/* ============ Nova Engine — Procedural pixel-art sprite generator ============ */

import { mulberry32, hashStr } from './core'

export type SpriteImage = { w: number; h: number; data: Uint8ClampedArray }

const P = {
  player: ['#ffd166', '#ef476f', '#f8f9fa', '#118ab2'],
  coin: ['#ffd700', '#ffb703', '#fff3c4', '#b8860b'],
  gem: ['#22d3ee', '#a78bfa', '#e0f2fe', '#0e7490'],
  enemy: ['#ef4444', '#7f1d1d', '#fca5a5', '#1f2937'],
  ship: ['#22d3ee', '#e2e8f0', '#6366f1', '#0ea5e9'],
  ufo: ['#a3e635', '#65a30d', '#e2e8f0', '#84cc16'],
  alien: ['#a78bfa', '#7c3aed', '#f0abfc', '#ddd6fe'],
  crate: ['#b45309', '#78350f', '#d97706', '#fbbf24'],
  orb: ['#f472b6', '#fb7185', '#ffe4e6', '#e11d48'],
  cloud: ['#e2e8f0', '#f8fafc', '#cbd5e1', '#94a3b8'],
  tree: ['#16a34a', '#15803d', '#a16207', '#22c55e'],
  star: ['#fde047', '#facc15', '#fffbeb', '#f59e0b'],
  brick: ['#6b7280', '#4b5563', '#9ca3af', '#374151'],
  /* extra categories (used defensively if the catalog grows) */
  pipe: ['#22c55e', '#15803d', '#4ade80', '#065f46'],
  spike: ['#94a3b8', '#64748b', '#cbd5e1', '#334155'],
  lava: ['#f97316', '#dc2626', '#fde047', '#7c2d12'],
  rock: ['#78716c', '#57534e', '#a8a29e', '#292524'],
  stone: ['#9ca3af', '#6b7280', '#d1d5db', '#374151'],
  bush: ['#15803d', '#166534', '#22c55e', '#14532d'],
  flower: ['#f472b6', '#ec4899', '#fde68a', '#9d174d'],
  heart: ['#ef4444', '#f87171', '#fecaca', '#b91c1c'],
  key: ['#fbbf24', '#d97706', '#fef08a', '#92400e'],
  bomb: ['#334155', '#1e293b', '#64748b', '#ef4444'],
  shield: ['#60a5fa', '#2563eb', '#93c5fd', '#1e3a8a'],
  potion: ['#a78bfa', '#7c3aed', '#f0abfc', '#4c1d95'],
  door: ['#b45309', '#92400e', '#d97706', '#451a03'],
  torch: ['#f59e0b', '#dc2626', '#fbbf24', '#78350f'],
  ghost: ['#e2e8f0', '#cbd5e1', '#f8fafc', '#94a3b8'],
  bat: ['#6b21a8', '#4c1d95', '#a78bfa', '#2e1065'],
  slime: ['#34d399', '#10b981', '#a7f3d0', '#065f46'],
  boss: ['#dc2626', '#7f1d1d', '#f87171', '#111827'],
  arrow: ['#d6d3d1', '#a8a29e', '#f5f5f4', '#57534e'],
  grass: ['#4ade80', '#16a34a', '#86efac', '#14532d'],
  flag: ['#ef4444', '#f8fafc', '#fca5a5', '#7f1d1d'],
  ring: ['#fbbf24', '#b45309', '#fde68a', '#78350f'],
  none: ['#7c5cff', '#5b8def', '#c4b5fd', '#818cf8']
} as Record<string, string[]>

