/* ============ Nova Engine — Hierarchy panel ============
   Self-initializes on first renderHierarchy() call (main.ts calls
   renderHierarchy via editor.refreshHierarchy). */

import { getComp, type Entity } from '../engine/core'
import { compLabel, COMP_DEFS } from '../engine/components'
import { addSpecToScene } from '../engine/spec'
import { entityIcon, type Editor } from './state'
import { showDropdown, showContextMenu, toast, uiRef, type MenuItem } from './ui'
import { presetList, presetSpec } from './blank'
import {
  installEditor, setSelection, toggleSelection, rangeSelection, selectionIds,
  uniqueName, deleteEntities, cloneEntities, copySelection, readClipboard,
  toggleLock, isLocked, pasteClipboard
} from './actions'
import { pushUndo } from './history'

let filter = ''
let inited = false
let searchEl: HTMLInputElement | null = null
/** set by F2 → next render starts inline rename on this row */
let pendingRenameId: string | null = null

export function initHierarchy(ed: Editor, listEl: HTMLElement, addBtn: HTMLButtonElement) {
  ensureInit(ed, listEl, addBtn)
}

/* ---------- one-time setup (safe to call repeatedly) ---------- */

function ensureInit(ed: Editor, listEl: HTMLElement, addBtn?: HTMLButtonElement) {
  if (inited) return
  const parent = listEl.parentElement
  if (!parent) return
  inited = true

  installEditor(ed)

  /* toolbar row: fuzzy search + clear */
  const bar = document.createElement('div')
  bar.className = 'htool'
  searchEl = document.createElement('input')
  searchEl.className = 'hsearch'
  searchEl.placeholder = '🔎 Filter entities… (fuzzy)'
  searchEl.setAttribute('autocomplete', 'off')
  searchEl.addEventListener('input', () => {
    filter = searchEl!.value
    renderHierarchy(ed, listEl)
  })
  searchEl.addEventListener('keydown', ev => {
    ev.stopPropagation()
    if (ev.key === 'Escape') { searchEl!.value = ''; filter = ''; renderHierarchy(ed, listEl); (ev.target as HTMLInputElement).blur() }
    if (ev.key === 'Enter') {
      const first = listEl.querySelector<HTMLElement>('.hitem')
      if (first) {
        setSelection(ed, first.dataset.id || null)
        ed.refreshAll()
      }
    }
  })
  bar.appendChild(searchEl)
  parent.insertBefore(bar, listEl)

  /* ＋ button → preset dropdown */
  if (addBtn) {
    addBtn.title = 'Add entity (presets)'
    addBtn.addEventListener('click', () => {
      if (ed.playing) { toast('warn', 'Stop play mode first'); return }
      const mode = ed.scene.meta.mode
      const items: MenuItem[] = presetList(mode).map(p => ({
        label: `${p.icon} ${p.label}`,
        hint: '',
        action: () => {
          const e = addSpecToScene(ed.scene, JSON.parse(JSON.stringify(presetSpec(p.key, mode))))
          e.name = uniqueName(ed, e.name)
          setSelection(ed, e.id)
          ed.refreshAll()
          toast('ok', `Added ${p.label}`)
        }
      }))
      const empty: MenuItem = {
        label: '▪️ Empty Entity',
        hint: '',
        action: () => {
          const e = ed.scene.createEntity(uniqueName(ed, 'Entity'), [
            { type: 'sprite2d', sprite: 'none', color: '#7c5cff', w: 60, h: 60, seed: 7, screen: false }
          ])
          setSelection(ed, e.id)
          ed.refreshAll()
          toast('ok', 'Created empty entity')
        }
      }
      showDropdown(addBtn, [empty, { sep: true } as MenuItem, ...items])
    })
  }

  /* delegated events on the list (rows are rebuilt every render) */
  listEl.addEventListener('click', ev => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    if (!row || !row.dataset.id) return
    const act = (ev.target as HTMLElement).dataset.act
    if (act) { ev.stopPropagation(); handleRowAction(ed, listEl, row.dataset.id, act); return }
    if (ev.ctrlKey || ev.metaKey) toggleSelection(ed, row.dataset.id)
    else if (ev.shiftKey) rangeSelection(ed, row.dataset.id)
    else setSelection(ed, row.dataset.id)
    ed.refreshHierarchy()
    ed.refreshInspector()
  })

  listEl.addEventListener('dblclick', ev => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    if (row?.dataset.id) startRename(ed, listEl, row.dataset.id)
  })

  listEl.addEventListener('contextmenu', ev => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    if (!row?.dataset.id) return
    ev.preventDefault()
    const id = row.dataset.id
    if (!ed.selection || (ed.selectionSet && !ed.selectionSet.has(id))) setSelection(ed, id)
    showContextMenu(ev.clientX, ev.clientY, contextItems(ed, listEl, id))
  })

  /* drag-drop reorder (flat list reorder = z-order) */
  listEl.addEventListener('dragstart', ev => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    if (!row) return
    ev.dataTransfer?.setData('text/nova.entity', row.dataset.id || '')
    ev.dataTransfer!.effectAllowed = 'move'
    row.classList.add('dragging')
  })
  listEl.addEventListener('dragover', ev => {
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    listEl.querySelectorAll('.drop-above, .drop-below').forEach(x => x.classList.remove('drop-above', 'drop-below'))
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    if (row) row.classList.add(ev.offsetY < row.offsetHeight / 2 ? 'drop-above' : 'drop-below')
  })
  listEl.addEventListener('dragleave', ev => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    row?.classList.remove('drop-above', 'drop-below')
  })
  listEl.addEventListener('drop', ev => {
    ev.preventDefault()
    const srcId = ev.dataTransfer?.getData('text/nova.entity')
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.hitem')
    listEl.querySelectorAll('.drop-above, .drop-below, .dragging').forEach(x => x.classList.remove('drop-above', 'drop-below', 'dragging'))
    if (!srcId || !row?.dataset.id || srcId === row.dataset.id) return
    reorderEntity(ed, srcId, row.dataset.id, row.classList.contains('drop-above'))
  })
  listEl.addEventListener('dragend', () => {
    listEl.querySelectorAll('.drop-above, .drop-below, .dragging').forEach(x => x.classList.remove('drop-above', 'drop-below', 'dragging'))
  })
}

