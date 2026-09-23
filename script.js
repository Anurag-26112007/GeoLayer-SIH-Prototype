// ---------------------------------------------------------------------------
// GeoLayer 3D - ULPIN generator
// NOTE: This token is visible to anyone who opens the site. In your Mapbox
// account, restrict it to your deployed URL(s) so it cannot be reused elsewhere.
// ---------------------------------------------------------------------------
mapboxgl.accessToken = 'pk.eyJ1IjoiZXJpY25pbmciLCJhIjoiY21icXlubWM1MDRiczJvb2xwM2p0amNyayJ9.n-3O6JI5nOp_Lw96ZO5vJQ';

// ---------------------------------------------------------------------------
// Backend (Supabase). Fill these in from your project's Settings -> API page,
// then run schema.sql once in the Supabase SQL editor.
// Leave them blank to run the app in offline/local-only mode (IndexedDB only,
// nothing shared between devices).
// ---------------------------------------------------------------------------
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';

const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const STATE_CODE = '09'; // Uttar Pradesh
const FLOOR_HEIGHT_M = 3;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const MAX_SCAN = 500;

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
    selected: null,   // current parcel record
    floor: null,      // null = whole building, 1..n above ground, -1..-n basements
    voiceLang: lsGet('gl.voiceLang', 'en-IN'),
    readAloud: lsGet('gl.readAloud', '0') === '1'
};

// ---------------------------------------------------------------------------
// Database: Supabase (shared, cross-device) with an IndexedDB cache
// (instant paint on load, and a fallback when there is no backend or no
// network). Everything else in the app only ever talks to the DB object
// below, so it doesn't need to know which backend is actually in use.
// ---------------------------------------------------------------------------
function toRow(r) {
    return {
        ulpin: r.ulpin, lng: r.lng, lat: r.lat,
        height_m: r.heightM, min_height_m: r.minHeightM, depth_m: r.depthM,
        floors_above: r.floorsAbove, floors_below: r.floorsBelow,
        footprint_m2: r.footprintM2, volume_m3: r.volumeM3,
        status: r.status, owner: r.owner, place: r.place || null, note: r.note || null,
        starred: !!r.starred, first_seen: r.firstSeen, last_viewed: r.lastViewed || null,
        views: r.views || 0, source: r.source || null, geometry: r.geometry
    };
}

function fromRow(row) {
    return {
        v: 1, ulpin: row.ulpin, lng: row.lng, lat: row.lat,
        heightM: row.height_m, minHeightM: row.min_height_m, depthM: row.depth_m,
        floorsAbove: row.floors_above, floorsBelow: row.floors_below,
        footprintM2: row.footprint_m2, volumeM3: row.volume_m3,
        status: row.status, owner: row.owner, place: row.place || '', note: row.note || '',
        starred: !!row.starred, firstSeen: row.first_seen, lastViewed: row.last_viewed || 0,
        views: row.views || 0, source: row.source || 'sync', geometry: row.geometry
    };
}

