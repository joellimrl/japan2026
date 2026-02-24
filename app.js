/* Japan 2026 itinerary viewer (GitHub Pages friendly)
  - Uses MapLibre GL JS + OpenFreeMap vector tiles (no API key)
  - Renders markers for each hotel stop + key day-by-day places
  - Forces basemap labels to prefer English/Latin (no Japanese labels)
*/

const STOPS = [
  {
    id: 'liber-osaka',
    name: 'LIBER HOTEL Osaka',
    city: 'Osaka',
    dates: '25–28 Apr 2026',
    position: { lat: 34.6656, lng: 135.4322 },
    details: 'Universal City / USJ area.'
  },
  {
    id: 'umekoji-kyoto',
    name: 'Umekoji Kodensho (Kyoto)',
    city: 'Kyoto',
    dates: '28–30 Apr 2026',
    position: { lat: 34.9852, lng: 135.7458 },
    details: 'Umekoji Park / Kyoto Railway Museum area.'
  },
  {
    id: 'remm-kobe',
    name: 'remm plus Kobe',
    city: 'Kobe',
    dates: '30 Apr–3 May 2026',
    position: { lat: 34.6943, lng: 135.1956 },
    details: 'Sannomiya area (approx.).'
  },
  {
    id: 'hiyori-namba',
    name: 'Hiyori Namba (Osaka)',
    city: 'Osaka',
    dates: '3–6 May 2026',
    position: { lat: 34.6646, lng: 135.5019 },
    details: 'Namba area.'
  }
];

// Key places referenced in the day-by-day plan.
// Coordinates are approximate and meant for map context (not navigation).
const POIS = {
  kix: {
    id: 'kix',
    name: 'Kansai International Airport (KIX)',
    position: { lat: 34.4347, lng: 135.2440 },
    details: 'Arrival/departure airport.'
  },
  usj: {
    id: 'usj',
    name: 'Universal Studios Japan (USJ)',
    position: { lat: 34.6654, lng: 135.4323 },
    details: 'Theme park (approx.).'
  },
  kyoto_station: {
    id: 'kyoto_station',
    name: 'Kyoto Station',
    position: { lat: 34.9858, lng: 135.7587 },
    details: 'Main rail hub (approx.).'
  },
  gion: {
    id: 'gion',
    name: 'Gion (kimono rental area)',
    position: { lat: 35.0037, lng: 135.7788 },
    details: 'Good base area for kimono rental (approx.).'
  },
  sannomiya: {
    id: 'sannomiya',
    name: 'Sannomiya (Kobe)',
    position: { lat: 34.6947, lng: 135.1950 },
    details: 'Central area (approx.).'
  },
  mouriya: {
    id: 'mouriya',
    name: 'Mouriya (Kobe beef)',
    position: { lat: 34.6946, lng: 135.1941 },
    details: 'Lunch option (approx.).'
  },
  wakkoqu: {
    id: 'wakkoqu',
    name: 'Wakkoqu (Kobe beef)',
    position: { lat: 34.6938, lng: 135.1950 },
    details: 'Lunch option (approx.).'
  },
  namba_station: {
    id: 'namba_station',
    name: 'Namba Station area',
    position: { lat: 34.6670, lng: 135.5015 },
    details: 'Transit hub (approx.).'
  },
  round1_namba: {
    id: 'round1_namba',
    name: 'Round1 Namba',
    position: { lat: 34.6681, lng: 135.5016 },
    details: 'Arcade/bowling complex (approx.).'
  }
};

