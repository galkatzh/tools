// Global variables
let openRouterApiKey = '';
let googleApiKey = '';
let openRouterModel = '';
let map = null;
let markers = [];
let placesData = [];
let loadedMapName = '';
let extractedContent = ''; // For debugging

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    loadApiKeys();
    setupEventListeners();
});

// Load API keys from localStorage
function loadApiKeys() {
    openRouterApiKey = localStorage.getItem('openRouterApiKey') || '';
    googleApiKey = localStorage.getItem('googleApiKey') || '';
    openRouterModel = localStorage.getItem('openRouterModel') || 'moonshotai/kimi-k2:free';

    if (openRouterApiKey) {
        document.getElementById('openrouter-key').value = openRouterApiKey;
        document.getElementById('openrouter-status').textContent = '✓ Saved';
        document.getElementById('openrouter-status').className = 'status success';
    }

    if (openRouterModel) {
        document.getElementById('openrouter-model').value = openRouterModel;
        document.getElementById('model-status').textContent = '✓ Saved';
        document.getElementById('model-status').className = 'status success';
    }

    if (googleApiKey) {
        document.getElementById('google-key').value = googleApiKey;
        document.getElementById('google-status').textContent = '✓ Saved';
        document.getElementById('google-status').className = 'status success';
        loadGoogleMapsScript();
    }
}

// Setup event listeners
function setupEventListeners() {
    // Settings panel
    document.getElementById('settings-toggle').addEventListener('click', toggleSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);

    // API configuration
    document.getElementById('save-openrouter').addEventListener('click', saveOpenRouterKey);
    document.getElementById('save-model').addEventListener('click', saveOpenRouterModel);
    document.getElementById('save-google').addEventListener('click', saveGoogleKey);

    // Map management
    document.getElementById('load-map-btn').addEventListener('click', loadMapFromFile);
    document.getElementById('clear-map').addEventListener('click', clearMap);

    // Extract and results
    document.getElementById('extract-places').addEventListener('click', extractAndMapPlaces);
    document.getElementById('download-map').addEventListener('click', downloadMapData);
    document.getElementById('show-debug').addEventListener('click', showDebug);
    document.getElementById('debug-close').addEventListener('click', hideDebug);
}

// Toggle settings panel
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.toggle('open');
}

// Close settings panel
function closeSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.remove('open');
}

