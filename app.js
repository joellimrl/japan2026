/* Japan 2026 itinerary viewer (GitHub Pages friendly)
  - Uses MapLibre GL JS + OpenFreeMap vector tiles (no API key)
  - Renders markers for each hotel stop + key day-by-day places
  - Forces basemap labels to prefer English/Latin (no Japanese labels)
*/

const COLLECTION_NAME = 'japan2026';
const KEY_STORAGE_KEY = 'japan2026-key-v1';
const PROD_API_BASE = 'https://streetbot.fly.dev';

// API requests go directly to the production API (CORS is handled upstream).
const API_BASE = PROD_API_BASE;
const AUTH_HEADER_NAME = ['x', '-', 'auth'].join('');

// Japan-wide default (blank map state)
const DEFAULT_CENTER = { lng: 138.2529, lat: 36.2048 };
const DEFAULT_ZOOM = 4.6;

function parsePlaceKey(key) {
  const raw = String(key || '');
  const stopPrefix = 'stop:';
  const poiPrefix = 'poi:';
  if (raw.startsWith(stopPrefix)) {
    return { type: 'stop', id: raw.slice(stopPrefix.length) };
  }
  if (raw.startsWith(poiPrefix)) {
    return { type: 'poi', id: raw.slice(poiPrefix.length) };
  }
  return null;
}

function parseDayKey(key) {
  const raw = String(key || '');
  const dayPrefix = 'day:';
  if (raw.startsWith(dayPrefix)) {
    return { type: 'day', id: raw.slice(dayPrefix.length) };
  }
  return null;
}
// Places are embedded in this file (fully static).
/** @type {any[]} */
let stops = [];
/** @type {Record<string, any>} */
let pois = {};

// Day-by-day itinerary is embedded in this file.
/** @type {any[]} */
let days = [];

/** @type {{ stopDates: Map<string, Set<string>>, poiDates: Map<string, Set<string>> }} */
let plannedDatesIndex = buildPlannedDatesIndex([]);

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