/* ---------- reorder ---------- */

function reorderEntity(ed: Editor, srcId: string, targetId: string, above: boolean) {
  const ent = ed.scene.entities.find(e => e.id === srcId)
  const tIdx = ed.scene.entities.findIndex(e => e.id === targetId)
  if (!ent || tIdx < 0) return
  pushUndo(ed, 'Reorder entity')
  ed.scene.entities.splice(ed.scene.entities.indexOf(ent), 1)
  const tIdx2 = ed.scene.entities.findIndex(e => e.id === targetId)
  ed.scene.entities.splice(above ? tIdx2 : tIdx2 + 1, 0, ent)
  setSelection(ed, srcId)
  ed.refreshAll()
  toast('ok', `Reordered "${ent.name}"`)
}

/* ---------- row actions (vis / del / lock) ---------- */

function handleRowAction(ed: Editor, listEl: HTMLElement, id: string, act: string) {
  const e = ed.scene.entities.find(x => x.id === id)
  if (!e) return
  if (act === 'vis') {
    if (ed.playing) { toast('warn', 'Stop play mode first'); return }
    e.visible = !e.visible
    ed.refreshAll()
    return
  }
  if (act === 'lock') {
    toggleLock(ed, id)
    return
  }
  if (act === 'del') {
    deleteById(ed, [id])
    return
  }
}

export function deleteById(ed: Editor, ids: string[]) {
  if (!ids.length) return
  if (ed.playing) { toast('warn', 'Stop play mode before deleting entities'); return }
  const names = ids.map(i => ed.scene.entities.find(x => x.id === i)?.name).filter(Boolean)
  pushUndo(ed, `Delete ${ids.length > 1 ? names.length + ' entities' : names[0]}`)
  deleteEntities(ed, ids)
  toast('warn', `Deleted ${names.join(', ')}`)
}

/* ---------- context menu ---------- */

