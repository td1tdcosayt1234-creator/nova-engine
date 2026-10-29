/* ============ Nova Engine — 2D physics (Planck.js — a real Box2D port) ============
   Real rigid bodies: rotation, friction, restitution, dynamic–dynamic collisions,
   kinematic bodies, sensors (triggers), bullet CCD for fast movers and raycasts.
   Engine units stay the same as before (positions in pixels, velocities in
   pixels/sec) — everything is converted through PPM so existing scenes keep working.

   While playing, the physics world is the source of truth after each step.
   Scripts express intent through body2d.vx/vy, transform.pos (teleport) and
   transform.rot.z (spin) — those intents are pushed into the world each frame,
   then the world's resolved state is synced back.

   Collision dispatch:
     sink(a, b)                       — legacy: fires every frame while touching
     on('enter'|'exit'|'stay', cb)    — precise edges: 'enter' on contact start,
                                        'exit' on contact end, 'stay' while touching */

import { World, Vec2, Box, Circle, type Body, type Fixture } from 'planck'
import { getComp, clamp, type Entity, type Scene } from './core'

/** pixels per meter — Box2D is happiest with 0.1–10 m bodies */
export const PPM = 50

const FIXED_DT = 1 / 60
const MAX_SUBSTEPS = 3
const R2D = 180 / Math.PI

export type CollideSink = (a: Entity, b: Entity) => void
export type PhysEvent = 'enter' | 'exit' | 'stay'
export type PhysListener = (a: Entity, b: Entity) => void
export type RayOpts = { skip?: Entity; sensors?: boolean }

export function bodyHalf(e: Entity): { hw: number; hh: number } {
  const b = getComp(e, 'body2d')
  if (b && Number.isFinite(b.w) && b.w) return { hw: b.w / 2, hh: b.h / 2 }
  const s = getComp(e, 'sprite2d')
  if (s) return { hw: (Number(s.w) || 40) / 2, hh: (Number(s.h) || 40) / 2 }
  return { hw: 20, hh: 20 }
}

/** NaN guard: fall back to a default for non-finite numbers (scripts love NaN) */
function fin(x: any, d = 0): number {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}

function pairKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a
}

export class Physics2D {
  world = new World({ gravity: new Vec2(0, 0), allowSleep: true })
  private scene: Scene
  private sink: CollideSink
  private bodies = new Map<string, Body>()
  private entBody = new WeakMap<Entity, Body>()
  private byId = new Map<string, Entity>()
  private lastVel = new Map<string, [number, number]>()
  private lastRot = new Map<string, number>()
  private activePairs = new Set<string>()
  private prevPairs = new Set<string>()
  private listeners = new Map<string, Set<PhysListener>>()
  private pendingAdds: Entity[] = []
  private pendingRemovals: string[] = []
  private warned = new Set<string>()
  private acc = 0
  private disposed = false

