/* ============ Nova Engine — Audio (zero-dep WebAudio synth + chiptune) ============ */

/* main.ts wiring:
 *   import { audio } from './engine/audio'
 *   audio.init()                                  // idempotent, call once at boot
 *   audio.playPreset('coin')                      // one of 11 synth SFX presets
 *   audio.startMusic('galaxy')                    // chiptune loop (seeded)
 *   // in the game loop you call nothing — music self-schedules.
 *   // from entity scripts: engine gives `audio.preset('jump')` etc. at your discretion.
 */

import { hashStr, mulberry32 } from './core'

export type PresetName =
  | 'click' | 'coin' | 'jump' | 'hurt' | 'explode'
  | 'powerup' | 'laser' | 'win' | 'lose' | 'ding' | 'zap'

export type ToneOpts = {
  freq: number
  dur?: number
  type?: 'sine' | 'square' | 'triangle' | 'sawtooth'
  vol?: number
  attack?: number
  decay?: number
  slideTo?: number
  /** schedule delay in seconds from now (for arpeggio layering) */
  when?: number
}

export type NoiseOpts = {
  dur?: number
  vol?: number
  /** lowpass cutoff Hz (sweeps down to 25% over the burst for punch) */
  filter?: number
  /** schedule delay in seconds from now */
  when?: number
}

type MusicState = {
  ctx: AudioContext
  gain: GainNode
  timer: any
  nextTime: number
  step: number
  seed: number
  note: number
}

const MUSIC_STEP = 0.25      // sec per 8th note @ 120 BPM
const MUSIC_LOOKAHEAD = 0.35
const MUSIC_TICK = 120       // ms scheduler cadence

// A-minor pentatonic ladder: A3 C4 D4 E4 G4 A4 C5 D5
const PENT = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33]

