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
    """
    
    # Bounding box covering Kathmandu Valley (Kathmandu, Lalitpur, Bhaktapur)
    # Coordinates format: (left, bottom, right, top) representing (west, south, east, north)
    BBOX = (85.15, 27.55, 85.55, 27.82)
    
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
    def load_or_build(cls) -> Graph:
        """
        Loads the graph from the cache file.
        If cache doesn't exist, builds it from OSMnx, saves it, and returns the graph.
        """
        cache_path = cls.get_cache_path()
        if os.path.exists(cache_path):
            print(f"[GraphLoader] Loading graph from cache: {cache_path}")
            start_time = time.time()
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            graph = Graph.from_dict(data)
            print(f"[GraphLoader] Loaded {len(graph.nodes)} nodes and "
                  f"{sum(len(edges) for edges in graph.adjacency_list.values())} edges from cache in {time.time() - start_time:.2f} seconds.")
            return graph

        print("[GraphLoader] Cached graph not found. Fetching from OpenStreetMap...")
        start_time = time.time()
        
        # 1. Download street network using OSMnx with fallback mirrors
        endpoints = [
            "https://lz4.overpass-api.de/api",
            "https://z.overpass-api.de/api",
            "https://overpass.kumi.systems/api",
            "https://overpass.nchc.org.tw/api",
            "https://overpass-api.de/api"
        ]
        
        G_raw = None
        last_error = None
        for endpoint in endpoints:
            print(f"[GraphLoader] Trying Overpass endpoint: {endpoint}")
            ox.settings.overpass_url = endpoint
            ox.settings.timeout = 90
            try:
                G_raw = ox.graph_from_bbox(bbox=cls.BBOX, network_type='drive')
                print(f"[GraphLoader] SUCCESS with {endpoint}")
                break
            except Exception as e:
                print(f"[GraphLoader] FAILED with {endpoint}: {e}")
                last_error = e

        if G_raw is None:
            raise RuntimeError(f"All Overpass API endpoints failed to download road data. Last error: {last_error}")

        print(f"[GraphLoader] Downloaded raw OSM graph: {G_raw.number_of_nodes()} nodes, {G_raw.number_of_edges()} edges in {time.time() - start_time:.2f} seconds.")

        # 2. Extract Largest Strongly Connected Component (LSCC)
        # This guarantees that a path always exists between any two nodes in our routing system.
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
        # OSMnx MultiDiGraph edge structure: (u, v, key, data)
        for u, v, k, data in G_lscc.edges(keys=True, data=True):
            # Extract road name
            name = data.get('name', '')
            if isinstance(name, list):
                name = ', '.join(str(n) for n in name)
            
            # Extract highway type
            highway = data.get('highway', '')
            if isinstance(highway, list):
                highway = highway[0] if highway else 'residential'

            # Get distance
            distance = data.get('length')
            if distance is None:
                # Fallback to computing Haversine distance
                node_u = custom_graph.get_node(u)
                node_v = custom_graph.get_node(v)
                distance = cls.haversine_distance(node_u.lat, node_u.lon, node_v.lat, node_v.lon)

            # Check if edge is one-way
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

        # 4. Save to cache
        print(f"[GraphLoader] Saving preprocessed LSCC graph to cache: {cache_path}")
        cache_start = time.time()
        graph_dict = custom_graph.to_dict()
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump(graph_dict, f, indent=2)
        print(f"[GraphLoader] Saved cache in {time.time() - cache_start:.2f} seconds.")
        
        return custom_graph
