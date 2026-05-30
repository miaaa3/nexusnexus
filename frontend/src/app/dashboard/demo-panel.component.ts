import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

import { DemoModeService } from '../core/demo-mode.service';

interface DemoButton {
  key:    'rush' | 'accident' | 'emergency' | 'iris' | 'stress';
  icon:   string;
  label:  string;
  hint:   string;
  color:  string;
}

/**
 * "Démo" panel — five buttons that drive scripted scenarios via
 * {@link DemoModeService}. Per-button colour matches the colour theme of the
 * scenario it triggers (orange rush, red accident, etc.) so the panel reads
 * at a glance.
 *
 * The whole panel disables while a scenario is in flight (REST chain), so
 * double-clicks are impossible.
 */
@Component({
  selector: 'app-demo-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="demo-card">
      <div class="demo-header">
        <span class="demo-title">DÉMO</span>
        <span class="demo-status" [class.demo-status--on]="demo.busy()">
          {{ demo.status() || 'idle' }}
        </span>
      </div>

      <div class="demo-grid">
        @for (b of BUTTONS; track b.key) {
          <button class="demo-btn"
                  [style.--c]="b.color"
                  [disabled]="demo.busy()"
                  (click)="run(b.key)"
                  [title]="b.hint">
            <span class="demo-ico">{{ b.icon }}</span>
            <span class="demo-lbl">{{ b.label }}</span>
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .demo-card { display: flex; flex-direction: column; gap: 8px; }
    .demo-header {
      display: flex; justify-content: space-between; align-items: baseline;
    }
    .demo-title {
      font-size: 10px; font-weight: 700; letter-spacing: 1.4px;
      color: rgba(255,255,255,.85);
    }
    .demo-status {
      font-size: 10px; color: rgba(255,255,255,.45);
      font-variant-numeric: tabular-nums;
    }
    .demo-status--on {
      color: #3d9eff;
      animation: demo-pulse 1.4s ease-in-out infinite;
    }
    @keyframes demo-pulse {
      0%, 100% { opacity: .55; }
      50%      { opacity: 1; }
    }

    .demo-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px;
    }
    .demo-btn {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 9px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--c, #3d9eff) 35%, transparent);
      background: color-mix(in srgb, var(--c, #3d9eff) 8%, transparent);
      color: rgba(255,255,255,.85);
      cursor: pointer;
      text-align: left;
      font: 600 11px/1.1 inherit;
      transition: background .15s ease, border-color .15s ease, transform .1s ease;
    }
    .demo-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--c, #3d9eff) 22%, transparent);
      border-color: color-mix(in srgb, var(--c, #3d9eff) 65%, transparent);
    }
    .demo-btn:active:not(:disabled) { transform: translateY(1px); }
    .demo-btn:disabled { opacity: .45; cursor: not-allowed; }

    .demo-ico { font-size: 14px; line-height: 1; }
    .demo-lbl { line-height: 1.15; }
  `],
})
export class DemoPanelComponent {
  protected demo = inject(DemoModeService);

  protected readonly BUTTONS: ReadonlyArray<DemoButton> = [
    { key: 'rush',      icon: '🌅', label: 'Rush hour',  hint: 'Fleet ≈ 6 K, RUSH_HOUR mode',          color: '#e67e22' },
    { key: 'accident',  icon: '💥', label: 'Accidents',  hint: 'Drop 3 incidents around the centre',   color: '#e74c3c' },
    { key: 'emergency', icon: '🚨', label: 'Emergency',  hint: 'Select & follow a live EMERGENCY veh.', color: '#ff5252' },
    { key: 'iris',      icon: '🗺',  label: 'IRIS focus', hint: 'Fly to the most congested IRIS zone',  color: '#3d9eff' },
    { key: 'stress',    icon: '⚡', label: '15K stress', hint: 'Push the fleet to 15 000 vehicles',    color: '#9b59b6' },
  ];

  run(key: DemoButton['key']): void {
    switch (key) {
      case 'rush':      this.demo.rushHour();         break;
      case 'accident':  this.demo.accidentScenario(); break;
      case 'emergency': this.demo.emergencyFollow();  break;
      case 'iris':      this.demo.irisAnalysis();     break;
      case 'stress':    this.demo.stressTest();       break;
    }
  }
}
