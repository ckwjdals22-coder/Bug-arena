/**
 * 절차 애니메이션: (상태, 이모트, 시간, 걸음 위상, 속도) → 포즈 매개변수 + 표정.
 * 뼈대가 없으므로 포즈는 숫자 몇 개(몸 기울기, 팔다리 각도 …)로만 표현하고,
 * 렌더러가 상태 전환 때 이 숫자들을 약 150ms 동안 섞는다.
 *
 * 팔 각도 약속: x = 앞으로 드는 각(0 아래, π/2 앞, π 위), z = 옆으로 벌리는 각(+ 바깥).
 * 머리가 커서 팔을 똑바로 위로 들면 머리에 파묻힌다 → "번쩍" 포즈는 항상 z ≥ 0.75 로 벌려 든다.
 */
import { Anim } from '../../../../shared/constants'

export const P = {
  /** 몸 전체가 떠오르는 높이 */
  hover: 0,
  /** 엉덩이 높이 변화(들썩임, 무릎 꿇기) */
  bob: 1,
  /** 앞으로 숙임(+) */
  pitch: 2,
  /** 옆으로 기울임 */
  roll: 3,
  /** 추가 회전(춤, 회전 기도) */
  twist: 4,
  /** 세로 늘이기(1 = 보통) */
  squash: 5,
  headPitch: 6,
  headYaw: 7,
  headRoll: 8,
  aLx: 9,
  aLz: 10,
  aRx: 11,
  aRz: 12,
  /** 다리: x 앞뒤 흔들기, z 벌리기, y 들어 올리기 */
  lLx: 13,
  lLz: 14,
  lLy: 15,
  lRx: 16,
  lRz: 17,
  lRy: 18,
  /** 손에 든 전단지 크기 0..1 */
  flyer: 19,
  /** 확성기를 손에 듦 0..1 */
  mega: 20,
} as const
export const POSE_N = 21

export const EYES = { Face: 0, Happy: 1, Closed: 2, Sly: 3, Wide: 4, Dizzy: 5, Blank: 6 } as const
export const MOUTH = { Face: 0, Smile: 1, Open: 2, O: 3, Sly: 4, Flat: 5 } as const

export interface Expr {
  eyes: number
  mouth: number
  /** 벌린 입의 크기 배율(설교할 때 뻐끔뻐끔) */
  talk: number
  /** 눈썹을 찌푸린 정도(−: 걱정, +: 결연) */
  brow: number
}

export interface PoseInput {
  anim: number
  emote: string | null
  /** 이모트 경과 초 */
  et: number
  /** 전역 시각(초) */
  t: number
  /** 캐릭터별 난수 0..1 */
  ph: number
  /** 걸음 주기(1 = 왼발·오른발 한 번씩) */
  gait: number
  /** 지면 속도 m/s */
  speed: number
  hasMega: boolean
}

const PI = Math.PI
const TAU = PI * 2

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}
function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** 0→1 로 올라갔다가(tIn) 유지하고 tOutStart 부터 tOutEnd 까지 내려오는 봉투 */
function pulse(t: number, tIn: number, tOutStart: number, tOutEnd: number): number {
  return smooth(0, tIn, t) * (1 - smooth(tOutStart, tOutEnd, t))
}
export function wrapPi(a: number): number {
  a = (a + PI) % TAU
  if (a < 0) a += TAU
  return a - PI
}

const scratch = new Float32Array(POSE_N)

function reset(o: Float32Array): void {
  o.fill(0)
  o[P.squash] = 1
}

/** 숨쉬며 서 있기 — 다른 정지 포즈의 바탕이 된다 */
function idle(o: Float32Array, t: number, ph: number): void {
  const br = Math.sin(t * 2.1 + ph * TAU)
  o[P.bob] = 0.006 * br
  o[P.squash] = 1 + 0.014 * br
  o[P.roll] = 0.016 * Math.sin(t * 0.9 + ph * 9)
  // 가끔 두리번
  const look = Math.sin(t * 0.43 + ph * 21)
  o[P.headYaw] = 0.16 * look * Math.abs(look)
  o[P.headRoll] = 0.035 * Math.sin(t * 0.61 + ph * 5)
  o[P.aLz] = 0.11 + 0.02 * br
  o[P.aRz] = 0.11 + 0.02 * br
  o[P.aLx] = 0.04 * Math.sin(t * 1.3 + ph * 3)
  o[P.aRx] = -0.04 * Math.sin(t * 1.3 + ph * 3)
}