const DAYS = [
  {
    date: '25 Apr 2026',
    stopId: 'liber-osaka',
    summary: 'Land at KIX → public transport to hotel → check-in.',
    poiIds: ['kix']
  },
  {
    date: '26 Apr 2026',
    stopId: 'liber-osaka',
    summary: 'Chill day. USJ from ~3pm onwards (buy 1.5-day ticket).',
    poiIds: ['usj']
  },
  {
    date: '27 Apr 2026',
    stopId: 'liber-osaka',
    summary: 'Full day at USJ.',
    poiIds: ['usj']
  },
  {
    date: '28 Apr 2026',
    stopId: 'umekoji-kyoto',
    summary: 'Checkout → travel to Kyoto → check-in at Umekoji.',
    poiIds: ['kyoto_station']
  },
  {
    date: '29 Apr 2026',
    stopId: 'umekoji-kyoto',
    summary: 'Explore Kyoto. Rent kimono etc.',
    poiIds: ['gion']
  },
  {
    date: '30 Apr 2026',
    stopId: 'remm-kobe',
    summary: 'Checkout → travel to Kobe → check-in at remm plus Kobe.',
    poiIds: ['sannomiya']
  },
  {
    date: '1 May 2026',
    stopId: 'remm-kobe',
    summary: 'Explore Kobe. Book higher-end Kobe beef lunch (Wakkoqu or Mouriya).',
    poiIds: ['mouriya', 'wakkoqu']
  },
  {
    date: '2 May 2026',
    stopId: 'remm-kobe',
    summary: 'Explore Kobe more.',
    poiIds: []
  },
  {
    date: '3 May 2026',
    stopId: 'hiyori-namba',
    summary: 'Checkout → travel to Osaka → check-in at Hiyori Namba.',
    poiIds: ['namba_station']
  },
  {
    date: '4 May 2026',
    stopId: 'hiyori-namba',
    summary: 'Explore Osaka main city area. Go to Round1 Namba.',
    poiIds: ['round1_namba']
  },
  {
    date: '5 May 2026',
    stopId: 'hiyori-namba',
    summary: 'More exploring and shopping.',
    poiIds: []
  },
  {
    date: '6 May 2026',
    stopId: 'hiyori-namba',
    summary: 'Public transport to KIX → fly back.',
    poiIds: ['kix']
  }
];

const PLANNED_DATES_INDEX = buildPlannedDatesIndex();

const BOOKING_ITEMS = [
  {
    id: 'usj_tickets',
    title: 'USJ tickets (1.5-day)',
    meta: 'Buy on 26 Apr (after ~3pm entry) for 26–27 Apr.'
  },
  {
    id: 'usj_express',
    title: 'USJ Express Pass (optional)',
    meta: 'Optional, depending on crowds + your must-rides.'
  },
  {
    id: 'kimono_rental',
    title: 'Kimono rental booking (Kyoto)',
    meta: 'Plan for 29 Apr.'
  },
  {
    id: 'kobe_beef',
    title: 'Kobe beef lunch reservation',
    meta: '1 May — choose Wakkoqu or Mouriya.'
  }
];

/** @type {any} */
let map = null;
/** @type {any[]} */
let markers = [];
/** @type {any[]} */
let poiMarkers = [];
/** @type {any} */
let activePopup = null;

/** @type {Map<string, { marker: any, element: HTMLElement }>} */
let stopMarkerById = new Map();
/** @type {Map<string, { marker: any, element: HTMLElement }>} */
let poiMarkerById = new Map();

/** @type {number | null} */
let focusedDayIndex = null;

const TRANSIT_ROUTE_SOURCE_ID = 'japan2026-transit-route';
const TRANSIT_ROUTE_LAYER_ID = 'japan2026-transit-route-line';

const STORAGE_KEY = 'japan2026-bookings-v1';