function qs(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

function getStopById(id) {
  return stops.find((s) => s.id === id) || null;
}

function getPoiById(id) {
  return pois[id] || null;
}

let sidebarEventsBound = false;

function getAllPoisSorted() {
  return Object.values(pois || {})
    .filter(Boolean)
    .map((p) => ({
      id: String(p.id || ''),
      name: String(p.name || p.id || '').trim(),
      location: String(p.location || '').trim(),
      details: String(p.details || '').trim()
    }))
    .filter((p) => p.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getPoiSuggestionMatches(query, { excludeIds } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return [];
  }

  const excludeSet = excludeIds instanceof Set ? excludeIds : null;

  const all = getAllPoisSorted();
  const matches = [];
  for (const p of all) {
    if (excludeSet && excludeSet.has(p.id)) {
      continue;
    }
    const hay = `${p.name} ${p.location} ${p.id}`.toLowerCase();
    if (hay.includes(q)) {
      matches.push(p);
    }
    if (matches.length >= 12) {
      break;
    }
  }
  return matches;
}

function getExcludedPoiIdsForDay(dayIndex) {
  const day = days && Number.isInteger(dayIndex) ? days[dayIndex] : null;
  const exclude = new Set();
  for (const id of (day && day.poiIds) || []) {
    const clean = String(id || '').trim();
    if (clean) {
      exclude.add(clean);
    }
  }
  return exclude;
}

function persistDayUpdate(dayIndex) {
  const day = days[dayIndex];
  if (!day) {
    return Promise.resolve();
  }

  const rec = { key: day.key, date: day.date, stopId: day.stopId, summary: day.summary, poiIds: day.poiIds };
  return updateStorageRecord(rec).then(() => {
    setAuthStatus('Day updated');
    plannedDatesIndex = buildPlannedDatesIndex(days);
    renderSidebar();
    try {
      buildMap();
    } catch {
      // ignore
    }
  });
}

function addPoiToDay(dayIndex, poiIdRaw) {
  const day = days[dayIndex];
  if (!day) {
    return Promise.resolve();
  }
  const poiId = String(poiIdRaw || '').trim();
  if (!poiId) {
    return Promise.resolve();
  }
  if (!getPoiById(poiId)) {
    setAuthStatus(`Unknown POI id: ${poiId}`);
    return Promise.resolve();
  }
  if (!Array.isArray(day.poiIds)) {
    day.poiIds = [];
  }
  if (day.poiIds.includes(poiId)) {
    return Promise.resolve();
  }

  day.poiIds.push(poiId);
  return persistDayUpdate(dayIndex);
}

function removePoiFromDay(dayIndex, poiIdRaw) {
  const day = days[dayIndex];
  if (!day || !Array.isArray(day.poiIds)) {
    return Promise.resolve();
  }
  const poiId = String(poiIdRaw || '').trim();
  if (!poiId) {
    return Promise.resolve();
  }
  const next = day.poiIds.filter((id) => String(id) !== poiId);
  if (next.length === day.poiIds.length) {
    return Promise.resolve();
  }
  day.poiIds = next;
  return persistDayUpdate(dayIndex);
}

function renderPoiSuggest(suggestEl, matches) {
  if (!suggestEl) {
    return;
  }

  if (!matches || matches.length === 0) {
    suggestEl.innerHTML = '';
    suggestEl.hidden = true;
    suggestEl.dataset.activeIndex = '-1';
    return;
  }

  suggestEl.hidden = false;
  suggestEl.dataset.activeIndex = '0';
  suggestEl.innerHTML = matches
    .map((p, idx) => {
      const activeClass = idx === 0 ? ' is-active' : '';
      return `
        <button type="button" class="poiSuggestItem${activeClass}" data-action="pick-poi" data-poi-id="${escapeHtml(p.id)}">
          <span class="poiSuggestName">${escapeHtml(p.name || p.id)}</span>
          <span class="poiSuggestId">${escapeHtml(p.id)}</span>
        </button>
      `;
    })
    .join('');
}

function renderSidebar() {
  const container = qs('itinerary');

  const dayPanel = document.getElementById('dayPanel');
  if (dayPanel) {
    dayPanel.hidden = !Array.isArray(days) || days.length === 0;
  }

  if (!Array.isArray(days) || days.length === 0) {
    container.innerHTML = '';
    return;
  }

  const daysHtml = days
    .map((day, dayIndex) => {
      const stop = getStopById(day.stopId);
      const stopLabel = stop ? stop.name : '';

      const pillParts = [];

      for (const poiId of day.poiIds || []) {
        const poi = getPoiById(poiId);
        if (!poi) {
          continue;
        }
        pillParts.push(
          `<span class="pill" data-poi-id="${escapeHtml(poi.id)}">` +
            `<span class="pillText">${escapeHtml(poi.name)}</span>` +
            `<button type="button" class="pillRemove" aria-label="Remove" data-action="remove-poi" data-day-index="${dayIndex}" data-poi-id="${escapeHtml(poi.id)}">×</button>` +
          `</span>`
        );
      }

      const pillsHtml = `
        <div class="dayPlaces" data-day-index="${dayIndex}">
          <div class="dayPlacesPills">${pillParts.join('')}</div>
          <input type="text" class="poiAddInput" placeholder="Type to add POI" autocomplete="off" spellcheck="false" autocapitalize="off" data-day-index="${dayIndex}" />
          <div class="poiSuggest" hidden data-day-index="${dayIndex}"></div>
        </div>
      `;

      return `
        <div class="dayItem">
          <div class="dayHeader">
            <div class="dayDate">${escapeHtml(day.date)}</div>
            <div class="dayStop">${escapeHtml(stopLabel)}</div>
          </div>
          <div class="daySummary" contenteditable="true" data-edit="summary" data-day-index="${dayIndex}">${escapeHtml(day.summary)}</div>
          ${pillsHtml}
          <div class="dayActions">
            <button type="button" data-action="focus" data-day-index="${dayIndex}">Focus</button>
          </div>
        </div>
      `;
    })
    .join('');

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

      const actionEl = target.closest('[data-action]');
      if (!(actionEl instanceof HTMLElement)) {
        // Still allow focusing the POI input by clicking the POI area.
        const dayPlaces = target.closest('.dayPlaces');
        if (dayPlaces instanceof HTMLElement) {
          const input = dayPlaces.querySelector('.poiAddInput');
          if (input instanceof HTMLInputElement) {
            try {
              input.focus();
            } catch {
              // ignore
            }
          }
        }
        return;
      }

      const action = actionEl.getAttribute('data-action');
      if (action === 'focus') {
        const idxRaw = actionEl.getAttribute('data-day-index');
        if (idxRaw == null) {
          return;
        }
        const dayIndex = Number(idxRaw);
        if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) {
          return;
        }
        focusDay(dayIndex);
        return;
      }

      if (action === 'remove-poi') {
        const idxRaw = actionEl.getAttribute('data-day-index');
        const poiId = actionEl.getAttribute('data-poi-id');
        const dayIndex = Number(idxRaw);
        if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) {
          return;
        }
        removePoiFromDay(dayIndex, poiId).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setAuthStatus(`Update failed: ${msg}`);
        });
        return;
      }

      if (action === 'pick-poi') {
        const poiId = actionEl.getAttribute('data-poi-id');
        const dayPlaces = actionEl.closest('.dayPlaces');
        if (!(dayPlaces instanceof HTMLElement)) {
          return;
        }
        const idxRaw = dayPlaces.getAttribute('data-day-index');
        const dayIndex = Number(idxRaw);
        if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) {
          return;
        }

        addPoiToDay(dayIndex, poiId)
          .then(() => {
            // After re-render, no direct DOM to clear; status already updated.
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setAuthStatus(`Update failed: ${msg}`);
          });
        return;
      }
    });

    container.addEventListener('input', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      if (!target.classList.contains('poiAddInput')) {
        return;
      }

      const dayPlaces = target.closest('.dayPlaces');
      if (!(dayPlaces instanceof HTMLElement)) {
        return;
      }
      const suggestEl = dayPlaces.querySelector('.poiSuggest');
      if (!(suggestEl instanceof HTMLElement)) {
        return;
      }

      const idxRaw = dayPlaces.getAttribute('data-day-index');
      const dayIndex = Number(idxRaw);
      const excludeIds = Number.isInteger(dayIndex) ? getExcludedPoiIdsForDay(dayIndex) : new Set();

      const matches = getPoiSuggestionMatches(target.value, { excludeIds });
      renderPoiSuggest(suggestEl, matches);
    });

    container.addEventListener(
      'keydown',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        if (!target.classList.contains('poiAddInput')) {
          return;
        }

        const dayPlaces = target.closest('.dayPlaces');
        if (!(dayPlaces instanceof HTMLElement)) {
          return;
        }
        const suggestEl = dayPlaces.querySelector('.poiSuggest');
        if (!(suggestEl instanceof HTMLElement)) {
          return;
        }

        const items = Array.from(suggestEl.querySelectorAll('.poiSuggestItem'));
        const isOpen = !suggestEl.hidden && items.length > 0;
        const activeIndex = Number(suggestEl.dataset.activeIndex || '-1');

        const setActive = (nextIndex) => {
          const idx = Math.max(0, Math.min(items.length - 1, nextIndex));
          suggestEl.dataset.activeIndex = String(idx);
          for (let i = 0; i < items.length; i += 1) {
            items[i].classList.toggle('is-active', i === idx);
          }
        };

        if (e.key === 'Escape') {
          suggestEl.hidden = true;
          suggestEl.innerHTML = '';
          suggestEl.dataset.activeIndex = '-1';
          return;
        }

        if (e.key === 'ArrowDown' && isOpen) {
          e.preventDefault();
          setActive(Number.isFinite(activeIndex) ? activeIndex + 1 : 0);
          return;
        }

        if (e.key === 'ArrowUp' && isOpen) {
          e.preventDefault();
          setActive(Number.isFinite(activeIndex) ? activeIndex - 1 : 0);
          return;
        }

        if (e.key === 'Enter') {
          const typed = String(target.value || '').trim();
          const idxRaw = dayPlaces.getAttribute('data-day-index');
          const dayIndex = Number(idxRaw);
          if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) {
            return;
          }

          if (isOpen) {
            e.preventDefault();
            const idx = Number.isFinite(activeIndex) && activeIndex >= 0 ? activeIndex : 0;
            const btn = items[idx];
            if (btn instanceof HTMLElement) {
              const poiId = btn.getAttribute('data-poi-id');
              addPoiToDay(dayIndex, poiId)
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  setAuthStatus(`Update failed: ${msg}`);
                });
            }
            return;
          }

          // If the dropdown isn't open, allow quick-add by exact id or exact unique name.
          if (typed) {
            // If it's already on the day, do nothing.
            if (Array.isArray(days[dayIndex].poiIds) && days[dayIndex].poiIds.includes(typed)) {
              return;
            }

            const byId = getPoiById(typed);
            if (byId) {
              e.preventDefault();
              addPoiToDay(dayIndex, typed)
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  setAuthStatus(`Update failed: ${msg}`);
                });
              return;
            }

            const all = getAllPoisSorted();
            const matchesByName = all.filter((p) => p.name.toLowerCase() === typed.toLowerCase());
            if (matchesByName.length === 1) {
              e.preventDefault();
              addPoiToDay(dayIndex, matchesByName[0].id)
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  setAuthStatus(`Update failed: ${msg}`);
                });
            }
          }
        }
      },
      true
    );

    container.addEventListener(
      'blur',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        if (!target.classList.contains('poiAddInput')) {
          return;
        }

        const dayPlaces = target.closest('.dayPlaces');
        if (!(dayPlaces instanceof HTMLElement)) {
          return;
        }
        const suggestEl = dayPlaces.querySelector('.poiSuggest');
        if (!(suggestEl instanceof HTMLElement)) {
          return;
        }

        // Delay so clicks on suggestion items still work.
        setTimeout(() => {
          try {
            if (dayPlaces.contains(document.activeElement)) {
              return;
            }
          } catch {
            // ignore
          }
          suggestEl.hidden = true;
          suggestEl.innerHTML = '';
          suggestEl.dataset.activeIndex = '-1';
        }, 120);
      },
      true
    );

    // Track original values for contenteditable fields so we can avoid
    // calling the storage endpoint when nothing changed.
    container.addEventListener(
      'focusin',
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const edit = target.getAttribute('data-edit');
        const idxRaw = target.getAttribute('data-day-index');
        if (!edit || idxRaw == null) {
          return;
        }

        target.dataset.originalValue = String(target.textContent || '').trim();
      },
      true
    );

    // Handle contenteditable saves (Enter or blur)
    container.addEventListener('keydown', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const edit = target.getAttribute('data-edit');
      const idxRaw = target.getAttribute('data-day-index');
      if (!edit || idxRaw == null) {
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        try {
          target.blur();
        } catch {
          // ignore
        }
      }
    }, true);

    container.addEventListener('blur', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const edit = target.getAttribute('data-edit');
      const idxRaw = target.getAttribute('data-day-index');
      if (!edit || idxRaw == null) {
        return;
      }
      const dayIndex = Number(idxRaw);
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) {
        return;
      }
      const day = days[dayIndex];
      if (!day) {
        return;
      }
      const newValue = String(target.textContent || '').trim();
      if (edit !== 'summary') {
        return;
      }

      const originalValue = String(target.dataset.originalValue ?? day.summary ?? '').trim();
      if (newValue === originalValue) {
        return;
      }

      day.summary = newValue;
      const rec = { key: day.key, date: day.date, stopId: day.stopId, summary: day.summary, poiIds: day.poiIds };
      updateStorageRecord(rec).then(() => {
        setAuthStatus('Day updated');
        plannedDatesIndex = buildPlannedDatesIndex(days);
        renderSidebar();
        try {
          buildMap();
        } catch {
          // ignore
        }
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setAuthStatus(`Update failed: ${msg}`);
      });
    }, true);
  }
}

