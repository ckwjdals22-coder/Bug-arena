/**
 * 캐릭터 부위 지오메트리 정의. 전부 코드로 만든다(에셋 파일 없음).
 *
 * 풀 하나가 여러 변형을 품는다(geo.ts, pools.ts 참고). 변형 번호는 아래 상수로 고른다.
 * 좌표: 캐릭터는 +Z 를 바라보고, +X 가 캐릭터의 왼쪽, Y 가 위. 단위 m.
 *
 * 세밀도(Detail): 0 = 품질 low, 1 = 게임 화면(10m 밖에서 보므로 분할을 아낀다), 2 = 초상(가까이서 크게 그린다)
 */
import * as THREE from 'three'
import { GeoBuilder, MASK_A, MASK_B, TRS, box, cone, cyl, lathe, poly, seeded, sphere, strip, torus } from './geo'
import type { AddOpts } from './geo'

export type Detail = 0 | 1 | 2

/** 몸 치수. 전체 키 1.5m, 머리 지름 약 0.75m 의 2등신 */
export const DIM = {
  /** 엉덩이(다리 붙는 곳) 높이 */
  HIP_Y: 0.33,
  /** 엉덩이 → 목 */
  NECK_Y: 0.47,
  /** 목 → 머리 중심 */
  HEAD_UP: 0.34,
  HEAD_RX: 0.385,
  HEAD_RY: 0.36,
  HEAD_RZ: 0.37,
  SHOULDER_X: 0.215,
  SHOULDER_Y: 0.4,
  /** 어깨 → 손 중심 */
  ARM_LEN: 0.275,
  HIP_X: 0.105,
} as const

export const HAIR = { Short: 0, Part: 1, Messy: 2, Bob: 3, Slick: 4, Comb: 5, Knot: 6, Cap: 7 } as const
export const TORSO = { Shirt: 0, Hoodie: 1, Suit: 2, Vest: 3, Hanbok: 4, Robe: 5, Slim: 6, Mantle: 7, Cape: 8 } as const
export const ARM = { Long: 0, Short: 1, Wide: 2 } as const
export const LEG = { Pants: 0, Feet: 1, Baggy: 2, Boots: 3 } as const
/** 얼굴 단위 도형(곡면 위에 얹는 납작한 조각) */
export const FACE = { Dot: 0, Arc: 1, Bar: 2, Half: 3 } as const
/** 머리에 맞춰 만든 얼굴 덩어리 */
export const FACEFIT = { Glasses: 0, Moustache: 1, Beard: 2 } as const
export const ACC = { Sash: 1, Beads: 2, Backpack: 3, Megaphone: 4, Chain: 5, Flyer: 6 } as const
export const CAT = { Body: 0, Head: 1, Leg: 2, Tail: 3 } as const
/** 모자 변형 번호 = HATS 카탈로그 id (1..10). 반투명 풀은 갓(3)과 UFO 광선(10)만 가진다 */

const PI = Math.PI
/** 몸통은 앞뒤로 살짝 납작하다 */
const ZS = 0.8

type Profile = readonly (readonly [number, number])[]

function lv(d: Detail, a: number, b: number, c: number): number {
  return d === 0 ? a : d === 1 ? b : c
}

/** 이동 · 크기 · 회전(= 회전한 뒤 크기). 타원체 위에 정확히 얹히는 머리카락 캡에 필요하다 */
function TSR(px: number, py: number, pz: number, sx: number, sy: number, sz: number, rx: number, ry = 0, rz = 0): THREE.Matrix4 {
  const r = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'))
  const s = new THREE.Matrix4().makeScale(sx, sy, sz)
  return new THREE.Matrix4().makeTranslation(px, py, pz).multiply(s).multiply(r)
}

/** 두 점을 잇는 원통(꼬리 등) */
function limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r0: number, r1: number, seg: number): [THREE.BufferGeometry, THREE.Matrix4] {
  const a = new THREE.Vector3(ax, ay, az)
  const b = new THREE.Vector3(bx, by, bz)
  const dir = b.clone().sub(a)
  const len = dir.length()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1))
  return [cyl(r1, r0, len, seg, true), m]
}

/** 면을 뒤집어 안쪽 면을 만든다(망토 안감 등) */
function inside(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.index
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1)
      idx.setX(i + 1, idx.getX(i + 2))
      idx.setX(i + 2, a)
    }
  }
  const n = g.getAttribute('normal')
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
  return g
}

function circlePts(n: number, rx: number, ry = rx, cx = 0, cy = 0): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
  }
  return out
}

function starPts(points: number, rOuter: number, rInner: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = PI / 2 + (i * PI) / points
    out.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  return out
}

function rect(xa: number, ya: number, xb: number, yb: number): [number, number][] {
  return [
    [xa, ya],
    [xb, ya],
    [xb, yb],
    [xa, yb],
  ]
}

/** 프로파일(아래→위)에서 높이 y 의 반지름 */
function rAt(profile: Profile, y: number): number {
  for (let k = 0; k < profile.length - 1; k++) {
    const p0 = profile[k]!
    const p1 = profile[k + 1]!
    if (p1[1] > p0[1] && y >= p0[1] && y <= p1[1]) return p0[0] + ((p1[0] - p0[0]) * (y - p0[1])) / (p1[1] - p0[1])
  }
  return y < profile[0]![1] ? profile[0]![0] : profile[profile.length - 1]![0]
}

/**
 * 몸 앞면에 납작한 조각(넥타이, 깃, 주머니 …)을 붙인다.
 * 손으로 깊이를 맞추면 몸통 곡면에 파묻히거나 떠 버리기 쉬워서, 프로파일에서 표면 깊이를 계산해
 * 조각의 위·아래 끝이 표면에서 margin 만큼만 뜨도록 기울인다.
 */
function frontOn(b: GeoBuilder, profile: Profile, pts: Profile, margin: number, o: AddOpts): void {
  let y0 = Infinity
  let y1 = -Infinity
  let x0 = Infinity
  let x1 = -Infinity
  for (const p of pts) {
    y0 = Math.min(y0, p[1])
    y1 = Math.max(y1, p[1])
    x0 = Math.min(x0, p[0])
    x1 = Math.max(x1, p[0])
  }
  const xRef = x0 <= 0 && x1 >= 0 ? 0 : Math.min(Math.abs(x0), Math.abs(x1))
  const zAt = (y: number): number => {
    const r = rAt(profile, y)
    return ZS * Math.sqrt(Math.max(0, r * r - xRef * xRef))
  }
  const zA = zAt(y1)
  const zB = zAt(y0)
  const k = (zA - zB) / (y1 - y0)
  let bulge = 0
  for (let i = 1; i < 8; i++) {
    const y = y0 + ((y1 - y0) * i) / 8
    bulge = Math.max(bulge, zAt(y) - (zB + k * (y - y0)))
  }
  const m = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, k, 1, zB - k * y0 + margin + bulge, 0, 0, 0, 1)
  b.add(poly(pts), m, o)
}

// ───────────────────────── 머리 + 머리카락 ─────────────────────────

