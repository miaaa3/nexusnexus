package com.nexus.simulation;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TrafficModeTest {

    @Test
    void rushHourIsSlowestAndNightIsFastest() {
        assertTrue(TrafficMode.RUSH_HOUR.speedFactor() < TrafficMode.NORMAL.speedFactor());
        assertTrue(TrafficMode.NORMAL.speedFactor() < TrafficMode.NIGHT.speedFactor());
        assertEquals(1.0, TrafficMode.NORMAL.speedFactor());
    }

    @Test
    void rushHourIsTheMostErratic() {
        assertTrue(TrafficMode.RUSH_HOUR.variance() > TrafficMode.NORMAL.variance());
        assertTrue(TrafficMode.NORMAL.variance() > TrafficMode.NIGHT.variance());
    }
}
