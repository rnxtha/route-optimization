import json
import os
import re
import threading
import time
import concurrent.futures as futures
import requests
from django.shortcuts import render
from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST, require_GET
from django.conf import settings
from .services.routing_service import RoutingService


def dashboard(request):
    return render(request, 'index.html')


# Valley bounds used to keep every suggestion inside the study area.
VALLEY_LAT_MIN, VALLEY_LAT_MAX = 27.55, 27.82
VALLEY_LON_MIN, VALLEY_LON_MAX = 85.15, 85.55
# NOTE: Nominatim viewbox order is left,top,right,bottom.
NOMINATIM_VIEWBOX = f'{VALLEY_LON_MIN},{VALLEY_LAT_MAX},{VALLEY_LON_MAX},{VALLEY_LAT_MIN}'
NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
NOMINATIM_UA = 'RouteOptKathmanduValley/1.0'

# Shared sessions = keep-alive connections, so every keystroke doesn't repay
# DNS + TLS handshakes (urllib3 pooling is thread-safe).
_NOMINATIM_SESSION = requests.Session()
_NOMINATIM_SESSION.headers.update({'User-Agent': NOMINATIM_UA, 'Accept-Language': 'en'})
_OVERPASS_SESSION = requests.Session()
_OVERPASS_SESSION.headers.update({'User-Agent': 'RouteOptimizerDemo/1.0'})

# Tiny in-memory cache so repeated keystrokes/focus/Enter don't re-hit Overpass.
_PLACES_CACHE = {}
_PLACES_CACHE_LOCK = threading.Lock()
_PLACES_CACHE_TTL = 600
_PLACES_CACHE_MAX = 200


def _places_cache_get(key):
    try:
        with _PLACES_CACHE_LOCK:
            ts, data = _PLACES_CACHE.get(key, (0, None))
            if data is not None and (time.monotonic() - ts) < _PLACES_CACHE_TTL:
                return data
            _PLACES_CACHE.pop(key, None)
    except Exception:
        pass
    return None


def _places_cache_put(key, data):
    try:
        with _PLACES_CACHE_LOCK:
            if len(_PLACES_CACHE) >= _PLACES_CACHE_MAX:
                _PLACES_CACHE.clear()
            _PLACES_CACHE[key] = (time.monotonic(), data)
    except Exception:
        pass


def _in_valley(lat, lon):
    try:
        return (VALLEY_LAT_MIN <= float(lat) <= VALLEY_LAT_MAX
                and VALLEY_LON_MIN <= float(lon) <= VALLEY_LON_MAX)
    except (TypeError, ValueError):
        return False


def _nominatim_places(query, limit):
    """Full-text OSM search (all named places/roads), valley-bounded.

    Runs server-side so the browser never hardcodes the external geocoder and
    all suggestions stay aligned with the same OSM data source as the graph.
    Any failure returns [] so the category search still answers.
    """
    try:
        resp = _NOMINATIM_SESSION.get(
            NOMINATIM_URL,
            params={'format': 'jsonv2', 'addressdetails': '1', 'namedetails': '1', 'countrycodes': 'np',
                    'limit': limit, 'viewbox': NOMINATIM_VIEWBOX, 'bounded': '1',
                    'dedupe': '1', 'q': query},
            timeout=8,
        )
        resp.raise_for_status()
        out = []
        ql = query.strip().lower()
        for p in resp.json() or []:
            try:
                lat = float(p.get('lat'))
                lon = float(p.get('lon'))
            except (TypeError, ValueError):
                continue
            if not _in_valley(lat, lon):
                continue
            addr = p.get('address') or {}
            bits = [addr.get('road'), addr.get('suburb') or addr.get('neighbourhood'),
                    addr.get('city') or addr.get('town') or addr.get('village')]
            bits = [b for b in bits if b]
            display = p.get('display_name') or ''
            name = (p.get('name') or display.split(',')[0] or 'Location').strip()
            # Alias-aware label: if the typed text matches a known alt name
            # (e.g. "Patan" for Lalitpur) but not the primary name, show it —
            # otherwise users think it's the wrong place.
            try:
                named = p.get('namedetails') or {}
                alt_names = []
                for key in ('alt_name', 'loc_name', 'short_name', 'official_name'):
                    v = named.get(key)
                    if v:
                        alt_names.extend([a.strip() for a in str(v).split(';') if a.strip()])
                for alt in alt_names:
                    if ql and ql in alt.lower() and ql not in name.lower():
                        name = f'{alt} ({name})'
                        break
            except Exception:
                pass
            out.append({
                'name': name,
                'display_name': display,
                'short_addr': ', '.join(bits[:2]) or ', '.join(display.split(',')[1:3]).strip(),
                'lat': lat, 'lon': lon,
                'type': p.get('type') or '', 'category': p.get('category') or '',
                'source': 'osm',
            })
        return out
    except Exception:
        return []