export function buildHead(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const ws = lv(d, 10, 12, 20)
  const hs = lv(d, 7, 8, 13)
  const capRings = lv(d, 3, 4, 7)
  const bw = lv(d, 5, 6, 10)
  const bh = lv(d, 3, 4, 7)
  const { HEAD_RX: RX, HEAD_RY: RY, HEAD_RZ: RZ } = DIM

  // 두상 + 귀 (주색 = 피부)
  b.add(sphere(1, ws, hs), TRS(0, 0, 0, 0, 0, 0, RX, RY, RZ), { mask: MASK_A })
  for (const s of [-1, 1]) {
    b.add(sphere(1, bw, bh), TRS(s * 0.378, -0.045, 0.0, 0, 0, 0, 0.05, 0.075, 0.06), { mask: MASK_A, mul: 0.9 })
  }

  // 정수리 쪽을 살짝 밝게: 위에서 내려다보는 게임 시점에서 머리가 시커먼 덩어리로 뭉개지지 않는다
  const hairShade = (_x: number, y: number): number => 0.84 + 0.34 * Math.min(1, Math.max(0, (y - 0.1) / 0.28))
  /** 뒤로 기울인 반구 캡. tilt 가 클수록(음수) 이마가 넓어진다 */
  const cap = (tilt: number, thLen: number, grow = 1.06): void => {
    b.add(sphere(1, ws, capRings, 0, PI * 2, 0, thLen), TSR(0, 0.004, -0.004, RX * grow, RY * (grow + 0.012), RZ * grow, tilt), { mask: MASK_B, shade: hairShade })
  }
  const blob = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0, mul = 1): void => {
    b.add(sphere(1, bw, bh), TRS(x, y, z, rx, ry, rz, sx, sy, sz), { mask: MASK_B, mul, shade: hairShade })
  }

  // 0 기본: 단정한 짧은 머리 + 앞머리 두 덩이
  b.variant = HAIR.Short
  cap(-0.5, 0.52 * PI)
  blob(0.13, 0.215, 0.275, 0.17, 0.085, 0.1, 0.5, 0, -0.2)
  blob(-0.13, 0.2, 0.285, 0.15, 0.08, 0.09, 0.55, 0, 0.3)

  // 1 가르마: 한쪽으로 넘긴 큰 앞머리
  b.variant = HAIR.Part
  cap(-0.62, 0.5 * PI)
  blob(0.1, 0.265, 0.215, 0.23, 0.1, 0.17, 0.35, 0, -0.35)
  blob(-0.22, 0.2, 0.2, 0.11, 0.075, 0.12, 0.3, 0, 0.5)

  // 2 까치집: 삐죽삐죽 + 더듬이 한 가닥
  b.variant = HAIR.Messy
  cap(-0.5, 0.52 * PI)
  blob(0.0, 0.215, 0.28, 0.22, 0.075, 0.09, 0.55)
  const spike = (x: number, y: number, z: number, rx: number, rz: number, h: number, r: number): void => {
    b.add(cone(r, h, 4), TRS(x, y, z, rx, 0, rz), { mask: MASK_B, flat: true })
  }
  spike(-0.19, 0.36, -0.03, -0.2, 0.75, 0.2, 0.085)
  spike(0.22, 0.33, -0.08, -0.35, -0.85, 0.19, 0.08)
  spike(0.03, 0.4, -0.14, -0.7, 0.1, 0.2, 0.085)
  spike(-0.3, 0.2, -0.16, -0.5, 1.2, 0.16, 0.07)
  spike(0.05, 0.44, 0.06, 0.45, -0.25, 0.2, 0.035)

  // 3 단발: 일자 앞머리 + 옆머리 + 머리핀
  b.variant = HAIR.Bob
  cap(-0.42, 0.56 * PI, 1.08)
  blob(0, 0.185, 0.29, 0.29, 0.075, 0.1, 0.5)
  for (const s of [-1, 1]) blob(s * 0.345, -0.13, 0.02, 0.09, 0.2, 0.18)
  b.add(poly(starPts(5, 0.055, 0.026)), TRS(0.27, 0.21, 0.292, -0.25, 0.75, 0.2), { color: 0xffd23f })

  // 4 올백: 이마를 드러내고 앞을 세운 머리
  b.variant = HAIR.Slick
  cap(-0.74, 0.5 * PI)
  blob(0, 0.345, 0.14, 0.21, 0.1, 0.18, -0.25)

  // 5 바코드: 옆·뒤만 남고 정수리에 몇 가닥
  b.variant = HAIR.Comb
  b.add(sphere(1, ws, lv(d, 2, 2, 4), (145 / 180) * PI, (250 / 180) * PI, 0.37 * PI, 0.27 * PI), TRS(0, 0, 0, 0, 0, 0, RX * 1.045, RY * 1.045, RZ * 1.045), {
    mask: MASK_B,
  })
  for (const rx of [0.5, 0.05, -0.42]) {
    b.add(torus(1, 0.04, 3, lv(d, 6, 8, 14), PI), TRS(0, 0, 0, rx, 0, 0, RX * 1.012, RY * 1.012, 0.42), { mask: MASK_B })
  }

  // 6 상투: 흰 머리를 올려 묶은 도사
  b.variant = HAIR.Knot
  cap(-0.62, 0.5 * PI)
  b.add(cyl(0.05, 0.065, 0.07, lv(d, 5, 6, 10)), TRS(0, 0.385, -0.03), { mask: MASK_B, mul: 0.85 })
  blob(0, 0.455, -0.03, 0.085, 0.075, 0.085)

  // 7 모자 속 머리: 모자를 뚫고 나오지 않는 평범한 캡
  b.variant = HAIR.Cap
  cap(-0.5, 0.52 * PI, 1.045)

  return b.build()
}

// ───────────────────────── 몸통 ─────────────────────────

const P_PANTS: Profile = [
  [0, -0.05],
  [0.13, -0.05],
  [0.205, -0.02],
  [0.224, 0.035],
]
const P_SHIRT: Profile = [
  [0.232, 0.03],
  [0.232, 0.1],
  [0.22, 0.24],
  [0.198, 0.36],
  [0.166, 0.44],
  [0.1, 0.49],
  [0, 0.5],
]
const P_HOODIE: Profile = [
  [0.243, 0.02],
  [0.248, 0.1],
  [0.236, 0.25],
  [0.212, 0.37],
  [0.172, 0.45],
  [0.1, 0.5],
  [0, 0.51],
]
const P_VEST: Profile = [
  [0.238, 0.025],
  [0.24, 0.1],
  [0.228, 0.25],
  [0.214, 0.33],
  [0.204, 0.38],
  [0.17, 0.45],
  [0.1, 0.5],
  [0, 0.51],
]
const P_HANBOK: Profile = [
  [0.266, 0.045],
  [0.25, 0.11],
  [0.226, 0.25],
  [0.2, 0.37],
  [0.166, 0.45],
  [0.1, 0.5],
  [0, 0.51],
]
const P_ROBE: Profile = [
  [0, -0.272],
  [0.3, -0.272],
  [0.345, -0.25],
  [0.318, -0.12],
  [0.27, 0.02],
  [0.238, 0.13],
  [0.222, 0.26],
  [0.2, 0.37],
  [0.166, 0.45],
  [0.1, 0.5],
  [0, 0.51],
]
const P_SLIM: Profile = [
  [0, -0.05],
  [0.13, -0.05],
  [0.205, -0.02],
  [0.222, 0.03],
  [0.226, 0.1],
  [0.214, 0.24],
  [0.194, 0.36],
  [0.164, 0.44],
  [0.1, 0.49],
  [0, 0.5],
]

