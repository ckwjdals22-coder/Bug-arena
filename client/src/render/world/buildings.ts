/**
 * 건물: 상가(1층 가게 + 위층 간판), 사무용 건물, 배경 건물, 아파트, 그리고 비밀 교단 건물.
 *
 * 핵심 규칙 — "보이지 않는 면은 만들지 않는다":
 *  - 이웃 건물에 가려진 벽은 건너뛴다(exposed). 3인칭 카메라가 건물 덩어리 '안'으로 들어갔을 때
 *    남아 있는 안쪽 면이 시야를 막지 않게 하려는 것이다. 모든 벽은 바깥을 보는 한 면짜리라서,
 *    안에서 보면 뒷면 컬링으로 통째로 사라지고 거리와 캐릭터만 보인다.
 *  - 놀이 영역에서 절대 보이지 않는 바깥쪽 면(먼 뒷면)도 건너뛴다.
 */
import { BUILDINGS, HQ, type BuildingDef, type ShopFrontDef, type Side, type SignDef, type WallSignDef } from '../../../../shared/world/data'
import { type BuildCtx, PAL } from './ctx'
import { FX_Y, HQ_FLOOR_Y } from './ground'
import { type AtlasRect, type Builder, type RGB, type V3, WHITE, box, cyl, facing, floorQuad, floorRect, mix, mul, rgb } from './geo'

/** 1층(가게 + 간판 띠) 높이 */
const GF = 4.4
/** 이 범위 밖을 향한 벽은 어디서도 보이지 않으므로 만들지 않는다 */
const VIS = { x0: -85, x1: 85, z0: -50, z1: 40 }

interface FaceRect {
  a0: number
  a1: number
  y0: number
  y1: number
}

const SIDE: Record<Side, { nx: number; nz: number; dir: 1 | -1 }> = {
  // dir: 읽는 사람(벽을 마주 본 사람)의 오른쪽이 벽 좌표 a 가 커지는 쪽이면 +1
  n: { nx: 0, nz: -1, dir: -1 },
  s: { nx: 0, nz: 1, dir: 1 },
  w: { nx: -1, nz: 0, dir: 1 },
  e: { nx: 1, nz: 0, dir: -1 },
}
const SIDES: Side[] = ['n', 's', 'e', 'w']

type Bx = Pick<BuildingDef, 'x0' | 'z0' | 'x1' | 'z1'>

function faceRange(b: Bx, side: Side): [number, number] {
  return side === 'n' || side === 's' ? [b.x0, b.x1] : [b.z0, b.z1]
}

/** 벽 좌표 (a, y)에서 바깥으로 out 만큼 나온 월드 점 */
function facePoint(b: Bx, side: Side, a: number, y: number, out: number): V3 {
  switch (side) {
    case 'n':
      return [a, y, b.z0 - out]
    case 's':
      return [a, y, b.z1 + out]
    case 'w':
      return [b.x0 - out, y, a]
    default:
      return [b.x1 + out, y, a]
  }
}

/** 벽면 위의 사각형(바깥을 본다). 글자 UV 는 읽는 방향에 맞춰진다 */
function wallQuad(
  bld: Builder,
  b: Bx,
  side: Side,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  out: number,
  lo: RGB,
  hi: RGB = lo,
  uv: AtlasRect | null = null,
  outTop: number = out,
): void {
  const d = SIDE[side].dir
  const l = d > 0 ? a0 : a1
  const r = d > 0 ? a1 : a0
  bld.quad(facePoint(b, side, l, y0, out), facePoint(b, side, r, y0, out), facePoint(b, side, r, y1, outTop), facePoint(b, side, l, y1, outTop), lo, hi, null, uv)
}

/** 벽에서 depth 만큼 튀어나온 판(벽에 닿는 면은 생략) */
function wallSlab(bld: Builder, b: Bx, side: Side, a0: number, a1: number, y0: number, y1: number, depth: number, col: RGB, top: RGB = col): void {
  if (side === 'n') box(bld, a0, y0, b.z0 - depth, a1, y1, b.z0, col, { skip: 's', top })
  else if (side === 's') box(bld, a0, y0, b.z1, a1, y1, b.z1 + depth, col, { skip: 'n', top })
  else if (side === 'w') box(bld, b.x0 - depth, y0, a0, b.x0, y1, a1, col, { skip: 'e', top })
  else box(bld, b.x1, y0, a0, b.x1 + depth, y1, a1, col, { skip: 'w', top })
}

