package com.nexus.simulation;

import com.nexus.model.IncidentUpdate;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ManualIncidentSystemTest {

    private static IncidentUpdate incident(String id, long expiresAtMs) {
        return new IncidentUpdate(id, "accident", 2, 46.1, -1.1, "test", expiresAtMs);
    }

    @Test
    void activeIncidentsAreReportedUntilTheyExpire() {
        ManualIncidentSystem s = new ManualIncidentSystem();
        s.add(incident("a", 1_000));

        List<IncidentUpdate> out = new ArrayList<>();
        s.appendActive(500, out);
        assertEquals(1, out.size());

        out.clear();
        s.appendActive(1_000, out);
        assertTrue(out.isEmpty(), "expiry is inclusive");
        assertEquals(0, s.activeCount(), "expired entries are swept");
    }

    @Test
    void historyKeepsExpiredIncidentsNewestFirst() {
        ManualIncidentSystem s = new ManualIncidentSystem();
        s.add(incident("a", 10));
        s.add(incident("b", 10));
        s.appendActive(100, new ArrayList<>());

        List<IncidentUpdate> history = s.snapshotHistory();
        assertEquals(List.of("b", "a"), history.stream().map(IncidentUpdate::id).toList());
    }

    @Test
    void historyIsCappedAtFifty() {
        ManualIncidentSystem s = new ManualIncidentSystem();
        for (int i = 0; i < 60; i++) s.add(incident("i" + i, 1_000));
        assertEquals(50, s.historyCount());
        assertEquals("i59", s.snapshotHistory().get(0).id());
    }

    @Test
    void resetClearsEverything() {
        ManualIncidentSystem s = new ManualIncidentSystem();
        s.add(incident("a", 1_000));
        s.reset();
        assertEquals(0, s.activeCount());
        assertEquals(0, s.historyCount());
    }
}
