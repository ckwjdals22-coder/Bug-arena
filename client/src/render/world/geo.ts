/**
 * 정적 월드용 지오메트리 조립기.
 *
 * 왜 직접 만드나: 드로콜을 줄이려면 수백 개의 상자·기둥·간판을 "재질별 한 덩어리"로 합쳐야 한다.
 * three 의 mergeGeometries 는 조각마다 BufferGeometry 를 만들었다 버려야 해서 느리고,
 * 정점마다 색(가짜 음영)·알파(가짜 그림자)·UV(간판 아틀라스)를 섞어 쓰기도 번거롭다.
 * 그래서 숫자 배열에 바로 밀어 넣는 작은 빌더를 쓴다(결과는 인덱스 있는 BufferGeometry 한 개).
 */
import * as THREE from 'three'

export type RGB = readonly [number, number, number]
export type V3 = readonly [number, number, number]

const colorCache = new Map<number, RGB>()
const tmpColor = new THREE.Color()

/** 0xRRGGBB(sRGB) → 선형 색 공간 RGB. 버텍스 컬러는 선형 값을 기대한다 */
export function rgb(hex: number): RGB {
  let c = colorCache.get(hex)
  if (!c) {
    tmpColor.setHex(hex)
    c = [tmpColor.r, tmpColor.g, tmpColor.b]
    colorCache.set(hex, c)
  }
  return c
}

export const mul = (c: RGB, m: number): RGB => [c[0] * m, c[1] * m, c[2] * m]
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const WHITE: RGB = [1, 1, 1]
export const BLACK: RGB = [0, 0, 0]

/** 시드 고정 난수(같은 월드가 모든 접속자·모든 재생성에서 똑같이 보이도록 Math.random 을 쓰지 않는다) */
export function makeRnd(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 아틀라스 안의 한 칸(UV) */
export interface AtlasRect {
  u0: number
  v0: number
  u1: number
  v1: number
}

export class Builder {
  private readonly pos: number[] = []
  private readonly nor: number[] = []
  private readonly col: number[] = []
  private readonly uvs: number[] = []
  private readonly idx: number[] = []
  private count = 0
  // 현재 변환: 이동 + Y축 회전(yaw). 소품을 로컬 좌표로 적고 제자리에 놓기 위함
  private ox = 0
  private oy = 0
  private oz = 0
  private cs = 1
  private sn = 0
  private sc = 1

  constructor(
    private readonly hasNormal: boolean,
    private readonly hasUv: boolean,
    private readonly hasAlpha: boolean,
  ) {}

  /** 이후 정점을 (x,y,z)로 옮기고 yaw 만큼 돌린다. 로컬 +Z 가 '앞' */
  at(x: number, y: number, z: number, yaw = 0, scale = 1): this {
    this.ox = x
    this.oy = y
    this.oz = z
    this.cs = Math.cos(yaw)
    this.sn = Math.sin(yaw)
    this.sc = scale
    return this
  }

  origin(): this {
    return this.at(0, 0, 0, 0, 1)
  }

  get triangles(): number {
    return this.idx.length / 3
  }

  get empty(): boolean {
    return this.idx.length === 0
  }

  private vert(p: V3, n: V3, c: RGB, a: number, u: number, v: number): number {
    const { cs, sn, sc } = this
    this.pos.push(this.ox + (p[0] * cs + p[2] * sn) * sc, this.oy + p[1] * sc, this.oz + (-p[0] * sn + p[2] * cs) * sc)
    if (this.hasNormal) this.nor.push(n[0] * cs + n[2] * sn, n[1], -n[0] * sn + n[2] * cs)
    if (this.hasAlpha) this.col.push(c[0], c[1], c[2], a)
    else this.col.push(c[0], c[1], c[2])
    if (this.hasUv) this.uvs.push(u, v)
    return this.count++
  }

  /**
   * 사각형. a→b→c→d 는 앞에서 봤을 때 반시계 방향(a,b 아래 / c,d 위로 쓰면 세로 그라데이션이 쉽다).
   * cTop 을 주면 c,d 정점에 그 색을 쓴다.
   */
  quad(a: V3, b: V3, c: V3, d: V3, col: RGB, cTop: RGB = col, alpha: readonly [number, number, number, number] | null = null, uv: AtlasRect | null = null): void {
    const n = faceNormal(a, b, d)
    const al = alpha ?? ONES
    const i0 = this.vert(a, n, col, al[0], uv ? uv.u0 : 0, uv ? uv.v0 : 0)
    const i1 = this.vert(b, n, col, al[1], uv ? uv.u1 : 0, uv ? uv.v0 : 0)
    const i2 = this.vert(c, n, cTop, al[2], uv ? uv.u1 : 0, uv ? uv.v1 : 0)
    const i3 = this.vert(d, n, cTop, al[3], uv ? uv.u0 : 0, uv ? uv.v1 : 0)
    this.idx.push(i0, i1, i2, i0, i2, i3)
  }

  tri(a: V3, b: V3, c: V3, col: RGB, alpha: readonly [number, number, number] | null = null, colB: RGB = col, colC: RGB = col): void {
    const n = faceNormal(a, b, c)
    const i0 = this.vert(a, n, col, alpha ? alpha[0] : 1, 0, 0)
    const i1 = this.vert(b, n, colB, alpha ? alpha[1] : 1, 0, 0)
    const i2 = this.vert(c, n, colC, alpha ? alpha[2] : 1, 0, 0)
    this.idx.push(i0, i1, i2)
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3))
    if (this.hasNormal) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), this.hasAlpha ? 4 : 3))
    if (this.hasUv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uvs), 2))
    g.setIndex(new THREE.BufferAttribute(this.count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1))
    g.computeBoundingSphere()
    return g
  }
}