def _category_places(query, bbox, limit):
    """Live Overpass venue search (futsal, cafes, clinics, colleges...).

    Returns [] on any failure so callers can still answer with the other
    source. Tight per-mirror timeouts with fastest-first failover, since
    overpass-api.de stalls on TCP connect from some networks.
    """
    # Choose a category bucket from the query text.
    category = 'restaurant'
    if any(token in query for token in ['futsal', 'football', 'sport', 'ground']):
        category = 'futsal'
    elif any(token in query for token in ['cafe', 'coffee', 'tea', 'bakery']):
        category = 'cafe'
    elif any(token in query for token in ['hospital', 'clinic', 'doctor', 'medical', 'health']):
        category = 'hospital'
    elif any(token in query for token in ['campus', 'college', 'school', 'university', 'institute']):
        category = 'education'
    elif any(token in query for token in ['restaurant', 'food', 'eat', 'dinner', 'lunch']):
        category = 'restaurant'

    # `["name"]` prefilter keeps valley-wide scans small (unnamed venues
    # can never match typed text usefully). Futsal pitches are often
    # unnamed, so that bucket stays unfiltered.
    N = '["name"]' if category != 'futsal' else ''

    if category == 'futsal':
        queries = [
            f'''[out:json][timeout:12];(node["sport"="futsal"]({bbox});node["leisure"="pitch"]["sport"="futsal"]({bbox});way["sport"="futsal"]({bbox});way["leisure"="pitch"]["sport"="futsal"]({bbox}););out center;'''
        ]
    elif category == 'cafe':
        queries = [
            f'''[out:json][timeout:12];(node["amenity"="cafe"]{N}({bbox});node["amenity"="coffee"]{N}({bbox});node["amenity"="coffee_shop"]{N}({bbox});way["amenity"="cafe"]{N}({bbox});way["amenity"="coffee"]{N}({bbox});way["amenity"="coffee_shop"]{N}({bbox}););out center;'''
        ]
    elif category == 'hospital':
        queries = [
            f'''[out:json][timeout:12];(node["amenity"="hospital"]{N}({bbox});node["amenity"="clinic"]{N}({bbox});node["healthcare"]{N}({bbox});way["amenity"="hospital"]{N}({bbox});way["amenity"="clinic"]{N}({bbox});way["healthcare"]{N}({bbox}););out center;'''
        ]
    elif category == 'education':
        queries = [
            f'''[out:json][timeout:12];(node["amenity"="college"]{N}({bbox});node["amenity"="university"]{N}({bbox});node["amenity"="school"]{N}({bbox});way["amenity"="college"]{N}({bbox});way["amenity"="university"]{N}({bbox});way["amenity"="school"]{N}({bbox}););out center;'''
        ]
    else:
        queries = [
            f'''[out:json][timeout:12];(node["amenity"="restaurant"]{N}({bbox});node["amenity"="fast_food"]{N}({bbox});node["amenity"="food_court"]{N}({bbox});way["amenity"="restaurant"]{N}({bbox});way["amenity"="fast_food"]{N}({bbox});way["amenity"="food_court"]{N}({bbox}););out center;'''
        ]

    overpass_endpoints = [
        'https://lz4.overpass-api.de/api/interpreter',
        'https://z.overpass-api.de/api/interpreter',
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.nchc.org.tw/api/interpreter',
    ]
    results = []

    try:
        for q in queries:
            try:
                response = None
                for endpoint in overpass_endpoints:
                        try:
                            response = _OVERPASS_SESSION.post(endpoint, data={'data': q}, timeout=(5, 12))
                            response.raise_for_status()
                            break
                        except Exception:
                            response = None
                            continue
                if response is None:
                    continue
                payload = response.json()
                elements = payload.get('elements', []) or []
                for item in elements:
                    tags = item.get('tags', {}) or {}
                    if 'highway' in tags:
                        continue
                    name = tags.get('name') or tags.get('operator') or ''
                    kind = tags.get('amenity') or tags.get('shop') or tags.get('leisure') or tags.get('sport') or tags.get('healthcare') or tags.get('tourism') or tags.get('cuisine') or 'place'

                    hay = ' '.join([name.lower(), kind.lower(), json.dumps(tags, ensure_ascii=False).lower()])
                    if query and query not in hay:
                        continue

                    lat = item.get('lat')
                    lon = item.get('lon')
                    if lat is None or lon is None:
                        center = item.get('center') or {}
                        lat = center.get('lat')
                        lon = center.get('lon')
                    if lat is None or lon is None:
                        continue

                    results.append({
                        'name': name or kind.title(),
                        'display_name': name or kind.title(),
                        'short_addr': str(kind).replace('_', ' '),
                        'lat': float(lat),
                        'lon': float(lon),
                        'type': kind,
                        'category': 'place',
                        'source': 'local',
                    })
                    if len(results) >= limit:
                        break
                if len(results) >= limit:
                    break
            except Exception:
                continue
    except Exception:
        return []
    return results


