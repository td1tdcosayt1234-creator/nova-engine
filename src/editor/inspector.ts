/* ============ Nova Engine — Inspector panel ============
   Self-initializes on first renderInspector() call (main.ts calls it via
   editor.refreshInspector). Lives-refresh at 10fps during play. */

import { getComp, type Entity } from '../engine/core'
import { COMP_DEFS, type FieldDef } from '../engine/components'
import { compileScript } from '../engine/script'
import { spriteCanvas } from '../engine/sprites'
import { selectedEntity, type Editor } from './state'
import { selectedEntities, setSelection, cloneEntities, deleteEntities, installEditor, alignSelection, type AlignMode } from './actions'
import { pushUndo } from './history'
import { presetList } from './blank'
import { toast } from './ui'

let inited = false
let editPushPending = false
let playTicker: ReturnType<typeof setInterval> | null = null

export function initInspector(ed: Editor, root: HTMLElement) {
  ensureInit(ed, root)
  renderInspector(ed, root)
}

function ensureInit(ed: Editor, root: HTMLElement) {
  if (inited) return
  const panel = root.closest('.panel.right')
  if (!panel) return
  inited = true

  installEditor(ed)

  /* push one undo entry per edit chain (first 'input' after a 'change') */
  root.addEventListener('input', () => {
    if (!editPushPending) {
      editPushPending = true
      ed.pushUndo?.('Inspector edit')
    }
  }, true)
  root.addEventListener('change', () => { editPushPending = false }, true)

  /* live values during play (throttled to ~10 fps) */
  playTicker = setInterval(() => {
    if (!ed.playing || ed.paused) return
    if (document.querySelector('.modal-back')) return
    const app = document.getElementById('app')
    if (app?.classList.contains('editorhidden')) return
    const active = document.activeElement
    if (active && root.contains(active)) return
    const keep = root.scrollTop
    renderInspector(ed, root)
    root.scrollTop = keep
  }, 100)
  void playTicker
}

/* ---------- render ---------- */

export function renderInspector(ed: Editor, root: HTMLElement) {
  root.innerHTML = ''
  const many = selectedEntities(ed)
  if (many.length > 1) {
    renderMulti(ed, root, many)
    return
  }
  const sel = selectedEntity(ed)
  if (sel) renderEntity(ed, root, sel)
  else renderSceneSettings(ed, root)
}

/* ---------- Scene settings (no selection) ---------- */

function renderSceneSettings(ed: Editor, root: HTMLElement) {
  const m = ed.scene.meta

  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `<div class="card-h">🌍 Scene Settings</div>`
  const body = document.createElement('div')
  body.className = 'card-b'
  card.appendChild(body)

  body.appendChild(rowText('Name', m.name, v => { m.name = v; ed.dirty = true }))
  body.appendChild(rowSelect('Mode', m.mode, ['2d', '3d'], v => {
    m.mode = v as '2d' | '3d'
    ed.applyMode()
  }))
  body.appendChild(rowCheck('Gradient BG', m.useGradient, v => { m.useGradient = v }))
  body.appendChild(rowColor('BG Top', m.bgTop, v => { m.bgTop = v; if (!m.useGradient) m.bg = v }))
  body.appendChild(rowColor('BG Bottom', m.bgBottom, v => { m.bgBottom = v; if (!m.useGradient) m.bg = v }))
  body.appendChild(rowNum('Gravity 2D', m.gravity2d, 50, v => { m.gravity2d = v }))
  body.appendChild(rowNum('Gravity 3D', m.gravity3d, 0.5, v => { m.gravity3d = v }))

  const cam2 = subCard('📷 Camera 2D')
  cam2.appendChild(rowNum('Zoom', m.camera2d.zoom, 0.05, v => { m.camera2d.zoom = v }))
  cam2.appendChild(rowText('Follow (name)', m.camera2d.follow, v => { m.camera2d.follow = v }))
  body.appendChild(cam2)

  const cam3 = subCard('📷 Camera 3D')
  cam3.appendChild(rowSelect('Mode', m.camera3d.mode, ['orbit', 'first', 'third', 'top'], v => { m.camera3d.mode = v as any }))
  cam3.appendChild(rowText('Follow (name)', m.camera3d.follow, v => { m.camera3d.follow = v }))
  cam3.appendChild(rowNum('FOV', m.camera3d.fov, 1, v => { m.camera3d.fov = v }))
  cam3.appendChild(rowNum('Distance', m.camera3d.dist, 0.5, v => { m.camera3d.dist = v }))
  cam3.appendChild(rowNum('Height', m.camera3d.height, 0.25, v => { m.camera3d.height = v }))
  body.appendChild(cam3)

  root.appendChild(card)

  /* presets row */
  root.appendChild(presetRow(ed))

  const note = document.createElement('div')
  note.className = 'empty-note'
  note.innerHTML = 'Kono entity select koro nai.<br>Viewport e click kore select koro,<br>ba AI Builder theke game generate koro.'
  root.appendChild(note)
}