const ONES = [1, 1, 1, 1] as const

function faceNormal(a: V3, b: V3, d: V3): V3 {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = d[0] - a[0]
  const vy = d[1] - a[1]
  const vz = d[2] - a[2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

// ───────────────────────── 도형 ─────────────────────────

export interface BoxOpts {
  /** 그리지 않을 면: n(−Z) s(+Z) w(−X) e(+X) t(위) b(아래). 기본 'b' */
  skip?: string
  /** 윗면 색 */
  top?: RGB
  /** 옆면 아래쪽 정점 밝기 배수(가짜 접지 음영). 기본 1 */
  ao?: number
}

/** 축 정렬 상자(로컬 좌표) */
export function box(b: Builder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: RGB, o: BoxOpts = {}): void {
  const skip = o.skip ?? 'b'
  const lo = o.ao !== undefined ? mul(col, o.ao) : col
  if (!skip.includes('s')) b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], lo, col)
  if (!skip.includes('n')) b.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], lo, col)
  if (!skip.includes('e')) b.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], lo, col)
  if (!skip.includes('w')) b.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], lo, col)
  if (!skip.includes('t')) {
    const t = o.top ?? col
    b.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], t)
  }
  if (!skip.includes('b')) b.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], lo)
}

export interface CylOpts {
  /** 윗면 뚜껑 색. null 이면 뚜껑 없음. 기본은 옆면 색 */
  cap?: RGB | null
  ao?: number
  /** 시작 각(라디안) */
  phase?: number
}

