// ---------------------------------------------------------------------------
// GeoLayer 3D - ULPIN generator
// NOTE: This token is visible to anyone who opens the site. In your Mapbox
// account, restrict it to your deployed URL(s) so it cannot be reused elsewhere.
//
// Data model: every FLOOR of a building — above ground or below — gets its
// own unique 14-digit ULPIN. A "shell" describes the building envelope
// (footprint, total height, total floor count); a "unit" is one specific
// floor of that shell and is the thing that actually gets stored, searched
// and exported. Storage is local to this browser only (IndexedDB); there is
// no server and nothing is shared between devices.
// ---------------------------------------------------------------------------
mapboxgl.accessToken = 'pk.eyJ1IjoiZXJpY25pbmciLCJhIjoiY21icXlubWM1MDRiczJvb2xwM2p0amNyayJ9.n-3O6JI5nOp_Lw96ZO5vJQ';

const STATE_CODE = '09'; // Uttar Pradesh
const FLOOR_HEIGHT_M = 3;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const MAX_SCAN_FLOORS = 1500;
const MAX_SCAN_BUILDINGS = 150;

const STYLES = {
    light:     { url: 'mapbox://styles/mapbox/light-v11',             base: '#c5cec9', opacity: 0.72 },
    dark:      { url: 'mapbox://styles/mapbox/dark-v11',              base: '#46585f', opacity: 0.88 },
    satellite: { url: 'mapbox://styles/mapbox/satellite-streets-v12', base: '#e6e8e1', opacity: 0.55 }
};

const OWNERS = [
    'Directorate of State Estates',
    'Lucknow Development Authority',
    'Housing & Urban Planning Dept.',
    'Private title holder (name withheld)'
];

const STATUS_TEXT = { ok: 'Title authenticated', warn: 'Verification pending', bad: 'Dispute flagged' };

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

function lsGet(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch (e) { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const state = {
    styleKey: 'light',
    shell: null,       // the currently selected building's envelope
    selected: null,     // the currently selected floor unit (always has its own ULPIN)
    voiceLang: lsGet('gl.voiceLang', 'en-IN'),
    readAloud: lsGet('gl.readAloud', '0') === '1'
};

// ---------------------------------------------------------------------------
// On-device database (IndexedDB, mirrored in memory for instant reads).
// Every row is one floor unit, keyed by its own ULPIN.
// ---------------------------------------------------------------------------
const DB = (() => {
    const mem = new Map();
    let db = null;

    function open() {
        return new Promise((resolve) => {
            try {
                const req = indexedDB.open('geolayer3d_floors', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('units', { keyPath: 'ulpin' });
                req.onsuccess = () => { db = req.result; resolve(true); };
                req.onerror = () => resolve(false);
                req.onblocked = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    async function load() {
        await open();
        if (!db) return;
        await new Promise((resolve) => {
            try {
                const rq = db.transaction('units').objectStore('units').getAll();
                rq.onsuccess = () => { rq.result.forEach((r) => mem.set(r.ulpin, r)); resolve(); };
                rq.onerror = () => resolve();
            } catch (e) { resolve(); }
        });
    }

    function write(fn) {
        if (!db) return;
        try { fn(db.transaction('units', 'readwrite').objectStore('units')); } catch (e) { /* ignore */ }
    }

    return {
        load,
        persistent: () => !!db,
        get: (u) => mem.get(u),
        all: () => Array.from(mem.values()),
        count: () => mem.size,
        put(rec) { mem.set(rec.ulpin, rec); write((s) => s.put(rec)); },
        putMany(recs) { recs.forEach((r) => mem.set(r.ulpin, r)); write((s) => recs.forEach((r) => s.put(r))); },
        del(u) { mem.delete(u); write((s) => s.delete(u)); },
        clear() { mem.clear(); write((s) => s.clear()); }
    };
})();

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
const map = new mapboxgl.Map({
    container: 'map',
    style: STYLES.light.url,
    center: [80.9462, 26.8467], // Lucknow
    zoom: 16,
    pitch: 55,
    bearing: -17.6,
    antialias: true
});

const geocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    marker: false,
    countries: 'in',
    placeholder: 'Search a city, locality or landmark in India'
});
$('geocoder').appendChild(geocoder.onAdd(map));

map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
}), 'top-right');
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

map.on('error', (e) => {
    const status = e && e.error && e.error.status;
    if (status === 401 || status === 403) $('map-error').hidden = false;
});

// Runs on first load and again after every style switch.
function addLayers() {
    if (!map.getSource('composite')) return;

    const cfg = STYLES[state.styleKey];
    const labelLayerId = map.getStyle().layers.find(
        (l) => l.type === 'symbol' && l.layout && l.layout['text-field']
    )?.id;

    if (!map.getLayer('buildings-3d')) {
        map.addLayer({
            id: 'buildings-3d',
            source: 'composite',
            'source-layer': 'building',
            filter: ['==', 'extrude', 'true'],
            type: 'fill-extrusion',
            minzoom: 15,
            paint: {
                'fill-extrusion-color': cfg.base,
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-base': ['get', 'min_height'],
                'fill-extrusion-opacity': cfg.opacity
            }
        }, labelLayerId);
    }

    // Buildings with at least one indexed floor get a thin teal outline.
    if (!map.getSource('registry-parcels')) map.addSource('registry-parcels', { type: 'geojson', data: registryCollection() });
    if (!map.getLayer('registry-outline')) {
        map.addLayer({
            id: 'registry-outline',
            source: 'registry-parcels',
            type: 'line',
            minzoom: 15,
            paint: {
                'line-color': state.styleKey === 'dark' ? '#7fd1c4' : '#1c6b73',
                'line-width': 1.4,
                'line-opacity': 0.85
            }
        }, labelLayerId);
    }

    // The selected building (translucent) and the selected floor slab
    // (solid) live in their own GeoJSON sources, so highlighting works even
    // when Mapbox building features have no feature id.
    if (!map.getSource('selected-parcel')) map.addSource('selected-parcel', { type: 'geojson', data: selectionCollection() });
    if (!map.getSource('selected-floor')) map.addSource('selected-floor', { type: 'geojson', data: floorCollection() });

    if (!map.getLayer('selected-parcel-3d')) {
        map.addLayer({
            id: 'selected-parcel-3d',
            source: 'selected-parcel',
            type: 'fill-extrusion',
            paint: {
                'fill-extrusion-color': '#f26a1b',
                'fill-extrusion-height': ['get', 'h'],
                'fill-extrusion-base': ['get', 'base'],
                'fill-extrusion-opacity': 0.25
            }
        }, labelLayerId);
    }
    if (!map.getLayer('selected-floor-3d')) {
        map.addLayer({
            id: 'selected-floor-3d',
            source: 'selected-floor',
            type: 'fill-extrusion',
            paint: {
                'fill-extrusion-color': '#10303a',
                'fill-extrusion-height': ['get', 'h'],
                'fill-extrusion-base': ['get', 'base'],
                'fill-extrusion-opacity': 1
            }
        }, labelLayerId);
    }
    if (!map.getLayer('selected-parcel-outline')) {
        map.addLayer({
            id: 'selected-parcel-outline',
            source: 'selected-parcel',
            type: 'line',
            paint: { 'line-color': '#f26a1b', 'line-width': 3 }
        });
    }
}

map.on('style.load', addLayers);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function polygonsOf(geom) {
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
}

function bboxOf(geom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    polygonsOf(geom).forEach((poly) => poly[0].forEach(([x, y]) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }));
    return [minX, minY, maxX, maxY];
}

// Footprint area in m2 (local equirectangular projection, fine at building scale).
function areaM2(geom) {
    const [minX, minY, maxX, maxY] = bboxOf(geom);
    const kx = 111320 * Math.cos(((minY + maxY) / 2) * Math.PI / 180);
    const ky = 110540;
    let total = 0;
    polygonsOf(geom).forEach((rings) => rings.forEach((ring, i) => {
        let a = 0;
        for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
            const xk = (ring[k][0] - minX) * kx, yk = (ring[k][1] - minY) * ky;
            const xj = (ring[j][0] - minX) * kx, yj = (ring[j][1] - minY) * ky;
            a += xk * yj - xj * yk;
        }
        a = Math.abs(a) / 2;
        total += i === 0 ? a : -a; // inner rings are courtyards
    }));
    return Math.max(total, 0);
}

function hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function formatUlpin(u) { return u.replace(/(.{4})/g, '$1 ').trim(); }

// ---------------------------------------------------------------------------
// Building shell (envelope) and per-floor units
// ---------------------------------------------------------------------------

// A short stable id for the building at this position, independent of any
// one floor's ULPIN.
function buildingIdOf(lng, lat) {
    return hashString(`${lng.toFixed(4)}|${lat.toFixed(4)}`).toString(16).padStart(8, '0');
}

// Build the envelope of a building from a clicked/scanned map feature. This
// carries no ULPIN of its own — only individual floors get one.
function buildShell(feature) {
    const geom = JSON.parse(JSON.stringify(feature.geometry));
    const [minX, minY, maxX, maxY] = bboxOf(geom);
    const lng = (minX + maxX) / 2;
    const lat = (minY + maxY) / 2;
    const buildingId = buildingIdOf(lng, lat);
    const rng = mulberry32(hashString(`${buildingId}:shell`));

    let heightM = Number(feature.properties.height);
    if (!(heightM > 0)) heightM = 9 + Math.floor(rng() * 24);
    heightM = Math.round(heightM * 10) / 10;

    const minHeightM = Number(feature.properties.min_height) || 0;
    const rBase = rng(), rBaseN = rng();
    const basements = rBase > 0.7 ? 1 + Math.floor(rBaseN * 3) : 0;
    const depthM = basements * FLOOR_HEIGHT_M;
    const floorsAbove = Math.max(1, Math.round(heightM / FLOOR_HEIGHT_M)); // every building has at least one floor

    return {
        buildingId, lng, lat, heightM, minHeightM, depthM,
        floorsAbove, floorsBelow: basements,
        footprintM2: areaM2(geom),
        volumeM3: areaM2(geom) * (heightM + depthM),
        geometry: geom
    };
}

// Rebuild a building's envelope from any one of its floor units. This is
// what lets ULPIN lookup jump straight to a floor, and still offer the
// floor picker for every other floor of the same building, without needing
// a fresh map click.
function shellFromUnit(u) {
    return {
        buildingId: u.buildingId, lng: u.lng, lat: u.lat,
        heightM: u.buildingHeightM, minHeightM: u.minHeightM || 0, depthM: u.buildingDepthM,
        floorsAbove: u.floorsAboveTotal, floorsBelow: u.floorsBelowTotal,
        footprintM2: u.buildingFootprintM2, volumeM3: u.buildingVolumeM3,
        geometry: u.geometry
    };
}

// Bottom-to-top list of every floor index in a building: negative for
// basements, positive for floors above ground. Every building has at least
// one entry (floor 1), so a single-storey building still gets exactly one
// ULPIN.
function floorList(shell) {
    const list = [];
    for (let k = shell.floorsBelow; k >= 1; k--) list.push(-k);
    for (let f = 1; f <= shell.floorsAbove; f++) list.push(f);
    return list;
}

function floorLabel(f) { return f < 0 ? `Basement ${-f}` : `Floor ${f}`; }

// Generate the full record for ONE floor of a building. The seed is unique
// per building + floor index, so every floor — including a lone floor 1 in
// a single-storey building — gets its own distinct 14-digit ULPIN, and the
// same floor always regenerates to the same ULPIN.
function buildFloorRecord(shell, f) {
    const rng = mulberry32(hashString(`${shell.buildingId}:floor:${f}`));
    let digits = '';
    for (let i = 0; i < 12; i++) digits += Math.floor(rng() * 10);
    const ulpin = STATE_CODE + digits;

    const rUse = rng(), rAreaAdj = rng(), rStatus = rng(), rOwner = rng();
    let use;
    if (f < 0) use = rUse < 0.6 ? 'Parking' : 'Storage and utilities';
    else if (f === 1) use = ['Retail', 'Commercial', 'Parking and lobby', 'Office'][Math.floor(rUse * 4)];
    else use = ['Residential', 'Residential', 'Residential', 'Office', 'Mixed use'][Math.floor(rUse * 5)];

    const floorAreaM2 = shell.footprintM2 * (0.86 + rAreaAdj * 0.1);
    const perUnit = { Residential: 90, Office: 55, 'Mixed use': 70, Retail: 45, Commercial: 60 }[use];
    const unitsEst = perUnit ? Math.max(1, Math.round(floorAreaM2 / perUnit)) : 0;

    let elevLo, elevHi;
    if (f > 0) { elevLo = (f - 1) * FLOOR_HEIGHT_M; elevHi = Math.min(f * FLOOR_HEIGHT_M, shell.heightM); }
    else { const bnum = -f; elevLo = (bnum - 1) * FLOOR_HEIGHT_M; elevHi = bnum * FLOOR_HEIGHT_M; }

    return {
        v: 2, ulpin, buildingId: shell.buildingId, floor: f,
        floorsAboveTotal: shell.floorsAbove, floorsBelowTotal: shell.floorsBelow,
        buildingHeightM: shell.heightM, buildingDepthM: shell.depthM,
        buildingFootprintM2: shell.footprintM2, buildingVolumeM3: shell.volumeM3,
        minHeightM: shell.minHeightM,
        lng: shell.lng, lat: shell.lat, geometry: shell.geometry,
        use, elevLo, elevHi, floorAreaM2, floorVolumeM3: floorAreaM2 * FLOOR_HEIGHT_M, unitsEst,
        status: rStatus < 0.6 ? 'ok' : rStatus < 0.8 ? 'warn' : 'bad',
        owner: OWNERS[Math.floor(rOwner * OWNERS.length)]
    };
}