/* ---------- Entity inspector (single selection) ---------- */

function renderEntity(ed: Editor, root: HTMLElement, e: Entity) {
  // identity card
  const idCard = document.createElement('div')
  idCard.className = 'card'
  idCard.innerHTML = `<div class="card-h">🏷️ Entity</div>`
  const ib = document.createElement('div')
  ib.className = 'card-b'
  idCard.appendChild(ib)
  ib.appendChild(rowText('Name', e.name, v => { e.name = v; ed.refreshHierarchy() }))
  ib.appendChild(rowText('Tags', e.tags.join(', '), v => { e.tags = v.split(',').map(s => s.trim()).filter(Boolean) }))
  ib.appendChild(rowCheck('Visible', e.visible, v => { e.visible = v }))
  ib.appendChild(rowVec3('Position', e.transform.pos, ed, 1))
  ib.appendChild(rowVec3('Rotation°', e.transform.rot, ed, 5))
  ib.appendChild(rowVec3('Scale', e.transform.scale, ed, 0.1))
  root.appendChild(idCard)

  // components
  for (const c of [...e.comps]) {
    const def = COMP_DEFS[c.type]
    if (!def) continue
    const card = document.createElement('div')
    card.className = 'card'
    const h = document.createElement('div')
    h.className = 'card-h'
    const icon = document.createElement('span')
    icon.textContent = def.icon
    const lbl = document.createElement('span')
    lbl.textContent = def.label
    h.append(icon, lbl)
    /* sprite preview thumbnail */
    if (c.type === 'sprite2d' && c.sprite && c.sprite !== 'none') {
      const prev = document.createElement('canvas')
      prev.className = 'spriteprev'
      prev.width = 16; prev.height = 16
      prev.title = `${c.sprite} (seed ${c.seed})`
      const pctx = prev.getContext('2d')!
      pctx.imageSmoothingEnabled = false
      try { pctx.drawImage(spriteCanvas(c.sprite, c.seed || 1), 0, 0) } catch { /* category removed */ }
      h.appendChild(prev)
    }
    const rm = document.createElement('button')
    rm.className = 'rm'
    rm.textContent = '✕'
    rm.title = 'Remove component'
    rm.addEventListener('click', () => {
      if (ed.playing) { toast('warn', 'Stop play mode first'); return }
      pushUndo(ed, `Remove ${def.label}`)
      e.comps = e.comps.filter(x => x !== c)
      ed.refreshAll()
      ed.log('info', `Removed ${def.label} from "${e.name}"`)
      renderInspector(ed, root)
    })
    h.appendChild(rm)
    card.appendChild(h)
    const body = document.createElement('div')
    body.className = 'card-b'
    for (const f of def.fields) body.appendChild(fieldRowFor(ed, e, c, f, root))
    card.appendChild(body)
    root.appendChild(card)
  }

  // add component (grouped by category)
  root.appendChild(addComponentRow(ed, e, root))

  // presets row
  root.appendChild(presetRow(ed))

  // actions
  const act = document.createElement('div')
  act.style.display = 'flex'
  act.style.gap = '8px'
  const dup = document.createElement('button')
  dup.className = 'btn'
  dup.style.flex = '1'
  dup.textContent = '⧉ Duplicate'
  dup.addEventListener('click', () => {
    if (ed.playing) { toast('warn', 'Stop play mode first'); return }
    pushUndo(ed, `Duplicate ${e.name}`)
    const c = cloneEntities(ed, [e])
    ed.refreshAll()
    void c
  })
  const foc = document.createElement('button')
  foc.className = 'btn'
  foc.style.flex = '1'
  foc.textContent = '🎯 Focus'
  foc.title = 'Center the camera on this entity (shortcut: F)'
  foc.addEventListener('click', () => ed.focusSelection())
  const del = document.createElement('button')
  del.className = 'btn danger'
  del.style.flex = '1'
  del.textContent = '🗑 Delete'
  del.addEventListener('click', () => {
    if (ed.playing) { toast('warn', 'Stop play mode first'); return }
    pushUndo(ed, `Delete ${e.name}`)
    deleteEntities(ed, [e.id])
    ed.log('warn', `Deleted "${e.name}"`)
  })
  act.append(dup, foc, del)
  root.appendChild(act)
}

