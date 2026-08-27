import heapq
import time
import math
from typing import Set, Tuple, Optional, List
from .base import RouteAlgorithm, RouteResult


class AStar(RouteAlgorithm):
    """
    Manual implementation of A* (A-Star) search algorithm.
    Heuristic: Haversine distance to target node.
    Uses road distance (meters) as edge weight.
    Supports edge-penalty overrides for alternative route generation.
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
                   penalty_factor: float = 1.0) -> RouteResult:
        if start_node_id not in graph.nodes or end_node_id not in graph.nodes:
            return RouteResult(path=[], distance=float('inf'), nodes_explored=0, execution_time=0.0)

        if start_node_id == end_node_id:
            return RouteResult(path=[start_node_id], distance=0.0, nodes_explored=1, execution_time=0.0)

        start_time = time.perf_counter()

        end_node = graph.get_node(end_node_id)
        end_lat, end_lon = end_node.lat, end_node.lon

        g_score = {start_node_id: 0.0}
        start_node_obj = graph.get_node(start_node_id)
        h_start = self.haversine_distance(start_node_obj.lat, start_node_obj.lon, end_lat, end_lon)
        f_score = {start_node_id: h_start}

        parent = {}
        visited = set()
        pq = [(f_score[start_node_id], start_node_id)]
        nodes_explored = 0

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
                weight = edge.distance

                if v in visited:
                    continue

                if penalized_edges and (u, v) in penalized_edges:
                    weight *= penalty_factor

                tentative_g = current_g + weight

                if v not in g_score or tentative_g < g_score[v]:
                    g_score[v] = tentative_g
                    v_node = graph.get_node(v)
                    h_v = self.haversine_distance(v_node.lat, v_node.lon, end_lat, end_lon)
                    f_val = tentative_g + h_v
                    f_score[v] = f_val
                    parent[v] = u
                    heapq.heappush(pq, (f_val, v))

        execution_time = time.perf_counter() - start_time

        if end_node_id not in g_score:
            return RouteResult(path=[], distance=float('inf'), nodes_explored=nodes_explored, execution_time=execution_time)

        path = []
        curr = end_node_id
        while curr in parent:
            path.append(curr)
            curr = parent[curr]
        path.append(start_node_id)
        path.reverse()

        return RouteResult(
            path=path,
            distance=g_score[end_node_id],
            nodes_explored=nodes_explored,
            execution_time=execution_time
        )