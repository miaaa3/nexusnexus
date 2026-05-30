package com.nexus.model;

public record MapLoadResponse(
        String mapName,
        int nodeCount,
        int edgeCount,
        Bounds bounds,
        String status
) {
    public record Bounds(
            double minLat,
            double maxLat,
            double minLon,
            double maxLon
    ) {}
}