export class NovaAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private vol = 0.6
  private muted = false
  private music: MusicState | null = null

  /** Whether audio is available in this environment (browser/Electron). */
  get available(): boolean {
    if (typeof window === 'undefined') return false
    return !!(window as any).AudioContext || !!(window as any).webkitAudioContext
  }

  /** true while the music sequencer is running (even mid fade-out). */
  get playing(): boolean {
    return !!this.music
  }

  /** Lazily create the AudioContext + master gain + noise buffer. Idempotent. */
  init(): boolean {
    if (this.ctx) return true
    if (!this.available) return false
    try {
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext
      const ctx: AudioContext = new AC()
      const master: GainNode = ctx.createGain()
      master.gain.value = this.muted ? 0 : this.vol
      master.connect(ctx.destination)
      // 1 s pre-rendered white noise for bursts & hats
      const len = Math.floor(ctx.sampleRate) || 44100
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      this.ctx = ctx
      this.master = master
      this.noiseBuf = buf
      return true
    } catch {
      this.ctx = null
      this.master = null
      this.noiseBuf = null
      return false
    }
  }

  /** Call from any user gesture — browsers suspend until interaction. */
  resume() {
    try {
      if (!this.init() || !this.ctx) return
      if (this.ctx.state === 'suspended') void this.ctx.resume()
    } catch { /* no audio hardware — ignore */ }
  }

  setVolume(v: number) {
    this.vol = v < 0 ? 0 : v > 1 ? 1 : v
    try {
      if (this.master) this.master.gain.value = this.muted ? 0 : this.vol
    } catch { /* ignore */ }
  }

  mute(m: boolean) {
    this.muted = !!m
    try {
      if (this.master) this.master.gain.value = this.muted ? 0 : this.vol
    } catch { /* ignore */ }
  }

  /* ---------- raw synth voices (public) ---------- */

  playTone(o: ToneOpts) { this.tone(o, 0) }

  noiseBurst(o: NoiseOpts) { this.noise(o, 0) }

  /* ---------- internal voices ---------- */

  private tone(o: ToneOpts, when = 0, dest: AudioNode | null = null) {
    try {
      const ctx = this.ctx || (this.init() ? this.ctx : null)
      if (!ctx || !this.master) return
      const t0 = ctx.currentTime + Math.max(0, o.when ?? when)
      const dur = Math.max(0.02, o.dur ?? 0.2)
      const atk = Math.max(0, o.attack ?? 0.004)
      const dec = Math.max(0.02, o.decay ?? dur)
      const osc: OscillatorNode = ctx.createOscillator()
      osc.type = o.type || 'sine'
      const g: GainNode = ctx.createGain()
      const vol = o.vol ?? 0.3
      osc.frequency.setValueAtTime(Math.max(1, o.freq), t0)
      if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + dur)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + atk)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dec)
      osc.connect(g)
      g.connect(dest || this.master)
      osc.start(t0)
      osc.stop(t0 + atk + dec + 0.03)
      osc.onended = () => { try { g.disconnect() } catch { /* ignore */ } }
    } catch { /* no audio — ignore */ }
  }

  private noise(o: NoiseOpts, when = 0, dest: AudioNode | null = null) {
    try {
      const ctx = this.ctx || (this.init() ? this.ctx : null)
      if (!ctx || !this.master || !this.noiseBuf) return
      const t0 = ctx.currentTime + Math.max(0, o.when ?? when)
      const dur = Math.max(0.03, o.dur ?? 0.3)
      const cut = Math.max(40, o.filter ?? 1200)
      const src: AudioBufferSourceNode = ctx.createBufferSource()
      src.buffer = this.noiseBuf
      src.loop = true
      const f: BiquadFilterNode = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.setValueAtTime(cut, t0)
      f.frequency.exponentialRampToValueAtTime(Math.max(40, cut * 0.25), t0 + dur)
      f.Q.value = 0.8
      const g: GainNode = ctx.createGain()
      const vol = o.vol ?? 0.3
      g.gain.setValueAtTime(Math.max(0.001, vol), t0)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      src.connect(f)
      f.connect(g)
      g.connect(dest || this.master)
      src.start(t0)
      src.stop(t0 + dur + 0.03)
      src.onended = () => { try { f.disconnect(); g.disconnect() } catch { /* ignore */ } }
    } catch { /* no audio — ignore */ }
  }

  /* ---------- SFX presets (layered, all synthesized) ---------- */

  playPreset(name: PresetName | string) {
    switch (name) {
      case 'click':
        this.tone({ freq: 1500, slideTo: 700, dur: 0.05, type: 'square', vol: 0.09 })
        break
      case 'coin':
        this.tone({ freq: 987.77, dur: 0.08, type: 'square', vol: 0.2 })
        this.tone({ freq: 1318.5, dur: 0.28, type: 'square', vol: 0.18, when: 0.07 })
        break
      case 'jump': {
        this.tone({ freq: 240, slideTo: 660, dur: 0.2, type: 'sine', vol: 0.3 })
        this.tone({ freq: 240, slideTo: 660, dur: 0.2, type: 'triangle', vol: 0.12 })
        break
      }
      case 'hurt':
        this.tone({ freq: 320, slideTo: 100, dur: 0.22, type: 'square', vol: 0.24 })
        this.noise({ dur: 0.12, vol: 0.12, filter: 900 })
        break
      case 'explode':
        this.noise({ dur: 0.55, vol: 0.5, filter: 1000 })
        this.tone({ freq: 150, slideTo: 35, dur: 0.45, type: 'sine', vol: 0.4 })
        this.tone({ freq: 90, slideTo: 30, dur: 0.6, type: 'triangle', vol: 0.2 })
        break
      case 'powerup':
        for (let i = 0; i < 4; i++) {
          this.tone({ freq: [523.25, 659.25, 784.0, 1046.5][i], dur: 0.09, type: 'square', vol: 0.16, when: i * 0.07 })
        }
        this.tone({ freq: 130.8, slideTo: 261.6, dur: 0.3, type: 'triangle', vol: 0.14 })
        break
      case 'laser':
        this.tone({ freq: 1500, slideTo: 220, dur: 0.22, type: 'sawtooth', vol: 0.2 })
        this.noise({ dur: 0.1, vol: 0.08, filter: 5000 })
        break
      case 'win':
        for (let i = 0; i < 4; i++) {
          this.tone({ freq: [523.25, 659.25, 784.0, 1046.5][i], dur: 0.22, type: 'triangle', vol: 0.2, when: i * 0.13 })
        }
        this.tone({ freq: 1046.5, dur: 0.5, type: 'sine', vol: 0.22, when: 0.52 })
        this.tone({ freq: 1568.0, dur: 0.5, type: 'sine', vol: 0.12, when: 0.52 })
        this.noise({ dur: 0.35, vol: 0.06, filter: 7000, when: 0.5 })
        break
      case 'lose':
        for (let i = 0; i < 4; i++) {
          this.tone({ freq: [392.0, 329.63, 261.63, 196.0][i], dur: 0.26, type: 'triangle', vol: 0.2, when: i * 0.19 })
        }
        this.tone({ freq: 98, dur: 0.6, type: 'sine', vol: 0.2, when: 0.76, slideTo: 70 })
        break
      case 'ding':
        this.tone({ freq: 1568.0, dur: 0.6, type: 'sine', vol: 0.22, decay: 0.55 })
        this.tone({ freq: 2093.0, dur: 0.35, type: 'sine', vol: 0.08 })
        break
      case 'zap':
        this.tone({ freq: 2200, slideTo: 90, dur: 0.16, type: 'square', vol: 0.2 })
        this.noise({ dur: 0.14, vol: 0.16, filter: 6000 })
        break
      default:
        break // unknown preset — silently ignore
    }
  }

  /* ---------- chiptune step-sequencer ---------- */

  /**
   * Start a seeded chiptune loop: pentatonic lead walk + bass + kick + noise hats.
   * No-op if already playing. Pass a string (hashed) or numeric seed.
   */
  startMusic(seedOrName?: string | number) {
    try {
      if (this.music) return
      if (!this.init() || !this.ctx || !this.master) return
      const seedVal = typeof seedOrName === 'number' ? seedOrName >>> 0 : hashStr(String(seedOrName || 'galaxy'))
      const gain = this.ctx.createGain()
      gain.gain.value = 0.5
      gain.connect(this.master)
      this.music = { ctx: this.ctx, gain, timer: null, nextTime: this.ctx.currentTime + 0.1, step: 0, seed: seedVal, note: 0 }
      const st = this.music
      st.timer = setInterval(() => {
        try {
          const m = this.music
          if (!m) return
          while (m.nextTime < m.ctx.currentTime + MUSIC_LOOKAHEAD) {
            this.musicStep(m)
            m.nextTime += MUSIC_STEP
            m.step++
          }
        } catch { /* scheduler hiccup — keep the interval alive */ }
      }, MUSIC_TICK)
    } catch { /* audio unavailable — music silently off */ }
  }

  private musicStep(m: MusicState) {
    const at = m.nextTime - m.ctx.currentTime
    const s = m.step % 16
    const bar = Math.floor(m.step / 16)
    const rnd = mulberry32((m.seed ^ Math.imul(bar + 1, 0x9E3779B1)) >>> 0)
    const r = rnd()

    // kick on 0 & 8, snare-ish noise on 4 & 12
    if (s === 0 || s === 8) {
      this.tone({ freq: 150, slideTo: 45, dur: 0.13, type: 'sine', vol: 0.5 }, at, m.gain)
    }
    if (s === 4 || s === 12) {
      this.noise({ dur: 0.09, vol: 0.22, filter: 2400 }, at, m.gain)
    }
    // hats on every other step, sparse on odd bars
    if (s % 2 === 1 && (r < 0.9 || bar % 2 === 0)) {
      this.noise({ dur: 0.045, vol: 0.07, filter: 7000 }, at, m.gain)
    }
    // bass: root / fifth on quarters
    if (s % 4 === 0) {
      const f = (s === 0 || s === 12) ? 110 : s === 4 ? 146.83 : 82.41
      this.tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.34 }, at, m.gain)
    }
    // lead: melodic walk over the pentatonic ladder, ~60% density
    if (r < 0.94) {
      if (r < 0.58) {
        const jump = r < 0.15 ? -1 : r < 0.24 ? 1 : r < 0.4 ? 2 : 0
        m.note = Math.min(PENT.length - 1, Math.max(0, m.note + jump))
      }
      const f = PENT[m.note] * (r > 0.88 && bar % 4 === 3 ? 2 : 1)
      this.tone({ freq: f, dur: 0.16, type: 'square', vol: 0.11 }, at, m.gain)
    }
  }

  stopMusic(fadeSec = 0) {
    const m = this.music
    if (!m) return
    this.music = null
    try {
      if (m.timer) clearInterval(m.timer)
      const t = m.ctx.currentTime
      if (fadeSec > 0) {
        m.gain.gain.cancelScheduledValues(t)
        m.gain.gain.setValueAtTime(Math.max(0.0001, m.gain.gain.value), t)
        m.gain.gain.linearRampToValueAtTime(0, t + fadeSec)
        setTimeout(() => { try { m.gain.disconnect() } catch { /* ignore */ } }, fadeSec * 1000 + 120)
      } else {
        m.gain.disconnect() // hard cut: also silences already-scheduled notes
      }
    } catch { /* ignore */ }
  }

  /** Smoothly fade the music out (or start of a silent period) — helper on top of stopMusic. */
  fadeMusicOut(sec = 1) {
    this.stopMusic(Math.max(0.05, sec))
  }

  /** Dev/test helper: tear down every voice + context (restart cold). */
  shutdown() {
    this.stopMusic(0)
    try {
      if (this.ctx) { void this.ctx.close() }
    } catch { /* ignore */ }
    this.ctx = null
    this.master = null
    this.noiseBuf = null
  }
}

/** Shared singleton used by the engine + game scripts. */
export const audio = new NovaAudio()
