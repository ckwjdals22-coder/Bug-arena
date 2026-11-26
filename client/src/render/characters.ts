/**
 * 캐릭터 렌더러: 큰 머리 2등신 캐릭터(와 길고양이)를 부위별 InstancedMesh 풀로 그린다.
 *
 *  - 드로콜(캐릭터 수와 무관): 머리 1 · 팔 1 · 다리 1 · 얼굴 2 · 소품 1 · 고양이 1 · 스프라이트 1
 *    + 몸통은 화면에 있는 종류만큼(최대 9) + 모자도 화면에 있는 종류만큼(최대 10 + 반투명 2) = 최대 29, 보통 15 안팎.
 *    풀 하나가 여러 변형(머리 모양, 소매 종류 …)을 담고 인스턴스가 고른 변형만 그린다(chars/pools.ts).
 *  - 애니메이션: 뼈대 없이 포즈 숫자(chars/pose.ts)에서 부위 행렬을 직접 계산한다.
 *    상태/이모트가 바뀌면 약 150ms 동안 이전 포즈에서 섞는다.
 *  - 걸음: 프레임 사이의 실제 이동 거리로 걸음 주기를 굴려서 발이 미끄러져 보이지 않게 한다.
 *  - 컬링/LOD: 캐릭터 단위로 절두체 검사, 멀면 얼굴·소품·오라 생략.
 */
import * as THREE from 'three'
import { Anim } from '../../../shared/constants'
import { EMOTE_BY_ID } from '../../../shared/content/core'
import type { Look } from '../../../shared/types'
import { NpcModel } from '../../../shared/types'
import type { CharVisual, CharacterRendererApi, EngineApi } from '../core/contracts'
import { lin } from './chars/geo'
import type { RGB } from './chars/geo'
import { ACC, CAT, DIM, FACE, FACEFIT, TORSO, buildAcc, buildArm, buildCat, buildFaceFit, buildFaceUnit, buildHat, buildHatTranslucent, buildHead, buildLeg, buildTorso } from './chars/parts'
import type { Detail } from './chars/parts'
import { PartPool, SplitPool, makePartMaterial, sharedUniforms } from './chars/pools'
import type { Pool } from './chars/pools'
import { EYES, MOUTH, P, POSE_N, computePose, wrapPi } from './chars/pose'
import type { Expr } from './chars/pose'
import { CELL, MODE, SpriteBatch } from './chars/sprites'
import { C_EYE, C_MOUTH, C_MOUTH_IN, C_WHITE, HAT_TOP, resolveStyle } from './chars/style'
import type { Style } from './chars/style'

const PI = Math.PI
const TAU = PI * 2

/** 이보다 멀면 얼굴·소품·오라를 생략한다 */
const LOD_FAR = 28
/** 이보다 가까울 때만 눈 하이라이트·볼터치 같은 잔 디테일을 그린다 */
const LOD_NEAR = 15
/** 상태 전환 시 포즈를 섞는 시간(초) */
const BLEND_SEC = 0.15
/** 이 시간(초) 동안 안 보인 캐릭터의 상태는 버린다 */
const FORGET_SEC = 4
/** 한 프레임에 이보다 멀리 움직이면 순간이동으로 본다(걸음 계산에서 제외) */
const TELEPORT_M = 3
const POOL_CAP = 96

interface Geos {
  head: THREE.BufferGeometry
  torso: THREE.BufferGeometry
  arm: THREE.BufferGeometry
  leg: THREE.BufferGeometry
  face: THREE.BufferGeometry
  faceFit: THREE.BufferGeometry
  hat: THREE.BufferGeometry
  hatT: THREE.BufferGeometry
  acc: THREE.BufferGeometry
  cat: THREE.BufferGeometry
}

function buildGeos(d: Detail): Geos {
  return {
    head: buildHead(d),
    torso: buildTorso(d),
    arm: buildArm(d),
    leg: buildLeg(d),
    face: buildFaceUnit(d),
    faceFit: buildFaceFit(d),
    hat: buildHat(d),
    hatT: buildHatTranslucent(d),
    acc: buildAcc(d),
    cat: buildCat(d),
  }
}

function disposeGeos(g: Geos): void {
  for (const k of Object.keys(g) as (keyof Geos)[]) g[k].dispose()
}

/** 한 씬에 붙는 풀 묶음. 본 게임용과 초상용을 따로 만든다 */
class Rig {
  readonly head: Pool
  readonly torso: Pool
  readonly arm: Pool
  readonly leg: Pool
  readonly face: Pool
  readonly faceFit: Pool
  readonly hat: Pool
  readonly hatT: Pool
  readonly acc: Pool
  readonly cat: Pool
  readonly sprites: SpriteBatch
  private readonly pools: Pool[]

  constructor(parent: THREE.Object3D, g: Geos, opaque: THREE.Material, translucent: THREE.Material, cap: number, portrait: boolean) {
    // 거의 모든 캐릭터가 쓰는 부위: 드로콜 하나에 변형을 모은다
    this.head = new PartPool(parent, g.head, opaque, cap)
    this.arm = new PartPool(parent, g.arm, opaque, cap * 2)
    this.leg = new PartPool(parent, g.leg, opaque, cap * 2)
    this.face = new PartPool(parent, g.face, opaque, cap * 8)
    this.faceFit = new PartPool(parent, g.faceFit, opaque, Math.max(4, cap >> 2))
    this.acc = new PartPool(parent, g.acc, opaque, Math.max(4, cap >> 1))
    this.cat = new PartPool(parent, g.cat, opaque, Math.max(7, cap >> 2))
    // 종류가 많고 큼직한 부위: 종류별 드로콜(버려지는 정점이 없다).
    // 한 종류에 모두 몰려도 다시 할당하지 않게 종류마다 cap 만큼 잡는다(인스턴스 버퍼는 작아서 부담이 없다)
    this.torso = new SplitPool(parent, g.torso, opaque, cap)
    this.hat = new SplitPool(parent, g.hat, opaque, cap)
    // 반투명(갓, 광선)은 불투명 부위 뒤에, 스프라이트보다는 먼저 그린다
    this.hatT = new SplitPool(parent, g.hatT, translucent, cap, 1)
    this.pools = [this.head, this.torso, this.arm, this.leg, this.face, this.faceFit, this.hat, this.hatT, this.acc, this.cat]
    this.sprites = new SpriteBatch(parent, cap * 8, { noAdditive: portrait, renderOrder: 2 })
  }

  setGeos(g: Geos): void {
    this.head.setGeometry(g.head)
    this.torso.setGeometry(g.torso)
    this.arm.setGeometry(g.arm)
    this.leg.setGeometry(g.leg)
    this.face.setGeometry(g.face)
    this.faceFit.setGeometry(g.faceFit)
    this.hat.setGeometry(g.hat)
    this.hatT.setGeometry(g.hatT)
    this.acc.setGeometry(g.acc)
    this.cat.setGeometry(g.cat)
  }

  begin(): void {
    for (const p of this.pools) p.begin()
    this.sprites.begin()
  }

  end(): void {
    for (const p of this.pools) p.end()
    this.sprites.end()
  }

  dispose(): void {
    for (const p of this.pools) p.dispose()
    this.sprites.dispose()
  }
}

