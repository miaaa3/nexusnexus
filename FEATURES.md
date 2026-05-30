# NexusNexus — Feature Audit

Last updated: 2026-05-29.

A running inventory of what exists, what's missing, and what's worth adding
next. Lives in the repo so it survives chat-session compaction.

---

## Working today

### Simulation core
- Real OSM road graph via two-pass StAX parser (`LocalFileRoadGraphProvider`),
  default `data/maps/la-rochelle.osm`.
- Runtime `.osm` / `.osm.xml` upload (`MapImportService`), idempotent across
  MapLibre style switches.
- Vehicle fleet of 5 types (CAR, BUS, TRUCK, MOTORCYCLE, EMERGENCY) with
  per-type speed bands and per-type acceleration / braking multipliers
  (`ACCEL_MULT` / `DECEL_MULT` in `SimulationEngine`).
- Vehicles stay **strictly on real roads** — A* pathfinding with 4 000-node
  cap, haversine heuristic, lazy path renewal.
- Car-following model: stop-gap, follow-gap, bounded accel/decel — vehicles
  queue, never clip through each other.
- Single-phase traffic lights at degree ≥ 4 intersections, 9 s green / 7 s
  red, vehicles brake at 50 m, never run a red.
  EMERGENCY vehicles bypass red lights (siren on).
- Accident system: periodic wrecks of non-emergency vehicles; wrecked
  vehicles freeze and become obstacles. Car-following queues traffic behind
  them automatically.
- Time-of-day modes (`NORMAL` / `RUSH_HOUR` / `NIGHT`) via `TrafficTimeService`,
  with per-mode speed factor and variance; REST override endpoint.

### Networking & performance
- STOMP-over-SockJS WebSocket at `/ws`, broadcast at 10 Hz.
- WebSocket transport limits raised to 16 MB message / 8 MB per-session
  buffer (`WebSocketConfig`) so 20 K-vehicle keyframes don't kill the session.
- Compact `VehicleUpdate` wire format: lat/lon rounded to 5 dp (~1 m), speed
  to 1 dp, direction to int degrees, `wrecked: false` omitted.
- **Delta broadcast**: server diffs each tick against the previous broadcast;
  only changed vehicles + removed IDs go on the wire. Full keyframe every
  20 ticks (~2 s) for resync.
- **Client rAF coalesce**: `WebSocketService` applies deltas synchronously
  to a local mirror but emits reconstructed snapshots through
  `requestAnimationFrame`, so render rate decouples from WS arrival rate
  and the SockJS buffer can't back up.
- A* path budget capped per tick (`MAX_PATHS_PER_TICK = 400`) so a 15 K
  scale-up never spikes the tick.
- Non-blocking vehicle scale-up: `setVehicleCount` does generator work
  outside the write lock and lets `advanceOnRoad` build A* paths lazily.

### Rendering
- WebGL2 instanced rendering — one `drawArraysInstanced` call per frame for
  up to 20 K vehicles (`vehicle-renderer.ts`).
- Position interpolation between server frames; selected-vehicle pulse +
  halo; wrecked vehicles rendered as red hazard blobs.
- MapLibre GL JS basemap with raster + vector style switching, OSM tiles.

### Live overlays
- **Traffic lights** (`traffic-light-layer.service.ts`) — polls
  `/api/simulation/lights` at 1 Hz; rendered as halo + bright core (3× a
  vehicle's size so they're unmistakable).
- **Events** (`incident-layer.service.ts`) — polls `/api/simulation/events`;
  every dot corresponds to a real wrecked vehicle from `AccidentSystem`.
  Severity scales with vehicle type; popup shows live countdown.
- **Zones** (`geofence-layer.service.ts`) — polls `/api/simulation/zones`;
  backend `ZoneSystem` owns four La Rochelle polygons (low-emission /
  airport / port / school) and counts vehicles inside each via
  bbox-prefiltered ray-cast. Label shows live count, e.g. `Low-emission
  Zone (147)`.
- **IRIS INSEE territorial overlay** (`iris-layer.service.ts`) — zones
  fetched once from IGN Géoplateforme WFS for the active graph bounds;
  `IrisZoneSystem` tracks vehicle count, summed speed, and wrecked count
  per zone every 250 ms. Choropleth coloured by **congestion score**
  (`speedDeficit + incidentPenalty`, clamped 0..1) green → yellow → orange
  → red. Popup shows code IRIS, commune, type, vehicle count, incidents,
  avg speed, density, congestion level + bar.
