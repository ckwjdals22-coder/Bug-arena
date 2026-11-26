/**
 * 캐릭터/이펙트 개발용 미리보기. 게임 엔진(render/engine.ts)을 쓰지 않고 자체 렌더러와 최소한의 EngineApi 로 돈다.
 *
 *   /dev/chars.html                 카탈로그(복장×색, 모자, 얼굴, 소품, 오라, 피부, 고양이)
 *   /dev/chars.html?view=anim       상태·이모트 한 명씩 + 걷기/달리기 레인
 *   /dev/chars.html?view=game       실제 게임 시점(10m, 32°, FOV 55)에서의 가독성
 *   /dev/chars.html?view=fx         이펙트 확인용(한 명 + 버튼)
 *   /dev/chars.html?stress=70       70명이 원을 그리며 걷는 부하 시험(fps/드로콜 표시)
 *   &q=low|mid|high                 품질 단계
 *
 * 콘솔/자동화용 window.__dev:
 *   setCam(x,y,z, tx,ty,tz, fov?)   카메라 위치와 바라보는 점
 *   info() / stats()                방금 그린 프레임의 renderer.info.render / 평균 프레임·update·render 시간
 *   portrait(look, size?, emote?)   초상을 만들어 화면 왼쪽 아래에 붙인다 · clearPortraits()
 *   freeze(t) / unfreeze()          애니메이션 시계를 t 초에 고정(같은 t 는 항상 같은 그림)
 *   sheet([t…], cols?) / sheetOff() 여러 시각의 화면을 한 장에 이어 붙여 덮는다(걸음·이모트 연속 장면)
 *   fx(kind, color?) / fxAt(kind, t, color?)   이펙트 터뜨리기 / 터뜨린 뒤 t 초 지난 순간에 멈추기
 *   view(name, n?) · section(tag|null) · only(label) · follow(label, dx,dy,dz,ty)   보여 줄 대상 고르기
 *   quality(q) · fog('linear'|'exp2'|'none') · labels(bool) · ui(bool)
 */
import * as THREE from 'three'
import { Anim } from '../../shared/constants'
import { ACCESSORIES, AURAS, EMOTES, FACES, HATS, OUTFITS, OUTFIT_COLORS, SKIN_COLORS } from '../../shared/content/core'
import type { Look } from '../../shared/types'
import type { CharVisual, CharacterRendererApi, EngineApi, FxApi, FxKind, QualityTier } from '../src/core/contracts'
import { createCharacterRenderer } from '../src/render/characters'
import { createFx } from '../src/render/fx'

const params = new URLSearchParams(location.search)
const canvas = document.getElementById('view') as HTMLCanvasElement
const labelRoot = document.getElementById('labels') as HTMLElement
const bar = document.getElementById('bar') as HTMLElement
const statsEl = document.getElementById('stats') as HTMLElement
const portraitRoot = document.getElementById('portraits') as HTMLElement

// ───────── 자체 렌더러 + 최소 EngineApi ─────────
const qParam = params.get('q')
let quality: QualityTier = qParam === 'low' || qParam === 'mid' ? qParam : 'high'
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' })
renderer.outputColorSpace = THREE.SRGBColorSpace
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xcfe3f2)
scene.fog = new THREE.Fog(0xd9cbe8, 45, 160)
const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 400)
scene.add(new THREE.HemisphereLight(0xfff3e0, 0x9a8fb5, 1.25))
const sun = new THREE.DirectionalLight(0xffe8cc, 1.7)
sun.position.set(-6, 12, 8)
scene.add(sun)

// 바닥: 1m 격자(발이 미끄러지는지 눈으로 확인하기 좋다)
{
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#cdbfae'
    ctx.fillRect(0, 0, 128, 128)
    ctx.fillStyle = '#c3b4a2'
    ctx.fillRect(0, 0, 64, 64)
    ctx.fillRect(64, 64, 64, 64)
    ctx.strokeStyle = 'rgba(90,70,60,0.25)'
    ctx.lineWidth = 2
    ctx.strokeRect(0, 0, 128, 128)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(200, 200)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ map: tex }))
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)
}

