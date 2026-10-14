import { Map as MapLibreMap } from 'maplibre-gl';
import { VehicleUpdate, VEHICLE_COLORS, VEHICLE_SIZES, WRECK_COLOR, WRECK_SIZE } from '../core/models/vehicle.model';

/**
 * Squared mercator-distance threshold above which a frame-to-frame jump is
 * treated as a backend re-spawn rather than honest movement. 0.0005 mercator
 * units ≈ 55 m at La Rochelle latitude; squared = 2.5e-7. A car at 250 km/h
 * covers ~14 m in 200 ms, well under the threshold, so honest fast vehicles
 * still interpolate; only true teleports get snapped.
 */
const TELEPORT_SQ_THRESHOLD = 2.5e-7;

/**
 * WebGL2 custom layer for instanced vehicle rendering.
 *
 * Buffer layout per instance (10 floats × 4 bytes = 40 bytes/vehicle):
 *   [0] mercatorX
 *   [1] mercatorY
 *   [2] r
 *   [3] g
 *   [4] b
 *   [5] size
 *   [6] directionSin
 *   [7] directionCos
 *   [8] selected  (0.0 or 1.0)
 *   [9] typeCode  (0 car, 1 bus, 2 truck, 3 motorcycle, 4 emergency, 5 wreck)
 *
 * LOD:
 *   City-wide zooms use a simpler fragment path for non-selected vehicles.
 *   Street zooms keep the detailed silhouettes with windows/wheels/lights.
 */
export class VehicleRenderer {

  readonly id = 'nexus-vehicles';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private instanceBuffer!: WebGLBuffer;
  private quadBuffer!: WebGLBuffer;

  // FR : TAILLE MAX DU BUFFER = 20 000 voitures.
  //      20 000 × 10 floats × 4 octets = 800 Ko alloués UNE FOIS dans la VRAM du GPU.
  //      Doit matcher le plafond backend dans SimulationConfig.maxVehicles.
  private readonly MAX_VEHICLES = 20000;
  // FR : Chaque voiture = 10 valeurs (x, y, vitesse, direction, couleurR, G, B, taille, sélectionnée, type)
  private readonly FLOATS_PER_VEHICLE = 10;
  // FR : Le grand tableau qu'on enverra au GPU à chaque frame
  private instanceData: Float32Array;

  private prevPositions: Float32Array;
  private nextPositions: Float32Array;
  private vehicleCount = 0;

  // ── Interpolation timing ────────────────────────────────────────────────────
  // We interpolate prev → next over the duration that elapsed between the last
  // two WS frames, using the *client* monotonic clock (performance.now()).
  // Mixing client and server clocks (e.g. `performance.now() - serverTimestamp`)
  // is meaningless — server epoch ms vs client page-load ms are billions apart,
  // which is what produced the "vehicles look frozen" symptom: alpha clamped
  // to 0 every frame, so positions never advanced between WS arrivals.
  private lastFrameClientMs = 0;     // performance.now() at last updateVehicles
  private interpSpanMs      = 200;   // running estimate of inter-frame interval

  // Compact slot map — reassigned every frame so slots 0..N-1 always hold visible vehicles.
  private idToSlot = new Map<string, number>();
  // Persists the last mercator position for every vehicle ever seen, so
  // interpolation stays smooth when vehicles re-enter the viewport.
  private lastKnownPos = new Map<string, [number, number]>();
  private selectedId: string | null = null;

  private map?: MapLibreMap;
  private uMatrix!: WebGLUniformLocation;
  private uViewport!: WebGLUniformLocation;
  private uPixelRatio!: WebGLUniformLocation;
  private uTime!: WebGLUniformLocation;
  private uLodMode!: WebGLUniformLocation;