function subRect(r: FaceRect, c: FaceRect): FaceRect[] {
  if (c.a1 <= r.a0 || c.a0 >= r.a1 || c.y1 <= r.y0 || c.y0 >= r.y1) return [r]
  const out: FaceRect[] = []
  if (c.a0 > r.a0) out.push({ a0: r.a0, a1: c.a0, y0: r.y0, y1: r.y1 })
  if (c.a1 < r.a1) out.push({ a0: c.a1, a1: r.a1, y0: r.y0, y1: r.y1 })
  const m0 = Math.max(r.a0, c.a0)
  const m1 = Math.min(r.a1, c.a1)
  if (c.y0 > r.y0) out.push({ a0: m0, a1: m1, y0: r.y0, y1: c.y0 })
  if (c.y1 < r.y1) out.push({ a0: m0, a1: m1, y0: c.y1, y1: r.y1 })
  return out
}

/** 이웃 건물에 가려지지 않은 벽 조각들 */
function exposed(b: BuildingDef, side: Side): FaceRect[] {
  const plane = side === 'n' ? b.z0 : side === 's' ? b.z1 : side === 'w' ? b.x0 : b.x1
  if (side === 'n' || side === 's') {
    if (plane < VIS.z0 || plane > VIS.z1) return []
  } else if (plane < VIS.x0 || plane > VIS.x1) return []
  const [a0, a1] = faceRange(b, side)
  let rects: FaceRect[] = [{ a0, a1, y0: 0, y1: b.h }]
  const e = 0.02
  for (const o of BUILDINGS) {
    if (o === b) continue
    let hit: boolean
    let c0: number
    let c1: number
    if (side === 'n') {
      hit = o.z0 <= b.z0 - e && o.z1 >= b.z0 - e
      c0 = o.x0
      c1 = o.x1
    } else if (side === 's') {
      hit = o.z0 <= b.z1 + e && o.z1 >= b.z1 + e
      c0 = o.x0
      c1 = o.x1
    } else if (side === 'w') {
      hit = o.x0 <= b.x0 - e && o.x1 >= b.x0 - e
      c0 = o.z0
      c1 = o.z1
    } else {
      hit = o.x0 <= b.x1 + e && o.x1 >= b.x1 + e
      c0 = o.z0
      c1 = o.z1
    }
    if (!hit) continue
    const cut: FaceRect = { a0: c0, a1: c1, y0: 0, y1: o.h }
    rects = rects.flatMap((r) => subRect(r, cut))
  }
  return rects.filter((r) => r.a1 - r.a0 > 0.05 && r.y1 - r.y0 > 0.05)
}

const inside = (rs: FaceRect[], a0: number, a1: number, y0: number, y1: number): boolean =>
  rs.some((r) => a0 >= r.a0 - 1e-6 && a1 <= r.a1 + 1e-6 && y0 >= r.y0 - 1e-6 && y1 <= r.y1 + 1e-6)

const overlaps = (zs: FaceRect[], a0: number, a1: number, y0: number, y1: number): boolean =>
  zs.some((z) => a0 < z.a1 && a1 > z.a0 && y0 < z.y1 && y1 > z.y0)

/** 벽 밝기: 바닥 가까이는 어둡게(가짜 접지 음영) */
const wallShade = (y: number): number => (y >= GF ? 1 : 0.8 + 0.2 * (y / GF))

const LIT_COLORS = [0xffe2a0, 0xffd27e, 0xfff0c8, 0xffc98a, 0xe7d2ff]

export function buildBuildings(c: BuildCtx): void {
  for (const b of BUILDINGS) {
    if (b.kind === 'hq') buildHq(c, b)
    else buildOne(c, b)
  }
}

function buildOne(c: BuildCtx, b: BuildingDef): void {
  const { solid, decal, fx } = c.main
  const wall = rgb(b.wall)
  const trim = rgb(b.trim)
  const far = !b.collide
  const faces = new Map<Side, FaceRect[]>()
  for (const s of SIDES) faces.set(s, exposed(b, s))

  // ── 벽 ──
  for (const s of SIDES) {
    for (const r of faces.get(s)!) {
      emitWall(solid, b, s, r, wall)
      if (far) continue
      // 지붕 처마 띠 / 1층 위 띠
      if (r.y1 >= b.h - 1e-6 && r.y1 - r.y0 > 0.6) wallQuad(decal, b, s, r.a0, r.a1, b.h - 0.45, b.h, 0.02, trim)
      if (b.kind !== 'backdrop' && r.y0 < GF - 0.2 && r.y1 > GF + 0.2) wallQuad(decal, b, s, r.a0, r.a1, GF - 0.1, GF + 0.12, 0.02, mul(trim, 1.1))
      // 벽 밑동이 바닥에 드리우는 음영
      if (fx && r.y0 < 1e-6) {
        const p0 = facePoint(b, s, r.a0, 0, 0)
        const p1 = facePoint(b, s, r.a1, 0, 0)
        const q1 = facePoint(b, s, r.a1, 0, 1.5)
        const q0 = facePoint(b, s, r.a0, 0, 1.5)
        floorQuad(fx, [p0[0], p0[2]], [p1[0], p1[2]], [q1[0], q1[2]], [q0[0], q0[2]], FX_Y, PAL.shade, [0.34, 0.34, 0, 0])
      }
    }
  }

  // ── 지붕 ──
  const roof = rgb(b.roof)
  floorRect(solid, b.x0, b.z0, b.x1, b.z1, b.h, roof)
  if (!far && !c.low) buildRooftop(c, b, wall)

  // ── 간판이 차지하는 자리(창문을 내지 않는다) ──
  const zones = new Map<Side, FaceRect[]>()
  for (const s of SIDES) zones.set(s, [])
  for (const sg of b.signs ?? []) {
    const m = sg.mount === 'stick' ? 0.5 : 0.3
    zones.get(sg.side)!.push({ a0: sg.at - sg.w / 2 - m, a1: sg.at + sg.w / 2 + m, y0: sg.y - sg.h / 2 - 0.3, y1: sg.y + sg.h / 2 + 0.3 })
  }

  // ── 창문 ──
  const skipWindows = c.low && far
  if (!skipWindows) {
    for (const s of SIDES) {
      const rs = faces.get(s)!
      if (!rs.length) continue
      if (b.kind === 'office') bandWindows(c, b, s, rs, zones.get(s)!, false)
      else if (b.kind === 'apartment') {
        if (s === 's') bandWindows(c, b, s, rs, zones.get(s)!, true)
      } else gridWindows(c, b, s, rs, zones.get(s)!)
    }
  }

  // ── 1층 가게와 간판 ──
  for (const f of b.fronts ?? []) shopFront(c, b, f, trim)
  for (const sg of b.signs ?? []) wallSign(c, b, sg)
}

