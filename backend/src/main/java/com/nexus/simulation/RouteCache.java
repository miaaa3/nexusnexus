package com.nexus.simulation;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Bounded LRU cache of A* paths, keyed by {@code (fromNode, goalNode)}.
 *
 * <p>Two reasons a cached path may be stale:
 * <ul>
 *   <li><b>Age</b> — entries older than {@link #TTL_MS} are discarded. Paths
 *       eventually become irrelevant as traffic shifts.</li>
 *   <li><b>Generation mismatch</b> — every time the hot-edge set changes,
 *       {@link SimulationEngine} bumps the generation counter passed to
 *       {@link #get}. Paths computed under an older generation are skipped
 *       so a route computed during a jam doesn't get reused after it clears
 *       (or vice versa).</li>
 * </ul>
 *
 * <p>Eviction: LinkedHashMap in access-order with a hard cap of
 * {@link #MAX_ENTRIES} — the least-recently-used path is dropped on insert.
 *
 * <p>Thread-safety: all calls happen on the broadcast / tick thread under
 * the simulation lock, so no synchronisation is required.
 */
public class RouteCache {

    /** Hard cap on the number of cached paths. */
    private static final int  MAX_ENTRIES = 10_000;
    /** Maximum age before an entry is considered stale (ms). */
    private static final long TTL_MS      = 5_000L;

    private final LinkedHashMap<Long, Entry> map = new LinkedHashMap<>(
            MAX_ENTRIES + 16, 0.75f, true /* access order */) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Entry> eldest) {
            return size() > MAX_ENTRIES;
        }
    };

    private long hits   = 0;
    private long misses = 0;

    /**
     * @return cached path if present, fresh, and computed under {@code generation};
     *         null otherwise.
     */
    public List<Long> get(long start, long goal, long generation, long nowMs) {
        Entry e = map.get(key(start, goal));
        if (e == null || nowMs - e.timestamp > TTL_MS || e.generation != generation) {
            misses++;
            return null;
        }
        hits++;
        return e.path;
    }

    /** Store a non-trivial path. Paths shorter than 2 nodes are ignored. */
    public void put(long start, long goal, List<Long> path,
                    long generation, long nowMs) {
        if (path == null || path.size() < 2) return;
        map.put(key(start, goal), new Entry(path, generation, nowMs));
    }

    /** Drop every entry — used when the road graph is replaced. */
    public void clear() {
        map.clear();
        hits = 0;
        misses = 0;
    }

    public int  size()   { return map.size(); }
    public long hits()   { return hits; }
    public long misses() { return misses; }

    /** Hit rate as a percentage — only meaningful after some traffic. */
    public double hitRate() {
        long total = hits + misses;
        return total == 0 ? 0.0 : (100.0 * hits) / total;
    }

    private static long key(long start, long goal) {
        // Same combine as AStarPathfinder.packEdge — directed and well-spread.
        return start * 1_000_003L + goal;
    }

    private record Entry(List<Long> path, long generation, long timestamp) {}
}
