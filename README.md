# Japan 2026 Itinerary Viewer

Static site (GitHub Pages-friendly) that shows a Japan hotel itinerary on an OpenStreetMap-backed map with markers and travel legs.

## What it shows

- 25–28 Apr 2026 — LIBER HOTEL Osaka
- 28–30 Apr 2026 — Umekoji Kodensho (Kyoto)
- 30 Apr–3 May 2026 — remm plus Kobe
- 3–6 May 2026 — Hiyori Namba (Osaka)

## Map tech

This page uses:

- **MapLibre GL JS** (client-side vector map renderer)
- **OpenFreeMap** vector tiles/styles (free, no API keys)

Basemap labels: the default OpenFreeMap style can show bilingual labels (latin + local script). The app overrides label rendering to prefer English/latin names and avoid Japanese/non‑Latin labels.

Note: OpenStreetMap provides map data/tiles, but **not** public-transport directions by itself. This site currently draws a simple line connecting the stops (straight between coordinates). If you want real transit routing, you’ll need to integrate a separate routing engine/API (e.g., OpenTripPlanner).

## Edit the itinerary

Places (stops + POIs) and the day-by-day itinerary are loaded from Streetbot storage.

- The app reads `stop:*`, `poi:*`, and `day:*` records from the `japan2026` collection
- To update data, write updated records into storage 

## Local dev (CORS-free)

When running locally, you can use the dev server in [server/dev-server.js](server/dev-server.js). It serves the static site and proxies API calls via same-origin `/api/*`, which avoids browser CORS.

- Run: `node server/dev-server.js`
- Open: `http://127.0.0.1:8787/`

In local dev, the app calls `/api/storage/...` which the dev server forwards to `https://streetbot.fly.dev/storage/...`.
