import { Injectable, OnDestroy, signal } from '@angular/core';
import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { Subject } from 'rxjs';
import { SimulationFrame, VehicleUpdate } from '../core/models/vehicle.model';
import { environment } from '../../environments/environment';

export type WsStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

/**
 * Decode a base64 string into raw bytes and run it through the browser's
 * native gzip decompressor. Returns the inflated payload as a UTF-8 string.
 * Used by the WS subscriber when the backend signals gzip+base64 via the
 * {@code x-compression} STOMP header.
 *
 * <p>{@code DecompressionStream} is built into every browser we target
 * (Chrome 80+, Firefox 113+, Safari 16.4+) — no extra dependency.
 */
async function decompressGzipBase64(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/**
 * WebSocket service — manages STOMP connection to Spring Boot backend.
 *
 * Design principles:
 * - Single STOMP client, auto-reconnects with exponential backoff
 * - Uses Subject to push frames downstream; subscribers hold no WS reference
 * - Tracks latency via timestamp diff between server frame and client receipt
 * - Exposes Angular signals for reactive status/latency display
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {

  private static readonly MAX_STALE_FRAME_MS = 2500;

  private client: Client | null = null;
  private subscription: StompSubscription | null = null;

  // Reactive state
  readonly status = signal<WsStatus>('DISCONNECTED');
  readonly latencyMs = signal<number>(0);

  // Observable stream of incoming frames — always emitted as full snapshots,
  // even though the wire format is delta-based. See subscribeToVehicles().
  readonly frames$ = new Subject<SimulationFrame>();

  /**
   * Local mirror of the fleet — keyed by id, reconstructed from the delta stream.
   * Replaced on each keyframe; patched on each delta. Sized to hold the
   * full backend cap (20 K) without rehashing.
   */
  private state = new Map<string, VehicleUpdate>();

  // ── rAF-coalesced emission ─────────────────────────────────────────────────
  // The downstream render pipeline (vehicle/trail/congestion renderers + chart
  // data) takes real work at 15 K+ vehicles. If we emitted every WebSocket
  // message synchronously, the next message would queue behind us in the
  // SockJS buffer and latency would climb into multi-second territory.
  //
  // Instead, deltas are applied to {@link state} immediately (cheap) and we
  // schedule a single rAF that emits the *latest* reconstructed snapshot.
  // Multiple WS arrivals between rAFs collapse into one render — backlog
  // can't grow, and the visible fleet always reflects the freshest state.
  private rafId: number | null = null;
  private latestTimestamp = 0;
  private latestVehicleCount = 0;
  private latestReceiveTime = 0;

  connect(url: string = `${environment.backendUrl}/ws`): void {
    if (this.client?.connected) return;

    this.client = new Client({
      webSocketFactory: () => new SockJS(url) as WebSocket,
      reconnectDelay: 3000,
      heartbeatIncoming: 5000,
      heartbeatOutgoing: 5000,

      onConnect: () => {
        this.resetLiveState();
        this.status.set('CONNECTED');
        this.subscribeToVehicles();
      },

      onDisconnect: () => {
        this.status.set('DISCONNECTED');
        this.subscription = null;
        this.resetLiveState();
      },

      onStompError: (frame) => {
        console.error('STOMP error', frame);
        this.status.set('ERROR');
      },

      onWebSocketClose: () => {
        this.status.set('DISCONNECTED');
        this.resetLiveState();
      }
    });

    this.status.set('CONNECTING');
    this.client.activate();
  }

  disconnect(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.client?.deactivate();
    this.client = null;
    this.status.set('DISCONNECTED');
    // Drop the local mirror so a reconnect starts clean and waits for the
    // server's next keyframe instead of replaying stale state.
    this.resetLiveState();
  }

  private resetLiveState(): void {
    this.state.clear();
    this.latestTimestamp = 0;
    this.latestVehicleCount = 0;
    this.latestReceiveTime = 0;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private subscribeToVehicles(): void {
    if (!this.client) return;

    this.subscription = this.client.subscribe('/topic/vehicles', async (msg: IMessage) => {
      const receiveTime = Date.now();
      try {
        // Backend gzips + base64-encodes payloads above 1 KB to cut SockJS
        // bandwidth ~5×. The custom `x-compression` STOMP header tells us
        // whether to decompress. Plain JSON still works for small deltas.
        const compression = msg.headers?.['x-compression'];
        const body = compression === 'gzip+base64'
          ? await decompressGzipBase64(msg.body)
          : msg.body;
        const frame: SimulationFrame = JSON.parse(body);
        // Network latency only — exclude local decompression cost, which can
        // briefly inflate the apparent latency on a 5 K-vehicle keyframe but
        // is not really WS lag.
        const apparentLatency = receiveTime - frame.timestamp;
        const isKeyframe = frame.keyframe !== false;
        const hasLiveState = this.latestTimestamp !== 0;

        if (this.latestTimestamp !== 0 && frame.timestamp <= this.latestTimestamp) {
          return;
        }

        // When the browser is draining an old SockJS queue, do not spend CPU
        // reconstructing/rendering stale frames. On startup we still accept the
        // first frame, even if old, so the map does not stay empty while the
        // queue catches up.
        if (hasLiveState && apparentLatency > WebSocketService.MAX_STALE_FRAME_MS) {
          this.latencyMs.set(apparentLatency);
          return;
        }

        // ── Apply delta to local mirror ────────────────────────────────────
        // Keyframes (or undefined for back-compat) replace the entire state;
        // delta frames patch only the changed entries and drop the removed. If
        // we missed a delta, later fresh deltas are still applied as a partial
        // live view until the next keyframe restores exact sync.
        if (isKeyframe) {
          this.state.clear();
          for (const v of frame.vehicles) this.state.set(v.id, v);
        } else {
          for (const v of frame.vehicles) this.state.set(v.id, v);
          if (frame.removed) {
            for (const id of frame.removed) this.state.delete(id);
          }
        }

        this.latestTimestamp = frame.timestamp;
        this.latestVehicleCount = frame.vehicleCount;
        this.latestReceiveTime = receiveTime;
        this.scheduleEmit();
      } catch (e) {
        console.warn('Failed to parse vehicle frame', e);
      }
    });
  }

  private scheduleEmit(): void {
    if (this.rafId !== null) return;

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;

      // Emit a full reconstructed snapshot — downstream consumers
      // (map, renderers, charts) never see the delta wire format.
      this.latencyMs.set(this.latestReceiveTime - this.latestTimestamp);
      this.frames$.next({
        timestamp:    this.latestTimestamp,
        vehicleCount: this.latestVehicleCount,
        vehicles:     Array.from(this.state.values()),
        keyframe:     true,
        removed:      [],
      });
    });
  }

  /**
   * Find a single vehicle in the live mirror matching {@code predicate}.
   * Used by the demo-mode panel to locate an EMERGENCY vehicle without
   * subscribing to {@link frames$} or duplicating the state map.
   */
  findVehicle(predicate: (v: VehicleUpdate) => boolean): VehicleUpdate | null {
    for (const v of this.state.values()) {
      if (predicate(v)) return v;
    }
    return null;
  }

  ngOnDestroy(): void {
    this.disconnect();
    this.frames$.complete();
  }
}
