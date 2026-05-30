package com.nexus.simulation;

import lombok.extern.slf4j.Slf4j;

import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamReader;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Loads a drivable road graph from a local OSM XML file ({@code .osm} / {@code .osm.xml}).
 *
 * <p><b>Two-pass streaming parse (StAX), tuned for large extracts:</b>
 * <ol>
 *   <li><b>Pass 1 — ways:</b> stream every {@code <way>}, keep only those tagged
 *       {@code highway=<drivable>}. Each kept way's node references and metadata
 *       are retained; every referenced node id is collected into a "needed" set.</li>
 *   <li><b>Pass 2 — nodes:</b> stream every {@code <node>}, retaining the coordinates
 *       of <i>only</i> the nodes in the needed set.</li>
 * </ol>
 *
 * <p>Non-road nodes (building corners, POIs, etc. — often the large majority of an
 * OSM file) are never retained, so peak memory stays proportional to the road
 * network rather than to the whole file. Both passes stream the file with StAX,
 * so the document is never held in memory as a DOM.
 *
 * <p>Failure policy: a file with no drivable roads (or no coordinates for them)
 * throws {@link IllegalArgumentException}. The caller surfaces this as a clean
 * import error — there is no silent fallback to a fake or empty graph.
 */
@Slf4j
public class LocalFileRoadGraphProvider implements RoadGraphProvider {

    /** {@code highway=*} values treated as drivable roads. */
    private static final Set<String> ACCEPTED_HIGHWAYS = Set.of(
            "motorway", "trunk", "primary", "secondary", "tertiary",
            "residential", "service", "unclassified", "living_street", "road"
    );

    private static final int READ_BUFFER_BYTES = 1 << 20;   // 1 MB I/O buffer

    private static final XMLInputFactory XML_FACTORY = XMLInputFactory.newFactory();

    static {
        // Harden the parser: no DTD / external entities (XXE-safe, faster).
        XML_FACTORY.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        XML_FACTORY.setProperty(XMLInputFactory.SUPPORT_DTD, false);
    }

    private final Path file;

    /** No-arg form — used as a placeholder provider; {@link #load()} returns {@code null}. */
    public LocalFileRoadGraphProvider() {
        this.file = null;
    }

    /** Bind the provider to a specific OSM file for {@link #load()}. */
    public LocalFileRoadGraphProvider(Path file) {
        this.file = file;
    }

    // ─── RoadGraphProvider ─────────────────────────────────────────────────────

    @Override
    public RoadGraph load() {
        if (file == null) {
            log.warn("No local OSM file configured; road-only simulation will remain empty.");
            return null;
        }
        try {
            return load(file);
        } catch (Exception e) {
            log.warn("Failed to load local OSM file {}: {}", file, e.getMessage());
            return null;
        }
    }

    // ─── Parsing entry point ───────────────────────────────────────────────────

    /**
     * Parse {@code osmFile} into a fully built {@link RoadGraph}.
     *
     * @throws IllegalArgumentException if the file contains no usable drivable roads
     * @throws IOException              on read failure
     * @throws XMLStreamException       if the file is not valid OSM XML
     */
    public RoadGraph load(Path osmFile) throws IOException, XMLStreamException {
        // Pass 1 — collect drivable ways and the ids of every node they reference.
        List<PendingWay> ways = new ArrayList<>();
        HashSet<Long> neededNodeIds = new HashSet<>(1 << 16);
        readHighwayWays(osmFile, ways, neededNodeIds);
        if (ways.isEmpty()) {
            throw new IllegalArgumentException(
                    "OSM file contains no drivable roads (no highway=* ways).");
        }

        // Pass 2 — read coordinates for road nodes only; skip everything else.
        HashMap<Long, double[]> coords = readNeededNodes(osmFile, neededNodeIds);
        if (coords.isEmpty()) {
            throw new IllegalArgumentException(
                    "OSM file has roads but no coordinates for their nodes.");
        }

        RoadGraph graph = buildGraph(ways, coords);
        log.info("Local OSM road graph loaded from {}: {} nodes, {} edges",
                osmFile.getFileName(), graph.nodeCount(), graph.edgeCount());
        return graph;
    }

    // ─── Pass 1: drivable ways ─────────────────────────────────────────────────

    private void readHighwayWays(Path osmFile,
                                 List<PendingWay> ways,
                                 HashSet<Long> neededNodeIds) throws IOException, XMLStreamException {
        try (InputStream stream = openStream(osmFile)) {
            XMLStreamReader reader = XML_FACTORY.createXMLStreamReader(stream);
            try {
                while (reader.hasNext()) {
                    if (reader.next() != XMLStreamConstants.START_ELEMENT) continue;
                    if (!"way".equals(reader.getLocalName())) continue;

                    PendingWay way = parseWay(reader);
                    if (way != null) {
                        ways.add(way);
                        for (long ref : way.refs()) {
                            neededNodeIds.add(ref);
                        }
                    }
                }
            } finally {
                reader.close();
            }
        }
    }

