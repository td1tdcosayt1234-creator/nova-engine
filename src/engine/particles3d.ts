/* ============ Nova Engine — 3D Particles (three.js Points pool) ============ */

/* main.ts wiring:
 *   import { Particles3D } from './engine/particles3d'
 *   const fx3d = new Particles3D()
 *   fx3d.attach(r3d.scene)                    // r3d = your Renderer3D
 *   fx3d.emitAt(hit.position, { count: 40, color: '#fbbf24', speed: 7 })
 *   // per frame: fx3d.update(dt)
 *   // on scene switch: fx3d.attach(newScene); on teardown: fx3d.dispose()
 */

import * as THREE from 'three'

export type Vec3Like = { x: number; y: number; z: number }

export type EmitOpts = {
  count?: number
  color?: string | number
  /** speed jitter factor; 0 = uniform burst, 1 = ±50% jitter, 2 = ±100% */
  spread?: number
  speed?: number
  size?: number
  life?: number
  gravity?: number
  /** switches the shared material blend mode (system-wide, not per burst) */
  additive?: boolean
}

const MAX_PARTICLES = 4000
const MAX_EMIT = 2000 // safety cap per emitAt call
const DRAG = 0.995    // per-frame velocity damping

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (280.0 / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float a = smoothstep(0.5, 0.12, length(d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}
`

export class Particles3D {
  private scene: THREE.Scene | null = null
  private points: THREE.Points | null = null
  private geo: THREE.BufferGeometry | null = null
  private mat: THREE.ShaderMaterial | null = null

  // pooled particle state (length MAX_PARTICLES)
  private aPos: Float32Array = new Float32Array(0)
  private aVel: Float32Array = new Float32Array(0)
  private aCol: Float32Array = new Float32Array(0)
  private aSize: Float32Array = new Float32Array(0)
  private aBase: Float32Array = new Float32Array(0)
  private aAlpha: Float32Array = new Float32Array(0)
  private aLife: Float32Array = new Float32Array(0)
  private aInv: Float32Array = new Float32Array(0)
  private aGrav: Float32Array = new Float32Array(0)

  private head = 0        // ring-buffer cursor (oldest particle gets reused)
  private used = 0        // highest slot ever touched (drawRange)
  private active = 0      // particles with life > 0

  /**
   * Attach to (or re-attach to) a scene. Removing from the old scene is handled
   * automatically, so it is safe to call when switching scenes. All emits before
   * any attach are intentionally discarded no-ops.
   */
  attach(scene: THREE.Scene) {
    if (this.scene === scene) return
    if (this.scene && this.points && this.points.parent === this.scene) {
      this.scene.remove(this.points)
    }
    this.scene = scene
    this.ensureBuilt()
    if (this.points) scene.add(this.points)
  }

  update(dt: number) {
    const pts = this.points
    if (!pts || !this.geo || this.active === 0) return
    const step = Math.min(0.1, Math.max(0, dt))
    const n = this.used
    const dr = Math.pow(DRAG, step * 60)
    for (let i = 0; i < n; i++) {
      if (this.aLife[i] <= 0) continue
      this.aLife[i] -= step
      if (this.aLife[i] <= 0) {
        this.aAlpha[i] = 0
        this.active--
        continue
      }
      const i3 = i * 3
      this.aVel[i3] *= dr
      this.aVel[i3 + 1] *= dr
      this.aVel[i3 + 2] *= dr
      this.aVel[i3 + 1] += this.aGrav[i] * step
      this.aPos[i3] += this.aVel[i3] * step
      this.aPos[i3 + 1] += this.aVel[i3 + 1] * step
      this.aPos[i3 + 2] += this.aVel[i3 + 2] * step
      const k = this.aLife[i] * this.aInv[i] // 1 → 0 over lifetime
      this.aAlpha[i] = k
      this.aSize[i] = this.aBase[i] * (0.3 + 0.7 * k)
    }
    const pa = this.geo.attributes
    if (pa.position) pa.position.needsUpdate = true
    if (pa.aSize) pa.aSize.needsUpdate = true
    if (pa.aAlpha) pa.aAlpha.needsUpdate = true
    if (pa.aColor) pa.aColor.needsUpdate = true
    if (this.geo.drawRange.count !== n) this.geo.setDrawRange(0, n)
    if (this.active === 0) pts.visible = false
  }

  /** Spawn a burst at a world position. Safe no-op until attach() is called. */
  emitAt(pos: Vec3Like, opts: EmitOpts = {}) {
    if (!this.points || !this.geo) return
    const raw = Math.round(opts.count ?? 24) || 24
    const count = Math.min(Math.max(1, raw), MAX_EMIT)
    const speed = opts.speed ?? 6
    const spread = Math.max(0, opts.spread ?? 2)
    const life = Math.max(0.05, opts.life ?? 0.8)
    const baseSize = Math.max(0.01, opts.size ?? 0.25)
    const grav = opts.gravity ?? -9
    const c = new THREE.Color(opts.color ?? '#fbbf24')
    if (opts.additive != null && this.mat) {
      this.mat.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending
      this.mat.needsUpdate = true
    }
    for (let n = 0; n < count; n++) {
      const i = this.head
      this.head = (this.head + 1) % MAX_PARTICLES
      if (this.used < MAX_PARTICLES) this.used++
      if (this.aLife[i] > 0) this.active-- // reusing a still-alive slot: it leaves the pool
      const i3 = i * 3
      // random direction on the unit sphere
      const u = Math.random() * 2 - 1
      const ang = Math.random() * Math.PI * 2
      const rr = Math.sqrt(Math.max(0, 1 - u * u))
      const vi = speed * (1 + (Math.random() * 2 - 1) * 0.5 * spread)
      const shade = 0.72 + Math.random() * 0.28 // per-particle brightness variation
      this.aPos[i3] = pos.x + (Math.random() - 0.5) * 0.08
      this.aPos[i3 + 1] = pos.y + (Math.random() - 0.5) * 0.08
      this.aPos[i3 + 2] = pos.z + (Math.random() - 0.5) * 0.08
      this.aVel[i3] = rr * Math.cos(ang) * vi
      this.aVel[i3 + 1] = u * vi
      this.aVel[i3 + 2] = rr * Math.sin(ang) * vi
      this.aCol[i3] = c.r * shade
      this.aCol[i3 + 1] = c.g * shade
      this.aCol[i3 + 2] = c.b * shade
      this.aBase[i] = baseSize
      this.aSize[i] = baseSize
      this.aGrav[i] = grav
      this.aLife[i] = life * (0.75 + Math.random() * 0.5)
      this.aInv[i] = 1 / this.aLife[i]
      this.aAlpha[i] = 1
      this.active++
    }
    const pa = this.geo.attributes
    if (pa.position) pa.position.needsUpdate = true
    if (pa.aColor) pa.aColor.needsUpdate = true
    if (pa.aSize) pa.aSize.needsUpdate = true
    if (pa.aAlpha) pa.aAlpha.needsUpdate = true
    this.geo.setDrawRange(0, this.used)
    if (this.points) this.points.visible = true
  }

  /** Kill every particle without releasing GPU buffers. */
  clear() {
    if (!this.geo) return
    this.aLife.fill(0)
    this.aAlpha.fill(0)
    this.active = 0
    if (this.points) this.points.visible = false
  }

  /** Remove from scene and release GPU resources. Safe to call twice. */
  dispose() {
    if (this.scene && this.points) {
      try { this.scene.remove(this.points) } catch { /* ignore */ }
    }
    try { this.geo?.dispose() } catch { /* ignore */ }
    try { this.mat?.dispose() } catch { /* ignore */ }
    this.scene = null
    this.points = null
    this.geo = null
    this.mat = null
    this.head = 0
    this.used = 0
    this.active = 0
  }

  get particleCount(): number { return this.active }
  get isAttached(): boolean { return !!this.scene }

  private ensureBuilt() {
    if (this.points) return
    try {
      const geo = new THREE.BufferGeometry()
      const cap = (n: number) => new Float32Array(n)
      this.aPos = cap(MAX_PARTICLES * 3)
      this.aVel = cap(MAX_PARTICLES * 3)
      this.aCol = cap(MAX_PARTICLES * 3)
      this.aSize = cap(MAX_PARTICLES)
      this.aBase = cap(MAX_PARTICLES)
      this.aAlpha = cap(MAX_PARTICLES)
      this.aLife = cap(MAX_PARTICLES)
      this.aInv = cap(MAX_PARTICLES)
      this.aGrav = cap(MAX_PARTICLES)
      geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3))
      geo.setAttribute('aColor', new THREE.BufferAttribute(this.aCol, 3))
      geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1))
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1))
      geo.setDrawRange(0, 0)
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
      const pts = new THREE.Points(geo, mat)
      pts.frustumCulled = false
      pts.visible = false
      this.geo = geo
      this.mat = mat
      this.points = pts
    } catch {
      // WebGL/GLSL failure — leave the system neutralized
      this.points = null
      this.geo = null
      this.mat = null
    }
  }
}
