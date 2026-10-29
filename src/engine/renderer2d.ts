/* ============ Nova Engine — 2D renderer (Canvas2D, y-up world) ============ */

import { getComp, type Entity, type Scene } from './core'
import { spriteCanvas } from './sprites'

export interface Cam2D { x: number; y: number; zoom: number; shakeX: number; shakeY: number }

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; grav: number }

const MAX_P = 2000
const DEGR = Math.PI / 180
const MAX_STAT_RES = 2400 // static-layer offscreen cap (device px per axis)

/** world -> screen (shared by the renderer and the offscreen static layer) */
function project(cam: Cam2D, cw: number, ch: number, wx: number, wy: number): [number, number] {
  return [cw / 2 + (wx - cam.x) * cam.zoom + cam.shakeX, ch / 2 - (wy - cam.y) * cam.zoom + cam.shakeY]
}

export class Renderer2D {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  lastDt = 0.016
  gridVisible = true
  /** visual toggles — scene.meta.vignette/.bloom/.shadows override when set */
  vignette = true
  glow = false
  spriteShadows = false
  smoothShake = true
  private freeP: Particle[] = []   // object pool (no per-frame allocation)
  private active: Particle[] = []
  private t = 0
  private shX = 0
  private shY = 0
  private scam: Cam2D = { x: 0, y: 0, zoom: 1, shakeX: 0, shakeY: 0 } // smoothed cam copy
  private bgGrad: CanvasGradient | null = null
  private bgKey = ''
  private vigGrad: CanvasGradient | null = null
  private vigKey = ''
  private glowCache = new Map<string, HTMLCanvasElement>()
  private statCv: HTMLCanvasElement | null = null
  private statCtx: CanvasRenderingContext2D | null = null
  private statStamp = ''
  private statB: { minX: number; minY: number; w: number; h: number; s: number } | null = null
  private aAll: Entity[] = []
  private aStat: Entity[] = []
  private statIds = new Set<string>()
  private statMinZ = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    for (let i = 0; i < MAX_P; i++)
      this.freeP.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 4, color: '#fff', grav: 0 })
    this.ctx.imageSmoothingEnabled = false
  }

  resize() {
    const c = this.canvas
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr)
      c.height = Math.floor(h * dpr)
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* ---------- particles (pooled) ---------- */

  private spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, grav = 0) {
    let p = this.freeP.pop()
    if (!p) p = this.active.length ? this.active.shift()! : null   // pool full: recycle oldest
    if (!p) return
    p.x = x; p.y = y; p.vx = vx; p.vy = vy
    p.life = life; p.max = life; p.size = size; p.color = color; p.grav = grav
    this.active.push(p)
  }

  /** Spawn a burst at a world position (called via runtime hook). */
  burstAt(x: number, y: number, color: string, size: number, n: number) {
    const count = Math.max(1, Math.min(500, Math.round(n)))
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 60 + Math.random() * 160
      this.spawn(
        x, y,
        Math.cos(a) * sp, Math.sin(a) * sp,
        0.4 + Math.random() * 0.3,
        size * (0.6 + Math.random() * 0.8),
        color, 140
      )
    }
  }

  updateParticles(dt: number) {
    this.lastDt = dt
    this.t += dt
    const drag = Math.pow(0.96, dt * 60) // frame-rate independent damping
    const a = this.active
    for (let i = a.length - 1; i >= 0; i--) {
      const p = a[i]
      p.life -= dt
      if (p.life <= 0) { a[i] = a[a.length - 1]; a.pop(); this.freeP.push(p); continue }
      p.vy += p.grav * dt
      p.vx *= drag; p.vy *= drag
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }

  /* ---------- camera ---------- */

  w2s(cam: Cam2D, cw: number, ch: number, wx: number, wy: number): [number, number] {
    return project(cam, cw, ch, wx, wy)
  }

  s2w(cam: Cam2D, cw: number, ch: number, sx: number, sy: number): [number, number] {
    const z = cam.zoom > 1e-4 ? cam.zoom : 1e-4
    return [
      (sx - cw / 2) / z + cam.x,
      (ch / 2 - sy) / z + cam.y
    ]
  }

  /* ---------- frame ---------- */

  draw(scene: Scene, cam: Cam2D, opts: { hud: boolean; editor: boolean; selected: string | null }) {
    const ctx = this.ctx
    const cw = this.canvas.clientWidth
    const ch = this.canvas.clientHeight
    if (cw <= 0 || ch <= 0) return
    const dpr = window.devicePixelRatio || 1
    const m = scene.meta as any

    // camera shake smoothing — touches only our copy, never the editor cam
    const k = this.smoothShake ? 0.38 : 1
    this.shX += (cam.shakeX - this.shX) * k
    this.shY += (cam.shakeY - this.shY) * k
    const sc = this.scam
    const z = cam.zoom > 1e-4 ? cam.zoom : 1e-4
    sc.x = cam.x; sc.y = cam.y; sc.zoom = z; sc.shakeX = this.shX; sc.shakeY = this.shY

    // hard reset canvas state each frame (guards against external drift / leaks)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.setLineDash([])

    // background (gradient cached per size+colors, never recreated per frame)
    ctx.fillStyle = this.bgFill(m, ch)
    ctx.fillRect(0, 0, cw, ch)
    ctx.imageSmoothingEnabled = false

    if (opts.hud) {
      this.drawHud(scene, true)
      return
    }

    if (opts.editor && this.gridVisible) this.drawGrid(sc, cw, ch)

    // classify visible non-text entities once per frame (arrays reused)
    const shadows = m.shadows != null ? !!m.shadows : this.spriteShadows
    this.aAll.length = 0
    this.aStat.length = 0
    for (const e of scene.entities) {
      if (!e.visible || getComp(e, 'text2d')) continue
      this.aAll.push(e)
      if (this.isStaticEnt(e) && getComp(e, 'sprite2d') && !getComp(e, 'script') && !getComp(e, 'parallax2d'))
        this.aStat.push(e)
    }
    this.aAll.sort((a, b) => (a.transform.pos.z || 0) - (b.transform.pos.z || 0))

    const useStat = this.aStat.length >= 6
    if (useStat) {
      this.statMinZ = Infinity
      for (const e of this.aStat) this.statMinZ = Math.min(this.statMinZ, e.transform.pos.z || 0)
    }

    if (useStat && this.maybeRenderStaticLayer(sc)) {
      // entities behind the static layer
      for (const e of this.aAll) {
        if (this.statIds.has(e.id)) continue
        if ((e.transform.pos.z || 0) < this.statMinZ) this.drawEntity(ctx, e, sc, cw, ch, dpr, shadows)
      }
      const b = this.statB!
      const [bx, by] = project(sc, cw, ch, b.minX, b.minY + b.h)
      const bw = b.w * sc.zoom, bh = b.h * sc.zoom
      if (bx < cw && by < ch && bx + bw > 0 && by + bh > 0) ctx.drawImage(this.statCv!, bx, by, bw, bh)
      for (const e of this.aAll) {
        if (this.statIds.has(e.id)) continue
        if ((e.transform.pos.z || 0) >= this.statMinZ) this.drawEntity(ctx, e, sc, cw, ch, dpr, shadows)
      }
    } else {
      for (const e of this.aAll) this.drawEntity(ctx, e, sc, cw, ch, dpr, shadows)
    }

    // world-space text (2D only)
    this.drawWorldText(scene, sc, cw, ch)

    // particles (+ optional additive bloom glow — meta.bloom/.glow override)
    const glowEff = m.bloom != null ? !!m.bloom : m.glow != null ? !!m.glow : this.glow
    this.drawParticles(sc, cw, ch, glowEff)

    // vignette (play mode only — keeps the editor clean)
    if ((m.vignette != null ? !!m.vignette : this.vignette) && !opts.editor) {
      ctx.fillStyle = this.vigFill(cw, ch)
      ctx.fillRect(0, 0, cw, ch)
    }

    // selection outline + gizmo coordinate readout
    if (opts.editor && opts.selected) {
      const e = scene.entities.find(x => x.id === opts.selected)
      if (e) this.drawSelection(e, sc, cw, ch)
    }

    // HUD: screen-space text (in 3d mode every text2d is HUD)
    this.drawHud(scene, false)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* ---------- background / vignette (cached gradients) ---------- */

  private bgFill(m: any, ch: number): string | CanvasGradient {
    if (!m.useGradient) return m.bg
    const key = `${m.bgTop}|${m.bgBottom}|${Math.ceil(ch)}`
    if (!this.bgGrad || key !== this.bgKey) {
      const gr = this.ctx.createLinearGradient(0, 0, 0, ch)
      gr.addColorStop(0, m.bgTop)
      gr.addColorStop(1, m.bgBottom)
      this.bgGrad = gr
      this.bgKey = key
    }
    return this.bgGrad
  }

  private vigFill(cw: number, ch: number): CanvasGradient {
    const key = `${Math.ceil(cw)}x${Math.ceil(ch)}`
    if (!this.vigGrad || key !== this.vigKey) {
      const R = Math.hypot(cw, ch) / 2
      const gr = this.ctx.createRadialGradient(cw / 2, ch / 2, R * 0.45, cw / 2, ch / 2, R * 0.92)
      gr.addColorStop(0, 'rgba(4,6,16,0)')
      gr.addColorStop(1, 'rgba(4,6,16,0.46)')
      this.vigGrad = gr
      this.vigKey = key
    }
    return this.vigGrad
  }

  private glowSprite(color: string): HTMLCanvasElement {
    let cv = this.glowCache.get(color)
    if (cv) return cv
    cv = document.createElement('canvas')
    cv.width = 48; cv.height = 48
    const g = cv.getContext('2d')!
    const rgb = this.rgbOf(color)
    const gr = g.createRadialGradient(24, 24, 2, 24, 24, 23)
    gr.addColorStop(0, `rgba(${rgb},0.5)`)
    gr.addColorStop(1, `rgba(${rgb},0)`)
    g.fillStyle = gr
    g.fillRect(0, 0, 48, 48)
    if (this.glowCache.size > 24) this.glowCache.delete(this.glowCache.keys().next().value as string)
    this.glowCache.set(color, cv)
    return cv
  }

  private rgbOf(c: string): string {
    if (/^#[0-9a-fA-F]{6}$/.test(c)) {
      const n = parseInt(c.slice(1), 16)
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
    }
    return '250,190,40'
  }

  /* ---------- static layer (offscreen dirty cache) ---------- */

  private isStaticEnt(e: Entity): boolean {
    const b = getComp(e, 'body2d') as any
    return !!b?.isStatic || (e as any).static === true || e.tags.includes('static')
  }

  /** returns false when the layer was invalidated (caller falls back to direct draws) */
  private maybeRenderStaticLayer(cam: Cam2D): boolean {
    let stamp = `${Math.round(this.aStat.length)}|`
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const e of this.aStat) {
      const t = e.transform
      const spr = getComp(e, 'sprite2d') as any
      const w = spr?.w || 40, h = spr?.h || 40
      stamp += `${e.id}:${t.pos.x.toFixed(1)},${t.pos.y.toFixed(1)},${(t.rot.z || 0).toFixed(2)},` +
        `${spr.sprite},${spr.seed},${spr.w},${spr.h},${spr.color}|`
      minX = Math.min(minX, t.pos.x - w / 2 - 24)
      maxX = Math.max(maxX, t.pos.x + w / 2 + 24)
      minY = Math.min(minY, t.pos.y - h / 2 - 24)
      maxY = Math.max(maxY, t.pos.y + h / 2 + 24)
    }
    if (minX === Infinity) return false
    const w = Math.ceil((maxX - minX) / 8) * 8
    const h = Math.ceil((maxY - minY) / 8) * 8
    const s = Math.min(1, MAX_STAT_RES / Math.max(w, h))
    if (stamp !== this.statStamp || !this.statCv) {
      const pw = Math.max(1, Math.ceil(w * s))
      const ph = Math.max(1, Math.ceil(h * s))
      if (!this.statCv || this.statCv.width !== pw || this.statCv.height !== ph) {
        this.statCv = document.createElement('canvas')
        this.statCv.width = pw; this.statCv.height = ph
        this.statCtx = this.statCv.getContext('2d')
      }
      const c2 = this.statCtx!
      c2.setTransform(1, 0, 0, 1, 0, 0)
      c2.clearRect(0, 0, pw, ph)
      c2.imageSmoothingEnabled = false
      const wcam: Cam2D = { x: minX + w / 2, y: minY + h / 2, zoom: s, shakeX: 0, shakeY: 0 }
      for (const e of this.aStat) this.drawEntity(c2, e, wcam, pw, ph, 1, false)
      this.statStamp = stamp
    }
    this.statB = { minX, minY, w, h, s }
    this.statIds.clear()
    for (const e of this.aStat) this.statIds.add(e.id)
    return true
  }

  /* ---------- entities ---------- */

  private drawEntity(
    ctx: CanvasRenderingContext2D, e: Entity, cam: Cam2D, cw: number, ch: number,
    px: number, shadows: boolean
  ) {
    const spr = getComp(e, 'sprite2d') as any
    const part = getComp(e, 'particles2d') as any
    if (part && part.rate > 0 && ctx === this.ctx) this.emitFrom(e, part)
    if (!spr) return

    // parallax2d: {factor 0..1 (1 = normal world), repeat:'x'|'y'} — defensively supported
    const par = getComp(e, 'parallax2d') as any
    let wx = e.transform.pos.x, wy = e.transform.pos.y
    if (par) {
      const f = Math.max(0, Math.min(1, Number(par.factor) || 0))
      wx += cam.x * (1 - f)
      wy += cam.y * (1 - f)
    }
    const [sx, sy] = project(cam, cw, ch, wx, wy)
    const w = spr.w * cam.zoom
    const h = spr.h * cam.zoom
    // cheap screen-space cull (skip when tiled, tiles self-cull)
    if (!par || !par.repeat) {
      const r = Math.max(w, h) / 2 + 48
      if (sx < -r || sx > cw + r || sy < -r || sy > ch + r) return
    }

    const rot = e.transform.rot.z || 0
    const ang = -rot * DEGR
    const c = Math.cos(ang), s = Math.sin(ang)

    // 2-frame walk anim: explicit frame prop wins, else spr.anim drives a phase
    const fr = Number.isFinite(spr.frame)
      ? Math.abs(spr.frame | 0)
      : (spr.anim ? Math.floor(this.t * Math.min(6, Number(spr.anim) || 3)) % 2 : 0)

    if (shadows) {
      ctx.shadowColor = 'rgba(8,10,22,0.42)'
      ctx.shadowBlur = Math.min(14, 6 * cam.zoom)
      ctx.shadowOffsetY = 4
    }

    const singles: number[] = [0]
    if (par && par.repeat === 'x') { singles.length = 0; singles.push(-2, -1, 0, 1, 2) }
    if (par && par.repeat === 'y') { singles.length = 0; singles.push(-2, -1, 0, 1, 2) }
    const tileW = Math.max(1, w)
    const tileH = Math.max(1, h)
    const repX = par?.repeat === 'x'
    const repY = par?.repeat === 'y'

    if (spr.sprite && spr.sprite !== 'none') {
      const img = spriteCanvas(spr.sprite, spr.seed || 1, 16, fr)
      for (const i of singles) {
        const ox = repX ? i * tileW : 0
        const oy = repY ? i * tileH : 0
        ctx.setTransform(px * c, px * s, -px * s, px * c, px * (sx + ox), px * (sy + oy))
        ctx.drawImage(img, -w / 2, -h / 2, w, h)
      }
    } else {
      ctx.fillStyle = spr.color
      const shape = spr.shape || 'box'
      for (const i of singles) {
        const ox = repX ? i * tileW : 0
        const oy = repY ? i * tileH : 0
        ctx.setTransform(px * c, px * s, -px * s, px * c, px * (sx + ox), px * (sy + oy))
        if (shape === 'circle') {
          ctx.beginPath(); ctx.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2); ctx.fill()
        } else if (shape === 'triangle') {
          ctx.beginPath(); ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2); ctx.closePath(); ctx.fill()
        } else {
          ctx.fillRect(-w / 2, -h / 2, w, h)
        }
      }
    }
    ctx.shadowColor = 'rgba(0,0,0,0)'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
  }

  /** continuous emission honoring rate/spread/gravity (spawn many per frame) */
  private emitFrom(e: Entity, part: any) {
    const acc = ((e as any).__pacc || 0) + part.rate * this.lastDt
    let n = Math.floor(acc)
    ;(e as any).__pacc = acc - n
    if (n < 1) return
    if (n > 32) n = 32
    const spread = Number(part.spread ?? part.spreadDeg ?? 360) || 0
    const radial = spread >= 355
    for (let i = 0; i < n; i++) {
      const sp = (part.speed || 90) * (0.6 + Math.random() * 0.8)
      const a = radial
        ? Math.random() * Math.PI * 2
        : (Math.PI / 2) + (Math.random() - 0.5) * spread * DEGR // cone around "up"
      this.spawn(
        e.transform.pos.x, e.transform.pos.y,
        Math.cos(a) * sp, Math.sin(a) * sp,
        part.life || 0.6,
        part.size || 5,
        part.color || '#fbbf24',
        Number(part.gravity ?? 0)
      )
    }
  }

  /* ---------- text ---------- */

  private drawWorldText(scene: Scene, sc: Cam2D, cw: number, ch: number) {
    const ctx = this.ctx
    for (const e of scene.entities) {
      if (!e.visible) continue
      const t = getComp(e, 'text2d') as any
      if (!t || t.screen) continue
      const [sx, sy] = project(sc, cw, ch, e.transform.pos.x, e.transform.pos.y)
      this.drawText(ctx, String(t.text), sx, sy, t.size * sc.zoom, t.color, t)
    }
  }

  private drawHud(scene: Scene, hud: boolean) {
    const ctx = this.ctx
    for (const e of scene.entities) {
      if (!e.visible) continue
      const t = getComp(e, 'text2d') as any
      if (!t) continue
      if (t.screen || hud) this.drawText(ctx, String(t.text), e.transform.pos.x, e.transform.pos.y, t.size, t.color, t)
    }
    ctx.textAlign = 'left'
  }

  private drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, o?: any) {
    ctx.font = `${o?.bold ? 700 : 600} ${Math.max(4, size)}px ${o?.font || "'Segoe UI', 'Inter', system-ui, sans-serif"}`
    ctx.textAlign = o?.align === 'center' ? 'center' : o?.align === 'right' ? 'right' : 'left'
    ctx.textBaseline = 'top'
    if (o?.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = size * 0.2
      ctx.shadowOffsetY = size * 0.07
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0)'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
    }
    if (o?.outline) {
      ctx.strokeStyle = o.outline === true ? '#000000' : String(o.outline)
      ctx.lineWidth = Math.max(2, size * 0.09)
      ctx.lineJoin = 'round'
      ctx.strokeText(text, x, y)
    }
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
    ctx.shadowColor = 'rgba(0,0,0,0)'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
  }

  /* ---------- grid: sub-grid + axis + ruler ticks ---------- */

  private drawGrid(cam: Cam2D, cw: number, ch: number) {
    const ctx = this.ctx
    const step = 50 * cam.zoom
    if (step < 10) return
    const ox = cw / 2 - cam.x * cam.zoom
    const oy = ch / 2 + cam.y * cam.zoom
    const startX = ((ox % step) + step) % step
    const startY = ((oy % step) + step) % step

    ctx.lineWidth = 1
    if (step >= 45) { // sub-grid: 5 divisions per cell
      const s2 = step / 5
      const sx2 = ((ox % s2) + s2) % s2
      const sy2 = ((oy % s2) + s2) % s2
      ctx.strokeStyle = 'rgba(255,255,255,0.02)'
      ctx.beginPath()
      for (let x = sx2; x < cw; x += s2) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ch) }
      for (let y = sy2; y < ch; y += s2) { ctx.moveTo(0, y + 0.5); ctx.lineTo(cw, y + 0.5) }
      ctx.stroke()
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.beginPath()
    for (let x = startX; x < cw; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ch) }
    for (let y = startY; y < ch; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(cw, y + 0.5) }
    ctx.stroke()

    // axes
    ctx.strokeStyle = 'rgba(124,92,255,0.3)'
    ctx.beginPath()
    ctx.moveTo(ox + 0.5, 0); ctx.lineTo(ox + 0.5, ch)
    ctx.moveTo(0, oy + 0.5); ctx.lineTo(cw, oy + 0.5)
    ctx.stroke()

    // ruler ticks + world-coordinate labels along the axes
    if (step >= 26) {
      ctx.fillStyle = 'rgba(148,163,184,0.55)'
      ctx.font = '9px Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (let x = startX; x < cw; x += step) {
        const wv = (x - ox) / cam.zoom
        if (Math.abs(wv) > 0.5) ctx.fillText(String(Math.round(wv)), x, oy + 10)
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (let y = startY; y < ch; y += step) {
        const wv = (oy - y) / cam.zoom
        if (Math.abs(wv) > 0.5) ctx.fillText(String(Math.round(wv)), ox + 8, y)
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
    }
  }

  /* ---------- particles ---------- */

  private drawParticles(cam: Cam2D, cw: number, ch: number, glow: boolean) {
    const ctx = this.ctx
    const z = cam.zoom
    if (glow) {
      ctx.globalCompositeOperation = 'lighter'
      for (const p of this.active) {
        const gs = this.glowSprite(p.color)
        const gs0 = Math.min(480, p.size * 7 * z)
        const [gx2, gy2] = project(cam, cw, ch, p.x, p.y)
        ctx.globalAlpha = Math.max(0, Math.min(1, (p.life / p.max) * 0.9))
        ctx.drawImage(gs, gx2 - gs0 / 2, gy2 - gs0 / 2, gs0, gs0)
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
    for (const p of this.active) {
      const [sx, sy] = project(cam, cw, ch, p.x, p.y)
      if (sx < -32 || sx > cw + 32 || sy < -32 || sy > ch + 32) continue
      ctx.globalAlpha = Math.max(0, p.life / p.max)
      ctx.fillStyle = p.color
      const s = Math.max(1, p.size * z)
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s)
    }
    ctx.globalAlpha = 1
  }

  /* ---------- selection ---------- */

  private drawSelection(e: Entity, cam: Cam2D, cw: number, ch: number) {
    const ctx = this.ctx
    const b = getComp(e, 'body2d') as any
    const s = getComp(e, 'sprite2d') as any
    const w0 = b?.w || s?.w || 40
    const h0 = b?.h || s?.h || 40
    const w = w0 * cam.zoom
    const h = h0 * cam.zoom
    const [sx, sy] = project(cam, cw, ch, e.transform.pos.x, e.transform.pos.y)

    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 3
    ctx.setLineDash([])
    ctx.strokeRect(sx - w / 2 - 3, sy - h / 2 - 3, w + 6, h + 6)
    ctx.strokeStyle = '#f0abfc'
    ctx.lineWidth = 1.5
    ctx.setLineDash([7, 5])
    ctx.lineDashOffset = -(this.t * 26) % 12 // animated marching dashes
    ctx.strokeRect(sx - w / 2 - 2, sy - h / 2 - 2, w + 4, h + 4)
    ctx.setLineDash([])

    ctx.fillStyle = '#f0abfc'
    for (const [hx, hy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
      ctx.fillRect(sx + hx * w / 2 - 3, sy + hy * h / 2 - 3, 6, 6)

    // gizmo coordinate readout
    ctx.font = '10px Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    ctx.fillText(
      `${Math.round(e.transform.pos.x)}, ${Math.round(e.transform.pos.y)}  ·  ${Math.round(w0)}×${Math.round(h0)}`,
      sx + 1, sy - h / 2 - 8
    )
    ctx.fillStyle = 'rgba(240,171,252,0.95)'
    ctx.fillText(
      `${Math.round(e.transform.pos.x)}, ${Math.round(e.transform.pos.y)}  ·  ${Math.round(w0)}×${Math.round(h0)}`,
      sx, sy - h / 2 - 9
    )
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
  }
}