function emitWall(bld: Builder, b: BuildingDef, side: Side, r: FaceRect, wall: RGB): void {
  // 1층 높이에서 한 번 끊어 아래쪽에만 음영 그라데이션을 준다
  if (r.y0 < GF && r.y1 > GF) {
    wallQuad(bld, b, side, r.a0, r.a1, r.y0, GF, 0, mul(wall, wallShade(r.y0)), wall)
    wallQuad(bld, b, side, r.a0, r.a1, GF, r.y1, 0, wall, mul(wall, 1.04))
  } else {
    wallQuad(bld, b, side, r.a0, r.a1, r.y0, r.y1, 0, mul(wall, wallShade(r.y0)), mul(wall, wallShade(r.y1) * (r.y1 > GF ? 1.04 : 1)))
  }
}

/** 위층 층 배치: [층 중심 높이들, 층 높이] */
function floorsOf(b: BuildingDef): { ys: number[]; fh: number } {
  const n = Math.max(1, b.floors - 1)
  const fh = (b.h - 0.9 - GF) / n
  const ys: number[] = []
  for (let k = 0; k < n; k++) ys.push(GF + (k + 0.5) * fh)
  return { ys, fh }
}

/** 낱개 창문 격자(상가·배경 건물) */
function gridWindows(c: BuildCtx, b: BuildingDef, side: Side, rs: FaceRect[], zones: FaceRect[]): void {
  const { decal, unlit } = c.main
  const { ys, fh } = floorsOf(b)
  const [A0, A1] = faceRange(b, side)
  const backdrop = b.kind === 'backdrop'
  const pitch = backdrop ? 3.1 : 2.45
  const w = backdrop ? 1.7 : 1.35
  const h = Math.min(1.55, fh * 0.52)
  const n = Math.floor((A1 - A0 - 1.4) / pitch)
  if (n < 1) return
  const start = (A0 + A1) / 2 - ((n - 1) * pitch) / 2
  const litRatio = backdrop ? 0.22 : 0.36
  const rnd = c.rnd
  for (const yc of ys) {
    for (let i = 0; i < n; i++) {
      const x = start + i * pitch
      const lit = rnd() < litRatio
      const tone = rnd()
      const a0 = x - w / 2
      const a1 = x + w / 2
      const y0 = yc - h / 2
      const y1 = yc + h / 2
      if (!inside(rs, a0, a1, y0, y1) || overlaps(zones, a0, a1, y0, y1)) continue
      if (lit) {
        const col = rgb(LIT_COLORS[Math.floor(tone * LIT_COLORS.length) % LIT_COLORS.length]!)
        c.atlas.later(() => wallQuad(unlit, b, side, a0, a1, y0, y1, 0.03, mul(col, 0.82), col, c.atlas.white))
      } else {
        const g = mul(PAL.glassDark, 0.85 + tone * 0.3)
        wallQuad(decal, b, side, a0, a1, y0, y1, 0.03, g, mix(g, PAL.glassSky, 0.45))
      }
      // 창턱
      if (!backdrop && c.high) wallQuad(decal, b, side, a0 - 0.08, a1 + 0.08, y0 - 0.14, y0, 0.03, mul(rgb(b.trim), 1.15))
    }
  }
}