export function buildTorso(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 8, 10, 16)
  const body = (profile: Profile, o: AddOpts = {}): void => {
    b.add(lathe(profile, seg), TRS(0, 0, 0, 0, 0, 0, 1, 1, ZS), o)
  }

  // 0 셔츠(평범한 시민): 주색 셔츠 + 가슴 주머니, 허리 아래는 바지색
  b.variant = TORSO.Shirt
  body(P_PANTS, { mask: MASK_B })
  body(P_SHIRT, { mask: MASK_A })
  frontOn(b, P_SHIRT, rect(0.045, 0.25, 0.125, 0.33), 0.004, { mask: MASK_A, mul: 0.76 })

  // 1 후드티: 앞주머니 + 모자 + 끈
  b.variant = TORSO.Hoodie
  body(P_PANTS, { mask: MASK_B })
  body(P_HOODIE, { mask: MASK_A })
  body(
    [
      [0.244, 0.012],
      [0.254, 0.04],
      [0.246, 0.07],
    ],
    { mask: MASK_A, mul: 0.72 },
  )
  b.add(box(0.21, 0.09, 0.04), TRS(0, 0.15, 0.183, -0.05), { mask: MASK_A, mul: 0.72 })
  b.add(sphere(1, lv(d, 6, 6, 10), lv(d, 4, 4, 6)), TRS(0, 0.45, -0.125, 0, 0, 0, 0.215, 0.105, 0.135), { mask: MASK_A, mul: 0.84 })
  for (const s of [-1, 1]) frontOn(b, P_HOODIE, rect(s * 0.045 - 0.009, 0.28, s * 0.045 + 0.009, 0.41), 0.005, { color: 0xf6f4ee })

  // 2 정장 셔츠(수상한 전도사): 흰 셔츠 + 검은 넥타이 + 어두운 바지
  b.variant = TORSO.Suit
  body(P_PANTS, { mask: MASK_B })
  body(P_SHIRT, { mask: MASK_A })
  body(
    [
      [0.234, 0.028],
      [0.24, 0.05],
      [0.234, 0.072],
    ],
    { color: 0x16141c },
  )
  b.add(box(0.05, 0.038, 0.014), TRS(0, 0.05, 0.193), { color: 0xc9ced6 })
  // 넥타이: 매듭 + 아래로 넓어지는 몸통(머리에 가려도 보이게 굵고 길게)
  frontOn(
    b,
    P_SHIRT,
    [
      [-0.028, 0.395],
      [0.028, 0.395],
      [0.045, 0.455],
      [-0.045, 0.455],
    ],
    0.01,
    { color: 0x16141c },
  )
  frontOn(
    b,
    P_SHIRT,
    [
      [-0.026, 0.41],
      [-0.058, 0.16],
      [0, 0.09],
      [0.058, 0.16],
      [0.026, 0.41],
    ],
    0.006,
    { color: 0x1b1922 },
  )

  // 3 등산복: 주색 재킷 + 검은 어깨 + 형광 띠 + 지퍼
  b.variant = TORSO.Vest
  body(P_PANTS, { mask: MASK_B })
  body(P_VEST.slice(0, 4), { mask: MASK_A })
  body(P_VEST.slice(3), { color: 0x2b2d36 })
  body(
    [
      [0.244, 0.19],
      [0.242, 0.23],
    ],
    { color: 0xd9ff4a },
  )
  frontOn(b, P_VEST, rect(-0.011, 0.03, 0.011, 0.36), 0.008, { color: 0xeeeeea })
  frontOn(b, P_VEST, rect(0.06, 0.265, 0.125, 0.305), 0.005, { color: 0xffffff })

  // 4 개량한복: 여민 깃(흰 동정) + 퍼진 밑단 + 고름
  b.variant = TORSO.Hanbok
  body(
    [
      [0, -0.05],
      [0.15, -0.05],
      [0.226, -0.02],
      [0.238, 0.055],
    ],
    { mask: MASK_B },
  )
  body(P_HANBOK, { mask: MASK_A })
  // 깃: 캐릭터 왼쪽 어깨에서 오른쪽 허리로 내려오는 진한 띠 + 반대쪽 짧은 깃 + 그 위 흰 동정
  frontOn(
    b,
    P_HANBOK,
    [
      [0.02, 0.46],
      [0.09, 0.46],
      [-0.07, 0.13],
      [-0.14, 0.13],
    ],
    0.005,
    { mask: MASK_A, mul: 0.58 },
  )
  frontOn(
    b,
    P_HANBOK,
    [
      [-0.02, 0.46],
      [-0.005, 0.385],
      [-0.05, 0.36],
      [-0.085, 0.46],
    ],
    0.004,
    { mask: MASK_A, mul: 0.58 },
  )
  frontOn(
    b,
    P_HANBOK,
    [
      [0.038, 0.462],
      [0.072, 0.462],
      [-0.028, 0.255],
      [-0.062, 0.255],
    ],
    0.009,
    { color: 0xfbfaf5 },
  )
  // 고름
  b.add(box(0.032, 0.15, 0.012), TRS(-0.09, 0.15, 0.197, -0.1, 0, 0.12), { color: 0x8a2f3f })
  b.add(box(0.032, 0.11, 0.012), TRS(-0.055, 0.17, 0.203, -0.1, 0, -0.2), { color: 0x8a2f3f })
  b.add(box(0.05, 0.04, 0.02), TRS(-0.075, 0.235, 0.197, -0.1), { color: 0x73263a })

  // 5 도복/로브: 다리를 덮는 종 모양. 보조색 = 허리띠·깃
  b.variant = TORSO.Robe
  body(P_ROBE, { mask: MASK_A, shade: (_x, y) => (y < 0.02 ? 1 - 0.22 * Math.min(1, (0.02 - y) / 0.29) : 1) })
  body(
    [
      [0.242, 0.1],
      [0.254, 0.125],
      [0.252, 0.17],
      [0.238, 0.195],
    ],
    { mask: MASK_B },
  )
  b.add(box(0.075, 0.06, 0.04), TRS(0.03, 0.148, 0.205), { mask: MASK_B, mul: 0.9 })
  b.add(box(0.04, 0.15, 0.016), TRS(0.005, 0.055, 0.226, -0.16, 0, 0.1), { mask: MASK_B })
  b.add(box(0.04, 0.12, 0.016), TRS(0.065, 0.07, 0.219, -0.16, 0, -0.18), { mask: MASK_B, mul: 0.9 })
  frontOn(
    b,
    P_ROBE,
    [
      [0.03, 0.46],
      [0.09, 0.46],
      [-0.04, 0.195],
      [-0.1, 0.195],
    ],
    0.006,
    { mask: MASK_B },
  )
  frontOn(
    b,
    P_ROBE,
    [
      [-0.03, 0.46],
      [0.0, 0.39],
      [-0.045, 0.37],
      [-0.09, 0.46],
    ],
    0.004,
    { mask: MASK_B, mul: 0.9 },
  )

  // 6 슬림 슈트(망토 복장의 몸): 보조색 벨트 + 가슴의 별
  b.variant = TORSO.Slim
  body(P_SLIM, { mask: MASK_A })
  body(
    [
      [0.224, 0.03],
      [0.238, 0.055],
      [0.23, 0.085],
    ],
    { mask: MASK_B },
  )
  b.add(box(0.06, 0.05, 0.014), TRS(0, 0.057, 0.193), { mask: MASK_B, mul: 1.2 })
  frontOn(
    b,
    P_SLIM,
    starPts(5, 0.075, 0.032).map(([x, y]) => [x, y + 0.27] as [number, number]),
    0.006,
    { mask: MASK_B },
  )

  // 7 망토 깃(황금 로브 위의 어깨 덮개): 흰 털 테두리 + 보석
  b.variant = TORSO.Mantle
  const mantleM = (): THREE.Matrix4 => TRS(0, 0, 0, 0, 0, 0, 1, 1, 0.86)
  b.add(
    lathe(
      [
        [0.31, 0.3],
        [0.322, 0.335],
        [0.25, 0.43],
        [0.15, 0.5],
      ],
      seg,
    ),
    mantleM(),
    { mask: MASK_A },
  )
  b.add(
    lathe(
      [
        [0.312, 0.285],
        [0.336, 0.31],
        [0.324, 0.345],
      ],
      seg,
    ),
    mantleM(),
    { color: 0xfbfaf5 },
  )
  b.add(sphere(0.042, lv(d, 5, 6, 8), lv(d, 3, 4, 6)), TRS(0, 0.39, 0.235), { color: 0x3fd0c9 })

  // 8 망토: 등 뒤로 흘러내리는 반원뿔 + 세운 깃 + 반짝이
  b.variant = TORSO.Cape
  const capeProfile: Profile = [
    [0.4, -0.25],
    [0.36, -0.05],
    [0.29, 0.16],
    [0.25, 0.33],
    [0.215, 0.44],
    [0.19, 0.49],
  ]
  const capeSpan = 3.7
  const capeM = (): THREE.Matrix4 => TRS(0, 0, -0.02, 0, 0, 0, 1, 1, 0.92)
  const capeSeg = lv(d, 6, 8, 12)
  b.add(lathe(capeProfile, capeSeg, PI - capeSpan / 2, capeSpan), capeM(), {
    mask: MASK_A,
    shade: (_x, y) => 0.8 + 0.2 * Math.min(1, Math.max(0, (y + 0.25) / 0.7)),
  })
  b.add(inside(lathe(capeProfile, capeSeg, PI - capeSpan / 2, capeSpan)), capeM(), { mask: MASK_A, mul: 0.5 })
  const collar: Profile = [
    [0.2, 0.44],
    [0.29, 0.54],
    [0.33, 0.63],
  ]
  b.add(lathe(collar, capeSeg, PI - 1.45, 2.9), capeM(), { mask: MASK_A })
  b.add(inside(lathe(collar, capeSeg, PI - 1.45, 2.9)), capeM(), { mask: MASK_A, mul: 0.55 })
  // 반짝이: 등 쪽 바깥면에 박힌 작은 별
  const rnd = seeded(7)
  for (let i = 0; i < lv(d, 5, 8, 10); i++) {
    const phi = PI + (rnd() - 0.5) * 2.6
    const y = -0.18 + rnd() * 0.5
    const rr = rAt(capeProfile, y) + 0.014
    const size = 0.035 + rnd() * 0.03
    b.add(poly(starPts(4, size, size * 0.3)), TRS(rr * Math.sin(phi), y, rr * Math.cos(phi) * 0.92 - 0.02, 0, phi, rnd() * 1.5), { color: 0xfffbe0 })
  }

  return b.build()
}

