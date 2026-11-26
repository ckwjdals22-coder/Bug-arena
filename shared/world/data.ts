/**
 * 월드 데이터 — "수상역 4번 출구 앞" 거리 레이아웃의 단일 원본.
 *
 * 왜 이렇게 생겼나:
 *  - 건물(BUILDINGS)과 소품(PROPS)을 한 번만 적고, 충돌체(WORLD.boxes/circles)와 화면(render/world.ts)을
 *    둘 다 여기서 끌어낸다. 그래서 "보이는 것"과 "막히는 것"이 어긋날 수 없다.
 *  - 좌표계: X 동(+)/서(−), Z 남(+)/북(−). yaw 는 바라보는 방향(0 = 남쪽 +Z, 앞 = (sin yaw, cos yaw)).
 *  - 순수 데이터 파일이다(DOM/Node API 금지 — 서버·워커·클라이언트가 같이 쓴다).
 *
 * 배치 원칙(카메라 때문에 중요):
 *  - 걸을 수 있는 곳 바로 옆 건물은 전부 13m 이상으로 높다. 3인칭 카메라(높이 ≈ 6~12m)가 건물 "안"에 들어가면
 *    뒷면 컬링으로 건물이 통째로 투명해져 캐릭터가 가려지지 않는다. 낮은 건물은 지붕이 시야를 막는다.
 *  - 충돌체 사이 틈은 0(붙임)이거나 1.2m 이상. 0.9~1.2m 틈은 반지름 0.45 캐릭터가 끼는 느낌을 준다.
 */
import type { Box, Circle, NavKind, NavNode, Spot, WorldDef } from './def'

// ───────────────────────── 공용 타입 ─────────────────────────

/** 건물의 어느 면인가. n = 북쪽 면(z0, 바깥 법선 −Z), s = 남쪽 면(z1), w = 서쪽 면(x0), e = 동쪽 면(x1) */
export type Side = 'n' | 's' | 'e' | 'w'

export type SignIcon =
  | 'eye' // 수상한 눈
  | 'eyes' // 어둠 속 두 눈(천막 입구)
  | 'arrowL'
  | 'arrowR'
  | 'note' // 음표
  | 'fish' // 붕어빵
  | 'cross' // 약국 십자
  | 'star'
  | 'num4' // 지하철 출구 번호
  | 'cans' // 자판기 진열
  | 'ball' // 당구공

/** 간판 한 장. 글자와 색만 정하고, 그리는 방법은 렌더러의 간판 아틀라스가 맡는다 */
export interface SignDef {
  text: string
  /** 작은 보조 문구 */
  sub?: string
  /** 판 색 / 글자 색 (0xRRGGBB) */
  bg: number
  fg: number
  icon?: SignIcon
  /** 세로쓰기(돌출 간판, 배너) */
  vertical?: boolean
  /** 어두운 판 위에 빛나는 글자 */
  neon?: boolean
}

/** 1층 가게 전면 */
export interface ShopFrontDef {
  side: Side
  /** 벽을 따라 잰 가게 범위(월드 좌표: n/s 면은 x, e/w 면은 z) */
  a: number
  b: number
  sign: SignDef
  /** glass 통유리 가게 | shutter 내려진 셔터 */
  type: 'glass' | 'shutter'
  /** 차양 색(없으면 차양 없음) */
  awning?: number
  /** 유리 안쪽 불빛 색 */
  glow?: number
}

/** 위층 간판/벽화 */
export interface WallSignDef {
  side: Side
  /** 간판 중심(벽을 따라 잰 월드 좌표)과 중심 높이 */
  at: number
  y: number
  w: number
  h: number
  sign: SignDef
  /** board 벽에 붙은 판 | stick 벽에서 튀어나온 돌출 간판 | paint 벽에 직접 그린 벽화/현수막 */
  mount: 'board' | 'stick' | 'paint'
}

export type BuildingKind =
  | 'shop' // 길가 상가(1층 가게 + 위층 간판)
  | 'office' // 띠 유리창 사무용 건물
  | 'backdrop' // 뒤쪽 배경 건물(걸어서 닿지 않음)
  | 'apartment' // 북쪽 멀리 보이는 아파트
  | 'hq' // 비밀 교단 건물(안이 비어 있고 벽만 충돌)

export interface BuildingDef {
  id: string
  kind: BuildingKind
  x0: number
  z0: number
  x1: number
  z1: number
  /** 높이(m) */
  h: number
  /** 층수(창문 줄 계산용) */
  floors: number
  wall: number
  trim: number
  roof: number
  /** 발자국 전체가 충돌 박스인가(경계 밖 배경 건물은 false) */
  collide: boolean
  fronts?: ShopFrontDef[]
  signs?: WallSignDef[]
}

export type PropKind =
  | 'tree'
  | 'lamp'
  | 'bench'
  | 'table' // 편의점 앞 플라스틱 탁자 + 의자 + 파라솔
  | 'booth' // 포교 부스(탁자 + 파라솔)
  | 'xbanner' // 세워 둔 배너
  | 'vending'
  | 'van'
  | 'truck' // 붕어빵 트럭
  | 'scooter' // 배달 스쿠터
  | 'busStop'
  | 'subway' // 지하철 출입구(계단 + 캐노피)
  | 'totem' // 역 이름 기둥
  | 'stall' // 분식 포장마차
  | 'tent' // 수상한 천막
  | 'offering' // 가상 헌금함
  | 'planter'
  | 'signpost'
  | 'bollard'
  | 'signal' // 보행 신호등
  | 'pole' // 전봇대
  | 'crate'
  | 'trash'
  | 'cone'
  | 'banner' // 두 기둥 사이 현수막
  | 'wall' // 낮은 담
  | 'throne'
  | 'lantern'
  | 'crystal' // 기운 충전 수정(교단 건물 안)
  | 'cushion'
  | 'pigeon'
  | 'acunit' // 벽에 달린 실외기
  | 'flyer' // 벽에 붙은 전단지
  | 'barricade' // 길 끝 공사 가림막(경계 밖)

export interface PropDef {
  kind: PropKind
  x: number
  z: number
  /** 바라보는 방향. 생략 = 0(남쪽) */
  yaw?: number
  /** 종류별 변형 이름(색/모양) */
  variant?: string
  /** 간판 글자가 있는 소품 */
  sign?: SignDef
  sign2?: SignDef
  /** 크기 덮어쓰기(PROP_SHAPE 기본값 대신) */
  w?: number
  d?: number
  h?: number
  r?: number
  /** 바닥에서 띄운 높이(벽에 붙는 소품) */
  y?: number
  color?: number
  color2?: number
  /** 교단 건물 안 소품(문이 닫혀 있으면 그리지 않는다) */
  hq?: boolean
  /** 꾸밈 전용: 충돌체가 없고 낮은 품질에서는 생략해도 된다 */
  deco?: boolean
}

/** 소품의 충돌 모양. 화면에 그릴 때도 같은 치수를 쓴다 */
export type PropShape =
  | { t: 'none' }
  | { t: 'circle'; r: number }
  /** 축 정렬 박스: w = 로컬 X(좌우), d = 로컬 Z(앞뒤). yaw 는 90° 단위여야 한다 */
  | { t: 'box'; w: number; d: number }
  /** 임의 각도로 놓이는 길쭉한 소품: 로컬 X 를 따라 원 여러 개 */
  | { t: 'capsule'; w: number; d: number }
  /** 로컬 X 양 끝(±w/2)에 기둥 두 개 */
  | { t: 'ends'; w: number; r: number }