  constructor() {
    const cap = this.MAX_VEHICLES * this.FLOATS_PER_VEHICLE;
    this.instanceData  = new Float32Array(cap);
    this.prevPositions = new Float32Array(this.MAX_VEHICLES * 2);
    this.nextPositions = new Float32Array(this.MAX_VEHICLES * 2);
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;
    this.gl  = gl as WebGL2RenderingContext;
    this.initGL(this.gl);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // FR : LA MÉTHODE DE RENDU — appelée par MapLibre à chaque frame (60 fois/sec)
  //      C'est ICI qu'on dessine les 20 000 voitures D'UN SEUL COUP avec WebGL2.
  // ═════════════════════════════════════════════════════════════════════════
  render(gl: WebGL2RenderingContext | WebGLRenderingContext, matrix: number[]): void {
    const gl2 = gl as WebGL2RenderingContext;
    if (this.vehicleCount === 0) return;        // 0 voiture → rien à dessiner

    // ÉTAPE 1 : interpolation — on calcule la position lissée entre 2 frames serveur
    const t = performance.now();
    const alpha = this.computeAlpha(t);          // alpha ∈ [0, 1] : 0=prev, 1=next
    this.interpolatePositions(alpha);            // lerp(prev, next, alpha)

    // ÉTAPE 2 : on dit au GPU quel programme shader utiliser
    gl2.useProgram(this.program);
    // ÉTAPE 3 : on passe les UNIFORMS (variables globales du shader)
    gl2.uniformMatrix4fv(this.uMatrix, false, matrix);                        // matrice carte
    gl2.uniform2f(this.uViewport, gl2.drawingBufferWidth, gl2.drawingBufferHeight); // taille écran
    gl2.uniform1f(this.uPixelRatio, devicePixelRatio ?? 1);                    // densité pixels (retina)
    gl2.uniform1f(this.uTime, t * 0.001);                                      // temps (pour animations)
    gl2.uniform1f(this.uLodMode, this.lodMode());                              // mode LOD (compact/détaillé)

    // ÉTAPE 4 : on téléverse le tableau des voitures dans le buffer GPU
    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.instanceBuffer);
    gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, this.instanceData, 0,
      this.vehicleCount * this.FLOATS_PER_VEHICLE);