// Combine a freshly generated floor unit with whatever the database already
// knows about it (place, notes, star, view history).
function mergeRecord(fresh, existing, source) {
    if (existing) {
        return Object.assign({}, fresh, {
            place: existing.place || '',
            note: existing.note || '',
            starred: !!existing.starred,
            firstSeen: existing.firstSeen || Date.now(),
            lastViewed: existing.lastViewed || 0,
            views: existing.views || 0,
            source: existing.source || source
        });
    }
    return Object.assign({}, fresh, {
        place: '', note: '', starred: false,
        firstSeen: Date.now(), lastViewed: 0, views: 0, source
    });
}

// ---------------------------------------------------------------------------
// Map data for selection and registry
// ---------------------------------------------------------------------------
function selectionCollection() {
    if (!state.shell) return EMPTY_FC;
    const s = state.shell;
    return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: s.geometry, properties: { h: s.heightM + 0.2, base: s.minHeightM } }]
    };
}

// Basements can't be shown below the map's ground plane in 3D, so only
// floors above ground get a solid highlight here; basements are still fully
// visible (and have their own ULPIN) in the vertical section diagram.
function floorCollection() {
    const u = state.selected;
    if (!u || !state.shell || u.floor < 0) return EMPTY_FC;
    return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: state.shell.geometry, properties: { h: u.elevHi, base: u.elevLo } }]
    };
}

function registryCollection() {
    const seen = new Set();
    const features = [];
    for (const r of DB.all()) {
        if (seen.has(r.buildingId)) continue;
        seen.add(r.buildingId);
        features.push({ type: 'Feature', geometry: r.geometry, properties: {} });
        if (features.length >= 2500) break;
    }
    return { type: 'FeatureCollection', features };
}

function syncMapSelection() {
    const p = map.getSource('selected-parcel');
    const f = map.getSource('selected-floor');
    if (p) p.setData(selectionCollection());
    if (f) f.setData(floorCollection());
}

const syncRegistryLayer = debounce(() => {
    const s = map.getSource('registry-parcels');
    if (s) s.setData(registryCollection());
}, 200);

// ---------------------------------------------------------------------------
// Selection, lookup and navigation
// ---------------------------------------------------------------------------

// Select one specific floor of a building. This is the single path every
// other action (map click, ULPIN lookup, voice, registry, recents) goes
// through, so the ULPIN shown is always the ULPIN of the exact floor chosen.
function selectFloor(shell, f) {
    const fresh = buildFloorRecord(shell, f);
    const existing = DB.get(fresh.ulpin);
    const merged = mergeRecord(fresh, existing, existing ? existing.source : 'click');
    merged.lastViewed = Date.now();
    merged.views = (merged.views || 0) + 1;
    DB.put(merged);

    state.shell = shell;
    state.selected = merged;
    syncMapSelection();
    renderRecord();
    refreshRegistryUI();
    ensurePlace(shell, merged);
    return merged;
}

// Jump to a floor unit already known to the registry (from a lookup match,
// the recent list, or the registry table). Rebuilds the building's envelope
// from the unit itself, so the floor picker works even if only this one
// floor was ever scanned.
function focusUnit(u) {
    return selectFloor(shellFromUnit(u), u.floor);
}

function goTo(u) {
    map.flyTo({ center: [u.lng, u.lat], zoom: Math.max(map.getZoom(), 18), pitch: 60, duration: 1100 });
    return focusUnit(u);
}

function clearSelection() {
    state.shell = null;
    state.selected = null;
    syncMapSelection();
    renderRecord();
    refreshRegistryUI();
}

function setFloor(f) {
    if (!state.shell) return;
    if (!floorList(state.shell).includes(f)) { toast(`This building has no ${floorLabel(f).toLowerCase()}.`); return; }
    selectFloor(state.shell, f);
}

map.on('click', (e) => {
    if (!map.getLayer('buildings-3d')) return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ['buildings-3d'] })[0];
    if (!hit) { clearSelection(); return; }
    selectFloor(buildShell(hit), 1); // default to ground floor; every building has one
});
map.on('mouseenter', 'buildings-3d', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'buildings-3d', () => { map.getCanvas().style.cursor = ''; });

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected && !$('registry-dialog').open) clearSelection();
});

// Index every floor of every building currently visible into the registry.
function scanView() {
    if (!map.getLayer('buildings-3d')) return;
    if (map.getZoom() < 15) { toast('Zoom in to level 15 or closer, then scan.'); return; }

    const feats = map.queryRenderedFeatures({ layers: ['buildings-3d'] });
    const seenBuildings = new Set();
    const batch = [];
    let freshFloors = 0, buildingsScanned = 0;

    for (const f of feats) {
        if (!f.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type)) continue;
        const shell = buildShell(f);
        if (shell.footprintM2 < 25 || seenBuildings.has(shell.buildingId)) continue;
        seenBuildings.add(shell.buildingId);
        buildingsScanned++;

        for (const fl of floorList(shell)) {
            const fresh = buildFloorRecord(shell, fl);
            const existing = DB.get(fresh.ulpin);
            if (!existing) freshFloors++;
            batch.push(mergeRecord(fresh, existing, 'scan'));
            if (batch.length >= MAX_SCAN_FLOORS) break;
        }
        if (batch.length >= MAX_SCAN_FLOORS || buildingsScanned >= MAX_SCAN_BUILDINGS) break;
    }

    if (!batch.length) { toast('No buildings found in this view.'); return; }
    DB.putMany(batch);
    refreshRegistryUI();
    toast(`Indexed ${freshFloors} new floor${freshFloors === 1 ? '' : 's'} across ${buildingsScanned} building${buildingsScanned === 1 ? '' : 's'}. ${DB.count()} floor units total.`);
}

// ---------------------------------------------------------------------------
// Address lookup (Mapbox geocoding) — cached per building so every floor of
// the same building shares one lookup instead of repeating it.
// ---------------------------------------------------------------------------
const placeCache = new Map();

function applyPlace(unit, place) {
    unit.place = place;
    DB.put(unit);
    if (state.selected && state.selected.ulpin === unit.ulpin) $('sp-place').textContent = place;
    refreshRegistryUI();
}