const qualityListeners: ((q: QualityTier) => void)[] = []
const _v = new THREE.Vector3()
const _ray = new THREE.Raycaster()
const engine: EngineApi = {
  renderer,
  scene,
  camera,
  canvas,
  get quality() {
    return quality
  },
  setQuality(q) {
    quality = q
    applyPixelRatio()
    for (const fn of qualityListeners) fn(q)
  },
  onQuality(fn) {
    qualityListeners.push(fn)
  },
  project(x, y, z, out) {
    _v.set(x, y, z).project(camera)
    if (_v.z < -1 || _v.z > 1) return false
    out.x = (_v.x * 0.5 + 0.5) * canvas.clientWidth
    out.y = (-_v.y * 0.5 + 0.5) * canvas.clientHeight
    return out.x > -80 && out.y > -80 && out.x < canvas.clientWidth + 80 && out.y < canvas.clientHeight + 80
  },
  pickGround(clientX, clientY) {
    const r = canvas.getBoundingClientRect()
    _ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera)
    const d = _ray.ray.direction
    if (d.y >= -1e-4) return null
    const k = -_ray.ray.origin.y / d.y
    return { x: _ray.ray.origin.x + d.x * k, z: _ray.ray.origin.z + d.z * k }
  },
  resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  },
  render() {
    renderer.render(scene, camera)
  },
}
function applyPixelRatio(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : quality === 'mid' ? 1.5 : 2))
  engine.resize()
}
applyPixelRatio()
window.addEventListener('resize', () => engine.resize())

let chars: CharacterRendererApi = createCharacterRenderer(engine)
let fx: FxApi = createFx(engine)

// ───────── 배우(화면에 세울 캐릭터) ─────────
interface Actor {
  v: CharVisual
  label: string
  /** 카탈로그 구획 이름(outfit, hat, face, skin, acc, aura, cat …). section() 으로 한 구획만 볼 수 있다 */
  tag: string
  /** 시각 t(초)에서의 상태를 v 에 써 넣는다. 위치까지 t 의 함수여야 freeze 가 결정적이다 */
  step?: (t: number, v: CharVisual) => void
  el?: HTMLElement
}

