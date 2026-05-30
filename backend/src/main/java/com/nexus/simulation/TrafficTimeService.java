package com.nexus.simulation;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Manages a simulated clock that advances faster than wall time.
 *
 * Default: 1 real second = 1 simulated minute (60× acceleration).
 * The simulated day cycles continuously (00:00 → 23:59 → 00:00).
 *
 * Thread-safe — tick() is called from the simulation loop, getMode()
 * and getFormattedTime() from HTTP handler threads.
 */
@Slf4j
@Component
public class TrafficTimeService {

    /** How many simulated minutes pass per real millisecond. */
    private static final double SIM_MINUTES_PER_REAL_MS = 60.0 / 1000.0;

    /** Total simulated minutes in a day. */
    private static final int MINUTES_PER_DAY = 24 * 60;

    /** Accumulated simulated minutes (modulo MINUTES_PER_DAY). */
    private final AtomicLong simMinutesX1000 = new AtomicLong(7 * 60 * 1000L); // start at 07:00

    /** When non-null, overrides the computed mode (useful for demos). */
    private volatile TrafficMode modeOverride = null;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("HH:mm");

    /**
     * Advance the simulated clock by {@code deltaMs} real milliseconds.
     * Called every tick from {@link com.nexus.websocket.VehicleBroadcaster}.
     */
    public void advance(long deltaMs) {
        long deltaSim = Math.round(deltaMs * SIM_MINUTES_PER_REAL_MS * 1000);
        simMinutesX1000.updateAndGet(v -> (v + deltaSim) % (MINUTES_PER_DAY * 1000L));
    }

    /** Current simulated hour (0–23). */
    public int simHour() {
        return (int) (simMinutesX1000.get() / 1000 / 60);
    }

    /** Current simulated minute within the hour (0–59). */
    public int simMinute() {
        return (int) ((simMinutesX1000.get() / 1000) % 60);
    }

    /** Human-readable HH:mm string for the simulated time. */
    public String getFormattedTime() {
        return LocalTime.of(simHour(), simMinute()).format(FMT);
    }

    /**
     * Determine the current traffic mode from the simulated hour.
     *
     * Rush hour : 07:00–09:00  and  17:00–19:00
     * Night     : 00:00–07:00
     * Normal    : everything else
     *
     * A manual override (set via {@link #setOverride}) takes precedence.
     */
    public TrafficMode getMode() {
        if (modeOverride != null) return modeOverride;
        int h = simHour();
        if (h < 7)  return TrafficMode.NIGHT;
        if (h < 9)  return TrafficMode.RUSH_HOUR;
        if (h < 17) return TrafficMode.NORMAL;
        if (h < 19) return TrafficMode.RUSH_HOUR;
        return TrafficMode.NORMAL;
    }

    /** Force a specific mode (null = revert to clock-based mode). */
    public void setOverride(TrafficMode mode) {
        this.modeOverride = mode;
    }
}