/** 캐릭터(key)별로 프레임 사이에 기억하는 것 */
interface CharState {
  seen: number
  x: number
  z: number
  speed: number
  gait: number
  anim: number
  emote: string | null
  from: Float32Array
  cur: Float32Array
  /** 섞기 진행도. 1 이상이면 끝 */
  blend: number
  /** 사라짐 정도 0(다 보임)..1(안 보임) */
  vanish: number
  /** 고양이: 앉은 정도 0..1 */
  sit: number
  look: Look | null
  isNpc: boolean
  style: Style | null
}

function sameLook(a: Look | null, b: Look): boolean {
  if (!a) return false
  for (let i = 0; i < 7; i++) if (a[i] !== b[i]) return false
  return true
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}
function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** 0..1 결정적 난수(반짝이 위치 등 — 프레임마다 같은 값이 나와야 한다) */
function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

// ───── 프레임 중 재사용하는 임시 객체(할당을 피한다) ─────
const _e = new THREE.Euler()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const mRoot = new THREE.Matrix4()
const mBody = new THREE.Matrix4()
const mHead = new THREE.Matrix4()
const mArmL = new THREE.Matrix4()
const mArmR = new THREE.Matrix4()
const mLeg = new THREE.Matrix4()
const mTmp = new THREE.Matrix4()
const mTmp2 = new THREE.Matrix4()
const vA = new THREE.Vector3()
const vB = new THREE.Vector3()
const tgt = new Float32Array(POSE_N)
const expr: Expr = { eyes: 0, mouth: 0, talk: 1, brow: 0 }
const TINT_NONE: RGB = [1, 1, 1]
/** 얼어붙었을 때 온몸에 곱하는 푸르스름한 색 */
const TINT_FROZEN: RGB = [0.76, 0.9, 1.22]

/** out = parent × (이동 · 회전 · 크기) */
function local(
  out: THREE.Matrix4,
  parent: THREE.Matrix4,
  px: number,
  py: number,
  pz: number,
  rx: number,
  ry: number,
  rz: number,
  order: THREE.EulerOrder = 'XYZ',
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.Matrix4 {
  _e.set(rx, ry, rz, order)
  _q.setFromEuler(_e)
  _p.set(px, py, pz)
  _s.set(sx, sy, sz)
  _m.compose(_p, _q, _s)
  return out.multiplyMatrices(parent, _m)
}

/** 그리기에 필요한 그 프레임의 공통 정보 */
interface Frame {
  rig: Rig
  time: number
  camX: number
  camY: number
  camZ: number
  /** 오라를 그릴지(품질 low 면 생략) */
  auras: boolean
  /** 초상: 그림자·고리·강조 표시를 그리지 않는다 */
  portrait: boolean
}

const { HEAD_RX, HEAD_RY, HEAD_RZ } = DIM

/**
 * 얼굴 곡면(타원체) 위의 한 점에 단위 도형을 얹는다.
 * @param lift 표면에서 띄우는 거리(겹치는 부품끼리 깊이 싸움이 나지 않게 층을 나눈다)
 */
function feature(f: Frame, x: number, y: number, sx: number, sy: number, rot: number, variant: number, color: RGB, lift: number, tint: RGB): void {
  const zz = 1 - (x * x) / (HEAD_RX * HEAD_RX) - (y * y) / (HEAD_RY * HEAD_RY)
  const z = HEAD_RZ * Math.sqrt(zz > 0.02 ? zz : 0.02)
  // 타원체 법선
  let nx = x / (HEAD_RX * HEAD_RX)
  let ny = y / (HEAD_RY * HEAD_RY)
  let nz = z / (HEAD_RZ * HEAD_RZ)
  const nl = 1 / Math.hypot(nx, ny, nz)
  nx *= nl
  ny *= nl
  nz *= nl
  // 접선 기저: X = up × n, Y = n × X
  let tx = nz
  let tz = -nx
  const tl = 1 / Math.hypot(tx, tz)
  tx *= tl
  tz *= tl
  const ux = ny * tz
  const uy = nz * tx - nx * tz
  const uz = -ny * tx
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const ax = (tx * c + ux * s) * sx
  const ay = uy * s * sx
  const az = (tz * c + uz * s) * sx
  const bx = (-tx * s + ux * c) * sy
  const by = uy * c * sy
  const bz = (-tz * s + uz * c) * sy
  mTmp.set(ax, bx, nx, x + nx * lift, ay, by, ny, y + ny * lift, az, bz, nz, z + nz * lift, 0, 0, 0, 1)
  mTmp2.multiplyMatrices(mHead, mTmp)
  f.rig.face.add(mTmp2, color, null, variant, tint)
}

const EYE_X = 0.135
const EYE_Y = -0.035
const MOUTH_Y = -0.158

function emitFace(f: Frame, st: Style, ex: Expr, blink: boolean, near: boolean, tint: RGB): void {
  const face = st.face
  const shades = face === 4

  // ── 눈 ──
  let eyes = ex.eyes
  if (eyes === EYES.Face) {
    if (face === 1) eyes = EYES.Sly
    else if (face === 6) eyes = EYES.Happy
  }
  if (!shades) {
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1
      const x = s * EYE_X
      switch (eyes) {
        case EYES.Happy:
          feature(f, x, EYE_Y, 0.056, 0.05, 0, FACE.Arc, C_EYE, 0.006, tint)
          break
        case EYES.Sly:
          // 초승달 눈웃음: 바깥쪽이 살짝 처진다
          feature(f, x, EYE_Y + 0.004, 0.062, 0.052, s * -0.12, FACE.Arc, C_EYE, 0.006, tint)
          break
        case EYES.Closed:
          feature(f, x, EYE_Y - 0.012, 0.052, 0.036, PI, FACE.Arc, C_EYE, 0.006, tint)
          break
        case EYES.Wide:
          feature(f, x, EYE_Y, 0.064, 0.074, 0, FACE.Dot, C_EYE, 0.005, tint)
          feature(f, x, EYE_Y, 0.052, 0.062, 0, FACE.Dot, C_WHITE, 0.009, tint)
          feature(f, x, EYE_Y, 0.02, 0.022, 0, FACE.Dot, C_EYE, 0.013, tint)
          break
        case EYES.Blank:
          feature(f, x, EYE_Y, 0.06, 0.068, 0, FACE.Dot, C_EYE, 0.005, tint)
          feature(f, x, EYE_Y, 0.049, 0.057, 0, FACE.Dot, C_WHITE, 0.009, tint)
          break
        case EYES.Dizzy:
          feature(f, x, EYE_Y, 0.058, 0.02, PI / 4, FACE.Bar, C_EYE, 0.006, tint)
          feature(f, x, EYE_Y, 0.058, 0.02, -PI / 4, FACE.Bar, C_EYE, 0.008, tint)
          break
        default: {
          if (face === 2) {
            // 졸린 눈: 위가 잘린 반달
            feature(f, x, EYE_Y - 0.002, 0.052, blink ? 0.01 : 0.058, 0, FACE.Half, C_EYE, 0.006, tint)
          } else {
            const big = face === 3
            const rx = big ? 0.056 : 0.044
            const ry = big ? 0.07 : 0.057
            feature(f, x, EYE_Y, rx, blink ? ry * 0.12 : ry, 0, FACE.Dot, C_EYE, 0.006, tint)
            if (near && !blink) {
              feature(f, x + 0.014, EYE_Y + 0.022, big ? 0.02 : 0.014, big ? 0.022 : 0.015, 0, FACE.Dot, C_WHITE, 0.01, tint)
              if (big) feature(f, x - 0.016, EYE_Y - 0.026, 0.01, 0.011, 0, FACE.Dot, C_WHITE, 0.01, tint)
            }
          }
        }
      }
    }
  } else {
    f.rig.faceFit.add(mHead, null, null, FACEFIT.Glasses, tint)
  }

  // ── 눈썹 ──
  const browFace = face === 5 || face === 6
  if ((ex.brow !== 0 || browFace || eyes === EYES.Sly) && !shades) {
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 1 : -1
      if (face === 6) {
        // 도사: 길게 늘어진 흰 눈썹
        feature(f, s * 0.15, EYE_Y + 0.085, 0.07, 0.022, s * (-0.38 + 0.2 * ex.brow), FACE.Bar, st.facial, 0.012, tint)
      } else if (face === 5) {
        feature(f, s * EYE_X, EYE_Y + 0.088, 0.058, 0.02, s * (-0.1 + 0.3 * ex.brow), FACE.Bar, st.facial, 0.008, tint)
      } else if (eyes === EYES.Sly) {
        feature(f, s * EYE_X, EYE_Y + 0.085, 0.045, 0.011, s * 0.3, FACE.Bar, C_EYE, 0.008, tint)
      } else {
        feature(f, s * EYE_X, EYE_Y + 0.092, 0.045, 0.012, s * 0.34 * ex.brow, FACE.Bar, C_EYE, 0.008, tint)
      }
    }
  }

  // ── 볼터치 ──
  if (near) {
    const strong = face === 3 ? 1.25 : 1
    feature(f, 0.225, -0.115, 0.05 * strong, 0.03 * strong, 0, FACE.Dot, st.blush, 0.004, tint)
    feature(f, -0.225, -0.115, 0.05 * strong, 0.03 * strong, 0, FACE.Dot, st.blush, 0.004, tint)
  }

  // ── 수염 ──
  if (face === 5 || face === 6) f.rig.faceFit.add(mHead, st.facial, null, FACEFIT.Moustache, tint)
  if (face === 6) f.rig.faceFit.add(mHead, st.facial, null, FACEFIT.Beard, tint)

  // ── 입 ──
  let mouth = ex.mouth
  if (mouth === MOUTH.Face) {
    if (face === 1) mouth = MOUTH.Sly
    else if (face === 2) mouth = MOUTH.Flat
    else if (face === 3) mouth = MOUTH.Open
    else if (face === 4) mouth = MOUTH.Sly
    else if (face === 5 || face === 6) mouth = -1
    else mouth = MOUTH.Smile
  }
  // 수염에 가려지는 얼굴은 입을 조금 아래에 그린다
  const my = face === 5 || face === 6 ? MOUTH_Y - 0.045 : MOUTH_Y
  switch (mouth) {
    case MOUTH.Smile:
      if (face !== 5 && face !== 6) feature(f, 0, my, 0.052, 0.036, PI, FACE.Arc, C_MOUTH, 0.006, tint)
      break
    case MOUTH.Open: {
      const small = ex.mouth === MOUTH.Face
      const w = small ? 0.036 : 0.056
      const h = (small ? 0.03 : 0.05) * (0.35 + 0.65 * ex.talk)
      feature(f, 0, my + 0.012, w, h, 0, FACE.Half, C_MOUTH_IN, 0.007, tint)
      break
    }
    case MOUTH.O:
      feature(f, 0, my - 0.004, 0.024, 0.032, 0, FACE.Dot, C_MOUTH_IN, 0.007, tint)
      break
    case MOUTH.Sly:
      // 한쪽 입꼬리만 올라간 미소
      feature(f, 0.024, my + 0.004, 0.066, 0.038, PI + 0.26, FACE.Arc, C_MOUTH, 0.006, tint)
      break
    case MOUTH.Flat:
      feature(f, 0, my, 0.03, 0.011, 0, FACE.Bar, C_MOUTH, 0.006, tint)
      break
  }
}

