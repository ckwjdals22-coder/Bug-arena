/**
 * 월드 렌더러 — "수상역 4번 출구 앞": 평범한 한국 거리인데 어딘가 수상한 무대.
 *
 * 설계 요점
 *  - shared/world/data.ts 의 건물·소품 목록을 그대로 읽어 그린다(충돌체와 같은 원본).
 *  - 정적 지오메트리는 재질별로 한 덩어리씩: 조명 받는 면 / 바닥·벽 무늬 / 간판·불빛(아틀라스 1장) / 가짜 그림자.
 *    움직이는 것(네온, 신호등, 셔터, 파라솔, 깃발, 비둘기)만 따로 둔다 → 전체 드로콜 15개 안팎.
 *  - 실시간 그림자 없음. 접지 음영·그늘·빛 웅덩이는 반투명 면과 버텍스 컬러로 흉내 낸다.
 *  - 하늘/안개/조명은 엔진 담당이 WORLD_SKY 값으로 설정한다.
 */
import * as THREE from 'three'
import type { EngineApi, QualityTier, WorldRendererApi } from '../core/contracts'
import { inBox } from '../../../shared/world'
import { HQ } from '../../../shared/world/data'
import { SignAtlas } from './world/atlas'
import { HQ_SHUTTER_PIVOT, buildBuildings } from './world/buildings'
import type { BuildCtx, FlagInst, ParasolInst, PigeonInst } from './world/ctx'
import { Builder, type RGB, cyl, ico, makeRnd, mul, rgb } from './world/geo'
import { buildGround } from './world/ground'
import { buildProps, subwayHole } from './world/props'

export { WORLD_SKY } from './world/ctx'

// ───────────────────────── 게임 쪽에서 부르는 독립 함수 ─────────────────────────

let hqOpenTarget = false
let focusX = 0
let focusZ = 0
/** setWorldFocus 가 마지막으로 불린 뒤 지난 프레임 수(오래되면 카메라로 추정한다) */
let focusAge = 1e9

/**
 * 비밀 교단 건물의 문(셔터)을 연다/닫는다. 내 직급이 world.hq.minRank 이상이면 true 로 불러 준다.
 * 월드 렌더러가 만들어지기 전에 불러도 값은 기억된다.
 */
export function setWorldHqOpen(open: boolean): void {
  hqOpenTarget = open
}

/**
 * (선택) 매 프레임 내 캐릭터 위치를 알려 주면, 교단 건물 안에 들어갔을 때 지붕과 앞벽을 정확한 순간에 걷어 낸다.
 * 부르지 않으면 카메라가 바라보는 지점으로 추정한다(조금 늦게 걷힐 수 있다).
 */
export function setWorldFocus(x: number, z: number): void {
  focusX = x
  focusZ = z
  focusAge = 0
}

/** 개발 화면용 수치: 간판 아틀라스가 설계 크기 대비 몇 배로 담겼는지(1 = 줄이지 않음) 등 */
export function worldStats(): { atlasFit: number; atlasSize: number } | null {
  return lastStats
}
let lastStats: { atlasFit: number; atlasSize: number } | null = null

// ───────────────────────── 조립 ─────────────────────────

interface Instanced<T> {
  mesh: THREE.InstancedMesh
  data: T[]
}

interface Built {
  root: THREE.Group
  atlas: SignAtlas
  disposables: { dispose(): void }[]
  low: boolean
  shell: THREE.Mesh | null
  interior: THREE.Group
  neon: THREE.Mesh | null
  neonMat: THREE.MeshBasicMaterial
  shutter: THREE.Mesh | null
  sigRed: THREE.Mesh | null
  sigGreen: THREE.Mesh | null
  parasols: Instanced<ParasolInst> | null
  flags: Instanced<FlagInst> | null
  pigeons: Instanced<PigeonInst> | null
}