@require_GET
def place_search_api(request):
    """Google-style suggestions: full-text OSM search + venue categories.

    Merges valley-bounded Nominatim results (all named places/roads) with the
    live Overpass category search (futsal, cafes, clinics...), de-duplicated
    by location. Either source failing still returns the other's results.
    """
    try:
        raw_query = (request.GET.get('q') or '').strip()
        if not raw_query:
            return JsonResponse({'success': True, 'data': []})

        limit = int(request.GET.get('limit') or 8)
        query = raw_query.lower()
        bbox = f'{VALLEY_LAT_MIN},{VALLEY_LON_MIN},{VALLEY_LAT_MAX},{VALLEY_LON_MAX}'

        cache_key = f'{query}|{limit}'
        cached = _places_cache_get(cache_key)
        if cached is not None:
            return JsonResponse({'success': True, 'data': cached})

        # Both sources resolve in parallel under one shared ~6 s budget, so a
        # stalled Overpass mirror can never hang typing — its future is simply
        # cut off and the fast source's hits are returned. shutdown(wait=False)
        # is essential: a context manager would wait for the stalled thread.
        t0 = time.monotonic()
        _ex = futures.ThreadPoolExecutor(max_workers=2)
        try:
            _f_nom = _ex.submit(_nominatim_places, raw_query, 8)
            _f_cat = _ex.submit(_category_places, query, bbox, limit)
            try:
                nominatim_hits = _f_nom.result(timeout=6)
            except Exception:
                nominatim_hits = []
            try:
                # Any text hit means the query is answered — only a short
                # grace period for venue enrichment. Zero text hits: spend
                # the remaining budget on the venue scan instead.
                if len(nominatim_hits) >= 1:
                    _budget = 2.0
                else:
                    _budget = max(1.0, 6.0 - (time.monotonic() - t0))
                category_hits = _f_cat.result(timeout=_budget)
            except Exception:
                _f_cat.cancel()
                category_hits = []
        finally:
            _ex.shutdown(wait=False)
        seen = set()
        unique = []
        for item in nominatim_hits + category_hits:
            try:
                key = f"{float(item['lat']):.4f},{float(item['lon']):.4f}"
            except (TypeError, ValueError, KeyError):
                continue
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
            if len(unique) >= limit:
                break

        _places_cache_put(cache_key, unique)
        return JsonResponse({'success': True, 'data': unique})
    except Exception as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@csrf_exempt