// Show debug panel
function showDebug() {
    const debugSection = document.getElementById('debug-section');
    const debugText = document.getElementById('debug-text');
    debugText.textContent = extractedContent || 'No content extracted yet';
    debugSection.classList.remove('hidden');
    debugSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Hide debug panel
function hideDebug() {
    document.getElementById('debug-section').classList.add('hidden');
}

// Save OpenRouter API key
function saveOpenRouterKey() {
    openRouterApiKey = document.getElementById('openrouter-key').value.trim();
    if (openRouterApiKey) {
        localStorage.setItem('openRouterApiKey', openRouterApiKey);
        document.getElementById('openrouter-status').textContent = '✓ Saved';
        document.getElementById('openrouter-status').className = 'status success';
    } else {
        document.getElementById('openrouter-status').textContent = '✗ Invalid key';
        document.getElementById('openrouter-status').className = 'status error';
    }
}

// Save OpenRouter Model
function saveOpenRouterModel() {
    openRouterModel = document.getElementById('openrouter-model').value.trim();
    if (openRouterModel) {
        localStorage.setItem('openRouterModel', openRouterModel);
        document.getElementById('model-status').textContent = '✓ Saved';
        document.getElementById('model-status').className = 'status success';
    } else {
        // If empty, use default
        openRouterModel = 'moonshotai/kimi-k2:free';
        localStorage.setItem('openRouterModel', openRouterModel);
        document.getElementById('openrouter-model').value = openRouterModel;
        document.getElementById('model-status').textContent = '✓ Using default';
        document.getElementById('model-status').className = 'status success';
    }
}

// Save Google API key
function saveGoogleKey() {
    googleApiKey = document.getElementById('google-key').value.trim();
    if (googleApiKey) {
        localStorage.setItem('googleApiKey', googleApiKey);
        document.getElementById('google-status').textContent = '✓ Saved';
        document.getElementById('google-status').className = 'status success';
        loadGoogleMapsScript();
    } else {
        document.getElementById('google-status').textContent = '✗ Invalid key';
        document.getElementById('google-status').className = 'status error';
    }
}

// Load Google Maps script dynamically
function loadGoogleMapsScript() {
    if (document.querySelector('script[src*="maps.googleapis.com"]')) {
        return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${googleApiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
}

// Main function to extract and map places
async function extractAndMapPlaces() {
    const url = document.getElementById('content-url').value.trim();

    if (!url) {
        alert('Please enter a URL');
        return;
    }

    if (!openRouterApiKey) {
        alert('Please save your OpenRouter API key first');
        return;
    }

    if (!googleApiKey) {
        alert('Please save your Google Places API key first');
        return;
    }

    showLoading(true, 'Fetching content...');

    try {
        // Step 1: Extract content from URL
        const content = await extractContentFromUrl(url);
        extractedContent = content; // Store for debugging

        // Step 2: Extract places using OpenRouter
        showLoading(true, 'Extracting places with AI...');
        const places = await extractPlacesWithAI(content);

        // Step 3: Geocode places with Google Places API
        showLoading(true, 'Geocoding places...');
        const appendMode = placesData.length > 0; // Append if we already have places
        await geocodePlaces(places, appendMode);

        // Step 4: Display results
        showLoading(false);
        displayPlaces();
        displayMap();
        updatePlaceCount();

    } catch (error) {
        showLoading(false);
        alert(`Error: ${error.message}`);
        console.error('Error:', error);
    }
}

// Extract content from URL
async function extractContentFromUrl(url) {
    // Check if it's a Reddit post
    if (url.includes('reddit.com')) {
        return await extractRedditContent(url);
    } else {
        return await extractGenericContent(url);
    }
}

// Extract Reddit content including all comments
async function extractRedditContent(url) {
    // Convert to JSON API URL
    let jsonUrl = url;
    if (!jsonUrl.endsWith('.json')) {
        jsonUrl = url.replace(/\/$/, '') + '.json';
    }

    showLoading(true, 'Fetching Reddit post and comments...');

    // Helper function to parse Reddit JSON response
    const parseRedditData = (data) => {
        const post = data[0].data.children[0].data;
        let content = `Title: ${post.title}\n\n`;

        if (post.selftext) {
            content += `Post: ${post.selftext}\n\n`;
        }

        content += 'Comments:\n\n';

        // Extract all comments recursively
        const comments = data[1].data.children;
        content += extractComments(comments);

        return content;
    };

    // Try direct fetch first
    try {
        const response = await fetch(jsonUrl);
        if (response.ok) {
            const data = await response.json();
            return parseRedditData(data);
        }
    } catch (directError) {
        console.log('Direct Reddit fetch failed, trying CORS proxy...', directError.message);
    }

    // Fallback to CORS proxy
    try {
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(jsonUrl)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error(`Proxy fetch failed: ${response.status}`);
        }

        // Get response as text first to validate it
        const responseText = await response.text();

        // Store raw response for debugging
        extractedContent = `[DEBUG] Raw Reddit API Response:\n${responseText.substring(0, 2000)}...\n\n`;

        // Try to parse as JSON
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            throw new Error(`Invalid JSON response from Reddit API. Response starts with: ${responseText.substring(0, 200)}`);
        }

        // Validate the expected Reddit structure
        if (!Array.isArray(data) || data.length < 2) {
            throw new Error(`Unexpected Reddit response structure. Expected array with 2 elements, got: ${typeof data}`);
        }

        if (!data[0]?.data?.children?.[0]?.data) {
            throw new Error('Reddit post data not found in expected location');
        }

        if (!data[1]?.data?.children) {
            throw new Error('Reddit comments data not found in expected location');
        }

        return parseRedditData(data);

    } catch (proxyError) {
        throw new Error(`Failed to extract Reddit content: ${proxyError.message}`);
    }
}

// Recursively extract comments and replies
function extractComments(comments, depth = 0) {
    let text = '';

    for (const comment of comments) {
        if (comment.kind === 't1' && comment.data.body) {
            const indent = '  '.repeat(depth);
            text += `${indent}${comment.data.body}\n\n`;

            // Process replies
            if (comment.data.replies && comment.data.replies.data) {
                text += extractComments(comment.data.replies.data.children, depth + 1);
            }
        }
    }

    return text;
}

// Extract content from generic URL
async function extractGenericContent(url) {
    try {
        // For CORS reasons, we'll use a proxy or fetch directly
        // This is a simple implementation - in production you'd want a backend proxy
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch content: ${response.status}`);
        }

        const html = await response.text();

        // Extract text from HTML (basic implementation)
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove script and style elements
        const scripts = doc.querySelectorAll('script, style');
        scripts.forEach(el => el.remove());

        // Get text content
        const text = doc.body.textContent || '';

        // Clean up whitespace
        return text.replace(/\s+/g, ' ').trim();

    } catch (error) {
        // If direct fetch fails due to CORS, try using a CORS proxy
        try {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            const response = await fetch(proxyUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch via proxy: ${response.status}`);
            }

            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const scripts = doc.querySelectorAll('script, style');
            scripts.forEach(el => el.remove());

            const text = doc.body.textContent || '';
            return text.replace(/\s+/g, ' ').trim();

        } catch (proxyError) {
            throw new Error(`Failed to extract content: ${proxyError.message}`);
        }
    }
}