function contextItems(ed: Editor, listEl: HTMLElement, id: string): MenuItem[] {
  const e = ed.scene.entities.find(x => x.id === id)!
  const ids = selectionIds(ed)
  const multi = ids.length > 1
  const locked = isLocked(ed, id)
  const onSel = ids.includes(id)
  const items: MenuItem[] = [
    { label: multi && onSel ? `✏️ Rename (primary)` : '✏️ Rename', hint: 'F2', action: () => startRename(ed, listEl, id) },
    {
      label: `⧉ Duplicate${multi && onSel ? ` (${ids.length})` : ''}`, hint: 'Ctrl+D', action: () => {
        if (ed.playing) { toast('warn', 'Stop play mode first'); return }
        const list = selectedOf(ed, id)
        pushUndo(ed, `Duplicate ${list.length > 1 ? list.length + ' entities' : e.name}`)
        const c = cloneEntities(ed, list)
        ed.refreshAll()
        toast('ok', `Duplicated ${c.length}`)
      }
    },
    {
      label: `🗑 Delete${multi && onSel ? ` (${ids.length})` : ''}`, hint: 'Del', action: () => {
        deleteById(ed, ed.playing ? [] : (onSel ? selectionIds(ed) : [id]))
      }
    },
    { sep: true },
    {
      label: `📋 Copy${multi && onSel ? ` (${ids.length})` : ''}`, hint: 'Ctrl+C', action: () => {
        if (!onSel) setSelection(ed, id)
        const n = copySelection(ed)
        toast(n ? 'ok' : 'warn', n ? `Copied ${n} entit${n > 1 ? 'ies' : 'y'}` : 'Nothing copied')
      }
    },
    {
      label: '📥 Paste', hint: 'Ctrl+V', action: () => {
        if (ed.playing) { toast('warn', 'Stop play mode first'); return }
        if (!readClipboard()) { toast('warn', 'Clipboard is empty'); return }
        pushUndo(ed, 'Paste entities')
        pasteClipboard(ed, 24)
      }
    },
    { sep: true },
    {
      label: '⬆ Move Up', action: () => moveEntity(ed, id, -1)
    },
    {
      label: '⬇ Move Down', action: () => moveEntity(ed, id, +1)
    },
    { sep: true },
    {
      label: e.visible ? '🚫 Hide' : '👁 Show', action: () => {
        if (ed.playing) { toast('warn', 'Stop play mode first'); return }
        e.visible = !e.visible
        ed.refreshAll()
      }
    },
    {
      label: locked ? '🔓 Unlock editing' : '🔒 Lock editing', action: () => {
        toggleLock(ed, id)
      }
    },
    { sep: true }
  ]
  /* add-component section */
  const have = new Set(e.comps.map(c => c.type))
  const firstComp = Object.entries(COMP_DEFS).find(([k]) => !have.has(k))
  if (firstComp) {
    items.push({ label: `➕ Add Component — ${firstComp[1].label}`, action: () => addCompTo(ed, e, firstComp[0]) })
    for (const [k, def] of Object.entries(COMP_DEFS)) {
      if (k === firstComp[0] || have.has(k)) continue
      items.push({ label: `　▸ ${def.icon} ${def.label}`, action: () => addCompTo(ed, e, k) })
    }
  } else {
    items.push({ label: '✅ All components added', hint: '' })
  }
  return items
}

function selectedOf(ed: Editor, id: string): Entity[] {
  const cur = selectionIds(ed)
  if (cur.includes(id) && cur.length > 1) {
    return cur.map(i => ed.scene.entities.find(x => x.id === i)).filter((x): x is Entity => !!x)
  }
  return [ed.scene.entities.find(x => x.id === id) as Entity]
}

function addCompTo(ed: Editor, e: Entity, type: string) {
  if (ed.playing) { toast('warn', 'Stop play mode first'); return }
  if (getComp(e, type)) { toast('warn', `${compLabel(type)} already exists`); return }
  pushUndo(ed, `Add ${compLabel(type)}`)
  const def = COMP_DEFS[type]
  if (!def) return
  e.comps.push(def.defaults())
  setSelection(ed, e.id)
  ed.refreshAll()
  toast('ok', `Added ${compLabel(type)}`)
}

function moveEntity(ed: Editor, id: string, dir: number) {
  const list = ed.scene.entities
  const i = list.findIndex(e => e.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) { toast('info', 'Already at the edge'); return }
  pushUndo(ed, 'Move entity')
  ;[list[i], list[j]] = [list[j], list[i]]
  ed.refreshAll()
}

/* ---------- inline rename ---------- */

