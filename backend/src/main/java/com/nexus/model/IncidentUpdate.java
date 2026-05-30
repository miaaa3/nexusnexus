package com.nexus.model;

/**
 * A single real-time incident shown on the Events overlay.
 *
 * For now the only kind we emit is {@code "accident"} — sourced directly from
 * the {@link com.nexus.simulation.AccidentSystem}'s currently-wrecked vehicles.
 * The type/severity/label fields are kept so we can plug in additional real
 * sources later (closures, congestion clusters, construction) without changing
 * the frontend contract.
 */
public record IncidentUpdate(
        String id,
        String type,        // "accident" | "closure" | "congestion" | "construction"
        int    severity,    // 1=low 2=medium 3=high
        double lat,
        double lon,
        String label,
        long   expiresAtMs  // wall-clock ms — frontend can show countdown if useful
) {}
