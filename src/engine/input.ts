/* ============ Nova Engine — Input ============ */

const GAME_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'
])

export type MouseState = {
  x: number; y: number           // viewport-local pixels
  wx: number; wy: number         // world coords (filled in by the 2D game loop)
  inside: boolean
  dx: number; dy: number         // movement this frame
  left: boolean; right: boolean; mid: boolean          // held
  leftPressed: boolean; rightPressed: boolean          // went down this frame
  wheel: number                  // wheel delta this frame
  dbl: boolean                   // double-click went off this frame
}

export class Input {
  enabled = false
  downSet = new Set<string>()
  pressedSet = new Set<string>()
  mouse: MouseState = {
    x: 0, y: 0, wx: 0, wy: 0, inside: false,
    dx: 0, dy: 0,
    left: false, right: false, mid: false,
    leftPressed: false, rightPressed: false,
    wheel: 0, dbl: false
  }
  wheel = 0
  touch = { active: false, x: 0, y: 0 }
  private el: HTMLElement | null = null
  private handlers: Array<[string, any, any?]> = []

  attach(el: HTMLElement) {
    this.el = el

    const kd = (ev: KeyboardEvent) => {
      if (!this.enabled) return
      const c = ev.code
      if (GAME_CODES.has(c)) ev.preventDefault()
      if (!this.downSet.has(c)) this.pressedSet.add(c)
      this.downSet.add(c)
    }
    const ku = (ev: KeyboardEvent) => { this.downSet.delete(ev.code) }
    const blur = () => { this.downSet.clear(); this.mouse.left = false; this.mouse.right = false; this.mouse.mid = false; this.touch.active = false }

    const setPos = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect()
      this.mouse.x = cx - r.left
      this.mouse.y = cy - r.top
      this.touch.x = this.mouse.x
      this.touch.y = this.mouse.y
    }

    const mm = (ev: MouseEvent) => {
      setPos(ev.clientX, ev.clientY)
      this.mouse.dx += ev.movementX ?? 0
      this.mouse.dy += ev.movementY ?? 0
    }
    const md = (ev: MouseEvent) => {
      setPos(ev.clientX, ev.clientY)
      if (ev.button === 0) { if (!this.mouse.left) this.mouse.leftPressed = true; this.mouse.left = true }
      if (ev.button === 1) this.mouse.mid = true
      if (ev.button === 2) { if (!this.mouse.right) this.mouse.rightPressed = true; this.mouse.right = true }
    }
    const mu = (ev: MouseEvent) => {
      if (ev.button === 0) this.mouse.left = false
      if (ev.button === 1) this.mouse.mid = false
      if (ev.button === 2) this.mouse.right = false
    }
    const wh = (ev: WheelEvent) => {
      const d = ev.deltaY
      this.wheel += d
      this.mouse.wheel += d
    }
    const dbl = (ev: MouseEvent) => { setPos(ev.clientX, ev.clientY); this.mouse.dbl = true }
    const ctx = (ev: Event) => { ev.preventDefault() }

    const ts = (ev: TouchEvent) => {
      const t = ev.touches[0]
      if (!t) return
      this.touch.active = true
      setPos(t.clientX, t.clientY)
    }
    const tm = (ev: TouchEvent) => {
      const t = ev.touches[0]
      if (!t) return
      setPos(t.clientX, t.clientY)
    }
    const te = () => { this.touch.active = false }

    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    el.addEventListener('mousemove', mm)
    el.addEventListener('mousedown', md)
    window.addEventListener('mouseup', mu)
    el.addEventListener('wheel', wh, { passive: true })
    el.addEventListener('contextmenu', ctx)
    el.addEventListener('dblclick', dbl, { passive: true })
    el.addEventListener('touchstart', ts, { passive: true })
    el.addEventListener('touchmove', tm, { passive: true })
    el.addEventListener('touchend', te, { passive: true })
    el.addEventListener('mouseenter', () => { this.mouse.inside = true })
    el.addEventListener('mouseleave', () => { this.mouse.inside = false })

    this.handlers = [
      ['keydown', kd], ['keyup', ku], ['blur', blur], ['mousemove', mm],
      ['mousedown', md], ['mouseup', mu], ['wheel', wh, { passive: true }],
      ['contextmenu', ctx], ['dblclick', dbl, { passive: true }],
      ['touchstart', ts, { passive: true }], ['touchmove', tm, { passive: true }],
      ['touchend', te, { passive: true }]
    ]
  }

  setEnabled(v: boolean) {
    this.enabled = v
    if (v) { this.downSet.clear(); this.pressedSet.clear() }
  }

  isDown(c: string) { return this.downSet.has(c) }
  isPressed(c: string) { return this.pressedSet.has(c) }

  postUpdate() {
    this.pressedSet.clear()
    this.mouse.dx = 0
    this.mouse.dy = 0
    this.wheel = 0
    this.mouse.wheel = 0
    this.mouse.dbl = false
    this.mouse.leftPressed = false
    this.mouse.rightPressed = false
  }
}
