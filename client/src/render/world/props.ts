/**
 * 소품: 가로수, 가로등, 부스, 지하철 출입구, 포장마차, 천막, 헌금함, 왕좌 …
 *
 * 치수는 shared/world/data.ts 의 PROP_SHAPE(충돌 모양)와 같은 값을 쓴다 — 보이는 것과 막히는 것이 같아야 한다.
 * 모든 소품은 로컬 좌표(앞 = +Z)로 적고 Builder.at() 으로 제자리에 놓는다.
 */
import type { Box } from '../../../../shared/world/def'
import { PROPS, type PropDef, propShape } from '../../../../shared/world/data'
import { type BuildCtx, type Layer, PAL, SHADOW_DIR, jitter } from './ctx'
import { FX_Y, HQ_FLOOR_Y, L2, L3 } from './ground'
import { type AtlasRect, type RGB, type V3, WHITE, beam, box, cyl, disc, facing, floorRect, ico, mul, rgb, softRect, wheel } from './geo'

const yawOf = (p: PropDef): number => p.yaw ?? 0

/** 로컬 (lx, lz) → 월드 (x, z) */
function toWorld(p: PropDef, lx: number, lz: number): [number, number] {
  const yaw = yawOf(p)
  const cs = Math.cos(yaw)
  const sn = Math.sin(yaw)
  return [p.x + lx * cs + lz * sn, p.z - lx * sn + lz * cs]
}

/** 간판 사각형은 아틀라스가 구워진 뒤에야 UV 를 알 수 있어 미뤄 둔다 */
function signAt(c: BuildCtx, L: Layer, p: PropDef, rect: AtlasRect, lx: number, ly: number, lz: number, nx: number, nz: number, w: number, h: number): void {
  const y = p.y ?? 0
  c.atlas.later(() => {
    L.unlit.at(p.x, y, p.z, yawOf(p))
    facing(L.unlit, lx, ly, lz, nx, nz, w, h, WHITE, WHITE, rect)
    L.unlit.origin()
  })
}

/** 소품 밑 둥근 그림자(해 반대쪽으로 조금 밀린다) */
function blob(L: Layer, x: number, z: number, rx: number, rz: number, alpha = 0.3, cast = 0): void {
  if (!L.fx) return
  disc(L.fx.origin(), x + SHADOW_DIR.x * cast, FX_Y, z + SHADOW_DIR.z * cast, rx, rz, 12, PAL.shade, alpha, 0)
}

/** 상자 소품 밑 네모 그림자(로컬 좌표) */
function rectShadow(L: Layer, p: PropDef, hx: number, hz: number, soft = 0.45, alpha = 0.32): void {
  if (!L.fx) return
  softRect(L.fx.at(p.x, 0, p.z, yawOf(p)), -hx, -hz, hx, hz, FX_Y, soft, PAL.shade, alpha)
  L.fx.origin()
}

/** 바닥에 번지는 불빛 */
function glow(L: Layer, x: number, z: number, r: number, col: RGB, alpha: number): void {
  if (!L.fx) return
  disc(L.fx.origin(), x, FX_Y + 0.015, z, r, r, 14, col, alpha, 0)
}

const TREE_COLORS: Record<string, [number, number, number]> = {
  green: [0x6fa35a, 0x86b765, 0x5c8f55],
  ginkgo: [0xe8c24a, 0xf0d368, 0xd9a93a],
  pink: [0xf2a9c0, 0xf7c3d2, 0xe58fb0],
}

export function buildProps(c: BuildCtx): void {
  for (const p of PROPS) {
    // 꾸밈 전용 소품은 낮은 품질에서 뺀다(충돌체가 없으니 길은 그대로다)
    if (p.deco && c.low) continue
    const L = p.hq ? c.hq : c.main
    BUILD[p.kind](c, L, p)
    L.solid.origin()
    L.decal.origin()
    L.unlit.origin()
    L.fx?.origin()
  }
  if (!c.low) {
    bunting(c)
    wires(c)
  }
}

type PropFn = (c: BuildCtx, L: Layer, p: PropDef) => void

