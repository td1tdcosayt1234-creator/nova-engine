/* ============ Nova Engine — 3D physics (Rapier — Rust rigid-body engine, WASM) ============
   Real rigid bodies: box / sphere / capsule / cuboid colliders straight from mesh3d
   geometry, friction, restitution, dynamic–dynamic collisions, contact events,
   kinematic & sensor colliders, damping, CCD, raycasts and ground checks.
   Units are plain meters (like the renderer).

   While playing, the physics world is the source of truth after each step.
   Scripts express intent through rigid3d.vx/vy/vz, transform.pos (teleport) and
   transform.rot (spin) — intents are pushed into the world each frame, then the
   world's resolved state is synced back.

   Collision dispatch:
     sink(a, b)                       — legacy: fires every frame while touching
     on('enter'|'exit'|'stay', cb)    — precise edges: 'enter' on contact start,
                                        'exit' on contact end, 'stay' while touching */

import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { getComp, clamp, type Entity, type Scene, type Vec3 } from './core'

/** load the WASM module once — await this before constructing Physics3D */
export const rapierReady = RAPIER.init()

const FIXED_DT = 1 / 60
const MAX_SUBSTEPS = 3
const DEG = Math.PI / 180

export type CollideSink = (a: Entity, b: Entity) => void
export type PhysEvent = 'enter' | 'exit' | 'stay'
export type PhysListener = (a: Entity, b: Entity) => void
export type RayOpts = { skip?: Entity; sensors?: boolean }
export type RayHit3D = { entity: Entity; point: Vec3; normal: Vec3; distance: number }

/** conservative sphere-ish radius (used by the editor gizmos/renderers) */
export function radiusOf(e: Entity): number {
  const r = getComp(e, 'rigid3d') as any
  if (r && r.radius) return r.radius
  const m = getComp(e, 'mesh3d') as any
  const s = e.transform.scale
  if (!m) return 0.5
  if (m.geo === 'plane') return 0
  if (m.geo === 'sphere') return 0.5 * Math.max(s.x, s.y, s.z)
  if (m.geo === 'capsule') return 0.5 * Math.max(s.x, s.z)
  const hx = 0.5 * s.x, hy = 0.5 * s.y, hz = 0.5 * s.z
  return 0.7 * Math.sqrt(hx * hx + hy * hy + hz * hz)
}

/** approximation of the collider's lower half-height (for ground rays) */
export function halfHeightOf(e: Entity): number {
  const r = getComp(e, 'rigid3d') as any
  const m = getComp(e, 'mesh3d') as any
  const geo = m?.geo || 'box'
  const s = e.transform.scale
  if (r && Number(r.radius) > 0 && geo !== 'box' && geo !== 'plane') return Number(r.radius)
  if (geo === 'plane') return 0.5
  if (geo === 'sphere' || geo === 'torus' || geo === 'torusKnot') return 0.5 * Math.max(s.x, s.y, s.z)
  if (geo === 'capsule') return 0.275 * s.y + 0.35 * Math.max(s.x, s.z)
  return 0.5 * s.y
}

/* three.js views rot as XYZ-intrinsic degrees — keep physics & render in the same space */
const _e = new THREE.Euler()
const _q = new THREE.Quaternion()

function eulerDegToQuat(rot: Vec3): { x: number; y: number; z: number; w: number } {
  _e.set(
    (Number(rot.x) || 0) * DEG,
    (Number(rot.y) || 0) * DEG,
    (Number(rot.z) || 0) * DEG,
    'XYZ'
  )
  _q.setFromEuler(_e)
  return { x: _q.x, y: _q.y, z: _q.z, w: _q.w }
}

function quatToEulerDeg(q: { x: number; y: number; z: number; w: number }, out: Vec3) {
  _q.set(q.x, q.y, q.z, q.w)
  _e.setFromQuaternion(_q, 'XYZ')
  out.x = _e.x / DEG
  out.y = _e.y / DEG
  out.z = _e.z / DEG
}

/** NaN guard: fall back to a default for non-finite numbers (scripts love NaN) */
function fin(x: any, d = 0): number {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}

function pairKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a
}