function build(engine: EngineApi, q: QualityTier): Built {
  const low = q === 'low'
  const lit = (): Builder => new Builder(true, false, false)
  const unlit = (): Builder => new Builder(false, true, false)
  const hqSolid = lit()
  const atlas = new SignAtlas()
  const c: BuildCtx = {
    q,
    low,
    high: q === 'high',
    main: { solid: lit(), decal: lit(), unlit: unlit(), fx: new Builder(false, false, true) },
    // 방 안은 드로콜을 아끼려고 무늬도 같은 버퍼에 담는다(조금씩 띄워서 겹침을 피한다)
    hq: { solid: hqSolid, decal: hqSolid, unlit: unlit(), fx: null },
    shell: lit(),
    neon: unlit(),
    shutter: lit(),
    sigRed: unlit(),
    sigGreen: unlit(),
    atlas,
    parasols: [],
    flags: [],
    pigeons: [],
    // 시드 고정: 모든 접속자가 같은 거리(같은 창문 불빛, 같은 나무 모양)를 본다
    rnd: makeRnd(20240917),
  }

  buildGround(c, subwayHole())
  buildBuildings(c)
  buildProps(c)

  const caps = engine.renderer.capabilities
  const atlasSize = low ? 512 : 1024
  const tex = atlas.bake(atlasSize, low ? 1 : Math.min(q === 'high' ? 4 : 2, caps.getMaxAnisotropy()))
  lastStats = { atlasFit: atlas.fit, atlasSize }

  // ── 재질 ──
  const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  const decalMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const unlitMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: tex, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
  const fxMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  })
  const neonMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: tex, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
  const flagMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
  const disposables: { dispose(): void }[] = [solidMat, decalMat, unlitMat, fxMat, neonMat, flagMat, atlas]

  const root = new THREE.Group()
  root.name = 'world'
  const add = (b: Builder, mat: THREE.Material, name: string, parent: THREE.Object3D = root): THREE.Mesh | null => {
    if (b.empty) return null
    const geo = b.build()
    disposables.push(geo)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = name
    mesh.matrixAutoUpdate = false
    parent.add(mesh)
    return mesh
  }

  add(c.main.solid, solidMat, 'world-solid')
  add(c.main.decal, decalMat, 'world-decal')
  add(c.main.unlit, unlitMat, 'world-signs')
  const fx = add(c.main.fx!, fxMat, 'world-shadows')
  // 반투명 그림자는 캐릭터보다 먼저 그려져야 캐릭터 발이 그림자에 묻히지 않는다
  if (fx) fx.renderOrder = -1

  const interior = new THREE.Group()
  interior.name = 'hq-interior'
  root.add(interior)
  // 방 안은 '무늬' 재질(polygonOffset)로 그린다: 바닥이 건물 발자국 무늬와 같은 조건에서 높이로만 겨루게 된다
  add(c.hq.solid, decalMat, 'hq-inside', interior)
  add(c.hq.unlit, unlitMat, 'hq-inside-signs', interior)
  const shell = add(c.shell, solidMat, 'hq-shell')
  const neon = add(c.neon, neonMat, 'hq-neon')
  const sigRed = add(c.sigRed, unlitMat, 'signal-red')
  const sigGreen = add(c.sigGreen, unlitMat, 'signal-green')

  const shutter = add(c.shutter, solidMat, 'hq-shutter')
  if (shutter) {
    shutter.matrixAutoUpdate = true
    shutter.position.set(HQ_SHUTTER_PIVOT.x, HQ_SHUTTER_PIVOT.y, HQ_SHUTTER_PIVOT.z)
  }

  // ── 인스턴스: 파라솔 / 깃발 / 비둘기 ──
  const color = new THREE.Color()
  const instanced = <T>(geo: THREE.BufferGeometry, mat: THREE.Material, data: T[], name: string, colorOf?: (d: T) => number): Instanced<T> | null => {
    if (!data.length) {
      geo.dispose()
      return null
    }
    disposables.push(geo)
    const mesh = new THREE.InstancedMesh(geo, mat, data.length)
    mesh.name = name
    // 인스턴스가 넓게 흩어져 있어 한 덩어리 경계 구로는 컬링이 부정확하다(개수도 적어 그냥 그린다)
    mesh.frustumCulled = false
    if (colorOf) data.forEach((d, i) => mesh.setColorAt(i, color.setHex(colorOf(d))))
    disposables.push(mesh)
    root.add(mesh)
    return { mesh, data }
  }
  const parasols = instanced(parasolGeometry(), solidMat, c.parasols, 'parasols', (d) => d.color)
  const flags = instanced(flagGeometry(), flagMat, c.flags, 'flags', (d) => d.color)
  const pigeons = instanced(pigeonGeometry(), solidMat, c.pigeons, 'pigeons')

  const built: Built = { root, atlas, disposables, low, shell, interior, neon, neonMat, shutter, sigRed, sigGreen, parasols, flags, pigeons }
  // 움직임이 없는 품질에서도 한 번은 제자리에 놓아야 한다
  placeInstances(built, 0, true)
  return built
}

