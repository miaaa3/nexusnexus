# NexusNexus — Frontend Quick Reference

> Read this at the start of every session to orient yourself.
> Root: `frontend/src/app/`

---

## Run

```bash
cd frontend
npm install
npm start         # http://localhost:4200
```

Config: `src/environments/environment.ts`

---

## File Map

```
frontend/src/
├── environments/
│   └── environment.ts              — backendUrl, VECTOR_STYLE_URL, MAP_CENTER, MAP_ZOOM, MAP_DEFAULT_PITCH
├── polyfills.ts                    — global Buffer polyfill for SockJS
├── main.ts                         — Angular bootstrap
└── app/
    ├── app.component.ts            — root shell: position:fixed inset:0; renders <app-map>
    ├── app.config.ts               — provideHttpClient, provideAnimations
    ├── app.routes.ts               — routes (minimal, mostly single-page)
    │
    ├── core/
    │   ├── models/
    │   │   ├── vehicle.model.ts    — VehicleUpdate interface; VEHICLE_COLORS; VEHICLE_SIZES
    │   │   └── render-stats.model.ts — RenderStats: fps, renderTimeMs, vehicleCount, wsLatencyMs, framesRendered
    │   ├── map-state.service.ts    — shared bridge (see below)
    │   ├── map-style.service.ts    — MapStyleOption; raster (CartoDB) vs vector (OpenFreeMap); currentStyle signal
    │   ├── map-api.service.ts      — uploadMap(file) → POST /api/maps/upload → MapLoadResponse
    │   ├── selection.service.ts    — selectedVehicle signal; FilterState signal; all toggle methods
    │   ├── replay.service.ts       — replay state machine: idle/loading/ready/playing/paused
    │   ├── alert.service.ts        — push()/dismiss() toast alerts
    │   └── chart-data.service.ts   — rolling history signals: fpsHistory, speedHistory, congestionHistory
    │
    ├── map/
    │   ├── map.component.ts        — MapLibre host; WebSocket feed; layer wiring (see below)
    │   ├── heatmap.service.ts      — MapLibre heatmap source + layer
    │   ├── incident-layer.service.ts — 8 mock Paris incidents; circle layer; click popup; init/show/hide
    │   ├── geofence-layer.service.ts — 4 mock zones; fill+outline+label layers; circleApprox(); init/show/hide
    │   └── iris-layer.service.ts   — INSEE IRIS choropleth; loads zones once, polls counts/3s; click popup; shortcut N
    │
    ├── vehicles/
    │   ├── vehicle-renderer.ts     — WebGL2 instanced directional vehicle glyphs; compact slot reassignment; VAO
    │   ├── trail-renderer.ts       — WebGL2 line trails; capped ring buffer per vehicle; cached colours; VAO
    │   ├── congestion-renderer.ts  — WebGL2 grid cells coloured green→yellow→red by density+speed
    │   ├── spatial-grid.ts         — uniform lat/lon grid; O(k) frustum culling
    │   └── vehicle-selector.ts     — click → nearest vehicle within pixel threshold
    │
    ├── dashboard/
    │   ├── dashboard.component.ts  — all UI panels (see below)
    │   ├── search.component.ts     — live vehicle ID filter + map pan-to; emits PanToEvent
    │   ├── charts.component.ts     — canvas sparklines: FPS / speed histogram / congestion timeline
    │   ├── alerts.component.ts     — toast overlay; auto-dismiss
    │   ├── replay-bar.component.ts — standalone replay timeline bar component
    │   └── map-import.component.ts — drag/drop or browse .osm file; calls MapApiService.uploadMap()
    │
    └── websocket/
        └── websocket.service.ts    — STOMP over SockJS; rAF-coalesced frame emission; status signal; wsLatencyMs
```

---

## Key Services

### MapStateService (`core/map-state.service.ts`)
Bridge between `MapComponent` (writes) and `DashboardComponent` (reads). No circular imports.

| Member | Type | Direction |
|---|---|---|
| `stats` | `Signal<RenderStats>` | map → dashboard |
| `searchPool` | `Signal<VehicleUpdate[]>` | map → search |
| `panTo$` | `Subject<{lon,lat}>` | dashboard → map |
| `cycleTraffic$` | `Subject<void>` | map keydown R → dashboard HTTP |
| `togglePause$` | `Subject<void>` | map keydown P → dashboard HTTP |

