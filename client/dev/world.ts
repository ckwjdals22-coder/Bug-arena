/**
 * 월드 미리보기(개발용). 게임 엔진 없이 월드 렌더러만 띄워 본다.
 *
 * 주소 인자
 *   ?q=low|mid|high   품질 단계(기본 high)
 *   ?colliders=1      충돌체(박스·원)를 선으로
 *   ?nav=1            NPC 이동망(노드·간선)
 *   ?pois=1           POI·시작 위치·부스 자리
 *   ?hq=1             교단 문을 연 상태로 시작
 *   ?focus=1          gameCam 이 setWorldFocus 도 같이 부른다(게임이 위치를 알려 주는 경우)
 *   ?hud=0            왼쪽 위 정보 숨기기
 *   ?near=0.1         카메라 near 값(깊이 정밀도 시험용, 기본 0.5)
 *
 * 콘솔: __dev.setCam(x,y,z,tx,ty,tz) · __dev.gameCam(x,z,yawDeg,dist?,pitchDeg?) · __dev.info() · __dev.hq(true)
 *       __dev.quality('low') · __dev.bench() · __dev.atlas() · __dev.freeze(t) · __dev.focus(true)
 * 조작: 드래그 = 회전, 휠 = 줌, WASD/방향키 = 이동
 */
import * as THREE from 'three'
import type { EngineApi, QualityTier } from '../src/core/contracts'
import { WORLD_SKY, createWorldRenderer, setWorldFocus, setWorldHqOpen, worldStats } from '../src/render/world'
import { WORLD, groundHeight } from '../../shared/world'

const params = new URLSearchParams(location.search)
const flag = (k: string): boolean => params.get(k) === '1'
const qParam = params.get('q')
let quality: QualityTier = qParam === 'low' || qParam === 'mid' ? qParam : 'high'

const canvas = document.getElementById('view') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLDivElement
if (params.get('hud') === '0') hud.style.display = 'none'

const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' })
renderer.outputColorSpace = THREE.SRGBColorSpace
const pixelCap = (q: QualityTier): number => (q === 'low' ? 1 : q === 'mid' ? 1.5 : 2)
renderer.setPixelRatio(Math.min(devicePixelRatio, pixelCap(quality)))

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, 1, Number(params.get('near')) || 0.5, 420)

// ── 하늘/안개/조명: 엔진이 쓸 값(WORLD_SKY)을 그대로 쓴다 ──
scene.fog = new THREE.Fog(WORLD_SKY.fog, WORLD_SKY.fogNear, WORLD_SKY.fogFar)
scene.background = new THREE.Color(WORLD_SKY.fog)
const hemi = new THREE.HemisphereLight(WORLD_SKY.hemi.sky, WORLD_SKY.hemi.ground, WORLD_SKY.hemi.intensity)
scene.add(hemi)
const sun = new THREE.DirectionalLight(WORLD_SKY.sun.color, WORLD_SKY.sun.intensity)
sun.position.set(...WORLD_SKY.sun.dir).multiplyScalar(100)
scene.add(sun)

/** 개발용 도우미(하늘, 인형, 선)는 여기에 모아 드로콜 계산에서 뺀다 */
const helpers = new THREE.Group()
scene.add(helpers)

// 하늘 돔: 지평선은 안개색, 조금 위는 복숭아색, 꼭대기는 하늘색
{
  const geo = new THREE.SphereGeometry(380, 24, 12)
  const pos = geo.getAttribute('position')
  const col = new Float32Array(pos.count * 3)
  const top = new THREE.Color(WORLD_SKY.top)
  const bottom = new THREE.Color(WORLD_SKY.bottom)
  const fog = new THREE.Color(WORLD_SKY.fog)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 380
    if (h < 0.04) c.copy(fog)
    else if (h < 0.22) c.copy(fog).lerp(bottom, (h - 0.04) / 0.18)
    else c.copy(bottom).lerp(top, Math.min(1, (h - 0.22) / 0.5))
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }))
  dome.renderOrder = -10
  helpers.add(dome)
}