/** 층마다 길게 이어진 띠창(사무용 건물) / 발코니 띠(아파트) */
function bandWindows(c: BuildCtx, b: BuildingDef, side: Side, rs: FaceRect[], zones: FaceRect[], apartment: boolean): void {
  const { decal, unlit } = c.main
  const { ys, fh } = floorsOf(b)
  const [A0, A1] = faceRange(b, side)
  const h = fh * (apartment ? 0.5 : 0.56)
  const rnd = c.rnd
  const margin = apartment ? 1.4 : 0.8
  for (const yc of ys) {
    const y0 = yc - h / 2
    const y1 = yc + h / 2
    for (const r of rs) {
      if (y0 < r.y0 || y1 > r.y1) continue
      // 간판 자리를 빼고 남은 구간들
      let spans: [number, number][] = [[Math.max(r.a0, A0 + margin), Math.min(r.a1, A1 - margin)]]
      for (const z of zones) {
        if (y0 >= z.y1 || y1 <= z.y0) continue
        spans = spans.flatMap(([p, q]): [number, number][] => {
          if (z.a1 <= p || z.a0 >= q) return [[p, q]]
          const out: [number, number][] = []
          if (z.a0 > p) out.push([p, z.a0])
          if (z.a1 < q) out.push([z.a1, q])
          return out
        })
      }
      for (const [p, q] of spans) {
        if (q - p < 1.2) continue
        const g = mul(PAL.glassDark, apartment ? 1.05 : 0.95)
        wallQuad(decal, b, side, p, q, y0, y1, 0.03, g, mix(g, PAL.glassSky, apartment ? 0.35 : 0.6))
        if (apartment) wallQuad(decal, b, side, p, q, y0 - fh * 0.2, y0, 0.03, mul(rgb(b.wall), 0.9))
        if (c.low && !b.collide) continue
        // 불 켜진 칸
        const cell = apartment ? 2.4 : 2.1
        for (let x = p + 0.15; x + cell - 0.3 <= q; x += cell) {
          const lit = rnd() < (apartment ? 0.26 : 0.2)
          const tone = rnd()
          if (!lit) continue
          const col = rgb(LIT_COLORS[Math.floor(tone * LIT_COLORS.length) % LIT_COLORS.length]!)
          const xa = x
          const xb = x + cell - 0.3
          c.atlas.later(() => wallQuad(unlit, b, side, xa, xb, y0 + 0.08, y1 - 0.08, 0.035, mul(col, 0.8), col, c.atlas.white))
        }
      }
    }
  }
  if (apartment) {
    // 동 번호 쪽 세로 색 띠(한국 아파트의 얼굴)
    const t = rgb(b.trim)
    for (const r of rs) wallQuad(decal, b, side, Math.max(r.a0, A1 - 1.2), Math.min(r.a1, A1), r.y0, r.y1, 0.02, mul(t, 0.9), t)
  }
}

/** 옥상: 난간, 물탱크, 실외기(높은 카메라·타이틀 화면에서 보인다) */
function buildRooftop(c: BuildCtx, b: BuildingDef, wall: RGB): void {
  const { solid } = c.main
  const p = mul(wall, 0.9)
  const t = 0.3
  const y0 = b.h
  const y1 = b.h + 0.55
  const x0 = Math.max(b.x0, -60)
  const x1 = Math.min(b.x1, 60)
  const z0 = Math.max(b.z0, -40)
  const z1 = Math.min(b.z1, 40)
  box(solid, x0, y0, z0, x1, y1, z0 + t, p)
  box(solid, x0, y0, z1 - t, x1, y1, z1, p)
  box(solid, x0, y0, z0 + t, x0 + t, y1, z1 - t, p, { skip: 'bns' })
  box(solid, x1 - t, y0, z0 + t, x1, y1, z1 - t, p, { skip: 'bns' })
  if (!c.high || b.kind === 'backdrop' || b.kind === 'apartment') return
  const rnd = c.rnd
  const cx = x0 + 2 + rnd() * Math.max(0.1, x1 - x0 - 4)
  const cz = z0 + 2 + rnd() * Math.max(0.1, Math.min(z1 - z0 - 4, 6))
  // 노란 물탱크
  const tank = rgb(rnd() < 0.5 ? 0xe9c651 : 0x6fa3c9)
  cyl(solid, cx, y0 + 0.5, cz, 0.95, 0.95, 1.5, 8, tank, { cap: mul(tank, 1.1) })
  box(solid, cx - 0.8, y0, cz - 0.8, cx + 0.8, y0 + 0.5, cz + 0.8, PAL.metal)
  // 실외기 한 줄
  for (let i = 0; i < 3; i++) {
    const ax = Math.min(x1 - 1.4, cx + 2.2 + i * 1.3)
    box(solid, ax, y0, cz - 0.3, ax + 0.9, y0 + 0.7, cz + 0.3, PAL.metalLight)
  }
}