/** 파라솔: 원점이 바닥, 기둥이 위로. 인스턴스 색 × (밝은 면 / 어두운 면) 으로 두 톤 줄무늬를 만든다 */
function parasolGeometry(): THREE.BufferGeometry {
  const b = new Builder(true, false, false)
  const H = 2.45
  const R = 1.5
  const n = 8
  const lightTone: RGB = [1, 1, 1]
  const darkTone: RGB = [0.5, 0.5, 0.5]
  // 기둥은 인스턴스 색을 덜 타게 밝은 회색
  cyl(b, 0, 0, 0, 0.04, 0.035, H + 0.3, 5, [0.82, 0.82, 0.82], { cap: null })
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    const p0: [number, number, number] = [R * Math.cos(a0), H - 0.12, R * Math.sin(a0)]
    const p1: [number, number, number] = [R * Math.cos(a1), H - 0.12, R * Math.sin(a1)]
    const top: [number, number, number] = [0, H + 0.38, 0]
    const tone = i % 2 === 0 ? lightTone : darkTone
    b.tri(p1, p0, top, tone)
    // 안쪽(아래에서 올려다볼 때)
    b.tri(p0, p1, top, mul(tone, 0.6))
  }
  return b.build()
}

/** 삼각 깃발: 윗변이 줄에 매달리고 아래로 뾰족하다 */
function flagGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, -1, 0]), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
  return g
}

/** 비둘기: 통통한 몸 + 머리 + 부리 + 꼬리. 앞 = +Z */
function pigeonGeometry(): THREE.BufferGeometry {
  const b = new Builder(true, false, false)
  const body = rgb(0x8f93a3)
  // 실제 비둘기보다 1.7배쯤 크다: 3인칭 카메라 거리에서도 '비둘기'로 읽혀야 한다
  ico(b, 0, 0.21, 0, 0.17, 0.15, 0.25, body)
  ico(b, 0, 0.41, 0.19, 0.095, 0.095, 0.1, rgb(0x6c7386))
  b.tri([-0.035, 0.41, 0.27], [0.035, 0.41, 0.27], [0, 0.385, 0.37], rgb(0xf0a23c))
  b.tri([0.035, 0.41, 0.27], [-0.035, 0.41, 0.27], [0, 0.385, 0.37], rgb(0xf0a23c))
  // 꼬리(위/아래 양면)
  b.tri([-0.1, 0.24, -0.2], [0.1, 0.24, -0.2], [0, 0.19, -0.46], mul(body, 0.75))
  b.tri([0.1, 0.24, -0.2], [-0.1, 0.24, -0.2], [0, 0.19, -0.46], mul(body, 0.75))
  // 목덜미의 초록빛
  ico(b, 0, 0.32, 0.13, 0.1, 0.06, 0.085, rgb(0x5f9e86))
  return b.build()
}

const tmpMat = new THREE.Matrix4()
const tmpPos = new THREE.Vector3()
const tmpQuat = new THREE.Quaternion()
const tmpScale = new THREE.Vector3()
const tmpEuler = new THREE.Euler()
const tmpDir = new THREE.Vector3()

/** 인스턴스 행렬 갱신. force = 움직임이 꺼진 품질에서 처음 한 번 */
function placeInstances(w: Built, time: number, force: boolean): void {
  const animate = !w.low
  if (!animate && !force) return
  if (w.parasols) {
    const { mesh, data } = w.parasols
    for (let i = 0; i < data.length; i++) {
      const d = data[i]!
      // 바람에 아주 조금 기우뚱
      tmpEuler.set(Math.sin(time * 0.9 + d.phase) * 0.028, 0, Math.cos(time * 0.7 + d.phase * 1.7) * 0.028)
      tmpQuat.setFromEuler(tmpEuler)
      mesh.setMatrixAt(i, tmpMat.compose(tmpPos.set(d.x, d.y, d.z), tmpQuat, tmpScale.setScalar(d.scale)))
    }
    mesh.instanceMatrix.needsUpdate = true
  }
  if (w.flags) {
    const { mesh, data } = w.flags
    for (let i = 0; i < data.length; i++) {
      const d = data[i]!
      // 줄(로컬 X)을 축으로 펄럭인다
      tmpEuler.set(Math.sin(time * 2.6 + d.phase) * 0.45 + Math.sin(time * 5.3 + d.phase * 2) * 0.12, d.yaw, 0, 'YXZ')
      tmpQuat.setFromEuler(tmpEuler)
      mesh.setMatrixAt(i, tmpMat.compose(tmpPos.set(d.x, d.y, d.z), tmpQuat, tmpScale.set(d.w, d.h, 1)))
    }
    mesh.instanceMatrix.needsUpdate = true
  }
  if (w.pigeons) {
    const { mesh, data } = w.pigeons
    for (let i = 0; i < data.length; i++) {
      const d = data[i]!
      const t = time + d.phase
      // 가끔 바닥을 쪼고, 종종걸음으로 몸을 돌린다
      const peck = Math.max(0, Math.sin(t * 2.3)) ** 6
      const hop = Math.abs(Math.sin(t * 7)) * 0.012
      tmpEuler.set(peck * 0.95, d.yaw + Math.sin(t * 0.37) * 0.7, 0, 'YXZ')
      tmpQuat.setFromEuler(tmpEuler)
      mesh.setMatrixAt(i, tmpMat.compose(tmpPos.set(d.x, d.y + hop, d.z), tmpQuat, tmpScale.setScalar(1)))
    }
    mesh.instanceMatrix.needsUpdate = true
  }
}