/* ---------- multi-select inspector ---------- */

function renderMulti(ed: Editor, root: HTMLElement, list: Entity[]) {
  const primary = list[0]

  const card = document.createElement('div')
  card.className = 'card'
  const h = document.createElement('div')
  h.className = 'card-h'
  h.innerHTML = `<span>⛓</span><span>${list.length} Entities Selected</span>`
  card.appendChild(h)
  const b = document.createElement('div')
  b.className = 'card-b'

  /* chips */
  const chips = document.createElement('div')
  chips.className = 'multichips'
  for (const e of list) {
    const chip = document.createElement('button')
    chip.className = 'chip small' + (e.id === ed.selection ? ' primary' : '')
    chip.textContent = e.name
    chip.title = 'Make this the primary selection'
    chip.addEventListener('click', () => {
      setSelection(ed, e.id)
      ed.refreshAll()
    })
    chips.appendChild(chip)
  }
  b.appendChild(chips)

  /* delta transform ops */
  b.appendChild(deltaVecRow(ed, list, 'Δ Position', primary.transform.pos, 'pos', 1))
  b.appendChild(deltaVecRow(ed, list, 'Δ Rotation°', primary.transform.rot, 'rot', 5))
  b.appendChild(deltaVecRow(ed, list, 'Δ Scale', primary.transform.scale, 'scale', 0.1))

  b.appendChild(rowCheck('All Visible', list.every(e => e.visible), v => {
    pushUndo(ed, 'Visibility (multi)')
    list.forEach(e => { e.visible = v })
    ed.refreshAll()
  }))
  card.appendChild(b)
  root.appendChild(card)

  /* batch align quick row */
  const alignRow = document.createElement('div')
  alignRow.className = 'card'
  const ab = document.createElement('div')
  ab.className = 'card-b'
  const abRow = document.createElement('div')
  abRow.className = 'multichips'
  const modes: Array<[AlignMode, string, string]> = [
    ['left', '⇤ Left', 'Align left'], ['right', 'Right ⇥', 'Align right'],
    ['top', '⤒ Top', 'Align top'], ['bottom', '⤓ Bottom', 'Align bottom'],
    ['center-h', '⇨ Cent H', 'Center horizontally'], ['center-v', '⇪ Cent V', 'Center vertically'],
    ['dist-x', '⇹ Dist X', 'Distribute horizontally'], ['dist-y', '⇵ Dist Y', 'Distribute vertically']
  ]
  for (const [mode, label, title] of modes) {
    const btn = document.createElement('button')
    btn.className = 'btn small'
    btn.textContent = label
    btn.title = title
    btn.addEventListener('click', () => {
      const n = alignSelection(ed, mode)
      if (!n) toast('warn', 'Select 2+ entities')
    })
    abRow.appendChild(btn)
  }
  ab.appendChild(abRow)
  alignRow.appendChild(ab)
  root.appendChild(alignRow)

  /* batch actions */
  const act = document.createElement('div')
  act.style.display = 'flex'
  act.style.gap = '8px'
  const dup = document.createElement('button')
  dup.className = 'btn'
  dup.style.flex = '1'
  dup.textContent = '⧉ Duplicate All'
  dup.addEventListener('click', () => {
    if (ed.playing) { toast('warn', 'Stop play mode first'); return }
    pushUndo(ed, `Duplicate ${list.length} entities`)
    cloneEntities(ed, list)
    ed.refreshAll()
  })
  const del = document.createElement('button')
  del.className = 'btn danger'
  del.style.flex = '1'
  del.textContent = `🗑 Delete All (${list.length})`
  del.addEventListener('click', () => {
    if (ed.playing) { toast('warn', 'Stop play mode first'); return }
    pushUndo(ed, `Delete ${list.length} entities`)
    deleteEntities(ed, list.map(e => e.id))
  })
  act.append(dup, del)
  root.appendChild(act)
}