/** 1층 가게 전면 */
function shopFront(c: BuildCtx, b: BuildingDef, f: ShopFrontDef, trim: RGB): void {
  const { solid, decal, unlit } = c.main
  const side = f.side
  const rnd = c.rnd
  const len = f.b - f.a
  const signY0 = 2.98
  const signY1 = 4.12
  const depth = 0.3

  if (f.type === 'glass') {
    const glow = rgb(f.glow ?? 0xffe7b0)
    wallQuad(decal, b, side, f.a, f.b, 0, 0.42, 0.03, mul(trim, 0.7), mul(trim, 0.85))
    // 문 한 칸은 조금 어둡게
    const doorAt = f.a + len * (0.25 + rnd() * 0.5)
    const items: (() => void)[] = []
    items.push(() => wallQuad(unlit, b, side, f.a, f.b, 0.42, 2.84, 0.03, mul(glow, 0.66), glow, c.atlas.white))
    items.push(() => wallQuad(unlit, b, side, doorAt - 0.55, doorAt + 0.55, 0.06, 2.3, 0.045, mul(glow, 0.5), mul(glow, 0.78), c.atlas.white))
    if (!c.low) {
      // 진열된 물건(색색 네모)
      const n = Math.max(2, Math.round(len / 1.5))
      for (let i = 0; i < n; i++) {
        const x = f.a + 0.5 + ((len - 1) * (i + rnd() * 0.6)) / n
        if (Math.abs(x - doorAt) < 0.95) continue
        const col = rgb([0xe2483a, 0x3a8fd8, 0xf2c230, 0x5cb86a, 0xf08a3c, 0x8a6bd8, 0xffffff][Math.floor(rnd() * 7)]!)
        const w = 0.35 + rnd() * 0.3
        const y = 0.75 + rnd() * 0.5
        const h = 0.3 + rnd() * 0.5
        items.push(() => wallQuad(unlit, b, side, x - w / 2, x + w / 2, y, y + h, 0.05, mul(col, 0.75), mul(col, 0.9), c.atlas.white))
      }
    }
    for (const it of items) c.atlas.later(it)
    // 창살 기둥
    const n = Math.max(2, Math.round(len / 1.9))
    for (let i = 0; i <= n; i++) {
      const x = f.a + (len * i) / n
      wallSlab(solid, b, side, x - 0.055, x + 0.055, 0, 2.9, 0.12, trim)
    }
    wallSlab(solid, b, side, f.a, f.b, 2.84, 2.98, 0.14, trim)
  } else {
    // 내려진 셔터 + 붙여 놓은 종이
    const slats = 9
    for (let i = 0; i < slats; i++) {
      const g = mul(PAL.metalLight, i % 2 === 0 ? 0.9 : 0.78)
      wallQuad(decal, b, side, f.a, f.b, (2.9 * i) / slats, (2.9 * (i + 1)) / slats, 0.03, mul(g, 0.9), g)
    }
    // 종이는 가게 한쪽 끝에 붙인다(가운데는 앞에 선 포장마차가 가린다)
    const pw = Math.min(3.0, len * 0.4)
    const mid = f.a + 0.8 + pw / 2
    const rect = c.atlas.sign(f.sign, pw, 0.95, 60)
    c.atlas.later(() => wallQuad(unlit, b, side, mid - pw / 2, mid + pw / 2, 1.2, 2.15, 0.045, WHITE, WHITE, rect))
  }

  // 간판 띠: 앞면 전체를 조명 없는 판으로(가운데만 글자 텍스처)
  const bg = rgb(f.type === 'shutter' ? 0xcfc6b8 : f.sign.bg)
  wallSlab(solid, b, side, f.a, f.b, signY0, signY1, depth, mul(bg, 0.62), mul(bg, 0.8))
  if (f.type === 'glass') {
    const sw = Math.min(len - 0.2, 7.2)
    const mid = (f.a + f.b) / 2
    const rect = c.atlas.sign(f.sign, sw, signY1 - signY0 - 0.1, 58)
    c.atlas.later(() => {
      const o = depth + 0.012
      wallQuad(unlit, b, side, f.a + 0.04, f.b - 0.04, signY0 + 0.04, signY1 - 0.04, o, bg, bg, c.atlas.white)
      wallQuad(unlit, b, side, mid - sw / 2, mid + sw / 2, signY0 + 0.05, signY1 - 0.05, o + 0.008, WHITE, WHITE, rect)
    })
  }

  // 줄무늬 차양
  if (f.awning !== undefined) {
    const n = Math.max(3, Math.round(len / 0.8))
    const ca = rgb(f.awning)
    for (let i = 0; i < n; i++) {
      const a0 = f.a + (len * i) / n
      const a1 = f.a + (len * (i + 1)) / n
      const col = i % 2 === 0 ? ca : PAL.white
      wallQuad(solid, b, side, a0, a1, 2.42, 2.9, 1.2, mul(col, 0.92), col, null, depth)
      wallQuad(solid, b, side, a0, a1, 2.2, 2.42, 1.2, mul(col, 0.8), mul(col, 0.9))
    }
  }
}