function spriteRgb(hex: number): RGB {
  return lin(hex)
}
const S_GOLD = spriteRgb(0xffd84a)
const S_HILITE = spriteRgb(0xfff07a)
const S_VIOLET = spriteRgb(0xc9a2ff)
const S_HALO = spriteRgb(0xffd96a)
const S_CYAN = spriteRgb(0x7dffd9)
const S_DROP = spriteRgb(0x8fd3ff)
const S_PURPLE = spriteRgb(0x8a5cff)
const _ringCol = new THREE.Color()

/** 바닥 그림자·발밑 고리·강조 표시 */
function emitGroundCues(f: Frame, v: CharVisual, S: number, hover: number, top: number, radius: number): void {
  if (f.portrait) return
  const sp = f.rig.sprites
  const k = 1 / (1 + hover * 1.3)
  // 부드러운 원형 그림자(진짜 그림자 맵 대신)
  sp.push(v.x, v.y + 0.02, v.z, radius * 2.3 * S * k, radius * 2.3 * S * k, 0, MODE.Ground, 0, 0.04, 0.02, 0.08, 0.5 * k * Math.min(1, S), CELL.Glow)
  if (v.ring >= 0) {
    _ringCol.setHex(v.ring)
    sp.push(v.x, v.y + 0.03, v.z, radius * 2.9 * S, radius * 2.9 * S, 0, MODE.Ground, 0, _ringCol.r, _ringCol.g, _ringCol.b, 0.92, CELL.Ring)
  }
  if (v.highlight) {
    // "이 사람에게 말을 걸 수 있다": 발밑에서 맥박치는 밝은 고리 + 머리 위에서 통통 튀는 화살표
    const pulse = 0.5 + 0.5 * Math.sin(f.time * 6.5)
    const d = radius * (3.3 + 0.35 * pulse) * S
    sp.push(v.x, v.y + 0.035, v.z, d * 1.25, d * 1.25, 0, MODE.Ground, 1, S_HILITE[0], S_HILITE[1], S_HILITE[2], 0.3 + 0.15 * pulse, CELL.Glow)
    sp.push(v.x, v.y + 0.04, v.z, d, d, f.time * 0.8, MODE.Ground, 0.35, S_HILITE[0], S_HILITE[1], S_HILITE[2], 1, CELL.Ring)
    const bounce = Math.abs(Math.sin(f.time * 4.5))
    sp.push(v.x, v.y + (top + 0.3 + 0.14 * bounce) * S, v.z, 0.4, 0.4 * (0.92 + 0.08 * bounce), 0, MODE.Billboard, 0.15, S_GOLD[0], S_GOLD[1], S_GOLD[2], 1, CELL.Arrow)
  }
}

/** 얼어붙었을 때 머리 위를 도는 별 */
function emitStunStars(f: Frame, x: number, y: number, z: number, r: number, ph: number): void {
  const sp = f.rig.sprites
  for (let i = 0; i < 3; i++) {
    const a = f.time * 5 + (i * TAU) / 3 + ph * TAU
    sp.push(x + Math.cos(a) * r, y + 0.05 * Math.sin(a * 2 + i), z + Math.sin(a) * r, 0.24, 0.24, -a, MODE.Billboard, 0.25, S_GOLD[0], S_GOLD[1], S_GOLD[2], 1, CELL.Star)
  }
}

/** 카메라 반대쪽으로 d 만큼 민 위치(머리 "뒤"에 놓이는 후광 등) → vB */
function behind(f: Frame, x: number, y: number, z: number, d: number): THREE.Vector3 {
  let dx = x - f.camX
  let dy = y - f.camY
  let dz = z - f.camZ
  const l = Math.hypot(dx, dy, dz) || 1
  dx /= l
  dy /= l
  dz /= l
  return vB.set(x + dx * d, y + dy * d, z + dz * d)
}

