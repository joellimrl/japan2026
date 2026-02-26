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
    const hay = `${p.name} ${p.id}`.toLowerCase();
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

    poiMarkers = Object.values(pois).map((poi) => {
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

      // Build editable popup DOM for POIs
      const popupEl = document.createElement('div');
      popupEl.style.minWidth = '260px';

      const titleRow = document.createElement('div');
      titleRow.style.fontWeight = '700';
      titleRow.style.marginBottom = '6px';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = poi.name || '';
      nameInput.style.width = '100%';
      nameInput.style.fontWeight = '700';
      nameInput.style.marginBottom = '6px';

      titleRow.appendChild(nameInput);
      popupEl.appendChild(titleRow);

      if (planned) {
        const plannedDiv = document.createElement('div');
        plannedDiv.style.marginBottom = '6px';
        plannedDiv.textContent = `Planned: ${planned}`;
        popupEl.appendChild(plannedDiv);
      }

      const detailsInput = document.createElement('textarea');
      detailsInput.rows = 3;
      detailsInput.style.width = '100%';
      detailsInput.value = poi.details || '';
      detailsInput.style.marginBottom = '6px';
      popupEl.appendChild(detailsInput);

      const coordRow = document.createElement('div');
      coordRow.style.display = 'flex';
      coordRow.style.gap = '6px';

      const latInput = document.createElement('input');
      latInput.type = 'text';
      latInput.value = String(poi.position.lat);
      latInput.style.flex = '1';
      latInput.placeholder = 'lat';

      const lngInput = document.createElement('input');
      lngInput.type = 'text';
      lngInput.value = String(poi.position.lng);
      lngInput.style.flex = '1';
      lngInput.placeholder = 'lng';

      coordRow.appendChild(latInput);
      coordRow.appendChild(lngInput);
      popupEl.appendChild(coordRow);

      const saveStatus = document.createElement('div');
      saveStatus.style.marginTop = '6px';
      saveStatus.style.color = '#333';
      popupEl.appendChild(saveStatus);

      const popup = new window.maplibregl.Popup({ offset: 16 }).setDOMContent(popupEl);

      // Auto-save helper
      let poiSaveInFlight = false;
      let poiSaveInFlightFingerprint = '';

      const scheduleSave = () => {
        const nextLatParsed = Number.parseFloat(String(latInput.value || ''));
        const nextLngParsed = Number.parseFloat(String(lngInput.value || ''));

        const nextName = String(nameInput.value || '').trim();
        const nextDetails = String(detailsInput.value || '').trim();
        const nextLat = Number.isFinite(nextLatParsed) ? nextLatParsed : poi.position.lat;
        const nextLng = Number.isFinite(nextLngParsed) ? nextLngParsed : poi.position.lng;

        const currentName = String(poi.name || '').trim();
        const currentDetails = String(poi.details || '').trim();
        const currentLat = poi.position.lat;
        const currentLng = poi.position.lng;

        const hasChanges = nextName !== currentName || nextDetails !== currentDetails || nextLat !== currentLat || nextLng !== currentLng;
        if (!hasChanges) {
          return;
        }

        const fingerprint = `${nextName}\n${nextDetails}\n${nextLat}\n${nextLng}`;
        if (poiSaveInFlight && fingerprint === poiSaveInFlightFingerprint) {
          return;
        }

        poiSaveInFlight = true;
        poiSaveInFlightFingerprint = fingerprint;
        saveStatus.textContent = 'Saving...';

        const next = {
          key: poi.key,
          name: nextName,
          details: nextDetails,
          lat: nextLat,
          lng: nextLng,
          position: { lat: nextLat, lng: nextLng }
        };

        updateStorageRecord(next)
          .then(() => {
            saveStatus.textContent = 'Saved';
            // Update local state
            poi.name = next.name;
            poi.details = next.details;
            poi.position = { lat: next.lat, lng: next.lng };
            try {
              const entry = poiMarkerById.get(poi.id);
              if (entry && entry.marker && typeof entry.marker.setLngLat === 'function') {
                entry.marker.setLngLat([poi.position.lng, poi.position.lat]);
              }
              renderSidebar();
            } catch (_err) {
              // ignore
            }
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

      // Save on blur or Enter
      for (const inputEl of [nameInput, detailsInput, latInput, lngInput]) {
        inputEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && ev.target === nameInput) {
            ev.preventDefault();
            try {
              detailsInput.focus();
            } catch {
              // ignore
            }
          }
          if (ev.key === 'Enter' && (ev.target === latInput || ev.target === lngInput)) {
            ev.preventDefault();
            try {
              ev.target.blur();
            } catch {
              // ignore
            }
          }
        });

        inputEl.addEventListener('blur', () => {
          scheduleSave();
        });
      }

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

async function main() {
  initAuthUi();
  await refreshPlacesAndRebuildMap({ reason: 'initial load' });
}

main();