// ───────────────────────── 공개 API ─────────────────────────

export function createWorldRenderer(engine: EngineApi): WorldRendererApi {
  let disposed = false
  let quality: QualityTier = engine.quality
  let world: Built | null = build(engine, quality)
  engine.scene.add(world.root)
  /** 셔터가 열린 정도 0..1 */
  let open = hqOpenTarget ? 1 : 0

  const free = (w: Built): void => {
    engine.scene.remove(w.root)
    for (const d of w.disposables) d.dispose()
  }

  // 품질 단계가 바뀌면 통째로 다시 만든다(아틀라스 크기와 꾸밈 소품 수가 달라진다)
  engine.onQuality((q) => {
    if (disposed || q === quality || !world) return
    quality = q
    free(world)
    world = build(engine, q)
    engine.scene.add(world.root)
  })

  return {
    update(dt: number, time: number): void {
      const w = world
      if (disposed || !w) return
      const step = Math.min(Math.max(dt, 0), 0.1)

      // ── 보행 신호: 초록 7초 → 깜빡임 3초 → 빨강 6초 ──
      const ph = time % 16
      const green = ph < 7 || (ph < 10 && Math.floor(ph * 2.5) % 2 === 0)
      if (w.sigGreen) w.sigGreen.visible = green
      if (w.sigRed) w.sigRed.visible = ph >= 10

      // ── 네온: 잔잔한 숨쉬기 + 가끔 지지직 ──
      let glow = 0.9 + 0.1 * Math.sin(time * 5.1)
      if (time % 7.3 > 6.65 && Math.floor(time * 22) % 2 === 0) glow *= 0.35
      w.neonMat.color.setScalar(glow)

      // ── 셔터 ──
      const target = hqOpenTarget ? 1 : 0
      if (open !== target) open += Math.min(Math.max(target - open, -step * 1.5), step * 1.5)
      const ease = open * open * (3 - 2 * open)
      if (w.shutter) w.shutter.scale.y = 1 - 0.93 * ease

      // ── 교단 건물 단면 보기 ──
      // 내 캐릭터가 안에 있으면 지붕과 앞벽을 걷어 내 인형의 집처럼 들여다본다.
      // 반대로 카메라만 건물 안에 들어간 경우(문 앞 골목에 서 있을 때)는 방 안을 숨겨 골목이 보이게 한다.
      const cam = engine.camera.position
      let inside = false
      if (focusAge <= 2) {
        inside = inBox(focusX, focusZ, HQ.inside, 0.15) || (inBox(focusX, focusZ, HQ.gate, 0) && focusZ > (HQ.gate.z0 + HQ.gate.z1) / 2)
      } else if (hqOpenTarget) {
        // 위치를 모르면 카메라가 바라보는 바닥 지점으로 추정한다. 문 앞에서 미리 걷히지 않게 안쪽으로 여유를 둔다
        engine.camera.getWorldDirection(tmpDir)
        if (tmpDir.y < -0.08) {
          const t = (cam.y - 0.9) / -tmpDir.y
          if (t < 45) inside = inBox(cam.x + tmpDir.x * t, cam.z + tmpDir.z * t, HQ.inside, -0.6)
        }
      }
      focusAge++
      const camInside = cam.y < HQ.h && inBox(cam.x, cam.z, HQ.outer, 0)
      if (w.shell) w.shell.visible = !inside
      if (w.neon) w.neon.visible = !inside
      if (w.shutter) w.shutter.visible = !inside
      // 문이 완전히 닫혀 있으면 안은 어차피 안 보이니 그리지 않는다
      w.interior.visible = inside || (open > 0.001 && !camInside)

      placeInstances(w, time, false)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      if (world) free(world)
      world = null
    },
  }
}
