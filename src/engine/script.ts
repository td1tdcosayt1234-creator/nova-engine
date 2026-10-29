/* ============ Nova Engine — Script host (user game logic) ============
   Per-entity scripts are plain function bodies compiled once; `self` exposes the
   entity, `engine` the world. The extended runtime (events / timers / tweens /
   timeScale / physics bridges) is optional and installed by installScriptRuntime —
   so older mains and editor code keep compiling untouched. */

import { getComp, hit, clamp, type Entity, type Scene } from './core'
import type { Physics2D } from './physics2d'
import type { Physics3D } from './physics3d'

export interface InputAPI {
  down(c: string): boolean
  pressed(c: string): boolean
  mouse: {
    x: number; y: number; wx: number; wy: number
    inside: boolean; left: boolean; right: boolean; mid: boolean
    dx?: number; dy?: number
    leftPressed?: boolean; rightPressed?: boolean
    wheel?: number; dbl?: boolean
  }
  touch?: { active: boolean; x: number; y: number }
}

export interface SelfAPI {
  name: string
  pos: { x: number; y: number; z: number }
  vel: { x: number; y: number; z: number }
  rot: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  color: string
  visible: boolean
  onGround: boolean
  mem: Record<string, any>
  tags: string[]
  destroyed: boolean
  /** the raw entity behind this API (lets engine.destroy(api) work reliably) */
  readonly entityRef: Entity
  has(tag: string): boolean
  addTag(t: string): void
  removeTag(t: string): void
  setText(t: string): void
  burst(n?: number): void
  /** core `health` component semantics — respects invuln, marks dead at hp 0 */
  damage(n?: number): boolean
  onCollide(cb: (other: SelfAPI, tag: string) => void): void
}

export type TweenSpec = Record<string, number | undefined>

export interface EngineAPI {
  dt: number
  time: number
  score: number
  input: InputAPI
  log(...args: any[]): void
  random(min: number, max?: number): number
  chance(p: number): boolean
  pick<T>(arr: T[]): T
  find(name: string): SelfAPI | null
  findAll(tag: string): SelfAPI[]
  spawn(spec: any): SelfAPI
  destroy(target: SelfAPI | string): void
  camera: { shake(a?: number, t?: number): void; follow(name: string): void; zoom(z: number): void; readonly yaw: number }
  win(msg?: string): void
  gameOver(msg?: string): void
  reload(): void
  burstAt(target: SelfAPI | string, n?: number): void

  /* ---------- optional extended API (installed by installScriptRuntime) ---------- */
  /** simple event bus surviving all scripts; cleared on play start */
  on?(event: string, cb: (data?: any) => void): () => void
  emit?(event: string, data?: any): void
  /** run cb once after N seconds (scaled by timeScale); returns cancel */
  after?(seconds: number, cb: () => void): () => void
  /** run cb every N seconds (scaled by timeScale); returns cancel */
  every?(seconds: number, cb: () => void): () => void
  /** interpolate transform props over duration: 'x'|'y'|'z' or 'pos.x'|'rot.z'|'scale.y' */
  tween?(target: SelfAPI | string, props: TweenSpec, duration: number, easing?: string | ((t: number) => number)): () => void
  /** set physics velocity (2D: px/s, 3D: m/s; falls back to component write with no world) */
  velocity?(target: SelfAPI | string, x: number, y: number, z?: number): void
  /** physics impulse (same unit convention as the physics helpers) */
  impulse?(target: SelfAPI | string, x: number, y: number, z?: number): void
  /** ground check for jump scripts (uses the physics world when available) */
  isGrounded?(target: SelfAPI | string): boolean
  /** global slow-mo/fast-forward — orchestrator feeds phys.step(dt × timeScale) */
  readonly timeScale?: number
}

export type ScriptFn = (self: SelfAPI, engine: EngineAPI) => void

export function compileScript(code: string): ScriptFn {
  return new Function('self', 'engine', '"use strict";\n' + code) as ScriptFn
}

/* ---------- easing presets (shared by tweens) ---------- */

export const easing: Record<string, (t: number) => number> = {
  linear: t => t,
  easeIn: t => t * t,
  easeOut: t => t * (2 - t),
  easeInOut: t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  bounce: t => {
    const n1 = 7.5625
    const d1 = 2.75
    if (t < 1 / d1) return n1 * t * t
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
    return n1 * (t -= 2.625 / d1) * t + 0.984375
  }
}

/* ---------- ScriptRuntime: event bus + timers + tweens + timeScale ---------- */

