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
    // FR : on met à jour les statistiques IRIS toutes les 250 ms = 4 fois par seconde.
    //      Le tick simulation tourne à 10 Hz mais l'analyse territoriale n'a pas besoin
    //      d'être aussi rapide — l'œil ne voit pas la différence.
    private static final long REFRESH_MS = 250L;

    private List<IrisZone> zones = Collections.emptyList();   // liste des quartiers IRIS
    private long lastRefreshMs  = 0L;                          // timestamp du dernier recount

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
        if (zones.isEmpty()) return;                              // pas de zones chargées → on sort
        if (nowMs - lastRefreshMs < REFRESH_MS) return;           // pas le moment de recalculer → on sort
        lastRefreshMs = nowMs;                                    // on note l'heure du recalcul

        // ÉTAPE 1 : on remet tous les compteurs à zéro
        for (IrisZone z : zones) {
            z.count        = 0;     // nombre de voitures dans le quartier
            z.sumSpeedKmh  = 0.0;   // somme des vitesses (pour calculer la moyenne après)
            z.incidents    = 0;     // nombre d'accidents dans le quartier
        }

        // ÉTAPE 2 : pour chaque voiture, on cherche dans quel quartier elle est
        for (Vehicle v : vehicles) {
            double lat = v.getLatitude();                          // position de la voiture
            double lon = v.getLongitude();
            double speed = v.getSpeed();                           // vitesse actuelle
            boolean wrecked = v.getWreckedUntilMs() > nowMs;       // accidentée ? (true/false)
            for (IrisZone z : zones) {
                // FILTRE RAPIDE (bbox) : on regarde d'abord le rectangle qui entoure le quartier
                // → 4 comparaisons super rapides, rejette 95% des cas
                if (lon < z.minLon || lon > z.maxLon
                        || lat < z.minLat || lat > z.maxLat) continue;
                // FILTRE PRÉCIS : test point-in-polygon (lancer de rayon pair/impair)
                // → précis mais plus coûteux, fait seulement pour les 5% restants
                if (!pointInPolygon(lon, lat, z.polygon)) continue;

                // La voiture est dans ce quartier → on met à jour les compteurs
                z.count++;                       // une voiture de plus
                z.sumSpeedKmh += speed;          // on ajoute sa vitesse à la somme
                if (wrecked) z.incidents++;      // si elle est accidentée, on compte un incident
            }
        }
    }

    /**
     * Free-flow target used as the denominator for the speed-deficit term of
     * the congestion score. 50 km/h is a reasonable urban free-flow speed.
     */
    // FR : vitesse de référence en ville = 50 km/h (Code de la route en agglomération).
    //      Sert de "100% fluide" — si les voitures roulent à 50, le score est à 0.
    private static final double FREE_FLOW_KMH = 50.0;

    /** Snapshot of all zones with current analytics (counts, speed, congestion). */
    // FR : photo instantanée de tous les quartiers à un instant T.
    //      Renvoyée à chaque appel REST /api/iris/zones pour le frontend.
    public List<IrisZoneStatus> snapshot() {
        List<IrisZoneStatus> out = new ArrayList<>(zones.size());
        for (IrisZone z : zones) {
            // densité = nombre de voitures / surface (en voitures par km²)
            double density = z.areaSqKm > 0 ? z.count / z.areaSqKm : 0.0;
            // vitesse moyenne = somme des vitesses / nombre de voitures
            double avg     = z.count > 0   ? z.sumSpeedKmh / z.count : 0.0;

            // ── CALCUL DU SCORE DE CONGESTION (0 = fluide, 1 = bloqué) ─────
            // Formule : clamp01( (50 − vitesseMoyenne)/50 + min(0.4, 0.15 × accidents) )
            // Quartier vide → score 0 (libre, pas "gelé")
            double congestion = 0.0;
            if (z.count > 0) {
                // INGRÉDIENT 1 : déficit de vitesse
                //   à 50 km/h  → 0   (rien à signaler)
                //   à 25 km/h  → 0.5 (chargé)
                //   à 0 km/h   → 1.0 (bloqué)
                double speedDeficit = clamp01((FREE_FLOW_KMH - avg) / FREE_FLOW_KMH);

                // INGRÉDIENT 2 : pénalité accidents
                //   0 accident  → 0
                //   1 accident  → 0.15
                //   2 accidents → 0.30
                //   3+          → 0.40 (plafonné, pour pas exploser le score)
                double incPenalty   = Math.min(0.4, z.incidents * 0.15);

                // On additionne les deux ingrédients et on plafonne entre 0 et 1
                congestion = clamp01(speedDeficit + incPenalty);
            }

            // On range tout ça dans un objet "status" qu'on enverra au frontend
            out.add(new IrisZoneStatus(
                    z.codeIris, z.nomIris, z.typIris,
                    z.nomCom,   z.inseeComm,
                    z.polygon,  z.count,
                    density, avg, z.incidents, congestion
            ));
        }
        return out;
    }

    // FR : "clamp" = forcer une valeur à rester entre 0 et 1.
    //      Si v < 0  → renvoie 0
    //      Si v > 1  → renvoie 1
    //      Sinon     → renvoie v tel quel
    //      Comme une note à l'école : pas plus que 20/20, pas moins que 0/20.
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

    // ── Historique de congestion sur 1 h ─────────────────────────────────────

    /** Nombre d'échantillons gardés par zone — 60 minutes × 1 par minute. */
    private static final int HISTORY_LEN = 60;

    /**
     * Échantillonne le score de congestion COURANT pour chaque zone et l'ajoute
     * au ring buffer. À appeler 1× par minute via @Scheduled depuis
     * SimulationEngine. Coût : O(zones) — quelques dizaines de microsecondes.
     */
    public void recordHistorySample() {
        for (IrisZone z : zones) {
            // Même formule que snapshot() — zone vide → score 0.
            double congestion = 0.0;
            if (z.count > 0) {
                double avg = z.sumSpeedKmh / z.count;
                double speedDeficit = clamp01((FREE_FLOW_KMH - avg) / FREE_FLOW_KMH);
                double incPenalty   = Math.min(0.4, z.incidents * 0.15);
                congestion = clamp01(speedDeficit + incPenalty);
            }
            if (z.history == null) z.history = new double[HISTORY_LEN];
            z.history[z.historyHead] = congestion;
            z.historyHead = (z.historyHead + 1) % HISTORY_LEN;
            if (z.historyFill < HISTORY_LEN) z.historyFill++;
        }
    }

    /**
     * Renvoie l'historique des scores de congestion d'une zone, dans l'ordre
     * chronologique (du plus ancien au plus récent). Renvoie une liste vide
     * si la zone n'existe pas ou n'a aucun échantillon.
     */
    public List<Double> historyForCode(String codeIris) {
        for (IrisZone z : zones) {
            if (!z.codeIris.equals(codeIris)) continue;
            if (z.history == null || z.historyFill == 0) return List.of();
            List<Double> out = new ArrayList<>(z.historyFill);
            int start = (z.historyHead - z.historyFill + HISTORY_LEN) % HISTORY_LEN;
            for (int i = 0; i < z.historyFill; i++) {
                out.add(z.history[(start + i) % HISTORY_LEN]);
            }
            return out;
        }
        return List.of();
    }

    // ── Ray-casting ───────────────────────────────────────────────────────────

    /** Standard even-odd ray-casting — works for convex and concave polygons. */
    // FR : algorithme du LANCER DE RAYON (règle pair/impair).
    //      On envoie un rayon imaginaire depuis la voiture vers la droite,
    //      et on compte combien de fois il traverse les côtés du polygone.
    //      Nombre IMPAIR de croisements → la voiture est DEDANS  ✅
    //      Nombre PAIR  de croisements → la voiture est DEHORS   ❌
    //      Marche pour TOUTES les formes (convexes ou concaves bizarres).
    private static boolean pointInPolygon(double x, double y, double[][] poly) {
        boolean inside = false;          // au début, on est dehors
        int n = poly.length;             // nombre de sommets du polygone
        // On parcourt chaque côté du polygone : segment [poly[j] → poly[i]]
        for (int i = 0, j = n - 1; i < n; j = i++) {
            double xi = poly[i][0], yi = poly[i][1];   // 1er sommet du côté
            double xj = poly[j][0], yj = poly[j][1];   // 2e  sommet du côté
            // Le rayon horizontal passant par y traverse-t-il ce côté ?
            // 1) le côté doit être à cheval sur la ligne horizontale y
            // 2) le croisement doit être à droite du point (x, y)
            if (((yi > y) != (yj > y))
                    && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi)) {
                inside = !inside;        // un croisement de plus → on bascule dedans/dehors
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

        // Ring buffer des scores de congestion — 60 valeurs (1 par minute, 1 h max).
        // Lazily allouée à la première écriture pour éviter le gaspillage si
        // l'historique n'est jamais demandé.
        double[]       history;
        int            historyHead = 0;   // prochaine position d'écriture
        int            historyFill = 0;   // nombre de samples valides ≤ HISTORY_LEN

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
