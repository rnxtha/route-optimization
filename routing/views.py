import json
from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from .services.routing_service import RoutingService


def dashboard(request):
    return render(request, 'index.html')


@csrf_exempt
@require_POST
def calculate_route_api(request):
    try:
        data = json.loads(request.body)
        start_lat = float(data.get('start_lat'))
        start_lon = float(data.get('start_lon'))
        end_lat = float(data.get('end_lat'))
        end_lon = float(data.get('end_lon'))
    except (ValueError, TypeError, json.JSONDecodeError) as e:
        return JsonResponse({
            'success': False,
            'error': f'Invalid input payload. Details: {str(e)}'
        }, status=400)

    try:
        service = RoutingService()
        result = service.calculate_routes(start_lat, start_lon, end_lat, end_lon)

        if result['dijkstra']['distance_meters'] == float('inf') or not result['dijkstra']['path']:
            return JsonResponse({
                'success': False,
                'error': 'No route could be found between the selected coordinates.'
            }, status=404)

        return JsonResponse({
            'success': True,
            'data': result
        })

    except Exception as e:
        return JsonResponse({
            'success': False,
            'error': f'Internal server error: {str(e)}'
        }, status=500)
