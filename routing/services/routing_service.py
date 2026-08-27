from typing import Dict, Any, Tuple, List, Set, Optional
import time
from ..graph.loader import GraphLoader
from ..graph.nearest_node import NearestNodeFinder
from ..algorithms.dijkstra import Dijkstra
from ..algorithms.astar import AStar

# Average speeds in km/h by road type for travel-time estimation
ROAD_SPEED_KMH = {
    'motorway': 80,
    'motorway_link': 60,
    'trunk': 70,
    'trunk_link': 50,
    'primary': 50,
    'primary_link': 40,
    'secondary': 40,
    'secondary_link': 35,
    'tertiary': 35,
    'tertiary_link': 30,
    'residential': 25,
    'unclassified': 25,
    'service': 20,
    'living_street': 15,
}
DEFAULT_SPEED_KMH = 30


class RoutingService:
    """
    Orchestrates the routing process by loading the graph, finding nearest nodes
    to the query coordinates, running Dijkstra and A* algorithms, and formatting
    the results.
    
    Both algorithms use road distance (meters) as edge weights.
    No ML/traffic data is used.
    """
    _graph = None

    @classmethod
    def get_graph(cls):
        """Class method to load and cache the graph in memory."""
        if cls._graph is None:
            cls._graph = GraphLoader.load_or_build()
        return cls._graph

    def __init__(self):
        self.graph = self.get_graph()
        self.finder = NearestNodeFinder(self.graph)
        self.dijkstra_algo = Dijkstra()
        self.astar_algo = AStar()

    def _get_path_edges(self, path: List[int]) -> Set[Tuple[int, int]]:
        edges = set()
        for i in range(len(path) - 1):
            edges.add((path[i], path[i + 1]))
        return edges

    def _get_road_names(self, path: List[int]) -> List[str]:
        names = []
        for i in range(len(path) - 1):
            for edge in self.graph.get_neighbors(path[i]):
                if edge.destination == path[i + 1]:
                    road_name = edge.name if edge.name and edge.name != "Unnamed Road" else ""
                    names.append(road_name)
                    break
        return names

    def _get_unique_road_names(self, path: List[int]) -> List[str]:
        seen = set()
        unique = []
        for name in self._get_road_names(path):
            if name and name not in seen:
                seen.add(name)
                unique.append(name)
        return unique

    def _estimate_travel_time_minutes(self, path: List[int]) -> float:
        total_seconds = 0.0
        for i in range(len(path) - 1):
            for edge in self.graph.get_neighbors(path[i]):
                if edge.destination == path[i + 1]:
                    speed_kmh = ROAD_SPEED_KMH.get(edge.highway, DEFAULT_SPEED_KMH)
                    speed_ms = speed_kmh / 3.6
                    if speed_ms > 0:
                        total_seconds += edge.distance / speed_ms
                    break
        return round(total_seconds / 60.0, 1)

    def _build_route_result(self, route_result, path: List[int], label: str) -> Dict[str, Any]:
        road_names = self._get_road_names(path)
        unique_roads = self._get_unique_road_names(path)
        travel_time = self._estimate_travel_time_minutes(path)
        coords = []
        for nid in path:
            node = self.graph.get_node(nid)
            if node:
                coords.append((node.lat, node.lon))
        return {
            'label': label,
            'distance_meters': route_result.distance,
            'distance_km': round(route_result.distance / 1000.0, 3) if route_result.distance != float('inf') else None,
            'execution_time_seconds': route_result.execution_time,
            'nodes_explored': route_result.nodes_explored,
            'path_nodes_count': route_result.path_nodes_count,
            'path': coords,
            'road_names': road_names,
            'unique_road_names': unique_roads[:15],
            'travel_time_minutes': travel_time,
        }

    def calculate_routes(self, start_lat: float, start_lon: float, end_lat: float, end_lon: float) -> Dict[str, Any]:
        start_node_id = self.finder.find_nearest(start_lat, start_lon)
        end_node_id = self.finder.find_nearest(end_lat, end_lon)

        # Run both algorithms on distance weights
        dijkstra_result = self.dijkstra_algo.find_route(self.graph, start_node_id, end_node_id)
        astar_result = self.astar_algo.find_route(self.graph, start_node_id, end_node_id)

        best_path = dijkstra_result.path if dijkstra_result.path else astar_result.path
        best_edges = self._get_path_edges(best_path)

        # Alternative route 1: penalize optimal edges
        alt1_result = self.dijkstra_algo.find_route(
            self.graph, start_node_id, end_node_id,
            penalized_edges=best_edges, penalty_factor=3.0
        )

        # Alternative route 2: penalize optimal + alt1 edges
        combined_penalties = set(best_edges)
        if alt1_result.path:
            combined_penalties.update(self._get_path_edges(alt1_result.path))
        alt2_result = self.astar_algo.find_route(
            self.graph, start_node_id, end_node_id,
            penalized_edges=combined_penalties, penalty_factor=4.0
        )

        start_node = self.graph.get_node(start_node_id)
        end_node = self.graph.get_node(end_node_id)

        result = {
            'start_node_id': start_node_id,
            'end_node_id': end_node_id,
            'start_coords': (start_node.lat, start_node.lon) if start_node else (start_lat, start_lon),
            'end_coords': (end_node.lat, end_node.lon) if end_node else (end_lat, end_lon),
            'dijkstra': self._build_route_result(dijkstra_result, dijkstra_result.path, 'Dijkstra (Shortest Distance)'),
            'astar': self._build_route_result(astar_result, astar_result.path, 'A* (Shortest Distance, Heuristic)'),
        }

        if alt1_result.path and alt1_result.path != best_path:
            result['alt1'] = self._build_route_result(alt1_result, alt1_result.path, 'Alternative 1')
        else:
            result['alt1'] = None

        if alt2_result.path and alt2_result.path != best_path:
            if not alt1_result.path or alt2_result.path != alt1_result.path:
                result['alt2'] = self._build_route_result(alt2_result, alt2_result.path, 'Alternative 2')
            else:
                result['alt2'] = None
        else:
            result['alt2'] = None

        return result