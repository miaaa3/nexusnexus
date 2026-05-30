package com.nexus.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One broadcast frame.
 *
 * <p>Carries either a full snapshot (a <em>keyframe</em>) or a delta against
 * the previous frame:
 * <ul>
 *   <li>{@code keyframe = true}  → {@code vehicles} is the full fleet, {@code removed} is empty.
 *       The frontend replaces its local state. Sent every ~2 s.</li>
 *   <li>{@code keyframe = false} → {@code vehicles} contains only entries whose
 *       lat/lon/speed/direction/wrecked changed since the previous tick, and
 *       {@code removed} lists IDs that are no longer in the fleet.</li>
 * </ul>
 *
 * <p>{@code vehicleCount} is always the <em>total</em> fleet size on the
 * backend — used by the dashboard, independent of delta vs. keyframe.
 *
 * <p>Recorded frames are always keyframes so replay can seek to any point
 * without reconstructing history.
 */
public record SimulationFrame(
        long timestamp,
        int  vehicleCount,
        List<VehicleUpdate> vehicles,
        boolean keyframe,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) List<String> removed
) {

    /** Convenience: legacy 3-arg shape = keyframe with no removed IDs. */
    public SimulationFrame(long timestamp, int vehicleCount, List<VehicleUpdate> vehicles) {
        this(timestamp, vehicleCount, vehicles, true, List.of());
    }
}
