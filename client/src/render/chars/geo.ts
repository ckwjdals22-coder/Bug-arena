/**
 * 캐릭터 부위 지오메트리를 코드로 조립하는 작은 도구.
 *
 * 하나의 풀(InstancedMesh)이 여러 "변형(variant)"을 한 지오메트리에 담고,
 * 정점 셰이더가 인스턴스가 고른 변형만 남기고 나머지를 0으로 접는다.
 * 그래서 정점마다 [색 마스크, 변형 번호] 를 함께 굽는다.
 *  - 마스크 0: 고정색(정점색 그대로)
 *  - 마스크 1: 인스턴스 주색(instanceColor) × 정점 명암
 *  - 마스크 2: 인스턴스 보조색(iB.rgb) × 정점 명암
 */
import * as THREE from 'three'

export type RGB = [number, number, number]

const _col = new THREE.Color()

/** sRGB 16진수 → 선형 작업 색공간 RGB (인스턴스/정점 색은 전부 선형으로 넣는다) */
export function lin(hex: number): RGB {
  _col.setHex(hex)
  return [_col.r, _col.g, _col.b]
}

/** 선형 RGB 두 개를 섞는다 */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** 채도/밝기 조절(선형 공간에서의 근사). NPC 를 플레이어보다 살짝 차분하게 만드는 데 쓴다 */
export function tone(c: RGB, sat: number, mul: number): RGB {
  const l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
  return [(l + (c[0] - l) * sat) * mul, (l + (c[1] - l) * sat) * mul, (l + (c[2] - l) * sat) * mul]
}

export const MASK_FIXED = 0
export const MASK_A = 1
export const MASK_B = 2

export interface AddOpts {
  /** sRGB 색. 마스크 0 이면 최종색, 1/2 면 보통 생략(흰색) */
  color?: number
  /** 선형 명암 배수(기본 1). 마스크 1/2 에서 같은 인스턴스 색의 진한/연한 부분을 만든다 */
  mul?: number
  mask?: number
  alpha?: number
  /** 면 단위 법선(각진 로우폴리 느낌) */
  flat?: boolean
  /** 정점 위치별 추가 명암 */
  shade?: (x: number, y: number, z: number) => number
  /** 면(삼각형)별 추가 명암 — flat 일 때만 의미가 있다(은박지의 구김 등) */
  faceShade?: (faceIndex: number) => number
}

/** 이동·회전(XYZ 오일러)·크기 행렬. 빌드 시점에만 쓰므로 매번 새로 만든다 */
export function TRS(
  px = 0,
  py = 0,
  pz = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  )
}

export class GeoBuilder {
  private pos: number[] = []
  private nor: number[] = []
  private col: number[] = []
  private sel: number[] = []
  private idx: number[] = []
  /** 이후 add 되는 조각이 속할 변형 번호. -1 = 항상 보임 */
  variant = -1
  /** 변형별 인덱스 범위. 변형마다 따로 그리는 풀(SplitPool)이 드로 범위로 쓴다 */
  private ranges = new Map<number, IndexRange>()

  get vertexCount(): number {
    return this.pos.length / 3
  }

  /** 지오메트리 조각을 변환해 덧붙인다. 넘겨받은 지오메트리는 소비(dispose)한다 */
  add(src: THREE.BufferGeometry, m: THREE.Matrix4 | null = null, o: AddOpts = {}): this {
    let g = src
    let flip = false
    if (m) {
      g.applyMatrix4(m)
      // 거울 변환이면 면 방향이 뒤집히므로 삼각형 순서를 되돌린다
      flip = m.determinant() < 0
    }
    if (o.flat) {
      if (g.index) {
        const ng = g.toNonIndexed()
        g.dispose()
        g = ng
      }
      g.computeVertexNormals()
    } else if (!g.getAttribute('normal')) {
      g.computeVertexNormals()
    }
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    const base = this.pos.length / 3
    const c = lin(o.color ?? 0xffffff)
    const mul = o.mul ?? 1
    const mask = o.mask ?? MASK_FIXED
    const alpha = o.alpha ?? 1
    const sgn = flip && o.flat ? -1 : 1
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      this.pos.push(x, y, z)
      this.nor.push(n.getX(i) * sgn, n.getY(i) * sgn, n.getZ(i) * sgn)
      let k = mul
      if (o.shade) k *= o.shade(x, y, z)
      if (o.faceShade && o.flat) k *= o.faceShade(Math.floor(i / 3))
      this.col.push(c[0] * k, c[1] * k, c[2] * k, alpha)
      this.sel.push(mask, this.variant)
    }
    const index = g.index
    const count = index ? index.count : p.count
    const start = this.idx.length
    for (let i = 0; i < count; i += 3) {
      const a = base + (index ? index.getX(i) : i)
      const b = base + (index ? index.getX(i + 1) : i + 1)
      const d = base + (index ? index.getX(i + 2) : i + 2)
      if (flip) this.idx.push(a, d, b)
      else this.idx.push(a, b, d)
    }
    const r = this.ranges.get(this.variant)
    if (!r) {
      this.ranges.set(this.variant, { start, count: this.idx.length - start })
    } else {
      // 같은 변형의 조각은 이어서 넣어야 드로 범위 하나로 그릴 수 있다
      if (r.start + r.count !== start) throw new Error(`변형 ${this.variant} 의 조각이 떨어져 있다`)
      r.count = this.idx.length - r.start
    }
    g.dispose()
    return this
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4))
    g.setAttribute('aSel', new THREE.Float32BufferAttribute(this.sel, 2))
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    // 풀은 frustumCulled=false 로 쓰지만, 혹시 모를 경계 계산이 변형 전체를 훑지 않도록 넉넉한 구를 미리 넣어 둔다
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    g.userData.ranges = this.ranges
    return g
  }
}

