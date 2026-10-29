/* ============ Nova Engine — AI Builder & Assistant (real LLM integration) ============
   • Robust JSON extraction from LLM output (fences / comments / trailing commas /
     truncated tail repair) + retry-once with a "JSON only" reminder
   • Spec hardening: clamp sizes, dedupe entity names, repair invalid scripts,
     auto-patch player/floor/walls/camera/score so EVERY generated game is playable
   • Difficulty (easy/normal/hard) + multi-level awareness parsed from the prompt
   • Offline DEFAULT_SCRIPTS + template fallback used when no LLM is reachable */

import type { SceneSpec, EntitySpec } from '../../engine/spec'
import { validateSpec } from '../../engine/spec'
import { COMP_DEFS } from '../../engine/components'
import { chatComplete, aiConfigured, normalizeSettings, AIError, type AISettings } from './providers'
import {
  platform, coinArc2D, enemyPatrol, cloud, crate2D, movingPlatform,
  hudText, hint2D, goalFlag2D, borderWalls2D, playerEntity2D,
  playerEntity3D, floorBlock3D, hudGem3D,
  type SeedFn
} from '../blank'

/* ================================================================
   1. DEFAULT SCRIPTS LIBRARY (offline fallbacks, also reused by templates)
   Kept in sync with the copies used by blank scenes.
   ================================================================ */

export const CONTROLLER_2D = `// NOVA-AI default platformer controller | speed: 260 | jump: 640
var SPEED = 260, JUMP = 640, COYOTE = 0.10, BUFFER = 0.12
if (self.mem.isInit === undefined) { self.mem.isInit = 1; self.mem.coyote = 0; self.mem.buffer = 0 }
var onG = self.onGround
if (onG) self.mem.coyote = COYOTE
else self.mem.coyote = Math.max(0, self.mem.coyote - engine.dt)
if (engine.input.pressed("Space") || engine.input.pressed("KeyW") || engine.input.pressed("ArrowUp")) self.mem.buffer = BUFFER
else self.mem.buffer = Math.max(0, self.mem.buffer - engine.dt)
var L = engine.input.down("KeyA") || engine.input.down("ArrowLeft")
var R = engine.input.down("KeyD") || engine.input.down("ArrowRight")
if (L && !R) self.vel.x = -SPEED
else if (R && !L) self.vel.x = SPEED
else if (onG) self.vel.x = 0
if (self.mem.buffer > 0 && self.mem.coyote > 0) {
  self.vel.y = JUMP
  self.mem.buffer = 0
  self.mem.coyote = 0
  self.burst(8)
}
var holdJump = engine.input.down("Space") || engine.input.down("KeyW") || engine.input.down("ArrowUp")
if (!holdJump && self.vel.y > 200) self.vel.y = 200
if (self.vel.y < -1000) self.vel.y = -1000
if (self.pos.y < -400) engine.gameOver("You fell off the level!")`

export const CONTROLLER_3D = `// NOVA-AI default 3D controller | speed: 7.5 | jump: 9.4
var SPEED = 7.5, JUMP = 9.4
var yaw = engine.camera.yaw
var fx = Math.sin(yaw), fz = Math.cos(yaw)
var rx = -Math.cos(yaw), rz = Math.sin(yaw)
var f = 0, r = 0
if (engine.input.down("KeyW") || engine.input.down("ArrowUp")) f += 1
if (engine.input.down("KeyS") || engine.input.down("ArrowDown")) f -= 1
if (engine.input.down("KeyD") || engine.input.down("ArrowRight")) r += 1
if (engine.input.down("KeyA") || engine.input.down("ArrowLeft")) r -= 1
var sp = SPEED
if (engine.input.down("ShiftLeft") || engine.input.down("ShiftRight")) sp *= 1.55
var mx = fx * f + rx * r, mz = fz * f + rz * r
var l = Math.sqrt(mx * mx + mz * mz)
if (l > 0) { mx /= l; mz /= l }
self.vel.x = mx * sp
self.vel.z = mz * sp
if (engine.input.pressed("Space") && self.onGround) {
  self.vel.y = JUMP
  self.burst(6)
}
if (self.pos.y < -30) { self.pos.x = 0; self.pos.y = 1.4; self.pos.z = 0; self.vel.y = 0 }`

export const FLAPPY_2D = `// NOVA-AI default flappy controller | speed: 0 | jump: 420
var FLAP = 420
self.vel.x = 0
if (engine.input.pressed("Space") || engine.input.pressed("KeyW") || engine.input.pressed("ArrowUp")) {
  self.vel.y = FLAP
  self.burst(5)
}
if (self.pos.y > 330) self.pos.y = 330
self.rot.z = Math.max(-32, Math.min(24, self.vel.y * 0.08))
if (self.pos.y < -320) engine.gameOver("Grounded!")`

export const RUNNER_2D = `// NOVA-AI default runner controller | speed: 300 | jump: 680
var SPEED = 300, JUMP = 680, COYOTE = 0.12
if (self.mem.coyote === undefined) self.mem.coyote = 0
var onG = self.onGround
if (onG) self.mem.coyote = COYOTE
else self.mem.coyote = Math.max(0, self.mem.coyote - engine.dt)
self.vel.x = onG ? SPEED : Math.max(SPEED * 0.9, self.vel.x)
if (engine.input.pressed("Space") || engine.input.pressed("KeyW") || engine.input.pressed("ArrowUp")) {
  if (onG || self.mem.coyote > 0) {
    self.vel.y = JUMP
    self.mem.coyote = 0
    self.burst(6)
  }
}
var holdJump = engine.input.down("Space") || engine.input.down("KeyW")
if (!holdJump && self.vel.y > 240) self.vel.y = 240
if (self.pos.y < -360) engine.gameOver("Wiped out!")`

