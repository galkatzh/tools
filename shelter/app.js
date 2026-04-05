/** Shelter Finder – finds the 5 closest bomb shelters and shows navigation options. */

let map, userMarker, shelterMarkers = [], shelterData = null;
let panelEl, listEl, locateBtn, loadingEl;
let travelMode = 'foot'; // 'foot' | 'driving'
let lastPos = null;      // last known { lat, lng } to re-locate on request
let lastCandidates = null; // cached candidates with both routing durations

/* ── Bootstrap ─────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  panelEl   = document.getElementById('panel');
  listEl    = document.getElementById('shelter-list');
  locateBtn = document.getElementById('locate-btn');
  loadingEl = document.getElementById('loading');

  initMap();
  loadShelters();
  locateBtn.addEventListener('click', requestLocation);
  setupPanelDrag();
  setupTravelToggle();
  registerSW();
  requestLocation();
});

/** Initialize Leaflet map centered on Israel. */
function initMap() {
  map = L.map('map', {
    center: [31.5, 34.8],
    zoom: 8,
    zoomControl: false,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &amp; CARTO',
    maxZoom: 19,
  }).addTo(map);
}

/** Fetch the pre-processed shelter array: [[lat, lng, type], ...] */
async function loadShelters() {
  try {
    const res = await fetch('shelters.json');
    shelterData = await res.json();
    console.log(`Loaded ${shelterData.length} shelters`);
  } catch (err) {
    console.error('Failed to load shelter data:', err);
    alert('שגיאה בטעינת נתוני מקלטים');
  }
}

/* ── Travel mode toggle ────────────────────────────────── */

function setupTravelToggle() {
  document.getElementById('travel-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.travel-btn');
    if (!btn || btn.dataset.mode === travelMode) return;
    travelMode = btn.dataset.mode;
    document.querySelectorAll('.travel-btn').forEach(
      b => b.classList.toggle('active', b.dataset.mode === travelMode)
    );
    if (lastCandidates && lastPos) resortAndRender();
  });
}

/* ── Geolocation ───────────────────────────────────────── */

function requestLocation() {
  if (!navigator.geolocation) {
    alert('הדפדפן לא תומך באיתור מיקום');
    return;
  }

  // Call getCurrentPosition FIRST — must be synchronous from the click
  // handler for iOS Safari to recognize the user gesture.
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setUserMarker(lat, lng);
      showClosestShelters(lat, lng);
    },
    (err) => {
      loadingEl.classList.add('hidden');
      locateBtn.classList.remove('tracking');
      console.error('Geolocation error:', err.code, err.message);

      switch (err.code) {
        case err.PERMISSION_DENIED:
          alert('גישה למיקום נדחתה.\n\nיש לוודא ש"שירותי מיקום" מופעלים בהגדרות > פרטיות, ושהדפדפן מורשה לגשת למיקום.\n\nנדרשת גישה למיקום מדויק.');
          break;
        case err.POSITION_UNAVAILABLE:
          alert('לא ניתן לקבוע את המיקום. יש לוודא ששירותי המיקום מופעלים במכשיר.');
          break;
        case err.TIMEOUT:
          alert('חיפוש המיקום ארך יותר מדי זמן. נסה שוב במקום עם קליטה טובה יותר.');
          break;
        default:
          alert('שגיאה לא ידועה באיתור מיקום.');
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );

  // Update UI after the geolocation call is dispatched (not before)
  locateBtn.classList.add('tracking');
  loadingEl.classList.remove('hidden');
}

/* ── Map markers ───────────────────────────────────────── */

function setUserMarker(lat, lng) {
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'user-marker', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
    }).addTo(map).bindPopup('המיקום שלך');
  }
}

function clearShelterMarkers() {
  shelterMarkers.forEach(m => map.removeLayer(m));
  shelterMarkers = [];
}

/* ── OSRM routing ──────────────────────────────────────── */