function focusDay(dayIndex) {
  if (!map) {
    return;
  }

  if (!Array.isArray(days) || dayIndex < 0 || dayIndex >= days.length) {
    return;
  }

  setFocusedDay(dayIndex);

  const day = days[dayIndex];
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

  const day = days[dayIndex];
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
  const day = days[dayIndex];
  if (!day) {
    return null;
  }

  const lastDayIndex = days.length - 1;

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

  const prevDay = dayIndex > 0 ? days[dayIndex - 1] : null;

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

function buildPlannedDatesIndex(sourceDays) {
  /** @type {Map<string, Set<string>>} */
  const stopDates = new Map();
  /** @type {Map<string, Set<string>>} */
  const poiDates = new Map();

  for (const day of sourceDays || []) {
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
  const raw = String(dateStr).trim();

  // Format A: "25 Apr 2026" (English month abbreviations)
  const matchA = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (matchA) {
    const day = Number(matchA[1]);
    const monthRaw = matchA[2].toLowerCase();
    const year = Number(matchA[3]);
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

  // Format B: ISO "2026-04-25"
  const matchB = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (matchB) {
    const year = Number(matchB[1]);
    const month = Number(matchB[2]);
    const day = Number(matchB[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  return null;
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
  const set = plannedDatesIndex.stopDates.get(stopId);
  if (!set) {
    return [];
  }
  return Array.from(set);
}

function getPlannedDatesForPoi(poiId) {
  const set = plannedDatesIndex.poiDates.get(poiId);
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

function getPoiAssignedDayIndices(poiId) {
  const id = String(poiId || '').trim();
  if (!id || !Array.isArray(days)) {
    return [];
  }

  const indices = [];
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    if (!day || !Array.isArray(day.poiIds)) {
      continue;
    }
    if (day.poiIds.includes(id)) {
      indices.push(i);
    }
  }
  return indices;
}

function updatePoiMarkerDateBadge(poiId) {
  const id = String(poiId || '').trim();
  if (!id) {
    return;
  }

  const entry = poiMarkerById.get(id);
  if (!entry) {
    return;
  }

  const dateEl = entry.dateEl || (entry.element ? entry.element.querySelector('.markerDate') : null);
  if (!dateEl) {
    return;
  }

  const planned = formatPlannedDatesShort(getPlannedDatesForPoi(id));
  dateEl.textContent = planned;
  dateEl.hidden = !planned;
}

async function persistDayRecords(dayIndices) {
  const unique = Array.from(new Set(dayIndices || [])).filter((idx) => Number.isInteger(idx));
  if (!unique.length) {
    return;
  }

  for (const idx of unique) {
    const day = days[idx];
    if (!day) {
      continue;
    }
    const rec = { key: day.key, date: day.date, stopId: day.stopId, summary: day.summary, poiIds: day.poiIds };
    await updateStorageRecord(rec);
  }
}

async function setPoiAssignedDays(poiIdRaw, nextDayIndices) {
  const poiId = String(poiIdRaw || '').trim();
  if (!poiId || !Array.isArray(days)) {
    return;
  }

  const targetSet = new Set(
    (Array.isArray(nextDayIndices) ? nextDayIndices : [])
      .filter((idx) => Number.isInteger(idx))
      .filter((idx) => idx >= 0 && idx < days.length)
  );

  /** @type {Map<number, string[]>} */
  const before = new Map();
  /** @type {number[]} */
  const changed = [];

  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    if (!day) {
      continue;
    }
    if (!Array.isArray(day.poiIds)) {
      day.poiIds = [];
    }

    const has = day.poiIds.includes(poiId);
    const wants = targetSet.has(i);
    if (has === wants) {
      continue;
    }

    before.set(i, [...day.poiIds]);
    if (wants) {
      day.poiIds.push(poiId);
    } else {
      day.poiIds = day.poiIds.filter((id) => String(id) !== poiId);
    }
    changed.push(i);
  }

  if (!changed.length) {
    return;
  }

  try {
    await persistDayRecords(changed);
  } catch (err) {
    // Rollback local state if storage write fails.
    for (const [idx, poiIds] of before.entries()) {
      if (days[idx]) {
        days[idx].poiIds = poiIds;
      }
    }
    throw err;
  }

  plannedDatesIndex = buildPlannedDatesIndex(days);
  renderSidebar();
  updatePoiMarkerDateBadge(poiId);
  if (typeof focusedDayIndex === 'number') {
    setFocusedDay(focusedDayIndex);
  }
}

function createPoiMarker(poi) {
  if (!map || !poi) {
    return null;
  }

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

  // Popup DOM: only Day + Description are editable.
  const popupEl = document.createElement('div');
  popupEl.className = 'markerPopup';

  const titleRow = document.createElement('div');
  titleRow.className = 'markerPopupTitle';
  titleRow.textContent = poi.name || poi.id;
  popupEl.appendChild(titleRow);

  const dayLabel = document.createElement('div');
  dayLabel.className = 'muted markerPopupLabel';
  dayLabel.textContent = 'Days';
  popupEl.appendChild(dayLabel);

  const dayPills = document.createElement('div');
  dayPills.className = 'dayPlacesPills markerDayPills';
  popupEl.appendChild(dayPills);

  const dayDropdown = document.createElement('div');
  dayDropdown.className = 'poiSuggest poiDayDropdown';
  dayDropdown.hidden = true;
  popupEl.appendChild(dayDropdown);

  const detailsInput = document.createElement('textarea');
  detailsInput.rows = 4;
  detailsInput.className = 'markerPopupTextarea';
  detailsInput.value = poi.details || '';
  popupEl.appendChild(detailsInput);

  const saveStatus = document.createElement('div');
  saveStatus.className = 'markerPopupStatus';
  popupEl.appendChild(saveStatus);

  const popup = new window.maplibregl.Popup({ offset: 16, maxWidth: '880px' }).setDOMContent(popupEl);

  const formatDayLabel = (idx) => {
    const d = Array.isArray(days) ? days[idx] : null;
    const stop = d && d.stopId ? getStopById(d.stopId) : null;
    const stopPart = stop && stop.name ? ` — ${stop.name}` : '';
    const datePart = String(d && d.date ? d.date : `Day ${idx + 1}`);
    return `${datePart}${stopPart}`;
  };

  const normalizeDayIndices = (indices) => {
    const clean = (Array.isArray(indices) ? indices : [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v));

    const unique = Array.from(new Set(clean)).filter((idx) => idx >= 0 && idx < (days || []).length);
    unique.sort((a, b) => a - b);
    return unique;
  };

  // Save: description (POI details)
  let poiSaveInFlight = false;
  let poiSaveInFlightFingerprint = '';

  const scheduleDetailsSave = () => {
    const nextDetails = String(detailsInput.value || '').trim();
    const currentDetails = String(poi.details || '').trim();
    if (nextDetails === currentDetails) {
      return;
    }

    const fingerprint = `${poi.key}\n${nextDetails}`;
    if (poiSaveInFlight && fingerprint === poiSaveInFlightFingerprint) {
      return;
    }

    poiSaveInFlight = true;
    poiSaveInFlightFingerprint = fingerprint;
    saveStatus.textContent = 'Saving…';

    const next = {
      key: poi.key,
      name: String(poi.name || '').trim(),
      location: String(poi.location || '').trim(),
      details: nextDetails,
      lat: poi.position.lat,
      lng: poi.position.lng
    };

    updateStorageRecord(next)
      .then(() => {
        saveStatus.textContent = 'Saved';
        poi.details = next.details;
        renderSidebar();
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        saveStatus.textContent = `Save failed: ${msg}`;
      })
      .finally(() => {
        poiSaveInFlight = false;
        poiSaveInFlightFingerprint = '';
      });
  };

  detailsInput.addEventListener('blur', () => {
    scheduleDetailsSave();
  });

  // Save: day assignment (updates day:* record(s))
  let dayUpdateInFlight = false;
  let lastSavedDayIndices = normalizeDayIndices(getPoiAssignedDayIndices(poi.id));
  let dayPickerOpen = false;

  const applyDayDropdownMaxHeight = () => {
    if (!map || !dayPickerOpen || dayDropdown.hidden) {
      return;
    }

    // Keep the dropdown within the visible map area with a bit of padding.
    // This prevents the popup from growing beyond the map edge when many days exist.
    const mapContainer = typeof map.getContainer === 'function' ? map.getContainer() : null;
    if (!mapContainer) {
      return;
    }

    const mapRect = mapContainer.getBoundingClientRect();
    const dropdownRect = dayDropdown.getBoundingClientRect();
    if (!mapRect || !dropdownRect) {
      return;
    }

    const EDGE_PADDING = 12;
    const spaceBelow = Math.max(0, mapRect.bottom - EDGE_PADDING - dropdownRect.top);
    const maxHeight = Math.max(0, Math.min(spaceBelow, 340));
    if (maxHeight > 0) {
      dayDropdown.style.maxHeight = `${Math.floor(maxHeight)}px`;
    }
  };

  const setDayPickerOpen = (open) => {
    dayPickerOpen = Boolean(open);
    dayDropdown.hidden = !dayPickerOpen;

    if (dayPickerOpen) {
      // Wait for layout after un-hiding.
      requestAnimationFrame(() => applyDayDropdownMaxHeight());
    }
  };

  const renderDayUi = () => {
    // Selected pills
    dayPills.innerHTML = '';
    if (!Array.isArray(days) || !days.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No days available';
      dayPills.appendChild(empty);
    } else if (!lastSavedDayIndices.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'None selected (click to add)';
      dayPills.appendChild(empty);
    } else {
      for (const idx of lastSavedDayIndices) {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.dataset.dayIndex = String(idx);
        pill.innerHTML =
          `<span class="pillText">${escapeHtml(formatDayLabel(idx))}</span>` +
          `<button type="button" class="pillRemove" aria-label="Remove" data-action="remove-poi-day" data-day-index="${idx}">×</button>`;
        dayPills.appendChild(pill);
      }
    }

    // Dropdown content: remove + add
    if (!Array.isArray(days) || !days.length) {
      dayDropdown.innerHTML = '';
      return;
    }

    const selectedSet = new Set(lastSavedDayIndices);
    const removeItems = lastSavedDayIndices;
    const addItems = [];
    for (let i = 0; i < days.length; i += 1) {
      if (!selectedSet.has(i)) {
        addItems.push(i);
      }
    }

    const htmlParts = [];

    if (removeItems.length) {
      htmlParts.push(
        `<div class="muted" style="padding:8px 10px;border-bottom:1px solid #e6e6e6">Remove day</div>`
      );
      for (const idx of removeItems) {
        htmlParts.push(
          `<button type="button" class="poiSuggestItem" data-action="remove-poi-day" data-day-index="${idx}">` +
            `<span class="poiSuggestName">${escapeHtml(formatDayLabel(idx))}</span>` +
            `<span class="poiSuggestId">Remove</span>` +
          `</button>`
        );
      }
    }

    htmlParts.push(
      `<div class="muted" style="padding:8px 10px;border-top:${removeItems.length ? '1px solid #e6e6e6' : '0'};border-bottom:1px solid #e6e6e6">Add day</div>`
    );
    if (!addItems.length) {
      htmlParts.push(`<div class="muted" style="padding:8px 10px">All days already selected</div>`);
    } else {
      for (const idx of addItems) {
        htmlParts.push(
          `<button type="button" class="poiSuggestItem" data-action="add-poi-day" data-day-index="${idx}">` +
            `<span class="poiSuggestName">${escapeHtml(formatDayLabel(idx))}</span>` +
            `<span class="poiSuggestId">Add</span>` +
          `</button>`
        );
      }
    }

    dayDropdown.innerHTML = htmlParts.join('');
  };

  const saveDays = (nextIndicesRaw) => {
    if (dayUpdateInFlight) {
      return;
    }

    const nextIndices = normalizeDayIndices(nextIndicesRaw);
    const currentKey = lastSavedDayIndices.join(',');
    const nextKey = nextIndices.join(',');
    if (currentKey === nextKey) {
      return;
    }

    const rollback = lastSavedDayIndices;
    dayUpdateInFlight = true;
    saveStatus.textContent = 'Saving days…';

    setPoiAssignedDays(poi.id, nextIndices)
      .then(() => {
        lastSavedDayIndices = nextIndices;
        saveStatus.textContent = 'Days saved';
        updatePoiMarkerDateBadge(poi.id);
        renderDayUi();
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        saveStatus.textContent = `Days save failed: ${msg}`;
        lastSavedDayIndices = rollback;
        renderDayUi();
      })
      .finally(() => {
        dayUpdateInFlight = false;
      });
  };

  dayPills.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) {
        return;
      }

      const removeBtn = target.closest('[data-action="remove-poi-day"]');
      if (removeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(removeBtn.getAttribute('data-day-index'));
        if (Number.isInteger(idx)) {
          saveDays(lastSavedDayIndices.filter((v) => v !== idx));
        }
        return;
      }

      // Toggle dropdown for add/remove.
      setDayPickerOpen(!dayPickerOpen);
    },
    true
  );

  dayDropdown.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const actionEl = target ? target.closest('[data-action]') : null;
      if (!actionEl) {
        return;
      }
      const action = actionEl.getAttribute('data-action');
      const idx = Number(actionEl.getAttribute('data-day-index'));
      if (!Number.isInteger(idx)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (action === 'add-poi-day') {
        saveDays([...lastSavedDayIndices, idx]);
        setDayPickerOpen(false);
        return;
      }

      if (action === 'remove-poi-day') {
        saveDays(lastSavedDayIndices.filter((v) => v !== idx));
        setDayPickerOpen(false);
      }
    },
    true
  );

  popupEl.addEventListener('click', (e) => {
    // Keep clicks inside popup from bubbling to map,
    // but don't block child handlers (avoid capture-phase stopPropagation).
    e.stopPropagation();
  });

  renderDayUi();

  const marker = new window.maplibregl.Marker({ element: wrap, anchor: 'bottom' })
    .setLngLat([poi.position.lng, poi.position.lat])
    .setPopup(popup)
    .addTo(map);

  poiMarkerById.set(poi.id, { marker, element: wrap, dateEl, popup });

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
}

function buildMap() {
  const mapEl = qs('map');

  // If we previously rendered an error overlay (or anything else), clear it so it
  // can't sit on top of the map on a subsequent rebuild.
  try {
    mapEl.innerHTML = '';
  } catch {
    // ignore
  }

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
    center: stops.length ? [stops[0].position.lng, stops[0].position.lat] : [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
    zoom: stops.length ? 10 : DEFAULT_ZOOM,
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

    markers = stops.map((stop, idx) => {
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

      const popup = new window.maplibregl.Popup({ offset: 18, maxWidth: '880px' }).setHTML(
        `
          <div class="markerPopup markerPopup--stop">
            <div class="markerPopupTitle">${idx + 1}. ${escapeHtml(stop.name)}</div>
            <div class="markerPopupStopDates">${escapeHtml(stop.dates)}</div>
            <div class="markerPopupMeta">${escapeHtml(stop.city)} • ${escapeHtml(stop.details)}</div>
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

    poiMarkers = Object.values(pois)
      .map((poi) => createPoiMarker(poi))
      .filter(Boolean);

    const bounds = new window.maplibregl.LngLatBounds();
    let hasBounds = false;
    for (const stop of stops) {
      bounds.extend([stop.position.lng, stop.position.lat]);
      hasBounds = true;
    }
    for (const poi of Object.values(pois)) {
      bounds.extend([poi.position.lng, poi.position.lat]);
      hasBounds = true;
    }
    if (hasBounds) {
      map.fitBounds(bounds, { padding: 40 });
    }

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

  const stop = stops[index];
  if (!stop) {
    return;
  }

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

function loadAuth() {
  try {
    const raw = localStorage.getItem(KEY_STORAGE_KEY);
    const val = raw == null ? '' : String(raw);
    return val.trim();
  } catch {
    return '';
  }
}

function saveAuth(nextAuth) {
  const val = String(nextAuth || '').trim();
  try {
    if (!val) {
      localStorage.removeItem(KEY_STORAGE_KEY);
    } else {
      localStorage.setItem(KEY_STORAGE_KEY, val);
    }
  } catch {
    // ignore
  }
}

function setAuthStatus(message) {
  const el = document.getElementById('authStatus');
  if (!el) {
    return;
  }
  el.textContent = message ? String(message) : '';
}

async function fetchBackendPlaces(auth) {
  const url = `${API_BASE}/storage/collection?collection=${encodeURIComponent(COLLECTION_NAME)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      [AUTH_HEADER_NAME]: auth
    }
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok) {
    const statusMsg = payload && payload.status ? ` (${payload.status})` : '';
    throw new Error(`Storage GET failed: HTTP ${res.status}${statusMsg}`);
  }

  if (!payload || payload.status !== 'ok' || !Array.isArray(payload.data)) {
    throw new Error('Storage GET failed: unexpected response');
  }

  return payload.data;
}

async function updateStorageRecord(record) {
  const auth = loadAuth();
  if (!auth) {
    throw new Error('No auth available');
  }

  // backend expects POST /storage with JSON body { collection, key, ... }
  const url = `${API_BASE}/storage`;

  const payloadBody = Object.assign({ collection: COLLECTION_NAME }, record);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AUTH_HEADER_NAME]: auth
    },
    body: JSON.stringify(payloadBody)
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok) {
    const statusMsg = payload && payload.status ? ` (${payload.status})` : '';
    throw new Error(`Storage update failed: HTTP ${res.status}${statusMsg}`);
  }

  return payload;
}

function getLatLngFromRecord(record) {
  // Canonical storage location: top-level `lat`/`lng`.
  // Some legacy/alternate writers may store `position.{lat,lng}`; treat that as fallback.
  const lat = typeof record.lat === 'number' ? record.lat : record.position && typeof record.position.lat === 'number' ? record.position.lat : null;
  const lng = typeof record.lng === 'number' ? record.lng : record.position && typeof record.position.lng === 'number' ? record.position.lng : null;
  if (typeof lat === 'number' && typeof lng === 'number') {
    return { lat, lng };
  }
  return null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function buildStateFromBackendRecords(records) {
  /** @type {any[]} */
  const nextStops = [];
  /** @type {Record<string, any>} */
  const nextPois = {};
  /** @type {any[]} */
  const nextDays = [];

  for (const record of records || []) {
    if (!record || typeof record.key !== 'string') {
      continue;
    }

    const parsed = parsePlaceKey(record.key);

    if (parsed) {
      const ll = getLatLngFromRecord(record) || DEFAULT_CENTER;

      if (parsed.type === 'stop') {
        nextStops.push({
          id: parsed.id,
          key: record.key,
          name: typeof record.name === 'string' ? record.name : parsed.id,
          city: typeof record.city === 'string' ? record.city : '',
          dates: typeof record.dates === 'string' ? record.dates : '',
          details: typeof record.details === 'string' ? record.details : '',
          position: { lat: ll.lat, lng: ll.lng }
        });
      } else if (parsed.type === 'poi') {
        nextPois[parsed.id] = {
          id: parsed.id,
          key: record.key,
          name: typeof record.name === 'string' ? record.name : parsed.id,
          location: typeof record.location === 'string' ? record.location : typeof record.address === 'string' ? record.address : '',
          details: typeof record.details === 'string' ? record.details : '',
          position: { lat: ll.lat, lng: ll.lng }
        };
      }

      continue;
    }

    const parsedDay = parseDayKey(record.key);
    if (parsedDay && parsedDay.type === 'day') {
      const date = typeof record.date === 'string' ? record.date : typeof record.dateLabel === 'string' ? record.dateLabel : parsedDay.id;
      const stopId = typeof record.stopId === 'string' ? record.stopId : typeof record.stop_id === 'string' ? record.stop_id : '';
      const summary = typeof record.summary === 'string' ? record.summary : '';
      const poiIds = normalizeStringArray(record.poiIds ?? record.pois ?? record.poi_ids);

      nextDays.push({
        id: parsedDay.id,
        key: record.key,
        date,
        stopId,
        summary,
        poiIds
      });
    }
  }

  // Enforce: hotels/stops are not POIs.
  const stopIdSet = new Set(nextStops.map((s) => String(s && s.id ? s.id : '')).filter(Boolean));
  for (const day of nextDays) {
    if (!day) {
      continue;
    }

    const clean = [];
    for (const poiIdRaw of day.poiIds || []) {
      const poiId = String(poiIdRaw || '').trim();
      if (!poiId) {
        continue;
      }
      const parsedKey = parsePlaceKey(poiId);
      if (parsedKey && parsedKey.type === 'stop') {
        continue;
      }
      if (stopIdSet.has(poiId)) {
        continue;
      }
      clean.push(poiId);
    }
    day.poiIds = clean;
  }

  // Remove any POIs that are actually stops (hotels are shown in the stop list)
  for (const s of nextStops) {
    if (s && s.id && Object.prototype.hasOwnProperty.call(nextPois, s.id)) {
      delete nextPois[s.id];
    }
  }

  nextDays.sort((a, b) => {
    const ad = parseDayDate(a.date) || parseDayDate(a.id);
    const bd = parseDayDate(b.date) || parseDayDate(b.id);
    if (ad && bd) {
      return ad.getTime() - bd.getTime();
    }
    if (ad && !bd) {
      return -1;
    }
    if (!ad && bd) {
      return 1;
    }
    return String(a.id).localeCompare(String(b.id));
  });

  const stopFirstDate = new Map();
  for (const day of nextDays) {
    if (!day || !day.stopId) {
      continue;
    }
    const d = parseDayDate(day.date) || parseDayDate(day.id);
    if (!d) {
      continue;
    }
    const existing = stopFirstDate.get(day.stopId);
    if (!existing || d.getTime() < existing.getTime()) {
      stopFirstDate.set(day.stopId, d);
    }
  }

  // Sort stops by earliest planned day they appear on (fallback: by id).
  nextStops.sort((a, b) => {
    const aMin = stopFirstDate.get(a.id) || null;
    const bMin = stopFirstDate.get(b.id) || null;
    if (aMin && bMin) {
      return aMin.getTime() - bMin.getTime();
    }
    if (aMin && !bMin) {
      return -1;
    }
    if (!aMin && bMin) {
      return 1;
    }
    return String(a.id).localeCompare(String(b.id));
  });

  return { nextStops, nextPois, nextDays };
}

let refreshSeq = 0;

async function refreshPlacesAndRebuildMap({ reason } = {}) {
  const seq = refreshSeq += 1;
  const auth = loadAuth();
  const dayPanel = document.getElementById('dayPanel');

  if (!auth) {
    stops = [];
    pois = {};
    days = [];
    plannedDatesIndex = buildPlannedDatesIndex([]);
    clearFocusedDay();
    if (dayPanel) {
      dayPanel.hidden = true;
    }
    setAuthStatus('Enter your key to load the map.');
    renderSidebar();
    try {
      buildMap();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(err);
      showMapError(msg);
    }
    return;
  }

  setAuthStatus('Loading from backend…');
  if (dayPanel) {
    dayPanel.hidden = true;
  }

  try {
    const records = await fetchBackendPlaces(auth);
    if (seq !== refreshSeq) {
      return;
    }

    const built = buildStateFromBackendRecords(records);
    stops = built.nextStops;
    pois = built.nextPois;
    days = built.nextDays;
    plannedDatesIndex = buildPlannedDatesIndex(days);

    setAuthStatus(`Loaded ${records.length} place records${reason ? ` (${reason})` : ''}.`);
    renderSidebar();
    try {
      buildMap();
    } catch (mapErr) {
      const mapMsg = mapErr instanceof Error ? mapErr.message : String(mapErr);
      console.error(mapErr);
      showMapError(mapMsg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err);
    setAuthStatus(`Backend load failed: ${msg}`);

    days = [];
    plannedDatesIndex = buildPlannedDatesIndex([]);
    clearFocusedDay();
    if (dayPanel) {
      dayPanel.hidden = true;
    }

    // Keep the current map/data if backend fails.
    if (!map) {
      renderSidebar();
      try {
        buildMap();
      } catch (mapErr) {
        const mapMsg = mapErr instanceof Error ? mapErr.message : String(mapErr);
        console.error(mapErr);
        showMapError(mapMsg);
      }
    }
  }
}

let authUiBound = false;

function initAuthUi() {
  const input = document.getElementById('authInput');
  if (!input || !(input instanceof HTMLInputElement)) {
    return;
  }

  if (authUiBound) {
    return;
  }
  authUiBound = true;

  input.value = loadAuth();
  input.addEventListener('change', () => {
    const next = String(input.value || '').trim();
    const current = loadAuth();
    if (next === current) {
      return;
    }
    saveAuth(next);
    refreshPlacesAndRebuildMap({ reason: 'key updated' });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') {
      return;
    }
    e.preventDefault();
    const next = String(input.value || '').trim();
    const current = loadAuth();
    if (next === current) {
      return;
    }
    saveAuth(next);
    refreshPlacesAndRebuildMap({ reason: 'key updated' });
  });
}

function slugifyId(raw) {
  const base = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'place';
}

function fnv1aBase36(input) {
  // Small, stable hash for client-side IDs (not for crypto).
  let hash = 2166136261;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Convert to unsigned then base36.
  return (hash >>> 0).toString(36);
}

function createUniquePoiId({ name, lat, lng }) {
  const base = slugifyId(name).slice(0, 40);
  const salt = fnv1aBase36(`${name}|${lat}|${lng}|${Date.now()}`).slice(0, 6);
  let candidate = `${base}-${salt}`;
  let counter = 2;

  while (candidate in (pois || {})) {
    candidate = `${base}-${salt}-${counter}`;
    counter += 1;
  }

  return candidate;
}

function formatGlobalPlaceLocation(properties) {
  const parts = [];
  const street = [properties && properties.street, properties && properties.housenumber].filter(Boolean).join(' ');
  if (street) {
    parts.push(street);
  }

  const locality = [properties && properties.city, properties && properties.state].filter(Boolean).join(', ');
  if (locality) {
    parts.push(locality);
  }

  if (properties && properties.country) {
    parts.push(properties.country);
  }

  return parts.filter(Boolean).join(', ');
}

async function searchPlacesEverywhere(query, { signal } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return [];
  }

  // Photon geocoder (OpenStreetMap-backed). Public endpoint, no API key.
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal
  });

  if (!res.ok) {
    throw new Error(`Search failed: HTTP ${res.status}`);
  }

  const payload = await res.json();
  const features = payload && Array.isArray(payload.features) ? payload.features : [];

  const results = [];
  for (const f of features) {
    const coords = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    const lng = coords && typeof coords[0] === 'number' ? coords[0] : null;
    const lat = coords && typeof coords[1] === 'number' ? coords[1] : null;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      continue;
    }

    const props = f && f.properties ? f.properties : {};
    const name = String(props.name || q).trim();
    const location = String(formatGlobalPlaceLocation(props) || props.country || '').trim();
    results.push({ name, location, lat, lng, _props: props });
  }

  return results;
}

