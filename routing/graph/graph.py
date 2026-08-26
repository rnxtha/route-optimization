from typing import Dict, List
from .node import Node
from .edge import Edge

class Graph:
    """
    Represents the road network graph.
    Uses adjacency list representation.
    """
    def __init__(self):
        self.nodes: Dict[int, Node] = {}
        self.adjacency_list: Dict[int, List[Edge]] = {}

    def add_node(self, node: Node):
        """Adds a node to the graph."""
        self.nodes[node.id] = node
        if node.id not in self.adjacency_list:
            self.adjacency_list[node.id] = []

    def add_edge(self, edge: Edge):
        """
        Adds a directed edge to the graph.
        Ensure both source and destination nodes exist before calling this.
        """
        if edge.source in self.nodes and edge.destination in self.nodes:
            self.adjacency_list[edge.source].append(edge)
        else:
            raise ValueError(f"Nodes {edge.source} or {edge.destination} must exist in the graph.")

    def get_node(self, node_id: int) -> Node:
        """Returns the Node object for a given node_id, or None if it doesn't exist."""
        return self.nodes.get(node_id)

    def get_neighbors(self, node_id: int) -> List[Edge]:
        """Returns a list of Edge objects originating from node_id."""
        return self.adjacency_list.get(node_id, [])

    def to_dict(self) -> dict:
        """Serializes the graph into a JSON-serializable dictionary."""
        return {
            'nodes': [node.to_dict() for node in self.nodes.values()],
            'edges': [
                edge.to_dict()
                for edges in self.adjacency_list.values()
                for edge in edges
            ]
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'Graph':
        """Deserializes a graph from a dictionary representation."""
        graph = cls()
        for n_data in data['nodes']:
            node = Node(id=n_data['id'], lat=n_data['lat'], lon=n_data['lon'])
            graph.add_node(node)
        for e_data in data['edges']:
            edge = Edge(
                source=e_data['source'],
                destination=e_data['destination'],
                distance=e_data['distance'],
                name=e_data.get('name', ''),
                highway=e_data.get('highway', ''),
                oneway=e_data.get('oneway', False)
            )
            graph.add_edge(edge)
        return graph