### SelectionService (`core/selection.service.ts`)
| Member | Type |
|---|---|
| `selectedVehicle` | `Signal<VehicleUpdate \| null>` |
| `filters` | `Signal<FilterState>` |
| `select(v)` | sets selection |
| `toggleTrails()` | |
| `toggleHeatmap()` | |
| `toggleCongestion()` | |
| `toggle3dMode()` | |
| `toggleIncidents()` | |
| `toggleGeofences()` | |
| `toggleIris()` | |
| `toggleType(type)` | |

**FilterState fields:** `types: Set<VehicleType>`, `trailsEnabled`, `heatmapEnabled`, `congestionEnabled`, `mode3dEnabled`, `incidentsEnabled`, `geofencesEnabled`, `irisEnabled`

### MapStyleService (`core/map-style.service.ts`)
| Member | |
|---|---|
| `availableStyles` | array of `MapStyleOption` (excludes vector if URL empty) |
| `currentStyle` | `Signal<MapStyleOption>` |
| `setStyle(id)` | switches active style |
| `getMapLibreStyle(option)` | returns inline raster object or vector URL string |

---

## MapComponent — Critical Logic (`map/map.component.ts`)

**Init flow:**
1. Creates MapLibre map with CartoDB raster style, pitch from `environment.MAP_DEFAULT_PITCH` (25°)
2. On `map.load`: calls `initLayers()`
3. `initLayers()`: creates VehicleRenderer + TrailRenderer + CongestionRenderer; inits HeatmapService, IncidentLayerService, GeofenceLayerService, IrisLayerService; re-applies filter state; starts WebSocket subscription (guarded by `liveSub`)

**Style switching:**
- `switchMapStyle(url)` → `map.setStyle()` → wipes all custom layers → `map.once('style.load', initLayers)`
- `liveSub` guard prevents double WebSocket subscription on re-init

**3D mode:**
- `apply3dMode(true)` → `map.easeTo({ pitch: 55, bearing: -10 })`
- `apply3dMode(false)` → back to default pitch + 0° bearing
- `add3dBuildingsIfSupported()` → probes source names (openmaptiles, composite, maptiler_planet, versatiles-shortbread); adds `fill-extrusion` layer; no-ops on raster styles

**Keyboard shortcuts:**

| Key | Action |
|---|---|
| `H` | toggle heatmap |
| `T` | toggle trails |
| `C` | toggle congestion |
| `B` | toggle 3D mode |
| `I` | toggle incidents |
| `G` | toggle geofences |
| `N` | toggle IRIS zones |
| `R` | cycle traffic mode (emits `cycleTraffic$`) |
| `P` | toggle pause (emits `togglePause$`) |
| `Space` | replay play/pause |
| `Esc` | deselect vehicle |

**Angular effects wired in MapComponent:**
- filter signal → show/hide renderers and overlay layers
- `mapStyle.currentStyle()` change → `switchMapStyle()`
- replay frames$ → feed renderer with replayed data

**High-volume frame handling:**
- `WebSocketService` applies keyframes/deltas to a local `Map<string, VehicleUpdate>` immediately, then emits one reconstructed snapshot on the next `requestAnimationFrame`. This collapses multiple WebSocket arrivals into one render and prevents SockJS/render backlog.
- `processFrame()` keeps vehicle WebGL updates on the hot path, but throttles dashboard-heavy updates (`stats`, `searchPool`, `chartData`) to `UI_UPDATE_INTERVAL_MS = 250`.
- `TrailRenderer` is capped at `MAX_TRAIL_VEHICLES = 1000`; each trail entry stores its RGB colour so rebuilds avoid per-trail `vehicles.find(...)` scans.

---

## DashboardComponent — Panels (`dashboard/dashboard.component.ts`)

| Panel | Contents |
|---|---|
| Header | NEXUS logo, WS status badge, `?` hints toggle |
| Search | `<app-search>` — live ID filter + pan-to |
| Stats + Traffic | 4 stat cards (FPS / Vehicles / Latency / Render); simulated clock + mode badge |
| Charts | `<app-charts>` — canvas sparklines |
| Selected Vehicle | pulsing dot + id/type/speed/direction/lat/lon |
| Simulation Controls | Vehicles slider (50–5000), Speed× slider (0–5), **Pause/Resume button** |
| Overlay Toggles | Trails(T) · Heat(H) · Congestion(C) · 3D(B) |
| Flow Legend | appears when congestion is active; green→yellow→red traffic ramp |
| Layer Toggles | Events/Incidents(I) · Zones/Geofences(G) · Map style cycler |
| Replay | load / play / scrub / stop / speed chips |
| Type Filters | CAR · BUS · TRUCK · MOTORCYCLE · EMERGENCY chips |
| Hints | collapsible keyboard shortcut reference |

