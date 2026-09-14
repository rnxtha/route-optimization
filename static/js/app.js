document.addEventListener('DOMContentLoaded', () => {
    const VALLEY_BOUNDS = { south: 27.55, west: 85.15, north: 27.82, east: 85.55 };
    const CENTER = [85.3001, 27.7007];
    const DEFAULT_ZOOM = 13.6;
    const DEFAULT_PITCH = 25;
    const DEFAULT_BEARING = 0;

    const VECTOR_STYLES = {
        liberty: 'https://tiles.openfreemap.org/styles/liberty',
        bright: 'https://tiles.openfreemap.org/styles/bright'
    };
    const SATELLITE_STYLE = {
        version: 8, name: 'Satellite Hybrid',
        sources: {
            esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Tiles &copy; Esri' },
            roads: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'], tileSize: 256 },
            places: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256 }
        },
        layers: [
            { id: 'sat', type: 'raster', source: 'esri' },
            { id: 'roads', type: 'raster', source: 'roads', paint: { 'raster-opacity': 0.85 } },
            { id: 'places', type: 'raster', source: 'places' }
        ]
    };
    const ROUTE_COLORS = {
        astar: { line: '#10b981', glow: 'rgba(16,185,129,0.55)' },
        dijkstra: { line: '#1d4ed8', glow: 'rgba(29,78,216,0.45)' },
        alt1: { line: '#f97316', glow: 'rgba(249,115,22,0.35)' },
        alt2: { line: '#ec4899', glow: 'rgba(236,72,153,0.35)' }
    };

    // ==================== MAP INIT ====================
    const map = new maplibregl.Map({
        container: 'map',
        style: VECTOR_STYLES.liberty,
        center: CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: 11,
        maxZoom: 19,
        pitch: DEFAULT_PITCH,
        bearing: DEFAULT_BEARING,
        maxBounds: [[VALLEY_BOUNDS.west, VALLEY_BOUNDS.south], [VALLEY_BOUNDS.east, VALLEY_BOUNDS.north]],
        attributionControl: false,
        canvasContextAttributes: { antialias: true }
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-right');

    let startMarker = null, endMarker = null;
    let startLngLat = null, endLngLat = null;
    let chartInstance = null;
    let lastRouteData = null;
    let is3D = true;
    let currentStyle = 'liberty';
    let routeLayersReady = false;
    let distanceMarkers = [];
    let activeRouteVisibility = { astar: true, dijkstra: true, alt1: true, alt2: true };
    let useOfflineRouting = false;
    let showSearchArea = false; // optional explored-nodes overlay (kept subtle so routes stay visible)

    const startInput = document.getElementById('start-input');
    const endInput = document.getElementById('end-input');
    const startResults = document.getElementById('start-results');
    const endResults = document.getElementById('end-results');
    const clearStartBtn = document.getElementById('clear-start');
    const clearEndBtn = document.getElementById('clear-end');
    const btnSwap = document.getElementById('btn-swap');
    const btnCalculate = document.getElementById('btn-calculate');
    const btnReset = document.getElementById('btn-reset');
    const btnNavigate = document.getElementById('btn-navigate');
    const errorAlert = document.getElementById('error-alert');
    const errorMessage = document.getElementById('error-message');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingStepText = document.getElementById('loading-step-text');
    const resultsSection = document.getElementById('route-results-section');
    const routeToggleGroup = document.getElementById('route-toggle-group');
    const mapHint = document.getElementById('map-hint');
    const routeInfoPanel = document.getElementById('route-info-panel');
    const routeInfoTitle = document.getElementById('route-info-title');
    const routeInfoBody = document.getElementById('route-info-body');
    const closeRouteInfo = document.getElementById('close-route-info');
    const tiltLabel = document.getElementById('tilt-label');
    const navigationPanel = document.getElementById('navigation-panel');
    const onlineStatusEl = document.getElementById('online-status');

    // ==================== HELPERS ====================
    function inBounds(lat, lng) { return lat >= VALLEY_BOUNDS.south && lat <= VALLEY_BOUNDS.north && lng >= VALLEY_BOUNDS.west && lng <= VALLEY_BOUNDS.east; }
    function pathToLine(path) { return path.map(c => [c[1], c[0]]); }
    function pointAtFraction(path, frac) {
        if (!path || path.length === 0) return null;
        const idx = Math.min(path.length - 1, Math.max(0, Math.floor(path.length * frac)));
        return path[idx];
    }
    function haversineMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }
    function bearingDeg(lat1, lon1, lat2, lon2) {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI/180);
        const x = Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) - Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.cos(dLon);
        let brng = Math.atan2(y, x) * 180 / Math.PI;
        return (brng + 360) % 360;
    }
    function formatDistance(m) {
        if (m < 1000) return Math.round(m) + ' m';
        return (m/1000).toFixed(m < 10000 ? 1 : 0) + ' km';
    }
    function pinElement(kind, letter) {
        const el = document.createElement('div');
        el.className = `gpin gpin-${kind}`;
        el.addEventListener('click', ev => ev.stopPropagation());
        const fill = kind === 'start' ? '#34A853' : '#EA4335';
        el.innerHTML = `<svg viewBox="0 0 40 54" width="40" height="54" aria-hidden="true"><ellipse cx="20" cy="51" rx="9" ry="2.6" fill="rgba(0,0,0,0.28)"/><path d="M20 1.5C11.4 1.5 4.5 8.4 4.5 17c0 11.4 15.5 34 15.5 34S35.5 28.4 35.5 17C35.5 8.4 28.6 1.5 20 1.5z" fill="${fill}" stroke="#fff" stroke-width="1.4"/><circle cx="20" cy="17" r="8.2" fill="#fff"/><text x="20" y="21.2" text-anchor="middle" font-size="11.5" font-weight="800" font-family="Outfit, system-ui, sans-serif" fill="${fill}">${letter}</text></svg>`;
        return el;
    }
    function createMarker(kind, lng, lat) {
        const letter = kind === 'start' ? 'A' : 'B';
        const title = kind === 'start' ? 'Start' : 'Destination';
        const marker = new maplibregl.Marker({ element: pinElement(kind, letter), anchor: 'bottom', draggable: true, offset: [0, 2] })
            .setLngLat([lng, lat]).setPopup(new maplibregl.Popup({ offset: 42, closeButton: false }).setHTML(`<strong>${title}</strong>`)).addTo(map);
        marker.on('dragend', () => {
            const pos = marker.getLngLat();
            if (!inBounds(pos.lat, pos.lng)) { showError('Pin must stay inside the Kathmandu Valley study area.'); marker.setLngLat(kind === 'start' ? startLngLat : endLngLat); return; }
            if (kind === 'start') { startLngLat = pos; startInput.value = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`; }
            else { endLngLat = pos; endInput.value = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`; }
            clearRoutes();
        });
        return marker;
    }
    async function reverseGeocode(lat, lng) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, { headers: { 'Accept-Language': 'en' } });
            if (!res.ok) return null;
            const data = await res.json();
            const addr = data.address || {};
            const n = addr.amenity || addr.tourism || addr.shop || addr.building || addr.road || addr.neighbourhood || addr.suburb || addr.city_district || data.name || data.display_name;
            return n ? String(n).split(',').slice(0, 2).join(',').trim() : null;
        } catch { return null; }
    }
    function setStart(lat, lng, fly) {
        if (startMarker) startMarker.remove();
        startLngLat = { lng, lat };
        startMarker = createMarker('start', lng, lat);
        startInput.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        startInput.title = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (fly) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15.2), pitch: is3D ? 58 : 0, duration: 900 });
        clearRoutes(); checkButtons(); updateHint();
        reverseGeocode(lat, lng).then(name => { if (name) { startInput.value = name; startInput.title = `${name} · ${lat.toFixed(5)}, ${lng.toFixed(5)}`; } });
    }
    function setEnd(lat, lng, fly) {
        if (endMarker) endMarker.remove();
        endLngLat = { lng, lat };
        endMarker = createMarker('end', lng, lat);
        endInput.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        endInput.title = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (fly) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15.2), pitch: is3D ? 58 : 0, duration: 900 });
        clearRoutes(); checkButtons(); updateHint();
        reverseGeocode(lat, lng).then(name => { if (name) { endInput.value = name; endInput.title = `${name} · ${lat.toFixed(5)}, ${lng.toFixed(5)}`; } });
    }
    function updateHint() {
        if (!startMarker) { mapHint.innerHTML = '<i class="fa-solid fa-hand-pointer"></i><span>Click the map or type a location to begin</span>'; mapHint.hidden = false; }
        else if (!endMarker) { mapHint.innerHTML = '<i class="fa-solid fa-flag"></i><span>Now set the destination</span>'; mapHint.hidden = false; }
        else mapHint.hidden = true;
    }
    function checkButtons() {
        const hasBoth = !!(startLngLat && endLngLat);
        const hasTwoPlaceNames = !!(startInput.value.trim() && endInput.value.trim());
        btnCalculate.disabled = !(hasBoth || hasTwoPlaceNames);
        btnNavigate.style.display = hasBoth && lastRouteData ? 'inline-flex' : 'none';
        if (hasBoth && lastRouteData) btnNavigate.disabled = false;
        else if (!lastRouteData) btnNavigate.disabled = true;
    }
    function emptyLine() { return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }; }
    function emptyPoints() { return { type: 'FeatureCollection', features: [] }; }
    function getSelectedAlgorithm() {
        const el = document.querySelector('input[name="algorithm"]:checked');
        const v = el ? el.value : 'astar';
        return (v === 'dijkstra' || v === 'astar' || v === 'both') ? v : 'astar';
    }
    function ensureRouteLayers() {
        // Explored-node (search area) layers first so route lines always render on top.
        ['dijkstra', 'astar'].forEach(key => {
            const src = `explored-${key}`;
            if (!map.getSource(src)) {
                map.addSource(src, { type: 'geojson', data: emptyPoints() });
                map.addLayer({
                    id: `${src}-dots`, type: 'circle', source: src,
                    paint: {
                        'circle-radius': 2.5,
                        'circle-opacity': 0.35,
                        'circle-color': key === 'astar' ? '#10b981' : '#1d4ed8',
                        'circle-stroke-width': 0
                    }
                });
            }
        });
        if (map.getSource('route-astar')) { routeLayersReady = true; return; }
        const routeConfigs = [
            { id: 'alt2', color: ROUTE_COLORS.alt2.line, width: 4, dash: [3, 4] },
            { id: 'alt1', color: ROUTE_COLORS.alt1.line, width: 5, dash: [5, 3] },
            { id: 'dijkstra', color: ROUTE_COLORS.dijkstra.line, width: 8, dash: null },
            { id: 'astar', color: ROUTE_COLORS.astar.line, width: 10, dash: null }
        ];
        routeConfigs.forEach(cfg => {
            map.addSource(`route-${cfg.id}`, { type: 'geojson', data: emptyLine() });
            map.addLayer({ id: `${cfg.id}-glow`, type: 'line', source: `route-${cfg.id}`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE_COLORS[cfg.id].glow, 'line-width': cfg.width + 16, 'line-opacity': 0.55 } });
            map.addLayer({ id: `${cfg.id}-casing`, type: 'line', source: `route-${cfg.id}`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': cfg.width + 5, 'line-opacity': 1 } });
            const lp = { 'line-color': cfg.color, 'line-width': cfg.width, 'line-opacity': 1 };
            if (cfg.dash) lp['line-dasharray'] = cfg.dash;
            map.addLayer({ id: `${cfg.id}-line`, type: 'line', source: `route-${cfg.id}`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: lp });
        });
        routeLayersReady = true;
    }
    function clearRoutes() {
        lastRouteData = null;
        ['dijkstra', 'astar', 'alt1', 'alt2'].forEach(id => { if (map.getSource(`route-${id}`)) map.getSource(`route-${id}`).setData(emptyLine()); });
        ['dijkstra', 'astar'].forEach(id => { if (map.getSource(`explored-${id}`)) map.getSource(`explored-${id}`).setData(emptyPoints()); });
        ['legend-search-dijkstra', 'legend-search-astar'].forEach(lid => { const el = document.getElementById(lid); if (el) el.style.display = 'none'; });
        distanceMarkers.forEach(m => m.remove()); distanceMarkers = [];
        resultsSection.style.display = 'none';
        routeToggleGroup.innerHTML = '';
        const statsPanel = document.getElementById('route-stats-panel');
        if (statsPanel) statsPanel.style.display = 'none';
        const statsBody = document.getElementById('route-stats-body');
        if (statsBody) statsBody.innerHTML = '';
        resultsSection.style.display = 'none';
        routeToggleGroup.innerHTML = '';
        routeInfoPanel.hidden = true;
        navigationPanel.hidden = true;
        stopNavigation();
        activeRouteVisibility = { astar: true, dijkstra: true, alt1: true, alt2: true };
        hideError(); checkButtons();
    }
    function resetRouting() {
        if (startMarker) startMarker.remove();
        if (endMarker) endMarker.remove();
        startMarker = null; endMarker = null;
        startLngLat = null; endLngLat = null;
        startInput.value = ''; startInput.title = '';
        endInput.value = ''; endInput.title = '';
        clearStartBtn.style.display = 'none';
        clearEndBtn.style.display = 'none';
        startResults.style.display = 'none';
        endResults.style.display = 'none';
        clearRoutes(); checkButtons(); updateHint();
    }
    function showError(msg) { errorMessage.innerText = msg; errorAlert.classList.add('active'); }
    function hideError() { errorAlert.classList.remove('active'); }
    function toggleRouteVisibility(key, visible) {
        activeRouteVisibility[key] = visible;
        const o = visible ? 1 : 0, g = visible ? 0.55 : 0, c = visible ? 1 : 0;
        if (map.getLayer(`${key}-line`)) {
            map.setPaintProperty(`${key}-line`, 'line-opacity', o);
            map.setPaintProperty(`${key}-casing`, 'line-opacity', c);
            map.setPaintProperty(`${key}-glow`, 'line-opacity', g);
        }
        const dot = document.querySelector(`.route-toggle-dot[data-key="${key}"]`);
        if (dot) dot.classList.toggle('dimmed', !visible);
    }
    function setExploredData(key, coordsLatLon) {
        // coordsLatLon: [[lat, lon], ...] from API (explored_coords) — small
        // translucent dots rendered UNDER the route lines so the final route
        // stays clearly visible.
        if (!routeLayersReady) ensureRouteLayers();
        const src = map.getSource(`explored-${key}`);
        if (!src) return;
        if (!showSearchArea || !coordsLatLon || coordsLatLon.length === 0) {
            src.setData(emptyPoints());
            const leg = document.getElementById(key === 'astar' ? 'legend-search-astar' : 'legend-search-dijkstra');
            if (leg) leg.style.display = 'none';
            return;
        }
        src.setData({ type: 'FeatureCollection', features: coordsLatLon.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c[1], c[0]] } })) });
        const leg = document.getElementById(key === 'astar' ? 'legend-search-astar' : 'legend-search-dijkstra');
        if (leg) leg.style.display = 'flex';
    }
    function refreshSearchArea() {
        if (!lastRouteData) return;
        ['dijkstra', 'astar'].forEach(k => {
            const coords = lastRouteData[k] && lastRouteData[k].explored_coords ? lastRouteData[k].explored_coords : null;
            setExploredData(k, coords);
        });
    }
    function createDistanceBubble(path, color, text, frac = 0.5) {
        const p = pointAtFraction(path, frac);
        if (!p) return;
        const el = document.createElement('div');
        el.className = 'distance-bubble';
        el.style.background = color;
        el.style.boxShadow = `0 4px 12px ${color}66`;
        el.textContent = text;
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p[1], p[0]]).addTo(map);
        distanceMarkers.push(marker);
    }
    function buildRouteToggles(data) {
        const routes = [];
        if (data.astar) routes.push({ key: 'astar', label: 'A* (Heuristic)', color: ROUTE_COLORS.astar.line });
        if (data.dijkstra) routes.push({ key: 'dijkstra', label: 'Dijkstra', color: ROUTE_COLORS.dijkstra.line });
        if (data.alt1) routes.push({ key: 'alt1', label: 'Alternative 1', color: ROUTE_COLORS.alt1.line });
        if (data.alt2) routes.push({ key: 'alt2', label: 'Alternative 2', color: ROUTE_COLORS.alt2.line });
        routeToggleGroup.innerHTML = '';
        routes.forEach(r => {
            const t = document.createElement('div');
            t.className = 'route-toggle-item';
            t.innerHTML = `<div class="route-toggle-dot active" data-key="${r.key}" style="background:${r.color};"></div><span class="route-toggle-label">${r.label}</span><label class="route-toggle-switch"><input type="checkbox" checked data-route-key="${r.key}"><span class="toggle-slider"></span></label>`;
            t.querySelector('input').addEventListener('change', e => { e.stopPropagation(); toggleRouteVisibility(r.key, e.target.checked); });
            t.querySelector('.route-toggle-dot').addEventListener('click', e => { e.stopPropagation(); const cb = t.querySelector('input'); cb.checked = !cb.checked; toggleRouteVisibility(r.key, cb.checked); });
            t.addEventListener('click', () => showRouteInfo(r.key, lastRouteData[r.key]));
            routeToggleGroup.appendChild(t);
        });
    }
    function showRouteInfo(key, data) {
        if (!data || !data.path || data.path.length === 0) { routeInfoPanel.hidden = true; return; }
        routeInfoTitle.textContent = data.label;
        const roads = (data.unique_road_names || []).filter(Boolean).slice(0, 8);
        let html = `<div class="info-row"><span class="info-label">Distance</span><span class="info-value">${data.distance_km} km</span></div>`;
        html += `<div class="info-row"><span class="info-label">Est. Travel</span><span class="info-value">${data.travel_time_minutes} min</span></div>`;
        html += `<div class="info-row"><span class="info-label">Road Nodes</span><span class="info-value">${data.path_nodes_count}</span></div>`;
        if (roads.length > 0) html += `<div class="info-roads"><span class="info-label">Roads on route:</span><div class="road-tags">${roads.map(r => `<span class="road-tag">${r}</span>`).join('')}</div></div>`;
        html += `<button class="btn btn-sm btn-primary" style="margin-top:0.6rem;width:100%;" onclick="document.getElementById('btn-navigate').click()"><i class="fa-solid fa-location-arrow"></i> Navigate this route</button>`;
        routeInfoBody.innerHTML = html;
        routeInfoPanel.hidden = false;
    }

    // ==================== TURN-BY-TURN ====================
    function generateNavigationSteps(path, roadNames) {
        if (!path || path.length < 2) return [];
        const steps = [];
        let segStartIdx = 0;
        let currentRoad = roadNames[0] || 'Unnamed road';
        let accDist = 0;

        function flushSegment(endIdx) {
            if (endIdx <= segStartIdx) return;
            const startCoord = path[segStartIdx];
            const endCoord = path[endIdx];
            // sum distance along segment
            let dist = 0;
            for (let i = segStartIdx; i < endIdx; i++) {
                dist += haversineMeters(path[i][0], path[i][1], path[i+1][0], path[i+1][1]);
            }
            // maneuver detection: compare bearing before and after
            let maneuver = 'continue';
            let icon = 'fa-arrow-up';
            if (steps.length > 0) {
                const prevBrng = bearingDeg(path[Math.max(0, segStartIdx-1)][0], path[Math.max(0, segStartIdx-1)][1], path[segStartIdx][0], path[segStartIdx][1]);
                const curBrng = bearingDeg(path[segStartIdx][0], path[segStartIdx][1], path[Math.min(segStartIdx+1, endIdx)][0], path[Math.min(segStartIdx+1, endIdx)][1]);
                let delta = curBrng - prevBrng;
                delta = ((delta + 540) % 360) - 180; // -180..180
                if (delta < -30 && delta > -150) { maneuver = 'left'; icon = 'fa-arrow-left'; }
                else if (delta > 30 && delta < 150) { maneuver = 'right'; icon = 'fa-arrow-right'; }
                else if (Math.abs(delta) >= 150) { maneuver = 'uturn'; icon = 'fa-rotate-left'; }
            }
            if (steps.length === 0) {
                maneuver = 'depart'; icon = 'fa-location-arrow';
            }
            const instruction = steps.length === 0
                ? `Head ${currentRoad ? 'on ' + currentRoad : 'toward destination'}`
                : (maneuver === 'continue' ? `Continue on ${currentRoad}` : (maneuver === 'left' ? `Turn left onto ${currentRoad}` : maneuver === 'right' ? `Turn right onto ${currentRoad}` : `Make a U-turn onto ${currentRoad}`));
            steps.push({ idx: segStartIdx, endIdx, maneuver, icon, instruction, roadName: currentRoad, distanceM: dist, coord: startCoord });
        }

        for (let i = 1; i < roadNames.length; i++) {
            const rn = roadNames[i] || 'Unnamed road';
            const b1 = bearingDeg(path[i-1][0], path[i-1][1], path[i][0], path[i][1]);
            const b2 = bearingDeg(path[i][0], path[i][1], path[i+1 < path.length ? i+1 : i][0], path[i+1 < path.length ? i+1 : i][1]);
            let delta = b2 - b1;
            delta = ((delta + 540) % 360) - 180;
            const roadChange = rn !== currentRoad;
            const sharpTurn = Math.abs(delta) > 35;
            if (roadChange || sharpTurn) {
                flushSegment(i);
                segStartIdx = i;
                currentRoad = rn;
            }
        }
        flushSegment(path.length - 1);
        // arrival step
        steps.push({ idx: path.length-1, endIdx: path.length-1, maneuver: 'arrival', icon: 'fa-flag-checkered', instruction: 'You have arrived at your destination', roadName: '', distanceM: 0, coord: path[path.length-1] });
        return steps;
    }

    let navSteps = [];
    let navCurrentIdx = 0;
    // True once a GPS fix has come within range of the planned path.
    // Auto-reroute only fires after joining — planning a trip from elsewhere
    // (e.g. from home) must not rebuild the route onto the live GPS dot.
    let hasJoinedRoute = false;
    const JOIN_ROUTE_METERS = 80;
    let navWatchId = null;
    let navPath = [];
    let navRoadNames = [];
    let currentPosMarker = null;
    let navTotalDistance = 0;
    let currentLocation = null;
    let locationAccuracyCircle = null;
    let followMode = 'free'; // 'free' = user pans, 'follow' = center on GPS, 'follow-heading' = center + rotate per GPS heading
    let previousGpsPosition = null;
    let navRerouteInFlight = false;
    let lastRerouteAt = 0;
    const OFF_ROUTE_THRESHOLD_METERS = 60;
    const REROUTE_COOLDOWN_MS = 15000;

    function updateLocationMarker(lat, lon, accuracy = 0) {        if (!currentPosMarker) {
            const el = document.createElement('div');
            el.className = 'gps-dot';
            el.innerHTML = '<div class="gps-dot-inner"></div><div class="gps-dot-pulse"></div>';
            currentPosMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map);
        } else {
            currentPosMarker.setLngLat([lon, lat]);
        }
        const source = map.getSource('location-accuracy');
        if (source) {
            const radius = Math.min(Math.max(accuracy || 25, 5), 300);
            const points = [];
            for (let i = 0; i <= 64; i++) {
                const angle = (i / 64) * Math.PI * 2;
                const latOffset = (radius / 111320) * Math.sin(angle);
                const lonOffset = (radius / (111320 * Math.cos(lat * Math.PI / 180))) * Math.cos(angle);
                points.push([lon + lonOffset, lat + latOffset]);
            }
            source.setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] } });
        }
    }

    function updateLocationLayers() {
        if (!map.getSource('location-accuracy')) {
            map.addSource('location-accuracy', { type: 'geojson', data: emptyLine() });
            map.addLayer({ id: 'location-accuracy-fill', type: 'fill', source: 'location-accuracy', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } });
            map.addLayer({ id: 'location-accuracy-line', type: 'line', source: 'location-accuracy', paint: { 'line-color': '#3b82f6', 'line-opacity': 0.35, 'line-width': 1 } });
        }
    }

    function centerOnLocation(lat, lon, heading = null, duration = 700) {
        const camera = { center: [lon, lat], zoom: Math.max(map.getZoom(), 16), pitch: is3D ? 58 : 0, duration };
        if (followMode === 'follow-heading' && Number.isFinite(heading) && heading >= 0) {
            camera.bearing = heading;
            camera.rotate = true;
        } else if (followMode === 'follow' && Number.isFinite(heading) && heading >= 0) {
            camera.bearing = heading;
        }
        map.easeTo(camera);
    }

    function renderNavSteps() {
        const list = document.getElementById('nav-steps-list');
        list.innerHTML = '';
        navSteps.forEach((s, i) => {
            const div = document.createElement('div');
            div.className = 'nav-step-item' + (i === navCurrentIdx ? ' active' : '') + (i < navCurrentIdx ? ' completed' : '');
            div.innerHTML = `<div class="nav-step-icon"><i class="fa-solid ${s.icon}"></i></div><div class="nav-step-text"><div class="nav-step-instruction">${s.instruction}</div><div class="nav-step-road">${s.roadName ? s.roadName + ' · ' + formatDistance(s.distanceM) : ''}</div></div>`;
            div.addEventListener('click', () => { navCurrentIdx = i; updateNavPanel(); });
            list.appendChild(div);
        });
    }

    function updateNavPanel() {
        if (!navSteps.length) return;
        const cur = navSteps[navCurrentIdx];
        document.getElementById('nav-maneuver').innerHTML = `<i class="fa-solid ${cur.icon}"></i>`;
        document.getElementById('nav-instruction').textContent = cur.instruction;
        document.getElementById('nav-distance').textContent = formatDistance(cur.distanceM);
        document.getElementById('nav-subtitle').textContent = `Step ${navCurrentIdx+1} of ${navSteps.length}`;

        // remaining distance
        let remaining = 0;
        for (let i = navCurrentIdx; i < navSteps.length; i++) remaining += navSteps[i].distanceM;
        document.getElementById('eta-distance').textContent = formatDistance(remaining);
        const avgSpeedMs = 30 / 3.6;
        const remMin = Math.round(remaining / avgSpeedMs / 60);
        document.getElementById('eta-remaining').textContent = remMin + ' min';
        const arrival = new Date(Date.now() + remMin*60000);
        document.getElementById('eta-arrival').textContent = arrival.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

        // progress
        const totalSteps = navSteps.length;
        const pct = Math.round((navCurrentIdx / Math.max(1, totalSteps-1)) * 100);
        document.getElementById('nav-progress-fill').style.width = pct + '%';
        document.getElementById('nav-progress-current').textContent = pct + '%';

        renderNavSteps();
        // highlight on map: pan to current step
        if (cur.coord && (!document.body.classList.contains('navigating') || !currentLocation)) {
            map.easeTo({ center: [cur.coord[1], cur.coord[0]], zoom: Math.max(map.getZoom(), 16), pitch: 50, duration: 800 });
        }
    }

    function nearestPointOnPath(lat, lon, path) {
        if (!path || path.length === 0) return null;
        const cosLat = Math.cos(lat * Math.PI / 180);
        let best = null;
        for (let i = 0; i < path.length - 1; i++) {
            const ax = (path[i][1] - lon) * cosLat;
            const ay = path[i][0] - lat;
            const bx = (path[i + 1][1] - lon) * cosLat;
            const by = path[i + 1][0] - lat;
            const dx = bx - ax, dy = by - ay;
            const fraction = Math.max(0, Math.min(1, (-(ax * dx + ay * dy)) / Math.max(1e-12, dx * dx + dy * dy)));
            const pointLat = path[i][0] + (path[i + 1][0] - path[i][0]) * fraction;
            const pointLon = path[i][1] + (path[i + 1][1] - path[i][1]) * fraction;
            const distance = haversineMeters(lat, lon, pointLat, pointLon);
            if (!best || distance < best.distance) best = { lat: pointLat, lon: pointLon, distance, index: i };
        }
        return best || { lat: path[0][0], lon: path[0][1], distance: haversineMeters(lat, lon, path[0][0], path[0][1]), index: 0 };
    }

    async function rerouteFromLocation(lat, lon) {
        if (!endLngLat || navRerouteInFlight) return;
        navRerouteInFlight = true;
        lastRerouteAt = Date.now();
        document.getElementById('nav-subtitle').textContent = 'Off route · recalculating...';
        try {
            let data;
            if (useOfflineRouting || !navigator.onLine) {
                data = await offlineRoute(lat, lon, endLngLat.lat, endLngLat.lng);
            } else {
                const response = await fetch('/api/route/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start_lat: lat, start_lon: lon, end_lat: endLngLat.lat, end_lon: endLngLat.lng })
                });
                if (!response.ok) throw new Error('Route recalculation failed.');
                const payload = await response.json();
                if (!payload.success) throw new Error(payload.error || 'Route recalculation failed.');
                data = payload.data;
            }
            if (!data.astar || !data.astar.path || data.astar.path.length < 2) {
                if (!data.dijkstra || !data.dijkstra.path || data.dijkstra.path.length < 2) throw new Error('No replacement route found.');
                data.astar = data.dijkstra;
            }
            renderRouteResult(data);
            routeInfoPanel.hidden = true;
            navPath = data.astar.path;
            navRoadNames = data.astar.road_names || [];
            navSteps = generateNavigationSteps(navPath, navRoadNames);
            navCurrentIdx = 0;
            navTotalDistance = navSteps.reduce((total, step) => total + step.distanceM, 0);
            updateNavPanel();
            document.getElementById('nav-subtitle').textContent = 'Route updated · GPS active';
            hasJoinedRoute = false; // re-join the fresh path on the next fix
        } catch (error) {
            document.getElementById('nav-subtitle').textContent = 'Off route · unable to recalculate';
            showError(error.message);
        } finally {
            navRerouteInFlight = false;
        }
    }

    function checkOffRoute(lat, lon) {
        const nearest = nearestPointOnPath(lat, lon, navPath);
        if (!nearest || !currentLocation || currentLocation.accuracy > 100) return;
        const threshold = Math.max(OFF_ROUTE_THRESHOLD_METERS, currentLocation.accuracy * 1.5);
        if (nearest.distance > threshold && Date.now() - lastRerouteAt > REROUTE_COOLDOWN_MS) rerouteFromLocation(lat, lon);
    }

    function startNavigation() {
        const primary = (lastRouteData && (lastRouteData.astar || lastRouteData.dijkstra)) || null;
        if (!primary || !primary.path || primary.path.length === 0) {
            showError('No route available to navigate. Please calculate a route first.');
            return;
        }
        navPath = primary.path;
        navRoadNames = primary.road_names || [];
        navSteps = generateNavigationSteps(navPath, navRoadNames);
        navCurrentIdx = 0;
        navTotalDistance = navSteps.reduce((a,s)=>a+s.distanceM,0);
        hasJoinedRoute = false; // (re-)join the path on the next GPS fix
        navigationPanel.hidden = false;
        document.body.classList.add('navigating');
        followMode = 'follow'; // default to follow GPS mode when navigation starts
        // Lock the pins: accidental taps/drags while zooming must not move
        // the route. Zoom controls, locate and the nav panel keep working.
        try { if (startMarker) startMarker.setDraggable(false); } catch {}
        try { if (endMarker) endMarker.setDraggable(false); } catch {}
        updateNavPanel();

        // Try real GPS
        if ('geolocation' in navigator) {
            document.getElementById('nav-subtitle').textContent = 'Waiting for GPS...';
            navigator.geolocation.getCurrentPosition(onGpsUpdate, onGpsError, {
                enableHighAccuracy: true, maximumAge: 0, timeout: 15000
            });
            navWatchId = navigator.geolocation.watchPosition(
                onGpsUpdate,
                onGpsError,
                { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
            );
            // fallback: if no GPS within 6s, explain manual mode
            setTimeout(() => {
                if (navWatchId !== null && !currentPosMarker) {
                    document.getElementById('nav-subtitle').textContent = 'GPS unavailable — tap steps to advance manually';
                }
            }, 6000);
        } else {
            document.getElementById('nav-subtitle').textContent = 'GPS not supported — tap steps to advance';
        }
    }

    function onGpsUpdate(pos) {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        if (!inBounds(lat, lon)) return; // ignore outside valley
        // Jump filter: a fix that teleports >300 m with poor accuracy is a
        // bad reading, not movement — ignore it so the dot/route don't jump.
        if (previousGpsPosition && (pos.coords.accuracy || 9999) > 150) {
            const jump = haversineMeters(previousGpsPosition.lat, previousGpsPosition.lon, lat, lon);
            if (jump > 300) return;
        }
        let heading = Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0 ? pos.coords.heading : null;
        if (heading === null && previousGpsPosition) {
            const moved = haversineMeters(previousGpsPosition.lat, previousGpsPosition.lon, lat, lon);
            if (moved >= 3) heading = bearingDeg(previousGpsPosition.lat, previousGpsPosition.lon, lat, lon);
        }
        previousGpsPosition = { lat, lon };
        currentLocation = { lat, lon, accuracy: pos.coords.accuracy };
        updateLocationMarker(lat, lon, pos.coords.accuracy);
        if (!hasJoinedRoute) {
            // Join check needs a reasonably good fix, not a drifted one.
            const acc = pos.coords.accuracy || 9999;
            const nearest = navPath.length ? nearestPointOnPath(lat, lon, navPath) : null;
            if (nearest && acc <= 150 && nearest.distance <= JOIN_ROUTE_METERS) {
                hasJoinedRoute = true;
            } else {
                // Not on the planned route yet (e.g. planning from home):
                // hold the plan and guide to the start instead of rebuilding
                // the whole trip onto the GPS dot.
                let dStart = null;
                if (navPath.length) dStart = haversineMeters(lat, lon, navPath[0][0], navPath[0][1]);
                document.getElementById('nav-subtitle').textContent =
                    dStart === null ? 'Waiting for GPS…' : `Head to start · ${formatDistance(dStart)} away`;
                if (followMode === 'follow' || followMode === 'follow-heading') centerOnLocation(lat, lon, heading, 1000);
                return;
            }
        }
        document.getElementById('nav-subtitle').textContent = `GPS active · ±${Math.round(pos.coords.accuracy)} m`;
        checkOffRoute(lat, lon);
        // advance step if close to next maneuver
        if (navCurrentIdx < navSteps.length - 1) {
            const next = navSteps[navCurrentIdx + 1];
            const d = haversineMeters(lat, lon, next.coord[0], next.coord[1]);
            if (d < 40) { // 40m threshold
                navCurrentIdx++;
                updateNavPanel();
                if (navSteps[navCurrentIdx].maneuver === 'arrival') {
                    document.getElementById('nav-subtitle').textContent = 'Arrived!';
                }
            }
        }
        // Camera behavior based on follow mode
        if (followMode === 'follow' || followMode === 'follow-heading') {
            centerOnLocation(lat, lon, heading, 1000);
            // When user drags map while in follow mode, switch to free pan
        }
        // If free pan, map stays where user left it
    }

    function onGpsError(err) {
        let msg = 'GPS unavailable';
        if (err.code === 1) msg = 'Location permission denied — tap steps to navigate manually';
        else if (err.code === 2) msg = 'GPS unavailable — tap steps to navigate manually';
        else if (err.code === 3) msg = 'GPS timeout — tap steps to navigate manually';
        document.getElementById('nav-subtitle').textContent = msg;
        console.warn('GPS error', err);
    }

    function stopNavigation() {
        if (navWatchId !== null) { navigator.geolocation.clearWatch(navWatchId); navWatchId = null; }
        // Unlock the pins so start/destination can be adjusted again.
        try { if (startMarker) startMarker.setDraggable(true); } catch {}
        try { if (endMarker) endMarker.setDraggable(true); } catch {}
        if (currentPosMarker) { currentPosMarker.remove(); currentPosMarker = null; }
        currentLocation = null;
        previousGpsPosition = null;
        if (map.getSource('location-accuracy')) map.getSource('location-accuracy').setData(emptyLine());
        navigationPanel.hidden = true;
        document.body.classList.remove('navigating');
        navSteps = []; navCurrentIdx = 0;
        hasJoinedRoute = false;
    }

    // ==================== OFFLINE (IndexedDB) ====================
    const DB_NAME = 'RouteOptOffline';
    const DB_VERSION = 1;

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('regions')) db.createObjectStore('regions', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('graphs')) db.createObjectStore('graphs', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles', { keyPath: 'url' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveRegion(region) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('regions', 'readwrite');
            tx.objectStore('regions').put(region);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }
    async function getRegions() {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('regions', 'readonly');
            const req = tx.objectStore('regions').getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => rej(req.error);
        });
    }
    async function deleteRegion(id) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('regions', 'readwrite');
            tx.objectStore('regions').delete(id);
            tx.objectStore('graphs').delete(id);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }
    async function saveGraph(id, graphData) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('graphs', 'readwrite');
            tx.objectStore('graphs').put({ id, data: graphData, savedAt: Date.now() });
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }
    async function getGraph(id) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('graphs', 'readonly');
            const req = tx.objectStore('graphs').get(id);
            req.onsuccess = () => res(req.result ? req.result.data : null);
            req.onerror = () => rej(req.error);
        });
    }

    function tileCoordinate(value, zoom) {
        return Math.floor((value + 180) / 360 * Math.pow(2, zoom));
    }
    function tileY(lat, zoom) {
        const radians = lat * Math.PI / 180;
        return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * Math.pow(2, zoom));
    }
    async function cacheCurrentMapView(bounds, zoom) {
        if (!navigator.serviceWorker) return 0;
        const registration = await navigator.serviceWorker.ready;
        const worker = navigator.serviceWorker.controller || registration.active;
        if (!worker) return 0;
        const sources = map.getStyle()?.sources || {};
        const templates = [];
        Object.values(sources).forEach(source => (source.tiles || []).forEach(tile => templates.push(tile)));
        if (currentStyle === 'satellite') templates.push(...SATELLITE_STYLE.sources.esri.tiles, ...SATELLITE_STYLE.sources.roads.tiles, ...SATELLITE_STYLE.sources.places.tiles);
        const urls = new Set();
        for (const level of [Math.max(11, zoom - 1), zoom, Math.min(19, zoom + 1)]) {
            const minX = tileCoordinate(bounds.west, level), maxX = tileCoordinate(bounds.east, level);
            const minY = tileY(bounds.north, level), maxY = tileY(bounds.south, level);
            for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
                templates.forEach(template => urls.add(template.replace('{z}', level).replace('{x}', x).replace('{y}', y)));
            }
        }
        worker.postMessage({ type: 'CACHE_URLS', urls: [...urls].slice(0, 500) });
        return Math.min(urls.size, 500);
    }

    // ==================== OFFLINE TILE CACHING (IndexedDB) ====================
    async function saveTile(url, blob) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('tiles', 'readwrite');
            tx.objectStore('tiles').put({ url, data: blob, savedAt: Date.now() });
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }
    async function getTile(url) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('tiles', 'readonly');
            const req = tx.objectStore('tiles').get(url);
            req.onsuccess = () => res(req.result ? req.result.data : null);
            req.onerror = () => rej(req.error);
        });
    }
    async function getAllTiles() {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('tiles', 'readonly');
            const req = tx.objectStore('tiles').getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => rej(req.error);
        });
    }
    async function clearTiles() {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('tiles', 'readwrite');
            tx.objectStore('tiles').clear();
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }
    async function downloadAndCacheTiles(bounds, zoom, maxTiles = 300) {
        const sources = map.getStyle()?.sources || {};
        const templates = [];
        Object.values(sources).forEach(source => (source.tiles || []).forEach(tile => templates.push(tile)));
        if (currentStyle === 'satellite') templates.push(...SATELLITE_STYLE.sources.esri.tiles, ...SATELLITE_STYLE.sources.roads.tiles, ...SATELLITE_STYLE.sources.places.tiles);
        const urls = [];
        for (const level of [Math.max(11, zoom - 1), zoom, Math.min(19, zoom + 1)]) {
            const minX = tileCoordinate(bounds.west, level), maxX = tileCoordinate(bounds.east, level);
            const minY = tileY(bounds.north, level), maxY = tileY(bounds.south, level);
            for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
                templates.forEach(template => urls.push(template.replace('{z}', level).replace('{x}', x).replace('{y}', y)));
            }
        }
        const toDownload = urls.slice(0, maxTiles);
        let downloaded = 0;
        for (const url of toDownload) {
            try {
                const response = await fetch(url, { cache: 'no-store' });
                if (response.ok) {
                    const blob = await response.blob();
                    await saveTile(url, blob);
                    downloaded++;
                }
            } catch (e) {
                console.warn('Failed to cache tile:', url, e);
            }
        }
        return downloaded;
    }
    function buildOfflineStyle() {
        return {
            version: 8,
            name: 'Offline Tiles',
            sources: {
                'offline-raster': {
                    type: 'raster',
                    tiles: ['local://{z}/{x}/{y}'],
                    tileSize: 256,
                    attribution: 'Offline cached tiles'
                }
            },
            layers: [{
                id: 'offline-layer',
                type: 'raster',
                source: 'offline-raster',
                paint: { 'raster-opacity': 1 }
            }]
        };
    }
    async function switchToOfflineStyle() {
        try {
            const tiles = await getAllTiles();
            if (tiles.length === 0) return false;
            // We'll intercept tile requests and serve from IndexedDB
            // For now, use a workaround: create a style with local tile URLs
            // MapLibre doesn't support custom protocols easily, so we'll use a different approach
            // Show offline banner instead
            showOfflineBanner(tiles.length);
            return true;
        } catch (e) {
            console.error('Failed to switch to offline style:', e);
            return false;
        }
    }
    function showOfflineBanner(tileCount = 0) {
        let banner = document.getElementById('offline-map-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'offline-map-banner';
            banner.className = 'offline-banner';
            document.body.appendChild(banner);
        }
        banner.innerHTML = `<i class="fa-solid fa-wifi-slash"></i> <span>Offline mode · ${tileCount} map tiles cached</span> <button class="btn btn-sm btn-ghost" onclick="document.getElementById('offline-map-banner').style.display='none'">Dismiss</button>`;
        banner.style.display = 'flex';
    }
    function hideOfflineBanner() {
        const banner = document.getElementById('offline-map-banner');
        if (banner) banner.style.display = 'none';
    }

    // JS implementations for offline routing
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2-lat1)*Math.PI/180;
        const dLon = (lon2-lon1)*Math.PI/180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
        return 2*R*Math.asin(Math.sqrt(a));
    }
    function findNearestNode(graph, lat, lon) {
        let best = null, bestDist = Infinity;
        const cosLat = Math.cos(lat*Math.PI/180);
        for (const n of graph.nodes) {
            const dLat = n.lat - lat, dLon = (n.lon - lon)*cosLat;
            const d2 = dLat*dLat + dLon*dLon;
            if (d2 < bestDist) { bestDist = d2; best = n.id; }
        }
        return best;
    }
    function dijkstraJS(graph, startId, endId, penalizedEdges=null, penalty=1.0) {
        const t0 = performance.now();
        const adj = new Map();
        for (const e of graph.edges) {
            if (!adj.has(e.source)) adj.set(e.source, []);
            adj.get(e.source).push(e);
        }
        const dist = new Map([[startId, 0]]);
        const parent = new Map();
        const visited = new Set();
        const visitedOrder = [];
        const pq = [[0, startId]];
        let explored = 0;
        function popMin() {
            let minIdx = 0;
            for (let i=1;i<pq.length;i++) if (pq[i][0] < pq[minIdx][0]) minIdx=i;
            return pq.splice(minIdx,1)[0];
        }
        while (pq.length) {
            const [d,u] = popMin();
            if (visited.has(u)) continue;
            visited.add(u); visitedOrder.push(u); explored++;
            if (u===endId) break;
            const neigh = adj.get(u) || [];
            for (const e of neigh) {
                const v = e.destination;
                if (visited.has(v)) continue;
                let w = e.distance;
                if (penalizedEdges && penalizedEdges.has(u+','+v)) w *= penalty;
                const nd = d + w;
                if (!dist.has(v) || nd < dist.get(v)) { dist.set(v, nd); parent.set(v, u); pq.push([nd, v]); }
            }
        }
        const t1 = performance.now();
        if (!dist.has(endId)) return { path: [], distance: Infinity, nodes_explored: explored, execution_time: (t1-t0)/1000, visitedOrder };
        const path = [];
        let cur = endId;
        while (cur !== undefined) { path.push(cur); cur = parent.get(cur); if (cur===startId) { path.push(cur); break; } }
        path.reverse();
        return { path, distance: dist.get(endId), nodes_explored: explored, execution_time: (t1-t0)/1000, visitedOrder };
    }
    function astarJS(graph, startId, endId, penalizedEdges=null, penalty=1.0) {
        const t0 = performance.now();
        const nodeMap = new Map(graph.nodes.map(n=>[n.id, n]));
        const adj = new Map();
        for (const e of graph.edges) {
            if (!adj.has(e.source)) adj.set(e.source, []);
            adj.get(e.source).push(e);
        }
        const endNode = nodeMap.get(endId);
        const gScore = new Map([[startId,0]]);
        const fScore = new Map([[startId, haversine(nodeMap.get(startId).lat, nodeMap.get(startId).lon, endNode.lat, endNode.lon)]]);
        const parent = new Map();
        const visited = new Set();
        const visitedOrder = [];
        const pq = [[fScore.get(startId), startId]];
        let explored=0;
        function popMin(){ let mi=0; for(let i=1;i<pq.length;i++) if(pq[i][0]<pq[mi][0]) mi=i; return pq.splice(mi,1)[0]; }
        while(pq.length){
            const [f,u]=popMin();
            if(visited.has(u)) continue;
            visited.add(u); visitedOrder.push(u); explored++;
            if(u===endId) break;
            const curG=gScore.get(u);
            for(const e of (adj.get(u)||[])){
                const v=e.destination; if(visited.has(v)) continue;
                let w=e.distance; if(penalizedEdges&&penalizedEdges.has(u+','+v)) w*=penalty;
                const tentative=curG+w;
                if(!gScore.has(v) || tentative<gScore.get(v)){
                    gScore.set(v,tentative);
                    const vn=nodeMap.get(v);
                    const h=haversine(vn.lat, vn.lon, endNode.lat, endNode.lon);
                    const f=tentative+h;
                    fScore.set(v,f); parent.set(v,u); pq.push([f,v]);
                }
            }
        }
        const t1=performance.now();
        if(!gScore.has(endId)) return { path:[], distance:Infinity, nodes_explored: explored, execution_time:(t1-t0)/1000, visitedOrder };
        const path=[]; let cur=endId; while(cur!==undefined){ path.push(cur); cur=parent.get(cur); if(cur===startId){path.push(cur);break;} } path.reverse();
        return { path, distance: gScore.get(endId), nodes_explored: explored, execution_time:(t1-t0)/1000, visitedOrder };
    }
    async function offlineRoute(startLat, startLon, endLat, endLon, includeExplored=false, algorithm='both') {
        // Load graph from IndexedDB, fallback to fetching from server if online
        let graph = null;
        const regions = await getRegions();
        if (regions.length > 0) {
            // Use most recent region's graph
            const sorted = regions.sort((a,b)=>b.savedAt-a.savedAt);
            graph = await getGraph(sorted[0].id);
        }
        if (!graph) {
            // Try fetch from server (if online)
            if (!navigator.onLine) throw new Error('No offline graph available. Please download a region while online.');
            const res = await fetch('/api/graph/download/');
            if (!res.ok) throw new Error('Failed to fetch graph for offline routing.');
            graph = await res.json();
            // Optionally cache it
        }
        // Support both {nodes:[], edges:[]} and cached object
        const g = graph;
        const startId = findNearestNode(g, startLat, startLon);
        const endId = findNearestNode(g, endLat, endLon);
        const wantD = algorithm !== 'astar', wantA = algorithm !== 'dijkstra';
        const dRes = wantD ? dijkstraJS(g, startId, endId) : null;
        const aRes = wantA ? astarJS(g, startId, endId) : null;
        // Build response similar to server
        const nodeMap = new Map(g.nodes.map(n=>[n.id, n]));
        function exploredCoords(r) {
            if (!includeExplored || !r || !r.visitedOrder) return undefined;
            const order = r.visitedOrder;
            const step = Math.max(1, Math.floor(order.length / 2000));
            const out = [];
            for (let i = 0; i < order.length && out.length < 2000; i += step) {
                const n = nodeMap.get(order[i]);
                if (n) out.push([n.lat, n.lon]);
            }
            return out;
        }
        function buildResult(r, label){
            const coords = r.path.map(id=>{ const n=nodeMap.get(id); return n?[n.lat, n.lon]:null; }).filter(Boolean);
            // road names
            const edgeMap = new Map();
            for(const e of g.edges) edgeMap.set(e.source+','+e.destination, e);
            const roadNames = [];
            for(let i=0;i<r.path.length-1;i++) {
                const e = edgeMap.get(r.path[i]+','+r.path[i+1]);
                roadNames.push(e ? (e.name || '') : '');
            }
            const uniq = [...new Set(roadNames.filter(Boolean))].slice(0,15);
            // travel time estimate
            let totalSec=0;
            for(let i=0;i<r.path.length-1;i++){
                const e=edgeMap.get(r.path[i]+','+r.path[i+1]);
                if(e){ const kmh = ({motorway:80, trunk:70, primary:50, secondary:40, tertiary:35, residential:25, unclassified:25, service:20}[e.highway]||30); totalSec+= e.distance/(kmh/3.6); }
            }
            const res = {
                label, distance_meters: r.distance, distance_km: r.distance===Infinity?null:+(r.distance/1000).toFixed(3),
                execution_time_seconds: r.execution_time, execution_time_ms: +(r.execution_time*1000).toFixed(2),
                nodes_explored: r.nodes_explored, path_nodes_count: r.path.length,
                path: coords, road_names: roadNames, unique_road_names: uniq, travel_time_minutes: +(totalSec/60).toFixed(1)
            };
            const ec = exploredCoords(r);
            if (ec) res.explored_coords = ec;
            return res;
        }
        const dijkstra = dRes ? buildResult(dRes, 'Dijkstra (Shortest)') : null;
        const astar = aRes ? buildResult(aRes, 'A* (Heuristic)') : null;
        // Alternatives (based on whichever primary path exists; legacy behaviour preserved for 'both')
        let alt1=null, alt2=null;
        const basePath = (dRes && dRes.path.length ? dRes.path : (aRes && aRes.path.length ? aRes.path : []));
        if(basePath.length){
            const pen = new Set(basePath.slice(0,-1).map((id,i)=>id+','+basePath[i+1]));
            const a1 = dijkstraJS(g, startId, endId, pen, 3.0);
            if(a1.path.length && a1.path.join(',')!==basePath.join(',')){
                alt1 = buildResult(a1, 'Alternative 1');
                const pen2 = new Set([...pen, ...a1.path.slice(0,-1).map((id,i)=>id+','+a1.path[i+1])]);
                const a2 = astarJS(g, startId, endId, pen2, 4.0);
                if(a2.path.length && a2.path.join(',')!==basePath.join(',') && a2.path.join(',')!==a1.path.join(',')){
                    alt2 = buildResult(a2, 'Alternative 2');
                }
            }
        }
        const sNode=nodeMap.get(startId), eNode=nodeMap.get(endId);
        return { start_coords: sNode?[sNode.lat,sNode.lon]:[startLat,startLon], end_coords: eNode?[eNode.lat,eNode.lon]:[endLat,endLon], dijkstra, astar, alt1, alt2 };
    }

    async function refreshOfflineUI() {
        const listEl = document.getElementById('offline-regions-list');
        const storageInfo = document.getElementById('storage-info');
        const barFill = document.getElementById('storage-bar-fill');
        const btnUseOffline = document.getElementById('btn-use-offline');
        try {
            const regions = await getRegions();
            if (regions.length === 0) {
                listEl.innerHTML = '<div class="offline-empty">No offline regions downloaded yet.<br><small>Tap "Download Current View" while online.</small></div>';
                btnUseOffline.disabled = true;
                btnUseOffline.textContent = 'Use Offline Mode';
            } else {
                listEl.innerHTML = '';
                regions.forEach(r=>{
                    const div=document.createElement('div');
                    div.className='offline-region-item';
                    div.innerHTML=`<div class="region-header"><i class="fa-solid fa-map"></i> <strong>${r.name}</strong><span class="region-size">${r.sizeMB} MB</span></div><div class="region-meta">${r.boundsText} · ${new Date(r.savedAt).toLocaleString()}</div><div class="region-actions"><button class="btn btn-sm btn-secondary btn-delete-region" data-id="${r.id}"><i class="fa-solid fa-trash"></i> Delete</button><span class="region-status">${r.id===useOfflineRouting?'✓ Active':''}</span></div>`;
                    listEl.appendChild(div);
                });
                listEl.querySelectorAll('.btn-delete-region').forEach(b=>b.addEventListener('click', async e=>{
                    const id=e.currentTarget.dataset.id;
                    await deleteRegion(id);
                    if(useOfflineRouting===id) { useOfflineRouting=false; btnUseOffline.textContent='Use Offline Mode'; btnUseOffline.classList.remove('active'); }
                    refreshOfflineUI();
                }));
                btnUseOffline.disabled = false;
                btnUseOffline.textContent = useOfflineRouting ? 'Using Offline ✓' : 'Use Offline Mode';
                btnUseOffline.classList.toggle('active', !!useOfflineRouting);
            }
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                const usedMB = ((est.usage||0)/(1024*1024)).toFixed(1);
                const quotaMB = ((est.quota||0)/(1024*1024)).toFixed(0);
                storageInfo.textContent = `${usedMB} MB used${quotaMB!=='0' ? ' / ' + quotaMB + ' MB quota' : ''} · ${regions.length} region(s)`;
                const pct = est.quota ? Math.min(100, Math.round((est.usage/est.quota)*100)) : 10;
                barFill.style.width = pct + '%';
            } else {
                storageInfo.textContent = `${regions.length} region(s) stored`;
            }
        } catch(err){ console.error(err); storageInfo.textContent='Storage error'; }
    }

    async function downloadCurrentRegion() {
        const btn = document.getElementById('btn-download-region');
        btn.disabled = true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Downloading...';
        try {
            // Get current map bounds as region
            const b = map.getBounds();
            const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
            const zoom = Math.round(map.getZoom());
            const name = `Kathmandu Valley Z${zoom} (${bounds.west.toFixed(2)},${bounds.south.toFixed(2)})`;
            // Fetch graph info
            let graph=null, sizeMB=0;
            try {
                const infoRes = await fetch('/api/graph/info/');
                const info = await infoRes.json();
                if(info.success) sizeMB = info.data.size_mb;
            } catch {}
            loadingStepText.innerText='Downloading road graph for offline routing...';
            loadingOverlay.classList.add('active');
            const graphRes = await fetch('/api/graph/download/');
            if(!graphRes.ok) throw new Error('Graph download failed: '+graphRes.status);
            const total = parseInt(graphRes.headers.get('Content-Length')||'0',10);
            const reader = graphRes.body.getReader();
            let received=0; const chunks=[];
            while(true){
                const {done,value}=await reader.read();
                if(done) break;
                chunks.push(value);
                received+=value.length;
                if(total) loadingStepText.innerText=`Downloading graph... ${(received/total*100).toFixed(0)}% (${(received/1024/1024).toFixed(1)} MB)`;
            }
            const blob = new Blob(chunks, {type:'application/json'});
            const text = await blob.text();
            graph = JSON.parse(text);
            sizeMB = (blob.size/(1024*1024)).toFixed(1);
            loadingStepText.innerText='Saving to IndexedDB...';
            const id = 'region-'+Date.now();
            await saveRegion({ id, name, bounds, boundsText: `${bounds.west.toFixed(2)}°W → ${bounds.east.toFixed(2)}°E, ${bounds.south.toFixed(2)}°S → ${bounds.north.toFixed(2)}°N`, sizeMB, savedAt: Date.now() });
            await saveGraph(id, graph);
            loadingStepText.innerText='Downloading map tiles for offline use...';
            const tileCount = await downloadAndCacheTiles(bounds, zoom, 300);
            loadingOverlay.classList.remove('active');
            showError(''); hideError();
            // show success as transient
            const msg = document.createElement('div');
            msg.className='offline-toast'; msg.innerHTML='<i class="fa-solid fa-check"></i> Offline region saved ('+sizeMB+' MB graph, '+tileCount+' map tiles cached)';
            document.body.appendChild(msg);
            setTimeout(()=>msg.remove(),3000);
            refreshOfflineUI();
        } catch(err){
            loadingOverlay.classList.remove('active');
            showError('Offline download failed: '+err.message);
            console.error(err);
        } finally {
            btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-download"></i> Download Current View';
        }
    }

    // ==================== MODE TABS ====================
    document.querySelectorAll('.mode-tab').forEach(tab=>{
        tab.addEventListener('click',()=>{
            const mode=tab.dataset.mode;
            document.querySelectorAll('.mode-tab').forEach(t=>{ t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
            tab.classList.add('active'); tab.setAttribute('aria-selected','true');
            document.querySelectorAll('.mode-panel').forEach(p=>p.style.display='none');
            document.getElementById('panel-'+mode).style.display='block';
            document.getElementById('panel-'+mode).classList.add('active');
            if(mode==='offline') refreshOfflineUI();
            if(mode==='compare' && lastRouteData) renderComparison(lastRouteData);
        });
    });

    // ==================== ONLINE/OFFLINE STATUS ====================
    function updateOnlineStatus(){
        const online = navigator.onLine;
        onlineStatusEl.className = 'status-indicator ' + (online ? 'online' : 'offline');
        onlineStatusEl.innerHTML = online ? '<i class="fa-solid fa-circle"></i> Online' : '<i class="fa-solid fa-triangle-exclamation"></i> Offline';
        if(!online){
            // auto-enable offline routing if we have regions
            getRegions().then(rs=>{ if(rs.length>0) { useOfflineRouting = rs.sort((a,b)=>b.savedAt-a.savedAt)[0].id; refreshOfflineUI(); }});
            // show offline map banner if tiles are cached
            getAllTiles().then(tiles=>{ if(tiles.length>0) showOfflineBanner(tiles.length); });
        } else {
            hideOfflineBanner();
        }
    }
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();

    document.getElementById('btn-download-region').addEventListener('click', downloadCurrentRegion);
    document.getElementById('btn-use-offline').addEventListener('click', async ()=>{
        const btn=document.getElementById('btn-use-offline');
        if(useOfflineRouting){
            useOfflineRouting=false;
            btn.textContent='Use Offline Mode'; btn.classList.remove('active');
            showError('Offline mode disabled. Using online routing.');
            setTimeout(hideError,3000);
        } else {
            const regions=await getRegions();
            if(regions.length===0){ showError('No offline regions. Download one first.'); return; }
            useOfflineRouting=regions.sort((a,b)=>b.savedAt-a.savedAt)[0].id;
            btn.textContent='Using Offline ✓'; btn.classList.add('active');
            showError('Offline mode enabled. Routing will run locally.');
            setTimeout(hideError,3000);
        }
        refreshOfflineUI();
    });

    // ==================== MAP EVENTS ====================
    map.on('load', () => { ensureRouteLayers(); updateLocationLayers(); try { map.setSky({ 'sky-color': '#87b8e8', 'horizon-color': '#f4efe6', 'fog-color': '#f4efe6', 'fog-ground-blend': 0.35 }); } catch {} });
    map.on('style.load', () => { routeLayersReady = false; ensureRouteLayers(); updateLocationLayers(); if (lastRouteData) drawRoutesOnMap(lastRouteData); });
    map.on('click', e => {
        if (navigationPanel.hidden === false || document.body.classList.contains('navigating')) return; // locked during navigation: zoom/pan allowed, pins untouchable
        if (e.originalEvent.target.closest('.gpin, .map-style-switcher, .map-fabs, .map-legend-card, .route-info-panel, .maplibregl-ctrl, .navigation-panel')) return;
        const { lng, lat } = e.lngLat;
        if (!inBounds(lat, lng)) { showError('Selected point is outside Kathmandu Valley study boundary.'); return; }
        if (!startMarker) setStart(lat, lng, false);
        else if (!endMarker) setEnd(lat, lng, false);
        else { resetRouting(); setStart(lat, lng, false); }
    });
    document.getElementById('map-style-switcher').addEventListener('click', e => {
        const btn = e.target.closest('.style-chip');
        if (!btn) return;
        const sk = btn.dataset.style;
        if (sk === currentStyle) return;
        currentStyle = sk;
        document.querySelectorAll('.style-chip').forEach(el => el.classList.toggle('active', el === btn));
        map.setStyle(sk === 'satellite' ? SATELLITE_STYLE : VECTOR_STYLES[sk]);
    });
    document.getElementById('btn-tilt').addEventListener('click', () => { is3D = !is3D; tiltLabel.textContent = is3D ? '3D' : '2D'; map.easeTo({ pitch: is3D ? DEFAULT_PITCH : 0, bearing: is3D ? DEFAULT_BEARING : 0, duration: 800 }); });
    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
        if (!lastRouteData) { map.flyTo({ center: CENTER, zoom: DEFAULT_ZOOM, pitch: is3D ? DEFAULT_PITCH : 0, bearing: is3D ? DEFAULT_BEARING : 0, duration: 900 }); return; }
        const bounds = new maplibregl.LngLatBounds();
        ['dijkstra', 'astar', 'alt1', 'alt2'].forEach(k => { if (lastRouteData[k] && lastRouteData[k].path) lastRouteData[k].path.forEach(c => bounds.extend([c[1], c[0]])); });
        if (startLngLat) bounds.extend([startLngLat.lng, startLngLat.lat]);
        if (endLngLat) bounds.extend([endLngLat.lng, endLngLat.lat]);
        map.fitBounds(bounds, { padding: { top: 100, bottom: 150, left: 100, right: 100 }, pitch: is3D ? DEFAULT_PITCH : 0, bearing: DEFAULT_BEARING, duration: 1200, maxZoom: 16 });
    });
    // ---- High-accuracy location lock (locate button) ----
    // A single getCurrentPosition() usually returns the first coarse (network)
    // fix, which can be 100+ m off. Instead we stream fixes for a few seconds
    // and keep the most accurate one, so the dot settles onto the true position
    // once the device GPS locks. maximumAge: 0 forces fresh satellite fixes
    // (never a stale cached position).
    let locateWatchId = null;
    let locateTimer = null;
    let locateBest = null;
    let locateSawOob = false;
    const LOCATE_GOOD_ENOUGH_M = 20;  // lock early once this accurate
    const LOCATE_SETTLE_MS = 10000;   // max time to keep refining
    const LOCATE_TIMEOUT_MS = 25000;  // per-fix give-up timeout

    function clearLocateLock() {
        if (locateWatchId !== null) {
            try { navigator.geolocation.clearWatch(locateWatchId); } catch {}
            locateWatchId = null;
        }
        if (locateTimer !== null) { clearTimeout(locateTimer); locateTimer = null; }
    }
    function revertLocateMode(btn) {
        followMode = 'free';
        if (btn) btn.classList.remove('follow', 'follow-heading');
    }
    function finishLocateLock(btn, reason) {
        clearLocateLock();
        if (!locateBest) {
            if (locateSawOob) showError('Your location is outside the Kathmandu Valley study area.');
            else showError('GPS unavailable — go outdoors with a clear sky view and try again.');
            revertLocateMode(btn);
            updateHint();
            return;
        }
        const { lat, lon, accuracy, heading } = locateBest;
        currentLocation = { lat, lon, accuracy };
        updateLocationMarker(lat, lon, accuracy);
        centerOnLocation(lat, lon, heading, 1000);
        if (!startMarker) setStart(lat, lon, false);
        else if (!endMarker) setEnd(lat, lon, false);
        hideError();
        mapHint.innerHTML = `<i class="fa-solid fa-location-crosshairs"></i><span>My location · GPS ±${Math.round(accuracy)} m${accuracy > 50 ? ' — go outdoors for better accuracy' : ''}</span>`;
        mapHint.hidden = false;
        if (reason === 'timeout' && accuracy > 50) {
            showError(`Best GPS fix is ±${Math.round(accuracy)} m. Turn on High-accuracy location mode and go outdoors for better accuracy.`);
        }
        setTimeout(updateHint, 6000);
        locateBest = null;
        locateSawOob = false;
    }
    document.getElementById('btn-locate').addEventListener('click', () => {
        if (!navigator.geolocation) { showError('Geolocation is not supported on this device.'); return; }
        const btn = document.getElementById('btn-locate');
        // Tapping again while a lock is in progress cancels it.
        if (locateWatchId !== null) { clearLocateLock(); locateBest = null; locateSawOob = false; revertLocateMode(btn); updateHint(); return; }
        // Cycle follow modes: free → follow → follow-heading → free
        if (followMode === 'free') followMode = 'follow';
        else if (followMode === 'follow') followMode = 'follow-heading';
        else followMode = 'free';
        // Update button visual state (add rotating indicator classes)
        btn.classList.remove('follow', 'follow-heading');
        if (followMode === 'follow') btn.classList.add('follow');
        else if (followMode === 'follow-heading') btn.classList.add('follow-heading');
        if (followMode === 'free') { updateHint(); return; } // exited follow modes; no fix needed
        // Fresh-fix-only lock (maximumAge: 0 = never use a stale cached position).
        hideError();
        locateBest = null;
        locateSawOob = false;
        mapHint.innerHTML = '<i class="fa-solid fa-satellite-dish"></i><span>Locking GPS… stay outdoors for best accuracy</span>';
        mapHint.hidden = false;
        const onFix = pos => {
            const lat = pos.coords.latitude, lng = pos.coords.longitude;
            const accuracy = pos.coords.accuracy || 9999;
            if (!inBounds(lat, lng)) {
                // Coarse warm-up fixes are often wrong — ignore out-of-area ones
                // but keep waiting for the GPS to lock onto the true position.
                locateSawOob = true;
                return;
            }
            if (!locateBest || accuracy < locateBest.accuracy) {
                const heading = (Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0) ? pos.coords.heading : null;
                locateBest = { lat, lon: lng, accuracy, heading };
                currentLocation = { lat, lon: lng, accuracy };
                updateLocationMarker(lat, lng, accuracy);
                mapHint.innerHTML = `<i class="fa-solid fa-satellite-dish"></i><span>Locking GPS… ±${Math.round(accuracy)} m</span>`;
                mapHint.hidden = false;
                if (followMode !== 'free') centerOnLocation(lat, lng, heading, 800);
                if (accuracy <= LOCATE_GOOD_ENOUGH_M) finishLocateLock(btn, 'locked');
            }
        };
        const onFixError = err => {
            // Permission denial fails fast; other errors keep waiting until the
            // settle timer expires, then the best fix so far is used.
            if (err && err.code === 1) {
                clearLocateLock(); locateBest = null; locateSawOob = false;
                showError('Location permission denied — allow access and try again.');
                revertLocateMode(btn); updateHint();
            }
        };
        try {
            locateWatchId = navigator.geolocation.watchPosition(onFix, onFixError,
                { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATE_TIMEOUT_MS });
        } catch (e) {
            showError('Geolocation is not supported on this device.');
            revertLocateMode(btn); updateHint(); return;
        }
        locateTimer = setTimeout(() => finishLocateLock(btn, 'timeout'), LOCATE_SETTLE_MS);
    });
    map.on('dragstart', () => { if (navigationPanel.hidden === false) followMode = 'free'; });
    btnReset.addEventListener('click', () => { resetRouting(); map.flyTo({ center: CENTER, zoom: DEFAULT_ZOOM, pitch: is3D ? DEFAULT_PITCH : 0, bearing: is3D ? DEFAULT_BEARING : 0, duration: 900 }); });
    btnSwap.addEventListener('click', () => {
        if (!startLngLat || !endLngLat) return;
        const sLat = startLngLat.lat, sLng = startLngLat.lng, eLat = endLngLat.lat, eLng = endLngLat.lng;
        const sName = startInput.value, eName = endInput.value;
        resetRouting();
        setStart(eLat, eLng, false);
        setEnd(sLat, sLng, false);
        startInput.value = eName; endInput.value = sName;
    });
    closeRouteInfo.addEventListener('click', () => { routeInfoPanel.hidden = true; });
    document.getElementById('btn-stop-nav').addEventListener('click', stopNavigation);
    // Manual reroute: rebuild the trip from the live GPS position on demand.
    // (Auto-reroute only fires after joining the route; this is the explicit
    // "take me from where I actually am" button.)
    const btnRerouteNav = document.getElementById('btn-reroute-nav');
    if (btnRerouteNav) btnRerouteNav.addEventListener('click', async () => {
        if (!endLngLat) return;
        if (!currentLocation) {
            document.getElementById('nav-subtitle').textContent = 'Waiting for GPS… tap again in a moment';
            return;
        }
        document.getElementById('nav-subtitle').textContent = 'Rerouting from your location…';
        await rerouteFromLocation(currentLocation.lat, currentLocation.lon);
    });
    btnNavigate.addEventListener('click', startNavigation);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/static/sw.js?v=9').catch(err => console.warn('Offline cache unavailable', err));
    document.getElementById('card-astar').addEventListener('click', () => { if (lastRouteData && lastRouteData.astar) showRouteInfo('astar', lastRouteData.astar); });
    document.getElementById('card-dijkstra').addEventListener('click', () => { if (lastRouteData && lastRouteData.dijkstra) showRouteInfo('dijkstra', lastRouteData.dijkstra); });
    document.getElementById('card-astar').style.cursor = 'pointer';
    document.getElementById('card-dijkstra').style.cursor = 'pointer';

    function drawRoutesOnMap(data) {
        if (!routeLayersReady) ensureRouteLayers();
        ['dijkstra', 'astar', 'alt1', 'alt2'].forEach(key => {
            if (data[key] && data[key].path && data[key].path.length > 0) {
                map.getSource(`route-${key}`).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: pathToLine(data[key].path) } });
                toggleRouteVisibility(key, activeRouteVisibility[key]);
            } else { map.getSource(`route-${key}`).setData(emptyLine()); }
        });
    }

    function renderComparison(data){
        const cmpEl=document.getElementById('comparison-results');
        if(!cmpEl) return;
        if(!data || !data.dijkstra || !data.astar){ cmpEl.style.display='none'; return; }
        cmpEl.style.display='block';
        const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
        const dDist=data.dijkstra.distance_km, aDist=data.astar.distance_km;
        const sameDist = dDist!==null && aDist!==null && Math.abs(dDist - aDist) < 0.001;
        set('cmp-distance-match', sameDist ? '✓ Same ('+dDist+' km)' : '✗ Different (D:'+dDist+' A:'+aDist+')');
        const matchEl = document.getElementById('cmp-distance-match');
        if (matchEl) matchEl.style.color = sameDist ? '#10b981' : '#ef4444';
        set('cmp-dijkstra-distance', dDist!==null ? dDist+' km' : '—');
        set('cmp-astar-distance', aDist!==null ? aDist+' km' : '—');
        set('cmp-astar-nodes', data.astar.nodes_explored);
        set('cmp-dijkstra-nodes', data.dijkstra.nodes_explored);
        set('cmp-astar-path', data.astar.path_nodes_count + ' nodes');
        set('cmp-dijkstra-path', data.dijkstra.path_nodes_count + ' nodes');
        const aMs = data.astar.execution_time_ms !== undefined ? data.astar.execution_time_ms : (data.astar.execution_time_seconds*1000);
        const dMs = data.dijkstra.execution_time_ms !== undefined ? data.dijkstra.execution_time_ms : (data.dijkstra.execution_time_seconds*1000);
        set('cmp-astar-time', aMs.toFixed(1)+' ms');
        set('cmp-dijkstra-time', dMs.toFixed(1)+' ms');
        const speedup = dMs / Math.max(0.01, aMs);
        const exploredRatio = data.dijkstra.nodes_explored / Math.max(1, data.astar.nodes_explored);
        let reduction = 0;
        if (data.dijkstra.nodes_explored > 0) reduction = (data.dijkstra.nodes_explored - data.astar.nodes_explored) / data.dijkstra.nodes_explored * 100;
        if (data.comparison && data.comparison.speedup) {
            set('cmp-speedup', `A* ${data.comparison.speedup}× faster`);
            set('cmp-node-reduction', `${data.comparison.node_reduction_percent}% fewer nodes`);
        } else {
            set('cmp-speedup', `A* ${speedup.toFixed(1)}× faster, ${exploredRatio.toFixed(1)}× fewer nodes`);
            set('cmp-node-reduction', `${reduction.toFixed(1)}% fewer nodes (A* vs Dijkstra)`);
        }
    }

    function renderRouteStats(data) {
        const panel = document.getElementById('route-stats-panel');
        const body = document.getElementById('route-stats-body');
        if (!panel || !body) return;
        const rows = [];
        function fmtTime(r) {
            const ms = r.execution_time_ms !== undefined ? r.execution_time_ms : r.execution_time_seconds * 1000;
            return ms.toFixed(1) + ' ms';
        }
        if (data.dijkstra) rows.push(['Dijkstra', 'row-dijkstra', data.dijkstra, fmtTime(data.dijkstra)]);
        if (data.astar) rows.push(['A*', 'row-astar', data.astar, fmtTime(data.astar)]);
        if (!rows.length) { panel.style.display = 'none'; return; }
        body.innerHTML = rows.map(([name, cls, r, t]) =>
            `<tr class="${cls}"><td>${name}</td><td>${r.distance_km !== null ? r.distance_km + ' km' : '—'}</td><td>${t}</td><td>${r.nodes_explored}</td><td>${r.path_nodes_count}</td><td>~${r.travel_time_minutes} min</td></tr>`
        ).join('');
        panel.style.display = 'block';
    }

    function renderRouteResult(data) {
        lastRouteData = data;
        // During navigation the entered start/destination are locked: a
        // mid-trip reroute refreshes the drawn route + steps from the live
        // GPS position, but must never move the user's pins.
        const locked = document.body.classList.contains('navigating');
        if (!locked) {
            if (data.start_coords) { startLngLat = { lat: data.start_coords[0], lng: data.start_coords[1] }; if (startMarker) startMarker.setLngLat([startLngLat.lng, startLngLat.lat]); }
            if (data.end_coords) { endLngLat = { lat: data.end_coords[0], lng: data.end_coords[1] }; if (endMarker) endMarker.setLngLat([endLngLat.lng, endLngLat.lat]); }
        }
        drawRoutesOnMap(data);
        refreshSearchArea();
        const bounds = new maplibregl.LngLatBounds();
        ['dijkstra', 'astar', 'alt1', 'alt2'].forEach(k => { if (data[k] && data[k].path) data[k].path.forEach(c => bounds.extend([c[1], c[0]])); });
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: { top: 100, bottom: 150, left: 100, right: 100 }, pitch: is3D ? DEFAULT_PITCH : 0, bearing: DEFAULT_BEARING, duration: 1400, maxZoom: 16 });
        distanceMarkers.forEach(m => m.remove()); distanceMarkers = [];
        if (data.astar && data.astar.path && data.astar.path.length > 0) createDistanceBubble(data.astar.path, ROUTE_COLORS.astar.line, `${data.astar.distance_km} km · A*`, 0.52);
        if (data.dijkstra && data.dijkstra.path && data.dijkstra.path.length > 0) createDistanceBubble(data.dijkstra.path, ROUTE_COLORS.dijkstra.line, `${data.dijkstra.distance_km} km · Dijkstra`, 0.25);
        if (data.alt1 && data.alt1.path && data.alt1.path.length > 0) createDistanceBubble(data.alt1.path, ROUTE_COLORS.alt1.line, `${data.alt1.distance_km} km`, 0.75);
        if (data.alt2 && data.alt2.path && data.alt2.path.length > 0) createDistanceBubble(data.alt2.path, ROUTE_COLORS.alt2.line, `${data.alt2.distance_km} km`, 0.85);
        const primary = data.astar || data.dijkstra;
        document.getElementById('summary-distance').innerText = primary ? `${primary.distance_km} km` : '-';
        document.getElementById('summary-time').innerText = primary ? `~${primary.travel_time_minutes} min` : '-';
        document.getElementById('summary-nodes').innerText = primary ? `${primary.path_nodes_count} nodes` : '-';
        document.getElementById('astar-distance').innerText = data.astar ? `${data.astar.distance_km} km` : '— (not run)';
        document.getElementById('dijkstra-distance').innerText = data.dijkstra ? `${data.dijkstra.distance_km} km` : '— (not run)';
        document.getElementById('astar-time').innerText = data.astar ? `${((data.astar.execution_time_ms !== undefined ? data.astar.execution_time_ms : data.astar.execution_time_seconds*1000)).toFixed(1)} ms` : '—';
        document.getElementById('dijkstra-time').innerText = data.dijkstra ? `${((data.dijkstra.execution_time_ms !== undefined ? data.dijkstra.execution_time_ms : data.dijkstra.execution_time_seconds*1000)).toFixed(1)} ms` : '—';
        document.getElementById('astar-nodes').innerText = data.astar ? data.astar.nodes_explored : '—';
        document.getElementById('dijkstra-nodes').innerText = data.dijkstra ? data.dijkstra.nodes_explored : '—';
        document.getElementById('astar-travel').innerText = data.astar ? `~${data.astar.travel_time_minutes} min` : '—';
        document.getElementById('dijkstra-travel').innerText = data.dijkstra ? `~${data.dijkstra.travel_time_minutes} min` : '—';
        buildRouteToggles(data);
        renderRouteStats(data);
        showRouteInfo(data.astar ? 'astar' : 'dijkstra', primary);
        resultsSection.style.display = 'block';
        renderComparison(data);
        drawChart(data.astar ? data.astar.nodes_explored : 0, data.dijkstra ? data.dijkstra.nodes_explored : 0);
        checkButtons();
    }

    function drawChart(ae, de) {
        const ctx = document.getElementById('performance-chart').getContext('2d');
        if (chartInstance) chartInstance.destroy();
        chartInstance = new Chart(ctx, { type: 'bar', data: { labels: ['Nodes Explored'], datasets: [{ label: 'A*', data: [ae], backgroundColor: '#10b981', borderColor: '#059669', borderWidth: 1, borderRadius: 4 }, { label: 'Dijkstra', data: [de], backgroundColor: '#1d4ed8', borderColor: '#1e40af', borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#9ca3af', font: { family: 'Outfit', size: 11 } } }, title: { display: true, text: 'Algorithm Efficiency (Lower is Better)', color: '#f3f4f6', font: { family: 'Outfit', size: 12, weight: 'bold' } } }, scales: { y: { beginAtZero: true, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { ticks: { color: '#9ca3af' }, grid: { display: false } } } } });
    }

    // ===== SEARCH (Google-Maps-style) =====
    // Two sources, merged: (1) Nominatim full-text search bounded to the valley
    // (covers ALL named places/roads, like Google's search box), (2) the app's
    // own category API (futsal/cafes/clinics often missing from Nominatim).
    let startTimeout = null, endTimeout = null;
    let startSearchToken = 0, endSearchToken = 0; // drop stale responses
    let startAbort = null, endAbort = null;     // abort superseded requests
    const SEARCH_TIMEOUT_MS = 12000;
    let startActiveIdx = -1, endActiveIdx = -1;   // keyboard highlight
    let startLastResults = [], endLastResults = [];
    const MIN_SEARCH_CHARS = 2;

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function getRecents() {
        try { const r = JSON.parse(localStorage.getItem('routeopt-recent') || '[]'); return Array.isArray(r) ? r : []; }
        catch { return []; }
    }
    function saveRecent(name, lat, lon) {
        try {
            const recents = getRecents().filter(r => !(r.name === name && Math.abs(r.lat - lat) < 1e-4 && Math.abs(r.lon - lon) < 1e-4));
            recents.unshift({ name, lat, lon, at: Date.now() });
            localStorage.setItem('routeopt-recent', JSON.stringify(recents.slice(0, 6)));
        } catch {}
    }
    async function unifiedSearch(query, limit = 8, signal = undefined) {
        // Single backend call: valley-bounded full-text OSM search merged with
        // the live venue-category search (futsal, cafes, clinics...).
        const res = await fetch('/api/places/search/?q=' + encodeURIComponent(query) + '&limit=' + limit, { headers: { 'Accept-Language': 'en' }, signal });
        if (!res.ok) return [];
        const payload = await res.json();
        const data = payload.success ? payload.data : [];
        return (data || []).map(item => ({
            name: String(item.name || item.display_name || 'Location'),
            display_name: item.display_name || item.name,
            short_addr: item.short_addr || '',
            lat: parseFloat(item.lat), lon: parseFloat(item.lon),
            category: item.category || '', type: item.type || '', source: item.source || 'osm'
        })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
    async function geocodeText(query, limit = 1) {
        // Shared fallback for Find Route when the user typed text but never
        // picked a suggestion.
        try { const hits = await unifiedSearch(query, limit); if (hits.length) return hits[0]; } catch {}
        return null;
    }
    function placeIcon(item) {
        const t = ((item.type || '') + ' ' + (item.category || '')).toLowerCase();
        if (/futsal|football|sport|pitch|stadium|ground/.test(t)) return 'fa-futbol';
        if (/cafe|coffee|tea|bakery/.test(t)) return 'fa-mug-saucer';
        if (/hospital|clinic|doctor|health|pharmacy/.test(t)) return 'fa-hospital';
        if (/restaurant|food|fast_food|eat|dinner|cuisine/.test(t)) return 'fa-utensils';
        if (/hotel|guest|hostel/.test(t)) return 'fa-bed';
        if (/school|college|university|education/.test(t)) return 'fa-graduation-cap';
        if (/temple|church|mosque|shrine|monastery|worship/.test(t)) return 'fa-place-of-worship';
        if (/bank|atm/.test(t)) return 'fa-building-columns';
        if (/road|highway|street|residential|tertiary|secondary|primary|path/.test(t)) return 'fa-road';
        if (/railway|bus|station|airport|aerodrome/.test(t)) return 'fa-train-subway';
        return 'fa-location-dot';
    }
    function selectPlace(kind, lat, lon, name) {
        const input = kind === 'start' ? startInput : endInput;
        const results = kind === 'start' ? startResults : endResults;
        input.value = name; input.title = name + ' · ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
        results.style.display = 'none'; results.innerHTML = '';
        saveRecent(name, lat, lon);
        if (kind === 'start') setStart(lat, lon, true); else setEnd(lat, lon, true);
    }
    function setActiveSearch(kind, idx, scroll) {
        if (kind === 'start') startActiveIdx = idx; else endActiveIdx = idx;
        const container = kind === 'start' ? startResults : endResults;
        [...container.children].forEach((el, i) => el.classList.toggle('active', i === idx));
        if (scroll && container.children[idx]) container.children[idx].scrollIntoView({ block: 'nearest' });
    }
    function moveActiveSearch(kind, dir) {
        const results = kind === 'start' ? startLastResults : endLastResults;
        if (!results.length) return;
        let idx = (kind === 'start' ? startActiveIdx : endActiveIdx) + dir;
        setActiveSearch(kind, Math.max(0, Math.min(results.length - 1, idx)), true);
    }
    function pickSearchResult(kind, i) {
        const results = kind === 'start' ? startLastResults : endLastResults;
        const item = results[i];
        if (!item) return;
        selectPlace(kind, item.lat, item.lon, item.name);
    }
    function renderSearchResults(container, kind, results, activeIdx) {
        container.innerHTML = '';
        if (!results.length) {
            container.innerHTML = '<div class="search-item no-results"><i class="fa-solid fa-map-pin"></i><span>Not found? Click the map to drop a pin.</span></div>';
            container.style.display = 'block';
            return;
        }
        results.forEach((item, i) => {
            const div = document.createElement('div');
            div.className = 'search-item' + (i === activeIdx ? ' active' : '');
            div.setAttribute('role', 'option');
            if (item.recent) {
                div.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i><span class="search-text"><span class="search-name">${escHtml(item.name)}</span></span>`;
            } else {
                div.innerHTML = `<i class="fa-solid ${placeIcon(item)}"></i><span class="search-text"><span class="search-name">${escHtml(item.name)}</span>` +
                    (item.short_addr ? `<span class="search-addr">${escHtml(item.short_addr)}</span>` : '') +
                    `</span>${item.source === 'local' ? '<span class="search-badge">Local</span>' : ''}`;
            }
            div.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); pickSearchResult(kind, i); });
            div.addEventListener('mousemove', () => setActiveSearch(kind, i, false));
            container.appendChild(div);
        });
        container.style.display = 'block';
    }
    function doSearch(query, container, kind) {
        const token = (kind === 'start' ? ++startSearchToken : ++endSearchToken);
        const setResults = r => { if (kind === 'start') startLastResults = r; else endLastResults = r; };
        const q = (query || '').trim();
        if (q.length < MIN_SEARCH_CHARS) { container.style.display = 'none'; setResults([]); setActiveSearch(kind, -1, false); return Promise.resolve([]); }
        if (!navigator.onLine) {
            // Recents keep search useful offline.
            const recents = getRecents()
                .filter(r => r.name.toLowerCase().includes(q.toLowerCase()))
                .map(r => ({ ...r, recent: true }));
            setResults(recents); setActiveSearch(kind, -1, false);
            if (!recents.length) { container.innerHTML = '<div class="search-item no-results">Offline — pick a recent place or click the map.</div>'; container.style.display = 'block'; }
            else renderSearchResults(container, kind, recents, -1);
            return Promise.resolve(recents);
        }
        container.innerHTML = '<div class="search-item search-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Searching Kathmandu Valley…</span></div>';
        container.style.display = 'block';
        // Abort the previous in-flight request for this field so only the
        // latest keystrokes consume bandwidth; a 12 s cap guarantees the
        // spinner can never hang forever.
        if (kind === 'start') { if (startAbort) startAbort.abort(); startAbort = new AbortController(); }
        else { if (endAbort) endAbort.abort(); endAbort = new AbortController(); }
        const signal = kind === 'start' ? startAbort.signal : endAbort.signal;
        const timer = setTimeout(() => { try { (kind === 'start' ? startAbort : endAbort).abort(); } catch {} }, SEARCH_TIMEOUT_MS);
        return unifiedSearch(q, 8, signal)
            .then(results => {
                clearTimeout(timer);
                if ((kind === 'start' ? startSearchToken : endSearchToken) !== token) return null; // stale
                setResults(results); setActiveSearch(kind, -1, false);
                renderSearchResults(container, kind, results, -1);
                return results;
            })
            .catch(err => {
                clearTimeout(timer);
                if ((kind === 'start' ? startSearchToken : endSearchToken) !== token) return []; // superseded
                if (err && err.name === 'AbortError') {
                    container.innerHTML = '<div class="search-item no-results"><i class="fa-solid fa-triangle-exclamation"></i><span>Search is taking too long — try fewer words, or click the map to drop a pin.</span></div>';
                    container.style.display = 'block';
                    return [];
                }
                console.error('Place search failed:', err); return [];
            });
    }
    function showRecents(kind) {
        // Focusing a field shows recent places (or fresh search for typed text).
        const container = kind === 'start' ? startResults : endResults;
        const input = kind === 'start' ? startInput : endInput;
        if (input.value.trim().length >= MIN_SEARCH_CHARS) { doSearch(input.value.trim(), container, kind); return; }
        const recents = getRecents().map(r => ({ ...r, recent: true }));
        if (!recents.length) return;
        if (kind === 'start') { startLastResults = recents; startActiveIdx = -1; }
        else { endLastResults = recents; endActiveIdx = -1; }
        renderSearchResults(container, kind, recents, -1);
    }
    function searchKeyHandler(e, kind) {
        const container = kind === 'start' ? startResults : endResults;
        const input = kind === 'start' ? startInput : endInput;
        const results = kind === 'start' ? startLastResults : endLastResults;
        const active = kind === 'start' ? startActiveIdx : endActiveIdx;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (container.style.display !== 'block' || !results.length) doSearch(input.value.trim(), container, kind);
            else moveActiveSearch(kind, 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveActiveSearch(kind, -1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (kind === 'start' && startTimeout) clearTimeout(startTimeout);
            if (kind === 'end' && endTimeout) clearTimeout(endTimeout);
            if (active >= 0 && results[active]) pickSearchResult(kind, active);
            else {
                const q = input.value.trim(); if (!q) return;
                doSearch(q, container, kind).then(res => {
                    const list = (res && res.length) ? res : (kind === 'start' ? startLastResults : endLastResults);
                    if (list && list.length) selectPlace(kind, list[0].lat, list[0].lon, list[0].name);
                });
            }
        } else if (e.key === 'Escape') {
            container.style.display = 'none';
        }
    }
    startInput.addEventListener('input', e => {
        const q = e.target.value.trim();
        clearStartBtn.style.display = q ? 'block' : 'none';
        startLngLat = null;
        if (startMarker) { startMarker.remove(); startMarker = null; }
        clearRoutes(); checkButtons(); updateHint();
        if (startTimeout) clearTimeout(startTimeout);
        if (!q) { startResults.style.display = 'none'; return; }
        startTimeout = setTimeout(() => doSearch(q, startResults, 'start'), 300);
    });
    endInput.addEventListener('input', e => {
        const q = e.target.value.trim();
        clearEndBtn.style.display = q ? 'block' : 'none';
        endLngLat = null;
        if (endMarker) { endMarker.remove(); endMarker = null; }
        clearRoutes(); checkButtons(); updateHint();
        if (endTimeout) clearTimeout(endTimeout);
        if (!q) { endResults.style.display = 'none'; return; }
        endTimeout = setTimeout(() => doSearch(q, endResults, 'end'), 300);
    });
    startInput.addEventListener('keydown', e => searchKeyHandler(e, 'start'));
    endInput.addEventListener('keydown', e => searchKeyHandler(e, 'end'));
    startInput.addEventListener('focus', () => showRecents('start'));
    endInput.addEventListener('focus', () => showRecents('end'));
    clearStartBtn.addEventListener('click', () => { startInput.value=''; clearStartBtn.style.display='none'; startResults.style.display='none'; startLngLat=null; if(startMarker){startMarker.remove();startMarker=null;} checkButtons(); updateHint(); });
    clearEndBtn.addEventListener('click', () => { endInput.value=''; clearEndBtn.style.display='none'; endResults.style.display='none'; endLngLat=null; if(endMarker){endMarker.remove();endMarker=null;} checkButtons(); updateHint(); });
    document.addEventListener('mousedown', e => {
        if (!startInput.contains(e.target) && !startResults.contains(e.target)) startResults.style.display='none';
        if (!endInput.contains(e.target) && !endResults.contains(e.target)) endResults.style.display='none';
    });

    // ===== CALCULATE =====
    btnCalculate.addEventListener('click', async () => {
        const startQ = startInput.value.trim(), endQ = endInput.value.trim();
        async function proceed(){
            if (!startLngLat || !endLngLat){ showError('Please set both a start and destination location.'); return; }
            hideError();
            ['dijkstra','astar','alt1','alt2'].forEach(k=>{ if(map.getSource('route-'+k)) map.getSource('route-'+k).setData(emptyLine()); });
            ['dijkstra','astar'].forEach(k=>{ if(map.getSource('explored-'+k)) map.getSource('explored-'+k).setData(emptyPoints()); });
            resultsSection.style.display='none'; distanceMarkers.forEach(m=>m.remove()); distanceMarkers=[]; routeInfoPanel.hidden=true;
            loadingStepText.innerText='Finding nearest road nodes & computing routes...';
            loadingOverlay.classList.add('active');
            try{
                let data;
                const algorithm = getSelectedAlgorithm();
                const includeExplored = showSearchArea;
                const shouldUseOffline = useOfflineRouting || !navigator.onLine;
                if(shouldUseOffline){
                    loadingStepText.innerText='Computing offline route (local Dijkstra/A*)...';
                    data = await offlineRoute(startLngLat.lat, startLngLat.lng, endLngLat.lat, endLngLat.lng, includeExplored, algorithm === 'compare' ? 'both' : algorithm);
                } else {
                    const res = await fetch('/api/route/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start_lat:startLngLat.lat,start_lon:startLngLat.lng,end_lat:endLngLat.lat,end_lon:endLngLat.lng,algorithm: algorithm === 'compare' ? 'both' : algorithm,include_explored:includeExplored})});
                    const j = await res.json();
                    if(!res.ok || !j.success) throw new Error(j.error||'Failed to compute route.');
                    data = j.data;
                }
                renderRouteResult(data);
            }catch(err){ showError(err.message); } finally { loadingOverlay.classList.remove('active'); }
        }
        // If inputs have text but no pin, geocode them (Nominatim first, category API second).
        let needGeocode=false;
        const tasks=[];
        if(!startLngLat && startQ){
            needGeocode=true;
            tasks.push(geocodeText(startQ, 1)
                .then(item => {
                    if (item) selectPlace('start', item.lat, item.lon, item.name);
                })
                .catch(() => {}));
        }
        if(!endLngLat && endQ){
            needGeocode=true;
            tasks.push(geocodeText(endQ, 1)
                .then(item => {
                    if (item) selectPlace('end', item.lat, item.lon, item.name);
                })
                .catch(() => {}));
        }
        if(needGeocode){ loadingStepText.innerText='Locating places...'; loadingOverlay.classList.add('active'); await Promise.all(tasks); loadingOverlay.classList.remove('active'); if(!startLngLat || !endLngLat) { if(!startLngLat && startQ || !endLngLat && endQ) showError('Could not locate one or both places. Try clicking the map.'); return; } }
        proceed();
    });

    // init offline UI
    refreshOfflineUI();

    // Algorithm selector + search-area toggle wiring (additive; defaults preserve old behaviour)
    document.querySelectorAll('input[name="algorithm"]').forEach(r => {
        r.addEventListener('change', () => { if (lastRouteData) renderRouteResult(lastRouteData); });
    });
    const searchToggle = document.getElementById('toggle-search-area');
    if (searchToggle) {
        searchToggle.addEventListener('change', async (e) => {
            showSearchArea = e.target.checked;
            if (showSearchArea && lastRouteData && (!lastRouteData.astar?.explored_coords && !lastRouteData.dijkstra?.explored_coords)) {
                // Re-fetch current route with explored coords included.
                try {
                    btnCalculate.click();
                } catch {}
                return;
            }
            refreshSearchArea();
        });
    }

    // Benchmark mode: run fixed Kathmandu Valley suite and render averages.
    const btnBenchmark = document.getElementById('btn-run-benchmark');
    if (btnBenchmark) {
        btnBenchmark.addEventListener('click', async () => {
            const statusEl = document.getElementById('benchmark-status');
            const resultsEl = document.getElementById('benchmark-results');
            const bodyEl = document.getElementById('benchmark-body');
            const avgEl = document.getElementById('benchmark-averages');
            btnBenchmark.disabled = true;
            btnBenchmark.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running...';
            if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Running Dijkstra vs A* on 6 real valley routes...'; }
            if (resultsEl) resultsEl.style.display = 'none';
            try {
                const res = await fetch('/api/benchmark/');
                const payload = await res.json();
                if (!res.ok || !payload.success) throw new Error(payload.error || 'Benchmark failed.');
                const { routes, averages } = payload.data;
                if (bodyEl) {
                    bodyEl.innerHTML = routes.map(r => {
                        if (r.error) return `<tr><td>${r.name}</td><td colspan="8">Error: ${r.error}</td></tr>`;
                        return `<tr><td>${r.name}</td><td>${r.dijkstra.distance_km} km</td><td>${r.astar.distance_km} km</td><td>${r.dijkstra.execution_time_ms} ms</td><td>${r.astar.execution_time_ms} ms</td><td>${r.dijkstra.nodes_explored}</td><td>${r.astar.nodes_explored}</td><td>${r.speedup}×</td><td>${r.node_reduction_percent}%</td></tr>`;
                    }).join('');
                }
                if (avgEl) {
                    avgEl.innerHTML =
                        `<div class="benchmark-avg-card">Avg Dijkstra time<strong>${averages.avg_dijkstra_time_ms} ms</strong></div>` +
                        `<div class="benchmark-avg-card">Avg A* time<strong>${averages.avg_astar_time_ms} ms</strong></div>` +
                        `<div class="benchmark-avg-card">Avg Dijkstra nodes<strong>${averages.avg_dijkstra_nodes}</strong></div>` +
                        `<div class="benchmark-avg-card">Avg A* nodes<strong>${averages.avg_astar_nodes}</strong></div>` +
                        `<div class="benchmark-avg-card">Avg speedup<strong>${averages.avg_speedup}× (A*)</strong></div>` +
                        `<div class="benchmark-avg-card">Avg node reduction<strong>${averages.avg_node_reduction_percent}%</strong></div>`;
                }
                if (resultsEl) resultsEl.style.display = 'block';
                if (statusEl) statusEl.textContent = `Done — ${averages.successful_routes}/${averages.routes} routes · A* ${averages.avg_speedup}× faster on average.`;
            } catch (err) {
                if (statusEl) statusEl.textContent = 'Benchmark failed: ' + err.message;
            } finally {
                btnBenchmark.disabled = false;
                btnBenchmark.innerHTML = '<i class="fa-solid fa-play"></i> Run Benchmark';
            }
        });
    }
});
