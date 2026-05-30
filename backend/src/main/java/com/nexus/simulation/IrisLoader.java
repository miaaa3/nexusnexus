package com.nexus.simulation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Loads IRIS zone polygons. Two sources, tried in order:
 *
 * <ol>
 *   <li>{@link #loadFromFile(Path)} — a local GeoJSON file dropped under
 *       {@code backend/data/iris/}. Preferred: fast, offline, deterministic.
 *       This is the recommended way to make IRIS analytics work reliably.</li>
 *   <li>{@link #loadForBounds(double, double, double, double)} — IGN's
 *       Géoplateforme WFS, used as the network fallback. IGN's endpoint can
 *       be flaky / slow, so we set explicit timeouts, retry once, and log
 *       enough detail to actually diagnose failures.</li>
 * </ol>
 *
 * <p>GeoJSON features have geometry type Polygon or MultiPolygon. Only the
 * exterior ring of the first polygon is kept (sufficient for IRIS-level
 * visualisation and point-in-polygon at city-traffic resolution).
 *
 * <p>Properties used:
 * <ul>
 *   <li>{@code CODE_IRIS} — e.g. "171210101"</li>
 *   <li>{@code NOM_IRIS}  — e.g. "Vieux-Port"</li>
 *   <li>{@code TYP_IRIS}  — H / A / D / Z</li>
 *   <li>{@code NOM_COM}   — commune name</li>
 *   <li>{@code INSEE_COM} — INSEE commune code</li>
 * </ul>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class IrisLoader {

    /**
     * IGN Géoplateforme WFS endpoint — no API key required.
     *
     * <p>The historical typename {@code ADMINEXPRESS-COG-CARTO.LATEST:IRIS_GE}
     * was retired in the Géoplateforme migration. The current one (verified
     * 2026-05) is {@code STATISTICALUNITS.IRISGE:iris_ge}.
     */
    private static final String WFS_BASE =
            "https://data.geopf.fr/wfs/ows" +
            "?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature" +
            "&TYPENAMES=STATISTICALUNITS.IRISGE:iris_ge" +
            "&OUTPUTFORMAT=application/json" +
            "&SRSNAME=urn:ogc:def:crs:OGC:1.3:CRS84" +   // lon,lat axis order
            "&COUNT=5000" +
            "&BBOX=%s,%s,%s,%s,urn:ogc:def:crs:OGC:1.3:CRS84";

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration READ_TIMEOUT    = Duration.ofSeconds(30);

    private final ObjectMapper objectMapper;

    // ── Local-file path (preferred source) ───────────────────────────────────

    /**
     * Parse a local GeoJSON file as the IRIS source. Returns an empty list
     * (and logs a warning) if the file is missing, unreadable, or malformed —
     * the caller can then fall back to {@link #loadForBounds}.
     */
    public List<IrisZoneSystem.IrisZone> loadFromFile(Path path) {
        if (path == null || !Files.isReadable(path)) {
            log.info("IRIS local file not found at {} — will try IGN WFS instead", path);
            return List.of();
        }
        try {
            JsonNode root = objectMapper.readTree(path.toFile());
            List<IrisZoneSystem.IrisZone> zones = parseFeatureCollection(root);
            log.info("Loaded {} IRIS zones from local file {}", zones.size(), path);
            return zones;
        } catch (IOException e) {
            log.warn("Failed to read IRIS local file {}: {} ({}). Falling back to WFS.",
                    path, e.getMessage(), e.getClass().getSimpleName());
            return List.of();
        }
    }

    // ── IGN WFS path (network fallback) ──────────────────────────────────────

    /**
     * Download IRIS zones whose bounding box overlaps
     * {@code [lonMin,latMin,lonMax,latMax]}. Tries the IGN endpoint once,
     * retries once on transport-level failure. Returns an empty list on
     * permanent failure — callers must handle gracefully.
     */
    public List<IrisZoneSystem.IrisZone> loadForBounds(
            double latMin, double lonMin, double latMax, double lonMax) {

        String url = String.format(WFS_BASE, lonMin, latMin, lonMax, latMax);
        log.info("Fetching IRIS zones from IGN WFS: bounds [{},{} → {},{}]",
                latMin, lonMin, latMax, lonMax);

        for (int attempt = 1; attempt <= 2; attempt++) {
            try {
                String raw = fetch(url);
                if (raw == null || raw.isBlank()) {
                    log.warn("IGN WFS returned empty response (attempt {}/2)", attempt);
                    continue;
                }
                JsonNode root = objectMapper.readTree(raw);
                List<IrisZoneSystem.IrisZone> zones = parseFeatureCollection(root);
                log.info("Loaded {} IRIS zones from IGN WFS", zones.size());
                return zones;
            } catch (RestClientResponseException http) {
                // HTTP-level error — body usually says why; log the first 500 chars
                String excerpt = http.getResponseBodyAsString();
                if (excerpt.length() > 500) excerpt = excerpt.substring(0, 500) + "…";
                log.warn("IGN WFS HTTP {} on attempt {}/2: {}",
                        http.getStatusCode(), attempt, excerpt);
                if (!shouldRetry(http.getStatusCode())) break;
            } catch (Exception e) {
                // Transport, parse, or anything else — log type + message so we
                // can actually tell connection refused vs. timeout vs. JSON err.
                log.warn("IGN WFS failed on attempt {}/2: {} ({})",
                        attempt, e.getMessage(), e.getClass().getSimpleName());
            }
        }
        log.warn("Giving up on IGN WFS — IRIS layer disabled. "
               + "Drop a local GeoJSON in data/iris/ to enable offline.");
        return List.of();
    }

    /** Single HTTP GET with timeouts + a User-Agent IGN tends to like better. */
    private String fetch(String url) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) CONNECT_TIMEOUT.toMillis());
        factory.setReadTimeout((int)    READ_TIMEOUT.toMillis());
        RestTemplate rt = new RestTemplate(factory);

        var headers = new HttpHeaders();
        headers.add(HttpHeaders.USER_AGENT, "NexusNexus/1.0 (+https://github.com/)");
        headers.add(HttpHeaders.ACCEPT,    "application/json,application/geo+json");

        ResponseEntity<String> resp = rt.exchange(url,
                org.springframework.http.HttpMethod.GET,
                new org.springframework.http.HttpEntity<>(headers),
                String.class);
        return resp.getBody();
    }

    /** Retry only on transient server-side errors. */
    private static boolean shouldRetry(HttpStatusCode code) {
        int v = code.value();
        return v == 408 || v == 429 || (v >= 500 && v < 600);
    }

    // ── Parsing helpers ──────────────────────────────────────────────────────

    /** Build zone list from a parsed GeoJSON {@code FeatureCollection}. */
    private List<IrisZoneSystem.IrisZone> parseFeatureCollection(JsonNode root) {
        JsonNode features = root.path("features");
        if (!features.isArray()) {
            log.warn("GeoJSON has no 'features' array — IRIS list will be empty");
            return List.of();
        }
        List<IrisZoneSystem.IrisZone> zones = new ArrayList<>();
        for (JsonNode feat : features) {
            IrisZoneSystem.IrisZone zone = parseFeature(feat);
            if (zone != null) zones.add(zone);
        }
        return zones;
    }

    private IrisZoneSystem.IrisZone parseFeature(JsonNode feat) {
        try {
            JsonNode props    = feat.path("properties");
            JsonNode geom     = feat.path("geometry");
            String   geomType = geom.path("type").asText("");

            // Accept both the official IGN capitalisation and the lower-case
            // variants found in many community-distributed IRIS files.
            String codeIris  = first(props, "CODE_IRIS", "code_iris");
            String nomIris   = firstOr(props, "Zone IRIS", "NOM_IRIS", "nom_iris");
            String typIris   = firstOr(props, "H",       "TYP_IRIS",  "typ_iris");
            String nomCom    = first(props, "NOM_COM",   "nom_com");
            String inseeComm = first(props, "INSEE_COM", "insee_com");

            if (codeIris.isBlank()) return null;  // skip degenerate features

            double[][] polygon = extractExteriorRing(geom, geomType);
            if (polygon == null || polygon.length < 3) return null;

            return new IrisZoneSystem.IrisZone(
                    codeIris, nomIris, typIris, nomCom, inseeComm, polygon);

        } catch (Exception e) {
            log.trace("Skipping malformed IRIS feature: {}", e.getMessage());
            return null;
        }
    }

    /** First non-blank value across {@code keys}, or empty string. */
    private static String first(JsonNode props, String... keys) {
        return firstOr(props, "", keys);
    }
    private static String firstOr(JsonNode props, String fallback, String... keys) {
        for (String k : keys) {
            String v = props.path(k).asText("");
            if (!v.isBlank()) return v;
        }
        return fallback;
    }

    /**
     * Extract the exterior ring (first ring of first polygon).
     * Handles both Polygon and MultiPolygon geometries.
     * Returns [lon, lat] pairs as required by the ray-casting and GeoJSON spec.
     */
    private double[][] extractExteriorRing(JsonNode geom, String geomType) {
        JsonNode coords = geom.path("coordinates");
        JsonNode ringNode;

        switch (geomType) {
            case "Polygon":
                // coordinates = [ exterior_ring, ...holes ]
                ringNode = coords.get(0);
                break;
            case "MultiPolygon":
                // coordinates = [ [ [exterior, holes], ... ], ... ]
                // Pick the first polygon's exterior ring
                ringNode = coords.get(0) != null ? coords.get(0).get(0) : null;
                break;
            default:
                return null;
        }

        if (ringNode == null || !ringNode.isArray() || ringNode.size() < 3) return null;

        // Subsample large rings — IRIS zones rarely need more than 200 vertices
        // for accurate point-in-polygon at city-traffic resolution.
        int stride = Math.max(1, ringNode.size() / 200);
        List<double[]> pts = new ArrayList<>();
        for (int i = 0; i < ringNode.size(); i += stride) {
            JsonNode pt = ringNode.get(i);
            if (pt.size() >= 2) {
                pts.add(new double[]{ pt.get(0).asDouble(), pt.get(1).asDouble() });
            }
        }
        return pts.toArray(new double[0][]);
    }
}
