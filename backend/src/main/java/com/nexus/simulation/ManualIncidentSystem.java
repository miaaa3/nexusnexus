package com.nexus.simulation;

import com.nexus.model.IncidentUpdate;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * User-created incidents — the "Drop event" button on the dashboard ends up
 * here. Synthetic markers don't affect vehicle dynamics (yet); they merge into
 * {@link SimulationEngine#eventsSnapshot()} so the existing Events overlay
 * renders them without any additional plumbing.
 *
 * <p>Two concurrent stores:
 * <ul>
 *   <li>{@link #active}  — TTL-bound list of incidents still on the map.
 *       {@link CopyOnWriteArrayList} so the broadcast / REST threads can read
 *       lock-free while the rare {@code add} pays the copy cost.</li>
 *   <li>{@link #history} — fixed-size deque of the most recent N incidents,
 *       active or expired. Powers the dashboard "Recent events" panel.</li>
 * </ul>
 *
 * <p>Expired entries are swept lazily from {@link #active} on every read
 * (cheap — there are rarely more than a handful), so there's no timer thread.
 */
@Slf4j
public class ManualIncidentSystem {

    /** Maximum number of past incidents kept for the history panel. */
    private static final int HISTORY_MAX = 50;

    private final List<IncidentUpdate>  active  = new CopyOnWriteArrayList<>();
    private final Deque<IncidentUpdate> history = new ArrayDeque<>(HISTORY_MAX);

    /** Add a new incident. Caller may be any thread. */
    public void add(IncidentUpdate inc) {
        active.add(inc);
        synchronized (history) {
            history.addFirst(inc);
            while (history.size() > HISTORY_MAX) history.removeLast();
        }
        log.debug("Manual incident added: {} ({}) at {},{}",
                inc.id(), inc.type(), inc.lat(), inc.lon());
    }

    /**
     * Append currently-active (non-expired) incidents to {@code out}. Sweeps
     * expired entries from {@link #active} in the same pass so the list never
     * grows unbounded.
     */
    public void appendActive(long nowMs, List<IncidentUpdate> out) {
        if (active.isEmpty()) return;
        active.removeIf(i -> i.expiresAtMs() <= nowMs);
        out.addAll(active);
    }

    /** Snapshot of the most recent incidents, newest first. */
    public List<IncidentUpdate> snapshotHistory() {
        synchronized (history) {
            return new ArrayList<>(history);
        }
    }

    /** Drop everything — used when the road graph is replaced. */
    public void reset() {
        active.clear();
        synchronized (history) { history.clear(); }
    }

    public int activeCount()  { return active.size(); }
    public int historyCount() { synchronized (history) { return history.size(); } }
}
