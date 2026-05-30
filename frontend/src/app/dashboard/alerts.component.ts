import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AlertService } from '../core/alert.service';

/**
 * Toast overlay — positioned at the top-right of the screen.
 * Separate from the dashboard panel so it can be absolutely positioned
 * without affecting the panel layout.
 */
@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="alerts-container">
      @for (alert of alertSvc.alerts(); track alert.id) {
        <div class="toast" [class]="'toast--' + alert.level">
          <div class="toast-icon">
            @switch (alert.level) {
              @case ('error') { ✕ }
              @case ('warn')  { ⚠ }
              @case ('info')  { ● }
            }
          </div>
          <div class="toast-body">
            <div class="toast-title">{{ alert.title }}</div>
            <div class="toast-msg">{{ alert.message }}</div>
          </div>
          <button class="toast-close" (click)="alertSvc.dismiss(alert.id)">✕</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .alerts-container {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 9999;
      pointer-events: none;
      width: 280px;
    }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 11px 13px;
      border-radius: 10px;
      border: 1px solid;
      backdrop-filter: blur(14px);
      pointer-events: all;
      box-shadow: 0 6px 24px rgba(0,0,0,0.5);
      animation: slideIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateX(24px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    .toast--error {
      background: rgba(30, 8, 8, 0.92);
      border-color: rgba(231, 76, 60, 0.45);
    }
    .toast--warn {
      background: rgba(30, 22, 4, 0.92);
      border-color: rgba(241, 196, 15, 0.4);
    }
    .toast--info {
      background: rgba(6, 14, 28, 0.92);
      border-color: rgba(61, 158, 255, 0.4);
    }

    .toast-icon {
      font-size: 13px;
      flex-shrink: 0;
      margin-top: 1px;
      font-weight: 700;
    }
    .toast--error .toast-icon { color: #e74c3c; }
    .toast--warn  .toast-icon { color: #f1c40f; }
    .toast--info  .toast-icon { color: #3d9eff; }

    .toast-body {
      flex: 1;
      min-width: 0;
    }

    .toast-title {
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 2px;
    }

    .toast-msg {
      font-size: 10px;
      color: rgba(255,255,255,0.55);
      line-height: 1.4;
    }

    .toast-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.25);
      font-size: 10px;
      cursor: pointer;
      padding: 0;
      flex-shrink: 0;
      margin-top: 1px;
      line-height: 1;
    }
    .toast-close:hover { color: rgba(255,255,255,0.7); }
  `]
})
export class AlertsComponent {
  readonly alertSvc = inject(AlertService);
}
