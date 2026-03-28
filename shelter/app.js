/** Shelter Finder – finds the 5 closest bomb shelters and shows navigation options. */

const WALKING_SPEED_KMH = 5; // average walking speed
let map, userMarker, shelterMarkers = [], shelterData = null;
let panelEl, listEl, locateBtn, loadingEl;

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
  registerSW();
});

/** Initialize Leaflet map centered on Israel. */
function initMap() {
  map = L.map('map', {
    center: [31.5, 34.8],
    zoom: 8,
    zoomControl: false,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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

/* ── Geolocation ───────────────────────────────────────── */

function requestLocation() {
  if (!navigator.geolocation) {
    alert('הדפדפן לא תומך באיתור מיקום');
    return;
  }

  // Use watchPosition instead of getCurrentPosition — on some iOS Safari
  // versions, watchPosition reliably triggers the permission prompt while
  // getCurrentPosition silently denies with code 1.
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      navigator.geolocation.clearWatch(watchId);
      loadingEl.classList.add('hidden');
      const { latitude: lat, longitude: lng } = pos.coords;
      setUserMarker(lat, lng);
      showClosestShelters(lat, lng);
    },
    (err) => {
      navigator.geolocation.clearWatch(watchId);
      loadingEl.classList.add('hidden');
      locateBtn.classList.remove('tracking');
      console.error('Geolocation error:', err);

      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      switch (err.code) {
        case err.PERMISSION_DENIED:
          alert(isIOS
            ? 'גישה למיקום נדחתה.\n\nיש לוודא ש"שירותי מיקום" מופעלים בהגדרות > פרטיות > שירותי מיקום, ושהדפדפן מורשה לגשת למיקום.'
            : 'גישה למיקום נדחתה. אנא אשר הרשאת מיקום בדפדפן ונסה שוב.');
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
    { timeout: 15000, maximumAge: 30000 }
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

/* ── Core logic: find & display closest shelters ───────── */

function showClosestShelters(userLat, userLng) {
  if (!shelterData) {
    alert('נתוני מקלטים עדיין נטענים, נסה שוב');
    return;
  }

  // Calculate distances for all shelters
  const withDist = shelterData.map(([lat, lng, type]) => ({
    lat, lng, type,
    dist: haversine(userLat, userLng, lat, lng),
  }));

  // Sort and pick 5 closest
  withDist.sort((a, b) => a.dist - b.dist);
  const closest = withDist.slice(0, 5);

  clearShelterMarkers();
  renderShelterMarkers(closest);
  renderShelterList(closest, userLat, userLng);
  fitMapBounds(closest, userLat, userLng);

  // Open panel
  panelEl.classList.remove('collapsed');
  panelEl.classList.add('open');
  locateBtn.style.display = 'none';
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
      `<br>${formatDist(s.dist)} · ${formatWalk(s.dist)} הליכה`
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
          <span>${formatDist(s.dist)}</span>
          <span>~${formatWalk(s.dist)} הליכה</span>
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

/** Zoom map to fit user + all 5 shelters. */
function fitMapBounds(shelters, userLat, userLng) {
  const points = [[userLat, userLng], ...shelters.map(s => [s.lat, s.lng])];
  const bounds = L.latLngBounds(points);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
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

/** Approximate walking time string. */
function formatWalk(meters) {
  const minutes = Math.round(meters / (WALKING_SPEED_KMH * 1000 / 60));
  if (minutes < 1) return 'פחות מדקה';
  if (minutes < 60) return `${minutes} דק'`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} שע' ${m} דק'` : `${h} שע'`;
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