export class Physics3D {
  world = new RAPIER.World(new RAPIER.Vector3(0, 0, 0))
  private events = new RAPIER.EventQueue(true)
  private scene: Scene
  private sink: CollideSink
  private bodies = new Map<string, RAPIER.RigidBody>()
  private entBody = new WeakMap<Entity, RAPIER.RigidBody>()
  private byId = new Map<string, Entity>()
  private staticBody = new Map<string, boolean>()
  private colliderEnt = new Map<number, string>()
  private lastVel = new Map<string, [number, number, number]>()
  private lastRot = new Map<string, Vec3>()
  private activePairs = new Set<string>()
  private prevPairs = new Set<string>()
  private listeners = new Map<string, Set<PhysListener>>()
  private warned = new Set<string>()
  private acc = 0
  private stepping = false
  private disposed = false

  constructor(scene: Scene, sink: CollideSink) {
    this.scene = scene
    this.sink = sink
    this.world.gravity = new RAPIER.Vector3(0, -(Number(scene.meta.gravity3d) || 0), 0)
    for (const e of [...scene.entities]) this.add(e)
  }

  /* ---------- events ---------- */

  /** subscribe to collision events; returns an unsubscribe function (backwards compatible) */
  on(ev: PhysEvent, cb: PhysListener): () => void {
    let set = this.listeners.get(ev)
    if (!set) { set = new Set(); this.listeners.set(ev, set) }
    set.add(cb)
    return () => set!.delete(cb)
  }

  off(ev: PhysEvent, cb: PhysListener) {
    this.listeners.get(ev)?.delete(cb)
  }

  private emit(ev: PhysEvent, a: Entity, b: Entity) {
    const set = this.listeners.get(ev)
    if (!set || !set.size) return
    for (const cb of [...set]) {
      try { cb(a, b) } catch (err) { console.error('[phys3:' + ev + ']', err) }
    }
  }

  /* ---------- entity → body resolution (WeakMap-backed) ---------- */

  bodyOf(e: Entity): RAPIER.RigidBody | null {
    const cached = this.entBody.get(e)
    if (cached && cached.isValid()) return cached
    const found = this.bodies.get(e.id) || null
    if (found) this.entBody.set(e, found)
    return found
  }

  private entOfCollider(c: RAPIER.Collider): Entity | null {
    const id = this.colliderEnt.get(c.handle)
    return id ? (this.byId.get(id) || null) : null
  }

  /* ---------- collider / body build ---------- */

  /* collider straight off the mesh geometry (plane → big static slab) */
  private colliderFor(e: Entity): RAPIER.ColliderDesc {
    const r = getComp(e, 'rigid3d') as any
    const m = getComp(e, 'mesh3d') as any
    const geo = m?.geo || 'box'
    const s = e.transform.scale
    let desc: RAPIER.ColliderDesc
    if (geo === 'plane') {
      desc = RAPIER.ColliderDesc.cuboid(160, 0.5, 160)
      desc.setTranslation(0, -0.5, 0)   // top surface exactly at entity y
    } else if (r && Number(r.radius) > 0 && geo !== 'box') {
      desc = RAPIER.ColliderDesc.ball(Number(r.radius))     // legacy radius field (old scenes)
    } else if (geo === 'sphere' || geo === 'torus' || geo === 'torusKnot') {
      desc = RAPIER.ColliderDesc.ball(0.5 * Math.max(s.x, s.y, s.z))
    } else if (geo === 'capsule') {
      desc = RAPIER.ColliderDesc.capsule(
        Math.max(0.02, 0.275 * fin(s.y, 1)),
        Math.max(0.02, 0.35 * Math.max(fin(s.x, 1), fin(s.z, 1)))
      )
    } else {
      desc = RAPIER.ColliderDesc.cuboid(
        Math.max(0.01, 0.5 * fin(s.x, 1)),
        Math.max(0.01, 0.5 * fin(s.y, 1)),
        Math.max(0.01, 0.5 * fin(s.z, 1))
      )
    }
    desc.setFriction(clamp(fin(r?.friction, 0.6), 0, 1.5))
    desc.setRestitution(clamp(fin(r?.bounce), 0, 1))
    desc.setDensity(1)
    if (r?.sensor) desc.setSensor(true)
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    return desc
  }

