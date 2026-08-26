import heapq
import time
import math
from typing import Set, Tuple, Optional, Callable, List, Dict, Any
from .base import RouteAlgorithm, RouteResult


class AStar(RouteAlgorithm):
    """
    Manual implementation of A* (A-Star) search algorithm.
    Heuristic: Haversine distance to target node.
    Supports edge-penalty overrides for alternative route generation.
    Optionally accepts an ``edge_weight_fn`` to plug in ML-based traffic weights.
    """
    def __init__(self):
        super().__init__("A*")

    @staticmethod
    def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
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

    def find_route(self, graph, start_node_id: int, end_node_id: int,
                   penalized_edges: Optional[Set[Tuple[int, int]]] = None,
                   penalty_factor: float = 1.0,
                   edge_weight_fn: Optional[Callable[[Any], Tuple[float, Dict[str, Any]]]] = None,
                   now_ts: Optional[float] = None) -> RouteResult:
        if start_node_id not in graph.nodes or end_node_id not in graph.nodes:
            return RouteResult(path=[], distance=float('inf'), nodes_explored=0, execution_time=0.0)

        if start_node_id == end_node_id:
            return RouteResult(path=[start_node_id], distance=0.0, nodes_explored=1, execution_time=0.0,
                               travel_time_seconds=0.0, traffic_stats={}, edges_detail=[])

        start_time = time.perf_counter()

        end_node = graph.get_node(end_node_id)
        end_lat, end_lon = end_node.lat, end_node.lon

        g_score = {start_node_id: 0.0}
        start_node_obj = graph.get_node(start_node_id)

        # Heuristic: if using time-based weights, estimate travel time via haversine
        # using a reasonable reference speed (25 km/h ≈ 6.94 m/s); otherwise meters.
        if edge_weight_fn is not None:
            ref_speed_ms = 25.0 / 3.6
            h_start = self.haversine_distance(start_node_obj.lat, start_node_obj.lon, end_lat, end_lon) / ref_speed_ms
        else:
            h_start = self.haversine_distance(start_node_obj.lat, start_node_obj.lon, end_lat, end_lon)

        f_score = {start_node_id: h_start}

        parent = {}
        visited = set()
        pq = [(f_score[start_node_id], start_node_id)]
        nodes_explored = 0

        weight_cache: Dict[Tuple[int, int], Tuple[float, float, Dict[str, Any]]] = {}

        while pq:
            current_f, u = heapq.heappop(pq)

            if u in visited:
                continue

            visited.add(u)
            nodes_explored += 1

            if u == end_node_id:
                break

            current_g = g_score[u]

            for edge in graph.get_neighbors(u):
                v = edge.destination

                if v in visited:
                    continue

                key = (u, v)
                if key in weight_cache:
                    weight, distance_m, _detail = weight_cache[key]
                else:
                    distance_m = edge.distance
                    if edge_weight_fn is not None:
                        weight, detail = edge_weight_fn(edge)
                    else:
                        weight, detail = distance_m, {}
                    weight_cache[key] = (weight, distance_m, detail)

                if penalized_edges and (u, v) in penalized_edges:
                    weight *= penalty_factor

                tentative_g = current_g + weight

                if v not in g_score or tentative_g < g_score[v]:
                    g_score[v] = tentative_g
                    v_node = graph.get_node(v)
                    if edge_weight_fn is not None:
                        ref_speed_ms = 25.0 / 3.6
                        h_v = self.haversine_distance(v_node.lat, v_node.lon, end_lat, end_lon) / ref_speed_ms
                    else:
                        h_v = self.haversine_distance(v_node.lat, v_node.lon, end_lat, end_lon)
                    f_val = tentative_g + h_v
                    f_score[v] = f_val
                    parent[v] = u
                    heapq.heappush(pq, (f_val, v))

        execution_time = time.perf_counter() - start_time

        if end_node_id not in g_score:
            return RouteResult(path=[], distance=float('inf'), nodes_explored=nodes_explored,
                               execution_time=execution_time)

        path = []
        curr = end_node_id
        while curr in parent:
            path.append(curr)
            curr = parent[curr]
        path.append(start_node_id)
        path.reverse()

        total_distance = 0.0
        total_travel_seconds = 0.0
        edges_detail: List[Dict[str, Any]] = []
        for i in range(len(path) - 1):
            u, v = path[i], path[i + 1]
            _w, distance_m, detail = weight_cache.get((u, v), (0.0, 0.0, {}))
            total_distance += distance_m
            if edge_weight_fn is not None:
                total_travel_seconds += detail.get('predicted_seconds', distance_m / (30.0 / 3.6))
            else:
                total_travel_seconds += detail.get('predicted_seconds', 0.0) if detail else 0.0
            if detail:
                edges_detail.append(detail)

        traffic_stats: Dict[str, Any] = {}
        if edges_detail:
            level_counts = {'free': 0, 'light': 0, 'moderate': 0, 'heavy': 0}
            worst = None
            worst_ratio = 0.0
            for d in edges_detail:
                lvl = d.get('congestion_level', 'free')
                level_counts[lvl] = level_counts.get(lvl, 0) + 1
                cf = d.get('congestion_factor', 1.0)
                if cf > worst_ratio:
                    worst_ratio = cf
                    worst = d
            traffic_stats = {
                'edges_count': len(edges_detail),
                'dominant_congestion': max(level_counts, key=lambda k: level_counts[k]) if level_counts else 'free',
                'level_counts': level_counts,
                'worst_edge': worst,
            }

        travel_seconds = total_travel_seconds if edge_weight_fn is not None else None

        return RouteResult(
            path=path,
            distance=total_distance,
            nodes_explored=nodes_explored,
            execution_time=execution_time,
            travel_time_seconds=travel_seconds,
            traffic_stats=traffic_stats,
            edges_detail=edges_detail,
        )
