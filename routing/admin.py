from django.contrib import admin
from .models import GraphMetadata, RouteStatistic


@admin.register(GraphMetadata)
class GraphMetadataAdmin(admin.ModelAdmin):
    list_display = ('total_nodes', 'total_edges', 'graph_status', 'last_updated')
    readonly_fields = ('last_updated',)
    fieldsets = (
        ('Graph Info', {
            'fields': ('graph_source', 'graph_region')
        }),
        ('Statistics', {
            'fields': ('total_nodes', 'total_edges', 'file_size_mb')
        }),
        ('Status', {
            'fields': ('graph_status', 'status_message', 'last_updated')
        }),
    )


@admin.register(RouteStatistic)
class RouteStatisticAdmin(admin.ModelAdmin):
    list_display = ('algorithm', 'execution_time_ms', 'distance_meters', 'nodes_explored', 'created_at')
    list_filter = ('algorithm', 'created_at')
    search_fields = ('algorithm',)
    readonly_fields = ('created_at', 'start_lat', 'start_lon', 'end_lat', 'end_lon')
    
    fieldsets = (
        ('Algorithm', {
            'fields': ('algorithm', 'execution_time_ms')
        }),
        ('Route Details', {
            'fields': ('distance_meters', 'nodes_explored', 'path_length')
        }),
        ('Coordinates', {
            'fields': ('start_lat', 'start_lon', 'end_lat', 'end_lon'),
            'classes': ('collapse',)
        }),
        ('Timestamp', {
            'fields': ('created_at',),
            'classes': ('collapse',)
        }),
    )