    // ÉTAPE 5 : on active le blending (transparence)
    gl2.bindVertexArray(this.vao);
    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA);

    // ⭐ ÉTAPE 6 : L'INSTRUCTION MAGIQUE — drawArraysInstanced
    //    En UN SEUL appel CPU → GPU, on dessine vehicleCount voitures.
    //    Le GPU exécute le vertex shader en PARALLÈLE pour chaque instance.
    //    C'est ce qui nous permet de tenir 60 FPS à 15K voitures.
    gl2.drawArraysInstanced(gl2.TRIANGLE_FAN, 0, 4, this.vehicleCount);
    gl2.bindVertexArray(null);

    // Keep MapLibre painting until interpolation finishes. Without this the
    // canvas only repaints when updateVehicles() calls triggerRepaint() — i.e.
    // at the WS broadcast rate (~5 Hz at 5 K vehicles), which makes the fleet
    // look static between frames. While alpha < 1 we ask for another tick so
    // positions advance every animation frame.
    if (alpha < 1) this.map?.triggerRepaint();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl2 = gl as WebGL2RenderingContext;
    gl2.deleteProgram(this.program);
    gl2.deleteBuffer(this.instanceBuffer);
    gl2.deleteBuffer(this.quadBuffer);
    gl2.deleteVertexArray(this.vao);
  }

  updateVehicles(vehicles: VehicleUpdate[], _timestamp: number): void {
    // Use the client monotonic clock for interpolation timing. The server
    // timestamp is kept on the wire for the dashboard latency widget, but
    // it cannot be subtracted from performance.now() — different reference
    // frames — so we measure the *client-side* gap between two arrivals and
    // animate over that span.
    const clientNow = performance.now();
    if (this.lastFrameClientMs > 0) {
      const observedSpan = clientNow - this.lastFrameClientMs;
      // EMA smooths jitter caused by occasional late frames; clamp keeps us
      // sane if the WS stream pauses (e.g. user switched tabs).
      const clampedSpan = Math.min(1_000, Math.max(50, observedSpan));
      this.interpSpanMs = this.interpSpanMs * 0.6 + clampedSpan * 0.4;
    }
    this.lastFrameClientMs = clientNow;

    // Compact reassignment: visible vehicles always occupy slots 0..N-1.
    // This is the key correctness requirement — drawArraysInstanced draws
    // instances 0..vehicleCount-1, so vehicle data MUST live in those slots.
    this.idToSlot.clear();

    const count = Math.min(vehicles.length, this.MAX_VEHICLES);
    for (let i = 0; i < count; i++) {
      const v = vehicles[i];
      this.idToSlot.set(v.id, i);

      const [mercX, mercY] = lngLatToMercator(v.lon, v.lat);

      // For interpolation: use last known position so vehicles glide smoothly
      // even after re-entering the viewport with a new slot assignment.
      //
      // Teleport guard: if the backend re-placed the vehicle on a far edge
      // (recovery path in reassignEdge / new A* after an invalid route), the
      // delta from prev → current would be huge and the interp would draw a
      // streak across the map ("flying car"). When the delta exceeds what a
      // vehicle could plausibly cover between two WS frames, we snap by
      // forcing prev = current.
      const prev = this.lastKnownPos.get(v.id);
      let prevX = mercX, prevY = mercY;
      if (prev) {
        const dx = mercX - prev[0];
        const dy = mercY - prev[1];
        // 0.0005 mercator ≈ 55 m at La Rochelle latitude; a vehicle at 250 km/h
        // covers ~14 m in 200 ms, so anything past this threshold is a
        // backend re-spawn, not honest motion.
        if (dx * dx + dy * dy < TELEPORT_SQ_THRESHOLD) {
          prevX = prev[0];
          prevY = prev[1];
        }
      }
      this.prevPositions[i * 2]     = prevX;
      this.prevPositions[i * 2 + 1] = prevY;
      this.nextPositions[i * 2]     = mercX;
      this.nextPositions[i * 2 + 1] = mercY;
      this.lastKnownPos.set(v.id, [mercX, mercY]);

      const base = i * this.FLOATS_PER_VEHICLE;
      const wrecked = v.wrecked === true;
      const [r, g, b] = wrecked ? WRECK_COLOR : VEHICLE_COLORS[v.type];
      const size = wrecked ? WRECK_SIZE : VEHICLE_SIZES[v.type];
      const dirRad = (v.direction * Math.PI) / 180;
      this.instanceData[base + 2] = r;
      this.instanceData[base + 3] = g;
      this.instanceData[base + 4] = b;
      this.instanceData[base + 5] = size;
      this.instanceData[base + 6] = Math.sin(dirRad);
      this.instanceData[base + 7] = Math.cos(dirRad);
      this.instanceData[base + 8] = v.id === this.selectedId ? 1.0 : 0.0;
      this.instanceData[base + 9] = wrecked ? 5.0 : vehicleTypeCode(v.type);
    }

    this.vehicleCount = count;
    this.map?.triggerRepaint();
  }

  setSelectedId(id: string | null): void {
    // Clear old flag in current slot (if vehicle still visible)
    if (this.selectedId) {
      const slot = this.idToSlot.get(this.selectedId);
      if (slot !== undefined) this.instanceData[slot * this.FLOATS_PER_VEHICLE + 8] = 0.0;
    }
    this.selectedId = id;
    // Set new flag
    if (id) {
      const slot = this.idToSlot.get(id);
      if (slot !== undefined) this.instanceData[slot * this.FLOATS_PER_VEHICLE + 8] = 1.0;
    }
    this.map?.triggerRepaint();
  }

  // -------------------------------------------------------------------------
  /**
   * Linear blend factor from {@code prevPositions} (alpha 0) to
   * {@code nextPositions} (alpha 1) based on time elapsed since the last
   * frame arrived, measured on the same monotonic clock used by render().
   *
   * <p>Right after a WS frame: alpha ≈ 0 → we render at the *previous* target
   * (smooth visual continuity with the frame just before). Over the next
   * ~{@link #interpSpanMs} ms the alpha climbs to 1 and the vehicle slides
   * into its new position. The render loop calls {@code triggerRepaint()}
   * while alpha &lt; 1, so the slide actually animates instead of snapping.
   */
  private computeAlpha(nowMs: number): number {
    if (this.lastFrameClientMs === 0 || this.interpSpanMs <= 0) return 1;
    const elapsed = nowMs - this.lastFrameClientMs;
    return Math.min(1, Math.max(0, elapsed / this.interpSpanMs));
  }

  private interpolatePositions(alpha: number): void {
    for (let i = 0; i < this.vehicleCount; i++) {
      const p = i * 2;
      const b = i * this.FLOATS_PER_VEHICLE;
      const prevX = this.prevPositions[p],     prevY = this.prevPositions[p + 1];
      const nextX = this.nextPositions[p],     nextY = this.nextPositions[p + 1];
      this.instanceData[b]     = prevX + (nextX - prevX) * alpha;
      this.instanceData[b + 1] = prevY + (nextY - prevY) * alpha;
    }
  }

  private initGL(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, VERT_SHADER, FRAG_SHADER);
    this.uMatrix     = gl.getUniformLocation(this.program, 'u_matrix')!;
    this.uViewport   = gl.getUniformLocation(this.program, 'u_viewport')!;
    this.uPixelRatio = gl.getUniformLocation(this.program, 'u_pixelRatio')!;
    this.uTime       = gl.getUniformLocation(this.program, 'u_time')!;
    this.uLodMode    = gl.getUniformLocation(this.program, 'u_lodMode')!;

    // FR : LE QUAD = un petit rectangle (4 sommets) qui sert de "tampon" pour chaque voiture.
    //      C'est le seul modèle qu'on définit. Le GPU le réutilisera 20 000 fois.
    const quad = new Float32Array([-1, -1,  1, -1,  1, 1,  -1, 1]);
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);     // STATIC = on ne le change jamais

    // FR : LE BUFFER D'INSTANCES = un grand tableau dans la VRAM du GPU.
    //      On y mettra les données des 20 000 voitures (position, couleur, taille, etc.)
    //      DYNAMIC_DRAW = on prévient le GPU qu'on changera ces données souvent.
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.MAX_VEHICLES * this.FLOATS_PER_VEHICLE * 4, gl.DYNAMIC_DRAW);

    // FR : VAO = Vertex Array Object — c'est une "recette" qui dit au GPU
    //      comment lire les buffers (quel attribut commence où dans la mémoire).
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // ── Attribut 0 : sommet du quad (partagé par toutes les instances) ──
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // Pas de vertexAttribDivisor → cet attribut change à chaque sommet (les 4 du quad)

    // ── Attributs PAR INSTANCE (changent à chaque voiture) ──
    // stride = 10 floats × 4 octets = 40 octets par voiture
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = this.FLOATS_PER_VEHICLE * 4;

    // Attribut 1 : position (mercatorX, mercatorY) — 2 floats
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    // ⭐ LA LIGNE MAGIQUE : vertexAttribDivisor(1, 1)
    //    "Avance dans le buffer UNE FOIS PAR INSTANCE, pas par sommet"
    //    → c'est CE truc qui rend l'instanced rendering possible.
    gl.vertexAttribDivisor(1, 1);

    // a_color (r, g, b)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 2 * 4);
    gl.vertexAttribDivisor(2, 1);

    // a_size
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 5 * 4);
    gl.vertexAttribDivisor(3, 1);

    // a_direction (sin, cos)
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 6 * 4);
    gl.vertexAttribDivisor(4, 1);

    // a_selected
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 8 * 4);
    gl.vertexAttribDivisor(5, 1);

    // a_typeCode
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 9 * 4);
    gl.vertexAttribDivisor(6, 1);

    gl.bindVertexArray(null);
  }

  /**
   * Fragment-level level of detail:
   * 0 = detailed silhouettes, 1 = compact directional markers.
   * Selected vehicles stay detailed in the shader so inspection remains clear.
   */
  /**
   * Choisit entre :
   *   0 = silhouettes type-aware détaillées (paintCar / paintBus / …)
   *   1 = marqueur directionnel compact (paintLodMarker)
   *
   * Le shader détaillé fait ~8-10 SDF par pixel — magnifique pour 1 véhicule
   * sélectionné ou une petite flotte au zoom rue, ruineux pour 15 K véhicules
   * à zoom ville. Seuils calibrés pour garder >50 FPS sur Mac M1 :
   *   - Toute flotte > 5 000  → toujours LOD (le shader détaillé est trop cher).
   *   - Zoom < 14.5           → toujours LOD (les véhicules sont sub-pixel anyway).
   *   - Zoom 14.5–15.5 + > 2 K → LOD.
   *   - Sinon (zoom rue + petite flotte) → silhouettes détaillées.
   * Les véhicules SÉLECTIONNÉS restent toujours en détail (cf. dispatch FS).
   */
  private lodMode(): number {
    const zoom = this.map?.getZoom() ?? 14;
    if (this.vehicleCount > 5000) return 1.0;
    if (zoom < 14.5) return 1.0;
    if (zoom < 15.5 && this.vehicleCount > 2000) return 1.0;
    return 0.0;
  }
}