export const PROP_SHAPE: Record<PropKind, PropShape> = {
  tree: { t: 'circle', r: 0.6 },
  lamp: { t: 'circle', r: 0.2 },
  bench: { t: 'capsule', w: 1.8, d: 0.6 },
  table: { t: 'capsule', w: 1.9, d: 0.9 },
  booth: { t: 'box', w: 2.0, d: 0.8 },
  xbanner: { t: 'circle', r: 0.32 },
  vending: { t: 'box', w: 1.1, d: 0.8 },
  van: { t: 'box', w: 1.9, d: 4.6 },
  truck: { t: 'box', w: 1.9, d: 4.5 },
  scooter: { t: 'capsule', w: 1.7, d: 0.6 },
  busStop: { t: 'box', w: 4.0, d: 1.6 },
  subway: { t: 'box', w: 3.4, d: 6.4 },
  totem: { t: 'circle', r: 0.28 },
  stall: { t: 'box', w: 3.6, d: 1.4 },
  tent: { t: 'circle', r: 3.2 },
  offering: { t: 'circle', r: 0.6 },
  planter: { t: 'box', w: 3.0, d: 1.0 },
  signpost: { t: 'circle', r: 0.14 },
  bollard: { t: 'circle', r: 0.18 },
  signal: { t: 'circle', r: 0.16 },
  pole: { t: 'circle', r: 0.2 },
  crate: { t: 'box', w: 1.4, d: 1.4 },
  trash: { t: 'circle', r: 0.5 },
  cone: { t: 'circle', r: 0.2 },
  banner: { t: 'ends', w: 9, r: 0.12 },
  wall: { t: 'box', w: 0.4, d: 8 },
  throne: { t: 'box', w: 1.8, d: 1.4 },
  lantern: { t: 'circle', r: 0.25 },
  crystal: { t: 'circle', r: 0.6 },
  cushion: { t: 'none' },
  pigeon: { t: 'none' },
  acunit: { t: 'none' },
  flyer: { t: 'none' },
  barricade: { t: 'none' },
}

/** 소품의 실제 치수(덮어쓰기 반영) */
export function propShape(p: PropDef): PropShape {
  const s = PROP_SHAPE[p.kind]
  switch (s.t) {
    case 'circle':
      return { t: 'circle', r: p.r ?? s.r }
    case 'box':
      return { t: 'box', w: p.w ?? s.w, d: p.d ?? s.d }
    case 'capsule':
      return { t: 'capsule', w: p.w ?? s.w, d: p.d ?? s.d }
    case 'ends':
      return { t: 'ends', w: p.w ?? s.w, r: p.r ?? s.r }
    default:
      return s
  }
}

/** 소품 하나의 충돌체 목록 */
export function propColliders(p: PropDef): { boxes: Box[]; circles: Circle[] } {
  const boxes: Box[] = []
  const circles: Circle[] = []
  const s = propShape(p)
  const yaw = p.yaw ?? 0
  const cs = Math.cos(yaw)
  const sn = Math.sin(yaw)
  if (s.t === 'circle') {
    circles.push({ x: p.x, z: p.z, r: s.r })
  } else if (s.t === 'box') {
    // 90° 단위 회전만 허용: 홀수 번 돌면 가로/세로가 바뀐다
    const quarter = Math.round(yaw / (Math.PI / 2))
    const swap = Math.abs(quarter) % 2 === 1
    const hw = (swap ? s.d : s.w) / 2
    const hd = (swap ? s.w : s.d) / 2
    boxes.push({ x0: p.x - hw, z0: p.z - hd, x1: p.x + hw, z1: p.z + hd })
  } else if (s.t === 'capsule') {
    const r = s.d / 2
    // 원 사이 간격을 지름의 3/4 이하로 잡아야 사이에 틈(캐릭터가 파고드는 홈)이 생기지 않는다
    const n = Math.max(2, Math.ceil((s.w - s.d) / (s.d * 0.75)) + 1)
    const span = s.w / 2 - r
    for (let i = 0; i < n; i++) {
      const lx = n === 1 ? 0 : -span + (2 * span * i) / (n - 1)
      // 로컬 X 축은 월드에서 (cos yaw, −sin yaw)
      circles.push({ x: p.x + lx * cs, z: p.z - lx * sn, r })
    }
  } else if (s.t === 'ends') {
    for (const lx of [-s.w / 2, s.w / 2]) circles.push({ x: p.x + lx * cs, z: p.z - lx * sn, r: s.r })
  }
  return { boxes, circles }
}

// ───────────────────────── 큰 틀(지면 구역) ─────────────────────────

const E = Math.PI / 2 // 동쪽을 본다
const W = -Math.PI / 2 // 서쪽을 본다
const N = Math.PI // 북쪽을 본다

export const BOUNDS: Box = { x0: -48, z0: -36, x1: 48, z1: 36 }

/** 지면 구역 치수. 렌더러의 바닥 무늬와 아래 건물/소품 배치가 같이 쓴다 */
export const LAYOUT = {
  /** 큰길(차 없는 거리) */
  road: { z0: -5, z1: 5 },
  /** 중앙 횡단보도 */
  cross: { x0: -4, x1: 4 },
  northWalk: { z0: -9, z1: -5 },
  southWalk: { z0: 5, z1: 10 },
  /** 북쪽 건물 전면선 / 남쪽 상가 전면선 */
  northFront: -13,
  southFront: 10,
  /** 북쪽 경계 담 */
  northWall: -33,
  /** 지하철 옆 쌈지 공원 잔디 */
  garden: { x0: -29.4, z0: -32.4, x1: -12.6, z1: -17.6 },
  /** 천막이 있는 공터 */
  lot: { x0: 3.4, z0: 10, x1: 16.5, z1: 21.5 },
  /** 골목(남쪽 인도 → 비밀 교단 건물) */
  alley: { x0: -3, z0: 10, x1: 3, z1: 25.4 },
} as const

/** 비밀 교단 건물 치수: 바깥 상자, 안쪽 방, 문 */
export const HQ = {
  outer: { x0: -6.6, z0: 25.4, x1: 6.6, z1: 33.6 },
  inside: { x0: -6, z0: 26.2, x1: 6, z1: 33 },
  /** 문(셔터)이 막는 틈. 충돌 gate 와 같은 상자 */
  gate: { x0: -1.2, z0: 25.4, x1: 1.2, z1: 26.2 },
  doorH: 2.8,
  h: 16,
} as const

const PLAZA = { x: 0, z: -21, r: 11 }
const PODIUM = { x: 0, z: -21, r: 2.6, h: 0.5, ramp: 1.2 }
const TENT = { x: 10.6, z: 18.4, r: 3.2 }
const OFFERING = { x: 10.6, z: 13.2, r: 0.6 }
const SUBWAY = { x: -17.6, z: -13, r: 1.2, yaw: E }

// ───────────────────────── 건물 ─────────────────────────

const S_FRONT = LAYOUT.southFront
const S_BACK = HQ.outer.z0 // 남쪽 상가 뒷면 = 뒷줄 건물 앞면
const N_FRONT = LAYOUT.northFront
const N_BACK = LAYOUT.northWall