let nextKey = 1
let curTag = ''
function actor(label: string, x: number, z: number, look: Look, opts: Partial<CharVisual> = {}, step?: Actor['step']): Actor {
  const key = nextKey++
  return {
    label,
    step,
    tag: curTag,
    v: {
      key,
      x,
      y: 0,
      z,
      yaw: 0,
      look,
      model: 0,
      anim: Anim.Idle,
      emote: null,
      emoteT: 0,
      phase: (key * 0.6180339) % 1,
      scale: 1,
      ring: -1,
      isNpc: false,
      highlight: false,
      ...opts,
    },
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 직선 레인을 왕복(양 끝에서 돌아선다). 속도가 정확해야 발 미끄러짐을 판단할 수 있다 */
function lane(len: number, speed: number, x0: number, z: number, anim: number): NonNullable<Actor['step']> {
  return (t, v) => {
    const period = (2 * len) / speed
    const u = (((t + v.phase * period) % period) + period) % period
    const d = u * speed
    const fwd = d < len
    v.x = x0 + (fwd ? d : 2 * len - d)
    v.z = z
    v.yaw = fwd ? Math.PI / 2 : -Math.PI / 2
    v.anim = anim
  }
}

function buildCatalog(): Actor[] {
  const out: Actor[] = []
  const colorRows = [2, 7, 8]
  curTag = 'outfit'
  OUTFITS.forEach((o, i) => {
    colorRows.forEach((c, r) => {
      const x = (i - (OUTFITS.length - 1) / 2) * 1.5
      const z = -9.6 + r * 1.6
      out.push(actor(r === colorRows.length - 1 ? `${o.id} ${o.name}` : '', x, z, [i % SKIN_COLORS.length, o.id, c, 0, i % 4, 0, 0]))
    })
  })
  curTag = 'hat'
  HATS.forEach((h, i) => {
    out.push(actor(`${h.id} ${h.name}`, (i - (HATS.length - 1) / 2) * 1.5, -4.2, [1, [0, 1, 0, 5, 3, 2, 6, 7, 4, 8, 9][i] ?? 0, 6, h.id, 0, 0, 0]))
  })
  curTag = 'face'
  FACES.forEach((fc, i) => {
    out.push(actor(`${fc.id} ${fc.name}`, (i - 6.5) * 1.5, -2.2, [i % 3, 1, 3 + i, 0, fc.id, 0, 0]))
  })
  curTag = 'skin'
  SKIN_COLORS.forEach((_, i) => {
    out.push(actor(`피부 ${i}`, (i + 8 - 6.5) * 1.5, -2.2, [i, 0, 5, 0, i === 3 ? 3 : 0, 0, 0]))
  })
  curTag = 'acc'
  ACCESSORIES.forEach((a, i) => {
    out.push(actor(`${a.id} ${a.name}`, (i - 6.5) * 1.5, -0.2, [0, i === 4 ? 2 : 0, 7, 0, 0, a.id, 0]))
  })
  curTag = 'aura'
  AURAS.forEach((a, i) => {
    out.push(actor(`${a.id} ${a.name}`, (i + 7.5 - 6.5) * 1.5, -0.2, [1, 6, 0, 0, 1, 0, a.id]))
  })
  curTag = 'cat'
  for (let i = 0; i < 12; i++) {
    out.push(actor(`고양이 ${i}`, (i - 5.5) * 1.3, 1.6, [0, 0, i, 0, 0, 0, 0], { model: 1, isNpc: true, yaw: (i % 3) * 0.5 - 0.5 }))
  }
  return out
}

const DEMO_LOOKS: Look[] = [
  [0, 2, 0, 0, 1, 1, 0],
  [1, 3, 8, 3, 6, 2, 0],
  [2, 1, 2, 1, 0, 3, 0],
  [5, 0, 7, 0, 3, 0, 0],
  [3, 4, 5, 2, 5, 3, 0],
  [0, 5, 6, 4, 2, 0, 0],
  [1, 7, 0, 7, 4, 5, 2],
  [4, 0, 3, 0, 2, 0, 0],
]

function buildAnim(): Actor[] {
  const out: Actor[] = []
  curTag = 'state'
  const statics: [string, number][] = [
    ['Idle 숨쉬기', Anim.Idle],
    ['Listen 갸웃', Anim.Listen],
    ['Cheer 환호', Anim.Cheer],
    ['Stun 얼음', Anim.Stun],
  ]
  statics.forEach(([name, anim], i) => {
    out.push(actor(name, (i - 2.5) * 1.8, 0, DEMO_LOOKS[i % DEMO_LOOKS.length]!, { anim, isNpc: i === 1 }))
  })
  // Vanish: 1.6초마다 사라졌다 나타난다
  out.push(
    actor('Vanish 사라짐', (4 - 2.5) * 1.8, 0, DEMO_LOOKS[4]!, { isNpc: true }, (t, v) => {
      v.anim = t % 3.2 < 1.6 ? Anim.Vanish : Anim.Idle
    }),
  )
  out.push(actor('고양이 Listen', (5 - 2.5) * 1.8, 0, [0, 0, 2, 0, 0, 0, 0], { model: 1, anim: Anim.Listen, isNpc: true, phase: 0.2 }))
  EMOTES.forEach((e, i) => {
    const col = i % 7
    const row = Math.floor(i / 7)
    curTag = row === 0 ? 'emoteA' : 'emoteB'
    const look: Look = e.id === 'preach' ? [0, 2, 0, 0, 0, 4, 0] : DEMO_LOOKS[(i + 2) % DEMO_LOOKS.length]!
    out.push(
      actor(`${e.icon} ${e.id} ${e.name}`, (col - 3) * 1.9, 2.4 + row * 2.6, look, {}, (t, v) => {
        if (e.loop) {
          v.emote = e.id
          v.emoteT = t
        } else {
          // 1회성: 끝나고 0.7초 쉬었다가 다시
          const len = e.ms / 1000
          const u = t % (len + 0.7)
          v.emote = u < len ? e.id : null
          v.emoteT = u
        }
      }),
    )
  })
  curTag = 'lane'
  const lanes: [string, number, number, number, number][] = [
    ['Walk NPC 1.5m/s', 1.5, Anim.Walk, 0, 1],
    ['Walk 3.4m/s', 3.4, Anim.Walk, 0, 0],
    ['Run 5.6m/s', 5.6, Anim.Run, 0, 0],
    ['Sprint 8.4m/s', 8.4, Anim.Sprint, 0, 0],
    ['고양이 Walk 1.3m/s', 1.3, Anim.Walk, 1, 1],
    ['고양이 Sprint 7m/s', 7, Anim.Sprint, 1, 1],
  ]
  lanes.forEach(([name, speed, anim, model, npc], i) => {
    const z = -2.2 - i * 1.5
    const look: Look = model === 1 ? [0, 0, i === 4 ? 1 : 2, 0, 0, 0, 0] : DEMO_LOOKS[(i * 3 + 1) % DEMO_LOOKS.length]!
    out.push(actor(name, 0, z, look, { model, isNpc: npc === 1 }, lane(12, speed, -6, z, anim)))
  })
  // 로브: 걸을 때 발끝이 보이는지
  out.push(actor('도복 Walk 3.4m/s', 0, -11.2, [1, 6, 0, 4, 6, 0, 0], {}, lane(12, 3.4, -6, -11.2, Anim.Walk)))
  return out
}

function buildGame(): Actor[] {
  const out: Actor[] = []
  curTag = 'game'
  const rnd = lcg(11)
  // 가운데: 포교 중인 플레이어(전단지)와 고개를 갸웃하는 시민
  out.push(actor('나(전도사)', -0.9, 0.3, [0, 2, 0, 0, 1, 1, 0], { yaw: Math.PI / 2, emote: 'flyer' }, (t, v) => void (v.emoteT = t)))
  out.push(actor('시민(대상)', 0.9, 0.3, [2, 1, 2, 1, 0, 3, 0], { yaw: -Math.PI / 2, anim: Anim.Listen, isNpc: true, highlight: true }))
  // 신도를 줄줄이 달고 걷는 교주
  const leaderLook: Look = [1, 7, 0, 7, 4, 5, 2]
  for (let i = 0; i < 4; i++) {
    const look: Look = i === 0 ? leaderLook : [i % 6, i % 2, 3 + i * 2, i === 2 ? 2 : 0, i, i === 1 ? 3 : 0, 0]
    out.push(
      actor(i === 0 ? '교주' : `신도${i}`, 0, 0, look, { isNpc: i > 0, ring: i > 0 ? 0x6a55d8 : -1 }, (t, v) => {
        const a = t * (3.4 / 4.2) - i * 0.27
        v.x = Math.cos(a) * 4.2
        v.z = -1.5 + Math.sin(a) * 4.2
        v.yaw = Math.atan2(-Math.sin(a), Math.cos(a))
        v.anim = Anim.Walk
      }),
    )
  }
  // 여기저기 서 있거나 걷는 시민들
  for (let i = 0; i < 9; i++) {
    const look: Look = [Math.floor(rnd() * 6), [0, 1, 0, 4, 5, 2][Math.floor(rnd() * 6)]!, Math.floor(rnd() * 12), [0, 0, 1, 2, 0][Math.floor(rnd() * 5)]!, Math.floor(rnd() * 6), [0, 0, 3][Math.floor(rnd() * 3)]!, 0]
    const x = (rnd() - 0.5) * 12
    const z = (rnd() - 0.5) * 9 - 1
    const yaw = rnd() * 6.28
    const walk = i % 3 === 0
    out.push(
      actor('', x, z, look, { yaw, isNpc: true }, walk ? lane(5, 1.5, x - 2.5, z, Anim.Walk) : undefined),
    )
  }
  out.push(actor('기도', -3.4, 2.4, [3, 3, 9, 4, 6, 2, 1], { yaw: 0.4, emote: 'pray' }, (t, v) => void (v.emoteT = t)))
  out.push(actor('설교', 3.3, 2.2, [0, 8, 2, 9, 3, 0, 3], { yaw: -0.5, emote: 'preach' }, (t, v) => void (v.emoteT = t)))
  out.push(actor('', -4.6, -0.6, [0, 0, 2, 0, 0, 0, 0], { model: 1, isNpc: true, yaw: 1 }))
  out.push(actor('', 2.2, -3.4, [0, 0, 1, 0, 0, 0, 0], { model: 1, isNpc: true }, lane(4, 1.3, 0.5, -3.4, Anim.Walk)))
  out.push(actor('얼음', 4.8, -1.2, [2, 4, 4, 1, 5, 3, 0], { yaw: -0.8, anim: Anim.Stun }))
  return out
}

function buildFxStage(): Actor[] {
  curTag = 'fx'
  return [actor('', 0, 0, [0, 2, 0, 0, 0, 1, 0], { yaw: 0.3 })]
}

function buildStress(n: number): Actor[] {
  const out: Actor[] = []
  curTag = 'stress'
  const rnd = lcg(2024)
  for (let i = 0; i < n; i++) {
    const cat = i % 17 === 5
    const look: Look = [
      Math.floor(rnd() * 6),
      Math.floor(rnd() * 10),
      Math.floor(rnd() * 12),
      Math.floor(rnd() * 11),
      Math.floor(rnd() * 7),
      Math.floor(rnd() * 6),
      rnd() < 0.3 ? Math.floor(rnd() * 5) : 0,
    ]
    const radius = 2 + rnd() * 13
    const speed = cat ? 1.3 : [1.5, 1.5, 3.4, 3.4, 5.6][Math.floor(rnd() * 5)]!
    const dir = rnd() < 0.5 ? 1 : -1
    const off = rnd() * 6.283
    const isNpc = i >= 20
    out.push(
      actor('', 0, 0, look, { model: cat ? 1 : 0, isNpc, ring: i % 6 === 0 ? OUTFIT_COLORS[i % 12]! : -1, highlight: i === 33 }, (t, v) => {
        const a = off + (dir * t * speed) / radius
        v.x = Math.cos(a) * radius
        v.z = Math.sin(a) * radius
        v.yaw = Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir)
        v.anim = speed > 4 ? Anim.Run : Anim.Walk
      }),
    )
  }
  return out
}

// ───────── 뷰 전환 ─────────
type ViewName = 'catalog' | 'anim' | 'game' | 'fx' | 'stress'
let actors: Actor[] = []
let visuals: CharVisual[] = []
let viewName: ViewName = 'catalog'
const camTarget = new THREE.Vector3()

function setCam(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov?: number): void {
  camera.position.set(x, y, z)
  camTarget.set(tx, ty, tz)
  camera.lookAt(camTarget)
  if (fov) {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }
}

function setView(name: ViewName, n = 70): void {
  viewName = name
  followed = null
  nextKey = 1
  for (const a of actors) a.el?.remove()
  camera.fov = 55
  camera.updateProjectionMatrix()
  if (name === 'catalog') {
    actors = buildCatalog()
    setCam(0, 10.5, 9.5, 0, 0.6, -3.8, 50)
  } else if (name === 'anim') {
    actors = buildAnim()
    setCam(0, 8.5, 14.5, 0, 0.6, -1.5, 50)
  } else if (name === 'game') {
    actors = buildGame()
    // 게임 기본 시점: 10m 거리, 32° 내려다봄, FOV 55
    const d = 10
    const pitch = (32 * Math.PI) / 180
    setCam(0, 0.9 + d * Math.sin(pitch), d * Math.cos(pitch), 0, 0.9, 0, 55)
  } else if (name === 'fx') {
    actors = buildFxStage()
    setCam(0, 3.0, 5.2, 0, 1.45, 0, 50)
  } else {
    actors = buildStress(n)
    setCam(0, 20, 23, 0, 0, 0, 55)
  }
  for (const a of actors) {
    if (!a.label) continue
    const el = document.createElement('div')
    el.className = 'lbl'
    el.textContent = a.label
    labelRoot.appendChild(el)
    a.el = el
  }
  setSection(null)
}

/** 한 구획(tag)만 그린다. null 이면 전부 */
let section: string | null = null
function setSection(tag: string | null): void {
  section = tag
  visuals = actors.filter((a) => !tag || a.tag === tag).map((a) => a.v)
}
/** 이름표에 text 가 들어간 배우만 그린다(한 명만 떼어 볼 때) */
function only(text: string): void {
  section = null
  visuals = actors.filter((a) => a.label.includes(text)).map((a) => a.v)
}

function stepActors(t: number): void {
  for (const a of actors) a.step?.(t, a.v)
  if (followed) {
    // 따라가기: 대상의 진행 방향 기준 오프셋(옆 dx, 위 dy, 앞 dz)에서 바라본다
    const v = followed.v
    const s = Math.sin(v.yaw)
    const c = Math.cos(v.yaw)
    camTarget.set(v.x, v.y + followOff.ty, v.z)
    camera.position.set(v.x + c * followOff.dx + s * followOff.dz, v.y + followOff.dy, v.z - s * followOff.dx + c * followOff.dz)
    camera.lookAt(camTarget)
  }
}

let followed: Actor | null = null
const followOff = { dx: 0, dy: 1, dz: 4, ty: 0.8 }
/** 이름표에 text 가 들어간 배우를 카메라가 따라간다(걸음 확인용). 빈 문자열이면 해제 */
function follow(text: string, dx = 4, dy = 1.2, dz = 0, ty = 0.75): void {
  followed = text ? (actors.find((a) => a.label.includes(text)) ?? null) : null
  followOff.dx = dx
  followOff.dy = dy
  followOff.dz = dz
  followOff.ty = ty
}

// ───────── 시계 / 프레임 루프 ─────────
let clock = 0
let frozen = false
let fxFrozen = false
let last = performance.now()
const frameMs: number[] = []
const updateMs: number[] = []
const renderMs: number[] = []
const proj = { x: 0, y: 0 }

function avg(a: number[]): number {
  if (a.length === 0) return 0
  let s = 0
  for (const x of a) s += x
  return s / a.length
}
function pushSample(a: number[], x: number): void {
  a.push(x)
  if (a.length > 90) a.shift()
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  const raw = (now - last) / 1000
  last = now
  pushSample(frameMs, raw * 1000)
  const dt = Math.min(0.1, raw)
  const t0 = performance.now()
  if (!frozen) {
    clock += dt
    stepActors(clock)
    chars.update(dt, clock, visuals)
  } else {
    // 멈춘 동안에도 카메라를 돌려 볼 수 있게 dt=0 으로 다시 채운다(애니메이션 상태는 변하지 않는다)
    chars.update(0, clock, visuals)
  }
  if (!fxFrozen) fx.update(frozen ? 0 : dt, clock)
  const t1 = performance.now()
  engine.render()
  // 드로콜은 방금 그린 프레임 기준
  const calls = renderer.info.render.calls
  const tris = renderer.info.render.triangles
  const t2 = performance.now()
  pushSample(updateMs, t1 - t0)
  pushSample(renderMs, t2 - t1)

  for (const a of actors) {
    if (!a.el) continue
    const ok = (!section || a.tag === section) && engine.project(a.v.x, a.v.y - 0.08, a.v.z, proj)
    a.el.style.display = ok ? '' : 'none'
    if (ok) a.el.style.transform = `translate(-50%, 2px) translate(${proj.x.toFixed(1)}px, ${proj.y.toFixed(1)}px)`
  }
  const f = avg(frameMs)
  statsEl.textContent =
    `${viewName}  ${actors.length}명  품질 ${quality}${frozen ? '  [정지 ' + clock.toFixed(2) + 's]' : ''}\n` +
    `프레임 ${f.toFixed(1)}ms (${(1000 / Math.max(0.01, f)).toFixed(0)}fps)\n` +
    `update ${avg(updateMs).toFixed(2)}ms  render ${avg(renderMs).toFixed(2)}ms\n` +
    `드로콜 ${calls}  삼각형 ${tris}`
  lastCalls = calls
  lastTris = tris
}
let lastCalls = 0
let lastTris = 0

/**
 * 시각 t 에 고정. 렌더러를 새로 만들고 시각 0(아주 큰 t 는 t-30)부터 1/60초 간격으로 다시 돌린다.
 * 걸음 위상은 "지금까지 걸은 거리"로 정해지므로, 항상 같은 출발점에서 돌려야 같은 t 가 같은 그림이 된다.
 */
function freeze(t: number): void {
  chars.dispose()
  chars = createCharacterRenderer(engine)
  const step = 1 / 60
  const origin = t > 30 ? Math.floor(t - 30) : 0
  const n = Math.max(1, Math.round((t - origin) / step))
  for (let k = n; k >= 0; k--) {
    const tt = t - k * step
    stepActors(tt)
    chars.update(step, tt, visuals)
  }
  clock = t
  frozen = true
}

/**
 * 연속 장면 한 장으로 보기: 주어진 시각들에서 각각 멈춰 그린 화면을 격자로 이어 붙여 화면 위에 덮는다.
 * 걸음 주기나 이모트의 여러 순간을 스크린샷 한 장으로 비교할 때 쓴다.
 */
function sheet(times: number[], cols = 4): void {
  sheetOff()
  const w = canvas.width
  const h = canvas.height
  const rows = Math.ceil(times.length / cols)
  const out = document.createElement('canvas')
  out.id = 'sheet'
  out.width = w
  out.height = h
  out.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:10'
  const ctx = out.getContext('2d')
  if (!ctx) return
  const cw = w / cols
  const ch = h / rows
  // 칸과 같은 비율로 화면 가운데를 잘라 넣는다
  let sw = w
  let sh = h
  if (w / h > cw / ch) sw = (h * cw) / ch
  else sh = (w * ch) / cw
  ctx.font = `${Math.round(h / 40)}px ui-monospace, monospace`
  times.forEach((t, i) => {
    freeze(t)
    engine.render()
    const x = (i % cols) * cw
    const y = Math.floor(i / cols) * ch
    ctx.drawImage(canvas, (w - sw) / 2, (h - sh) / 2, sw, sh, x, y, cw, ch)
    ctx.fillStyle = 'rgba(42,36,51,0.8)'
    ctx.fillText(`t=${t.toFixed(2)}`, x + 6, y + h / 32)
    ctx.strokeStyle = 'rgba(42,36,51,0.5)'
    ctx.strokeRect(x, y, cw, ch)
  })
  document.body.appendChild(out)
}
function sheetOff(): void {
  document.getElementById('sheet')?.remove()
}

function fxSpot(): THREE.Vector3 {
  return new THREE.Vector3(camTarget.x, 0, camTarget.z)
}

const FX_KINDS: FxKind[] = ['join', 'fail', 'flee', 'rank', 'prophecy', 'coin', 'poof', 'cheer', 'alert']

function fireFx(kind: FxKind, color?: number): void {
  const p = fxSpot()
  fx.burst(kind, p.x, 0, p.z, color)
}

/** 이펙트를 터뜨린 뒤 t 초 지난 순간에서 멈춘다(스크린샷용, 결정적) */
function fxAt(kind: FxKind, t: number, color?: number): void {
  fx.dispose()
  fx = createFx(engine)
  const p = fxSpot()
  fx.burst(kind, p.x, 0, p.z, color)
  const step = 1 / 60
  for (let e = 0; e < t; e += step) fx.update(step, e)
  fxFrozen = true
}

// ───────── 도구 막대 ─────────
function button(text: string, cls: string, fn: () => void): void {
  const b = document.createElement('button')
  b.textContent = text
  if (cls) b.className = cls
  b.addEventListener('click', fn)
  bar.appendChild(b)
}
button('카탈로그', '', () => setView('catalog'))
button('애니메이션', '', () => setView('anim'))
button('게임 시점', '', () => setView('game'))
button('이펙트', '', () => setView('fx'))
button('70명', '', () => setView('stress', 70))
button('품질', '', () => engine.setQuality(quality === 'high' ? 'mid' : quality === 'mid' ? 'low' : 'high'))
button('정지/재생', '', () => {
  if (frozen) {
    frozen = false
    fxFrozen = false
  } else freeze(clock)
})
{
  const sep = document.createElement('span')
  sep.className = 'sep'
  bar.appendChild(sep)
}
for (const k of FX_KINDS) button(k, 'fx', () => fireFx(k))

// ───────── 마우스로 둘러보기(드래그 회전, 휠 줌) ─────────
{
  let drag = false
  let px = 0
  let py = 0
  canvas.addEventListener('pointerdown', (e) => {
    drag = true
    px = e.clientX
    py = e.clientY
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointerup', () => (drag = false))
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return
    const off = camera.position.clone().sub(camTarget)
    const sph = new THREE.Spherical().setFromVector3(off)
    sph.theta -= (e.clientX - px) * 0.006
    sph.phi = Math.min(Math.PI / 2 - 0.02, Math.max(0.1, sph.phi - (e.clientY - py) * 0.005))
    px = e.clientX
    py = e.clientY
    camera.position.copy(camTarget).add(off.setFromSpherical(sph))
    camera.lookAt(camTarget)
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      const off = camera.position.clone().sub(camTarget)
      off.multiplyScalar(Math.exp(e.deltaY * 0.001))
      camera.position.copy(camTarget).add(off)
    },
    { passive: true },
  )
}

// ───────── 자동화/콘솔용 API ─────────
const dev = {
  setCam,
  /** 방금 그린 프레임의 renderer.info.render */
  info: () => ({ ...renderer.info.render, calls: lastCalls, triangles: lastTris }),
  stats: () => ({
    view: viewName,
    actors: actors.length,
    quality,
    frameMs: +avg(frameMs).toFixed(2),
    updateMs: +avg(updateMs).toFixed(3),
    renderMs: +avg(renderMs).toFixed(2),
    calls: lastCalls,
    triangles: lastTris,
  }),
  /** 초상을 만들어 화면 왼쪽 아래에 붙인다 */
  portrait(look: Look, size = 160, emote?: string): string {
    const c = chars.portrait(look, size, emote)
    portraitRoot.appendChild(c)
    return `${c.width}x${c.height}`
  },
  clearPortraits(): void {
    portraitRoot.textContent = ''
  },
  freeze,
  unfreeze(): void {
    frozen = false
    fxFrozen = false
  },
  fx: fireFx,
  fxAt,
  view: setView,
  section: setSection,
  only,
  follow,
  sheet,
  sheetOff,
  quality: (q: QualityTier) => engine.setQuality(q),
  /** 엔진이 어떤 안개를 쓰든 셰이더가 도는지 확인용 */
  fog(kind: 'linear' | 'exp2' | 'none'): void {
    scene.fog = kind === 'linear' ? new THREE.Fog(0xd9cbe8, 45, 160) : kind === 'exp2' ? new THREE.FogExp2(0xd9cbe8, 0.012) : null
  },
  /** 자동화 스크립트가 같은 모듈 인스턴스로 렌더러를 직접 만들어 시험할 수 있게 내보낸다 */
  THREE,
  createCharacterRenderer,
  createFx,
  labels(on: boolean): void {
    labelRoot.style.display = on ? '' : 'none'
  },
  ui(on: boolean): void {
    bar.style.display = on ? '' : 'none'
    statsEl.style.display = on ? '' : 'none'
  },
}
;(window as unknown as { __dev: typeof dev }).__dev = dev

// ───────── 시작 ─────────
const stress = Number(params.get('stress'))
const viewParam = params.get('view')
if (stress > 0) setView('stress', Math.min(400, Math.floor(stress)))
else if (viewParam === 'anim' || viewParam === 'game' || viewParam === 'fx' || viewParam === 'catalog') setView(viewParam)
else setView('catalog')
requestAnimationFrame((now) => {
  last = now
  frame(now)
})
