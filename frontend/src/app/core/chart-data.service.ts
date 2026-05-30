import { Injectable, signal } from '@angular/core';
import { VehicleUpdate } from './models/vehicle.model';

const SPARKLINE_LEN   = 60;   // FPS + congestion history depth
const HISTOGRAM_BINS  = 12;   // speed histogram buckets (0–120 km/h, 10 km/h each)

export interface ChartSnapshot {
  fpsHistory:        number[];          // last N fps readings
  congHistory:       number[];          // last N avg-congestion readings (0–1)
  speedBins:         number[];          // count per 10 km/h bin
  avgSpeed:          number;
  maxCongestion:     number;            // highest cell score this tick
}

/**
 * Lightweight time-series store for dashboard charts.
 * All buffers are fixed-length arrays — no allocations after init.
 * Consumed by ChartsComponent via a signal.
 */
@Injectable({ providedIn: 'root' })
export class ChartDataService {

  private fpsRing:   number[] = new Array(SPARKLINE_LEN).fill(0);
  private congRing:  number[] = new Array(SPARKLINE_LEN).fill(0);
  private speedBins: number[] = new Array(HISTOGRAM_BINS).fill(0);

  readonly snapshot = signal<ChartSnapshot>({
    fpsHistory:    [...this.fpsRing],
    congHistory:   [...this.congRing],
    speedBins:     [...this.speedBins],
    avgSpeed:      0,
    maxCongestion: 0,
  });

  /** Called every 500ms with the current FPS value. */
  pushFps(fps: number): void {
    this.fpsRing.shift();
    this.fpsRing.push(fps);
    this.snapshot.update(s => ({ ...s, fpsHistory: [...this.fpsRing] }));
  }

  /** Called every 500ms with the current average congestion score (0–1). */
  pushCongestion(score: number, maxScore: number): void {
    this.congRing.shift();
    this.congRing.push(score);
    this.snapshot.update(s => ({
      ...s,
      congHistory:   [...this.congRing],
      maxCongestion: maxScore,
    }));
  }

  /** Called every server frame with visible vehicles — recomputes speed histogram. */
  updateVehicles(vehicles: VehicleUpdate[]): void {
    this.speedBins.fill(0);
    let speedSum = 0;

    for (const v of vehicles) {
      const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(v.speed / 10));
      this.speedBins[bin]++;
      speedSum += v.speed;
    }

    const avgSpeed = vehicles.length > 0 ? speedSum / vehicles.length : 0;
    this.snapshot.update(s => ({
      ...s,
      speedBins: [...this.speedBins],
      avgSpeed: Math.round(avgSpeed),
    }));
  }
}
