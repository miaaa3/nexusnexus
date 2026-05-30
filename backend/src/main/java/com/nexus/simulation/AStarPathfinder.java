package com.nexus.simulation;

import java.util.*;
import java.util.concurrent.ThreadLocalRandom;

/**
 * A* shortest-path search on a {@link RoadGraph}.
 *
 * Heuristic: haversine distance to goal (admissible — never overestimates
 * because vehicles travel in straight lines between nodes at the very least).
 *
 * Performance notes:
 *  - Uses a binary-heap PriorityQueue — O((V+E) log V) worst case.
 *  - Graph is read-only → no synchronisation needed.
 *  - Path is returned as a node-ID list [source, ..., goal].
 *  - Max-nodes cap (default 4 000) keeps pathfinding O(1) in practice
 *    on city-scale graphs; if the goal is unreachable within the cap
 *    no fake direct path is returned.
 *  - Optional {@code hotEdges} set lets callers route around currently
 *    congested edges by multiplying their cost — the search still finds
 *    a path through them if no alternative exists.
 */
public final class AStarPathfinder {

    /** Safety cap: stop expanding after this many nodes to bound worst-case time. */
    private static final int MAX_NODES = 4_000;

    /** Cost multiplier applied to edges currently flagged as congested. */
    private static final double HOT_EDGE_PENALTY = 2.5;

    private static final double EARTH_R = 6371.0;   // km

    private AStarPathfinder() {}

    /** Pack a directed edge (from → to) into a single long for hot-edge lookup. */
    public static long packEdge(long from, long to) {
        // Order-preserving combine — distinguishes (a→b) from (b→a).
        return from * 1_000_003L + to;
    }

    /** Convenience overload: no congestion penalty. */
    public static List<Long> findPath(RoadGraph graph, long start, long goal) {
        return findPath(graph, start, goal, java.util.Collections.emptySet());
    }

    /**
     * Find a path from {@code start} to {@code goal} in the road graph.
     *
     * @param hotEdges optional set of {@link #packEdge}-encoded directed
     *                 edges whose cost will be multiplied by
     *                 {@link #HOT_EDGE_PENALTY}. Pass an empty set to disable.
     * @return list of node IDs [start, n1, n2, ..., goal], or [start] if no path is found.
     */
    public static List<Long> findPath(RoadGraph graph, long start, long goal,
                                       Set<Long> hotEdges) {
        if (start == goal) return List.of(start);

        double[] goalCoord = graph.getNode(goal);
        if (goalCoord == null) return List.of(start);

        // f = g + h
        Map<Long, Double> gScore = new HashMap<>();
        Map<Long, Long>   cameFrom = new HashMap<>();

        gScore.put(start, 0.0);

        // PQ ordered by fScore
        PriorityQueue<long[]> open = new PriorityQueue<>(
                Comparator.comparingDouble(a -> Double.longBitsToDouble(a[1])));
        open.offer(new long[]{start, Double.doubleToLongBits(heuristic(graph, start, goalCoord))});

        Set<Long> closed = new HashSet<>();
        int expanded = 0;

        while (!open.isEmpty() && expanded < MAX_NODES) {
            long current = open.poll()[0];
            if (closed.contains(current)) continue;
            closed.add(current);
            expanded++;

            if (current == goal) return reconstructPath(cameFrom, start, goal);

            double g = gScore.getOrDefault(current, Double.MAX_VALUE);
            for (long neighbor : graph.neighbors(current)) {
                if (closed.contains(neighbor)) continue;
                double edgeCost = edgeKm(graph, current, neighbor);
                // Congestion penalty — A* prefers detours when an alternative
                // exists, but still routes through hot edges if it must.
                if (!hotEdges.isEmpty() && hotEdges.contains(packEdge(current, neighbor))) {
                    edgeCost *= HOT_EDGE_PENALTY;
                }
                double tentativeG = g + edgeCost;
                if (tentativeG < gScore.getOrDefault(neighbor, Double.MAX_VALUE)) {
                    gScore.put(neighbor, tentativeG);
                    cameFrom.put(neighbor, current);
                    double f = tentativeG + heuristic(graph, neighbor, goalCoord);
                    open.offer(new long[]{neighbor, Double.doubleToLongBits(f)});
                }
            }
        }

        return List.of(start);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static List<Long> reconstructPath(Map<Long, Long> cameFrom, long start, long goal) {
        LinkedList<Long> path = new LinkedList<>();
        long cur = goal;
        while (cur != start) {
            path.addFirst(cur);
            Long prev = cameFrom.get(cur);
            if (prev == null) break;
            cur = prev;
        }
        path.addFirst(start);
        return Collections.unmodifiableList(path);
    }

    private static double heuristic(RoadGraph graph, long node, double[] goalCoord) {
        double[] c = graph.getNode(node);
        if (c == null) return 0;
        return haversineKm(c[0], c[1], goalCoord[0], goalCoord[1]);
    }

    private static double edgeKm(RoadGraph graph, long from, long to) {
        double[] f = graph.getNode(from);
        double[] t = graph.getNode(to);
        if (f == null || t == null) return 0.1;
        return haversineKm(f[0], f[1], t[0], t[1]);
    }

    static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat/2)*Math.sin(dLat/2)
                 + Math.cos(Math.toRadians(lat1))*Math.cos(Math.toRadians(lat2))
                   *Math.sin(dLon/2)*Math.sin(dLon/2);
        return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    /** Pick a random reachable node to use as a vehicle's next destination. */
    public static long randomNode(RoadGraph graph, ThreadLocalRandom rng) {
        // Pick a random edge's destination — biased toward connected nodes (acceptable)
        long[] edge = graph.randomEdge(rng);
        return edge[1];
    }
}