// ───────────────────────── 팔 ─────────────────────────

export function buildArm(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 6, 7, 12)
  const hand = (y: number, r: number): void => {
    b.add(sphere(1, lv(d, 5, 6, 10), lv(d, 3, 4, 7)), TRS(0, y, 0, 0, 0, 0, r, r, r), { mask: MASK_B })
  }

  // 0 긴소매
  b.variant = ARM.Long
  b.add(
    lathe(
      [
        [0, 0.072],
        [0.05, 0.058],
        [0.08, 0.012],
        [0.076, -0.08],
        [0.068, -0.215],
      ],
      seg,
    ),
    null,
    { mask: MASK_A },
  )
  hand(-0.275, 0.078)

  // 1 반소매: 소매 아래로 맨팔
  b.variant = ARM.Short
  b.add(
    lathe(
      [
        [0, 0.072],
        [0.05, 0.058],
        [0.084, 0.012],
        [0.088, -0.06],
        [0.09, -0.105],
      ],
      seg,
    ),
    null,
    { mask: MASK_A },
  )
  b.add(
    lathe(
      [
        [0.063, -0.08],
        [0.058, -0.23],
      ],
      seg,
    ),
    null,
    { mask: MASK_B },
  )
  hand(-0.275, 0.078)

  // 2 넓은 소매(도복/한복): 손끝만 살짝 나온다
  b.variant = ARM.Wide
  b.add(
    lathe(
      [
        [0, 0.072],
        [0.05, 0.058],
        [0.082, 0.012],
        [0.1, -0.1],
        [0.132, -0.24],
        [0.07, -0.225],
      ],
      seg,
    ),
    null,
    // 소매 입구 안쪽은 어둡게
    { mask: MASK_A, shade: (x, y, z) => (y < -0.2 && Math.hypot(x, z) < 0.09 ? 0.55 : 1) },
  )
  hand(-0.268, 0.074)

  return b.build()
}

// ───────────────────────── 다리 ─────────────────────────

export function buildLeg(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 6, 7, 12)
  const shoe = (rx: number, ry: number, rz: number, z = 0.036): void => {
    b.add(sphere(1, lv(d, 5, 6, 10), lv(d, 3, 4, 6)), TRS(0, -0.33 + ry, z, 0, 0, 0, rx, ry, rz), { mask: MASK_B })
  }

  // 0 바지 + 신발
  b.variant = LEG.Pants
  b.add(
    lathe(
      [
        [0.088, 0.04],
        [0.086, -0.1],
        [0.076, -0.262],
      ],
      seg,
    ),
    null,
    { mask: MASK_A },
  )
  shoe(0.08, 0.052, 0.12)

  // 1 로브 아래로 살짝 보이는 발
  b.variant = LEG.Feet
  shoe(0.066, 0.046, 0.105, 0.03)

  // 2 통 넓은 한복 바지(발목에서 묶임)
  b.variant = LEG.Baggy
  b.add(
    lathe(
      [
        [0.098, 0.04],
        [0.116, -0.08],
        [0.112, -0.19],
        [0.07, -0.262],
      ],
      seg,
    ),
    null,
    { mask: MASK_A },
  )
  shoe(0.078, 0.05, 0.115)

  // 3 부츠
  b.variant = LEG.Boots
  b.add(
    lathe(
      [
        [0.086, 0.04],
        [0.084, -0.12],
      ],
      seg,
    ),
    null,
    { mask: MASK_A },
  )
  b.add(
    lathe(
      [
        [0.094, -0.115],
        [0.09, -0.262],
      ],
      seg,
    ),
    null,
    { mask: MASK_B },
  )
  shoe(0.09, 0.058, 0.128)

  return b.build()
}

// ───────────────────────── 얼굴 부품 ─────────────────────────

