import math
from .graph import Graph
from .node import Node

class NearestNodeFinder:
    """
    Finds the nearest graph node to a given (latitude, longitude) coordinate.
    """
    def __init__(self, graph: Graph):
        self.graph = graph

    def find_nearest(self, lat: float, lon: float) -> int:
        """
        Finds the ID of the node closest to (lat, lon) using scaled Euclidean distance
        which is extremely fast and accurate for local coordinate areas.
        """
        if not self.graph.nodes:
            raise ValueError("The graph contains no nodes.")

        best_node_id = None
        min_dist_sq = float('inf')

        # Cache cos(lat) factor for Kathmandu latitude to adjust longitude scale
        # for accurate distance comparison.
        cos_lat = math.cos(math.radians(lat))

        for node_id, node in self.graph.nodes.items():
            d_lat = node.lat - lat
            d_lon = (node.lon - lon) * cos_lat
            dist_sq = d_lat * d_lat + d_lon * d_lon

            if dist_sq < min_dist_sq:
                min_dist_sq = dist_sq
                best_node_id = node_id

        return best_node_id