export const BUILDINGS: BuildingDef[] = [
  // ── 남쪽 상가(전면 = 북쪽 면, 남쪽 인도를 본다) ──
  {
    id: 'sw1',
    kind: 'shop',
    x0: -56,
    z0: S_FRONT,
    x1: -37,
    z1: S_BACK,
    h: 15,
    floors: 4,
    wall: 0xe2cdb0,
    trim: 0x8c6f5a,
    roof: 0x7fa58a,
    collide: true,
    fronts: [
      {
        side: 'n',
        a: -47.6,
        b: -37.4,
        type: 'glass',
        glow: 0xffe7b0,
        sign: { text: '칼퇴 부동산', sub: '전세 · 월세 · 옥탑방', bg: 0x2f7d4f, fg: 0xffffff },
      },
    ],
    signs: [
      { side: 'n', at: -42.5, y: 7.3, w: 7, h: 1.1, mount: 'board', sign: { text: '수상 당구장', bg: 0x1d3f7a, fg: 0xffffff, icon: 'ball' } },
      { side: 'n', at: -37.7, y: 8.6, w: 0.9, h: 2.6, mount: 'stick', sign: { text: '당구', bg: 0x1d3f7a, fg: 0xffffff, vertical: true } },
    ],
  },
  {
    id: 'sw2',
    kind: 'shop',
    x0: -37,
    z0: S_FRONT,
    x1: -26,
    z1: S_BACK,
    h: 18,
    floors: 5,
    wall: 0xa9bccb,
    trim: 0x5d7186,
    roof: 0x8a8f99,
    collide: true,
    fronts: [
      { side: 'n', a: -36.6, b: -31.6, type: 'glass', glow: 0xf0fff0, sign: { text: '월요병 약국', bg: 0xffffff, fg: 0x2a9d5c, icon: 'cross' } },
      { side: 'n', a: -31.2, b: -26.4, type: 'glass', glow: 0xffe3ee, awning: 0xff7fa8, sign: { text: '야옹 미용실', bg: 0xff9fbf, fg: 0xffffff } },
    ],
    signs: [
      { side: 'n', at: -31.5, y: 7.4, w: 8, h: 1.2, mount: 'board', sign: { text: '번개 PC방', sub: '24시', bg: 0x1a1a22, fg: 0xffe14a } },
      { side: 'n', at: -31.5, y: 11.0, w: 8, h: 1.0, mount: 'board', sign: { text: '졸음 독서실', bg: 0xf4f1e6, fg: 0x3a5a8a } },
      { side: 'n', at: -26.4, y: 8.6, w: 0.9, h: 2.4, mount: 'stick', sign: { text: 'PC', bg: 0xffe14a, fg: 0x1a1a22, vertical: true } },
    ],
  },
  {
    id: 'sw3',
    kind: 'shop',
    x0: -26,
    z0: S_FRONT,
    x1: -14,
    z1: S_BACK,
    h: 13,
    floors: 3,
    wall: 0xf0e6d2,
    trim: 0x6b4fb3,
    roof: 0x7fa58a,
    collide: true,
    fronts: [
      {
        side: 'n',
        a: -25.6,
        b: -14.4,
        type: 'glass',
        glow: 0xf2f8ff,
        sign: { text: '24시 수상한 편의점', sub: '수상할 정도로 친절함', bg: 0x6b4fb3, fg: 0xffffff },
      },
    ],
    signs: [{ side: 'n', at: -20, y: 7.3, w: 6.4, h: 1.1, mount: 'board', sign: { text: '멍 카페', sub: '멍 때리기 전문', bg: 0x6a4a3a, fg: 0xffe9c9 } }],
  },
  {
    id: 'sw4',
    kind: 'shop',
    x0: -14,
    z0: S_FRONT,
    x1: -3,
    z1: S_BACK,
    h: 16,
    floors: 4,
    wall: 0xd29c84,
    trim: 0x7a4b3c,
    roof: 0x8a8f99,
    collide: true,
    fronts: [
      {
        side: 'n',
        a: -13.6,
        b: -3.4,
        type: 'shutter',
        sign: { text: '임대 문의', sub: '권리금 없음 · 기운 좋음', bg: 0xf1eee6, fg: 0xd23c3c },
      },
    ],
    signs: [
      { side: 'n', at: -8.5, y: 7.4, w: 9, h: 1.3, mount: 'board', sign: { text: '코인 노래연습장', bg: 0x1b1030, fg: 0xff6ad5, icon: 'note', neon: true } },
      { side: 'n', at: -8.5, y: 10.9, w: 7, h: 1.0, mount: 'board', sign: { text: '아침 요가 교실', bg: 0x8fc7b5, fg: 0x24443c } },
      { side: 'n', at: -3.4, y: 8.4, w: 0.9, h: 2.8, mount: 'stick', sign: { text: '노래방', bg: 0x1b1030, fg: 0xff6ad5, vertical: true, neon: true } },
      // 골목 쪽 벽: 비밀 본부로 가는 '비밀' 안내 네온(읽는 사람 기준 왼쪽이 남쪽)
      { side: 'e', at: 14.6, y: 3.3, w: 3.6, h: 1.0, mount: 'board', sign: { text: '비밀 본부 (쉿)', bg: 0x1b1030, fg: 0xc79bff, icon: 'arrowL', neon: true } },
    ],
  },
  {
    // 공터 뒤를 막는 얇은 건물. 천막 위로 벽화가 보인다
    id: 'lotBack',
    kind: 'backdrop',
    x0: 3,
    z0: LAYOUT.lot.z1,
    x1: 16.5,
    z1: S_BACK,
    h: 14,
    floors: 4,
    wall: 0x8f86a3,
    trim: 0x5d5474,
    roof: 0x6f6a7c,
    collide: true,
    signs: [
      {
        side: 'n',
        at: 10.6,
        y: 6.1,
        w: 9.5,
        h: 2.6,
        mount: 'paint',
        sign: { text: '기운이 부족하십니까?', sub: '지금 바로 헌납하세요 (전부 가상)', bg: 0x4a3a6e, fg: 0xffe08a },
      },
    ],
  },
  {
    id: 'se1',
    kind: 'shop',
    x0: 16.5,
    z0: S_FRONT,
    x1: 27.5,
    z1: S_BACK,
    h: 15,
    floors: 4,
    wall: 0xe9d9bf,
    trim: 0xb5533c,
    roof: 0x7fa58a,
    collide: true,
    fronts: [
      {
        side: 'n',
        a: 16.9,
        b: 27.1,
        type: 'glass',
        glow: 0xffe2a8,
        awning: 0xd8362a,
        sign: { text: '퇴근 치킨', sub: '오늘도 수고했닭', bg: 0xd8362a, fg: 0xfff2b0 },
      },
    ],
    signs: [
      { side: 'n', at: 22, y: 7.3, w: 8, h: 1.1, mount: 'board', sign: { text: '칼퇴 요가', sub: '정시 퇴근 자세 교정', bg: 0xbfe3d6, fg: 0x24443c } },
      { side: 'n', at: 16.9, y: 8.6, w: 0.9, h: 2.4, mount: 'stick', sign: { text: '치킨', bg: 0xd8362a, fg: 0xfff2b0, vertical: true } },
      // 공터 쪽 벽: 귀여운 감시의 눈
      { side: 'w', at: 15.0, y: 5.1, w: 6.5, h: 3.0, mount: 'paint', sign: { text: '보고 있다', sub: 'CCTV 아님 · 제3의 눈 작동 중', bg: 0x2a2140, fg: 0xd9c2ff, icon: 'eye' } },
    ],
  },
  {
    id: 'se2',
    kind: 'shop',
    x0: 27.5,
    z0: S_FRONT,
    x1: 38.5,
    z1: S_BACK,
    h: 13,
    floors: 3,
    wall: 0xf2c9b0,
    trim: 0x9c6b57,
    roof: 0x8a8f99,
    collide: true,
    fronts: [
      { side: 'n', a: 27.9, b: 33.1, type: 'glass', glow: 0xeaf6ff, sign: { text: '반짝 세탁소', bg: 0x4aa3df, fg: 0xffffff } },
      { side: 'n', a: 33.5, b: 38.1, type: 'glass', glow: 0xffeef4, awning: 0xf2a7c0, sign: { text: '달빛 꽃집', bg: 0xf7d6e0, fg: 0x7a3b5e } },
    ],
    signs: [{ side: 'n', at: 33, y: 7.2, w: 7.5, h: 1.1, mount: 'board', sign: { text: '꿀잠 수면카페', bg: 0x2b3a67, fg: 0xffe9a8, icon: 'star' } }],
  },
  {
    id: 'se3',
    kind: 'shop',
    x0: 38.5,
    z0: S_FRONT,
    x1: 56,
    z1: S_BACK,
    h: 17,
    floors: 5,
    wall: 0xb7afc9,
    trim: 0x6c6387,
    roof: 0x8a8f99,
    collide: true,
    fronts: [
      {
        side: 'n',
        a: 38.9,
        b: 47.6,
        type: 'glass',
        glow: 0xffd9a0,
        awning: 0x8a2f1e,
        sign: { text: '24시 국밥', sub: '든든하게 한 그릇', bg: 0x8a2f1e, fg: 0xfff2d0 },
      },
    ],
    signs: [{ side: 'n', at: 43.4, y: 7.4, w: 8, h: 1.2, mount: 'board', sign: { text: '수상 헬스장', sub: '3대 500 기원', bg: 0x222226, fg: 0xff6a3c } }],
  },
  // ── 남쪽 뒷줄(배경이자 경계). 교단 건물은 이 줄 한가운데에 끼어 있다 ──
  { id: 'backW', kind: 'backdrop', x0: -56, z0: S_BACK, x1: HQ.outer.x0, z1: 42, h: 22, floors: 6, wall: 0x9b93ad, trim: 0x6f6787, roof: 0x77728a, collide: true },
  { id: 'backE', kind: 'backdrop', x0: HQ.outer.x1, z0: S_BACK, x1: 56, z1: 42, h: 21, floors: 6, wall: 0xa79fb4, trim: 0x766e8c, roof: 0x77728a, collide: true },
  { id: 'backHq', kind: 'backdrop', x0: HQ.outer.x0, z0: HQ.outer.z1, x1: HQ.outer.x1, z1: 42, h: 22, floors: 6, wall: 0x8a80a0, trim: 0x655c7d, roof: 0x77728a, collide: true },
  {
    id: 'hq',
    kind: 'hq',
    x0: HQ.outer.x0,
    z0: HQ.outer.z0,
    x1: HQ.outer.x1,
    z1: HQ.outer.z1,
    h: HQ.h,
    floors: 4,
    wall: 0x5b4a7a,
    trim: 0xd9b24a,
    roof: 0x463a60,
    collide: true,
  },
  // ── 북쪽 건물(전면 = 남쪽 면, 북쪽 인도를 본다) ──
  {
    id: 'nwOffice',
    kind: 'office',
    x0: -56,
    z0: N_BACK,
    x1: -30,
    z1: N_FRONT,
    h: 19,
    floors: 5,
    wall: 0xbfcad3,
    trim: 0x66788a,
    roof: 0x8a8f99,
    collide: true,
    fronts: [
      { side: 's', a: -47.6, b: -39.4, type: 'glass', glow: 0xeef5ff, sign: { text: '수상한 은행', sub: '이자는 기운으로 드립니다', bg: 0x1f4e8c, fg: 0xffffff } },
      { side: 's', a: -38.6, b: -30.6, type: 'glass', glow: 0xffe2a8, awning: 0xe9a15b, sign: { text: '새벽 빵집', sub: '갓 구운 식빵', bg: 0xf3d9a4, fg: 0x6b3f1d } },
    ],
    signs: [
      { side: 's', at: -39, y: 16.8, w: 10, h: 1.6, mount: 'board', sign: { text: '수상빌딩', bg: 0x2c3e55, fg: 0xffffff } },
      // 공원 쪽 벽: 단속반 세계관의 구청 현수막
      { side: 'e', at: -23, y: 6.3, w: 11, h: 3.4, mount: 'paint', sign: { text: '무단 포교 금지', sub: '적발 시 3초간 얼음 — 수상구청', bg: 0xfdf6e3, fg: 0xd23c3c } },
    ],
  },
  {
    id: 'neAcademy',
    kind: 'shop',
    x0: 15,
    z0: N_BACK,
    x1: 32,
    z1: -18,
    h: 17,
    floors: 5,
    wall: 0xe6cfae,
    trim: 0xa0522d,
    roof: 0x7fa58a,
    collide: true,
    fronts: [
      { side: 's', a: 15.6, b: 23.2, type: 'glass', glow: 0xfff3c2, sign: { text: '수상한 문구점', sub: '부적 아님 · 그냥 스티커', bg: 0xffd84a, fg: 0x3a2a1a } },
      { side: 's', a: 23.8, b: 31.4, type: 'glass', glow: 0xe6fbff, sign: { text: '코인 빨래방', bg: 0x39b7b0, fg: 0xffffff } },
    ],
    signs: [
      { side: 's', at: 23.5, y: 7.5, w: 12, h: 1.4, mount: 'board', sign: { text: '합격 기원 학원', sub: '수강생 모집 (기운 무관)', bg: 0xf2c230, fg: 0xb3261e } },
      { side: 's', at: 23.5, y: 11.2, w: 9, h: 1.1, mount: 'board', sign: { text: '24시 스터디카페', bg: 0xffffff, fg: 0x33415c } },
      // 광장 쪽 벽: 세로 현수막
      { side: 'w', at: -25.5, y: 8.2, w: 2.2, h: 8.4, mount: 'paint', sign: { text: '수강생 모집', bg: 0xc8342b, fg: 0xffffff, vertical: true } },
    ],
  },
  {
    id: 'neOfficetel',
    kind: 'office',
    x0: 32,
    z0: N_BACK,
    x1: 56,
    z1: N_FRONT,
    h: 22,
    floors: 6,
    wall: 0xd3d9e0,
    trim: 0x7c8794,
    roof: 0x8a8f99,
    collide: true,
    fronts: [
      { side: 's', a: 32.6, b: 40.2, type: 'glass', glow: 0xffe9c4, awning: 0xff8a3d, sign: { text: '새참 김밥', sub: '한 줄의 여유', bg: 0xff8a3d, fg: 0xffffff } },
      { side: 's', a: 40.8, b: 47.6, type: 'glass', glow: 0xe8f7ff, sign: { text: '별빛 안경', bg: 0x2b2b3a, fg: 0x9fe8ff, icon: 'star' } },
    ],
    signs: [{ side: 's', at: 40, y: 19.6, w: 11, h: 1.7, mount: 'board', sign: { text: '수상 오피스텔', bg: 0x39424e, fg: 0xffffff } }],
  },
  // ── 경계 밖 배경(충돌 없음): 길 양 끝으로 이어지는 건물과 북쪽 아파트 ──
  { id: 'farNW', kind: 'backdrop', x0: -90, z0: -34, x1: -56, z1: N_FRONT, h: 25, floors: 7, wall: 0xb5aec2, trim: 0x837b98, roof: 0x77728a, collide: false },
  { id: 'farSW', kind: 'backdrop', x0: -90, z0: S_FRONT, x1: -56, z1: 34, h: 21, floors: 6, wall: 0xb9a9b0, trim: 0x837b98, roof: 0x77728a, collide: false },
  { id: 'farNE', kind: 'backdrop', x0: 56, z0: -34, x1: 90, z1: N_FRONT, h: 24, floors: 7, wall: 0xb0b4c6, trim: 0x837b98, roof: 0x77728a, collide: false },
  { id: 'farSE', kind: 'backdrop', x0: 56, z0: S_FRONT, x1: 90, z1: 34, h: 23, floors: 6, wall: 0xbfaeb4, trim: 0x837b98, roof: 0x77728a, collide: false },
  {
    id: 'apt1',
    kind: 'apartment',
    x0: -47,
    z0: -52,
    x1: -27,
    z1: -41,
    h: 30,
    floors: 10,
    wall: 0xe8e2da,
    trim: 0xd98f6c,
    roof: 0x8a8f99,
    collide: false,
    signs: [{ side: 's', at: -29.6, y: 26.4, w: 4, h: 2.6, mount: 'paint', sign: { text: '101', bg: 0xd98f6c, fg: 0xffffff } }],
  },
  {
    id: 'apt2',
    kind: 'apartment',
    x0: -21,
    z0: -55,
    x1: -1,
    z1: -44,
    h: 36,
    floors: 12,
    wall: 0xece6de,
    trim: 0x7fa3b5,
    roof: 0x8a8f99,
    collide: false,
    signs: [{ side: 's', at: -3.6, y: 32.2, w: 4, h: 2.6, mount: 'paint', sign: { text: '102', bg: 0x7fa3b5, fg: 0xffffff } }],
  },
  {
    id: 'apt3',
    kind: 'apartment',
    x0: 5,
    z0: -53,
    x1: 25,
    z1: -42,
    h: 33,
    floors: 11,
    wall: 0xe8e2da,
    trim: 0xd98f6c,
    roof: 0x8a8f99,
    collide: false,
    signs: [{ side: 's', at: 22.4, y: 29.3, w: 4, h: 2.6, mount: 'paint', sign: { text: '103', bg: 0xd98f6c, fg: 0xffffff } }],
  },
  {
    id: 'apt4',
    kind: 'apartment',
    x0: 31,
    z0: -56,
    x1: 51,
    z1: -45,
    h: 38,
    floors: 13,
    wall: 0xece6de,
    trim: 0x7fa3b5,
    roof: 0x8a8f99,
    collide: false,
    signs: [{ side: 's', at: 48.4, y: 34.2, w: 4, h: 2.6, mount: 'paint', sign: { text: '104', bg: 0x7fa3b5, fg: 0xffffff } }],
  },
]