function qs(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

function getStopById(id) {
  return STOPS.find((s) => s.id === id) || null;
}

function getPoiById(id) {
  return POIS[id] || null;
}

let sidebarEventsBound = false;

function renderSidebar() {
  const container = qs('itinerary');

  const daysHtml = DAYS.map((day, dayIndex) => {
    const stop = getStopById(day.stopId);
    const stopLabel = stop ? stop.name : '';

    const pillParts = [];
    if (stop) {
      pillParts.push(`<span class="pill">${escapeHtml(stop.name)}</span>`);
    }

    for (const poiId of day.poiIds || []) {
      const poi = getPoiById(poiId);
      if (!poi) {
        continue;
      }
      pillParts.push(`<span class="pill">${escapeHtml(poi.name)}</span>`);
    }

    const pillsHtml = pillParts.length ? `<div class="dayPlaces">${pillParts.join('')}</div>` : '';

    return `
      <div class="dayItem">
        <div class="dayHeader">
          <div class="dayDate">${escapeHtml(day.date)}</div>
          <div class="dayStop">${escapeHtml(stopLabel)}</div>
        </div>
        <div class="daySummary">${escapeHtml(day.summary)}</div>
        ${pillsHtml}
        <div class="dayActions">
          <button type="button" data-action="focus" data-day-index="${dayIndex}">Focus</button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="dayList">
      ${daysHtml}
    </div>
  `;

  if (!sidebarEventsBound) {
    sidebarEventsBound = true;
    container.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.getAttribute('data-action');
      const idxRaw = target.getAttribute('data-day-index');
      if (!action || idxRaw == null) {
        return;
      }

      const dayIndex = Number(idxRaw);
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= DAYS.length) {
        return;
      }

      if (action === 'focus') {
        focusDay(dayIndex);
      }
    });
  }
}

function focusDay(dayIndex) {
  if (!map) {
    return;
  }

  setFocusedDay(dayIndex);

  const day = DAYS[dayIndex];
  const stop = getStopById(day.stopId);
  if (!stop) {
    return;
  }

  const transit = getTransitLegForDay(dayIndex);
  const focusPoints = getDayFocusPoints(day, { transit });

  const bounds = new window.maplibregl.LngLatBounds();
  for (const point of focusPoints) {
    bounds.extend([point.lng, point.lat]);
  }

  map.fitBounds(bounds, { padding: 70, duration: 650 });
}

function setFocusedDay(dayIndex) {
  focusedDayIndex = dayIndex;

  const day = DAYS[dayIndex];
  if (!day) {
    clearFocusedDay();
    return;
  }

  const stopIds = new Set();
  const poiIds = new Set();

  if (typeof day.stopId === 'string') {
    stopIds.add(day.stopId);
  }
  for (const poiId of day.poiIds || []) {
    if (typeof poiId === 'string') {
      poiIds.add(poiId);
    }
  }

  const transit = getTransitLegForDay(dayIndex);
  if (transit) {
    if (transit.from.type === 'stop') {
      stopIds.add(transit.from.id);
    } else if (transit.from.type === 'poi') {
      poiIds.add(transit.from.id);
    }

    if (transit.to.type === 'stop') {
      stopIds.add(transit.to.id);
    } else if (transit.to.type === 'poi') {
      poiIds.add(transit.to.id);
    }
  }

  applyMarkerHighlight({ stopIds, poiIds });
  applyTransitRoute(transit);
}

function clearFocusedDay() {
  focusedDayIndex = null;
  applyMarkerHighlight({ stopIds: new Set(), poiIds: new Set() });
  applyTransitRoute(null);
}

function applyMarkerHighlight({ stopIds, poiIds }) {
  for (const [stopId, entry] of stopMarkerById.entries()) {
    entry.element.classList.toggle('is-highlight', stopIds.has(stopId));
  }

  for (const [poiId, entry] of poiMarkerById.entries()) {
    entry.element.classList.toggle('is-highlight', poiIds.has(poiId));
  }
}

function ensureTransitLayer() {
  if (!map || !map.getSource || !map.addSource) {
    return;
  }

  try {
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
      return;
    }
  } catch {
    return;
  }

  try {
    if (!map.getSource(TRANSIT_ROUTE_SOURCE_ID)) {
      map.addSource(TRANSIT_ROUTE_SOURCE_ID, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });
    }

    if (!map.getLayer(TRANSIT_ROUTE_LAYER_ID)) {
      map.addLayer({
        id: TRANSIT_ROUTE_LAYER_ID,
        type: 'line',
        source: TRANSIT_ROUTE_SOURCE_ID,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': 'none'
        },
        paint: {
          'line-color': '#333',
          'line-width': 4,
          'line-opacity': 0.75
        }
      });
    }
  } catch {
    // Style may still be initializing; ignore.
  }
}

