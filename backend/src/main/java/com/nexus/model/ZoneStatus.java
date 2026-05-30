package com.nexus.model;

import java.util.List;

/**
 * Real-time state of a geofenced zone.
 *
 * Carries both the static definition (polygon + style) and the live count of
 * vehicles currently inside, so the frontend can render the polygon and show
 * "Low-emission Zone (147)" in the label.
 *
 * Polygon is a flat array of [lon, lat] pairs in outer-ring order; closing
 * vertex is omitted (renderer adds it).
 */
public record ZoneStatus(
        String  id,
        String  name,
        String  color,           // hex colour for fill / outline / label
        double[][] polygon,      // [[lon, lat], ...]
        int     vehiclesInside,
        long    asOfMs
) {}
