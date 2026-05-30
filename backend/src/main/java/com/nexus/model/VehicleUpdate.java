package com.nexus.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Lightweight DTO sent over WebSocket every tick.
 *
 * <p>The compact constructor rounds every numeric field to the precision the
 * renderer actually uses, which trims ~25 % off the serialised JSON before
 * Jackson even runs. At 15 K vehicles that's the difference between a frame
 * fitting in the SockJS buffer and the session being terminated.
 *
 * <ul>
 *   <li>lat / lon: 5 decimal places (~1.1 m precision)</li>
 *   <li>speed: 1 decimal place</li>
 *   <li>direction: nearest integer degree</li>
 *   <li>wrecked: omitted from JSON when false (most vehicles, every tick)</li>
 * </ul>
 *
 * <p>Field names are preserved — the Angular {@code VehicleUpdate} interface
 * is unchanged.
 */
public record VehicleUpdate(
        String  id,
        double  lat,
        double  lon,
        double  speed,
        double  direction,
        VehicleType type,
        @JsonInclude(JsonInclude.Include.NON_DEFAULT) boolean wrecked
) {

    public VehicleUpdate {
        lat       = Math.round(lat       * 1e5) / 1e5;     // 5 dp ≈ 1.1 m
        lon       = Math.round(lon       * 1e5) / 1e5;
        speed     = Math.round(speed     * 10.0) / 10.0;
        direction = Math.round(direction);                  // integer degrees
    }
}
