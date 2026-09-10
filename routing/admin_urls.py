from django.urls import path
from . import admin_views

app_name = 'admin_panel'

urlpatterns = [
    path('dashboard/', admin_views.admin_dashboard, name='dashboard'),
    path('graph-management/', admin_views.graph_management, name='graph_management'),
    path('graph/upload/', admin_views.upload_graph, name='upload_graph'),
    path('graph/rebuild/', admin_views.rebuild_graph, name='rebuild_graph'),
    path('statistics/', admin_views.algorithm_statistics, name='statistics'),
    path('api/statistics/', admin_views.get_statistics_json, name='statistics_json'),
]
