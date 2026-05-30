import { Component, OnInit, OnDestroy, ViewChild, inject, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

import { MapStateService }   from '../core/map-state.service';
import { WebSocketService }  from '../websocket/websocket.service';
import { SelectionService }  from '../core/selection.service';
import { ReplayService }     from '../core/replay.service';
import { MapStyleService }   from '../core/map-style.service';
import { ChartsComponent }   from './charts.component';
import { SearchComponent, PanToEvent } from './search.component';
import { MapImportComponent } from './map-import.component';
import { IrisAnalyticsComponent, IrisFlyToEvent } from './iris-analytics.component';
import { EventsPanelComponent } from './events-panel.component';
import { DemoPanelComponent }   from './demo-panel.component';
import { VehicleType, VEHICLE_COLORS } from '../core/models/vehicle.model';

interface VehicleTypeMeta { type: VehicleType; label: string; color: string; }

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, ChartsComponent, SearchComponent, MapImportComponent, IrisAnalyticsComponent, EventsPanelComponent, DemoPanelComponent],
  template: `
    <div class="dashboard">

      <!-- ── Header ─────────────────────────────────────────────────── -->
      <div class="panel panel--header">
        <div class="nexus-logo"><span class="logo-dot"></span>NEXUS</div>
        <div class="header-right">
          <div class="ws-badge" [class]="'ws-badge--' + wsStatus()">
            <span class="ws-dot"></span>{{ wsStatus() }}
          </div>
          <button class="hint-toggle" [class.hint-toggle--on]="showHints"
            (click)="showHints = !showHints" title="Keyboard shortcuts">?</button>
        </div>
      </div>

      <!-- ── Search ─────────────────────────────────────────────────── -->
      <div class="panel">
        <app-search #searchComp (panTo)="onPanTo($event)"></app-search>
      </div>

      <!-- ── Stats + Traffic ───────────────────────────────────────── -->
      <div class="panel panel--stats-traffic">
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-value" [class.stat-warn]="stats().fps < 30">{{ stats().fps }}</div>
            <div class="stat-label">FPS</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ stats().vehicleCount | number }}</div>
            <div class="stat-label">Vehicles</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" [class.stat-warn]="stats().wsLatencyMs > 200">
              {{ stats().wsLatencyMs }}ms</div>
            <div class="stat-label">Latency</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ stats().renderTimeMs }}ms</div>
            <div class="stat-label">Render</div>
          </div>
        </div>
        <div class="traffic-row">
          <div class="traffic-clock">{{ simTime }}</div>
          <button class="traffic-mode" [class]="'tm--' + trafficMode"
            (click)="cycleTrafficOverride()" title="Click to cycle traffic mode">
            <span class="tm-dot"></span>{{ trafficModeLabel }}
          </button>
        </div>
      </div>

      <!-- ── Charts ─────────────────────────────────────────────────── -->
      <div class="panel">
        <app-charts></app-charts>
      </div>

      <!-- ── Analyse territoriale (top-5 congested IRIS) ──────────────── -->
      <div class="panel">
        <app-iris-analytics (flyTo)="onIrisFlyTo($event)"></app-iris-analytics>
      </div>

      <!-- ── Selected Vehicle ───────────────────────────────────────── -->
      @if (selectedVehicle()) {
        <div class="panel panel--selection">
          <div class="sel-header">
            <span class="sel-dot" [style.background]="selectedColor()"></span>
            <span class="sel-id">{{ selectedVehicle()!.id }}</span>
            <span class="sel-type">{{ selectedVehicle()!.type }}</span>
            <button class="sel-close" (click)="sel.select(null)">✕</button>
          </div>
          <div class="sel-grid">
            <div class="sel-stat">
              <div class="sel-val">{{ selectedVehicle()!.speed | number:'1.0-1' }}<span class="sel-unit"> km/h</span></div>
              <div class="sel-label">Speed</div>
            </div>
            <div class="sel-stat">
              <div class="sel-val">{{ selectedVehicle()!.direction | number:'1.0-0' }}<span class="sel-unit">°</span></div>
              <div class="sel-label">Direction</div>
            </div>
            <div class="sel-stat">
              <div class="sel-val">{{ selectedVehicle()!.lat | number:'1.4-4' }}</div>
              <div class="sel-label">Latitude</div>
            </div>
            <div class="sel-stat">
              <div class="sel-val">{{ selectedVehicle()!.lon | number:'1.4-4' }}</div>
              <div class="sel-label">Longitude</div>
            </div>
          </div>
        </div>
      }

      <!-- ── Simulation Controls ────────────────────────────────────── -->
      <div class="panel panel--controls">
        <div class="control-row">
          <label class="control-label">Vehicles</label>
          <input type="range" min="50" max="20000" step="100"
            [(ngModel)]="vehicleCount" (change)="applyVehicleCount()" class="slider" />
          <span class="control-value">{{ vehicleCount }}</span>
        </div>
        <div class="control-row">
          <label class="control-label">Speed ×</label>
          <input type="range" min="0" max="5" step="0.5"
            [(ngModel)]="speedMultiplier" (change)="applySpeed()" class="slider" />
          <span class="control-value">{{ speedMultiplier }}</span>
        </div>
        <button class="pause-btn" [class.pause-btn--paused]="paused"
          (click)="togglePause()" title="P — Pause / Resume simulation">
          {{ paused ? '▶ Resume' : '❙❙ Pause' }}
        </button>
      </div>

      <!-- ── Map Import ────────────────────────────────────────────── -->
      <div class="panel">
        <app-map-import></app-map-import>
      </div>

      <!-- ── Overlay Toggles ────────────────────────────────────────── -->
      <div class="panel panel--toggles">
        <button class="toggle-btn" [class.toggle-btn--on]="filters().trailsEnabled"
          (click)="sel.toggleTrails()" title="T — Trails">
          <span class="ti">〜</span>Trails
        </button>
        <button class="toggle-btn" [class.toggle-btn--on]="filters().heatmapEnabled"
          (click)="sel.toggleHeatmap()" title="H — Heatmap">
          <span class="ti">◉</span>Heat
        </button>
        <button class="toggle-btn" [class.toggle-btn--on]="filters().congestionEnabled"
          (click)="sel.toggleCongestion()" title="C — Congestion grid">
          <span class="ti">▦</span>Cong.
        </button>
        <button class="toggle-btn" [class.toggle-btn--on]="filters().mode3dEnabled"
          (click)="sel.toggle3dMode()" title="B — 3D view">
          <span class="ti">⬡</span>3D
        </button>
      </div>

      <!-- ── Layers Toggles ────────────────────────────────────────── -->
      <div class="panel panel--toggles">
        <button class="toggle-btn" [class.toggle-btn--on]="filters().incidentsEnabled"
          (click)="sel.toggleIncidents()" title="I — Incidents">
          <span class="ti">⚠</span>Events
        </button>
        <button class="toggle-btn" [class.toggle-btn--on]="filters().geofencesEnabled"
          (click)="sel.toggleGeofences()" title="G — Geofences">
          <span class="ti">⬟</span>Zones
        </button>
        <button class="toggle-btn" [class.toggle-btn--on]="filters().irisEnabled"
          (click)="sel.toggleIris()" title="N — INSEE IRIS zones">
          <span class="ti">▦</span>IRIS
        </button>
        <button class="toggle-btn"
          [class.toggle-btn--on]="currentStyleId().id !== 'dark-raster'"
          (click)="cycleMapStyle()"
          [title]="'Map: ' + currentStyleName()">
          <span class="ti">🗺</span>{{ currentStyleName() }}
        </button>
      </div>

      <!-- ── Démo (one-click scenarios) ───────────────────────────────── -->
      <div class="panel">
        <app-demo-panel></app-demo-panel>
      </div>

      <!-- ── Events (drop / filter / history) ─────────────────────────── -->
      <div class="panel">
        <app-events-panel></app-events-panel>
      </div>

      <!-- ── Replay ─────────────────────────────────────────────────── -->
      <div class="panel panel--replay">
        <div class="replay-header">
          <span class="replay-title">REPLAY</span>
          <span class="replay-state" [class]="'rstate--' + replay.state()">
            {{ replay.state().toUpperCase() }}
          </span>
        </div>
        @if (replay.state() === 'idle') {
          <button class="replay-load-btn" (click)="replay.load()">⬇ Load last 60s</button>
        } @else {
          <div class="replay-controls">
            <button class="r-btn" (click)="replay.togglePlayPause()">
              {{ replay.state() === 'playing' ? '❙❙' : '▶' }}
            </button>
            <div class="r-scrubber-wrap">
              <input type="range" class="r-scrubber"
                min="0" [max]="replay.totalFrames() - 1" step="1"
                [value]="replay.currentIdx()"
                (input)="onScrub($event)" />
              <div class="r-fill" [style.width.%]="replay.progress() * 100"></div>
            </div>
            <button class="r-btn r-btn--stop" (click)="replay.stop()">■</button>
          </div>
          <div class="replay-meta">
            <span>{{ replay.currentIdx() + 1 }} / {{ replay.totalFrames() }} frames</span>
            <div class="speed-row">
              @for (s of speeds; track s) {
                <button class="speed-chip"
                  [class.speed-chip--on]="replay.speedFactor() === s"
                  (click)="replay.setSpeed(s)">{{ s }}×</button>
              }
            </div>
          </div>
        }
      </div>

      <!-- ── Type Filters ───────────────────────────────────────────── -->
      <div class="panel panel--types">
        <div class="types-label">FILTER</div>
        <div class="types-row">
          @for (v of vehicleTypes; track v.type) {
            <button class="type-chip"
              [class.type-chip--off]="!filters().types.has(v.type)"
              [style.--chip-color]="v.color"
              (click)="sel.toggleType(v.type)">
              <span class="chip-dot"></span>{{ v.label }}
            </button>
          }
        </div>
      </div>

      <!-- ── Keyboard hints (collapsible) ─────────────────────────── -->
      @if (showHints) {
        <div class="panel panel--hints">
          <div class="hint"><kbd>H</kbd>Heatmap</div>
          <div class="hint"><kbd>T</kbd>Trails</div>
          <div class="hint"><kbd>C</kbd>Congestion</div>
          <div class="hint"><kbd>B</kbd>3D view</div>
          <div class="hint"><kbd>I</kbd>Incidents</div>
          <div class="hint"><kbd>G</kbd>Geofences</div>
          <div class="hint"><kbd>R</kbd>Rush hour</div>
          <div class="hint"><kbd>P</kbd>Pause</div>
          <div class="hint"><kbd>Space</kbd>Replay</div>
          <div class="hint"><kbd>Esc</kbd>Deselect</div>
        </div>
      }

    </div>
  `,
  styles: [`
    .dashboard {
      position: absolute; top: 16px; left: 16px;
      display: flex; flex-direction: column; gap: 8px;
      z-index: 100; pointer-events: none;
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
      max-height: calc(100vh - 32px);
      overflow-y: auto; overflow-x: hidden;
    }
    .dashboard::-webkit-scrollbar { width: 0; }

    .panel {
      background: rgba(8,12,24,0.88); backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,0.07); border-radius: 10px;
      padding: 12px 14px; color: #e0e6f0; pointer-events: all;
      box-shadow: 0 4px 28px rgba(0,0,0,0.55);
    }

    /* Header */
    .panel--header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .nexus-logo { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:700; letter-spacing:3px; color:#fff; }
    .logo-dot { width:8px; height:8px; border-radius:50%; background:#3d9eff; box-shadow:0 0 8px #3d9eff; animation:pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.8)} }
    .header-right { display:flex; align-items:center; gap:8px; }
    .ws-badge { display:flex; align-items:center; gap:6px; font-size:10px; font-weight:600; letter-spacing:1px; padding:3px 8px; border-radius:20px; background:rgba(255,255,255,.05); }
    .ws-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
    .ws-badge--CONNECTED { color:#2ecc71; } .ws-badge--CONNECTING { color:#f1c40f; }
    .ws-badge--DISCONNECTED,.ws-badge--ERROR { color:#e74c3c; }
    .hint-toggle { width:22px; height:22px; border-radius:50%; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); color:rgba(255,255,255,.4); font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all .2s; }
    .hint-toggle:hover { color:#fff; border-color:rgba(255,255,255,.3); }
    .hint-toggle--on { background:rgba(61,158,255,.15); border-color:rgba(61,158,255,.45); color:#3d9eff; }

    /* Stats + Traffic combined */
    .panel--stats-traffic { display:flex; flex-direction:column; gap:8px; padding:10px 12px; }
    .stats-row { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
    .stat-card { display:flex; flex-direction:column; align-items:center; gap:2px; }
    .stat-value { font-size:20px; font-weight:700; color:#fff; font-variant-numeric:tabular-nums; transition:color .3s; }
    .stat-warn { color:#e74c3c !important; }
    .stat-label { font-size:9px; font-weight:500; color:rgba(255,255,255,.4); letter-spacing:1.2px; text-transform:uppercase; }
    .traffic-row { display:flex; align-items:center; justify-content:space-between; padding-top:4px; border-top:1px solid rgba(255,255,255,.06); }

    /* Selection */
    .panel--selection { border-color:rgba(61,158,255,.3); box-shadow:0 0 16px rgba(61,158,255,.1); }
    .sel-header { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
    .sel-dot { width:10px; height:10px; border-radius:3px; flex-shrink:0; }
    .sel-id { font-size:13px; font-weight:700; color:#fff; font-family:monospace; }
    .sel-type { font-size:9px; font-weight:600; color:rgba(255,255,255,.4); letter-spacing:1px; text-transform:uppercase; flex:1; }
    .sel-close { background:none; border:none; color:rgba(255,255,255,.3); font-size:12px; cursor:pointer; padding:2px 4px; border-radius:4px; }
    .sel-close:hover { color:#fff; }
    .sel-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .sel-stat { display:flex; flex-direction:column; gap:2px; }
    .sel-val { font-size:14px; font-weight:700; color:#3d9eff; font-variant-numeric:tabular-nums; }
    .sel-unit { font-size:10px; color:rgba(255,255,255,.4); font-weight:400; }
    .sel-label { font-size:9px; color:rgba(255,255,255,.35); text-transform:uppercase; letter-spacing:1px; }

    /* Traffic mode */
    .traffic-clock { font-size:16px; font-weight:700; color:#fff; font-variant-numeric:tabular-nums; font-family:monospace; letter-spacing:2px; }
    .traffic-mode { display:flex; align-items:center; gap:6px; font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; padding:4px 10px; border-radius:20px; cursor:pointer; transition:filter .2s; }
    .traffic-mode:hover { filter:brightness(1.25); }
    .tm-dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
    .tm--RUSH_HOUR { color:#e74c3c; background:rgba(231,76,60,.12); border:1px solid rgba(231,76,60,.3); }
    .tm--NORMAL    { color:#2ecc71; background:rgba(46,204,113,.10); border:1px solid rgba(46,204,113,.25); }
    .tm--NIGHT     { color:#7b5fff; background:rgba(123,95,255,.10); border:1px solid rgba(123,95,255,.25); }

    /* Controls */
    .panel--controls { display:flex; flex-direction:column; gap:10px; min-width:240px; }
    .control-row { display:flex; align-items:center; gap:10px; }
    .control-label { font-size:10px; font-weight:600; letter-spacing:.8px; color:rgba(255,255,255,.5); text-transform:uppercase; width:60px; flex-shrink:0; }
    .slider { flex:1; -webkit-appearance:none; height:3px; background:rgba(255,255,255,.12); border-radius:2px; outline:none; cursor:pointer; }
    .slider::-webkit-slider-thumb { -webkit-appearance:none; width:13px; height:13px; border-radius:50%; background:#3d9eff; box-shadow:0 0 6px rgba(61,158,255,.6); cursor:grab; }
    .control-value { font-size:11px; font-weight:600; color:#3d9eff; width:32px; text-align:right; font-variant-numeric:tabular-nums; }

    /* Pause button */
    .pause-btn { width:100%; padding:7px; border-radius:7px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); color:rgba(255,255,255,.55); font-size:11px; font-weight:700; letter-spacing:.8px; cursor:pointer; transition:all .2s; text-transform:uppercase; }
    .pause-btn:hover { background:rgba(255,255,255,.1); color:#fff; }
    .pause-btn--paused { background:rgba(46,204,113,.12); border-color:rgba(46,204,113,.4); color:#2ecc71; }
    .pause-btn--paused:hover { background:rgba(46,204,113,.22); }

    /* Toggles */
    .panel--toggles { display:flex; gap:6px; }
    .toggle-btn { flex:1; display:flex; align-items:center; justify-content:center; gap:5px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); border-radius:7px; padding:7px 8px; color:rgba(255,255,255,.5); font-size:10px; font-weight:600; letter-spacing:.8px; cursor:pointer; text-transform:uppercase; transition:all .2s; }
    .toggle-btn:hover { color:rgba(255,255,255,.8); border-color:rgba(255,255,255,.2); }
    .toggle-btn--on { background:rgba(61,158,255,.15); border-color:rgba(61,158,255,.5); color:#3d9eff; }
    .ti { font-size:12px; }

    /* Replay */
    .panel--replay { display:flex; flex-direction:column; gap:10px; }
    .replay-header { display:flex; align-items:center; justify-content:space-between; }
    .replay-title { font-size:10px; font-weight:700; letter-spacing:2px; color:rgba(255,255,255,.4); }
    .replay-state { font-size:9px; font-weight:700; letter-spacing:1px; padding:2px 7px; border-radius:4px; }
    .rstate--idle    { color:rgba(255,255,255,.25); background:rgba(255,255,255,.05); }
    .rstate--loading { color:#f1c40f; background:rgba(241,196,15,.1); }
    .rstate--ready   { color:#2ecc71; background:rgba(46,204,113,.1); }
    .rstate--playing { color:#e74c3c; background:rgba(231,76,60,.15); animation:rp .8s step-end infinite; }
    .rstate--paused  { color:#3d9eff; background:rgba(61,158,255,.1); }
    @keyframes rp { 50%{opacity:.4} }
    .replay-load-btn { width:100%; padding:8px; background:rgba(61,158,255,.08); border:1px dashed rgba(61,158,255,.3); border-radius:7px; color:#3d9eff; font-size:11px; font-weight:600; cursor:pointer; transition:all .2s; }
    .replay-load-btn:hover { background:rgba(61,158,255,.18); }
    .replay-controls { display:flex; align-items:center; gap:8px; }
    .r-btn { width:30px; height:30px; border-radius:50%; background:rgba(61,158,255,.12); border:1px solid rgba(61,158,255,.35); color:#3d9eff; font-size:12px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .18s; }
    .r-btn:hover { background:rgba(61,158,255,.25); }
    .r-btn--stop { background:rgba(231,76,60,.1); border-color:rgba(231,76,60,.35); color:#e74c3c; }
    .r-scrubber-wrap { flex:1; position:relative; height:20px; display:flex; align-items:center; }
    .r-scrubber { width:100%; -webkit-appearance:none; height:3px; background:rgba(255,255,255,.1); border-radius:2px; outline:none; cursor:pointer; z-index:2; position:relative; }
    .r-scrubber::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; border-radius:50%; background:#3d9eff; box-shadow:0 0 6px rgba(61,158,255,.6); }
    .r-fill { position:absolute; left:0; top:50%; transform:translateY(-50%); height:3px; background:linear-gradient(90deg,#3d9eff,#7b5fff); border-radius:2px; pointer-events:none; z-index:1; }
    .replay-meta { display:flex; align-items:center; justify-content:space-between; }
    .replay-meta span { font-size:9px; color:rgba(255,255,255,.3); font-variant-numeric:tabular-nums; }
    .speed-row { display:flex; gap:3px; }
    .speed-chip { padding:2px 6px; border-radius:4px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); color:rgba(255,255,255,.4); font-size:9px; font-weight:600; cursor:pointer; transition:all .15s; }
    .speed-chip:hover { color:rgba(255,255,255,.7); }
    .speed-chip--on { background:rgba(61,158,255,.15); border-color:rgba(61,158,255,.45); color:#3d9eff; }

    /* Type filters */
    .panel--types { display:flex; flex-direction:column; gap:8px; }
    .types-label { font-size:9px; font-weight:600; color:rgba(255,255,255,.3); letter-spacing:1.5px; }
    .types-row { display:flex; gap:5px; flex-wrap:wrap; }
    .type-chip { display:flex; align-items:center; gap:5px; background:rgba(255,255,255,.05); border:1px solid color-mix(in srgb,var(--chip-color) 35%,transparent); border-radius:20px; padding:4px 10px; color:rgba(255,255,255,.75); font-size:10px; font-weight:600; cursor:pointer; transition:all .18s; white-space:nowrap; }
    .type-chip:hover { background:color-mix(in srgb,var(--chip-color) 18%,transparent); }
    .type-chip--off { opacity:.3; filter:grayscale(1); }
    .chip-dot { width:6px; height:6px; border-radius:50%; background:var(--chip-color); box-shadow:0 0 4px var(--chip-color); }

    /* Hints */
    .panel--hints { display:flex; gap:10px; flex-wrap:wrap; padding:8px 12px; }
    .hint { display:flex; align-items:center; gap:4px; font-size:9px; color:rgba(255,255,255,.25); }
    kbd { padding:1px 5px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.15); border-radius:4px; font-size:8px; font-family:monospace; color:rgba(255,255,255,.45); }
  `]
})
export class DashboardComponent implements OnInit, OnDestroy {

