package com.nexus.simulation;

/**
 * Strategy interface for loading the road graph used by the simulation.
 *
 * Implementations:
 *   - {@link RoadNetworkLoader}          — fetches OSM data from the Overpass API (default)
 *   - LocalFileRoadGraphProvider         — loads local .osm / .osm.xml files
 *
 * Contract:
 *   {@code load()} is called once at startup (blocking).
 *   Returns a fully built {@link RoadGraph}, or {@code null} on failure.
 *   A null return keeps the road-only simulation empty.
 */
public interface RoadGraphProvider {

    /**
     * Load and return the road network graph.
     *
     * @return the loaded graph, or {@code null} if loading failed
     */
    RoadGraph load();
}