type Timer = { id: number; seconds: number; left: number; cb: () => void; repeat: boolean; owner: string | null; dead?: boolean }
type TweenEntry = {
  ent: Entity
  props: Array<{ obj: { x: number; y: number; z: number }; key: 'x' | 'y' | 'z'; to: number; from: number }>
  dur: number
  t: number
  ease: (t: number) => number
  owner: string | null
  dead?: boolean
}

export class ScriptRuntime {
  timeScale = 1
  private listeners = new Map<string, Set<(data?: any) => void>>()
  private timers = new Map<number, Timer>()
  private timerSeq = 1
  private tweens: TweenEntry[] = []

  /* -- event bus (survives scripts; cleared on play start via reset) -- */
  on(event: string, cb: (data?: any) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    set.add(cb)
    return () => set!.delete(cb)
  }

  off(event: string, cb: (data?: any) => void) {
    this.listeners.get(event)?.delete(cb)
  }

  emit(event: string, data?: any) {
    const set = this.listeners.get(event)
    if (!set || !set.size) return
    for (const cb of [...set]) {
      try { cb(data) } catch (err) { console.error('[event:' + event + ']', err) }
    }
  }

  /* -- timers -- */
  after(seconds: number, cb: () => void, owner: string | null = null): () => void {
    const id = this.timerSeq++
    const t: Timer = { id, seconds: Math.max(0.001, seconds), left: Math.max(0.001, seconds), cb, repeat: false, owner }
    this.timers.set(id, t)
    return () => { t.dead = true }
  }

  every(seconds: number, cb: () => void, owner: string | null = null): () => void {
    const id = this.timerSeq++
    const t: Timer = { id, seconds: Math.max(0.001, seconds), left: Math.max(0.001, seconds), cb, repeat: true, owner }
    this.timers.set(id, t)
    return () => { t.dead = true }
  }

  /* -- tweens -- */
  tween(target: Entity, props: TweenSpec, duration = 0.3, easingFn?: string | ((t: number) => number), owner: string | null = null): () => void {
    const entry: TweenEntry = {
      ent: target,
      props: [],
      dur: Math.max(0.001, Number(duration) || 0.001),
      t: 0,
      ease: typeof easingFn === 'string'
        ? (easing[easingFn] || easing.linear)
        : (typeof easingFn === 'function' ? easingFn : easing.linear),
      owner
    }
    for (const key of Object.keys(props || {})) {
      const to = Number((props as any)[key])
      if (!Number.isFinite(to)) continue
      const path = resolveTweenPath(target, key)
      if (!path) continue
      entry.props.push({ obj: path.obj, key: path.key, to, from: path.obj[path.key] })
    }
    if (entry.props.length) this.tweens.push(entry)
    return () => { entry.dead = true }
  }

  /** advance timers + tweens by scaled dt (called from the game loop) */
  tick(dt: number) {
    const d = clamp(Number(dt) || 0, 0, 0.25) * this.timeScale
    if (d <= 0) return
    // timers
    for (const t of [...this.timers.values()]) {
      if (t.dead) continue
      t.left -= d
      while (t.left <= 0 && !t.dead) {
        try { t.cb() } catch (err) { console.error('[timer]', err); t.dead = true; break }
        if (t.repeat) t.left += t.seconds
        else { t.dead = true; break }
      }
    }
    for (const [id, t] of [...this.timers]) if (t.dead) this.timers.delete(id)
    // tweens
    for (const tw of this.tweens) {
      if (tw.dead) continue
      if ((tw.ent as any).__dead) { tw.dead = true; continue }
      tw.t += d
      const k = tw.ease(clamp(tw.t / tw.dur, 0, 1))
      for (const p of tw.props) p.obj[p.key] = p.from + (p.to - p.from) * k
      if (tw.t >= tw.dur) tw.dead = true
    }
    if (this.tweens.some(t => t.dead)) this.tweens = this.tweens.filter(t => !t.dead)
  }

  /** drop state owned by a destroyed entity script */
  dropOwner(ownerId: string) {
    for (const [id, t] of [...this.timers]) if (t.owner === ownerId) this.timers.delete(id)
    for (const tw of this.tweens) if (tw.owner === ownerId) tw.dead = true
  }

  reset() {
    for (const set of this.listeners.values()) set.clear()
    this.listeners.clear()
    this.timers.clear()
    this.tweens = []
    this.timeScale = 1
  }
}

/** map a tween key like 'x' | 'pos.x' | 'rot.z' | 'scale.y' onto the transform vector */
function resolveTweenPath(ent: Entity, key: string): { obj: { x: number; y: number; z: number }; key: 'x' | 'y' | 'z' } | null {
  const t = ent.transform
  let root = 'pos'
  let sub = key
  if (key.includes('.')) {
    const parts = key.split('.')
    root = parts[0]
    sub = parts.slice(1).join('.')
  }
  const obj = root === 'pos' ? t.pos : root === 'rot' ? t.rot : root === 'scale' ? t.scale : null
  if (!obj) return null
  if (sub !== 'x' && sub !== 'y' && sub !== 'z') return null
  return { obj, key: sub }
}

