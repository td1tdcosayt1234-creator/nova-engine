/* ============ Nova Engine — Utility: easing, RNG, helpers, tweens ============ */

/* main.ts wiring:
 *   import { tweens, runTween, easing, randRange, lerpAngle, formatTime } from './engine/utility'
 *   runTween(ship, { y: 4, ry: 6.28 }, 0.8, easing.easeOutBack)   // entity from './core'
 *   // per frame: tweens.update(dt)
 *   tween.cancel()                                                // abort any tween
 */

import { clamp, lerp, type Transform } from './core'

/* ---------- easing presets: (t: 0..1) -> 0..1 (overshoot allowed) ---------- */

export type Ease = (t: number) => number

export function easeLinear(t: number): number { return t }

export function easeInQuad(t: number): number { return t * t }

export function easeOutQuad(t: number): number { return t * (2 - t) }

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const x = t - 1
  return 1 + c3 * x * x * x + c1 * x * x
}

export function easeOutBounce(t: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  let x = t
  if (x < 1 / d1) return n1 * x * x
  if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75 }
  if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375 }
  x -= 2.625 / d1
  return n1 * x * x + 0.984375
}

export function easeOutElastic(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const c4 = (2 * Math.PI) / 3
  const p = Math.pow(2, -10 * t)
  const s = Math.sin((t * 10 - 0.75) * c4)
  return Math.max(0, Math.min(1.1, p * s + 1))
}

/** Named map handy for presets in the script API (`easing.easeOutBounce`, ...). */
export const easing: Record<string, Ease> = {
  linear: easeLinear,
  easeInQuad,
  easeOutQuad,
  easeInOutQuad,
  easeOutBack,
  easeOutBounce,
  easeOutElastic
}

/* ---------- randomness & math helpers ---------- */

/** Random float in [a, b). */
export function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

/** Random integer in [a, b] (both ends included). */
export function randInt(a: number, b: number): number {
  if (b < a) { const s = a; a = b; b = s }
  return a + Math.floor(Math.random() * (b - a + 1))
}

/** True with probability p (0..1). */
export function chance(p: number): boolean {
  return Math.random() < p
}

/** Fisher-Yates shuffle, in place; returns the same array. */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

/** Move `cur` toward `target` by at most `maxDelta`. */
export function stepTowards(cur: number, target: number, maxDelta: number): number {
  const d = target - cur
  if (Math.abs(d) <= maxDelta) return target
  return cur + (d > 0 ? maxDelta : -maxDelta)
}

