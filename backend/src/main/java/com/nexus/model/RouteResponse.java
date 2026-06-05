package com.nexus.model;

import java.util.List;

/**
 * Route d'un véhicule sélectionné, renvoyée par
 * {@code GET /api/simulation/vehicles/{id}/route}.
 *
 * <p>Le frontend l'utilise pour dessiner une polyline qui brille sur la carte.
 *
 * <ul>
 *   <li>{@code coords} — chaque point est {@code [lon, lat]} (ordre GeoJSON).
 *       Inclut la position courante du véhicule en tête et le reste du chemin
 *       A* restant jusqu'à la destination.</li>
 *   <li>{@code currentIndex} — index de la position du véhicule dans
 *       {@code coords}. Toujours 0 dans cette implémentation (on a coupé le
 *       passé), mais réservé pour des évolutions (afficher passé + futur).</li>
 *   <li>{@code totalSegments} — nombre de segments de route entre points
 *       (= coords.size() - 1).</li>
 * </ul>
 */
public record RouteResponse(
        String        vehicleId,
        List<double[]> coords,
        int           currentIndex,
        int           totalSegments
) {}
