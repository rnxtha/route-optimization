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
        btnCalculate.disabled = !hasBoth;
        btnNavigate.style.display = hasBoth && lastRouteData ? 'inline-flex' : 'none';
        if (hasBoth && lastRouteData) btnNavigate.disabled = false;
        else if (!lastRouteData) btnNavigate.disabled = true;
    }
    function emptyLine() { return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }; }
    function ensureRouteLayers() {
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
        distanceMarkers.forEach(m => m.remove()); distanceMarkers = [];
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
        const routes = [
            { key: 'astar', label: 'A* (Heuristic)', color: ROUTE_COLORS.astar.line },
            { key: 'dijkstra', label: 'Dijkstra', color: ROUTE_COLORS.dijkstra.line }
        ];
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
    let navWatchId = null;
    let navPath = [];
    let navRoadNames = [];
    let currentPosMarker = null;
    let navTotalDistance = 0;

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
        if (cur.coord) {
            map.easeTo({ center: [cur.coord[1], cur.coord[0]], zoom: Math.max(map.getZoom(), 16), pitch: 50, duration: 800 });
        }
    }

    function startNavigation() {
        if (!lastRouteData || !lastRouteData.astar || !lastRouteData.astar.path || lastRouteData.astar.path.length === 0) {
            showError('No route available to navigate. Please calculate a route first.');
            return;
        }
        navPath = lastRouteData.astar.path;
        navRoadNames = lastRouteData.astar.road_names || [];
        navSteps = generateNavigationSteps(navPath, navRoadNames);
        navCurrentIdx = 0;
        navTotalDistance = navSteps.reduce((a,s)=>a+s.distanceM,0);
        navigationPanel.hidden = false;
        document.body.classList.add('navigating');
        updateNavPanel();

        // Try real GPS
        if ('geolocation' in navigator) {
            document.getElementById('nav-subtitle').textContent = 'Waiting for GPS...';
            navWatchId = navigator.geolocation.watchPosition(
                onGpsUpdate,
                onGpsError,
                { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
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
        if (!currentPosMarker) {
            const el = document.createElement('div');
            el.className = 'gps-dot';
            el.innerHTML = '<div class="gps-dot-inner"></div><div class="gps-dot-pulse"></div>';
            currentPosMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map);
        } else {
            currentPosMarker.setLngLat([lon, lat]);
        }
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
        // also auto-center map on GPS when navigating
        map.easeTo({ center: [lon, lat], duration: 1000 });
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
        if (currentPosMarker) { currentPosMarker.remove(); currentPosMarker = null; }
        navigationPanel.hidden = true;
        document.body.classList.remove('navigating');
        navSteps = []; navCurrentIdx = 0;
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
            visited.add(u); explored++;
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
        if (!dist.has(endId)) return { path: [], distance: Infinity, nodes_explored: explored, execution_time: (t1-t0)/1000 };
        const path = [];
        let cur = endId;
        while (cur !== undefined) { path.push(cur); cur = parent.get(cur); if (cur===startId) { path.push(cur); break; } }
        path.reverse();
        return { path, distance: dist.get(endId), nodes_explored: explored, execution_time: (t1-t0)/1000 };
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
        const pq = [[fScore.get(startId), startId]];
        let explored=0;
        function popMin(){ let mi=0; for(let i=1;i<pq.length;i++) if(pq[i][0]<pq[mi][0]) mi=i; return pq.splice(mi,1)[0]; }
        while(pq.length){
            const [f,u]=popMin();
            if(visited.has(u)) continue;
            visited.add(u); explored++;
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
        if(!gScore.has(endId)) return { path:[], distance:Infinity, nodes_explored: explored, execution_time:(t1-t0)/1000 };
        const path=[]; let cur=endId; while(cur!==undefined){ path.push(cur); cur=parent.get(cur); if(cur===startId){path.push(cur);break;} } path.reverse();
        return { path, distance: gScore.get(endId), nodes_explored: explored, execution_time:(t1-t0)/1000 };
    }
    async function offlineRoute(startLat, startLon, endLat, endLon) {
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
        const dRes = dijkstraJS(g, startId, endId);
        const aRes = astarJS(g, startId, endId);
        // Build response similar to server
        const nodeMap = new Map(g.nodes.map(n=>[n.id, n]));
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
            return {
                label, distance_meters: r.distance, distance_km: r.distance===Infinity?null:+(r.distance/1000).toFixed(3),
                execution_time_seconds: r.execution_time, nodes_explored: r.nodes_explored, path_nodes_count: r.path.length,
                path: coords, road_names: roadNames, unique_road_names: uniq, travel_time_minutes: +(totalSec/60).toFixed(1)
            };
        }
        const dijkstra = buildResult(dRes, 'Dijkstra (Shortest)');
        const astar = buildResult(aRes, 'A* (Heuristic)');
        // Alternatives
        let alt1=null, alt2=null;
        if(dRes.path.length){
            const pen = new Set(dRes.path.slice(0,-1).map((id,i)=>id+','+dRes.path[i+1]));
            const a1 = dijkstraJS(g, startId, endId, pen, 3.0);
            if(a1.path.length && a1.path.join(',')!==dRes.path.join(',')){
                alt1 = buildResult(a1, 'Alternative 1');
                const pen2 = new Set([...pen, ...a1.path.slice(0,-1).map((id,i)=>id+','+a1.path[i+1])]);
                const a2 = astarJS(g, startId, endId, pen2, 4.0);
                if(a2.path.length && a2.path.join(',')!==dRes.path.join(',') && a2.path.join(',')!==a1.path.join(',')){
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
            loadingOverlay.classList.remove('active');
            showError(''); hideError();
            // show success as transient
            const msg = document.createElement('div');
            msg.className='offline-toast'; msg.innerHTML='<i class="fa-solid fa-check"></i> Offline region saved ('+sizeMB+' MB)';
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
    map.on('load', () => { ensureRouteLayers(); try { map.setSky({ 'sky-color': '#87b8e8', 'horizon-color': '#f4efe6', 'fog-color': '#f4efe6', 'fog-ground-blend': 0.35 }); } catch {} });
    map.on('style.load', () => { routeLayersReady = false; ensureRouteLayers(); if (lastRouteData) drawRoutesOnMap(lastRouteData); });
    map.on('click', e => {
        if (navigationPanel.hidden === false) return; // don't place pins while navigating
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
    document.getElementById('btn-locate').addEventListener('click', () => {
        if (!navigator.geolocation) { showError('Geolocation is not supported.'); return; }
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            if (!inBounds(lat, lng)) { showError('Your location is outside the Kathmandu Valley study area.'); return; }
            map.flyTo({ center: [lng, lat], zoom: 16, pitch: is3D ? 58 : 0, duration: 1000 });
            if (!startMarker) setStart(lat, lng, false);
            else if (!endMarker) setEnd(lat, lng, false);
        }, () => showError('Could not read your location. Allow location access and try again.'));
    });
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
    btnNavigate.addEventListener('click', startNavigation);
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
        if(!data || !data.dijkstra || !data.astar){ cmpEl.style.display='none'; return; }
        cmpEl.style.display='block';
        const dDist=data.dijkstra.distance_km, aDist=data.astar.distance_km;
        const sameDist = dDist!==null && aDist!==null && Math.abs(dDist - aDist) < 0.001;
        document.getElementById('cmp-distance-match').textContent = sameDist ? '✓ Same ('+dDist+' km)' : '✗ Different (D:'+dDist+' A:'+aDist+')';
        document.getElementById('cmp-distance-match').style.color = sameDist ? '#10b981' : '#ef4444';
        document.getElementById('cmp-astar-nodes').textContent = data.astar.nodes_explored;
        document.getElementById('cmp-dijkstra-nodes').textContent = data.dijkstra.nodes_explored;
        document.getElementById('cmp-astar-time').textContent = (data.astar.execution_time_seconds*1000).toFixed(1)+' ms';
        document.getElementById('cmp-dijkstra-time').textContent = (data.dijkstra.execution_time_seconds*1000).toFixed(1)+' ms';
        const speedup = data.dijkstra.execution_time_seconds / Math.max(0.0001, data.astar.execution_time_seconds);
        const exploredRatio = data.dijkstra.nodes_explored / Math.max(1, data.astar.nodes_explored);
        document.getElementById('cmp-speedup').textContent = `A* ${speedup.toFixed(1)}× faster, ${exploredRatio.toFixed(1)}× fewer nodes`;
    }

    function renderRouteResult(data) {
        lastRouteData = data;
        if (data.start_coords) { startLngLat = { lat: data.start_coords[0], lng: data.start_coords[1] }; if (startMarker) startMarker.setLngLat([startLngLat.lng, startLngLat.lat]); }
        if (data.end_coords) { endLngLat = { lat: data.end_coords[0], lng: data.end_coords[1] }; if (endMarker) endMarker.setLngLat([endLngLat.lng, endLngLat.lat]); }
        drawRoutesOnMap(data);
        const bounds = new maplibregl.LngLatBounds();
        ['dijkstra', 'astar', 'alt1', 'alt2'].forEach(k => { if (data[k] && data[k].path) data[k].path.forEach(c => bounds.extend([c[1], c[0]])); });
        map.fitBounds(bounds, { padding: { top: 100, bottom: 150, left: 100, right: 100 }, pitch: is3D ? DEFAULT_PITCH : 0, bearing: DEFAULT_BEARING, duration: 1400, maxZoom: 16 });
        distanceMarkers.forEach(m => m.remove()); distanceMarkers = [];
        if (data.astar && data.astar.path && data.astar.path.length > 0) createDistanceBubble(data.astar.path, ROUTE_COLORS.astar.line, `${data.astar.distance_km} km · A*`, 0.52);
        if (data.dijkstra && data.dijkstra.path && data.dijkstra.path.length > 0) createDistanceBubble(data.dijkstra.path, ROUTE_COLORS.dijkstra.line, `${data.dijkstra.distance_km} km · Dijkstra`, 0.25);
        if (data.alt1 && data.alt1.path && data.alt1.path.length > 0) createDistanceBubble(data.alt1.path, ROUTE_COLORS.alt1.line, `${data.alt1.distance_km} km`, 0.75);
        if (data.alt2 && data.alt2.path && data.alt2.path.length > 0) createDistanceBubble(data.alt2.path, ROUTE_COLORS.alt2.line, `${data.alt2.distance_km} km`, 0.85);
        document.getElementById('summary-distance').innerText = `${data.astar.distance_km} km`;
        document.getElementById('summary-time').innerText = `~${data.astar.travel_time_minutes} min`;
        document.getElementById('summary-nodes').innerText = `${data.astar.path_nodes_count} nodes`;
        document.getElementById('astar-distance').innerText = `${data.astar.distance_km} km`;
        document.getElementById('dijkstra-distance').innerText = `${data.dijkstra.distance_km} km`;
        document.getElementById('astar-time').innerText = `${(data.astar.execution_time_seconds * 1000).toFixed(1)} ms`;
        document.getElementById('dijkstra-time').innerText = `${(data.dijkstra.execution_time_seconds * 1000).toFixed(1)} ms`;
        document.getElementById('astar-nodes').innerText = data.astar.nodes_explored;
        document.getElementById('dijkstra-nodes').innerText = data.dijkstra.nodes_explored;
        document.getElementById('astar-travel').innerText = `~${data.astar.travel_time_minutes} min`;
        document.getElementById('dijkstra-travel').innerText = `~${data.dijkstra.travel_time_minutes} min`;
        buildRouteToggles(data);
        showRouteInfo('astar', data.astar);
        resultsSection.style.display = 'block';
        renderComparison(data);
        drawChart(data.astar.nodes_explored, data.dijkstra.nodes_explored);
        checkButtons();
    }

    function drawChart(ae, de) {
        const ctx = document.getElementById('performance-chart').getContext('2d');
        if (chartInstance) chartInstance.destroy();
        chartInstance = new Chart(ctx, { type: 'bar', data: { labels: ['Nodes Explored'], datasets: [{ label: 'A*', data: [ae], backgroundColor: '#10b981', borderColor: '#059669', borderWidth: 1, borderRadius: 4 }, { label: 'Dijkstra', data: [de], backgroundColor: '#1d4ed8', borderColor: '#1e40af', borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#9ca3af', font: { family: 'Outfit', size: 11 } } }, title: { display: true, text: 'Algorithm Efficiency (Lower is Better)', color: '#f3f4f6', font: { family: 'Outfit', size: 12, weight: 'bold' } } }, scales: { y: { beginAtZero: true, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { ticks: { color: '#9ca3af' }, grid: { display: false } } } } });
    }

    // ===== SEARCH =====
    let startTimeout = null, endTimeout = null;
    function selectPlace(kind, lat, lon, name) {
        const input = kind === 'start' ? startInput : endInput;
        const results = kind === 'start' ? startResults : endResults;
        input.value = name; input.title = name + ' · ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
        results.style.display = 'none'; results.innerHTML = '';
        if (kind === 'start') setStart(lat, lon, true); else setEnd(lat, lon, true);
    }
    function doSearch(query, container, kind) {
        if (!query) { container.style.display = 'none'; return Promise.resolve([]); }
        if (!navigator.onLine) { container.innerHTML = '<div class="search-item no-results">Offline — search unavailable. Click the map to set location.</div>'; container.style.display='block'; return Promise.resolve([]); }
        return fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(query) + '&viewbox=85.15,27.82,85.55,27.55&bounded=1&limit=6&addressdetails=1', { headers: { 'Accept-Language': 'en' } })
            .then(res => res.ok ? res.json() : [])
            .then(data => {
                if (data.length === 0) { container.innerHTML = '<div class="search-item no-results">No locations found in Kathmandu Valley</div>'; container.style.display = 'block'; return []; }
                container.innerHTML = '';
                data.forEach(item => {
                    const name = item.display_name.split(',').slice(0, 3).join(',');
                    const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
                    const div = document.createElement('div');
                    div.className = 'search-item';
                    div.innerHTML = '<i class="fa-solid fa-location-dot"></i><span>' + name + '</span>';
                    div.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); selectPlace(kind, lat, lon, name); });
                    container.appendChild(div);
                });
                container.style.display = 'block'; return data;
            }).catch(err => { console.error('Geocoding failed:', err); return []; });
    }
    startInput.addEventListener('input', e => {
        const q = e.target.value.trim();
        clearStartBtn.style.display = q ? 'block' : 'none';
        if (startTimeout) clearTimeout(startTimeout);
        if (!q) { startResults.style.display = 'none'; return; }
        startTimeout = setTimeout(() => doSearch(q, startResults, 'start'), 350);
    });
    endInput.addEventListener('input', e => {
        const q = e.target.value.trim();
        clearEndBtn.style.display = q ? 'block' : 'none';
        if (endTimeout) clearTimeout(endTimeout);
        if (!q) { endResults.style.display = 'none'; return; }
        endTimeout = setTimeout(() => doSearch(q, endResults, 'end'), 350);
    });
    startInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault(); if (startTimeout) clearTimeout(startTimeout);
            const q = startInput.value.trim(); if (!q) return;
            doSearch(q, startResults, 'start').then(results => { if (results && results.length>0) { const item=results[0]; const name=item.display_name.split(',').slice(0,3).join(','); selectPlace('start', parseFloat(item.lat), parseFloat(item.lon), name); } });
        }
    });
    endInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault(); if (endTimeout) clearTimeout(endTimeout);
            const q = endInput.value.trim(); if (!q) return;
            doSearch(q, endResults, 'end').then(results => { if (results && results.length>0) { const item=results[0]; const name=item.display_name.split(',').slice(0,3).join(','); selectPlace('end', parseFloat(item.lat), parseFloat(item.lon), name); } });
        }
    });
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
            resultsSection.style.display='none'; distanceMarkers.forEach(m=>m.remove()); distanceMarkers=[]; routeInfoPanel.hidden=true;
            loadingStepText.innerText='Finding nearest road nodes & computing routes...';
            loadingOverlay.classList.add('active');
            try{
                let data;
                const shouldUseOffline = useOfflineRouting || !navigator.onLine;
                if(shouldUseOffline){
                    loadingStepText.innerText='Computing offline route (local Dijkstra/A*)...';
                    data = await offlineRoute(startLngLat.lat, startLngLat.lng, endLngLat.lat, endLngLat.lng);
                } else {
                    const res = await fetch('/api/route/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start_lat:startLngLat.lat,start_lon:startLngLat.lng,end_lat:endLngLat.lat,end_lon:endLngLat.lng})});
                    const j = await res.json();
                    if(!res.ok || !j.success) throw new Error(j.error||'Failed to compute route.');
                    data = j.data;
                }
                renderRouteResult(data);
            }catch(err){ showError(err.message); } finally { loadingOverlay.classList.remove('active'); }
        }
        // If inputs have text but no pin, try to geocode them first
        let needGeocode=false;
        const tasks=[];
        if(!startLngLat && startQ){ needGeocode=true; tasks.push(fetch('https://nominatim.openstreetmap.org/search?format=json&q='+encodeURIComponent(startQ)+'&viewbox=85.15,27.82,85.55,27.55&bounded=1&limit=1').then(r=>r.json()).then(d=>{ if(d&&d[0]){ const n=d[0].display_name.split(',').slice(0,3).join(','); selectPlace('start', parseFloat(d[0].lat), parseFloat(d[0].lon), n); }}).catch(()=>{})); }
        if(!endLngLat && endQ){ needGeocode=true; tasks.push(fetch('https://nominatim.openstreetmap.org/search?format=json&q='+encodeURIComponent(endQ)+'&viewbox=85.15,27.82,85.55,27.55&bounded=1&limit=1').then(r=>r.json()).then(d=>{ if(d&&d[0]){ const n=d[0].display_name.split(',').slice(0,3).join(','); selectPlace('end', parseFloat(d[0].lat), parseFloat(d[0].lon), n); }}).catch(()=>{})); }
        if(needGeocode){ loadingStepText.innerText='Locating places...'; loadingOverlay.classList.add('active'); await Promise.all(tasks); loadingOverlay.classList.remove('active'); if(!startLngLat || !endLngLat) { if(!startLngLat && startQ || !endLngLat && endQ) showError('Could not locate one or both places. Try clicking the map.'); return; } }
        proceed();
    });

    // init offline UI
    refreshOfflineUI();
});
