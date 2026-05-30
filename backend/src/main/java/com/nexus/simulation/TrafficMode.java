package com.nexus.simulation;

/**
 * Represents the current traffic condition of the simulation.
 *
 * RUSH_HOUR  — morning/evening peak (7–9h, 17–19h simulated time)
 *              Lower speeds, higher congestion, more speed variance.
 * NORMAL     — daytime off-peak (9–17h, 19–24h)
 *              Moderate speeds, standard variance.
 * NIGHT      — quiet hours (0–7h simulated time)
 *              Higher speeds, minimal congestion.
 */
public enum TrafficMode {
    RUSH_HOUR,
    NORMAL,
    NIGHT;

    /** Speed multiplier applied on top of the user-set global multiplier. */
    public double speedFactor() {
        return switch (this) {
            case RUSH_HOUR -> 0.55;
            case NORMAL    -> 1.0;
            case NIGHT     -> 1.35;
        };
    }

    /**
     * Extra random speed variance (±fraction of base speed) applied per
     * vehicle per tick to simulate uneven traffic flow.
     */
    public double variance() {
        return switch (this) {
            case RUSH_HOUR -> 0.35;
            case NORMAL    -> 0.15;
            case NIGHT     -> 0.08;
        };
    }
}
