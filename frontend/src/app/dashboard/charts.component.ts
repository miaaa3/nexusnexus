import {
  Component, OnDestroy, AfterViewInit,
  ViewChild, ElementRef, inject, effect, Injector
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChartDataService } from '../core/chart-data.service';

/**
 * Three pure-Canvas mini-charts drawn directly — no chart library.
 *
 * - FPS sparkline:          blue line, 60-point history, 30fps danger threshold
 * - Speed histogram:        cyan bars, 0–120 km/h in 10 km/h bins
 * - Congestion timeline:    gradient area fill, 0–1 score history
 *
 * Redraws only when ChartDataService.snapshot signal changes (≤2Hz).
 */
@Component({
  selector: 'app-charts',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="charts-panel">

      <div class="chart-block">
        <div class="chart-title">
          FPS <span class="chart-val" [class.warn]="snap().avgSpeed < 30">{{ snap().fpsHistory[snap().fpsHistory.length-1] }}</span>
        </div>
        <canvas #fpsCanvas width="220" height="48"></canvas>
      </div>

      <div class="chart-block">
        <div class="chart-title">
          Speed dist · <span class="chart-val">{{ snap().avgSpeed }} km/h avg</span>
        </div>
        <canvas #speedCanvas width="220" height="48"></canvas>
      </div>

      <div class="chart-block">
        <div class="chart-title">
          Congestion <span class="chart-val warn-if-high"
            [class.warn]="snap().maxCongestion > 0.75">
            {{ (snap().maxCongestion * 100) | number:'1.0-0' }}% peak
          </span>
        </div>
        <canvas #congCanvas width="220" height="48"></canvas>
      </div>

    </div>
  `,
  styles: [`
    .charts-panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .chart-block {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .chart-title {
      font-size: 9px;
      font-weight: 600;
      color: rgba(255,255,255,0.35);
      letter-spacing: 0.8px;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .chart-val {
      color: rgba(255,255,255,0.65);
      font-variant-numeric: tabular-nums;
    }

    .chart-val.warn { color: #e74c3c; }

    canvas {
      display: block;
      border-radius: 4px;
      background: rgba(255,255,255,0.03);
    }
  `]
})
export class ChartsComponent implements AfterViewInit {

  @ViewChild('fpsCanvas')   fpsRef!:  ElementRef<HTMLCanvasElement>;
  @ViewChild('speedCanvas') speedRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('congCanvas')  congRef!:  ElementRef<HTMLCanvasElement>;

  private charts   = inject(ChartDataService);
  private injector = inject(Injector);
  readonly snap    = this.charts.snapshot;

  ngAfterViewInit(): void {
    // effect() must run in an injection context — provide Injector explicitly
    effect(() => {
      const s = this.snap();
      this.drawSparkline(
        this.fpsRef.nativeElement, s.fpsHistory,
        0, 120, '#3d9eff', 30
      );
      this.drawHistogram(
        this.speedRef.nativeElement, s.speedBins,
        '#00d4aa'
      );
      this.drawArea(
        this.congRef.nativeElement, s.congHistory,
        0, 1, '#ff6b35', '#e74c3c'
      );
    }, { injector: this.injector });
  }

  ngOnDestroy(): void {}

  // ── Sparkline (line chart) ─────────────────────────────────────────────────
  private drawSparkline(
    canvas: HTMLCanvasElement,
    data: number[],
    min: number,
    max: number,
    color: string,
    dangerThreshold?: number
  ): void {
    const ctx = canvas.getContext('2d')!;
    const { width: W, height: H } = canvas;
    ctx.clearRect(0, 0, W, H);

    const range = max - min || 1;
    const toY   = (v: number) => H - ((v - min) / range) * (H - 4) - 2;
    const toX   = (i: number) => (i / (data.length - 1)) * W;

    // Danger threshold line
    if (dangerThreshold !== undefined) {
      const ty = toY(dangerThreshold);
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(231,76,60,0.35)';
      ctx.lineWidth = 1;
      ctx.moveTo(0, ty);
      ctx.lineTo(W, ty);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Gradient fill below line
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, color.replace(')', ', 0.25)').replace('rgb', 'rgba'));
    grad.addColorStop(1, color.replace(')', ', 0)').replace('rgb', 'rgba'));

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(i), toY(data[i]));
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(i), toY(data[i]));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ── Histogram (bar chart) ─────────────────────────────────────────────────
  private drawHistogram(
    canvas: HTMLCanvasElement,
    bins: number[],
    color: string
  ): void {
    const ctx = canvas.getContext('2d')!;
    const { width: W, height: H } = canvas;
    ctx.clearRect(0, 0, W, H);

    const maxVal = Math.max(...bins, 1);
    const barW   = W / bins.length;
    const gap    = 2;

    for (let i = 0; i < bins.length; i++) {
      const barH = (bins[i] / maxVal) * (H - 4);
      const x    = i * barW + gap / 2;
      const y    = H - barH;

      // Color ramp: cyan (slow) → yellow → red (fast)
      const t  = i / (bins.length - 1);
      const r  = Math.round(t < 0.5 ? t * 2 * 255 : 255);
      const g  = Math.round(t < 0.5 ? 212 - t * 100 : 212 - (t - 0.5) * 2 * 212);
      const b  = Math.round(t < 0.5 ? 170 - t * 340 : 0);
      ctx.fillStyle = `rgba(${r},${g},${b}, 0.8)`;
      ctx.beginPath();
      ctx.roundRect(x, y, barW - gap, barH, [2, 2, 0, 0]);
      ctx.fill();
    }

    // X-axis labels at 0 and 120 km/h
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '7px sans-serif';
    ctx.fillText('0', 2, H - 1);
    ctx.fillText('120', W - 16, H - 1);
  }

  // ── Area chart (congestion) ───────────────────────────────────────────────
  private drawArea(
    canvas: HTMLCanvasElement,
    data: number[],
    min: number,
    max: number,
    colorTop: string,
    colorBottom: string
  ): void {
    const ctx = canvas.getContext('2d')!;
    const { width: W, height: H } = canvas;
    ctx.clearRect(0, 0, W, H);

    const range = max - min || 1;
    const toY   = (v: number) => H - ((v - min) / range) * (H - 4) - 2;
    const toX   = (i: number) => (i / (data.length - 1)) * W;

    // Grid line at 0.5 (medium congestion)
    const midY = toY(0.5);
    ctx.beginPath();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.moveTo(0, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(231, 76, 60, 0.4)');
    grad.addColorStop(0.5, 'rgba(255, 107, 53, 0.2)');
    grad.addColorStop(1, 'rgba(255, 107, 53, 0)');

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0]));
    for (let i = 1; i < data.length; i++) {
      // Smooth curve using quadratic bezier
      const cx = (toX(i - 1) + toX(i)) / 2;
      ctx.quadraticCurveTo(toX(i - 1), toY(data[i - 1]), cx, (toY(data[i-1]) + toY(data[i])) / 2);
    }
    ctx.lineTo(W, toY(data[data.length - 1]));
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Redraw line on top
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0]));
    for (let i = 1; i < data.length; i++) {
      const cx = (toX(i-1) + toX(i)) / 2;
      ctx.quadraticCurveTo(toX(i-1), toY(data[i-1]), cx, (toY(data[i-1])+toY(data[i]))/2);
    }
    ctx.lineTo(W, toY(data[data.length - 1]));
    ctx.strokeStyle = '#ff6b35';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