// ── 엔진 계약을 만족하는 최소 객체 ──
const qualityListeners: ((q: QualityTier) => void)[] = []
const ndc = new THREE.Vector3()
const ray = new THREE.Raycaster()
const engine: EngineApi = {
  renderer,
  scene,
  camera,
  canvas,
  get quality() {
    return quality
  },
  setQuality(q) {
    if (q === quality) return
    quality = q
    renderer.setPixelRatio(Math.min(devicePixelRatio, pixelCap(q)))
    for (const fn of qualityListeners) fn(q)
  },
  onQuality(fn) {
    qualityListeners.push(fn)
  },
  project(x, y, z, out) {
    ndc.set(x, y, z).project(camera)
    out.x = (ndc.x * 0.5 + 0.5) * canvas.clientWidth
    out.y = (-ndc.y * 0.5 + 0.5) * canvas.clientHeight
    return ndc.z < 1 && Math.abs(ndc.x) < 1.2 && Math.abs(ndc.y) < 1.2
  },
  pickGround(clientX, clientY) {
    const r = canvas.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera)
    const d = ray.ray.direction
    if (d.y >= -1e-4) return null
    const t = -ray.ray.origin.y / d.y
    return { x: ray.ray.origin.x + d.x * t, z: ray.ray.origin.z + d.z * t }
  },
  resize() {
    const w = canvas.clientWidth || innerWidth
    const h = canvas.clientHeight || innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  },
  render() {
    renderer.render(scene, camera)
  },
}

const world = createWorldRenderer(engine)
setWorldHqOpen(flag('hq'))

// ── 게임 카메라 흉내용 인형(키 1.5m, 큰 머리) ──
const dummy = new THREE.Group()
{
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.7, 10), bodyMat)
  body.position.y = 0.45
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 10), new THREE.MeshLambertMaterial({ color: 0xffd9b8 }))
  head.position.y = 1.12
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), new THREE.MeshLambertMaterial({ color: 0x3a2a4a }))
  nose.position.set(0, 1.1, 0.4)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 16),
    new THREE.MeshBasicMaterial({ color: 0x1c1232, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.06
  dummy.add(body, head, nose, shadow)
  dummy.visible = false
  helpers.add(dummy)
}

// ── 겹쳐 보기: 충돌체 / 이동망 / POI ──
function lineMesh(points: number[], color: number): THREE.LineSegments {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
  const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, fog: false }))
  m.renderOrder = 100
  return m
}
function pushBox(out: number[], x0: number, z0: number, x1: number, z1: number, y: number): void {
  out.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0)
}
function pushCircle(out: number[], x: number, z: number, r: number, y: number, seg = 20): void {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2
    const a1 = ((i + 1) / seg) * Math.PI * 2
    out.push(x + Math.cos(a0) * r, y, z + Math.sin(a0) * r, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r)
  }
}
function pushArrow(out: number[], x: number, z: number, yaw: number, len: number, y: number): void {
  const fx = Math.sin(yaw)
  const fz = Math.cos(yaw)
  const tx = x + fx * len
  const tz = z + fz * len
  out.push(x, y, z, tx, y, tz)
  out.push(tx, y, tz, tx - fx * 0.3 + fz * 0.2, y, tz - fz * 0.3 - fx * 0.2)
  out.push(tx, y, tz, tx - fx * 0.3 - fz * 0.2, y, tz - fz * 0.3 + fx * 0.2)
}

