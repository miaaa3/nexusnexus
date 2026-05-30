# NexusNexus — Project Summary

> Living document. Update whenever architecture, features, or known issues change.

---

## What It Is

A real-time traffic visualization platform for Paris.
Thousands of vehicles stream live from a Spring Boot backend over WebSocket and are rendered on an OpenStreetMap dark-theme map using WebGL2 instanced drawing.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend framework | Angular 17 (standalone components) |
| Map | MapLibre GL JS 4.7 |
| Vehicle rendering | WebGL2 — instanced TRIANGLE_FAN quads |
| Realtime transport | STOMP over SockJS WebSocket |
| Backend | Spring Boot 3, Java 21 |
| Road data | OpenStreetMap via Overpass API (fetched at startup) |
| Build | Maven (backend) · Angular CLI (frontend) |

---

## Running the Project

```bash
# Backend  (port 8080)
cd backend
./mvnw spring-boot:run          # or: java -jar target/nexus-*.jar

# Frontend (port 4200)
cd frontend
npm install
npm start
```

Open `http://localhost:4200`.

---

## Project Structure

```
NexusNexus/
├── CUSTOM_OSM_MAP.md               # Guide: local OSM tiles + vector style setup
├── PROJECT_SUMMARY.md              # This file
│
├── backend/src/main/java/com/nexus/
│   ├── config/
│   │   ├── SimulationConfig.java       # vehicleCount, updateRateMs, bbox, maxVehicles, graphSource
│   │   ├── CorsConfig.java
│   │   └── WebSocketConfig.java
│   ├── controller/
│   │   ├── SimulationController.java   # REST: speed, vehicle count, pause/resume, traffic
│   │   ├── ReplayController.java       # REST: replay list/play/stop
│   │   └── MapController.java          # REST: POST /api/maps/upload (OSM file import)
│   ├── model/
│   │   ├── Vehicle.java                # mutable state (lat, lon, speed, direction, route*, routePath*)
│   │   ├── VehicleUpdate.java          # immutable broadcast record
│   │   ├── VehicleType.java            # CAR BUS TRUCK MOTORCYCLE EMERGENCY
│   │   ├── SimulationFrame.java        # replay frame envelope
│   │   └── MapLoadResponse.java        # OSM upload result: name, counts, bounds
│   ├── service/
│   │   ├── FrameRecorder.java          # records frames to disk for replay
│   │   ├── MapImportService.java       # validate + save + parse uploaded OSM, swap graph
│   │   └── MapImportException.java     # clean import-error signal
│   ├── simulation/
│   │   ├── RoadGraph.java              # OSM node+adjacency graph (immutable after load)
│   │   ├── RoadGraphProvider.java      # interface: load() → RoadGraph
│   │   ├── RoadNetworkLoader.java      # implements RoadGraphProvider via Overpass API
│   │   ├── LocalFileRoadGraphProvider.java  # two-pass StAX parser for uploaded .osm files
│   │   ├── AStarPathfinder.java        # A* with haversine heuristic, MAX_NODES=4000 cap
│   │   ├── TrafficMode.java            # enum: RUSH_HOUR / NORMAL / NIGHT + speedFactor/variance
│   │   ├── TrafficTimeService.java     # simulated clock (60× acceleration), mode detection
│   │   ├── VehicleGenerator.java       # places vehicles on random road edges at init
│   │   └── SimulationEngine.java       # tick loop: A* path following, traffic mode, pause
│   └── websocket/
│       └── VehicleBroadcaster.java     # scheduled @100ms: tick → snapshot → broadcast
│
└── frontend/src/app/
    ├── app.component.ts                # root shell (position:fixed, inset:0)
    ├── core/
    │   ├── models/
    │   │   ├── vehicle.model.ts        # VehicleUpdate, VEHICLE_COLORS, VEHICLE_SIZES
    │   │   └── render-stats.model.ts   # fps, renderTimeMs, vehicleCount, wsLatencyMs
    │   ├── map-state.service.ts        # bridge: stats signal + searchPool + panTo$/cycleTraffic$/togglePause$ Subjects
    │   ├── map-style.service.ts        # MapStyleOption, raster (CartoDB) vs vector (OpenFreeMap) styles
    │   ├── selection.service.ts        # selected vehicle + filter signals (trails, heatmap, 3D, incidents, geofences)
    │   ├── replay.service.ts           # replay state machine + frames$ observable
    │   ├── alert.service.ts            # toast alerts (fps drop, congestion, ws)
    │   ├── chart-data.service.ts       # fps / speed / congestion history signals (fed from throttled map updates)
    │   └── map-api.service.ts          # POST /api/maps/upload — OSM file import
    ├── map/
    │   ├── map.component.ts            # MapLibre init, WebSocket feed, layer wiring, style switching
    │   ├── heatmap.service.ts          # MapLibre heatmap source/layer
    │   ├── incident-layer.service.ts   # MapLibre circle layer — mock Paris incidents
    │   └── geofence-layer.service.ts   # MapLibre fill/outline/label layers — mock geofence zones
    ├── vehicles/
    │   ├── vehicle-renderer.ts         # WebGL2 instanced dots (compact slot reassignment)
    │   ├── trail-renderer.ts           # WebGL2 line trails (bounded ring buffers, cached colours, VAO)
    │   ├── congestion-renderer.ts      # WebGL2 grid cells coloured by density/speed
    │   ├── spatial-grid.ts             # uniform spatial grid for O(k) frustum culling
    │   └── vehicle-selector.ts         # click → nearest vehicle hit test
    ├── dashboard/
    │   ├── dashboard.component.ts      # stats, search, filters, replay timeline, pause button
    │   ├── alerts.component.ts         # toast overlay
    │   ├── charts.component.ts         # canvas sparklines: fps / speed / congestion
    │   └── map-import.component.ts     # OSM file upload panel → fitBounds + clear vehicles
    └── websocket/
        └── websocket.service.ts        # STOMP client, local delta mirror, rAF-coalesced snapshot emission

frontend/src/environments/
    └── environment.ts                  # backendUrl, MAP_CENTER, MAP_ZOOM, MAP_DEFAULT_PITCH, VECTOR_STYLE_URL
```