**Key fields:**
- `paused: boolean` — synced from GET /api/simulation/status on init
- `trafficMode: string` — polled every 2s from GET /api/simulation/traffic
- `simTime: string` — e.g. "08:42" from traffic poll
- `trafficOverride: string | null` — current manual override (null = auto)
- `overrideCycle: [null, 'RUSH_HOUR', 'NORMAL', 'NIGHT']` — cycles on badge click / R key

**HTTP calls:**
- `togglePause()` → POST /api/simulation/pause or /resume
- `cycleTrafficOverride()` → POST /api/simulation/traffic/override[?mode=X]
- `applyVehicleCount()` → POST /api/simulation/vehicles?count=N
- `applySpeed()` → POST /api/simulation/speed?multiplier=N
- `cycleMapStyle()` → calls `MapStyleService.setStyle()`

---

## WebGL Rendering — Vehicle Shader Formula

```glsl
// Zoom+pitch-invariant screen-space size:
vec4 projected = u_matrix * vec4(a_position, 0.0, 1.0);
vec2 rotated   = rotate(a_quad, a_direction);           // unit quad rotated by bearing
float px       = 7.4 * a_size * u_pixelRatio * pulse;
vec2 offset    = rotated * px * 2.0 / u_viewport * projected.w;
gl_Position    = projected + vec4(offset, 0.0, 0.0);
// multiplying by .w before adding → hardware divide cancels it → constant pixel size
```

Fragment: tapered local marker → directional vehicle glyph, nose glow, selected halo ring.

---

## Data Flow (Frontend)

```
WebSocketService (STOMP /ws → /topic/vehicles)
    └─▶ apply keyframe/delta to local state Map
    └─▶ rAF-coalesced SimulationFrame { timestamp, vehicleCount, vehicles: VehicleUpdate[] }
            ├─▶ VehicleRenderer.updateVehicles()    — WebGL instanced draw
            ├─▶ TrailRenderer.update()               — ring buffer append
            ├─▶ CongestionRenderer.update()          — grid density update
            ├─▶ SpatialGrid.update()                 — O(k) culling rebuild
            ├─▶ MapStateService.stats (throttled)    — FPS / latency / count
            └─▶ MapStateService.searchPool (throttled) — vehicle list for search

DashboardComponent
    ├─▶ reads stats/searchPool from MapStateService
    ├─▶ reads selectedVehicle/filters from SelectionService
    └─▶ controls → HTTP → backend REST API

MapImportComponent
    └─▶ MapApiService.uploadMap(file) → POST /api/maps/upload
            └─▶ backend hot-swaps RoadGraph, resets vehicles
```

---

## environment.ts

```typescript
export const environment = {
  production: false,
  backendUrl: 'http://localhost:8080',
  VECTOR_STYLE_URL: 'https://tiles.openfreemap.org/styles/dark',  // empty = vector style disabled
  MAP_CENTER: [2.347, 48.859] as [number, number],
  MAP_ZOOM: 12,
  MAP_DEFAULT_PITCH: 25,
};
```

---

## Notable Constraints

- **No DOM elements for vehicles** — everything is WebGL or MapLibre GPU layers
- **Angular change detection isolated** — WebSocket data flows directly to WebGL renderers, never through `@Component` inputs
- **VAO per renderer** — each WebGL layer owns its VAO; MapLibre GL state can't corrupt it
- **Compact slot reassignment** — `idToSlot` rebuilt each frame; `drawArraysInstanced(count)` always draws exactly visible vehicles
- **Directional vehicle glyphs** — fragment shader tapers each marker from rear to nose so heading is readable without extra geometry
- **rAF-coalesced WebSocket rendering** — incoming deltas update the local mirror immediately, but Angular/renderer subscribers see at most one full snapshot per browser animation frame
- **Dashboard throttling** — stats, charts, and search pool updates are capped to 4 Hz so high vehicle counts do not force Angular work every render frame
- **Bounded trails** — trails render for at most 1000 visible vehicles and cache per-vehicle colour to avoid O(n²) rebuilds
- **liveSub guard** — `if (!this.liveSub)` in `initLayers()` prevents double WebSocket subscription on style switches
- **`renderingMode: '2d'`** on WebGL layers — vehicles render before 3D buildings; switch to `'3d'` if buildings should clip vehicles