function applyTransitRoute(transit) {
  if (!map || !map.getSource) {
    return;
  }

  try {
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
      return;
    }
  } catch {
    return;
  }

  ensureTransitLayer();

  const source = map.getSource(TRANSIT_ROUTE_SOURCE_ID);
  if (!source || typeof source.setData !== 'function') {
    return;
  }

  if (!transit) {
    source.setData({ type: 'FeatureCollection', features: [] });
    try {
      map.setLayoutProperty(TRANSIT_ROUTE_LAYER_ID, 'visibility', 'none');
    } catch {
      // ignore
    }
    return;
  }

  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [transit.from.position.lng, transit.from.position.lat],
            [transit.to.position.lng, transit.to.position.lat]
          ]
        }
      }
    ]
  });

  try {
    map.setLayoutProperty(TRANSIT_ROUTE_LAYER_ID, 'visibility', 'visible');
  } catch {
    // ignore
  }
}

function getTransitLegForDay(dayIndex) {
  const day = DAYS[dayIndex];
  if (!day) {
    return null;
  }

  const lastDayIndex = DAYS.length - 1;

  // Special-case: first and last day should show KIX ↔ hotel route if KIX is part of that day's POIs.
  if ((dayIndex === 0 || dayIndex === lastDayIndex) && Array.isArray(day.poiIds) && day.poiIds.includes('kix')) {
    const kix = getPoiById('kix');
    const stop = day.stopId ? getStopById(day.stopId) : null;
    if (kix && stop) {
      if (dayIndex === 0) {
        return {
          from: { type: 'poi', id: kix.id, position: { lng: kix.position.lng, lat: kix.position.lat } },
          to: { type: 'stop', id: stop.id, position: { lng: stop.position.lng, lat: stop.position.lat } }
        };
      }

      return {
        from: { type: 'stop', id: stop.id, position: { lng: stop.position.lng, lat: stop.position.lat } },
        to: { type: 'poi', id: kix.id, position: { lng: kix.position.lng, lat: kix.position.lat } }
      };
    }
  }

  const prevDay = dayIndex > 0 ? DAYS[dayIndex - 1] : null;

  if (!prevDay) {
    return null;
  }
  if (!day.stopId || !prevDay.stopId || day.stopId === prevDay.stopId) {
    return null;
  }

  const fromStop = getStopById(prevDay.stopId);
  const toStop = getStopById(day.stopId);
  if (!fromStop || !toStop) {
    return null;
  }

  return {
    from: { type: 'stop', id: fromStop.id, position: { lng: fromStop.position.lng, lat: fromStop.position.lat } },
    to: { type: 'stop', id: toStop.id, position: { lng: toStop.position.lng, lat: toStop.position.lat } }
  };
}