let placeSearchBound = false;
let lastGlobalSearchResults = [];

function initPlaceSearchUi() {
  const input = document.getElementById('placeSearchInput');
  const resultsEl = document.getElementById('placeSearchResults');
  if (!input || !(input instanceof HTMLInputElement) || !resultsEl) {
    return;
  }

  if (placeSearchBound) {
    return;
  }
  placeSearchBound = true;

  let debounceTimer = null;
  let abortController = null;

  const clearResults = () => {
    lastGlobalSearchResults = [];
    resultsEl.innerHTML = '';
    resultsEl.hidden = true;
  };

  const renderResults = (items) => {
    lastGlobalSearchResults = items || [];
    if (!lastGlobalSearchResults.length) {
      clearResults();
      return;
    }

    resultsEl.hidden = false;
    resultsEl.innerHTML = lastGlobalSearchResults
      .map((item, idx) => {
        return (
          `<button type="button" class="mapSearchResultItem" data-action="add-global-place" data-index="${idx}">` +
            `<div class="mapSearchResultName">${escapeHtml(item.name || '')}</div>` +
            `<div class="mapSearchResultLocation">${escapeHtml(item.location || '')}</div>` +
          `</button>`
        );
      })
      .join('');
  };

  const runSearch = async () => {
    const q = String(input.value || '').trim();
    if (!q) {
      clearResults();
      return;
    }

    if (abortController) {
      try {
        abortController.abort();
      } catch {
        // ignore
      }
    }
    abortController = new AbortController();

    try {
      const items = await searchPlacesEverywhere(q, { signal: abortController.signal });
      renderResults(items);
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setAuthStatus(msg);
      clearResults();
    }
  };

  input.addEventListener('input', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      runSearch();
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearResults();
      try {
        input.blur();
      } catch {
        // ignore
      }
    }
  });

  const addGlobalPlaceAsPoi = async (item) => {
    const auth = loadAuth();
    if (!auth) {
      setAuthStatus('Enter your key before adding POIs.');
      return;
    }
    if (!item || typeof item.lat !== 'number' || typeof item.lng !== 'number') {
      return;
    }

    const name = String(item.name || '').trim();
    const location = String(item.location || '').trim();

    const poiId = createUniquePoiId({ name: name || 'place', lat: item.lat, lng: item.lng });
    const key = `poi:${poiId}`;

    setAuthStatus('Adding POI…');
    try {
      await updateStorageRecord({
        key,
        name: name || poiId,
        location,
        details: '',
        lat: item.lat,
        lng: item.lng
      });

      pois[poiId] = {
        id: poiId,
        key,
        name: name || poiId,
        location,
        details: '',
        position: { lat: item.lat, lng: item.lng }
      };

      setAuthStatus('POI added');
      clearResults();
      input.value = '';

      // Add marker immediately if the map is live.
      if (map) {
        const marker = createPoiMarker(pois[poiId]);
        if (marker) {
          poiMarkers.push(marker);
          try {
            map.easeTo({ center: [item.lng, item.lat], zoom: 14, duration: 650 });
          } catch {
            // ignore
          }
          openMarkerPopup(marker);
          setTimeout(() => {
            try {
              const entry = poiMarkerById.get(poiId);
              const popup = entry && entry.popup ? entry.popup : null;
              const root = popup && typeof popup.getElement === 'function' ? popup.getElement() : null;
              const textarea = root ? root.querySelector('textarea') : null;
              if (textarea) {
                textarea.focus();
              }
            } catch {
              // ignore
            }
          }, 0);
        }
      }

      renderSidebar();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthStatus(`Add POI failed: ${msg}`);
    }
  };

  resultsEl.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const actionEl = target ? target.closest('[data-action="add-global-place"]') : null;
    if (!actionEl) {
      return;
    }

    const idx = Number(actionEl.getAttribute('data-index'));
    const item = Number.isFinite(idx) ? lastGlobalSearchResults[idx] : null;
    if (!item) {
      return;
    }

    addGlobalPlaceAsPoi(item);
  });

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) {
      return;
    }
    const wrap = target.closest('.mapSearch');
    if (wrap) {
      return;
    }
    clearResults();
  });

}