/** 교단 건물의 벽(충돌 박스). 문 틈(HQ.gate)만 비워 둔다 */
export const HQ_WALLS: Box[] = [
  { x0: HQ.outer.x0, z0: HQ.outer.z0, x1: HQ.gate.x0, z1: HQ.inside.z0 }, // 앞벽 왼쪽
  { x0: HQ.gate.x1, z0: HQ.outer.z0, x1: HQ.outer.x1, z1: HQ.inside.z0 }, // 앞벽 오른쪽
  { x0: HQ.outer.x0, z0: HQ.inside.z0, x1: HQ.inside.x0, z1: HQ.outer.z1 }, // 서쪽 벽
  { x0: HQ.inside.x1, z0: HQ.inside.z0, x1: HQ.outer.x1, z1: HQ.outer.z1 }, // 동쪽 벽
  { x0: HQ.outer.x0, z0: HQ.inside.z1, x1: HQ.outer.x1, z1: HQ.outer.z1 }, // 뒷벽
]

// ───────────────────────── 소품 ─────────────────────────

/** 광장 중심에서 각도 deg(동쪽 0°, 남쪽 90°), 거리 r 인 점 */
function onPlaza(deg: number, r: number): { x: number; z: number } {
  const a = (deg * Math.PI) / 180
  return { x: PLAZA.x + Math.cos(a) * r, z: PLAZA.z + Math.sin(a) * r }
}
/** (x,z)에서 광장 중심을 바라보는 yaw */
function faceCenter(x: number, z: number): number {
  return Math.atan2(PLAZA.x - x, PLAZA.z - z)
}
const round2 = (v: number): number => Math.round(v * 100) / 100

