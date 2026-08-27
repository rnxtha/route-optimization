from django.urls import path
from . import views

app_name = 'routing'

urlpatterns = [
    path('', views.dashboard, name='dashboard'),
    path('api/route/', views.calculate_route_api, name='calculate_route_api'),
    path('api/graph/info/', views.graph_info_api, name='graph_info_api'),
    path('api/graph/download/', views.graph_download_api, name='graph_download_api'),
]