/** 단위 도형(반지름 1, +Z 를 봄). 인스턴스 행렬로 얼굴 곡면 위에 얹는다. 캐릭터당 여러 개가 쓰이므로 아주 가볍게 */
export function buildFaceUnit(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()

  // 0 점(원반)
  b.variant = FACE.Dot
  b.add(poly(circlePts(lv(d, 8, 10, 18), 1)), null, { mask: MASK_A })

  // 1 호(∩): 끝이 뾰족한 초승달. 눈웃음·입꼬리·감은 눈에 쓴다
  b.variant = FACE.Arc
  {
    const n = lv(d, 6, 8, 14)
    const outer: [number, number][] = []
    const inner: [number, number][] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = PI * (0.9 - 0.8 * t) // 162° → 18°
      const th = 0.1 + 0.3 * Math.sin(t * PI) // 가운데가 두껍다
      outer.push([Math.cos(a), Math.sin(a) - 0.62])
      inner.push([Math.cos(a) * (1 - th), Math.sin(a) * (1 - th) - 0.62])
    }
    b.add(strip(outer, inner), null, { mask: MASK_A })
  }

  // 2 막대(둥근 끝)
  b.variant = FACE.Bar
  {
    const pts: [number, number][] = []
    const n = lv(d, 3, 4, 6)
    const r = 0.3
    for (let i = 0; i <= n; i++) {
      const a = -PI / 2 + (i / n) * PI
      pts.push([1 - r + Math.cos(a) * r, Math.sin(a) * r])
    }
    for (let i = 0; i <= n; i++) {
      const a = PI / 2 + (i / n) * PI
      pts.push([-1 + r + Math.cos(a) * r, Math.sin(a) * r])
    }
    b.add(poly(pts), null, { mask: MASK_A })
  }

  // 3 반달(위가 평평): 벌린 입, 반쯤 감긴 눈
  b.variant = FACE.Half
  {
    const pts: [number, number][] = []
    const n = lv(d, 6, 8, 12)
    for (let i = 0; i <= n; i++) {
      const a = PI + (i / n) * PI
      pts.push([Math.cos(a), Math.sin(a) + 0.45])
    }
    b.add(poly(pts), null, { mask: MASK_A })
  }

  return b.build()
}

/** 머리 좌표계에 맞춰 만든 덩어리(선글라스, 콧수염, 도사 수염). 머리 행렬을 그대로 쓴다 */
export function buildFaceFit(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const { HEAD_RX: RX, HEAD_RY: RY, HEAD_RZ: RZ } = DIM
  const surfZ = (x: number, y: number): number => RZ * Math.sqrt(Math.max(0, 1 - (x * x) / (RX * RX) - (y * y) / (RY * RY)))
  const bw = lv(d, 5, 6, 10)
  const bh = lv(d, 3, 4, 6)

  // 0 선글라스
  b.variant = FACEFIT.Glasses
  {
    const ex = 0.135
    const ey = -0.03
    const ez = surfZ(ex, ey)
    for (const s of [-1, 1]) {
      // 렌즈: 납작한 타원 원반을 눈 위치의 곡면 방향으로 돌려 놓는다
      b.add(cyl(0.106, 0.106, 0.03, lv(d, 6, 8, 14)), TRS(s * ex, ey, ez + 0.024, 0, s * 0.33, 0).multiply(TRS(0, 0, 0, PI / 2, 0, 0, 1, 1, 0.68)), {
        color: 0x15131b,
      })
      // 다리: 렌즈 바깥 끝에서 귀까지 머리 옆면을 따라간다
      b.add(box(0.016, 0.022, 0.337), TRS(s * 0.3335, ey + 0.012, 0.1825, 0, s * -0.438, 0), { color: 0x15131b })
      // 반사광
      b.add(
        poly([
          [-0.06, 0.0],
          [-0.035, -0.012],
          [0.02, 0.05],
          [-0.005, 0.055],
        ]),
        TRS(s * ex - 0.012, ey + 0.012, ez + 0.042, 0, s * 0.33, 0),
        { color: 0xf4f6ff },
      )
    }
    b.add(box(0.1, 0.028, 0.024), TRS(0, ey + 0.03, surfZ(0, ey) + 0.026), { color: 0x15131b })
  }

  // 1 콧수염: 양쪽으로 처진 두 덩이(색은 인스턴스가 정한다 — 도사는 흰색)
  b.variant = FACEFIT.Moustache
  for (const s of [-1, 1]) {
    b.add(sphere(1, bw, bh), TRS(s * 0.062, -0.118, surfZ(0.062, -0.118) + 0.012, 0, s * 0.18, s * -0.32, 0.082, 0.036, 0.03), { mask: MASK_A })
    b.add(sphere(1, bw, bh), TRS(s * 0.128, -0.14, surfZ(0.128, -0.14) + 0.008, 0, s * 0.35, s * -0.75, 0.04, 0.022, 0.02), { mask: MASK_A })
  }

  // 2 도사 수염: 턱에서 가슴까지 내려오는 긴 수염 + 구레나룻
  b.variant = FACEFIT.Beard
  b.add(
    lathe(
      [
        [0, -0.38],
        [0.045, -0.31],
        [0.1, -0.17],
        [0.13, -0.04],
        [0.11, 0.05],
        [0, 0.08],
      ],
      lv(d, 6, 7, 12),
    ),
    TRS(0, -0.245, 0.225, 0.12, 0, 0, 1, 1, 0.6),
    { mask: MASK_A, shade: (_x, y) => (y < -0.45 ? 0.86 : 1) },
  )
  for (const s of [-1, 1]) {
    b.add(sphere(1, bw, bh), TRS(s * 0.2, -0.2, 0.21, 0.3, 0, s * 0.5, 0.075, 0.11, 0.07), { mask: MASK_A })
  }

  return b.build()
}

// ───────────────────────── 모자 ─────────────────────────