  @ViewChild('searchComp') searchComp!: SearchComponent;

  private mapState     = inject(MapStateService);
  private ws           = inject(WebSocketService);
  private http         = inject(HttpClient);
  private styleService = inject(MapStyleService);
  readonly sel         = inject(SelectionService);
  readonly replay      = inject(ReplayService);

  readonly stats           = this.mapState.stats;
  readonly wsStatus        = this.ws.status;
  readonly selectedVehicle = this.sel.selectedVehicle;
  readonly filters         = this.sel.filters;

  vehicleCount    = 500;
  speedMultiplier = 1.0;
  paused          = false;
  readonly speeds = [0.25, 0.5, 1, 2, 4, 8];

  // Traffic mode display
  simTime         = '07:00';
  trafficMode     = 'NORMAL';
  showHints       = false;
  private trafficOverride: string | null = null;  // null = auto, else mode name
  get trafficModeLabel(): string {
    const suffix = this.trafficOverride ? ' ⚡' : '';
    return (this.trafficMode === 'RUSH_HOUR' ? 'Rush Hour'
          : this.trafficMode === 'NIGHT'     ? 'Night'
          : 'Normal') + suffix;
  }
  private readonly overrideCycle = [null, 'RUSH_HOUR', 'NORMAL', 'NIGHT'] as const;
  private overrideCycleIdx = 0;
  private trafficPoll?: ReturnType<typeof setInterval>;

