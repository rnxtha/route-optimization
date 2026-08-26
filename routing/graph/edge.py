class Edge:
    """
    Represents a directed edge (road segment) between two nodes in the road network.
    """
    def __init__(self, source: int, destination: int, distance: float, name: str = "", highway: str = "", oneway: bool = False):
        self.source = source
        self.destination = destination
        self.distance = distance  # in meters
        self.name = name or "Unnamed Road"
        self.highway = highway or "residential"
        self.oneway = oneway

    def __repr__(self):
        return f"Edge(source={self.source}, destination={self.destination}, distance={self.distance}m, name='{self.name}')"

    def to_dict(self):
        return {
            'source': self.source,
            'destination': self.destination,
            'distance': self.distance,
            'name': self.name,
            'highway': self.highway,
            'oneway': self.oneway
        }