const Cache = (() => {
    let db = null;
    function open() {
        return new Promise((resolve) => {
            try {
                const req = indexedDB.open('geolayer3d', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('parcels', { keyPath: 'ulpin' });
                req.onsuccess = () => { db = req.result; resolve(true); };
                req.onerror = () => resolve(false);
                req.onblocked = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }
    function write(fn) { if (db) { try { fn(db.transaction('parcels', 'readwrite').objectStore('parcels')); } catch (e) { /* ignore */ } } }
    return {
        ready: () => !!db,
        open,
        async all() {
            if (!db) return [];
            return new Promise((resolve) => {
                try {
                    const rq = db.transaction('parcels').objectStore('parcels').getAll();
                    rq.onsuccess = () => resolve(rq.result || []);
                    rq.onerror = () => resolve([]);
                } catch (e) { resolve([]); }
            });
        },
        put(rec) { write((s) => s.put(rec)); },
        putMany(recs) { write((s) => recs.forEach((r) => s.put(r))); },
        del(u) { write((s) => s.delete(u)); },
        clear() { write((s) => s.clear()); }
    };
})();

const DB = (() => {
    const mem = new Map();
    let backend = 'local';   // 'cloud' once a Supabase load has succeeded at least once
    let pending = 0;
    let onChange = () => {};

    async function pullFromCloud() {
        if (!supabase) return false;
        try {
            const { data, error } = await supabase.from('parcels').select('*').order('last_viewed', { ascending: false }).limit(5000);
            if (error) throw error;
            mem.clear();
            data.forEach((row) => mem.set(row.ulpin, fromRow(row)));
            Cache.putMany(data.map(fromRow));
            backend = 'cloud';
            return true;
        } catch (e) {
            return false;
        }
    }

    async function load() {
        await Cache.open();
        const cached = await Cache.all();
        cached.forEach((r) => mem.set(r.ulpin, r));   // instant paint, even before the network answers
        const gotCloud = await pullFromCloud();
        if (!gotCloud && !supabase) backend = 'local';
        if (!gotCloud && supabase) backend = 'offline'; // configured, but unreachable right now
        onChange();
    }

    function trackWrite(promise) {
        pending++;
        onChange();
        promise.finally(() => { pending = Math.max(0, pending - 1); onChange(); });
    }

    return {
        load,
        onSync(fn) { onChange = fn; },
        mode: () => backend,          // 'cloud' | 'local' | 'offline'
        pendingWrites: () => pending,
        get: (u) => mem.get(u),
        all: () => Array.from(mem.values()),
        count: () => mem.size,

        put(rec) {
            mem.set(rec.ulpin, rec);
            Cache.put(rec);
            if (supabase) trackWrite(supabase.from('parcels').upsert(toRow(rec)).then(({ error }) => { if (error) backend = 'offline'; }));
        },
        putMany(recs) {
            recs.forEach((r) => mem.set(r.ulpin, r));
            Cache.putMany(recs);
            if (supabase && recs.length) {
                const chunks = [];
                for (let i = 0; i < recs.length; i += 200) chunks.push(recs.slice(i, i + 200));
                chunks.forEach((c) => trackWrite(supabase.from('parcels').upsert(c.map(toRow)).then(({ error }) => { if (error) backend = 'offline'; })));
            }
        },
        del(u) {
            mem.delete(u);
            Cache.del(u);
            if (supabase) trackWrite(supabase.from('parcels').delete().eq('ulpin', u).then(({ error }) => { if (error) backend = 'offline'; }));
        },
        clear() {
            const ids = Array.from(mem.keys());
            mem.clear();
            Cache.clear();
            if (supabase && ids.length) trackWrite(supabase.from('parcels').delete().in('ulpin', ids).then(({ error }) => { if (error) backend = 'offline'; }));
        },

        // Merge a row that arrived over realtime from someone else's tab.
        applyRemote(row) { mem.set(row.ulpin, fromRow(row)); Cache.put(fromRow(row)); },
        removeRemote(ulpin) { mem.delete(ulpin); Cache.del(ulpin); }
    };
})();

// Live updates: when someone else scans or edits a parcel, reflect it here
// without a manual refresh.
if (supabase) {
    supabase
        .channel('parcels-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, (payload) => {
            if (payload.eventType === 'DELETE') DB.removeRemote(payload.old.ulpin);
            else DB.applyRemote(payload.new);
            refreshRegistryUI();
            if (state.selected && payload.new && payload.new.ulpin === state.selected.ulpin && payload.eventType === 'UPDATE') {
                state.selected = fromRow(payload.new);
                renderRecord();
            }
        })
        .subscribe();
}

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

    // Parcels already in the registry get a thin teal outline on the ground.
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

    // The selected parcel and floor live in their own GeoJSON sources, so
    // highlighting works even when Mapbox building features have no id.
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
                'fill-extrusion-opacity': state.floor === null ? 0.95 : 0.25
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
// Geometry + deterministic record helpers
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

// The same building position always produces the same ULPIN.
function buildRecord(feature) {
    const geom = JSON.parse(JSON.stringify(feature.geometry));
    const [minX, minY, maxX, maxY] = bboxOf(geom);
    const lng = (minX + maxX) / 2;
    const lat = (minY + maxY) / 2;
    const rng = mulberry32(hashString(`${lng.toFixed(4)}|${lat.toFixed(4)}`));

    const rFallbackH = rng(), rBase = rng(), rBaseN = rng(), rStatus = rng(), rOwner = rng();

    let heightM = Number(feature.properties.height);
    if (!(heightM > 0)) heightM = 9 + Math.floor(rFallbackH * 24);
    heightM = Math.round(heightM * 10) / 10;

    const minHeightM = Number(feature.properties.min_height) || 0;
    const basements = rBase > 0.7 ? 1 + Math.floor(rBaseN * 3) : 0;
    const depthM = basements * FLOOR_HEIGHT_M;
    const floorsAbove = Math.max(1, Math.round(heightM / FLOOR_HEIGHT_M));
    const footprint = areaM2(geom);

    let digits = '';
    for (let i = 0; i < 12; i++) digits += Math.floor(rng() * 10);

    return {
        v: 1,
        ulpin: STATE_CODE + digits,
        lng, lat,
        heightM, minHeightM, depthM,
        floorsAbove, floorsBelow: basements,
        footprintM2: footprint,
        volumeM3: footprint * (heightM + depthM),
        status: rStatus < 0.6 ? 'ok' : rStatus < 0.8 ? 'warn' : 'bad',
        owner: OWNERS[Math.floor(rOwner * OWNERS.length)],
        geometry: geom
    };
}

// Combine a freshly computed record with whatever the database already knows.
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

// Per-floor details (simulated, but stable for a given ULPIN and floor).
function floorList(rec) {
    const list = [];
    for (let k = rec.floorsBelow; k >= 1; k--) list.push(-k);
    for (let f = 1; f <= rec.floorsAbove; f++) list.push(f);
    return list; // bottom to top
}

function floorLabel(f) { return f < 0 ? `Basement ${-f}` : `Floor ${f}`; }
function floorCode(f) { return f < 0 ? `B${-f}` : `F${String(f).padStart(2, '0')}`; }

function floorInfo(rec, f) {
    const r = mulberry32(hashString(`${rec.ulpin}:${f}`));
    const upper = ['Residential', 'Residential', 'Residential', 'Office', 'Mixed use'];
    let use;
    if (f < 0) use = r() < 0.6 ? 'Parking' : 'Storage and utilities';
    else if (f === 1) use = ['Retail', 'Commercial', 'Parking and lobby', 'Office'][Math.floor(r() * 4)];
    else use = upper[Math.floor(r() * upper.length)];

    const area = rec.footprintM2 * (0.86 + r() * 0.1);
    const perUnit = { Residential: 90, Office: 55, 'Mixed use': 70, Retail: 45, Commercial: 60 }[use];
    const units = perUnit ? Math.max(1, Math.round(area / perUnit)) : 0;
    const lo = f > 0 ? (f - 1) * FLOOR_HEIGHT_M : f * FLOOR_HEIGHT_M;
    const hi = Math.min(lo + FLOOR_HEIGHT_M, f > 0 ? rec.heightM : lo + FLOOR_HEIGHT_M);
    return { use, area, units, lo, hi, ref: `${formatUlpin(rec.ulpin)} ${floorCode(f)}` };
}

// ---------------------------------------------------------------------------
// Map data for selection, floor and registry
// ---------------------------------------------------------------------------
function selectionCollection() {
    const r = state.selected;
    if (!r) return EMPTY_FC;
    return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: r.geometry, properties: { h: r.heightM + 0.2, base: r.minHeightM } }]
    };
}