  readonly vehicleTypes: VehicleTypeMeta[] = [
    { type: 'CAR',        label: 'Car',       color: this.tc('CAR')        },
    { type: 'BUS',        label: 'Bus',       color: this.tc('BUS')        },
    { type: 'TRUCK',      label: 'Truck',     color: this.tc('TRUCK')      },
    { type: 'MOTORCYCLE', label: 'Moto',      color: this.tc('MOTORCYCLE') },
    { type: 'EMERGENCY',  label: 'Emergency', color: this.tc('EMERGENCY')  },
  ];

  readonly selectedColor = computed(() => {
    const v = this.selectedVehicle();
    if (!v) return 'transparent';
    const [r, g, b] = VEHICLE_COLORS[v.type];
    return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
  });

  constructor() {
    // Keep search pool in sync with live vehicle data
    effect(() => {
      const pool = this.mapState.searchPool();
      this.searchComp?.setPool(pool);
    });

    // R key → cycle traffic mode
    this.mapState.cycleTraffic$.subscribe(() => this.cycleTrafficOverride());
    // P key → toggle pause
    this.mapState.togglePause$.subscribe(() => this.togglePause());
  }

  ngOnInit(): void {
    this.http.get<{ vehicleCount: number; speedMultiplier: number; paused: boolean }>(
      'http://localhost:8080/api/simulation/status'
    ).subscribe({ next: s => {
      this.vehicleCount    = s.vehicleCount;
      this.speedMultiplier = s.speedMultiplier;
      this.paused          = s.paused ?? false;
    }});

    // Poll traffic status every 2 seconds (simulated time advances 60×)
    const pollTraffic = () => {
      this.http.get<{ mode: string; simulatedTime: string }>(
        'http://localhost:8080/api/simulation/traffic'
      ).subscribe({ next: t => {
        this.trafficMode = t.mode;
        this.simTime     = t.simulatedTime;
      }});
    };
    pollTraffic();
    this.trafficPoll = setInterval(pollTraffic, 2000);
  }

