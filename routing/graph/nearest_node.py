import math
from .graph import Graph
from .node import Node

class NearestNodeFinder:
    """
    Finds the nearest graph node to a given (latitude, longitude) coordinate.
    """
    def __init__(self, graph: Graph):
        self.graph = graph
        self._incoming = {node_id: set() for node_id in graph.nodes}
        for source_id, edges in graph.adjacency_list.items():
            for edge in edges:
                self._incoming.setdefault(edge.destination, set()).add(source_id)

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

    def find_nearest_junction(self, lat: float, lon: float) -> int:
        """Find the closest node that connects at least three road segments."""
        junction_ids = {
            node_id for node_id in self.graph.nodes
            if self._connection_count(node_id) >= 3
        }
        if not junction_ids:
            return self.find_nearest(lat, lon)
        return self._find_nearest_from(lat, lon, junction_ids)

    def _connection_count(self, node_id: int) -> int:
        outgoing = {edge.destination for edge in self.graph.get_neighbors(node_id)}
        return len(outgoing | self._incoming.get(node_id, set()))

    def _find_nearest_from(self, lat: float, lon: float, node_ids) -> int:
        cos_lat = math.cos(math.radians(lat))
        return min(
            node_ids,
            key=lambda node_id: (
                (self.graph.nodes[node_id].lat - lat) ** 2
                + ((self.graph.nodes[node_id].lon - lon) * cos_lat) ** 2
            )
        )