// Extract places using OpenRouter AI
async function extractPlacesWithAI(content) {
    const prompt = `You are a helpful assistant that extracts place recommendations from text.

Analyze the following content and extract all mentioned places, restaurants, cafes, attractions, hotels, or any locations that are recommended or discussed.

For each place, provide:
1. Name of the place
2. Type (restaurant, cafe, hotel, attraction, etc.)
3. Any additional context or description mentioned

Format your response as a JSON array of objects with fields: name, type, description

Content:
${content.substring(0, 8000)}`;

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openRouterApiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Place Recommendation Mapper'
            },
            body: JSON.stringify({
                model: openRouterModel || 'moonshotai/kimi-k2:free',
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;

        // Try to parse JSON from response
        let places;
        try {
            // Extract JSON from markdown code blocks if present
            const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                            responseText.match(/```\n?([\s\S]*?)\n?```/) ||
                            [null, responseText];
            places = JSON.parse(jsonMatch[1]);
        } catch (e) {
            // If parsing fails, try to extract places manually
            places = [];
            console.warn('Failed to parse JSON, response:', responseText);
        }

        if (!Array.isArray(places) || places.length === 0) {
            throw new Error('No places found in the content');
        }

        return places;

    } catch (error) {
        throw new Error(`Failed to extract places with AI: ${error.message}`);
    }
}

// Geocode places using Google Places API
async function geocodePlaces(places, appendMode = false) {
    if (!appendMode) {
        placesData = [];
    }

    const service = new google.maps.places.PlacesService(document.createElement('div'));
    const newPlaces = [];

    for (const place of places) {
        // Check if place already exists in placesData
        const exists = placesData.some(p =>
            p.name.toLowerCase() === place.name.toLowerCase()
        );

        if (exists && appendMode) {
            console.log(`Skipping duplicate place: ${place.name}`);
            continue;
        }

        try {
            const location = await new Promise((resolve, reject) => {
                const request = {
                    query: place.name,
                    fields: ['name', 'geometry', 'formatted_address', 'place_id', 'types']
                };

                service.findPlaceFromQuery(request, (results, status) => {
                    if (status === google.maps.places.PlacesServiceStatus.OK && results && results[0]) {
                        resolve(results[0]);
                    } else {
                        reject(new Error(`Place not found: ${place.name}`));
                    }
                });
            });

            const newPlace = {
                ...place,
                lat: location.geometry.location.lat(),
                lng: location.geometry.location.lng(),
                address: location.formatted_address,
                placeId: location.place_id,
                found: true,
                source: 'extracted',
                addedDate: new Date().toISOString()
            };

            newPlaces.push(newPlace);

        } catch (error) {
            // Add place even if geocoding failed
            const newPlace = {
                ...place,
                error: error.message,
                found: false,
                source: 'extracted',
                addedDate: new Date().toISOString()
            };

            newPlaces.push(newPlace);
        }
    }

    // Add new places to existing data
    placesData.push(...newPlaces);
    updateLoadedMapInfo();
}

// Display places list
function displayPlaces() {
    const placesList = document.getElementById('places-list');
    placesList.innerHTML = '';

    placesData.forEach((place, index) => {
        const placeItem = document.createElement('div');
        const classNames = ['place-item'];
        if (!place.found) classNames.push('error');
        if (place.source === 'loaded') classNames.push('loaded');

        placeItem.className = classNames.join(' ');

        const sourceLabel = place.source === 'loaded' ? '(from loaded map)' : '(newly extracted)';

        placeItem.innerHTML = `
            <h3>${index + 1}. ${place.name}</h3>
            <p><strong>Type:</strong> ${place.type || 'N/A'}</p>
            ${place.description ? `<p><strong>Description:</strong> ${place.description}</p>` : ''}
            ${place.address ? `<p><strong>Address:</strong> ${place.address}</p>` : ''}
            ${place.error ? `<p style="color: #f44336;"><strong>Error:</strong> ${place.error}</p>` : ''}
            <p class="place-source">${sourceLabel}</p>
        `;

        placesList.appendChild(placeItem);
    });

    document.getElementById('results-section').classList.remove('hidden');
}

