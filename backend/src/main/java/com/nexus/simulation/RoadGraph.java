package com.nexus.simulation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Immutable road network graph built from OpenStreetMap data.
 *
 * Structure:
 *  - nodes:    nodeId → [lat, lon]
 *  - adj:      nodeId → list of reachable neighbor nodeIds
 *  - edges:    flat list of road edges for random vehicle placement
 *
 * All data is loaded once at startup; no synchronization required at read time.
 */
public class RoadGraph {

    private final Map<Long, double[]> nodes;       // nodeId → {lat, lon}
    private final Map<Long, List<Long>> adj;        // nodeId → neighbors
    private final List<RoadEdge> edges;             // all directed edges
    private final Bounds bounds;

    private RoadGraph(Map<Long, double[]> nodes,
                      Map<Long, List<Long>> adj,
                      List<RoadEdge> edges,
                      Bounds bounds) {
        this.nodes = nodes;
        this.adj   = adj;
        this.edges = edges;
        this.bounds = bounds;
    }

    /** Lat/lon pair for a node, or null if not found. */
    public double[] getNode(long id) {
        return nodes.get(id);
    }

    /** Neighbor node IDs reachable from this node (never null). */
    public List<Long> neighbors(long id) {
        List<Long> n = adj.get(id);
        return n != null ? n : Collections.emptyList();
    }

    /** A random road edge as [fromNodeId, toNodeId]. */
    public long[] randomEdge(java.util.concurrent.ThreadLocalRandom rng) {
        RoadEdge edge = edges.get(rng.nextInt(edges.size()));
        return new long[]{edge.from(), edge.to()};
    }

    /** A random road edge with metadata. */
    public RoadEdge randomRoadEdge(java.util.concurrent.ThreadLocalRandom rng) {
        return edges.get(rng.nextInt(edges.size()));
    }

    public int nodeCount() { return nodes.size(); }
    public int edgeCount() { return edges.size(); }
    public boolean isEmpty() { return edges.isEmpty(); }
    public Bounds bounds() { return bounds; }

    /** Unmodifiable view of every node id in the graph. */
    public Set<Long> nodeIds() { return nodes.keySet(); }

    public record Bounds(double minLat, double maxLat, double minLon, double maxLon) {
        public boolean isValid() {
            return Double.isFinite(minLat) && Double.isFinite(maxLat)
                    && Double.isFinite(minLon) && Double.isFinite(maxLon)
                    && minLat <= maxLat && minLon <= maxLon;
        }
    }

    public record RoadEdge(
            long from,
            long to,
            String highway,
            String name,
            Integer maxSpeedKmh
    ) {}

    // ─── Builder ─────────────────────────────────────────────────────────────

    public static Builder builder() { return new Builder(); }

    public static class Builder {
        private final Map<Long, double[]> nodes = new HashMap<>();
        private final Map<Long, List<Long>> adj  = new HashMap<>();
        private final List<RoadEdge> edges        = new ArrayList<>();
        private double minLat = Double.POSITIVE_INFINITY;
        private double maxLat = Double.NEGATIVE_INFINITY;
        private double minLon = Double.POSITIVE_INFINITY;
        private double maxLon = Double.NEGATIVE_INFINITY;
        private Bounds explicitBounds;

        public void addNode(long id, double lat, double lon) {
            nodes.put(id, new double[]{lat, lon});
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
        }

        /**
         * Add a directed road segment from → to.
         * Call twice (swapped) for bidirectional roads.
         */
        public void addEdge(long from, long to) {
            addEdge(from, to, null, null, null);
        }

        public void addEdge(long from, long to, String highway, String name, Integer maxSpeedKmh) {
            adj.computeIfAbsent(from, k -> new ArrayList<>()).add(to);
            edges.add(new RoadEdge(from, to, highway, name, maxSpeedKmh));
        }

        public void setBounds(Bounds bounds) {
            this.explicitBounds = bounds;
        }

        public RoadGraph build() {
            Bounds graphBounds = explicitBounds != null
                    ? explicitBounds
                    : new Bounds(minLat, maxLat, minLon, maxLon);
            if (nodes.isEmpty() || edges.isEmpty() || !graphBounds.isValid()) {
                throw new IllegalStateException("Road graph must contain nodes, edges, and valid bounds");
            }
            return new RoadGraph(
                    Collections.unmodifiableMap(nodes),
                    Collections.unmodifiableMap(adj),
                    Collections.unmodifiableList(edges),
                    graphBounds);
        }
    }
}