function startRename(ed: Editor, listEl: HTMLElement, id: string) {
  const row = listEl.querySelector<HTMLElement>(`.hitem[data-id="${id}"]`)
  if (!row) return
  const e = ed.scene.entities.find(x => x.id === id)
  if (!e) return
  const nameSpan = row.querySelector<HTMLElement>('.hname')
  if (!nameSpan) return
  if (row.querySelector('.hrename')) return

  const input = document.createElement('input')
  input.className = 'hrename'
  input.value = e.name
  input.setAttribute('autocomplete', 'off')
  nameSpan.replaceWith(input)
  input.focus()
  input.select()

  let done = false
  const finish = (commit: boolean) => {
    if (done) return
    done = true
    const val = input.value.trim()
    if (commit && val && val !== e.name) {
      pushUndo(ed, `Rename → ${val}`)
      e.name = uniqueName(ed, val, e.id)
      if (ed.selection === e.id) {
        // keep inspector in sync (name field)
        ed.refreshInspector()
      }
      toast('ok', `Renamed to "${e.name}"`)
    }
    ed.refreshHierarchy()
  }
  input.addEventListener('keydown', ev => {
    ev.stopPropagation()
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

/* ---------- fuzzy match ---------- */

export function fuzzyScore(needle: string, hay: string): number {
  const n = needle.toLowerCase().trim()
  if (!n) return 1
  const h = hay.toLowerCase()
  let score = 0
  let cursor = 0
  for (const ch of n) {
    const idx = h.indexOf(ch, cursor)
    if (idx < 0) return 0
    if (idx === cursor) score += 3
    if (idx === 0) score += 2
    cursor = idx + 1
  }
  return score / (n.length + 3)
}

function matches(e: Entity, q: string): number {
  if (!q.trim()) return 1
  const a = fuzzyScore(q, e.name)
  let best = a
  for (const t of e.tags) {
    const s = fuzzyScore(q, t) * 0.9
    if (s > best) best = s
  }
  if (e.comps.some(c => compLabel(c.type).toLowerCase().includes(q.toLowerCase()))) best = Math.max(best, 0.4)
  return best
}

/* ---------- render ---------- */

export function renderHierarchy(ed: Editor, listEl: HTMLElement) {
  ensureInit(ed, listEl, uiRef()?.hierarchyAdd)

  const query = filter
  const ents = ed.scene.entities
    .map((e, idx) => ({ e, idx, score: matches(e, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => a.idx - b.idx)

  listEl.innerHTML = ''
  const selSet = ed.selectionSet

  for (const { e } of ents) {
    const row = document.createElement('div')
    row.dataset.id = e.id
    row.draggable = !ed.playing
    const selected = e.id === ed.selection || (selSet?.has(e.id) ?? false)
    row.className = 'hitem'
      + (selected ? ' sel' : '')
      + (e.id === ed.selection ? ' primary' : '')
      + (e.visible ? '' : ' hidden-ent')
      + (isLocked(ed, e.id) ? ' locked-ent' : '')

    const dot = document.createElement('span')
    dot.className = 'tagdot'
    dot.style.background = tagColor(e)

    const icon = document.createElement('span')
    icon.textContent = entityIcon(e)
    icon.className = 'hicon'

    const name = document.createElement('span')
    name.className = 'hname'
    name.textContent = e.name

    const extra = document.createElement('span')
    extra.className = 'hscript'
    extra.textContent = e.comps.some(c => c.type === 'script') ? 'ƒ' : ''

    const lock = document.createElement('button')
    lock.className = 'hctl hlockctl'
    lock.dataset.act = 'lock'
    lock.textContent = '🔒'
    lock.title = isLocked(ed, e.id) ? 'Unlock (prevents viewport editing)' : 'Lock editing'

    const vis = document.createElement('button')
    vis.className = 'hctl'
    vis.dataset.act = 'vis'
    vis.textContent = e.visible ? '👁' : '🚫'
    vis.title = e.visible ? 'Hide entity' : 'Show entity'

    const del = document.createElement('button')
    del.className = 'hctl hdelctl'
    del.dataset.act = 'del'
    del.textContent = '✕'
    del.title = 'Delete entity (Del)'

    row.append(dot, icon, name, extra, lock, vis, del)
    listEl.appendChild(row)

    if (pendingRenameId === e.id) {
      pendingRenameId = null
      startRename(ed, listEl, e.id)
    }
  }

  if (!ed.scene.entities.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-note'
    empty.textContent = 'No entities. Use ＋ above or ask the AI Builder!'
    listEl.appendChild(empty)
  } else if (!ents.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-note'
    empty.textContent = 'No match for this filter.'
    listEl.appendChild(empty)
  }

  /* entity count badge */
  const badge = document.querySelector('.panel-badge') as HTMLElement | null
  if (badge) {
    if (query.trim()) {
      badge.textContent = `${ents.length}/${ed.scene.entities.length}`
    } else {
      badge.textContent = String(ed.scene.entities.length)
    }
    badge.title = 'Entity count' + (query.trim() ? ' (filtered)' : '')
  }
}

function tagColor(e: { tags: string[]; comps: Array<{ type: string }> }): string {
  if (e.tags.includes('player')) return '#34d399'
  if (e.tags.includes('enemy')) return '#f87171'
  if (e.tags.includes('coin')) return '#fbbf24'
  if (e.tags.includes('ground')) return '#64748b'
  if (e.comps.some(c => c.type === 'light3d')) return '#fde047'
  return '#4b5675'
}

/** F2 / context-menu entry point for keyboard rename */
export function beginKeyboardRename(ed: Editor) {
  if (!ed.selection) return
  pendingRenameId = ed.selection
  ed.refreshHierarchy()
}

/* used by gizmo delete / keyboard flows */
export function hasPhysics(e: Entity): boolean {
  return !!getComp(e, 'body2d') || !!getComp(e, 'rigid3d')
}