/* delta transform: edits are applied relative to the primary entity */
function deltaVecRow(ed: Editor, list: Entity[], label: string, ref: { x: number; y: number; z: number }, get: 'pos' | 'rot' | 'scale', step: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  const l = document.createElement('label')
  l.textContent = label
  const grid = document.createElement('div')
  grid.className = 'vec3'
  for (const key of ['x', 'y', 'z'] as const) {
    grid.appendChild(dragNum({
      value: ref[key],
      step,
      onCommit: (v) => {
        pushUndo(ed, `${label} (multi)`)
        const d = v - ref[key]
        for (const e of list) e.transform[get][key] += d
        ed.refreshAll()
      }
    }))
  }
  row.append(l, grid)
  return row
}

/* ---------- add-component + presets ---------- */

const COMP_CATEGORIES: Array<{ cat: string; types: string[] }> = [
  { cat: '🟦 2D', types: ['sprite2d', 'text2d', 'particles2d', 'body2d'] },
  { cat: '🧊 3D', types: ['mesh3d', 'rigid3d', 'light3d'] },
  { cat: '⚙️ Logic', types: ['script'] }
]

function addComponentRow(ed: Editor, e: Entity, root: HTMLElement): HTMLElement {
  const addCard = document.createElement('div')
  addCard.className = 'card'
  const ab = document.createElement('div')
  ab.className = 'card-b'
  const wrap = document.createElement('div')
  wrap.className = 'compadd'
  const sel = document.createElement('select')
  const have = new Set(e.comps.map(c => c.type))
  let any = false
  for (const cat of COMP_CATEGORIES) {
    const types = cat.types.filter(t => COMP_DEFS[t] && !have.has(t))
    if (!types.length) continue
    any = true
    const og = document.createElement('optgroup')
    og.label = cat.cat
    for (const t of types) {
      const o = document.createElement('option')
      o.value = t
      o.textContent = `${COMP_DEFS[t].icon} ${COMP_DEFS[t].label}`
      og.appendChild(o)
    }
    sel.appendChild(og)
  }
  const addBtn = document.createElement('button')
  addBtn.className = 'btn small primary'
  addBtn.textContent = 'Add'
  addBtn.disabled = !any
  addBtn.addEventListener('click', () => {
    if (!sel.value) return
    if (ed.playing) { toast('warn', 'Stop play mode first'); return }
    pushUndo(ed, `Add ${COMP_DEFS[sel.value].label}`)
    e.comps.push(COMP_DEFS[sel.value].defaults())
    ed.refreshAll()
    ed.log('ok', `Added ${COMP_DEFS[sel.value].label} to "${e.name}"`)
    renderInspector(ed, root)
  })
  wrap.append(sel, addBtn)
  ab.appendChild(wrap)
  addCard.appendChild(ab)
  return addCard
}

function presetRow(ed: Editor): HTMLElement {
  const mode = ed.scene.meta.mode
  const wrap = document.createElement('div')
  wrap.className = 'card'
  const b = document.createElement('div')
  b.className = 'card-b'
  const label = document.createElement('div')
  label.className = 'card-b-label'
  label.textContent = '⚡ Entity presets'
  const chips = document.createElement('div')
  chips.className = 'multichips'
  const custom: Array<{ key: string; label: string; icon: string }> = [
    { key: '__empty', label: 'Empty', icon: '▪️' },
    { key: '__light', label: 'Light', icon: '💡' },
    { key: '__hud', label: 'HUD Text', icon: '🔤' }
  ]
  const all = [...custom, ...presetList(mode)]
  for (const p of all) {
    const chip = document.createElement('button')
    chip.className = 'chip small'
    chip.textContent = `${p.icon} ${p.label}`
    chip.title = `Add a ${p.label} entity`
    chip.addEventListener('click', () => {
      if (ed.playing) { toast('warn', 'Stop play mode first'); return }
      addPresetQuick(ed, p.key)
    })
    chips.appendChild(chip)
  }
  b.append(label, chips)
  wrap.appendChild(b)
  return wrap
}

