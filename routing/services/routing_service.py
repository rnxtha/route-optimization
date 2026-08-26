from typing import Dict, Any, Tuple, List, Set, Callable, Optional
import time
from ..graph.loader import GraphLoader
from ..graph.nearest_node import NearestNodeFinder
from ..algorithms.dijkstra import Dijkstra
from ..algorithms.astar import AStar
from .traffic_predictor import TrafficPredictor

ROAD_SPEED_KMH = {
    'motorway': 80,
    'motorway_link': 60,
    'trunk': 70,
    'trunk_link': 50,
    'primary': 50,
    'primary_link': 40,
    'secondary': 40,
    'secondary_link': 35,
    'tertiary': 35,
    'tertiary_link': 30,
    'residential': 25,
    'unclassified': 25,
    'service': 20,
    'living_street': 15,
}
DEFAULT_SPEED_KMH = 30


class RoutingService:
    _graph = None
    _traffic = None

    @classmethod
    def get_graph(cls):
        if cls._graph is None:
            cls._graph = GraphLoader.load_or_build()
        return cls._graph

    @classmethod
    def get_traffic_predictor(cls):
        if cls._traffic is None:
            cls._traffic = TrafficPredictor(cls.get_graph())
            try:
                import os
                from django.conf import settings
                cache_path = os.path.join(settings.BASE_DIR, 'routing', 'data', 'traffic_effects.json')
                if os.path.exists(cache_path):
                    cls._traffic.load_effects(cache_path)
            except Exception:
                pass
        return cls._traffic

    def __init__(self):
        self.graph = self.get_graph()
        self.finder = NearestNodeFinder(self.graph)
        self.dijkstra_algo = Dijkstra()
        self.astar_algo = AStar()
        self.traffic = self.get_traffic_predictor()
        self._now_ts = time.time()

    # ---- helpers ------------------------------------------------------------
    def _distance_weight_fn(self):
        """Baseline weight function: weight = edge distance in meters."""
        def w(edge):
            return (float(edge.distance), {
                'distance_m': float(edge.distance),
                'highway_class': edge.highway or 'residential',
                'road_name': edge.name or 'Unnamed Road',
                'freeflow_speed_kmh': ROAD_SPEED_KMH.get(edge.highway, DEFAULT_SPEED_KMH),
                'predicted_seconds': float(edge.distance) / (ROAD_SPEED_KMH.get(edge.highway, DEFAULT_SPEED_KMH) / 3.6),
                'congestion_factor': 1.0,
                'congestion_level': 'free',
            })
        return w

    def _traffic_weight_fn(self):
        """ML-aware weight function: weight = travel time in seconds (predicted)."""
        now = self._now_ts
        traffic = self.traffic
        def w(edge):
            seconds, detail = traffic.predict_edge_weight(edge, now)
            return (float(seconds), detail)
        return w

    def _get_path_edges(self, path: List[int]) -> Set[Tuple[int, int]]:
        edges = set()
        for i in range(len(path) - 1):
            edges.add((path[i], path[i + 1]))
        return edges

    def _get_road_names(self, path: List[int]) -> List[str]:
        names = []
        for i in range(len(path) - 1):
            for edge in self.graph.get_neighbors(path[i]):
                if edge.destination == path[i + 1]:
                    road_name = edge.name if edge.name and edge.name != "Unnamed Road" else ""
                    names.append(road_name)
                    break
        return names

    def _get_unique_road_names(self, path: List[int]) -> List[str]:
        seen = set()
        unique = []
        for name in self._get_road_names(path):
            if name and name not in seen:
                seen.add(name)
                unique.append(name)
        return unique

    def _estimate_travel_time_minutes(self, path: List[int], freeflow: bool = True) -> float:
        total_seconds = 0.0
        for i in range(len(path) - 1):
            for edge in self.graph.get_neighbors(path[i]):
                if edge.destination == path[i + 1]:
                    if freeflow:
                        speed_kmh = ROAD_SPEED_KMH.get(edge.highway, DEFAULT_SPEED_KMH)
                        speed_ms = speed_kmh / 3.6
                        if speed_ms > 0:
                            total_seconds += edge.distance / speed_ms
                    else:
                        seconds, _ = self.traffic.predict_edge_weight(edge, self._now_ts)
                        total_seconds += seconds
                    break
        return round(total_seconds / 60.0, 1)

    def _build_route_result(self, route_result, path: List[int], label: str,
                            travel_mode: str = 'distance') -> Dict[str, Any]:
        road_names = self._get_road_names(path)
        unique_roads = self._get_unique_road_names(path)
        freeflow_travel = self._estimate_travel_time_minutes(path, freeflow=True)

        # Always re-evaluate traffic stats & travel time with the ML predictor
        # on the computed path, so both baseline & optimized are compared
        # apples-to-apples using the same ML traffic model.
        path_edges = []
        for i in range(len(path) - 1):
            u, v = path[i], path[i + 1]
            for e in self.graph.get_neighbors(u):
                if e.destination == v:
                    path_edges.append(e)
                    break
        ml_stats = self.traffic.aggregate_route_stats(path_edges, self._now_ts) if path_edges else {}
        ml_predicted_minutes = ml_stats.get('predicted_total_minutes') if ml_stats else None

        if ml_predicted_minutes is not None:
            travel_time = ml_predicted_minutes
        elif travel_mode == 'traffic' and route_result.travel_time_seconds is not None:
            travel_time = round(route_result.travel_time_seconds / 60.0, 1)
        else:
            travel_time = freeflow_travel

        # Merge route_result stats (from routing) with ML stats (truth on path),
        # preferring ML stats for congestion info.
        merged_stats = dict(route_result.traffic_stats or {})
        if ml_stats:
            merged_stats.update({
                'edges_count': ml_stats.get('edges_count', merged_stats.get('edges_count')),
                'dominant_congestion': ml_stats.get('dominant_congestion', merged_stats.get('dominant_congestion', 'free')),
                'level_counts': ml_stats.get('level_counts', merged_stats.get('level_counts', {})),
                'worst_edge': ml_stats.get('worst_edge', merged_stats.get('worst_edge')),
                'freeflow_total_minutes': ml_stats.get('freeflow_total_minutes'),
                'predicted_total_minutes': ml_stats.get('predicted_total_minutes'),
                'overall_congestion_factor': ml_stats.get('overall_congestion_factor'),
            })

        coords = []
        for nid in path:
            node = self.graph.get_node(nid)
            if node:
                coords.append((node.lat, node.lon))
        return {
            'label': label,
            'distance_meters': route_result.distance,
            'distance_km': round(route_result.distance / 1000.0, 3) if route_result.distance != float('inf') else None,
            'execution_time_seconds': route_result.execution_time,
            'nodes_explored': route_result.nodes_explored,
            'path_nodes_count': route_result.path_nodes_count,
            'path': coords,
            'road_names': road_names,
            'unique_road_names': unique_roads[:15],
            'travel_time_minutes': travel_time,
            'freeflow_travel_minutes': freeflow_travel,
            'travel_mode': travel_mode,
            'traffic_stats': merged_stats,
        }

    def _build_explanation(self, baseline, optimized) -> Dict[str, Any]:
        """
        Build a human-readable comparison explaining why the traffic-optimized
        route was (or wasn't) selected differently from the distance baseline.
        """
        b_km = baseline.get('distance_km') or 0.0
        o_km = optimized.get('distance_km') or 0.0
        b_t = baseline.get('travel_time_minutes') or 0.0
        o_t = optimized.get('travel_time_minutes') or 0.0
        delta_km = o_km - b_km
        delta_t = o_t - b_t
        same_path = baseline.get('path') == optimized.get('path')

        # Count congested segments per route
        def heavy_count(stats):
            lc = (stats or {}).get('level_counts') or {}
            return lc.get('heavy', 0) + lc.get('moderate', 0)

        b_heavy = heavy_count(baseline.get('traffic_stats'))
        o_heavy = heavy_count(optimized.get('traffic_stats'))

        reasons = []
        if same_path:
            reasons.append("The shortest route was also optimal for traffic — no detour needed.")
        else:
            if delta_t < -0.05:
                minutes_saved = abs(delta_t)
                reasons.append(
                    f"The traffic-optimized route is {minutes_saved:.1f} minutes faster "
                    f"({b_t:.1f} → {o_t:.1f} min) by avoiding heavy-congestion corridors."
                )
                if abs(delta_km) > 0.05:
                    if delta_km > 0:
                        reasons.append(
                            f"It travels {delta_km:.2f} km farther ({b_km:.2f} → {o_km:.2f} km) "
                            f"to detour around bottlenecks."
                        )
                    else:
                        reasons.append(
                            f"It is also {abs(delta_km):.2f} km shorter ({b_km:.2f} → {o_km:.2f} km)."
                        )
            elif abs(delta_t) <= 0.05:
                reasons.append(
                    "Both routes have near-identical predicted travel times. "
                    "Prefer the shorter one for comfort and lower fuel use."
                )
            else:
                reasons.append(
                    f"Curiously, the shorter baseline is also faster (+{delta_t:.1f} min for the optimized path); "
                    f"this happens when detours hit equal-or-worse traffic elsewhere."
                )

        if b_heavy != o_heavy:
            reasons.append(
                f"Heavy/moderate segments: baseline {b_heavy} vs optimized {o_heavy}."
            )

        if optimized.get('traffic_stats', {}).get('worst_edge'):
            we = optimized['traffic_stats']['worst_edge']
            name = we.get('road_name', 'Unnamed')
            level = we.get('congestion_level', 'free')
            speed = we.get('effective_speed_kmh', 0)
            reasons.append(
                f"Slowest road on optimized route: {name} ({level}, ~{speed:.0f} km/h effective)."
            )

        # Recommendation
        if same_path:
            recommendation = "Single best route — no difference between baseline and traffic-aware."
        elif delta_t < -0.1:
            recommendation = "✅ Use the traffic-optimized route: faster despite any added distance."
        elif delta_km < -0.01 and delta_t <= 0.1:
            recommendation = "✅ Optimized route is both shorter and at least as fast."
        else:
            recommendation = "ℹ️ Baseline (shortest) route recommended; time difference is negligible."

        return {
            'same_path': same_path,
            'distance_delta_km': round(delta_km, 3),
            'travel_time_delta_minutes': round(delta_t, 2),
            'baseline_congested_segments': b_heavy,
            'optimized_congested_segments': o_heavy,
            'reasons': reasons,
            'recommendation': recommendation,
            'time_of_day_factor': round(self.traffic._time_multiplier(self._now_ts), 2),
            'traffic_calibration_summary': self.traffic.calibrate_on_graph(self.graph, n_samples=200),
        }

    # ---- main entry ---------------------------------------------------------
    def calculate_routes(self, start_lat: float, start_lon: float,
                         end_lat: float, end_lon: float) -> Dict[str, Any]:
        self._now_ts = time.time()
        start_node_id = self.finder.find_nearest(start_lat, start_lon)
        end_node_id = self.finder.find_nearest(end_lat, end_lon)

        distance_w = self._distance_weight_fn()
        traffic_w = self._traffic_weight_fn()

        # 1) Baseline: Dijkstra on raw distance (shortest route)
        dijkstra_baseline = self.dijkstra_algo.find_route(
            self.graph, start_node_id, end_node_id,
            edge_weight_fn=distance_w, now_ts=self._now_ts,
        )

        # 2) A* with raw-distance heuristic (fastest shortest-route search)
        astar_baseline = self.astar_algo.find_route(
            self.graph, start_node_id, end_node_id,
            edge_weight_fn=distance_w, now_ts=self._now_ts,
        )

        # 3) ML-traffic-optimized: A* on predicted travel-time weights
        astar_traffic = self.astar_algo.find_route(
            self.graph, start_node_id, end_node_id,
            edge_weight_fn=traffic_w, now_ts=self._now_ts,
        )

        # 4) Also run Dijkstra with traffic weights — serves as second-best baseline
        dijkstra_traffic = self.dijkstra_algo.find_route(
            self.graph, start_node_id, end_node_id,
            edge_weight_fn=traffic_w, now_ts=self._now_ts,
        )

        # Sanity: if traffic search returned no path, fall back to baseline path/info
        if not astar_traffic.path or astar_traffic.distance == float('inf'):
            astar_traffic = astar_baseline
            dijkstra_traffic = dijkstra_baseline

        best_distance_path = dijkstra_baseline.path if dijkstra_baseline.path else astar_baseline.path
        best_traffic_path = astar_traffic.path if astar_traffic.path else best_distance_path
        best_edges = self._get_path_edges(best_distance_path)

        # Alternatives using penalty on the distance-optimal path
        alt1_result = self.dijkstra_algo.find_route(
            self.graph, start_node_id, end_node_id,
            penalized_edges=self._get_path_edges(best_distance_path),
            penalty_factor=3.0,
            edge_weight_fn=traffic_w, now_ts=self._now_ts,
        )
        combined = set(best_edges)
        if alt1_result.path:
            combined.update(self._get_path_edges(alt1_result.path))
        alt2_result = self.astar_algo.find_route(
            self.graph, start_node_id, end_node_id,
            penalized_edges=combined,
            penalty_factor=4.0,
            edge_weight_fn=traffic_w, now_ts=self._now_ts,
        )

        start_node = self.graph.get_node(start_node_id)
        end_node = self.graph.get_node(end_node_id)

        dijkstra_out = self._build_route_result(dijkstra_baseline, dijkstra_baseline.path,
                                                'Dijkstra · Shortest (baseline distance)', 'distance')
        astar_dist_out = self._build_route_result(astar_baseline, astar_baseline.path,
                                                  'A* · Shortest (fast search)', 'distance')
        # We publish A* traffic as the primary "A* optimized" result
        astar_out = self._build_route_result(astar_traffic, astar_traffic.path,
                                             'A* · Traffic-Optimized (ML weights)', 'traffic')
        dijkstra_t_out = self._build_route_result(dijkstra_traffic, dijkstra_traffic.path,
                                                   'Dijkstra · Traffic-Optimized (ML weights)', 'traffic')

        # Comparison/explanation: baseline=dijkstra distance, optimized=astar traffic
        explanation = self._build_explanation(dijkstra_out, astar_out)

        result = {
            'start_node_id': start_node_id,
            'end_node_id': end_node_id,
            'start_coords': (start_node.lat, start_node.lon) if start_node else (start_lat, start_lon),
            'end_coords': (end_node.lat, end_node.lon) if end_node else (end_lat, end_lon),
            'dijkstra': dijkstra_out,
            'astar': astar_out,
            'dijkstra_traffic': dijkstra_t_out,
            'astar_distance_baseline': astar_dist_out,
            'comparison': explanation,
        }

        if alt1_result.path and alt1_result.path != best_distance_path and alt1_result.path != best_traffic_path:
            result['alt1'] = self._build_route_result(alt1_result, alt1_result.path, 'Alternative 1', 'traffic')
        else:
            result['alt1'] = None

        if alt2_result.path:
            is_unique = (alt2_result.path != best_distance_path and
                         alt2_result.path != best_traffic_path and
                         (not alt1_result.path or alt2_result.path != alt1_result.path))
            if is_unique:
                result['alt2'] = self._build_route_result(alt2_result, alt2_result.path, 'Alternative 2', 'traffic')
            else:
                result['alt2'] = None
        else:
            result['alt2'] = None

        return result