function plazaBench(deg: number): PropDef {
  const p = onPlaza(deg, 10.3)
  return { kind: 'bench', x: round2(p.x), z: round2(p.z), yaw: faceCenter(p.x, p.z) }
}
function plazaLamp(deg: number): PropDef {
  const p = onPlaza(deg, 11.6)
  return { kind: 'lamp', x: round2(p.x), z: round2(p.z), yaw: faceCenter(p.x, p.z), variant: 'plaza' }
}

const BOOTH_Z = -14.2
const BOOTH_SPOT_Z = -15.6
const BOOTH_X = [17, 21.5, 26] as const

const NORTH_CURB_TREES = [-37.5, -27.5, -16.5, 12, 31.6]
const NORTH_CURB_LAMPS = [-45.5, -32.5, -22, -10.5, 8.5, 17.5, 26.5, 45]
const SOUTH_CURB_TREES = [-37.5, -26.5, -15.5, 30.5, 38.5]
const SOUTH_CURB_LAMPS = [-45.5, -32, -21, -9.5, 6.6, 17.5, 26.5, 35, 45.5]

export const PROPS: PropDef[] = [
  // ── 가로수 / 가로등(차도 쪽 연석을 따라) ──
  ...NORTH_CURB_TREES.map((x, i): PropDef => ({ kind: 'tree', x, z: -6.0, variant: i % 2 === 0 ? 'ginkgo' : 'green' })),
  ...SOUTH_CURB_TREES.map((x, i): PropDef => ({ kind: 'tree', x, z: 6.0, variant: i % 3 === 1 ? 'ginkgo' : 'green' })),
  ...NORTH_CURB_LAMPS.map((x): PropDef => ({ kind: 'lamp', x, z: -5.7, yaw: 0 })),
  ...SOUTH_CURB_LAMPS.map((x): PropDef => ({ kind: 'lamp', x, z: 5.7, yaw: N })),

  // ── 횡단보도: 보행 신호등 4개(맞은편을 본다) ──
  { kind: 'signal', x: -4.9, z: -5.6, yaw: 0 },
  { kind: 'signal', x: 4.9, z: -5.6, yaw: 0 },
  { kind: 'signal', x: -4.9, z: 5.6, yaw: N },
  { kind: 'signal', x: 4.9, z: 5.6, yaw: N },

  // ── 큰길: 주차된 수상한 승합차, 붕어빵 트럭, 길 끝 현수막 ──
  { kind: 'van', x: -31, z: -3.2, yaw: E, color: 0x4b3b78, sign: { text: '기운 측정 출장', sub: '부르면 갑니다', bg: 0x4b3b78, fg: 0xffe08a } },
  { kind: 'truck', x: 22.2, z: 3.3, yaw: W, color: 0x3f7fbf, sign: { text: '황금 붕어빵', sub: '팥 · 슈크림 · 기운', bg: 0xffd24a, fg: 0x7a3b10, icon: 'fish' } },
  {
    kind: 'banner',
    variant: 'road',
    x: -41.5,
    z: 0,
    yaw: E,
    w: 11,
    sign: { text: '차 없는 거리', sub: '차는 없지만 교주는 많음', bg: 0xfff3c4, fg: 0x2f6f4f },
  },
  {
    kind: 'banner',
    variant: 'road',
    x: 41.5,
    z: 0,
    yaw: W,
    w: 11,
    sign: { text: '차 없는 거리', sub: '차는 없지만 교주는 많음', bg: 0xfff3c4, fg: 0x2f6f4f },
  },
  { kind: 'cone', x: -46.6, z: -3 },
  { kind: 'cone', x: -46.6, z: 0 },
  { kind: 'cone', x: -46.6, z: 3 },
  { kind: 'cone', x: 46.6, z: -3 },
  { kind: 'cone', x: 46.6, z: 0 },
  { kind: 'cone', x: 46.6, z: 3 },
  {
    kind: 'barricade',
    x: -48.5,
    z: -1.5,
    yaw: E,
    w: 23,
    deco: true,
    sign: { text: '이 앞은 평범한 동네', sub: '교주 출입 금지 · 돌아가세요', bg: 0xffd24a, fg: 0x2a2a2a },
  },
  {
    kind: 'barricade',
    x: 48.5,
    z: -1.5,
    yaw: W,
    w: 23,
    deco: true,
    sign: { text: '이 앞은 평범한 동네', sub: '교주 출입 금지 · 돌아가세요', bg: 0xffd24a, fg: 0x2a2a2a },
  },

  // ── 지하철 출입구(동쪽 = 광장 쪽으로 열림) ──
  {
    kind: 'subway',
    x: -22.2,
    z: -13,
    yaw: E,
    sign: { text: '수상역 4번 출구', bg: 0x2a2f3a, fg: 0xffffff, icon: 'num4' },
    sign2: { text: '수상역', bg: 0x2a2f3a, fg: 0xffffff, icon: 'num4' },
  },
  { kind: 'totem', x: -19.2, z: -11.2, sign: { text: '수상역', bg: 0xf2c230, fg: 0x23262e, icon: 'num4', vertical: true } },
  { kind: 'vending', x: -29.6, z: -15.2, yaw: E, color: 0xd8483a, sign: { text: '음료', sub: '기운 충전', bg: 0xf7f2e8, fg: 0xd8483a, icon: 'cans' } },

  // ── 쌈지 공원 ──
  { kind: 'tree', x: -26.5, z: -19.5, variant: 'green', r: 0.6 },
  { kind: 'tree', x: -24, z: -27.5, variant: 'ginkgo' },
  { kind: 'tree', x: -27.2, z: -30.8, variant: 'green' },
  { kind: 'tree', x: -15.5, z: -29.5, variant: 'pink' },
  { kind: 'bench', x: -21, z: -24, yaw: E },
  { kind: 'bench', x: -17.6, z: -30.9, yaw: 0 },

  // ── 북쪽 건물 앞 화단 ──
  { kind: 'planter', x: -44, z: -12.5, w: 4, d: 1.0 },
  { kind: 'planter', x: -34.5, z: -12.5, w: 4, d: 1.0 },
  { kind: 'planter', x: 36.5, z: -12.5, w: 4, d: 1.0 },
  { kind: 'planter', x: 44.5, z: -12.5, w: 4, d: 1.0 },

  // ── 광장: 벤치, 조명, 나무, 환영 현수막 ──
  plazaBench(60),
  plazaBench(120),
  plazaBench(225),
  plazaBench(315),
  plazaBench(250),
  plazaBench(290),
  plazaLamp(20),
  plazaLamp(160),
  plazaLamp(200),
  plazaLamp(340),
  { kind: 'tree', x: -9.4, z: -30.4, variant: 'pink' },
  { kind: 'tree', x: 9.4, z: -30.4, variant: 'ginkgo' },
  // 광장 동쪽 귀퉁이의 이용 수칙 게시판(광장 쪽을 본다)
  {
    kind: 'banner',
    variant: 'board',
    x: 13.4,
    z: -27,
    yaw: W,
    w: 3.2,
    sign: { text: '광장 이용 수칙', sub: '포교는 정중히 · 도망은 자유', bg: 0xf6f2ea, fg: 0x3a5a8a },
  },
  {
    kind: 'banner',
    x: 0,
    z: -32.3,
    yaw: 0,
    w: 9,
    sign: { text: '인상 좋은 분 환영', sub: '수상역 광장 포교 연합', bg: 0xffffff, fg: 0x6b4fb3 },
  },

  // ── 포교 부스 거리(남쪽 = 인도를 본다) ──
  { kind: 'booth', x: BOOTH_X[0], z: BOOTH_Z, variant: 'meter', color: 0x7b5ea7, sign: { text: '기운 무료 측정', bg: 0x7b5ea7, fg: 0xffffff } },
  { kind: 'booth', x: BOOTH_X[1], z: BOOTH_Z, variant: 'face', color: 0xe0a030, sign: { text: '관상 봐 드립니다', bg: 0xe0a030, fg: 0x3a2410 } },
  { kind: 'booth', x: BOOTH_X[2], z: BOOTH_Z, variant: 'survey', color: 0x3f8f6b, sign: { text: '30초 설문조사', bg: 0x3f8f6b, fg: 0xffffff } },
  { kind: 'xbanner', x: BOOTH_X[0] + 1.55, z: -13.95, sign: { text: '인상 좋으시네요', bg: 0xf6efff, fg: 0x6b4fb3, vertical: true } },
  { kind: 'xbanner', x: BOOTH_X[1] + 1.55, z: -13.95, sign: { text: '잠깐 시간 되세요', bg: 0xfff3d6, fg: 0x8a4a12, vertical: true } },
  { kind: 'xbanner', x: BOOTH_X[2] + 1.55, z: -13.95, sign: { text: '진짜 30초', bg: 0xe9fff3, fg: 0x2a6a4c, vertical: true } },
  { kind: 'tree', x: 29.8, z: -15.2, variant: 'green' },

  // ── 버스 정류장 ──
  { kind: 'busStop', x: 37.5, z: -6.6, yaw: 0, sign: { text: '버스는 옵니다', sub: '언젠가. — 수상구청', bg: 0xfdf6e3, fg: 0x2f6f8f } },
  { kind: 'signpost', x: 34.6, z: -5.8, yaw: 0, variant: 'bus', sign: { text: '수상역 앞', bg: 0x2f6fbf, fg: 0xffffff } },

  // ── 남쪽 인도: 포장마차, 자판기, 편의점 탁자, 꽃집 화분, 입간판 ──
  { kind: 'stall', x: -8, z: 9.3, yaw: N, sign: { text: '원조 할매 떡볶이', bg: 0xe8552d, fg: 0xfff4c2 } },
  { kind: 'vending', x: -14.9, z: 9.6, yaw: N, color: 0x3a6fbf, sign: { text: '음료', sub: '시원한 기운', bg: 0xf2f6ff, fg: 0x3a6fbf, icon: 'cans' } },
  { kind: 'table', x: -21.5, z: 9.15, yaw: 0, color: 0x6b4fb3 },
  { kind: 'planter', x: 35.8, z: 9.6, w: 3, d: 0.8, variant: 'flowers' },
  { kind: 'signpost', x: 19, z: 9.3, yaw: N, variant: 'aframe', r: 0.3, sign: { text: '오늘만 이 가격', sub: '(매일 이 가격)', bg: 0xfff2b0, fg: 0xd8362a } },
  { kind: 'scooter', x: 25.2, z: 9.25, yaw: 0, color: 0xd8362a },

  // ── 공터: 수상한 천막과 가상 헌금함 ──
  { kind: 'tent', x: TENT.x, z: TENT.z, yaw: N, r: TENT.r, sign: { text: '헌납 환영', sub: '전부 가상 · 진짜 돈 안 받음', bg: 0x3a2a5e, fg: 0xffe08a }, sign2: { text: '', bg: 0x140d24, fg: 0xffe08a, icon: 'eyes' } },
  { kind: 'offering', x: OFFERING.x, z: OFFERING.z, yaw: N, r: OFFERING.r, sign: { text: '가상 헌금함', bg: 0x5a2d1c, fg: 0xffd86a } },
  { kind: 'signpost', x: 4.2, z: 10.7, variant: 'bunting' },
  { kind: 'signpost', x: 15.8, z: 10.7, variant: 'bunting' },
  { kind: 'crate', x: 15.7, z: 12.4, w: 1.6, d: 1.4 },
  { kind: 'crate', x: 4.2, z: 20.7, w: 1.6, d: 1.6, variant: 'flyers' },

  // ── 골목 ──
  { kind: 'wall', x: 3.2, z: 17.25, w: 0.4, d: 8.5, h: 1.9 },
  { kind: 'pole', x: -2.7, z: 11.2 },
  { kind: 'pole', x: 2.7, z: 22.4 },
  { kind: 'trash', x: 2.45, z: 15.2 },
  { kind: 'crate', x: -2.3, z: 18.6, w: 1.4, d: 1.6 },
  { kind: 'lamp', x: -2.7, z: 22.6, yaw: E, variant: 'purple' },
  {
    kind: 'signpost',
    x: 2.45,
    z: 24.85,
    yaw: N,
    variant: 'aframe',
    r: 0.3,
    sign: { text: '관계자 외 출입 금지', sub: '(관계자: 신흥 교단장 이상)', bg: 0x1b1030, fg: 0xffd86a },
  },
  { kind: 'acunit', x: -3, z: 12.6, yaw: E, y: 2.6, deco: true },
  { kind: 'acunit', x: -3, z: 20.6, yaw: E, y: 3.0, deco: true },
  { kind: 'flyer', x: -3, z: 16.8, yaw: E, y: 1.5, deco: true, sign: { text: '도를 아십니까?', bg: 0xfffbe8, fg: 0x6b4fb3 } },
  { kind: 'flyer', x: -3, z: 17.5, yaw: E, y: 1.7, deco: true, sign: { text: '전단지 부착 금지', bg: 0xffffff, fg: 0xd23c3c } },
  { kind: 'flyer', x: 3.0, z: 16.2, yaw: W, y: 1.2, deco: true, sign: { text: '도를 아십니까?', bg: 0xfffbe8, fg: 0x6b4fb3 } },
  { kind: 'flyer', x: 3.0, z: 18.9, yaw: W, y: 1.3, deco: true, sign: { text: '인상이 참 좋으시네요', bg: 0xf3ecff, fg: 0x3a2a5e } },

  // ── 비밀 교단 건물 안: 왕좌, 등불, 방석 ──
  { kind: 'throne', x: 0, z: 32.2, yaw: N, hq: true },
  { kind: 'lantern', x: -1.25, z: 32.5, hq: true },
  { kind: 'lantern', x: 1.25, z: 32.5, hq: true },
  { kind: 'crystal', x: 4.9, z: 31.9, hq: true },
  { kind: 'crate', x: -5.2, z: 32.2, w: 1.6, d: 1.6, variant: 'flyers', hq: true },
  ...[28.4, 30.0].flatMap((z, row) =>
    [-3.9, -1.3, 1.3, 3.9].map((x, i): PropDef => ({ kind: 'cushion', x, z, hq: true, color: (row + i) % 2 === 0 ? 0xb5383f : 0x8a56c8 })),
  ),

  // ── 꾸밈: 광장 비둘기(충돌 없음) ──
  { kind: 'pigeon', x: -3.2, z: -14.6, yaw: 0.6, deco: true },
  { kind: 'pigeon', x: -2.5, z: -14.1, yaw: 2.2, deco: true },
  { kind: 'pigeon', x: -3.9, z: -13.9, yaw: -1.2, deco: true },
  { kind: 'pigeon', x: 6.4, z: -24.6, yaw: 1.9, deco: true },
  { kind: 'pigeon', x: 7.1, z: -25.3, yaw: -2.4, deco: true },
  { kind: 'pigeon', x: -6.7, z: -23.4, yaw: 0.2, deco: true },
  { kind: 'pigeon', x: 3.4, z: -28.1, yaw: -0.7, deco: true },
  { kind: 'pigeon', x: 4.1, z: -27.5, yaw: 2.9, deco: true },
]