export const SHOOTER_2D = `// NOVA-AI default top-down shooter controller | speed: 260 | fire: 0.20
var SPEED = 260, COOLDOWN = 0.20
self.mem.cd = Math.max(0, (self.mem.cd || 0) - engine.dt)
var dx = 0, dy = 0
if (engine.input.down("KeyA") || engine.input.down("ArrowLeft")) dx -= 1
if (engine.input.down("KeyD") || engine.input.down("ArrowRight")) dx += 1
if (engine.input.down("KeyW") || engine.input.down("ArrowUp")) dy -= 1
if (engine.input.down("KeyS") || engine.input.down("ArrowDown")) dy += 1
var l = Math.sqrt(dx * dx + dy * dy)
if (l > 0) { dx /= l; dy /= l }
self.vel.x = dx * SPEED
self.vel.y = dy * SPEED
var ang = 0
if (engine.input.mouse.inside) ang = Math.atan2(engine.input.mouse.wy - self.pos.y, engine.input.mouse.wx - self.pos.x)
self.rot.z = ang * 57.2957
var fire = engine.input.mouse.left || engine.input.down("Space") || engine.input.down("KeyJ")
if (fire && self.mem.cd <= 0) {
  self.mem.cd = COOLDOWN
  var bx = Math.cos(ang) * 26, by = Math.sin(ang) * 26
  var b = engine.spawn({
    name: "Bullet", tags: ["bullet"],
    pos: [self.pos.x + bx, self.pos.y + by, 3],
    comps: [
      { type: "sprite2d", sprite: "orb", color: "#ffe066", w: 12, h: 12, seed: 3, screen: false },
      { type: "body2d", isStatic: true, sensor: true, gravityScale: 0, w: 12, h: 12 },
      { type: "script", code: 'var vx=(self.mem.vx||0), vy=(self.mem.vy||0); self.pos.x += vx*engine.dt; self.pos.y += vy*engine.dt; self.mem.life=(self.mem.life===undefined?2.0:self.mem.life)-engine.dt; if(self.mem.life<0){engine.destroy(self);return;} self.onCollide(function(o){ if(o.has("enemy")){ engine.score+=2; o.burst(14); engine.destroy(o); engine.destroy(self); var s=engine.find("Score"); if(s) s.setText("Score: "+engine.score); } })' }
    ]
  })
  b.mem.vx = Math.cos(ang) * 700
  b.mem.vy = Math.sin(ang) * 700
  self.burst(2)
}
if (self.pos.x < -880) self.pos.x = -880
if (self.pos.x > 880) self.pos.x = 880
if (self.pos.y < -300) self.pos.y = -300
if (self.pos.y > 300) self.pos.y = 300`

/** Public library map (offline playbook used by templates + repairs) */
export const DEFAULT_SCRIPTS: Record<string, string> = {
  platformer2d: CONTROLLER_2D,
  controller3d: CONTROLLER_3D,
  flappy: FLAPPY_2D,
  runner: RUNNER_2D,
  shooter: SHOOTER_2D
}

/* ================================================================
   2. PROMPT ENGINEERING — schema doc for the game generator
   ================================================================ */

const DIFFICULTY_RULES: Record<string, string> = {
  easy:   'EASY: forgiving platforms (width 180+), small gaps (<=120px), at most 1-2 slow enemies (speed ~35), generous jumps, high coin density, no instant-death traps.',
  normal: 'NORMAL: balanced speeds (enemy ~55), moderate gaps, 2-4 enemies, regular platform sizes.',
  hard:   'HARD: faster enemies (70-90), wider gaps needing precise jumps, 5+ enemies or moving hazards, tighter platforms (width <=110), autopunish (higher fall-out line, faster timers).'
}

const DIFF_PLACEHOLDER = '@@NOVA_DIFFICULTY@@'

const SCHEMA_DOC = `You are NovaAI, the built-in game generator of "Nova Engine" (an AI-first 2D/3D game engine).
The user describes a game; you reply with ONE complete game as a single JSON SceneSpec. NO explanations, ONLY the JSON object.

FORMAT (SceneSpec):
{
  "name": "short game name",                     // <= 40 chars
  "mode": "2d" | "3d",
  "useGradient": true,
  "bgTop": "#hex", "bgBottom": "#hex",           // 2d sky gradient / 3d fog
  "gravity2d": 1700,                             // 2d: 1400-2000, 0 for top-down games
  "gravity3d": 24,                               // 3d: 15-30
  "camera2d": { "zoom": 1, "follow": "Player" },
  "camera3d": { "mode": "third|first|top|orbit", "follow": "Player", "fov": 60, "dist": 9, "height": 3.4 },
  "entities": [ EntitySpec, ... ]                // <= 380 entities
}
EntitySpec:
{ "name": "Player", "tags": ["player"], "pos": [x,y,z], "rot": [x,y,z] (degrees), "scale": [x,y,z],
  "comps": [ ComponentSpec, ... ] }
pos/rot/scale ALWAYS exactly 3 finite numbers. Entity names must be UNIQUE across the scene.

Component types that exist in this engine (never invent other types):
- {"type":"sprite2d","sprite":"none|player|coin|gem|enemy|ship|ufo|alien|crate|orb|cloud|tree|star|brick","color":"#hex","w":60,"h":60,"seed":7,"screen":false}
- {"type":"text2d","text":"Score: 0","size":22,"color":"#fff","screen":true}          // screen:true = HUD pixels
- {"type":"particles2d","rate":0,"life":0.6,"speed":90,"spread":180,"size":5,"color":"#fbbf24"}
- {"type":"body2d","vx":0,"vy":0,"gravityScale":1,"isStatic":false,"sensor":false,"bounce":0,"friction":0.35,"keepUpright":true,"w":60,"h":60}
- {"type":"mesh3d","geo":"box|sphere|capsule|cylinder|cone|torus|torusKnot|plane","color":"#hex","texture":"none|player|coin|gem|enemy|ship|ufo|alien|crate|orb|cloud|tree|star|brick","wire":false}
- {"type":"rigid3d","vx":0,"vy":0,"vz":0,"isStatic":false,"sensor":false,"bounce":0,"friction":0.6,"lockRot":false,"gravityScale":1,"radius":0}
- {"type":"light3d","kind":"sun|ambient|hemisphere|point","color":"#hex","intensity":1.5,"distance":0}
- {"type":"script","code":"javascript function body, runs every frame"}

REAL PHYSICS:
2D uses Planck (Box2D port); 3D uses Rapier. Bodies have mass, rotation (unless keepUpright/lockRot),
friction and bounce; EVERY dynamic body collides with every other body. Ground contact sets self.onGround.

SCRIPT API (scripts run every frame):
self.pos {x,y,z} (2D: y is UP, +x right) · self.vel {x,y,z} (pixels/s in 2D, m/s in 3D) · self.rot (degrees) ·
self.scale · self.color · self.visible · self.onGround · self.mem {} (persists across frames) · self.tags ·
self.has(tag) · self.setText(str) (text2d entities) · self.burst(n) ·
self.onCollide(cb) — cb(other) fires EVERY frame two bodies touch; other is another SelfAPI.
engine.dt · engine.time · engine.score (number) · engine.input.down("KeyW"|"ArrowUp"|"Space") ·
engine.input.pressed(...) (true only on the frame the key went down) ·
engine.input.mouse {x,y,wx,wy,inside,left} (2d: wx/wy = world coords) · engine.find("Name") ·
engine.findAll(tag) · engine.spawn(EntitySpec) (returns the new entity's SelfAPI) · engine.destroy(api) ·
engine.camera.shake(strength, seconds) · engine.camera.yaw (3d, read-only) · engine.random(a,b) ·
engine.pick(arr) · engine.win(msg) · engine.gameOver(msg) · engine.log(...)

RULES:
1. WORLD 2D: y is UP; origin at screen center; visible area about x in [-450,450], y in [-280,320] at zoom 1.
   Ground/walls are CENTERED boxes (pos = box center). Keep the playable level inside x [-800, 800].
2. ALWAYS include: an entity named "Player" with tags ["player"]; a HUD text2d named "Score"
   (screen:true, pos [16,14], text mentions the score); camera follow set to "Player".
3. BODY VALUES THAT PLAY NICELY: player body2d {keepUpright:true, friction:0.05, gravityScale:1, w/h close to
   the sprite size}; ground/walls {isStatic:true, friction:0.3}; moving platforms {isStatic:true} + a script
   that moves self.pos (statics follow their transform). Collectibles: body2d {isStatic:true, sensor:true,
   gravityScale:0} + onCollide scoring. Jump = self.vel.y = +640.
4. 3D: ground = one entity with mesh3d geo "plane", scale [50,1,50] (big static collider). Player = capsule
   mesh + rigid3d {lockRot:true, friction:0.05}. Static props rigid3d {isStatic:true}; crates/balls dynamic.
5. SCRIPTS: plain JS function bodies (no imports/DOM/fetch), each <= 40 lines. Write COMPLETE logic inline:
   score updates via engine.find("Score").setText(...), win/lose via engine.win / engine.gameOver.
6. At least 6 gameplay entities (collectibles / enemies / obstacles / goal) and a clear WIN + LOSE path.
7. JSON hygiene: no comments, no trailing commas, valid #hex colors, no NaN/Infinity, entities never empty.

LEVELS: when the prompt wants multiple levels, lay levels SIDE BY SIDE along +x (level 1 x in [-800,200],
level 2 x in [400,1400], ...). Between levels put a "LevelGate" entity (sprite2d star + body2d
{isStatic:true, sensor:true} + script): on player collision move the player (set other.pos.x/y to the next
level start), bump engine.score, then engine.destroy(self).

@@NOVA_DIFFICULTY@@`

