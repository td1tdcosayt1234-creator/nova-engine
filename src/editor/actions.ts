/* ============ Nova Engine — editor actions: install, selection, clipboard, align ============ */

import { getComp, type Entity } from '../engine/core'
import { addSpecToScene } from '../engine/spec'
import { presetSpec, type PresetKey } from './blank'
import { pushUndo, undo as histUndo, redo as histRedo } from './history'
import { initGizmo } from './gizmo'
import { menubarButton, uiRef, type MenuItem } from './ui'
import type { Editor } from './state'

/* ---------- runtime (non-persisted) lock registry ---------- */

const LOCKS = new Set<string>()
export function isLocked(ed: Editor, id: string | null): boolean {
  return !!id && !!ed.lockedIds && ed.lockedIds.has(id)
}
export function toggleLock(ed: Editor, id: string) {
  if (!ed.lockedIds) ed.lockedIds = LOCKS
  if (ed.lockedIds.has(id)) ed.lockedIds.delete(id)
  else ed.lockedIds.add(id)
  ed.refreshHierarchy()
}

/* ---------- selection helpers (array-friendly) ---------- */

export function selectionIds(ed: Editor): string[] {
  const set = ed.selectionSet
  if (set && set.size) {
    const ids = [...set].filter(id => ed.scene.entities.some(e => e.id === id))
    if (ed.selection && ids.includes(ed.selection)) {
      // primary first
      return [ed.selection, ...ids.filter(i => i !== ed.selection)]
    }
    return ids
  }
  return ed.selection ? [ed.selection] : []
}

export function selectedEntities(ed: Editor): Entity[] {
  return selectionIds(ed)
    .map(id => ed.scene.entities.find(e => e.id === id))
    .filter((e): e is Entity => !!e)
}

export function primeSelectionSet(ed: Editor) {
  if (!ed.selectionSet) ed.selectionSet = new Set<string>()
}

export function setSelection(ed: Editor, id: string | null) {
  primeSelectionSet(ed)
  ed.selectionSet!.clear()
  ed.selection = id
  if (id) ed.selectionSet!.add(id)
  else ed.selectionSet.delete('')
}

export function addSelection(ed: Editor, id: string) {
  if (!ed.selection) { setSelection(ed, id); return }
  primeSelectionSet(ed)
  const set = ed.selectionSet!
  set.add(ed.selection)
  set.add(id)
  ed.selection = id
}

export function toggleSelection(ed: Editor, id: string) {
  primeSelectionSet(ed)
  const set = ed.selectionSet!
  if (set.has(id)) {
    set.delete(id)
    if (ed.selection === id) ed.selection = [...set][0] || null
  } else {
    addSelection(ed, id)
  }
}

/** shift-click: range between primary and clicked id */
export function rangeSelection(ed: Editor, id: string) {
  const all = ed.scene.entities.map(e => e.id)
  if (!ed.selection) { setSelection(ed, id); return }
  const a = all.indexOf(ed.selection), b = all.indexOf(id)
  if (a < 0 || b < 0) { addSelection(ed, id); return }
  const [lo, hi] = a < b ? [a, b] : [b, a]
  primeSelectionSet(ed)
  const set = ed.selectionSet!
  for (let i = lo; i <= hi; i++) set.add(all[i])
  ed.selection = id
}

export function clearSelection(ed: Editor) {
  ed.selection = null
  primeSelectionSet(ed)
  ed.selectionSet!.clear()
}

export function selectAll(ed: Editor) {
  primeSelectionSet(ed)
  const set = ed.selectionSet!
  for (const e of ed.scene.entities) set.add(e.id)
  ed.selection = ed.scene.entities.length ? ed.scene.entities[ed.scene.entities.length - 1].id : null
  if (!ed.selection && set.size) ed.selection = [...set][0]
  ed.refreshAll()
}

export function selectionCount(ed: Editor): number {
  return selectionIds(ed).length
}

/* ---------- entity ops ---------- */

export function uniqueName(ed: Editor, base: string, ignoreId?: string): string {
  let n = base
  let i = 2
  while (ed.scene.entities.some(e => e.name === n && e.id !== ignoreId)) n = `${base} ${i++}`
  return n
}

const CLIP_KEY = 'nova.clipboard'

export function copySelection(ed: Editor): number {
  const list = selectedEntities(ed)
  if (!list.length) return 0
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(list))
    return list.length
  } catch {
    return 0
  }
}

