package com.nexus.simulation;

import com.nexus.model.Vehicle;
import com.nexus.model.ZoneStatus;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.List;

/**
 * Live geofence ("zone") system.
 *
 * <p>Owns a small set of named polygons (low-emission zone, airport, port
 * delivery, school safety, etc.) and, every {@link #REFRESH_INTERVAL_MS}, counts
 * how many simulated vehicles are inside each one. The counts feed the frontend
 * Zones overlay so the labels show live "Zone Name (vehicles)" instead of mock
 * decoration.
 *
 * <p>Performance:
 * <ul>
 *   <li>Each polygon caches an axis-aligned bounding box; a vehicle outside the
 *       bbox is rejected in 4 comparisons — typical 15 K-vehicle fleet costs
 *       <em>O(zones × vehicles)</em> only when zones cover the whole map.</li>
 *   <li>Refresh is throttled: {@link #update(List, long)} is a cheap no-op
 *       between refreshes, so calling it every tick is free.</li>
 *   <li>No per-tick allocation — count buffer is reused.</li>
 *   <li>Point-in-polygon uses the standard ray-casting algorithm
 *       (O(vertices) per test). All zones have ≤ 24 vertices.</li>
 * </ul>
 *
 * <p>Thread-safety: reads ({@code snapshot}) and writes ({@code update}) must
 * be guarded by the simulation lock — same contract as {@link TrafficLightSystem}.
 */
@Slf4j
public class ZoneSystem {

    /** How often the vehicle-count is recomputed. 250 ms = 4 Hz — plenty fresh for a UI badge. */
    private static final long REFRESH_INTERVAL_MS = 250L;

    private final List<Zone> zones = new ArrayList<>();
    private long lastRefreshMs = 0L;

    public ZoneSystem() {
        // ── Mirror of the La Rochelle polygons rendered by the frontend ──
        // Defining them here makes the backend the single source of truth.
        addRect("gf-zcr",      "Low-emission Zone",        "#2ecc71",
                -1.180, 46.135, -1.090, 46.190);
        addCircle("gf-airport","La Rochelle Airport Zone", "#e74c3c",
                -1.1953, 46.1792, 0.030, 24);
        addCircle("gf-delivery","Port Delivery Zone",      "#3d9eff",
                -1.1511, 46.1583, 0.020, 20);
        addCircle("gf-school", "School Safety Zone",       "#f1c40f",
                -1.1350, 46.1650, 0.008, 16);
    }

    /**
     * Advance one tick — recomputes vehicle counts at most every
     * {@link #REFRESH_INTERVAL_MS}. Holding the simulation read or write lock
     * is sufficient because we only touch our own state.
     */
    public void update(List<Vehicle> vehicles, long nowMs) {
        if (nowMs - lastRefreshMs < REFRESH_INTERVAL_MS) return;
        lastRefreshMs = nowMs;

        for (Zone z : zones) z.count = 0;

        for (Vehicle v : vehicles) {
            double lat = v.getLatitude();
            double lon = v.getLongitude();
            for (Zone z : zones) {
                if (lon < z.minLon || lon > z.maxLon
                        || lat < z.minLat || lat > z.maxLat) continue;
                if (pointInPolygon(lon, lat, z.polygon)) z.count++;
            }
        }
    }

    /** Snapshot every zone's current state (definition + live count). */
    public List<ZoneStatus> snapshot(long nowMs) {
        List<ZoneStatus> out = new ArrayList<>(zones.size());
        for (Zone z : zones) {
            out.add(new ZoneStatus(z.id, z.name, z.color, z.polygon, z.count, nowMs));
        }
        return out;
    }

    public int size() { return zones.size(); }

    // ─── Internals ────────────────────────────────────────────────────────────

    private void addRect(String id, String name, String color,
                         double lonW, double latS, double lonE, double latN) {
        double[][] poly = {
                {lonW, latS}, {lonE, latS}, {lonE, latN}, {lonW, latN},
        };
        zones.add(new Zone(id, name, color, poly));
    }

    private void addCircle(String id, String name, String color,
                           double cLon, double cLat, double rDeg, int segments) {
        double[][] poly = new double[segments][2];
        for (int i = 0; i < segments; i++) {
            double a = (i / (double) segments) * 2.0 * Math.PI;
            poly[i][0] = cLon + rDeg * Math.cos(a);
            poly[i][1] = cLat + rDeg * Math.sin(a);
        }
        zones.add(new Zone(id, name, color, poly));
    }

    /** Standard ray-casting test — works for both convex and concave polygons. */
    private static boolean pointInPolygon(double x, double y, double[][] poly) {
        boolean inside = false;
        int n = poly.length;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            double xi = poly[i][0], yi = poly[i][1];
            double xj = poly[j][0], yj = poly[j][1];
            boolean intersect = ((yi > y) != (yj > y))
                    && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /** Mutable per-zone state. {@code count} is the only field rewritten each refresh. */
    private static final class Zone {
        final String   id;
        final String   name;
        final String   color;
        final double[][] polygon;
        final double   minLon, maxLon, minLat, maxLat;
        int            count;

        Zone(String id, String name, String color, double[][] polygon) {
            this.id      = id;
            this.name    = name;
            this.color   = color;
            this.polygon = polygon;

            double minLon = Double.POSITIVE_INFINITY, maxLon = Double.NEGATIVE_INFINITY;
            double minLat = Double.POSITIVE_INFINITY, maxLat = Double.NEGATIVE_INFINITY;
            for (double[] p : polygon) {
                if (p[0] < minLon) minLon = p[0];
                if (p[0] > maxLon) maxLon = p[0];
                if (p[1] < minLat) minLat = p[1];
                if (p[1] > maxLat) maxLat = p[1];
            }
            this.minLon = minLon;
            this.maxLon = maxLon;
            this.minLat = minLat;
            this.maxLat = maxLat;
        }
    }
}
