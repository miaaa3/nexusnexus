# NexusNexus — Backend Quick Reference

> Read this at the start of every session to orient yourself.
> Root: `backend/src/main/java/com/nexus/`

---

## Run

```bash
cd backend
./mvnw spring-boot:run        # port 8080
```

Config: `src/main/resources/application.yml`

---

## Package Map

```
com.nexus/
├── NexusApplication.java           — Spring Boot entry point
├── config/
│   ├── SimulationConfig.java       — @ConfigurationProperties "nexus.simulation"
│   ├── WebSocketConfig.java        — STOMP over SockJS, endpoint /ws
│   └── CorsConfig.java             — allows all origins
├── model/
│   ├── Vehicle.java                — mutable per-vehicle state (see fields below)
│   ├── VehicleUpdate.java          — immutable broadcast record (id,lat,lon,speed,dir,type)
│   ├── VehicleType.java            — enum: CAR BUS TRUCK MOTORCYCLE EMERGENCY
│   ├── SimulationFrame.java        — broadcast envelope: timestamp + vehicleCount + updates
│   ├── MapLoadResponse.java        — response for POST /api/maps/upload
│   └── LightUpdate.java            — (light/minimal vehicle update variant)
├── controller/
│   ├── SimulationController.java   — REST /api/simulation/*  (see API table)
│   ├── ReplayController.java       — REST /api/replay/*
│   └── MapController.java          — REST POST /api/maps/upload
├── service/
│   ├── FrameRecorder.java          — records SimulationFrames to disk for replay
│   ├── MapImportService.java       — validates + saves .osm file, builds RoadGraph, calls engine.replaceGraph()
│   └── MapImportException.java     — checked exception for bad uploads
├── simulation/
│   ├── RoadGraphProvider.java      — interface: RoadGraph load()
│   ├── RoadGraph.java              — immutable graph: nodes (id→{lat,lon}), adj (id→neighbors), edges list, bounds
│   ├── RoadNetworkLoader.java      — implements RoadGraphProvider via Overpass API (fetched at startup)
│   ├── LocalFileRoadGraphProvider.java — implements RoadGraphProvider from .osm/.osm.xml file (used by MapImportService)
│   ├── AStarPathfinder.java        — findPath(graph, start, goal) → List<Long>; MAX_NODES=4000; haversine heuristic
│   ├── TrafficMode.java            — enum: RUSH_HOUR(×0.55,±35%) / NORMAL(×1.0,±15%) / NIGHT(×1.35,±8%)
│   ├── TrafficTimeService.java     — simulated clock 60× real; getMode(), setOverride(mode), getFormattedTime()
│   ├── AccidentSystem.java         — randomly wrecks vehicles (freeze+speed=0); MAX_ACTIVE=5, clears after 12–32s
│   ├── IrisZoneSystem.java         — vehicle counting per INSEE IRIS zone (ray-cast, bbox pre-filter, throttled 4Hz)
│   ├── IrisLoader.java             — fetches IRIS zones from IGN WFS (data.geopf.fr); subsamples polygons to ≤200pts
│   ├── VehicleGenerator.java       — places N vehicles on random road edges at init
│   └── SimulationEngine.java       — main tick loop (see below)
├── model/
│   └── IrisZoneStatus.java         — immutable record sent to frontend: codeIris, nomIris, typIris, polygon[][], vehicleCount, density
└── websocket/
    └── VehicleBroadcaster.java     — @Scheduled at update-rate-ms: tick → record → broadcast to /topic/vehicles
```

---

## Vehicle Fields (Vehicle.java)

| Field | Type | Purpose |
|---|---|---|
| `id` | String | unique ID |
| `type` | VehicleType | CAR / BUS / TRUCK / MOTORCYCLE / EMERGENCY |
| `latitude`, `longitude` | double | current position |
| `speed` | double | current speed km/h |
| `direction` | double | bearing 0–360° (0=north) |
| `cruiseSpeed` | double | desired speed when road is clear |
| `frontGap` | double | distance (m) to vehicle ahead on same edge |
| `wreckedUntilMs` | long | epoch ms; >now = frozen obstacle (AccidentSystem) |
| `routeFromNode` | long | current OSM edge from-node ID (-1 = unplaced) |
| `routeToNode` | long | current OSM edge to-node ID |
| `routeProgress` | double | 0.0→1.0 along current edge |
| `routePath` | `List<Long>` | full A* path (node IDs) |
| `routePathIndex` | int | fromNode index in routePath; toNode = index+1 |
| `waypointLat/Lon` | double | fallback random-waypoint target |

---

## SimulationEngine — Key Methods