/**
 * Query OSRM table service for one profile. Returns an array of durations
 * (seconds) parallel to `candidates`, or null on failure.
 *
 * OSRM table API: coordinates are lng,lat (longitude first).
 * sources=0 means only compute rows for the first coordinate (the user).
 * durations[0][0] = 0 (user→user), durations[0][i+1] = user→candidates[i].
 */
async function fetchOsrmDurations(userLat, userLng, candidates, profile) {
  try {
    const coords = [[userLng, userLat], ...candidates.map(s => [s.lng, s.lat])]
      .map(([lng, lat]) => `${lng},${lat}`)
      .join(';');
    const url = `https://router.project-osrm.org/table/v1/${profile}/${coords}?sources=0&annotations=duration`;

    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(`OSRM code: ${data.code}`);

    // Slice off index 0 (user→user = 0) to align with candidates array.
    return data.durations[0].slice(1);
  } catch (err) {
    console.error(`OSRM ${profile} failed, falling back to haversine:`, err);
    return null;
  }
}

/* ── Core logic: find & display closest shelters ───────── */

async function showClosestShelters(userLat, userLng) {
  if (!shelterData) {
    alert('נתוני מקלטים עדיין נטענים, נסה שוב');
    return;
  }

  lastPos = { lat: userLat, lng: userLng };
  loadingEl.classList.remove('hidden');

  // Calculate haversine distances and take the 20 closest as routing candidates.
  const withDist = shelterData.map(([lat, lng, type]) => ({
    lat, lng, type,
    dist: haversine(userLat, userLng, lat, lng),
  }));
  withDist.sort((a, b) => a.dist - b.dist);
  const candidates = withDist.slice(0, 20);

  // Fetch durations for current travel mode only.
  // If the user toggles later, the other profile is fetched then and cached.
  await fetchAndCacheDurations(userLat, userLng, candidates, travelMode);

  lastCandidates = candidates;
  loadingEl.classList.add('hidden');
  panelEl.classList.remove('collapsed');
  panelEl.classList.add('open');
  locateBtn.style.display = 'none';

  resortAndRender();
}

/**
 * Fetch OSRM durations for `profile` and store them on each candidate as
 * `footDuration` or `drivingDuration`. No-ops if already cached.
 */
async function fetchAndCacheDurations(userLat, userLng, candidates, profile) {
  const key = profile === 'foot' ? 'footDuration' : 'drivingDuration';
  if (candidates[0][key] !== undefined) return; // already cached
  const durations = await fetchOsrmDurations(userLat, userLng, candidates, profile);
  candidates.forEach((s, i) => { s[key] = durations ? durations[i] : null; });
}

/** Sort cached candidates by current travel mode and re-render. */
async function resortAndRender() {
  // Fetch the newly selected profile's durations if not yet cached.
  await fetchAndCacheDurations(lastPos.lat, lastPos.lng, lastCandidates, travelMode);

  const durationKey = travelMode === 'foot' ? 'footDuration' : 'drivingDuration';
  const sorted = [...lastCandidates].sort(
    (a, b) => (a[durationKey] ?? Infinity) - (b[durationKey] ?? Infinity)
  );
  const closest = sorted.slice(0, 5).map(s => ({
    ...s, routeDuration: s[durationKey],
  }));

  clearShelterMarkers();
  renderShelterMarkers(closest);
  renderShelterList(closest, lastPos.lat, lastPos.lng);
  fitMapBounds(closest, lastPos.lat, lastPos.lng);
}

function renderShelterMarkers(shelters) {
  shelters.forEach((s, i) => {
    const marker = L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: 'shelter-marker',
        html: `${i + 1}`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).addTo(map);

    marker.bindPopup(
      `<b>מקלט ${i + 1}</b><br>${s.type || 'מקלט'}` +
      `<br>${s.routeDuration != null ? formatDuration(s.routeDuration) : formatDist(s.dist)}`
    );

    marker.on('click', () => highlightCard(i));
    shelterMarkers.push(marker);
  });
}

