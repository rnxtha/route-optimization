import json
import os
from datetime import timedelta
from django.shortcuts import render, redirect
from django.http import JsonResponse
from django.views.decorators.http import require_POST, require_GET
from django.utils import timezone
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Avg, Q
from django.conf import settings
from .models import GraphMetadata, RouteStatistic
from .services.routing_service import RoutingService
from .graph.graph import Graph
from .graph.loader import GraphLoader


@login_required(login_url='/admin/login/')
def admin_dashboard(request):
    """Admin dashboard showing system information + basic algorithm stats."""
    # Get or create graph metadata
    metadata, created = GraphMetadata.objects.get_or_create(pk=1)

    # Sync metadata file size / freshness from the on-disk graph cache.
    try:
        info = GraphLoader.get_graph_info()
        if info.get('exists'):
            metadata.file_size_mb = info.get('size_mb', metadata.file_size_mb)
            if metadata.total_nodes == 0 and info.get('nodes'):
                metadata.total_nodes = info['nodes']
                metadata.total_edges = info.get('edges', 0)
            metadata.save(update_fields=['file_size_mb', 'total_nodes', 'total_edges'])
    except Exception:
        info = {}
    
    # Calculate statistics
    now = timezone.now()
    last_24h = now - timedelta(hours=24)
    last_7d = now - timedelta(days=7)
    
    stats_24h = RouteStatistic.objects.filter(created_at__gte=last_24h)
    stats_7d = RouteStatistic.objects.filter(created_at__gte=last_7d)

    def _avg(qs, field):
        return qs.aggregate(Avg(field))[f'{field}__avg'] or 0

    d_avg_24 = _avg(stats_24h.filter(algorithm='dijkstra'), 'execution_time_ms')
    a_avg_24 = _avg(stats_24h.filter(algorithm='astar'), 'execution_time_ms')
    d_avg_7 = _avg(stats_7d.filter(algorithm='dijkstra'), 'execution_time_ms')
    a_avg_7 = _avg(stats_7d.filter(algorithm='astar'), 'execution_time_ms')
    d_nodes_7 = _avg(stats_7d.filter(algorithm='dijkstra'), 'nodes_explored')
    a_nodes_7 = _avg(stats_7d.filter(algorithm='astar'), 'nodes_explored')

    faster_24, speedup_24, reduction_24 = None, 0, 0
    if d_avg_24 and a_avg_24:
        if a_avg_24 < d_avg_24:
            faster_24, speedup_24 = 'A*', d_avg_24 / a_avg_24
        else:
            faster_24, speedup_24 = 'Dijkstra', a_avg_24 / d_avg_24
    d_nodes_24 = _avg(stats_24h.filter(algorithm='dijkstra'), 'nodes_explored')
    a_nodes_24 = _avg(stats_24h.filter(algorithm='astar'), 'nodes_explored')
    if d_nodes_24:
        reduction_24 = round((d_nodes_24 - a_nodes_24) / d_nodes_24 * 100.0, 1)

    faster_7d, speedup_7d, reduction_7d = None, 0, 0
    if d_avg_7 and a_avg_7:
        if a_avg_7 < d_avg_7:
            faster_7d, speedup_7d = 'A*', d_avg_7 / a_avg_7
        else:
            faster_7d, speedup_7d = 'Dijkstra', a_avg_7 / d_avg_7
    if d_nodes_7:
        reduction_7d = round((d_nodes_7 - a_nodes_7) / d_nodes_7 * 100.0, 1)
    
    context = {
        'metadata': metadata,
        'graph_info': info,
        'total_routes_24h': stats_24h.count(),
        'total_routes_7d': stats_7d.count(),
        'dijkstra_avg_time_24h': d_avg_24,
        'astar_avg_time_24h': a_avg_24,
        'dijkstra_avg_time_7d': d_avg_7,
        'astar_avg_time_7d': a_avg_7,
        'dijkstra_avg_nodes_7d': d_nodes_7,
        'astar_avg_nodes_7d': a_nodes_7,
        'faster_algorithm_24h': faster_24,
        'speedup_24h': speedup_24,
        'node_reduction_24h': reduction_24,
        'faster_algorithm_7d': faster_7d,
        'speedup_7d': speedup_7d,
        'node_reduction_7d': reduction_7d,
    }
    
    return render(request, 'admin/dashboard.html', context)


@login_required(login_url='/admin/login/')
def graph_management(request):
    """Graph management view for uploading and rebuilding graphs"""
    metadata, created = GraphMetadata.objects.get_or_create(pk=1)
    
    context = {
        'metadata': metadata,
    }
    
    return render(request, 'admin/graph_management.html', context)