export function readClipboard(): Entity[] | null {
  try {
    const raw = localStorage.getItem(CLIP_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr) || !arr.every(x => x && typeof x === 'object' && 'id' in x)) return null
    return arr as Entity[]
  } catch {
    return null
  }
}

export function pasteClipboard(ed: Editor, offset = 24): Entity[] {
  const clip = readClipboard()
  if (!clip) return []
  const created: Entity[] = []
  try {
    for (const src of clip) {
      const copy: Entity = JSON.parse(JSON.stringify(src))
      copy.id = genId()
      copy.name = uniqueName(ed, src.name)
      copy.transform.pos.x += offset
      copy.transform.pos.y -= offset
      ed.scene.entities.push(copy)
      created.push(copy)
    }
  } catch (err) {
    ed.log('err', 'Paste failed: ' + String(err).slice(0, 140))
    return []
  }
  if (created.length) {
    setSelection(ed, created[created.length - 1].id)
    for (const e of created) ed.selectionSet!.add(e.id)
    ed.selection = created[0].id
    ed.refreshAll()
    ed.log('ok' as any, `Pasted ${created.length} entit${created.length > 1 ? 'ies' : 'y'}`)
  }
  return created
}

function genId(): string {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function cloneEntities(ed: Editor, list: Entity[], selectClone = true): Entity[] {
  const copies: Entity[] = []
  for (const src of list) {
    const c: Entity = JSON.parse(JSON.stringify(src))
    c.id = genId()
    c.name = uniqueName(ed, src.name)
    const i = ed.scene.entities.findIndex(e => e.id === src.id)
    if (i >= 0) ed.scene.entities.splice(i + 1, 0, c)
    else ed.scene.entities.push(c)
    copies.push(c)
  }
  if (selectClone && copies.length) {
    setSelection(ed, copies[0].id)
    for (const c of copies) ed.selectionSet!.add(c.id)
    ed.selection = copies[0].id
  }
  return copies
}

export function deleteEntities(ed: Editor, ids: string[]): number {
  for (const id of ids) {
    ed.scene.remove(id)
    if (ed.selection === id) ed.selection = null
    if (ed.selectionSet) ed.selectionSet.delete(id)
  }
  ed.refreshAll()
  return ids.length
}

/* ---------- transforms / align ---------- */

export function entSize(e: Entity): { w: number; h: number } {
  const b = getComp(e as Entity, 'body2d') as { w: number; h: number } | null
  const s = getComp(e as Entity, 'sprite2d') as { w: number; h: number } | null
  return { w: b?.w || s?.w || 40, h: b?.h || s?.h || 40 }
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v' | 'dist-x' | 'dist-y'

export function alignSelection(ed: Editor, mode: AlignMode): number {
  const list = selectedEntities(ed)
  if (!list.length) return 0
  if (list.length === 1 && !['center-h', 'center-v'].includes(mode)) return 0
  pushUndo(ed, `Align ${mode}`)
  const boxes = list.map(e => {
    const { w, h } = entSize(e)
    return { e, x0: e.transform.pos.x - w / 2, x1: e.transform.pos.x + w / 2, y0: e.transform.pos.y - h / 2, y1: e.transform.pos.y + h / 2 }
  })
  if (list.length === 1) {
    const b = boxes[0]
    if (mode === 'center-h') b.e.transform.pos.x = 0
    if (mode === 'center-v') b.e.transform.pos.y = 0
  } else {
    const x0 = Math.min(...boxes.map(b => b.x0)), x1 = Math.max(...boxes.map(b => b.x1))
    const y0 = Math.min(...boxes.map(b => b.y0)), y1 = Math.max(...boxes.map(b => b.y1))
    for (const b of boxes) {
      const w = entSize(b.e).w, h = entSize(b.e).h
      if (mode === 'left') b.e.transform.pos.x = x0 + w / 2
      if (mode === 'right') b.e.transform.pos.x = x1 - w / 2
      if (mode === 'top') b.e.transform.pos.y = y1 - h / 2
      if (mode === 'bottom') b.e.transform.pos.y = y0 + h / 2
      if (mode === 'center-h') b.e.transform.pos.x = (x0 + x1) / 2
      if (mode === 'center-v') b.e.transform.pos.y = (y0 + y1) / 2
    }
    if (mode === 'dist-x' && list.length > 2) {
      const sorted = [...boxes].sort((a, b) => a.e.transform.pos.x - b.e.transform.pos.x)
      const span = sorted[sorted.length - 1].e.transform.pos.x - sorted[0].e.transform.pos.x
      const step = span / (list.length - 1)
      sorted.forEach((b, i) => { b.e.transform.pos.x = sorted[0].e.transform.pos.x + i * step })
    }
    if (mode === 'dist-y' && list.length > 2) {
      const sorted = [...boxes].sort((a, b) => a.e.transform.pos.y - b.e.transform.pos.y)
      const span = sorted[sorted.length - 1].e.transform.pos.y - sorted[0].e.transform.pos.y
      const step = span / (list.length - 1)
      sorted.forEach((b, i) => { b.e.transform.pos.y = sorted[0].e.transform.pos.y + i * step })
    }
  }
  ed.refreshAll()
  return list.length
}

export function nudgeSelection(ed: Editor, dx: number, dy: number) {
  const list = selectedEntities(ed)
  if (!list.length) return
  pushUndo(ed, 'Nudge selection')
  for (const e of list) {
    e.transform.pos.x += dx
    e.transform.pos.y += dy
  }
  ed.refreshInspector()
}

export function addPresetToScene(ed: Editor, key: PresetKey) {
  const mode = ed.scene.meta.mode
  const e = addSpecToScene(ed.scene, presetSpecClone(key, mode))
  e.name = uniqueName(ed, e.name)
  setSelection(ed, e.id)
  ed.refreshAll()
  return e
}

function presetSpecClone(key: PresetKey, mode: '2d' | '3d') {
  const s = presetSpec(key, mode)
  return JSON.parse(JSON.stringify(s))
}

/* ---------- gizmo snap setting ---------- */

const SNAP_KEY = 'nova.snap'

export function loadSnap(): { enabled: boolean; size: 8 | 16 | 32 } {
  try {
    const raw = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      return { enabled: !!raw.enabled, size: ([8, 16, 32] as const).includes(raw.size) ? raw.size as 8 | 16 | 32 : 16 }
    }
  } catch { /* corrupt — fall through */ }
  return { enabled: true, size: 16 }
}
export function saveSnap(enabled: boolean, size: 8 | 16 | 32) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify({ enabled, size })) } catch { /* quota */ }
}

