from django.urls import path
from . import views

app_name = 'routing'

urlpatterns = [
    path('', views.dashboard, name='dashboard'),
    path('api/route/', views.calculate_route_api, name='calculate_route_api'),
]