function addPresetQuick(ed: Editor, key: string) {
  import('./actions').then(m => {
    if (key === '__empty') {
      const e = ed.scene.createEntity(uniqueNameLocal(ed, 'Entity'), [
        { type: 'sprite2d', sprite: 'none', color: '#7c5cff', w: 60, h: 60, seed: 7, screen: false }
      ])
      pushUndo(ed, 'Add empty entity')
      setSelection(ed, e.id)
      ed.refreshAll()
      toast('ok', 'Added Empty entity')
      return
    }
    if (key === '__light') {
      const pk = ed.scene.meta.mode === '3d' ? 'lightSun' : '__none'
      if (pk === '__none') {
        /* 2D has no lights — give a glowing orb preset */
        pushUndo(ed, 'Add glow orb')
        const e = ed.scene.createEntity(uniqueNameLocal(ed, 'Light'), [
          { type: 'sprite2d', sprite: 'orb', color: '#fde047', w: 40, h: 40, seed: 9, screen: false },
          { type: 'particles2d', rate: 12, life: 0.5, speed: 40, spread: 180, size: 3, color: '#fbbf24' }
        ])
        setSelection(ed, e.id)
        ed.refreshAll()
        toast('ok', 'Added glow orb (2D — real lights are 3D only)')
        return
      }
      m.addPresetToScene(ed, 'lightSun')
      toast('ok', 'Added sun light')
      return
    }
    if (key === '__hud') {
      pushUndo(ed, 'Add HUD text')
      const e = ed.scene.createEntity(uniqueNameLocal(ed, 'Score'), [
        { type: 'text2d', text: 'Score: 0', size: 22, color: '#ffffff', screen: true }
      ], { pos: { x: 14, y: 12, z: 0 } })
      setSelection(ed, e.id)
      ed.refreshAll()
      toast('ok', 'Added HUD text')
      return
    }
    pushUndo(ed, 'Add preset')
    m.addPresetToScene(ed, key as any)
    toast('ok', 'Added preset')
  })
}

function uniqueNameLocal(ed: Editor, base: string): string {
  let n = base
  let i = 2
  while (ed.scene.byName(n)) n = `${base} ${i++}`
  return n
}

/* ---------- field dispatcher ---------- */

function fieldRowFor(ed: Editor, e: Entity, c: any, f: FieldDef, root: HTMLElement): HTMLElement {
  switch (f.type) {
    case 'number': {
      const start = Number(c[f.key]) || 0
      return dragNumRow(f.label, start, f.step || 0.1, v => { c[f.key] = v })
    }
    case 'text':
      return rowText(f.label, String(c[f.key] ?? ''), v => { c[f.key] = v })
    case 'color':
      return rowColor(f.label, c[f.key] || '#ffffff', v => { c[f.key] = v })
    case 'select':
      return rowSelect(f.label, String(c[f.key]), f.options || [], v => {
        c[f.key] = v
        renderInspector(ed, root)
      })
    case 'check':
      return rowCheck(f.label, !!c[f.key], v => { c[f.key] = v })
    case 'code':
      return rowCode(ed, e, String(c[f.key] ?? ''), v => {
        c[f.key] = v
        ed.host.drop(e.id)
      })
    default:
      return document.createElement('div')
  }
}

/* ---------- widgets ---------- */

function rowText(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  const l = document.createElement('label'); l.textContent = label
  const i = document.createElement('input'); i.value = value
  i.addEventListener('change', () => onChange(i.value))
  row.append(l, i)
  return row
}