function floorCollection() {
    const r = state.selected, f = state.floor;
    if (!r || f === null || f < 1) return EMPTY_FC;
    let lo = (f - 1) * FLOOR_HEIGHT_M;
    const hi = Math.min(f * FLOOR_HEIGHT_M, r.heightM + 0.2);
    if (hi <= lo) lo = Math.max(0, hi - FLOOR_HEIGHT_M);
    return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: r.geometry, properties: { h: hi, base: lo } }]
    };
}

function registryCollection() {
    return {
        type: 'FeatureCollection',
        features: DB.all().slice(0, 2500).map((r) => ({ type: 'Feature', geometry: r.geometry, properties: {} }))
    };
}

function syncMapSelection() {
    const p = map.getSource('selected-parcel');
    const f = map.getSource('selected-floor');
    if (p) p.setData(selectionCollection());
    if (f) f.setData(floorCollection());
    if (map.getLayer('selected-parcel-3d')) {
        map.setPaintProperty('selected-parcel-3d', 'fill-extrusion-opacity', state.floor === null ? 0.95 : 0.25);
    }
}

const syncRegistryLayer = debounce(() => {
    const s = map.getSource('registry-parcels');
    if (s) s.setData(registryCollection());
}, 200);

// ---------------------------------------------------------------------------
// Selection, lookup and navigation
// ---------------------------------------------------------------------------
function selectRecord(rec, opts = {}) {
    const merged = mergeRecord(rec, DB.get(rec.ulpin) || (rec.firstSeen ? rec : null), rec.source || 'click');
    merged.lastViewed = Date.now();
    merged.views = (merged.views || 0) + 1;
    DB.put(merged);

    state.selected = merged;
    state.floor = opts.floor ?? null;
    syncMapSelection();
    renderRecord();
    refreshRegistryUI();
    ensurePlace(merged);
    return merged;
}

function clearSelection() {
    state.selected = null;
    state.floor = null;
    syncMapSelection();
    renderRecord();
    refreshRegistryUI();
}

function setFloor(f) {
    if (!state.selected) return;
    const valid = floorList(state.selected);
    state.floor = f !== null && valid.includes(f) ? f : null;
    syncMapSelection();
    renderStrip(state.selected);
    renderFloor();
}

