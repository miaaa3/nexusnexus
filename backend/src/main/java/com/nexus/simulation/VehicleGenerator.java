package com.nexus.simulation;

import com.nexus.config.SimulationConfig;
import com.nexus.model.Vehicle;
import com.nexus.model.VehicleType;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Generates the initial vehicle fleet.
 *
 * When a {@link RoadGraph} is supplied, vehicles are placed on random road
 * edges and inherit the edge's direction. Without a graph they fall back to
 * random positions inside the configured bounding box.
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
     * Generate {@code count} vehicles.
     *
     * @param count number of vehicles to create
     * @param graph road network (may be null — falls back to random positions)
     */
    public List<Vehicle> generate(int count, RoadGraph graph) {
        var rng  = ThreadLocalRandom.current();
        var area = config.getArea();
        List<Vehicle> vehicles = new ArrayList<>(count);

        for (int i = 0; i < count; i++) {
            VehicleType type    = TYPES[rng.nextInt(TYPES.length)];
            int         typeIdx = type.ordinal();
            double speed = SPEED_MIN[typeIdx]
                    + rng.nextDouble() * (SPEED_MAX[typeIdx] - SPEED_MIN[typeIdx]);

            Vehicle v = new Vehicle(UUID.randomUUID().toString().substring(0, 8), type);
            v.setCruiseSpeed(speed);   // desired free-flow speed
            v.setSpeed(speed);         // current speed — car-following modulates it

            if (graph != null && !graph.isEmpty()) {
                placeOnEdge(v, graph, rng);
            } else {
                placeRandom(v, area, rng);
            }

            vehicles.add(v);
        }
        return vehicles;
    }

    // ─── Placement helpers ────────────────────────────────────────────────────

    /**
     * Place a vehicle at a random point along a random road edge,
     * and set its direction to match that edge's bearing.
     */
    private void placeOnEdge(Vehicle v, RoadGraph graph, ThreadLocalRandom rng) {
        for (int attempt = 0; attempt < 5; attempt++) {
            long[] edge = graph.randomEdge(rng);
            double[] from = graph.getNode(edge[0]);
            double[] to   = graph.getNode(edge[1]);
            if (from == null || to == null) continue;

            double t = rng.nextDouble();   // start anywhere along the edge
            v.setLatitude (from[0] + (to[0] - from[0]) * t);
            v.setLongitude(from[1] + (to[1] - from[1]) * t);
            v.setDirection(bearing(from[0], from[1], to[0], to[1]));
            v.setRouteFromNode(edge[0]);
            v.setRouteToNode(edge[1]);
            v.setRouteProgress(t);
            // Seed a minimal path so the vehicle can move immediately. A real
            // A* path gets computed lazily by SimulationEngine.advanceOnRoad
            // when the vehicle finishes this first edge — that spreads A*
            // cost across many ticks instead of stalling the whole spawn.
            v.setRoutePath(java.util.List.of(edge[0], edge[1]));
            v.setRoutePathIndex(0);
            return;
        }
        // Extreme fallback — degenerate edge, use centre of bounding box
        var area = config.getArea();
        v.setLatitude ((area.getLatMin() + area.getLatMax()) / 2.0);
        v.setLongitude((area.getLonMin() + area.getLonMax()) / 2.0);
    }

    /** Random position inside the bounding box (used when no road graph). */
    private void placeRandom(Vehicle v, SimulationConfig.Area area, ThreadLocalRandom rng) {
        v.setLatitude (area.getLatMin() + rng.nextDouble() * (area.getLatMax() - area.getLatMin()));
        v.setLongitude(area.getLonMin() + rng.nextDouble() * (area.getLonMax() - area.getLonMin()));
        v.setDirection(rng.nextDouble() * 360);
        v.setWaypointLat(area.getLatMin() + rng.nextDouble() * (area.getLatMax() - area.getLatMin()));
        v.setWaypointLon(area.getLonMin() + rng.nextDouble() * (area.getLonMax() - area.getLonMin()));
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
}