function getDayFocusPoints(day, { transit }) {
  const points = [];

  const stop = day && day.stopId ? getStopById(day.stopId) : null;
  if (stop) {
    points.push({ lng: stop.position.lng, lat: stop.position.lat });
  }

  for (const poiId of (day && day.poiIds) || []) {
    const poi = getPoiById(poiId);
    if (!poi) {
      continue;
    }
    points.push({ lng: poi.position.lng, lat: poi.position.lat });
  }

  if (transit) {
    points.push({ lng: transit.from.position.lng, lat: transit.from.position.lat });
    points.push({ lng: transit.to.position.lng, lat: transit.to.position.lat });
  }

  // Deduplicate identical coords.
  const seen = new Set();
  const unique = [];
  for (const p of points) {
    const key = `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

function buildPlannedDatesIndex() {
  /** @type {Map<string, Set<string>>} */
  const stopDates = new Map();
  /** @type {Map<string, Set<string>>} */
  const poiDates = new Map();

  for (const day of DAYS) {
    if (day.stopId) {
      if (!stopDates.has(day.stopId)) {
        stopDates.set(day.stopId, new Set());
      }
      stopDates.get(day.stopId).add(day.date);
    }

    for (const poiId of day.poiIds || []) {
      if (!poiDates.has(poiId)) {
        poiDates.set(poiId, new Set());
      }
      poiDates.get(poiId).add(day.date);
    }
  }

  return { stopDates, poiDates };
}

function parseDayDate(dateStr) {
  // Expected format: "25 Apr 2026" (English month abbreviations)
  const match = String(dateStr).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const monthRaw = match[2].toLowerCase();
  const year = Number(match[3]);
  const monthIndex = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  }[monthRaw];

  if (!Number.isFinite(day) || !Number.isFinite(year) || monthIndex == null) {
    return null;
  }

  // Use noon local time to avoid DST edge cases.
  return new Date(year, monthIndex, day, 12, 0, 0, 0);
}

function formatDateRangeShort(start, end) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate()) {
    return `${start.getDate()} ${months[start.getMonth()]}`;
  }

  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${start.getDate()}–${end.getDate()} ${months[start.getMonth()]}`;
  }

  return `${start.getDate()} ${months[start.getMonth()]}–${end.getDate()} ${months[end.getMonth()]}`;
}

function formatPlannedDatesShort(dateStrings) {
  const dates = (dateStrings || [])
    .map(parseDayDate)
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  if (!dates.length) {
    return '';
  }

  const groups = [];
  let groupStart = dates[0];
  let prev = dates[0];

  for (let i = 1; i < dates.length; i += 1) {
    const cur = dates[i];
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      prev = cur;
      continue;
    }
    groups.push([groupStart, prev]);
    groupStart = cur;
    prev = cur;
  }
  groups.push([groupStart, prev]);

  return groups.map(([s, e]) => formatDateRangeShort(s, e)).join(' / ');
}

function getPlannedDatesForStop(stopId) {
  const set = PLANNED_DATES_INDEX.stopDates.get(stopId);
  if (!set) {
    return [];
  }
  return Array.from(set);
}