function systemPrompt(difficulty: string): string {
  const rule = DIFFICULTY_RULES[difficulty] || DIFFICULTY_RULES.normal
  return SCHEMA_DOC.replace(DIFF_PLACEHOLDER, 'DIFFICULTY for this request: ' + rule)
}

/* ================================================================
   3. PROMPT INTENT PARSING
   ================================================================ */

export function parseDifficulty(prompt: string): 'easy' | 'normal' | 'hard' {
  const t = (prompt || '').toLowerCase()
  if (/\b(insane|nightmare|brutal)\b/.test(t)) return 'hard'
  if (/\b(hard|expert|difficult|challenge)\b/.test(t)) return 'hard'
  if (/\b(easy|casual|chill|simple|relax)\b/.test(t)) return 'easy'
  if (/\b(normal|medium)\b/.test(t)) return 'normal'
  return 'normal'
}

export function wantsLevels(prompt: string): number {
  const t = (prompt || '').toLowerCase()
  if (!/\b(levels?|stages?|worlds?)\b/.test(t)) return 1
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }
  const n = t.match(/\b(\d+|one|two|three|four|five)\b\s*(?:\+|plus)?\s*(?:levels?|stages?|worlds?)/)
  if (n) {
    const v = /^\d+$/.test(n[1]) ? parseInt(n[1]) : words[n[1]]
    return Math.max(2, Math.min(5, v || 2))
  }
  return 2 // "multi level" without an explicit count
}

/* ================================================================
   4. ROBUST JSON EXTRACTION (fences, comments, trailing commas,
      truncated tail repair) + retry-once upstream
   ================================================================ */