// ───────────────────────── 시작 위치 / 부스 자리 ─────────────────────────

/** 지하철 출구를 막 나온 자리. 캐노피가 카메라를 가리지 않도록 출구에서 3.4m 이상 떨어뜨렸다 */
const SPAWN_POINTS: [number, number][] = [
  [-15.2, -15.2],
  [-13.6, -15.2],
  [-12.0, -15.2],
  [-16.0, -13.6],
  [-14.4, -13.6],
  [-12.8, -13.6],
  [-15.2, -12.0],
  [-13.6, -12.0],
  [-12.0, -12.0],
  [-14.4, -10.4],
]
const SPAWNS: Spot[] = SPAWN_POINTS.map(([x, z]) => ({ x, z, yaw: faceCenter(x, z) }))

/** 부스 자리 = 포교하는 사람이 탁자 뒤에 서는 곳(손님 쪽 = 남쪽을 본다) */
const BOOTHS: Spot[] = BOOTH_X.map((x) => ({ x, z: BOOTH_SPOT_Z, yaw: 0 }))

// ───────────────────────── NPC 이동망 ─────────────────────────

type NavSeed = [name: string, x: number, z: number, kind: NavKind]

const RING = 8.2 // 광장 바깥 고리
const INNER = 5.6 // 단상 둘레 안쪽 고리(경사로 바깥)
const ringPt = (deg: number, r: number): [number, number] => {
  const p = onPlaza(deg, r)
  return [round2(p.x), round2(p.z)]
}