---

## Key Architecture Decisions

### Frontend

**WebGL instanced rendering**
Vehicles are drawn with a single `drawArraysInstanced` call. Each instance is 9 floats: position (mercatorX/Y), colour (RGB), size, direction (sin/cos), selected flag. The quad is a 4-vertex TRIANGLE_FAN; the fragment shader discards corners to make a circle with a glow.

**Compact slot reassignment (vehicle-renderer.ts)**
Every `updateVehicles` call clears `idToSlot` and assigns slots 0…N-1 to the *currently visible* vehicles. This ensures `drawArraysInstanced(…, vehicleCount)` always draws the right data. A `lastKnownPos` map preserves positions across viewport changes for smooth interpolation.

**Spatial grid culling (spatial-grid.ts)**
Vehicles are bucketed into lat/lon cells (cell size ≈ 0.005°). On each frame only the cells overlapping the current map bounds are queried — O(k) instead of O(n).

**rAF-coalesced WebSocket snapshots (websocket.service.ts)**
The wire format can be delta-based, but render consumers receive full reconstructed snapshots. Incoming keyframes/deltas update a local `Map<string, VehicleUpdate>` immediately, then one `requestAnimationFrame` callback emits only the freshest reconstructed fleet. This prevents multiple WebSocket messages from queueing expensive render/UI work on the main thread.

**Throttled dashboard work (map.component.ts)**
Vehicle renderer updates stay on the hot path, while expensive UI updates (`MapStateService.stats`, `searchPool`, and chart histograms) are throttled to 250 ms. This keeps Angular signals and dashboard canvases from competing with WebGL when vehicle counts are high.

**Bounded trail rendering (trail-renderer.ts)**
Trails are limited to `MAX_TRAIL_VEHICLES = 1000`. Each trail entry stores the latest RGB colour, so rebuilding the flat line buffer no longer scans the visible vehicle list for every trail.

**MapStateService bridge**
`DashboardComponent` is a child of `MapComponent` (not a sibling in AppComponent). `MapStateService` holds shared signals (`stats`, `searchPool`) and Subjects (`panTo$`, `cycleTraffic$`, `togglePause$`) so the dashboard can trigger map actions without circular imports.

**VAO per renderer**
Each WebGL custom layer owns a VAO. Attrib pointers are recorded inside it so MapLibre's own GL state cannot corrupt them between frames.

**Map style switching**
`MapStyleService` maintains the active style (raster CartoDB vs vector OpenFreeMap). When `map.setStyle()` is called, MapLibre wipes all custom layers. `MapComponent` listens on `map.once('style.load', initLayers)` to re-create all renderers and overlay services. A `liveSub` guard prevents double WebSocket subscriptions.

**3D mode**
Toggling 3D mode calls `map.easeTo({ pitch: 55, bearing: -10 })`. When a vector tile source is active, `add3dBuildingsIfSupported()` detects the source name and adds a `fill-extrusion` layer with colour interpolated by building height. No-ops silently on raster styles.

**Incident and geofence layers**
Both are MapLibre GeoJSON sources — rendered entirely on the GPU, no DOM elements. Incidents use circle layers with type-based colours and severity-based radii. Geofences use fill + outline + label layers, with polygon shapes approximated from lat/lon/radius via `circleApprox()`.

### Backend