- **Heatmaps**, **trails**, **congestion grid** renderers.

### REST API
- `GET /api/simulation/status` — fleet size, speed multiplier, paused,
  lights count, accidents count, zones count.
- `GET /api/simulation/lights` — current signal positions + red/green state.
- `GET /api/simulation/events` — live wrecked-vehicle incidents.
- `GET /api/simulation/zones` — geofence polygons + live counts.
- `GET /api/simulation/traffic` — mode + simulated time.
- `POST /api/simulation/pause` `/resume` `/speed` `/vehicles`
  `/traffic/override`.
- `GET /api/iris/status` `/zones` `/counts` — IRIS choropleth data.
- `GET /api/iris/top-congested?limit=N` — worst-N zones by congestion score,
  ready for the dashboard "Analyse territoriale" card.
- `POST /api/map/import` — upload `.osm` / `.osm.xml`.
- Replay REST (`/api/replay/...`) backed by `FrameRecorder` (600 frames /
  ~60 s ring buffer).

### Dashboard
- Dark theme, FPS / vehicle count / latency / render-time counters.
- Vehicle count slider (50 → 20 000).
- Speed multiplier slider.
- Layer toggles (vehicles, trails, heatmap, congestion, IRIS, incidents,
  zones).
- Replay panel (scrubber, play/pause).
- Sim control panel (pause/resume, speed, vehicle count, traffic mode).

---

## Missing / suggestions

Ordered by impact (highest first).

1. **Dashboard "Analyse territoriale" card** — live top-5 congested IRIS
   pulled from `/api/iris/top-congested`, plus fleet KPIs (vehicles, FPS,
   latency, incident count). The IRIS endpoint already exists; this is
   pure frontend.
2. **A\* route cache + congested-edge avoidance** — memoise paths between
   common node pairs; when re-pathing, add a penalty to edges entering
   high-congestion IRIS zones so traffic steers away from jams.
3. **Manual incident creation from the UI** — click on a road, pick
   severity, spawn a wreck or closure. Reuses `AccidentSystem`.
4. **Incident filter chips + history list** — filter the Events overlay by
   type/severity; scrollable list in the dashboard.
5. **Demo-mode buttons** — one-click rush hour, accident scenario, emergency
   vehicle, IRIS congestion analysis, large-fleet stress test.
6. **Replay scrubber + 0.5× / 1× / 2× / 4× speed buttons** and visible
   "REPLAY" badge so it can't be confused with live mode.
7. **Map-import polish** — progress bar during parse, post-import node /
   edge counts and bounds, clearer error toast.
8. **Selected-vehicle route highlight** — draw the A* path as a glowing
   polyline on the map.
9. **Dynamic rerouting mid-trip** — re-run A* when the next 200 m has a
   wreck or heavy congestion.
10. **Vehicle type behavioural extras** — bus dwell at bus stops (would
    need bus-stop OSM tags), truck preference for arterial roads.
11. **Vehicle clustering at low zoom** — render aggregate density instead
    of 20 000 individual sprites when zoomed out.
12. **Statistics over time** — average speed / throughput per minute / jam
    length; ring buffer per metric.
13. **Day / night basemap style cycle** driven by `TrafficTimeService`.
14. **Weather simulation** — rain reduces target speed and bumps accident
    probability.
15. **Server-side tile / road-graph cache** for arbitrary regions (if we
    ever go back to Overpass).
16. **Multi-region support** — load multiple `RoadGraph`s and let the user
    switch by city without restart.
17. **CSV / JSON export of analytics** — IRIS table, fleet KPIs over time.

---

## Architectural constraints to preserve

- WebGL instanced rendering for vehicles. **Never** one DOM element /
  Angular component per vehicle.
- MapLibre layers for overlays, never DOM-overlay polygons.
- Spatial indexing (bbox prefilter, IRIS bbox cache, spatial grid for
  culling) for every per-vehicle × per-polygon test.
- Expensive analytics throttled to 250 ms — 1 s, not every tick.
- Reuse buffers in simulation loops; avoid per-tick allocation.
- Send aggregated / delta data over the wire, not full snapshots every
  frame at scale.