function openMarkerPopup(marker) {
  if (!map || !marker || !marker.getPopup) {
    return;
  }

  const setPopupAnchor = (popup, anchor) => {
    if (!popup || !anchor) {
      return;
    }
    try {
      // MapLibre doesn't expose a public setAnchor API; options.anchor is used internally.
      popup.options = popup.options || {};
      popup.options.anchor = anchor;
      if (typeof popup._update === 'function') {
        popup._update();
      }
    } catch {
      // ignore
    }
  };

  const computeDesiredAnchor = (lngLat) => {
    if (!map || !lngLat || typeof map.getContainer !== 'function' || typeof map.project !== 'function') {
      return 'bottom';
    }

    const container = map.getContainer();
    if (!container) {
      return 'bottom';
    }

    const rect = container.getBoundingClientRect();
    const w = rect && rect.width ? rect.width : 0;
    const h = rect && rect.height ? rect.height : 0;
    if (!w || !h) {
      return 'bottom';
    }

    const pt = map.project(lngLat);
    const EDGE_PAD = 16;
    const HORZ_THRESHOLD = 220;
    const VERT_THRESHOLD = 180;

    const nearLeft = pt.x < EDGE_PAD + HORZ_THRESHOLD;
    const nearRight = pt.x > w - (EDGE_PAD + HORZ_THRESHOLD);
    const nearTop = pt.y < EDGE_PAD + VERT_THRESHOLD;

    const vertical = nearTop ? 'top' : 'bottom';
    if (nearLeft) {
      return `${vertical}-left`;
    }
    if (nearRight) {
      return `${vertical}-right`;
    }
    return vertical;
  };

  const nudgePopupIntoMapBounds = (popup) => {
    try {
      if (!map || !popup || typeof popup.getElement !== 'function' || typeof map.getContainer !== 'function') {
        return;
      }
      const container = map.getContainer();
      const popupEl = popup.getElement();
      if (!container || !popupEl) {
        return;
      }
      const mapRect = container.getBoundingClientRect();
      const popupRect = popupEl.getBoundingClientRect();
      if (!mapRect || !popupRect) {
        return;
      }

      const PAD = 12;
      const overflowLeft = popupRect.left < mapRect.left + PAD;
      const overflowRight = popupRect.right > mapRect.right - PAD;
      const overflowTop = popupRect.top < mapRect.top + PAD;

      if (!overflowLeft && !overflowRight && !overflowTop) {
        return;
      }

      const current = (popup.options && popup.options.anchor) || 'bottom';
      const wantVertical = overflowTop ? 'top' : current.startsWith('top') ? 'top' : 'bottom';

      if (overflowLeft) {
        setPopupAnchor(popup, `${wantVertical}-left`);
      } else if (overflowRight) {
        setPopupAnchor(popup, `${wantVertical}-right`);
      } else {
        setPopupAnchor(popup, wantVertical);
      }
    } catch {
      // ignore
    }
  };

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
      const lngLat = marker.getLngLat();
      popup.setLngLat(lngLat);
      setPopupAnchor(popup, computeDesiredAnchor(lngLat));
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
    // After the popup is in the DOM, confirm it isn't clipped by the map container.
    requestAnimationFrame(() => nudgePopupIntoMapBounds(popup));
  } catch {
    // ignore
  }
}

async function main() {
  initAuthUi();
  initPlaceSearchUi();
  await refreshPlacesAndRebuildMap({ reason: 'initial load' });
}

main();
