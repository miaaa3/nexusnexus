import { Injectable, OnDestroy, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Map as MapLibreMap } from 'maplibre-gl';

import { environment } from '../../environments/environment';
import { SelectionService } from '../core/selection.service';

interface RouteResponse {
  vehicleId:     string;
  coords:        [number, number][];   // [[lon, lat], ...]
  currentIndex:  number;
  totalSegments: number;
}

/**
 * « Route highlight » — dessine sur la carte le chemin A* restant du véhicule
 * sélectionné, sous forme de polyline qui brille (halo extérieur doux + cœur
 * blanc lumineux).
 *
 * <p>Fonctionnement :
 * <ul>
 *   <li>Effect Angular qui réagit au signal {@code selection.selected} —
 *       quand un véhicule est sélectionné, on fetch sa route via REST.</li>
 *   <li>Re-fetch automatique toutes les {@link #POLL_MS} ms tant qu'un
 *       véhicule est sélectionné, parce que le véhicule avance et la route
 *       change à chaque intersection franchie.</li>
 *   <li>Désélection → on vide la source GeoJSON → la polyline disparaît.</li>
 * </ul>
 *
 * <p>Trois couches MapLibre empilées pour l'effet glow :
 * <ul>
 *   <li>{@code HALO_ID} — ligne très large, floutée, transparente</li>
 *   <li>{@code MAIN_ID} — ligne moyenne, couleur fluo</li>
 *   <li>{@code CORE_ID} — ligne fine, blanche centrale</li>
 * </ul>
 */
@Injectable({ providedIn: 'root' })
export class RouteHighlightLayerService implements OnDestroy {

  private readonly SOURCE_ID = 'nexus-route-hl';
  private readonly HALO_ID   = 'nexus-route-hl-halo';
  private readonly MAIN_ID   = 'nexus-route-hl-main';
  private readonly CORE_ID   = 'nexus-route-hl-core';

  /** Le véhicule bouge — on rafraîchit la route 2× par seconde tant que sélectionné. */
  private readonly POLL_MS = 500;

  private http = inject(HttpClient);
  private selection = inject(SelectionService);

  private map?: MapLibreMap;
  private pollTimer?: ReturnType<typeof setInterval>;
  private currentVehicleId: string | null = null;

  constructor() {
    // Réagit aux changements de sélection — Angular Signal effect.
    effect(() => {
      const sel = this.selection.selectedVehicle();
      const id = sel?.id ?? null;
      if (id === this.currentVehicleId) return;
      this.currentVehicleId = id;
      if (!id) {
        this.clearRoute();
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
      } else {
        this.fetchAndDraw(id);
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => {
          if (this.currentVehicleId) this.fetchAndDraw(this.currentVehicleId);
        }, this.POLL_MS);
      }
    });
  }

  init(map: MapLibreMap): void {
    this.map = map;

    // Source GeoJSON vide au départ.
    if (!map.getSource(this.SOURCE_ID)) {
      map.addSource(this.SOURCE_ID, {
        type: 'geojson',
        data: this.emptyFC(),
      });
    }

    // 1. Halo extérieur (large, flou, transparent)
    if (!map.getLayer(this.HALO_ID)) {
      map.addLayer({
        id:     this.HALO_ID,
        type:   'line',
        source: this.SOURCE_ID,
        paint: {
          'line-color':   'rgba(61, 158, 255, 0.55)',
          'line-width':   12,
          'line-blur':    8,
          'line-opacity': 0.65,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }

    // 2. Ligne principale (fluorescente)
    if (!map.getLayer(this.MAIN_ID)) {
      map.addLayer({
        id:     this.MAIN_ID,
        type:   'line',
        source: this.SOURCE_ID,
        paint: {
          'line-color':   '#3df0ff',           // cyan fluo
          'line-width':   5,
          'line-opacity': 0.95,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }

    // 3. Cœur blanc (donne l'effet brillant au centre)
    if (!map.getLayer(this.CORE_ID)) {
      map.addLayer({
        id:     this.CORE_ID,
        type:   'line',
        source: this.SOURCE_ID,
        paint: {
          'line-color':   '#ffffff',
          'line-width':   1.8,
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }

    // Si un véhicule était déjà sélectionné avant l'init carte, on fetch maintenant.
    if (this.currentVehicleId) this.fetchAndDraw(this.currentVehicleId);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // ── Privé ─────────────────────────────────────────────────────────────────

  private fetchAndDraw(vehicleId: string): void {
    if (!this.map) return;
    this.http.get<RouteResponse>(
      `${environment.backendUrl}/api/simulation/vehicles/${vehicleId}/route`
    ).subscribe({
      next: r => this.drawRoute(r.coords),
      error: () => this.clearRoute(),    // 404 ou véhicule sans route
    });
  }

  private drawRoute(coords: [number, number][]): void {
    if (!this.map) return;
    const src = this.map.getSource(this.SOURCE_ID) as any;
    src?.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {},
      }],
    });
  }

  private clearRoute(): void {
    if (!this.map) return;
    const src = this.map.getSource(this.SOURCE_ID) as any;
    src?.setData(this.emptyFC());
  }

  private emptyFC(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }
}