const SHINY = new Set(['coin', 'gem', 'star', 'orb', 'heart', 'key', 'potion', 'ring'])

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/* mask(x,y) -> true if pixel is inside the sprite shape */
function maskFor(cat: string): (x: number, y: number) => boolean {
  const circle = (cx: number, cy: number, r: number) => (x: number, y: number) =>
    (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r
  const ell = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

  switch (cat) {
    case 'player': return (x, y) => {
      if (y <= 5) return ell(7.5, 3, 3.4, 3.2)(x, y)
      if (y <= 11) return x >= 3 && x <= 12
      return (x >= 4 && x <= 6) || (x >= 9 && x <= 11)
    }
    case 'coin': return circle(7.5, 7.5, 6.2)
    case 'gem': return (x, y) => Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 6.4
    case 'enemy': return (x, y) => {
      if (y <= 13 && y >= 3) {
        const ry = y <= 4 || y >= 12 ? 4.4 : 5.4
        if (ell(7.5, 8, 5.6, ry)(x, y)) return true
      }
      return y === 14 && (x >= 3 && x <= 5 || x >= 10 && x <= 12)
    }
    case 'ship': return (x, y) => {
      if (y < 1 || y > 14) return false
      const half = 1 + Math.floor((y - 1) * 0.55)
      return Math.abs(x - 7.5) <= half
    }
    case 'ufo': return (x, y) => {
      if (y >= 2 && y <= 6) return ell(7.5, 4.5, 4.4, 2.6)(x, y)
      return y >= 7 && y <= 11 && x >= 1 && x <= 14
    }
    case 'alien': return (x, y) => {
      if (y <= 1) return x === 4 || x === 11
      if (y === 2) return x === 4 || x === 5 || x === 10 || x === 11
      return ell(7.5, 7.5, 5, 5.2)(x, y) && y >= 3
    }
    case 'crate': return (x, y) => x >= 1 && y >= 1 && x <= 14 && y <= 14
    case 'orb': return circle(7.5, 7.5, 6.8)
    case 'cloud': return (x, y) =>
      ell(4.5, 9.5, 3.6, 2.4)(x, y) || ell(8, 8, 4.2, 3)(x, y) || ell(11.5, 9.5, 3.6, 2.4)(x, y)
    case 'tree': return (x, y) => {
      if (y >= 9 && x >= 6 && x <= 9) return true
      return circle(7.5, 5.5, 4.6)(x, y) || circle(5.5, 7, 3)(x, y) || circle(9.5, 7, 3)(x, y)
    }
    case 'star': return (x, y) => {
      const dx = x - 7.5, dy = y - 7.5
      const r = Math.sqrt(dx * dx + dy * dy)
      const th = Math.atan2(dy, dx)
      const rr = 3.2 + 3.4 * Math.cos(5 * th)
      return r <= rr
    }
    case 'brick': return (x, y) => x >= 1 && y >= 2 && x <= 14 && y <= 13
    /* extra shapes */
    case 'pipe': return (x, y) =>
      y <= 2 ? x >= 3 && x <= 12 : y >= 3 && y <= 14 && x >= 4 && x <= 11
    case 'spike': return (x, y) => y <= 13 && Math.abs(x - 7.5) <= 0.9 + y * 0.5
    case 'lava': return (x, y) => y >= 4 + Math.sin(x * 0.85) * 1.7
    case 'rock': return (x, y) =>
      circle(7.5, 9, 6)(x, y) || circle(4.5, 7, 3.2)(x, y) || circle(10.5, 7, 3.2)(x, y) ||
      (y >= 12 && x >= 4 && x <= 11)
    case 'stone': return (x, y) =>
      circle(7.5, 9.5, 5.4)(x, y) || (y >= 4 && y <= 6 && x >= 4 && x <= 11)
    case 'bush': return (x, y) =>
      circle(4.5, 10.5, 3.4)(x, y) || circle(7.5, 8.5, 4.2)(x, y) || circle(10.5, 10.5, 3.4)(x, y)
    case 'flower': return (x, y) =>
      circle(7.5, 5.5, 3.6)(x, y) || (y >= 8 && x >= 7 && x <= 8) ||
      circle(5.5, 10.5, 1.7)(x, y) || circle(9.5, 11.5, 1.7)(x, y)
    case 'heart': return (x, y) =>
      (y <= 5 && (circle(5, 4.5, 3.6)(x, y) || circle(10, 4.5, 3.6)(x, y))) ||
      (y >= 5 && Math.abs(x - 7.5) <= (15 - y) * 0.95)
    case 'key': return (x, y) => {
      const d = Math.sqrt((x - 6) ** 2 + (y - 5) ** 2)
      return (d <= 4.2 && d >= 2) || (y >= 9 && y <= 11 && x >= 7 && x <= 14) ||
        (x === 11 && y >= 12 && y <= 14) || (x === 13 && y >= 12 && y <= 13)
    }
    case 'bomb': return (x, y) =>
      circle(7.5, 9.5, 5.5)(x, y) || (x >= 9 && x <= 11 && y >= 2 && y <= 5) || (x === 10 && y === 1)
    case 'shield': return (x, y) =>
      y <= 3 ? x >= 2 && x <= 13
        : y <= 9 ? Math.abs(x - 7.5) <= 5.5 - (y - 3) * 0.35
        : Math.abs(x - 7.5) <= (15 - y) * 0.6
    case 'potion': return (x, y) =>
      (y >= 1 && y <= 4 && x >= 6 && x <= 9) || (y >= 4 && circle(7.5, 9.5, 5)(x, y))
    case 'door': return (x, y) =>
      (y <= 4 && ell(7.5, 4, 4.8, 4.2)(x, y)) || (y >= 5 && x >= 2 && x <= 13)
    case 'torch': return (x, y) =>
      (x >= 7 && x <= 8 && y >= 8) || (y >= 2 && y <= 8 && circle(7.5, 5, 3.4)(x, y)) ||
      ((x === 7 || x === 8) && y === 1)
    case 'ghost': return (x, y) =>
      y <= 10 ? ell(7.5, 6, 5.2, 5.2)(x, y) : y <= 14 && x % 2 === 0
    case 'bat': return (x, y) => {
      if (ell(7.5, 7, 2.7, 3.4)(x, y)) return true
      if (y >= 4 && y <= 8 && x >= 1 && x <= 5) return y >= 4 + (5 - x) * 0.55
      if (y >= 4 && y <= 8 && x >= 10 && x <= 14) return y >= 4 + (x - 10) * 0.55
      return false
    }
    case 'slime': return (x, y) => ell(7.5, 10, 6, 4.6)(x, y) && y >= 4 && y <= 14
    case 'boss': return (x, y) =>
      (y >= 3 && y <= 13 && x >= 2 && x <= 13) ||
      (y >= 1 && y <= 2 && ((x >= 3 && x <= 5) || (x >= 10 && x <= 12)))
    case 'arrow': return (x, y) =>
      (y >= 7 && y <= 8 && x >= 2 && x <= 13) ||
      (x >= 11 && Math.abs(y - 7.5) <= (14 - x) * 0.9) ||
      (x <= 4 && y >= 6 && y <= 9)
    case 'grass': return (x, y) => y >= 6 + ((x * 53) % 7) && x >= 1 && x <= 14
    case 'flag': return (x, y) =>
      (x >= 3 && x <= 4) ||
      (x >= 5 && x <= 13 && y >= 1 && y <= 6 && Math.abs(y - 3.5) <= (13 - x) * 0.42)
    case 'ring': return (x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5)
      return d >= 3.4 && d <= 6.6
    }
    default: return (x, y) => x >= 1 && y >= 1 && x <= 14 && y <= 14
  }
}