/** 위층 간판 / 돌출 간판 / 벽화 */
function wallSign(c: BuildCtx, b: BuildingDef, sg: WallSignDef): void {
  const { solid, unlit } = c.main
  const side = sg.side
  const y0 = sg.y - sg.h / 2
  const y1 = sg.y + sg.h / 2
  const bg = rgb(sg.sign.bg)
  if (sg.mount === 'stick') {
    // 벽에서 직각으로 튀어나온 세로 간판: 양쪽 면에 글자
    const t = 0.11
    const gap = 0.16
    const p0 = facePoint(b, side, sg.at - t, y0, gap)
    const p1 = facePoint(b, side, sg.at + t, y1, gap + sg.w)
    box(solid, Math.min(p0[0], p1[0]), y0, Math.min(p0[2], p1[2]), Math.max(p0[0], p1[0]), y1, Math.max(p0[2], p1[2]), mul(bg, 0.6), { skip: '' })
    // 받침 팔
    const q0 = facePoint(b, side, sg.at - 0.04, sg.y + sg.h * 0.3, 0)
    const q1 = facePoint(b, side, sg.at + 0.04, sg.y + sg.h * 0.3 + 0.08, gap)
    box(solid, Math.min(q0[0], q1[0]), q0[1], Math.min(q0[2], q1[2]), Math.max(q0[0], q1[0]), q1[1], Math.max(q0[2], q1[2]), PAL.metal, { skip: '' })
    const rect = c.atlas.sign(sg.sign, sg.w - 0.1, sg.h - 0.1, 52)
    const s = SIDE[side]
    const mid = facePoint(b, side, sg.at, sg.y, gap + sg.w / 2)
    c.atlas.later(() => {
      // 판의 두 넓은 면은 벽과 나란한 방향(±)을 본다
      const fx = Math.abs(s.nz)
      const fz = Math.abs(s.nx)
      const o = t + 0.012
      facing(unlit, mid[0] + fx * o, mid[1], mid[2] + fz * o, fx, fz, sg.w - 0.1, sg.h - 0.1, WHITE, WHITE, rect)
      facing(unlit, mid[0] - fx * o, mid[1], mid[2] - fz * o, -fx, -fz, sg.w - 0.1, sg.h - 0.1, WHITE, WHITE, rect)
    })
    return
  }
  const a0 = sg.at - sg.w / 2
  const a1 = sg.at + sg.w / 2
  let out = 0.03
  let m = 0
  if (sg.mount === 'board') {
    const depth = 0.22
    wallSlab(solid, b, side, a0, a1, y0, y1, depth, mul(bg, 0.6), mul(bg, 0.8))
    out = depth + 0.012
    m = 0.05
  }
  // 아틀라스 넓이는 한정돼 있다: 기본 카메라(38° 내려다봄)에 거의 안 잡히는 높은 간판·먼 벽화는 성기게,
  // 눈높이 간판은 촘촘하게 배분한다
  const density = b.kind === 'apartment' ? 15 : sg.mount === 'paint' ? 27 : sg.y > 6.5 ? 38 : 58
  const rect = c.atlas.sign(sg.sign, sg.w - m * 2, sg.h - m * 2, density)
  c.atlas.later(() => wallQuad(unlit, b, side, a0 + m, a1 - m, y0 + m, y1 - m, out, WHITE, WHITE, rect))
}

// ───────────────────────── 비밀 교단 건물 ─────────────────────────

const HQ_NEON: SignDef = { text: '비밀 교단 본부', sub: '쉿! 비밀입니다', bg: 0x1b1030, fg: 0xc79bff, icon: 'eye', neon: true }
const HQ_DOOR_LABEL: SignDef = { text: '신흥 교단장 이상 출입', bg: 0x1b1030, fg: 0xffd86a }
const HQ_EMBLEM: SignDef = { text: '', bg: 0x2a1a4a, fg: 0xffd86a, icon: 'eye' }
const HQ_BANNER: SignDef = { text: '믿습니다', bg: 0x8e2338, fg: 0xffd86a, vertical: true }

/** 셔터 원점(문 위쪽 가운데). 위쪽을 축으로 말려 올라간다 */
export const HQ_SHUTTER_PIVOT = { x: (HQ.gate.x0 + HQ.gate.x1) / 2, y: HQ.doorH, z: HQ.gate.z0 + 0.14 }