/** 모자(불투명). 머리 중심이 원점 */
export function buildHat(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 8, 10, 16)
  const { HEAD_RX: RX, HEAD_RY: RY } = DIM
  /** 장식용 작은 구슬 */
  const bead = (r: number, x: number, y: number, z: number, color: number, m: THREE.Matrix4 | null = null): void => {
    const t = TRS(x, y, z)
    b.add(sphere(r, lv(d, 4, 5, 8), lv(d, 2, 3, 5)), m ? m.clone().multiply(t) : t, { color })
  }

  // 머리에 딱 붙는 조각은 머리(머리카락 캡)와 같은 분할 수를 써야 각진 면 사이로 머리카락이 삐져나오지 않는다
  const hw = lv(d, 10, 12, 20)

  // 1 야구모자: 주색 돔 + 흰 앞판 + 챙
  b.variant = 1
  {
    const rings = lv(d, 3, 4, 6)
    const domeLen = 0.42 * PI
    b.add(sphere(1, hw, rings, 0, PI * 2, 0, domeLen), TRS(0, 0.012, 0, 0, 0, 0, 0.426, 0.405, 0.41), { mask: MASK_A })
    // 앞판은 돔의 정점과 정확히 겹치는 범위(앞쪽 몇 칸, 꼭대기 한 줄 아래부터)를 살짝 키워 덮는다
    const half = (lv(d, 54, 60, 54) / 180) * PI
    b.add(sphere(1, lv(d, 3, 4, 6), rings - 1, PI / 2 - half, half * 2, domeLen / rings, (domeLen * (rings - 1)) / rings), TRS(0, 0.012, 0, 0, 0, 0, 0.433, 0.411, 0.417), {
      color: 0xf7f5ee,
    })
  }
  b.add(cyl(0.3, 0.3, 0.022, seg), TRS(0, 0.118, 0.315, 0.16, 0, 0), { mask: MASK_A, mul: 0.7 })
  bead(0.03, 0, 0.418, 0, 0xf7f5ee)

  // 2 밀짚모자
  b.variant = 2
  b.add(
    lathe(
      [
        [0.405, 0.125],
        [0.405, 0.2],
        [0.36, 0.33],
        [0.25, 0.41],
        [0, 0.43],
      ],
      seg,
    ),
    null,
    { color: 0xecc566, flat: true, faceShade: (f) => (Math.floor(f / 2) % 2 === 0 ? 1 : 0.92) },
  )
  b.add(
    lathe(
      [
        [0.41, 0.14],
        [0.412, 0.205],
      ],
      seg,
    ),
    null,
    { color: 0xc8372f },
  )
  b.add(
    lathe(
      [
        [0.7, 0.09],
        [0.4, 0.14],
      ],
      seg,
    ),
    null,
    { color: 0xecc566, flat: true, faceShade: (f) => (Math.floor(f / 2) % 2 === 0 ? 1 : 0.9) },
  )
  b.add(
    lathe(
      [
        [0.4, 0.128],
        [0.7, 0.078],
      ],
      seg,
    ),
    null,
    { color: 0xb9954a },
  )

  // 3 갓(불투명 부분): 이마의 망건 띠만. 갓 본체는 반투명 풀에 있다
  b.variant = 3
  b.add(sphere(1, hw * 2, 2, 0, PI * 2, 0.27 * PI, 0.1 * PI), TRS(0, 0.004, 0, 0, 0, 0, RX * 1.09, RY * 1.1, 0.37 * 1.09), { color: 0x1a1820 })

  // 4 삿갓: 넓은 원뿔
  b.variant = 4
  b.add(
    lathe(
      [
        [0.63, 0.17],
        [0.43, 0.34],
        [0.21, 0.52],
        [0, 0.66],
      ],
      seg,
    ),
    null,
    { color: 0xdcb96c, flat: true, faceShade: (f) => (Math.floor(f / 2) % 2 === 0 ? 1 : 0.88) },
  )
  b.add(
    lathe(
      [
        [0, 0.33],
        [0.63, 0.158],
      ],
      seg,
    ),
    null,
    { color: 0x9c7c3e },
  )
  bead(0.04, 0, 0.66, 0, 0x6b4a2a)

  // 5 은박지 모자: 구겨진 원뿔
  b.variant = 5
  {
    const rings: [number, number][] = [
      [0.44, 0.13],
      [0.41, 0.18],
      [0.31, 0.33],
      [0.2, 0.47],
      [0.09, 0.6],
      [0, 0.71],
    ]
    const fseg = lv(d, 7, 9, 11)
    const g = lathe(rings, fseg)
    const p = g.getAttribute('position')
    const rnd = seeded(41)
    const n = rings.length
    // 이음매(j=0 과 j=fseg)가 벌어지지 않게 같은 난수를 쓴다
    const jit: number[] = []
    for (let k = 0; k < fseg * n * 3; k++) jit.push((rnd() - 0.5) * 0.07)
    for (let j = 0; j <= fseg; j++) {
      for (let i = 0; i < n; i++) {
        const v = j * n + i
        const k = ((j % fseg) * n + i) * 3
        const top = i === n - 1
        p.setXYZ(v, p.getX(v) + (top ? 0.06 : jit[k]!), p.getY(v) + (top ? 0 : jit[k + 1]! * 0.6), p.getZ(v) + (top ? -0.04 : jit[k + 2]!))
      }
    }
    const frnd = seeded(5)
    const shades: number[] = []
    for (let k = 0; k < 400; k++) shades.push(0.62 + frnd() * 0.5)
    b.add(g, null, { color: 0xe3e9f0, flat: true, faceShade: (f) => shades[f % shades.length]! })
  }

  // 6 피라미드 모자: 앞면에 눈
  b.variant = 6
  b.add(cone(0.5, 0.56, 4), TRS(0, 0.48, 0, 0, PI / 4, 0), { color: 0xeab92a, flat: true })
  b.add(box(0.78, 0.035, 0.78), TRS(0, 0.195, 0), { color: 0xc9951a, flat: true })
  {
    const tilt = -Math.atan(0.354 / 0.56)
    const m = (dz: number): THREE.Matrix4 => TRS(0, 0.4, 0.228 + dz, tilt, 0, 0)
    b.add(
      poly([
        [-0.13, 0],
        [-0.065, -0.055],
        [0, -0.07],
        [0.065, -0.055],
        [0.13, 0],
        [0.065, 0.055],
        [0, 0.07],
        [-0.065, 0.055],
      ]),
      m(0.012),
      { color: 0xfdfcf5 },
    )
    b.add(poly(circlePts(lv(d, 8, 10, 14), 0.05)), m(0.017), { color: 0x2a2140 })
    b.add(poly(circlePts(6, 0.016, 0.016, 0.018, 0.02)), m(0.021), { color: 0xffffff })
  }

  // 7 왕관: 살짝 삐딱하게
  b.variant = 7
  {
    const tiltM = TRS(0.02, 0.01, 0, 0.06, 0, -0.14)
    const add = (g: THREE.BufferGeometry, m: THREE.Matrix4 | null, o: AddOpts): void => {
      b.add(g, m ? tiltM.clone().multiply(m) : tiltM.clone(), o)
    }
    add(
      lathe(
        [
          [0.25, 0.27],
          [0.262, 0.3],
          [0.262, 0.37],
        ],
        seg,
      ),
      null,
      { color: 0xf4c63a },
    )
    add(
      inside(
        lathe(
          [
            [0.25, 0.27],
            [0.25, 0.37],
          ],
          seg,
        ),
      ),
      null,
      { color: 0xb98a1c },
    )
    const spikes = 6
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * PI * 2
      const tri: [number, number][] = [
        [-0.13, 0],
        [0.13, 0],
        [0, 0.15],
      ]
      const px = Math.sin(a) * 0.258
      const pz = Math.cos(a) * 0.258
      add(poly(tri), TRS(px, 0.368, pz, 0, a, 0), { color: 0xf4c63a })
      add(poly(tri), TRS(px * 0.985, 0.368, pz * 0.985, 0, a + PI, 0), { color: 0xc9981f })
      bead(0.026, Math.sin(a) * 0.262, 0.515, Math.cos(a) * 0.262, 0xfff1b0, tiltM)
      bead(0.03, Math.sin(a) * 0.268, 0.325, Math.cos(a) * 0.268, i % 2 === 0 ? 0xe5334b : 0x3b82f6, tiltM)
    }
  }

  // 8 안테나 수신기: 머리띠 + 귀마개 + 접시 + 회초리 안테나
  b.variant = 8
  b.add(torus(1, 0.055, lv(d, 4, 4, 6), lv(d, 8, 10, 16), PI), TRS(0, 0, 0, 0, 0, 0, RX * 1.09, RY * 1.1, 0.5), { color: 0x3b3f52 })
  for (const s of [-1, 1]) {
    b.add(cyl(0.085, 0.085, 0.06, lv(d, 6, 8, 12)), TRS(s * 0.42, -0.03, 0, 0, 0, PI / 2), { color: 0x3b3f52 })
    b.add(cyl(0.05, 0.05, 0.065, lv(d, 6, 8, 12)), TRS(s * 0.423, -0.03, 0, 0, 0, PI / 2), { color: 0xf2a03d })
  }
  {
    const dishM = TRS(0, 0.47, 0.0, 0.5, 0, -0.35)
    const dish: [number, number][] = [
      [0, 0],
      [0.09, 0.014],
      [0.16, 0.055],
      [0.2, 0.115],
    ]
    b.add(lathe(dish, seg), dishM.clone(), { color: 0xb5bdc8 })
    b.add(inside(lathe(dish, seg)), dishM.clone().multiply(TRS(0, 0.004, 0)), { color: 0xe6ebf1 })
    b.add(cyl(0.012, 0.012, 0.15, 4), dishM.clone().multiply(TRS(0, 0.075, 0)), { color: 0x6b7280 })
    bead(0.03, 0, 0.155, 0, 0xff4b3e, dishM)
    b.add(cyl(0.02, 0.028, 0.1, 5), TRS(0, 0.43, 0), { color: 0x6b7280 })
  }
  b.add(cyl(0.008, 0.012, 0.5, 4), TRS(0.43, 0.25, -0.02, 0, 0, -0.12), { color: 0x6b7280 })
  bead(0.032, 0.46, 0.5, -0.02, 0xff4b3e)

  // 9 후광 머리띠: 철사로 받친 금색 고리(누가 봐도 소품)
  b.variant = 9
  b.add(torus(1, 0.05, lv(d, 4, 4, 6), lv(d, 8, 10, 16), PI), TRS(0, 0, -0.02, 0, 0, 0, RX * 1.085, RY * 1.095, 0.5), { color: 0xf5f5f0 })
  b.add(cyl(0.01, 0.01, 0.27, 4), TRS(0, 0.52, -0.12, 0.25), { color: 0x9aa3ad })
  b.add(torus(0.24, 0.036, lv(d, 4, 5, 8), lv(d, 10, 12, 20)), TRS(0, 0.66, -0.02, PI / 2 + 0.12, 0, 0.08), { color: 0xffdf4d })

  // 10 UFO 모자: 머리 위에 떠 있는 비행접시(광선은 반투명 풀)
  b.variant = 10
  b.add(
    lathe(
      [
        [0, 0.6],
        [0.17, 0.6],
        [0.37, 0.66],
        [0.39, 0.685],
        [0.37, 0.705],
        [0.19, 0.745],
        [0, 0.75],
      ],
      seg,
    ),
    null,
    { color: 0xc5cfdb, flat: true },
  )
  b.add(sphere(0.16, seg, lv(d, 3, 3, 5), 0, PI * 2, 0, PI / 2), TRS(0, 0.735, 0), { color: 0x7fe9df })
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2
    bead(0.032, Math.sin(a) * 0.275, 0.632, Math.cos(a) * 0.275, i % 2 === 0 ? 0xffe14d : 0xff5b6e)
  }

  return b.build()
}