/** Angle lerp along the shortest arc; args in radians. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  else if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Seconds → `mm:ss` (minutes pad out past 59). */
export function formatTime(sec: number): string {
  let s = Math.floor(Math.max(0, sec))
  const m = Math.floor(s / 60)
  s -= m * 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/* ---------- tweens ---------- */

/** What runTween can animate: pos xyz, rot xyz (radians), scale xyz (sx..sz). */
export type TweenTo = {
  x?: number; y?: number; z?: number        // target.transform.pos
  rx?: number; ry?: number; rz?: number     // target.transform.rot
  sx?: number; sy?: number; sz?: number     // target.transform.scale
}

/** Entity-like: anything with a Nova Transform (e.g. core.Entity). */
export type TweenTarget = { transform: Transform }

export type Tween = {
  target: TweenTarget | null // nulled on cancel → tween degrades to no-op
  from: Transform            // snapshot taken at add() time
  to: TweenTo
  dur: number
  t: number
  ease: Ease
  onDone?: () => void
  done: boolean
}

function applyTween(tw: Tween, e: number) {
  const tr = tw.target!.transform
  const from = tw.from, to = tw.to
  if (to.x !== undefined) tr.pos.x = lerp(from.pos.x, to.x, e)
  if (to.y !== undefined) tr.pos.y = lerp(from.pos.y, to.y, e)
  if (to.z !== undefined) tr.pos.z = lerp(from.pos.z, to.z, e)
  if (to.rx !== undefined) tr.rot.x = lerp(from.rot.x, to.rx, e)
  if (to.ry !== undefined) tr.rot.y = lerp(from.rot.y, to.ry, e)
  if (to.rz !== undefined) tr.rot.z = lerp(from.rot.z, to.rz, e)
  if (to.sx !== undefined) tr.scale.x = lerp(from.scale.x, to.sx, e)
  if (to.sy !== undefined) tr.scale.y = lerp(from.scale.y, to.sy, e)
  if (to.sz !== undefined) tr.scale.z = lerp(from.scale.z, to.sz, e)
}

function snapToEnd(tw: Tween) {
  const tr = tw.target!.transform, to = tw.to
  if (to.x !== undefined) tr.pos.x = to.x
  if (to.y !== undefined) tr.pos.y = to.y
  if (to.z !== undefined) tr.pos.z = to.z
  if (to.rx !== undefined) tr.rot.x = to.rx
  if (to.ry !== undefined) tr.rot.y = to.ry
  if (to.rz !== undefined) tr.rot.z = to.rz
  if (to.sx !== undefined) tr.scale.x = to.sx
  if (to.sy !== undefined) tr.scale.y = to.sy
  if (to.sz !== undefined) tr.scale.z = to.sz
}

/**
 * Advance one tween by dt. External tick design: no rAF is started here, the
 * engine loop owns the clock (`tweens.update(dt)` or per-object updateTween).
 * Returns true when the tween finished on this call.
 */
export function updateTween(tw: Tween, dt: number): boolean {
  if (tw.done || !tw.target) return true
  tw.t += Math.max(0, dt)
  const k = clamp(tw.dur <= 0 ? 1 : tw.t / tw.dur, 0, 1)
  applyTween(tw, tw.ease(k))
  if (k >= 1) {
    tw.done = true
    snapToEnd(tw)
    try { tw.onDone?.() } catch (err) { console.error('[tween.onDone]', err) }
  }
  return tw.done
}

/** Batch runner: add tweens, tick all with one dt, auto-remove finished. */
export class TweenRunner {
  list: Tween[] = []

  add(
    target: TweenTarget,
    to: TweenTo,
    dur: number,
    ease: Ease = easeInOutQuad,
    onDone?: () => void
  ): Tween {
    const tf = target.transform
    const snap: Transform = {
      pos: { ...tf.pos },
      rot: { ...tf.rot },
      scale: { ...tf.scale }
    }
    const tw: Tween = { target, from: snap, to, dur: Math.max(0, dur), t: 0, ease, onDone, done: false }
    this.list.push(tw)
    return tw
  }

  /** Tick everything. Exact final values are applied on completion. */
  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (updateTween(this.list[i], dt)) this.list.splice(i, 1)
    }
  }

  /** Abort one tween (onDone is NOT called). */
  cancel(tw: Tween) {
    tw.target = null
    tw.done = true
    const i = this.list.indexOf(tw)
    if (i >= 0) this.list.splice(i, 1)
  }

  /** Abort everything. */
  clear() {
    for (const tw of this.list) { tw.target = null; tw.done = true }
    this.list.length = 0
  }

  get active(): number {
    return this.list.length
  }
}

/** Shared singleton the engine loop ticks. */
export const tweens = new TweenRunner()

/**
 * Convenience wrapper that registers on the shared runner and returns only a
 * `{ cancel }` handle. Remember to call `tweens.update(dt)` once per frame.
 * animate(ship, { y: 4, ry: Math.PI * 2 }, 0.8, easing.easeOutBack, onDone)
 */
export function runTween(
  target: TweenTarget,
  to: TweenTo,
  dur: number,
  ease?: Ease,
  onDone?: () => void
): { cancel(): void } {
  const tw = tweens.add(target, to, dur, ease ?? easeInOutQuad, onDone)
  return { cancel: () => tweens.cancel(tw) }
}

export default tweens