function emitAura(f: Frame, aura: number, x: number, y: number, z: number, S: number, ph: number): void {
  const sp = f.rig.sprites
  const t = f.time
  const headY = y + 1.14 * S
  switch (aura) {
    case 1: {
      // 수상한 반짝이: 몸 주위 여기저기서 반짝 켜졌다 꺼진다
      for (let i = 0; i < 5; i++) {
        const cyc = t * 0.75 + i * 0.37 + ph * 3
        const k = cyc - Math.floor(cyc)
        const seed = Math.floor(cyc) + i * 17
        const a = hash(seed, 1.3) * TAU
        const r = (0.42 + 0.22 * hash(seed, 2.7)) * S
        const h = (0.25 + 1.35 * hash(seed, 4.1)) * S
        const size = 0.3 * Math.sin(PI * k) * S
        const c = i % 2 === 0 ? S_GOLD : S_VIOLET
        sp.push(x + Math.cos(a) * r, y + h + 0.1 * k, z + Math.sin(a) * r, size, size, t * 1.5 + i, MODE.Billboard, 0.85, c[0], c[1], c[2], 1, CELL.Spark)
      }
      break
    }
    case 2: {
      // 후광: 머리 뒤의 금빛 원반(어느 쪽에서 봐도 머리 뒤에 온다)
      const b = behind(f, x, headY, z, 0.46 * S)
      const d = 1.62 * S * (1 + 0.035 * Math.sin(t * 2.4 + ph * 6))
      sp.push(b.x, b.y, b.z, d, d, 0, MODE.Billboard, 0.5, S_HALO[0], S_HALO[1], S_HALO[2], 0.95, CELL.Halo)
      break
    }
    case 3: {
      // 무지개 오라: 몸 뒤에서 천천히 도는 무지개 고리 + 색색 반짝이
      const b = behind(f, x, y + 0.85 * S, z, 0.6 * S)
      const d = 2.7 * S * (1 + 0.03 * Math.sin(t * 2 + ph * 6))
      sp.push(b.x, b.y, b.z, d, d, t * 0.5, MODE.Billboard, 0.3, 1, 1, 1, 0.92, CELL.Rainbow)
      for (let i = 0; i < 3; i++) {
        const a = t * 1.1 + (i * TAU) / 3
        _ringCol.setHSL((i / 3 + t * 0.1) % 1, 0.9, 0.62)
        sp.push(x + Math.cos(a) * 0.62 * S, y + (0.55 + 0.5 * Math.sin(a * 1.7 + i)) * S + 0.3, z + Math.sin(a) * 0.62 * S, 0.2 * S, 0.2 * S, a, MODE.Billboard, 0.8, _ringCol.r, _ringCol.g, _ringCol.b, 1, CELL.Spark)
      }
      break
    }
    case 4: {
      // 우주 오라: 기울어진 궤도를 도는 별과 행성 + 은은한 보라 기운
      const b = behind(f, x, y + 0.9 * S, z, 0.55 * S)
      sp.push(b.x, b.y, b.z, 2.5 * S, 2.5 * S, 0, MODE.Billboard, 1, S_PURPLE[0], S_PURPLE[1], S_PURPLE[2], 0.26, CELL.Glow)
      for (let i = 0; i < 6; i++) {
        const orbit = i % 2
        const a = t * (orbit ? -1.25 : 1.5) + (i * TAU) / 6 + ph * TAU
        const r = (0.62 + 0.08 * orbit) * S
        const tilt = orbit ? -0.5 : 0.42
        const ox = Math.cos(a) * r
        const oz = Math.sin(a) * r
        const oy = ox * Math.sin(tilt)
        const px = x + ox * Math.cos(tilt)
        const py = y + (0.9 + 0.1 * orbit) * S + oy
        if (i === 0) sp.push(px, py, z + oz, 0.3 * S, 0.3 * S, 0.3, MODE.Billboard, 0.1, 1, 1, 1, 1, CELL.Planet)
        else sp.push(px, py, z + oz, 0.19 * S, 0.19 * S, a, MODE.Billboard, 0.6, S_GOLD[0], S_GOLD[1], S_GOLD[2], 1, i % 3 === 0 ? CELL.Spark : CELL.Star)
      }
      break
    }
  }
}