/* ---------- runtime context ---------- */

export interface RuntimeCtx {
  scene: () => Scene
  mode: () => '2d' | '3d'
  host: ScriptHost
  phys2?: () => Physics2D | null
  phys3?: () => Physics3D | null
}

/**
 * Install the extended script runtime into an EngineAPI object.
 * Returns the runtime — the orchestrator calls rt.tick(dt) each frame and
 * passes dt × rt.timeScale to the physics step. Requires zero other changes.
 */
export function installScriptRuntime(api: EngineAPI, ctx: RuntimeCtx): ScriptRuntime {
  const rt = ctx.host.runtime
  const a = api as any

  const entOf = (t: any): Entity | null => {
    if (t && typeof t === 'object') {
      if ((t as any).entityRef) return (t as any).entityRef as Entity
      if (Array.isArray((t as any).comps)) return t as Entity
      return null
    }
    if (typeof t === 'string') {
      const s = ctx.scene()
      return s.byName(t)
    }
    return null
  }

  const owner = () => ((a.__owner as string | null) || null)

  a.on = (ev: string, cb: (data?: any) => void) => rt.on(ev, cb)
  a.emit = (ev: string, data?: any) => rt.emit(ev, data)
  a.after = (seconds: number, cb: () => void) => rt.after(seconds, cb, owner())
  a.every = (seconds: number, cb: () => void) => rt.every(seconds, cb, owner())
  a.tween = (target: any, props: TweenSpec, duration: number, easingFn: any) => {
    const e = entOf(target)
    if (!e) return () => {}
    return rt.tween(e, props, duration, easingFn, owner())
  }
  a.velocity = (target: any, x: number, y: number, z?: number) => {
    const e = entOf(target)
    if (!e) return
    const vx = Number(x) || 0
    const vy = Number(y) || 0
    if (ctx.mode() === '3d') {
      const p = ctx.phys3?.()
      if (p) p.setLinearVelocity(e, vx, vy, Number(z) || 0)
      else {
        const r = getComp(e, 'rigid3d') as any
        if (r) { r.vx = vx; r.vy = vy; r.vz = Number(z) || 0 }
      }
    } else {
      const p = ctx.phys2?.()
      if (p) p.setVelocity(e, vx, vy)
      else {
        const b = getComp(e, 'body2d') as any
        if (b) { b.vx = vx; b.vy = vy }
      }
    }
  }
  a.impulse = (target: any, x: number, y: number, z?: number) => {
    const e = entOf(target)
    if (!e) return
    if (ctx.mode() === '3d') ctx.phys3?.()?.applyImpulse(e, Number(x) || 0, Number(y) || 0, Number(z) || 0)
    else ctx.phys2?.()?.applyImpulse(e, Number(x) || 0, Number(y) || 0)
  }
  a.isGrounded = (target: any) => {
    const e = entOf(target)
    if (!e) return false
    if (ctx.mode() === '3d') {
      const p = ctx.phys3?.()
      return p ? p.isGrounded(e) : !!(getComp(e, 'rigid3d') as any)?.onGround
    }
    const p = ctx.phys2?.()
    return p ? p.isGrounded(e) : !!(getComp(e, 'body2d') as any)?.onGround
  }
  if (!('timeScale' in api)) {
    Object.defineProperty(api, 'timeScale', {
      get: () => rt.timeScale,
      set: (v: any) => { rt.timeScale = clamp(Number(v) || 1, 0.05, 5) }
    })
  }
  return rt
}

type CollideCb = { cb: (other: any) => void }

export class ScriptHost {
  debug = false
  runtime = new ScriptRuntime()
  private fns = new Map<string, ScriptFn>()
  private failed = new Set<string>()
  private registered = new Set<string>()
  private errOnce = new Set<string>()
  private mems = new Map<string, Record<string, any>>()
  private apis = new Map<string, SelfAPI>()
  private collide: Map<string, CollideCb[]> = new Map()

  hooks: {
    burst(entityId: string, n?: number): void
  } = { burst: () => {} }

  ensure(entity: Entity): ScriptFn | null {
    if (this.failed.has(entity.id)) return null
    let fn = this.fns.get(entity.id)
    if (fn) return fn
    const sc = entity.comps.find(c => c.type === 'script')
    if (!sc || !sc.code || !sc.code.trim()) return null
    try {
      fn = compileScript(sc.code)
      this.fns.set(entity.id, fn)
      return fn
    } catch (err) {
      this.failed.add(entity.id)
      console.error(`[script:${entity.name}] compile error:`, err)
      return null
    }
  }

