package com.nexus.simulation;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class AStarPathfinderTest {

    /**
     * Two routes from 1 to 4:
     * <pre>
     *   1 -- 2 -- 4        (short, along lat 46.000)
     *    \_ 3 __/          (detour through lat 46.005)
     * </pre>
     */
    private static RoadGraph diamond() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.000, -1.00);
        b.addNode(2, 46.000, -0.99);
        b.addNode(3, 46.005, -0.990);
        b.addNode(4, 46.000, -0.98);
        b.addEdge(1, 2);
        b.addEdge(2, 4);
        b.addEdge(1, 3);
        b.addEdge(3, 4);
        return b.build();
    }

    @Test
    void sameStartAndGoalReturnsSingleNode() {
        assertEquals(List.of(1L), AStarPathfinder.findPath(diamond(), 1, 1));
    }

    @Test
    void findsTheShortestRoute() {
        assertEquals(List.of(1L, 2L, 4L), AStarPathfinder.findPath(diamond(), 1, 4));
    }

    @Test
    void unknownGoalReturnsStartOnly() {
        assertEquals(List.of(1L), AStarPathfinder.findPath(diamond(), 1, 99));
    }

    @Test
    void unreachableGoalReturnsStartOnly() {
        // Edges are directed: nothing leads back to node 1.
        assertEquals(List.of(4L), AStarPathfinder.findPath(diamond(), 4, 1));
    }

    @Test
    void hotEdgesPushRouteToTheDetour() {
        Set<Long> hot = Set.of(AStarPathfinder.packEdge(2, 4));
        assertEquals(List.of(1L, 3L, 4L), AStarPathfinder.findPath(diamond(), 1, 4, hot));
    }

    @Test
    void hotEdgesAreStillUsedWhenThereIsNoAlternative() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.0, -1.0);
        b.addNode(2, 46.0, -0.9);
        b.addEdge(1, 2);
        Set<Long> hot = Set.of(AStarPathfinder.packEdge(1, 2));
        assertEquals(List.of(1L, 2L), AStarPathfinder.findPath(b.build(), 1, 2, hot));
    }

    @Test
    void packEdgeDistinguishesDirection() {
        assertNotEquals(AStarPathfinder.packEdge(1, 2), AStarPathfinder.packEdge(2, 1));
    }

    @Test
    void haversineMatchesKnownDistance() {
        // One degree of latitude is about 111.2 km.
        assertEquals(111.19, AStarPathfinder.haversineKm(46.0, -1.0, 47.0, -1.0), 0.1);
        assertEquals(0.0, AStarPathfinder.haversineKm(46.0, -1.0, 46.0, -1.0), 1e-9);
    }
}