function renderShelterList(shelters, userLat, userLng) {
  listEl.innerHTML = shelters.map((s, i) => `
    <div class="shelter-card" data-idx="${i}" onclick="onCardClick(${i})">
      <div class="shelter-num">${i + 1}</div>
      <div class="shelter-info">
        ${s.type ? `<div class="shelter-type">${s.type}</div>` : ''}
        <div class="shelter-distances">
          <span>${s.routeDuration != null ? formatDuration(s.routeDuration) : formatDist(s.dist)}</span>
        </div>
        <div class="nav-links">
          <a class="nav-link waze" href="${wazeUrl(s.lat, s.lng)}" target="_blank" onclick="event.stopPropagation()">
            Waze
          </a>
          <a class="nav-link gmaps" href="${gmapsUrl(s.lat, s.lng, userLat, userLng)}" target="_blank" onclick="event.stopPropagation()">
            Google Maps
          </a>
        </div>
      </div>
    </div>
  `).join('');
}

/** Zoom map to fit user + all 5 shelters, accounting for the open panel. */
function fitMapBounds(shelters, userLat, userLng) {
  const points = [[userLat, userLng], ...shelters.map(s => [s.lat, s.lng])];
  const bounds = L.latLngBounds(points);
  // The bottom panel covers ~55% of the viewport. Add enough bottom padding
  // so all markers are visible in the top portion of the map.
  const panelHeight = Math.round(window.innerHeight * 0.55);
  map.fitBounds(bounds, {
    paddingTopLeft: [40, 40],
    paddingBottomRight: [40, panelHeight + 20],
    maxZoom: 17,
  });
}

/* ── Interaction helpers ───────────────────────────────── */

/** Highlight a card and center map on the corresponding shelter. */
// eslint-disable-next-line no-unused-vars -- called from inline onclick
function onCardClick(idx) {
  highlightCard(idx);
  const marker = shelterMarkers[idx];
  if (marker) {
    map.setView(marker.getLatLng(), 17, { animate: true });
    marker.openPopup();
  }
}

function highlightCard(idx) {
  document.querySelectorAll('.shelter-card').forEach(c => c.classList.remove('active'));
  const card = document.querySelector(`.shelter-card[data-idx="${idx}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ── Panel drag to dismiss ─────────────────────────────── */

function setupPanelDrag() {
  const handle = document.getElementById('panel-handle');
  let startY = 0, currentY = 0, dragging = false;

  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    currentY = e.touches[0].clientY - startY;
    if (currentY > 0) {
      panelEl.style.transform = `translateY(${currentY}px)`;
    }
  }, { passive: true });

  handle.addEventListener('touchend', () => {
    dragging = false;
    panelEl.style.transform = '';
    if (currentY > 100) {
      panelEl.classList.remove('open');
      panelEl.classList.add('collapsed');
      locateBtn.style.display = '';
      locateBtn.classList.remove('tracking');
    }
    currentY = 0;
  });
}

/* ── Geo utilities ─────────────────────────────────────── */

/** Haversine distance in meters between two lat/lng points. */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format meters as human-readable distance. */
function formatDist(m) {
  return m < 1000 ? `${Math.round(m)} מ'` : `${(m / 1000).toFixed(1)} ק"מ`;
}

/** Format OSRM duration (seconds) as human-readable travel time. */
function formatDuration(sec) {
  const min = Math.round(sec / 60);
  return min < 1 ? `< 1 דק'` : `${min} דק'`;
}

/** Waze deep link to navigate to coordinates. */
function wazeUrl(lat, lng) {
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

/** Google Maps directions link (walking). */
function gmapsUrl(lat, lng, fromLat, fromLng) {
  return `https://www.google.com/maps/dir/${fromLat},${fromLng}/${lat},${lng}/@${lat},${lng},17z/data=!4m2!4m1!3e2`;
}

/* ── Service Worker ────────────────────────────────────── */

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('SW registered:', reg.scope))
      .catch(err => console.error('SW registration failed:', err));
  }
}
