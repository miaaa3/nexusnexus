import { Injectable, signal } from '@angular/core';

export type AlertLevel = 'info' | 'warn' | 'error';

export interface Alert {
  id: number;
  level: AlertLevel;
  title: string;
  message: string;
  timestamp: number;
}

/**
 * Toast alert service.
 *
 * Triggers:
 *  - FPS < 20 for 3 consecutive readings → 'error'
 *  - congestion peak > 0.85 → 'warn' (rate-limited to once per 10s)
 *  - WS status changes → 'error' / 'info'
 *
 * Max 4 toasts visible; oldest auto-removed on overflow.
 * Each toast auto-dismisses after 4 seconds.
 */
@Injectable({ providedIn: 'root' })
export class AlertService {

  private counter = 0;
  private lowFpsStreak = 0;
  private lastCongestionAlert = 0;
  private lastWsStatus = '';

  readonly alerts = signal<Alert[]>([]);

  push(level: AlertLevel, title: string, message: string): void {
    const alert: Alert = {
      id: ++this.counter, level, title, message, timestamp: Date.now()
    };

    this.alerts.update(list => {
      const next = [...list, alert].slice(-4);   // keep max 4
      return next;
    });

    setTimeout(() => this.dismiss(alert.id), 4000);
  }

  dismiss(id: number): void {
    this.alerts.update(list => list.filter(a => a.id !== id));
  }

  // ── Trigger helpers called by MapComponent / DashboardComponent ────────────

  checkFps(fps: number): void {
    if (fps < 20 && fps > 0) {
      this.lowFpsStreak++;
      if (this.lowFpsStreak === 3) {
        this.push('error', 'Low FPS', `Rendering dropped to ${fps} fps — try reducing vehicle count.`);
      }
    } else {
      this.lowFpsStreak = 0;
    }
  }

  checkCongestion(maxScore: number): void {
    const now = Date.now();
    if (maxScore > 0.85 && now - this.lastCongestionAlert > 10_000) {
      this.lastCongestionAlert = now;
      this.push('warn', 'High Congestion', `Peak congestion at ${Math.round(maxScore * 100)}% — heavy traffic detected.`);
    }
  }

  checkWsStatus(status: string): void {
    if (status === this.lastWsStatus) return;
    this.lastWsStatus = status;
    if (status === 'DISCONNECTED') {
      this.push('error', 'Connection Lost', 'WebSocket disconnected — attempting reconnect…');
    } else if (status === 'CONNECTED' && this.lastWsStatus !== '') {
      this.push('info', 'Reconnected', 'WebSocket connection restored.');
    }
  }
}