/* ---------- Edit menu ---------- */

export function editMenuItems(ed: Editor): MenuItem[] {
  return [
    { label: '↶ Undo', hint: 'Ctrl+Z', action: () => ed.undo?.() },
    { label: '↪ Redo', hint: 'Ctrl+Shift+Z', action: () => ed.redo?.() },
    { sep: true },
    { label: 'Copy', hint: 'Ctrl+C', action: () => { const n = copySelection(ed); if (n) toastSel(n, 'copied', ed) } },
    { label: 'Paste', hint: 'Ctrl+V', action: () => pushUndo2(ed, pasteClipboard) },
    { label: 'Cut', hint: 'Ctrl+X', action: () => {
        const ids = selectionIds(ed)
        if (copySelection(ed) && ids.length) { pushUndo(ed, 'Cut entities'); deleteEntities(ed, ids); ed.log('ok', '✂ Cut ' + ids.length) }
      } },
    { sep: true },
    { label: 'Select All', hint: 'Ctrl+A', action: () => selectAll(ed) },
    { label: 'Deselect', hint: 'Esc', action: () => { clearSelection(ed); ed.refreshAll() } },
    { sep: true },
    { label: 'Align Left', hint: '', action: () => { if (alignSelection(ed, 'left')) ed.log('ok', '⬅ Aligned left') } },
    { label: 'Align Right', hint: '', action: () => { if (alignSelection(ed, 'right')) ed.log('ok', '➡ Aligned right') } },
    { label: 'Align Top', hint: '', action: () => { if (alignSelection(ed, 'top')) ed.log('ok', '⬆ Aligned top') } },
    { label: 'Align Bottom', hint: '', action: () => { if (alignSelection(ed, 'bottom')) ed.log('ok', '⬇ Aligned bottom') } },
    { label: 'Center H', hint: '', action: () => { if (alignSelection(ed, 'center-h')) ed.log('ok', '⇔ Centered H') } },
    { label: 'Center V', hint: '', action: () => { if (alignSelection(ed, 'center-v')) ed.log('ok', '⇕ Centered V') } },
    { sep: true },
    { label: 'Duplicate', hint: 'Ctrl+D', action: () => { const ids = selectionIds(ed); const list = selectedEntities(ed); if (list.length) { pushUndo(ed, 'Duplicate'); const next = cloneEntities(ed, list); void ids; ed.log('ok', `⧉ Duplicated ${next.length}`) } } },
    { label: 'Delete', hint: 'Del', action: () => { const ids = selectionIds(ed); if (ids.length) { pushUndo(ed, 'Delete'); deleteEntities(ed, ids); ed.log('warn', `🗑 Deleted ${ids.length}`) } } }
  ]
}