// WGS84 → Mercator (0–1 space, matching MapLibre)
function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

function vehicleTypeCode(type: VehicleUpdate['type']): number {
  switch (type) {
    case 'BUS':        return 1;
    case 'TRUCK':      return 2;
    case 'MOTORCYCLE': return 3;
    case 'EMERGENCY':  return 4;
    case 'CAR':
    default:           return 0;
  }
}

// ─── Shaders ────────────────────────────────────────────────────────────────

const VERT_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_position;
layout(location = 2) in vec3 a_color;
layout(location = 3) in float a_size;
layout(location = 4) in vec2 a_direction;   // (sin, cos)
layout(location = 5) in float a_selected;
layout(location = 6) in float a_typeCode;

uniform mat4  u_matrix;
uniform vec2  u_viewport;    // (drawingBufferWidth, drawingBufferHeight) in px
uniform float u_pixelRatio;
uniform float u_time;

out vec3 v_color;
out vec2 v_uv;
out float v_selected;
out float v_typeCode;

void main() {
  // a_direction = (sin β, cos β) avec β = bearing (0 = nord, sens horaire).
  // Le fragment shader définit forwardY = -p.y, donc en pré-rotation
  // l'avant du véhicule est à (0, -1). On doit faire correspondre :
  //   (0, -1)  →  (sin β, cos β)   en NDC (où +Y = nord à l'écran)
  // Matrice de rotation : R = [[-cosβ, -sinβ], [sinβ, -cosβ]]
  float sinD = a_direction.x;
  float cosD = a_direction.y;
  vec2 rotated = vec2(
    -a_quad.x * cosD - a_quad.y * sinD,
     a_quad.x * sinD - a_quad.y * cosD
  );

  // Type-aware silhouette: constant screen size, but large enough for wheels/windows.
  float pulse = a_selected > 0.5 ? 1.0 + 0.18 * sin(u_time * 6.0) : 1.0;
  float pixelSize = 8.6 * a_size * u_pixelRatio * pulse;

  vec4 projected = u_matrix * vec4(a_position, 0.0, 1.0);

  // Correct screen-space offset independent of projected.w:
  // Multiply by projected.w so the perspective divide cancels out,
  // then convert pixels → NDC via viewport size.
  vec2 offset = rotated * pixelSize * 2.0 / u_viewport * projected.w;
  gl_Position = projected + vec4(offset, 0.0, 0.0);

  v_color    = a_color;
  v_uv       = a_quad;
  v_selected = a_selected;
  v_typeCode = a_typeCode;
}
`;

const FRAG_SHADER = `#version 300 es
precision mediump float;