function buildHq(c: BuildCtx, b: BuildingDef): void {
  const shell = c.shell
  const neon = c.neon
  const wall = rgb(b.wall)
  const gold = rgb(b.trim)
  const gate = HQ.gate
  const doorH = HQ.doorH
  const inn = HQ.inside
  const zF = b.z0 // 앞벽(골목 쪽) 평면

  // ── 겉: 골목에 드러난 앞벽(문 구멍 제외) + 이웃보다 높은 부분 + 지붕 ──
  const door: FaceRect = { a0: gate.x0, a1: gate.x1, y0: 0, y1: doorH }
  const front = exposed(b, 'n')
  for (const r of front) {
    for (const p of subRect(r, door)) {
      const lo = mul(wall, 0.72 + 0.28 * Math.min(1, p.y0 / 5))
      const hi = mul(wall, 0.72 + 0.28 * Math.min(1, p.y1 / 5))
      wallQuad(shell, b, 'n', p.a0, p.a1, p.y0, p.y1, 0, lo, hi)
    }
  }
  for (const s of ['s', 'e', 'w'] as Side[]) for (const r of exposed(b, s)) wallQuad(shell, b, s, r.a0, r.a1, r.y0, r.y1, 0, wall)
  floorRect(shell, b.x0, b.z0, b.x1, b.z1, b.h, rgb(b.roof))

  // 금색 문틀과 기둥 장식
  box(shell, gate.x0 - 0.3, 0, zF - 0.14, gate.x0, doorH + 0.3, zF, gold, { skip: 'bs', ao: 0.8 })
  box(shell, gate.x1, 0, zF - 0.14, gate.x1 + 0.3, doorH + 0.3, zF, gold, { skip: 'bs', ao: 0.8 })
  box(shell, gate.x0 - 0.3, doorH, zF - 0.16, gate.x1 + 0.3, doorH + 0.5, zF, mul(gold, 1.08), { skip: 's' })
  const vis = front.find((r) => r.y0 < 0.01 && r.a0 < gate.x0 && r.a1 > gate.x1)
  if (vis) {
    for (const x of [vis.a0 + 0.02, vis.a1 - 0.3]) box(shell, x, 0, zF - 0.1, x + 0.28, 6.4, zF, mul(gold, 0.85), { skip: 'bs', ao: 0.75 })
    box(shell, vis.a0, 6.4, zF - 0.16, vis.a1, 6.75, zF, gold, { skip: 's' })
  }
  // 네온 간판 받침판
  box(shell, -2.75, 3.55, zF - 0.26, 2.75, 5.85, zF, rgb(0x1b1030), { skip: 's' })
  const neonRect = c.atlas.sign(HQ_NEON, 5.3, 2.1, 66)
  const labelRect = c.atlas.sign(HQ_DOOR_LABEL, 2.3, 0.4, 70)
  c.atlas.later(() => {
    facing(neon, 0, 4.7, zF - 0.275, 0, -1, 5.3, 2.1, WHITE, WHITE, neonRect)
    facing(neon, 0, doorH + 0.25, zF - 0.175, 0, -1, 2.3, 0.4, WHITE, WHITE, labelRect)
    // 보랏빛으로 새어 나오는 위층 창
    const win = rgb(0xb48cff)
    for (const y of [8.4, 11.2, 14.0]) {
      for (const x of [-1.9, 0, 1.9]) facing(neon, x, y, zF - 0.02, 0, -1, 0.95, 1.3, mul(win, 0.45), mul(win, 0.8), c.atlas.white)
    }
    // 문 양옆 벽등
    for (const x of [-2.1, 2.1]) {
      const pts: V3[] = [
        [x - 0.16, 2.5, zF - 0.3],
        [x + 0.16, 2.5, zF - 0.3],
        [x + 0.16, 2.95, zF - 0.3],
        [x - 0.16, 2.95, zF - 0.3],
      ]
      neon.quad(pts[1]!, pts[0]!, pts[3]!, pts[2]!, rgb(0xd9b3ff), rgb(0xf3e6ff), null, c.atlas.white)
    }
  })
  for (const x of [-2.1, 2.1]) box(shell, x - 0.2, 2.42, zF - 0.29, x + 0.2, 3.03, zF, PAL.metal, { skip: 's' })

  // ── 셔터(로컬 좌표: 위쪽 가운데가 원점, 북쪽을 본다) ──
  const sh = c.shutter
  const w = gate.x1 - gate.x0
  const slats = 10
  const base = rgb(0x6a5a8c)
  for (let i = 0; i < slats; i++) {
    const y0 = -doorH + (doorH * i) / slats
    const y1 = -doorH + (doorH * (i + 1)) / slats
    const col = mul(base, i % 2 === 0 ? 1 : 0.8)
    facing(sh, 0, (y0 + y1) / 2, 0, 0, -1, w, y1 - y0, mul(col, 0.86), col)
  }
  box(sh, -w / 2, -doorH, -0.05, w / 2, -doorH + 0.14, 0.05, gold, { skip: '' })
  // 셔터에 그린 눈(마름모)
  const eye = (rx: number, ry: number, col: RGB, z: number): void => {
    const cy = -doorH * 0.52
    // 북쪽을 보는 면: 읽는 사람 오른쪽이 −X
    sh.tri([-rx, cy, z], [0, cy + ry, z], [rx, cy, z], col)
    sh.tri([rx, cy, z], [0, cy - ry, z], [-rx, cy, z], col)
  }
  eye(0.75, 0.36, gold, -0.02)
  eye(0.26, 0.26, rgb(0x2a1a4a), -0.035)

  // ── 안: 바닥, 안쪽을 보는 벽, 문턱 ──
  const hs = c.hq.solid
  const carpet = rgb(0x5d3f86)
  const fy = HQ_FLOOR_Y
  floorRect(hs, inn.x0, inn.z0, inn.x1, inn.z1, fy, carpet)
  floorRect(hs, gate.x0, gate.z0, gate.x1, gate.z1, fy, mul(carpet, 0.7))
  // 금테와 가운데 붉은 융단
  const g2 = mul(gold, 0.9)
  floorRect(hs, inn.x0 + 0.5, inn.z0 + 0.5, inn.x1 - 0.5, inn.z0 + 0.62, fy + 0.008, g2)
  floorRect(hs, inn.x0 + 0.5, inn.z1 - 0.62, inn.x1 - 0.5, inn.z1 - 0.5, fy + 0.008, g2)
  floorRect(hs, inn.x0 + 0.5, inn.z0 + 0.62, inn.x0 + 0.62, inn.z1 - 0.62, fy + 0.008, g2)
  floorRect(hs, inn.x1 - 0.62, inn.z0 + 0.62, inn.x1 - 0.5, inn.z1 - 0.62, fy + 0.008, g2)
  floorRect(hs, -0.95, inn.z0, 0.95, 31.3, fy + 0.016, PAL.red)

  const H = b.h
  const dark = rgb(0x3d2a4f)
  const mid = rgb(0x7460a0)
  // 허리 아래는 어두운 나무판, 위는 보라 벽, 꼭대기로 갈수록 어둡게
  const bands: [number, number, RGB, RGB][] = [
    [0, 1.1, mul(dark, 0.8), dark],
    [1.1, 5, mid, mid],
    [5, H, mid, mul(mid, 0.5)],
  ]
  const innerWall = (cx: number, cz: number, nx: number, nz: number, wd: number, y0: number, y1: number): void => {
    for (const [a, t, lo, hi] of bands) {
      const ya = Math.max(a, y0)
      const yt = Math.min(t, y1)
      if (yt - ya < 0.01) continue
      facing(hs, cx, (ya + yt) / 2, cz, nx, nz, wd, yt - ya, lo, hi)
    }
  }
  const zN = inn.z0
  innerWall((inn.x0 + gate.x0) / 2, zN, 0, 1, gate.x0 - inn.x0, 0, H)
  innerWall((gate.x1 + inn.x1) / 2, zN, 0, 1, inn.x1 - gate.x1, 0, H)
  innerWall(0, zN, 0, 1, w, doorH, H)
  innerWall(0, inn.z1, 0, -1, inn.x1 - inn.x0, 0, H)
  innerWall(inn.x0, (inn.z0 + inn.z1) / 2, 1, 0, inn.z1 - inn.z0, 0, H)
  innerWall(inn.x1, (inn.z0 + inn.z1) / 2, -1, 0, inn.z1 - inn.z0, 0, H)
  // 문틈 안쪽 면(벽 두께)
  const zm = (gate.z0 + gate.z1) / 2
  const zd = gate.z1 - gate.z0
  facing(hs, gate.x0, doorH / 2, zm, 1, 0, zd, doorH, mul(gold, 0.6), mul(gold, 0.8))
  facing(hs, gate.x1, doorH / 2, zm, -1, 0, zd, doorH, mul(gold, 0.6), mul(gold, 0.8))
  hs.quad([gate.x0, doorH, gate.z0], [gate.x1, doorH, gate.z0], [gate.x1, doorH, gate.z1], [gate.x0, doorH, gate.z1], mul(gold, 0.5))

  // 벽 장식: 왕좌 위 눈 문양, 양옆 세로 현수막
  const hu = c.hq.unlit
  const emblem = c.atlas.sign(HQ_EMBLEM, 2.6, 1.7, 60)
  const banner = c.atlas.sign(HQ_BANNER, 0.9, 3.0, 60)
  c.atlas.later(() => {
    facing(hu, 0, 3.9, inn.z1 - 0.03, 0, -1, 2.6, 1.7, WHITE, WHITE, emblem)
    for (const x of [-3.6, 3.6]) facing(hu, x, 2.9, inn.z1 - 0.03, 0, -1, 0.9, 3.0, WHITE, WHITE, banner)
    for (const z of [28.3, 31.0]) {
      facing(hu, inn.x0 + 0.03, 2.9, z, 1, 0, 0.9, 3.0, WHITE, WHITE, banner)
      facing(hu, inn.x1 - 0.03, 2.9, z, -1, 0, 0.9, 3.0, WHITE, WHITE, banner)
    }
  })
}