| Method | What it does |
|---|---|
| `init()` | selects graph provider by config.graphSource, loads graph, generates vehicles, pre-assigns A* paths |
| `tick(deltaMs)` | skips if paused; advances trafficTime; calls advanceOnRoad or advanceRandom per vehicle |
| `advanceOnRoad(v, dt, rng, jitter)` | follows A* path; on segment end advances pathIndex; on path end calls assignNewPath() |
| `assignNewPath(v, rng)` | A* from current node to random dest; sets routePath + indices |
| `reassignEdge(v, rng)` | places vehicle on a random graph edge (dead-end recovery) |
| `snapshot()` | returns `List<VehicleUpdate>` for broadcast |
| `replaceGraph(graph, name)` | hot-swaps road graph (called by MapImportService) |
| `setVehicleCount(n)` | adds/removes vehicles; assigns paths to new ones |
| `pause()` / `resume()` | sets `volatile boolean paused` |
| `setSpeedMultiplier(m)` | clamps 0–10 |
| `setTrafficOverride(mode)` | passes to TrafficTimeService |

---

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/simulation/status` | `{vehicleCount, speedMultiplier, paused}` |
| POST | `/api/simulation/speed?multiplier=N` | Set speed multiplier (0–10) |
| POST | `/api/simulation/vehicles?count=N` | Set vehicle count (capped at maxVehicles) |
| POST | `/api/simulation/pause` | Freeze simulation |
| POST | `/api/simulation/resume` | Unfreeze simulation |
| GET | `/api/simulation/traffic` | `{mode, simulatedTime}` |
| POST | `/api/simulation/traffic/override?mode=X` | Force mode: RUSH_HOUR / NORMAL / NIGHT |
| POST | `/api/simulation/traffic/override` | Clear override (back to auto clock) |
| GET | `/api/replay/list` | Available replay files |
| GET | `/api/replay/play/{file}` | Stream replay frames |
| POST | `/api/maps/upload` | Upload `.osm` / `.osm.xml` file → hot-swap graph |
| GET | `/api/iris/status` | `{loaded: boolean, zoneCount: int}` |
| GET | `/api/iris/zones` | Full GeoJSON FeatureCollection with polygons + vehicleCount + density |
| GET | `/api/iris/counts` | Lightweight `{codeIris: {count, density}}` map (poll every 3s) |

## WebSocket

| Topic | Payload | Rate |
|---|---|---|
| `/topic/vehicles` | `SimulationFrame` (timestamp + vehicleCount + `List<VehicleUpdate>`) | every `update-rate-ms` (default 100ms) |

---

## Configuration (`application.yml`)

```yaml
nexus:
  simulation:
    vehicle-count: 500       # initial vehicle count
    update-rate-ms: 100      # broadcast interval (ms)
    max-vehicles: 5000       # hard cap
    graph-source: overpass   # overpass | local-file
    area:                    # Paris bounding box
      lat-min: 48.82
      lat-max: 48.90
      lon-min: 2.28
      lon-max: 2.42
```

---

## Data Flow

```
application.yml
    └─▶ SimulationConfig
            └─▶ SimulationEngine.init()
                    ├─▶ RoadNetworkLoader (Overpass API) → RoadGraph
                    └─▶ VehicleGenerator → List<Vehicle> (placed on edges, A* paths assigned)

@Scheduled (100ms) — VehicleBroadcaster
    ├─▶ SimulationEngine.tick(deltaMs)
    │       ├─▶ TrafficTimeService.advance()   → TrafficMode (speedFactor, jitter)
    │       ├─▶ AccidentSystem.update()        → wreck random vehicles
    │       └─▶ advanceOnRoad() per vehicle    → A* path following
    ├─▶ SimulationEngine.snapshot()            → List<VehicleUpdate>
    ├─▶ FrameRecorder.record()
    └─▶ SimpMessagingTemplate → /topic/vehicles

POST /api/maps/upload
    └─▶ MapImportService.importMap()
            ├─▶ LocalFileRoadGraphProvider.load(path) → RoadGraph
            └─▶ SimulationEngine.replaceGraph()        → hot-swap live
```

---

## Notable Constraints

- `CopyOnWriteArrayList<Vehicle>` — safe for concurrent reads; mutations are rare
- All tick math uses primitive `double` — zero allocations per vehicle per tick
- `RoadGraph` is read-only after load — no locking needed during tick
- A* capped at `MAX_NODES = 4000` expansions per call to bound worst-case latency
- `AccidentSystem` max 5 simultaneous wrecks, EMERGENCY vehicles are immune
- `LocalFileRoadGraphProvider` is now **fully implemented** — used by `MapImportService` for `.osm` uploads