/* LRU canvas cache — hottest sprites stay hot, cold ones get evicted */
const CACHE_MAX = 384
const cache = new Map<string, HTMLCanvasElement>()

/* move pixel (x,y) -> (nx,ny) for the 2-frame walk cycle */
function swapCell(g: number[][], y: number, x: number, ny: number, nx: number) {
  const n = g.length
  if (y < 0 || ny < 0 || x < 0 || nx < 0 || y >= n || ny >= n || x >= n || nx >= n) return
  const v = g[y][x]
  if (v <= -1) return
  g[ny][nx] = v
  g[y][x] = -1
}

/** frame=1 nudges legs/limbs — pairs with sprite2d.frame for cheap walk anims */
function applyFrame(cat: string, frame: number, g: number[][]) {
  if (!frame) return
  switch (cat) {
    case 'player': swapCell(g, 14, 4, 13, 4); swapCell(g, 13, 10, 14, 10); break
    case 'enemy': swapCell(g, 14, 3, 13, 3); swapCell(g, 14, 12, 13, 12); break
    case 'alien': swapCell(g, 1, 4, 1, 5); swapCell(g, 1, 11, 1, 10); break
    case 'ship': swapCell(g, 4, 7, 5, 7); swapCell(g, 4, 8, 5, 8); break
    case 'ufo': swapCell(g, 9, 4, 9, 5); swapCell(g, 9, 11, 9, 10); break
    case 'ghost': swapCell(g, 11, 2, 11, 3); swapCell(g, 12, 12, 12, 11); break
    case 'slime': swapCell(g, 13, 3, 12, 3); swapCell(g, 13, 12, 12, 12); break
    case 'torch': swapCell(g, 3, 7, 2, 7); break
  }
}

