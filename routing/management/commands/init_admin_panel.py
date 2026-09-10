import os
from django.core.management.base import BaseCommand
from routing.models import GraphMetadata
from routing.services.routing_service import RoutingService
from django.conf import settings


class Command(BaseCommand):
    help = 'Initialize admin panel with graph metadata'

    def handle(self, *args, **options):
        try:
            # Get or create metadata
            metadata, created = GraphMetadata.objects.get_or_create(pk=1)
            
            # Load the graph to get statistics
            service = RoutingService()
            graph = service.graph
            
            # Update metadata
            metadata.total_nodes = len(graph.nodes)
            metadata.total_edges = sum(len(edges) for edges in graph.adjacency_list.values())
            metadata.graph_status = 'active'
            metadata.status_message = 'Graph initialized successfully'
            
            # Get file size
            graph_path = os.path.join(settings.BASE_DIR, 'routing', 'data', 'kathmandu_graph.json')
            if os.path.exists(graph_path):
                metadata.file_size_mb = round(os.path.getsize(graph_path) / (1024 * 1024), 2)
            
            metadata.save()
            
            if created:
                self.stdout.write(self.style.SUCCESS(f'✓ Graph metadata created successfully'))
            else:
                self.stdout.write(self.style.SUCCESS(f'✓ Graph metadata updated successfully'))
            
            self.stdout.write(f'  Total nodes: {metadata.total_nodes}')
            self.stdout.write(f'  Total edges: {metadata.total_edges}')
            self.stdout.write(f'  File size: {metadata.file_size_mb} MB')
            
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'✗ Error initializing graph metadata: {str(e)}'))
