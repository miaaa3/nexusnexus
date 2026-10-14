import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment }         from '../../environments/environment';
import { MapStateService }     from './map-state.service';
import { SelectionService }    from './selection.service';
import { WebSocketService }    from '../websocket/websocket.service';
import { CreateIncidentRequest } from './incident-drop.service';

/** Top-congested row used by the IRIS scenario. */
interface IrisTop {
  codeIris:        string;
  nomIris:         string;
  congestionScore: number;
}

/**
 * One-click demonstration scenarios.
 *
 * <p>Each entry orchestrates the existing services / REST endpoints to set
 * the simulation up in a way that's worth showing to someone watching over
 * your shoulder. Nothing here is permanent — every action is reversible
 * through the normal controls (vehicle slider, traffic override, etc.).
 *
 * <p>The {@link busy} signal lets the UI disable buttons while a scenario
 * is in flight (most scenarios chain 2–4 REST calls).
 */
@Injectable({ providedIn: 'root' })
export class DemoModeService {

  private http      = inject(HttpClient);
  private mapState  = inject(MapStateService);
  private selection = inject(SelectionService);
  private ws        = inject(WebSocketService);

  /** True while a scenario's REST calls are in flight. */
  readonly busy = signal<boolean>(false);
  /** Short label shown next to the spinner; cleared when the scenario ends. */
  readonly status = signal<string>('');

  /**
   * 🌅 Rush hour — moderate fleet (~6 000), accelerated time (2×) so the
   * congestion patterns build up visibly within a few seconds, RUSH_HOUR
   * traffic mode. The IRIS choropleth + Events overlay are auto-enabled
   * so the resulting jams are visible.
   */
  async rushHour(): Promise<void> {
    await this.run('🌅 Rush hour', async () => {
      this.ensureLayer('iris', true);
      this.ensureLayer('incidents', true);
      await this.setVehicles(6000);
      await this.setSpeed(2.0);
      await this.setTrafficMode('RUSH_HOUR');
    });
  }

  /**
   * 💥 Accident scenario — drops three manual incidents around the current
   * map centre, switches to NORMAL mode, and pans to the centroid of the
   * drops so the user sees the queues form.
   */
  async accidentScenario(): Promise<void> {
    await this.run('💥 Accident scenario', async () => {
      this.ensureLayer('incidents', true);
      await this.setTrafficMode('NORMAL');

      const c = environment.MAP_CENTER; // [lon, lat]
      const drops: CreateIncidentRequest[] = [
        { type: 'accident',     severity: 3, lat: c[1] + 0.005, lon: c[0] - 0.007, durationMs: 90_000 },
        { type: 'closure',      severity: 3, lat: c[1] - 0.004, lon: c[0] + 0.006, durationMs: 90_000 },
        { type: 'construction', severity: 2, lat: c[1] + 0.003, lon: c[0] + 0.012, durationMs: 90_000 },
      ];
      for (const d of drops) await this.postIncident(d);
      this.mapState.panTo(c[0], c[1]);
    });
  }

  /**
   * 🚨 Emergency — find the first EMERGENCY-type vehicle in the live mirror
   * and select + pan to it. The renderer pulses selected vehicles, so it's
   * easy to follow as it weaves through traffic (and it bypasses red lights).
   */
  async emergencyFollow(): Promise<void> {
    await this.run('🚨 Emergency', async () => {
      const v = this.ws.findVehicle(x => x.type === 'EMERGENCY');
      if (!v) { this.status.set('No emergency vehicle in fleet'); return; }
      this.selection.select(v);
      this.mapState.panTo(v.lon, v.lat);
    });
  }

  /**
   * 🗺 IRIS analysis — enable the IRIS overlay and fly to the most
   * congested zone returned by /api/iris/top-congested.
   */
  async irisAnalysis(): Promise<void> {
    await this.run('🗺 IRIS analysis', async () => {
      this.ensureLayer('iris', true);
      const top = await firstValueFrom(
        this.http.get<IrisTop[]>(`${environment.backendUrl}/api/iris/top-congested?limit=1`),
      );
      if (!top?.length) { this.status.set('IRIS not loaded yet'); return; }
      // Look up the centroid via the layer service via dependency-free route:
      // POST not available — call the zone list once and pick the worst.
      const zones = await firstValueFrom(
        this.http.get<{ features: Array<{ properties: { codeIris: string };
                                          geometry: { coordinates: number[][][] } }> }>(
          `${environment.backendUrl}/api/iris/zones`),
      );
      const target = zones?.features?.find(f => f.properties.codeIris === top[0].codeIris);
      if (!target?.geometry?.coordinates?.[0]?.length) return;
      const ring = target.geometry.coordinates[0];
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const p of ring) {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
      this.mapState.panTo((minLon + maxLon) / 2, (minLat + maxLat) / 2);
    });
  }

  /**
   * ⚡ Stress test — fleet → 15 000 with the live overlays enabled so the
   * delta WebSocket + rAF coalesce path gets a real workout. Safe to leave
   * running; the vehicle slider rolls it back.
   */
  async stressTest(): Promise<void> {
    await this.run('⚡ 15 K stress test', async () => {
      this.ensureLayer('iris', true);
      this.ensureLayer('incidents', true);
      await this.setSpeed(1.0);
      await this.setVehicles(15000);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async run(label: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;       // ignore double-clicks
    this.busy.set(true);
    this.status.set(label);
    try { await fn(); }
    catch (e) {
      console.warn('[DemoMode] scenario failed', e);
      this.status.set(label + ' (error)');
    } finally {
      // Clear status after a short beat so the user sees what ran.
      setTimeout(() => this.status.set(''), 1500);
      this.busy.set(false);
    }
  }

  private ensureLayer(layer: 'iris' | 'incidents' | 'geofences', on: boolean): void {
    const f = this.selection.filters();
    const enabled =
      layer === 'iris'      ? f.irisEnabled :
      layer === 'incidents' ? f.incidentsEnabled :
                              f.geofencesEnabled;
    if (enabled === on) return;
    if (layer === 'iris')      this.selection.toggleIris();
    if (layer === 'incidents') this.selection.toggleIncidents();
    if (layer === 'geofences') this.selection.toggleGeofences();
  }

  private setVehicles(count: number): Promise<unknown> {
    return firstValueFrom(this.http.post(
      `${environment.backendUrl}/api/simulation/vehicles?count=${count}`, null,
    ));
  }

  private setSpeed(mult: number): Promise<unknown> {
    return firstValueFrom(this.http.post(
      `${environment.backendUrl}/api/simulation/speed?multiplier=${mult}`, null,
    ));
  }

  private setTrafficMode(mode: 'NORMAL' | 'RUSH_HOUR' | 'NIGHT'): Promise<unknown> {
    return firstValueFrom(this.http.post(
      `${environment.backendUrl}/api/simulation/traffic/override?mode=${mode}`, null,
    ));
  }

  private postIncident(req: CreateIncidentRequest): Promise<unknown> {
    return firstValueFrom(this.http.post(
      `${environment.backendUrl}/api/simulation/incidents`, req,
    ));
  }
}
