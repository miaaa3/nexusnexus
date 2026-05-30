package com.nexus.model;

import lombok.Data;

import java.util.Collections;
import java.util.List;

/**
 * Core vehicle state — kept flat and minimal for fast JSON serialization
 * and WebSocket streaming. No nested objects to reduce GC pressure.
 */
@Data
public class Vehicle {

    private final String id;
    private final VehicleType type;

    // Current position
    private double latitude;
    private double longitude;

    // Movement
    private double speed;        // km/h — current speed (varies with traffic)
    private double direction;    // degrees (0 = north, clockwise)

    // ── Car-following dynamics ───────────────────────────────────────────────
    /** Desired cruising speed (km/h) — targeted when the road ahead is clear. */
    private double cruiseSpeed;
    /** Distance (m) to the nearest vehicle ahead on the same edge; huge when clear. */
    private double frontGap = Double.MAX_VALUE;

    // ── Accident state ───────────────────────────────────────────────────────
    /**
     * Wall-clock epoch time (ms) until which this vehicle is wrecked.
     * While {@code wreckedUntilMs > now} the vehicle is frozen as an obstacle.
     * 0 = never wrecked.
     */
    private long wreckedUntilMs = 0L;

    // ── Road-network routing ─────────────────────────────────────────────────
    // When the road graph is loaded, vehicles follow actual OSM edges.
    // routeFromNode and routeToNode are OSM node IDs; -1 = not yet placed.
    private long   routeFromNode = -1L;
    private long   routeToNode   = -1L;
    private double routeProgress = 0.0;   // 0.0 (at fromNode) → 1.0 (at toNode)

    // ── A* path (filled when A* routing is active) ───────────────────────────
    // Full sequence of node IDs from current position to destination.
    // routePathIndex is the fromNode index in routePath; toNode is at routePathIndex+1.
    private List<Long> routePath      = Collections.emptyList();
    private int        routePathIndex = 0;

    // ── Fallback: random waypoint (used when road graph is unavailable) ──────
    private double waypointLat;
    private double waypointLon;
}