async function ensurePlace(shell, unit) {
    if (placeCache.has(shell.buildingId)) { applyPlace(unit, placeCache.get(shell.buildingId)); return; }
    if (unit.place) { placeCache.set(shell.buildingId, unit.place); return; }

    $('sp-place').textContent = 'Looking up...';
    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${shell.lng},${shell.lat}.json` +
            `?types=address,poi,neighborhood,locality&language=en&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const name = data.features && data.features[0] && data.features[0].place_name;
        if (name) {
            const clean = name.replace(/, India$/, '');
            placeCache.set(shell.buildingId, clean);
            applyPlace(unit, clean);
            return;
        }
    } catch (e) { /* offline or blocked */ }
    if (state.selected && state.selected.ulpin === unit.ulpin) $('sp-place').textContent = 'Address unavailable';
}

async function flyToPlace(query) {
    const c = map.getCenter();
    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
            `?country=in&limit=1&proximity=${c.lng},${c.lat}&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const hit = data.features && data.features[0];
        if (!hit) { toast(`No place found for "${query}".`); return false; }
        geocoder.setInput(hit.place_name.replace(/, India$/, ''));
        map.flyTo({ center: hit.center, zoom: 17, pitch: 60, duration: 1400 });
        toast(`Going to ${hit.text}`);
        return true;
    } catch (e) {
        toast('Place search needs an internet connection.');
        return false;
    }
}

// ---------------------------------------------------------------------------
// ULPIN lookup — a ULPIN now names exactly one floor, so this only ever
// needs to extract digits.
// ---------------------------------------------------------------------------
const NUM_WORDS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

// "zero nine double one" -> "09 11"
function wordsToDigits(text) {
    const parts = text.toLowerCase().replace(/[,.\-]/g, ' ').split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const w = parts[i];
        if ((w === 'double' || w === 'triple') && i + 1 < parts.length) {
            const nx = parts[i + 1];
            const d = /^\d$/.test(nx) ? nx : (nx in NUM_WORDS ? String(NUM_WORDS[nx]) : null);
            if (d !== null) { out.push(d.repeat(w === 'double' ? 2 : 3)); i++; continue; }
        }
        out.push(w in NUM_WORDS ? String(NUM_WORDS[w]) : w);
    }
    return out.join(' ');
}

function parseLookup(raw) {
    const digits = (wordsToDigits(raw).match(/\d/g) || []).join('').slice(0, 14);
    return { digits };
}

function showLookupMsg(text, kind = 'info', withScan = false) {
    const el = $('lookup-msg');
    el.textContent = text;
    el.className = 'lookup-msg' + (kind === 'error' ? ' error' : '');
    el.hidden = !text;
    if (withScan) {
        el.append(' ');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link';
        b.textContent = 'Scan this view';
        b.addEventListener('click', scanView);
        el.appendChild(b);
    }
}

function renderMatchList(ul, recs, onPick) {
    ul.innerHTML = '';
    recs.forEach((r) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        if (state.selected && state.selected.ulpin === r.ulpin) btn.setAttribute('aria-current', 'true');
        btn.innerHTML = '<span class="r-id"></span><span class="r-meta"></span>';
        btn.querySelector('.r-id').textContent = formatUlpin(r.ulpin);
        btn.querySelector('.r-meta').textContent = `${floorLabel(r.floor)} \u2022 ${r.use}`;
        btn.addEventListener('click', () => onPick(r));
        li.appendChild(btn);
        ul.appendChild(li);
    });
}

function lookup(raw) {
    const list = $('lookup-matches');
    list.hidden = true;
    const { digits } = parseLookup(raw);

    if (digits.length < 3) {
        showLookupMsg('Enter a 14-digit ULPIN, or at least 3 digits to search the registry.', 'error');
        return false;
    }

    if (digits.length === 14) {
        const rec = DB.get(digits);
        if (!rec) {
            showLookupMsg(`ULPIN ${formatUlpin(digits)} is not in the registry yet. Fly to the area and`, 'error', true);
            return false;
        }
        goTo(rec);
        showLookupMsg(`Found ${floorLabel(rec.floor).toLowerCase()} \u2014 ULPIN ${formatUlpin(digits)}.`);
        return true;
    }

    const matches = DB.all().filter((r) => r.ulpin.includes(digits)).slice(0, 6);
    if (!matches.length) {
        showLookupMsg(`No registry entries contain ${digits}.`, 'error', true);
        return false;
    }
    showLookupMsg(`${matches.length} match${matches.length === 1 ? '' : 'es'} for ${digits}. Pick one:`);
    renderMatchList(list, matches, (r) => { goTo(r); list.hidden = true; showLookupMsg(''); });
    list.hidden = false;
    return true;
}

$('lookup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    lookup($('lookup-input').value);
});

// ---------------------------------------------------------------------------
// Inspector rendering
// ---------------------------------------------------------------------------
function renderStrip(shell, unit) {
    const svg = $('strip');
    const x0 = 78, barW = 120, top = 18;
    const defs = `<defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#dfe8e5"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="#10303a" stroke-width="2"/>
        </pattern></defs>`;

    if (!shell) {
        const bh = 20, ground = top + 5 * bh;
        let s = defs;
        for (let i = 0; i < 5; i++) s += `<rect class="ghost" x="${x0}" y="${ground - (i + 1) * bh + 2}" width="${barW}" height="${bh - 4}" rx="1"/>`;
        s += `<rect class="ghost" x="${x0}" y="${ground + 2}" width="${barW}" height="${bh - 4}" rx="1"/>`;
        s += `<line class="ground" x1="${x0 - 36}" y1="${ground}" x2="${x0 + barW + 36}" y2="${ground}"/>`;
        svg.innerHTML = s;
        svg.setAttribute('aria-label', 'No building selected');
        return;
    }

    const a = shell.floorsAbove, b = shell.floorsBelow, total = a + b;
    const bh = Math.max(2.2, Math.min(18, 190 / total));
    const gap = bh >= 8 ? 1.6 : 0.5;
    const ground = top + a * bh;
    const sel = unit ? unit.floor : null;
    let s = defs;
    let selY = null;

    for (let i = 0; i < a; i++) {
        const y = ground - (i + 1) * bh;
        const isSel = sel === i + 1;
        if (isSel) selY = y + (bh - gap) / 2 + 4;
        s += `<rect class="floor${i % 2 ? ' alt' : ''}${isSel ? ' sel' : ''}" x="${x0}" y="${y.toFixed(2)}" width="${barW}" height="${(bh - gap).toFixed(2)}"/>`;
    }
    for (let i = 0; i < b; i++) {
        const y = ground + i * bh + gap;
        const isSel = sel === -(i + 1);
        if (isSel) selY = y + (bh - gap) / 2 + 4;
        s += `<rect class="basement${isSel ? ' sel' : ''}" x="${x0}" y="${y.toFixed(2)}" width="${barW}" height="${(bh - gap).toFixed(2)}" fill="url(#hatch)"/>`;
    }
    s += `<line class="ground" x1="${x0 - 36}" y1="${ground.toFixed(2)}" x2="${x0 + barW + 36}" y2="${ground.toFixed(2)}"/>`;

    const rx = x0 + barW + 10;
    const near = (y) => selY !== null && Math.abs(selY - y) < 12;
    const yTop = top + 8, yGround = ground - 5, yDepth = ground + b * bh - 2;
    if (!near(yTop)) s += `<text class="strong" x="${rx}" y="${yTop}">+${nf1.format(shell.heightM)} m</text>`;
    if (!near(yGround)) s += `<text x="${rx}" y="${yGround.toFixed(2)}">Ground</text>`;
    if (b && !near(yDepth)) s += `<text class="strong" x="${rx}" y="${yDepth.toFixed(2)}">-${shell.depthM} m</text>`;
    if (selY !== null) s += `<text class="strong" x="${rx}" y="${selY.toFixed(2)}">${floorLabel(sel)}</text>`;
    s += `<text text-anchor="end" x="${x0 - 10}" y="${top + 8}">${a} floor${a > 1 ? 's' : ''}</text>`;
    if (b) s += `<text text-anchor="end" x="${x0 - 10}" y="${yDepth.toFixed(2)}">${b} basement${b > 1 ? 's' : ''}</text>`;

    svg.innerHTML = s;
    svg.setAttribute('aria-label',
        `Section of selected building: ${a} floors above ground, ${b} below, ${nf1.format(shell.heightM)} metres tall.` +
        (sel !== null ? ` ${floorLabel(sel)} highlighted, each floor has its own ULPIN.` : ''));
}

function renderFloorSelect(shell) {
    const sel = $('floor-select');
    sel.innerHTML = '';
    floorList(shell).slice().reverse().forEach((f) => sel.add(new Option(floorLabel(f), String(f))));
}

function renderRecord() {
    const shell = state.shell, unit = state.selected;
    const ulpinEl = $('ulpin-display');
    const pill = $('status-pill');

    renderStrip(shell, unit);
    $('record-details').hidden = !unit;
    $('empty-hint').hidden = !!unit;
    $('copy-ulpin').hidden = !unit;
    pill.hidden = !unit;
    renderRecent();

    if (!unit) {
        ulpinEl.textContent = 'Not assigned';
        ulpinEl.classList.add('is-empty');
        return;
    }

    ulpinEl.textContent = formatUlpin(unit.ulpin);
    ulpinEl.classList.remove('is-empty');
    ulpinEl.classList.add('flash');
    requestAnimationFrame(() => requestAnimationFrame(() => ulpinEl.classList.remove('flash')));

    pill.className = `pill ${unit.status}`;
    pill.textContent = STATUS_TEXT[unit.status];

    renderFloorSelect(shell);
    $('floor-select').value = String(unit.floor);

    $('fl-use').textContent = unit.use;
    $('fl-elev').textContent = unit.floor > 0
        ? `${nf1.format(unit.elevLo)} to ${nf1.format(unit.elevHi)} m above ground`
        : `${nf1.format(unit.elevLo)} to ${nf1.format(unit.elevHi)} m below ground`;
    $('fl-area').textContent = `${nf(unit.floorAreaM2)} m\u00B2`;
    $('fl-units').textContent = unit.unitsEst ? `${unit.unitsEst} approx.` : 'Not applicable';
    $('sp-owner').textContent = unit.owner;

    $('sp-place').textContent = placeCache.get(shell.buildingId) || unit.place || '-';
    $('sp-floors').textContent = `${shell.floorsAbove} above, ${shell.floorsBelow} below`;
    $('sp-height').textContent = `${nf1.format(shell.heightM)} m`;
    $('sp-footprint').textContent = `${nf.format(shell.footprintM2)} m\u00B2`;
    $('sp-volume').textContent = `${nf.format(shell.volumeM3)} m\u00B3`;

    const sign = unit.floor > 0 ? '+' : '-';
    $('coord-display').innerHTML =
        `X: ${shell.lng.toFixed(5)}<br>Y: ${shell.lat.toFixed(5)}<br>` +
        `Z: ${sign}${nf1.format(unit.elevLo)} to ${sign}${nf1.format(unit.elevHi)} m (this floor)`;

    $('note-input').value = unit.note || '';
    const star = $('star-btn');
    star.setAttribute('aria-pressed', String(!!unit.starred));
    star.textContent = unit.starred ? 'Starred' : 'Star';
}

function renderRecent() {
    const recent = DB.all().filter((r) => r.lastViewed > 0).sort((a, b) => b.lastViewed - a.lastViewed).slice(0, 5);
    $('recent-wrap').hidden = recent.length === 0;
    renderMatchList($('recent-list'), recent, (r) => goTo(r));
}

// Floor controls -----------------------------------------------------------
$('floor-select').addEventListener('change', (e) => setFloor(parseInt(e.target.value, 10)));

function stepFloor(dir) {
    if (!state.shell || !state.selected) return;
    const list = floorList(state.shell); // bottom to top
    const i = list.indexOf(state.selected.floor) + dir;
    if (i >= 0 && i < list.length) selectFloor(state.shell, list[i]);
}
$('floor-up').addEventListener('click', () => stepFloor(1));
$('floor-down').addEventListener('click', () => stepFloor(-1));

// Note, star, copy ---------------------------------------------------------
const saveNote = debounce(() => {
    if (!state.selected) return;
    state.selected.note = $('note-input').value;
    DB.put(state.selected);
    refreshRegistryUI();
}, 400);
$('note-input').addEventListener('input', saveNote);

$('star-btn').addEventListener('click', () => {
    const u = state.selected;
    if (!u) return;
    u.starred = !u.starred;
    DB.put(u);
    $('star-btn').setAttribute('aria-pressed', String(u.starred));
    $('star-btn').textContent = u.starred ? 'Starred' : 'Star';
    refreshRegistryUI();
});

async function copyText(text, btn, doneLabel) {
    const original = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = doneLabel; }
    catch (err) { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = original; }, 1400);
}

function exportShape(u) {
    return {
        ulpin: u.ulpin,
        floor: u.floor,
        floorLabel: floorLabel(u.floor),
        use: u.use,
        elevationM: { from: u.elevLo, to: u.elevHi },
        floorAreaM2: Math.round(u.floorAreaM2),
        unitsEstimate: u.unitsEst || null,
        registryStatus: STATUS_TEXT[u.status],
        registeredTo: u.owner,
        place: u.place || placeCache.get(u.buildingId) || null,
        building: {
            id: u.buildingId,
            centroid: { x: +u.lng.toFixed(5), y: +u.lat.toFixed(5) },
            floorsAbove: u.floorsAboveTotal,
            floorsBelow: u.floorsBelowTotal,
            heightM: u.buildingHeightM,
            depthM: u.buildingDepthM,
            footprintM2: Math.round(u.buildingFootprintM2),
            volumeM3: Math.round(u.buildingVolumeM3)
        },
        note: u.note || '',
        note_: 'Simulated demo record'
    };
}

$('copy-ulpin').addEventListener('click', (e) => { if (state.selected) copyText(state.selected.ulpin, e.currentTarget, 'Copied'); });
$('copy-record').addEventListener('click', (e) => {
    if (state.selected) copyText(JSON.stringify(exportShape(state.selected), null, 2), e.currentTarget, 'Copied');
});
$('clear-btn').addEventListener('click', clearSelection);

// Map style switcher -------------------------------------------------------
document.querySelectorAll('.style-switch button').forEach((btn) => {
    btn.addEventListener('click', () => setMapStyle(btn.dataset.style));
});

function setMapStyle(key) {
    if (!STYLES[key] || key === state.styleKey) return;
    state.styleKey = key;
    document.querySelectorAll('.style-switch button').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.style === key)));
    map.setStyle(STYLES[key].url); // style.load re-adds our layers
}

$('scan-btn').addEventListener('click', scanView);

// ---------------------------------------------------------------------------
// Registry dialog
// ---------------------------------------------------------------------------
const dlg = $('registry-dialog');

function refreshRegistryUI() {
    $('registry-count').textContent = String(DB.count());
    syncRegistryLayer();
    renderRecent();
    if (dlg.open) renderRegistryTable();
}

function renderRegistryTable() {
    const q = $('registry-filter').value.trim().toLowerCase();
    const starredOnly = $('registry-starred').checked;
    const all = DB.all();
    let rows = all.filter((r) => {
        if (starredOnly && !r.starred) return false;
        if (!q) return true;
        return r.ulpin.includes(q.replace(/\s+/g, '')) || (r.place || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q);
    });
    rows.sort((a, b) => (b.lastViewed || 0) - (a.lastViewed || 0) || (b.firstSeen || 0) - (a.firstSeen || 0));
    const shown = rows.slice(0, 300);

    $('registry-meta').textContent =
        `${all.length} floor unit${all.length === 1 ? '' : 's'} stored ${DB.persistent() ? 'on this device' : 'for this session only (browser storage unavailable)'}` +
        (rows.length > shown.length ? `. Showing the latest ${shown.length} of ${rows.length} matches.` : '.');

    const body = $('registry-body');
    body.innerHTML = '';
    const empty = $('registry-empty');
    empty.hidden = shown.length > 0;
    if (!shown.length) {
        empty.textContent = all.length
            ? 'No floor units match this filter.'
            : 'The registry is empty. Click a building, or use Scan this view to index every floor on screen.';
    }

    shown.forEach((r) => {
        const tr = document.createElement('tr');
        tr.dataset.ulpin = r.ulpin;
        const viewed = r.lastViewed ? new Date(r.lastViewed).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not yet';
        tr.innerHTML =
            '<td class="c-ulpin"></td><td class="c-floor"></td><td class="c-place"></td>' +
            '<td><span class="pill sm"></span></td><td class="c-num c-viewed"></td>' +
            '<td class="c-act"><button class="btn-quiet" data-act="locate" type="button">Locate</button>' +
            '<button class="btn-quiet" data-act="star" type="button"></button>' +
            '<button class="btn-quiet danger" data-act="delete" type="button">Delete</button></td>';
        tr.querySelector('.c-ulpin').textContent = formatUlpin(r.ulpin);
        tr.querySelector('.c-floor').textContent = floorLabel(r.floor);
        tr.querySelector('.c-floor').title = r.use;
        tr.querySelector('.c-place').textContent = r.place || '-';
        tr.querySelector('.c-place').title = r.note ? `${r.place || ''}\nNote: ${r.note}` : (r.place || '');
        const pill = tr.querySelector('.pill');
        pill.classList.add(r.status);
        pill.textContent = STATUS_TEXT[r.status];
        tr.querySelector('.c-viewed').textContent = viewed;
        const star = tr.querySelector('[data-act="star"]');
        star.textContent = r.starred ? 'Starred' : 'Star';
        star.setAttribute('aria-pressed', String(!!r.starred));
        body.appendChild(tr);
    });
}

$('open-registry').addEventListener('click', () => { renderRegistryTable(); dlg.showModal(); });
$('registry-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
$('registry-filter').addEventListener('input', renderRegistryTable);
$('registry-starred').addEventListener('change', renderRegistryTable);

$('registry-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const ulpin = btn.closest('tr').dataset.ulpin;
    const rec = DB.get(ulpin);
    if (!rec) return;
    if (btn.dataset.act === 'locate') { dlg.close(); goTo(rec); }
    if (btn.dataset.act === 'star') { rec.starred = !rec.starred; DB.put(rec); refreshRegistryUI(); if (state.selected && state.selected.ulpin === ulpin) renderRecord(); }
    if (btn.dataset.act === 'delete') {
        DB.del(ulpin);
        if (state.selected && state.selected.ulpin === ulpin) clearSelection();
        refreshRegistryUI();
    }
});

function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('export-json').addEventListener('click', () => {
    const payload = { app: 'GeoLayer 3D', model: 'per-floor', exportedAt: new Date().toISOString(), units: DB.all() };
    download('geolayer-registry.json', JSON.stringify(payload), 'application/json');
});

$('export-csv').addEventListener('click', () => {
    const cols = [
        'ulpin', 'buildingId', 'floor', 'use', 'place', 'lng', 'lat', 'elevLo', 'elevHi',
        'floorAreaM2', 'unitsEst', 'floorsAboveTotal', 'floorsBelowTotal', 'buildingHeightM',
        'buildingDepthM', 'buildingFootprintM2', 'status', 'owner', 'note', 'starred', 'views', 'firstSeen'
    ];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')];
    DB.all().forEach((r) => lines.push(cols.map((c) => {
        if (c === 'status') return esc(STATUS_TEXT[r.status]);
        if (c === 'firstSeen') return esc(r.firstSeen ? new Date(r.firstSeen).toISOString() : '');
        if (c === 'floorAreaM2' || c === 'buildingFootprintM2') return esc(Math.round(r[c]));
        return esc(r[c]);
    }).join(',')));
    download('geolayer-registry.csv', lines.join('\n'), 'text/csv');
});

$('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        const list = Array.isArray(data) ? data : data.units;
        if (!Array.isArray(list)) throw new Error('bad shape');
        const ok = list.filter((r) => r && /^\d{14}$/.test(String(r.ulpin)) && Number.isInteger(r.floor) &&
            r.geometry && r.geometry.coordinates && r.buildingId &&
            Number.isFinite(r.lng) && Number.isFinite(r.lat) && Number.isFinite(r.buildingHeightM));
        const fill = ok.map((r) => mergeRecord(r, DB.get(r.ulpin) || r, 'import'));
        DB.putMany(fill);
        refreshRegistryUI();
        toast(`Imported ${fill.length} floor unit${fill.length === 1 ? '' : 's'}${list.length > ok.length ? `, skipped ${list.length - ok.length} invalid` : ''}.`);
    } catch (err) {
        toast('That file is not a valid GeoLayer registry export.');
    }
});

$('registry-clear').addEventListener('click', () => {
    if (!DB.count()) return;
    if (window.confirm(`Delete all ${DB.count()} floor units from this device? Export first if you need a backup.`)) {
        DB.clear();
        clearSelection();
        refreshRegistryUI();
    }
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

// ---------------------------------------------------------------------------
// Voice input (Web Speech API) + spoken replies
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { rec: null, active: false, ctx: null, btn: null, final: '', error: '' };

const VOICE_HINT = {
    global: 'Say a place, a ULPIN, "floor 5", or "scan"',
    lookup: 'Say the 14-digit ULPIN of the floor',
    assistant: 'Ask about this property'
};

function setListening(on, btn) {
    document.querySelectorAll('.mic').forEach((b) => b.classList.remove('listening'));
    if (on && btn) btn.classList.add('listening');
    const bar = $('voice-status');
    bar.hidden = !on;
    if (on) $('voice-text').textContent = VOICE_HINT[voice.ctx] || 'Listening';
}

function startVoice(ctx, btn) {
    if (!SR) {
        toast('Voice input works in Chrome, Edge and Safari over HTTPS or localhost.');
        return;
    }
    if (voice.active) { voice.rec.stop(); return; }

    const rec = new SR();
    rec.lang = state.voiceLang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    voice.rec = rec; voice.ctx = ctx; voice.btn = btn; voice.final = ''; voice.error = '';

    rec.onstart = () => { voice.active = true; setListening(true, btn); };
    rec.onresult = (e) => {
        let interim = '', fin = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) fin += t; else interim += t;
        }
        if (fin) voice.final = fin;
        $('voice-text').textContent = fin || interim || VOICE_HINT[ctx];
    };
    rec.onerror = (e) => { voice.error = e.error; };
    rec.onend = () => {
        voice.active = false;
        setListening(false);
        const heard = voice.final.trim();
        if (heard) routeVoice(voice.ctx, heard);
        else if (voice.error === 'not-allowed' || voice.error === 'service-not-allowed') toast('Microphone is blocked. Allow microphone access for this site and try again.');
        else if (voice.error === 'no-speech' || !voice.error) toast('Did not catch that. Tap the mic and try again.');
        else if (voice.error === 'network') toast('Voice recognition needs an internet connection.');
        else toast('Voice input stopped.');
    };

    try { rec.start(); } catch (err) { toast('Could not start the microphone.'); }
}

function routeVoice(ctx, text) {
    if (ctx === 'lookup') { $('lookup-input').value = text; lookup(text); return; }
    if (ctx === 'assistant') { ask(text); return; }
    handleCommand(text);
}

// Global voice commands: ULPINs, floors, styles, registry, or a place name.
function handleCommand(text) {
    const t = text.toLowerCase().trim();
    const spoken = wordsToDigits(t);
    const digitCount = (spoken.match(/\d/g) || []).length;

    const fm = spoken.match(/\b(?:floor|level)\s*(\d{1,2})\b/);
    const bm = spoken.match(/\bbasement\s*(\d{1,2})\b/);
    if (fm || bm) {
        if (!state.shell) { toast('Select a building first, then name a floor.'); return; }
        const f = bm ? -parseInt(bm[1], 10) : parseInt(fm[1], 10);
        if (!floorList(state.shell).includes(f)) { toast(`This building has no ${floorLabel(f).toLowerCase()}.`); return; }
        const u = selectFloor(state.shell, f);
        toast(`${floorLabel(f)} ULPIN: ${formatUlpin(u.ulpin)}`);
        return;
    }

    if (/\bulpin\b/.test(t) || digitCount >= 8) {
        $('lookup-input').value = spoken.replace(/\bulpin\b/g, '').trim();
        lookup(spoken);
        return;
    }

    if (/\b(clear|reset|deselect)\b/.test(t)) { clearSelection(); return; }
    if (/\bscan\b/.test(t)) { scanView(); return; }
    if (/\b(registry|database|saved parcels|saved floors)\b/.test(t)) { $('open-registry').click(); return; }
    if (/\bsatellite\b/.test(t)) { setMapStyle('satellite'); return; }
    if (/\bdark\b/.test(t)) { setMapStyle('dark'); return; }
    if (/\blight\b/.test(t)) { setMapStyle('light'); return; }

    const place = t.replace(/^(?:please\s+)?(?:go to|take me to|show me|show|find|search for|search|navigate to|open|fly to)\s+/, '');
    flyToPlace(place || t);
}

$('mic-global').addEventListener('click', (e) => startVoice('global', e.currentTarget));
$('mic-lookup').addEventListener('click', (e) => startVoice('lookup', e.currentTarget));
$('mic-assistant').addEventListener('click', (e) => startVoice('assistant', e.currentTarget));

function renderVoiceLang() {
    const hi = state.voiceLang === 'hi-IN';
    const b = $('voice-lang');
    b.textContent = hi ? '\u0939\u093F' : 'EN';
    b.setAttribute('aria-label', `Voice language: ${hi ? 'Hindi' : 'English'}`);
}
$('voice-lang').addEventListener('click', () => {
    state.voiceLang = state.voiceLang === 'hi-IN' ? 'en-IN' : 'hi-IN';
    lsSet('gl.voiceLang', state.voiceLang);
    renderVoiceLang();
    toast(state.voiceLang === 'hi-IN' ? 'Voice language: Hindi' : 'Voice language: English');
});

function speak(text) {
    if (!state.readAloud || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    window.speechSynthesis.speak(u);
}

$('speak-toggle').addEventListener('click', (e) => {
    state.readAloud = !state.readAloud;
    lsSet('gl.readAloud', state.readAloud ? '1' : '0');
    e.currentTarget.setAttribute('aria-pressed', String(state.readAloud));
    if (!state.readAloud && 'speechSynthesis' in window) window.speechSynthesis.cancel();
});

// ---------------------------------------------------------------------------
// Land records assistant
// ---------------------------------------------------------------------------
const chatHistory = $('chat-history');
const aiInput = $('ai-input');

function appendMessage(kind, text) {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    return div;
}

function answer(question, unit) {
    const q = wordsToDigits(question);
    const id = formatUlpin(unit.ulpin);
    const has = (...words) => words.some((w) => q.includes(w));

    const fm = q.match(/\b(?:floor|level)\s*(\d{1,2})\b/);
    const bm = q.match(/\bbasement\s*(\d{1,2})\b/);
    if (fm || bm) {
        const f = bm ? -parseInt(bm[1], 10) : parseInt(fm[1], 10);
        if (!floorList(state.shell).includes(f)) {
            return `This building has no ${floorLabel(f).toLowerCase()}. It has ${state.shell.floorsAbove} floors above ground and ${state.shell.floorsBelow} basement level${state.shell.floorsBelow === 1 ? '' : 's'}.`;
        }
        const u = selectFloor(state.shell, f);
        return `${floorLabel(f)} has its own ULPIN: ${formatUlpin(u.ulpin)}. It is ${u.use.toLowerCase()}, about ${nf(u.floorAreaM2)} m\u00B2` +
            (u.unitsEst ? `, roughly ${u.unitsEst} unit${u.unitsEst === 1 ? '' : 's'}` : '') +
            `. Now highlighted on the map.`;
    }

    if (has('registry', 'database', 'indexed', 'how many')) {
        return `The registry holds ${DB.count()} floor unit${DB.count() === 1 ? '' : 's'}, stored on this device. Open Registry in the top bar to search, export or import them.`;
    }
    if (has('owner', 'name', 'registered', 'belong')) {
        return `Registry record for ULPIN ${id} (${floorLabel(unit.floor).toLowerCase()}): registered to ${unit.owner}. ${unit.status === 'bad' ? 'Status: under review.' : 'Status: cleared.'}`;
    }
    if (has('tax', 'due', 'payment')) {
        return unit.status === 'bad'
            ? `Financial audit for ULPIN ${id}: property tax is up to date, but a dispute flag is holding mutation of this floor's record.`
            : `Financial audit for ULPIN ${id}: property tax assessment is up to date. No pending dues for the current fiscal year.`;
    }
    if (has('dispute', 'court', 'litigation', 'legal', 'case')) {
        return unit.status === 'bad'
            ? `Legal check for ULPIN ${id}: a dispute is flagged on ${floorLabel(unit.floor).toLowerCase()}. Physical verification is needed before the title can be authenticated.`
            : `Legal check for ULPIN ${id}: no litigation flags or encumbrances found in district court records.`;
    }
    if (has('where', 'place', 'address', 'locality', 'location', 'coordinate')) {
        const place = placeCache.get(unit.buildingId) || unit.place;
        return `ULPIN ${id} is ${place ? `at ${place}, ` : ''}centred at X ${unit.lng.toFixed(5)}, Y ${unit.lat.toFixed(5)}.`;
    }
    if (has('floor', 'storey', 'story', 'height', 'tall', 'basement', 'level')) {
        const base = state.shell.floorsBelow ? ` and ${state.shell.floorsBelow} basement level${state.shell.floorsBelow > 1 ? 's' : ''}` : ' and no basements';
        return `This building has ${state.shell.floorsAbove} floor${state.shell.floorsAbove > 1 ? 's' : ''} above ground${base} \u2014 every one of them has its own ULPIN. You're viewing ${floorLabel(unit.floor).toLowerCase()} (${id}). Ask for another, for example "floor 3" or "basement 1".`;
    }
    if (has('area', 'size', 'volume', 'footprint', 'big')) {
        return `${floorLabel(unit.floor)} (ULPIN ${id}): floor area is about ${nf(unit.floorAreaM2)} m\u00B2. The whole building's footprint is about ${nf(unit.buildingFootprintM2)} m\u00B2.`;
    }
    if (has('ulpin', 'id', 'number')) {
        return `This floor's 14-digit ULPIN is ${id}. The first two digits (${STATE_CODE}) are the state code for Uttar Pradesh. Every other floor of this building has its own separate ULPIN.`;
    }

    const lead = `Property analysis [${id}], ${floorLabel(unit.floor).toLowerCase()}: ${unit.use.toLowerCase()}, floor area about ${nf(unit.floorAreaM2)} m\u00B2. `;
    if (unit.status === 'ok') return lead + 'Title deed is fully authenticated under DILRMP guidelines.';
    if (unit.status === 'warn') return lead + `Status is pending: physical verification of this floor is awaited for the DILRMP registry.`;
    return lead + `Alert: title deed is not authenticated under DILRMP guidelines. A dispute is flagged on this floor.`;
}

