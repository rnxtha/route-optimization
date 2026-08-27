import time
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple


class RouteResult:
    """
    Represents the output of a route calculation.
    """
    def __init__(self,
                 path: List[int],
                 distance: float,
                 nodes_explored: int,
                 execution_time: float):
        self.path = path  # List of node IDs in order
        self.distance = distance  # Total path distance in meters
        self.nodes_explored = nodes_explored  # Number of nodes popped/visited
        self.execution_time = execution_time  # In seconds
        self.path_nodes_count = len(path)

    def to_dict(self) -> Dict[str, Any]:
        return {
            'path': self.path,
            'distance': self.distance,
            'nodes_explored': self.nodes_explored,
            'execution_time': self.execution_time,
            'path_nodes_count': self.path_nodes_count,
        }

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