/* helper indirection so imports stay tidy */
function pushUndo2(ed: Editor, fn: (ed: Editor, o?: number) => Entity[]) {
  const before = readClipboard()
  if (!before || !before.length) { ed.log('info', 'Clipboard is empty'); return }
  pushUndo(ed, 'Paste entities')
  fn(ed, 24)
}

function toastSel(n: number, verb: string, ed: Editor) {
  ed.log('info', `📋 ${n} entit${n > 1 ? 'ies' : 'y'} ${verb}`)
}

/* ---------- one-time install ---------- */

let kbInstalled = false
const installedWeak = new WeakSet<Editor>()

export function installEditor(ed: Editor) {
  if (installedWeak.has(ed)) return
  installedWeak.add(ed)

  primeSelectionSet(ed)
  ed.lockedIds = LOCKS
  const snap = loadSnap()
  ed.snapEnabled = snap.enabled
  ed.snapSize = snap.size

  ed.pushUndo = (label: string) => pushUndo(ed, label)
  ed.undo = () => histUndo(ed)
  ed.redo = () => histRedo(ed)

  const refs = uiRef()

  /* Edit menu button — placed before the existing menubuttons */
  if (refs && refs.menuHost) {
    const host = refs.menuHost
    if (!host.querySelector('[data-editmenu]')) {
      const btn = menubarButton(host, 'Edit', editMenuItems(ed))
      btn.dataset.editmenu = '1'
      btn.setAttribute('data-editmenu', '1')
      host.insertBefore(btn, host.firstChild)
    }
  }

  /* gizmo: self-initializing (main.ts may or may not call initGizmo) */
  if (refs) initGizmo(ed, refs.vp2d, refs.vp3d)

  installKeyboard(ed)

  ed.log('info', '✨ Editor enhancements ready (hierarchy, inspector, gizmo, undo/redo)')
}

function editingBlocked(ed: Editor): boolean {
  if (document.querySelector('.modal-back')) return true
  const app = document.getElementById('app')
  if (app && app.classList.contains('editorhidden')) return true
  return false
}

function installKeyboard(ed: Editor) {
  if (kbInstalled) return
  kbInstalled = true
  window.addEventListener('keydown', ev => {
    if (ed.playing) return
    if (editingBlocked(ed)) return
    const t = document.activeElement as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    const mod = ev.ctrlKey || ev.metaKey

    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault()
      if (ev.shiftKey) ed.redo?.()
      else ed.undo?.()
      return
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault()
      ed.redo?.()
      return
    }
    if (typing) return
    if (mod && ev.key.toLowerCase() === 'a') {
      ev.preventDefault()
      selectAll(ed)
      return
    }
    if (mod && ev.key.toLowerCase() === 'c') {
      const n = copySelection(ed)
      if (n) { ed.log('info', `📋 Copied ${n}`); ev.preventDefault() }
      return
    }
    if (mod && ev.key.toLowerCase() === 'x') {
      const ids = selectionIds(ed)
      if (ids.length) {
        pushUndo(ed, 'Cut entities')
        copySelection(ed)
        deleteEntities(ed, ids)
        ed.log('ok', `✂ Cut ${ids.length}`)
        ev.preventDefault()
      }
      return
    }
    if (mod && ev.key.toLowerCase() === 'v') {
      ev.preventDefault()
      pushUndo2(ed, pasteClipboard)
      return
    }
    /* arrow key nudge (plain = fine step, shift = big step) */
    const fine = ed.scene.meta.mode === '3d' ? 0.25 : 2
    const big = fine * 8
    const step = ev.shiftKey ? big : fine
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); nudgeSelection(ed, -step, 0) }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); nudgeSelection(ed, step, 0) }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); nudgeSelection(ed, 0, step) }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); nudgeSelection(ed, 0, -step) }
  })
}