/** 걷기/달리기/전력 질주. 발 디딤은 실제 이동 거리(gait)에 맞물린다 */
function locomotion(o: Float32Array, gait: number, speed: number, sprinting: boolean): void {
  const th = gait * TAU
  const s = Math.sin(th)
  const c = Math.cos(th)
  const run = smooth(4.2, 5.8, speed)
  const sprint = sprinting ? 1 : smooth(6.8, 8.2, speed)
  const amp = Math.min(1.05, 0.5 + 0.11 * speed)
  o[P.lLx] = amp * s
  o[P.lRx] = -amp * s
  const lift = 0.035 + 0.05 * run
  o[P.lLy] = lift * Math.max(0, c)
  o[P.lRy] = lift * Math.max(0, -c)
  o[P.bob] = (0.016 + 0.028 * run) * Math.cos(th * 2)
  o[P.squash] = 1 + 0.02 * Math.cos(th * 2)
  const pitch = 0.05 + 0.13 * run + 0.24 * sprint
  o[P.pitch] = pitch
  // 뒤뚱뒤뚱: 디딘 발 쪽으로 몸이 기운다
  o[P.roll] = (0.065 - 0.03 * run) * s
  o[P.twist] = 0.08 * s * (1 - sprint)
  o[P.headPitch] = -0.55 * pitch - 0.12 * sprint
  o[P.headRoll] = -0.5 * o[P.roll]!
  const swing = 0.5 + 0.45 * run
  const flail = Math.sin(th * 2)
  const flail2 = Math.sin(th * 2 + 1.9)
  // 전력 질주: 양팔을 뒤로 뻗고 허둥지둥
  o[P.aLx] = -swing * s * (1 - sprint) + sprint * (-1.2 + 0.28 * flail)
  o[P.aRx] = swing * s * (1 - sprint) + sprint * (-1.2 + 0.28 * flail2)
  o[P.aLz] = (0.14 + 0.1 * run) * (1 - sprint) + sprint * (0.7 + 0.3 * flail2)
  o[P.aRz] = (0.14 + 0.1 * run) * (1 - sprint) + sprint * (0.7 + 0.3 * flail)
}

