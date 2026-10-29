/* ============ Nova Engine — Core: math, ECS, Scene ============ */

export type Vec3 = { x: number; y: number; z: number }

export function v3(x = 0, y = 0, z = 0): Vec3 { return { x, y, z } }
export function cloneVec3(v: Vec3): Vec3 { return { x: v.x, y: v.y, z: v.z } }
export function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x }
export function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

let idCounter = Math.floor(Math.random() * 1e6)
export function uid(prefix = 'e'): string {
  return `${prefix}${idCounter++}_${Math.random().toString(36).slice(2, 6)}`
}

/* ---------- Components / Entities ---------- */

export type Component = { type: string } & Record<string, any>

export type Transform = { pos: Vec3; rot: Vec3; scale: Vec3 }

export function makeTransform(): Transform {
  return { pos: v3(), rot: v3(), scale: v3(1, 1, 1) }
}

export type Entity = {
  id: string
  name: string
  visible: boolean
  tags: string[]
  transform: Transform
  comps: Component[]
}

export function getComp<T = Component>(e: Entity, type: string): T | null {
  for (const c of e.comps) if (c.type === type) return c as T
  return null
}
export function hasComp(e: Entity, type: string): boolean {
  return !!getComp(e, type)
}
export function addComp(e: Entity, c: Component): Component {
  const old = getComp(e, c.type)
  if (old) { Object.assign(old, c); return old }
  e.comps.push(c)
  return c
}
export function removeComp(e: Entity, type: string) {
  e.comps = e.comps.filter(c => c.type !== type)
}

/* ---------- Scene ---------- */

export type Camera2DMeta = { zoom: number; follow: string }
export type Camera3DMeta = {
  mode: 'orbit' | 'first' | 'third' | 'top'
  follow: string
  fov: number
  dist: number
  height: number
}

export type SceneMeta = {
  name: string
  mode: '2d' | '3d'
  bg: string
  bgTop: string
  bgBottom: string
  useGradient: boolean
  gravity2d: number
  gravity3d: number
  camera2d: Camera2DMeta
  camera3d: Camera3DMeta
}

export function defaultMeta(): SceneMeta {
  return {
    name: 'Untitled Scene',
    mode: '2d',
    bg: '#1a2130',
    bgTop: '#0b1026',
    bgBottom: '#223a5e',
    useGradient: true,
    gravity2d: 1700,
    gravity3d: 22,
    camera2d: { zoom: 1, follow: '' },
    camera3d: { mode: 'third', follow: 'Player', fov: 60, dist: 9, height: 3.2 }
  }
}

export class Scene {
  meta: SceneMeta = defaultMeta()
  entities: Entity[] = []

  createEntity(
    name: string,
    comps: Component[] = [],
    opts: { tags?: string[]; pos?: Vec3; rot?: Vec3; scale?: Vec3; visible?: boolean } = {}
  ): Entity {
    const e: Entity = {
      id: uid(),
      name,
      visible: opts.visible !== false,
      tags: opts.tags ? [...opts.tags] : [],
      transform: makeTransform(),
      comps: comps.map(c => ({ ...c }))
    }
    if (opts.pos) e.transform.pos = { ...opts.pos }
    if (opts.rot) e.transform.rot = { ...opts.rot }
    if (opts.scale) e.transform.scale = { ...opts.scale }
    this.entities.push(e)
    return e
  }

  remove(id: string) {
    this.entities = this.entities.filter(e => e.id !== id)
  }

  byName(name: string): Entity | null {
    for (const e of this.entities) if (e.name === name) return e
    return null
  }

  byTag(tag: string): Entity[] {
    return this.entities.filter(e => e.tags.includes(tag))
  }

  cloneEntity(e: Entity): Entity {
    const copy: Entity = JSON.parse(JSON.stringify(e))
    copy.id = uid()
    copy.name = e.name + ' copy'
    const i = this.entities.indexOf(e)
    this.entities.splice(i + 1, 0, copy)
    return copy
  }
}

/* ---------- Serialization ---------- */

export function serializeScene(s: Scene): string {
  return JSON.stringify({ v: 1, nova: true, meta: s.meta, entities: s.entities }, null, 2)
}

export function deserializeScene(text: string): Scene {
  const raw = JSON.parse(text)
  const s = new Scene()
  if (raw && raw.meta) s.meta = Object.assign(defaultMeta(), raw.meta)
  if (raw && Array.isArray(raw.entities)) {
    s.entities = raw.entities.map((e: any) => ({
      id: e.id || uid(),
      name: e.name || 'Entity',
      visible: e.visible !== false,
      tags: Array.isArray(e.tags) ? e.tags : [],
      transform: {
        pos: e.transform?.pos || v3(),
        rot: e.transform?.rot || v3(),
        scale: e.transform?.scale || v3(1, 1, 1)
      },
      comps: Array.isArray(e.comps) ? e.comps : []
    }))
  }
  return s
}

