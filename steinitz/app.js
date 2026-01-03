// App State
const state = {
    map: null,
    selectedLocation: null,
    searchCircle: null,
    markers: [],
    restaurants: [],
    apiKey: null
};

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initControls();
    checkApiKey();
});

// Initialize Leaflet map
function initMap() {
    // Default to San Francisco
    const defaultLat = 37.7749;
    const defaultLng = -122.4194;

    state.map = L.map('map').setView([defaultLat, defaultLng], 13);

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(state.map);

    // Try to get user's location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                state.map.setView([lat, lng], 13);
                setSelectedLocation(lat, lng);
            },
            (error) => {
                console.log('Geolocation error:', error);
                // Use default location
                setSelectedLocation(defaultLat, defaultLng);
            }
        );
    } else {
        setSelectedLocation(defaultLat, defaultLng);
    }

    // Allow user to click on map to select location
    state.map.on('click', (e) => {
        setSelectedLocation(e.latlng.lat, e.latlng.lng);
    });
}

// Set selected location and update marker
function setSelectedLocation(lat, lng) {
    state.selectedLocation = { lat, lng };

    // Remove existing search circle
    if (state.searchCircle) {
        state.map.removeLayer(state.searchCircle);
    }

    // Add marker for selected location
    if (state.selectedMarker) {
        state.map.removeLayer(state.selectedMarker);
    }

    state.selectedMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'custom-marker',
            html: '<div style="background: #3498db; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        })
    }).addTo(state.map);

    // Add search radius circle
    const radius = parseInt(document.getElementById('radius').value);
    state.searchCircle = L.circle([lat, lng], {
        radius: radius,
        color: '#3498db',
        fillColor: '#3498db',
        fillOpacity: 0.1,
        weight: 2
    }).addTo(state.map);

    // Fit map to circle bounds
    state.map.fitBounds(state.searchCircle.getBounds());
}

// Update search circle when radius changes
function updateSearchCircle() {
    if (state.selectedLocation && state.searchCircle) {
        const radius = parseInt(document.getElementById('radius').value);
        state.map.removeLayer(state.searchCircle);

        state.searchCircle = L.circle([state.selectedLocation.lat, state.selectedLocation.lng], {
            radius: radius,
            color: '#3498db',
            fillColor: '#3498db',
            fillOpacity: 0.1,
            weight: 2
        }).addTo(state.map);

        state.map.fitBounds(state.searchCircle.getBounds());
    }
}

// Initialize controls
function initControls() {
    document.getElementById('searchBtn').addEventListener('click', searchRestaurants);
    document.getElementById('radius').addEventListener('change', updateSearchCircle);
    document.getElementById('sortBy').addEventListener('change', displayResults);
    document.getElementById('minRating').addEventListener('change', displayResults);
    document.getElementById('apiKeyBtn').addEventListener('click', showApiKeyModal);
    document.getElementById('saveApiKey').addEventListener('click', saveApiKey);
    document.getElementById('cancelApiKey').addEventListener('click', hideApiKeyModal);
}

// API Key Management
function checkApiKey() {
    const storedKey = localStorage.getItem('googlePlacesApiKey');
    if (storedKey) {
        state.apiKey = storedKey;
    } else {
        showApiKeyModal();
    }
}

function showApiKeyModal() {
    const modal = document.getElementById('apiKeyModal');
    modal.classList.add('show');
    document.getElementById('apiKeyInput').value = state.apiKey || '';
}

function hideApiKeyModal() {
    const modal = document.getElementById('apiKeyModal');
    modal.classList.remove('show');
}

function saveApiKey() {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    if (apiKey) {
        state.apiKey = apiKey;
        localStorage.setItem('googlePlacesApiKey', apiKey);
        hideApiKeyModal();
    } else {
        alert('Please enter a valid API key');
    }
}