/** 모자의 반투명 부분: 갓(말총으로 짠 비치는 검은 갓)과 UFO 납치 광선 */
export function buildHatTranslucent(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 10, 12, 20)

  b.variant = 3
  const gat = 0x17151d
  // 양태(챙): 윗면·아랫면
  b.add(
    lathe(
      [
        [0.7, 0.245],
        [0.27, 0.285],
      ],
      seg,
    ),
    null,
    { color: gat, alpha: 0.84 },
  )
  b.add(
    lathe(
      [
        [0.27, 0.277],
        [0.7, 0.237],
      ],
      seg,
    ),
    null,
    { color: gat, alpha: 0.84 },
  )
  // 대우(모자집)
  b.add(
    lathe(
      [
        [0.27, 0.285],
        [0.252, 0.4],
        [0.225, 0.53],
        [0, 0.535],
      ],
      seg,
    ),
    null,
    { color: gat, alpha: 0.72 },
  )

  b.variant = 10
  b.add(
    lathe(
      [
        [0.36, 0.26],
        [0.13, 0.6],
      ],
      lv(d, 8, 10, 16),
    ),
    null,
    { color: 0xc4ffb8, alpha: 0.3, shade: () => 1.4 },
  )

  return b.build()
}

// ───────────────────────── 소품 ─────────────────────────

/** 소품. 변형 1,2,3,5 는 몸통 좌표계(엉덩이 중심이 원점), 4(확성기)·6(전단지)은 손잡이가 원점 */
export function buildAcc(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 8, 12, 18)
  const beadW = lv(d, 4, 5, 8)
  const beadH = lv(d, 2, 3, 5)

  // 1 어깨띠: 왼쪽 어깨에서 오른쪽 허리로
  b.variant = ACC.Sash
  {
    const tilt = 0.74
    const R = 0.243
    const m = (): THREE.Matrix4 => TRS(-0.028, 0.245, 0, 0, 0, tilt, 1 / Math.cos(tilt), 1, 0.845)
    b.add(
      lathe(
        [
          [R, -0.042],
          [R + 0.008, 0],
          [R, 0.042],
        ],
        seg,
      ),
      m(),
      { color: 0xffd23f },
    )
    for (const y of [-0.04, 0.04]) {
      b.add(
        lathe(
          [
            [R + 0.004, y - 0.01],
            [R + 0.007, y + 0.01],
          ],
          seg,
        ),
        m(),
        { color: 0xd8342f },
      )
    }
    // 글씨처럼 보이는 네모들(앞·뒤)
    for (const base of [0, PI]) {
      for (let i = -2; i <= 2; i++) {
        const a = base + i * 0.24 + 0.1
        b.add(box(0.03, 0.036, 0.012), m().multiply(TRS(Math.sin(a) * (R + 0.008), 0, Math.cos(a) * (R + 0.008), 0, a, 0)), { color: 0x7a1f2b })
      }
    }
  }

  // 2 염주 목걸이
  b.variant = ACC.Beads
  {
    const n = lv(d, 10, 12, 14)
    const m = (): THREE.Matrix4 => TRS(0, 0.4, 0.02, 0.62, 0, 0)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2
      b.add(sphere(0.04, beadW, beadH), m().multiply(TRS(Math.sin(a) * 0.185, 0, Math.cos(a) * 0.19)), { color: i % 2 === 0 ? 0x6b3f22 : 0x8a5530 })
    }
    b.add(sphere(0.054, beadW + 1, beadH + 1), m().multiply(TRS(0, -0.012, 0.2)), { color: 0x4f2d16 })
    b.add(cone(0.03, 0.09, 5), TRS(0, 0.205, 0.215, PI), { color: 0xc23b3b })
  }

  // 3 배낭
  b.variant = ACC.Backpack
  b.add(box(0.28, 0.3, 0.14), TRS(0, 0.25, -0.24), { color: 0xe36c2f })
  b.add(box(0.286, 0.1, 0.15), TRS(0, 0.365, -0.24), { color: 0xc6551f })
  b.add(box(0.18, 0.11, 0.05), TRS(0, 0.17, -0.325), { color: 0xf4b83a })
  b.add(box(0.07, 0.03, 0.03), TRS(0, 0.42, -0.24), { color: 0x3a3f55 })
  for (const s of [-1, 1]) {
    b.add(box(0.036, 0.34, 0.02), TRS(s * 0.125, 0.29, 0.156, -0.13), { color: 0x3a3f55 })
    b.add(box(0.036, 0.02, 0.36), TRS(s * 0.125, 0.455, -0.03), { color: 0x3a3f55 })
  }

  // 4 확성기: 손잡이가 원점, +Z 로 나팔
  b.variant = ACC.Megaphone
  {
    const m = (): THREE.Matrix4 => TRS(0, 0.045, -0.06, PI / 2, 0, 0)
    b.add(
      lathe(
        [
          [0, -0.01],
          [0.03, 0],
          [0.038, 0.07],
          [0.105, 0.23],
          [0.11, 0.245],
        ],
        seg,
      ),
      m(),
      { color: 0xf6f5f0 },
    )
    b.add(
      lathe(
        [
          [0.108, 0.232],
          [0.118, 0.25],
          [0.108, 0.268],
        ],
        seg,
      ),
      m(),
      { color: 0xd8342f },
    )
    b.add(
      inside(
        lathe(
          [
            [0.03, 0.07],
            [0.106, 0.262],
          ],
          seg,
        ),
      ),
      m(),
      { color: 0x7a1f2b },
    )
    b.add(cyl(0.034, 0.034, 0.03, lv(d, 6, 8, 12)), m().multiply(TRS(0, -0.02, 0)), { color: 0xd8342f })
    b.add(box(0.032, 0.1, 0.04), TRS(0, -0.02, 0.0, 0.2), { color: 0x3a3f55 })
  }

  // 5 금목걸이: 굵은 사슬 + 큼직한 메달
  b.variant = ACC.Chain
  {
    const n = lv(d, 12, 16, 18)
    const m = (): THREE.Matrix4 => TRS(0, 0.395, 0.02, 0.82, 0, 0)
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * PI * 2
      b.add(sphere(1, beadW, beadH), m().multiply(TRS(Math.sin(a) * 0.185, 0, Math.cos(a) * 0.215, 0, a, 0, 0.046, 0.03, 0.03)), {
        color: i % 2 === 0 ? 0xf6c443 : 0xe0a920,
      })
    }
    b.add(cyl(0.07, 0.07, 0.022, lv(d, 8, 10, 16)), TRS(0, 0.2, 0.208, PI / 2 - 0.1), { color: 0xf6c443 })
    b.add(poly(starPts(5, 0.045, 0.02)), TRS(0, 0.2, 0.221, -0.1), { color: 0xb8860b })
  }

  // 6 전단지: 아랫변 가운데가 원점(손에 쥔다)
  b.variant = ACC.Flyer
  b.add(box(0.18, 0.23, 0.006), TRS(0, 0.115, 0), { color: 0xfbfaf4 })
  for (const side of [0, PI]) {
    const m = (x: number, y: number): THREE.Matrix4 => TRS(0, 0, 0, 0, side, 0).multiply(TRS(x, y, 0.0045))
    const r = (w: number, h: number): [number, number][] => rect(-w / 2, -h / 2, w / 2, h / 2)
    b.add(poly(r(0.155, 0.05)), m(0, 0.19), { color: 0xe2413a })
    b.add(poly(circlePts(8, 0.038)), m(-0.045, 0.115), { color: 0xffd23f })
    b.add(poly(r(0.07, 0.014)), m(0.04, 0.13), { color: 0x6b7280 })
    b.add(poly(r(0.07, 0.014)), m(0.04, 0.1), { color: 0x6b7280 })
    b.add(poly(r(0.15, 0.014)), m(0, 0.055), { color: 0x9aa3ad })
    b.add(poly(r(0.15, 0.014)), m(0, 0.03), { color: 0x9aa3ad })
  }

  return b.build()
}