function ask(question) {
    const text = question.trim();
    if (!text) return;
    appendMessage('user', text);
    aiInput.value = '';

    // A spoken or typed ULPIN goes straight to lookup.
    const parsed = parseLookup(text);
    if (parsed.digits.length === 14) {
        const found = lookup(text);
        appendMessage('ai', found
            ? `Located ULPIN ${formatUlpin(parsed.digits)} on the map.`
            : `ULPIN ${formatUlpin(parsed.digits)} is not in the registry yet. Scan the area where the building stands, or import a registry file.`);
        return;
    }

    const wait = appendMessage('wait', 'Checking the land registry...');
    setTimeout(() => {
        wait.remove();
        const reply = state.selected
            ? answer(text, state.selected)
            : 'Click a building on the 3D map first, or give me a ULPIN, then I can read out its floor details.';
        appendMessage('ai', reply);
        speak(reply);
    }, 450);
}

$('ai-form').addEventListener('submit', (e) => { e.preventDefault(); ask(aiInput.value); });
$('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('button[data-q]');
    if (chip) ask(chip.dataset.q);
});

const assistantToggle = $('assistant-toggle');
const assistantBody = $('assistant-body');
function setAssistantOpen(open) {
    assistantToggle.setAttribute('aria-expanded', String(open));
    assistantBody.hidden = !open;
}
assistantToggle.addEventListener('click', () =>
    setAssistantOpen(assistantToggle.getAttribute('aria-expanded') !== 'true'));
setAssistantOpen(window.matchMedia('(min-width: 861px)').matches);

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------
renderVoiceLang();
$('speak-toggle').setAttribute('aria-pressed', String(state.readAloud));
if (!SR) {
    document.querySelectorAll('.mic').forEach((b) => { b.title = 'Voice input is not supported in this browser'; });
}
renderRecord();
DB.load().then(() => { refreshRegistryUI(); });