function getPlannedDatesForPoi(poiId) {
  const set = PLANNED_DATES_INDEX.poiDates.get(poiId);
  if (!set) {
    return [];
  }
  return Array.from(set);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clearMapOverlays() {
  for (const marker of markers) {
    try {
      marker.remove();
    } catch {
      // ignore
    }
  }
  markers = [];

  stopMarkerById = new Map();

  for (const marker of poiMarkers) {
    try {
      marker.remove();
    } catch {
      // ignore
    }
  }
  poiMarkers = [];

  poiMarkerById = new Map();

  try {
    if (activePopup && typeof activePopup.remove === 'function') {
      activePopup.remove();
    }
  } catch {
    // ignore
  }
  activePopup = null;
}

function showMapError(message) {
  const mapEl = qs('map');
  mapEl.style.position = 'relative';
  mapEl.innerHTML = `
    <div class="mapOverlay">
      <div class="overlayCard">
        <h2>Map failed to load</h2>
        <p class="muted">${escapeHtml(message)}</p>
      </div>
    </div>
  `;
}

function setEnglishLabels() {
  if (!map || !map.getStyle) {
    return;
  }

  const style = map.getStyle();
  const layers = style && Array.isArray(style.layers) ? style.layers : [];

  // OpenFreeMap's default styles often show both latin + non-latin names.
  // Override that so we only show English/latin (no Japanese line).
  const englishTextField = [
    'coalesce',
    ['get', 'name_en'],
    ['get', 'name:en'],
    ['get', 'name:latin'],
    ['get', 'name']
  ];

  for (const layer of layers) {
    if (!layer || layer.type !== 'symbol' || !layer.layout) {
      continue;
    }

    const textField = layer.layout['text-field'];
    if (!textField || !Array.isArray(textField)) {
      continue;
    }

    const serialized = JSON.stringify(textField);
    if (
      !serialized.includes('name:nonlatin') &&
      !serialized.includes('name:latin') &&
      !serialized.includes('name_en') &&
      !serialized.includes('name')
    ) {
      continue;
    }

    try {
      map.setLayoutProperty(layer.id, 'text-field', englishTextField);
    } catch {
      // Some layers might not be modifiable depending on style state; ignore.
    }
  }
}

function buildMap() {
  const mapEl = qs('map');

  if (!window.maplibregl) {
    throw new Error('MapLibre failed to load.');
  }

  if (map) {
    clearMapOverlays();
    map.remove();
    map = null;
  }

  map = new window.maplibregl.Map({
    container: mapEl,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [STOPS[0].position.lng, STOPS[0].position.lat],
    zoom: 10,
    attributionControl: true
  });

  map.addControl(new window.maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  map.addControl(
    new window.maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap'
    })
  );

  map.on('load', () => {
    setEnglishLabels();

    ensureTransitLayer();

    markers = STOPS.map((stop, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'markerWrap';

      const el = document.createElement('div');
      el.className = 'mapMarker';
      el.textContent = String(idx + 1);

      const dateEl = document.createElement('div');
      dateEl.className = 'markerDate';
      dateEl.textContent = formatPlannedDatesShort(getPlannedDatesForStop(stop.id));
      dateEl.hidden = !dateEl.textContent;

      wrap.append(dateEl, el);

      const popup = new window.maplibregl.Popup({ offset: 18 }).setHTML(
        `
          <div style="min-width:220px">
            <div style="font-weight:700;margin-bottom:4px">${idx + 1}. ${escapeHtml(stop.name)}</div>
            <div style="margin-bottom:6px">${escapeHtml(stop.dates)}</div>
            <div style="color:#555">${escapeHtml(stop.city)} • ${escapeHtml(stop.details)}</div>
          </div>
        `
      );

      const marker = new window.maplibregl.Marker({ element: wrap, anchor: 'bottom' })
        .setLngLat([stop.position.lng, stop.position.lat])
        .setPopup(popup)
        .addTo(map);

      stopMarkerById.set(stop.id, { marker, element: wrap });

      // MapLibre attaches its own click handler when a popup is set.
      // Use a capturing listener + stopImmediatePropagation so we don't double-toggle.
      wrap.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          selectStop(idx, { zoom: null, openPopup: true });
        },
        true
      );
      return marker;
    });

    poiMarkers = Object.values(POIS).map((poi) => {
      const wrap = document.createElement('div');
      wrap.className = 'markerWrap';

      const el = document.createElement('div');
      el.className = 'mapMarker poi';
      el.textContent = '•';

      const dateEl = document.createElement('div');
      dateEl.className = 'markerDate';
      dateEl.textContent = formatPlannedDatesShort(getPlannedDatesForPoi(poi.id));
      dateEl.hidden = !dateEl.textContent;

      wrap.append(dateEl, el);

      const planned = formatPlannedDatesShort(getPlannedDatesForPoi(poi.id));
      const plannedHtml = planned ? `<div style="margin-bottom:6px">Planned: ${escapeHtml(planned)}</div>` : '';

      const popup = new window.maplibregl.Popup({ offset: 16 }).setHTML(
        `
          <div style="min-width:220px">
            <div style="font-weight:700;margin-bottom:4px">${escapeHtml(poi.name)}</div>
            ${plannedHtml}
            <div style="color:#555">${escapeHtml(poi.details || '')}</div>
          </div>
        `
      );

      const marker = new window.maplibregl.Marker({ element: wrap, anchor: 'bottom' })
        .setLngLat([poi.position.lng, poi.position.lat])
        .setPopup(popup)
        .addTo(map);

      poiMarkerById.set(poi.id, { marker, element: wrap });

      wrap.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          openMarkerPopup(marker);
        },
        true
      );

      return marker;
    });

    const bounds = new window.maplibregl.LngLatBounds();
    for (const stop of STOPS) {
      bounds.extend([stop.position.lng, stop.position.lat]);
    }
    for (const poi of Object.values(POIS)) {
      bounds.extend([poi.position.lng, poi.position.lat]);
    }
    map.fitBounds(bounds, { padding: 40 });

    // Re-apply focus highlights/route if the user clicked before the map finished loading.
    if (typeof focusedDayIndex === 'number') {
      setFocusedDay(focusedDayIndex);
    }
  });

  // Some style changes happen after load; re-apply on style updates.
  map.on('styledata', () => {
    if (!map) {
      return;
    }
    setEnglishLabels();

    // Style reloads can drop custom layers/sources.
    ensureTransitLayer();
    if (typeof focusedDayIndex === 'number') {
      setFocusedDay(focusedDayIndex);
    }
  });
}