export function spriteCanvas(category: string, seed: number, size = 16, frame = 0): HTMLCanvasElement {
  const key = `${category}|${seed}|${frame}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }   // refresh LRU order

  const cat = P[category] ? category : 'none'
  const rnd = mulberry32(hashStr(key) ^ 0x9e3779b9)
  const pal = P[cat]
  const inMask = maskFor(cat)
  const n = size
  const img = new SpriteImageLite(n, n)

  const cols = pal.map(hex)
  const b = (seed % 7) / 70 // tiny per-seed palette bias so seeds look distinct
  const pick = () => {
    const r = rnd()
    return r < 0.5 + b ? cols[0] : r < 0.82 - b ? cols[1] : r < 0.94 ? cols[2] : cols[3]
  }

  const grid: number[][] = []
  for (let y = 0; y < n; y++) {
    grid[y] = []
    for (let x = 0; x < n; x++) {
      if (!inMask(x, y)) { grid[y][x] = -1; continue }
      grid[y][x] = Math.floor(rnd() * 4)
    }
  }

  // special details per category
  if (cat === 'enemy' || cat === 'alien') {
    const dark = cols[3]
    grid[7][5] = -2; grid[7][10] = -2 // eyes (custom value)
  }
  if (cat === 'ghost' || cat === 'boss') { grid[6][5] = -2; grid[6][10] = -2 }
  if (cat === 'bat' || cat === 'slime') { grid[8][6] = -2; grid[8][9] = -2 }
  if (cat === 'crate') {
    for (let i = 1; i <= 14; i++) { grid[i][1] = 3; grid[i][14] = 3; grid[1][i] = 3; grid[14][i] = 3 }
    for (let i = 3; i <= 12; i++) { grid[i][i] = 3; grid[i][15 - i] = 3 }
  }
  if (cat === 'ship' && n > 8) { grid[3][7] = 2; grid[3][8] = 2; grid[4][7] = 2; grid[4][8] = 2 }
  if (cat === 'ufo') for (let x = 3; x <= 12; x += 2) if (grid[9][x] !== -1) grid[9][x] = 3
  if (cat === 'orb') { grid[5][5] = 2; grid[5][6] = 2; grid[6][5] = 2 }
  if (cat === 'brick') {
    for (let x = 0; x < n; x++) { grid[5][x] = 3; grid[9][x] = 3 }
    for (let y = 0; y < n; y++) { grid[y][5] = 3; grid[y][10] = 3 }
  }
  if (SHINY.has(cat)) for (let i = 0; i < 3; i++) { // sparkle highlights, seed-driven
    const gx = 3 + ((seed >> (i * 3)) % 10)
    const gy = 3 + ((seed >> (i * 3 + 5)) % 10)
    if (grid[gy][gx] > -1) grid[gy][gx] = 2
  }
  applyFrame(cat, frame, grid)

  const darker = (c: [number, number, number]): [number, number, number] =>
    [Math.floor(c[0] * 0.62), Math.floor(c[1] * 0.62), Math.floor(c[2] * 0.62)]

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = grid[y][x]
      if (v === -1) continue
      let c: [number, number, number]
      if (v === -2) c = [15, 15, 25]
      else {
        c = cols[v]
        const edge =
          (y === 0 || grid[y - 1][x] === -1) ||
          (y === n - 1 || grid[y + 1][x] === -1) ||
          (x === 0 || grid[y][x - 1] === -1) ||
          (x === n - 1 || grid[y][x + 1] === -1)
        if (edge) c = darker(c)
      }
      img.set(x, y, c[0], c[1], c[2], 255)
    }
  }

  const cv = document.createElement('canvas')
  cv.width = n; cv.height = n
  const ctx = cv.getContext('2d')!
  const id = new ImageData(img.data as any, n, n)
  ctx.putImageData(id, 0, 0)
  cache.set(key, cv)
  if (cache.size > CACHE_MAX) { // LRU evict oldest
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return cv
}

class SpriteImageLite {
  data: Uint8ClampedArray
  constructor(public w: number, public h: number) {
    this.data = new Uint8ClampedArray(w * h * 4)
  }
  set(x: number, y: number, r: number, g: number, b: number, a: number) {
    const i = (y * this.w + x) * 4
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a
  }
}

export type SpriteImageFull = SpriteImage