function locate(rec, floor = null) {
    map.flyTo({ center: [rec.lng, rec.lat], zoom: Math.max(map.getZoom(), 18), pitch: 60, duration: 1100 });
    const sel = selectRecord(rec, { floor: null });
    if (floor !== null) setFloor(floor);
    return sel;
}

map.on('click', (e) => {
    if (!map.getLayer('buildings-3d')) return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ['buildings-3d'] })[0];
    if (!hit) { clearSelection(); return; }
    selectRecord(buildRecord(hit));
});
map.on('mouseenter', 'buildings-3d', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'buildings-3d', () => { map.getCanvas().style.cursor = ''; });

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected && !$('registry-dialog').open) clearSelection();
});

// Index every building currently visible into the registry.
function scanView() {
    if (!map.getLayer('buildings-3d')) return;
    if (map.getZoom() < 15) { toast('Zoom in to level 15 or closer, then scan.'); return; }

    const feats = map.queryRenderedFeatures({ layers: ['buildings-3d'] });
    const seen = new Set();
    const batch = [];
    let fresh = 0;

    for (const f of feats) {
        if (!f.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type)) continue;
        const rec = buildRecord(f);
        if (rec.footprintM2 < 25 || seen.has(rec.ulpin)) continue;
        seen.add(rec.ulpin);
        const existing = DB.get(rec.ulpin);
        if (!existing) fresh++;
        batch.push(mergeRecord(rec, existing, 'scan'));
        if (batch.length >= MAX_SCAN) break;
    }

    if (!batch.length) { toast('No buildings found in this view.'); return; }
    DB.putMany(batch);
    refreshRegistryUI();
    toast(`Indexed ${fresh} new building${fresh === 1 ? '' : 's'}. ${batch.length} in view, ${DB.count()} in the registry.`);
}

// ---------------------------------------------------------------------------
// Address lookup (Mapbox geocoding)
// ---------------------------------------------------------------------------
async function ensurePlace(rec) {
    if (rec.place) return;
    $('sp-place').textContent = 'Looking up...';
    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${rec.lng},${rec.lat}.json` +
            `?types=address,poi,neighborhood,locality&language=en&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const name = data.features && data.features[0] && data.features[0].place_name;
        if (name) {
            rec.place = name.replace(/, India$/, '');
            DB.put(rec);
            refreshRegistryUI();
        }
    } catch (e) { /* offline or blocked */ }
    if (state.selected && state.selected.ulpin === rec.ulpin) {
        $('sp-place').textContent = rec.place || 'Address unavailable';
    }
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
// ULPIN lookup
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

// Accepts "0912 3456 7890 12", "09123456789012 F5", "...12 floor 5", "...12 B1", "...12-05".
function parseLookup(raw) {
    let text = wordsToDigits(raw);
    let floor = null;

    const fm = text.match(/\b(?:floor|level|fl|f)\s*-?\s*(\d{1,2})\b/i);
    const bm = text.match(/\b(?:basement|b)\s*-?\s*(\d{1,2})\b/i);
    if (bm) { floor = -parseInt(bm[1], 10); text = text.replace(bm[0], ' '); }
    else if (fm) { floor = parseInt(fm[1], 10); text = text.replace(fm[0], ' '); }

    let digits = (text.match(/\d/g) || []).join('');
    if (floor === null && digits.length === 16 && /\d-\d{2}\s*$/.test(raw)) {
        floor = parseInt(digits.slice(14), 10);
        digits = digits.slice(0, 14);
    }
    if (digits.length > 14) digits = digits.slice(0, 14);
    return { digits, floor };
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
        btn.querySelector('.r-meta').textContent = `${r.floorsAbove} fl, ${nf(r.footprintM2)} m\u00B2`;
        btn.addEventListener('click', () => onPick(r));
        li.appendChild(btn);
        ul.appendChild(li);
    });
}

