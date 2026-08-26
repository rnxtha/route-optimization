class Node:
    """
    Represents a single node (intersection or point) in the road network.
    """
    def __init__(self, id: int, lat: float, lon: float):
        self.id = id
        self.lat = lat
        self.lon = lon

    def __repr__(self):
        return f"Node(id={self.id}, lat={self.lat}, lon={self.lon})"

    def to_dict(self):
        return {
            'id': self.id,
            'lat': self.lat,
            'lon': self.lon
        }