  add(e: Entity) {
    if (this.disposed || this.stepping) return
    const r = getComp(e, 'rigid3d') as any
    if (!r || !e.visible || this.bodies.has(e.id)) return
    const m = getComp(e, 'mesh3d') as any
    const geo = m?.geo || 'box'
    const isStatic = !!r.isStatic || geo === 'plane'
    const isKinematic = !!r.kinematic && !isStatic
    const t = e.transform
    const desc = isStatic
      ? RAPIER.RigidBodyDesc.fixed()
      : isKinematic
        ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
        : RAPIER.RigidBodyDesc.dynamic()
    desc.setTranslation(fin(t.pos.x), fin(t.pos.y), fin(t.pos.z))
    const q = eulerDegToQuat(t.rot)
    desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    const speed = Math.hypot(fin(r.vx), fin(r.vy), fin(r.vz))
    // CCD for fast movers unless explicitly opted out; damping fields supported too
    desc.setCcdEnabled(r.ccd == null ? speed > 30 : !!r.ccd)
    const damp = fin(r.linDamp)
    if (damp > 0) desc.setLinearDamping(Math.min(25, damp))
    const adamp = fin(r.angDamp)
    if (adamp > 0) desc.setAngularDamping(Math.min(25, adamp))
    const body = this.world.createRigidBody(desc)
    if (!isStatic) {
      body.setGravityScale(clamp(fin(r.gravityScale, 1), -5, 10), true)
      if (r.lockRot) body.lockRotations(true, true)
    }
    const collider = this.world.createCollider(this.colliderFor(e), body)
    this.colliderEnt.set(collider.handle, e.id)
    this.bodies.set(e.id, body)
    this.entBody.set(e, body)
    this.byId.set(e.id, e)
    this.staticBody.set(e.id, isStatic)
    this.lastVel.set(e.id, [fin(r.vx), fin(r.vy), fin(r.vz)])
    this.lastRot.set(e.id, { x: fin(t.rot.x), y: fin(t.rot.y), z: fin(t.rot.z) })
    if (r.enabled === false) body.setEnabled(false)
  }

  remove(id: string) {
    if (this.disposed || this.stepping) return
    const body = this.bodies.get(id)
    if (!body) return
    for (const [h, eid] of [...this.colliderEnt]) if (eid === id) this.colliderEnt.delete(h)
    this.bodies.delete(id)
    this.byId.delete(id)
    this.staticBody.delete(id)
    this.lastVel.delete(id)
    this.lastRot.delete(id)
    for (const k of [...this.activePairs]) {
      const i = k.indexOf('|')
      if (k.slice(0, i) === id || k.slice(i + 1) === id) this.activePairs.delete(k)
    }
    for (const k of [...this.prevPairs]) {
      const i = k.indexOf('|')
      if (k.slice(0, i) === id || k.slice(i + 1) === id) this.prevPairs.delete(k)
    }
    this.world.removeRigidBody(body)
  }

  /** catch entities spawned mid-play without a body (or that lost rigid3d / got hidden) */
  private sweep() {
    for (const e of [...this.scene.entities]) {
      const r = getComp(e, 'rigid3d') as any
      const body = this.bodies.get(e.id)
      if (!r) { if (body) this.remove(e.id); continue }
      if (!e.visible) { if (body) body.setEnabled(false); continue }
      if (!body) { this.add(e); continue }
      if (r.enabled === false) body.setEnabled(false)
      else if (!body.isEnabled()) body.setEnabled(true)
      // auto-CCD follows body speed (only for bodies without an explicit r.ccd flag)
      if (!this.staticBody.get(e.id) && r.ccd == null && !r.kinematic) {
        const lv = body.linvel()
        const fast = Math.hypot(lv.x, lv.y, lv.z) > 30
        if (fast !== body.isCcdEnabled()) body.enableCcd(fast)
      }
    }
  }

  /* ---------- stepping ---------- */

