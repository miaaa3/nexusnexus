package com.nexus.simulation;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class TrafficTimeServiceTest {

    @Test
    void startsAtSevenInTheMorningInRushHour() {
        TrafficTimeService t = new TrafficTimeService();
        assertEquals("07:00", t.getFormattedTime());
        assertEquals(TrafficMode.RUSH_HOUR, t.getMode());
    }

    @Test
    void clockRunsSixtyTimesFasterThanTheWallClockTick() {
        // 60 simulated minutes per real second: one second moves 07:00 to 08:00.
        TrafficTimeService t = new TrafficTimeService();
        t.advance(1_000);
        assertEquals("08:00", t.getFormattedTime());
        t.advance(500);
        assertEquals("08:30", t.getFormattedTime());
    }

    @Test
    void modeFollowsTheClock() {
        TrafficTimeService t = new TrafficTimeService();
        t.advance(2_000);                                   // 09:00
        assertEquals(TrafficMode.NORMAL, t.getMode());
        t.advance(8_000);                                   // 17:00
        assertEquals(TrafficMode.RUSH_HOUR, t.getMode());
        t.advance(2_000);                                   // 19:00
        assertEquals(TrafficMode.NORMAL, t.getMode());
        t.advance(5_000);                                   // 00:00
        assertEquals(TrafficMode.NIGHT, t.getMode());
    }

    @Test
    void clockWrapsAfterMidnight() {
        TrafficTimeService t = new TrafficTimeService();
        t.advance(17_000);                                  // 24:00 → 00:00
        assertEquals("00:00", t.getFormattedTime());
        assertEquals(0, t.simHour());
        assertEquals(0, t.simMinute());
    }

    @Test
    void overrideWinsOverTheClockAndCanBeCleared() {
        TrafficTimeService t = new TrafficTimeService();
        t.setOverride(TrafficMode.NIGHT);
        assertEquals(TrafficMode.NIGHT, t.getMode());
        t.setOverride(null);
        assertEquals(TrafficMode.RUSH_HOUR, t.getMode());
    }
}
