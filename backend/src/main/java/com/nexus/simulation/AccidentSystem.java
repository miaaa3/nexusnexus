package com.nexus.simulation;

import com.nexus.model.Vehicle;
import com.nexus.model.VehicleType;
import lombok.extern.slf4j.Slf4j;

import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Periodically wrecks a random vehicle, turning it into a temporary obstacle.
 *
 * <p>A wrecked vehicle is frozen in place by {@code SimulationEngine}; the
 * car-following model then makes every vehicle behind it queue up naturally —
 * no explicit jam logic is needed. After a random duration the wreck clears
 * and the vehicle resumes its route.
 *
 * <p>This is a plain helper owned by {@link SimulationEngine} (not a Spring
 * bean): it holds only its own scheduling state and mutates the vehicle list
 * it is handed each tick.
 */
@Slf4j
public class AccidentSystem {

    /** Never let more than this many wrecks be active at once (avoids gridlock). */
    private static final int  MAX_ACTIVE        = 5;
    /** Minimum wall-clock gap between two new accidents. */
    private static final long MIN_INTERVAL_MS   = 10_000L;
    /** Random extra gap on top of the minimum interval. */
    private static final long INTERVAL_RANGE_MS = 16_000L;
    /** Minimum time a wreck blocks the road. */
    private static final long MIN_DURATION_MS   = 12_000L;
    /** Random extra wreck duration on top of the minimum. */
    private static final long DURATION_RANGE_MS = 20_000L;

    /** Wall-clock time at which the next accident becomes due (0 = uninitialised). */
    private long nextAccidentAtMs = 0L;

    /** Number of wrecks active as of the last {@link #update} call. */
    private int activeAccidents = 0;

    /**
     * Advance the accident system one tick.
     *
     * @param vehicles the live vehicle list (may be mutated: a vehicle gets wrecked)
     * @param nowMs    current wall-clock time in epoch millis
     */
    public void update(List<Vehicle> vehicles, long nowMs) {
        if (vehicles.isEmpty()) return;

        // First call: just schedule the first accident a little ahead.
        if (nextAccidentAtMs == 0L) {
            nextAccidentAtMs = nowMs + MIN_INTERVAL_MS;
            return;
        }

        // Count active wrecks (also the value exposed to diagnostics).
        int active = 0;
        for (Vehicle v : vehicles) {
            if (v.getWreckedUntilMs() > nowMs) active++;
        }
        activeAccidents = active;

        if (nowMs < nextAccidentAtMs || active >= MAX_ACTIVE) return;

        ThreadLocalRandom rng = ThreadLocalRandom.current();
        int size = vehicles.size();
        for (int attempt = 0; attempt < 12; attempt++) {
            Vehicle v = vehicles.get(rng.nextInt(size));
            if (v.getWreckedUntilMs() > nowMs) continue;          // already wrecked
            if (v.getType() == VehicleType.EMERGENCY) continue;   // emergency never wrecks
            if (v.getRouteFromNode() == -1L) continue;            // not placed on a road

            long duration = MIN_DURATION_MS + rng.nextLong(DURATION_RANGE_MS);
            v.setWreckedUntilMs(nowMs + duration);
            v.setSpeed(0.0);
            activeAccidents++;
            log.debug("Accident — vehicle {} wrecked for {} ms", v.getId(), duration);
            break;
        }
        nextAccidentAtMs = nowMs + MIN_INTERVAL_MS + rng.nextLong(INTERVAL_RANGE_MS);
    }

    /** Number of wrecks active as of the last {@link #update} call. */
    public int getActiveAccidents() {
        return activeAccidents;
    }

    /** Reset scheduling — used when the road graph is swapped out. */
    public void reset() {
        nextAccidentAtMs = 0L;
        activeAccidents  = 0;
    }
}