/** 세로 원뿔대: 아래 반지름 r0, 위 반지름 r1 */
export function cyl(b: Builder, x: number, y: number, z: number, r0: number, r1: number, h: number, seg: number, col: RGB, o: CylOpts = {}): void {
  const lo = o.ao !== undefined ? mul(col, o.ao) : col
  const ph = o.phase ?? 0
  const y1 = y + h
  for (let i = 0; i < seg; i++) {
    const a0 = ph + (i / seg) * Math.PI * 2
    const a1 = ph + ((i + 1) / seg) * Math.PI * 2
    const c0 = Math.cos(a0)
    const s0 = Math.sin(a0)
    const c1 = Math.cos(a1)
    const s1 = Math.sin(a1)
    const p0: V3 = [x + r0 * c0, y, z + r0 * s0]
    const p1: V3 = [x + r0 * c1, y, z + r0 * s1]
    const q0: V3 = [x + r1 * c0, y1, z + r1 * s0]
    const q1: V3 = [x + r1 * c1, y1, z + r1 * s1]
    if (r1 > 1e-4) b.quad(p1, p0, q0, q1, lo, col)
    else b.tri(p1, p0, [x, y1, z], lo, null, lo, col)
    if (r1 > 1e-4 && o.cap !== null) b.tri([x, y1, z], q1, q0, o.cap ?? col)
  }
}

/** 가로로 누운 원기둥(바퀴 등). axis: 로컬 x 또는 z 방향 */
export function wheel(b: Builder, x: number, y: number, z: number, r: number, len: number, axis: 'x' | 'z', seg: number, col: RGB, capCol: RGB = col): void {
  const h = len / 2
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2
    const a1 = ((i + 1) / seg) * Math.PI * 2
    const u0 = r * Math.cos(a0)
    const v0 = r * Math.sin(a0)
    const u1 = r * Math.cos(a1)
    const v1 = r * Math.sin(a1)
    if (axis === 'x') {
      b.quad([x - h, y + v0, z + u0], [x + h, y + v0, z + u0], [x + h, y + v1, z + u1], [x - h, y + v1, z + u1], col)
      b.tri([x + h, y, z], [x + h, y + v1, z + u1], [x + h, y + v0, z + u0], capCol)
      b.tri([x - h, y, z], [x - h, y + v0, z + u0], [x - h, y + v1, z + u1], capCol)
    } else {
      b.quad([x + u0, y + v0, z + h], [x + u0, y + v0, z - h], [x + u1, y + v1, z - h], [x + u1, y + v1, z + h], col)
      b.tri([x, y, z + h], [x + u0, y + v0, z + h], [x + u1, y + v1, z + h], capCol)
      b.tri([x, y, z - h], [x + u1, y + v1, z - h], [x + u0, y + v0, z - h], capCol)
    }
  }
}

const T = (1 + Math.sqrt(5)) / 2
const ICO_V: V3[] = (
  [
    [-1, T, 0],
    [1, T, 0],
    [-1, -T, 0],
    [1, -T, 0],
    [0, -1, T],
    [0, 1, T],
    [0, -1, -T],
    [0, 1, -T],
    [T, 0, -1],
    [T, 0, 1],
    [-T, 0, -1],
    [-T, 0, 1],
  ] as V3[]
).map((v) => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l] as V3
})
const ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]

/**
 * 정이십면체 덩어리(나무 잎, 전구, 쓰레기봉투…). rnd 를 주면 꼭짓점을 조금씩 흩뜨리고 면마다 밝기를 달리해
 * 손으로 깎은 로우폴리 느낌을 낸다.
 */
export function ico(b: Builder, x: number, y: number, z: number, rx: number, ry: number, rz: number, col: RGB, rnd: (() => number) | null = null, vary = 0.1): void {
  const pts: V3[] = ICO_V.map((v) => {
    const k = rnd ? 1 + (rnd() - 0.5) * 0.3 : 1
    return [x + v[0] * rx * k, y + v[1] * ry * k, z + v[2] * rz * k] as V3
  })
  for (let f = 0; f < ICO_F.length; f += 3) {
    const c = rnd ? mul(col, 1 + (rnd() - 0.5) * 2 * vary) : col
    b.tri(pts[ICO_F[f]!]!, pts[ICO_F[f + 1]!]!, pts[ICO_F[f + 2]!]!, c)
  }
}