function emitHuman(f: Frame, v: CharVisual, cs: CharState, st: Style, pose: Float32Array, ex: Expr, dist: number, grow: number, emoteOn: boolean): void {
  const rig = f.rig
  const t = f.time
  const far = dist > LOD_FAR
  const near = dist < LOD_NEAR
  const frozen = v.anim === Anim.Stun
  const tint = frozen ? TINT_FROZEN : TINT_NONE
  // 실제 접속자는 아주 조금 크게
  const S = v.scale * grow * (v.isNpc ? 1 : 1.04)
  const hover = pose[P.hover]!
  const bob = pose[P.bob]!
  const yaw = v.yaw + pose[P.twist]!

  _e.set(0, yaw, 0)
  _q.setFromEuler(_e)
  _p.set(v.x, v.y + hover * S, v.z)
  _s.set(S, S, S)
  mRoot.compose(_p, _q, _s)

  const sq = pose[P.squash]!
  const sxz = 1 / Math.sqrt(sq)
  local(mBody, mRoot, 0, DIM.HIP_Y + bob, 0, pose[P.pitch]!, 0, pose[P.roll]!, 'XYZ', sxz, sq, sxz)

  // 몸통 + 덧입는 조각
  rig.torso.add(mBody, st.torsoA, st.torsoB, st.torsoVar, tint)
  if (st.addon === TORSO.Mantle) {
    rig.torso.add(mBody, st.addonA, null, TORSO.Mantle, tint)
  } else if (st.addon === TORSO.Cape) {
    // 망토는 목을 축으로 살랑이고, 달리면 뒤로 날린다
    const sway = 0.04 + 0.05 * Math.min(cs.speed, 7) + 0.03 * Math.sin(t * 2.6 + v.phase * TAU)
    local(mTmp, mBody, 0, DIM.NECK_Y, 0, sway, 0, 0)
    mTmp.multiply(_m.makeTranslation(0, -DIM.NECK_Y, 0))
    rig.torso.add(mTmp, st.addonA, null, TORSO.Cape, tint)
  }

  // 머리(목을 축으로 끄덕·돌림·갸웃)
  local(mHead, mBody, 0, DIM.NECK_Y, 0, pose[P.headPitch]!, pose[P.headYaw]!, pose[P.headRoll]!, 'YXZ')
  mHead.multiply(_m.makeTranslation(0, DIM.HEAD_UP, 0))
  rig.head.add(mHead, st.skin, st.hair, st.hairVar, tint)

  // 모자
  if (st.hat > 0) {
    if (st.hat === 10) {
      // UFO 는 머리 위에서 둥실거리며 돈다
      local(mTmp, mHead, 0, 0.03 * Math.sin(t * 2.4 + v.phase * TAU), 0, 0.05 * Math.sin(t * 1.7), t * 1.3, 0.05 * Math.cos(t * 1.3))
      rig.hat.add(mTmp, st.hatA, null, 10, tint)
      rig.hatT.add(mTmp, null, null, 10, tint)
    } else {
      rig.hat.add(mHead, st.hatA, null, st.hat, tint)
      if (st.hat === 3) rig.hatT.add(mHead, null, null, 3, tint)
    }
  }

  // 얼굴: 멀거나 뒤통수만 보이면 생략
  if (!far) {
    const e = mHead.elements
    // 머리의 앞 방향(+Z 축)과 카메라 방향
    const fx = e[8]!
    const fy = e[9]!
    const fz = e[10]!
    const cx = f.camX - e[12]!
    const cy = f.camY - e[13]!
    const cz = f.camZ - e[14]!
    const facing = (fx * cx + fy * cy + fz * cz) / ((Math.hypot(fx, fy, fz) || 1) * (Math.hypot(cx, cy, cz) || 1))
    if (facing > -0.45) {
      // 눈 깜빡임: 캐릭터마다 다른 박자로 가끔
      const bt = t * 0.31 + v.phase * 7.3
      const blink = bt - Math.floor(bt) < 0.035 && !frozen
      emitFace(f, st, ex, blink, near, tint)
    }
  }

  // 팔: 번쩍 들 때는 어깨가 살짝 올라가고 팔이 늘어나 큰 머리 밖으로 손이 나온다
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1
    const ax = pose[k === 0 ? P.aLx : P.aRx]!
    const az = pose[k === 0 ? P.aLz : P.aRz]!
    const raise = smooth(1.3, 2.7, ax)
    local(k === 0 ? mArmL : mArmR, mBody, s * (DIM.SHOULDER_X + 0.02 * raise), DIM.SHOULDER_Y + 0.03 * raise, 0, -ax, 0, s * az, 'XYZ', 1, 1 + 0.16 * raise, 1)
    rig.arm.add(k === 0 ? mArmL : mArmR, st.sleeve, st.hand, st.armVar, tint)
  }

  // 다리: 엉덩이 높이에서 앞뒤로 흔든다(몸이 숙여도 다리는 서 있다)
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1
    const lx = pose[k === 0 ? P.lLx : P.lRx]!
    const lz = pose[k === 0 ? P.lLz : P.lRz]!
    const ly = pose[k === 0 ? P.lLy : P.lRy]!
    local(mLeg, mRoot, s * DIM.HIP_X, DIM.HIP_Y + bob + ly, 0, -lx, 0, s * lz)
    rig.leg.add(mLeg, st.pants, st.shoe, st.legVar, tint)
  }

  if (!far) {
    // 소품
    const acc = st.acc
    if (acc === ACC.Sash || acc === ACC.Beads || acc === ACC.Backpack || acc === ACC.Chain) {
      rig.acc.add(mBody, null, null, acc, tint)
    } else if (acc === ACC.Megaphone) {
      if (pose[P.mega]! > 0.5) {
        // 설교 중: 오른손에 들고 입 앞으로
        local(mTmp, mArmR, 0, -DIM.ARM_LEN - 0.03, 0.03, PI / 2 + 0.25, 0, 0)
      } else {
        // 평소: 허리춤에 차고 있다
        local(mTmp, mBody, -0.25, 0.1, 0.02, 1.35, -0.25, 0)
      }
      rig.acc.add(mTmp, null, null, ACC.Megaphone, tint)
    }
    // 전단지(오른손)
    const fl = pose[P.flyer]!
    if (fl > 0.05) {
      const fs = fl * 1.35
      local(mTmp, mArmR, 0, -DIM.ARM_LEN - 0.04, 0.02, PI / 2, 0, 0, 'XYZ', fs, fs, fs)
      rig.acc.add(mTmp, null, null, ACC.Flyer, tint)
    }
  }

  // ── 스프라이트 ──
  const top = HAT_TOP[st.hat] ?? 1.5
  emitGroundCues(f, v, S, hover, top, 0.42)
  const sp = rig.sprites
  const headX = mHead.elements[12]!
  const headY = mHead.elements[13]!
  const headZ = mHead.elements[14]!
  if (frozen) emitStunStars(f, headX, v.y + (top + 0.16) * S, headZ, 0.4 * S, v.phase)
  if (far) return
  if (f.auras && st.aura > 0) emitAura(f, st.aura, v.x, v.y + hover * S, v.z, S, v.phase)

  if (emoteOn && v.emote) {
    const et = v.emoteT
    if (v.emote === 'cosmic') {
      // 머리 위로 퍼져 올라가는 전파 고리
      for (let i = 0; i < 3; i++) {
        const c = et * 0.9 + i / 3
        const k = c - Math.floor(c)
        const d = (0.3 + 1.0 * k) * S
        sp.push(headX, v.y + (top + 0.12 + 0.85 * k) * S, headZ, d, d * 0.55, 0, MODE.Billboard, 0.8, S_CYAN[0], S_CYAN[1], S_CYAN[2], (1 - k) * 0.95, CELL.Ring)
      }
    } else if (v.emote === 'levitate') {
      // 발밑의 신비로운 빛
      const up = smooth(0, 0.9, et)
      const d = (1.3 + 0.12 * Math.sin(et * 3)) * S
      sp.push(v.x, v.y + 0.05, v.z, d * 1.4, d * 1.4, 0, MODE.Ground, 1, S_VIOLET[0], S_VIOLET[1], S_VIOLET[2], 0.5 * up, CELL.Glow)
      sp.push(v.x, v.y + 0.06, v.z, d, d, -et * 0.7, MODE.Ground, 0.7, S_VIOLET[0], S_VIOLET[1], S_VIOLET[2], 0.85 * up, CELL.Ring)
    } else if (v.emote === 'point' && et > 0.18 && et < 1.5) {
      // 손끝에서 "팅!"
      vA.set(0, -(DIM.ARM_LEN + 0.12), 0).applyMatrix4(mArmR)
      const k = (et - 0.18) / 1.32
      const d = 0.55 * Math.sin(PI * Math.sqrt(k)) * S
      sp.push(vA.x, vA.y, vA.z, d, d, et * 2, MODE.Billboard, 0.9, S_HILITE[0], S_HILITE[1], S_HILITE[2], 1, CELL.Spark)
    } else if (v.emote === 'smirk' && et > 0.35 && et < 1.3) {
      // 눈가에 번쩍 — 수상한 미소의 완성
      vA.set(-0.2, 0.06, 0.42).applyMatrix4(mHead)
      const d = 0.34 * Math.sin((PI * (et - 0.35)) / 0.95) * S
      sp.push(vA.x, vA.y, vA.z, d, d, 0.4, MODE.Billboard, 0.9, 1, 1, 1, 1, CELL.Spark)
    } else if (v.emote === 'pray') {
      // 모은 손 위의 은은한 빛
      vA.set(0, 0.4, 0.3).applyMatrix4(mBody)
      const d = (0.42 + 0.06 * Math.sin(et * 3)) * S
      sp.push(vA.x, vA.y, vA.z, d, d, 0, MODE.Billboard, 1, S_HALO[0], S_HALO[1], S_HALO[2], 0.4, CELL.Glow)
    }
  }
  // 도망칠 때 흩날리는 식은땀
  if (v.anim === Anim.Sprint || (emoteOn && v.emote === 'flee')) {
    const bx = -Math.sin(yaw)
    const bz = -Math.cos(yaw)
    for (let i = 0; i < 2; i++) {
      const c = t * 2.6 + i * 0.5 + v.phase
      const k = c - Math.floor(c)
      const side = i === 0 ? 1 : -1
      const d = 0.2 * (1 - k * 0.6) * S
      sp.push(
        headX + bx * (0.28 + 0.5 * k) * S + bz * side * 0.3 * S,
        headY + (0.25 + 0.35 * k - 0.6 * k * k) * S,
        headZ + bz * (0.28 + 0.5 * k) * S - bx * side * 0.3 * S,
        d,
        d * 1.3,
        side * 0.6,
        MODE.Billboard,
        0.1,
        S_DROP[0],
        S_DROP[1],
        S_DROP[2],
        1 - k,
        CELL.Drop,
      )
    }
  }
}