if (flag('colliders')) {
  const pts: number[] = []
  const y = 0.12
  for (const b of WORLD.boxes) pushBox(pts, b.x0, b.z0, b.x1, b.z1, y)
  for (const c of WORLD.circles) pushCircle(pts, c.x, c.z, c.r, y)
  helpers.add(lineMesh(pts, 0xff2a2a))
  const bd: number[] = []
  pushBox(bd, WORLD.bounds.x0, WORLD.bounds.z0, WORLD.bounds.x1, WORLD.bounds.z1, y)
  helpers.add(lineMesh(bd, 0xffffff))
}
if (flag('nav')) {
  const edges: number[] = []
  const y = 0.2
  for (const [a, b] of WORLD.nav.edges) {
    const p = WORLD.nav.nodes[a]!
    const q = WORLD.nav.nodes[b]!
    edges.push(p.x, y, p.z, q.x, y, q.z)
  }
  helpers.add(lineMesh(edges, 0x22d3ff))
  const colors: Record<string, number> = { walk: 0x22d3ff, plaza: 0x4dff7a, cross: 0xffffff, shop: 0xffb020, rest: 0xff5ad1, exit: 0xff3030 }
  for (const kind of Object.keys(colors)) {
    const pts: number[] = []
    for (const n of WORLD.nav.nodes) if (n.kind === kind) pushCircle(pts, n.x, n.z, 0.45, y, 10)
    if (pts.length) helpers.add(lineMesh(pts, colors[kind]!))
  }
}
if (flag('pois')) {
  const y = 0.28
  const pts: number[] = []
  pushCircle(pts, WORLD.plaza.x, WORLD.plaza.z, WORLD.plaza.r, y, 48)
  pushCircle(pts, WORLD.podium.x, WORLD.podium.z, WORLD.podium.r, y, 32)
  pushCircle(pts, WORLD.podium.x, WORLD.podium.z, WORLD.podium.r + WORLD.podium.ramp, y, 32)
  pushCircle(pts, WORLD.offeringBox.x, WORLD.offeringBox.z, WORLD.offeringBox.r + 1.6, y)
  pushCircle(pts, WORLD.tent.x, WORLD.tent.z, WORLD.tent.r, y)
  pushCircle(pts, WORLD.subway.x, WORLD.subway.z, WORLD.subway.r, y)
  pushArrow(pts, WORLD.subway.x, WORLD.subway.z, WORLD.subway.yaw, 1.6, y)
  pushCircle(pts, WORLD.hq.door.x, WORLD.hq.door.z, WORLD.hq.door.r, y)
  const g = WORLD.hq.gate
  pushBox(pts, g.x0, g.z0, g.x1, g.z1, y)
  const i = WORLD.hq.inside
  pushBox(pts, i.x0, i.z0, i.x1, i.z1, y)
  helpers.add(lineMesh(pts, 0xffe000))
  const sp: number[] = []
  for (const s of WORLD.spawns) {
    pushCircle(sp, s.x, s.z, 0.45, y, 10)
    pushArrow(sp, s.x, s.z, s.yaw, 0.9, y)
  }
  for (const s of WORLD.booths) {
    pushCircle(sp, s.x, s.z, 0.45, y, 10)
    pushArrow(sp, s.x, s.z, s.yaw, 0.9, y)
  }
  helpers.add(lineMesh(sp, 0xff40ff))
}

// ── 카메라 조작 ──
const target = new THREE.Vector3(0, 0, -6)
let orbitYaw = 0 // 카메라가 타깃을 바라보는 방향(0 = 남쪽에서 북쪽을 봄)
let orbitPitch = 1.0
let orbitDist = 95
let manual = true

function applyOrbit(): void {
  const cp = Math.cos(orbitPitch)
  camera.position.set(target.x - Math.sin(orbitYaw) * cp * orbitDist, target.y + Math.sin(orbitPitch) * orbitDist, target.z + Math.cos(orbitYaw) * cp * orbitDist)
  camera.lookAt(target)
}
applyOrbit()

let dragging = false
let lastX = 0
let lastY = 0
canvas.addEventListener('pointerdown', (e) => {
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return
  manual = true
  orbitYaw += (e.clientX - lastX) * 0.005
  orbitPitch = Math.min(1.55, Math.max(0.08, orbitPitch + (e.clientY - lastY) * 0.005))
  lastX = e.clientX
  lastY = e.clientY
})
canvas.addEventListener('pointerup', () => (dragging = false))
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    manual = true
    orbitDist = Math.min(200, Math.max(3, orbitDist * Math.exp(e.deltaY * 0.001)))
  },
  { passive: false },
)
const keys = new Set<string>()
addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()))
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))

