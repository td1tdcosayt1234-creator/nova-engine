/* ============ Nova Engine — 3D renderer (three.js backed) ============ */

import * as THREE from 'three'
import { getComp, hashStr, type Entity, type Scene } from './core'
import { spriteCanvas } from './sprites'
import { radiusOf } from './physics3d'

export interface OrbitState { theta: number; phi: number; dist: number; target: THREE.Vector3 }
export interface PlayCamState { yaw: number; pitch: number }

const DEG = Math.PI / 180
const INST_THRESHOLD = 10 // identical static meshes below this stay individual

type InstGroup = { key: string; mesh: THREE.InstancedMesh; ids: string[]; cap: number }
type FXPart = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; r: number; g: number; b: number; grav: number }

const SKY_VERT = /* glsl */ `
varying vec3 vP;
void main() {
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBot;
varying vec3 vP;
void main() {
  float k = clamp(vP.y / 300.0 * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(mix(uBot, uTop, k), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export class Renderer3D {
  container: HTMLElement
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  root = new THREE.Group()
  meshMap = new Map<string, THREE.Object3D>()
  private geos = new Map<string, THREE.BufferGeometry>()   // shared, session-cached
  private mats = new Map<string, THREE.MeshStandardMaterial>() // fp -> material (shared)
  private texs = new Map<string, THREE.CanvasTexture>()    // cat|seed -> texture (shared)
  private selHelper: THREE.Box3Helper
  private selBox = new THREE.Box3()
  grid: THREE.GridHelper
  defaultSun: THREE.DirectionalLight
  defaultAmb: THREE.HemisphereLight
  lastBg = ''
  private lastFogKey = ''
  private lastSkyKey = ''
  private sky: THREE.Mesh | null = null
  private instGroups = new Map<string, InstGroup>()
  private instIdx = new Map<string, { key: string; index: number }>()
  private shadowRes = 0
  private selId: string | null = null
  private selMat: THREE.MeshStandardMaterial | null = null
  // pooled temps (no per-frame allocation)
  private tmpE = new THREE.Euler()
  private tmpQ = new THREE.Quaternion()
  private tmpP = new THREE.Vector3()
  private tmpS = new THREE.Vector3()
  private tmpM = new THREE.Matrix4()
  private tmpBox = new THREE.Box3()
  private lastSyncT = 0
  // 3D particles (dormant unless entities carry a particles3d comp)
  private fxLive: FXPart[] = []
  private fxPool: FXPart[] = []
  private fxPts: THREE.Points | null = null
  private fxGeo: THREE.BufferGeometry | null = null
  private fxPos: Float32Array | null = null
  private fxCol: Float32Array | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.style.position = 'absolute'
    this.renderer.domElement.style.inset = '0'
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000)
    this.scene.add(this.root)
    this.scene.add(this.camera)

    this.grid = new THREE.GridHelper(60, 60, 0x4c5670, 0x272e3d)
    ;(this.grid.material as any).transparent = true
    ;(this.grid.material as any).opacity = 0.5
    this.grid.visible = false
    this.scene.add(this.grid)

    this.defaultAmb = new THREE.HemisphereLight(0xdfe8ff, 0x3a2f47, 0.55)
    this.defaultSun = new THREE.DirectionalLight(0xffffff, 1.4)
    this.defaultSun.position.set(18, 30, 12)
    this.defaultSun.castShadow = true
    this.defaultSun.shadow.mapSize.set(2048, 2048)
    this.defaultSun.shadow.bias = -0.0004
    this.defaultSun.shadow.normalBias = 0.03
    const sc = this.defaultSun.shadow.camera as THREE.OrthographicCamera
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40
    this.scene.add(this.defaultAmb, this.defaultSun)

    this.selHelper = new THREE.Box3Helper(this.selBox, 0xf0abfc)
    this.selHelper.visible = false
    this.scene.add(this.selHelper)
  }

  resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w <= 0 || h <= 0) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Full teardown: scene/entity objects AND every shared cached GPU resource. */
  reset() {
    for (const [, obj] of this.meshMap) this.root.remove(obj)
    this.meshMap.clear()
    for (const [, g] of this.instGroups) { this.root.remove(g.mesh); g.mesh.dispose() }
    this.instGroups.clear()
    this.instIdx.clear()
    for (const [, m] of this.mats) m.dispose()
    this.mats.clear()
    for (const [, t] of this.texs) t.dispose()
    this.texs.clear()
    for (const [, g2] of this.geos) g2.dispose()
    this.geos.clear()
    for (const [, l] of this.lightMap) { this.scene.remove(l); (l as any).dispose?.() }
    this.lightMap.clear()
    if (this.sky) { this.scene.remove(this.sky); this.sky.geometry.dispose(); (this.sky.material as any)?.dispose?.(); this.sky = null }
    this.disposeFX()
    this.selMat = null
    this.selId = null
    this.selHelper.visible = false
    this.lastBg = ''
    this.lastFogKey = ''
    this.lastSkyKey = ''
    this.lastSyncT = 0
  }

  /* ---------- shared geometry / material / texture caches ---------- */

  private geo(name: string): THREE.BufferGeometry {
    let g = this.geos.get(name)
    if (g) return g
    switch (name) {
      case 'sphere': g = new THREE.SphereGeometry(0.5, 24, 18); break
      case 'capsule': g = new THREE.CapsuleGeometry(0.35, 0.55, 6, 16); break
      case 'cylinder': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 22); break
      case 'cone': g = new THREE.ConeGeometry(0.5, 1, 22); break
      case 'torus': g = new THREE.TorusGeometry(0.4, 0.16, 14, 36); break
      case 'torusKnot': g = new THREE.TorusKnotGeometry(0.35, 0.12, 64, 12); break
      case 'plane': g = new THREE.PlaneGeometry(1, 1); break
      default: g = new THREE.BoxGeometry(1, 1, 1)
    }
    g.computeBoundingBox()
    g.computeBoundingSphere()
    this.geos.set(name, g)
    return g
  }

  private texFor(cat: string, seed: number): THREE.CanvasTexture {
    const key = `${cat}|${seed}`
    let t = this.texs.get(key)
    if (t) return t
    t = new THREE.CanvasTexture(spriteCanvas(cat, seed))
    t.magFilter = THREE.NearestFilter          // crisp pixel-art magnification
    t.minFilter = THREE.LinearMipmapLinearFilter // mipmaps -> clean minification
    t.generateMipmaps = true
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy())
    this.texs.set(key, t)
    return t
  }

  /** fingerprint: color|texture|seed|wire — shared materials cut state switches */
  private matFor(fp: string): THREE.MeshStandardMaterial {
    let m = this.mats.get(fp)
    if (!m) {
      const [color, cat, seedS, wire] = fp.split('|')
      m = new THREE.MeshStandardMaterial({ color: color, roughness: 0.6, metalness: 0.12 })
      if (cat && cat !== 'none') m.map = this.texFor(cat, Number(seedS) || 1)
      m.wireframe = wire === '1'
      this.mats.set(fp, m)
    }
    return m
  }

  private meshFP(e: Entity, meshC: any): string {
    const seed = (getComp(e, 'sprite2d') as any)?.seed || (hashStr(e.id) % 10000)
    return `${meshC.color || '#888888'}|${meshC.texture}|${seed}|${meshC.wire ? 1 : 0}`
  }

  /* ---------- sync ---------- */

  sync(scene: Scene, opts: { orbit: OrbitState; playing: boolean; cam: PlayCamState; selected: string | null }) {
    const m = scene.meta
    const is3d = m.mode === '3d'
    this.root.visible = is3d
    this.grid.visible = is3d && !opts.playing

    // background + meta-driven fog (defensive: fogTint/fog/fogNear/fogFar honored)
    const bgc = m.useGradient ? m.bgBottom : m.bg
    if (bgc !== this.lastBg) {
      this.scene.background = new THREE.Color(bgc)
      this.lastBg = bgc
    }
    const fogTint = (m as any).fogTint || (typeof (m as any).fog === 'string' ? (m as any).fog : null) || bgc
    const fogNear = Number((m as any).fogNear ?? 60)
    const fogFar = Number((m as any).fogFar ?? 190)
    const fogOn = (m as any).fogEnabled !== false && (m as any).fog !== false
    const fogKey = fogOn ? `${fogTint}|${fogNear}|${fogFar}` : 'off'
    if (fogKey !== this.lastFogKey) {
      this.scene.fog = fogOn ? new THREE.Fog(fogTint, fogNear, fogFar) : null
      this.lastFogKey = fogKey
    }

    if (!is3d) {
      if (this.fxPts) this.fxPts.visible = false
      return
    }

    // sky dome follows the camera; colors track meta gradient
    this.updateSky(scene, is3d && m.useGradient)

    const seen = new Set<string>()
    const hasLight = scene.entities.some(e => e.visible && getComp(e, 'light3d'))
    this.defaultAmb.visible = !hasLight
    this.defaultSun.visible = !hasLight

    // ---- instanced pass: identical static meshes share ONE InstancedMesh ----
    const instanced = new Set<string>()
    const cand = new Map<string, { geo: string; fp: string; ids: string[]; ents: Entity[] }>()
    this.instIdx.clear()
    for (const e of scene.entities) {
      if (!e.visible) continue
      const meshC = getComp(e, 'mesh3d') as any
      if (!meshC || getComp(e, 'light3d')) continue
      if (!this.isStaticEnt(e)) continue
      const fp = this.meshFP(e, meshC)
      let c = cand.get(fp)
      if (!c) { c = { geo: meshC.geo, fp, ids: [], ents: [] }; cand.set(fp, c) }
      c.ids.push(e.id); c.ents.push(e)
    }
    for (const [fp, c] of cand) {
      if (c.ents.length < INST_THRESHOLD) continue
      instanced.add(fp)
      for (const id of c.ids) instanced.add(id)
      this.syncInstGroup(fp, c)
    }
    for (const [key, g] of [...this.instGroups]) {
      if (!instanced.has(key)) { this.root.remove(g.mesh); g.mesh.dispose(); this.instGroups.delete(key) }
    }

    const seenEnts = new Set<string>()
    for (const e of scene.entities) {
      const meshC = getComp(e, 'mesh3d') as any
      const lightC = getComp(e, 'light3d')
      if (lightC) { this.syncLight(e, lightC); seen.add(e.id); continue }
      if (!meshC) continue
      seen.add(e.id)
      if (instanced.has(e.id)) { // demote any stale individual mesh
        const obj = this.meshMap.get(e.id)
        if (obj) { this.root.remove(obj); this.meshMap.delete(e.id) }
        seenEnts.add(e.id)
        continue
      }
      seenEnts.add(e.id)
      this.syncMesh(e, meshC)
    }

    // remove stale (lights keep their own gc list)
    for (const [id, obj] of [...this.meshMap]) {
      if (!seenEnts.has(id)) {
        this.root.remove(obj)
        this.meshMap.delete(id)
      }
    }
    this.gcLights(seen)
    if (this.selId && !seenEnts.has(this.selId) && !instanced.has(this.selId)) this.applySelection(null)

    this.adaptShadows()

    this.updateCamera(scene, opts)

    // internal clock drives particles fx + selection pulse
    const now = performance.now()
    const dt = this.lastSyncT ? Math.min(0.05, Math.max(0, (now - this.lastSyncT) / 1000)) : 0.016
    this.lastSyncT = now
    this.syncParticles3D(scene, dt)

    // selection highlight (per-instance bbox for instanced members)
    const selIdx = opts.selected ? this.instIdx.get(opts.selected) : null
    let selObj: THREE.Object3D | null = null
    if (selIdx) {
      const g = this.instGroups.get(selIdx.key)
      if (g) {
        g.mesh.getMatrixAt(selIdx.index, this.tmpM)
        const bb = g.mesh.geometry.boundingBox || g.mesh.geometry.computeBoundingBox() && g.mesh.geometry.boundingBox
        if (bb) this.selBox.copy(bb).applyMatrix4(this.tmpM)
        this.selHelper.visible = !opts.playing
      }
    } else {
      selObj = opts.selected ? (this.meshMap.get(opts.selected) ?? null) : null
      if (selObj && !opts.playing) {
        this.selBox.setFromObject(selObj)
        this.selHelper.visible = true
      } else {
        this.selHelper.visible = false
      }
    }
    if (selObj && opts.selected !== this.selId) this.applySelection(opts.selected)
    if (this.selMat) this.selMat.emissiveIntensity = 0.22 + 0.2 * Math.sin(now * 0.006)

    this.renderer.render(this.scene, this.camera)
  }

  /* ---------- instanced statics ---------- */

  private isStaticEnt(e: Entity): boolean {
    const r = getComp(e, 'rigid3d') as any
    return (e as any).static === true || e.tags.includes('static') || !!r?.isStatic
  }

  private syncInstGroup(fp: string, c: { geo: string; fp: string; ids: string[]; ents: Entity[] }) {
    let g = this.instGroups.get(fp)
    if (!g || g.cap < c.ents.length) {
      // (re)create with headroom — geometry/material stay shared from the caches
      if (g) { this.root.remove(g.mesh); g.mesh.dispose() }
      const cap = Math.ceil((c.ents.length * 1.25 + 8))
      const mesh = new THREE.InstancedMesh(this.geo(c.geo), this.matFor(fp), cap)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.castShadow = c.geo !== 'plane'
      mesh.receiveShadow = true
      ;(mesh.userData as any).fp = fp
      this.root.add(mesh)
      g = { key: fp, mesh, ids: [], cap }
      this.instGroups.set(fp, g)
    }
    g.ids = c.ids
    g.mesh.visible = true
    const plane = c.geo === 'plane'
    for (let i = 0; i < c.ents.length; i++) {
      const e = c.ents[i]
      const t = e.transform
      this.tmpP.set(t.pos.x, t.pos.y, t.pos.z)
      if (plane) this.tmpE.set(-Math.PI / 2, 0, (t.rot.z || 0) * DEG)
      else this.tmpE.set((t.rot.x || 0) * DEG, (t.rot.y || 0) * DEG, (t.rot.z || 0) * DEG)
      this.tmpQ.setFromEuler(this.tmpE)
      this.tmpS.set(Math.max(0.001, t.scale.x), Math.max(0.001, t.scale.y), Math.max(0.001, t.scale.z))
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS)
      g.mesh.setMatrixAt(i, this.tmpM)
      (this.instIdx.get(e.id) || (this.instIdx.set(e.id, { key: fp, index: i }), this.instIdx.get(e.id)!))
    }
    g.mesh.count = c.ents.length
    g.mesh.instanceMatrix.needsUpdate = true
  }

  /* ---------- individual meshes ---------- */

  private syncMesh(e: Entity, meshC: any) {
    let obj = this.meshMap.get(e.id) as THREE.Mesh | undefined
    const fp = this.meshFP(e, meshC)
    if (!obj) {
      obj = new THREE.Mesh(this.geo(meshC.geo), this.matFor(fp))
      if (meshC.geo === 'plane') {
        obj.rotation.x = -Math.PI / 2
        obj.userData.baseRotX = -Math.PI / 2
      }
      obj.castShadow = meshC.geo !== 'plane'
      obj.receiveShadow = true
      obj.userData.entityId = e.id
      obj.userData.fp = fp
      this.root.add(obj)
      this.meshMap.set(e.id, obj)
    } else if (obj.userData.fp !== fp) {
      // props changed -> swap to the cached material (create/dispose churn gone)
      obj.material = this.matFor(fp)
      obj.userData.fp = fp
    }
    const mesh = obj

    const t = e.transform
    mesh.position.set(t.pos.x, t.pos.y, t.pos.z)
    if (meshC.geo === 'plane') {
      mesh.rotation.set(-Math.PI / 2, 0, (t.rot.z || 0) * DEG)
    } else {
      mesh.rotation.set((t.rot.x || 0) * DEG, (t.rot.y || 0) * DEG, (t.rot.z || 0) * DEG)
    }
    mesh.scale.set(
      Math.max(0.001, t.scale.x),
      Math.max(0.001, t.scale.y),
      Math.max(0.001, t.scale.z)
    )
    mesh.visible = e.visible
  }

  /* ---------- selection (emissive pulse on a cloned material) ---------- */

  private applySelection(id: string | null) {
    if (this.selId && this.selMat) {
      const old = this.meshMap.get(this.selId) as THREE.Mesh | undefined
      const fpo = old?.userData.fp as string | undefined
      if (old && fpo && old.material === this.selMat) old.material = this.matFor(fpo)
      this.selMat.dispose()
      this.selMat = null
      this.selId = null
    }
    if (!id) return
    const mesh = this.meshMap.get(id) as THREE.Mesh | undefined
    const fp = mesh?.userData.fp as string | undefined
    if (!mesh || !fp) return
    const m = this.matFor(fp).clone()
    m.emissive = new THREE.Color(m.color)
    m.emissiveIntensity = 0.3
    mesh.material = m
    this.selMat = m
    this.selId = id
  }

  /* ---------- lights ---------- */

  private lightMap = new Map<string, THREE.Light>()

  private syncLight(e: Entity, c: any) {
    let l = this.lightMap.get(e.id)
    if (!l || (l as any).__kind !== c.kind) {
      if (l) { this.scene.remove(l); this.lightMap.delete(e.id) }
      switch (c.kind) {
        case 'point': l = new THREE.PointLight(0xffffff, c.intensity, c.distance || 30); break
        case 'hemisphere': l = new THREE.HemisphereLight(0xbfd4ff, 0x3b2f4a, c.intensity); break
        case 'ambient': l = new THREE.AmbientLight(0xffffff, c.intensity); break
        default: l = new THREE.DirectionalLight(0xffffff, c.intensity)
      }
      ;(l as any).__kind = c.kind
      if (l instanceof THREE.DirectionalLight) {
        l.castShadow = true
        l.shadow.mapSize.set(1024, 1024)
        l.shadow.bias = -0.0004
        l.shadow.normalBias = 0.03
        const sc = l.shadow.camera as THREE.OrthographicCamera
        sc.left = -50; sc.right = 50; sc.top = 50; sc.bottom = -50
      }
      this.scene.add(l)
      this.lightMap.set(e.id, l)
    }
    l.color.set(c.color)
    if ('intensity' in l) (l as any).intensity = c.intensity // live intensity updates for every kind
    if (l instanceof THREE.DirectionalLight) {
      const t = e.transform
      l.position.set(t.pos.x, t.pos.y, t.pos.z)
      l.target.position.set(0, 0, 0)
      l.target.updateMatrixWorld()
    } else if (l instanceof THREE.PointLight) {
      const t = e.transform
      l.position.set(t.pos.x, t.pos.y, t.pos.z)
      l.distance = c.distance || 30
    }
  }

  /** Remove lights whose entities no longer exist. */
  private gcLights(seenIds: Set<string>) {
    for (const [id, l] of [...this.lightMap]) {
      if (!seenIds.has(id)) {
        this.scene.remove(l)
        ;(l as any).dispose?.()
        this.lightMap.delete(id)
      }
    }
  }

  /** 2048px sun shadows for small scenes, 1024 once things get dense. */
  private adaptShadows() {
    let count = this.meshMap.size
    for (const [, g] of this.instGroups) count += g.mesh.count
    const want = count <= 80 ? 2048 : 1024
    if (want !== this.shadowRes) {
      this.shadowRes = want
      const s = this.defaultSun.shadow
      s.mapSize.set(want, want)
      if (s.map) { s.map.dispose(); s.map = null }
    }
  }

  /* ---------- sky dome ---------- */

  private updateSky(scene: Scene, visible: boolean) {
    const m = scene.meta as any
    const key = `${m.bgTop}|${m.bgBottom}`
    if (!this.sky) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTop: { value: new THREE.Color('#223a5e') }, uBot: { value: new THREE.Color('#0b1026') } },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
      })
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 16), mat)
      this.sky.frustumCulled = false
      this.scene.add(this.sky)
    }
    this.sky.visible = visible
    if (visible && key !== this.lastSkyKey) {
      const u = (this.sky.material as THREE.ShaderMaterial).uniforms
      ;(u.uTop.value as THREE.Color).set(m.bgTop)
      ;(u.uBot.value as THREE.Color).set(m.bgBottom)
      this.lastSkyKey = key
    }
    if (visible) this.sky.position.copy(this.camera.position)
  }

  /* ---------- 3D particles (Points pool; dormant until particles3d comps exist) ---------- */

  /** Public API — call per frame (or let sync() do it). No-ops when unused. */
  syncParticles3D(scene: Scene, dt = 0.016) {
    const is3d = scene.meta.mode === '3d'
    let anyComp = false
    if (is3d) {
      for (const e of scene.entities) {
        if (!e.visible) continue
        const p = getComp(e, 'particles3d') as any
        if (!p || !(p.rate > 0)) continue
        anyComp = true
        this.ensureFX()
        const acc = ((e as any).__p3acc || 0) + p.rate * dt
        let n = Math.floor(acc)
        ;(e as any).__p3acc = acc - n
        if (n > 0) this.spawnFX(e.transform.pos, p)
      }
    }
    this.tickFX(dt)
    if (this.fxPts) this.fxPts.visible = is3d && anyComp && this.fxLive.length > 0
  }

  /** one-shot burst API: `r3d.burst3D(x, y, z, color?, count?, speed?)` */
  burst3D(x: number, y: number, z: number, color = '#fbbf24', count = 24, speed = 7) {
    this.ensureFX()
    this.spawnFX({ x, y, z }, { color, speed, count, life: 0.8, size: 0.25, rate: 0 })
  }

  private ensureFX() {
    if (this.fxPool.length) return
    for (let i = 0; i < 1200; i++)
      this.fxPool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 0.25, r: 1, g: 0.7, b: 0.2, grav: -6 })
    const N = 1200
    this.fxPos = new Float32Array(N * 3)
    this.fxCol = new Float32Array(N * 3)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.fxPos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(this.fxCol, 3))
    ;(g.attributes.position as THREE.BufferAttribute).usage = THREE.DynamicDrawUsage
    ;(g.attributes.color as THREE.BufferAttribute).usage = THREE.DynamicDrawUsage
    g.setDrawRange(0, 0)
    const mat = new THREE.PointsMaterial({
      size: 0.3, vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    })
    this.fxGeo = g
    this.fxPts = new THREE.Points(g, mat)
    this.fxPts.frustumCulled = false
    this.fxPts.visible = false
    this.scene.add(this.fxPts)
  }

  private spawnFX(pos: any, p: any) {
    const rgb = cssRGB(p.color || '#fbbf24')
    const n = Math.min(64, Math.max(1, Math.round(p.count ?? 1)))
    for (let i = 0; i < n; i++) {
      let f = this.fxPool.pop()
      if (!f) f = this.fxLive.length ? this.fxLive.shift()! : null
      if (!f) return
      f.x = pos.x + (Math.random() - 0.5) * 0.1
      f.y = pos.y + (Math.random() - 0.5) * 0.1 + 0.1
      f.z = pos.z + (Math.random() - 0.5) * 0.1
      const a = Math.random() * Math.PI * 2
      const u = Math.random() * 2 - 1
      const rr = Math.sqrt(Math.max(0, 1 - u * u))
      const sp = (p.speed || 5) * (0.6 + Math.random() * 0.8)
      f.vx = rr * Math.cos(a) * sp
      f.vy = u * sp
      f.vz = rr * Math.sin(a) * sp
      f.life = (p.life || 0.8) * (0.75 + Math.random() * 0.5)
      f.max = f.life
      f.size = p.size || 0.25
      f.grav = p.gravity ?? -6
      f.r = rgb[0]; f.g = rgb[1]; f.b = rgb[2]
      this.fxLive.push(f)
    }
  }

  private tickFX(dt: number) {
    const live = this.fxLive
    if (!live.length && this.fxPts) { if (this.fxGeo) this.fxGeo.setDrawRange(0, 0); return }
    const drag = Math.pow(0.99, dt * 60)
    for (let i = live.length - 1; i >= 0; i--) {
      const f = live[i]
      f.life -= dt
      if (f.life <= 0) { live[i] = live[live.length - 1]; live.pop(); this.fxPool.push(f); continue }
      f.vy += f.grav * dt
      f.vx *= drag; f.vy *= drag; f.vz *= drag
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt
    }
    if (!this.fxGeo || !this.fxPos || !this.fxCol) return
    for (let i = 0; i < live.length; i++) {
      const f = live[i]
      const i3 = i * 3
      this.fxPos[i3] = f.x; this.fxPos[i3 + 1] = f.y; this.fxPos[i3 + 2] = f.z
      const k = f.life / f.max // additive black = invisible -> free fade-out
      this.fxCol[i3] = f.r * k; this.fxCol[i3 + 1] = f.g * k; this.fxCol[i3 + 2] = f.b * k
    }
    this.fxGeo.setDrawRange(0, live.length)
    ;(this.fxGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.fxGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true
  }

  private disposeFX() {
    if (this.fxPts) { this.scene.remove(this.fxPts) }
    this.fxGeo?.dispose()
    ;(this.fxPts?.material as any)?.dispose?.()
    this.fxPts = null
    this.fxGeo = null
    this.fxPos = null
    this.fxCol = null
    this.fxLive.length = 0
  }

  /* ---------- camera ---------- */

  private updateCamera(scene: Scene, opts: { orbit: OrbitState; playing: boolean; cam: PlayCamState }) {
    const c3 = scene.meta.camera3d
    const targetFov = c3.fov || 60
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov
      this.camera.updateProjectionMatrix()
    }

    if (!opts.playing || c3.mode === 'orbit') {
      const o = opts.orbit
      const px = o.target.x + o.dist * Math.cos(o.phi) * Math.sin(o.theta)
      const py = o.target.y + o.dist * Math.sin(o.phi)
      const pz = o.target.z + o.dist * Math.cos(o.phi) * Math.cos(o.theta)
      this.camera.position.set(px, py, pz)
      this.camera.lookAt(o.target)
      return
    }

    const follow = c3.follow ? scene.byName(c3.follow) : null
    const fp = follow ? follow.transform.pos : this.tmpP.set(0, 1, 0)

    if (c3.mode === 'first') {
      const h = c3.height || 1.6
      this.camera.position.set(fp.x, fp.y + h, fp.z)
      const dir = this.tmpS.set(
        Math.sin(opts.cam.yaw) * Math.cos(opts.cam.pitch),
        Math.sin(opts.cam.pitch),
        Math.cos(opts.cam.yaw) * Math.cos(opts.cam.pitch)
      )
      const look = this.tmpM.scale ? 0 : 0 // (noop guard; tmp reuse below)
      void look
      this.camera.lookAt(
        this.camera.position.x + dir.x,
        this.camera.position.y + dir.y,
        this.camera.position.z + dir.z
      )
      if (follow) {
        const mesh = this.meshMap.get(follow.id)
        if (mesh) mesh.visible = false
      }
    } else if (c3.mode === 'top') {
      this.camera.position.set(fp.x, 24, fp.z + 0.01)
      this.camera.lookAt(fp.x, 0, fp.z)
    } else {
      // third person
      const dist = c3.dist || 9
      const h = c3.height || 3.2
      const desired = this.tmpP.set(
        fp.x - Math.sin(opts.cam.yaw) * dist,
        fp.y + h,
        fp.z - Math.cos(opts.cam.yaw) * dist
      )
      this.camera.position.lerp(desired, 0.12)
      this.camera.lookAt(fp.x, fp.y + 1, fp.z)
    }
  }

  /* ---------- picking ---------- */

  /** ndc x/y in -1..1 -> entity id or null (resolves InstancedMesh instances too) */
  pick(nx: number, ny: number): string | null {
    const rc = new THREE.Raycaster()
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera)
    const hits = rc.intersectObjects([...this.root.children, ...this.instGroupMeshes()], true)
    for (const h of hits) {
      const o = h.object as any
      if (o.isInstancedMesh && h.instanceId != null) {
        const g = [...this.instGroups.values()].find(g2 => g2.mesh === o)
        const ids = g?.ids
        if (ids && ids[h.instanceId]) return ids[h.instanceId]
        continue
      }
      let cur: THREE.Object3D | null = h.object
      while (cur) {
        if ((cur.userData as any).entityId) return (cur.userData as any).entityId as string
        cur = cur.parent
      }
    }
    return null
  }

  private instGroupMeshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = []
    for (const [, g] of this.instGroups) out.push(g.mesh)
    return out
  }

  /** Intersect ray with horizontal plane at y; returns world point. */
  groundPoint(nx: number, ny: number, y: number): THREE.Vector3 | null {
    const rc = new THREE.Raycaster()
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)
    const out = new THREE.Vector3()
    return rc.ray.intersectPlane(plane, out) ? out : null
  }

  /** Entity radius helper for gizmos */
  entityRadius(e: Entity) { return radiusOf(e) }
}

function cssRGB(c: string): [number, number, number] {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) {
    const n = parseInt(c.slice(1), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  return [1, 0.74, 0.14]
}