const NAV_NODES: NavSeed[] = [
  // 북쪽 인도(서 → 동)
  ['n0', -46, -8.2, 'exit'],
  ['n1', -39, -8.4, 'walk'],
  ['n2', -31, -8.4, 'walk'],
  ['n3', -23, -8.4, 'walk'],
  ['n4', -15, -8.4, 'walk'],
  ['n5', -6.5, -8.2, 'walk'],
  ['n6', 6.5, -8.2, 'walk'],
  ['n7', 14, -8.4, 'walk'],
  ['n8', 22, -8.4, 'walk'],
  ['n9', 30, -8.6, 'walk'],
  ['n10', 37.5, -9.0, 'rest'], // 버스 기다리기
  ['n11', 46, -8.2, 'exit'],
  // 횡단보도(두 줄)
  ['cn1', -2, -6.4, 'walk'],
  ['cn2', 2, -6.4, 'walk'],
  ['cm1', -2, 0, 'cross'],
  ['cm2', 2, 0, 'cross'],
  ['cs1', -2, 6.6, 'walk'],
  ['cs2', 2, 6.6, 'walk'],
  // 남쪽 인도(서 → 동)
  ['s0', -46, 7.4, 'exit'],
  ['s1', -39, 7.4, 'walk'],
  ['s2', -31.5, 7.8, 'shop'], // 약국·미용실 앞
  ['s3', -25, 7.4, 'walk'],
  ['s4', -18.5, 7.8, 'shop'], // 편의점 문 앞
  ['s5', -12.5, 7.4, 'walk'],
  ['sT', -8, 7.2, 'shop'], // 떡볶이 포장마차
  ['s6', -4.5, 7.4, 'walk'],
  ['s7', 4.5, 7.4, 'walk'],
  ['s8', 10.6, 8.4, 'walk'], // 공터 입구
  ['s9', 18, 7.4, 'walk'],
  ['sK', 22.2, 6.5, 'shop'], // 붕어빵 트럭
  ['s10', 26.5, 7.8, 'walk'],
  ['s11', 33, 7.8, 'shop'], // 세탁소·꽃집 앞
  ['s12', 40, 7.4, 'walk'],
  ['s13', 46, 7.4, 'exit'],
  // 공터와 골목 어귀(NPC 는 교단 건물까지 들어가지 않는다)
  ['l1', 8.2, 11.6, 'shop'], // 헌금함 구경
  ['l2', 5.6, 15.5, 'walk'],
  ['a1', 0, 11.8, 'walk'],
  ['a2', 0, 17.5, 'walk'],
  // 지하철 출구와 쌈지 공원
  ['sub', SUBWAY.x, SUBWAY.z, 'exit'],
  ['g1', -13.8, -13.4, 'walk'],
  ['g2', -17.5, -19, 'walk'],
  ['g3', -19.4, -24, 'rest'],
  // 광장: 남쪽 들머리, 바깥 고리 8, 안쪽 고리 4, 벤치 앞, 동쪽 들머리
  ['pg', 0, -10.4, 'plaza'],
  ['pE', ...ringPt(0, RING), 'plaza'],
  ['pSE', ...ringPt(45, RING), 'plaza'],
  ['pS', ...ringPt(90, RING), 'plaza'],
  ['pSW', ...ringPt(135, RING), 'plaza'],
  ['pW', ...ringPt(180, RING), 'plaza'],
  ['pNW', ...ringPt(225, RING), 'plaza'],
  ['pN', ...ringPt(270, RING), 'plaza'],
  ['pNE', ...ringPt(315, RING), 'plaza'],
  ['iE', ...ringPt(0, INNER), 'plaza'],
  ['iS', ...ringPt(90, INNER), 'plaza'],
  ['iW', ...ringPt(180, INNER), 'plaza'],
  ['iN', ...ringPt(270, INNER), 'plaza'],
  ['r60', ...ringPt(60, 9.2), 'rest'],
  ['r120', ...ringPt(120, 9.2), 'rest'],
  ['r225', ...ringPt(225, 9.2), 'rest'],
  ['r315', ...ringPt(315, 9.2), 'rest'],
  ['eg', 12.6, -19.5, 'plaza'],
  ['bw', 13.6, -14.0, 'walk'], // 부스 거리 서쪽 어귀
  // 포교 부스 앞
  ['b1', BOOTH_X[0], -12.4, 'shop'],
  ['b2', BOOTH_X[1], -12.4, 'shop'],
  ['b3', BOOTH_X[2], -12.4, 'shop'],
]

