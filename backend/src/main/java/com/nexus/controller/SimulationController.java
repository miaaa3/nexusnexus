package com.nexus.controller;

import com.nexus.model.IncidentUpdate;
import com.nexus.model.LightUpdate;
import com.nexus.model.RouteResponse;
import com.nexus.model.ZoneStatus;
import com.nexus.simulation.SimulationEngine;
import com.nexus.simulation.TrafficMode;

import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * REST API for controlling simulation parameters at runtime.
 * Enables the frontend dashboard to adjust vehicle count and speed.
 */
@RestController
@RequestMapping("/api/simulation")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class SimulationController {

    private final SimulationEngine simulationEngine;

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> getStatus() {
        return ResponseEntity.ok(Map.of(
                "vehicleCount",    simulationEngine.getVehicleCount(),
                "speedMultiplier", simulationEngine.getSpeedMultiplier(),
                "paused",          simulationEngine.isPaused(),
                "trafficLights",   simulationEngine.trafficLightCount(),
                "activeAccidents", simulationEngine.getActiveAccidentCount(),
                "zones",           simulationEngine.zonesSnapshot().size()
        ));
    }

    /** Snapshot of every traffic light's position + current red/green state. */
    @GetMapping("/lights")
    public ResponseEntity<List<LightUpdate>> getTrafficLights() {
        return ResponseEntity.ok(simulationEngine.trafficLightSnapshot());
    }

    /**
     * Live event list — every active accident (wrecked vehicle) merged with
     * user-created incidents from the "Drop event" UI. The frontend Events
     * overlay polls this; mock data has been removed.
     */
    @GetMapping("/events")
    public ResponseEntity<List<IncidentUpdate>> getEvents() {
        return ResponseEntity.ok(simulationEngine.eventsSnapshot());
    }

    /**
     * Body for {@code POST /api/simulation/incidents}.
     *
     * <p>Required: {@code lat}, {@code lon}. Optional: {@code type}
     * (accident / closure / congestion / construction — default "accident"),
     * {@code severity} (1..3, clamped, default 2), {@code durationMs}
     * (default 60 000), {@code label} (default "{type} (manuel)").
     */
    public record CreateIncidentRequest(
            String  type,
            Integer severity,
            double  lat,
            double  lon,
            Long    durationMs,
            String  label
    ) {}

    /** Drop a user-created incident at a clicked map location. */
    @PostMapping("/incidents")
    public ResponseEntity<IncidentUpdate> createIncident(@RequestBody CreateIncidentRequest req) {
        long now = System.currentTimeMillis();
        String type     = (req.type() != null && !req.type().isBlank()) ? req.type() : "accident";
        int    severity = req.severity() == null ? 2 : Math.max(1, Math.min(3, req.severity()));
        long   duration = req.durationMs() == null ? 60_000L : Math.max(5_000L, req.durationMs());
        String label    = (req.label() != null && !req.label().isBlank())
                ? req.label() : (type + " (manuel)");

        IncidentUpdate inc = new IncidentUpdate(
                "man-" + UUID.randomUUID().toString().substring(0, 8),
                type, severity, req.lat(), req.lon(), label, now + duration
        );
        simulationEngine.addManualIncident(inc);
        return ResponseEntity.ok(inc);
    }

    /** Most recent user-created incidents — backs the "Recent events" dashboard panel. */
    @GetMapping("/incidents/history")
    public ResponseEntity<List<IncidentUpdate>> getIncidentHistory() {
        return ResponseEntity.ok(simulationEngine.incidentHistory());
    }

    /**
     * Route restante d'un véhicule donné — alimente le calque
     * « route highlight » qui dessine sur la carte le chemin du véhicule
     * sélectionné.
     *
     * <p>Réponse 200 avec la liste des coords ; 404 si véhicule inconnu ou
     * route invalide.
     */
    @GetMapping("/vehicles/{id}/route")
    public ResponseEntity<RouteResponse> getVehicleRoute(@PathVariable("id") String id) {
        RouteResponse r = simulationEngine.vehicleRoute(id);
        return r == null ? ResponseEntity.notFound().build()
                         : ResponseEntity.ok(r);
    }

    /**
     * Zone definitions + live vehicle counts. Single source of truth: the
     * frontend Zones overlay renders polygons returned from here and uses the
     * {@code vehiclesInside} count in each zone's label.
     */
    @GetMapping("/zones")
    public ResponseEntity<List<ZoneStatus>> getZones() {
        return ResponseEntity.ok(simulationEngine.zonesSnapshot());
    }

    @PostMapping("/pause")
    public ResponseEntity<Void> pause() {
        simulationEngine.pause();
        return ResponseEntity.ok().build();
    }

    @PostMapping("/resume")
    public ResponseEntity<Void> resume() {
        simulationEngine.resume();
        return ResponseEntity.ok().build();
    }

    @PostMapping("/speed")
    public ResponseEntity<Void> setSpeed(@RequestParam double multiplier) {
        simulationEngine.setSpeedMultiplier(multiplier);
        return ResponseEntity.ok().build();
    }

    @PostMapping("/vehicles")
    public ResponseEntity<Void> setVehicleCount(@RequestParam int count) {
        simulationEngine.setVehicleCount(count);
        return ResponseEntity.ok().build();
    }

    @GetMapping("/traffic")
    public ResponseEntity<Map<String, Object>> getTrafficStatus() {
        return ResponseEntity.ok(Map.of(
                "mode",          simulationEngine.getTrafficMode().name(),
                "simulatedTime", simulationEngine.getSimulatedTime()
        ));
    }

    /**
     * Override the traffic mode for demo purposes.
     * POST /api/simulation/traffic/override?mode=RUSH_HOUR  (or NORMAL, NIGHT)
     * POST /api/simulation/traffic/override            (no param = clear override)
     */
    @PostMapping("/traffic/override")
    public ResponseEntity<Void> overrideTraffic(
            @RequestParam(required = false) String mode) {
        TrafficMode m = null;
        if (mode != null && !mode.isBlank()) {
            try { m = TrafficMode.valueOf(mode.toUpperCase()); }
            catch (IllegalArgumentException ignored) {}
        }
        simulationEngine.setTrafficOverride(m);
        return ResponseEntity.ok().build();
    }
}
