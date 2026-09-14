import os

from django.test import TestCase
from django.conf import settings
from unittest.mock import patch

from routing.graph.graph import Graph
from routing.graph.loader import GraphLoader


class AppGeocodeContractTests(TestCase):
    def test_app_js_uses_backend_place_search_api_instead_of_nominatim_geocoder(self):
        """The browser should stop hardcoding the external Nominatim search endpoint.

        The live category API in the Django app should serve the search fallback,
        so place names and categories stay aligned with the same map data source.
        """
        app_js_path = os.path.join(settings.BASE_DIR, 'static', 'js', 'app.js')
        with open(app_js_path, 'r', encoding='utf-8') as fh:
            app_js = fh.read()

        self.assertNotIn('nominatim.openstreetmap.org/search?', app_js)


class GraphLoaderTests(TestCase):
    @patch('routing.graph.loader.GraphLoader._download_graph_from_osm')
    @patch('routing.graph.loader.GraphLoader._save_graph_to_cache')
    def test_load_or_build_force_refresh_downloads_latest(self, mock_save_cache, mock_download):
        """force_refresh=True should bypass the cached JSON and fetch the latest graph."""
        latest_graph = Graph()
        mock_download.return_value = latest_graph

        result = GraphLoader.load_or_build(force_refresh=True)

        self.assertIs(result, latest_graph)
        mock_download.assert_called_once()
        mock_save_cache.assert_called_once_with(latest_graph, GraphLoader.get_cache_path())