function emotePose(o: Float32Array, ex: Expr, id: string, et: number, hasMega: boolean): boolean {
  switch (id) {
    case 'wave': {
      // 오른손을 번쩍 들어 좌우로 흔든다
      const w = Math.sin(et * 13)
      o[P.aRx] = 2.95
      o[P.aRz] = 0.84 + 0.3 * w
      o[P.aLz] = 0.14
      o[P.roll] = 0.07
      o[P.headRoll] = -0.12 + 0.03 * w
      o[P.bob] = 0.012 * Math.abs(w)
      ex.eyes = EYES.Happy
      ex.mouth = MOUTH.Open
      return true
    }
    case 'bow': {
      // 허리를 깊이 숙였다가 일어난다
      const k = pulse(et, 0.4, 1.2, 1.75)
      o[P.pitch] = 1.05 * k
      o[P.headPitch] = 0.28 * k
      o[P.bob] = -0.02 * k
      o[P.aLz] = 0.06
      o[P.aRz] = 0.06
      o[P.aLx] = 0.2 * k
      o[P.aRx] = 0.2 * k
      if (k > 0.3) ex.eyes = EYES.Closed
      ex.mouth = MOUTH.Smile
      return true
    }
    case 'smirk': {
      // 몸을 비스듬히 틀고 손을 비비며 초승달 눈웃음
      const rub = Math.sin(et * 16)
      o[P.roll] = -0.1
      o[P.pitch] = 0.12
      o[P.twist] = 0.3
      o[P.headRoll] = 0.17
      o[P.headYaw] = -0.3
      o[P.headPitch] = 0.06
      o[P.aLx] = 1.12 + 0.08 * rub
      o[P.aRx] = 1.12 - 0.08 * rub
      o[P.aLz] = -0.6
      o[P.aRz] = -0.6
      o[P.bob] = 0.012 * Math.abs(Math.sin(et * 8))
      ex.eyes = EYES.Sly
      ex.mouth = MOUTH.Sly
      return true
    }
    case 'pray': {
      // 두 손을 가슴 앞에 모으고 눈을 감는다
      const sway = Math.sin(et * 1.5)
      o[P.aLx] = 1.42
      o[P.aRx] = 1.42
      o[P.aLz] = -0.62
      o[P.aRz] = -0.62
      o[P.headPitch] = 0.2 + 0.03 * sway
      o[P.roll] = 0.025 * sway
      o[P.bob] = 0.006 * Math.sin(et * 2)
      ex.eyes = EYES.Closed
      ex.mouth = MOUTH.Smile
      return true
    }
    case 'flyer': {
      // 오른손의 전단지를 내밀어 흔들고 왼손으로 손짓
      const sh = Math.sin(et * 10)
      o[P.aRx] = 1.7 + 0.2 * sh
      o[P.aRz] = 0.78 + 0.18 * Math.sin(et * 10 + 1.3)
      o[P.aLx] = 0.65 + 0.3 * Math.sin(et * 5)
      o[P.aLz] = 0.4
      o[P.pitch] = 0.12
      o[P.bob] = 0.016 * Math.abs(Math.sin(et * 5))
      o[P.headYaw] = 0.22 * Math.sin(et * 1.3)
      o[P.headPitch] = -0.08
      o[P.flyer] = 1
      ex.mouth = MOUTH.Open
      ex.talk = 0.75 + 0.25 * Math.sin(et * 9)
      return true
    }
    case 'preach': {
      // 양손을 번쩍 들고 하늘을 보며 열변
      const k = Math.sin(et * 4.2)
      o[P.aLx] = 2.85 + 0.18 * k
      o[P.aLz] = 1.0 + 0.16 * Math.sin(et * 4.2 + 1)
      if (hasMega) {
        // 확성기가 있으면 한 손은 입 앞으로
        o[P.aRx] = 1.95
        o[P.aRz] = -0.42
        o[P.mega] = 1
      } else {
        o[P.aRx] = 2.85 + 0.18 * k
        o[P.aRz] = 1.0 + 0.16 * Math.sin(et * 4.2 + 2.2)
      }
      o[P.pitch] = -0.1 + 0.05 * k
      o[P.headPitch] = hasMega ? -0.12 : -0.3
      o[P.bob] = 0.022 * Math.abs(k)
      o[P.squash] = 1 + 0.025 * k
      ex.mouth = MOUTH.Open
      ex.talk = 0.55 + 0.45 * Math.sin(et * 11)
      ex.brow = 1
      return true
    }
    case 'dance': {
      // 팔을 물결처럼 흔들며 제자리에서 천천히 돈다
      const w = et * 3.2
      o[P.aLx] = 1.75 + 0.75 * Math.sin(w)
      o[P.aLz] = 1.05 + 0.3 * Math.sin(w + 1.3)
      o[P.aRx] = 1.75 + 0.75 * Math.sin(w + 2.1)
      o[P.aRz] = 1.05 + 0.3 * Math.sin(w + 3.4)
      o[P.twist] = wrapPi(et * 1.5)
      o[P.roll] = 0.13 * Math.sin(w)
      o[P.bob] = 0.035 * Math.abs(Math.sin(w))
      o[P.squash] = 1 + 0.03 * Math.sin(w * 2)
      o[P.headRoll] = -0.14 * Math.sin(w)
      o[P.lLy] = 0.05 * Math.max(0, Math.sin(w))
      o[P.lRy] = 0.05 * Math.max(0, -Math.sin(w))
      o[P.lLz] = 0.1
      o[P.lRz] = 0.1
      ex.eyes = EYES.Happy
      ex.mouth = MOUTH.Smile
      return true
    }
    case 'flee': {
      // 제자리에서 허둥지둥(움직이기 시작하면 전력 질주 포즈가 덮는다)
      locomotion(o, et * 3.6, 6, true)
      o[P.aLx] = 2.9
      o[P.aRx] = 2.9
      o[P.aLz] = 1.05 + 0.3 * Math.sin(et * 22)
      o[P.aRz] = 1.05 + 0.3 * Math.sin(et * 22 + 2)
      o[P.pitch] = 0.2
      o[P.headPitch] = -0.1
      o[P.headYaw] = 0.6 * Math.sin(et * 9)
      ex.eyes = EYES.Wide
      ex.mouth = MOUTH.O
      ex.brow = -1
      return true
    }
    case 'cheer': {
      // 만세 삼창: 세 번 폴짝
      const h = Math.abs(Math.sin(et * PI * 1.5))
      o[P.hover] = 0.24 * h
      o[P.squash] = 0.93 + 0.13 * h
      o[P.aLx] = 3.0
      o[P.aRx] = 3.0
      o[P.aLz] = 0.82 + 0.28 * h
      o[P.aRz] = 0.82 + 0.28 * h
      o[P.lLx] = 0.25 * h
      o[P.lRx] = -0.15 * h
      o[P.headPitch] = -0.2
      ex.eyes = EYES.Happy
      ex.mouth = MOUTH.Open
      return true
    }
    case 'kneel': {
      // 큰절: 무릎 꿇고 → 이마가 땅에 닿게 엎드렸다가 → 일어남
      const d = pulse(et, 0.5, 2.0, 2.55)
      const b = pulse(Math.max(0, et - 0.3), 0.6, 1.4, 1.85)
      o[P.bob] = -0.2 * d
      o[P.lLx] = -1.45 * d
      o[P.lRx] = -1.45 * d
      o[P.pitch] = 1.22 * b + 0.1 * d
      o[P.headPitch] = 0.25 * b
      o[P.aLx] = 0.3 * d + 2.3 * b
      o[P.aRx] = 0.3 * d + 2.3 * b
      o[P.aLz] = 0.1 + 0.8 * b
      o[P.aRz] = 0.1 + 0.8 * b
      if (d > 0.4) ex.eyes = EYES.Closed
      return true
    }
    case 'spin': {
      // 회전 기도: 양팔을 벌리고 빠르게 뱅글뱅글
      o[P.twist] = wrapPi(et * 7.5)
      o[P.aLx] = 0.1
      o[P.aRx] = 0.1
      o[P.aLz] = 1.8 + 0.08 * Math.sin(et * 5)
      o[P.aRz] = 1.8 + 0.08 * Math.sin(et * 5 + 1)
      o[P.hover] = 0.04 + 0.02 * Math.sin(et * 5)
      o[P.headPitch] = -0.16
      o[P.squash] = 0.97
      o[P.lLz] = 0.1
      o[P.lRz] = 0.1
      ex.eyes = EYES.Closed
      ex.mouth = MOUTH.O
      return true
    }
    case 'point': {
      // 계시의 손가락: 하늘을 가리키며 한 손은 허리에
      const k = smooth(0, 0.22, et)
      const hold = 1 + 0.04 * Math.sin(et * 20) * (1 - smooth(0.2, 0.6, et))
      o[P.aRx] = 2.75 * k
      o[P.aRz] = 0.85 * k * hold
      o[P.aLx] = -0.25
      o[P.aLz] = 0.62
      o[P.roll] = 0.09 * k
      o[P.pitch] = -0.1 * k
      o[P.headYaw] = -0.32 * k
      o[P.headPitch] = -0.22 * k
      o[P.lLz] = 0.2 * k
      o[P.lRz] = 0.12 * k
      ex.brow = 1
      ex.mouth = MOUTH.Open
      ex.talk = 0.8
      return true
    }
    case 'levitate': {
      // 공중부양: 가부좌로 둥실
      const up = smooth(0, 0.9, et)
      o[P.hover] = 0.52 * up + 0.05 * Math.sin(et * 1.6)
      o[P.lLx] = 1.3 * up
      o[P.lRx] = 1.3 * up
      o[P.lLz] = -0.55 * up
      o[P.lRz] = -0.55 * up
      o[P.aLx] = 0.75 * up
      o[P.aRx] = 0.75 * up
      o[P.aLz] = 0.5 * up
      o[P.aRz] = 0.5 * up
      o[P.pitch] = -0.05
      o[P.headPitch] = 0.06
      o[P.roll] = 0.03 * Math.sin(et * 0.8)
      ex.eyes = EYES.Closed
      ex.mouth = MOUTH.Smile
      return true
    }
    case 'cosmic': {
      // 우주 교신: 양팔을 안테나처럼 벌려 들고 하늘을 본다(눈은 하얗게)
      o[P.aLx] = 3.0
      o[P.aRx] = 3.0
      o[P.aLz] = 0.86 + 0.05 * Math.sin(et * 9)
      o[P.aRz] = 0.86 + 0.05 * Math.sin(et * 9 + 1.5)
      o[P.headPitch] = -0.36
      o[P.pitch] = -0.08
      o[P.hover] = 0.03 + 0.015 * Math.sin(et * 3)
      o[P.roll] = 0.012 * Math.sin(et * 41)
      o[P.twist] = 0.02 * Math.sin(et * 37)
      ex.eyes = EYES.Blank
      ex.mouth = MOUTH.O
      return true
    }
    default:
      return false
  }
}