function lookup(raw) {
    const list = $('lookup-matches');
    list.hidden = true;
    const { digits, floor } = parseLookup(raw);

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
        const sel = locate(rec, floor);
        if (floor !== null && !floorList(sel).includes(floor)) {
            showLookupMsg(`Found the building, but it has no ${floorLabel(floor).toLowerCase()}. It has ${sel.floorsAbove} floors above ground and ${sel.floorsBelow} basement level${sel.floorsBelow === 1 ? '' : 's'}.`, 'error');
        } else {
            showLookupMsg(floor !== null ? `Found ${floorLabel(floor).toLowerCase()} of ${formatUlpin(digits)}.` : `Found ${formatUlpin(digits)}.`);
        }
        return true;
    }

    const matches = DB.all().filter((r) => r.ulpin.includes(digits)).slice(0, 6);
    if (!matches.length) {
        showLookupMsg(`No registry entries contain ${digits}.`, 'error', true);
        return false;
    }
    showLookupMsg(`${matches.length} match${matches.length === 1 ? '' : 'es'} for ${digits}. Pick one:`);
    renderMatchList(list, matches, (r) => { locate(r, floor); list.hidden = true; showLookupMsg(''); });
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
function renderStrip(rec) {
    const svg = $('strip');
    const x0 = 78, barW = 120, top = 18;
    const defs = `<defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#dfe8e5"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="#10303a" stroke-width="2"/>
        </pattern></defs>`;

    if (!rec) {
        const bh = 20, ground = top + 5 * bh;
        let s = defs;
        for (let i = 0; i < 5; i++) s += `<rect class="ghost" x="${x0}" y="${ground - (i + 1) * bh + 2}" width="${barW}" height="${bh - 4}" rx="1"/>`;
        s += `<rect class="ghost" x="${x0}" y="${ground + 2}" width="${barW}" height="${bh - 4}" rx="1"/>`;
        s += `<line class="ground" x1="${x0 - 36}" y1="${ground}" x2="${x0 + barW + 36}" y2="${ground}"/>`;
        svg.innerHTML = s;
        svg.setAttribute('aria-label', 'No building selected');
        return;
    }

    const a = rec.floorsAbove, b = rec.floorsBelow, total = a + b;
    const bh = Math.max(2.2, Math.min(18, 190 / total));
    const gap = bh >= 8 ? 1.6 : 0.5;
    const ground = top + a * bh;
    const sel = state.floor;
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
    if (!near(yTop)) s += `<text class="strong" x="${rx}" y="${yTop}">+${nf1.format(rec.heightM)} m</text>`;
    if (!near(yGround)) s += `<text x="${rx}" y="${yGround.toFixed(2)}">Ground</text>`;
    if (b && !near(yDepth)) s += `<text class="strong" x="${rx}" y="${yDepth.toFixed(2)}">-${rec.depthM} m</text>`;
    if (selY !== null) s += `<text class="strong" x="${rx}" y="${selY.toFixed(2)}">${floorLabel(sel)}</text>`;
    s += `<text text-anchor="end" x="${x0 - 10}" y="${top + 8}">${a} floor${a > 1 ? 's' : ''}</text>`;
    if (b) s += `<text text-anchor="end" x="${x0 - 10}" y="${yDepth.toFixed(2)}">${b} basement${b > 1 ? 's' : ''}</text>`;

    svg.innerHTML = s;
    svg.setAttribute('aria-label',
        `Section of selected building: ${a} floors above ground, ${b} below, ${nf1.format(rec.heightM)} metres tall.` +
        (sel !== null ? ` ${floorLabel(sel)} highlighted.` : ''));
}

function renderFloorSelect(rec) {
    const sel = $('floor-select');
    sel.innerHTML = '';
    const whole = new Option('Whole building', '');
    sel.add(whole);
    floorList(rec).slice().reverse().forEach((f) => sel.add(new Option(floorLabel(f), String(f))));
}

function renderFloor() {
    const rec = state.selected;
    const specs = $('floor-specs');
    const sel = $('floor-select');
    sel.value = state.floor === null ? '' : String(state.floor);
    if (!rec || state.floor === null) { specs.hidden = true; return; }
    const info = floorInfo(rec, state.floor);
    specs.hidden = false;
    $('fl-use').textContent = info.use;
    $('fl-elev').textContent = state.floor > 0
        ? `${nf1.format(info.lo)} to ${nf1.format(info.hi)} m above ground`
        : `${-info.hi} to ${-info.lo} m below ground`;
    $('fl-area').textContent = `${nf(info.area)} m\u00B2`;
    $('fl-units').textContent = info.units ? `${info.units} approx.` : 'Not applicable';
    $('fl-ref').textContent = info.ref;
}