/** 임의 방향 막대(전선, 깃발 줄, 받침대). 단면은 네모 */
export function beam(b: Builder, p0: V3, p1: V3, t: number, col: RGB): void {
  const dx = p1[0] - p0[0]
  const dy = p1[1] - p0[1]
  const dz = p1[2] - p0[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-5) return
  const ax = dx / len
  const ay = dy / len
  const az = dz / len
  // 축과 나란하지 않은 기준 벡터로 수직 두 축을 만든다
  const ref: V3 = Math.abs(ay) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  let ux = ay * ref[2] - az * ref[1]
  let uy = az * ref[0] - ax * ref[2]
  let uz = ax * ref[1] - ay * ref[0]
  const ul = Math.hypot(ux, uy, uz)
  ux = (ux / ul) * t
  uy = (uy / ul) * t
  uz = (uz / ul) * t
  const vx = (ay * uz - az * uy)
  const vy = (az * ux - ax * uz)
  const vz = (ax * uy - ay * ux)
  const corner = (p: V3, su: number, sv: number): V3 => [p[0] + ux * su + vx * sv, p[1] + uy * su + vy * sv, p[2] + uz * su + vz * sv]
  const s: [number, number][] = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ]
  for (let i = 0; i < 4; i++) {
    const a = s[i]!
    const c = s[(i + 1) % 4]!
    b.quad(corner(p0, a[0], a[1]), corner(p0, c[0], c[1]), corner(p1, c[0], c[1]), corner(p1, a[0], a[1]), col)
  }
}

/** 바닥(위를 보는) 사각형 */
export function floorRect(b: Builder, x0: number, z0: number, x1: number, z1: number, y: number, col: RGB, alpha = 1): void {
  b.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, col, alpha === 1 ? null : [alpha, alpha, alpha, alpha])
}

/** 바닥 원판(부채꼴 삼각형). 가운데/가장자리 색·알파를 따로 줄 수 있어 부드러운 그림자·빛 웅덩이에 쓴다 */
export function disc(
  b: Builder,
  x: number,
  y: number,
  z: number,
  rx: number,
  rz: number,
  seg: number,
  col: RGB,
  aCenter = 1,
  aRim = 1,
  rim: RGB = col,
): void {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2
    const a1 = ((i + 1) / seg) * Math.PI * 2
    b.tri([x, y, z], [x + rx * Math.cos(a1), y, z + rz * Math.sin(a1)], [x + rx * Math.cos(a0), y, z + rz * Math.sin(a0)], col, [aCenter, aRim, aRim], rim, rim)
  }
}

/** 바닥 고리(안 반지름 r0 ~ 바깥 r1). a0..a1 각도 범위만 그릴 수도 있다 */
export function ring(b: Builder, x: number, y: number, z: number, r0: number, r1: number, seg: number, col: RGB, from = 0, to = Math.PI * 2, colOuter: RGB = col): void {
  for (let i = 0; i < seg; i++) {
    const a0 = from + ((to - from) * i) / seg
    const a1 = from + ((to - from) * (i + 1)) / seg
    const c0 = Math.cos(a0)
    const s0 = Math.sin(a0)
    const c1 = Math.cos(a1)
    const s1 = Math.sin(a1)
    // 안쪽 두 점(a,b)과 바깥 두 점(c,d): quad 의 '위쪽 색'이 바깥 색이 된다
    b.quad([x + r0 * c0, y, z + r0 * s0], [x + r0 * c1, y, z + r0 * s1], [x + r1 * c1, y, z + r1 * s1], [x + r1 * c0, y, z + r1 * s0], col, colOuter)
  }
}

/**
 * 가장자리가 흐려지는 바닥 그림자 사각형. 안쪽은 alpha, 바깥으로 soft 만큼 가며 0 이 된다.
 * (alpha 버텍스 컬러를 쓰는 빌더 전용)
 */