**A\* pathfinding (AStarPathfinder.java)**
Each vehicle holds a `routePath: List<Long>` (node IDs) and `routePathIndex` (current fromNode index; toNode = pathIndex+1). On every tick, progress advances along the current segment. On arrival, the engine advances `routePathIndex`. When the path is exhausted, `assignNewPath()` runs A* from the current node to a random destination. The heuristic is haversine distance. A `MAX_NODES=4000` expansion cap bounds worst-case per call.

**Traffic simulation (TrafficTimeService + TrafficMode)**
A simulated clock advances at 60× real time. The current hour maps to `RUSH_HOUR` (07–09, 17–19), `NORMAL`, or `NIGHT` (00–07). Each mode has a `speedFactor` (0.55/1.0/1.35) and a `variance` (jitter ±%). The dashboard can override the mode via `POST /api/simulation/traffic/override?mode=RUSH_HOUR`.

**Pause/resume**
`SimulationEngine` has a `volatile boolean paused`. When paused, `tick()` returns immediately — positions freeze — but VehicleBroadcaster continues sending the unchanged state. REST endpoints: `POST /api/simulation/pause` and `POST /api/simulation/resume`. The dashboard polls `/status` (which includes `paused`) and exposes a toggle button + `P` keyboard shortcut.

**Road graph provider pattern**
`RoadGraphProvider` is a one-method interface (`load() → RoadGraph`). `SimulationConfig.graphSource` selects the startup implementation: `"overpass"` (default) uses `RoadNetworkLoader`; `"local-file"` uses `LocalFileRoadGraphProvider`. See `CUSTOM_OSM_MAP.md` for the local tile pipeline.