  api(entity: Entity, engine: EngineAPI): SelfAPI {
    let a: any = this.apis.get(entity.id)
    if (a) return a

    const body = () => entity.comps.find(c => c.type === 'body2d')
    const rig = () => entity.comps.find(c => c.type === 'rigid3d')
    const spr = () => entity.comps.find(c => c.type === 'sprite2d')
    const mesh = () => entity.comps.find(c => c.type === 'mesh3d')
    const txt = () => entity.comps.find(c => c.type === 'text2d')

    a = {
      name: entity.name,
      destroyed: false,
      mem: this.mems.get(entity.id) || {},
      has: (t) => entity.tags.includes(t),
      addTag: (t) => { if (!entity.tags.includes(t)) entity.tags.push(t) },
      removeTag: (t) => { entity.tags = entity.tags.filter(x => x !== t) },
      setText: (t) => { const c = txt(); if (c) c.text = String(t) },
      burst: (n = 10) => this.hooks.burst(entity.id, n),
      damage: (n = 1) => hit(entity, n),
      onCollide: (cb) => {
        if (this.registered.has(entity.id)) return
        this.registered.add(entity.id)
        const list = this.collide.get(entity.id) || []
        list.push({ cb })
        this.collide.set(entity.id, list)
      }
    }
    this.mems.set(entity.id, a.mem)

    Object.defineProperty(a, 'entityRef', { get: () => entity })
    Object.defineProperty(a, 'pos', { get: () => entity.transform.pos, set: (v) => Object.assign(entity.transform.pos, v) })
    Object.defineProperty(a, 'rot', { get: () => entity.transform.rot, set: (v) => Object.assign(entity.transform.rot, v) })
    Object.defineProperty(a, 'scale', { get: () => entity.transform.scale, set: (v) => Object.assign(entity.transform.scale, v) })
    Object.defineProperty(a, 'visible', { get: () => entity.visible, set: (v) => { entity.visible = !!v } })
    Object.defineProperty(a, 'tags', { get: () => entity.tags })
    Object.defineProperty(a, 'vel', {
      get: () => {
        const b = body(), r = rig()
        if (b) return { x: b.vx, y: b.vy, z: 0 }
        if (r) return { x: r.vx, y: r.vy, z: r.vz }
        return { x: 0, y: 0, z: 0 }
      },
      set: (v) => {
        const b = body(), r = rig()
        if (b) { b.vx = finiteNum(v?.x, b.vx); b.vy = finiteNum(v?.y, b.vy) }
        else if (r) { r.vx = finiteNum(v?.x, r.vx); r.vy = finiteNum(v?.y, r.vy); r.vz = finiteNum(v?.z, r.vz) }
      }
    })
    Object.defineProperty(a, 'color', {
      get: () => { const s = spr(); if (s) return s.color; const m = mesh(); return m ? m.color : '#ffffff' },
      set: (v) => {
        const s = spr(); if (s && typeof v === 'string') s.color = v
        const m = mesh(); if (m && typeof v === 'string') m.color = v
      }
    })
    Object.defineProperty(a, 'onGround', {
      get: () => {
        const b = body()
        if (b) return !!b.onGround
        const r = rig()
        return r ? !!r.onGround : false
      }
    })

    this.apis.set(entity.id, a)
    return a
  }

  run(entity: Entity, engine: EngineAPI) {
    const fn = this.ensure(entity)
    if (!fn) return
    const a = this.api(entity, engine)
    const eng = engine as any
    eng.__owner = entity.id   // engine.after/every/tween attach to this script
    try {
      fn(a, engine)
    } catch (err) {
      if (this.debug || !this.errOnce.has(entity.id)) {
        this.errOnce.add(entity.id)
        console.error(`[script:${entity.name}] runtime error:`, err)
      }
    } finally {
      eng.__owner = null
    }
  }

  /** Fire collide callbacks registered by entity `aId` with `other`. */
  dispatchCollide(aId: string, other: Entity, engine: EngineAPI) {
    const list = this.collide.get(aId)
    if (!list) return
    for (const { cb } of list) {
      try { cb(this.api(other, engine)) } catch (err) { console.error('[collide]', err) }
    }
  }

  drop(id: string) {
    this.fns.delete(id)
    this.apis.delete(id)
    this.mems.delete(id)
    this.collide.delete(id)
    this.runtime.dropOwner(id)
  }

  reset() {
    this.fns.clear()
    this.failed.clear()
    this.registered.clear()
    this.errOnce.clear()
    this.mems.clear()
    this.apis.clear()
    this.collide.clear()
    this.runtime.reset()
  }
}

function finiteNum(x: any, d: number): number {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}