/** 길고양이: 사람과 같은 상태값으로 움직인다(걷기 = 총총, 도망 = 전력 질주, 듣기 = 앉아서 고개 갸웃) */
function emitCat(f: Frame, v: CharVisual, cs: CharState, st: Style, grow: number, dt: number): void {
  const rig = f.rig
  const t = f.time
  const ph = v.phase
  const frozen = v.anim === Anim.Stun
  const tint = frozen ? TINT_FROZEN : TINT_NONE
  const S = v.scale * grow * 1.3
  const w = frozen ? 0 : smooth(0.1, 0.5, cs.speed)
  const gallop = smooth(3.5, 5.5, cs.speed)
  const th = cs.gait * TAU

  // 서 있을 때 절반쯤은 앉아서 쉰다. 말을 들을 때는 항상 앉는다
  const sitTarget = w < 0.05 && !frozen && (v.anim === Anim.Listen || (v.anim === Anim.Idle && ph > 0.45)) ? 1 : 0
  cs.sit += (sitTarget - cs.sit) * (1 - Math.exp(-dt / 0.12))
  if (dt <= 0) cs.sit = sitTarget
  const sit = cs.sit

  const cheer = v.anim === Anim.Cheer ? Math.abs(Math.sin((t * 1.9 + ph) * PI)) : 0
  const shiver = frozen ? Math.sin(t * 47) * 0.04 : 0
  const hover = cheer * 0.16 + gallop * w * 0.04 * Math.max(0, Math.sin(th * 2))

  _e.set(0, v.yaw + shiver, 0)
  _q.setFromEuler(_e)
  _p.set(v.x, v.y + hover * S, v.z)
  _s.set(S, S, S)
  mRoot.compose(_p, _q, _s)

  // 몸: 앉으면 뒷다리 쪽을 축으로 앞이 들린다. 질주하면 앞뒤로 출렁
  const pitch = -0.5 * sit + gallop * w * 0.14 * Math.sin(th)
  const bob = w * 0.012 * Math.cos(th * 2) + 0.004 * Math.sin(t * 2.2 + ph * TAU)
  local(mBody, mRoot, 0, bob - 0.035 * sit, -0.13, pitch, 0, 0)
  mBody.multiply(_m.makeTranslation(0, 0, 0.13))
  rig.cat.add(mBody, st.fur, st.fur2, CAT.Body, tint)

  // 머리: 몸이 들려도 고개는 수평을 유지. 들을 때는 갸웃
  const listen = v.anim === Anim.Listen ? 1 : 0
  const look = Math.sin(t * 0.5 + ph * 17)
  local(
    mHead,
    mBody,
    0,
    0.3 + 0.012 * w * Math.sin(th * 2),
    0.215,
    -pitch * 0.9 - 0.25 * listen * sit - 0.15 * cheer,
    (1 - w) * 0.45 * look * Math.abs(look),
    listen * 0.32 * (ph < 0.5 ? 1 : -1) + 0.05 * Math.sin(t * 0.8 + ph * 3),
    'YXZ',
  )
  rig.cat.add(mHead, st.fur, st.fur2, CAT.Head, tint)

  // 다리: 걷기는 대각선끼리, 질주는 앞·뒤끼리 같이 움직인다
  const amp = (0.55 + 0.35 * gallop) * w
  for (let i = 0; i < 4; i++) {
    const front = i < 2
    const s = i % 2 === 0 ? 1 : -1
    const trot = (front ? 1 : -1) * s
    const phase = th + (gallop > 0.5 ? (front ? 0 : PI) : trot > 0 ? 0 : PI)
    let rot = amp * Math.sin(phase)
    let len = 1
    let y = 0.13
    let z = front ? 0.145 : -0.135
    if (front) {
      // 앉으면 가슴이 들리므로 앞다리를 곧게 세우고(몸의 기울기를 되돌린다) 늘려 바닥에 닿게 한다
      rot -= 0.5 * sit
      len += 0.62 * sit
    } else {
      // 뒷다리는 앞으로 접어 깔고 앉는다
      rot += 0.85 * sit
      y -= 0.02 * sit
      z += 0.03 * sit
    }
    local(mLeg, mBody, s * 0.068, y, z, -rot, 0, s * 0.08 * sit, 'XYZ', 1, len, 1)
    rig.cat.add(mLeg, st.fur, st.fur2, CAT.Leg, tint)
  }

  // 꼬리: 살랑살랑. 달리면 뒤로 뻗고, 앉으면 옆으로 감는다
  const swish = Math.sin(t * (2.2 + 3 * cheer) + ph * TAU)
  local(mTmp, mBody, 0, 0.235, -0.2, -0.25 - 0.75 * w * (0.4 + 0.6 * gallop) - 0.95 * sit, 0.5 * sit, (0.4 - 0.25 * w) * swish + 0.5 * sit)
  rig.cat.add(mTmp, st.fur, st.fur2, CAT.Tail, tint)

  emitGroundCues(f, v, S, hover, 0.52, 0.27)
  if (frozen) emitStunStars(f, mHead.elements[12]!, v.y + 0.62 * S, mHead.elements[14]!, 0.24 * S, ph)
}

class Renderer implements CharacterRendererApi {
  private readonly engine: EngineApi
  private low: boolean
  private geos: Geos
  private readonly matOpaque = makePartMaterial(false)
  private readonly matTrans = makePartMaterial(true)
  private readonly rig: Rig
  private readonly states = new Map<number, CharState>()
  private readonly frustum = new THREE.Frustum()
  private readonly projView = new THREE.Matrix4()
  private readonly sphere = new THREE.Sphere()
  private lastPurge = 0
  private disposed = false

  // ── 초상용(처음 요청될 때 만든다) ──
  private pRig: Rig | null = null
  private pGeos: Geos | null = null
  private pScene: THREE.Scene | null = null
  private pCam: THREE.PerspectiveCamera | null = null
  private pTarget: THREE.WebGLRenderTarget | null = null
  private pSize = 0
  private readonly pCache = new Map<string, HTMLCanvasElement>()

  constructor(engine: EngineApi) {
    this.engine = engine
    this.low = engine.quality === 'low'
    this.geos = buildGeos(this.low ? 0 : 1)
    this.rig = new Rig(engine.scene, this.geos, this.matOpaque, this.matTrans, POOL_CAP, false)
    engine.onQuality((q) => {
      if (this.disposed) return
      const low = q === 'low'
      if (low === this.low) return
      // 품질이 바뀌면 분할 수가 다른 지오메트리로 갈아 끼운다
      this.low = low
      const old = this.geos
      this.geos = buildGeos(low ? 0 : 1)
      this.rig.setGeos(this.geos)
      disposeGeos(old)
    })
  }