/** number input with pointer-drag knob + arrow-key stepping */
function dragNum(opts: {
  value: number
  step: number
  min?: number
  max?: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
}): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'text'
  i.className = 'dragnum'
  i.setAttribute('autocomplete', 'off')
  i.value = round(opts.value).toString()
  let startVal = opts.value
  let startX = 0
  let dragging = false

  const clampV = (v: number) => {
    let out = v
    if (opts.min !== undefined) out = Math.max(opts.min, out)
    if (opts.max !== undefined) out = Math.min(opts.max, out)
    return out
  }
  const dec = decimalsOf(opts.step)

  i.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return
    startX = ev.clientX
    startVal = parseFloat(i.value) || 0
    dragging = false
    try { i.setPointerCapture(ev.pointerId) } catch { /* not supported */ }
    const move = (e2: PointerEvent) => {
      const dx = e2.clientX - startX
      if (!dragging && Math.abs(dx) > 4) {
        dragging = true
        i.focus()
        i.select()
      }
      if (!dragging) return
      e2.preventDefault()
      const mult = e2.shiftKey ? 8 : 1
      const next = clampV(round2(startVal + dx * opts.step * mult, dec))
      i.value = next.toString()
      opts.onChange(next)
    }
    const up = (e3: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (i.hasPointerCapture?.(ev.pointerId)) { try { i.releasePointerCapture(ev.pointerId) } catch { /* detached */ } }
      if (dragging) {
        dragging = false
        opts.onCommit?.(parseFloat(i.value) || 0)
        i.select()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  i.addEventListener('keydown', ev => {
    ev.stopPropagation()
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault()
      const v = parseFloat(i.value) || 0
      const next = clampV(round2(v + (ev.key === 'ArrowUp' ? opts.step : -opts.step) * (ev.shiftKey ? 10 : 1), dec))
      i.value = next.toString()
      opts.onChange(next)
      opts.onCommit?.(next)
    } else if (ev.key === 'Enter') {
      i.blur()
    }
  })

  i.addEventListener('change', () => {
    const n = parseFloat(i.value)
    if (Number.isFinite(n)) {
      const clamped = clampV(n)
      i.value = round(clamped).toString()
      opts.onChange(clamped)
      opts.onCommit?.(clamped)
    } else {
      i.value = round(startVal).toString()
    }
  })
  return i
}

function dragNumRow(label: string, value: number, step: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  const l = document.createElement('label')
  l.textContent = label
  row.append(l, dragNum({ value, step, onChange }))
  return row
}

function rowVec3(label: string, v: { x: number; y: number; z: number }, _ed: Editor, step: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  row.dataset.vec = label
  const l = document.createElement('label'); l.textContent = label
  const grid = document.createElement('div')
  grid.className = 'vec3'
  for (const key of ['x', 'y', 'z'] as const) {
    const i = dragNum({
      value: v[key],
      step,
      onChange: n => { v[key] = n }
    })
    i.dataset.axis = `${label}.${key}`
    i.dataset.getter = label === 'Position' ? 'pos' : label === 'Rotation°' ? 'rot' : 'scale'
    i.dataset.axis2 = key
    grid.appendChild(i)
  }
  row.append(l, grid)
  return row
}

/** color swatch + hex text */
function rowColor(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  const l = document.createElement('label'); l.textContent = label
  const box = document.createElement('div')
  box.className = 'colorbox'
  const sw = document.createElement('input')
  sw.type = 'color'
  sw.value = normalizeHex(value) || '#ffffff'
  const hex = document.createElement('input')
  hex.className = 'hexin'
  hex.value = sw.value
  hex.setAttribute('autocomplete', 'off')
  sw.addEventListener('input', () => {
    hex.value = sw.value
    onChange(sw.value)
  })
  hex.addEventListener('change', () => {
    const n = normalizeHex(hex.value)
    if (n) {
      sw.value = n
      hex.value = n
      onChange(n)
    } else {
      hex.value = sw.value
    }
  })
  box.append(sw, hex)
  row.append(l, box)
  return row
}

function normalizeHex(v: string): string {
  if (!v) return ''
  let s = v.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(ch => ch + ch).join('')
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase()
  return ''
}