/**
 * 목표 포즈를 계산한다. out 길이는 POSE_N.
 * 이동 중이면 이모트/정지 포즈 위에 걸음 포즈를 속도에 비례해 덮는다(반복 이모트는 이동하면 풀리므로).
 */
export function computePose(out: Float32Array, ex: Expr, inp: PoseInput): void {
  const { anim, t, ph } = inp
  reset(out)
  ex.eyes = EYES.Face
  ex.mouth = MOUTH.Face
  ex.talk = 1
  ex.brow = 0

  const frozen = anim === Anim.Stun
  let w = frozen ? 0 : smooth(0.12, 0.7, inp.speed)

  let handled = false
  if (inp.emote && !frozen && w < 0.98) {
    idle(out, t, ph)
    handled = emotePose(out, ex, inp.emote, inp.et, inp.hasMega)
    if (!handled) reset(out)
  }
  if (!handled) {
    idle(out, t, ph)
    if (anim === Anim.Listen) {
      // 고개를 갸웃하고 한 손을 턱에 — "네? 저요?"
      const side = ph < 0.5 ? 1 : -1
      out[P.pitch] = -0.07
      out[P.headRoll] = side * 0.24
      out[P.headYaw] = side * -0.08
      out[P.headPitch] = -0.04 + 0.035 * Math.sin(t * 2.6 + ph * 5)
      if (side > 0) {
        out[P.aLx] = 1.83
        out[P.aLz] = -0.63
        out[P.aRx] = -0.1
        out[P.aRz] = 0.4
      } else {
        out[P.aRx] = 1.83
        out[P.aRz] = -0.63
        out[P.aLx] = -0.1
        out[P.aLz] = 0.4
      }
    } else if (anim === Anim.Cheer) {
      // 양팔 번쩍 폴짝
      const h = Math.abs(Math.sin((t * 1.7 + ph) * PI))
      out[P.hover] = 0.2 * h
      out[P.squash] = 0.93 + 0.13 * h
      out[P.aLx] = 3.0
      out[P.aRx] = 3.0
      out[P.aLz] = 0.8 + 0.25 * h
      out[P.aRz] = 0.8 + 0.25 * h
      out[P.lLx] = 0.22 * h
      out[P.lRx] = -0.12 * h
      out[P.headPitch] = -0.16
      out[P.headYaw] = 0
      ex.eyes = EYES.Happy
      ex.mouth = MOUTH.Open
    } else if (frozen) {
      // 얼어붙어 부들부들
      reset(out)
      out[P.roll] = 0.035 * Math.sin(t * 47 + ph * 9)
      out[P.twist] = 0.05 * Math.sin(t * 39 + ph * 5)
      out[P.pitch] = -0.06
      out[P.headPitch] = -0.08
      out[P.aLz] = 0.03
      out[P.aRz] = 0.03
      out[P.squash] = 1.03
      ex.eyes = EYES.Dizzy
      ex.mouth = MOUTH.Flat
    }
  }

  if (w > 0) {
    const sprinting = anim === Anim.Sprint
    reset(scratch)
    locomotion(scratch, inp.gait, inp.speed, sprinting)
    // 제자리 도망 포즈에서 달리기로 넘어갈 때 팔이 한 바퀴 돌지 않게 twist 는 최단 각도로 섞는다
    for (let i = 0; i < POSE_N; i++) {
      if (i === P.twist) out[i] = out[i]! + wrapPi(scratch[i]! - out[i]!) * w
      else out[i] = out[i]! + (scratch[i]! - out[i]!) * w
    }
    if (w > 0.5) {
      if (sprinting || inp.speed > 7) {
        ex.eyes = EYES.Wide
        ex.mouth = MOUTH.O
        ex.brow = -1
        ex.talk = 1
      } else if (handled) {
        ex.eyes = EYES.Face
        ex.mouth = MOUTH.Face
        ex.talk = 1
        ex.brow = 0
      }
    }
  } else {
    w = 0
  }
}
