package com.nexus.simulation;

import com.nexus.config.SimulationConfig;
import com.nexus.model.IncidentUpdate;
import com.nexus.model.IrisZoneStatus;
import com.nexus.model.LightUpdate;
import com.nexus.model.RouteResponse;
import com.nexus.model.Vehicle;
import com.nexus.model.VehicleType;
import com.nexus.model.VehicleUpdate;
import com.nexus.model.ZoneStatus;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Core simulation engine.
 *
 * Movement strategy (road graph available):
 *   Each vehicle stores routeFromNode, routeToNode, routeProgress ∈ [0,1].
 *   Every tick, progress advances by (speed × Δt) / segmentLengthKm.
 *   On reaching the destination node, a random connected neighbor is chosen
 *   (random walk on the OSM road graph) — vehicles follow real streets.
 *
 * If no graph is available, the simulation does not create free-floating
 * vehicles. Vehicles should only move on real road segments.
 *
 * Car-following:
 *   Each tick {@code computeFrontGaps()} finds, for every vehicle, the nearest
 *   vehicle ahead on the same directed edge. {@code advanceOnRoad()} then eases
 *   the vehicle's speed toward a gap-limited target with bounded acceleration /
 *   braking, so vehicles queue up instead of passing through each other.
 *
 * Performance:
 *   - Tick math uses primitives — no per-vehicle allocation.
 *   - Front-gap detection is one O(n log n) sort of a reused buffer per tick.
 *   - The road graph loads on a background thread; the web layer never blocks.
 *   - RoadGraph is read-only once published — guarded by the simulation lock.
 *   - CopyOnWriteArrayList: structural mutations are rare, reads dominate.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SimulationEngine {

    private final SimulationConfig    config;
    private final VehicleGenerator    generator;
    private final RoadNetworkLoader   networkLoader;   // implements RoadGraphProvider
    private final TrafficTimeService  trafficTime;
    private final IrisLoader          irisLoader;

    private final CopyOnWriteArrayList<Vehicle> vehicles = new CopyOnWriteArrayList<>();
    private final ReadWriteLock simulationLock = new ReentrantReadWriteLock();

    /**
     * Vehicles waiting to be merged into the live fleet, drained at
     * {@link #SPAWN_BATCH_PER_TICK} per tick. Set on every batch spawn
     * (slider 500 → 18 000), populated by {@link #setVehicleCount}, drained
     * at the very top of {@link #tick}. Using a concurrent deque avoids the
     * need to fight for the write lock from the REST controller thread.
     *
     * <p><b>Why staggered.</b> Dropping 17 K vehicles into the simulation in
     * a single tick caused them to converge on the same edges at the same
     * times and stall en masse — even with smart placement, hot-edge avoidance
     * could not unwind the simultaneous demand spike. Slow add empirically
     * works; this queue is just the engine doing slow add for the user.
     */
    private final java.util.concurrent.ConcurrentLinkedDeque<Vehicle> pendingSpawn =
            new java.util.concurrent.ConcurrentLinkedDeque<>();
    /** Max vehicles drained from {@link #pendingSpawn} per tick. */
    private static final int SPAWN_BATCH_PER_TICK = 500;

    /** Null when Overpass fetch fails — road-only simulation stays empty. */
    private RoadGraph graph;

    private static final double EARTH_RADIUS_KM = 6371.0;
    private static final double DEG_TO_RAD      = Math.PI / 180.0;
    private static final double RAD_TO_DEG      = 180.0 / Math.PI;

    // ── Car-following tuning ─────────────────────────────────────────────────
    /** Bumper-to-bumper distance (m) at which a follower comes to a full stop. */
    private static final double STOP_GAP_M   = 6.0;
    /** Gap (m) below which a follower starts easing off the throttle. */
    private static final double FOLLOW_GAP_M = 45.0;
    /** Acceleration ceiling (km/h gained per simulated second) ≈ 2.5 m/s². */
    private static final double ACCEL_KMH_S  = 9.0;
    /** Braking ceiling (km/h shed per simulated second) ≈ 6.6 m/s². */
    private static final double DECEL_KMH_S  = 24.0;
    /** Distance (m) before a red light at which a vehicle starts braking. */
    private static final double LIGHT_TRIGGER_M = 50.0;

    /**
     * Per-type acceleration / braking multipliers, indexed by {@link VehicleType#ordinal()}.
     * Order MUST match the enum declaration: CAR, BUS, TRUCK, MOTORCYCLE, EMERGENCY.
     *
     * Trucks/buses are sluggish on the throttle and slower to shed speed;
     * motorcycles and emergency vehicles are snappy and can brake harder.
     */
    private static final double[] ACCEL_MULT = { 1.00, 0.65, 0.50, 1.40, 1.30 };
    private static final double[] DECEL_MULT = { 1.00, 0.85, 0.75, 1.15, 1.25 };

    /** Order vehicles by directed edge, then ascending progress along it. */
    private static final Comparator<Vehicle> EDGE_ORDER =
            Comparator.comparingLong(Vehicle::getRouteFromNode)
                    .thenComparingLong(Vehicle::getRouteToNode)
                    .thenComparingDouble(Vehicle::getRouteProgress);

    /** Reused scratch buffer for per-tick front-gap sorting (no per-tick alloc). */
    private Vehicle[] gapBuffer = new Vehicle[0];

    /**
     * Per-tick cap on the number of A* searches we'll run for lazy path
     * reassignment. Keeps a 15K-vehicle scale-up from spiking the tick when
     * many vehicles finish their initial edge in the same frame.
     *
     * <p>Bumped from 400 → 800 after empirically watching a 500 → 18 000
     * slider jump freeze the fleet for several seconds: vehicles all finished
     * their initial edge within a 3-second window and queued for paths while
     * the cars behind them stacked up via car-following. 800/tick × 10 Hz =
     * 8 000 A* per second covers an 18 K spawn in about 2 s instead of 4-5.
     * The cache absorbs most of the work so the actual CPU bump is modest.
     */
    // FR : BUDGET A* PAR TICK = 800 calculs de route max par tick.
    //      Pourquoi ? Si on devait calculer 18 000 routes A* d'un coup, le serveur
    //      figerait pendant plusieurs secondes. À 800 par tick × 10 ticks/sec =
    //      8 000 routes/seconde, on étale la charge sur 2 secondes.
    //      Le cache LRU absorbe la plupart des calculs (chemins réutilisés).
    private static final int MAX_PATHS_PER_TICK = 800;
    private int pathBudgetThisTick = 0;            // budget restant pour ce tick

    // ── A* route cache + hot-edge avoidance ──────────────────────────────────
    /** Vehicles on the same directed edge above this count → mark as hot. */
    private static final int  HOT_EDGE_THRESHOLD = 6;
    /** Hot-edge set is recomputed at most once every this many ms. */
    private static final long HOT_REFRESH_MS     = 1_000L;

    /** Cached A* paths — short TTL + generation-stamped so jams expire cleanly. */
    private final RouteCache routeCache = new RouteCache();
    /** Reused per-tick edge → vehicle count buffer. */
    private final java.util.HashMap<Long, Integer> edgeCounts =
            new java.util.HashMap<>(4096);
    /** Snapshot of currently congested directed edges (packed). Immutable once published. */
    private volatile java.util.Set<Long> hotEdges = java.util.Set.of();
    /** Bumped every time {@link #hotEdges} is replaced; part of the cache key. */
    private long hotGeneration = 0;
    private long lastHotRefreshMs = 0;

    /** Spawns and clears road accidents — wrecked vehicles act as obstacles. */
    private final AccidentSystem accidents = new AccidentSystem();

    /** Red/green signals at major intersections. */
    private final TrafficLightSystem lights = new TrafficLightSystem();

    /** Live geofence overlay — counts vehicles inside each named zone. */
    private final ZoneSystem zones = new ZoneSystem();

    /** User-created incidents (Drop event button) — merged into eventsSnapshot. */
    private final ManualIncidentSystem manualIncidents = new ManualIncidentSystem();

    /** INSEE IRIS zoning — loaded from IGN WFS after graph bounds are known. */
    private final IrisZoneSystem irisZones = new IrisZoneSystem();

    private volatile double  speedMultiplier = 1.0;
    private volatile boolean paused          = false;

    /**
     * Kick off road-graph loading on a background thread so the web layer
     * (REST + WebSocket) comes up immediately. Large OSM files can take many
     * seconds to parse; until the graph is ready the simulation simply has
     * zero vehicles and {@code tick()} is a no-op.
     */
    @PostConstruct
    public void init() {
        Thread loader = new Thread(this::loadGraphAndPopulate, "nexus-graph-loader");
        loader.setDaemon(true);
        loader.start();
        log.info("SimulationEngine starting — road graph ({}) loading in background…",
                config.getGraphSource());
    }

    /** Runs on the background loader thread: parse the graph, then spawn vehicles. */
    private void loadGraphAndPopulate() {
        // "local-file" (default) → LocalFileRoadGraphProvider (parses config.localFile)
        // "overpass"             → RoadNetworkLoader (fetches from the Overpass API)
        RoadGraphProvider provider = switch (config.getGraphSource().toLowerCase()) {
            case "overpass" -> networkLoader;
            default         -> new LocalFileRoadGraphProvider(Path.of(config.getLocalFile()));
        };

        long startMs = System.currentTimeMillis();
        RoadGraph loaded = provider.load();
        if (loaded == null) {
            log.error("Road graph unavailable — simulation stays empty; no off-road movement is generated.");
            return;
        }

        // Generate the fleet OUTSIDE the lock — it touches no shared state and
        // each vehicle gets a minimal 2-node path from the generator, so A*
        // is amortised lazily in advanceOnRoad and the spawn is non-blocking.
        var spawned = generator.generate(config.getVehicleCount(), loaded);

        simulationLock.writeLock().lock();
        try {
            graph = loaded;
            lights.build(loaded);
            vehicles.clear();
            vehicles.addAll(spawned);
        } finally {
            simulationLock.writeLock().unlock();
        }

        // Load IRIS zones for the actual graph bounds (background thread — non-blocking).
        // RoadGraph.Bounds exposes minLat/maxLat/minLon/maxLon as record accessors.
        RoadGraph.Bounds b = loaded.bounds();
        var irisZoneList = loadIrisZones(b);
        simulationLock.writeLock().lock();
        try {
            irisZones.loadZones(irisZoneList);
        } finally {
            simulationLock.writeLock().unlock();
        }

        log.info("SimulationEngine ready — {} vehicles, {} nodes / {} edges (loaded in {} ms)",
                vehicles.size(), loaded.nodeCount(), loaded.edgeCount(),
                System.currentTimeMillis() - startMs);
    }

    // ─── Tick ─────────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════════
    // FR : LE CŒUR DE LA SIMULATION — appelé toutes les 100 ms par le scheduler.
    //      C'est ici que TOUT se passe : on avance le temps, on met à jour les
    //      voitures, les accidents, les zones IRIS, les feux, etc.
    //      → 10 fois par seconde, on rejoue ce cycle.
    // ═══════════════════════════════════════════════════════════════════════════
    public void tick(long deltaMs) {
        // ÉTAPE 0 : on crée les nouvelles voitures en attente (par paquets de 500)
        //           AVANT de prendre le verrou de lecture — sinon ça bloquerait.
        drainPendingSpawn();

        simulationLock.readLock().lock();        // on verrouille pour la lecture
        try {
            if (paused) return;                  // simulation en pause → on sort
            trafficTime.advance(deltaMs);        // on avance l'horloge simulée

            // Récup le mode courant (NORMAL / RUSH_HOUR / NIGHT) et ses paramètres
            TrafficMode mode   = trafficTime.getMode();
            // dt = pas de temps en secondes, ajusté par le multiplicateur et le mode
            double      dt     = (deltaMs / 1000.0) * speedMultiplier * mode.speedFactor();
            double      jitter = mode.variance();           // variance des vitesses
            var         rng    = ThreadLocalRandom.current(); // générateur aléatoire thread-local

            if (graph == null) return;                       // pas de carte chargée → on sort
            long nowMs = System.currentTimeMillis();         // timestamp courant

            // ÉTAPE 1 : on met à jour tous les sous-systèmes
            accidents.update(vehicles, nowMs);   // accidents (apparitions/disparitions)
            zones.update(vehicles, nowMs);       // zones simples (4 Hz interne)
            irisZones.update(vehicles, nowMs);   // zones IRIS — congestion par quartier (4 Hz)
            refreshHotEdges(nowMs);              // routes saturées pour A* (1 Hz interne)
            computeFrontGaps();                  // calcul distance à la voiture de devant

            // ÉTAPE 2 : on alloue un BUDGET de calculs A* pour ce tick
            //           → évite que tout calcule en même temps et fige le serveur
            pathBudgetThisTick = MAX_PATHS_PER_TICK;

            // ÉTAPE 3 : on fait avancer CHAQUE voiture le long de sa route
            for (var v : vehicles) advanceOnRoad(v, dt, rng, jitter, nowMs);
        } finally {
            simulationLock.readLock().unlock();  // on libère le verrou
        }
    }

    // ─── Road-network movement ─────────────────────────────────────────────────

    private void advanceOnRoad(Vehicle v, double dt, ThreadLocalRandom rng, double jitter, long nowMs) {
        // A wrecked vehicle is frozen in place — it becomes a static obstacle
        // that following vehicles queue behind (handled by car-following).
        if (v.getWreckedUntilMs() > nowMs) {
            v.setSpeed(0.0);
            return;
        }

        // Apply per-vehicle speed variance to simulate uneven traffic flow
        double effectiveDt = dt * (1.0 + (rng.nextDouble() * 2.0 - 1.0) * jitter);

        // Ensure vehicle has a valid A* path with at least one segment remaining.
        // routePathIndex is the fromNode index; toNode is at pathIndex+1.
        List<Long> currentPath = v.getRoutePath();
        if (currentPath.isEmpty() || v.getRoutePathIndex() + 1 >= currentPath.size()) {
            assignNewPath(v, rng);
            if (v.getRoutePath().isEmpty()) return; // couldn't place — skip tick
        }

        long fromId = v.getRouteFromNode();
        long toId   = v.getRouteToNode();

        // Safety: unplaced vehicle (shouldn't happen post-init, but be defensive)
        if (fromId == -1L || toId == -1L) {
            reassignEdge(v, rng);
            return;
        }

        double[] from = graph.getNode(fromId);
        double[] to   = graph.getNode(toId);
        if (from == null || to == null) {
            reassignEdge(v, rng);
            return;
        }

        // Edge length used by both the light check and the movement step.
        double segLenKm = haversineKm(from[0], from[1], to[0], to[1]);

        // ── Car-following: ease speed toward a gap-limited target ──────────────
        // Closer to the vehicle ahead → lower target speed; below STOP_GAP → halt.
        double cruise = v.getCruiseSpeed();
        double gapM   = v.getFrontGap();
        double target = cruise;
        if (gapM < STOP_GAP_M) {
            target = 0.0;
        } else if (gapM < FOLLOW_GAP_M) {
            target = cruise * (gapM - STOP_GAP_M) / (FOLLOW_GAP_M - STOP_GAP_M);
        }

        // ── Traffic light: hold short of a red signal at the destination node ──
        // EMERGENCY vehicles bypass the signal — siren on, others yield.
        boolean holdForLight = false;
        if (lights.hasLight(toId) && v.getType() != VehicleType.EMERGENCY) {
            double remainingM = (1.0 - v.getRouteProgress()) * segLenKm * 1000.0;
            if (remainingM < LIGHT_TRIGGER_M && lights.isRed(toId, nowMs)) {
                target = 0.0;
                holdForLight = true;
            }
        }

        // Approach the target with bounded acceleration / braking (no instant jumps).
        // Per-type multipliers make trucks lumber and motorcycles dart.
        int typeIdx = v.getType().ordinal();
        double speed = v.getSpeed();
        double maxUp = ACCEL_KMH_S * ACCEL_MULT[typeIdx] * effectiveDt;
        double maxDn = DECEL_KMH_S * DECEL_MULT[typeIdx] * effectiveDt;
        speed += Math.max(-maxDn, Math.min(maxUp, target - speed));
        if (speed < 0.0)    speed = 0.0;
        if (speed > cruise) speed = cruise;
        v.setSpeed(speed);

        double distKm   = (speed / 3600.0) * effectiveDt;
        double delta    = segLenKm > 1e-9 ? distKm / segLenKm : 1.0;
        double progress = v.getRouteProgress() + delta;
        // Never run a red — clamp progress just short of the stop line.
        if (holdForLight && progress >= 1.0) progress = 0.999;

        if (progress >= 1.0) {
            // Arrived at toId — advance to the next segment in the A* path.
            // routePathIndex is the fromNode index; toNode is at routePathIndex+1.
            // The new from = old to (routePathIndex+1); the new to = routePathIndex+2.
            int newFromIdx = v.getRoutePathIndex() + 1;
            List<Long> path = v.getRoutePath();

            if (newFromIdx + 1 < path.size()) {
                long nextId = path.get(newFromIdx + 1);
                v.setRouteFromNode(toId);           // path[newFromIdx]
                v.setRouteToNode(nextId);            // path[newFromIdx + 1]
                v.setRoutePathIndex(newFromIdx);
                v.setRouteProgress(0.0);

                double[] newTo = graph.getNode(nextId);
                if (newTo != null) {
                    v.setLatitude(to[0]);
                    v.setLongitude(to[1]);
                    v.setDirection(bearing(to[0], to[1], newTo[0], newTo[1]));
                }
            } else {
                // Reached final destination — assign a new A* path
                assignNewPath(v, rng);
            }
        } else {
            v.setRouteProgress(progress);
            v.setLatitude (from[0] + (to[0] - from[0]) * progress);
            v.setLongitude(from[1] + (to[1] - from[1]) * progress);
            v.setDirection(bearing(from[0], from[1], to[0], to[1]));
        }
    }

    /**
     * For every vehicle, find the nearest vehicle ahead on the same directed
     * edge and record the gap (meters) in {@link Vehicle#getFrontGap()}.
     *
     * Sorting the fleet by (edge, progress) makes each vehicle's leader its
     * immediate successor in the sorted array — one O(n log n) pass, no maps,
     * no per-tick allocation beyond the sort's internal scratch.
     */
    private void computeFrontGaps() {
        int n = vehicles.size();
        if (n == 0) return;

        if (gapBuffer.length < n) {
            gapBuffer = new Vehicle[Math.max(n, 64)];
        }
        Vehicle[] buf = gapBuffer;
        for (int i = 0; i < n; i++) {
            Vehicle v = vehicles.get(i);
            v.setFrontGap(Double.MAX_VALUE);   // default: clear road ahead
            buf[i] = v;
        }
        Arrays.sort(buf, 0, n, EDGE_ORDER);

        for (int i = 0; i + 1 < n; i++) {
            Vehicle behind = buf[i];
            Vehicle ahead  = buf[i + 1];
            long fromId = behind.getRouteFromNode();
            if (fromId == -1L) continue;
            // Same directed edge? Then `ahead` (higher progress) is the leader.
            if (fromId != ahead.getRouteFromNode()
                    || behind.getRouteToNode() != ahead.getRouteToNode()) {
                continue;
            }
            double[] from = graph.getNode(fromId);
            double[] to   = graph.getNode(behind.getRouteToNode());
            if (from == null || to == null) continue;

            double segM = haversineKm(from[0], from[1], to[0], to[1]) * 1000.0;
            double gap  = (ahead.getRouteProgress() - behind.getRouteProgress()) * segM;
            behind.setFrontGap(gap < 0.0 ? 0.0 : gap);
        }
    }

    /** Place vehicle on a random valid graph edge when its current route state is invalid. */
    private void reassignEdge(Vehicle v, ThreadLocalRandom rng) {
        for (int i = 0; i < 5; i++) {
            long[]   edge = graph.randomEdge(rng);
            double[] from = graph.getNode(edge[0]);
            double[] to   = graph.getNode(edge[1]);
            if (from == null || to == null) continue;
            v.setRouteFromNode(edge[0]);
            v.setRouteToNode(edge[1]);
            v.setRouteProgress(0.0);
            v.setLatitude(from[0]);
            v.setLongitude(from[1]);
            v.setDirection(bearing(from[0], from[1], to[0], to[1]));
            return;
        }
    }

    /**
     * Rebuild the {@link #hotEdges} set if the refresh interval has elapsed.
     *
     * <p>Counts vehicles per directed edge in a reusable HashMap; any edge
     * with {@link #HOT_EDGE_THRESHOLD} or more vehicles is flagged. The new
     * set is published atomically and the {@link #hotGeneration} counter
     * is bumped so {@link RouteCache} entries computed under the prior
     * generation are skipped — this is what makes "avoid this jam" decay
     * naturally as the jam clears.
     *
     * <p>Cost at 15 K vehicles: one HashMap.merge per vehicle (~3 ms) plus a
     * single pass over the entries; amortised at 1 Hz it's negligible.
     */
    private void refreshHotEdges(long nowMs) {
        if (nowMs - lastHotRefreshMs < HOT_REFRESH_MS) return;
        lastHotRefreshMs = nowMs;

        edgeCounts.clear();
        for (Vehicle v : vehicles) {
            long from = v.getRouteFromNode();
            long to   = v.getRouteToNode();
            if (from == -1L || to == -1L) continue;
            edgeCounts.merge(AStarPathfinder.packEdge(from, to), 1, Integer::sum);
        }

        java.util.Set<Long> next = new java.util.HashSet<>();
        for (var e : edgeCounts.entrySet()) {
            if (e.getValue() >= HOT_EDGE_THRESHOLD) next.add(e.getKey());
        }

        // Only bump the generation when the set actually changes — keeps the
        // route cache useful during steady-state traffic.
        if (!next.equals(hotEdges)) {
            hotEdges = java.util.Set.copyOf(next);
            hotGeneration++;
        }
    }

    /**
     * Compute a new A* path from the vehicle's current node to a random destination.
     * Sets routePath, routePathIndex, routeFromNode, routeToNode accordingly.
     */
    private void assignNewPath(Vehicle v, ThreadLocalRandom rng) {
        // Budget exhausted this tick — leave the path empty; the vehicle will
        // be retried next tick. Prevents A* spikes after a big scale-up.
        if (pathBudgetThisTick <= 0) {
            v.setRoutePath(List.of());
            return;
        }
        pathBudgetThisTick--;

        // Determine current node (use routeToNode if we just arrived, else routeFromNode)
        long currentNode = v.getRouteToNode() != -1L ? v.getRouteToNode() : v.getRouteFromNode();
        if (currentNode == -1L) {
            reassignEdge(v, rng);
            return;
        }

        long nowMs = System.currentTimeMillis();
        var snapshotHot = this.hotEdges;     // local copy: stable for the loop

        for (int attempt = 0; attempt < 8; attempt++) {
            long dest = AStarPathfinder.randomNode(graph, rng);
            if (dest == currentNode) continue;

            // 1. Try the cache first — saves the full A* search if a fresh
            //    path for the same (start, goal) under the current hot-edge
            //    generation already exists.
            List<Long> path = routeCache.get(currentNode, dest, hotGeneration, nowMs);
            if (path == null) {
                // 2. Cache miss — compute and store. A* itself penalises hot
                //    edges by HOT_EDGE_PENALTY so vehicles steer around jams.
                path = AStarPathfinder.findPath(graph, currentNode, dest, snapshotHot);
                routeCache.put(currentNode, dest, path, hotGeneration, nowMs);
            }
            if (path.size() >= 2 && graph.neighbors(path.get(0)).contains(path.get(1))) {
                v.setRoutePath(path);
                v.setRoutePathIndex(0);
                v.setRouteFromNode(path.get(0));
                v.setRouteToNode(path.get(1));
                v.setRouteProgress(0.0);
                return;
            }
        }

        // Keep the vehicle on its current road segment if no route is found.
        v.setRoutePath(List.of());
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    public List<VehicleUpdate> snapshot() {
        simulationLock.readLock().lock();
        try {
            long nowMs = System.currentTimeMillis();
            List<VehicleUpdate> updates = new ArrayList<>(vehicles.size());
            for (var v : vehicles) {
                updates.add(new VehicleUpdate(
                        v.getId(), v.getLatitude(), v.getLongitude(),
                        v.getSpeed(), v.getDirection(), v.getType(),
                        v.getWreckedUntilMs() > nowMs));
            }
            return updates;
        } finally {
            simulationLock.readLock().unlock();
        }
    }

    public int         getVehicleCount()            {
        simulationLock.readLock().lock();
        try { return vehicles.size(); }
        finally { simulationLock.readLock().unlock(); }
    }

    /**
     * Bounding box of the currently-loaded road graph, or {@code null} if it
     * has not been loaded yet (graph load happens on a background thread at
     * boot). Used by the frontend congestion grid to size its cells around
     * the real simulation area instead of relying on hard-coded coords.
     */
    public RoadGraph.Bounds getGraphBounds() {
        simulationLock.readLock().lock();
        try { return graph != null ? graph.bounds() : null; }
        finally { simulationLock.readLock().unlock(); }
    }

    /**
     * Snap a raw click point to the nearest road segment. Used by the
     * "drop incident" feature so user-created incidents always anchor to a
     * real road. Falls back to the input coords if the graph is not yet
     * loaded.
     */
    public double[] snapToNearestRoad(double lat, double lon) {
        simulationLock.readLock().lock();
        try {
            return graph != null ? graph.snapToNearestEdge(lat, lon)
                                 : new double[]{lat, lon};
        } finally { simulationLock.readLock().unlock(); }
    }

    /**
     * Find the closest vehicle to {@code (lat, lon)} within {@code maxKm}.
     * Returns {@code null} when no vehicle sits in range — the caller can
     * then fall back to a road-snap, or refuse the request. Used by the
     * "drop incident" flow so a manual accident always targets an actual
     * vehicle the user can see on the map.
     */
    public Vehicle nearestVehicle(double lat, double lon, double maxKm) {
        Vehicle best = null;
        double bestKm = maxKm;
        for (Vehicle v : vehicles) {
            // Cheap rough filter on lat/lon delta before haversine, so the
            // hot path stays linear and lock-free at 18 K vehicles.
            double dLat = lat - v.getLatitude();
            double dLon = lon - v.getLongitude();
            if (Math.abs(dLat) > 0.05 || Math.abs(dLon) > 0.05) continue;
            double km = haversineKm(lat, lon, v.getLatitude(), v.getLongitude());
            if (km < bestKm) {
                bestKm = km;
                best   = v;
            }
        }
        return best;
    }

    /**
     * Mark a vehicle as wrecked for {@code durationMs} from now. The vehicle
     * freezes in place and becomes a car-following obstacle until the
     * timestamp elapses. Returns false if the id is unknown so the caller
     * can react (e.g. the vehicle was already removed via a count change).
     */
    public boolean wreckVehicle(String id, long durationMs) {
        long until = System.currentTimeMillis() + Math.max(5_000L, durationMs);
        for (Vehicle v : vehicles) {
            if (v.getId().equals(id)) {
                v.setWreckedUntilMs(until);
                v.setSpeed(0.0);
                return true;
            }
        }
        return false;
    }
    public double      getSpeedMultiplier()         { return speedMultiplier; }
    public void        setSpeedMultiplier(double m) { speedMultiplier = Math.max(0, Math.min(10, m)); }
    public TrafficMode getTrafficMode()             { return trafficTime.getMode(); }
    public String      getSimulatedTime()           { return trafficTime.getFormattedTime(); }
    public void        setTrafficOverride(TrafficMode mode) { trafficTime.setOverride(mode); }
    public boolean     isPaused()  { return paused; }
    public void        pause()     { paused = true;  log.info("Simulation paused"); }
    public void        resume()    { paused = false; log.info("Simulation resumed"); }

    /** Current traffic-light positions + states (one entry per signal). */
    public List<LightUpdate> trafficLightSnapshot() {
        simulationLock.readLock().lock();
        try {
            return lights.snapshot(System.currentTimeMillis());
        } finally {
            simulationLock.readLock().unlock();
        }
    }

    public int trafficLightCount()    { return lights.size(); }
    public int getActiveAccidentCount() { return accidents.getActiveAccidents(); }

    /**
     * Real-time event list — currently just the live wrecks from {@link AccidentSystem}.
     * One {@link IncidentUpdate} per wrecked vehicle; severity scales with vehicle type
     * (truck/bus crashes are flagged worse than car crashes).
     */
    /**
     * Construit la route restante d'un véhicule sous forme de
     * coordonnées {@code [lon, lat]}, prête à être dessinée par MapLibre.
     *
     * <p>La route commence par la position courante (entre fromNode et toNode,
     * interpolée selon routeProgress) puis enchaîne tous les nœuds restants
     * de routePath jusqu'à la destination. Renvoie {@code null} si le véhicule
     * est introuvable, ou si sa route est invalide.
     */
    public RouteResponse vehicleRoute(String vehicleId) {
        simulationLock.readLock().lock();
        try {
            if (graph == null) return null;
            Vehicle target = null;
            for (Vehicle v : vehicles) {
                if (v.getId().equals(vehicleId)) { target = v; break; }
            }
            if (target == null) return null;

            List<Long> path = target.getRoutePath();
            int idx = target.getRoutePathIndex();
            if (path == null || path.size() < 2 || idx + 1 >= path.size()) {
                return null;
            }

            List<double[]> coords = new ArrayList<>();
            // Point courant : (lat, lon) actuel du véhicule (interpolé entre
            // les nœuds via routeProgress par advanceOnRoad).
            coords.add(new double[] { target.getLongitude(), target.getLatitude() });

            // Reste du chemin : tous les nœuds depuis toNode (= idx+1) jusqu'à la fin.
            for (int i = idx + 1; i < path.size(); i++) {
                double[] c = graph.getNode(path.get(i));
                if (c == null) continue;
                coords.add(new double[] { c[1], c[0] });   // [lon, lat]
            }

            if (coords.size() < 2) return null;
            return new RouteResponse(vehicleId, coords, 0, coords.size() - 1);
        } finally {
            simulationLock.readLock().unlock();
        }
    }

    public List<IncidentUpdate> eventsSnapshot() {
        simulationLock.readLock().lock();
        try {
            long now = System.currentTimeMillis();
            List<IncidentUpdate> out = new ArrayList<>();
            for (Vehicle v : vehicles) {
                long until = v.getWreckedUntilMs();
                if (until <= now) continue;
                int severity = switch (v.getType()) {
                    case TRUCK, BUS -> 3;
                    case CAR        -> 2;
                    default         -> 1;
                };
                out.add(new IncidentUpdate(
                        "acc-" + v.getId(),
                        "accident",
                        severity,
                        v.getLatitude(),
                        v.getLongitude(),
                        v.getType() + " accident",
                        until
                ));
            }
            // Merge user-created incidents (sweeps expired in the same pass).
            manualIncidents.appendActive(now, out);
            return out;
        } finally {
            simulationLock.readLock().unlock();
        }
    }

    /** Register a new user-created incident. Thread-safe. */
    public void addManualIncident(IncidentUpdate inc) {
        manualIncidents.add(inc);
    }

    /** Most recent N user-created incidents (newest first). Powers the dashboard panel. */
    public List<IncidentUpdate> incidentHistory() {
        return manualIncidents.snapshotHistory();
    }

    /** Snapshot every zone's polygon + live vehicle count for the Zones overlay. */
    public List<ZoneStatus> zonesSnapshot() {
        simulationLock.readLock().lock();
        try {
            return zones.snapshot(System.currentTimeMillis());
        } finally {
            simulationLock.readLock().unlock();
        }
    }

    /** Snapshot of all IRIS zones with live vehicle counts and density. */
    public List<IrisZoneStatus> irisZonesSnapshot() {
        simulationLock.readLock().lock();
        try {
            return irisZones.snapshot();
        } finally {
            simulationLock.readLock().unlock();
        }
    }

    public boolean isIrisLoaded() { return irisZones.isLoaded(); }
    public int     irisZoneCount() { return irisZones.size(); }

    /** Récupère l'historique 1 h d'une zone IRIS (max 60 samples, du + ancien au + récent). */
    public List<Double> irisHistory(String codeIris) {
        simulationLock.readLock().lock();
        try { return irisZones.historyForCode(codeIris); }
        finally { simulationLock.readLock().unlock(); }
    }

    /**
     * Échantillonne l'historique de congestion de chaque IRIS — appelé
     * 1× par minute via @Scheduled depuis VehicleBroadcaster.
     */
    public void sampleIrisHistory() {
        simulationLock.readLock().lock();
        try { irisZones.recordHistorySample(); }
        finally { simulationLock.readLock().unlock(); }
    }

    /**
     * Local-file-first IRIS load: tries {@code config.irisLocalFile} (when
     * present and readable), falls back to the IGN WFS otherwise. Logs both
     * outcomes so the operator can tell at a glance which source served the
     * polygons (or that both failed).
     */
    private List<IrisZoneSystem.IrisZone> loadIrisZones(RoadGraph.Bounds b) {
        var local = irisLoader.loadFromFile(Path.of(config.getIrisLocalFile()));
        // Before trusting the local file, check that its polygons actually
        // sit anywhere near the loaded road graph. If the local IRIS file
        // was built for a different city than the active OSM, its zones
        // would render hundreds of km off-screen. If less than 5% of the
        // local zones intersect the graph bounds, treat the file as
        // "wrong city" and fall back to the IGN WFS which we can ask for
        // the actual region.
        if (!local.isEmpty() && intersectsBounds(local, b) > 0.05) {
            log.info("Using local IRIS file ({} zones) for bounds {}", local.size(), b);
            return local;
        }
        if (!local.isEmpty()) {
            log.info("Local IRIS file does not overlap the road graph bounds — " +
                     "falling back to IGN WFS for the active city.");
        }
        return irisLoader.loadForBounds(b.minLat(), b.minLon(), b.maxLat(), b.maxLon());
    }

    /**
     * Fraction of {@code zones} whose bounding box overlaps the graph
     * bounds. Cheap rectangle-rectangle test — IrisZone caches its bbox at
     * construction so no per-call polygon sweep.
     */
    private static double intersectsBounds(List<IrisZoneSystem.IrisZone> zones,
                                           RoadGraph.Bounds b) {
        if (zones.isEmpty()) return 0.0;
        int hits = 0;
        for (var z : zones) {
            // Two AABBs overlap iff neither is fully to the side of the other.
            boolean apart = z.maxLon < b.minLon() || z.minLon > b.maxLon()
                         || z.maxLat < b.minLat() || z.minLat > b.maxLat();
            if (!apart) hits++;
        }
        return hits / (double) zones.size();
    }

    /**
     * Re-fetch IRIS zones without restarting the server — handy after dropping
     * a local file into {@code data/iris/} or to retry a failed WFS load.
     * @return number of zones now active.
     */
    public int reloadIris() {
        if (graph == null) {
            log.warn("reloadIris() ignored — road graph not yet loaded");
            return 0;
        }
        var zones = loadIrisZones(graph.bounds());
        simulationLock.writeLock().lock();
        try { irisZones.loadZones(zones); }
        finally { simulationLock.writeLock().unlock(); }
        return zones.size();
    }

    /**
     * Move up to {@link #SPAWN_BATCH_PER_TICK} vehicles from
     * {@link #pendingSpawn} into the live fleet. Called at the top of every
     * tick — at 10 Hz this digests ~5 000 vehicles per second, so a slider
     * jump 500 → 18 000 fully resolves in about 3.5 s of steady ramp instead
     * of one catastrophic dump.
     */
    // FR : CRÉATION PROGRESSIVE DES VOITURES (par paquets).
    //      Quand l'utilisateur demande 18 000 voitures, on ne les crée PAS d'un coup
    //      (sinon le serveur fige 3 secondes). On les met dans une file d'attente
    //      "pendingSpawn", et à chaque tick on en sort un paquet de SPAWN_BATCH_PER_TICK
    //      (~500). En 3-4 secondes, toutes les voitures sont en place sans freeze.
    private void drainPendingSpawn() {
        if (pendingSpawn.isEmpty()) return;                   // rien à créer → on sort
        int batch = 0;
        List<Vehicle> chunk = new ArrayList<>(SPAWN_BATCH_PER_TICK);
        Vehicle v;
        // On prend max SPAWN_BATCH_PER_TICK voitures de la file
        while (batch < SPAWN_BATCH_PER_TICK && (v = pendingSpawn.pollFirst()) != null) {
            chunk.add(v);
            batch++;
        }
        if (chunk.isEmpty()) return;
        simulationLock.writeLock().lock();                    // verrou écriture
        try {
            vehicles.addAll(chunk);                            // on ajoute le paquet à la flotte
        } finally {
            simulationLock.writeLock().unlock();
        }
        log.info("[drainSpawn] added {} → live={}, remaining queue={}",
                chunk.size(), vehicles.size(), pendingSpawn.size());
    }

    public void setVehicleCount(int count) {
        final int target = Math.min(count, config.getMaxVehicles());

        // Snapshot current size + graph + existing fleet under the read lock.
        // {@code current} includes already-queued spawns so a quick double-slide
        // does not double-count.
        int current;
        RoadGraph g;
        List<Vehicle> snapshot;
        simulationLock.readLock().lock();
        try {
            if (graph == null) {
                log.warn("Ignoring vehicle count change because road graph is unavailable");
                return;
            }
            current = vehicles.size() + pendingSpawn.size();
            g       = graph;
            snapshot = new ArrayList<>(vehicles);
            // Include already-pending spawns in the density check so newcomers
            // don't land on top of vehicles that will be added in a moment.
            snapshot.addAll(pendingSpawn);
        } finally {
            simulationLock.readLock().unlock();
        }
        if (target == current) return;

        if (target > current) {
            // Generate ALL newcomers up front (outside the lock, cheap with the
            // density-aware placement) then drop them into the staggered queue.
            // The tick loop will drain {@link #SPAWN_BATCH_PER_TICK} per pass,
            // so the simulation never sees a one-shot 17 K-vehicle scale-up —
            // it sees the same shape as an actual slow add, which we already
            // know the car-following / A* logic handles gracefully.
            List<Vehicle> newVehicles = generator.generate(target - current, g, snapshot);
            pendingSpawn.addAll(newVehicles);
        } else {
            // Shrink: first cancel pending spawns, then trim the live fleet
            // for whatever excess is left. Counting from the queue's tail is
            // O(excess) on a deque, cheap even at 17 K pending.
            int excess = current - target;
            while (excess > 0 && pendingSpawn.pollLast() != null) {
                excess--;
            }
            if (excess > 0) {
                simulationLock.writeLock().lock();
                try {
                    int cur = vehicles.size();
                    int newSize = Math.max(0, cur - excess);
                    if (newSize < cur) vehicles.subList(newSize, cur).clear();
                } finally {
                    simulationLock.writeLock().unlock();
                }
            }
        }
        log.info("[setVehicleCount] {} → {}  (live={}, queue={})",
                current, target, vehicles.size(), pendingSpawn.size());
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FR : REMPLACE LE GRAPHE ROUTIER À LA VOLÉE (suite à un upload OSM).
    //      Reset tous les états liés à l'ancienne carte : accidents, incidents,
    //      route cache, hot edges, ET zones IRIS — qui sont rechargées en
    //      ARRIÈRE-PLAN pour la nouvelle ville (peut prendre 5-30 s via IGN WFS).
    // ═══════════════════════════════════════════════════════════════════════════
    public void replaceGraph(RoadGraph newGraph, String mapName) {
        if (newGraph == null || newGraph.isEmpty() || !newGraph.bounds().isValid()) {
            throw new IllegalArgumentException("Imported road graph is empty or invalid");
        }

        // Same trick as loadGraphAndPopulate / setVehicleCount: do the heavy
        // placement work outside the lock; A* is amortised lazily.
        var spawned = generator.generate(config.getVehicleCount(), newGraph);

        simulationLock.writeLock().lock();
        try {
            boolean wasPaused = paused;
            paused = true;
            graph = newGraph;
            lights.build(newGraph);
            vehicles.clear();
            accidents.reset();
            manualIncidents.reset();     // markers were tied to the old map's lat/lon
            routeCache.clear();          // stale node IDs from the previous graph
            hotEdges = java.util.Set.of();
            hotGeneration++;
            // FR : on vide les zones IRIS de l'ancienne ville pour que la couche
            //      ne montre rien pendant que le rechargement async tourne.
            //      Sans ça, l'utilisateur verrait les polygones de La Rochelle
            //      flotter au milieu d'une autre ville pendant quelques secondes.
            irisZones.loadZones(java.util.List.of());
            vehicles.addAll(spawned);

            paused = wasPaused;
            log.info("Active road graph replaced by {} — {} vehicles, {} nodes / {} edges",
                    mapName, vehicles.size(), graph.nodeCount(), graph.edgeCount());
        } finally {
            simulationLock.writeLock().unlock();
        }

        // FR : RECHARGEMENT DES ZONES IRIS POUR LA NOUVELLE VILLE — EN ASYNCHRONE.
        //      On ne bloque pas la requête HTTP d'upload : le WFS IGN peut mettre
        //      jusqu'à 30 secondes, ce qui serait pénible pour l'utilisateur.
        //      Le frontend récupère les nouvelles zones via son polling REST
        //      /api/iris/zones quand elles sont prêtes.
        reloadIrisAsync(mapName);
    }

    // FR : Recharge les zones IRIS dans un thread daemon (background).
    //      Le frontend détectera automatiquement les nouvelles zones via son
    //      polling périodique sur /api/iris/zones.
    private void reloadIrisAsync(String mapName) {
        Thread t = new Thread(() -> {
            try {
                log.info("[IRIS] Background reload started for map '{}'", mapName);
                long t0 = System.currentTimeMillis();
                int count = reloadIris();
                long ms = System.currentTimeMillis() - t0;
                if (count > 0) {
                    log.info("[IRIS] Background reload OK — {} zones loaded for '{}' in {} ms",
                            count, mapName, ms);
                } else {
                    log.warn("[IRIS] Background reload returned 0 zones for '{}' " +
                             "(IGN WFS unreachable, or zones outside French territory)", mapName);
                }
            } catch (Exception e) {
                log.warn("[IRIS] Background reload failed for '{}': {}", mapName, e.getMessage());
            }
        }, "iris-reload-" + mapName);
        t.setDaemon(true);          // pas bloquant à l'arrêt du serveur
        t.start();
    }

    // ─── Geo helpers ──────────────────────────────────────────────────────────

    private static double bearing(double lat1, double lon1, double lat2, double lon2) {
        double dLon  = (lon2 - lon1) * DEG_TO_RAD;
        double lat1R = lat1 * DEG_TO_RAD;
        double lat2R = lat2 * DEG_TO_RAD;
        double y = Math.sin(dLon) * Math.cos(lat2R);
        double x = Math.cos(lat1R) * Math.sin(lat2R)
                 - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
        return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double dLat = (lat2 - lat1) * DEG_TO_RAD;
        double dLon = (lon2 - lon1) * DEG_TO_RAD;
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                 + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD)
                 * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