function selectStop(index, { zoom, openPopup } = {}) {
  if (!map) {
    return;
  }

  const stop = STOPS[index];

  const center = [stop.position.lng, stop.position.lat];
  if (typeof zoom === 'number') {
    map.easeTo({ center, zoom, duration: 650 });
  } else {
    map.easeTo({ center, duration: 650 });
  }

  const marker = markers[index];
  if (marker && openPopup !== false) {
    openMarkerPopup(marker);
  }
}

function openMarkerPopup(marker) {
  if (!map || !marker || !marker.getPopup) {
    return;
  }

  const popup = marker.getPopup();
  if (!popup) {
    return;
  }

  if (activePopup && activePopup !== popup) {
    try {
      activePopup.remove();
    } catch {
      // ignore
    }
  }

  activePopup = popup;
  if (!popup.__japan2026Bound && typeof popup.on === 'function') {
    popup.__japan2026Bound = true;
    popup.on('close', () => {
      if (activePopup === popup) {
        activePopup = null;
      }
    });
  }

  try {
    if (typeof marker.getLngLat === 'function' && typeof popup.setLngLat === 'function') {
      popup.setLngLat(marker.getLngLat());
    }
  } catch {
    // ignore
  }

  try {
    if (typeof popup.isOpen === 'function' && popup.isOpen()) {
      return;
    }
  } catch {
    // ignore
  }

  try {
    popup.addTo(map);
  } catch {
    // ignore
  }
}

function loadBookingState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const checked = parsed && Array.isArray(parsed.checked) ? parsed.checked : [];
    return new Set(checked.filter((id) => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function saveBookingState(checkedSet) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ checked: Array.from(checkedSet) }));
  } catch {
    // ignore
  }
}

let bookingsEventsBound = false;

function renderBookings() {
  const container = qs('bookings');
  const checked = loadBookingState();

  const doneCount = BOOKING_ITEMS.filter((i) => checked.has(i.id)).length;
  const totalCount = BOOKING_ITEMS.length;

  const itemsHtml = BOOKING_ITEMS.map((item) => {
    const isDone = checked.has(item.id);
    return `
      <label class="checkItem ${isDone ? 'done' : ''}">
        <input type="checkbox" data-check-id="${escapeHtml(item.id)}" ${isDone ? 'checked' : ''} />
        <div>
          <div class="checkTitle">${escapeHtml(item.title)}</div>
          <div class="checkMeta">${escapeHtml(item.meta || '')}</div>
        </div>
      </label>
    `;
  }).join('');

  container.innerHTML = `
    <div class="checklist">
      <div class="checkSummary muted">${doneCount}/${totalCount} done</div>
      ${itemsHtml}
    </div>
  `;

  if (!bookingsEventsBound) {
    bookingsEventsBound = true;
    container.addEventListener('change', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      const id = target.getAttribute('data-check-id');
      if (!id) {
        return;
      }

      const next = loadBookingState();
      if (target.checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      saveBookingState(next);
      renderBookings();
    });
  }
}

function main() {
  renderSidebar();
  renderBookings();

  try {
    buildMap();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err);
    showMapError(msg);
  }
}

main();