  ngOnDestroy(): void {
    if (this.trafficPoll) clearInterval(this.trafficPoll);
  }

  onPanTo(e: PanToEvent): void {
    this.mapState.panTo(e.lon, e.lat);
  }

  onIrisFlyTo(e: IrisFlyToEvent): void {
    // Make sure the IRIS layer is visible before flying — otherwise the user
    // lands on the zone but the choropleth is hidden.
    if (!this.sel.filters().irisEnabled) this.sel.toggleIris();
    this.mapState.panTo(e.lon, e.lat);
  }

  onScrub(ev: Event): void {
    this.replay.seekTo(parseInt((ev.target as HTMLInputElement).value, 10));
  }

  readonly currentStyleId   = this.styleService.currentStyle;
  currentStyleName(): string { return this.styleService.currentStyle().name; }

  cycleMapStyle(): void {
    const styles = this.styleService.availableStyles;
    const idx    = styles.findIndex(s => s.id === this.styleService.currentStyle().id);
    const next   = styles[(idx + 1) % styles.length];
    this.styleService.setStyle(next.id);
  }

  cycleTrafficOverride(): void {
    this.overrideCycleIdx = (this.overrideCycleIdx + 1) % this.overrideCycle.length;
    const mode = this.overrideCycle[this.overrideCycleIdx];
    this.trafficOverride = mode;
    const param = mode ? `?mode=${mode}` : '';
    this.http.post(`http://localhost:8080/api/simulation/traffic/override${param}`, null)
      .subscribe();
  }

  togglePause(): void {
    const endpoint = this.paused ? 'resume' : 'pause';
    this.http.post(`http://localhost:8080/api/simulation/${endpoint}`, null)
      .subscribe({ next: () => { this.paused = !this.paused; } });
  }

  applyVehicleCount(): void {
    this.http.post(`http://localhost:8080/api/simulation/vehicles`, null,
      { params: { count: this.vehicleCount } }).subscribe();
  }

  applySpeed(): void {
    this.http.post(`http://localhost:8080/api/simulation/speed`, null,
      { params: { multiplier: this.speedMultiplier } }).subscribe();
  }

  private tc(type: VehicleType): string {
    const [r, g, b] = VEHICLE_COLORS[type];
    return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
  }
}
