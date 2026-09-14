import os
import json
import time
import math
from django.conf import settings
import osmnx as ox
import networkx as nx
from .graph import Graph
from .node import Node
from .edge import Edge

class GraphLoader:
    """
    Handles downloading, parsing, cleaning, caching, and loading of the road graph.

    Freshness policy: the cached file is used for fast loads, but any rebuild
    with force_refresh=True downloads the LATEST OpenStreetMap snapshot via
    OSMnx/Overpass (with multiple mirror fallbacks) and re-runs the full
    preprocessing pipeline (LSCC + distance weights). New roads/places mapped
    in OSM since the last build are therefore picked up on rebuild. Google Maps
    is only ever used as an external visual reference by editors contributing
    to OSM itself — no Google data is copied into this graph.
    """

    # Bounding box covering Kathmandu Valley (Kathmandu, Lalitpur, Bhaktapur)
    # Coordinates format: (left, bottom, right, top) representing (west, south, east, north)
    BBOX = (85.15, 27.55, 85.55, 27.82)

    # Bumped whenever the download/preprocessing pipeline changes so clients
    # and the admin panel can tell a fresh build from a stale cache file.
    GRAPH_VERSION = "v2-fresh-osm"
    DATA_SOURCE = "OpenStreetMap via Overpass API (latest snapshot at rebuild time)"

    @staticmethod
    def get_cache_path() -> str:
        """Returns the absolute path to the cached graph JSON file."""
        data_dir = os.path.join(settings.BASE_DIR, 'routing', 'data')
        os.makedirs(data_dir, exist_ok=True)
        return os.path.join(data_dir, 'kathmandu_graph.json')

    @staticmethod
    def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Helper to calculate distance in meters between two coordinates."""
        R = 6371000.0
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        delta_phi = math.radians(lat2 - lat1)
        delta_lambda = math.radians(lon2 - lon1)
        a = (math.sin(delta_phi / 2.0) ** 2 +
             math.cos(phi1) * math.cos(phi2) *
             math.sin(delta_lambda / 2.0) ** 2)
        c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
        return R * c

    @classmethod
    def _download_graph_from_osm(cls) -> Graph:
        """Download the latest full Kathmandu Valley road network from OpenStreetMap.

        Always fetches a fresh snapshot (OSMnx cache disabled) so recently
        added roads and places are included. Falls back across public Overpass
        mirrors. Raises RuntimeError only if every mirror fails.
        """
        print("[GraphLoader] Fetching latest OpenStreetMap road graph...")
        start_time = time.time()

        # 1. Download street network using OSMnx with fallback mirrors.
        # Ordered by recent reliability; the canonical endpoint is tried too.
        endpoints = [
            "https://overpass-api.de/api",
            "https://lz4.overpass-api.de/api",
            "https://z.overpass-api.de/api",
            "https://overpass.kumi.systems/api",
            "https://overpass.nchc.org.tw/api",
        ]

        G_raw = None
        last_error = None
        for endpoint in endpoints:
            print(f"[GraphLoader] Trying Overpass endpoint: {endpoint}")
            ox.settings.overpass_url = endpoint
            ox.settings.timeout = 180
            ox.settings.use_cache = False
            try:
                # retain_all=False + simplify=True mirrors prior behaviour but is
                # now explicit so future OSMnx defaults cannot silently change it.
                # network_type='drive' keeps all motorable roads (incl. new ones).
                G_raw = ox.graph_from_bbox(bbox=cls.BBOX, network_type='drive',
                                           simplify=True, retain_all=False)
                print(f"[GraphLoader] SUCCESS with {endpoint}")
                break
            except Exception as e:
                print(f"[GraphLoader] FAILED with {endpoint}: {e}")
                last_error = e

        if G_raw is None:
            raise RuntimeError(f"All Overpass API endpoints failed to download road data. Last error: {last_error}")

        print(f"[GraphLoader] Downloaded raw OSM graph: {G_raw.number_of_nodes()} nodes, {G_raw.number_of_edges()} edges in {time.time() - start_time:.2f} seconds.")

        # 2. Extract Largest Strongly Connected Component (LSCC)
        scc_start = time.time()
        largest_cc = max(nx.strongly_connected_components(G_raw), key=len)
        G_lscc = G_raw.subgraph(largest_cc).copy()
        print(f"[GraphLoader] Extracted LSCC: {G_lscc.number_of_nodes()} nodes, {G_lscc.number_of_edges()} edges in {time.time() - scc_start:.2f} seconds.")

        # 3. Convert networkx graph to custom OOP Graph
        custom_graph = Graph()

        # Add Nodes
        for node_id, data in G_lscc.nodes(data=True):
            lat = data['y']
            lon = data['x']
            custom_graph.add_node(Node(id=node_id, lat=lat, lon=lon))

        # Add Edges
        for u, v, k, data in G_lscc.edges(keys=True, data=True):
            name = data.get('name', '')
            if isinstance(name, list):
                name = ', '.join(str(n) for n in name)

            highway = data.get('highway', '')
            if isinstance(highway, list):
                highway = highway[0] if highway else 'residential'

            distance = data.get('length')
            if distance is None:
                node_u = custom_graph.get_node(u)
                node_v = custom_graph.get_node(v)
                distance = cls.haversine_distance(node_u.lat, node_u.lon, node_v.lat, node_v.lon)

            oneway = data.get('oneway', False)
            if isinstance(oneway, str):
                oneway = (oneway.lower() == 'yes' or oneway == '1' or oneway.lower() == 'true')
            elif isinstance(oneway, int):
                oneway = bool(oneway)

            edge_obj = Edge(
                source=u,
                destination=v,
                distance=float(distance),
                name=str(name),
                highway=str(highway),
                oneway=oneway
            )
            custom_graph.add_edge(edge_obj)

        return custom_graph

    @staticmethod
    def _save_graph_to_cache(graph: Graph, cache_path: str) -> None:
        """Persist a graph object to the cached JSON representation.

        Adds version/source/built-at metadata so the admin panel, the
        /api/graph/info/ endpoint, and offline downloads can verify freshness.
        Keeps the SAME schema (nodes/edges + metadata keys), so existing
        offline IndexedDB payloads and the offline JS router keep working.
        """
        from datetime import datetime, timezone
        print(f"[GraphLoader] Saving preprocessed LSCC graph to cache: {cache_path}")
        cache_start = time.time()
        graph_dict = graph.to_dict()
        graph_dict['graph_version'] = GraphLoader.GRAPH_VERSION
        graph_dict['data_source'] = GraphLoader.DATA_SOURCE
        graph_dict['bbox'] = list(GraphLoader.BBOX)
        graph_dict['built_at'] = datetime.now(timezone.utc).isoformat()
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp_path = cache_path + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(graph_dict, f, indent=2)
        os.replace(tmp_path, cache_path)
        print(f"[GraphLoader] Saved cache in {time.time() - cache_start:.2f} seconds.")

    @classmethod
    def get_graph_info(cls) -> dict:
        """Freshness metadata for the admin panel and /api/graph/info/."""
        cache_path = cls.get_cache_path()
        info = {'exists': os.path.exists(cache_path), 'path': cache_path,
                'version': cls.GRAPH_VERSION, 'source': cls.DATA_SOURCE,
                'bbox': list(cls.BBOX)}
        if info['exists']:
            info['size_bytes'] = os.path.getsize(cache_path)
            info['size_mb'] = round(info['size_bytes'] / (1024 * 1024), 2)
            from datetime import datetime
            info['last_built'] = datetime.fromtimestamp(os.path.getmtime(cache_path)).isoformat()
            try:
                with open(cache_path, 'r', encoding='utf-8') as f:
                    head = json.load(f)
                info['nodes'] = len(head.get('nodes', []))
                info['edges'] = len(head.get('edges', []))
                info['cached_version'] = head.get('graph_version', 'v1')
                info['built_at'] = head.get('built_at')
            except Exception:
                pass
        return info

    @classmethod
    def load_or_build(cls, force_refresh: bool = False) -> Graph:
        """
        Loads the graph from the cache file by default.
        If force_refresh=True, bypasses the local cache and downloads the latest OSM network.
        Download failures raise RuntimeError so the admin rebuild endpoint can
        report them; the previous cache file is left untouched (atomic replace
        on save), so routing keeps working on the last good build.
        """
        cache_path = cls.get_cache_path()
        if os.path.exists(cache_path) and not force_refresh:
            print(f"[GraphLoader] Loading graph from cache: {cache_path}")
            start_time = time.time()
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            graph = Graph.from_dict(data)
            print(f"[GraphLoader] Loaded {len(graph.nodes)} nodes and "
                  f"{sum(len(edges) for edges in graph.adjacency_list.values())} edges from cache in {time.time() - start_time:.2f} seconds.")
            return graph

        custom_graph = cls._download_graph_from_osm()
        cls._save_graph_to_cache(custom_graph, cache_path)
        return custom_graph