@require_POST
def calculate_route_api(request):
    try:
        data = json.loads(request.body)
        start_lat = float(data.get('start_lat'))
        start_lon = float(data.get('start_lon'))
        end_lat = float(data.get('end_lat'))
        end_lon = float(data.get('end_lon'))
        algorithm = str(data.get('algorithm') or 'both').lower()
        include_explored = bool(data.get('include_explored', False))
    except (ValueError, TypeError, json.JSONDecodeError) as e:
        return JsonResponse({
            'success': False,
            'error': f'Invalid input payload. Details: {str(e)}'
        }, status=400)

    if algorithm not in ('dijkstra', 'astar', 'both', 'compare'):
        algorithm = 'both'

    try:
        service = RoutingService()
        result = service.calculate_routes(start_lat, start_lon, end_lat, end_lon,
                                          algorithm=algorithm,
                                          include_explored=include_explored)

        dijkstra = result.get('dijkstra')
        astar = result.get('astar')
        primary = dijkstra or astar
        if primary is None or primary.get('distance_meters') == float('inf') or not primary.get('path'):
            return JsonResponse({
                'success': False,
                'error': 'No route could be found between the selected coordinates.'
            }, status=404)

        return JsonResponse({
            'success': True,
            'data': result
        })

    except Exception as e:
        return JsonResponse({
            'success': False,
            'error': f'Internal server error: {str(e)}'
        }, status=500)


@require_GET
def benchmark_api(request):
    """Run the fixed Kathmandu Valley benchmark suite (Dijkstra vs A*).

    Returns per-route metrics plus averages. Read-only; does not change the
    cached graph. Used by the Benchmark tab in the UI.
    """
    try:
        service = RoutingService()
        result = service.run_benchmark()
        return JsonResponse({'success': True, 'data': result})
    except Exception as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=500)


@require_GET
def graph_info_api(request):
    """Return graph metadata for offline download (size, node/edge counts)."""
    try:
        from .graph.loader import GraphLoader
        cache_path = GraphLoader.get_cache_path()
        if not os.path.exists(cache_path):
            return JsonResponse({'success': False, 'error': 'Graph not built yet.'}, status=404)
        size_bytes = os.path.getsize(cache_path)
        # Quick peek at counts without loading full graph
        with open(cache_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        mtime = os.path.getmtime(cache_path)
        from datetime import datetime
        return JsonResponse({
            'success': True,
            'data': {
                'nodes': len(data.get('nodes', [])),
                'edges': len(data.get('edges', [])),
                'size_bytes': size_bytes,
                'size_mb': round(size_bytes / (1024*1024), 2),
                'last_built': datetime.fromtimestamp(mtime).isoformat(),
                'source': 'OpenStreetMap via Overpass (latest download)',
                'bbox': [85.15, 27.55, 85.55, 27.82],
                'graph_version': data.get('graph_version', 'v1'),
            }
        })
    except Exception as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=500)


@require_GET
def graph_download_api(request):
    """Stream the cached graph JSON for offline storage in IndexedDB."""
    try:
        from .graph.loader import GraphLoader
        cache_path = GraphLoader.get_cache_path()
        if not os.path.exists(cache_path):
            return JsonResponse({'success': False, 'error': 'Graph not built yet.'}, status=404)

        def file_iterator(path, chunk_size=8192):
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk

        response = StreamingHttpResponse(file_iterator(cache_path), content_type='application/json')
        response['Content-Disposition'] = 'attachment; filename="kathmandu_graph.json"'
        response['Content-Length'] = os.path.getsize(cache_path)
        return response
    except Exception as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=500)
