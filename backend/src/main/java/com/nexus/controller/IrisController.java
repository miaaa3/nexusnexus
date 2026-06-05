package com.nexus.controller;

import com.nexus.model.IrisZoneStatus;
import com.nexus.simulation.SimulationEngine;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * REST API for the INSEE IRIS zoning overlay.
 *
 * <p>Two endpoints:
 * <ul>
 *   <li>{@code GET /api/iris/zones}  — full zone list with polygons + live vehicle counts.
 *       Use this at init to build the MapLibre GeoJSON source.</li>
 *   <li>{@code GET /api/iris/counts} — lightweight map of codeIris → vehicleCount.
 *       Poll this every few seconds to refresh the choropleth colours.</li>
 *   <li>{@code GET /api/iris/status} — metadata: loaded flag + zone count.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/iris")
@RequiredArgsConstructor
public class IrisController {

    private final SimulationEngine simulationEngine;

    // ── Metadata ──────────────────────────────────────────────────────────────

    /**
     * Quick status check — the frontend polls this to know when IRIS zones are ready.
     */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> getStatus() {
        // Compteurs agrégés pour le header du panneau Analyse territoriale.
        List<IrisZoneStatus> zones = simulationEngine.irisZonesSnapshot();
        int active  = 0;     // ≥ 1 véhicule
        int heavy   = 0;     // congestion ≥ 0.70 — engorgés
        int trouble = 0;     // congestion ≥ 0.50 — chargés
        for (IrisZoneStatus z : zones) {
            if (z.vehicleCount() == 0) continue;
            active++;
            if (z.congestionScore() >= 0.50) trouble++;
            if (z.congestionScore() >= 0.70) heavy++;
        }
        return ResponseEntity.ok(Map.of(
                "loaded",     simulationEngine.isIrisLoaded(),
                "zoneCount",  simulationEngine.irisZoneCount(),
                "active",     active,
                "trouble",    trouble,
                "heavy",      heavy
        ));
    }

    /**
     * Re-fetch IRIS zones without restarting the server. Tries the local
     * GeoJSON file first, then falls back to IGN WFS — useful after dropping
     * a file in {@code data/iris/} or when the initial WFS load failed.
     *
     * @return {@code {"zoneCount": N}}
     */
    @PostMapping("/reload")
    public ResponseEntity<Map<String, Object>> reload() {
        int n = simulationEngine.reloadIris();
        return ResponseEntity.ok(Map.of("zoneCount", n));
    }

    /**
     * Historique du score de congestion (1 valeur par minute, max 60).
     * Renvoie {@code {codeIris, points: [..]}} avec points en ordre chronologique
     * (le dernier étant le plus récent). Liste vide si la zone est inconnue
     * ou n'a pas encore d'échantillon.
     */
    @GetMapping("/{codeIris}/history")
    public ResponseEntity<Map<String, Object>> getHistory(
            @org.springframework.web.bind.annotation.PathVariable("codeIris") String codeIris) {
        List<Double> points = simulationEngine.irisHistory(codeIris);
        Map<String, Object> out = new HashMap<>();
        out.put("codeIris", codeIris);
        out.put("points",   points);
        return ResponseEntity.ok(out);
    }

    // ── Full zone payload (called once on init) ───────────────────────────────