/* ---------- pure-transform behaviors (no physics needed) ---------- */

const fin0 = (x: any): number => (Number.isFinite(Number(x)) ? Number(x) : 0)

function pathTotal(pts: Array<any>): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(fin0(pts[i].x) - fin0(pts[i - 1].x), fin0(pts[i].y) - fin0(pts[i - 1].y))
  }
  return total
}

function samplePath(pts: Array<any>, t: number): { x: number; y: number } {
  for (let i = 1; i < pts.length; i++) {
    const ax = fin0(pts[i - 1].x), ay = fin0(pts[i - 1].y)
    const bx = fin0(pts[i].x), by = fin0(pts[i].y)
    const seg = Math.hypot(bx - ax, by - ay)
    if (t <= seg || i === pts.length - 1) {
      const k = seg > 1e-9 ? clamp(t / seg, 0, 1) : 0
      return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k }
    }
    t -= seg
  }
  const last = pts[pts.length - 1]
  return { x: fin0(last?.x), y: fin0(last?.y) }
}

/**
 * Move every `path2d` entity along its waypoints. Standalone — no physics body
 * required (dynamic blocks teleport; static/kinematic bodies follow along).
 * 2D scenes travel in (x, y); 3D scenes travel in (x, z).
 */
export function tickPath2d(scene: Scene, dt: number) {
  if (!dt || dt <= 0) return
  const mode3d = scene.meta.mode === '3d'
  for (const e of scene.entities) {
    const p = getComp(e, 'path2d') as any
    if (!p || !Array.isArray(p.points) || p.points.length < 2) continue
    const speed = fin0(p.speed)
    if (speed <= 0) continue
    const mode = p.loop === true ? 'loop' : (p.loop === 'pingpong' || p.loop === 'once' ? p.loop : 'loop')
    const total = pathTotal(p.points)
    if (total <= 1e-9) continue
    let t = fin0(p.t)
    let dir = fin0(p.dir) || 1
    t += dir * speed * dt
    if (mode === 'pingpong') {
      while (t > total) { t = total - (t - total); dir = -1 }
      while (t < 0) { t = -t; dir = 1 }
    } else if (mode === 'loop') {
      t = ((t % total) + total) % total
    } else {
      t = clamp(t, 0, total)
    }
    p.t = Number.isFinite(t) ? t : 0
    p.dir = dir
    const pos = samplePath(p.points, t)
    if (mode3d) {
      e.transform.pos.x = pos.x
      e.transform.pos.z = pos.y
      if (p.face) {
        const nxt = samplePath(p.points, Math.min(total, t + 0.5))
        e.transform.rot.y = Math.atan2(pos.y - nxt.y, nxt.x - pos.x) * 180 / Math.PI
      }
    } else {
      e.transform.pos.x = pos.x
      e.transform.pos.y = pos.y
      if (p.face) {
        const nxt = samplePath(p.points, Math.min(total, t + 0.5))
        e.transform.rot.z = Math.atan2(nxt.y - pos.y, nxt.x - pos.x) * 180 / Math.PI
      }
    }
  }
}

/* ---------- health component semantics ---------- */

const healthInvuln = new WeakMap<Entity, number>()

/**
 * `health` component hit semantics: subtracts `amount` hp unless the entity is
 * inside its invuln window. At hp ≤ 0 the entity is flagged `__dead` (the game
 * loop purge picks it up). Returns true when damage actually landed.
 */
export function hit(e: Entity, amount = 1): boolean {
  const h = getComp(e, 'health') as any
  if (!h) return false
  if ((healthInvuln.get(e) || 0) > 0) return false
  const invuln = Math.max(0, fin0(h.invuln))
  const dmg = fin0(amount)
  h.hp = fin0(h.hp, 1) - dmg
  healthInvuln.set(e, invuln)
  if (h.hp <= 0) { h.hp = 0; ;(e as any).__dead = true }
  return true
}

/** per-frame gameplay systems: health invuln timers + path2d movement */
export function tickSystems(scene: Scene, dt: number) {
  if (dt > 0) {
    for (const e of scene.entities) {
      const it = healthInvuln.get(e)
      if (it != null && it > 0) healthInvuln.set(e, it - dt)
    }
  }
  tickPath2d(scene, dt)
}
