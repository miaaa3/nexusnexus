import { Map as MapLibreMap } from 'maplibre-gl';
import { VehicleUpdate } from '../core/models/vehicle.model';

/**
 * WebGL2 congestion grid layer.
 *
 * Divides the map's simulation area into a COLS×ROWS grid.
 * Each cell is colored by its congestion score:
 *   score = (density / maxDensity) × (1 - avgSpeed / 120)
 * Color ramp: transparent (empty) → green (fast) → yellow → red (jammed).
 *
 * Rendering: one quad per cell, drawn as a single instanced draw call.
 *
 * Buffer layout per cell instance (5 floats):
 *   [0] mercator cell center X
 *   [1] mercator cell center Y
 *   [2] cell half-width  (mercator)
 *   [3] cell half-height (mercator)
 *   [4] congestion score 0–1
 */
export class CongestionRenderer {

  readonly id = 'nexus-congestion';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private quadBuf!: WebGLBuffer;
  private instanceBuf!: WebGLBuffer;
  private map!: MapLibreMap;
  private uMatrix!: WebGLUniformLocation;

  // Grid configuration — covers Paris bounding box
  private readonly LAT_MIN = 48.82;
  private readonly LAT_MAX = 48.90;
  private readonly LON_MIN = 2.28;
  private readonly LON_MAX = 2.42;
  private readonly COLS = 40;
  private readonly ROWS = 30;

  private readonly CELL_LON = (this.LON_MAX - this.LON_MIN) / this.COLS;
  private readonly CELL_LAT = (this.LAT_MAX - this.LAT_MIN) / this.ROWS;

  private readonly FLOATS_PER_CELL = 5;
  private readonly TOTAL_CELLS = this.COLS * this.ROWS;

  private instanceData: Float32Array;
  private cellCounts: Uint16Array;       // vehicle count per cell
  private cellSpeedSum: Float32Array;    // sum of speeds per cell (for average)

  // Pre-computed cell center mercator coords (never change)
  private readonly cellMercX: Float32Array;
  private readonly cellMercY: Float32Array;
  private readonly cellHW: number;   // half-width in mercator
  private readonly cellHH: number;   // half-height in mercator

  constructor() {
    this.instanceData = new Float32Array(this.TOTAL_CELLS * this.FLOATS_PER_CELL);
    this.cellCounts   = new Uint16Array(this.TOTAL_CELLS);
    this.cellSpeedSum = new Float32Array(this.TOTAL_CELLS);
    this.cellMercX    = new Float32Array(this.TOTAL_CELLS);
    this.cellMercY    = new Float32Array(this.TOTAL_CELLS);

    // Pre-compute all cell center mercator positions
    for (let r = 0; r < this.ROWS; r++) {
      for (let c = 0; c < this.COLS; c++) {
        const idx = r * this.COLS + c;
        const lat = this.LAT_MIN + (r + 0.5) * this.CELL_LAT;
        const lon = this.LON_MIN + (c + 0.5) * this.CELL_LON;
        const [mx, my] = lngLatToMercator(lon, lat);
        this.cellMercX[idx] = mx;
        this.cellMercY[idx] = my;
      }
    }

    // Half-cell dimensions in mercator space (approximate, good enough for rendering)
    const [x0] = lngLatToMercator(this.LON_MIN, this.LAT_MIN);
    const [x1] = lngLatToMercator(this.LON_MIN + this.CELL_LON, this.LAT_MIN);
    const [, y0] = lngLatToMercator(this.LON_MIN, this.LAT_MIN);
    const [, y1] = lngLatToMercator(this.LON_MIN, this.LAT_MIN + this.CELL_LAT);
    this.cellHW = Math.abs(x1 - x0) / 2;
    this.cellHH = Math.abs(y1 - y0) / 2;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;
    this.gl  = gl as WebGL2RenderingContext;
    this.initGL(this.gl);
  }

