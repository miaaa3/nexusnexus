package com.nexus.simulation;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class RoadGraphTest {

    /** 1 --- 2 --- 3 laid out west to east along lat 46.0. */
    private static RoadGraph line() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.0, -1.0);
        b.addNode(2, 46.0, -0.9);
        b.addNode(3, 46.0, -0.8);
        b.addEdge(1, 2);
        b.addEdge(2, 3);
        return b.build();
    }

    @Test
    void buildComputesBoundsFromNodes() {
        RoadGraph.Bounds bounds = line().bounds();
        assertEquals(46.0, bounds.minLat());
        assertEquals(46.0, bounds.maxLat());
        assertEquals(-1.0, bounds.minLon());
        assertEquals(-0.8, bounds.maxLon());
        assertTrue(bounds.isValid());
    }

    @Test
    void countsAndLookups() {
        RoadGraph g = line();
        assertEquals(3, g.nodeCount());
        assertEquals(2, g.edgeCount());
        assertFalse(g.isEmpty());
        assertArrayEquals(new double[]{46.0, -0.9}, g.getNode(2));
        assertNull(g.getNode(99));
    }

    @Test
    void neighborsAreDirectedAndNeverNull() {
        RoadGraph g = line();
        assertEquals(java.util.List.of(2L), g.neighbors(1));
        assertTrue(g.neighbors(3).isEmpty(), "no outgoing edge from 3");
        assertTrue(g.neighbors(99).isEmpty(), "unknown node");
    }

    @Test
    void emptyGraphIsRejected() {
        assertThrows(IllegalStateException.class, () -> RoadGraph.builder().build());
    }

    @Test
    void graphWithoutEdgesIsRejected() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.0, -1.0);
        assertThrows(IllegalStateException.class, b::build);
    }

    @Test
    void explicitBoundsOverrideComputedOnes() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.0, -1.0);
        b.addNode(2, 46.1, -0.9);
        b.addEdge(1, 2);
        b.setBounds(new RoadGraph.Bounds(45.0, 47.0, -2.0, 0.0));
        assertEquals(45.0, b.build().bounds().minLat());
    }

    @Test
    void invalidBoundsAreRejected() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.0, -1.0);
        b.addNode(2, 46.1, -0.9);
        b.addEdge(1, 2);
        b.setBounds(new RoadGraph.Bounds(47.0, 45.0, 0.0, -2.0));
        assertThrows(IllegalStateException.class, b::build);
    }

    @Test
    void snapProjectsOntoTheClosestSegment() {
        double[] snapped = line().snapToNearestEdge(46.01, -0.95);
        assertEquals(46.0, snapped[0], 1e-9, "snapped onto the road latitude");
        assertEquals(-0.95, snapped[1], 1e-9, "projection keeps the longitude along the segment");
    }

    @Test
    void snapClampsToSegmentEndpoints() {
        double[] snapped = line().snapToNearestEdge(46.0, -1.5);
        assertEquals(-1.0, snapped[1], 1e-9, "west of the first node clamps to node 1");
    }

    @Test
    void edgeMetadataIsKept() {
        RoadGraph.Builder b = RoadGraph.builder();
        b.addNode(1, 46.0, -1.0);
        b.addNode(2, 46.0, -0.9);
        b.addEdge(1, 2, "primary", "Avenue Test", 50);
        RoadGraph.RoadEdge e = b.build().randomRoadEdge(java.util.concurrent.ThreadLocalRandom.current());
        assertEquals("primary", e.highway());
        assertEquals("Avenue Test", e.name());
        assertEquals(50, e.maxSpeedKmh());
    }
}
