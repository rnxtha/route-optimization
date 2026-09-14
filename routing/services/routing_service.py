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

    # Real Kathmandu Valley routes used by the Benchmark mode.
    # Coordinates verified to lie inside the valley bbox (85.15,27.55 -> 85.55,27.82).
    BENCHMARK_ROUTES = [
        {'name': 'Thamel → Patan Dhoka', 'start': (27.7172, 85.3240), 'end': (27.6739, 85.3250)},
        {'name': 'Airport → Bhaktapur Durbar', 'start': (27.6966, 85.3262), 'end': (27.6722, 85.4273)},
        {'name': 'Kalanki → Chabahil', 'start': (27.6935, 85.2815), 'end': (27.7179, 85.3470)},
        {'name': 'Kirtipur → Boudha', 'start': (27.6785, 85.2770), 'end': (27.7216, 85.3620)},
        {'name': 'Lagankhel → Balaju', 'start': (27.6667, 85.3256), 'end': (27.7290, 85.2995)},
        {'name': 'Satdobato → Jorpati', 'start': (27.6580, 85.3250), 'end': (27.7280, 85.3700)},
    ]

    MAX_EXPLORED_COORDS = 2000

    @classmethod
    def get_graph(cls, force_refresh: bool = False):
        """Class method to load and cache the graph in memory.

        Passing force_refresh=True bypasses the local cache and refreshes the
        graph from the latest OpenStreetMap download.
        """
        if cls._graph is None or force_refresh:
            cls._graph = GraphLoader.load_or_build(force_refresh=force_refresh)
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

    def _sample_explored_coords(self, visited_order) -> List:
        """Downsample visited node IDs to [lat, lon] coords for map display.

        Caps output at MAX_EXPLORED_COORDS so the JSON stays small while the
        search-area shape remains visible. Returns [] when not requested.
        """
        if not visited_order:
            return []
        step = max(1, len(visited_order) // self.MAX_EXPLORED_COORDS)
        coords = []
        for nid in visited_order[::step][:self.MAX_EXPLORED_COORDS]:
            node = self.graph.get_node(nid)
            if node:
                coords.append([node.lat, node.lon])
        return coords

    def _build_route_result(self, route_result, path: List[int], label: str,
                            include_explored: bool = False) -> Dict[str, Any]:
        road_names = self._get_road_names(path)
        unique_roads = self._get_unique_road_names(path)
        travel_time = self._estimate_travel_time_minutes(path)
        coords = []
        for nid in path:
            node = self.graph.get_node(nid)
            if node:
                coords.append((node.lat, node.lon))
        payload = {
            'label': label,
            'distance_meters': route_result.distance,
            'distance_km': round(route_result.distance / 1000.0, 3) if route_result.distance != float('inf') else None,
            'execution_time_seconds': route_result.execution_time,
            'execution_time_ms': round(route_result.execution_time * 1000.0, 2),
            'nodes_explored': route_result.nodes_explored,
            'path_nodes_count': route_result.path_nodes_count,
            'path': coords,
            'road_names': road_names,
            'unique_road_names': unique_roads[:15],
            'travel_time_minutes': travel_time,
        }
        if include_explored:
            payload['explored_coords'] = self._sample_explored_coords(
                getattr(route_result, 'visited_order', []))
        return payload

    @staticmethod
    def _compare_pair(dijkstra_result, astar_result) -> Dict[str, Any]:
        d_time = max(dijkstra_result.execution_time, 1e-6)
        a_time = max(astar_result.execution_time, 1e-6)
        speedup = d_time / a_time
        node_reduction = 0.0
        if dijkstra_result.nodes_explored > 0:
            node_reduction = round(
                (dijkstra_result.nodes_explored - astar_result.nodes_explored)
                / dijkstra_result.nodes_explored * 100.0, 1)
        return {
            'speedup': round(speedup, 2),
            'node_reduction_percent': node_reduction,
            'distance_match': abs(dijkstra_result.distance - astar_result.distance) < 1.0,
        }

    def calculate_routes(self, start_lat: float, start_lon: float, end_lat: float, end_lon: float,
                         algorithm: str = 'both', include_explored: bool = False) -> Dict[str, Any]:
        """Calculate routes. `algorithm` is 'dijkstra', 'astar', or 'both'.

        'both' preserves the legacy response (dijkstra + astar + alternatives).
        Single-algorithm requests still return the same dict shape with the
        non-requested primary set to None, so old clients keep working.
        """
        algorithm = (algorithm or 'both').lower()
        if algorithm not in ('dijkstra', 'astar', 'both', 'compare'):
            algorithm = 'both'
        want_dijkstra = algorithm in ('dijkstra', 'both', 'compare')
        want_astar = algorithm in ('astar', 'both', 'compare')

        start_node_id = self.finder.find_nearest_junction(start_lat, start_lon)
        end_node_id = self.finder.find_nearest_junction(end_lat, end_lon)

        dijkstra_result = self.dijkstra_algo.find_route(self.graph, start_node_id, end_node_id) if want_dijkstra else None
        astar_result = self.astar_algo.find_route(self.graph, start_node_id, end_node_id) if want_astar else None

        # Log statistics to database (only for algorithms actually run)
        try:
            from ..models import RouteStatistic
            if dijkstra_result is not None:
                RouteStatistic.objects.create(
                    algorithm='dijkstra',
                    execution_time_ms=dijkstra_result.execution_time * 1000,
                    distance_meters=dijkstra_result.distance if dijkstra_result.distance != float('inf') else 0,
                    nodes_explored=dijkstra_result.nodes_explored,
                    path_length=dijkstra_result.path_nodes_count,
                    start_lat=start_lat,
                    start_lon=start_lon,
                    end_lat=end_lat,
                    end_lon=end_lon,
                )
            if astar_result is not None:
                RouteStatistic.objects.create(
                    algorithm='astar',
                    execution_time_ms=astar_result.execution_time * 1000,
                    distance_meters=astar_result.distance if astar_result.distance != float('inf') else 0,
                    nodes_explored=astar_result.nodes_explored,
                    path_length=astar_result.path_nodes_count,
                    start_lat=start_lat,
                    start_lon=start_lon,
                    end_lat=end_lat,
                    end_lon=end_lon,
                )
        except Exception:
            # Silently fail if statistics logging fails
            pass

        primary_path = None
        if dijkstra_result is not None and dijkstra_result.path:
            primary_path = dijkstra_result.path
        elif astar_result is not None and astar_result.path:
            primary_path = astar_result.path
        best_path = primary_path or []
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
            'algorithm': algorithm,
            'dijkstra': self._build_route_result(dijkstra_result, dijkstra_result.path, 'Dijkstra (Shortest Distance)', include_explored) if dijkstra_result is not None else None,
            'astar': self._build_route_result(astar_result, astar_result.path, 'A* (Shortest Distance, Heuristic)', include_explored) if astar_result is not None else None,
        }

        if dijkstra_result is not None and astar_result is not None:
            result['comparison'] = {
                **self._compare_pair(dijkstra_result, astar_result),
                'dijkstra': {
                    'distance_km': result['dijkstra']['distance_km'],
                    'execution_time_ms': result['dijkstra']['execution_time_ms'],
                    'nodes_explored': result['dijkstra']['nodes_explored'],
                    'path_nodes_count': result['dijkstra']['path_nodes_count'],
                    'travel_time_minutes': result['dijkstra']['travel_time_minutes'],
                },
                'astar': {
                    'distance_km': result['astar']['distance_km'],
                    'execution_time_ms': result['astar']['execution_time_ms'],
                    'nodes_explored': result['astar']['nodes_explored'],
                    'path_nodes_count': result['astar']['path_nodes_count'],
                    'travel_time_minutes': result['astar']['travel_time_minutes'],
                },
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

    def run_benchmark(self) -> Dict[str, Any]:
        """Run Dijkstra vs A* across BENCHMARK_ROUTES and average the results.

        Only the two primary algorithms run here (no alternative-route
        penalties), keeping the benchmark fast and comparable.
        """
        per_route = []
        for entry in self.BENCHMARK_ROUTES:
            (s_lat, s_lon), (e_lat, e_lon) = entry['start'], entry['end']
            try:
                s_id = self.finder.find_nearest_junction(s_lat, s_lon)
                e_id = self.finder.find_nearest_junction(e_lat, e_lon)
                d_res = self.dijkstra_algo.find_route(self.graph, s_id, e_id)
                a_res = self.astar_algo.find_route(self.graph, s_id, e_id)
                cmp = self._compare_pair(d_res, a_res)
                per_route.append({
                    'name': entry['name'],
                    'dijkstra': {
                        'distance_km': round(d_res.distance / 1000.0, 3) if d_res.distance != float('inf') else None,
                        'execution_time_ms': round(d_res.execution_time * 1000.0, 2),
                        'nodes_explored': d_res.nodes_explored,
                        'path_nodes_count': d_res.path_nodes_count,
                    },
                    'astar': {
                        'distance_km': round(a_res.distance / 1000.0, 3) if a_res.distance != float('inf') else None,
                        'execution_time_ms': round(a_res.execution_time * 1000.0, 2),
                        'nodes_explored': a_res.nodes_explored,
                        'path_nodes_count': a_res.path_nodes_count,
                    },
                    'speedup': cmp['speedup'],
                    'node_reduction_percent': cmp['node_reduction_percent'],
                    'distance_match': cmp['distance_match'],
                })
            except Exception as exc:
                per_route.append({'name': entry['name'], 'error': str(exc)})

        valid = [r for r in per_route if 'error' not in r]
        n = len(valid) or 1
        avg = {
            'routes': len(per_route),
            'successful_routes': len(valid),
            'avg_dijkstra_time_ms': round(sum(r['dijkstra']['execution_time_ms'] for r in valid) / n, 2),
            'avg_astar_time_ms': round(sum(r['astar']['execution_time_ms'] for r in valid) / n, 2),
            'avg_dijkstra_nodes': round(sum(r['dijkstra']['nodes_explored'] for r in valid) / n, 1),
            'avg_astar_nodes': round(sum(r['astar']['nodes_explored'] for r in valid) / n, 1),
            'avg_dijkstra_distance_km': round(sum((r['dijkstra']['distance_km'] or 0) for r in valid) / n, 3),
            'avg_astar_distance_km': round(sum((r['astar']['distance_km'] or 0) for r in valid) / n, 3),
            'avg_speedup': round(sum(r['speedup'] for r in valid) / n, 2),
            'avg_node_reduction_percent': round(sum(r['node_reduction_percent'] for r in valid) / n, 1),
        }
        return {'routes': per_route, 'averages': avg}