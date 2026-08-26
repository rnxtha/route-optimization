import time
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Callable, Tuple


class RouteResult:
    """
    Represents the output of a route calculation.
    """
    def __init__(self,
                 path: List[int],
                 distance: float,
                 nodes_explored: int,
                 execution_time: float,
                 travel_time_seconds: Optional[float] = None,
                 traffic_stats: Optional[Dict[str, Any]] = None,
                 edges_detail: Optional[List[Dict[str, Any]]] = None):
        self.path = path  # List of node IDs in order
        self.distance = distance  # Total path distance in meters
        self.nodes_explored = nodes_explored  # Number of nodes popped/visited
        self.execution_time = execution_time  # In seconds
        self.path_nodes_count = len(path)
        self.travel_time_seconds = travel_time_seconds  # Effective travel seconds (ML traffic)
        self.traffic_stats = traffic_stats or {}  # Aggregate congestion stats
        self.edges_detail = edges_detail or []  # Per-edge ML weight details

    def to_dict(self) -> Dict[str, Any]:
        return {
            'path': self.path,
            'distance': self.distance,
            'nodes_explored': self.nodes_explored,
            'execution_time': self.execution_time,
            'path_nodes_count': self.path_nodes_count,
            'travel_time_seconds': self.travel_time_seconds,
            'traffic_stats': self.traffic_stats,
            'edges_detail_count': len(self.edges_detail),
        }

    def __repr__(self):
        tt = f", travel={self.travel_time_seconds/60:.1f}min" if self.travel_time_seconds else ""
        return (f"RouteResult(distance={self.distance / 1000.0:.2f} km, "
                f"time={self.execution_time:.4f}s, "
                f"explored={self.nodes_explored}, "
                f"path_nodes={self.path_nodes_count}{tt})")


class RouteAlgorithm(ABC):
    """
    Abstract Base Class for routing algorithms.
    """
    def __init__(self, name: str):
        self.name = name

    @abstractmethod
    def find_route(self, graph: Any, start_node_id: int, end_node_id: int,
                   penalized_edges: Any = None, penalty_factor: float = 1.0,
                   edge_weight_fn: Optional[Callable[[Any], Tuple[float, Dict[str, Any]]]] = None,
                   now_ts: Optional[float] = None) -> RouteResult:
        """
        Executes the routing algorithm to find the shortest path.
        Accepts an optional ``edge_weight_fn(edge) -> (weight, detail_dict)`` to
        enable ML traffic-aware dynamic edge weights.
        Returns a RouteResult.
        """
        pass

