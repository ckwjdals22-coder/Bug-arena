/**
 * 월드 조립 중에 여러 파일이 함께 쓰는 것들: 하늘/빛 값, 색 팔레트, 조립 컨텍스트.
 */
import type { QualityTier } from '../../core/contracts'
import type { SignAtlas } from './atlas'
import { type Builder, type RGB, rgb } from './geo'

/**
 * 엔진이 써야 하는 하늘·안개·조명 값(해 질 녘 직전의 따뜻한 거리).
 * - sun.dir 은 원점에서 해를 향하는 방향(= DirectionalLight 의 position). 남서쪽 낮은 해.
 * - 조명 세기는 three r155+ 의 물리 단위 기준(Lambert 는 irradiance/π 로 반사).
 * - 카메라 near 는 0.5 이상을 권한다(바닥 무늬와 깊이 정밀도).
 */
export const WORLD_SKY = {
  top: 0x6fb4ea,
  bottom: 0xffd2a6,
  fog: 0xf0c4b8,
  fogNear: 55,
  fogFar: 185,
  sun: { color: 0xffd9a6, intensity: 1.9, dir: [-0.5, 0.62, 0.6] as [number, number, number] },
  hemi: { sky: 0xd3e0ff, ground: 0xdcb8a0, intensity: 2.3 },
} as const

/** 그림자가 떨어지는 쪽(해 반대편)의 수평 단위 벡터 */
const sl = Math.hypot(WORLD_SKY.sun.dir[0], WORLD_SKY.sun.dir[2])
export const SHADOW_DIR = { x: -WORLD_SKY.sun.dir[0] / sl, z: -WORLD_SKY.sun.dir[2] / sl }

/** 색 팔레트(sRGB 16진). 따뜻한 오후 + 수상한 보라 */
export const PAL = {
  asphalt: rgb(0x5d5868),
  asphaltDark: rgb(0x4b4756),
  roadWhite: rgb(0xf3efe6),
  roadYellow: rgb(0xf0bf3f),
  sidewalk: rgb(0xcbbfb2),
  sidewalkAlt: rgb(0xb9ac9e),
  curb: rgb(0xece3d6),
  tactile: rgb(0xf2c84b),
  paving: rgb(0xdfcdb3),
  plaza: rgb(0xf0dfc3),
  plazaTrim: rgb(0xb98a6e),
  plazaRing: rgb(0xd9c09c),
  plazaRay: rgb(0xf4c76e),
  plazaRay2: rgb(0xeba56a),
  grass: rgb(0x9cba6e),
  grassDark: rgb(0x87a862),
  farGrass: rgb(0xa8b889),
  blockBase: rgb(0x6f6677),
  footprint: rgb(0x453f50),
  lot: rgb(0xb89d80),
  alley: rgb(0x64596d),
  stone: rgb(0xc4b8ab),
  stoneDark: rgb(0x9a8f86),
  soil: rgb(0x6b5444),
  hedge: rgb(0x6f9e5c),
  hedgeDark: rgb(0x5d8a50),
  wood: rgb(0xb98a5e),
  woodDark: rgb(0x7a5a44),
  metal: rgb(0x4a4756),
  metalLight: rgb(0xa9adb8),
  concrete: rgb(0x98918a),
  white: rgb(0xf6f2ea),
  glassDark: rgb(0x4d5f80),
  glassSky: rgb(0x8fb0d0),
  purple: rgb(0x7b5ea7),
  purpleDeep: rgb(0x4a2f7a),
  cream: rgb(0xf3e9d2),
  gold: rgb(0xe0b84c),
  red: rgb(0xb5383f),
  orange: rgb(0xf26a2e),
  /** 그늘/접지 음영 색(순수 검정 대신 남보라를 써서 그림 같은 그늘을 만든다) */
  shade: rgb(0x1c1232),
  warmGlow: rgb(0xffd596),
  purpleGlow: rgb(0xb07cff),
} as const

/** 한 벌의 지오메트리 버퍼(재질별) */
export interface Layer {
  /** 조명 받는 불투명 면 */
  solid: Builder
  /** 바닥·벽에 붙는 무늬(polygonOffset 으로 깊이 싸움을 피한다) */
  decal: Builder
  /** 간판·불빛: 조명 없이 아틀라스 색 그대로 */
  unlit: Builder
  /** 가짜 그림자·빛 웅덩이(반투명). 없는 층에서는 생략한다 */
  fx: Builder | null
}

export interface ParasolInst {
  x: number
  y: number
  z: number
  scale: number
  color: number
  phase: number
}
export interface FlagInst {
  x: number
  y: number
  z: number
  /** 줄이 뻗은 방향 */
  yaw: number
  w: number
  h: number
  color: number
  phase: number
}
export interface PigeonInst {
  x: number
  y: number
  z: number
  yaw: number
  phase: number
}

export interface BuildCtx {
  q: QualityTier
  low: boolean
  high: boolean
  /** 정적 월드 */
  main: Layer
  /** 비밀 교단 건물 안(문이 닫혀 있으면 통째로 숨긴다) */
  hq: Layer
  /** 교단 건물 겉(앞벽 + 지붕): 안을 들여다볼 때 숨긴다 */
  shell: Builder
  /** 교단 네온 간판(깜빡임) */
  neon: Builder
  /** 교단 문 셔터(말려 올라감) */
  shutter: Builder
  /** 보행 신호 불빛(빨강/초록을 번갈아 보인다) */
  sigRed: Builder
  sigGreen: Builder
  atlas: SignAtlas
  parasols: ParasolInst[]
  flags: FlagInst[]
  pigeons: PigeonInst[]
  rnd: () => number
}

/** 색 밝기를 조금 흔든다(같은 재료라도 한 덩어리로 보이지 않게) */
export function jitter(c: RGB, rnd: () => number, amount = 0.06): RGB {
  const k = 1 + (rnd() - 0.5) * 2 * amount
  return [c[0] * k, c[1] * k, c[2] * k]
}