**OSM file upload — runtime graph swap**
`POST /api/maps/upload` accepts a `.osm` / `.osm.xml` `MultipartFile` (≤ 250 MB). `MapImportService` validates the extension/size, saves the file under `backend/data/maps/`, and hands it to `LocalFileRoadGraphProvider`, which parses it with a **two-pass StAX stream**: pass 1 keeps only drivable `highway=*` ways and records the node ids they reference; pass 2 reads coordinates for *only those* nodes — non-road nodes (building corners, POIs — usually the file's majority) are never retained, so peak memory tracks the road network, not the file. The result replaces the live graph via `SimulationEngine.replaceGraph()`, which takes the `ReadWriteLock` write lock so the swap can't race the tick loop: it pauses, clears old vehicles, regenerates them on the new road edges, pre-assigns A* paths, and resumes. A failed parse throws `MapImportException` → HTTP 400 with a clean message; the active simulation is left untouched (no silent fallback). The frontend `map-import.component` then calls `map.fitBounds()` on the returned bounds and clears stale vehicle visuals.

**Zero allocations per tick**
All movement math uses primitive `double` variables. No `new` calls inside the tick loop. `CopyOnWriteArrayList<Vehicle>` is used because structural mutations (add/remove vehicles) are rare while reads (per-tick iteration) dominate.

---

## Features

- ✅ Live vehicle streaming (WebSocket/STOMP, ~10 Hz)
- ✅ rAF-coalesced frontend frame handling — multiple WebSocket arrivals collapse into one render snapshot
- ✅ WebGL2 instanced rendering — handles 5 000+ vehicles at 60 FPS
- ✅ Vehicles follow real Paris roads (OSM via Overpass API)
- ✅ **OSM file upload** — import any `.osm` / `.osm.xml`; backend parses it, swaps the live road graph, respawns vehicles on real edges, map recenters on the imported bounds
- ✅ **A\* pathfinding** — vehicles pick real routes to random destinations; reassign on arrival
- ✅ Smooth position interpolation between server frames
- ✅ Vehicle type filters (CAR · BUS · TRUCK · MOTORCYCLE · EMERGENCY)
- ✅ Click to select vehicle — pulsing highlight + info panel
- ✅ Fading trail lines per vehicle (bounded ring-buffer history)
- ✅ Traffic density heatmap overlay (MapLibre)
- ✅ Congestion grid (WebGL cells: green→yellow→red by density+speed)
- ✅ **Traffic zones & rush hour** — simulated clock (60×), mode-based speed + jitter
- ✅ **Traffic mode override** — click the mode badge or press R to cycle RUSH HOUR / NORMAL / NIGHT
- ✅ **Pause / Resume** — freezes vehicle positions; button in controls panel + P key
- ✅ Runtime vehicle count slider (50–5 000)
- ✅ Speed multiplier slider (0–5×)
- ✅ FPS sparkline, speed histogram, congestion timeline (canvas charts)
- ✅ Throttled dashboard/chart updates for high vehicle counts
- ✅ Vehicle search — live filter + map pan-to
- ✅ Toast alerts (FPS drop, congestion spike, WS disconnect)
- ✅ Replay system — record frames to disk, play back with timeline UI
- ✅ **3D map mode** — pitch + bearing + fill-extrusion buildings (vector tiles), toggle with B key
- ✅ **Map style switcher** — raster dark (CartoDB) ↔ vector (OpenFreeMap), cycle button in UI
- ✅ **Incident layer** — 8 mock Paris incidents (accident, closure, congestion, construction)
- ✅ **Geofence layer** — 4 mock zones (ZCR, CDG airspace, delivery, school), GPU-rendered polygons
- ✅ Keyboard shortcuts: Space=replay, H=heatmap, T=trails, C=congestion, B=3D, I=incidents, G=geofences, R=traffic cycle, P=pause, Esc=deselect
- ✅ Dark professional UI with collapsible hints panel, clickable mode badge

---

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/simulation/status` | vehicleCount, speedMultiplier, paused |
| POST | `/api/simulation/speed?multiplier=N` | Set speed multiplier (0–10) |
| POST | `/api/simulation/vehicles?count=N` | Set vehicle count (up to maxVehicles) |
| POST | `/api/simulation/pause` | Pause simulation |
| POST | `/api/simulation/resume` | Resume simulation |
| GET | `/api/simulation/traffic` | Current mode + simulated time |
| POST | `/api/simulation/traffic/override?mode=X` | Override traffic mode (RUSH_HOUR/NORMAL/NIGHT) |
| POST | `/api/simulation/traffic/override` | Clear override (back to auto) |
| GET | `/api/replay/list` | Available replay files |
| GET | `/api/replay/play/{file}` | Stream replay frames |
| POST | `/api/maps/upload` | Upload an `.osm`/`.osm.xml` file → parse, swap road graph, return name/counts/bounds |

---

## Configuration

**`backend/src/main/resources/application.yml`**
```yaml
nexus:
  simulation:
    vehicle-count: 500
    update-rate-ms: 100
    max-vehicles: 5000
    graph-source: overpass    # overpass | local-file
    area:
      lat-min: 48.82
      lat-max: 48.90
      lon-min: 2.28
      lon-max: 2.42
```

**`frontend/src/environments/environment.ts`**
```typescript
export const environment = {
  production: false,
  backendUrl: 'http://localhost:8080',
  VECTOR_STYLE_URL: 'https://tiles.openfreemap.org/styles/dark',
  MAP_CENTER: [2.347, 48.859] as [number, number],
  MAP_ZOOM: 12,
  MAP_DEFAULT_PITCH: 25,
};
```

**Frontend vehicle colours / sizes — `vehicle.model.ts`**
`VEHICLE_COLORS` and `VEHICLE_SIZES` map `VehicleType` → RGB / pixel scale factor.

---

## How the WebGL Shader Works

**Vertex shader** (`vehicle-renderer.ts`)
```glsl
// 1. Project Mercator position to clip space
vec4 projected = u_matrix * vec4(a_position, 0.0, 1.0);

// 2. Rotate the unit quad by vehicle direction
vec2 rotated = rotate(a_quad, a_direction);

// 3. Convert pixel size to a clip-space offset that survives perspective divide
//    Multiplying by projected.w before adding ensures the offset is cancelled
//    by the hardware divide → constant screen-space pixel size at any zoom/pitch
float pixelSize = 6.0 * a_size * u_pixelRatio * pulse;
vec2 offset = rotated * pixelSize * 2.0 / u_viewport * projected.w;

gl_Position = projected + vec4(offset, 0.0, 0.0);
```

**Fragment shader**: diamond (Manhattan distance ≤ 1) → circle via `smoothstep` alpha, inner glow, selected ring.

---

## Known Issues / Next Steps

| # | Description | Status |
|---|---|---|
| 1 | Vehicles visible at all zoom levels (compact slot fix applied) | ✅ Fixed |
| 2 | Vehicles follow real road edges (Overpass fetch + RoadGraph) | ✅ Fixed |
| 3 | App fills screen edge-to-edge | ✅ Fixed |
| 4 | A* pathfinding — vehicles follow real routes to destinations | ✅ Added |
| 5 | Traffic zones & rush hour — simulated clock + speed mode | ✅ Added |
| 6 | Pause / Resume simulation | ✅ Added |
| 7 | 3D mode + buildings + map style switcher | ✅ Added |
| 8 | Incident + geofence layers | ✅ Added |
| 9 | OSM file upload — parse local `.osm`, swap live road graph, recenter map | ✅ Added |
| 10 | Vector tile self-hosting for 3D buildings | 🔲 Optional (free: OpenFreeMap, self-hosted: Planetiler + Tileserver GL) |
| 11 | Replace mock incidents/geofences with real data source | 🔲 Future |
| 12 | Multi-city support (change bounding box at runtime) | 🔲 Future |