@require_POST
@login_required(login_url='/admin/login/')
def upload_graph(request):
    """API endpoint to upload and rebuild the graph"""
    try:
        if 'graph_file' not in request.FILES:
            return JsonResponse({'success': False, 'error': 'No file provided'}, status=400)
        
        graph_file = request.FILES['graph_file']
        
        # Validate JSON
        try:
            graph_data = json.loads(graph_file.read().decode('utf-8'))
        except json.JSONDecodeError:
            return JsonResponse({'success': False, 'error': 'Invalid JSON file'}, status=400)
        
        # Validate structure
        if 'nodes' not in graph_data or 'edges' not in graph_data:
            return JsonResponse({'success': False, 'error': 'Graph must contain "nodes" and "edges"'}, status=400)
        
        # Update graph metadata
        metadata, _ = GraphMetadata.objects.get_or_create(pk=1)
        metadata.graph_status = 'loading'
        metadata.status_message = 'Loading graph...'
        metadata.save()
        
        # Save the file
        graph_path = os.path.join(settings.BASE_DIR, 'routing', 'data', 'kathmandu_graph.json')
        os.makedirs(os.path.dirname(graph_path), exist_ok=True)
        
        with open(graph_path, 'wb') as f:
            f.write(graph_file.read())
        
        # Rebuild the graph
        try:
            # Force reload the graph
            RoutingService._graph = None
            new_graph = RoutingService.get_graph()
            
            # Update metadata
            metadata.total_nodes = len(new_graph.nodes)
            metadata.total_edges = sum(len(edges) for edges in new_graph.adjacency_list.values())
            metadata.file_size_mb = round(os.path.getsize(graph_path) / (1024 * 1024), 2)
            metadata.graph_status = 'active'
            metadata.status_message = 'Graph loaded successfully'
            metadata.save()
            
            return JsonResponse({
                'success': True,
                'message': 'Graph uploaded and rebuilt successfully',
                'nodes': metadata.total_nodes,
                'edges': metadata.total_edges,
                'file_size_mb': metadata.file_size_mb,
            })
        except Exception as e:
            metadata.graph_status = 'error'
            metadata.status_message = f'Error loading graph: {str(e)}'
            metadata.save()
            return JsonResponse({
                'success': False,
                'error': f'Failed to rebuild graph: {str(e)}'
            }, status=500)
    
    except Exception as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=500)


@require_GET
@login_required(login_url='/admin/login/')
def rebuild_graph(request):
    """API endpoint to rebuild the graph from the latest OpenStreetMap network."""
    try:
        metadata, _ = GraphMetadata.objects.get_or_create(pk=1)
        metadata.graph_status = 'loading'
        metadata.status_message = 'Rebuilding graph from latest map data...'
        metadata.save()

        try:
            # Force reload the graph from the latest OSM snapshot
            RoutingService._graph = None
            new_graph = RoutingService.get_graph(force_refresh=True)

            # Update metadata
            import os as _os
            metadata.total_nodes = len(new_graph.nodes)
            metadata.total_edges = sum(len(edges) for edges in new_graph.adjacency_list.values())
            try:
                metadata.file_size_mb = round(_os.path.getsize(GraphLoader.get_cache_path()) / (1024 * 1024), 2)
            except OSError:
                pass
            metadata.graph_source = GraphLoader.DATA_SOURCE
            metadata.graph_region = "Kathmandu Valley (85.15,27.55 → 85.55,27.82)"
            metadata.graph_status = 'active'
            metadata.status_message = f'Graph rebuilt successfully from latest OSM data ({GraphLoader.GRAPH_VERSION})'
            metadata.save()

            return JsonResponse({
                'success': True,
                'message': 'Graph rebuilt successfully from latest map data',
                'nodes': metadata.total_nodes,
                'edges': metadata.total_edges,
                'file_size_mb': metadata.file_size_mb,
                'graph_version': GraphLoader.GRAPH_VERSION,
            })
        except Exception as e:
            metadata.graph_status = 'error'
            metadata.status_message = f'Error rebuilding graph: {str(e)}'
            metadata.save()
            return JsonResponse({
                'success': False,
                'error': f'Failed to rebuild graph: {str(e)}'
            }, status=500)

    except Exception as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=500)


