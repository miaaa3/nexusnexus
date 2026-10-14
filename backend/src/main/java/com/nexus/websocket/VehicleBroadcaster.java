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

    // ═══════════════════════════════════════════════════════════════════════════
    // FR : LE CHEF D'ORCHESTRE DU TEMPS RÉEL — appelé toutes les 100 ms.
    //      C'est la méthode qui :
    //        1. fait avancer la simulation (tick)
    //        2. décide s'il faut envoyer une trame ou attendre (cadence adaptive)
    //        3. décide si on envoie un KEYFRAME (état complet) ou un DELTA (changements)
    //        4. envoie la trame aux clients via WebSocket STOMP
    // ═══════════════════════════════════════════════════════════════════════════
    @Scheduled(fixedRateString = "${nexus.simulation.update-rate-ms:100}")
    public void broadcastFrame() {
        long now   = System.currentTimeMillis();
        long delta = now - lastTickTime;       // temps écoulé depuis le dernier tick
        lastTickTime = now;

        simulationEngine.tick(delta);          // ÉTAPE 1 : on fait avancer la simulation

        // ÉTAPE 2 : on choisit la cadence d'envoi selon le nombre de voitures
        //   peu de voitures → 10 Hz (vite)
        //   bcp de voitures → 2 Hz  (on respire)
        int totalForCadence = simulationEngine.getVehicleCount();
        long intervalMs = broadcastIntervalMs(totalForCadence);
        boolean firstBroadcast = lastBroadcastTime == 0L;
        // Si pas encore le moment d'envoyer → on sort (sauf si nouveau client)
        if (!firstBroadcast && !forceKeyframeNext
                && now - lastBroadcastTime < intervalMs) {
            return;
        }

        // ÉTAPE 3 : on récupère l'état courant de toutes les voitures
        List<VehicleUpdate> current = simulationEngine.snapshot();
        int total = current.size();

        // ÉTAPE 4 : on enregistre la trame pour le replay (même cadence que les clients)
        recorder.record(new SimulationFrame(now, total, current));

        // ÉTAPE 5 : on décide KEYFRAME ou DELTA
        //   keyframe = état complet (envoyé toutes les ~2 s pour resync)
        //   delta    = seulement ce qui a changé depuis la dernière trame
        framesSinceKeyframe++;
        boolean keyframe = firstBroadcast                  // première trame de la session
                        || forceKeyframeNext                // un client vient de se connecter
                        || previous.isEmpty()               // pas d'état précédent
                        || framesSinceKeyframe >= keyframeEveryFor(intervalMs);
        SimulationFrame out = keyframe ? buildKeyframe(now, total, current)
                                       : buildDelta(now, total, current);

        sendFrame(out);                         // ÉTAPE 6 : on envoie via WebSocket
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
    // FR : ENVOI DE LA TRAME (avec compression gzip si elle est grosse).
    //      1. on convertit en JSON (octets bruts)
    //      2. si JSON < 1 Ko → on envoie direct, pas la peine de compresser
    //      3. sinon → on compresse en gzip, on encode en base64
    //         (le base64 est nécessaire car SockJS est un canal "texte")
    //      4. on ajoute un header "x-compression" pour que le frontend sache
    //         qu'il doit décompresser à la réception
    private void sendFrame(SimulationFrame frame) {
        try {
            byte[] json = objectMapper.writeValueAsBytes(frame);     // JSON → octets
            // Trame petite (< 1 Ko) → on envoie sans compression
            if (json.length < COMPRESS_THRESHOLD_BYTES) {
                messagingTemplate.convertAndSend("/topic/vehicles", frame);
                return;
            }
            // Trame grosse → compression gzip
            ByteArrayOutputStream baos = new ByteArrayOutputStream(json.length / 4);
            try (GZIPOutputStream gz = new GZIPOutputStream(baos)) {
                gz.write(json);                                      // compression
            }
            // Encodage base64 pour passer dans le canal texte SockJS
            String b64 = Base64.getEncoder().encodeToString(baos.toByteArray());
            Map<String, Object> headers = new HashMap<>(2);
            headers.put(COMPRESSION_HEADER, COMPRESSION_GZIP_B64);   // signal au frontend
            messagingTemplate.convertAndSend("/topic/vehicles", b64, headers);
        } catch (Exception e) {
            // En cas d'erreur, on retombe sur l'envoi non compressé pour pas casser le flux
            log.warn("Compressed send failed ({}), falling back to plain JSON", e.getMessage());
            messagingTemplate.convertAndSend("/topic/vehicles", frame);
        }
    }

    // ── Frame builders ───────────────────────────────────────────────────────

    // FR : KEYFRAME = photo complète de TOUTES les voitures.
    //      Envoyée toutes les ~2 secondes pour permettre une resynchronisation
    //      si le client a raté un delta entre-temps.
    private SimulationFrame buildKeyframe(long now, int total, List<VehicleUpdate> current) {
        previous.clear();                                 // on oublie l'état précédent
        for (VehicleUpdate v : current) previous.put(v.id(), v); // on note tout l'état courant
        return new SimulationFrame(now, total, current, true, List.of());
    }

    // FR : DELTA = on envoie SEULEMENT les voitures qui ont changé depuis la dernière trame.
    //      Gain typique : 75% de bande passante en moins par rapport au keyframe.
    //      → c'est l'astuce qui nous a fait passer de 3473 ms à 173 ms de latence.
    private SimulationFrame buildDelta(long now, int total, List<VehicleUpdate> current) {
        List<VehicleUpdate> changed = new ArrayList<>();         // voitures qui ont changé
        Set<String> currentIds = new HashSet<>(current.size() * 2); // IDs encore présents

        // On compare chaque voiture actuelle avec son état précédent
        for (VehicleUpdate v : current) {
            currentIds.add(v.id());
            VehicleUpdate prev = previous.get(v.id());
            // Nouvelle voiture OU voiture qui a vraiment bougé → on l'envoie
            if (prev == null || changedSince(prev, v)) {
                changed.add(v);
                previous.put(v.id(), v);                          // on note la nouvelle position
            }
        }

        // On détecte les voitures qui ont DISPARU (slider qui baisse, etc.)
        List<String> removed = new ArrayList<>();
        var it = previous.entrySet().iterator();
        while (it.hasNext()) {
            var e = it.next();
            if (!currentIds.contains(e.getKey())) {
                removed.add(e.getKey());                          // on signale la suppression
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
    // FR : CADENCE ADAPTIVE — on choisit la fréquence d'envoi selon la charge.
    //      Plus il y a de voitures, plus on ralentit les envois, pour pas saturer
    //      le réseau ni le navigateur.
    //        ≥ 12 000 voitures → 1 envoi toutes les 500 ms  =  2 Hz
    //        ≥  8 000 voitures → 1 envoi toutes les 300 ms  ≈  3.3 Hz
    //        ≥  4 000 voitures → 1 envoi toutes les 200 ms  =  5 Hz
    //        ≥  2 000 voitures → 1 envoi toutes les 150 ms  ≈  6.6 Hz
    //        <  2 000 voitures → 1 envoi toutes les 100 ms  =  10 Hz
    //      L'interpolation côté client masque le ralentissement à l'œil nu.
    private static long broadcastIntervalMs(int totalVehicles) {
        if (totalVehicles >= 12_000) return 500L; // 2 Hz
        if (totalVehicles >= 8_000)  return 300L; // ~3.3 Hz
        if (totalVehicles >= 4_000)  return 200L; // 5 Hz
        if (totalVehicles >= 2_000)  return 150L; // ~6.6 Hz
        return MIN_BROADCAST_INTERVAL_MS;         // 10 Hz
    }

    private static int keyframeEveryFor(long intervalMs) {
        return Math.max(1, (int) Math.round(KEYFRAME_TARGET_MS / (double) intervalMs));
    }
}