function rowSelect(label: string, value: string, options: string[], onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  const l = document.createElement('label'); l.textContent = label
  const i = document.createElement('select')
  for (const o of options) {
    const opt = document.createElement('option')
    opt.value = o
    opt.textContent = o
    if (o === value) opt.selected = true
    i.appendChild(opt)
  }
  if (!options.includes(value)) {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = value
    opt.selected = true
    i.appendChild(opt)
  }
  i.addEventListener('change', () => onChange(i.value))
  row.append(l, i)
  return row
}

function rowCheck(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'frow'
  const l = document.createElement('label'); l.textContent = label
  const i = document.createElement('input')
  i.type = 'checkbox'
  i.checked = !!value
  i.addEventListener('change', () => onChange(i.checked))
  row.append(l, i)
  return row
}

function subCard(title: string): HTMLElement {
  const c = document.createElement('div')
  c.style.border = '1px solid var(--border)'
  c.style.borderRadius = '8px'
  c.style.padding = '8px'
  c.style.display = 'flex'
  c.style.flexDirection = 'column'
  c.style.gap = '7px'
  const h = document.createElement('div')
  h.style.fontSize = '11px'
  h.style.color = 'var(--muted)'
  h.textContent = title
  c.appendChild(h)
  return c
}

/* ---------- code editor (line numbers + Tab + error highlight) ---------- */

function rowCode(ed: Editor, e: Entity, value: string, onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'codewrap'
  const head = document.createElement('div')
  head.className = 'codehead'
  const l = document.createElement('span')
  l.textContent = '📜 Code (runs every frame)'
  const errTag = document.createElement('span')
  errTag.className = 'codetag'
  head.append(l, errTag)
  const body = document.createElement('div')
  body.className = 'codebody'
  const gutter = document.createElement('div')
  gutter.className = 'codegutter'
  const i = document.createElement('textarea')
  i.className = 'codeedit'
  i.spellcheck = false
  i.value = value
  const errLine = document.createElement('div')
  errLine.className = 'codeerror'
  errLine.style.display = 'none'

  const syncLines = () => {
    const lines = i.value.split('\n').length
    gutter.textContent = Array.from({ length: lines }, (_, n) => String(n + 1)).join('\n')
    gutter.scrollTop = i.scrollTop
    check()
  }
  const check = () => {
    try {
      compileScript(i.value)
      i.classList.remove('codeerr')
      errLine.style.display = 'none'
      errTag.textContent = ''
      errTag.classList.remove('bad')
    } catch (err) {
      i.classList.add('codeerr')
      const msg = String((err as Error)?.message || err).replace(/^SyntaxError: /, '').slice(0, 220)
      errLine.textContent = '⚠ ' + msg
      errLine.style.display = 'block'
      errTag.textContent = '⛔ syntax'
      errTag.classList.add('bad')
    }
  }
  syncLines()

  i.addEventListener('scroll', () => { gutter.scrollTop = i.scrollTop })
  i.addEventListener('input', () => {
    onChange(i.value)
    syncLines()
  })
  i.addEventListener('keydown', ev => {
    ev.stopPropagation()
    if (ev.key === 'Tab') {
      ev.preventDefault()
      const s = i.selectionStart ?? i.value.length
      const end = i.selectionEnd ?? s
      if (!ev.shiftKey) {
        i.value = i.value.slice(0, s) + '  ' + i.value.slice(end)
        i.selectionStart = i.selectionEnd = s + 2
      } else {
        const lineStart = i.value.lastIndexOf('\n', Math.max(0, s - 1)) + 1
        let remove = 0
        while (remove < 2 && i.value.slice(lineStart, lineStart + remove + 1).startsWith(' ')) remove++
        i.value = i.value.slice(0, lineStart) + i.value.slice(lineStart + remove)
        i.selectionStart = i.selectionEnd = Math.max(lineStart, s - remove)
      }
      onChange(i.value)
      syncLines()
    } else if (ev.key === 'Escape') {
      i.blur()
    }
  })
  body.append(gutter, i)
  row.append(head, body, errLine)
  void ed
  return row
}

/* ---------- helpers ---------- */

function round(x: number) { return Math.round(x * 100) / 100 }
function round2(x: number, decimals: number) {
  const m = Math.pow(10, decimals)
  return Math.round(x * m) / m
}
function decimalsOf(step: number): number {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}