const BUILD: Record<PropDef['kind'], PropFn> = {
  tree(c, L, p) {
    const rnd = c.rnd
    const s = 0.9 + rnd() * 0.25
    const b = L.solid.at(p.x, 0, p.z, rnd() * Math.PI * 2)
    cyl(b, 0, 0, 0, 0.6, 0.56, 0.26, 10, PAL.stone, { cap: PAL.soil, ao: 0.8 })
    cyl(b, 0, 0.26, 0, 0.15, 0.1, 2.0 * s, 6, PAL.woodDark, { cap: null, ao: 0.8 })
    const cols = TREE_COLORS[p.variant ?? 'green'] ?? TREE_COLORS.green!
    // 수관은 작고 낮게: 3인칭 카메라(높이 6~8m)가 나무 너머를 내려다볼 수 있어야 한다
    ico(b, 0, 3.15 * s, 0, 1.22 * s, 1.05 * s, 1.22 * s, rgb(cols[0]), rnd, 0.1)
    ico(b, 0.66 * s, 2.72 * s, 0.3 * s, 0.82 * s, 0.7 * s, 0.82 * s, rgb(cols[1]), rnd, 0.1)
    if (!c.low) ico(b, -0.55 * s, 2.84 * s, -0.42 * s, 0.86 * s, 0.74 * s, 0.86 * s, rgb(cols[2]), rnd, 0.1)
    blob(L, p.x, p.z, 1.9 * s, 1.6 * s, 0.34, 0.9)
  },

  lamp(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const u = L.unlit.at(p.x, 0, p.z, yawOf(p))
    cyl(b, 0, 0, 0, 0.17, 0.12, 0.35, 6, PAL.metal, { ao: 0.8 })
    if (p.variant === 'plaza') {
      // 광장 등: 낮은 기둥 위 둥근 등
      cyl(b, 0, 0.35, 0, 0.07, 0.06, 3.2, 6, PAL.metal, { cap: null })
      cyl(b, 0, 3.55, 0, 0.18, 0.26, 0.12, 6, PAL.metal)
      ico(u, 0, 3.97, 0, 0.3, 0.3, 0.3, rgb(0xfff1cc))
      if (!c.low) glow(L, p.x, p.z, 3.4, PAL.warmGlow, 0.2)
    } else {
      const purple = p.variant === 'purple'
      cyl(b, 0, 0.35, 0, 0.08, 0.06, 4.2, 6, PAL.metal, { cap: null })
      box(b, -0.05, 4.47, -0.05, 0.05, 4.57, 1.1, PAL.metal, { skip: '' })
      box(b, -0.17, 4.38, 0.7, 0.17, 4.49, 1.24, PAL.metal, { skip: '' })
      ico(u, 0, 4.28, 0.97, 0.15, 0.13, 0.15, purple ? rgb(0xdcb8ff) : rgb(0xfff0c4))
      if (!c.low) {
        const [gx, gz] = toWorld(p, 0, 0.97)
        glow(L, gx, gz, purple ? 3.4 : 3.0, purple ? PAL.purpleGlow : PAL.warmGlow, purple ? 0.3 : 0.15)
      }
    }
    blob(L, p.x, p.z, 0.4, 0.4, 0.32)
  },

  bench(_c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    box(b, -0.9, 0.36, -0.2, 0.9, 0.45, 0.26, PAL.wood, { skip: '' })
    box(b, -0.9, 0.45, -0.3, 0.9, 0.92, -0.2, mul(PAL.wood, 0.92), { skip: 'b' })
    for (const x of [-0.72, 0.72]) box(b, x - 0.05, 0, -0.27, x + 0.05, 0.36, 0.22, PAL.metal)
    rectShadow(L, p, 0.9, 0.3, 0.35, 0.3)
  },

  table(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    cyl(b, 0, 0, 0, 0.07, 0.07, 0.68, 5, PAL.metalLight, { cap: null })
    cyl(b, 0, 0.68, 0, 0.45, 0.45, 0.05, 10, PAL.white)
    cyl(b, -0.72, 0, 0, 0.2, 0.18, 0.44, 8, rgb(0x3a6fbf))
    cyl(b, 0.72, 0, 0, 0.2, 0.18, 0.44, 8, rgb(0xd8483a))
    c.parasols.push({ x: p.x, y: 0, z: p.z, scale: 0.9, color: p.color ?? 0x6b4fb3, phase: c.rnd() * 6 })
    blob(L, p.x, p.z, 1.5, 1.2, 0.26, 0.6)
  },

  booth(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const u = L.unlit.at(p.x, 0, p.z, yawOf(p))
    const cloth = rgb(p.color ?? 0x7b5ea7)
    box(b, -1, 0, -0.4, 1, 0.78, 0.4, cloth, { top: PAL.cream, ao: 0.82 })
    if (p.variant === 'meter') {
      // 기운 측정기: 안테나 달린 상자 + 손 올리는 금색 판
      box(b, -0.6, 0.78, -0.16, -0.18, 1.04, 0.14, PAL.metal)
      beam(b, [-0.39, 1.04, 0], [-0.39, 1.48, 0], 0.03, PAL.metalLight)
      ico(u, -0.39, 1.54, 0, 0.07, 0.07, 0.07, rgb(0x7dffb0))
      box(b, 0.05, 0.78, -0.2, 0.38, 0.82, 0.14, PAL.gold)
    } else if (p.variant === 'face') {
      // 수정 구슬
      cyl(b, -0.3, 0.78, 0, 0.16, 0.12, 0.08, 8, PAL.gold)
      ico(u, -0.3, 1.05, 0, 0.2, 0.2, 0.2, rgb(0xc3adff), c.rnd, 0.12)
      box(b, 0.1, 0.78, -0.15, 0.4, 0.8, 0.1, rgb(0x3a2410))
    } else {
      // 설문지 더미와 볼펜 통
      box(b, -0.62, 0.78, -0.2, -0.25, 0.84, 0.16, PAL.white)
      box(b, -0.15, 0.78, -0.14, 0.2, 0.87, 0.2, rgb(0xd9c9a0))
      cyl(b, 0.34, 0.78, -0.2, 0.06, 0.07, 0.17, 6, rgb(0x3a6fbf))
    }
    box(b, 0.5, 0.78, 0.04, 0.84, 0.85, 0.3, PAL.white)
    if (p.sign) signAt(c, L, p, c.atlas.sign(p.sign, 1.84, 0.54, 78), 0, 0.42, 0.412, 0, 1, 1.84, 0.54)
    // 파라솔은 탁자 뒤 가장자리에 꽂혀 있다(탁자 충돌 박스 안)
    const [px, pz] = toWorld(p, 0, -0.3)
    c.parasols.push({ x: px, y: 0, z: pz, scale: 1, color: p.color ?? 0x7b5ea7, phase: c.rnd() * 6 })
    rectShadow(L, p, 1, 0.4, 0.4, 0.3)
    blob(L, px, pz, 1.7, 1.5, 0.2, 0.9)
  },

  xbanner(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    box(b, -0.3, 0, -0.2, 0.3, 0.05, 0.2, PAL.metal)
    cyl(b, 0, 0.05, -0.03, 0.025, 0.025, 2.05, 4, PAL.metal, { cap: null })
    box(b, -0.32, 0.3, -0.012, 0.32, 2.1, 0.012, PAL.white, { skip: '' })
    if (p.sign) {
      const rect = c.atlas.sign(p.sign, 0.62, 1.76, 80)
      signAt(c, L, p, rect, 0, 1.2, 0.02, 0, 1, 0.62, 1.76)
      signAt(c, L, p, rect, 0, 1.2, -0.02, 0, -1, 0.62, 1.76)
    }
    blob(L, p.x, p.z, 0.5, 0.35, 0.28)
  },

  vending(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const col = rgb(p.color ?? 0xd8483a)
    box(b, -0.55, 0, -0.4, 0.55, 1.9, 0.4, col, { top: mul(col, 0.8), ao: 0.85 })
    box(b, -0.55, 1.9, -0.4, 0.55, 1.97, 0.45, mul(col, 0.7), { skip: '' })
    facing(L.decal.at(p.x, 0, p.z, yawOf(p)), 0, 0.3, 0.405, 0, 1, 0.74, 0.26, mul(PAL.metal, 0.7))
    if (p.sign) signAt(c, L, p, c.atlas.sign({ ...p.sign, vertical: true }, 0.92, 1.3, 72), 0, 1.16, 0.412, 0, 1, 0.92, 1.3)
    rectShadow(L, p, 0.55, 0.4, 0.4, 0.34)
    if (!c.low) {
      const [gx, gz] = toWorld(p, 0, 1.0)
      glow(L, gx, gz, 1.5, rgb(0xfff2d6), 0.2)
    }
  },

  van(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const d = L.decal.at(p.x, 0, p.z, yawOf(p))
    const u = L.unlit.at(p.x, 0, p.z, yawOf(p))
    const col = rgb(p.color ?? 0x4b3b78)
    const tyre = rgb(0x2a2830)
    box(b, -0.95, 0.32, -2.3, 0.95, 1.2, 2.3, col, { skip: '', ao: 0.82 })
    box(b, -0.9, 1.2, -2.25, 0.9, 1.98, 1.45, mul(col, 1.08), { top: mul(col, 1.22) })
    // 앞 유리(비스듬한 면)와 양옆 삼각형
    b.quad([-0.9, 1.2, 2.05], [0.9, 1.2, 2.05], [0.9, 1.98, 1.45], [-0.9, 1.98, 1.45], PAL.glassDark, PAL.glassSky)
    b.tri([0.9, 1.2, 1.45], [0.9, 1.98, 1.45], [0.9, 1.2, 2.05], col)
    b.tri([-0.9, 1.2, 1.45], [-0.9, 1.2, 2.05], [-0.9, 1.98, 1.45], col)
    for (const sx of [-1, 1]) facing(d, sx * 0.905, 1.6, -0.35, sx, 0, 3.1, 0.5, PAL.glassDark, PAL.glassSky)
    facing(d, 0, 1.6, -2.255, 0, -1, 1.5, 0.5, PAL.glassDark, PAL.glassSky)
    for (const sx of [-0.9, 0.9]) for (const sz of [-1.45, 1.45]) wheel(b, sx, 0.36, sz, 0.36, 0.26, 'x', 8, tyre, PAL.metalLight)
    for (const sx of [-0.62, 0.62]) {
      facing(u, sx, 0.78, 2.31, 0, 1, 0.34, 0.2, rgb(0xfff2c4))
      facing(u, sx, 0.82, -2.31, 0, -1, 0.3, 0.2, rgb(0xff5a4a))
    }
    // 지붕 확성기(출장 포교의 상징)
    box(b, -0.28, 1.98, 0.1, 0.28, 2.08, 0.7, PAL.metal)
    box(b, -0.2, 2.08, 0.15, 0.2, 2.36, 0.5, PAL.metalLight)
    box(b, -0.3, 2.04, 0.5, 0.3, 2.42, 0.8, mul(PAL.metalLight, 1.1))
    if (p.sign) {
      const rect = c.atlas.sign(p.sign, 2.9, 0.66, 66)
      signAt(c, L, p, rect, 0.962, 0.78, -0.25, 1, 0, 2.9, 0.66)
      signAt(c, L, p, rect, -0.962, 0.78, -0.25, -1, 0, 2.9, 0.66)
    }
    rectShadow(L, p, 0.95, 2.3, 0.6, 0.36)
  },

  truck(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const d = L.decal.at(p.x, 0, p.z, yawOf(p))
    const u = L.unlit.at(p.x, 0, p.z, yawOf(p))
    const col = rgb(p.color ?? 0x3f7fbf)
    const tyre = rgb(0x2a2830)
    // 운전석(앞 = +Z)
    box(b, -0.9, 0.4, 1.05, 0.9, 1.85, 2.25, col, { skip: '', ao: 0.85, top: mul(col, 1.18) })
    facing(d, 0, 1.42, 2.255, 0, 1, 1.5, 0.55, PAL.glassDark, PAL.glassSky)
    for (const sx of [-1, 1]) facing(d, sx * 0.905, 1.42, 1.66, sx, 0, 0.8, 0.5, PAL.glassDark, PAL.glassSky)
    for (const sx of [-0.6, 0.6]) facing(u, sx, 0.72, 2.26, 0, 1, 0.3, 0.18, rgb(0xfff2c4))
    // 짐칸과 붕어빵 조리대
    box(b, -0.95, 0.4, -2.25, 0.95, 0.9, 1.05, mul(col, 0.78), { skip: '' })
    box(b, -0.9, 0.9, -2.15, 0.9, 1.28, 0.9, PAL.wood, { top: mul(PAL.metal, 0.8) })
    for (let i = 0; i < 6; i++) {
      const z = -1.85 + i * 0.44
      box(b, 0.2, 1.28, z, 0.62, 1.36, z + 0.26, rgb(i % 3 === 2 ? 0xb8742a : 0xdba03e))
    }
    box(b, -0.7, 1.28, -1.6, -0.2, 1.52, -0.9, rgb(0xf3e9d2))
    // 기둥과 줄무늬 지붕
    for (const sx of [-0.88, 0.88]) for (const sz of [-2.1, 0.85]) box(b, sx - 0.04, 1.28, sz - 0.04, sx + 0.04, 2.4, sz + 0.04, PAL.metal)
    const n = 7
    for (let i = 0; i < n; i++) {
      const z0 = -2.35 + (3.4 * i) / n
      const z1 = -2.35 + (3.4 * (i + 1)) / n
      box(b, -1.15, 2.4, z0, 1.15, 2.5, z1, i % 2 === 0 ? rgb(0xf2c230) : PAL.white, { skip: i === 0 ? 's' : i === n - 1 ? 'n' : 'ns' })
    }
    // 양옆 처마 간판(인도 쪽 = +X)
    for (const sx of [-1, 1]) box(b, sx > 0 ? 1.1 : -1.16, 1.94, -1.95, sx > 0 ? 1.16 : -1.1, 2.42, 0.65, rgb(0xa8741c), { skip: '' })
    if (p.sign) {
      const rect = c.atlas.sign(p.sign, 2.5, 0.44, 80)
      signAt(c, L, p, rect, 1.172, 2.18, -0.65, 1, 0, 2.5, 0.44)
      signAt(c, L, p, rect, -1.172, 2.18, -0.65, -1, 0, 2.5, 0.44)
    }
    ico(u, 0.5, 2.22, -0.6, 0.09, 0.09, 0.09, rgb(0xfff0c4))
    for (const sx of [-0.9, 0.9]) for (const sz of [-1.5, 1.55]) wheel(b, sx, 0.34, sz, 0.34, 0.26, 'x', 8, tyre, PAL.metalLight)
    rectShadow(L, p, 1.0, 2.3, 0.6, 0.36)
    if (!c.low) {
      const [gx, gz] = toWorld(p, 1.9, -0.6)
      glow(L, gx, gz, 2.0, PAL.warmGlow, 0.22)
    }
  },

  scooter(c, L, p) {
    // 치킨집 배달 스쿠터(앞 = 로컬 +X)
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const col = rgb(p.color ?? 0xd8362a)
    const tyre = rgb(0x2a2830)
    for (const sx of [-0.58, 0.58]) wheel(b, sx, 0.24, 0, 0.24, 0.12, 'z', 8, tyre, PAL.metalLight)
    box(b, -0.3, 0.24, -0.14, 0.38, 0.34, 0.14, mul(col, 0.8), { skip: '' })
    box(b, -0.62, 0.3, -0.17, -0.05, 0.62, 0.17, col)
    box(b, -0.6, 0.62, -0.16, -0.1, 0.7, 0.16, PAL.metal)
    box(b, 0.38, 0.28, -0.16, 0.5, 0.95, 0.16, col, { top: mul(col, 1.15) })
    box(b, 0.41, 0.95, -0.3, 0.49, 1.02, 0.3, PAL.metal, { skip: '' })
    // 배달통
    box(b, -0.94, 0.62, -0.23, -0.6, 1.0, 0.23, PAL.white, { skip: '', top: col })
    facing(L.unlit.at(p.x, 0, p.z, yawOf(p)), 0.512, 0.8, 0, 1, 0, 0.14, 0.12, rgb(0xfff2c4))
    rectShadow(L, p, 0.85, 0.3, 0.35, 0.3)
  },

  busStop(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const frame = rgb(0x3a4a5e)
    const glass = rgb(0xa9cbdc)
    box(b, -1.9, 0.25, -0.78, 1.9, 2.2, -0.72, glass, { skip: '' })
    box(b, -1.98, 0.25, -0.72, -1.92, 2.2, 0.1, glass, { skip: '' })
    box(b, 1.92, 0.25, -0.72, 1.98, 2.2, 0.1, glass, { skip: '' })
    for (const x of [-1.95, 1.95]) {
      box(b, x - 0.06, 0, -0.8, x + 0.06, 2.32, -0.68, frame)
      box(b, x - 0.06, 0, 0.5, x + 0.06, 2.32, 0.62, frame)
    }
    box(b, -2.0, 2.32, -0.8, 2.0, 2.42, 0.62, frame, { skip: '', top: rgb(0x9db9c9) })
    box(b, -1.5, 0.42, -0.62, 0.1, 0.5, -0.24, PAL.wood, { skip: '' })
    for (const x of [-1.35, -0.05]) box(b, x - 0.04, 0, -0.56, x + 0.04, 0.42, -0.3, PAL.metal)
    if (p.sign) signAt(c, L, p, c.atlas.sign(p.sign, 1.7, 1.2, 66), 0.98, 1.32, -0.71, 0, 1, 1.7, 1.2)
    rectShadow(L, p, 2.0, 0.8, 0.5, 0.3)
  },

  subway(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const s = propShape(p)
    const hw = s.t === 'box' ? s.w / 2 : 1.7
    const hd = s.t === 'box' ? s.d / 2 : 3.2
    const t = SUBWAY_WALL
    const ph = 1.05
    const stone = PAL.stone
    // 난간벽(왼쪽, 오른쪽, 뒤). 앞(+Z)은 계단 입구
    box(b, -hw, 0, -hd, -hw + t, ph, hd, stone, { top: PAL.stoneDark, ao: 0.84 })
    box(b, hw - t, 0, -hd, hw, ph, hd, stone, { top: PAL.stoneDark, ao: 0.84 })
    box(b, -hw + t, 0, -hd, hw - t, ph, -hd + t, stone, { top: PAL.stoneDark, ao: 0.84, skip: 'bew' })
    // 계단: 입구에서 −Z 로 내려간다. 내려갈수록 어두워져 깊이감을 준다
    const steps = 10
    const run = 0.5
    const rise = 0.3
    const x0 = -hw + t
    const x1 = hw - t
    const stepCol = rgb(0xa29a92)
    for (let i = 0; i < steps; i++) {
      const z1 = hd - i * run
      const z0 = z1 - run
      const y = -(i + 1) * rise
      const k = Math.max(0.22, 1 - i * 0.085)
      b.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], mul(stepCol, k))
      // 챌판은 내려가는 쪽(−Z)을 본다
      b.quad([x1, y, z1], [x0, y, z1], [x0, y + rise, z1], [x1, y + rise, z1], mul(stepCol, k * 0.78))
    }
    const by = -steps * rise
    const zEnd = hd - steps * run
    const pit = rgb(0x2b2733)
    b.quad([x0, by, zEnd], [x1, by, zEnd], [x1, by, -hd + t], [x0, by, -hd + t], pit)
    const zc = (hd + -hd + t) / 2
    const zl = hd - (-hd + t)
    facing(b, x0, by / 2, zc, 1, 0, zl, -by, pit, mul(stone, 0.62))
    facing(b, x1, by / 2, zc, -1, 0, zl, -by, pit, mul(stone, 0.62))
    facing(b, 0, by / 2, -hd + t, 0, 1, x1 - x0, -by, pit, mul(stone, 0.5))
    // 캐노피
    const frame = rgb(0x3a4252)
    const roofGlass = rgb(0xb4d2e0)
    for (const sx of [-1, 1]) {
      for (const sz of [-2.9, 2.9]) {
        const px = sx * (hw - t / 2)
        box(b, px - 0.07, ph, sz - 0.07, px + 0.07, 2.72, sz + 0.07, frame)
      }
    }
    // 지붕은 밝은 유리색: 어두운 판이면 출구 앞 화면을 크게 가린다
    box(b, -hw - 0.2, 2.72, -hd - 0.2, hw + 0.2, 2.86, hd + 0.2, frame, { skip: 't' })
    floorRect(b, -hw - 0.2, -hd - 0.2, hw + 0.2, hd + 0.2, 2.86, mul(frame, 1.5))
    floorRect(b, -hw + 0.05, -hd + 0.05, hw - 0.05, hd - 0.05, 2.875, roofGlass)
    for (const z of [-1.6, 0, 1.6]) floorRect(b, -hw + 0.05, z - 0.05, hw - 0.05, z + 0.05, 2.89, mul(frame, 1.5))
    // 처마 간판: 긴 옆면 두 장 + 입구 한 장
    box(b, hw + 0.14, 2.2, -2.8, hw + 0.2, 2.72, 2.8, mul(frame, 0.8), { skip: '' })
    box(b, -hw - 0.2, 2.2, -2.8, -hw - 0.14, 2.72, 2.8, mul(frame, 0.8), { skip: '' })
    box(b, -1.6, 2.2, hd + 0.14, 1.6, 2.72, hd + 0.2, mul(frame, 0.8), { skip: '' })
    if (p.sign) {
      const rect = c.atlas.sign(p.sign, 5.4, 0.5, 62)
      signAt(c, L, p, rect, hw + 0.212, 2.46, 0, 1, 0, 5.4, 0.5)
      signAt(c, L, p, rect, -hw - 0.212, 2.46, 0, -1, 0, 5.4, 0.5)
    }
    if (p.sign2) signAt(c, L, p, c.atlas.sign(p.sign2, 3.0, 0.5, 62), 0, 2.46, hd + 0.212, 0, 1, 3.0, 0.5)
    // 계단 첫머리의 노란 미끄럼 방지 띠
    floorRect(L.decal.at(p.x, 0, p.z, yawOf(p)), x0, hd, x1, hd + 0.3, L2, PAL.tactile)
    rectShadow(L, p, hw + 0.2, hd + 0.2, 0.6, 0.22)
  },

  totem(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const dark = rgb(0x2a2f3a)
    box(b, -0.25, 0, -0.14, 0.25, 3.1, 0.14, dark, { ao: 0.8 })
    box(b, -0.28, 3.1, -0.17, 0.28, 3.2, 0.17, rgb(0xf2c230), { skip: '' })
    if (p.sign) {
      const rect = c.atlas.sign(p.sign, 0.46, 2.3, 84)
      signAt(c, L, p, rect, 0, 1.8, 0.152, 0, 1, 0.46, 2.3)
      signAt(c, L, p, rect, 0, 1.8, -0.152, 0, -1, 0.46, 2.3)
    }
    blob(L, p.x, p.z, 0.5, 0.4, 0.3)
  },

  stall(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const tarp = rgb(0xe8742d)
    const steel = rgb(0xbfc3cc)
    box(b, -1.65, 0, -0.05, 1.65, 0.86, 0.6, steel, { top: mul(steel, 1.1), ao: 0.84 })
    box(b, -1.3, 0.86, 0.02, -0.25, 0.95, 0.52, rgb(0xb02a18), { top: rgb(0xd9432a) })
    box(b, 0.15, 0.86, 0.02, 1.2, 1.02, 0.52, rgb(0xe0d2ac), { top: rgb(0xcbb88a) })
    for (let i = 0; i < 5; i++) beam(b, [0.3 + i * 0.2, 1.0, 0.27], [0.33 + i * 0.2, 1.42, 0.31], 0.02, rgb(0xd9b98a))
    // 주황 천막: 뒤·양옆 벽과 지붕
    box(b, -1.8, 0, -0.7, 1.8, 2.05, -0.64, tarp, { skip: 'b', ao: 0.84 })
    box(b, -1.8, 0, -0.64, -1.74, 2.05, 0.1, mul(tarp, 0.94), { skip: 'bn' })
    box(b, 1.74, 0, -0.64, 1.8, 2.05, 0.1, mul(tarp, 0.94), { skip: 'bn' })
    box(b, -1.9, 2.05, -0.75, 1.9, 2.17, 0.75, tarp, { skip: '', top: mul(tarp, 1.16) })
    for (const x of [-1.76, 1.76]) box(b, x - 0.03, 0, 0.64, x + 0.03, 2.05, 0.7, PAL.metal)
    box(b, -1.8, 1.58, 0.67, 1.8, 2.05, 0.73, mul(tarp, 0.8), { skip: '' })
    if (p.sign) signAt(c, L, p, c.atlas.sign(p.sign, 3.4, 0.42, 80), 0, 1.815, 0.742, 0, 1, 3.4, 0.42)
    ico(L.unlit.at(p.x, 0, p.z, yawOf(p)), 0, 1.45, 0.3, 0.09, 0.09, 0.09, rgb(0xfff0c4))
    rectShadow(L, p, 1.85, 0.72, 0.5, 0.34)
    if (!c.low) {
      const [gx, gz] = toWorld(p, 0, 1.4)
      glow(L, gx, gz, 2.2, PAL.warmGlow, 0.22)
    }
  },

  tent(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const R = p.r ?? 3.2
    const wallH = 2.35
    const apexY = 4.6
    const N = 12
    const eave = R + 0.3
    const purple = PAL.purple
    const cream = PAL.cream
    const door = rgb(0x140d24)
    const step = (Math.PI * 2) / N
    for (let k = 0; k < N; k++) {
      // k = 0 인 면이 정면(+Z)을 본다 = 입구
      const a0 = Math.PI / 2 - step / 2 + k * step
      const a1 = a0 + step
      const c0 = Math.cos(a0)
      const s0 = Math.sin(a0)
      const c1 = Math.cos(a1)
      const s1 = Math.sin(a1)
      const col = k === 0 ? door : k % 2 === 0 ? cream : purple
      b.quad([R * c1, 0, R * s1], [R * c0, 0, R * s0], [R * c0, wallH, R * s0], [R * c1, wallH, R * s1], mul(col, 0.8), col)
      const roof = k % 2 === 0 ? mul(purple, 0.82) : cream
      b.tri([eave * c1, wallH - 0.1, eave * s1], [eave * c0, wallH - 0.1, eave * s0], [0, apexY, 0], roof)
      // 처마 끝 금색 띠
      b.quad([eave * c1, wallH - 0.42, eave * s1], [eave * c0, wallH - 0.42, eave * s0], [eave * c0, wallH - 0.1, eave * s0], [eave * c1, wallH - 0.1, eave * s1], mul(PAL.gold, 0.85), PAL.gold)
    }
    ico(b, 0, apexY + 0.16, 0, 0.24, 0.24, 0.24, PAL.gold)
    cyl(b, 0, apexY - 0.3, 0, 0.05, 0.05, 0.4, 4, PAL.gold, { cap: null })
    const zf = R * Math.cos(step / 2)
    // 입구: 어둠 속에서 이쪽을 보는 두 눈
    if (p.sign2) signAt(c, L, p, c.atlas.sign(p.sign2, 1.5, 2.0, 62), 0, 1.05, zf + 0.02, 0, 1, 1.5, 2.0)
    // 입구 위 현수막
    // 현수막은 낮게 건다: 높으면 천막 뒤쪽 카메라에서 헌금함 앞 사람의 발을 가린다
    box(b, -1.8, 2.14, zf + 0.26, 1.8, 2.9, zf + 0.34, rgb(0x2a1d47), { skip: '' })
    if (p.sign) signAt(c, L, p, c.atlas.sign(p.sign, 3.5, 0.68, 72), 0, 2.52, zf + 0.352, 0, 1, 3.5, 0.68)
    blob(L, p.x, p.z, R + 1.3, R + 1.0, 0.36, 1.3)
  },

  offering(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const d = L.decal.at(p.x, 0, p.z, yawOf(p))
    const u = L.unlit.at(p.x, 0, p.z, yawOf(p))
    const wood = rgb(0x8a5630)
    // 붉은 깔개
    floorRect(d, -0.9, -0.75, 0.9, 0.95, L2, rgb(0x9b2d3a))
    floorRect(d, -0.8, -0.65, 0.8, -0.58, L3, PAL.gold)
    floorRect(d, -0.8, 0.78, 0.8, 0.85, L3, PAL.gold)
    box(b, -0.45, 0, -0.3, 0.45, 0.6, 0.3, wood, { ao: 0.8 })
    box(b, -0.48, 0.6, -0.33, 0.48, 0.74, 0.33, rgb(0x6a3a1e), { skip: '', top: rgb(0x7a4626) })
    for (const sx of [-1, 1]) box(b, sx > 0 ? 0.3 : -0.42, 0, -0.315, sx > 0 ? 0.42 : -0.3, 0.62, 0.315, PAL.gold, { skip: 'bt' })
    floorRect(d, -0.22, -0.04, 0.22, 0.04, 0.752, rgb(0x1a1210))
    if (p.sign) signAt(c, L, p, c.atlas.sign(p.sign, 0.56, 0.24, 130), 0, 0.33, 0.32, 0, 1, 0.56, 0.24)
    // 깔개 위 반짝이는 동전 몇 닢
    cyl(u, 0.62, L3, 0.55, 0.1, 0.1, 0.03, 8, rgb(0xffe07a))
    cyl(u, -0.6, L3, 0.62, 0.09, 0.09, 0.03, 8, rgb(0xffd257))
    cyl(u, 0.48, L3, 0.76, 0.08, 0.08, 0.03, 8, rgb(0xfff0a8))
    blob(L, p.x, p.z, 0.8, 0.65, 0.32)
  },

  planter(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const s = propShape(p)
    const w = s.t === 'box' ? s.w : 3
    const d = s.t === 'box' ? s.d : 1
    const rnd = c.rnd
    box(b, -w / 2, 0, -d / 2, w / 2, 0.5, d / 2, PAL.stone, { top: PAL.soil, ao: 0.82 })
    if (p.variant === 'flowers') {
      // 꽃집 앞 화분 줄
      const cols = [0xf28fb0, 0xffd257, 0xffffff, 0xf26a6a, 0xc79bff]
      const n = Math.max(3, Math.round(w / 0.5))
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 0.3 + ((w - 0.6) * i) / (n - 1)
        box(b, x - 0.16, 0.5, -0.14, x + 0.16, 0.66, 0.14, PAL.hedgeDark)
        ico(b, x, 0.8 + rnd() * 0.08, (rnd() - 0.5) * 0.1, 0.19, 0.17, 0.19, rgb(cols[i % cols.length]!), rnd, 0.08)
      }
    } else {
      const n = Math.max(1, Math.round(w / 1.3))
      for (let i = 0; i < n; i++) {
        const col = jitter(PAL.hedge, rnd, 0.08)
        box(b, -w / 2 + 0.1 + ((w - 0.2) * i) / n, 0.5, -d / 2 + 0.1, -w / 2 + 0.1 + ((w - 0.2) * (i + 1)) / n, 0.95 + rnd() * 0.2, d / 2 - 0.1, col, { top: mul(col, 1.12) })
      }
    }
    rectShadow(L, p, w / 2, d / 2, 0.4, 0.3)
  },

  signpost(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    if (p.variant === 'aframe') {
      // A자 입간판: 앞뒤로 기울어진 두 판
      const col = rgb(p.sign?.bg ?? 0xfff2b0)
      const dk = mul(col, 0.55)
      b.quad([-0.3, 0, 0.22], [0.3, 0, 0.22], [0.3, 1.0, 0.02], [-0.3, 1.0, 0.02], dk, dk)
      b.quad([0.3, 0, -0.22], [-0.3, 0, -0.22], [-0.3, 1.0, -0.02], [0.3, 1.0, -0.02], dk, dk)
      b.tri([-0.3, 0, -0.22], [-0.3, 0, 0.22], [-0.3, 1.0, 0], dk)
      b.tri([0.3, 0, 0.22], [0.3, 0, -0.22], [0.3, 1.0, 0], dk)
      if (p.sign) {
        const rect = c.atlas.sign(p.sign, 0.54, 0.88, 92)
        const y = p.y ?? 0
        c.atlas.later(() => {
          const u = L.unlit.at(p.x, y, p.z, yawOf(p))
          u.quad([-0.27, 0.07, 0.222], [0.27, 0.07, 0.222], [0.27, 0.95, 0.046], [-0.27, 0.95, 0.046], WHITE, WHITE, null, rect)
          u.quad([0.27, 0.07, -0.222], [-0.27, 0.07, -0.222], [-0.27, 0.95, -0.046], [0.27, 0.95, -0.046], WHITE, WHITE, null, rect)
          u.origin()
        })
      }
      blob(L, p.x, p.z, 0.45, 0.4, 0.3)
      return
    }
    if (p.variant === 'bunting') {
      // 깃발 줄을 매는 장대
      cyl(b, 0, 0, 0, 0.07, 0.05, BUNTING_POLE_H, 5, rgb(0x8a5630), { cap: null, ao: 0.8 })
      ico(b, 0, BUNTING_POLE_H + 0.08, 0, 0.11, 0.11, 0.11, PAL.gold)
      blob(L, p.x, p.z, 0.3, 0.3, 0.28)
      return
    }
    // 버스 정류장 표지 / 일반 표지판
    cyl(b, 0, 0, 0, 0.06, 0.05, 2.75, 5, PAL.metal, { cap: null, ao: 0.8 })
    const bg = rgb(p.sign?.bg ?? 0x2f6fbf)
    box(b, -0.4, 2.02, -0.035, 0.4, 2.72, 0.035, mul(bg, 0.7), { skip: '' })
    box(b, -0.22, 1.1, -0.025, 0.22, 1.62, 0.025, PAL.white, { skip: '' })
    if (p.sign) {
      const rect = c.atlas.sign(p.sign, 0.74, 0.62, 100)
      signAt(c, L, p, rect, 0, 2.37, 0.048, 0, 1, 0.74, 0.62)
      signAt(c, L, p, rect, 0, 2.37, -0.048, 0, -1, 0.74, 0.62)
    }
    blob(L, p.x, p.z, 0.3, 0.3, 0.28)
  },

  bollard(_c, L, p) {
    const b = L.solid.at(p.x, 0, p.z)
    cyl(b, 0, 0, 0, 0.14, 0.13, 0.85, 6, PAL.metal, { ao: 0.8 })
    cyl(b, 0, 0.55, 0, 0.145, 0.145, 0.12, 6, PAL.tactile, { cap: null })
    blob(L, p.x, p.z, 0.3, 0.3, 0.28)
  },

  signal(c, L, p) {
    const yaw = yawOf(p)
    const b = L.solid.at(p.x, 0, p.z, yaw)
    const housing = rgb(0x23262e)
    cyl(b, 0, 0, 0, 0.1, 0.07, 3.0, 6, PAL.metal, { cap: null, ao: 0.8 })
    box(b, -0.19, 2.2, 0.02, 0.19, 2.98, 0.26, housing, { skip: '' })
    box(b, -0.22, 2.98, 0, 0.22, 3.03, 0.42, housing, { skip: '' })
    box(b, -0.07, 1.0, 0.06, 0.07, 1.25, 0.15, PAL.tactile, { skip: '' })
    // 꺼진 등(어두운 색)은 늘 보이고, 켜진 등은 신호 전용 버퍼가 번갈아 덮는다
    const d = L.decal.at(p.x, 0, p.z, yaw)
    facing(d, 0, 2.76, 0.265, 0, 1, 0.26, 0.28, rgb(0x4a1c1c))
    facing(d, 0, 2.42, 0.265, 0, 1, 0.26, 0.28, rgb(0x173824))
    facing(c.sigRed.at(p.x, 0, p.z, yaw), 0, 2.76, 0.28, 0, 1, 0.26, 0.28, rgb(0xff4a3a), rgb(0xff7a5e))
    facing(c.sigGreen.at(p.x, 0, p.z, yaw), 0, 2.42, 0.28, 0, 1, 0.26, 0.28, rgb(0x38e07a), rgb(0x7dffb0))
    c.sigRed.origin()
    c.sigGreen.origin()
    blob(L, p.x, p.z, 0.3, 0.3, 0.3)
  },

  pole(_c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    cyl(b, 0, 0, 0, 0.18, 0.12, POLE_H, 6, PAL.concrete, { ao: 0.78 })
    box(b, -0.95, POLE_H - 0.9, -0.06, 0.95, POLE_H - 0.78, 0.06, PAL.woodDark, { skip: '' })
    cyl(b, 0.34, POLE_H - 2.3, 0, 0.26, 0.26, 0.7, 6, PAL.metalLight)
    blob(L, p.x, p.z, 0.4, 0.4, 0.3)
  },

  crate(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const s = propShape(p)
    const w = s.t === 'box' ? s.w : 1.4
    const d = s.t === 'box' ? s.d : 1.4
    const rnd = c.rnd
    if (p.variant === 'flyers') {
      // 전단지가 가득 든 종이 상자
      const card = rgb(0xc9a878)
      box(b, -w / 2, 0, -d / 2, w / 2, 0.62, d / 2, card, { top: mul(card, 1.1), ao: 0.8 })
      box(b, -w / 2 + 0.12, 0.62, -d / 2 + 0.1, w / 2 - 0.5, 1.1, d / 2 - 0.45, mul(card, 0.92), { top: PAL.white })
      box(b, w / 2 - 0.45, 0.62, d / 2 - 0.5, w / 2 - 0.08, 0.8, d / 2 - 0.1, PAL.white)
    } else {
      const wood = jitter(rgb(0xb08a5a), rnd, 0.06)
      box(b, -w / 2, 0, -d / 2, w / 2, 0.8, d / 2, wood, { top: mul(wood, 1.1), ao: 0.78 })
      box(b, -w / 2 + 0.1, 0.8, -d / 2 + 0.12, w / 2 - 0.55, 1.4, d / 2 - 0.5, mul(wood, 0.88), { top: mul(wood, 1.0) })
      // 띠 두른 느낌의 어두운 가로 판
      box(b, -w / 2 - 0.01, 0.34, -d / 2 - 0.01, w / 2 + 0.01, 0.46, d / 2 + 0.01, mul(wood, 0.7), { skip: 'bt' })
    }
    rectShadow(L, p, w / 2, d / 2, 0.4, 0.32)
  },

  trash(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    ico(b, -0.12, 0.26, 0.05, 0.3, 0.28, 0.3, rgb(0x2e2c36), c.rnd, 0.1)
    ico(b, 0.2, 0.2, -0.14, 0.24, 0.22, 0.24, rgb(0x4a6fa8), c.rnd, 0.1)
    ico(b, 0.04, 0.18, 0.26, 0.2, 0.19, 0.2, rgb(0xe6e2da), c.rnd, 0.08)
    blob(L, p.x, p.z, 0.6, 0.55, 0.3)
  },

  cone(_c, L, p) {
    const b = L.solid.at(p.x, 0, p.z)
    box(b, -0.2, 0, -0.2, 0.2, 0.04, 0.2, PAL.orange)
    cyl(b, 0, 0.04, 0, 0.16, 0.035, 0.58, 8, PAL.orange, { cap: PAL.orange })
    cyl(b, 0, 0.26, 0, 0.115, 0.09, 0.12, 8, PAL.white, { cap: null })
    blob(L, p.x, p.z, 0.3, 0.3, 0.28)
  },

  banner(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const s = propShape(p)
    const w = s.t === 'ends' ? s.w : 9
    const road = p.variant === 'road'
    const board = p.variant === 'board'
    const poleH = road ? 5.9 : board ? 2.55 : 4.15
    const y0 = road ? 4.5 : board ? 1.05 : 2.75
    const y1 = road ? 5.65 : board ? 2.4 : 3.95
    for (const sx of [-1, 1]) {
      cyl(b, (sx * w) / 2, 0, 0, 0.11, 0.08, poleH, 6, PAL.metal, { ao: 0.8 })
      ico(b, (sx * w) / 2, poleH + 0.08, 0, 0.12, 0.12, 0.12, PAL.gold)
      const [wx, wz] = toWorld(p, (sx * w) / 2, 0)
      blob(L, wx, wz, 0.32, 0.32, 0.3)
    }
    if (p.sign) {
      const cw = w - 0.3
      const rect = c.atlas.sign(p.sign, cw, y1 - y0, board ? 70 : 46)
      signAt(c, L, p, rect, 0, (y0 + y1) / 2, 0.012, 0, 1, cw, y1 - y0)
      signAt(c, L, p, rect, 0, (y0 + y1) / 2, -0.012, 0, -1, cw, y1 - y0)
    }
  },

  wall(_c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const s = propShape(p)
    const w = s.t === 'box' ? s.w : 0.4
    const d = s.t === 'box' ? s.d : 8
    const h = p.h ?? 1.9
    const brick = rgb(0xb5694f)
    box(b, -w / 2, 0, -d / 2, w / 2, h, d / 2, brick, { ao: 0.76, skip: 'bt' })
    box(b, -w / 2 - 0.05, h, -d / 2 - 0.05, w / 2 + 0.05, h + 0.12, d / 2 + 0.05, PAL.stone, { skip: '' })
    // 벽돌 줄눈 느낌의 어두운 띠
    const dc = L.decal.at(p.x, 0, p.z, yawOf(p))
    for (const y of [0.55, 1.1, 1.62]) {
      for (const sx of [-1, 1]) facing(dc, (sx * w) / 2 + sx * 0.012, y, 0, sx, 0, d, 0.05, mul(brick, 0.78))
    }
    rectShadow(L, p, w / 2, d / 2, 0.5, 0.3)
  },

  throne(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const red = rgb(0xa5303b)
    const gold = PAL.gold
    box(b, -0.9, 0, -0.7, 0.9, 0.24, 0.7, PAL.purpleDeep, { top: mul(PAL.purple, 0.9), ao: 0.85 })
    box(b, -0.5, 0.24, -0.45, 0.5, 0.74, 0.25, red, { top: mul(red, 1.15) })
    box(b, -0.62, 0.24, -0.62, 0.62, 2.35, -0.42, gold, { ao: 0.85 })
    box(b, -0.46, 0.8, -0.42, 0.46, 2.05, -0.4, red, { skip: 'bn' })
    for (const sx of [-1, 1]) box(b, sx > 0 ? 0.5 : -0.66, 0.24, -0.42, sx > 0 ? 0.66 : -0.5, 1.08, 0.28, gold, { top: mul(gold, 1.12) })
    for (const sx of [-0.62, 0.62]) ico(b, sx, 2.48, -0.52, 0.14, 0.14, 0.14, gold)
    ico(L.unlit.at(p.x, 0, p.z, yawOf(p)), 0, 2.62, -0.52, 0.2, 0.2, 0.2, rgb(0xd9b3ff), c.rnd, 0.1)
    // 왕좌 밑 어두운 자국(방 안에는 반투명 그림자 층이 없어서 카펫 위에 진한 색으로 깐다)
    floorRect(L.decal.at(p.x, 0, p.z, yawOf(p)), -1.05, -0.85, 1.05, 0.85, HQ_FLOOR_Y + 0.01, rgb(0x3a2658))
  },

  lantern(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z)
    cyl(b, 0, 0, 0, 0.2, 0.14, 0.12, 6, PAL.gold)
    cyl(b, 0, 0.12, 0, 0.04, 0.04, 1.2, 4, PAL.metal, { cap: null })
    cyl(b, 0, 1.3, 0, 0.14, 0.2, 0.08, 6, PAL.gold)
    ico(L.unlit.at(p.x, 0, p.z), 0, 1.6, 0, 0.2, 0.24, 0.2, rgb(0xffdc9c), c.rnd, 0.08)
  },

  crystal(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z)
    cyl(b, 0, 0, 0, 0.55, 0.46, 0.5, 8, PAL.purpleDeep, { cap: PAL.gold, ao: 0.85 })
    // 기운 충전 수정: 길쭉한 덩어리가 조명 없이 빛난다
    ico(L.unlit.at(p.x, 0, p.z, 0.4), 0, 1.45, 0, 0.42, 0.95, 0.42, rgb(0xc79bff), c.rnd, 0.22)
  },

  cushion(_c, L, p) {
    const b = L.solid.at(p.x, 0, p.z)
    const col = rgb(p.color ?? 0xb5383f)
    cyl(b, 0, HQ_FLOOR_Y, 0, 0.42, 0.36, 0.13, 10, mul(col, 0.8), { cap: col })
    disc(L.decal.at(p.x, 0, p.z), 0, HQ_FLOOR_Y + 0.14, 0, 0.1, 0.1, 6, PAL.gold)
  },

  pigeon(c, _L, p) {
    c.pigeons.push({ x: p.x, y: 0, z: p.z, yaw: yawOf(p), phase: c.rnd() * 10 })
  },

  acunit(_c, L, p) {
    const y = p.y ?? 2.6
    const b = L.solid.at(p.x, y, p.z, yawOf(p))
    box(b, -0.42, 0, 0, 0.42, 0.58, 0.32, PAL.metalLight, { skip: 'n', top: mul(PAL.metalLight, 1.1) })
    box(b, -0.36, -0.1, 0, -0.3, 0, 0.3, PAL.metal, { skip: 'n' })
    box(b, 0.3, -0.1, 0, 0.36, 0, 0.3, PAL.metal, { skip: 'n' })
    facing(L.decal.at(p.x, y, p.z, yawOf(p)), -0.08, 0.29, 0.325, 0, 1, 0.42, 0.42, mul(PAL.metal, 0.8))
  },

  flyer(c, L, p) {
    if (!p.sign) return
    signAt(c, L, p, c.atlas.sign(p.sign, 0.66, 0.46, 110), 0, 0, 0.03, 0, 1, 0.66, 0.46)
  },

  barricade(c, L, p) {
    const b = L.solid.at(p.x, 0, p.z, yawOf(p))
    const w = p.w ?? 20
    const n = Math.max(2, Math.round(w / 1.3))
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + (w * i) / n
      const x1 = -w / 2 + (w * (i + 1)) / n
      const skip = i === 0 ? 'e' : i === n - 1 ? 'w' : 'ew'
      box(b, x0, 0.66, -0.04, x1, 1.02, 0.04, i % 2 === 0 ? PAL.orange : PAL.white, { skip })
      box(b, x0, 0.18, -0.04, x1, 0.44, 0.04, i % 2 === 0 ? PAL.white : PAL.orange, { skip })
    }
    for (let x = -w / 2 + 0.3; x <= w / 2; x += 2.6) box(b, x - 0.05, 0, -0.26, x + 0.05, 1.08, 0.26, PAL.metal)
    // 안내판
    const bg = rgb(p.sign?.bg ?? 0xffd24a)
    for (const x of [-2.1, 2.1]) box(b, x - 0.05, 1.02, -0.05, x + 0.05, 2.7, 0.05, PAL.metal)
    box(b, -2.4, 1.4, -0.06, 2.4, 2.75, 0.06, mul(bg, 0.6), { skip: '' })
    if (p.sign) signAt(c, L, p, c.atlas.sign(p.sign, 4.6, 1.2, 50), 0, 2.07, 0.072, 0, 1, 4.6, 1.2)
    const u = L.unlit.at(p.x, 0, p.z, yawOf(p))
    for (const x of [-2.3, 2.3]) ico(u, x, 2.9, 0, 0.13, 0.13, 0.13, rgb(0xffb23a))
  },
}