// Search for restaurants
async function searchRestaurants() {
    if (!state.apiKey) {
        showApiKeyModal();
        return;
    }

    if (!state.selectedLocation) {
        alert('Please select a location on the map');
        return;
    }

    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '<div class="loading">Searching for restaurants...</div>';

    // Clear existing markers
    state.markers.forEach(marker => state.map.removeLayer(marker));
    state.markers = [];

    const radius = parseInt(document.getElementById('radius').value);
    const { lat, lng } = state.selectedLocation;

    try {
        // Use Google Places API Nearby Search
        const response = await fetch(
            `https://cors-anywhere.herokuapp.com/https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=restaurant&key=${state.apiKey}`
        );

        if (!response.ok) {
            throw new Error('API request failed');
        }

        const data = await response.json();

        if (data.status === 'REQUEST_DENIED') {
            throw new Error('API key is invalid or Places API is not enabled');
        }

        if (data.status === 'ZERO_RESULTS') {
            resultsDiv.innerHTML = '<div class="info-message">No restaurants found in this area</div>';
            state.restaurants = [];
            updateResultCount();
            return;
        }

        // Process results
        state.restaurants = data.results.map(place => ({
            id: place.place_id,
            name: place.name,
            rating: place.rating || 0,
            ratingCount: place.user_ratings_total || 0,
            address: place.vicinity,
            lat: place.geometry.location.lat,
            lng: place.geometry.location.lng,
            isOpen: place.opening_hours ? place.opening_hours.open_now : null,
            types: place.types
        }));

        displayResults();
        addMarkers();

    } catch (error) {
        console.error('Search error:', error);
        resultsDiv.innerHTML = `
            <div class="error">
                <strong>Error:</strong> ${error.message}<br><br>
                <strong>Note:</strong> This app requires a CORS proxy to work. You can:<br>
                1. Use a browser extension to disable CORS<br>
                2. Set up your own CORS proxy<br>
                3. Or check the browser console for more details
            </div>
        `;
    }
}

// Display filtered and sorted results
function displayResults() {
    const minRating = parseFloat(document.getElementById('minRating').value);
    const sortBy = document.getElementById('sortBy').value;

    // Filter
    let filtered = state.restaurants.filter(r => r.rating >= minRating);

    // Sort
    filtered.sort((a, b) => {
        switch (sortBy) {
            case 'rating':
                return b.rating - a.rating;
            case 'ratingCount':
                return b.ratingCount - a.ratingCount;
            case 'name':
                return a.name.localeCompare(b.name);
            default:
                return 0;
        }
    });

    // Update count
    updateResultCount(filtered.length);

    // Render
    const resultsDiv = document.getElementById('results');

    if (filtered.length === 0) {
        resultsDiv.innerHTML = '<div class="info-message">No restaurants match your filters</div>';
        return;
    }

    resultsDiv.innerHTML = filtered.map(restaurant => `
        <div class="result-item" data-id="${restaurant.id}" onclick="selectRestaurant('${restaurant.id}')">
            <div class="result-name">${restaurant.name}</div>
            <div class="result-rating">
                <span class="stars">${getStars(restaurant.rating)}</span>
                <span class="rating-text">${restaurant.rating.toFixed(1)} (${restaurant.ratingCount} reviews)</span>
            </div>
            <div class="result-address">${restaurant.address}</div>
            ${restaurant.isOpen !== null ? `
                <div class="result-status ${restaurant.isOpen ? 'open' : 'closed'}">
                    ${restaurant.isOpen ? '● Open now' : '● Closed'}
                </div>
            ` : ''}
        </div>
    `).join('');
}

// Add markers for restaurants
function addMarkers() {
    state.restaurants.forEach(restaurant => {
        const marker = L.marker([restaurant.lat, restaurant.lng], {
            icon: L.divIcon({
                className: 'custom-marker',
                html: '<div style="background: #e74c3c; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        })
        .bindPopup(`
            <strong>${restaurant.name}</strong><br>
            ${getStars(restaurant.rating)} ${restaurant.rating.toFixed(1)}<br>
            ${restaurant.address}
        `)
        .addTo(state.map);

        marker.restaurantId = restaurant.id;
        marker.on('click', () => selectRestaurant(restaurant.id));
        state.markers.push(marker);
    });
}

// Select a restaurant
function selectRestaurant(id) {
    // Remove previous selection
    document.querySelectorAll('.result-item').forEach(item => {
        item.classList.remove('selected');
    });

    // Add selection
    const selectedItem = document.querySelector(`[data-id="${id}"]`);
    if (selectedItem) {
        selectedItem.classList.add('selected');
        selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Center map on restaurant
    const restaurant = state.restaurants.find(r => r.id === id);
    if (restaurant) {
        state.map.setView([restaurant.lat, restaurant.lng], 16);
    }
}

// Update result count
function updateResultCount(count) {
    const total = count !== undefined ? count : state.restaurants.length;
    document.getElementById('resultCount').textContent = `(${total})`;
}

// Get star representation
function getStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalf = rating % 1 >= 0.5;
    const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0);

    return '⭐'.repeat(fullStars) +
           (hasHalf ? '⭐' : '') +
           '☆'.repeat(emptyStars);
}
