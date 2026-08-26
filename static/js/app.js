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
        astar:    { line: '#10b981', glow: 'rgba(16,185,129,0.55)' },
        dijkstra: { line: '#1d4ed8', glow: 'rgba(29,78,216,0.45)' },
        alt1:     { line: '#f97316', glow: 'rgba(249,115,22,0.35)' },
        alt2:     { line: '#ec4899', glow: 'rgba(236,72,153,0.35)' }
    };

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

    const startInput = document.getElementById('start-input');
    const endInput = document.getElementById('end-input');
    const startResults = document.getElementById('start-results');
    const endResults = document.getElementById('end-results');
    const clearStartBtn = document.getElementById('clear-start');
    const clearEndBtn = document.getElementById('clear-end');
    const btnSwap = document.getElementById('btn-swap');
    const btnCalculate = document.getElementById('btn-calculate');
    const btnReset = document.getElementById('btn-reset');
    const errorAlert = document.getElementById('error-alert');
    const errorMessage = document.getElementById('error-message');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingStepText = document.getElementById('loading-step-text');
    const resultsSection = document.getElementById('results-section');
    const routeToggleGroup = document.getElementById('route-toggle-group');
    const mapHint = document.getElementById('map-hint');
    const routeInfoPanel = document.getElementById('route-info-panel');
    const routeInfoTitle = document.getElementById('route-info-title');
    const routeInfoBody = document.getElementById('route-info-body');
    const closeRouteInfo = document.getElementById('close-route-info');
    const tiltLabel = document.getElementById('tilt-label');

    function inBounds(lat, lng) {
        return lat >= VALLEY_BOUNDS.south && lat <= VALLEY_BOUNDS.north && lng >= VALLEY_BOUNDS.west && lng <= VALLEY_BOUNDS.east;
    }

    function pathToLine(path) { return path.map(c => [c[1], c[0]]); }
    function pointAtFraction(path, frac) {
        if (!path || path.length === 0) return null;
        const idx = Math.min(path.length - 1, Math.max(0, Math.floor(path.length * frac)));
        return path[idx];
    }

    function pinElement(kind, letter) {
        const el = document.createElement('div');
        el.className = `gpin gpin-${kind}`;
        el.addEventListener('click', ev => ev.stopPropagation());
        const fill = kind === 'start' ? '#34A853' : '#EA4335';
        el.innerHTML = `
            <svg viewBox="0 0 40 54" width="40" height="54" aria-hidden="true">
                <ellipse cx="20" cy="51" rx="9" ry="2.6" fill="rgba(0,0,0,0.28)"/>
                <path d="M20 1.5C11.4 1.5 4.5 8.4 4.5 17c0 11.4 15.5 34 15.5 34S35.5 28.4 35.5 17C35.5 8.4 28.6 1.5 20 1.5z" fill="${fill}" stroke="#fff" stroke-width="1.4"/>
                <circle cx="20" cy="17" r="8.2" fill="#fff"/>
                <text x="20" y="21.2" text-anchor="middle" font-size="11.5" font-weight="800" font-family="Outfit, system-ui, sans-serif" fill="${fill}">${letter}</text>
            </svg>`;
        return el;
    }

    function createMarker(kind, lng, lat) {
        const letter = kind === 'start' ? 'A' : 'B';
        const title = kind === 'start' ? 'Start' : 'Destination';
        const marker = new maplibregl.Marker({ element: pinElement(kind, letter), anchor: 'bottom', draggable: true, offset: [0, 2] })
            .setLngLat([lng, lat])
            .setPopup(new maplibregl.Popup({ offset: 42, closeButton: false }).setHTML(`<strong>${title}</strong>`))
            .addTo(map);

        marker.on('dragend', () => {
            const pos = marker.getLngLat();
            if (!inBounds(pos.lat, pos.lng)) {
                showError('Pin must stay inside the Kathmandu Valley study area.');
                marker.setLngLat(kind === 'start' ? startLngLat : endLngLat);
                return;
            }
            if (kind === 'start') {
                startLngLat = pos;
                startInput.value = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
            } else {
                endLngLat = pos;
                endInput.value = `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
            }
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
        clearRoutes();
        checkButtons();
        updateHint();
        reverseGeocode(lat, lng).then(name => {
            if (name) {
                startInput.value = name;
                startInput.title = `${name} · ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            }
        });
    }

    function setEnd(lat, lng, fly) {
        if (endMarker) endMarker.remove();
        endLngLat = { lng, lat };
        endMarker = createMarker('end', lng, lat);
        endInput.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        endInput.title = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (fly) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15.2), pitch: is3D ? 58 : 0, duration: 900 });
        clearRoutes();
        checkButtons();
        updateHint();
        reverseGeocode(lat, lng).then(name => {
            if (name) {
                endInput.value = name;
                endInput.title = `${name} · ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            }
        });
    }

    function updateHint() {
        if (!startMarker) {
            mapHint.innerHTML = '<i class="fa-solid fa-hand-pointer"></i><span>Click the map or type a location to begin</span>';
            mapHint.hidden = false;
        } else if (!endMarker) {
            mapHint.innerHTML = '<i class="fa-solid fa-flag"></i><span>Now set the destination</span>';
            mapHint.hidden = false;
        } else {
            mapHint.hidden = true;
        }
    }

    function checkButtons() {
        btnCalculate.disabled = !(startLngLat && endLngLat);
    }

    function emptyLine() {
        return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };
    }

    function ensureRouteLayers() {
        if (map.getSource('route-astar')) { routeLayersReady = true; return; }
        // Layer draw order: first added = bottom. So alternatives (bottom) → baseline → A* recommended (topmost, most visible)
        const routeConfigs = [
            { id: 'alt2',     color: ROUTE_COLORS.alt2.line,     width: 4,  dash: [3, 4] },
            { id: 'alt1',     color: ROUTE_COLORS.alt1.line,     width: 5,  dash: [5, 3] },
            { id: 'dijkstra', color: ROUTE_COLORS.dijkstra.line, width: 8,  dash: null },
            { id: 'astar',    color: ROUTE_COLORS.astar.line,    width: 10, dash: null }
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
        distanceMarkers.forEach(m => m.remove());
        distanceMarkers = [];
        resultsSection.style.display = 'none';
        const explainer = document.getElementById('algorithm-explainer'); if (explainer) explainer.style.display = 'none';
        routeToggleGroup.innerHTML = '';
        routeInfoPanel.hidden = true;
        activeRouteVisibility = { astar: true, dijkstra: true, alt1: true, alt2: true };
        hideError();
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
        clearRoutes();
        checkButtons();
        updateHint();
    }

    function showError(msg) { errorMessage.innerText = msg; errorAlert.classList.add('active'); }
    function hideError() { errorAlert.classList.remove('active'); }

    function toggleRouteVisibility(key, visible) {
        activeRouteVisibility[key] = visible;
        const o = visible ? 0.95 : 0, g = visible ? 0.5 : 0, c = visible ? 0.9 : 0;
        if (map.getLayer(`${key}-line`)) {
            map.setPaintProperty(`${key}-line`, 'line-opacity', o);
            map.setPaintProperty(`${key}-casing`, 'line-opacity', c);
            map.setPaintProperty(`${key}-glow`, 'line-opacity', g);
        }
        const dot = document.querySelector(`.route-toggle-dot[data-key="${key}"]`);
        if (dot) dot.classList.toggle('dimmed', !visible);
    }

    function createDistanceBubble(path, color, text, frac = 0.5, offsetY = 0, offsetX = 0) {
        const p = pointAtFraction(path, frac);
        if (!p) return;
        const el = document.createElement('div');
        el.className = 'distance-bubble';
        el.style.background = color;
        el.style.boxShadow = `0 4px 12px ${color}66`;
        el.style.border = '2px solid rgba(255,255,255,0.95)';
        el.style.fontWeight = '800';
        el.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
        el.style.zIndex = 2;
        el.textContent = text;
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p[1], p[0]]).addTo(map);
        distanceMarkers.push(marker);
    }

    function buildRouteToggles(data) {
        const routes = [
            { key: 'astar', label: 'A* · ML Traffic-Optimized', color: ROUTE_COLORS.astar.line },
            { key: 'dijkstra', label: 'Dijkstra · Shortest Baseline', color: ROUTE_COLORS.dijkstra.line }
        ];
        if (data.alt1) routes.push({ key: 'alt1', label: 'Alternative 1', color: ROUTE_COLORS.alt1.line });
        if (data.alt2) routes.push({ key: 'alt2', label: 'Alternative 2', color: ROUTE_COLORS.alt2.line });
        routeToggleGroup.innerHTML = '';
        routes.forEach(r => {
            const t = document.createElement('div');
            t.className = 'route-toggle-item';
            t.title = `Click to view ${r.label} details`;
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
        const stats = data.traffic_stats || {};
        const lc = stats.level_counts || {};
        const travelMode = data.travel_mode === 'traffic' ? '<span class="ml-badge" style="margin-left:4px;"><i class="fa-solid fa-brain"></i> ML</span>' : '<span class="traffic-chip free" style="margin-left:4px;">Distance</span>';
        let html = `<div class="info-row"><span class="info-label">Mode</span><span class="info-value">${travelMode}</span></div>`;
        html += `<div class="info-row"><span class="info-label">Distance</span><span class="info-value">${data.distance_km} km</span></div>`;
        html += `<div class="info-row"><span class="info-label">Free-Flow</span><span class="info-value">${data.freeflow_travel_minutes || data.travel_time_minutes} min</span></div>`;
        html += `<div class="info-row"><span class="info-label">Predicted Travel</span><span class="info-value" style="color:${data.travel_mode === 'traffic' ? '#1a73e8' : '#222'};">${data.travel_time_minutes} min</span></div>`;
        html += `<div class="info-row"><span class="info-label">Road Nodes</span><span class="info-value">${data.path_nodes_count}</span></div>`;
        if (stats.dominant_congestion) {
            html += `<div class="info-row"><span class="info-label">Dominant Congestion</span><span class="info-value">${renderCongestionLevel(stats.dominant_congestion)}</span></div>`;
        }
        if (lc && (lc.free || lc.light || lc.moderate || lc.heavy)) {
            html += `<div class="info-row"><span class="info-label">Breakdown</span><span class="info-value" style="font-size:0.7rem;font-weight:600;">🟢${lc.free||0} 🟡${lc.light||0} 🟠${lc.moderate||0} 🔴${lc.heavy||0}</span></div>`;
        }
        if (roads.length > 0) html += `<div class="info-roads"><span class="info-label">Roads on route:</span><div class="road-tags">${roads.map(r => `<span class="road-tag">${r}</span>`).join('')}</div></div>`;
        routeInfoBody.innerHTML = html;
        routeInfoPanel.hidden = false;
    }

    map.on('load', () => {
        ensureRouteLayers();
        try { map.setSky({ 'sky-color': '#87b8e8', 'horizon-color': '#f4efe6', 'fog-color': '#f4efe6', 'fog-ground-blend': 0.35 }); } catch {}
    });
    map.on('style.load', () => { routeLayersReady = false; ensureRouteLayers(); if (lastRouteData) drawRoutesOnMap(lastRouteData); });

    map.on('click', e => {
        if (e.originalEvent.target.closest('.gpin, .map-style-switcher, .map-fabs, .map-legend-card, .route-info-panel, .maplibregl-ctrl')) return;
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

    function renderCongestionLevel(level) {
        const icons = { free: 'fa-check', light: 'fa-circle-notch', moderate: 'fa-triangle-exclamation', heavy: 'fa-circle-stop' };
        const labels = { free: 'Free Flow', light: 'Light', moderate: 'Moderate', heavy: 'Heavy' };
        return `<span class="traffic-chip ${level}"><i class="fa-solid ${icons[level] || 'fa-circle'}"></i> ${labels[level] || level}</span>`;
    }

    function renderComparison(comp, baselineRoute, optimizedRoute) {
        const card = document.getElementById('comparison-card');
        if (!comp) { card.style.display = 'none'; return; }
        card.style.display = 'block';

        document.getElementById('comparison-recommendation').innerHTML = comp.recommendation || '';

        const deltaT = comp.travel_time_delta_minutes || 0;
        const deltaKm = comp.distance_delta_km || 0;
        const faster = deltaT < -0.05;
        const slower = deltaT > 0.05;
        const shorter = deltaKm < -0.01;
        const longer = deltaKm > 0.01;

        function arrow(cls, up) { return `<i class="fa-solid fa-arrow-${up ? 'up' : 'down'}"></i>`; }

        const dtEl = document.getElementById('delta-time');
        if (faster) { dtEl.className = 'delta-value faster'; dtEl.innerHTML = `${arrow('faster', false)} ${Math.abs(deltaT).toFixed(1)} min saved`; }
        else if (slower) { dtEl.className = 'delta-value slower'; dtEl.innerHTML = `${arrow('slower', true)} +${deltaT.toFixed(1)} min`; }
        else { dtEl.className = 'delta-value same'; dtEl.innerHTML = '≈ same'; }

        const dkEl = document.getElementById('delta-distance');
        if (shorter) { dkEl.className = 'delta-value shorter'; dkEl.innerHTML = `${arrow('shorter', false)} ${Math.abs(deltaKm).toFixed(2)} km shorter`; }
        else if (longer) { dkEl.className = 'delta-value longer'; dkEl.innerHTML = `${arrow('longer', true)} +${deltaKm.toFixed(2)} km`; }
        else { dkEl.className = 'delta-value same'; dkEl.innerHTML = '≈ same'; }

        document.getElementById('delta-baseline-cong').innerHTML = `<i class="fa-solid fa-road" style="color:#ff9f43;"></i> ${comp.baseline_congested_segments || 0} seg`;
        document.getElementById('delta-optimized-cong').innerHTML = `<i class="fa-solid fa-road" style="color:#1a73e8;"></i> ${comp.optimized_congested_segments || 0} seg`;

        const reasonsEl = document.getElementById('comparison-reasons');
        reasonsEl.innerHTML = (comp.reasons || []).map(r => `<li>${r}</li>`).join('');

        function buildCongBars(routeObj, routeName, prefix) {
            const stats = (routeObj && routeObj.traffic_stats) ? routeObj.traffic_stats : {};
            const lc = stats.level_counts || {};
            const total = (lc.free || 0) + (lc.light || 0) + (lc.moderate || 0) + (lc.heavy || 0) || 1;
            const levels = [
                { key: 'free', label: 'Free', count: lc.free || 0 },
                { key: 'light', label: 'Light', count: lc.light || 0 },
                { key: 'moderate', label: 'Mod.', count: lc.moderate || 0 },
                { key: 'heavy', label: 'Heavy', count: lc.heavy || 0 }
            ];
            return levels.map(l => {
                const pct = Math.round((l.count / total) * 100);
                return `<div class="cong-bar cong-${l.key}">
                    <div class="cong-bar-fill-outer"><div class="cong-bar-fill-inner" style="width:${pct}%"></div></div>
                    <div class="cong-bar-label"><span>${l.label}</span><span>${l.count}</span></div>
                </div>`;
            }).join('');
        }

        const congEl = document.getElementById('congestion-distribution');
        if (comp.same_path) {
            congEl.innerHTML = `<div style="grid-column:span 4;text-align:center;font-size:0.72rem;color:#9ca3af;padding:0.25rem;">Both routes follow the same path — congestion profile is identical.</div>`;
        } else {
            congEl.innerHTML = `
                <div style="grid-column:span 4;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.4px;color:#9ca3af;font-weight:700;margin-bottom:-0.1rem;">Dijkstra Baseline</div>
                ${buildCongBars(baselineRoute, 'baseline', 'b')}
                <div style="grid-column:span 4;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.4px;color:#9ca3af;font-weight:700;margin-top:0.35rem;margin-bottom:-0.1rem;">A* ML-Optimized</div>
                ${buildCongBars(optimizedRoute, 'optimized', 'o')}
            `;
        }
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
        if (data.astar && data.astar.path && data.astar.path.length > 0)
            createDistanceBubble(data.astar.path, ROUTE_COLORS.astar.line, `${data.astar.distance_km} km · A* ✅ Recommended`, 0.52, -38, 0);
        if (data.dijkstra && data.dijkstra.path && data.dijkstra.path.length > 0)
            createDistanceBubble(data.dijkstra.path, ROUTE_COLORS.dijkstra.line, `${data.dijkstra.distance_km} km · Dijkstra`, 0.25, 24, 0);
        if (data.alt1 && data.alt1.path && data.alt1.path.length > 0)
            createDistanceBubble(data.alt1.path, ROUTE_COLORS.alt1.line, `${data.alt1.distance_km} km · Alt 1`, 0.75, 30, 0);
        if (data.alt2 && data.alt2.path && data.alt2.path.length > 0)
            createDistanceBubble(data.alt2.path, ROUTE_COLORS.alt2.line, `${data.alt2.distance_km} km · Alt 2`, 0.85, -30, 0);
        document.getElementById('summary-distance').innerText = `Best ${data.astar.travel_time_minutes} min`;
        document.getElementById('summary-time').innerText = `${data.astar.distance_km} km`;
        document.getElementById('summary-nodes').innerText = `${data.astar.path_nodes_count} nodes`;
        document.getElementById('astar-distance').innerText = `${data.astar.distance_km} km`;
        document.getElementById('dijkstra-distance').innerText = `${data.dijkstra.distance_km} km`;
        document.getElementById('astar-time').innerText = `${(data.astar.execution_time_seconds * 1000).toFixed(1)} ms`;
        document.getElementById('dijkstra-time').innerText = `${(data.dijkstra.execution_time_seconds * 1000).toFixed(1)} ms`;
        document.getElementById('astar-nodes').innerText = data.astar.nodes_explored;
        document.getElementById('dijkstra-nodes').innerText = data.dijkstra.nodes_explored;
        document.getElementById('astar-travel').innerText = `~${data.astar.travel_time_minutes} min`;
        document.getElementById('dijkstra-travel').innerText = `~${data.dijkstra.travel_time_minutes} min`;

        const astarCong = (data.astar.traffic_stats && data.astar.traffic_stats.dominant_congestion) ? data.astar.traffic_stats.dominant_congestion : 'free';
        const dijCong = (data.dijkstra.traffic_stats && data.dijkstra.traffic_stats.dominant_congestion) ? data.dijkstra.traffic_stats.dominant_congestion : 'free';
        document.getElementById('astar-congestion').innerHTML = renderCongestionLevel(astarCong);
        document.getElementById('dijkstra-congestion').innerHTML = renderCongestionLevel(dijCong);

        renderComparison(data.comparison, data.dijkstra, data.astar);
        buildRouteToggles(data);
        showRouteInfo('astar', data.astar);
        document.getElementById('algorithm-explainer').style.display = 'block';
        resultsSection.style.display = 'block';
        drawChart(data.astar.nodes_explored, data.dijkstra.nodes_explored);
    }

    function drawChart(ae, de) {
        const ctx = document.getElementById('performance-chart').getContext('2d');
        if (chartInstance) chartInstance.destroy();
        chartInstance = new Chart(ctx, { type: 'bar', data: { labels: ['Nodes Explored'], datasets: [{ label: 'A* 🏆 Optimal', data: [ae], backgroundColor: '#10b981', borderColor: '#059669', borderWidth: 1, borderRadius: 4 }, { label: 'Dijkstra Baseline', data: [de], backgroundColor: '#1d4ed8', borderColor: '#1e40af', borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#9ca3af', font: { family: 'Outfit', size: 11 } } }, title: { display: true, text: 'Algorithm Efficiency (Lower is Better)', color: '#f3f4f6', font: { family: 'Outfit', size: 12, weight: 'bold' } } }, scales: { y: { beginAtZero: true, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { ticks: { color: '#9ca3af' }, grid: { display: false } } } } });
    }

    // ===== SEARCH =====
    let startTimeout = null;
    let endTimeout = null;

    function selectPlace(kind, lat, lon, name) {
        const input = kind === 'start' ? startInput : endInput;
        const results = kind === 'start' ? startResults : endResults;
        input.value = name;
        input.title = name + ' · ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
        results.style.display = 'none';
        results.innerHTML = '';
        if (kind === 'start') {
            setStart(lat, lon, true);
        } else {
            setEnd(lat, lon, true);
        }
    }

    function doSearch(query, container, kind) {
        if (!query) { container.style.display = 'none'; return Promise.resolve([]); }
        return fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(query) + '&viewbox=85.15,27.82,85.55,27.55&bounded=1&limit=6&addressdetails=1', { headers: { 'Accept-Language': 'en' } })
            .then(function(res) { return res.ok ? res.json() : []; })
            .then(function(data) {
                if (data.length === 0) {
                    container.innerHTML = '<div class="search-item no-results">No locations found in Kathmandu Valley</div>';
                    container.style.display = 'block';
                    return [];
                }
                container.innerHTML = '';
                data.forEach(function(item) {
                    var name = item.display_name.split(',').slice(0, 3).join(',');
                    var lat = parseFloat(item.lat);
                    var lon = parseFloat(item.lon);
                    var div = document.createElement('div');
                    div.className = 'search-item';
                    div.innerHTML = '<i class="fa-solid fa-location-dot"></i><span>' + name + '</span>';
                    div.addEventListener('mousedown', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        selectPlace(kind, lat, lon, name);
                    });
                    container.appendChild(div);
                });
                container.style.display = 'block';
                return data;
            })
            .catch(function(err) { console.error('Geocoding failed:', err); return []; });
    }

    function geocodePlace(query, kind) {
        return fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(query) + '&viewbox=85.15,27.82,85.55,27.55&bounded=1&limit=1&addressdetails=1', { headers: { 'Accept-Language': 'en' } })
            .then(function(res) { return res.ok ? res.json() : []; })
            .then(function(data) {
                if (!data || data.length === 0) return null;
                var item = data[0];
                var name = item.display_name.split(',').slice(0, 3).join(',');
                var lat = parseFloat(item.lat);
                var lon = parseFloat(item.lon);
                selectPlace(kind, lat, lon, name);
                return { lat: lat, lon: lon, name: name };
            })
            .catch(function(err) { console.error('Geocoding failed:', err); return null; });
    }

    startInput.addEventListener('input', function(e) {
        var q = e.target.value.trim();
        clearStartBtn.style.display = q ? 'block' : 'none';
        if (startTimeout) clearTimeout(startTimeout);
        if (!q) { startResults.style.display = 'none'; return; }
        startTimeout = setTimeout(function() { doSearch(q, startResults, 'start'); }, 350);
    });

    endInput.addEventListener('input', function(e) {
        var q = e.target.value.trim();
        clearEndBtn.style.display = q ? 'block' : 'none';
        if (endTimeout) clearTimeout(endTimeout);
        if (!q) { endResults.style.display = 'none'; return; }
        endTimeout = setTimeout(function() { doSearch(q, endResults, 'end'); }, 350);
    });

    startInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (startTimeout) clearTimeout(startTimeout);
            var q = startInput.value.trim();
            if (!q) { startResults.style.display = 'none'; return; }
            doSearch(q, startResults, 'start').then(function(results) {
                if (results && results.length > 0) {
                    var item = results[0];
                    var name = item.display_name.split(',').slice(0, 3).join(',');
                    selectPlace('start', parseFloat(item.lat), parseFloat(item.lon), name);
                }
            });
        }
    });

    endInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (endTimeout) clearTimeout(endTimeout);
            var q = endInput.value.trim();
            if (!q) { endResults.style.display = 'none'; return; }
            doSearch(q, endResults, 'end').then(function(results) {
                if (results && results.length > 0) {
                    var item = results[0];
                    var name = item.display_name.split(',').slice(0, 3).join(',');
                    selectPlace('end', parseFloat(item.lat), parseFloat(item.lon), name);
                }
            });
        }
    });

    clearStartBtn.addEventListener('click', function() {
        startInput.value = '';
        clearStartBtn.style.display = 'none';
        startResults.style.display = 'none';
        startLngLat = null;
        if (startMarker) { startMarker.remove(); startMarker = null; }
        checkButtons();
        updateHint();
    });

    clearEndBtn.addEventListener('click', function() {
        endInput.value = '';
        clearEndBtn.style.display = 'none';
        endResults.style.display = 'none';
        endLngLat = null;
        if (endMarker) { endMarker.remove(); endMarker = null; }
        checkButtons();
        updateHint();
    });

    document.addEventListener('mousedown', function(e) {
        if (!startInput.contains(e.target) && !startResults.contains(e.target)) {
            startResults.style.display = 'none';
        }
        if (!endInput.contains(e.target) && !endResults.contains(e.target)) {
            endResults.style.display = 'none';
        }
    });

    // ===== CALCULATE =====
    btnCalculate.addEventListener('click', function() {
        var startQ = startInput.value.trim();
        var endQ = endInput.value.trim();

        function proceed() {
            if (!startLngLat || !endLngLat) {
                showError('Please set both a start and destination location (type and press Enter, or click a search result, or click the map).');
                return;
            }
            hideError();
            ['dijkstra', 'astar', 'alt1', 'alt2'].forEach(function(key) {
                if (map.getSource('route-' + key)) map.getSource('route-' + key).setData(emptyLine());
            });
            resultsSection.style.display = 'none';
            distanceMarkers.forEach(function(m) { m.remove(); });
            distanceMarkers = [];
            routeInfoPanel.hidden = true;
            loadingStepText.innerText = 'Finding nearest road nodes & computing routes...';
            loadingOverlay.classList.add('active');

            fetch('/api/route/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_lat: startLngLat.lat, start_lon: startLngLat.lng, end_lat: endLngLat.lat, end_lon: endLngLat.lng })
            })
            .then(function(response) {
                return response.json().then(function(result) {
                    if (!response.ok || !result.success) throw new Error(result.error || 'Failed to compute route.');
                    renderRouteResult(result.data);
                });
            })
            .catch(function(err) { showError(err.message); })
            .finally(function() { loadingOverlay.classList.remove('active'); });
        }

        var geocodeTasks = [];
        if (!startLngLat && startQ) {
            loadingStepText.innerText = 'Locating "' + startQ + '"...';
            loadingOverlay.classList.add('active');
            geocodeTasks.push(geocodePlace(startQ, 'start'));
        }
        if (!endLngLat && endQ) {
            if (!loadingOverlay.classList.contains('active')) {
                loadingStepText.innerText = 'Locating "' + endQ + '"...';
                loadingOverlay.classList.add('active');
            } else {
                loadingStepText.innerText = 'Locating start and destination...';
            }
            geocodeTasks.push(geocodePlace(endQ, 'end'));
        }

        if (geocodeTasks.length > 0) {
            Promise.all(geocodeTasks).then(function(results) {
                if ((!startLngLat && startQ) || (!endLngLat && endQ)) {
                    loadingOverlay.classList.remove('active');
                    showError('Could not locate one or both places. Try a more specific name or click the map.');
                    return;
                }
                proceed();
            });
        } else {
            proceed();
        }
    });
});