export function extractJSON(text: string): any {
  if (!text || typeof text !== 'string') throw new Error('Empty AI reply (no JSON)')
  const fences = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n?([\s\S]*?)```/g)].map(m => m[1])
  const candidates = [...fences.filter(f => f.includes('{')), text]
  const errs: string[] = []
  for (const c of candidates) {
    const a = c.indexOf('{')
    const b = c.lastIndexOf('}')
    if (a === -1 || b <= a) { errs.push('no braces'); continue }
    const slice = c.slice(a, b + 1)
    const tries: Array<[string, string]> = [['strict', slice], ['repaired', repairJSON(slice)]]
    for (const [label, attempt] of tries) {
      try { return JSON.parse(attempt) } catch (e) {
        errs.push(label + ': ' + String((e as Error)?.message || e).slice(0, 110))
      }
    }
  }
  throw new Error('No valid JSON found in AI reply (' + errs.slice(0, 3).join(' | ') + ')')
}

/** scan helpers that respect double-quoted string state */
function stripCommentsJSON(s: string): string {
  let out = '', inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '/' && next === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

function stripTrailingCommasJSON(s: string): string {
  let out = '', inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === ',') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      const nx = s[j]
      if (nx === '}' || nx === ']') continue // skip a trailing comma
    }
    out += ch
  }
  return out
}

/** cut the text back to the last COMPLETE json element and re-close open braces */
function closeTruncatedJSON(s: string): string | null {
  const stack: string[] = []
  let inStr = false, esc = false
  let cut = 0
  let cutStack: string[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') { inStr = false; cut = i + 1; cutStack = stack.slice() }
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{' || ch === '[') { stack.push(ch); cut = i + 1; cutStack = stack.slice(); continue }
    if (ch === '}' || ch === ']') { if (stack.length) stack.pop(); cut = i + 1; cutStack = stack.slice(); continue }
    if (/[0-9a-zA-Z\-]/.test(ch)) {
      let j = i
      while (j < s.length && /[0-9a-zA-Z.eE+\-]/.test(s[j])) j++
      i = j - 1
      cut = j
      cutStack = stack.slice()
      continue
    }
    // separators (, : whitespace) — no cut here
  }
  if (cut <= 0) return null
  let body = s.slice(0, cut)
  const closers = cutStack.slice().reverse().map(c => (c === '{' ? '}' : ']')).join('')
  body = body.replace(/[,\s]+$/, '')
  if (/:\s*$/.test(body)) body += ' null'
  return body + closers
}

function repairJSON(slice: string): string {
  let s = slice
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*$/, '')
  s = stripCommentsJSON(s)
  s = stripTrailingCommasJSON(s)
  try { JSON.parse(s); return s } catch { /* keep repairing */ }
  const fixed = closeTruncatedJSON(s)
  return fixed || s
}

/* ================================================================
   5. SPEC SANITIZING + PLAYABILITY AUTO-PATCH
   ================================================================ */

const isNum = (x: any): boolean => typeof x === 'number' && Number.isFinite(x)
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))

function num3(raw: any, def: [number, number, number], lim: number): number[] {
  const a = Array.isArray(raw) ? raw : []
  const out: number[] = []
  for (let i = 0; i < 3; i++) {
    const v = isNum(a[i]) ? a[i] : def[i]
    out.push(clamp(v, -lim, lim))
  }
  return out
}

function codeOK(code: any): boolean {
  if (typeof code !== 'string' || !code.trim()) return false
  try { new Function('self', 'engine', code); return true } catch { return false }
}

export interface SanitizeLog { notes: string[] }

/** clamp values, dedupe names, repair scripts; returns a NEW spec (deep-cleaned) */
export function sanitizeSpec(raw: any, log: SanitizeLog = { notes: [] }): SceneSpec {
  const spec: SceneSpec = {}
  if (raw && typeof raw.name === 'string' && raw.name.trim()) spec.name = String(raw.name).slice(0, 48)
  else spec.name = 'AI Scene'

  const rawEnts = Array.isArray(raw?.entities) ? raw.entities : []
  const hasKind = (types: string[]) => rawEnts.some((e: any) => Array.isArray(e?.comps) && e.comps.some((c: any) => types.includes(c?.type)))
  const mesh = hasKind(['mesh3d', 'rigid3d', 'light3d'])
  const sprite = hasKind(['sprite2d', 'body2d', 'text2d'])
  spec.mode = raw?.mode === '3d' ? '3d' : raw?.mode === '2d' ? '2d' : (mesh && !sprite ? '3d' : '2d')

  const hex = (v: any): boolean => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)
  if (hex(raw?.bgTop)) spec.bgTop = raw.bgTop
  if (hex(raw?.bgBottom)) spec.bgBottom = raw.bgBottom
  if (hex(raw?.bg)) spec.bg = raw.bg
  spec.useGradient = raw?.useGradient === false ? false : true
  spec.gravity2d = clamp(isNum(raw?.gravity2d) ? raw.gravity2d : 1700, 0, 5000)
  spec.gravity3d = clamp(isNum(raw?.gravity3d) ? raw.gravity3d : 24, 0, 80)

  if (raw?.camera2d && typeof raw.camera2d === 'object') {
    spec.camera2d = {
      zoom: clamp(isNum(raw.camera2d.zoom) ? raw.camera2d.zoom : 1, 0.15, 6),
      follow: typeof raw.camera2d.follow === 'string' ? raw.camera2d.follow.slice(0, 40) : 'Player'
    }
  }
  if (raw?.camera3d && typeof raw.camera3d === 'object') {
    spec.camera3d = {
      mode: ['first', 'third', 'top', 'orbit'].includes(raw.camera3d.mode) ? raw.camera3d.mode : 'third',
      follow: typeof raw.camera3d.follow === 'string' ? raw.camera3d.follow.slice(0, 40) : 'Player',
      fov: clamp(isNum(raw.camera3d.fov) ? raw.camera3d.fov : 60, 20, 110),
      dist: clamp(isNum(raw.camera3d.dist) ? raw.camera3d.dist : 9, 2, 60),
      height: clamp(isNum(raw.camera3d.height) ? raw.camera3d.height : 3.4, 0.5, 30)
    }
  }

  if (rawEnts.length > 400) {
    log.notes.push(`entities clamped ${rawEnts.length} → 400`)
    rawEnts.length = 400
  }

  const used = new Set<string>()
  const ents: EntitySpec[] = []
  for (const e0 of rawEnts) {
    if (!e0 || typeof e0 !== 'object') continue
    let name = typeof e0.name === 'string' && e0.name.trim() ? e0.name.trim().slice(0, 32) : 'Entity'
    if (used.has(name.toLowerCase())) {
      for (let i = 2; i < 500; i++) {
        const u = name + ' #' + i
        if (!used.has(u.toLowerCase())) { name = u; break }
      }
      log.notes.push('duplicate entity name → deduped: ' + name)
    }
    used.add(name.toLowerCase())

    const tags = Array.isArray(e0.tags)
      ? e0.tags.filter((t: any) => typeof t === 'string').map((t: string) => t.toLowerCase()).slice(0, 8)
      : []

    const comps: any[] = []
    const inComps = Array.isArray(e0.comps) ? e0.comps : []
    for (const c0 of inComps.slice(0, 16)) {
      if (!c0 || typeof c0.type !== 'string') continue
      if (!COMP_DEFS[c0.type]) {
        // future component types (path2d / light2d / health …) may be added to COMP_DEFS later;
        // unknown comps are dropped safely instead of failing the whole spec
        log.notes.push(`dropped unknown component "${c0.type}" on ${name}`)
        continue
      }
      const c = Object.assign({}, c0)
      switch (c.type) {
        case 'sprite2d':
          c.sprite = typeof c.sprite === 'string' ? c.sprite : 'none'
          c.color = typeof c.color === 'string' && c.color.length < 60 ? c.color : '#7c5cff'
          c.w = clamp(isNum(c.w) ? c.w : 60, 2, 4000)
          c.h = clamp(isNum(c.h) ? c.h : 60, 2, 4000)
          c.seed = clamp(isNum(c.seed) ? Math.round(c.seed) : 7, 0, 99999)
          c.screen = c.screen === true
          break
        case 'text2d':
          c.text = typeof c.text === 'string' ? c.text.slice(0, 140) : 'Text'
          c.size = clamp(isNum(c.size) ? c.size : 22, 4, 200)
          c.color = typeof c.color === 'string' && c.color.length < 60 ? c.color : '#ffffff'
          c.screen = c.screen !== false
          break
        case 'particles2d':
          c.rate = clamp(isNum(c.rate) ? c.rate : 0, 0, 500)
          c.life = clamp(isNum(c.life) ? c.life : 0.6, 0.05, 12)
          c.speed = clamp(isNum(c.speed) ? c.speed : 90, 0, 4000)
          c.spread = clamp(isNum(c.spread) ? c.spread : 180, 0, 360)
          c.size = clamp(isNum(c.size) ? c.size : 5, 1, 64)
          c.color = typeof c.color === 'string' && c.color.length < 60 ? c.color : '#fbbf24'
          break
        case 'body2d': {
          if (isNum(c.w) && c.w < 4) { c.w = 4; log.notes.push(`tiny collider on "${name}" clamped`) }
          if (isNum(c.h) && c.h < 4) { c.h = 4; log.notes.push(`tiny collider on "${name}" clamped`) }
          c.vx = clamp(isNum(c.vx) ? c.vx : 0, -3000, 3000)
          c.vy = clamp(isNum(c.vy) ? c.vy : 0, -6000, 6000)
          c.gravityScale = clamp(isNum(c.gravityScale) ? c.gravityScale : 1, -5, 5)
          c.isStatic = c.isStatic === true
          c.sensor = c.sensor === true
          c.bounce = clamp(isNum(c.bounce) ? c.bounce : 0, 0, 1.6)
          c.friction = clamp(isNum(c.friction) ? c.friction : 0.35, 0, 2)
          c.keepUpright = c.keepUpright !== false
          c.w = clamp(isNum(c.w) ? c.w : 60, 4, 6000)
          c.h = clamp(isNum(c.h) ? c.h : 60, 4, 6000)
          break
        }
        case 'mesh3d':
          c.geo = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'torus', 'torusKnot', 'plane'].includes(c.geo) ? c.geo : 'box'
          c.color = typeof c.color === 'string' && c.color.length < 60 ? c.color : '#7c5cff'
          c.texture = typeof c.texture === 'string' ? c.texture : 'none'
          c.wire = c.wire === true
          break
        case 'rigid3d':
          c.vx = clamp(isNum(c.vx) ? c.vx : 0, -60, 60)
          c.vy = clamp(isNum(c.vy) ? c.vy : 0, -80, 80)
          c.vz = clamp(isNum(c.vz) ? c.vz : 0, -60, 60)
          c.isStatic = c.isStatic === true
          c.sensor = c.sensor === true
          c.bounce = clamp(isNum(c.bounce) ? c.bounce : 0, 0, 1.6)
          c.friction = clamp(isNum(c.friction) ? c.friction : 0.6, 0, 2)
          c.lockRot = c.lockRot === true
          c.gravityScale = clamp(isNum(c.gravityScale) ? c.gravityScale : 1, -5, 5)
          c.radius = clamp(isNum(c.radius) ? c.radius : 0, 0, 50)
          break
        case 'light3d':
          c.kind = ['sun', 'ambient', 'hemisphere', 'point'].includes(c.kind) ? c.kind : 'sun'
          c.color = typeof c.color === 'string' && c.color.length < 60 ? c.color : '#ffffff'
          c.intensity = clamp(isNum(c.intensity) ? c.intensity : 1.5, 0, 20)
          c.distance = clamp(isNum(c.distance) ? c.distance : 0, 0, 500)
          break
        case 'script': {
          const code = typeof c.code === 'string' ? c.code.slice(0, 20000) : ''
          if (codeOK(code)) c.code = code
          else {
            log.notes.push(`invalid script code on "${name}" → default script`)
            c.code = '' // filled by ensurePlayability for the player; harmless no-op otherwise
          }
          break
        }
      }
      comps.push(c)
    }

    ents.push({
      name,
      tags,
      pos: num3(e0.pos, [0, 0, 0], 100000),
      rot: num3(e0.rot, [0, 0, 0], 3600),
      scale: num3(e0.scale, [1, 1, 1], 500).map(v => (v === 0 ? 1 : Math.abs(v))),
      visible: e0.visible !== false,
      comps
    })
  }
  spec.entities = ents
  return spec
}

/* ================================================================
   6. PLAYABILITY PASS — guarantee player/move/floor/walls/camera/score
   ================================================================ */

export function ensurePlayability(spec: SceneSpec, log: SanitizeLog = { notes: [] }): SceneSpec {
  const ents = spec.entities as EntitySpec[]
  if (!ents.length) {
    ents.push(platform(-0, 60, 180, '#8b5cf6', 3)) // never-empty guard
  }
  const mode: '2d' | '3d' = spec.mode === '3d' ? '3d' : '2d'

  let players = ents.filter(e => e.tags?.includes('player'))
  if (!players.length) {
    const p = mode === '2d' ? playerEntity2D(0, 120) : playerEntity3D(0, 1.3)
    ents.push(p)
    log.notes.push('no entity tagged "player" → default player added')
    players = [p]
  }
  const hero = players[0]
  if (!ents.some(e => e.name === 'Player')) hero.name = 'Player'
  for (let i = 1; i < players.length; i++) {
    players[i].name = 'Player #' + (i + 1)
    players[i].tags = (players[i].tags || []).filter(t => t !== 'player')
  }

  // the player needs a movement script that "looks like" a controller
  const moveHint = /input\.down|input\.pressed|Space|Arrow|KeyW/i
  let hasMove = false
  for (const c of (hero.comps || [])) {
    if (c.type === 'script' && moveHint.test(String(c.code || '')) && codeOK(c.code)) { hasMove = true; break }
  }
  if (!hasMove) {
    const script = mode === '2d' ? CONTROLLER_2D : CONTROLLER_3D
    if (!hero.comps) hero.comps = []
    let patched = false
    for (const c of hero.comps) if (c.type === 'script') { c.code = script; patched = true }
    if (!patched) hero.comps.push({ type: 'script', code: script } as any)
    if (mode === '2d' && !hero.comps.some(c => c.type === 'body2d')) {
      hero.comps.push({ type: 'body2d', gravityScale: 1, keepUpright: true, friction: 0.05, w: 30, h: 44 } as any)
    }
    if (mode === '3d' && !hero.comps.some(c => c.type === 'rigid3d')) {
      hero.comps.push({ type: 'rigid3d', lockRot: true, friction: 0.05, gravityScale: 1 } as any)
    }
    log.notes.push('player movement script auto-patched')
  }

  // mean, clean physics on the hero
  if (mode === '2d') {
    const p: any = (hero.comps || []).find(c => c.type === 'body2d')
    if (p) {
      p.keepUpright = true
      if (!isNum(p.gravityScale)) p.gravityScale = 1
      p.w = clamp(isNum(p.w) ? p.w : 30, 6, 2000)
      p.h = clamp(isNum(p.h) ? p.h : 44, 6, 2000)
      p.friction = clamp(isNum(p.friction) ? p.friction : 0.05, 0, 0.35)
    }
  } else {
    const p: any = (hero.comps || []).find(c => c.type === 'rigid3d')
    if (p) {
      if (!isNum(p.gravityScale)) p.gravityScale = 1
      p.lockRot = p.lockRot !== false
    }
  }

  // repair leftover empty scripts from sanitize
  for (const e of ents) {
    for (const c of (e.comps || [])) {
      if (c.type === 'script' && !codeOK(c.code)) {
        c.code = e === hero ? (mode === '2d' ? CONTROLLER_2D : CONTROLLER_3D) : '// (repaired) idle script'
      }
    }
  }

  // Score HUD
  if (!ents.some(e => e.name === 'Score' && (e.comps || []).some(c => c.type === 'text2d'))) {
    ents.push(mode === '2d' ? hudText('Score', 'Score: 0') : hudGem3D())
    log.notes.push('score HUD auto-added')
  }

  // camera follow
  if (mode === '2d') spec.camera2d = { zoom: spec.camera2d?.zoom ?? 1, follow: 'Player' }
  else {
    spec.camera3d = {
      mode: (spec.camera3d?.mode as any) || 'third',
      follow: 'Player',
      fov: spec.camera3d?.fov ?? 60,
      dist: spec.camera3d?.dist ?? 9,
      height: spec.camera3d?.height ?? 3.4
    }
  }

  // floor + borders
  if (mode === '2d') {
    const floorOK = ents.some(e =>
      e.tags?.includes('ground') ||
      ((e.comps || []).some(c => c.type === 'body2d' && c.isStatic && (c as any).w >= 500 && (c as any).h >= 30)))
    if (!floorOK) {
      ents.push({
        name: 'Ground', tags: ['ground'], pos: [0, -60, 1],
        comps: [
          { type: 'sprite2d', sprite: 'brick', color: '#8b7355', w: 2600, h: 100, seed: 42, screen: false },
          { type: 'body2d', isStatic: true, w: 2600, h: 100, friction: 0.3 }
        ]
      })
      log.notes.push('floor auto-added')
    }
    const wallOK = ents.some(e => ((e.comps || []).some(c => c.type === 'body2d' && c.isStatic && (c as any).h >= 260)))
    if (!wallOK) {
      borderWalls2D(150, 3000, 1100).forEach(w => ents.push(w))
      log.notes.push('border walls auto-added')
    }
  } else {
    const floorOK = ents.some(e =>
      e.tags?.includes('ground') ||
      ((e.comps || []).some(c => c.type === 'mesh3d' && c.geo === 'plane')))
    if (!floorOK) {
      ents.push(floorBlock3D())
      log.notes.push('3D floor auto-added')
    }
    if (!ents.some(e => (e.comps || []).some(c => c.type === 'light3d'))) {
      ents.push({ name: 'Sunlight', pos: [18, 30, 12], comps: [{ type: 'light3d', kind: 'sun', color: '#ffffff', intensity: 1.35, distance: 0 }] })
      ents.push({ name: 'Skylight', comps: [{ type: 'light3d', kind: 'hemisphere', color: '#bfd4ff', intensity: 0.6, distance: 0 }] })
      log.notes.push('lights auto-added')
    }
  }

  return spec
}

/* ================================================================
   7. GAME GENERATION (LLM with retry, template fallback)
   ================================================================ */

const REMINDER_RETRY = `Your previous reply was not valid JSON for Nova Engine. Reply with ONLY the SceneSpec JSON object — start with { and end with } — no markdown, no explanations. Full JSON with ALL entities.`

export interface BuilderResult {
  spec: SceneSpec
  source: 'llm' | 'template'
  note?: string
}

export async function aiGenerateScene(settings: AISettings, prompt: string): Promise<SceneSpec> {
  const difficulty = parseDifficulty(prompt)
  const levelCount = wantsLevels(prompt)
  const system = systemPrompt(difficulty)
  const userMsg = `Make this game (difficulty: ${difficulty}): ${prompt}` +
    (levelCount > 1 ? `\n\nIMPORTANT: it must have ${levelCount} levels, side by side as described in the LEVELS rules.` : '') +
    `\n\nRemember: reply with ONLY the SceneSpec JSON — no commentary.`

  const msgs: ChatMsg[] = [{ role: 'user', content: userMsg }]
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await chatComplete(settings, system, msgs, 0.6)
      const spec = sanitizeSpec(extractJSON(text))
      const v = validateSpec(spec)
      if (!v.ok) throw new Error('Spec invalid: ' + v.issues.join('; '))
      const log: SanitizeLog = { notes: [] }
      ensurePlayability(spec, log)
      if (log.notes.length) console.log('[nova builder] auto-patches:', log.notes.join('; '))
      return spec as SceneSpec
    } catch (err) {
      lastErr = err
      if (attempt === 0) msgs.push({ role: 'user', content: REMINDER_RETRY })
    }
  }
  throw new Error(String((lastErr as Error)?.message || lastErr).slice(0, 400))
}

export async function buildGame(settings: AISettings, prompt: string): Promise<BuilderResult> {
  const text = (prompt || '').trim()
  if (!text) throw new Error('Empty prompt — describe the game you want!')
  const difficulty = parseDifficulty(text)
  const levelCount = wantsLevels(text)
  if (aiConfigured(settings)) {
    try {
      const spec = await aiGenerateScene(normalizeSettings(settings), text)
      return { spec, source: 'llm' }
    } catch (err) {
      // real provider rejections (bad key / model missing / payment) must surface — don't hide them behind a template
      const e = err as AIError
      const bad = e instanceof AIError && e.kind === 'http' && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429
      if (bad) throw err
      const spec = templateGame(text, difficulty, levelCount)
      return {
        spec,
        source: 'template',
        note: 'LLM unavailable (' + String((err as Error)?.message || err).slice(0, 140) + ') — offline template game generated instead.'
      }
    }
  }
  const spec = templateGame(text, difficulty, levelCount)
  return { spec, source: 'template', note: 'No AI key configured — offline template game. Add a key in AI Settings for full LLM generation.' }
}

/* ================================================================
   8. ASSISTANT (chat + spec patches)
   ================================================================ */

const ASSISTANT_DOC = `You are NovaAI Assistant inside "Nova Engine" — an AI-first 2D/3D game engine editor.
You help the user build/edit their game. You know the engine's SceneSpec format and script API (same as the game builder: comps = sprite2d, text2d, particles2d, body2d, mesh3d, rigid3d, light3d, script; self.pos/vel/rot/scale/color/visible/onGround/mem/has/setText/burst/onCollide; engine.dt/time/score/input.down/pressed/find/findAll/spawn/destroy/camera.shake/camera.yaw/win/gameOver/reload/log; physics = Planck 2D / Rapier 3D; 2D world is y-up).
When the user asks for a change to the CURRENT scene, reply briefly AND include the complete updated SceneSpec in a \`\`\`nova ... \`\`\` code fence (full JSON with ALL entities, never a diff; unique entity names; valid JSON without comments or trailing commas).
When the user asks a question or chats, just reply helpfully in 2-6 sentences. If they ask how scripting works, show tiny code examples.`

export interface AssistantResult { reply: string; patch: SceneSpec | null }
export type ChatMsg = { role: 'user' | 'assistant'; content: string }

function clampHistory(history: ChatMsg[]): ChatMsg[] {
  return (history || [])
    .slice(-10)
    .map(m => ({ role: m.role, content: String(m.content || '').slice(0, 2400) }))
}

export async function aiAssistant(
  settings: AISettings,
  history: ChatMsg[],
  userMsg: string
): Promise<AssistantResult> {
  const hist = clampHistory(history)
  const text = await chatComplete(
    settings,
    ASSISTANT_DOC,
    [...hist, { role: 'user', content: String(userMsg || '').slice(0, 4000) }],
    0.7
  )

  let patch: SceneSpec | null = null
  const fences = [...text.matchAll(/```(?:nova|json)?[ \t]*\n?([\s\S]*?)```/g)].map(m => m[1])
  for (const f of fences) {
    if (!/entities/.test(f)) continue
    try { patch = sanitizeSpec(extractJSON(f)); break } catch { patch = null }
  }
  if (!patch && /entities/.test(text)) {
    try { patch = sanitizeSpec(extractJSON(text)) } catch { patch = null }
  }
  if (patch && !validateSpec(patch).ok) patch = null
  if (patch) {
    const lg: SanitizeLog = { notes: [] }
    ensurePlayability(patch, lg)
    if (lg.notes.length) console.log('[nova assistant] patch fixes:', lg.notes.join('; '))
  }

  const clean = text.replace(/```[\s\S]*?```/g, (s) => s.length > 220 ? '(scene spec applied)' : s)
  return { reply: clean.trim(), patch }
}

/* ================================================================
   9. OFFLINE TEMPLATE GAMES (playable with real physics, no LLM needed)
   ================================================================ */

export type Archetype = 'platformer' | 'flappy' | 'shooter' | 'runner'

export function detectArchetype(prompt: string): Archetype {
  const t = (prompt || '').toLowerCase()
  if (/flappy|flap|bird/i.test(t)) return 'flappy'
  if (/shooter|shoot|bullet|invader|asteroid/i.test(t)) return 'shooter'
  if (/runner|auto.?run|dino|jump over/i.test(t)) return 'runner'
  return 'platformer'
}

function templateGame(prompt: string, difficulty: 'easy' | 'normal' | 'hard', levels = 1): SceneSpec {
  const kind = detectArchetype(prompt)
  const seed: SeedFn = () => Math.floor(Math.random() * 9000) + 100
  if (kind === 'flappy') return flappyTemplate(seed, difficulty)
  if (kind === 'shooter') return shooterTemplate(seed, difficulty)
  if (kind === 'runner') return runnerTemplate(seed, difficulty)
  return platformerTemplate(seed, difficulty, levels)
}

function platformerTemplate(seed: SeedFn, d: 'easy' | 'normal' | 'hard', levels = 1): SceneSpec {
  const ents: EntitySpec[] = []
  const enemySpeed = d === 'easy' ? 40 : d === 'hard' ? 85 : 58
  const enemyCount = d === 'easy' ? 1 : d === 'hard' ? 4 : 2
  const coinCount = d === 'hard' ? 4 : 6
  const perLevel = Math.max(1, Math.min(3, levels))

  ents.push({
    name: 'Ground', tags: ['ground'], pos: [0, -60, 1],
    comps: [
      { type: 'sprite2d', sprite: 'brick', color: '#8b7355', w: 1400 * perLevel + 2200, h: 100, seed: 42, screen: false },
      { type: 'body2d', isStatic: true, w: 1400 * perLevel + 2200, h: 100, friction: 0.3 }
    ]
  })
  const span = perLevel > 1 ? 1400 * perLevel + 600 : 3000
  borderWalls2D(150, span, 1100).forEach(w => ents.push(w))

  for (let l = 0; l < perLevel; l++) {
    const x0 = -300 + l * 1400
    ents.push(platform(x0, 60, 200, '#8b5cf6', seed()))
    ents.push(platform(x0 + 260, 160, 150, '#10b981', seed()))
    ents.push(movingPlatform(x0 + 520, 110, 130, '#14b8a6', seed()))
    coinArc2D(x0 - 40, 210, coinCount, 74, 46, seed).forEach(c => ents.push(c))
    for (let i = 0; i < enemyCount; i++) ents.push(enemyPatrol(x0 + 120 + i * 220, 30, enemySpeed, seed()))
    ents.push(cloud(x0 + 160, 240 + (l % 2) * 40, seed()))
    ents.push(cloud(x0 + 560, 270, seed()))
    if (l < perLevel - 1) {
      ents.push({
        name: 'LevelGate ' + (l + 1), tags: ['gate'], pos: [x0 + 760, 55, 2],
        comps: [
          { type: 'sprite2d', sprite: 'star', color: '#ffd700', w: 46, h: 46, seed: seed(), screen: false },
          { type: 'body2d', isStatic: true, sensor: true, w: 70, h: 96 },
          {
            type: 'script', code: `// Teleports the player into the next level stretch
self.rot.z += engine.dt * 120
self.onCollide(function (other) {
  if (!other.has("player")) return
  other.pos.x = ${x0 + 1360}
  other.pos.y = 40
  other.vel.x = 0
  other.vel.y = 0
  engine.score += 25
  other.burst(24)
  engine.camera.shake(4, 0.2)
  engine.destroy(self)
})`
          }
        ]
      })
    } else {
      ents.push(goalFlag2D(x0 + 620, 14))
    }
  }
  ents.push(crate2D(-140, 180, seed()))
  ents.push(crate2D(-138, 240, seed()))
  ents.push(playerEntity2D(-380, 140))
  ents.push(hudText('Score', 'Score: 0'))
  ents.push(hint2D('A/D move · Space jump — reach the star goal ' + (perLevel > 1 ? 'through every golden gate! [levels template ·' : '! [') + d + ' difficulty]'))

  return {
    name: (perLevel > 1 ? 'Adventure ' + perLevel : 'Platformer Adventure'),
    mode: '2d', useGradient: true,
    bgTop: '#101a3a', bgBottom: '#3b5f8a', gravity2d: 1700,
    camera2d: { zoom: 1, follow: 'Player' },
    entities: ents
  }
}

function flappyTemplate(seed: SeedFn, d: 'easy' | 'normal' | 'hard'): SceneSpec {
  const ents: EntitySpec[] = []
  const gap = d === 'hard' ? 175 : d === 'normal' ? 215 : 255
  const speed = d === 'hard' ? 230 : d === 'normal' ? 185 : 150
  const spacing = 330
  const h = 170
  for (let i = 0; i < 6; i++) {
    const cy = [60, 0, -60][i % 3]
    const cx = 240 + i * spacing
    ents.push({
      name: 'PipeTop ' + (i + 1), tags: ['pipe'], pos: [cx, cy + h + gap / 2, 1],
      comps: [
        { type: 'sprite2d', sprite: 'tree', color: '#2fbf71', w: 64, h: h * 2, seed: seed(), screen: false },
        { type: 'body2d', isStatic: true, w: 64, h: h * 2 },
        { type: 'script', code: pipeScript(spacing, cy, speed, true) }
      ]
    })
    ents.push({
      name: 'PipeBottom ' + (i + 1), tags: ['pipe'], pos: [cx, cy - h - gap / 2, 1],
      comps: [
        { type: 'sprite2d', sprite: 'tree', color: '#2fbf71', w: 64, h: h * 2, seed: seed(), screen: false },
        { type: 'body2d', isStatic: true, w: 64, h: h * 2 },
        { type: 'script', code: pipeScript(spacing, cy, speed, false) }
      ]
    })
  }
  ents.push({
    name: 'Floor', tags: ['ground'], pos: [0, -360, 1],
    comps: [
      { type: 'sprite2d', sprite: 'brick', color: '#8b7355', w: 2400, h: 120, seed: 8, screen: false },
      { type: 'body2d', isStatic: true, w: 2400, h: 120 }
    ]
  })
  ents.push({
    name: 'Player', tags: ['player'], pos: [-260, 60, 4],
    comps: [
      { type: 'sprite2d', sprite: 'player', color: '#fbbf24', w: 34, h: 34, seed: 21, screen: false },
      { type: 'body2d', gravityScale: 1, keepUpright: true, friction: 0, w: 26, h: 26, vx: 0, vy: 0 },
      { type: 'script', code: FLAPPY_2D }
    ]
  })
  ents.push(hudText('Score', 'Score: 0'))
  ents.push(hint2D('Space to flap · fly through the green pipes [offline flappy template · ' + d + ']'))
  return {
    name: 'Flappy Nova', mode: '2d', useGradient: true,
    bgTop: '#160c33', bgBottom: '#31427a', gravity2d: 1350,
    camera2d: { zoom: 1, follow: '' }, // fixed camera — classic flappy framing
    entities: ents
  }

  function pipeScript(spacingPx: number, centerY: number, spd: number, isTop: boolean): string {
    return `var WRAPX = -${spacingPx * 7}
var CENTERY = ${centerY}
self.pos.x -= ${spd} * engine.dt
if (self.pos.x < WRAPX) {
  self.pos.x = -WRAPX - 300
  self.mem.counted = 0
}
if (${isTop} && !self.mem.counted && self.pos.x < -290) {
  self.mem.counted = 1
  engine.score += 1
  var s = engine.find("Score")
  if (s) s.setText("Score: " + engine.score)
}
self.onCollide(function (other) {
  if (!other.has("player")) return
  other.burst(20)
  engine.gameOver("Crashed into a pipe!")
})`
  }
}

function shooterTemplate(seed: SeedFn, d: 'easy' | 'normal' | 'hard'): SceneSpec {
  const ents: EntitySpec[] = []
  const enemies = d === 'easy' ? 3 : d === 'hard' ? 6 : 4
  ents.push({
    name: 'Arena', tags: ['ground'], pos: [0, 0, 0],
    comps: [{ type: 'sprite2d', sprite: 'none', color: '#1d2a44', w: 2000, h: 1400, seed: 5, screen: false }]
  })
  const mkWall = (name: string, x: number, y: number, w: number, h: number) => {
    ents.push({
      name, tags: ['wall'], pos: [x, y, 1],
      comps: [
        { type: 'sprite2d', sprite: 'brick', color: '#455364', w, h, seed: seed(), screen: false },
        { type: 'body2d', isStatic: true, w, h }
      ]
    })
  }
  mkWall('WallTop', 0, 340, 1900, 40)
  mkWall('WallBottom', 0, -340, 1900, 40)
  mkWall('WallLeft', -910, 0, 40, 760)
  mkWall('WallRight', 910, 0, 40, 760)
  mkWall('BlockA', -320, 80, 160, 26)
  mkWall('BlockB', 300, -60, 160, 26)

  const seekSpeed = d === 'hard' ? 150 : d === 'normal' ? 120 : 90
  for (let i = 0; i < enemies; i++) {
    ents.push({
      name: 'Chaser', tags: ['enemy'], pos: [-500 + i * 240, 180 - (i % 3) * 90, 3],
      comps: [
        { type: 'sprite2d', sprite: 'alien', color: '#ef4444', w: 38, h: 38, seed: seed(), screen: false },
        { type: 'body2d', gravityScale: 0, isStatic: false, w: 34, h: 34, friction: 0.05 },
        {
          type: 'script', code: `// Seek the player; touching the player ends the run
var SPD = ${seekSpeed + i * 10}
var p = engine.find("Player")
if (p) {
  var dx = p.pos.x - self.pos.x, dy = p.pos.y - self.pos.y
  var l = Math.sqrt(dx * dx + dy * dy) || 1
  self.vel.x = dx / l * SPD
  self.vel.y = dy / l * SPD
}
self.onCollide(function (o) {
  if (!o.has("player")) return
  self.burst(18)
  engine.gameOver("Caught by an alien!")
})`
        }
      ]
    })
  }

  ents.push({
    name: 'Player', tags: ['player'], pos: [0, 20, 4],
    comps: [
      { type: 'sprite2d', sprite: 'ship', color: '#3b82f6', w: 42, h: 42, seed: 12, screen: false },
      { type: 'body2d', gravityScale: 0, keepUpright: true, friction: 0, w: 36, h: 36 },
      { type: 'particles2d', rate: 0, life: 0.4, speed: 120, spread: 60, size: 4, color: '#38bdf8' },
      { type: 'script', code: SHOOTER_2D }
    ]
  })
  ents.push(hudText('Score', 'Score: 0'))
  ents.push(hint2D('WASD move · mouse aim · click / Space shoot — clear ' + enemies + ' aliens! [offline shooter template · ' + d + ']'))
  return {
    name: 'Wave Defender', mode: '2d', useGradient: true,
    bgTop: '#0b1026', bgBottom: '#1b2b4a', gravity2d: 0,
    camera2d: { zoom: 1, follow: '' }, // fixed arena camera
    entities: ents
  }
}

function runnerTemplate(seed: SeedFn, d: 'easy' | 'normal' | 'hard'): SceneSpec {
  const ents: EntitySpec[] = []
  const segW = 520
  const gap = d === 'hard' ? 140 : 90
  for (let i = 0; i < 8; i++) {
    ents.push({
      name: 'Track ' + (i + 1), tags: ['ground'], pos: [i * (segW + gap), -60, 1],
      comps: [
        { type: 'sprite2d', sprite: 'brick', color: '#6b7280', w: segW, h: 100, seed: seed(), screen: false },
        { type: 'body2d', isStatic: true, w: segW, h: 100, friction: 0.28 }
      ]
    })
  }
  coinArc2D(240, 190, 5, 90, 60, seed).forEach(c => ents.push(c))
  coinArc2D(1400, 190, 5, 90, 60, seed).forEach(c => ents.push(c))
  ents.push(enemyPatrol(760, 30, (d === 'easy' ? 40 : d === 'hard' ? 85 : 58) + 15, seed()))
  ents.push(enemyPatrol(1660, 30, (d === 'easy' ? 40 : d === 'hard' ? 85 : 58) + 15, seed()))
  ents.push(crate2D(480, 160, seed()))
  ents.push(crate2D(1560, 220, seed()))
  ents.push(cloud(100, 260, seed()))
  ents.push(cloud(900, 290, seed()))
  ents.push(goalFlag2D(4180, 14))
  ents.push(playerEntity2D(-40, 120, RUNNER_2D))
  ents.push(hudText('Score', 'Score: 0'))
  ents.push(hint2D('Auto-run · Space to jump the gaps & stomp enemies — reach the star! [offline runner template · ' + d + ']'))
  return {
    name: 'Endless Dash', mode: '2d', useGradient: true,
    bgTop: '#241b2f', bgBottom: '#7a3b2a', gravity2d: 1800,
    camera2d: { zoom: 1, follow: 'Player' },
    entities: ents
  }
}

/* ---------- unified re-exports used by main.ts ---------- */

export { localAssistant, type AssistantAction } from './assistant-local'
export { loadAISettings, normalizeSettings, aiConfigured, PROVIDER_INFO, testConnection, chatComplete } from './providers'
