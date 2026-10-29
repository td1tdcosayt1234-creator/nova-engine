/* ============ Nova Engine — Undo/Redo (snapshot based) ============ */

import { serializeScene, deserializeScene } from '../engine/core'
import type { Editor } from './state'

export interface HistoryEntry {
  label: string
  json: string
  t: number
}

const MAX_HISTORY = 50
const undoStack: HistoryEntry[] = []
const redoStack: HistoryEntry[] = []

let busy = false          // true while we are applying a snapshot ourselves
let lastRestoreOk = true

function capture(ed: Editor): string {
  return serializeScene(ed.scene)
}

/** Capture the CURRENT (pre-mutation) scene as an undo point. Call BEFORE mutating. */
export function pushUndo(ed: Editor, label: string) {
  if (busy) return
  if (ed.playing) return                        // play mode is transient — stop restores it
  const json = capture(ed)
  const top = undoStack[undoStack.length - 1]
  if (top && top.json === json) return          // identical state → nothing changed
  undoStack.push({ label, json, t: Date.now() })
  while (undoStack.length > MAX_HISTORY) undoStack.shift()
  redoStack.length = 0
}

/** Convenience: pushUndo then run the mutation. */
export function withUndo<T>(ed: Editor, label: string, fn: () => T): T {
  pushUndo(ed, label)
  return fn()
}

function applySnapshot(ed: Editor, json: string) {
  try {
    const s = deserializeScene(json)
    ed.scene.meta = s.meta
    ed.scene.entities = s.entities
    if (ed.selection && !s.entities.some(e => e.id === ed.selection)) ed.selection = null
    if (ed.selectionSet) {
      for (const id of [...ed.selectionSet]) {
        if (!s.entities.some(e => e.id === id)) ed.selectionSet.delete(id)
      }
      if (!ed.selection && ed.selectionSet.size) {
        ed.selection = [...ed.selectionSet][0]
      }
      if (ed.selection && !ed.selectionSet.has(ed.selection)) ed.selectionSet.add(ed.selection)
    }
    if (typeof ed.lockedIds === 'object') {
      for (const id of [...(ed.lockedIds as Set<string>)]) {
        if (!s.entities.some(e => e.id === id)) (ed.lockedIds as Set<string>).delete(id)
      }
    }
    lastRestoreOk = true
    ed.refreshAll()
    ed.applyMode()
  } catch (err) {
    lastRestoreOk = false
    ed.log('err', '↶ Undo/Redo apply failed: ' + String(err).slice(0, 160))
  }
}

/** Restore the previous state. */
export function undo(ed: Editor) {
  if (busy) return
  if (ed.playing) { ed.log('info', 'Undo is disabled while playing — Stop first'); return }
  const prev = undoStack.pop()
  if (!prev) { ed.log('info', 'Nothing to undo'); return }
  busy = true
  try {
    redoStack.push({ label: prev.label, json: capture(ed), t: Date.now() })
    while (redoStack.length > MAX_HISTORY) redoStack.shift()
    applySnapshot(ed, prev.json)
    ed.log('info', `↶ Undo: ${prev.label}`)
  } finally { busy = false }
}

/** Re-apply the last undone state. */
export function redo(ed: Editor) {
  if (busy) return
  if (ed.playing) { ed.log('info', 'Redo is disabled while playing — Stop first'); return }
  const next = redoStack.pop()
  if (!next) { ed.log('info', 'Nothing to redo'); return }
  busy = true
  try {
    undoStack.push({ label: next.label, json: capture(ed), t: Date.now() })
    while (undoStack.length > MAX_HISTORY) undoStack.shift()
    applySnapshot(ed, next.json)
    ed.log('info', `↪ Redo: ${next.label}`)
  } finally { busy = false }
}

export function canUndo(): boolean { return undoStack.length > 0 }
export function canRedo(): boolean { return redoStack.length > 0 }
export function lastUndoLabel(): string | null {
  const t = undoStack[undoStack.length - 1]
  return t ? t.label : null
}
export function lastRestoreFailed(): boolean { return !lastRestoreOk }
export function clearHistory() {
  undoStack.length = 0
  redoStack.length = 0
}
