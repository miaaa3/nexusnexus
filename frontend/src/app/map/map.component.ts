import {
  Component, AfterViewInit, OnDestroy, ViewChild,
  ElementRef, inject, signal, effect, HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Map as MapLibreMap, NavigationControl, MapMouseEvent } from 'maplibre-gl';
import { Subscription } from 'rxjs';

import { WebSocketService }    from '../websocket/websocket.service';
import { SelectionService }    from '../core/selection.service';
import { ReplayService }       from '../core/replay.service';
import { HeatmapService }      from './heatmap.service';
import { AlertService }        from '../core/alert.service';
import { ChartDataService }    from '../core/chart-data.service';
import { MapStyleOption, MapStyleService } from '../core/map-style.service';
import { IncidentLayerService } from './incident-layer.service';
import { GeofenceLayerService } from './geofence-layer.service';
import { TrafficLightLayerService } from './traffic-light-layer.service';
import { IrisLayerService } from './iris-layer.service';
import { IncidentDropService } from '../core/incident-drop.service';
import { VehicleRenderer }     from '../vehicles/vehicle-renderer';
import { TrailRenderer }       from '../vehicles/trail-renderer';
import { CongestionRenderer }  from '../vehicles/congestion-renderer';
import { SpatialGrid }         from '../vehicles/spatial-grid';
import { VehicleSelector }     from '../vehicles/vehicle-selector';
import { RenderStats }         from '../core/models/render-stats.model';
import { VehicleUpdate }       from '../core/models/vehicle.model';
import { MapStateService }     from '../core/map-state.service';
import { DashboardComponent }  from '../dashboard/dashboard.component';
import { AlertsComponent }     from '../dashboard/alerts.component';
import { environment }         from '../../environments/environment';

const BUILDINGS_LAYER_ID = 'nexus-buildings-3d';
const UI_UPDATE_INTERVAL_MS = 250;

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, DashboardComponent, AlertsComponent],
  template: `
    <div #mapContainer class="map-container"></div>
    <app-dashboard></app-dashboard>
    <app-alerts></app-alerts>
  `,
  styles: [`
    :host { display: block; position: relative; width: 100%; height: 100%; }
    .map-container { position: absolute; inset: 0; cursor: crosshair; }
  `]
})
export class MapComponent implements AfterViewInit, OnDestroy {

  @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef<HTMLDivElement>;

  private ws        = inject(WebSocketService);
  private selection = inject(SelectionService);
  private replay    = inject(ReplayService);
  private heatmap   = inject(HeatmapService);
  private alerts    = inject(AlertService);
  private chartData = inject(ChartDataService);
  private mapState  = inject(MapStateService);
  private mapStyle  = inject(MapStyleService);
  private incidents     = inject(IncidentLayerService);
  private geofences     = inject(GeofenceLayerService);
  private trafficLights = inject(TrafficLightLayerService);
  private irisLayer     = inject(IrisLayerService);
  private incidentDrop  = inject(IncidentDropService);

  private map!: MapLibreMap;
  private vehicleRenderer!: VehicleRenderer;
  private trailRenderer!: TrailRenderer;
  private congestionRenderer!: CongestionRenderer;
  private grid     = new SpatialGrid(0.005);
  private selector = new VehicleSelector();

  private liveSub?: Subscription;
  private replaySub?: Subscription;
  private wsSub?: Subscription;
  private panSub?: Subscription;
  private fitBoundsSub?: Subscription;
  private clearVehiclesSub?: Subscription;
  private rafId?: number;
  private chartTimer?: ReturnType<typeof setInterval>;
  private congestionTimer?: ReturnType<typeof setInterval>;

  private lastVisibleVehicles: VehicleUpdate[] = [];
  private allFilteredVehicles: VehicleUpdate[] = [];

  // Shared via MapStateService — DashboardComponent reads these
  private readonly stats      = this.mapState.stats;
  private readonly searchPool = this.mapState.searchPool;

  private fpsFrames = 0;
  private fpsLast = performance.now();
  private framesRendered = 0;
  private lastUiUpdate = 0;

  private maxCongScore = 0;
  private avgCongScore = 0;
  private activeStyleId?: string;