// ───────────────────────── 고양이 ─────────────────────────

/** 길고양이. 주색 = 털, 보조색 = 가슴·주둥이·발·꼬리 끝 */
export function buildCat(d: Detail): THREE.BufferGeometry {
  const b = new GeoBuilder()
  const seg = lv(d, 6, 8, 12)
  const hs = lv(d, 4, 6, 8)

  // 0 몸통(원점 = 몸 중심 아래 바닥)
  b.variant = CAT.Body
  b.add(sphere(1, seg, hs), TRS(0, 0.205, 0, 0, 0, 0, 0.11, 0.108, 0.225), { mask: MASK_A })
  b.add(sphere(1, lv(d, 5, 6, 8), lv(d, 3, 4, 6)), TRS(0, 0.185, 0.15, 0, 0, 0, 0.088, 0.09, 0.09), { mask: MASK_B })
  for (const z of [-0.11, -0.03, 0.05]) {
    // 그 위치의 몸통 단면 반지름에 맞춘다(떠 있으면 갈비뼈처럼 보인다)
    const k = Math.sqrt(1 - (z * z) / (0.225 * 0.225)) * 1.012
    b.add(torus(1, 0.07, 3, lv(d, 4, 6, 8), PI), TRS(0, 0.205, z, 0, 0, 0, 0.11 * k, 0.108 * k, 0.2), { mask: MASK_A, mul: 0.62 })
  }

  // 1 머리(원점 = 머리 중심)
  b.variant = CAT.Head
  b.add(sphere(1, seg, hs), TRS(0, 0, 0, 0, 0, 0, 0.14, 0.118, 0.118), { mask: MASK_A })
  for (const s of [-1, 1]) {
    b.add(cone(0.058, 0.11, 4), TRS(s * 0.085, 0.125, -0.005, 0, PI / 4, s * -0.28), { mask: MASK_A, flat: true })
    b.add(
      poly([
        [-0.03, 0],
        [0.03, 0],
        [0, 0.07],
      ]),
      TRS(s * 0.086, 0.1, 0.036, -0.22, 0, s * -0.28),
      { color: 0xf5a3b0 },
    )
    // 눈
    b.add(sphere(1, 6, 4), TRS(s * 0.06, 0.018, 0.1, 0, s * 0.35, 0, 0.024, 0.03, 0.012), { color: 0x1c1a22 })
    b.add(sphere(1, 4, 3), TRS(s * 0.053, 0.03, 0.111, 0, 0, 0, 0.007, 0.007, 0.004), { color: 0xffffff })
  }
  b.add(sphere(1, lv(d, 5, 6, 8), lv(d, 3, 4, 5)), TRS(0, -0.036, 0.088, 0, 0, 0, 0.072, 0.046, 0.042), { mask: MASK_B })
  b.add(sphere(1, 5, 3), TRS(0, -0.014, 0.127, 0, 0, 0, 0.018, 0.013, 0.012), { color: 0xf08a9b })

  // 2 다리(원점 = 위쪽 끝)
  b.variant = CAT.Leg
  b.add(cyl(0.037, 0.033, 0.1, lv(d, 5, 6, 8), true), TRS(0, -0.05, 0), { mask: MASK_A })
  b.add(sphere(1, lv(d, 5, 6, 8), lv(d, 3, 4, 5)), TRS(0, -0.108, 0.008, 0, 0, 0, 0.04, 0.032, 0.046), { mask: MASK_B })

  // 3 꼬리(원점 = 밑동, 위로 휘어 올라간다)
  b.variant = CAT.Tail
  {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [0, 0.07, -0.055],
      [0, 0.155, -0.075],
      [0, 0.235, -0.05],
      [0, 0.29, 0.005],
    ]
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!
      const q = pts[i + 1]!
      const r0 = 0.032 - i * 0.003
      const [g, m] = limb(p[0], p[1], p[2], q[0], q[1], q[2], r0, r0 - 0.003, lv(d, 5, 6, 8))
      const tip = i === pts.length - 2
      b.add(g, m, { mask: tip ? MASK_B : MASK_A })
      b.add(sphere(r0 - 0.002, lv(d, 5, 6, 8), lv(d, 3, 4, 5)), TRS(q[0], q[1], q[2]), { mask: tip ? MASK_B : MASK_A })
    }
  }

  return b.build()
}
