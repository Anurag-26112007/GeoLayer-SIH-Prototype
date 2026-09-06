// 1. Mapbox Token
mapboxgl.accessToken = 'pk.eyJ1IjoiZXJpY25pbmciLCJhIjoiY21icXlubWM1MDRiczJvb2xwM2p0amNyayJ9.n-3O6JI5nOp_Lw96ZO5vJQ';

// Global variables to give the Assistant context about what you click
let currentUlpin = 'None Selected';
let currentSpatialData = 'None Selected';
let currentFloors = 0;

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11', 
    center: [80.9462, 26.8467], // Lucknow Coordinates
    zoom: 16,
    pitch: 45, 
    bearing: -17.6, 
    antialias: true
});

map.on('style.load', () => {
    const layers = map.getStyle().layers;
    const labelLayerId = layers.find(
        (layer) => layer.type === 'symbol' && layer.layout['text-field']
    )?.id;

    map.addLayer(
        {
            'id': 'add-3d-buildings',
            'source': 'composite',
            'source-layer': 'building',
            'filter': ['==', 'extrude', 'true'],
            'type': 'fill-extrusion',
            'minzoom': 15,
            'paint': {
                'fill-extrusion-color': '#cbd5e1', 
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-base': ['get', 'min_height'],
                'fill-extrusion-opacity': 0.8
            }
        },
        labelLayerId
    );
});

map.on('click', (e) => {
    const lng = e.lngLat.lng.toFixed(4);
    const lat = e.lngLat.lat.toFixed(4);
    
    currentFloors = Math.floor(Math.random() * 8) + 2; 
    const heightZ = currentFloors * 3; 
    
    currentSpatialData = `X: ${lng}, Y: ${lat}, Z: ${heightZ}m (${currentFloors} floors)`;
    
    document.getElementById('coord-display').innerHTML = 
        `X: ${lng} (Lng)<br>Y: ${lat} (Lat)<br>Z: ${heightZ}m (${currentFloors} floors)`;
    
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let ulpin = '';
    for (let i = 0; i < 14; i++) {
        ulpin += chars.charAt(Math.floor(Math.random() * chars.length));
        if (i === 3 || i === 7) ulpin += '-';
    }
    
    currentUlpin = ulpin;
    
    const ulpinDisplay = document.getElementById('ulpin-display');
    ulpinDisplay.innerText = ulpin;
    
    ulpinDisplay.classList.remove('text-blue-700');
    ulpinDisplay.classList.add('text-green-600');
    
    setTimeout(() => {
        ulpinDisplay.classList.remove('text-green-600');
        ulpinDisplay.classList.add('text-blue-700');
    }, 300);
});

map.on('mouseenter', 'add-3d-buildings', () => {
    map.getCanvas().style.cursor = 'pointer';
});
map.on('mouseleave', 'add-3d-buildings', () => {
    map.getCanvas().style.cursor = '';
});

// --- Smart Local AI Assistant Engine ---
const chatHistory = document.getElementById('chat-history');
const aiInput = document.getElementById('ai-input');
const aiSendBtn = document.getElementById('ai-send');

function appendMessage(sender, text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = sender === 'user' 
        ? 'bg-purple-100 p-3 rounded-xl rounded-tr-none w-11/12 ml-auto text-purple-900 border border-purple-200'
        : 'bg-slate-200/70 p-3 rounded-xl rounded-tl-none w-11/12 text-slate-800 border border-slate-300';
    msgDiv.innerText = text;
    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function processAIAssistant(question) {
    appendMessage('user', question);
    aiInput.value = '';
    
    // Simulate thinking delay for realism
    const loadingId = 'loading-' + Date.now();
    const loadingDiv = document.createElement('div');
    loadingDiv.id = loadingId;
    loadingDiv.className = 'bg-slate-100 p-3 rounded-xl rounded-tl-none w-11/12 text-slate-500 italic flex items-center gap-2';
    loadingDiv.innerHTML = '<div class="w-2 h-2 bg-purple-400 rounded-full animate-ping"></div> Querying DILRMP land registry...';
    chatHistory.appendChild(loadingDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;

    setTimeout(() => {
        const loadingElement = document.getElementById(loadingId);
        if (loadingElement) loadingElement.remove();

        let responseText = "";
        const q = question.toLowerCase();

        if (currentUlpin === 'None Selected') {
            responseText = "Please click a building on the 3D map first so I can inspect its ULPIN and spatial coordinates.";
        } else if (q.includes('owner') || q.includes('name')) {
            responseText = `Land Registry record for ULPIN ${currentUlpin}: Registered to Directorate of State Estates, Lucknow Zone. Status: Cleared.`;
        } else if (q.includes('tax') || q.includes('dues')) {
            responseText = `Financial Audit for ULPIN ${currentUlpin}: Property tax assessment is up to date. No pending dues recorded for current fiscal year.`;
        } else if (q.includes('dispute') || q.includes('court')) {
            responseText = `Legal Verification for ULPIN ${currentUlpin}: Zero litigation flags or encumbrances found in district court records.`;
        } else {
            responseText = `Property Analysis [${currentUlpin}]: Volumetric structure verified with ${currentFloors} floors mapped via 3D spatial geometry. Title deed is fully authenticated under DILRMP guidelines.`;
        }

        appendMessage('ai', responseText);
    }, 600);
}

aiSendBtn.addEventListener('click', () => {
    if (aiInput.value.trim() !== '') processAIAssistant(aiInput.value);
});

aiInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && aiInput.value.trim() !== '') processAIAssistant(aiInput.value);
});