export function softRect(b: Builder, x0: number, z0: number, x1: number, z1: number, y: number, soft: number, col: RGB, alpha: number): void {
  const a = alpha
  b.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, col, [a, a, a, a])
  // 네 변
  b.quad([x0, y, z0], [x1, y, z0], [x1, y, z0 - soft], [x0, y, z0 - soft], col, col, [a, a, 0, 0])
  b.quad([x1, y, z1], [x0, y, z1], [x0, y, z1 + soft], [x1, y, z1 + soft], col, col, [a, a, 0, 0])
  b.quad([x1, y, z0], [x1, y, z1], [x1 + soft, y, z1], [x1 + soft, y, z0], col, col, [a, a, 0, 0])
  b.quad([x0, y, z1], [x0, y, z0], [x0 - soft, y, z0], [x0 - soft, y, z1], col, col, [a, a, 0, 0])
  // 네 귀퉁이
  b.quad([x1, y, z0], [x1 + soft, y, z0], [x1 + soft, y, z0 - soft], [x1, y, z0 - soft], col, col, [a, 0, 0, 0])
  b.quad([x0, y, z0], [x0, y, z0 - soft], [x0 - soft, y, z0 - soft], [x0 - soft, y, z0], col, col, [a, 0, 0, 0])
  b.quad([x1, y, z1], [x1, y, z1 + soft], [x1 + soft, y, z1 + soft], [x1 + soft, y, z1], col, col, [a, 0, 0, 0])
  b.quad([x0, y, z1], [x0 - soft, y, z1], [x0 - soft, y, z1 + soft], [x0, y, z1 + soft], col, col, [a, 0, 0, 0])
}

/**
 * 세로로 선 사각형(벽에 붙는 창문·간판·전단지). (nx,nz) 는 바라보는 방향.
 * 읽는 사람 기준 왼쪽 아래 → 오른쪽 아래 → 오른쪽 위 → 왼쪽 위 순서로 찍으므로 글자가 뒤집히지 않는다.
 */
export function facing(
  b: Builder,
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  nz: number,
  w: number,
  h: number,
  col: RGB,
  cTop: RGB = col,
  uv: AtlasRect | null = null,
): void {
  // 읽는 사람의 오른쪽 = up × n = (nz, 0, −nx)
  const rx = (nz * w) / 2
  const rz = (-nx * w) / 2
  const hh = h / 2
  b.quad([cx - rx, cy - hh, cz - rz], [cx + rx, cy - hh, cz + rz], [cx + rx, cy + hh, cz + rz], [cx - rx, cy + hh, cz - rz], col, cTop, null, uv)
}

/** 바닥 삼각형. 점 순서와 상관없이 위를 보게 만든다 */
export function floorTri(b: Builder, x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, y: number, col: RGB): void {
  // XZ 평면에서 (p1−p0)×(p2−p0) 의 y 성분이 양수여야 위를 본다
  const up = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0)
  if (up >= 0) b.tri([x0, y, z0], [x1, y, z1], [x2, y, z2], col)
  else b.tri([x0, y, z0], [x2, y, z2], [x1, y, z1], col)
}

/**
 * 바닥 사각형(임의 네 점, 알파 포함). 점 순서와 상관없이 위를 보게 만든다.
 * p0,p1 = 진한 쪽(벽 쪽), p2,p3 = 흐린 쪽으로 쓰면 접지 음영 띠가 된다.
 */
export function floorQuad(
  b: Builder,
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  y: number,
  col: RGB,
  alpha: readonly [number, number, number, number],
): void {
  const up = (p1[1] - p0[1]) * (p3[0] - p0[0]) - (p1[0] - p0[0]) * (p3[1] - p0[1])
  if (up >= 0) {
    b.quad([p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], [p3[0], y, p3[1]], col, col, alpha)
  } else {
    b.quad([p1[0], y, p1[1]], [p0[0], y, p0[1]], [p3[0], y, p3[1]], [p2[0], y, p2[1]], col, col, [alpha[1], alpha[0], alpha[3], alpha[2]])
  }
}