function renderRecord() {
    const rec = state.selected;
    const ulpinEl = $('ulpin-display');
    const pill = $('status-pill');

    renderStrip(rec);
    $('record-details').hidden = !rec;
    $('empty-hint').hidden = !!rec;
    $('copy-ulpin').hidden = !rec;
    pill.hidden = !rec;
    renderRecent();

    if (!rec) {
        ulpinEl.textContent = 'Not assigned';
        ulpinEl.classList.add('is-empty');
        return;
    }

    ulpinEl.textContent = formatUlpin(rec.ulpin);
    ulpinEl.classList.remove('is-empty');
    ulpinEl.classList.add('flash');
    requestAnimationFrame(() => requestAnimationFrame(() => ulpinEl.classList.remove('flash')));

    pill.className = `pill ${rec.status}`;
    pill.textContent = STATUS_TEXT[rec.status];

    renderFloorSelect(rec);
    renderFloor();

    $('sp-place').textContent = rec.place || '-';
    $('sp-footprint').textContent = `${nf.format(rec.footprintM2)} m\u00B2`;
    $('sp-height').textContent = `${nf1.format(rec.heightM)} m`;
    $('sp-depth').textContent = rec.depthM ? `${rec.depthM} m` : 'None';
    $('sp-floors').textContent = `${rec.floorsAbove} above, ${rec.floorsBelow} below`;
    $('sp-volume').textContent = `${nf.format(rec.volumeM3)} m\u00B3`;
    $('sp-owner').textContent = rec.owner;
    $('coord-display').innerHTML =
        `X: ${rec.lng.toFixed(5)}<br>Y: ${rec.lat.toFixed(5)}<br>` +
        `Z: +${nf1.format(rec.heightM)} m / -${rec.depthM} m`;
    $('note-input').value = rec.note || '';
    const star = $('star-btn');
    star.setAttribute('aria-pressed', String(!!rec.starred));
    star.textContent = rec.starred ? 'Starred' : 'Star';
}

function renderRecent() {
    const recent = DB.all().filter((r) => r.lastViewed > 0).sort((a, b) => b.lastViewed - a.lastViewed).slice(0, 5);
    $('recent-wrap').hidden = recent.length === 0;
    renderMatchList($('recent-list'), recent, (r) => locate(r));
}

// Floor controls -----------------------------------------------------------
$('floor-select').addEventListener('change', (e) => setFloor(e.target.value === '' ? null : parseInt(e.target.value, 10)));

function stepFloor(dir) {
    const rec = state.selected;
    if (!rec) return;
    const list = floorList(rec); // bottom to top
    if (state.floor === null) { setFloor(list.includes(1) ? 1 : list[0]); return; }
    const i = list.indexOf(state.floor) + dir;
    if (i >= 0 && i < list.length) setFloor(list[i]);
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
    const r = state.selected;
    if (!r) return;
    r.starred = !r.starred;
    DB.put(r);
    $('star-btn').setAttribute('aria-pressed', String(r.starred));
    $('star-btn').textContent = r.starred ? 'Starred' : 'Star';
    refreshRegistryUI();
});

async function copyText(text, btn, doneLabel) {
    const original = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = doneLabel; }
    catch (err) { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = original; }, 1400);
}

