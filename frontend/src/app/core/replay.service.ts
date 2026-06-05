import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { SimulationFrame } from './models/vehicle.model';
import { environment } from '../../environments/environment';

export type ReplayState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused';

/**
 * Replay service — fetches recorded frames from the backend and drives
 * a local playback loop that emits SimulationFrame events at the correct rate.
 *
 * Design:
 * - Frames fetched once on activation; stored in memory
 * - Playback uses requestAnimationFrame so it never blocks the render thread
 * - The same frames$ Subject is used by MapComponent — zero extra rendering code
 * - Speed multiplier adjusts how fast wallclock advances through recorded time
 */
@Injectable({ providedIn: 'root' })
export class ReplayService {

  private http = inject(HttpClient);
  private readonly API = `${environment.backendUrl}/api/replay`;

  // ── Public state ────────────────────────────────────────────────────────────
  readonly state       = signal<ReplayState>('idle');
  readonly currentIdx  = signal<number>(0);
  readonly totalFrames = signal<number>(0);
  readonly progress    = signal<number>(0);       // 0–1
  readonly speedFactor = signal<number>(1.0);     // playback speed multiplier

  // Emits frames during playback — consumed by MapComponent
  readonly frames$ = new Subject<SimulationFrame>();

  // ── Private state ───────────────────────────────────────────────────────────
  private frames: SimulationFrame[] = [];
  private rafId?: number;
  private playbackStart = 0;      // real time when play() was last called
  private frameTimeStart = 0;     // timestamp of the frame active when play() was called
  private frameIdx = 0;

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Load frames from the server and enter ready state. */
  load(): void {
    if (this.state() === 'loading') return;
    this.state.set('loading');

    this.http.get<SimulationFrame[]>(`${this.API}/frames`).subscribe({
      next: frames => {
        this.frames = frames;
        this.frameIdx = 0;
        this.totalFrames.set(frames.length);
        this.currentIdx.set(0);
        this.progress.set(0);
        this.state.set('ready');
      },
      error: err => {
        console.error('Replay load failed', err);
        this.state.set('idle');
      }
    });
  }

  play(): void {
    const s = this.state();
    if (s !== 'ready' && s !== 'paused') return;
    if (this.frames.length === 0) return;

    this.playbackStart  = performance.now();
    this.frameTimeStart = this.frames[this.frameIdx]?.timestamp ?? 0;
    this.state.set('playing');
    this.scheduleNext();
  }

  pause(): void {
    if (this.state() !== 'playing') return;
    cancelAnimationFrame(this.rafId!);
    this.state.set('paused');
  }

  togglePlayPause(): void {
    this.state() === 'playing' ? this.pause() : this.play();
  }

  seekTo(idx: number): void {
    const clamped = Math.max(0, Math.min(idx, this.frames.length - 1));
    this.frameIdx = clamped;
    this.currentIdx.set(clamped);
    this.progress.set(clamped / Math.max(1, this.frames.length - 1));
    if (this.frames[clamped]) this.frames$.next(this.frames[clamped]);

    // If playing, reset timing from the new seek position
    if (this.state() === 'playing') {
      cancelAnimationFrame(this.rafId!);
      this.playbackStart  = performance.now();
      this.frameTimeStart = this.frames[clamped]?.timestamp ?? 0;
      this.scheduleNext();
    }
  }

  setSpeed(x: number): void {
    this.speedFactor.set(Math.max(0.25, Math.min(8, x)));
    // Re-anchor timing so speed change doesn't cause a jump
    if (this.state() === 'playing') {
      this.playbackStart  = performance.now();
      this.frameTimeStart = this.frames[this.frameIdx]?.timestamp ?? 0;
    }
  }

  stop(): void {
    cancelAnimationFrame(this.rafId!);
    this.frames = [];
    this.frameIdx = 0;
    this.state.set('idle');
    this.totalFrames.set(0);
    this.currentIdx.set(0);
    this.progress.set(0);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private scheduleNext(): void {
    this.rafId = requestAnimationFrame(now => this.tick(now));
  }

  private tick(now: number): void {
    if (this.state() !== 'playing') return;

    const elapsed       = now - this.playbackStart;
    const simElapsed    = elapsed * this.speedFactor();
    const targetSimTime = this.frameTimeStart + simElapsed;

    // Advance frame index until we find the frame matching current sim time
    while (
      this.frameIdx < this.frames.length - 1 &&
      this.frames[this.frameIdx + 1].timestamp <= targetSimTime
    ) {
      this.frameIdx++;
    }

    // Emit current frame
    const frame = this.frames[this.frameIdx];
    if (frame) {
      this.frames$.next(frame);
      this.currentIdx.set(this.frameIdx);
      this.progress.set(this.frameIdx / Math.max(1, this.frames.length - 1));
    }

    // End of recording
    if (this.frameIdx >= this.frames.length - 1) {
      this.state.set('paused');
      return;
    }

    this.scheduleNext();
  }
}
