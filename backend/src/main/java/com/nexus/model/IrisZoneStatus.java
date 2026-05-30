package com.nexus.model;

/**
 * Snapshot of one IRIS zone — sent to the frontend via GET /api/iris/zones.
 *
 * <p>The polygon is GeoJSON-style: each point is [lon, lat].
 * The frontend uses it to draw the fill layer directly.
 *
 * <p>typIris values:
 *   H = habitat (residential)
 *   A = activité (business/commercial)
 *   D = divers (mixed)
 *   Z = zone spéciale (special)
 */
public record IrisZoneStatus(
        String   codeIris,
        String   nomIris,
        String   typIris,
        String   nomCom,
        String   inseeComm,
        double[][] polygon,       // [[lon,lat], ...]  — exterior ring only
        int      vehicleCount,
        double   density,         // vehicles per km² (approx)
        double   avgSpeedKmh,     // mean current speed of vehicles inside (0 if empty)
        int      incidentCount,   // wrecked vehicles inside right now
        double   congestionScore  // 0.0 (free flow) → 1.0 (gridlock)
) {}