function exportShape(r) {
    return {
        ulpin: r.ulpin,
        place: r.place || null,
        centroid: { x: +r.lng.toFixed(5), y: +r.lat.toFixed(5) },
        heightAboveGroundM: r.heightM,
        depthBelowGroundM: r.depthM,
        floorsAbove: r.floorsAbove,
        floorsBelow: r.floorsBelow,
        footprintM2: Math.round(r.footprintM2),
        enclosedVolumeM3: Math.round(r.volumeM3),
        registryStatus: STATUS_TEXT[r.status],
        registeredTo: r.owner,
        note: r.note || '',
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

    const modeText = {
        cloud: 'synced to the shared registry',
        offline: 'cached on this device (backend unreachable right now, changes will sync once it is back)',
        local: 'stored on this device only (no backend configured)'
    }[DB.mode()];
    $('registry-meta').textContent =
        `${all.length} parcel${all.length === 1 ? '' : 's'}, ${modeText}` +
        (DB.pendingWrites() ? ` \u2022 saving ${DB.pendingWrites()}...` : '') +
        (rows.length > shown.length ? `. Showing the latest ${shown.length} of ${rows.length} matches.` : '.');

    const body = $('registry-body');
    body.innerHTML = '';
    const empty = $('registry-empty');
    empty.hidden = shown.length > 0;
    if (!shown.length) {
        empty.textContent = all.length
            ? 'No parcels match this filter.'
            : 'The registry is empty. Click a building, or use Scan this view to index every building on screen.';
    }

    shown.forEach((r) => {
        const tr = document.createElement('tr');
        tr.dataset.ulpin = r.ulpin;
        const viewed = r.lastViewed ? new Date(r.lastViewed).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not yet';
        tr.innerHTML =
            '<td class="c-ulpin"></td><td class="c-place"></td><td class="c-num c-floors"></td>' +
            '<td class="c-num c-area"></td><td><span class="pill sm"></span></td><td class="c-num c-viewed"></td>' +
            '<td class="c-act"><button class="btn-quiet" data-act="locate" type="button">Locate</button>' +
            '<button class="btn-quiet" data-act="star" type="button"></button>' +
            '<button class="btn-quiet danger" data-act="delete" type="button">Delete</button></td>';
        tr.querySelector('.c-ulpin').textContent = formatUlpin(r.ulpin);
        tr.querySelector('.c-place').textContent = r.place || '-';
        tr.querySelector('.c-place').title = r.note ? `${r.place || ''}\nNote: ${r.note}` : (r.place || '');
        tr.querySelector('.c-floors').textContent = `${r.floorsAbove} / ${r.floorsBelow}`;
        tr.querySelector('.c-area').textContent = `${nf(r.footprintM2)} m\u00B2`;
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
    if (btn.dataset.act === 'locate') { dlg.close(); locate(rec); }
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
    const payload = { app: 'GeoLayer 3D', exportedAt: new Date().toISOString(), parcels: DB.all() };
    download('geolayer-registry.json', JSON.stringify(payload), 'application/json');
});

$('export-csv').addEventListener('click', () => {
    const cols = ['ulpin', 'place', 'lng', 'lat', 'floorsAbove', 'floorsBelow', 'heightM', 'depthM', 'footprintM2', 'volumeM3', 'status', 'owner', 'note', 'starred', 'views', 'firstSeen'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')];
    DB.all().forEach((r) => lines.push(cols.map((c) => {
        if (c === 'status') return esc(STATUS_TEXT[r.status]);
        if (c === 'firstSeen') return esc(r.firstSeen ? new Date(r.firstSeen).toISOString() : '');
        if (c === 'footprintM2' || c === 'volumeM3') return esc(Math.round(r[c]));
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
        const list = Array.isArray(data) ? data : data.parcels;
        if (!Array.isArray(list)) throw new Error('bad shape');
        const ok = list.filter((r) => r && /^\d{14}$/.test(String(r.ulpin)) && r.geometry && r.geometry.coordinates &&
            Number.isFinite(r.lng) && Number.isFinite(r.lat) && Number.isFinite(r.heightM));
        const fill = ok.map((r) => mergeRecord(r, DB.get(r.ulpin) || r, 'import'));
        DB.putMany(fill);
        refreshRegistryUI();
        toast(`Imported ${fill.length} parcel${fill.length === 1 ? '' : 's'}${list.length > ok.length ? `, skipped ${list.length - ok.length} invalid` : ''}.`);
    } catch (err) {
        toast('That file is not a valid GeoLayer registry export.');
    }
});

$('registry-clear').addEventListener('click', () => {
    if (!DB.count()) return;
    const scope = DB.mode() === 'cloud' ? 'from the shared registry, for everyone' : 'from this device';
    if (window.confirm(`Delete all ${DB.count()} parcels ${scope}? Export first if you need a backup.`)) {
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
    lookup: 'Say the 14-digit ULPIN, and a floor if you like',
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

    if (/\bulpin\b/.test(t) || digitCount >= 8) {
        $('lookup-input').value = spoken.replace(/\bulpin\b/g, '').trim();
        lookup(spoken);
        return;
    }

    const fm = spoken.match(/\b(?:floor|level)\s*(\d{1,2})\b/);
    const bm = spoken.match(/\bbasement\s*(\d{1,2})\b/);
    if (fm || bm) {
        if (!state.selected) { toast('Select a building first, then name a floor.'); return; }
        const f = bm ? -parseInt(bm[1], 10) : parseInt(fm[1], 10);
        if (!floorList(state.selected).includes(f)) { toast(`This building has no ${floorLabel(f).toLowerCase()}.`); return; }
        setFloor(f);
        toast(`${floorLabel(f)} highlighted.`);
        return;
    }

    if (/\b(whole building|all floors)\b/.test(t)) { setFloor(null); return; }
    if (/\b(clear|reset|deselect)\b/.test(t)) { clearSelection(); return; }
    if (/\bscan\b/.test(t)) { scanView(); return; }
    if (/\b(registry|database|saved parcels)\b/.test(t)) { $('open-registry').click(); return; }
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

function answer(question, r) {
    const q = wordsToDigits(question);
    const id = formatUlpin(r.ulpin);
    const has = (...words) => words.some((w) => q.includes(w));

    const fm = q.match(/\b(?:floor|level)\s*(\d{1,2})\b/);
    const bm = q.match(/\bbasement\s*(\d{1,2})\b/);
    if (fm || bm) {
        const f = bm ? -parseInt(bm[1], 10) : parseInt(fm[1], 10);
        if (!floorList(r).includes(f)) {
            return `ULPIN ${id} has no ${floorLabel(f).toLowerCase()}. It has ${r.floorsAbove} floors above ground and ${r.floorsBelow} basement level${r.floorsBelow === 1 ? '' : 's'}.`;
        }
        setFloor(f);
        const info = floorInfo(r, f);
        return `${floorLabel(f)} of ULPIN ${id}: ${info.use.toLowerCase()}, about ${nf(info.area)} m\u00B2` +
            (info.units ? `, roughly ${info.units} unit${info.units === 1 ? '' : 's'}` : '') +
            `. Unit reference ${info.ref}. It is now highlighted on the map.`;
    }

    if (has('registry', 'database', 'indexed', 'how many parcels')) {
        const scope = DB.mode() === 'cloud' ? 'shared across every device' : DB.mode() === 'offline' ? 'cached on this device until the backend is reachable again' : 'stored on this device only';
        return `The registry holds ${DB.count()} parcel${DB.count() === 1 ? '' : 's'}, ${scope}. Open Registry in the top bar to search, export or import them.`;
    }
    if (has('owner', 'name', 'registered', 'belong')) {
        return `Registry record for ULPIN ${id}: registered to ${r.owner}. ${r.status === 'bad' ? 'Status: under review.' : 'Status: cleared.'}`;
    }
    if (has('tax', 'due', 'payment')) {
        return r.status === 'bad'
            ? `Financial audit for ULPIN ${id}: property tax is up to date, but a dispute flag is holding mutation of this record.`
            : `Financial audit for ULPIN ${id}: property tax assessment is up to date. No pending dues for the current fiscal year.`;
    }
    if (has('dispute', 'court', 'litigation', 'legal', 'case')) {
        return r.status === 'bad'
            ? `Legal check for ULPIN ${id}: a vertical-property dispute is flagged on floor ${r.floorsAbove}. Physical verification is needed before the title can be authenticated.`
            : `Legal check for ULPIN ${id}: no litigation flags or encumbrances found in district court records.`;
    }
    if (has('where', 'place', 'address', 'locality', 'location', 'coordinate')) {
        return `ULPIN ${id} is ${r.place ? `at ${r.place}, ` : ''}centred at X ${r.lng.toFixed(5)}, Y ${r.lat.toFixed(5)}.`;
    }
    if (has('floor', 'storey', 'story', 'height', 'tall', 'basement', 'level')) {
        const base = r.floorsBelow ? ` and ${r.floorsBelow} basement level${r.floorsBelow > 1 ? 's' : ''} (${r.depthM} m deep)` : ' and no basements';
        return `ULPIN ${id} has ${r.floorsAbove} floor${r.floorsAbove > 1 ? 's' : ''} above ground${base}. Total height above ground is ${nf1.format(r.heightM)} m. Ask for a specific floor, for example "floor 3".`;
    }
    if (has('area', 'size', 'volume', 'footprint', 'big')) {
        return `ULPIN ${id}: footprint is about ${nf(r.footprintM2)} m\u00B2 and the enclosed volume is about ${nf(r.volumeM3)} m\u00B3.`;
    }
    if (has('ulpin', 'id', 'number')) {
        return `This parcel's 14-digit ULPIN is ${id}. The first two digits (${STATE_CODE}) are the state code for Uttar Pradesh.`;
    }

    const lead = `Property analysis [${id}]: ${r.floorsAbove} floors above ground` +
        (r.floorsBelow ? `, ${r.floorsBelow} below` : '') +
        `, footprint about ${nf(r.footprintM2)} m\u00B2. `;
    if (r.status === 'ok') return lead + 'Title deed is fully authenticated under DILRMP guidelines.';
    if (r.status === 'warn') return lead + `Status is pending: physical verification of ${r.floorsAbove} floors is awaited for the DILRMP registry.`;
    return lead + `Alert: title deed is not authenticated under DILRMP guidelines. A vertical property dispute is flagged on floor ${r.floorsAbove}.`;
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
            ? `Located ULPIN ${formatUlpin(parsed.digits)}${parsed.floor !== null ? `, ${floorLabel(parsed.floor).toLowerCase()}` : ''} on the map.`
            : `ULPIN ${formatUlpin(parsed.digits)} is not in the registry yet. Scan the area where the building stands, or import a registry file.`);
        return;
    }

    const wait = appendMessage('wait', 'Checking the land registry...');
    setTimeout(() => {
        wait.remove();
        const reply = state.selected
            ? answer(text, state.selected)
            : 'Click a building on the 3D map first, or give me a ULPIN, then I can read out its details.';
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
DB.onSync(() => refreshRegistryUI());
DB.load().then(() => {
    refreshRegistryUI();
    if (supabase && DB.mode() !== 'cloud') toast('Could not reach the shared registry. Working from this device\u2019s cache instead.');
});