// Display map with markers
function displayMap() {
    const mapSection = document.getElementById('map-section');
    mapSection.classList.remove('hidden');

    const validPlaces = placesData.filter(p => p.found);

    if (validPlaces.length === 0) {
        document.getElementById('map').innerHTML = '<p style="padding: 20px; text-align: center;">No places could be mapped</p>';
        return;
    }

    // Calculate center of all places
    const avgLat = validPlaces.reduce((sum, p) => sum + p.lat, 0) / validPlaces.length;
    const avgLng = validPlaces.reduce((sum, p) => sum + p.lng, 0) / validPlaces.length;

    // Initialize map
    map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: avgLat, lng: avgLng },
        zoom: 12
    });

    // Clear existing markers
    markers.forEach(marker => marker.setMap(null));
    markers = [];

    // Add markers for each place
    validPlaces.forEach((place, index) => {
        const marker = new google.maps.Marker({
            position: { lat: place.lat, lng: place.lng },
            map: map,
            title: place.name,
            label: (index + 1).toString()
        });

        const infoWindow = new google.maps.InfoWindow({
            content: `
                <div style="padding: 10px;">
                    <h3>${place.name}</h3>
                    <p><strong>Type:</strong> ${place.type || 'N/A'}</p>
                    ${place.description ? `<p>${place.description}</p>` : ''}
                    <p><strong>Address:</strong> ${place.address}</p>
                </div>
            `
        });

        marker.addListener('click', () => {
            infoWindow.open(map, marker);
        });

        markers.push(marker);
    });

    // Fit bounds to show all markers
    if (validPlaces.length > 1) {
        const bounds = new google.maps.LatLngBounds();
        validPlaces.forEach(place => {
            bounds.extend({ lat: place.lat, lng: place.lng });
        });
        map.fitBounds(bounds);
    }
}

// Download map data
function downloadMapData() {
    const data = {
        exportDate: new Date().toISOString(),
        places: placesData,
        summary: {
            total: placesData.length,
            mapped: placesData.filter(p => p.found).length,
            failed: placesData.filter(p => !p.found).length
        }
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `places-map-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Show/hide loading indicator
function showLoading(show, message = 'Processing...') {
    const loading = document.getElementById('loading');
    const loadingMessage = document.getElementById('loading-message');

    if (show) {
        loading.classList.remove('hidden');
        loadingMessage.textContent = message;
        document.getElementById('extract-places').disabled = true;
    } else {
        loading.classList.add('hidden');
        document.getElementById('extract-places').disabled = false;
    }
}

// Load map from JSON file
function loadMapFromFile() {
    const fileInput = document.getElementById('load-map-file');
    const file = fileInput.files[0];

    if (!file) {
        alert('Please select a JSON file to load');
        return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);

            // Validate the data structure
            if (!data.places || !Array.isArray(data.places)) {
                throw new Error('Invalid map file format');
            }

            // Mark all loaded places with source 'loaded'
            const loadedPlaces = data.places.map(place => ({
                ...place,
                source: 'loaded'
            }));

            // Replace current places data with loaded data
            placesData = loadedPlaces;
            loadedMapName = file.name;

            // Update UI
            updateLoadedMapInfo();
            displayPlaces();
            displayMap();

            document.getElementById('load-map-status').textContent = '✓ Loaded';
            document.getElementById('load-map-status').className = 'status success';

            // Reset file input
            fileInput.value = '';

        } catch (error) {
            alert(`Failed to load map: ${error.message}`);
            document.getElementById('load-map-status').textContent = '✗ Failed';
            document.getElementById('load-map-status').className = 'status error';
        }
    };

    reader.onerror = () => {
        alert('Failed to read file');
        document.getElementById('load-map-status').textContent = '✗ Failed';
        document.getElementById('load-map-status').className = 'status error';
    };

    reader.readAsText(file);
}

// Clear current map
function clearMap() {
    if (placesData.length === 0) {
        return;
    }

    if (confirm('Are you sure you want to clear the current map? This cannot be undone.')) {
        placesData = [];
        loadedMapName = '';

        // Clear markers
        markers.forEach(marker => marker.setMap(null));
        markers = [];

        // Update UI
        updateLoadedMapInfo();
        document.getElementById('results-section').classList.add('hidden');
        document.getElementById('map-section').classList.add('hidden');
        document.getElementById('load-map-status').textContent = '';
        document.getElementById('load-map-status').className = 'status';
    }
}

// Update loaded map info display
function updateLoadedMapInfo() {
    const infoSection = document.getElementById('loaded-map-info');
    const mapNameElement = document.getElementById('loaded-map-name');
    const mapCountElement = document.getElementById('loaded-map-count');

    if (placesData.length > 0) {
        infoSection.classList.remove('hidden');
        mapNameElement.textContent = loadedMapName || 'Current session';
        mapCountElement.textContent = placesData.length;
    } else {
        infoSection.classList.add('hidden');
        mapNameElement.textContent = 'None';
        mapCountElement.textContent = '0';
    }

    updatePlaceCount();
}

// Update place count in results header
function updatePlaceCount() {
    const countElement = document.getElementById('place-count');
    if (countElement) {
        countElement.textContent = placesData.length;
    }
}
