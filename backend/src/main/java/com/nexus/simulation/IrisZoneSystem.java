package com.nexus.simulation;

import com.nexus.model.IrisZoneStatus;
import com.nexus.model.Vehicle;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Counts simulated vehicles inside each IRIS zone every {@link #REFRESH_MS}.
 *
 * <p>Architecture mirrors {@link ZoneSystem}:
 * <ul>
 *   <li>Each zone caches a lat/lon bounding box — most vehicles are rejected in 4 comparisons.</li>
 *   <li>For vehicles inside the bbox, a standard ray-casting test determines membership.</li>
 *   <li>Refresh is throttled to 4 Hz so calling {@code update()} every tick is essentially free.</li>
 *   <li>No per-tick allocation — the count field on each zone object is reused.</li>
 * </ul>
 *
 * <p>Thread-safety: {@code loadZones()} must be called while holding the simulation write lock;
 * {@code update()} and {@code snapshot()} must be called while holding the read or write lock.
 */
@Slf4j
public class IrisZoneSystem {

    /** Recount interval — 4 Hz is more than enough for a UI label. */
    private static final long REFRESH_MS = 250L;

    private List<IrisZone> zones = Collections.emptyList();
    private long lastRefreshMs  = 0L;

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Replace the active zone set. Called once after the graph (and therefore
     * the simulation bounds) is known. Caller must hold the write lock.
     */
    public void loadZones(List<IrisZone> newZones) {
        this.zones = List.copyOf(newZones);
        this.lastRefreshMs = 0L;
        log.info("IrisZoneSystem loaded {} IRIS zones", zones.size());
    }

    /** True once zones have been loaded. */
    public boolean isLoaded() { return !zones.isEmpty(); }

    /**
     * Advance one tick — recomputes vehicle counts, average speed, incident
     * count and congestion score at most every {@link #REFRESH_MS}. Safe to
     * call every 100 ms tick; almost always a no-op.
     *
     * <p>Cost at 15 K vehicles × ~250 IRIS zones: dominated by the bbox
     * pre-filter (4 compares per pair); only the &lt;5 % of pairs that survive
     * run the full ray-cast.
     */
    public void update(List<Vehicle> vehicles, long nowMs) {
        if (zones.isEmpty()) return;
        if (nowMs - lastRefreshMs < REFRESH_MS) return;
        lastRefreshMs = nowMs;

        for (IrisZone z : zones) {
            z.count        = 0;
            z.sumSpeedKmh  = 0.0;
            z.incidents    = 0;
        }

        for (Vehicle v : vehicles) {
            double lat = v.getLatitude();
            double lon = v.getLongitude();
            double speed = v.getSpeed();
            boolean wrecked = v.getWreckedUntilMs() > nowMs;
            for (IrisZone z : zones) {
                // Bbox pre-filter — rejects most vehicles in 4 comparisons
                if (lon < z.minLon || lon > z.maxLon
                        || lat < z.minLat || lat > z.maxLat) continue;
                if (!pointInPolygon(lon, lat, z.polygon)) continue;

                z.count++;
                z.sumSpeedKmh += speed;
                if (wrecked) z.incidents++;
            }
        }
    }

    /**
     * Free-flow target used as the denominator for the speed-deficit term of
     * the congestion score. 50 km/h is a reasonable urban free-flow speed.
     */
    private static final double FREE_FLOW_KMH = 50.0;

    /** Snapshot of all zones with current analytics (counts, speed, congestion). */
    public List<IrisZoneStatus> snapshot() {
        List<IrisZoneStatus> out = new ArrayList<>(zones.size());
        for (IrisZone z : zones) {
            double density = z.areaSqKm > 0 ? z.count / z.areaSqKm : 0.0;
            double avg     = z.count > 0   ? z.sumSpeedKmh / z.count : 0.0;

            // Congestion score combines speed deficit + incident penalty.
            // Empty zones score 0 (free, not "frozen").
            double congestion = 0.0;
            if (z.count > 0) {
                double speedDeficit = clamp01((FREE_FLOW_KMH - avg) / FREE_FLOW_KMH);
                double incPenalty   = Math.min(0.4, z.incidents * 0.15);
                congestion = clamp01(speedDeficit + incPenalty);
            }

            out.add(new IrisZoneStatus(
                    z.codeIris, z.nomIris, z.typIris,
                    z.nomCom,   z.inseeComm,
                    z.polygon,  z.count,
                    density, avg, z.incidents, congestion
            ));
        }
        return out;
    }

    private static double clamp01(double v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /** Vehicle count for a single zone by IRIS code (O(n) scan — only used for diagnostics). */
    public int countForCode(String codeIris) {
        return zones.stream()
                .filter(z -> z.codeIris.equals(codeIris))
                .mapToInt(z -> z.count)
                .findFirst().orElse(0);
    }

    public int size() { return zones.size(); }

    // ── Ray-casting ───────────────────────────────────────────────────────────

    /** Standard even-odd ray-casting — works for convex and concave polygons. */
    private static boolean pointInPolygon(double x, double y, double[][] poly) {
        boolean inside = false;
        int n = poly.length;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            double xi = poly[i][0], yi = poly[i][1];
            double xj = poly[j][0], yj = poly[j][1];
            if (((yi > y) != (yj > y))
                    && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // ── Internal zone ─────────────────────────────────────────────────────────

    /** Mutable per-zone state — only {@code count} is rewritten each refresh. */
    static final class IrisZone {
        final String   codeIris;
        final String   nomIris;
        final String   typIris;
        final String   nomCom;
        final String   inseeComm;
        final double[][] polygon;   // [[lon, lat], ...] exterior ring
        final double   minLon, maxLon, minLat, maxLat;
        final double   areaSqKm;    // rough shoelace area for density calculation
        int            count;
        double         sumSpeedKmh;  // sum of vehicle speeds inside (for avg)
        int            incidents;    // wrecked vehicles inside right now

        IrisZone(String codeIris, String nomIris, String typIris,
                 String nomCom, String inseeComm, double[][] polygon) {
            this.codeIris  = codeIris;
            this.nomIris   = nomIris;
            this.typIris   = typIris;
            this.nomCom    = nomCom;
            this.inseeComm = inseeComm;
            this.polygon   = polygon;

            double minLon = Double.POSITIVE_INFINITY, maxLon = Double.NEGATIVE_INFINITY;
            double minLat = Double.POSITIVE_INFINITY, maxLat = Double.NEGATIVE_INFINITY;
            for (double[] p : polygon) {
                if (p[0] < minLon) minLon = p[0];
                if (p[0] > maxLon) maxLon = p[0];
                if (p[1] < minLat) minLat = p[1];
                if (p[1] > maxLat) maxLat = p[1];
            }
            this.minLon = minLon; this.maxLon = maxLon;
            this.minLat = minLat; this.maxLat = maxLat;
            this.areaSqKm = shoelaceKm2(polygon);
        }

        /** Shoelace formula for approximate area in km². */
        private static double shoelaceKm2(double[][] poly) {
            // 1° lat ≈ 111 km, 1° lon ≈ 111 × cos(lat) km — use centre lat for lon scale
            if (poly.length < 3) return 0;
            double cLat = 0;
            for (double[] p : poly) cLat += p[1];
            cLat /= poly.length;
            double cosLat = Math.cos(Math.toRadians(cLat));
            double area = 0;
            int n = poly.length;
            for (int i = 0, j = n - 1; i < n; j = i++) {
                double xi = poly[i][0] * 111.0 * cosLat;
                double yi = poly[i][1] * 111.0;
                double xj = poly[j][0] * 111.0 * cosLat;
                double yj = poly[j][1] * 111.0;
                area += xj * yi - xi * yj;
            }
            return Math.abs(area) / 2.0;
        }
    }
}