  /** advance the world (fixed timestep accumulator, max 3 × 1/60s per frame) */
  step(dt: number) {
    if (this.disposed) return
    this.acc += clamp(fin(dt, 0.016), 0, 0.1)
    this.sweep()
    this.pushIntents()
    let steps = 0
    this.stepping = true
    while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.world.timestep = FIXED_DT
      this.world.step(this.events)
      this.acc -= FIXED_DT
      steps++
    }
    this.stepping = false
    if (steps === MAX_SUBSTEPS) this.acc = 0
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderEnt.get(h1)
      const b = this.colliderEnt.get(h2)
      if (!a || !b) return
      if (started) this.activePairs.add(pairKey(a, b))
      else this.activePairs.delete(pairKey(a, b))
    })
    this.syncFromWorld()
    this.flushPairs()
  }

  /** scripts → world */
  private pushIntents() {
    for (const [id, body] of this.bodies) {
      const e = this.byId.get(id)
      const r = e ? (getComp(e, 'rigid3d') as any) : null
      if (!e || !r) continue
      const t = e.transform
      if (this.staticBody.get(id)) {
        // statics (incl. ground planes) mirror script-driven motion exactly
        body.setTranslation(new RAPIER.Vector3(fin(t.pos.x), fin(t.pos.y), fin(t.pos.z)), true)
        const q = eulerDegToQuat(t.rot)
        body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
        continue
      }
      const lv = body.linvel()
      const want = [fin(r.vx), fin(r.vy), fin(r.vz)]
      if (Math.abs(want[0] - lv.x) > 1e-6 || Math.abs(want[1] - lv.y) > 1e-6 || Math.abs(want[2] - lv.z) > 1e-6) {
        body.setLinvel(new RAPIER.Vector3(want[0], want[1], want[2]), true)
      }
      const last = this.lastRot.get(id) || { x: 0, y: 0, z: 0 }
      if (Math.abs(fin(t.rot.x) - last.x) > 1e-4 || Math.abs(fin(t.rot.y) - last.y) > 1e-4 || Math.abs(fin(t.rot.z) - last.z) > 1e-4) {
        const q = eulerDegToQuat(t.rot)
        body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
      }
      const tr = body.translation()
      if (Math.abs(fin(t.pos.x) - tr.x) > 1e-4 || Math.abs(fin(t.pos.y) - tr.y) > 1e-4 || Math.abs(fin(t.pos.z) - tr.z) > 1e-4) {
        body.setTranslation(new RAPIER.Vector3(fin(t.pos.x), fin(t.pos.y), fin(t.pos.z)), true)
      }
    }
  }

  /** world → transforms/components + ground flags (physics drives the transform) */
  private syncFromWorld() {
    for (const [id, body] of this.bodies) {
      const e = this.byId.get(id)
      const r = e ? (getComp(e, 'rigid3d') as any) : null
      if (!e || !r) continue
      if (this.staticBody.get(id)) continue   // statics keep script-driven transforms
      const tr = body.translation()
      const t = e.transform.pos
      if (!Number.isFinite(tr.x) || !Number.isFinite(tr.y) || !Number.isFinite(tr.z)) {
        this.warn(id, 'corrupt physics position — reset body')
        body.setTranslation(new RAPIER.Vector3(0, 2, 0), true)
        body.setLinvel(new RAPIER.Vector3(0, 0, 0), true)
        continue
      }
      t.x = tr.x; t.y = tr.y; t.z = tr.z
      const q = body.rotation()
      if (Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)) {
        quatToEulerDeg(q, e.transform.rot)
      }
      const lr = this.lastRot.get(id)
      if (lr) { lr.x = e.transform.rot.x; lr.y = e.transform.rot.y; lr.z = e.transform.rot.z }
      else this.lastRot.set(id, { ...e.transform.rot })
      const lv = body.linvel()
      r.vx = Number.isFinite(lv.x) ? lv.x : 0
      r.vy = Number.isFinite(lv.y) ? lv.y : 0
      r.vz = Number.isFinite(lv.z) ? lv.z : 0
      this.lastVel.set(id, [r.vx, r.vy, r.vz])
      r.onGround = this.groundBelow(body, e)
    }
  }

  /** raycast straight down, excluding this body's own colliders */
  private groundBelow(body: RAPIER.RigidBody, e: Entity): boolean {
    const half = halfHeightOf(e)
    const p = body.translation()
    const ray = new RAPIER.Ray(
      { x: fin(p.x), y: fin(p.y) + 0.2, z: fin(p.z) },
      { x: 0, y: -1, z: 0 }
    )
    const hit = this.world.castRay(ray, 0.2 + half + 0.25, true, undefined, undefined, undefined, body)
    if (!hit) return false
    return !hit.collider.isSensor() && hit.timeOfImpact <= half + 0.22
  }

  /** dispatch contact pairs: legacy sink every frame + precise edge events */
  private flushPairs() {
    for (const key of this.activePairs) {
      const pair = this.pairEnts(key)
      if (pair) this.sink(pair[0], pair[1])
    }
    if (this.activePairs.size || this.prevPairs.size) {
      for (const key of this.activePairs) {
        if (this.prevPairs.has(key)) continue
        const pair = this.pairEnts(key)
        if (pair) this.emit('enter', pair[0], pair[1])
      }
      for (const key of this.activePairs) {
        if (!this.prevPairs.has(key)) continue
        const pair = this.pairEnts(key)
        if (pair) this.emit('stay', pair[0], pair[1])
      }
      for (const key of this.prevPairs) {
        if (this.activePairs.has(key)) continue
        const pair = this.pairEnts(key)
        if (pair) this.emit('exit', pair[0], pair[1])
      }
      this.prevPairs = new Set([...this.activePairs])
    }
  }

  private pairEnts(key: string): [Entity, Entity] | null {
    const i = key.indexOf('|')
    const ea = this.byId.get(key.slice(0, i))
    const eb = this.byId.get(key.slice(i + 1))
    return ea && eb ? [ea, eb] : null
  }

  /* ---------- gameplay helpers (all resolve entity → body reliably) ---------- */

  /** set linear velocity in m/s (writes through rigid3d so scripts stay consistent) */
  setLinearVelocity(e: Entity, x: number, y: number, z = 0) {
    const body = this.bodyOf(e)
    const r = getComp(e, 'rigid3d') as any
    if (!body || !r || this.staticBody.get(e.id) || this.stepping || this.disposed) return
    r.vx = fin(x); r.vy = fin(y); r.vz = fin(z)
    body.setLinvel(new RAPIER.Vector3(fin(x), fin(y), fin(z)), true)
  }

  getLinearVelocity(e: Entity): { x: number; y: number; z: number } {
    const body = this.bodyOf(e)
    if (!body || this.staticBody.get(e.id)) {
      const r = getComp(e, 'rigid3d') as any
      return { x: fin(r?.vx), y: fin(r?.vy), z: fin(r?.vz) }
    }
    const lv = body.linvel()
    return { x: lv.x, y: lv.y, z: lv.z }
  }

  setAngularVelocity(e: Entity, x: number, y: number, z = 0) {
    const body = this.bodyOf(e)
    if (!body || this.staticBody.get(e.id) || this.stepping || this.disposed) return
    body.setAngvel(new RAPIER.Vector3(fin(x), fin(y), fin(z)), true)
  }

  getAngularVelocity(e: Entity): { x: number; y: number; z: number } {
    const body = this.bodyOf(e)
    if (!body || this.staticBody.get(e.id)) return { x: 0, y: 0, z: 0 }
    const av = body.angvel()
    return { x: av.x, y: av.y, z: av.z }
  }

  /** impulse in N·s, force in N, torque impulse in N·m·s (Rapier units) */
  applyImpulse(e: Entity, x: number, y: number, z = 0) {
    const body = this.bodyOf(e)
    if (!body || this.staticBody.get(e.id) || this.stepping || this.disposed) return
    body.applyImpulse(new RAPIER.Vector3(fin(x), fin(y), fin(z)), true)
  }

  applyForce(e: Entity, x: number, y: number, z = 0) {
    const body = this.bodyOf(e)
    if (!body || this.staticBody.get(e.id) || this.stepping || this.disposed) return
    body.addForce(new RAPIER.Vector3(fin(x), fin(y), fin(z)), true)
  }

  applyTorque(e: Entity, x: number, y: number, z = 0) {
    const body = this.bodyOf(e)
    if (!body || this.staticBody.get(e.id) || this.stepping || this.disposed) return
    body.applyTorqueImpulse(new RAPIER.Vector3(fin(x), fin(y), fin(z)), true)
  }

  setEnabled(e: Entity, on: boolean) {
    const body = this.bodyOf(e)
    if (!body || this.disposed) return
    body.setEnabled(!!on)
    if (!!on) body.wakeUp()
    const r = getComp(e, 'rigid3d') as any
    if (r) r.enabled = !!on
  }

  setGravityScale(e: Entity, s: number) {
    const body = this.bodyOf(e)
    const r = getComp(e, 'rigid3d') as any
    if (!body || !r || this.stepping || this.disposed) return
    body.setGravityScale(clamp(fin(s, 1), -5, 10), true)
    r.gravityScale = clamp(fin(s, 1), -5, 10)
  }

  /** toggle velocity-driven kinematic type (immune to forces; moved by vel/teleport) */
  setKinematic(e: Entity, on: boolean) {
    const body = this.bodyOf(e)
    const r = getComp(e, 'rigid3d') as any
    if (!body || !r || this.staticBody.get(e.id) || this.stepping || this.disposed) return
    r.kinematic = !!on
    if (body.isKinematic() === !!on) return
    body.setBodyType(on ? RAPIER.RigidBodyType.KinematicVelocityBased : RAPIER.RigidBodyType.Dynamic, true)
  }

  /** instant reposition in meters (optionally also rotate, degrees) */
  teleport(e: Entity, x: number, y: number, z?: number, rot?: Partial<Vec3>) {
    const body = this.bodyOf(e)
    if (!body || this.stepping || this.disposed) { return }
    const t = e.transform
    t.pos.x = fin(x)
    t.pos.y = fin(y)
    if (z != null) t.pos.z = fin(z)
    let q: { x: number; y: number; z: number; w: number } | null = null
    if (rot && (rot.x != null || rot.y != null || rot.z != null)) {
      const nx = rot.x != null ? fin(rot.x) : t.rot.x
      const ny = rot.y != null ? fin(rot.y) : t.rot.y
      const nz = rot.z != null ? fin(rot.z) : t.rot.z
      q = eulerDegToQuat({ x: nx, y: ny, z: nz })
      t.rot.x = nx; t.rot.y = ny; t.rot.z = nz
    }
    const tp = t.pos
    body.setTranslation(new RAPIER.Vector3(fin(tp.x), fin(tp.y), fin(tp.z)), true)
    if (q) body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
    const lr = this.lastRot.get(e.id)
    if (lr) { lr.x = t.rot.x; lr.y = t.rot.y; lr.z = t.rot.z }
  }

  /** public ground check for scripts (same ray as the per-frame onGround flag) */
  isGrounded(e: Entity): boolean {
    const body = this.bodyOf(e)
    if (!body) {
      const r = getComp(e, 'rigid3d') as any
      return !!r?.onGround
    }
    return this.groundBelow(body, e)
  }

  /* ---------- raycast ---------- */

  /** world raycast: origin/dir in meters, dir needn't be normalized; skips sensors unless asked */
  raycast3d(origin: Vec3, dir: Vec3, maxDist = 200, opts: RayOpts = {}): RayHit3D | null {
    if (this.disposed) return null
    const dx0 = fin(dir.x), dy0 = fin(dir.y), dz0 = fin(dir.z)
    const len = Math.hypot(dx0, dy0, dz0)
    if (len < 1e-9) return null
    const far = Math.max(1e-4, fin(maxDist, 200))
    const dx = dx0 / len, dy = dy0 / len, dz = dz0 / len
    const ray = new RAPIER.Ray(
      { x: fin(origin.x), y: fin(origin.y), z: fin(origin.z) },
      { x: dx, y: dy, z: dz }
    )
    const skipBody = opts.skip ? (this.bodyOf(opts.skip) || undefined) : undefined
    let pred: ((c: RAPIER.Collider) => boolean) | undefined
    if (!opts.sensors) {
      pred = c => !c.isSensor()
    }
    const hit = this.world.castRayAndGetNormal(ray, far, true, undefined, undefined, undefined, skipBody, pred)
    if (!hit) return null
    const ent = this.entOfCollider(hit.collider)
    if (!ent) return null
    const toi = fin(hit.timeOfImpact, far)
    return {
      entity: ent,
      point: { x: ray.origin.x + dx * toi, y: ray.origin.y + dy * toi, z: ray.origin.z + dz * toi },
      normal: { x: fin(hit.normal.x), y: fin(hit.normal.y), z: fin(hit.normal.z) },
      distance: toi
    }
  }

  private warn(id: string, msg: string) {
    const key = id + ':' + msg
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn('[phys3] ' + msg + ' (entity ' + id + ')')
  }

  dispose() {
    this.disposed = true
    this.activePairs.clear()
    this.prevPairs.clear()
    for (const set of this.listeners.values()) set.clear()
    this.listeners.clear()
    try { this.events.free() } catch { /* already freed */ }
    try { this.world.free() } catch { /* already freed */ }
    this.bodies.clear()
    this.byId.clear()
    this.staticBody.clear()
    this.colliderEnt.clear()
    this.lastVel.clear()
    this.lastRot.clear()
    this.acc = 0
    this.stepping = false
  }
}