in vec3 v_color;
in vec2 v_uv;
in float v_selected;
in float v_typeCode;

uniform float u_lodMode;

out vec4 fragColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float maskBox(vec2 p, vec2 b, float r) {
  return 1.0 - smoothstep(0.0, 0.045, sdRoundBox(p, b, r));
}

float maskCircle(vec2 p, float r) {
  return 1.0 - smoothstep(r, r + 0.045, length(p));
}

float pairBox(vec2 p, float x, float y, vec2 b, float r) {
  return max(maskBox(p - vec2( x, y), b, r),
             maskBox(p - vec2(-x, y), b, r));
}

float pairCircle(vec2 p, float x, float y, float r) {
  return max(maskCircle(p - vec2( x, y), r),
             maskCircle(p - vec2(-x, y), r));
}

vec3 blendPart(vec3 base, vec3 partColor, float partAlpha) {
  return mix(base, partColor, clamp(partAlpha, 0.0, 1.0));
}

vec4 paintCar(vec2 p, vec3 base, float emergency) {
  float body = maskBox(p, vec2(0.40, 0.78), 0.18);
  float hood = maskBox(p - vec2(0.0, -0.58), vec2(0.28, 0.18), 0.10);
  float trunk = maskBox(p - vec2(0.0, 0.62), vec2(0.30, 0.16), 0.10);
  float wheels = max(pairBox(p, 0.46, -0.36, vec2(0.07, 0.18), 0.03),
                     pairBox(p, 0.46,  0.38, vec2(0.07, 0.18), 0.03));
  float windshield = maskBox(p - vec2(0.0, -0.34), vec2(0.24, 0.12), 0.04);
  float rearWindow = maskBox(p - vec2(0.0,  0.30), vec2(0.23, 0.11), 0.04);
  float cabin = maskBox(p - vec2(0.0, -0.03), vec2(0.27, 0.27), 0.08);
  float headlights = pairCircle(p, 0.18, -0.78, 0.045);
  float taillights = pairCircle(p, 0.18,  0.77, 0.040);
  float stripe = emergency * maskBox(p - vec2(0.0, -0.05), vec2(0.08, 0.54), 0.03);
  float lightbar = emergency * maskBox(p - vec2(0.0, -0.18), vec2(0.28, 0.045), 0.025);

  float alpha = max(body, wheels);
  vec3 color = base;
  color = blendPart(color, vec3(0.025, 0.030, 0.040), wheels);
  color = blendPart(color, base + vec3(0.16), max(hood, trunk) * 0.45);
  color = blendPart(color, vec3(0.50, 0.78, 0.95), max(windshield, rearWindow) * 0.82);
  color = blendPart(color, vec3(0.32, 0.50, 0.64), cabin * 0.20);
  color = blendPart(color, vec3(1.0, 0.94, 0.62), headlights);
  color = blendPart(color, vec3(1.0, 0.06, 0.04), taillights);
  color = blendPart(color, vec3(1.0), stripe * 0.80);
  color = blendPart(color, vec3(0.10, 0.45, 1.0), lightbar * step(0.0, p.x));
  color = blendPart(color, vec3(1.0, 0.05, 0.05), lightbar * step(p.x, 0.0));
  return vec4(color, alpha);
}