export interface IndexRange {
  start: number
  count: number
}

/** build() 가 남긴 변형별 인덱스 범위 */
export function variantRanges(g: THREE.BufferGeometry): Map<number, IndexRange> {
  return (g.userData.ranges as Map<number, IndexRange> | undefined) ?? new Map<number, IndexRange>()
}

// ───────── 기본 도형 ─────────

export function sphere(r: number, ws: number, hs: number, phi0 = 0, phiLen = Math.PI * 2, th0 = 0, thLen = Math.PI): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, ws, hs, phi0, phiLen, th0, thLen)
}

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d)
}

export function cyl(rTop: number, rBottom: number, h: number, seg: number, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open)
}

export function cone(r: number, h: number, seg: number, open = false): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, h, seg, 1, open)
}

export function torus(R: number, r: number, tubeSeg: number, radSeg: number, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(R, r, tubeSeg, radSeg, arc)
}

/**
 * 회전체. profile 은 [반지름, 높이] 를 아래→위 순서로. phi=0 이 +Z(앞), 커질수록 +X 쪽으로 돈다.
 * 법선은 항상 바깥을 향한다(three 내장 Lathe 는 방향을 신경 써야 해서 직접 만든다).
 */
export function lathe(profile: readonly (readonly [number, number])[], seg: number, phi0 = 0, phiLen = Math.PI * 2): THREE.BufferGeometry {
  const n = profile.length
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const nr: number[] = []
  const ny: number[] = []
  for (let i = 0; i < n; i++) {
    const a = profile[Math.max(0, i - 1)]!
    const b = profile[Math.min(n - 1, i + 1)]!
    const tx = b[0] - a[0]
    const ty = b[1] - a[1]
    const l = Math.hypot(tx, ty) || 1
    nr.push(ty / l)
    ny.push(-tx / l)
  }
  for (let j = 0; j <= seg; j++) {
    const phi = phi0 + (phiLen * j) / seg
    const s = Math.sin(phi)
    const c = Math.cos(phi)
    for (let i = 0; i < n; i++) {
      const pt = profile[i]!
      pos.push(pt[0] * s, pt[1], pt[0] * c)
      nor.push(nr[i]! * s, ny[i]!, nr[i]! * c)
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = (j + 1) * n + i
      const c = (j + 1) * n + i + 1
      const d = j * n + i + 1
      idx.push(a, b, c, a, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setIndex(idx)
  return g
}

/** +Z 를 보는 납작한 볼록 다각형(얼굴 부품용). 점은 반시계 방향 */
export function poly(points: readonly (readonly [number, number])[], z = 0): THREE.BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p[0]
    cy += p[1]
  }
  cx /= points.length
  cy /= points.length
  pos.push(cx, cy, z)
  nor.push(0, 0, 1)
  for (const p of points) {
    pos.push(p[0], p[1], z)
    nor.push(0, 0, 1)
  }
  for (let i = 0; i < points.length; i++) {
    idx.push(0, 1 + i, 1 + ((i + 1) % points.length))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setIndex(idx)
  return g
}

/** +Z 를 보는 띠(두 점열 사이를 잇는 사각형 줄). 초승달 눈·입꼬리 같은 휘어진 선에 쓴다 */
export function strip(outer: readonly (readonly [number, number])[], inner: readonly (readonly [number, number])[], z = 0): THREE.BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const n = Math.min(outer.length, inner.length)
  for (let i = 0; i < n; i++) {
    pos.push(outer[i]![0], outer[i]![1], z, inner[i]![0], inner[i]![1], z)
    nor.push(0, 0, 1, 0, 0, 1)
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    // 점열이 왼→오른쪽(바깥이 위)일 때 +Z 에서 반시계가 되도록
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setIndex(idx)
  return g
}

/** 결정적 의사 난수(지오메트리 구김 등 — 매번 같은 모양이 나와야 한다) */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