  private state(v: CharVisual, time: number): CharState {
    let cs = this.states.get(v.key)
    if (!cs) {
      cs = {
        seen: time,
        x: v.x,
        z: v.z,
        speed: 0,
        gait: v.phase,
        anim: v.anim,
        emote: v.emote,
        from: new Float32Array(POSE_N),
        cur: new Float32Array(POSE_N),
        blend: 2,
        // 처음부터 사라지는 중으로 나타났다면(지하철에서 올라오는 중) 안 보이는 데서 시작한다
        vanish: v.anim === Anim.Vanish ? 1 : 0,
        sit: 0,
        look: null,
        isNpc: v.isNpc,
        style: null,
      }
      this.states.set(v.key, cs)
    }
    return cs
  }

  /** 걸음(실제 이동 거리 기반)과 사라짐 정도를 갱신한다. 화면 밖이어도 호출해 위상이 끊기지 않게 한다 */
  private advance(cs: CharState, v: CharVisual, dt: number, time: number, cat: boolean): void {
    const dx = v.x - cs.x
    const dz = v.z - cs.z
    const d = Math.hypot(dx, dz)
    cs.x = v.x
    cs.z = v.z
    if (d < TELEPORT_M) {
      if (dt > 1e-4) {
        const inst = Math.min(12, d / dt)
        cs.speed += (inst - cs.speed) * (1 - Math.exp(-dt / 0.09))
      }
      // 보폭은 속도가 빠를수록 길어진다 → 걷기 약 2.5보/초, 전력 질주 약 3.4보/초
      const stride = cat ? 0.32 + 0.16 * cs.speed : 0.55 + 0.23 * cs.speed
      cs.gait += d / stride
      if (cs.gait > 1e4) cs.gait -= 1e4
    } else if (v.anim === Anim.Vanish) {
      // 사라진 상태로 순간이동 = 새 시민으로 교체되어 다른 곳에서 등장
      cs.vanish = 1
    }
    const target = v.anim === Anim.Vanish ? 1 : 0
    if (dt > 0) {
      const rate = target > cs.vanish ? dt / 0.45 : dt / 0.3
      cs.vanish = target > cs.vanish ? Math.min(target, cs.vanish + rate) : Math.max(target, cs.vanish - rate)
    }
    cs.seen = time
  }

  /** 포즈 목표를 계산하고 상태 전환을 섞어 cs.cur 에 넣는다. 이모트가 실제로 재생 중인지 돌려준다 */
  private pose(cs: CharState, v: CharVisual, dt: number, time: number, snap: boolean): boolean {
    // 1회성 이모트는 길이가 지나면 끝난 것으로 본다(서버가 지우기 전의 짧은 틈)
    let emote = v.emote
    if (emote) {
      const def = EMOTE_BY_ID.get(emote)
      if (!def || (!def.loop && v.emoteT > def.ms / 1000 + 0.05)) emote = null
    }
    computePose(tgt, expr, {
      anim: v.anim,
      emote,
      et: v.emoteT,
      t: time,
      ph: v.phase,
      gait: cs.gait,
      speed: cs.speed,
      hasMega: cs.style !== null && cs.style.acc === ACC.Megaphone,
    })
    if (snap || cs.blend > 1.5) {
      cs.cur.set(tgt)
      cs.blend = 1
    } else {
      if (cs.anim !== v.anim || cs.emote !== emote) {
        cs.from.set(cs.cur)
        cs.blend = 0
      }
      if (cs.blend < 1) {
        cs.blend = Math.min(1, cs.blend + dt / BLEND_SEC)
        const k = cs.blend * cs.blend * (3 - 2 * cs.blend)
        for (let i = 0; i < POSE_N; i++) {
          const a = cs.from[i]!
          const b = tgt[i]!
          cs.cur[i] = i === P.twist ? a + wrapPi(b - a) * k : a + (b - a) * k
        }
      } else {
        cs.cur.set(tgt)
      }
    }
    cs.anim = v.anim
    cs.emote = emote
    return emote !== null && cs.speed < 0.45
  }

  private style(cs: CharState, v: CharVisual): Style {
    if (!cs.style || cs.isNpc !== v.isNpc || !sameLook(cs.look, v.look)) {
      cs.look = [v.look[0], v.look[1], v.look[2], v.look[3], v.look[4], v.look[5], v.look[6]]
      cs.isNpc = v.isNpc
      cs.style = resolveStyle(v.look, v.isNpc)
    }
    return cs.style
  }

