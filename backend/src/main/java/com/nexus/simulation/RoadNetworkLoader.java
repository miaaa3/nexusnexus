package com.nexus.simulation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexus.config.SimulationConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

/**
 * Fetches the La Rochelle road network from the Overpass API and builds
 * a {@link RoadGraph} for use by the simulation engine.
 *
 * Called once at startup. If the fetch fails (network unavailable,
 * timeout), returns null and the engine stays empty until a graph is available.
 *
 * Query scope: primary + secondary + tertiary + residential streets
 * inside the configured bounding box.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class RoadNetworkLoader implements RoadGraphProvider {

    private final SimulationConfig config;
    private final ObjectMapper objectMapper = new ObjectMapper();

    private static final String OVERPASS_URL = "https://overpass-api.de/api/interpreter";
    private static final String HIGHWAY_FILTER =
            "motorway|trunk|primary|secondary|tertiary|residential|living_street";

    /**
     * Download and parse the road network.
     *
     * @return a populated {@link RoadGraph}, or {@code null} on failure.
     */
    public RoadGraph load() {
        SimulationConfig.Area area = config.getArea();

        String query = String.format(
                "[out:json][timeout:60];\n" +
                "way[\"highway\"~\"^(%s)$\"](%.5f,%.5f,%.5f,%.5f);\n" +
                "out body;\n>;\nout skel qt;",
                HIGHWAY_FILTER,
                area.getLatMin(), area.getLonMin(),
                area.getLatMax(), area.getLonMax()
        );

        log.info("Fetching La Rochelle road network from Overpass API…");
        try {
            String body = fetchOverpass(query);
            RoadGraph graph = parse(body);
            log.info("Road network loaded: {} nodes, {} edges",
                    graph.nodeCount(), graph.edgeCount());
            return graph;
        } catch (Exception e) {
            log.warn("Road network fetch failed ({}): {}. Road-only simulation will stay empty.",
                    e.getClass().getSimpleName(), e.getMessage());
            return null;
        }
    }

    // ─── HTTP ────────────────────────────────────────────────────────────────

    private String fetchOverpass(String query) throws Exception {
        String encoded = "data=" + URLEncoder.encode(query, StandardCharsets.UTF_8);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .build();

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(OVERPASS_URL))
                .timeout(Duration.ofSeconds(90))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(encoded))
                .build();

        HttpResponse<String> response =
                client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            String normalizedBody = response.body() == null
                    ? ""
                    : response.body().replaceAll("\\s+", " ");
            String preview = normalizedBody.substring(0, Math.min(240, normalizedBody.length()));
            throw new RuntimeException("HTTP " + response.statusCode() + " from Overpass: " + preview);
        }
        return response.body();
    }

    // ─── Parser ──────────────────────────────────────────────────────────────

    /**
     * Parse an Overpass JSON response into a {@link RoadGraph}.
     *
     * The Overpass response contains a flat "elements" array mixing
     * nodes (with lat/lon) and ways (with an ordered node-id list).
     * We separate them in one pass, then build the adjacency graph
     * from consecutive node pairs in each way.
     */
    private RoadGraph parse(String json) throws Exception {
        JsonNode root     = objectMapper.readTree(json);
        JsonNode elements = root.get("elements");

        // Pass 1: collect all nodes
        Map<Long, double[]> rawNodes = new HashMap<>();
        for (JsonNode el : elements) {
            if ("node".equals(el.get("type").asText())) {
                long   id  = el.get("id").asLong();
                double lat = el.get("lat").asDouble();
                double lon = el.get("lon").asDouble();
                rawNodes.put(id, new double[]{lat, lon});
            }
        }

        RoadGraph.Builder builder = RoadGraph.builder();

        // Pass 2: register only nodes referenced by ways, build edges
        for (JsonNode el : elements) {
            if (!"way".equals(el.get("type").asText())) continue;

            JsonNode nodeList = el.get("nodes");
            if (nodeList == null || nodeList.size() < 2) continue;

            // Check if way is one-way
            boolean oneway = false;
            String highway = null;
            String name = null;
            Integer maxSpeedKmh = null;
            JsonNode tags = el.get("tags");
            if (tags != null) {
                JsonNode ow = tags.get("oneway");
                oneway = ow != null && isOneWay(ow.asText());
                JsonNode highwayNode = tags.get("highway");
                JsonNode nameNode = tags.get("name");
                JsonNode maxSpeedNode = tags.get("maxspeed");
                highway = highwayNode != null ? highwayNode.asText() : null;
                name = nameNode != null ? nameNode.asText() : null;
                maxSpeedKmh = maxSpeedNode != null ? parseMaxSpeed(maxSpeedNode.asText()) : null;
            }

            for (int i = 0; i < nodeList.size(); i++) {
                long nid = nodeList.get(i).asLong();
                double[] coords = rawNodes.get(nid);
                if (coords != null) {
                    builder.addNode(nid, coords[0], coords[1]);
                }
            }

            // Add edges between consecutive nodes in the way
            for (int i = 0; i < nodeList.size() - 1; i++) {
                long from = nodeList.get(i).asLong();
                long to   = nodeList.get(i + 1).asLong();

                if (rawNodes.containsKey(from) && rawNodes.containsKey(to)) {
                    builder.addEdge(from, to, highway, name, maxSpeedKmh);
                    if (!oneway) {
                        builder.addEdge(to, from, highway, name, maxSpeedKmh); // bidirectional
                    }
                }
            }
        }

        RoadGraph graph = builder.build();
        if (graph.isEmpty()) {
            throw new RuntimeException("Parsed graph has no edges");
        }
        return graph;
    }

    private static boolean isOneWay(String value) {
        if (value == null) return false;
        String normalized = value.trim().toLowerCase();
        return "yes".equals(normalized) || "true".equals(normalized) || "1".equals(normalized);
    }

    private static Integer parseMaxSpeed(String value) {
        if (value == null) return null;
        StringBuilder digits = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isDigit(c)) digits.append(c);
            else if (!digits.isEmpty()) break;
        }
        if (digits.isEmpty()) return null;
        try {
            return Integer.parseInt(digits.toString());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }
}
