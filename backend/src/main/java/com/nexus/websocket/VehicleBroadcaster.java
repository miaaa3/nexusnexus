package com.nexus.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexus.model.SimulationFrame;
import com.nexus.model.VehicleUpdate;
import com.nexus.service.FrameRecorder;
import com.nexus.simulation.SimulationEngine;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionSubscribeEvent;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPOutputStream;

/**
 * Drives the simulation tick, records sampled frames, and broadcasts to subscribers.
 *
 * <p><b>Adaptive delta broadcast.</b> The simulation still ticks at the
 * configured rate, but WebSocket sends slow down automatically when the fleet
 * becomes very large. At 15 K+ vehicles most positions change every tick, so a
 * delta is almost as large as a full snapshot; sending that JSON every 100 ms
 * fills the SockJS/browser receive queue and dashboard latency climbs into
 * multi-second territory. We therefore keep the previous broadcast in memory,
 * send deltas against that state, and reduce the broadcast cadence at high
 * counts.
 *
 * <p>A full keyframe is sent roughly every few seconds so a client that just
 * connected — or one that fell behind — can resync without us having to track
 * per-subscriber state.
 *
 * <p>The {@link FrameRecorder} is fed full snapshots at the same adaptive
 * cadence, so replay remains seekable without forcing a 20 K-vehicle snapshot
 * allocation every scheduler tick.
 *
 * <p>Single-threaded (Spring's {@code @Scheduled} executor), so the
 * {@code previous} map needs no synchronisation.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class VehicleBroadcaster {

    private static final long MIN_BROADCAST_INTERVAL_MS = 100L;  // 10 Hz
    private static final long KEYFRAME_TARGET_MS = 2_000L;

    /**
     * Payloads below this byte threshold are sent uncompressed. The
     * gzip + base64 overhead exceeds the saving on small deltas (heartbeat-ish
     * frames where only a handful of vehicles moved) and the round-trip CPU is
     * not worth it. Anything above this — keyframes, big deltas, ramp-up — is
     * gzipped and shrinks roughly 5–7×.
     */
    private static final int COMPRESS_THRESHOLD_BYTES = 1024;
    private static final String COMPRESSION_HEADER    = "x-compression";
    private static final String COMPRESSION_GZIP_B64  = "gzip+base64";

    private final SimulationEngine     simulationEngine;
    private final SimpMessagingTemplate messagingTemplate;
    private final FrameRecorder        recorder;
    private final ObjectMapper         objectMapper;

    private long lastTickTime = System.currentTimeMillis();
    private long lastBroadcastTime = 0L;

    /** Last broadcast state, indexed by vehicle id — used to detect deltas. */
    private final Map<String, VehicleUpdate> previous = new HashMap<>();
    private int framesSinceKeyframe = 0;

    /**
     * Set when a new STOMP client subscribes to {@code /topic/vehicles}. The
     * next broadcast tick will force a keyframe so the joining client receives
     * the full fleet immediately instead of waiting up to ~2 s for the next
     * scheduled keyframe. Without this, a fresh client would see only the
     * vehicles that moved between connect and the next keyframe — i.e. the map
     * looks empty / sparse for one or two seconds after a page load.
     */
    private volatile boolean forceKeyframeNext = false;

    /**
     * Push a fresh keyframe right now, bypassing the scheduled cadence.
     * Used after any backend action that changes the fleet roster (slider
     * setVehicleCount, OSM re-import, manual incident drop) so the client
     * sees the new state inside ~50 ms instead of waiting up to the full
     * broadcast interval for the next scheduled tick.
     */
    public void pushImmediateKeyframe() {
        try {
            List<VehicleUpdate> snap = simulationEngine.snapshot();
            sendFrame(new SimulationFrame(System.currentTimeMillis(),
                                          snap.size(), snap, true, List.of()));
            // The scheduled loop must also know that the wire state was just
            // reset, so the *next* delta is computed against this fresh
            // snapshot instead of stale entries that no longer exist.
            forceKeyframeNext = true;
        } catch (Exception ex) {
            log.warn("Immediate keyframe push failed: {}", ex.getMessage());
        }
    }

    /**
     * Fires the instant a STOMP client subscribes to {@code /topic/vehicles}.
     * We do two things:
     * <ol>
     *   <li>Push a full snapshot synchronously, so the client never sits with
     *       an empty map while waiting for the next scheduled broadcast (up to
     *       100 ms of unnecessary delay).</li>
     *   <li>Set {@code forceKeyframeNext} as a belt-and-braces guarantee — even
     *       if the synchronous send is dropped/reordered on a SockJS
     *       long-polling transport, the next scheduled tick will still send a
     *       fresh keyframe.</li>
     * </ol>
     * The snapshot is taken under the engine's read lock, so it is safe to
     * call from the broker's event-listener thread while the scheduled tick
     * runs concurrently.
     */
    @EventListener
    public void onSubscribe(SessionSubscribeEvent event) {
        StompHeaderAccessor acc = StompHeaderAccessor.wrap(event.getMessage());
        String dest = acc.getDestination();
        if (!"/topic/vehicles".equals(dest)) return;

        forceKeyframeNext = true;
        try {
            List<VehicleUpdate> snap = simulationEngine.snapshot();
            sendFrame(new SimulationFrame(System.currentTimeMillis(),
                                          snap.size(), snap, true, List.of()));
        } catch (Exception ex) {
            // Don't kill the broker just because a snapshot failed; the
            // scheduled tick will retry on its next pass.
            log.warn("Immediate keyframe on subscribe failed: {}", ex.getMessage());
        }
    }

    @Scheduled(fixedRateString = "${nexus.simulation.update-rate-ms:100}")
    public void broadcastFrame() {
        long now   = System.currentTimeMillis();
        long delta = now - lastTickTime;
        lastTickTime = now;

        simulationEngine.tick(delta);

        int totalForCadence = simulationEngine.getVehicleCount();
        long intervalMs = broadcastIntervalMs(totalForCadence);
        boolean firstBroadcast = lastBroadcastTime == 0L;
        // A pending subscriber takes priority over the adaptive throttle —
        // delivering the keyframe a few ms early is exactly what we want.
        if (!firstBroadcast && !forceKeyframeNext
                && now - lastBroadcastTime < intervalMs) {
            return;
        }

        List<VehicleUpdate> current = simulationEngine.snapshot();
        int total = current.size();

        // Recorder sees full snapshots at the same cadence as live clients.
        recorder.record(new SimulationFrame(now, total, current));

        framesSinceKeyframe++;
        boolean keyframe = firstBroadcast
                        || forceKeyframeNext
                        || previous.isEmpty()
                        || framesSinceKeyframe >= keyframeEveryFor(intervalMs);
        SimulationFrame out = keyframe ? buildKeyframe(now, total, current)
                                       : buildDelta(now, total, current);

        sendFrame(out);
        lastBroadcastTime = now;
        if (keyframe) {
            framesSinceKeyframe = 0;
            forceKeyframeNext = false;
        }
    }

    /**
     * Échantillonne le score de congestion de chaque IRIS dans son ring buffer
     * 1 fois par minute. Alimente l'historique 1 h affiché dans le popup IRIS.
     */
    @Scheduled(fixedRate = 60_000L)
    public void sampleIrisHistory() {
        simulationEngine.sampleIrisHistory();
    }

    // ── Wire send (with optional gzip) ──────────────────────────────────────

    /**
     * Serialise the frame to JSON, gzip it if it crosses
     * {@link #COMPRESS_THRESHOLD_BYTES}, base64-encode so the bytes survive
     * SockJS's text framing, and ship via STOMP with an {@code x-compression}
     * header. The frontend looks at that header and decompresses with the
     * browser's native {@code DecompressionStream}.
     *
     * <p>If anything in this pipeline trips (e.g. serialisation fails), we
     * fall back to the uncompressed convertAndSend so the broadcast loop is
     * never silently dropped.
     */
    private void sendFrame(SimulationFrame frame) {
        try {
            byte[] json = objectMapper.writeValueAsBytes(frame);
            if (json.length < COMPRESS_THRESHOLD_BYTES) {
                messagingTemplate.convertAndSend("/topic/vehicles", frame);
                return;
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream(json.length / 4);
            try (GZIPOutputStream gz = new GZIPOutputStream(baos)) {
                gz.write(json);
            }
            String b64 = Base64.getEncoder().encodeToString(baos.toByteArray());
            Map<String, Object> headers = new HashMap<>(2);
            headers.put(COMPRESSION_HEADER, COMPRESSION_GZIP_B64);
            messagingTemplate.convertAndSend("/topic/vehicles", b64, headers);
        } catch (Exception e) {
            log.warn("Compressed send failed ({}), falling back to plain JSON", e.getMessage());
            messagingTemplate.convertAndSend("/topic/vehicles", frame);
        }
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

    /**
     * Adaptive broadcast cadence: lower frequency as the fleet grows. The
     * thresholds were lowered (was 6_000 → 200 ms; is now 4_000) after we
     * measured ~4 MB/s of JSON saturating SockJS at 5 K vehicles on 10 Hz,
     * which is what fed the "takes forever to change number" symptom: a big
     * one-shot delta on top of a near-saturated queue. A 5 Hz cadence at 5 K
     * is invisible thanks to the client rAF interpolator and halves bandwidth.
     */
    private static long broadcastIntervalMs(int totalVehicles) {
        if (totalVehicles >= 12_000) return 500L; // 2 Hz
        if (totalVehicles >= 8_000)  return 300L; // ~3.3 Hz
        if (totalVehicles >= 4_000)  return 200L; // 5 Hz   (was 6_000)
        if (totalVehicles >= 2_000)  return 150L; // ~6.6 Hz (new tier)
        return MIN_BROADCAST_INTERVAL_MS;         // 10 Hz
    }

    private static int keyframeEveryFor(long intervalMs) {
        return Math.max(1, (int) Math.round(KEYFRAME_TARGET_MS / (double) intervalMs));
    }
}