vec4 paintBus(vec2 p, vec3 base) {
  float body = maskBox(p, vec2(0.46, 0.90), 0.14);
  float wheels = max(pairBox(p, 0.53, -0.56, vec2(0.075, 0.19), 0.03),
                     pairBox(p, 0.53,  0.56, vec2(0.075, 0.19), 0.03));
  float windshield = maskBox(p - vec2(0.0, -0.72), vec2(0.32, 0.10), 0.04);
  float sideWindows = maskBox(p - vec2(-0.14, -0.06), vec2(0.11, 0.52), 0.035)
                    + maskBox(p - vec2( 0.14, -0.06), vec2(0.11, 0.52), 0.035);
  float door = maskBox(p - vec2(0.32, -0.18), vec2(0.035, 0.32), 0.018);
  float headlights = pairCircle(p, 0.22, -0.86, 0.040);

  float alpha = max(body, wheels);
  vec3 color = base;
  color = blendPart(color, vec3(0.025, 0.030, 0.040), wheels);
  color = blendPart(color, vec3(0.55, 0.82, 0.94), max(windshield, clamp(sideWindows, 0.0, 1.0)) * 0.82);
  color = blendPart(color, vec3(0.05, 0.10, 0.12), door * 0.55);
  color = blendPart(color, vec3(1.0, 0.94, 0.62), headlights);
  return vec4(color, alpha);
}

