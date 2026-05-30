package com.nexus.model;

/**
 * Flat DTO for the {@code GET /api/simulation/lights} snapshot.
 * One entry per signalized intersection: position + current red/green state.
 */
public record LightUpdate(double lat, double lon, boolean red) {}