@login_required(login_url='/admin/login/')
def algorithm_statistics(request):
    """Statistics view for algorithm performance"""
    now = timezone.now()
    last_7d = now - timedelta(days=7)
    last_30d = now - timedelta(days=30)
    
    # Get recent statistics
    recent_stats = RouteStatistic.objects.all()[:100]
    
    # Algorithm comparison (last 7 days)
    dijkstra_stats = RouteStatistic.objects.filter(
        algorithm='dijkstra',
        created_at__gte=last_7d
    )
    astar_stats = RouteStatistic.objects.filter(
        algorithm='astar',
        created_at__gte=last_7d
    )
    
    dijkstra_summary = {
        'count': dijkstra_stats.count(),
        'avg_time_ms': dijkstra_stats.aggregate(Avg('execution_time_ms'))['execution_time_ms__avg'] or 0,
        'avg_distance': dijkstra_stats.aggregate(Avg('distance_meters'))['distance_meters__avg'] or 0,
        'avg_nodes_explored': dijkstra_stats.aggregate(Avg('nodes_explored'))['nodes_explored__avg'] or 0,
        'min_time_ms': dijkstra_stats.aggregate(models.Min('execution_time_ms'))['execution_time_ms__min'] or 0,
        'max_time_ms': dijkstra_stats.aggregate(models.Max('execution_time_ms'))['execution_time_ms__max'] or 0,
    }
    
    astar_summary = {
        'count': astar_stats.count(),
        'avg_time_ms': astar_stats.aggregate(Avg('execution_time_ms'))['execution_time_ms__avg'] or 0,
        'avg_distance': astar_stats.aggregate(Avg('distance_meters'))['distance_meters__avg'] or 0,
        'avg_nodes_explored': astar_stats.aggregate(Avg('nodes_explored'))['nodes_explored__avg'] or 0,
        'min_time_ms': astar_stats.aggregate(models.Min('execution_time_ms'))['execution_time_ms__min'] or 0,
        'max_time_ms': astar_stats.aggregate(models.Max('execution_time_ms'))['execution_time_ms__max'] or 0,
    }

    performance_ratio = 0
    faster_algorithm = None
    if astar_summary['avg_time_ms'] > 0 and dijkstra_summary['avg_time_ms'] > 0:
        if astar_summary['avg_time_ms'] < dijkstra_summary['avg_time_ms']:
            faster_algorithm = 'A*'
            performance_ratio = dijkstra_summary['avg_time_ms'] / astar_summary['avg_time_ms']
        elif dijkstra_summary['avg_time_ms'] < astar_summary['avg_time_ms']:
            faster_algorithm = 'Dijkstra'
            performance_ratio = astar_summary['avg_time_ms'] / dijkstra_summary['avg_time_ms']
    
    context = {
        'recent_stats': recent_stats,
        'dijkstra_summary': dijkstra_summary,
        'astar_summary': astar_summary,
        'faster_algorithm': faster_algorithm,
        'performance_ratio': performance_ratio,
    }
    
    return render(request, 'admin/statistics.html', context)


@require_GET
def get_statistics_json(request):
    """API endpoint to get statistics data for charts"""
    algorithm = request.GET.get('algorithm', 'all')
    days = int(request.GET.get('days', 7))
    
    now = timezone.now()
    since = now - timedelta(days=days)
    
    if algorithm == 'all':
        stats = RouteStatistic.objects.filter(created_at__gte=since).order_by('created_at')
    else:
        stats = RouteStatistic.objects.filter(
            algorithm=algorithm,
            created_at__gte=since
        ).order_by('created_at')
    
    # Group by day
    daily_data = {}
    for stat in stats:
        date_key = stat.created_at.date().isoformat()
        if date_key not in daily_data:
            daily_data[date_key] = []
        daily_data[date_key].append({
            'time_ms': stat.execution_time_ms,
            'distance': stat.distance_meters,
            'nodes': stat.nodes_explored,
            'algorithm': stat.algorithm,
        })
    
    # Calculate daily averages
    chart_data = {
        'dates': [],
        'dijkstra_time': [],
        'astar_time': [],
        'dijkstra_nodes': [],
        'astar_nodes': [],
    }
    
    for date_key in sorted(daily_data.keys()):
        daily_stats = daily_data[date_key]
        dijkstra_times = [s['time_ms'] for s in daily_stats if s['algorithm'] == 'dijkstra']
        astar_times = [s['time_ms'] for s in daily_stats if s['algorithm'] == 'astar']
        dijkstra_nodes = [s['nodes'] for s in daily_stats if s['algorithm'] == 'dijkstra']
        astar_nodes = [s['nodes'] for s in daily_stats if s['algorithm'] == 'astar']
        
        chart_data['dates'].append(date_key)
        chart_data['dijkstra_time'].append(sum(dijkstra_times) / len(dijkstra_times) if dijkstra_times else 0)
        chart_data['astar_time'].append(sum(astar_times) / len(astar_times) if astar_times else 0)
        chart_data['dijkstra_nodes'].append(sum(dijkstra_nodes) / len(dijkstra_nodes) if dijkstra_nodes else 0)
        chart_data['astar_nodes'].append(sum(astar_nodes) / len(astar_nodes) if astar_nodes else 0)
    
    return JsonResponse(chart_data)


from django.db import models