vec4 paintTruck(vec2 p, vec3 base) {
  float cargo = maskBox(p - vec2(0.0, 0.28), vec2(0.44, 0.54), 0.07);
  float cab = maskBox(p - vec2(0.0, -0.58), vec2(0.34, 0.26), 0.09);
  float body = max(cargo, cab);
  float wheels = max(pairBox(p, 0.52, -0.55, vec2(0.08, 0.18), 0.03),
                     pairBox(p, 0.52,  0.50, vec2(0.08, 0.20), 0.03));
  float windshield = maskBox(p - vec2(0.0, -0.69), vec2(0.22, 0.08), 0.035);
  float cargoLine = maskBox(p - vec2(0.0, 0.28), vec2(0.02, 0.45), 0.01);
  float headlights = pairCircle(p, 0.19, -0.86, 0.040);

  float alpha = max(body, wheels);
  vec3 color = base;
  color = blendPart(color, base + vec3(0.12), cargo * 0.30);
  color = blendPart(color, base + vec3(0.22), cab * 0.45);
  color = blendPart(color, vec3(0.025, 0.030, 0.040), wheels);
  color = blendPart(color, vec3(0.50, 0.78, 0.95), windshield * 0.82);
  color = blendPart(color, vec3(0.08, 0.08, 0.08), cargoLine * 0.25);
  color = blendPart(color, vec3(1.0, 0.94, 0.62), headlights);
  return vec4(color, alpha);
}

vec4 paintMotorcycle(vec2 p, vec3 base) {
  float frame = maskBox(p, vec2(0.12, 0.50), 0.08);
  float rider = maskCircle(p - vec2(0.0, -0.05), 0.16);
  float frontWheel = maskCircle((p - vec2(0.0, -0.70)) * vec2(1.0, 0.78), 0.16);
  float rearWheel = maskCircle((p - vec2(0.0,  0.68)) * vec2(1.0, 0.78), 0.16);
  float handle = pairBox(p, 0.18, -0.50, vec2(0.055, 0.018), 0.012);
  float headlight = maskCircle(p - vec2(0.0, -0.88), 0.040);

  float wheels = max(frontWheel, rearWheel);
  float alpha = max(max(frame, rider), max(wheels, handle));
  vec3 color = base;
  color = blendPart(color, vec3(0.020, 0.022, 0.028), wheels);
  color = blendPart(color, base + vec3(0.22), rider * 0.72);
  color = blendPart(color, vec3(1.0, 0.94, 0.62), headlight);
  return vec4(color, alpha);
}

