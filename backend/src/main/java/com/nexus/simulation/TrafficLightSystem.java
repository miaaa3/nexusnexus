package com.nexus.simulation;

import com.nexus.model.LightUpdate;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Single-phase traffic lights for major intersections.
 *
 * <p>When the road graph is published, {@link #build} samples a capped set of
 * intersection nodes (degree ≥ {@link #MIN_DEGREE}) and assigns each one a
 * random cycle offset. The phase is derived <i>lazily</i> from wall-clock time
 * + offset: there is no per-tick mutation and no background thread.
 *
 * <p>{@code SimulationEngine.advanceOnRoad} calls {@link #isRed} for vehicles
 * whose destination node has a signal; if red and close enough, the vehicle
 * brakes to a stop just short of the line. The car-following model queues the
 * rest of the lane behind it automatically.
 *
 * <p>Reads ({@code isRed}, {@code hasLight}, {@code snapshot}) are safe under
 * a read lock; writes ({@code build}, {@code reset}) must hold a write lock.
 */
@Slf4j
public class TrafficLightSystem {

    /** Hard cap on the number of signals — keeps per-vehicle lookup + rendering cheap. */
    private static final int  MAX_LIGHTS = 350;
    /** Minimum node degree to qualify as a "real" signalized intersection. */
    private static final int  MIN_DEGREE = 4;
    /** Time the light stays green each cycle (ms). */
    private static final long GREEN_MS   = 9_000L;
    /** Time the light stays red each cycle (ms). */
    private static final long RED_MS     = 7_000L;
    /** Total cycle length (ms). */
    private static final long CYCLE_MS   = GREEN_MS + RED_MS;

    /** Light node id → cycle offset in ms. */
    private final Map<Long, Long>     offsets   = new HashMap<>();
    /** Light node id → [lat, lon]. */
    private final Map<Long, double[]> positions = new HashMap<>();

    /**
     * Rebuild the active light set for the given road graph. Caller must hold
     * the simulation write lock.
     */
    public void build(RoadGraph graph) {
        offsets.clear();
        positions.clear();
        if (graph == null) return;

        // Collect every node with enough neighbours to count as a crossroads.
        List<Long> candidates = new ArrayList<>();
        for (Long id : graph.nodeIds()) {
            if (graph.neighbors(id).size() >= MIN_DEGREE) {
                candidates.add(id);
            }
        }
        // Deterministic shuffle so the same map always picks the same lights.
        Collections.shuffle(candidates, new Random(0xC0FFEEL));

        int n = Math.min(MAX_LIGHTS, candidates.size());
        ThreadLocalRandom rng = ThreadLocalRandom.current();
        for (int i = 0; i < n; i++) {
            long id = candidates.get(i);
            double[] c = graph.getNode(id);
            if (c == null) continue;
            positions.put(id, c);
            offsets.put(id, rng.nextLong(CYCLE_MS));   // random per-node cycle offset
        }
        log.info("TrafficLightSystem ready — {} signals across {} candidate intersections",
                positions.size(), candidates.size());
    }

    /** True iff the given node carries a signal. */
    public boolean hasLight(long node) {
        return positions.containsKey(node);
    }

    /** True iff the signal at {@code node} is currently red. */
    public boolean isRed(long node, long nowMs) {
        Long off = offsets.get(node);
        if (off == null) return false;
        long phase = Math.floorMod(nowMs + off, CYCLE_MS);
        return phase >= GREEN_MS;   // first GREEN_MS green, rest red
    }

    /** All current signal positions + states (for the REST snapshot). */
    public List<LightUpdate> snapshot(long nowMs) {
        List<LightUpdate> out = new ArrayList<>(positions.size());
        for (Map.Entry<Long, double[]> e : positions.entrySet()) {
            double[] c = e.getValue();
            out.add(new LightUpdate(c[0], c[1], isRed(e.getKey(), nowMs)));
        }
        return out;
    }

    /** Drop all lights — used while a new road graph is being installed. */
    public void reset() {
        offsets.clear();
        positions.clear();
    }

    public int size() { return positions.size(); }
}
