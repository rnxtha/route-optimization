# RouteOpt — Kathmandu Valley Offline Navigation

> **Traffic prediction and ML have been intentionally removed.** This project uses pure road-distance weights for routing. See [Limitations](#limitations).

A practical, offline-capable navigation app for Kathmandu Valley built on real OpenStreetMap road data, custom Dijkstra and A* implementations, MapLibre vector maps, turn-by-turn directions, and IndexedDB offline storage.

**Main flow:** Start → Destination → Calculate → Route → Directions → Start Navigation  
**Modes:** Route · Compare Algorithms · Offline Maps

---

## Architecture

```
Browser (MapLibre + IndexedDB)
    │
    ├─ Search (Nominatim, bounded to Kathmandu Valley)
    ├─ Map Display (OpenFreeMap vector tiles + Esri satellite)
    ├─ Offline Tile Cache (IndexedDB, per-region)
    ├─ Offline Graph (IndexedDB, ~25 MB JSON)
    ├─ Local Dijkstra / A* (JS, when offline)
    └─ GPS Navigation (watchPosition, real device GPS)
         │
         ▼ (when online)
Django 4.2  →  /api/route/  →  RoutingService
                                   ├─ GraphLoader (OSMnx → LSCC → kathmandu_graph.json)
                                   ├─ NearestNodeFinder (scaled Euclidean)
                                   ├─ Dijkstra (distance)
                                   └─ A* (distance + Haversine heuristic)
```

---

## OSM Data & Graph

- **Source:** OpenStreetMap via OSMnx + Overpass API (5 fallback endpoints)
- **Bounding box:** `85.15, 27.55 → 85.55, 27.82` (Kathmandu, Lalitpur, Bhaktapur)
- **Network type:** `drive` (motorable roads)
- **Cleaning:** Largest Strongly Connected Component (LSCC) extracted via NetworkX so every node is reachable from every other node
- **Cache:** `routing/data/kathmandu_graph.json` (~25 MB, ~tens of thousands of nodes/edges). Loaded on first request, cached in memory thereafter
- **On rebuild:** If cache missing, `GraphLoader.load_or_build()` downloads from Overpass, builds, and saves

Node: `{id, lat, lon}`  
Edge: `{source, destination, distance (meters), name, highway, oneway}`  
Weights: **road distance only** — no traffic multiplier

---

## Dijkstra

Custom implementation (`routing/algorithms/dijkstra.py:7`) — not `networkx.shortest_path`.

- Edge weight: `edge.distance` (meters, from OSM `length` or Haversine fallback)
- Priority queue: `heapq` (min-heap on distance)
- One-way roads: respected via directed edges (LSCC is strongly connected, but edges retain direction)
- Disconnected/invalid: returns `distance = inf, path = []` → API returns 404
- Penalty support: `penalized_edges` set with `penalty_factor` for alternative routes

---

## A*

Custom implementation (`routing/algorithms/astar.py:8`) — not library A*.

- Edge weight: same distance
- Heuristic `h(n)`: Haversine great-circle distance from `n` to goal (meters) — **admissible** (never overestimates road distance)
- Same one-way / disconnected handling as Dijkstra
- Same penalty support for alternatives
- `g_score` + `h` → `f_score` in heap

Both algorithms must return the **same optimal distance** on the same distance-weighted graph (A* is just faster by exploring fewer nodes). Verified in Compare mode.

---

## Heuristic

Haversine (`6371000 m` Earth radius) is used because it is fast, admissible, and requires only node coordinates — no precomputation. In testing, A* typically explores 30–60% fewer nodes than Dijkstra on Kathmandu routes.

---

## Navigation (Turn-by-Turn)

Instructions are **generated dynamically** from route geometry + OSM road names (`static/js/app.js` → `generateNavigationSteps`).

- For each segment where road name changes **or** bearing changes > 35°, a new step is emitted
- Bearing computed via `atan2` formula
- Maneuvers: `depart` (arrow-up), `continue`, `left`, `right`, `uturn`, `arrival` (flag)
- Each step shows: instruction text, road name, segment distance, icon
- **Start Navigation:** calls `navigator.geolocation.watchPosition({enableHighAccuracy:true})`; shows blue GPS dot with pulse; advances step when device is within 40 m of next maneuver; updates remaining distance, ETA, progress bar
- **Never fakes GPS.** If permission denied / unavailable / timeout, shows "GPS unavailable — tap steps to advance manually" and allows manual tapping on steps to advance. `maximumAge` and `timeout` are set; errors from `watchPosition` are handled gracefully
- Remaining distance and ETA (avg 30 km/h) recalculated on each step

---

## Offline Maps + Offline Routing

### Storage

- **IndexedDB** (`RouteOptOffline` DB) with stores: `regions`, `graphs`, `tiles` — **not localStorage** (graph is ~25 MB, far exceeds localStorage limits)
- `navigator.storage.estimate()` used for quota display

### Download

- Offline Maps panel → "Download Current View" captures current `map.getBounds()` + zoom, fetches `/api/graph/download/` (streams the cached JSON with progress %), saves as single region `{id, name, bounds, sizeMB, savedAt}` + graph blob in IndexedDB
- Progress shown in loading overlay; toast on success

### Use Offline

- "Use Offline Mode" toggles `useOfflineRouting` flag; when enabled (or when `navigator.onLine === false` auto-enables if regions exist), route calculation calls `offlineRoute()` in JS instead of `fetch('/api/route/')`
- `offlineRoute()` loads graph from IndexedDB (most recent region), runs **local JS Dijkstra and A*** on the same graph structure, builds same response shape (`dijkstra`, `astar`, `alt1`, `alt2`, `road_names`, `travel_time_minutes`), returns to same `renderRouteResult()` path
- Map display: when offline, `search` shows "Offline — click the map" and vector tiles rely on browser HTTP cache of previously viewed tiles. If tiles fail to load, a clear offline banner is shown. The routing graph is fully offline; a missing offline graph shows "No offline graph available. Please download a region while online."

### Management

- Offline Maps screen lists downloaded regions with size, bounds, date, **Delete** per region, storage bar, **Use Offline** toggle, and Online/Offline indicator in header (green pulse dot / red warning, listens to `online`/`offline` events)

---

## Compare Algorithms

Compare mode (tab) shows for the same Start/Destination:

- Distance (both should match within 1 m on distance weights)
- Execution time (ms)
- Nodes explored
- Edges evaluated (derived)
- Speedup factor (`Dijkstra time / A* time`, and explored ratio)
- Whether both return the same optimal distance (green ✓ / red ✗)

---

## UI

- Clean dark theme (`Outfit` font), glassmorphism sidebar, responsive
- Desktop: sidebar (420 px) + map flex
- Mobile (`≤1024px`): column-reverse, map 560 px, sidebar full-width
- Map controls: style switcher (Map / Colorful / Satellite), 3D tilt, locate, zoom-to-fit, navigation compass/scale
- Legend shows active routes with color + dash pattern; route toggles per route; info panel on route click
- Accessibility: `role="tablist"` / `aria-selected` on mode tabs

---

## Setup

```bash
# Python 3.10+
pip install django osmnx networkx
python manage.py migrate
python manage.py runserver
# Open http://127.0.0.1:8000/
```

First run builds `kathmandu_graph.json` from Overpass (may take 1–2 min). Subsequent runs load from cache (~0.5 s).

Optional: `pip install numpy` — not required; traffic predictor removed.

---

## Testing

Manual checks performed:

- Simple routes: Thamel → Patan Durbar, etc. — both algorithms return same distance, A* faster
- Invalid locations: outside valley → error banner; malformed payload → 400; no path (theoretical, LSCC prevents) → 404
- Disconnected: not applicable after LSCC, but algorithm returns `inf` correctly
- Multiple Kathmandu Valley routes: various start/end pairs across Kathmandu/Lalitpur/Bhaktapur
- Offline: download region, go offline (DevTools → Offline), calculate route → local JS routing succeeds

Automated: `python manage.py check` — 0 issues. No ML tests remain.

---

## Limitations

- **No traffic / ML:** Road distance only; travel time is estimated from highway-class speed priors (e.g., residential 25 km/h, primary 50 km/h). No congestion, time-of-day, or incidents.
- Offline tiles are best-effort (browser cache); full PMTiles download not yet implemented — offline routing is the reliable part, map may show blank tiles in never-visited areas while offline.
- Search requires online Nominatim; offline search falls back to map-click.
- Graph is static (~25 MB); OSM updates require deleting `kathmandu_graph.json` and rebuilding.
- One-way handling is correct but turn restrictions and access tags are not modeled.
- `DEBUG=True`, `SECRET_KEY` is dev-only — harden for production.