vec4 paintWreck(vec2 p, vec3 base) {
  float diamond = 1.0 - smoothstep(0.70, 0.78, abs(p.x) + abs(p.y));
  float crossA = maskBox(p, vec2(0.09, 0.64), 0.025);
  float crossB = maskBox(vec2(p.y, p.x), vec2(0.09, 0.64), 0.025);
  float cross = max(crossA, crossB);
  float alpha = max(diamond, cross);
  vec3 color = mix(base, vec3(1.0, 0.86, 0.12), cross * 0.9);
  return vec4(color, alpha);
}

vec4 paintLodMarker(vec2 p, vec3 base, float typeCode) {
  if (typeCode > 4.5) return paintWreck(p, base);

  float width = typeCode < 1.5 ? 0.34
              : typeCode < 2.5 ? 0.40
              : typeCode < 3.5 ? 0.18
              : 0.36;
  float len = typeCode < 1.5 ? 0.70
            : typeCode < 2.5 ? 0.80
            : typeCode < 3.5 ? 0.62
            : 0.72;
  float radius = typeCode < 3.5 ? 0.16 : 0.18;

  float body = maskBox(p, vec2(width, len), radius);
  float nose = maskCircle(p - vec2(0.0, -len * 0.90), typeCode < 3.5 ? 0.050 : 0.060);
  float tail = maskBox(p - vec2(0.0, len * 0.88), vec2(width * 0.42, 0.035), 0.018);
  float emergencyBar = step(3.5, typeCode) * step(typeCode, 4.5)
                     * maskBox(p - vec2(0.0, -0.16), vec2(0.25, 0.040), 0.020);

  float alpha = body;
  vec3 color = base;
  color = blendPart(color, base + vec3(0.12), body * 0.35);
  color = blendPart(color, vec3(1.0, 0.94, 0.62), nose);
  color = blendPart(color, vec3(0.04, 0.04, 0.05), tail * 0.45);
  color = blendPart(color, vec3(0.10, 0.45, 1.0), emergencyBar * step(0.0, p.x));
  color = blendPart(color, vec3(1.0, 0.05, 0.05), emergencyBar * step(p.x, 0.0));
  return vec4(color, alpha);
}

void main() {
  vec2 p = v_uv;
  float typeCode = floor(v_typeCode + 0.5);
  vec4 vehicle = vec4(0.0);
  if (u_lodMode > 0.5 && v_selected < 0.5) {
    vehicle = paintLodMarker(p, v_color, typeCode);
  } else if (typeCode < 0.5) {
    vehicle = paintCar(p, v_color, 0.0);
  } else if (typeCode < 1.5) {
    vehicle = paintBus(p, v_color);
  } else if (typeCode < 2.5) {
    vehicle = paintTruck(p, v_color);
  } else if (typeCode < 3.5) {
    vehicle = paintMotorcycle(p, v_color);
  } else if (typeCode < 4.5) {
    vehicle = paintCar(p, v_color, 1.0);
  } else {
    vehicle = paintWreck(p, v_color);
  }

  // Halo anneau quand sélectionné
  float selectedHalo = 0.0;
  if (v_selected > 0.5) {
    float hd = length(p * vec2(0.82, 0.62));
    selectedHalo = smoothstep(0.85, 0.94, hd) * (1.0 - smoothstep(0.94, 1.18, hd));
  }

  if (vehicle.a < 0.02 && selectedHalo < 0.02) discard;

  vec3 color = vehicle.rgb;
  float alpha = vehicle.a * 0.96;

  if (v_selected > 0.5) {
    color = mix(color, vec3(1.0), selectedHalo * 0.82);
    alpha = max(alpha, selectedHalo * 0.88);
  }

  fragColor = vec4(color, alpha);
}
`;

// ─── Shader helpers ──────────────────────────────────────────────────────────

function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Shader link: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(`Shader compile: ${gl.getShaderInfoLog(s)}`);
  return s;
}