  render(gl: WebGL2RenderingContext | WebGLRenderingContext, matrix: number[]): void {
    const gl2 = gl as WebGL2RenderingContext;
    gl2.useProgram(this.program);
    gl2.uniformMatrix4fv(this.uMatrix, false, matrix);

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.instanceBuf);
    gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, this.instanceData);

    gl2.bindVertexArray(this.vao);
    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA);
    gl2.drawArraysInstanced(gl2.TRIANGLE_FAN, 0, 4, this.TOTAL_CELLS);
    gl2.bindVertexArray(null);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl2 = gl as WebGL2RenderingContext;
    gl2.deleteProgram(this.program);
    gl2.deleteBuffer(this.instanceBuf);
    gl2.deleteBuffer(this.quadBuf);
    gl2.deleteVertexArray(this.vao);
  }

  /**
   * Recompute congestion scores from the current vehicle positions.
   * Called at ~2Hz from MapComponent to avoid per-frame overhead.
   */
  updateVehicles(vehicles: VehicleUpdate[]): void {
    // Reset accumulators
    this.cellCounts.fill(0);
    this.cellSpeedSum.fill(0);

    // Accumulate vehicles into cells
    for (const v of vehicles) {
      const col = Math.floor((v.lon - this.LON_MIN) / this.CELL_LON);
      const row = Math.floor((v.lat - this.LAT_MIN) / this.CELL_LAT);
      if (col < 0 || col >= this.COLS || row < 0 || row >= this.ROWS) continue;
      const idx = row * this.COLS + col;
      this.cellCounts[idx]++;
      this.cellSpeedSum[idx] += v.speed;
    }

    // Find max density for normalization
    let maxDensity = 1;
    for (let i = 0; i < this.TOTAL_CELLS; i++) {
      if (this.cellCounts[i] > maxDensity) maxDensity = this.cellCounts[i];
    }

    // Build instance buffer
    for (let i = 0; i < this.TOTAL_CELLS; i++) {
      const count = this.cellCounts[i];
      const base  = i * this.FLOATS_PER_CELL;

      this.instanceData[base]     = this.cellMercX[i];
      this.instanceData[base + 1] = this.cellMercY[i];
      this.instanceData[base + 2] = this.cellHW;
      this.instanceData[base + 3] = this.cellHH;

      if (count === 0) {
        this.instanceData[base + 4] = 0;   // transparent
      } else {
        const avgSpeed   = this.cellSpeedSum[i] / count;
        const density    = count / maxDensity;
        // High density + low speed = high congestion
        const congestion = density * (1 - avgSpeed / 120);
        this.instanceData[base + 4] = Math.min(1, Math.max(0, congestion));
      }
    }

    this.map?.triggerRepaint();
  }

  // ───────────────────────────────────────────────────────────────────────────

  private initGL(gl: WebGL2RenderingContext): void {
    this.program = buildProgram(gl, CONG_VERT, CONG_FRAG);
    this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix')!;

    // Unit quad
    const quad = new Float32Array([-1,-1, 1,-1, 1,1, -1,1]);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // attrib 0: quad xy (per-vertex)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // per-instance: stride = 5 floats = 20 bytes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const stride = this.FLOATS_PER_CELL * 4;

    // attrib 1: cell center mercator (x, y)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    // attrib 2: half-width, half-height
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 2 * 4);
    gl.vertexAttribDivisor(2, 1);

    // attrib 3: congestion score
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 4 * 4);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

const CONG_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_center;   // mercator center
layout(location = 2) in vec2 a_halfSize; // mercator half-w, half-h
layout(location = 3) in float a_score;   // 0 = free flow, 1 = jam

uniform mat4 u_matrix;

out float v_score;
out vec2  v_uv;

void main() {
  vec2 world = a_center + a_quad * a_halfSize;
  gl_Position = u_matrix * vec4(world, 0.0, 1.0);
  v_score = a_score;
  v_uv    = a_quad;
}
`;

const CONG_FRAG = `#version 300 es
precision mediump float;

in float v_score;
in vec2  v_uv;

out vec4 fragColor;

// Color ramp: green (0) → yellow (0.5) → red (1)
vec3 congestionColor(float t) {
  vec3 green  = vec3(0.10, 0.90, 0.30);
  vec3 yellow = vec3(1.00, 0.85, 0.00);
  vec3 red    = vec3(1.00, 0.15, 0.10);
  if (t < 0.5) return mix(green, yellow, t * 2.0);
  return mix(yellow, red, (t - 0.5) * 2.0);
}

void main() {
  if (v_score < 0.05) discard;   // empty cells invisible

  vec3 color = congestionColor(v_score);
  // Soft edge fade so cells blend nicely
  vec2 uv = abs(v_uv);
  float fade = 1.0 - smoothstep(0.7, 1.0, max(uv.x, uv.y));
  float alpha = v_score * 0.45 * fade;

  fragColor = vec4(color, alpha);
}
`;

function buildProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as [number, string][]) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? 'compile error');
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
  return prog;
}