const SUBWAY_WALL = 0.28
/** 전선이 기본 카메라 높이(≈8m)보다 위에 걸리도록 넉넉히 높다 */
const POLE_H = 10
const BUNTING_POLE_H = 3.3

/** 지하철 계단 구멍(월드 박스). 지면에 이만큼 구멍을 내야 계단이 땅 밑으로 보인다 */
export function subwayHole(): Box {
  const p = PROPS.find((q) => q.kind === 'subway')
  if (!p) return { x0: 0, z0: 0, x1: 0, z1: 0 }
  const s = propShape(p)
  const hw = (s.t === 'box' ? s.w : 3.4) / 2 - SUBWAY_WALL
  const hd = (s.t === 'box' ? s.d : 6.4) / 2
  const a = toWorld(p, -hw, -hd + SUBWAY_WALL)
  const b = toWorld(p, hw, hd)
  return { x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]) }
}

const FLAG_COLORS = [0x7b5ea7, 0xf2c230, 0xf28fb0, 0x6fc7b0, 0xf3e9d2, 0xe8552d]

/** 장대에서 천막 꼭대기로 이어지는 삼각 깃발 줄 */
function bunting(c: BuildCtx): void {
  const tent = PROPS.find((p) => p.kind === 'tent')
  if (!tent) return
  const apex: V3 = [tent.x, 4.78, tent.z]
  const b = c.main.solid.origin()
  const rope = rgb(0x4a4040)
  let ci = 0
  for (const pole of PROPS) {
    if (pole.kind !== 'signpost' || pole.variant !== 'bunting') continue
    const a: V3 = [pole.x, BUNTING_POLE_H, pole.z]
    const dx = apex[0] - a[0]
    const dz = apex[2] - a[2]
    const len = Math.hypot(dx, dz)
    const n = Math.max(2, Math.floor(len / 0.7))
    // 줄 방향으로 로컬 X 를 맞추는 yaw: 로컬 X = (cos yaw, −sin yaw)
    const yaw = Math.atan2(-dz, dx)
    let prev = a
    for (let i = 1; i <= n; i++) {
      const t = i / n
      // 가운데가 처지는 줄
      const pt: V3 = [a[0] + dx * t, a[1] + (apex[1] - a[1]) * t - 0.55 * 4 * t * (1 - t), a[2] + dz * t]
      beam(b, prev, pt, 0.025, rope)
      if (i < n) c.flags.push({ x: pt[0], y: pt[1], z: pt[2], yaw, w: 0.36, h: 0.46, color: FLAG_COLORS[ci++ % FLAG_COLORS.length]!, phase: c.rnd() * 6 })
      prev = pt
    }
  }
}

/** 골목 전봇대 사이로 늘어진 전선 */
function wires(c: BuildCtx): void {
  const poles = PROPS.filter((p) => p.kind === 'pole')
  const b = c.main.solid.origin()
  const col = rgb(0x2e2a36)
  for (let i = 0; i + 1 < poles.length; i++) {
    const p = poles[i]!
    const q = poles[i + 1]!
    for (const off of [-0.7, 0.7]) {
      const a: V3 = [p.x + off, POLE_H - 0.78, p.z]
      const e: V3 = [q.x + off, POLE_H - 0.78, q.z]
      const seg = 5
      let prev = a
      for (let k = 1; k <= seg; k++) {
        const t = k / seg
        const pt: V3 = [a[0] + (e[0] - a[0]) * t, a[1] - (0.5 + Math.abs(off) * 0.3) * 4 * t * (1 - t), a[2] + (e[2] - a[2]) * t]
        beam(b, prev, pt, 0.016, col)
        prev = pt
      }
    }
  }
}