  update(dt: number, time: number, visuals: readonly CharVisual[]): void {
    if (this.disposed) return
    const cam = this.engine.camera
    // 이번 프레임에 카메라가 이미 움직였을 수 있으므로 직접 갱신해서 절두체를 만든다
    cam.updateMatrixWorld()
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projView)
    const ce = cam.matrixWorld.elements
    const frame: Frame = {
      rig: this.rig,
      time,
      camX: ce[12]!,
      camY: ce[13]!,
      camZ: ce[14]!,
      auras: !this.low,
      portrait: false,
    }
    const rig = this.rig
    rig.begin()
    const safeDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.25) : 0

    for (let i = 0; i < visuals.length; i++) {
      const v = visuals[i]!
      const cat = v.model === NpcModel.Cat
      const cs = this.state(v, time)
      this.advance(cs, v, safeDt, time, cat)

      // 사라졌다가 돌아올 때는 살짝 튕기며 커진다
      const vis = 1 - cs.vanish
      const grow = vis >= 1 ? 1 : vis * vis * (3 - 2 * vis) * (1 + 0.28 * Math.sin(PI * vis))
      if (grow * v.scale < 0.02) continue

      // 절두체 밖이면 인스턴스를 만들지 않는다(모자·오라까지 덮는 넉넉한 구)
      const sc = Math.max(0.3, v.scale)
      this.sphere.center.set(v.x, v.y + (cat ? 0.4 : 1.0) * sc, v.z)
      this.sphere.radius = (cat ? 0.9 : 1.55) * sc
      if (!this.frustum.intersectsSphere(this.sphere)) {
        // 다시 화면에 들어올 때 옛 포즈에서 섞이지 않도록 바로 맞춘다
        cs.blend = 2
        cs.anim = v.anim
        continue
      }
      const dist = Math.hypot(v.x - frame.camX, v.y + 1 - frame.camY, v.z - frame.camZ)
      const st = this.style(cs, v)
      if (cat) {
        emitCat(frame, v, cs, st, grow, safeDt)
      } else {
        const emoteOn = this.pose(cs, v, safeDt, time, false)
        emitHuman(frame, v, cs, st, cs.cur, expr, dist, grow, emoteOn)
      }
    }
    rig.end()

    // 한동안 안 보인 캐릭터의 상태는 버린다(나간 플레이어, 교체된 NPC)
    if (time - this.lastPurge > 1 || time < this.lastPurge) {
      this.lastPurge = time
      for (const [key, cs] of this.states) {
        if (time - cs.seen > FORGET_SEC || cs.seen > time) this.states.delete(key)
      }
    }
  }

  // ───────── 초상 ─────────

  private ensurePortrait(px: number): void {
    if (!this.pScene) {
      const scene = new THREE.Scene()
      // 얼굴이 잘 보이게 정면 위에서 비추는 따뜻한 빛 + 부드러운 하늘빛
      scene.add(new THREE.HemisphereLight(0xfff4e6, 0x8a7fa8, 1.45))
      const key = new THREE.DirectionalLight(0xfff1dc, 1.9)
      key.position.set(1.4, 2.6, 3.2)
      scene.add(key)
      const rim = new THREE.DirectionalLight(0xbfd4ff, 0.7)
      rim.position.set(-2.5, 1.5, -2)
      scene.add(rim)
      this.pScene = scene
      this.pCam = new THREE.PerspectiveCamera(24, 1, 0.5, 30)
      // 초상은 크게 그려지므로 품질과 무관하게 가장 고운 지오메트리를 따로 만든다
      this.pGeos = buildGeos(2)
      this.pRig = new Rig(scene, this.pGeos, this.matOpaque, this.matTrans, 2, true)
    }
    if (!this.pTarget || this.pSize !== px) {
      this.pTarget?.dispose()
      this.pTarget = new THREE.WebGLRenderTarget(px, px, {
        depthBuffer: true,
        samples: this.engine.renderer.capabilities.isWebGL2 ? 4 : 0,
        generateMipmaps: false,
      })
      this.pSize = px
    }
  }

  portrait(look: Look, size: number, emote?: string): HTMLCanvasElement {
    const out = document.createElement('canvas')
    const n = Math.max(16, Math.min(2048, Math.round(size) || 256))
    out.width = out.height = n
    const ctx = out.getContext('2d')
    if (!ctx || this.disposed) return out

    const cacheKey = `${look.join(',')}|${n}|${emote ?? ''}`
    const hit = this.pCache.get(cacheKey)
    if (hit) {
      ctx.drawImage(hit, 0, 0)
      return out
    }

    const renderer = this.engine.renderer
    // 가장자리를 곱게: 2배로 그려서 줄인다(상한 1024)
    const px = Math.min(1024, n * 2)
    try {
      this.ensurePortrait(px)
    } catch {
      return out
    }
    const rig = this.pRig
    const scene = this.pScene
    const cam = this.pCam
    const target = this.pTarget
    if (!rig || !scene || !cam || !target) return out

    // 3/4 각도 흉상: 가슴께부터 머리(모자) 꼭대기까지. 넓은 갓·삿갓, 높은 피라미드·UFO 도 잘리지 않게 틀을 넓힌다
    const style = resolveStyle(look, false)
    const top = (HAT_TOP[style.hat] ?? 1.5) + 0.1
    const wide = style.hat === 3 || style.hat === 4 || style.hat === 2
    const lift = emote === 'levitate' ? 0.5 : emote === 'cheer' ? 0.12 : 0
    const half = Math.max(wide ? 0.78 : emote ? 0.66 : 0.56, (top - 0.56) / 2)
    const cy = top - half + lift
    const distance = half / Math.tan((cam.fov * PI) / 360)
    cam.position.set(distance * -0.1, cy + distance * 0.09, distance * 0.99)
    cam.lookAt(0, cy, 0)
    cam.updateMatrixWorld()

    const v: CharVisual = {
      key: -1,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0.42,
      look,
      model: 0,
      anim: Anim.Idle,
      emote: emote && EMOTE_BY_ID.has(emote) ? emote : null,
      // 포즈가 가장 그럴듯한 순간
      emoteT: 0.62,
      phase: 0.13,
      scale: 1,
      ring: -1,
      isNpc: false,
      highlight: false,
    }
    const cs: CharState = {
      seen: 0,
      x: 0,
      z: 0,
      speed: 0,
      gait: 0,
      anim: v.anim,
      emote: v.emote,
      from: new Float32Array(POSE_N),
      cur: new Float32Array(POSE_N),
      blend: 2,
      vanish: 0,
      sit: 0,
      look: null,
      isNpc: false,
      style,
    }
    const frame: Frame = {
      rig,
      time: 1.9,
      camX: cam.position.x,
      camY: cam.position.y,
      camZ: cam.position.z,
      auras: true,
      portrait: true,
    }
    rig.begin()
    const emoteOn = this.pose(cs, v, 0, frame.time, true)
    // 초상에서는 두리번거리지 않고 살짝 카메라 쪽을 본다
    if (!v.emote) {
      cs.cur[P.headYaw] = -0.14
      cs.cur[P.headRoll] = 0.04
    }
    // 절·큰절·회전처럼 얼굴이 틀 밖으로 나가는 동작은 얼굴이 보이는 선에서 멈춘다
    cs.cur[P.pitch] = Math.min(cs.cur[P.pitch]!, 0.2)
    cs.cur[P.bob] = Math.max(cs.cur[P.bob]!, -0.03)
    cs.cur[P.twist] = Math.max(-0.3, Math.min(0.3, cs.cur[P.twist]!))
    cs.cur[P.headPitch] = Math.max(-0.3, Math.min(0.22, cs.cur[P.headPitch]!))
    emitHuman(frame, v, cs, style, cs.cur, expr, 3, 1, emoteOn)
    rig.end()

    // ── 렌더 타깃에 그리고 픽셀을 읽어 온다. 끝나면 렌더러 상태를 원래대로 ──
    const prevTarget = renderer.getRenderTarget()
    const prevColor = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()
    const prevAuto = renderer.autoClear
    const prevXr = renderer.xr.enabled
    const pixels = new Uint8Array(px * px * 4)
    try {
      renderer.xr.enabled = false
      renderer.autoClear = true
      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 0)
      // 렌더 타깃은 선형으로 그려지므로 셰이더에서 직접 sRGB 로 내보낸다
      sharedUniforms.uSrgbOut.value = 1
      renderer.render(scene, cam)
      renderer.readRenderTargetPixels(target, 0, 0, px, px, pixels)
    } finally {
      sharedUniforms.uSrgbOut.value = 0
      renderer.setRenderTarget(prevTarget)
      renderer.setClearColor(prevColor, prevAlpha)
      renderer.autoClear = prevAuto
      renderer.xr.enabled = prevXr
    }

    // 위아래를 뒤집고(GL 은 아래가 원점), 미리 곱해진 알파를 풀어 2D 캔버스로 옮긴다
    const big = document.createElement('canvas')
    big.width = big.height = px
    const bctx = big.getContext('2d')
    if (!bctx) return out
    const img = bctx.createImageData(px, px)
    const dst = img.data
    for (let y = 0; y < px; y++) {
      let si = (px - 1 - y) * px * 4
      let di = y * px * 4
      for (let x = 0; x < px; x++, si += 4, di += 4) {
        const a = pixels[si + 3]!
        if (a === 0) continue
        const k = 255 / a
        dst[di] = Math.min(255, pixels[si]! * k)
        dst[di + 1] = Math.min(255, pixels[si + 1]! * k)
        dst[di + 2] = Math.min(255, pixels[si + 2]! * k)
        dst[di + 3] = a
      }
    }
    bctx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(big, 0, 0, n, n)

    // 같은 초상을 여러 번 요청하는 UI(프로필 → 임명장)를 위해 조금만 기억해 둔다
    const keep = document.createElement('canvas')
    keep.width = keep.height = n
    keep.getContext('2d')?.drawImage(out, 0, 0)
    this.pCache.set(cacheKey, keep)
    if (this.pCache.size > 24) {
      const first = this.pCache.keys().next()
      if (!first.done) this.pCache.delete(first.value)
    }
    return out
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rig.dispose()
    this.pRig?.dispose()
    if (this.pGeos) disposeGeos(this.pGeos)
    disposeGeos(this.geos)
    this.pTarget?.dispose()
    this.matOpaque.dispose()
    this.matTrans.dispose()
    this.states.clear()
    this.pCache.clear()
  }
}

export function createCharacterRenderer(engine: EngineApi): CharacterRendererApi {
  return new Renderer(engine)
}