    /** Parse a single {@code <way>} element; returns {@code null} if it is not a drivable road. */
    private PendingWay parseWay(XMLStreamReader reader) throws XMLStreamException {
        ArrayList<Long> refs = new ArrayList<>(16);
        String highway = null;
        String name = null;
        String oneway = null;
        Integer maxSpeedKmh = null;

        while (reader.hasNext()) {
            int event = reader.next();
            if (event == XMLStreamConstants.START_ELEMENT) {
                String localName = reader.getLocalName();
                if ("nd".equals(localName)) {
                    String ref = attr(reader, "ref");
                    if (ref != null) refs.add(Long.parseLong(ref));
                } else if ("tag".equals(localName)) {
                    String key = attr(reader, "k");
                    String value = attr(reader, "v");
                    if ("highway".equals(key)) highway = value;
                    else if ("name".equals(key)) name = value;
                    else if ("oneway".equals(key)) oneway = value;
                    else if ("maxspeed".equals(key)) maxSpeedKmh = parseMaxSpeed(value);
                }
            } else if (event == XMLStreamConstants.END_ELEMENT && "way".equals(reader.getLocalName())) {
                break;
            }
        }

        // highway may be null (railways, waterways, building outlines, etc.).
        // ACCEPTED_HIGHWAYS is a null-hostile Set.of(...) — must null-check first.
        if (highway == null || !ACCEPTED_HIGHWAYS.contains(highway) || refs.size() < 2) {
            return null;
        }

        // Store refs as a primitive long[] — compact, no per-element boxing retained.
        long[] refArray = new long[refs.size()];
        for (int i = 0; i < refArray.length; i++) {
            refArray[i] = refs.get(i);
        }
        return new PendingWay(refArray, highway, name, isOneWay(oneway), maxSpeedKmh);
    }

    // ─── Pass 2: road-node coordinates ─────────────────────────────────────────

    private HashMap<Long, double[]> readNeededNodes(Path osmFile,
                                                    HashSet<Long> neededNodeIds)
            throws IOException, XMLStreamException {
        HashMap<Long, double[]> coords = new HashMap<>(Math.max(16, neededNodeIds.size() * 4 / 3));
        try (InputStream stream = openStream(osmFile)) {
            XMLStreamReader reader = XML_FACTORY.createXMLStreamReader(stream);
            try {
                while (reader.hasNext()) {
                    if (reader.next() != XMLStreamConstants.START_ELEMENT) continue;
                    if (!"node".equals(reader.getLocalName())) continue;

                    String idRaw = attr(reader, "id");
                    if (idRaw == null) continue;
                    long id = Long.parseLong(idRaw);
                    if (!neededNodeIds.contains(id)) continue;   // non-road node — discard

                    String latRaw = attr(reader, "lat");
                    String lonRaw = attr(reader, "lon");
                    if (latRaw == null || lonRaw == null) continue;
                    coords.put(id, new double[]{
                            Double.parseDouble(latRaw),
                            Double.parseDouble(lonRaw)
                    });
                }
            } finally {
                reader.close();
            }
        }
        return coords;
    }

    // ─── Graph assembly ────────────────────────────────────────────────────────

    /**
     * Build the {@link RoadGraph} from drivable ways and road-node coordinates.
     * Bounds are derived from the road nodes actually used by an edge, so the
     * imported map camera frames exactly the drivable area.
     */
    private RoadGraph buildGraph(List<PendingWay> ways, HashMap<Long, double[]> coords) {
        RoadGraph.Builder builder = RoadGraph.builder();
        HashSet<Long> addedNodes = new HashSet<>(coords.size() * 4 / 3 + 16);

        double minLat = Double.POSITIVE_INFINITY, maxLat = Double.NEGATIVE_INFINITY;
        double minLon = Double.POSITIVE_INFINITY, maxLon = Double.NEGATIVE_INFINITY;

        for (PendingWay way : ways) {
            long[] refs = way.refs();
            for (int i = 0; i < refs.length - 1; i++) {
                long from = refs[i];
                long to = refs[i + 1];
                double[] fromCoord = coords.get(from);
                double[] toCoord = coords.get(to);
                // A ref may point outside the extract (clipped file) — skip that segment.
                if (fromCoord == null || toCoord == null) continue;

                if (addedNodes.add(from)) builder.addNode(from, fromCoord[0], fromCoord[1]);
                if (addedNodes.add(to))   builder.addNode(to,   toCoord[0],   toCoord[1]);

                builder.addEdge(from, to, way.highway(), way.name(), way.maxSpeedKmh());
                if (!way.oneWay()) {
                    builder.addEdge(to, from, way.highway(), way.name(), way.maxSpeedKmh());
                }

                minLat = Math.min(minLat, Math.min(fromCoord[0], toCoord[0]));
                maxLat = Math.max(maxLat, Math.max(fromCoord[0], toCoord[0]));
                minLon = Math.min(minLon, Math.min(fromCoord[1], toCoord[1]));
                maxLon = Math.max(maxLon, Math.max(fromCoord[1], toCoord[1]));
            }
        }

        if (addedNodes.isEmpty()) {
            throw new IllegalArgumentException(
                    "OSM road network has no usable segments (way nodes missing coordinates).");
        }
        builder.setBounds(new RoadGraph.Bounds(minLat, maxLat, minLon, maxLon));
        return builder.build();
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private static InputStream openStream(Path osmFile) throws IOException {
        return new BufferedInputStream(Files.newInputStream(osmFile), READ_BUFFER_BYTES);
    }

    private static boolean isOneWay(String value) {
        if (value == null) return false;
        String normalized = value.trim().toLowerCase();
        return "yes".equals(normalized) || "true".equals(normalized) || "1".equals(normalized);
    }

    /** Extract the leading integer of an OSM {@code maxspeed} tag (e.g. {@code "50 km/h"} → 50). */
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

    private static String attr(XMLStreamReader reader, String name) {
        return reader.getAttributeValue(null, name);
    }

    /** A drivable way retained from pass 1, awaiting node coordinates from pass 2. */
    private record PendingWay(
            long[] refs,
            String highway,
            String name,
            boolean oneWay,
            Integer maxSpeedKmh
    ) {}
}
