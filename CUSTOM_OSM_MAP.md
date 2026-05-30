# Custom OSM Map Pipeline

> This document explains how to set up a fully local OSM tile pipeline for NexusNexus.
> The default CartoDB raster tiles work out of the box, but a local vector tile stack
> enables **3D building extrusion** and reduces reliance on external services.
>
> The tile pipeline is **separate** from the backend road graph (which uses the Overpass API
> for simulation routing). Tiles are purely a visual concern — the simulation runs the same
> regardless of which tile style is active.

---

## Overview

```
OSM data extract (.pbf)
      │
      ▼
Tile generator (Planetiler or Tilemaker)
      │
      ▼ vector tiles (.pmtiles or /z/x/y.pbf)
      │
      ▼
Tile server (Tileserver GL, Martin, or static hosting)
      │
      ▼ MapLibre style JSON URL
      │
      ▼
NexusNexus Angular frontend
```

---

## Step 1 — Download an OSM Extract

Download a regional `.osm.pbf` file from [Geofabrik](https://download.geofabrik.de/):

```bash
# Île-de-France (Paris region, ~300 MB)
wget https://download.geofabrik.de/europe/france/ile-de-france-latest.osm.pbf

# Or the full France extract (~4 GB)
wget https://download.geofabrik.de/europe/france-latest.osm.pbf
```

For testing, a city-level extract is sufficient. The Paris bbox used by the simulation
is `lat 48.82–48.90, lon 2.28–2.42` — much smaller than the regional extract.

---

## Step 2 — Generate Vector Tiles

### Option A — Planetiler (recommended, fast, single JAR)

[Planetiler](https://github.com/onthegomap/planetiler) generates OpenMapTiles-schema
PMTiles or MBTiles from a `.pbf` in minutes.

```bash
# Download the latest release
wget https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar

# Generate tiles (Paris region; ~5–10 min on a modern laptop)
java -Xmx4g -jar planetiler.jar \
  --area=ile-de-france \
  --download \
  --output=paris.pmtiles

# Or from a local extract:
java -Xmx4g -jar planetiler.jar \
  --osm-path=ile-de-france-latest.osm.pbf \
  --output=paris.pmtiles
```

Output: `paris.pmtiles` — a single file containing all vector tiles.

### Option B — Tilemaker

[Tilemaker](https://github.com/systemed/tilemaker) is lighter and supports MBTiles.

```bash
# Install (Ubuntu/macOS via Homebrew)
sudo apt install tilemaker   # or: brew install tilemaker

tilemaker \
  --input ile-de-france-latest.osm.pbf \
  --output paris.mbtiles \
  --config config-openmaptiles.json \
  --process process-openmaptiles.lua
```

Download config files from the [Tilemaker GitHub](https://github.com/systemed/tilemaker/tree/master/resources).

---

## Step 3 — Serve the Tiles

### Option A — Tileserver GL (MapLibre-native, supports styles)

[Tileserver GL](https://tileserver.org/) serves PMTiles/MBTiles with a built-in style renderer.

```bash
# Install
npm install -g tileserver-gl-light

# Serve
tileserver-gl-light --file paris.pmtiles --port 8085
```

Access at `http://localhost:8085`. Tileserver GL auto-generates a MapLibre style at:
`http://localhost:8085/styles/basic-preview/style.json`

### Option B — Martin (Rust, ultra-fast, bare tiles)

[Martin](https://github.com/maplibre/martin) serves PMTiles or PostGIS as `/z/x/y.pbf`.

```bash
# Install (binary release)
wget https://github.com/maplibre/martin/releases/latest/download/martin-x86_64-unknown-linux-gnu.tar.gz
tar xzf martin-*.tar.gz && chmod +x martin

# Serve
./martin paris.pmtiles --listen-addresses 0.0.0.0:8085
```

Tiles available at `http://localhost:8085/paris/{z}/{x}/{y}`.
You will need to write your own MapLibre style JSON that references this URL.

### Option C — Static Hosting (simplest for PMTiles)

PMTiles can be served from any static file host (S3, Cloudflare, Nginx).
The MapLibre PMTiles plugin handles range requests client-side:

```html
<!-- In index.html or Angular app -->
<script src="https://unpkg.com/pmtiles@3/dist/pmtiles.js"></script>
```

```typescript
import { addProtocol } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

const protocol = new Protocol();
addProtocol('pmtiles', protocol.tile);
// Then use: 'pmtiles://path/to/paris.pmtiles' as tile URL
```

---

## Step 4 — Write a MapLibre Style JSON

Create `custom-style.json` pointing to your tile server:

```json
{
  "version": 8,
  "name": "NexusNexus Custom Dark",
  "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  "sprite": "https://demotiles.maplibre.org/style-6/sprite",
  "sources": {
    "openmaptiles": {
      "type": "vector",
      "url": "http://localhost:8085/styles/basic-preview/style.json",
      "attribution": "© OpenStreetMap contributors"
    }
  },
  "layers": [
    { "id": "background", "type": "background", "paint": { "background-color": "#0a0e1a" } },
    {
      "id": "water",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "water",
      "paint": { "fill-color": "#0d1a2e" }
    },
    {
      "id": "roads",
      "type": "line",
      "source": "openmaptiles",
      "source-layer": "transportation",
      "paint": { "line-color": "#1e2a3c", "line-width": 1.5 }
    },
    {
      "id": "buildings",
      "type": "fill-extrusion",
      "source": "openmaptiles",
      "source-layer": "building",
      "minzoom": 14,
      "paint": {
        "fill-extrusion-color": "#1a2035",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 10],
        "fill-extrusion-base":   ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85
      }
    }
  ]
}
```

Serve this file locally (e.g., `npx http-server -p 9090`) or reference it directly if on disk:

```typescript
// environment.ts
VECTOR_STYLE_URL: 'http://localhost:9090/custom-style.json'
```

---

## Step 5 — Point NexusNexus to Your Style

In `frontend/src/environments/environment.ts`:

```typescript
export const environment = {
  // ...
  VECTOR_STYLE_URL: 'http://localhost:8085/styles/basic-preview/style.json',
};
```

Restart the Angular dev server (`npm start`). The map style switcher button in the
dashboard will now show your vector style as **"Vector (OSM)"**.

Enable 3D buildings: click the **3D** toggle or press **B**.

---

## Architecture Notes

### Tiles vs. Road Graph

| Component | Purpose | Data source |
|---|---|---|
| Map tiles (this doc) | Visual background — roads, buildings, water, labels | Local PMTiles or external style |
| Backend road graph | Simulation routing — `RoadGraph`, `AStarPathfinder` | Overpass API (or future local OSM) |

These are **completely independent**. You can run the simulation with Overpass routing
while using CartoDB raster tiles for the map background, or vice-versa.

### Source Layer Names

The buildings 3D layer in NexusNexus detects these OpenMapTiles-schema source names:
`openmaptiles`, `composite`, `maptiler_planet`, `versatiles-shortbread`.

If your style uses a different source name, add it to `add3dBuildingsIfSupported()`
in `map.component.ts`.

### Free Hosted Vector Tiles (No Local Setup)

[OpenFreeMap](https://openfreemap.org/) provides free, key-free vector tiles.
Set in `environment.ts`:

```typescript
VECTOR_STYLE_URL: 'https://tiles.openfreemap.org/styles/dark',
```

This is the default vector option bundled with NexusNexus.
OpenFreeMap uses the OpenMapTiles schema, so 3D buildings work automatically.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Map is blank after switching to vector style | Check browser console for CORS errors; the tile server must send `Access-Control-Allow-Origin: *` |
| 3D buildings don't appear | Zoom in to level 14+; check that source name matches (see above) |
| Tiles load but labels are missing | Add a `glyphs` URL to your style JSON pointing to a font host |
| PMTiles protocol error | Ensure the pmtiles JS plugin is loaded before MapLibre initializes |
