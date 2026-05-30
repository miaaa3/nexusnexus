import { Map as MapLibreMap } from 'maplibre-gl';
import { VehicleUpdate, VEHICLE_COLORS } from '../core/models/vehicle.model';

interface TrailEntry {
  buf: Float32Array;
  head: number;
  len: number;
  r: number;
  g: number;
  b: number;
  lastSeenFrame: number;
}

/**
 * WebGL2 trail layer — draws fading polylines for recent vehicle positions.
 *
 * Performance strategy:
 * - Ring buffer per vehicle: TRAIL_LEN × 2 floats (mercX, mercY) → no reallocation
 * - Single flat vertex buffer, rebuilt on each frame in JS, one draw call
 * - Only tracks VISIBLE vehicles (passed in after frustum culling)
 * - Fading alpha encoded per-vertex in the buffer
 *
 * Buffer layout per vertex (6 floats):
 *   [0] mercX  [1] mercY  [2] r  [3] g  [4] b  [5] alpha
 */
export class TrailRenderer {

  readonly id = 'nexus-trails';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private map!: MapLibreMap;
  private uMatrix!: WebGLUniformLocation;

  private static readonly TRAIL_LEN = 25;        // positions per vehicle
  private static readonly FLOATS_PER_VERT = 6;
  private static readonly MAX_TRAIL_VEHICLES = 1000;

  // Ring buffer: vehicleId → circular array of [mercX, mercY] pairs
  private trails = new Map<string, TrailEntry>();
  private frameSeq = 0;

  // Flat vertex buffer for all trail segments
  private vertexData: Float32Array;
  private vertexCount = 0;

  constructor() {
    const maxVerts = TrailRenderer.MAX_TRAIL_VEHICLES * TrailRenderer.TRAIL_LEN * 2;
    this.vertexData = new Float32Array(maxVerts * TrailRenderer.FLOATS_PER_VERT);
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;
    this.gl  = gl as WebGL2RenderingContext;
    this.initGL(this.gl);
  }

  render(gl: WebGL2RenderingContext | WebGLRenderingContext, matrix: number[]): void {
    if (this.vertexCount === 0) return;
    const gl2 = gl as WebGL2RenderingContext;

    gl2.useProgram(this.program);
    gl2.uniformMatrix4fv(this.uMatrix, false, matrix);

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.vbo);
    gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, this.vertexData, 0,
      this.vertexCount * TrailRenderer.FLOATS_PER_VERT);

    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA);

    gl2.bindVertexArray(this.vao);
    gl2.drawArrays(gl2.LINES, 0, this.vertexCount);
    gl2.bindVertexArray(null);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl2 = gl as WebGL2RenderingContext;
    gl2.deleteProgram(this.program);
    gl2.deleteBuffer(this.vbo);
    gl2.deleteVertexArray(this.vao);
  }

  /**
   * Called every server frame with the current visible vehicles.
   * Updates ring buffers and rebuilds the vertex data for rendering.
   */
  updateVehicles(vehicles: VehicleUpdate[]): void {
    const TL = TrailRenderer.TRAIL_LEN;
    const FPV = TrailRenderer.FLOATS_PER_VERT;
    const frame = ++this.frameSeq;

    // Record new positions
    for (const v of vehicles) {
      let t = this.trails.get(v.id);
      if (!t) {
        if (this.trails.size >= TrailRenderer.MAX_TRAIL_VEHICLES) continue;

        const [r, g, b] = VEHICLE_COLORS[v.type];
        t = {
          buf: new Float32Array(TL * 2),
          head: 0,
          len: 0,
          r,
          g,
          b,
          lastSeenFrame: frame,
        };
        this.trails.set(v.id, t);
      }

      const [r, g, b] = VEHICLE_COLORS[v.type];
      t.r = r;
      t.g = g;
      t.b = b;
      t.lastSeenFrame = frame;

      const [mx, my] = lngLatToMercator(v.lon, v.lat);
      t.buf[t.head * 2]     = mx;
      t.buf[t.head * 2 + 1] = my;
      t.head = (t.head + 1) % TL;
      if (t.len < TL) t.len++;
    }

    // Evict stale trail entries (vehicles no longer visible)
    for (const [id, t] of this.trails) {
      if (t.lastSeenFrame !== frame) this.trails.delete(id);
    }

    // Rebuild flat vertex buffer
    let cursor = 0;
    for (const t of this.trails.values()) {
      if (t.len < 2) continue;

      // Walk the ring buffer in order from oldest to newest
      for (let i = 0; i < t.len - 1; i++) {
        if (cursor + FPV * 2 > this.vertexData.length) break;

        const ai = (t.head - t.len + i + TL) % TL;
        const bi = (ai + 1) % TL;

        // Alpha fades from 0 (oldest) to 0.7 (newest)
        const alpha = ((i + 1) / t.len) * 0.7;

        // Vertex A
        this.vertexData[cursor++] = t.buf[ai * 2];
        this.vertexData[cursor++] = t.buf[ai * 2 + 1];
        this.vertexData[cursor++] = t.r;
        this.vertexData[cursor++] = t.g;
        this.vertexData[cursor++] = t.b;
        this.vertexData[cursor++] = alpha;

        // Vertex B
        this.vertexData[cursor++] = t.buf[bi * 2];
        this.vertexData[cursor++] = t.buf[bi * 2 + 1];
        this.vertexData[cursor++] = t.r;
        this.vertexData[cursor++] = t.g;
        this.vertexData[cursor++] = t.b;
        this.vertexData[cursor++] = Math.min(alpha + 0.05, 0.7);
      }

      if (cursor + FPV * 2 > this.vertexData.length) break;
    }

    this.vertexCount = Math.floor(cursor / FPV);
    this.map?.triggerRepaint();
  }

  clearTrails(): void {
    this.trails.clear();
    this.vertexCount = 0;
  }

  // ────────────────────────────────────────────────────────────────────────────

  private initGL(gl: WebGL2RenderingContext): void {
    this.program = buildProgram(gl, TRAIL_VERT, TRAIL_FRAG);
    this.uMatrix = gl.getUniformLocation(this.program, 'u_matrix')!;

    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Re-bind VBO inside VAO so attrib pointers are recorded in the VAO
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

    const stride = TrailRenderer.FLOATS_PER_VERT * 4;

    // position (mercX, mercY)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);

    // color (r, g, b)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 2 * 4);

    // alpha
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 5 * 4);

    gl.bindVertexArray(null);
  }
}

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

const TRAIL_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_alpha;

uniform mat4 u_matrix;

out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_color = a_color;
  v_alpha = a_alpha;
}
`;

const TRAIL_FRAG = `#version 300 es
precision mediump float;

in vec3 v_color;
in float v_alpha;

out vec4 fragColor;

void main() {
  fragColor = vec4(v_color * 1.2, v_alpha);
}
`;

function buildProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].forEach((type, i) => {
    const src = i === 0 ? vs : fs;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? 'compile error');
    gl.attachShader(prog, s);
  });
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
  return prog;
}
