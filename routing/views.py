import json
import os
from django.shortcuts import render
from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST, require_GET
from django.conf import settings
from .services.routing_service import RoutingService


def dashboard(request):
    return render(request, 'index.html')


@csrf_exempt
@require_POST
def calculate_route_api(request):
    try:
        data = json.loads(request.body)
        start_lat = float(data.get('start_lat'))
        start_lon = float(data.get('start_lon'))
        end_lat = float(data.get('end_lat'))
        end_lon = float(data.get('end_lon'))
    except (ValueError, TypeError, json.JSONDecodeError) as e:
        return JsonResponse({
            'success': False,
            'error': f'Invalid input payload. Details: {str(e)}'
        }, status=400)

    try:
        service = RoutingService()
        result = service.calculate_routes(start_lat, start_lon, end_lat, end_lon)

        if result['dijkstra']['distance_meters'] == float('inf') or not result['dijkstra']['path']:
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
        return JsonResponse({
            'success': True,
            'data': {
                'nodes': len(data.get('nodes', [])),
                'edges': len(data.get('edges', [])),
                'size_bytes': size_bytes,
                'size_mb': round(size_bytes / (1024*1024), 2),
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
