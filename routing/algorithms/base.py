import time
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple


class RouteResult:
    """
    Represents the output of a route calculation.
    `visited_order` records node IDs in the order they were popped/expanded,
    used for optional search-area visualization. It is kept separate from
    `path` so existing consumers are unaffected.
    """
    def __init__(self,
                 path: List[int],
                 distance: float,
                 nodes_explored: int,
                 execution_time: float,
                 visited_order: Optional[List[int]] = None):
        self.path = path  # List of node IDs in order
        self.distance = distance  # Total path distance in meters
        self.nodes_explored = nodes_explored  # Number of nodes popped/visited
        self.execution_time = execution_time  # In seconds
        self.path_nodes_count = len(path)
        self.visited_order = list(visited_order) if visited_order else []

    def to_dict(self, include_visited: bool = False) -> Dict[str, Any]:
        data = {
            'path': self.path,
            'distance': self.distance,
            'nodes_explored': self.nodes_explored,
            'execution_time': self.execution_time,
            'path_nodes_count': self.path_nodes_count,
        }
        if include_visited:
            data['visited_order'] = self.visited_order
        return data

    def __repr__(self):
        return (f"RouteResult(distance={self.distance / 1000.0:.2f} km, "
                f"time={self.execution_time:.4f}s, "
                f"explored={self.nodes_explored}, "
                f"path_nodes={self.path_nodes_count})")


class RouteAlgorithm(ABC):
    """
    Abstract Base Class for routing algorithms.
    """
    def __init__(self, name: str):
        self.name = name

    @abstractmethod
    def find_route(self, graph: Any, start_node_id: int, end_node_id: int,
                   penalized_edges: Any = None, penalty_factor: float = 1.0) -> RouteResult:
        """
        Executes the routing algorithm to find the shortest path.
        Returns a RouteResult.
        """
        pass