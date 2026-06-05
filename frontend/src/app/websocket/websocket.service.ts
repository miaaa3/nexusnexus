import { Injectable, OnDestroy, signal } from '@angular/core';
import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { Subject } from 'rxjs';
import { SimulationFrame, VehicleUpdate } from '../core/models/vehicle.model';
import { environment } from '../../environments/environment';

export type WsStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

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
  // data) takes tens of ms at 15 K+ vehicles. If we emitted every WebSocket
  // message synchronously, the next message would queue behind us in the
  // SockJS buffer — that's what produced the 3.4 s latency.
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
        this.status.set('CONNECTED');
        this.subscribeToVehicles();
      },

      onDisconnect: () => {
        this.status.set('DISCONNECTED');
        this.subscription = null;
      },

      onStompError: (frame) => {
        console.error('STOMP error', frame);
        this.status.set('ERROR');
      },

      onWebSocketClose: () => {
        this.status.set('DISCONNECTED');
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
    // server's next keyframe (≤ 2 s away) instead of replaying stale state.
    this.state.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private subscribeToVehicles(): void {
    if (!this.client) return;

    this.subscription = this.client.subscribe('/topic/vehicles', (msg: IMessage) => {
      const receiveTime = Date.now();
      try {
        const frame: SimulationFrame = JSON.parse(msg.body);
        // ── Apply delta to local mirror ────────────────────────────────────
        // Keyframes (or undefined for back-compat) replace the entire state;
        // delta frames patch only the changed entries and drop the removed.
        if (frame.keyframe !== false) {
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