const NAV_EDGES: [string, string][] = [
  // 북쪽 인도
  ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'], ['n5', 'n6'],
  ['n6', 'n7'], ['n7', 'n8'], ['n8', 'n9'], ['n9', 'n10'], ['n10', 'n11'],
  // 횡단보도
  ['n5', 'cn1'], ['n6', 'cn2'], ['cn1', 'cn2'], ['cn1', 'cm1'], ['cm1', 'cs1'],
  ['cn2', 'cm2'], ['cm2', 'cs2'], ['cs1', 'cs2'], ['cs1', 's6'], ['cs2', 's7'],
  // 남쪽 인도
  ['s0', 's1'], ['s1', 's2'], ['s2', 's3'], ['s3', 's4'], ['s4', 's5'], ['s3', 's5'], ['s5', 'sT'],
  ['sT', 's6'], ['s6', 's7'], ['s7', 's8'], ['s8', 's9'], ['s9', 'sK'], ['sK', 's10'], ['s9', 's10'],
  ['s10', 's11'], ['s11', 's12'], ['s12', 's13'],
  // 공터 / 골목
  ['s8', 'l1'], ['l1', 'l2'], ['s7', 'a1'], ['s6', 'a1'], ['a1', 'a2'], ['a1', 'l1'],
  // 지하철 / 공원
  ['sub', 'g1'], ['g1', 'n4'], ['g1', 'pSW'], ['sub', 'g2'], ['g2', 'g3'], ['g2', 'pW'], ['g3', 'pW'],
  // 광장
  ['pg', 'cn1'], ['pg', 'cn2'], ['pg', 'pS'],
  ['pE', 'pSE'], ['pSE', 'pS'], ['pS', 'pSW'], ['pSW', 'pW'], ['pW', 'pNW'], ['pNW', 'pN'], ['pN', 'pNE'], ['pNE', 'pE'],
  ['iE', 'pE'], ['iS', 'pS'], ['iW', 'pW'], ['iN', 'pN'],
  ['iE', 'iS'], ['iS', 'iW'], ['iW', 'iN'], ['iN', 'iE'],
  ['r60', 'pSE'], ['r120', 'pSW'], ['r225', 'pNW'], ['r315', 'pNE'],
  ['pE', 'eg'],
  // 부스 거리
  ['eg', 'bw'], ['bw', 'b1'], ['bw', 'n7'], ['pSE', 'b1'], ['b1', 'b2'], ['b2', 'b3'], ['b1', 'n7'], ['b2', 'n8'], ['b3', 'n9'],
]

function buildNav(): { nodes: NavNode[]; edges: [number, number][] } {
  const index = new Map<string, number>()
  const nodes: NavNode[] = NAV_NODES.map(([name, x, z, kind], i) => {
    index.set(name, i)
    return { x, z, kind }
  })
  const edges: [number, number][] = NAV_EDGES.map(([a, b]) => {
    const ia = index.get(a)
    const ib = index.get(b)
    // 이름 오타는 조용히 넘어가면 NPC 가 끊긴 길에 갇히므로 바로 터뜨린다
    if (ia === undefined || ib === undefined) throw new Error(`nav edge 이름 오류: ${a} - ${b}`)
    return [ia, ib]
  })
  return { nodes, edges }
}

// ───────────────────────── 충돌체 조립 ─────────────────────────

function buildColliders(): { boxes: Box[]; circles: Circle[] } {
  const boxes: Box[] = [
    // 북쪽 경계 담(생울타리)
    { x0: BOUNDS.x0, z0: BOUNDS.z0, x1: BOUNDS.x1, z1: LAYOUT.northWall },
  ]
  const circles: Circle[] = []
  for (const b of BUILDINGS) {
    if (!b.collide) continue
    if (b.kind === 'hq') boxes.push(...HQ_WALLS)
    else boxes.push({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 })
  }
  for (const p of PROPS) {
    const c = propColliders(p)
    boxes.push(...c.boxes)
    circles.push(...c.circles)
  }
  return { boxes, circles }
}

const COLLIDERS = buildColliders()

export const WORLD: WorldDef = {
  bounds: BOUNDS,
  boxes: COLLIDERS.boxes,
  circles: COLLIDERS.circles,
  podium: PODIUM,
  plaza: PLAZA,
  offeringBox: OFFERING,
  tent: TENT,
  subway: SUBWAY,
  booths: BOOTHS,
  hq: {
    // 문 앞에 서는 자리(직급 안내를 띄울 범위)
    door: { x: 0, z: 24.4, r: 1.5 },
    gate: { ...HQ.gate },
    inside: { ...HQ.inside },
    minRank: 3,
  },
  spawns: SPAWNS,
  nav: buildNav(),
}
