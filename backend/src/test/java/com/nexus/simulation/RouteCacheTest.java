package com.nexus.simulation;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class RouteCacheTest {

    private static final List<Long> PATH = List.of(1L, 2L, 3L);

    @Test
    void returnsStoredPathWhileFreshAndSameGeneration() {
        RouteCache cache = new RouteCache();
        cache.put(1, 3, PATH, 7, 1_000);
        assertEquals(PATH, cache.get(1, 3, 7, 2_000));
        assertEquals(1, cache.hits());
    }

    @Test
    void missOnUnknownKey() {
        RouteCache cache = new RouteCache();
        assertNull(cache.get(1, 3, 0, 0));
        assertEquals(1, cache.misses());
    }

    @Test
    void entriesExpireAfterTtl() {
        RouteCache cache = new RouteCache();
        cache.put(1, 3, PATH, 0, 0);
        assertNotNull(cache.get(1, 3, 0, 5_000));
        assertNull(cache.get(1, 3, 0, 5_001));
    }

    @Test
    void generationMismatchInvalidates() {
        RouteCache cache = new RouteCache();
        cache.put(1, 3, PATH, 1, 0);
        assertNull(cache.get(1, 3, 2, 10));
    }

    @Test
    void trivialPathsAreNotCached() {
        RouteCache cache = new RouteCache();
        cache.put(1, 1, List.of(1L), 0, 0);
        cache.put(1, 2, null, 0, 0);
        assertEquals(0, cache.size());
    }

    @Test
    void cacheIsBoundedAndEvictsLeastRecentlyUsed() {
        RouteCache cache = new RouteCache();
        for (long i = 0; i < 10_050; i++) cache.put(i, i + 1, PATH, 0, 0);
        assertEquals(10_000, cache.size());
        assertNull(cache.get(0, 1, 0, 0), "oldest entry was evicted");
        assertNotNull(cache.get(10_049, 10_050, 0, 0), "newest entry is kept");
    }

    @Test
    void hitRateAndClear() {
        RouteCache cache = new RouteCache();
        assertEquals(0.0, cache.hitRate());
        cache.put(1, 3, PATH, 0, 0);
        cache.get(1, 3, 0, 0);   // hit
        cache.get(9, 9, 0, 0);   // miss
        assertEquals(50.0, cache.hitRate(), 1e-9);
        cache.clear();
        assertEquals(0, cache.size());
        assertEquals(0, cache.hits());
        assertEquals(0, cache.misses());
    }
}