// ── 콘솔 API ──
let focusOn = flag('focus')
const dev = {
  /** 카메라를 (x,y,z)에 놓고 (tx,ty,tz)를 본다 */
  setCam(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
    manual = false
    dummy.visible = false
    camera.position.set(x, y, z)
    camera.lookAt(tx, ty, tz)
  },
  /**
   * 게임 카메라처럼: (x,z)에 선 1.5m 인형의 등 뒤에서 내려다본다.
   * yawDeg = 인형이 바라보는 방향(0 = 남쪽, 180 = 북쪽), dist = 거리(m), pitchDeg = 내려다보는 각도
   */
  gameCam(x: number, z: number, yawDeg: number, dist = 11, pitchDeg = 38): { x: number; y: number; z: number } {
    manual = false
    const yaw = (yawDeg * Math.PI) / 180
    const pitch = (pitchDeg * Math.PI) / 180
    const gy = groundHeight(x, z)
    dummy.visible = true
    dummy.position.set(x, gy, z)
    dummy.rotation.y = yaw
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const ty = gy + 1.2
    camera.position.set(x - fx * Math.cos(pitch) * dist, ty + Math.sin(pitch) * dist, z - fz * Math.cos(pitch) * dist)
    camera.lookAt(x, ty, z)
    if (focusOn) dummyFocus = { x, z }
    return { x: camera.position.x, y: camera.position.y, z: camera.position.z }
  },
  /** 월드만(하늘·인형·선 제외) 그렸을 때의 드로콜/삼각형 수 */
  info(): { calls: number; triangles: number; geometries: number; textures: number; quality: QualityTier; atlasFit: number } {
    helpers.visible = false
    renderer.render(scene, camera)
    const out = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      quality,
      atlasFit: worldStats()?.atlasFit ?? 0,
    }
    helpers.visible = true
    renderer.render(scene, camera)
    return out
  },
  /** 교단 문 열기/닫기 */
  hq(open: boolean): void {
    setWorldHqOpen(open)
  },
  /** setWorldFocus 를 gameCam 위치로 계속 불러 줄지 */
  focus(on: boolean): void {
    focusOn = on
    if (!on) dummyFocus = null
  },
  quality(q: QualityTier): void {
    engine.setQuality(q)
  },
  /** 애니메이션 시각을 고정(스크린샷 비교용). null 이면 실시간 */
  freeze(t: number | null): void {
    frozen = t
  },
  dispose(): void {
    world.dispose()
  },
  /** update() 한 번의 평균 시간과 월드를 통째로 다시 만드는 시간(ms) */
  bench(): { updateMs: number; rebuildMs: number } {
    const n = 2000
    const t0 = performance.now()
    for (let i = 0; i < n; i++) world.update(0.016, i * 0.016)
    const updateMs = (performance.now() - t0) / n
    const q = quality
    const t1 = performance.now()
    engine.setQuality(q === 'low' ? 'mid' : 'low')
    engine.setQuality(q)
    const rebuildMs = (performance.now() - t1) / 2
    return { updateMs, rebuildMs }
  },
  /** 간판 아틀라스 그림(검수용 data URL) */
  atlas(): string {
    let url = ''
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined
      const img = m?.map?.image as HTMLCanvasElement | undefined
      if (!url && img && typeof img.toDataURL === 'function') url = img.toDataURL('image/png')
    })
    return url
  },
}
let dummyFocus: { x: number; z: number } | null = null
let frozen: number | null = null
;(window as unknown as { __dev: typeof dev }).__dev = dev

// ── 루프 ──
addEventListener('resize', () => engine.resize())
engine.resize()
let last = performance.now()
let hudAt = 0
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  if (manual) {
    const sp = orbitDist * 0.6 * dt
    const fx = Math.sin(orbitYaw)
    const fz = -Math.cos(orbitYaw)
    if (keys.has('w') || keys.has('arrowup')) target.add(new THREE.Vector3(fx * sp, 0, fz * sp))
    if (keys.has('s') || keys.has('arrowdown')) target.add(new THREE.Vector3(-fx * sp, 0, -fz * sp))
    if (keys.has('a') || keys.has('arrowleft')) target.add(new THREE.Vector3(fz * sp, 0, -fx * sp))
    if (keys.has('d') || keys.has('arrowright')) target.add(new THREE.Vector3(-fz * sp, 0, fx * sp))
    applyOrbit()
  }
  if (dummyFocus) setWorldFocus(dummyFocus.x, dummyFocus.z)
  world.update(dt, frozen ?? now / 1000)
  engine.render()
  if (now - hudAt > 500) {
    hudAt = now
    const r = renderer.info.render
    hud.textContent = `품질 ${quality} · 드로콜 ${r.calls} · 삼각형 ${r.triangles}\n(도우미 포함 수치 — 월드만은 __dev.info())`
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
