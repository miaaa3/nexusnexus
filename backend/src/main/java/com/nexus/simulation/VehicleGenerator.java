package com.nexus.simulation;

import com.nexus.config.SimulationConfig;
import com.nexus.model.Vehicle;
import com.nexus.model.VehicleType;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Generates the initial vehicle fleet.
 *
 * <p>When a {@link RoadGraph} is supplied, vehicles are placed on random road
 * edges and inherit the edge's direction. Without a graph they fall back to
 * random positions inside the configured bounding box.
 *
 * <p><b>Density-aware placement.</b> When the caller passes a snapshot of the
 * existing fleet, the generator avoids posing a new vehicle within
 * {@value #MIN_SPAWN_GAP_M} m of any vehicle already on the same edge. Without
 * this guard, a big batch spawn (e.g. slider 500 → 18 000) drops thousands of
 * vehicles onto a handful of short urban edges; many land closer than
 * {@code STOP_GAP_M} (6 m) from each other and the car-following logic clamps
 * their target speed to zero — every cluster freezes before it has a chance to
 * move and the simulation appears stuck. With the gap check, slow-add and
 * fast-add behave the same.
 */
@Component
@RequiredArgsConstructor
public class VehicleGenerator {

    private final SimulationConfig config;

    private static final VehicleType[] TYPES = VehicleType.values();

    // Speed ranges per type (km/h), indexed by VehicleType ordinal:
    //   [0] CAR  [1] BUS  [2] TRUCK  [3] MOTORCYCLE  [4] EMERGENCY
    private static final double[] SPEED_MIN = {20, 15, 18, 30, 40};
    private static final double[] SPEED_MAX = {80, 50, 65, 100, 110};

    /**
     * Minimum spacing between spawned vehicles on the same edge. Sits above
     * the car-following STOP_GAP (6 m) plus enough headroom that the new
     * vehicle starts in the soft FOLLOW zone (≤45 m), where it merely slows
     * instead of stopping.
     */
    private static final double MIN_SPAWN_GAP_M = 10.0;

    /**
     * Length of the random-walk seed path stitched onto each freshly-spawned
     * vehicle. Without it the vehicle's {@code routePath} is just the single
     * edge it was placed on, so the moment it reaches that edge's end node it
     * needs A* — and at a massive spawn (17 K+ vehicles all finishing their
     * first edge within ~3 s) the A* budget ({@code MAX_PATHS_PER_TICK = 400})
     * cannot keep up. The backlog freezes vehicles at intersections and the
     * cars behind them stack up via the car-following rule. A 6-step walk
     * gives every newcomer ~7 edges of headroom (~40-60 s of driving) before
     * the first real A* call — plenty of time for the engine to absorb the
     * demand smoothly.
     */
    private static final int SEED_WALK_STEPS = 6;

    /**
     * Generate {@code count} vehicles. Backwards-compatible overload kept for
     * the initial boot path where no existing fleet exists yet.
     */
    public List<Vehicle> generate(int count, RoadGraph graph) {
        return generate(count, graph, Collections.emptyList());
    }

    /**
     * Generate {@code count} vehicles aware of {@code existing} so newcomers
     * are placed with at least {@value #MIN_SPAWN_GAP_M} m to any existing
     * vehicle on the same directed edge. The {@code existing} list is read
     * only — the caller passes a snapshot taken under the simulation read
     * lock so the generator itself stays lock-free.
     */
    public List<Vehicle> generate(int count, RoadGraph graph, List<Vehicle> existing) {
        var rng  = ThreadLocalRandom.current();
        var area = config.getArea();
        List<Vehicle> vehicles = new ArrayList<>(count);

        // Pre-build occupancy map: edgeKey → ascending list of routeProgress.
        // Cheap to look up while placing; cheap to update as we go so newcomers
        // also avoid each other.
        Map<Long, List<Double>> occupancy = buildOccupancy(existing);

        for (int i = 0; i < count; i++) {
            VehicleType type    = TYPES[rng.nextInt(TYPES.length)];
            int         typeIdx = type.ordinal();
            double speed = SPEED_MIN[typeIdx]
                    + rng.nextDouble() * (SPEED_MAX[typeIdx] - SPEED_MIN[typeIdx]);

            Vehicle v = new Vehicle(UUID.randomUUID().toString().substring(0, 8), type);
            v.setCruiseSpeed(speed);   // desired free-flow speed
            v.setSpeed(speed);         // current speed — car-following modulates it

            if (graph != null && !graph.isEmpty()) {
                placeOnEdge(v, graph, rng, occupancy);
            } else {
                placeRandom(v, area, rng);
            }

            vehicles.add(v);
        }
        return vehicles;
    }

    // ─── Placement helpers ────────────────────────────────────────────────────

    /**
     * Place a vehicle at a point along a random road edge, ensuring it lands
     * at least {@link #MIN_SPAWN_GAP_M} from any vehicle already there.
     * Direction follows the edge bearing. Updates the running occupancy map
     * so the next call sees this placement.
     */
    private void placeOnEdge(Vehicle v, RoadGraph graph, ThreadLocalRandom rng,
                             Map<Long, List<Double>> occupancy) {
        for (int attempt = 0; attempt < 10; attempt++) {
            long[]   edge = graph.randomEdge(rng);
            double[] from = graph.getNode(edge[0]);
            double[] to   = graph.getNode(edge[1]);
            if (from == null || to == null) continue;

            double edgeLenM = haversineKm(from[0], from[1], to[0], to[1]) * 1000.0;
            if (edgeLenM < 1.0) continue; // degenerate

            long key = packEdge(edge[0], edge[1]);
            List<Double> occupied = occupancy.get(key);
            // Effective gap: shrink on tiny edges so they can still host
            // one vehicle each instead of being permanently rejected.
            double effectiveGap = edgeLenM < 2.0 * MIN_SPAWN_GAP_M
                    ? edgeLenM * 0.45
                    : MIN_SPAWN_GAP_M;

            double t = pickFreeProgress(rng, occupied, edgeLenM, effectiveGap);
            if (t < 0.0) continue; // no room on this edge, try another

            v.setLatitude (from[0] + (to[0] - from[0]) * t);
            v.setLongitude(from[1] + (to[1] - from[1]) * t);
            v.setDirection(bearing(from[0], from[1], to[0], to[1]));
            v.setRouteFromNode(edge[0]);
            v.setRouteToNode(edge[1]);
            v.setRouteProgress(t);
            // Seed a short random-walk path so the vehicle has many edges to
            // traverse before the engine needs to A* a real destination. See
            // SEED_WALK_STEPS for why this matters during a big batch spawn.
            v.setRoutePath(seedRandomWalk(graph, edge, rng));
            v.setRoutePathIndex(0);

            occupancy.computeIfAbsent(key, k -> new ArrayList<>()).add(t);
            return;
        }
        // Extreme fallback — degenerate edges everywhere, use centre of bounding box
        var area = config.getArea();
        v.setLatitude ((area.getLatMin() + area.getLatMax()) / 2.0);
        v.setLongitude((area.getLonMin() + area.getLonMax()) / 2.0);
    }

    /**
     * Build a routePath that starts with {@code startEdge} and extends it by
     * walking {@link #SEED_WALK_STEPS} random neighbouring nodes. The
     * resulting list has between 2 and {@code SEED_WALK_STEPS + 2} nodes —
     * shorter only if the graph runs out of neighbours (dead-end or isolated
     * cluster). Avoids immediate backtracking when there is a real choice,
     * so vehicles do not oscillate on the same edge.
     */
    private static List<Long> seedRandomWalk(RoadGraph graph, long[] startEdge,
                                             ThreadLocalRandom rng) {
        List<Long> path = new ArrayList<>(SEED_WALK_STEPS + 2);
        path.add(startEdge[0]);
        path.add(startEdge[1]);
        long prev = startEdge[0];
        long current = startEdge[1];
        for (int step = 0; step < SEED_WALK_STEPS; step++) {
            List<Long> neighbours = graph.neighbors(current);
            if (neighbours == null || neighbours.isEmpty()) break;
            long next = pickNextNeighbour(neighbours, prev, rng);
            path.add(next);
            prev = current;
            current = next;
        }
        return path;
    }

    /**
     * Pick a neighbour, preferring not to backtrack. Falls back to any
     * neighbour after a few attempts so dead-ends still get a move.
     */
    private static long pickNextNeighbour(List<Long> neighbours, long forbidden,
                                          ThreadLocalRandom rng) {
        int n = neighbours.size();
        if (n == 1) return neighbours.get(0);
        for (int attempt = 0; attempt < 3; attempt++) {
            long candidate = neighbours.get(rng.nextInt(n));
            if (candidate != forbidden) return candidate;
        }
        return neighbours.get(rng.nextInt(n));
    }

    /**
     * Try a few random progress values on this edge; return one that sits at
     * least {@code gapM} from every entry in {@code occupied}, or -1 if none
     * fits within the attempt budget.
     */
    private static double pickFreeProgress(ThreadLocalRandom rng, List<Double> occupied,
                                           double edgeLenM, double gapM) {
        if (occupied == null || occupied.isEmpty()) {
            return rng.nextDouble();
        }
        for (int tAttempt = 0; tAttempt < 5; tAttempt++) {
            double candidate = rng.nextDouble();
            boolean ok = true;
            for (int j = 0, n = occupied.size(); j < n; j++) {
                if (Math.abs(candidate - occupied.get(j)) * edgeLenM < gapM) {
                    ok = false;
                    break;
                }
            }
            if (ok) return candidate;
        }
        return -1.0;
    }

    /** Random position inside the bounding box (used when no road graph). */
    private void placeRandom(Vehicle v, SimulationConfig.Area area, ThreadLocalRandom rng) {
        v.setLatitude (area.getLatMin() + rng.nextDouble() * (area.getLatMax() - area.getLatMin()));
        v.setLongitude(area.getLonMin() + rng.nextDouble() * (area.getLonMax() - area.getLonMin()));
        v.setDirection(rng.nextDouble() * 360);
        v.setWaypointLat(area.getLatMin() + rng.nextDouble() * (area.getLatMax() - area.getLatMin()));
        v.setWaypointLon(area.getLonMin() + rng.nextDouble() * (area.getLonMax() - area.getLonMin()));
    }

    private static Map<Long, List<Double>> buildOccupancy(List<Vehicle> existing) {
        if (existing.isEmpty()) return new HashMap<>();
        Map<Long, List<Double>> map = new HashMap<>(Math.max(16, existing.size() / 4));
        for (Vehicle v : existing) {
            long from = v.getRouteFromNode();
            long to   = v.getRouteToNode();
            if (from < 0 || to < 0) continue;
            long key = packEdge(from, to);
            map.computeIfAbsent(key, k -> new ArrayList<>()).add(v.getRouteProgress());
        }
        return map;
    }

    private static long packEdge(long from, long to) {
        // Cheap unique mapping (from, to) → 64-bit key. Collisions only happen
        // for node ids ≥ 2^32 which OSM does not emit.
        return (from << 32) ^ (to & 0xFFFFFFFFL);
    }

    // ─── Geo helpers ──────────────────────────────────────────────────────────

    static double bearing(double lat1, double lon1, double lat2, double lon2) {
        double dLon  = Math.toRadians(lon2 - lon1);
        double lat1R = Math.toRadians(lat1);
        double lat2R = Math.toRadians(lat2);
        double y = Math.sin(dLon) * Math.cos(lat2R);
        double x = Math.cos(lat1R) * Math.sin(lat2R)
                 - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
        return (Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                 + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                   * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * 6371.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