    /**
     * Returns all IRIS zones as a GeoJSON-compatible structure, with the current
     * vehicle count and density embedded as properties.
     *
     * <p>Response shape:
     * <pre>
     * {
     *   "type": "FeatureCollection",
     *   "features": [
     *     {
     *       "type": "Feature",
     *       "geometry": { "type": "Polygon", "coordinates": [ [[lon,lat], ...] ] },
     *       "properties": {
     *         "codeIris": "751010101",
     *         "nomIris":  "Jardin des Plantes",
     *         "typIris":  "H",
     *         "nomCom":   "Paris",
     *         "inseeComm":"75101",
     *         "vehicleCount": 12,
     *         "density": 45.3
     *       }
     *     }, ...
     *   ]
     * }
     * </pre>
     */
    @GetMapping("/zones")
    public ResponseEntity<Map<String, Object>> getZones() {
        List<IrisZoneStatus> zones = simulationEngine.irisZonesSnapshot();
        List<Map<String, Object>> features = new ArrayList<>(zones.size());

        for (IrisZoneStatus z : zones) {
            // GeoJSON Polygon coordinates: [ [ [lon,lat], ... ] ]
            List<List<double[]>> rings = List.of(List.of(z.polygon()));
            Map<String, Object> geom = Map.of(
                    "type", "Polygon",
                    "coordinates", rings
            );
            Map<String, Object> props = new HashMap<>();
            props.put("codeIris",        z.codeIris());
            props.put("nomIris",         z.nomIris());
            props.put("typIris",         z.typIris());
            props.put("nomCom",          z.nomCom());
            props.put("inseeComm",       z.inseeComm());
            props.put("vehicleCount",    z.vehicleCount());
            props.put("density",         Math.round(z.density()       * 10.0)  / 10.0);
            props.put("avgSpeedKmh",     Math.round(z.avgSpeedKmh()   * 10.0)  / 10.0);
            props.put("incidentCount",   z.incidentCount());
            props.put("congestionScore", Math.round(z.congestionScore() * 100.0) / 100.0);

            features.add(Map.of(
                    "type",       "Feature",
                    "geometry",   geom,
                    "properties", props
            ));
        }

        Map<String, Object> fc = new HashMap<>();
        fc.put("type",     "FeatureCollection");
        fc.put("features", features);
        return ResponseEntity.ok(fc);
    }

    // ── Lightweight counts (polled every 3s) ─────────────────────────────────

    /**
     * Returns only the vehicle counts per IRIS code.
     * Much lighter than /zones — no polygon data.
     */
    @GetMapping("/counts")
    public ResponseEntity<Map<String, Object>> getCounts() {
        List<IrisZoneStatus> zones = simulationEngine.irisZonesSnapshot();
        Map<String, Object> counts = new HashMap<>(zones.size() * 2);
        for (IrisZoneStatus z : zones) {
            counts.put(z.codeIris(), Map.of(
                    "count",            z.vehicleCount(),
                    "density",          Math.round(z.density()         * 10.0)  / 10.0,
                    "avgSpeedKmh",      Math.round(z.avgSpeedKmh()    * 10.0)  / 10.0,
                    "incidentCount",    z.incidentCount(),
                    "congestionScore",  Math.round(z.congestionScore() * 100.0) / 100.0
            ));
        }
        return ResponseEntity.ok(counts);
    }

    /**
     * Top-K most congested IRIS zones — handy for the dashboard's
     * "Analyse territoriale" card. Defaults to top 5 by congestionScore.
     */
    @GetMapping("/top-congested")
    public ResponseEntity<List<Map<String, Object>>> getTopCongested(
            @org.springframework.web.bind.annotation.RequestParam(defaultValue = "5") int limit) {
        List<IrisZoneStatus> zones = simulationEngine.irisZonesSnapshot();
        List<Map<String, Object>> out = new ArrayList<>(Math.min(limit, zones.size()));
        zones.stream()
                .filter(z -> z.vehicleCount() > 0)
                .sorted((a, b) -> Double.compare(b.congestionScore(), a.congestionScore()))
                .limit(Math.max(1, limit))
                .forEach(z -> {
                    Map<String, Object> row = new HashMap<>();
                    row.put("codeIris",         z.codeIris());
                    row.put("nomIris",          z.nomIris());
                    row.put("nomCom",           z.nomCom());
                    row.put("vehicleCount",     z.vehicleCount());
                    row.put("avgSpeedKmh",      Math.round(z.avgSpeedKmh()    * 10.0)  / 10.0);
                    row.put("incidentCount",    z.incidentCount());
                    row.put("congestionScore",  Math.round(z.congestionScore() * 100.0) / 100.0);
                    out.add(row);
                });
        return ResponseEntity.ok(out);
    }
}
