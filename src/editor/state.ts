/* ============ Nova Engine — Editor shared state ============ */

import type { Scene, Entity } from '../engine/core'
import type { Renderer2D, Cam2D } from '../engine/renderer2d'
import type { Renderer3D, OrbitState, PlayCamState } from '../engine/renderer3d'
import type { Input } from '../engine/input'
import type { ScriptHost } from '../engine/script'

export type LogLevel = 'info' | 'ok' | 'warn' | 'err'

export interface Editor {
  scene: Scene
  selection: string | null
  playing: boolean
  paused: boolean
  ended: boolean
  cam2dEdit: Cam2D
  cam2dPlay: Cam2D
  orbit: OrbitState
  playCam: PlayCamState
  r2d: Renderer2D
  r3d: Renderer3D
  input: Input
  host: ScriptHost
  shake: { amount: number; time: number }
  dirty: boolean
  refreshHierarchy(): void
  refreshInspector(): void
  refreshAll(): void
  applyMode(): void
  log(level: LogLevel, msg: string): void
  resetCameras(): void
  focusSelection(): void

  /* ---------- optional extras (installed by editor/actions.ts) ----------
     These stay optional so the Editor object literal in main.ts keeps compiling. */
  /** multi-selection. Invariant: always contains `selection` when non-empty. */
  selectionSet?: Set<string>
  /** entity ids locked against viewport edits (runtime-only, not persisted) */
  lockedIds?: Set<string>
  /** grid snapping for gizmo drags */
  snapEnabled?: boolean
  snapSize?: 8 | 16 | 32
  /** history (editor/history.ts) */
  pushUndo?(label: string): void
  undo?(): void
  redo?(): void
}

export function selectedEntity(ed: Editor): Entity | null {
  if (!ed.selection) return null
  return ed.scene.entities.find(e => e.id === ed.selection) || null
}

export function entityIcon(e: Entity): string {
  const tags = e.tags || []
  if (tags.includes('player')) return '🎮'
  const types = e.comps.map(c => c.type)
  if (types.includes('light3d')) return '💡'
  if (types.includes('script')) return '📜'
  if (types.includes('mesh3d')) return '🧊'
  if (types.includes('text2d')) return '🔤'
  if (types.includes('particles2d')) return '✨'
  if (types.includes('sprite2d')) return '🖼️'
  if (types.includes('body2d') || types.includes('rigid3d')) return '🧱'
  return '▪️'
}
