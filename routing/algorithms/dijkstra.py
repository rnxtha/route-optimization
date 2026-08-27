import heapq
import time
from typing import Set, Tuple, Optional, List
from .base import RouteAlgorithm, RouteResult


class Dijkstra(RouteAlgorithm):
    """
    Manual implementation of Dijkstra's algorithm.
    Uses road distance (meters) as edge weight.
    Supports edge-penalty overrides for alternative route generation.
    """
    def __init__(self):
        super().__init__("Dijkstra")

    def find_route(self, graph, start_node_id: int, end_node_id: int,
                   penalized_edges: Optional[Set[Tuple[int, int]]] = None,
                   penalty_factor: float = 1.0) -> RouteResult:
        if start_node_id not in graph.nodes or end_node_id not in graph.nodes:
            return RouteResult(path=[], distance=float('inf'), nodes_explored=0, execution_time=0.0)

        if start_node_id == end_node_id:
            return RouteResult(path=[start_node_id], distance=0.0, nodes_explored=1, execution_time=0.0)

        start_time = time.perf_counter()

        dist = {start_node_id: 0.0}
        parent = {}
        visited = set()
        pq = [(0.0, start_node_id)]
        nodes_explored = 0

        while pq:
            current_dist, u = heapq.heappop(pq)

            if u in visited:
                continue

            visited.add(u)
            nodes_explored += 1

            if u == end_node_id:
                break

            for edge in graph.get_neighbors(u):
                v = edge.destination
                weight = edge.distance

                if v in visited:
                    continue

                if penalized_edges and (u, v) in penalized_edges:
                    weight *= penalty_factor

                new_dist = current_dist + weight
                if v not in dist or new_dist < dist[v]:
                    dist[v] = new_dist
                    parent[v] = u
                    heapq.heappush(pq, (new_dist, v))

        execution_time = time.perf_counter() - start_time

        if end_node_id not in dist:
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
            distance=dist[end_node_id],
            nodes_explored=nodes_explored,
            execution_time=execution_time
        )