  constructor(scene: Scene, sink: CollideSink) {
    this.scene = scene
    this.sink = sink
    this.world.setGravity(new Vec2(0, -fin(scene.meta.gravity2d) / PPM))
    this.world.on('begin-contact', c => {
      const a = c.getFixtureA().getBody().getUserData()
      const b = c.getFixtureB().getBody().getUserData()
      if (typeof a === 'string' && typeof b === 'string') this.activePairs.add(pairKey(a, b))
    })
    this.world.on('end-contact', c => {
      const a = c.getFixtureA().getBody().getUserData()
      const b = c.getFixtureB().getBody().getUserData()
      if (typeof a === 'string' && typeof b === 'string') this.activePairs.delete(pairKey(a, b))
    })
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
      try { cb(a, b) } catch (err) { console.error('[phys2:' + ev + ']', err) }
    }
  }

  /* ---------- entity → body resolution (WeakMap-backed) ---------- */

  bodyOf(e: Entity): Body | null {
    const cached = this.entBody.get(e)
    if (cached && cached.getUserData() === e.id) return cached
    const found = this.bodies.get(e.id) || null
    if (found) this.entBody.set(e, found)
    return found
  }

  private entOfFixture(fx: Fixture): Entity | null {
    const id = fx.getBody().getUserData()
    return typeof id === 'string' ? (this.byId.get(id) || null) : null
  }

  /* ---------- body lifecycle ---------- */

  /* body build for one entity (no body2d / hidden / existing → skip) */
  add(e: Entity) {
    if (this.disposed) return
    if (this.world.isLocked()) { this.pendingAdds.push(e); return }
    this.addNow(e)
  }

  private addNow(e: Entity) {
    const b = getComp(e, 'body2d') as any
    if (!b || !e.visible || this.bodies.has(e.id)) return
    const half = bodyHalf(e)
    const hw = Math.max(2, fin(half.hw)) / PPM
    const hh = Math.max(2, fin(half.hh)) / PPM
    const t = e.transform
    const type: 'static' | 'dynamic' | 'kinematic' = b.kinematic ? 'kinematic' : (b.isStatic ? 'static' : 'dynamic')
    const body = this.world.createBody({
      type,
      position: new Vec2(fin(t.pos.x) / PPM, fin(t.pos.y) / PPM),
      angle: fin(t.rot.z) / R2D
    })
    body.setUserData(e.id)
    this.entBody.set(e, body)
    if (type !== 'static') {
      body.setGravityScale(clamp(fin(b.gravityScale, 1), -5, 10))
      if (b.keepUpright !== false) body.setFixedRotation(true)   // platformer-friendly default
      const speed = Math.hypot(fin(b.vx), fin(b.vy))
      body.setBullet(b.bullet == null ? speed > 1200 : !!b.bullet)   // fast movers get CCD
      const damp = fin(b.linDamp)
      if (damp > 0) body.setLinearDamping(Math.min(25, damp))
      const adamp = fin(b.angDamp)
      if (adamp > 0) body.setAngularDamping(Math.min(25, adamp))
    }
    const spr = getComp(e, 'sprite2d') as any
    const wantCircle = b.shape === 'circle' || (b.shape !== 'box' && !!spr && spr.sprite === 'orb')
    const shape = wantCircle
      ? new Circle(Math.max(hw, hh))
      : new Box(hw, hh)
    body.createFixture(shape, {
      density: 1,
      friction: clamp(fin(b.friction, 0.35), 0, 1.5),
      restitution: clamp(fin(b.bounce), 0, 1),
      isSensor: !!b.sensor
    })
    this.bodies.set(e.id, body)
    this.byId.set(e.id, e)
    this.lastVel.set(e.id, [fin(b.vx), fin(b.vy)])
    this.lastRot.set(e.id, fin(t.rot.z))
    if (b.enabled === false) body.setActive(false)   // kill switch honored
  }

  remove(id: string) {
    if (this.world.isLocked()) { this.pendingRemovals.push(id); return }
    this.removeNow(id)
  }

  private removeNow(id: string) {
    const body = this.bodies.get(id)
    if (!body) return
    this.bodies.delete(id)
    this.byId.delete(id)
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
    this.world.destroyBody(body)
  }

  /** catch entities spawned/added mid-play without a body (or that lost body2d) */
  private sweep() {
    for (const e of [...this.scene.entities]) {
      const b = getComp(e, 'body2d') as any
      const body = this.bodies.get(e.id)
      if (!b) { if (body) this.removeNow(e.id); continue }
      if (!e.visible) { if (body) body.setActive(false); continue }
      if (!body) { this.addNow(e); continue }
      // bullets can change speed while alive — refresh the fast-mover flag
      if (b.kinematic !== true && !b.isStatic && b.bullet == null) {
        const sp = body.getLinearVelocity()
        const fast = Math.hypot(sp.x, sp.y) * PPM > 1200
        if (fast !== body.isBullet()) body.setBullet(fast)
      }
      if (b.enabled === false) body.setActive(false)
      else body.setActive(true)
    }
  }

  /* ---------- stepping ---------- */

  /** advance the world with a fixed timestep accumulator (max 3 × 1/60s per frame) */
  step(dt: number) {
    if (this.disposed) return
    this.acc += clamp(fin(dt, 0.016), 0, 0.1)
    this.sweep()
    this.pushIntents()
    let steps = 0
    while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.world.step(FIXED_DT, 8, 3)
      this.acc -= FIXED_DT
      steps++
    }
    if (steps === MAX_SUBSTEPS) this.acc = 0
    this.syncFromWorld()
    this.drainPending()
    this.flushPairs()
  }

  private drainPending() {
    if (this.pendingRemovals.length) {
      const ids = this.pendingRemovals
      this.pendingRemovals = []
      for (const id of ids) this.removeNow(id)
    }
    if (this.pendingAdds.length) {
      const adds = this.pendingAdds
      this.pendingAdds = []
      for (const e of adds) this.addNow(e)
    }
  }

  /** scripts → world (vel/teleport/spin intents, static platform movement) */
  private pushIntents() {
    for (const [id, body] of this.bodies) {
      const e = this.byId.get(id)
      const b = e ? (getComp(e, 'body2d') as any) : null
      if (!e || !b) continue
      const t = e.transform
      if (b.isStatic) {
        // statics don't integrate — mirror script-driven motion (moving platforms, bobbing pickups)
        body.setPosition(new Vec2(fin(t.pos.x) / PPM, fin(t.pos.y) / PPM))
        body.setAngle(fin(t.rot.z) / R2D)
        continue
      }
      const lv = body.getLinearVelocity()
      const vx = fin(b.vx) / PPM
      const vy = fin(b.vy) / PPM
      if (Math.abs(vx - lv.x) > 1e-6 || Math.abs(vy - lv.y) > 1e-6) {
        body.setLinearVelocity(new Vec2(vx, vy))
        body.setAwake(true)
      }
      if (!body.isFixedRotation()) {
        const want = fin(t.rot.z)
        if (Math.abs(want - (this.lastRot.get(id) || 0)) > 1e-4) {
          body.setAngle(want / R2D)
          body.setAwake(true)
        }
      }
      const p = body.getPosition()
      if (Math.abs(fin(t.pos.x) / PPM - p.x) > 1e-4 || Math.abs(fin(t.pos.y) / PPM - p.y) > 1e-4) {
        body.setPosition(new Vec2(fin(t.pos.x) / PPM, fin(t.pos.y) / PPM))
        body.setAwake(true)
      }
    }
  }

  /** world → transforms/components + ground flags (physics drives the transform) */
  private syncFromWorld() {
    for (const [id, body] of this.bodies) {
      const e = this.byId.get(id)
      const b = e ? (getComp(e, 'body2d') as any) : null
      if (!e || !b) continue
      if (b.isStatic) continue   // statics: transform is authoritative (scripts may move them)
      let p = body.getPosition()
      const lv0 = body.getLinearVelocity()
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(lv0.x) || !Number.isFinite(lv0.y)) {
        this.warn(id, 'corrupt physics state — reset body')
        body.setPosition(new Vec2(0, 40 / PPM))
        body.setLinearVelocity(Vec2.zero())
        body.setAngle(0)
        p = body.getPosition()
      }
      e.transform.pos.x = p.x * PPM
      e.transform.pos.y = p.y * PPM
      if (!body.isFixedRotation()) {
        const deg = body.getAngle() * R2D
        e.transform.rot.z = Number.isFinite(deg) ? deg : 0
        this.lastRot.set(id, deg)
      }
      const lv = body.getLinearVelocity()
      b.vx = lv.x * PPM
      b.vy = lv.y * PPM
      this.lastVel.set(id, [b.vx, b.vy])
      b.onGround = this.groundBelow(body, e)
    }
  }

  /** raycast straight down; any non-sensor fixture below the feet = grounded */
  private groundBelow(body: Body, e: Entity): boolean {
    const half = bodyHalf(e).hh
    const p = body.getPosition()
    let hit = false
    this.world.rayCast(
      new Vec2(p.x, p.y),
      new Vec2(p.x, p.y - (half + 8) / PPM),
      (fixture, _pt, _n, frac) => {
        if (fixture.getBody() === body) return 1
        if (fixture.isSensor()) return 1
        hit = true
        return frac
      }
    )
    return hit
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

  /** set velocity in px/sec (writes through body2d so scripts stay consistent) */
  setVelocity(e: Entity, x: number, y: number) {
    const body = this.bodyOf(e)
    const b = getComp(e, 'body2d') as any
    if (!body || !b || this.world.isLocked()) return
    const vx = fin(x), vy = fin(y)
    b.vx = vx; b.vy = vy
    body.setLinearVelocity(new Vec2(vx / PPM, vy / PPM))
    body.setAwake(true)
  }

  getVelocity(e: Entity): { x: number; y: number } {
    const body = this.bodyOf(e)
    const b = getComp(e, 'body2d') as any
    if (!body || b?.isStatic) return { x: fin(b?.vx), y: fin(b?.vy) }
    const lv = body.getLinearVelocity()
    return { x: lv.x * PPM, y: lv.y * PPM }
  }

  /** impulse in px-units (same scale as velocity), optionally at a world point */
  applyImpulse(e: Entity, x: number, y: number, px?: number, py?: number) {
    const body = this.bodyOf(e)
    if (!body || body.isStatic() || this.world.isLocked()) return
    const at = (px != null || py != null)
      ? new Vec2(fin(px) / PPM, fin(py) / PPM)
      : body.getWorldCenter()
    body.applyLinearImpulse(new Vec2(fin(x) / PPM, fin(y) / PPM), at, true)
  }

  /** force in px-units (same scale as velocity per second) */
  applyForce(e: Entity, x: number, y: number, px?: number, py?: number) {
    const body = this.bodyOf(e)
    if (!body || body.isStatic() || this.world.isLocked()) return
    if (px != null || py != null) {
      body.applyForce(new Vec2(fin(x) / PPM, fin(y) / PPM), new Vec2(fin(px) / PPM, fin(py) / PPM), true)
    } else {
      body.applyForceToCenter(new Vec2(fin(x) / PPM, fin(y) / PPM), true)
    }
  }

  /** pause/resume a body without destroying it (toggle physics per component too) */
  setEnabled(e: Entity, on: boolean) {
    const body = this.bodyOf(e)
    if (!body) return
    body.setActive(!!on)
    if (!!on) body.setAwake(true)
    const b = getComp(e, 'body2d') as any
    if (b) b.enabled = !!on
  }

  setGravityScale(e: Entity, s: number) {
    const body = this.bodyOf(e)
    const b = getComp(e, 'body2d') as any
    if (!body || !b) return
    body.setGravityScale(clamp(fin(s, 1), -5, 10))
    body.setAwake(true)
    b.gravityScale = clamp(fin(s, 1), -5, 10)
  }

  /** instant reposition in px (optionally also rotate, degrees) */
  teleport(e: Entity, x: number, y: number, rz?: number) {
    const body = this.bodyOf(e)
    if (!body) return
    const tx = fin(x), ty = fin(y)
    e.transform.pos.x = tx
    e.transform.pos.y = ty
    const rot = (rz != null && Number.isFinite(rz)) ? fin(rz) : null
    if (rot != null && !body.isFixedRotation()) e.transform.rot.z = rot
    if (this.world.isLocked()) return
    body.setPosition(new Vec2(tx / PPM, ty / PPM))
    if (rot != null && !body.isFixedRotation()) body.setAngle(rot / R2D)
    this.lastRot.set(e.id, e.transform.rot.z)
    if (!body.isStatic()) body.setAwake(true)
  }

  setBullet(e: Entity, on: boolean) {
    const body = this.bodyOf(e)
    if (!body) return
    body.setBullet(!!on)
    const b = getComp(e, 'body2d') as any
    if (b) b.bullet = !!on
  }

  /* ---------- raycast ---------- */

  /** world raycast: origin/dir in pixels, dir needn't be normalized; skips sensors unless asked */
  raycast2d(
    origin: { x: number; y: number },
    dir: { x?: number; y?: number },
    maxDist = 2000,
    opts: RayOpts = {}
  ): { entity: Entity; point: { x: number; y: number }; normal: { x: number; y: number }; distance: number } | null {
    if (this.disposed) return null
    const dx = fin(dir.x), dy = fin(dir.y)
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return null
    const far = Math.max(1e-3, fin(maxDist, 2000))
    const p1 = new Vec2(fin(origin.x) / PPM, fin(origin.y) / PPM)
    const end = new Vec2(p1.x + (dx / len) * far / PPM, p1.y + (dy / len) * far / PPM)
    let best: { entity: Entity; point: { x: number; y: number }; normal: { x: number; y: number }; distance: number } | null = null
    let bestFrac = 1
    this.world.rayCast(p1, end, (fixture, point, normal, frac) => {
      if (best && frac >= bestFrac) return bestFrac
      const ent = this.entOfFixture(fixture)
      if (!ent) return 1
      if (opts.skip && ent === opts.skip) return 1
      if (fixture.isSensor() && !opts.sensors) return 1
      best = { entity: ent, point: { x: point.x * PPM, y: point.y * PPM }, normal: { x: normal.x, y: normal.y }, distance: frac * far }
      bestFrac = frac
      return frac
    })
    return best
  }

  private warn(id: string, msg: string) {
    const key = id + ':' + msg
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn('[phys2] ' + msg + ' (entity ' + id + ')')
  }

  dispose() {
    this.disposed = true
    this.activePairs.clear()
    this.prevPairs.clear()
    for (const set of this.listeners.values()) set.clear()
    this.listeners.clear()
    this.bodies.clear()
    this.byId.clear()
    this.lastVel.clear()
    this.lastRot.clear()
    this.pendingAdds = []
    this.pendingRemovals = []
    this.warned.clear()
    this.acc = 0
    this.world = new World({ gravity: new Vec2(0, 0), allowSleep: true })
  }
}