  constructor() {
    // Overlay visibility reactive to filter state
    effect(() => {
      const f = this.selection.filters();
      if (!this.map?.loaded()) return;

      f.heatmapEnabled  ? this.heatmap.show()   : this.heatmap.hide();
      f.incidentsEnabled ? this.incidents.show() : this.incidents.hide();
      f.geofencesEnabled ? this.geofences.show() : this.geofences.hide();
      f.irisEnabled      ? this.irisLayer.show()  : this.irisLayer.hide();

      if (!f.trailsEnabled)     this.trailRenderer?.clearTrails();
      if (!f.congestionEnabled) this.clearCongestion();

      // 3D mode: fly to pitched view
      this.apply3dMode(f.mode3dEnabled);
    });

    // Selected vehicle highlight
    effect(() => {
      this.vehicleRenderer?.setSelectedId(this.selection.selectedVehicle()?.id ?? null);
    });

    // Map style switching
    effect(() => {
      const style = this.mapStyle.currentStyle();
      if (!this.map) return;
      if (style.id === this.activeStyleId) return;
      this.switchMapStyle(style);
    });
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key.toLowerCase()) {
      case ' ':       e.preventDefault(); this.replay.togglePlayPause(); break;
      case 'escape':
        // ESC cancels drop-incident mode first if it's active, otherwise
        // clears the selected vehicle.
        if (this.incidentDrop.active()) this.incidentDrop.cancel();
        else                            this.selection.select(null);
        break;
      case 'h':       this.selection.toggleHeatmap(); break;
      case 't':       this.selection.toggleTrails(); break;
      case 'c':       this.selection.toggleCongestion(); break;
      case 'r':       this.mapState.cycleTraffic$.next(); break;
      case 'b':       this.selection.toggle3dMode(); break;
      case 'i':       this.selection.toggleIncidents(); break;
      case 'g':       this.selection.toggleGeofences(); break;
      case 'n':       this.selection.toggleIris(); break;
      case 'p':       this.mapState.togglePause$.next(); break;
    }
  }

  ngAfterViewInit(): void {
    this.initMap();
    this.subscribePanTo();
  }

  ngOnDestroy(): void {
    this.liveSub?.unsubscribe();
    this.replaySub?.unsubscribe();
    this.wsSub?.unsubscribe();
    this.panSub?.unsubscribe();
    this.fitBoundsSub?.unsubscribe();
    this.clearVehiclesSub?.unsubscribe();
    this.ws.disconnect();
    cancelAnimationFrame(this.rafId!);
    clearInterval(this.chartTimer);
    clearInterval(this.congestionTimer);
    this.map?.remove();
  }

  /** Pan + zoom the map to a coordinate. */
  panTo(lon: number, lat: number): void {
    this.map?.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 14), duration: 600 });
  }

  /** Subscribe to MapStateService panTo$ so DashboardComponent can trigger flyTo. */
  private subscribePanTo(): void {
    this.panSub = this.mapState.panTo$.subscribe(({ lon, lat }) => this.panTo(lon, lat));
    this.fitBoundsSub = this.mapState.fitBounds$.subscribe(bounds => {
      this.map?.fitBounds(
        [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
        { padding: 60, duration: 1200 }
      );
    });
    this.clearVehiclesSub = this.mapState.clearVehicles$.subscribe(() => this.clearVehicleVisuals());
  }

  // ── Map init ────────────────────────────────────────────────────────────────

  private initMap(): void {
    const initialStyle = this.mapStyle.currentStyle();
    this.activeStyleId = initialStyle.id;

    this.map = new MapLibreMap({
      container: this.mapContainer.nativeElement,
      style: this.mapStyle.getMapLibreStyle(initialStyle),
      center: environment.MAP_CENTER,
      zoom: environment.MAP_ZOOM,
      pitch: environment.MAP_DEFAULT_PITCH,
      bearing: 0,
      antialias: true,
      maxZoom: 18,
      minZoom: 8,
    });

    this.map.addControl(new NavigationControl({ showCompass: true }), 'top-right');

    this.map.on('load', () => {
      this.initLayers();
    });

    this.map.on('click', (e: MapMouseEvent) => this.handleClick(e));
  }

  /**
   * Initialize all map layers and start data feeds.
   * Called on initial load AND after every style switch.
   */
  private initLayers(): void {
    // Re-create renderers (necessary after style switch — GL context is valid, VAOs reset)
    this.congestionRenderer = new CongestionRenderer();
    this.trailRenderer      = new TrailRenderer();
    this.vehicleRenderer    = new VehicleRenderer();

    this.map.addLayer(this.congestionRenderer as any);
    this.map.addLayer(this.trailRenderer as any);
    this.map.addLayer(this.vehicleRenderer as any);

    this.heatmap.init(this.map);
    this.incidents.init(this.map);
    this.geofences.init(this.map);
    this.trafficLights.init(this.map);
    this.irisLayer.init(this.map);

    // Re-apply current filter state (style switch resets layer visibility)
    const f = this.selection.filters();
    if (f.heatmapEnabled)   this.heatmap.show();
    if (f.incidentsEnabled) this.incidents.show();
    if (f.geofencesEnabled) this.geofences.show();
    if (f.irisEnabled)      this.irisLayer.show();
    if (f.mode3dEnabled)    this.add3dBuildingsIfSupported();

    // Start feeds only on first load (check if already subscribed)
    if (!this.liveSub) {
      this.connectWebSocket();
      this.connectReplay();
      this.startFpsLoop();
      this.startCongestionTimer();
      this.startChartTimer();
      this.watchWsStatus();
    }
  }

  // ── Map style switching ──────────────────────────────────────────────────────

  /**
   * Switch to a new style URL (or null for the built-in raster style).
   * After setStyle(), re-add all custom layers on the next 'style.load' event.
   */
  private switchMapStyle(styleOption: MapStyleOption): void {
    if (!this.map) return;
    this.activeStyleId = styleOption.id;
    const style = this.mapStyle.getMapLibreStyle(styleOption);
    this.map.setStyle(style);
    this.map.once('style.load', () => {
      this.initLayers();
    });
  }

  // ── 3D mode ─────────────────────────────────────────────────────────────────

  private apply3dMode(enabled: boolean): void {
    if (!this.map) return;
    if (enabled) {
      this.map.easeTo({ pitch: 55, bearing: -10, duration: 800 });
      this.add3dBuildingsIfSupported();
    } else {
      this.map.easeTo({ pitch: environment.MAP_DEFAULT_PITCH, bearing: 0, duration: 600 });
      this.remove3dBuildings();
    }
  }

  /**
   * Add a fill-extrusion buildings layer if the current style contains
   * a vector source with a 'building' source-layer (OpenMapTiles schema).
   * Silently no-ops if buildings are not available in the current style.
   */
  private add3dBuildingsIfSupported(): void {
    if (!this.map || this.map.getLayer(BUILDINGS_LAYER_ID)) return;

    // Try common source names used by OpenMapTiles-based styles
    const sources = ['openmaptiles', 'composite', 'maptiler_planet', 'versatiles-shortbread'];
    const availableSource = sources.find(s => this.map.getSource(s));

    if (!availableSource) {
      // Buildings not available in this style — 3D pitch is still applied
      return;
    }

    this.map.addLayer({
      id: BUILDINGS_LAYER_ID,
      type: 'fill-extrusion',
      source: availableSource,
      'source-layer': 'building',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['get', 'render_height'],
          0,   '#1a2035',
          30,  '#1e2a42',
          80,  '#22334e',
          200, '#283b5a',
        ],
        'fill-extrusion-height': [
          'coalesce', ['get', 'render_height'], ['get', 'height'], 10,
        ],
        'fill-extrusion-base': [
          'coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0,
        ],
        'fill-extrusion-opacity': 0.85,
      },
    }, this.vehicleRenderer?.id);  // insert below vehicles so vehicles render on top
  }

  private remove3dBuildings(): void {
    if (this.map?.getLayer(BUILDINGS_LAYER_ID)) {
      this.map.removeLayer(BUILDINGS_LAYER_ID);
    }
  }

  // ── Live + replay feeds ─────────────────────────────────────────────────────

  private connectWebSocket(): void {
    this.ws.connect();
    this.liveSub = this.ws.frames$.subscribe(frame => {
      if (this.replay.state() === 'playing' || this.replay.state() === 'paused') return;
      this.processFrame(frame.vehicles, frame.vehicleCount, frame.timestamp);
    });
  }

  private connectReplay(): void {
    this.replaySub = this.replay.frames$.subscribe(frame => {
      this.processFrame(frame.vehicles, frame.vehicleCount, frame.timestamp);
    });
  }

  private processFrame(vehicles: VehicleUpdate[], vehicleCount: number, timestamp: number): void {
    const t0      = performance.now();
    const filters = this.selection.filters();

    const typed = filters.types.size === 5
      ? vehicles
      : vehicles.filter(v => filters.types.has(v.type));

    this.grid.update(typed);
    const bounds  = this.mapBounds();
    const visible = bounds
      ? this.grid.query(bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon)
      : typed;

    this.lastVisibleVehicles = visible;
    this.allFilteredVehicles = typed;

    // ── Adaptive sampling ────────────────────────────────────────────────
    // At wide zooms the visible set can be 15 K+ — each vehicle is sub-pixel
    // so the user can't distinguish individuals anyway. We sub-sample 1:N
    // before the renderer pass, keeping the cost flat as the fleet grows.
    // High zoom keeps everything (small visible set).
    const zoom = this.map?.getZoom() ?? 13;
    const rendered = this.subsample(visible, zoom);

    this.vehicleRenderer.updateVehicles(rendered, timestamp);
    if (filters.trailsEnabled)  this.trailRenderer.updateVehicles(rendered);
    if (filters.heatmapEnabled) this.heatmap.update(typed);

    this.framesRendered++;
    const renderTimeMs = parseFloat((performance.now() - t0).toFixed(2));
    const now = performance.now();
    if (now - this.lastUiUpdate >= UI_UPDATE_INTERVAL_MS) {
      this.lastUiUpdate = now;
      this.searchPool.set(typed);
      this.chartData.updateVehicles(visible);
      this.stats.update(s => ({
        ...s, vehicleCount, wsLatencyMs: this.ws.latencyMs(),
        renderTimeMs, framesRendered: this.framesRendered
      }));
    }
  }

  // ── Congestion (2Hz) ────────────────────────────────────────────────────────

  private startCongestionTimer(): void {
    this.congestionTimer = setInterval(() => {
      const enabled = this.selection.filters().congestionEnabled;
      if (!enabled) return;
      if (this.allFilteredVehicles.length > 0) {
        this.congestionRenderer.updateVehicles(this.allFilteredVehicles);
      }
    }, 500);
  }

  private clearCongestion(): void {
    this.congestionRenderer?.updateVehicles([]);
    this.maxCongScore = 0;
  }

  private clearVehicleVisuals(): void {
    const now = Date.now();
    this.lastVisibleVehicles = [];
    this.allFilteredVehicles = [];
    this.grid.update([]);
    this.searchPool.set([]);
    this.selection.select(null);
    this.vehicleRenderer?.updateVehicles([], now);
    this.trailRenderer?.clearTrails();
    this.congestionRenderer?.updateVehicles([]);
    this.heatmap.update([]);
    this.chartData.updateVehicles([]);
  }

  // ── Chart data (500ms) ──────────────────────────────────────────────────────

  private startChartTimer(): void {
    this.chartTimer = setInterval(() => {
      const s = this.stats();
      this.chartData.pushFps(s.fps);
      this.chartData.pushCongestion(this.avgCongScore, this.maxCongScore);

      this.alerts.checkFps(s.fps);
      this.alerts.checkCongestion(this.maxCongScore);
    }, 500);
  }

  // ── WS status watcher ───────────────────────────────────────────────────────

  private watchWsStatus(): void {
    setInterval(() => {
      const status = this.ws.status();
      this.alerts.checkWsStatus(status);
    }, 1000);
  }

  // ── Click handling ──────────────────────────────────────────────────────────

  private handleClick(e: MapMouseEvent): void {
    // Drop-incident mode: next click is consumed as a marker drop, not a
    // vehicle selection. The service auto-clears active state on success.
    if (this.incidentDrop.active()) {
      this.incidentDrop.drop(e.lngLat.lat, e.lngLat.lng);
      return;
    }
    const hit = this.selector.findNearest(
      { x: e.point.x, y: e.point.y },
      this.lastVisibleVehicles,
      this.map
    );
    this.selection.select(hit);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private mapBounds() {
    try {
      const b = this.map.getBounds();
      return { minLat: b.getSouth(), maxLat: b.getNorth(), minLon: b.getWest(), maxLon: b.getEast() };
    } catch { return null; }
  }

  /**
   * Per-frame budget on vehicles handed to the renderer chain. Each vehicle
   * is sub-pixel at city-wide zoom, so dropping every other one is invisible
   * but halves the per-frame cost. We tighten the budget further as the
   * camera zooms out.
   */
  private static readonly RENDER_BUDGET_BY_ZOOM = [
    { maxZoom: 11,  budget: 4000 },   // continent / very wide → ≤4 K
    { maxZoom: 13,  budget: 6000 },   // city-wide              → ≤6 K
    { maxZoom: 15,  budget: 9000 },   // district               → ≤9 K
    { maxZoom: 99,  budget: Infinity } // street level           → no cap
  ];

  /**
   * Stride-sample the visible array down to the zoom-appropriate budget.
   * Cheap: the returned array shares no objects, just samples at fixed step.
   */
  private subsample(visible: VehicleUpdate[], zoom: number): VehicleUpdate[] {
    let budget = Infinity;
    for (const r of MapComponent.RENDER_BUDGET_BY_ZOOM) {
      if (zoom < r.maxZoom) { budget = r.budget; break; }
    }
    if (visible.length <= budget) return visible;
    const stride = Math.ceil(visible.length / budget);
    if (stride <= 1) return visible;
    const out = new Array<VehicleUpdate>(Math.ceil(visible.length / stride));
    for (let i = 0, j = 0; i < visible.length; i += stride, j++) out[j] = visible[i];
    return out;
  }

  private startFpsLoop(): void {
    const tick = (now: number) => {
      this.fpsFrames++;
      const elapsed = now - this.fpsLast;
      if (elapsed >= 500) {
        this.stats.update(s => ({ ...s, fps: Math.round((this.fpsFrames / elapsed) * 1000) }));
        this.fpsLast = now;
        this.fpsFrames = 0;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
}
