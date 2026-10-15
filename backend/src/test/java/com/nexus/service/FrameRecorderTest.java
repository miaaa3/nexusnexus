package com.nexus.service;

import com.nexus.model.SimulationFrame;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class FrameRecorderTest {

    private static SimulationFrame frame(long ts) {
        return new SimulationFrame(ts, 0, List.of());
    }

    @Test
    void emptyRecorderReportsNoTimestamps() {
        FrameRecorder r = new FrameRecorder();
        assertEquals(0, r.getSize());
        assertEquals(-1, r.oldestTimestamp());
        assertEquals(-1, r.newestTimestamp());
        assertTrue(r.queryAll().isEmpty());
    }

    @Test
    void framesComeBackInInsertionOrder() {
        FrameRecorder r = new FrameRecorder();
        for (long t = 1; t <= 3; t++) r.record(frame(t));
        assertEquals(List.of(1L, 2L, 3L), r.queryAll().stream().map(SimulationFrame::timestamp).toList());
        assertEquals(1, r.oldestTimestamp());
        assertEquals(3, r.newestTimestamp());
    }

    @Test
    void ringKeepsOnlyTheLastTwoHundredFrames() {
        FrameRecorder r = new FrameRecorder();
        for (long t = 1; t <= 250; t++) r.record(frame(t));
        assertEquals(200, r.getSize());
        assertEquals(51, r.oldestTimestamp());
        assertEquals(250, r.newestTimestamp());
        assertEquals(51, r.queryAll().get(0).timestamp());
    }

    @Test
    void queryFiltersByInclusiveTimeRange() {
        FrameRecorder r = new FrameRecorder();
        for (long t = 1; t <= 10; t++) r.record(frame(t));
        List<Long> ts = r.query(3, 5).stream().map(SimulationFrame::timestamp).toList();
        assertEquals(List.of(3L, 4L, 5L), ts);
        assertTrue(r.query(100, 200).isEmpty());
    }

    @Test
    void clearEmptiesTheBuffer() {
        FrameRecorder r = new FrameRecorder();
        r.record(frame(1));
        r.clear();
        assertEquals(0, r.getSize());
        assertEquals(-1, r.newestTimestamp());
    }
}
