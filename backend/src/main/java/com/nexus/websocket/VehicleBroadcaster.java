package com.nexus.websocket;

import com.nexus.model.SimulationFrame;
import com.nexus.model.VehicleUpdate;
import com.nexus.service.FrameRecorder;
import com.nexus.simulation.SimulationEngine;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Drives the simulation tick, records each frame, and broadcasts to subscribers.
 *
 * <p><b>Delta broadcast.</b> At 15 K+ vehicles a full snapshot every 100 ms is
 * too much JSON for the SockJS session to digest — the receive buffer fills,
 * latency climbs into multi-second territory and the session is terminated.
 * Instead we keep the previous broadcast in memory and send only entries that
 * actually moved (lat/lon/speed/direction/wrecked changed). Since
 * {@code VehicleUpdate}'s compact constructor already rounds the fields, an
 * unchanged vehicle compares exactly equal and is omitted.
 *
 * <p>A full {@link #KEYFRAME_EVERY}-tick keyframe is sent periodically so a
 * client that just connected — or one that fell behind — can resync without
 * us having to track per-subscriber state.
 *
 * <p>The {@link FrameRecorder} is fed full snapshots regardless, so the
 * replay buffer always contains seekable keyframes.
 *
 * <p>Single-threaded (Spring's {@code @Scheduled} executor), so the
 * {@code previous} map needs no synchronisation.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class VehicleBroadcaster {

    /** Full keyframe cadence: every 20 ticks ≈ 2 s at 10 Hz. */
    private static final int KEYFRAME_EVERY = 20;

    private final SimulationEngine     simulationEngine;
    private final SimpMessagingTemplate messagingTemplate;
    private final FrameRecorder        recorder;

    private long lastTickTime = System.currentTimeMillis();

    /** Last broadcast state, indexed by vehicle id — used to detect deltas. */
    private final Map<String, VehicleUpdate> previous = new HashMap<>();
    private int sinceKeyframe = 0;

    @Scheduled(fixedRateString = "${nexus.simulation.update-rate-ms:100}")
    public void broadcastFrame() {
        long now   = System.currentTimeMillis();
        long delta = now - lastTickTime;
        lastTickTime = now;

        simulationEngine.tick(delta);

        List<VehicleUpdate> current = simulationEngine.snapshot();
        int total = simulationEngine.getVehicleCount();

        // Recorder always sees full snapshots so replay can seek anywhere.
        recorder.record(new SimulationFrame(now, total, current));

        boolean keyframe = (sinceKeyframe++ % KEYFRAME_EVERY) == 0;
        SimulationFrame out = keyframe ? buildKeyframe(now, total, current)
                                       : buildDelta(now, total, current);

        messagingTemplate.convertAndSend("/topic/vehicles", out);
    }

    // ── Frame builders ───────────────────────────────────────────────────────

    private SimulationFrame buildKeyframe(long now, int total, List<VehicleUpdate> current) {
        previous.clear();
        for (VehicleUpdate v : current) previous.put(v.id(), v);
        return new SimulationFrame(now, total, current, true, List.of());
    }

    private SimulationFrame buildDelta(long now, int total, List<VehicleUpdate> current) {
        List<VehicleUpdate> changed = new ArrayList<>();
        Set<String> currentIds = new HashSet<>(current.size() * 2);

        for (VehicleUpdate v : current) {
            currentIds.add(v.id());
            VehicleUpdate prev = previous.get(v.id());
            if (prev == null || changedSince(prev, v)) {
                changed.add(v);
                previous.put(v.id(), v);
            }
        }

        List<String> removed = new ArrayList<>();
        // Use an iterator so we can drop entries in place.
        var it = previous.entrySet().iterator();
        while (it.hasNext()) {
            var e = it.next();
            if (!currentIds.contains(e.getKey())) {
                removed.add(e.getKey());
                it.remove();
            }
        }

        return new SimulationFrame(now, total, changed, false, removed);
    }

    /**
     * True iff any rendered field differs between the previous broadcast and
     * the current snapshot. Because {@code VehicleUpdate}'s compact constructor
     * rounds every numeric field, an unchanged vehicle compares exactly equal.
     */
    private static boolean changedSince(VehicleUpdate a, VehicleUpdate b) {
        return a.lat()       != b.lat()
            || a.lon()       != b.lon()
            || a.speed()     != b.speed()
            || a.direction() != b.direction()
            || a.wrecked()   != b.wrecked();
    }
}
