from django.db import models
from django.utils import timezone


class GraphMetadata(models.Model):
    """Stores metadata about the current graph"""
    total_nodes = models.IntegerField(default=0)
    total_edges = models.IntegerField(default=0)
    last_updated = models.DateTimeField(auto_now=True)
    graph_source = models.CharField(max_length=255, default="OSM", help_text="Source of the graph data")
    graph_region = models.CharField(max_length=255, default="Kathmandu", help_text="Geographic region")
    file_size_mb = models.FloatField(default=0, help_text="Size of graph file in MB")
    graph_status = models.CharField(
        max_length=50,
        choices=[
            ('active', 'Active'),
            ('loading', 'Loading'),
            ('error', 'Error'),
        ],
        default='active'
    )
    status_message = models.TextField(blank=True, null=True)
    
    class Meta:
        verbose_name = "Graph Metadata"
        verbose_name_plural = "Graph Metadata"
    
    def __str__(self):
        return f"Graph ({self.total_nodes} nodes, {self.total_edges} edges)"


class RouteStatistic(models.Model):
    """Stores statistics for each route calculation"""
    ALGORITHM_CHOICES = [
        ('dijkstra', 'Dijkstra'),
        ('astar', 'A*'),
    ]
    
    algorithm = models.CharField(max_length=20, choices=ALGORITHM_CHOICES)
    execution_time_ms = models.FloatField(help_text="Execution time in milliseconds")
    distance_meters = models.FloatField(help_text="Route distance in meters")
    nodes_explored = models.IntegerField(help_text="Number of nodes explored")
    path_length = models.IntegerField(help_text="Number of nodes in the path")
    start_lat = models.FloatField()
    start_lon = models.FloatField()
    end_lat = models.FloatField()
    end_lon = models.FloatField()
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['algorithm', '-created_at']),
            models.Index(fields=['-created_at']),
        ]
    
    def __str__(self):
        return f"{self.get_algorithm_display()} - {self.execution_time_ms}ms - {self.created_at}"
