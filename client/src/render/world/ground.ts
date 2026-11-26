/**
 * 지면: 큰길·인도·광장·공터·골목의 바닥과 무늬, 단상, 북쪽 경계 담.
 *
 * 왜 띠와 무늬를 나누나: 바닥 띠(큰 사각형)는 서로 겹치지 않게 깔고, 그 위의 차선·횡단보도·광장 무늬는
 * polygonOffset 이 걸린 '무늬' 버퍼에 조금씩 띄워 올린다. 같은 높이에 겹쳐 그리면 멀리서 깜빡거린다(z-fighting).
 */
import type { Box } from '../../../../shared/world/def'
import { BUILDINGS, HQ, LAYOUT } from '../../../../shared/world/data'
import { WORLD } from '../../../../shared/world'
import { type BuildCtx, PAL, jitter } from './ctx'
import { type RGB, box, cyl, disc, floorRect, floorTri, ico, mix, mul, rgb, ring } from './geo'

/** 바닥이 뻗는 범위(안개 끝보다 멀어야 땅 끝이 보이지 않는다) */
const XF = 260
/**
 * 무늬 층 높이: 층끼리 겹칠 때 순서를 정한다. 간격을 1cm 넘게 둔 것은 엔진이 카메라 near 를
 * 작게(0.1) 잡아 깊이 정밀도가 떨어져도 100m 밖에서 층이 서로 깜빡이지 않게 하려는 것이다.
 */
export const L1 = 0.02
export const L2 = 0.032
export const L3 = 0.044
/** 반투명 그림자·빛 웅덩이 높이 */
export const FX_Y = 0.06
/** 넓은 포장 무늬(가장 아래 층) */
const L0 = 0.01
/** 교단 건물 안 바닥 높이: 건물 발자국 무늬(L1)보다 위에 있어야 한다 */
export const HQ_FLOOR_Y = 0.034

export function buildGround(c: BuildCtx, stairHole: Box): void {
  const { solid, decal, fx } = c.main
  const road = LAYOUT.road
  const nw = LAYOUT.northWalk
  const sw = LAYOUT.southWalk
  const wallZ = LAYOUT.northWall

  // ── 바닥 띠(겹치지 않음) ──
  floorRect(solid, -XF, -XF, XF, wallZ, 0, PAL.farGrass)
  // 북쪽 광장·공원 바닥: 지하철 계단 구멍만 비운다. 구멍 모서리에서 꼭짓점이 어긋나면
  // 틈으로 하늘색 점이 새므로(T자 이음) 구멍 선에 맞춰 여덟 조각으로 나눈다
  const xs = [-XF, stairHole.x0, stairHole.x1, XF]
  const zs = [wallZ, stairHole.z0, stairHole.z1, nw.z0]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue
      floorRect(solid, xs[i]!, zs[j]!, xs[i + 1]!, zs[j + 1]!, 0, PAL.paving)
    }
  }
  floorRect(solid, -XF, nw.z0, XF, nw.z1, 0, PAL.sidewalk)
  floorRect(solid, -XF, road.z0, XF, road.z1, 0, PAL.asphalt)
  floorRect(solid, -XF, sw.z0, XF, sw.z1, 0, PAL.sidewalk)
  floorRect(solid, -XF, sw.z1, XF, XF, 0, PAL.blockBase)

  if (!c.low) {
    buildPaving(c, stairHole)
    buildLitter(c)
  }

  // ── 인도: 연석, 점자 블록 ──
  floorRect(decal, -XF, road.z0 - 0.28, XF, road.z0, L1, PAL.curb)
  floorRect(decal, -XF, road.z1, XF, road.z1 + 0.28, L1, PAL.curb)
  floorRect(decal, -XF, road.z0, XF, road.z0 + 0.22, L1, PAL.asphaltDark)
  floorRect(decal, -XF, road.z1 - 0.22, XF, road.z1, L1, PAL.asphaltDark)
  const cx0 = LAYOUT.cross.x0
  const cx1 = LAYOUT.cross.x1
  for (const s of [-1, 1]) {
    const zc = s * 7.0
    floorRect(decal, -XF, zc - 0.15, cx0 - 0.4, zc + 0.15, L1, PAL.tactile)
    floorRect(decal, cx1 + 0.4, zc - 0.15, XF, zc + 0.15, L1, PAL.tactile)
    // 횡단보도 앞 경고 블록과 거기로 이어지는 짧은 줄
    const zEdge = s * 5.36
    floorRect(decal, cx0, Math.min(zEdge, zEdge + s * 0.6), cx1, Math.max(zEdge, zEdge + s * 0.6), L1, PAL.tactile)
    floorRect(decal, cx0 - 0.4, zc - 0.15, cx1 + 0.4, zc + 0.15, L1, PAL.tactile)
    floorRect(decal, -0.15, Math.min(zc, zEdge + s * 0.6), 0.15, Math.max(zc, zEdge + s * 0.6), L2, PAL.tactile)
  }
  // 북쪽 건물 앞마당과 인도 사이 경계선(포장 색이 바뀌는 곳)
  floorRect(decal, -XF, nw.z0 - 0.12, XF, nw.z0, L1, PAL.sidewalkAlt)

  // ── 큰길: 중앙선, 차선, 정지선, 횡단보도, 맨홀 ──
  for (const [x0, x1] of [
    [-XF, cx0 - 2.2],
    [cx1 + 2.2, XF],
  ] as const) {
    floorRect(decal, x0, -0.24, x1, -0.09, L1, PAL.roadYellow)
    floorRect(decal, x0, 0.09, x1, 0.24, L1, PAL.roadYellow)
  }
  for (const z of [-2.5, 2.5]) {
    for (let x = 9; x < 84; x += 6) {
      floorRect(decal, x, z - 0.07, x + 3, z + 0.07, L1, PAL.roadWhite)
      floorRect(decal, -x - 3, z - 0.07, -x, z + 0.07, L1, PAL.roadWhite)
    }
  }
  floorRect(decal, cx0 - 2.1, 0.3, cx0 - 1.6, road.z1 - 0.3, L1, PAL.roadWhite)
  floorRect(decal, cx1 + 1.6, road.z0 + 0.3, cx1 + 2.1, -0.3, L1, PAL.roadWhite)
  for (let z = road.z0 + 0.5; z < road.z1 - 0.2; z += 1.0) {
    floorRect(decal, cx0, z - 0.29, cx1, z + 0.29, L1, PAL.roadWhite)
  }
  for (const [x, z] of [
    [-14, 2.2],
    [17, -1.7],
    [33, 1.9],
    [-38, -1.5],
  ] as const) {
    disc(decal, x, L1, z, 0.44, 0.44, 10, PAL.asphaltDark)
    ring(decal, x, L2, z, 0.3, 0.36, 10, mul(PAL.asphalt, 1.15))
  }

  buildPlaza(c)

  // ── 쌈지 공원 잔디 + 돌 테두리 ──
  const g = LAYOUT.garden
  floorRect(decal, g.x0, g.z0, g.x1, g.z1, L1, PAL.grass)
  floorRect(decal, g.x0 + 2, g.z0 + 3, g.x0 + 9, g.z0 + 9, L2, PAL.grassDark)
  floorRect(decal, g.x0 + 7, g.z0 + 10, g.x1 - 1.5, g.z1 - 1, L2, mix(PAL.grass, PAL.grassDark, 0.5))
  const edge = 0.2
  floorRect(decal, g.x0 - edge, g.z0 - edge, g.x1 + edge, g.z0, L2, PAL.stone)
  floorRect(decal, g.x0 - edge, g.z1, g.x1 + edge, g.z1 + edge, L2, PAL.stone)
  floorRect(decal, g.x0 - edge, g.z0, g.x0, g.z1, L2, PAL.stone)
  floorRect(decal, g.x1, g.z0, g.x1 + edge, g.z1, L2, PAL.stone)

  // ── 남쪽: 건물 발자국(카메라가 건물 안에 들어갔을 때 보이는 어두운 바닥), 공터, 골목 ──
  for (const b of BUILDINGS) {
    if (!b.collide || b.kind === 'hq') continue
    floorRect(decal, Math.max(b.x0, -70), Math.max(b.z0, -70), Math.min(b.x1, 70), Math.min(b.z1, 70), L1, PAL.footprint)
  }
  const lot = LAYOUT.lot
  const al = LAYOUT.alley
  floorRect(decal, al.x1, lot.z0, lot.x1, lot.z1, L1, PAL.lot)
  floorRect(decal, al.x0, al.z0, al.x1, al.z1, L1, PAL.alley)
  floorRect(decal, -0.14, al.z0 + 0.6, 0.14, al.z1 - 0.5, L2, mul(PAL.alley, 0.72))
  disc(decal, 0.95, L2, 14.4, 0.42, 0.42, 10, mul(PAL.alley, 0.68))
  // 공터 흙바닥의 얼룩
  const rnd = c.rnd
  for (let i = 0; i < 7; i++) {
    const x = lot.x0 + 1 + rnd() * (lot.x1 - lot.x0 - 2)
    const z = lot.z0 + 0.8 + rnd() * 4.2
    disc(decal, x, L2, z, 0.5 + rnd() * 0.7, 0.35 + rnd() * 0.5, 7, mul(PAL.lot, 0.9 + rnd() * 0.06))
  }

  // 교단 건물 발자국: 안이 숨겨져 있을 때 보이는 바닥(안쪽 바닥은 이보다 높게 깔린다)
  floorRect(decal, HQ.outer.x0, HQ.outer.z0, HQ.outer.x1, HQ.outer.z1, L1, PAL.footprint)

  if (fx) {
    // 남쪽 상가가 드리우는 넓은 그늘(해가 남서쪽): 인도는 그늘, 차도 쪽으로 가며 옅어진다
    const sh = PAL.shade
    fx.quad([-XF, FX_Y, sw.z1], [XF, FX_Y, sw.z1], [XF, FX_Y, 2.6], [-XF, FX_Y, 2.6], sh, sh, [0.3, 0.3, 0, 0])
    // 공터와 골목은 건물에 둘러싸여 통째로 그늘이다(보라 네온이 돋보인다)
    floorRect(fx, al.x0, sw.z1, lot.x1, lot.z1, FX_Y, sh, 0.3)
    floorRect(fx, al.x0, lot.z1, al.x1, al.z1, FX_Y, sh, 0.34)
    if (!c.low) {
      // 수상한 보라 기운(천막, 골목, 교단 문 앞)
      const p = PAL.purpleGlow
      disc(fx, WORLD.tent.x, FX_Y + 0.01, WORLD.tent.z, 6.4, 6.0, 20, p, 0.34, 0)
      disc(fx, 0, FX_Y + 0.01, 18.5, 4.2, 6.5, 16, p, 0.22, 0)
      disc(fx, 0, FX_Y + 0.02, WORLD.hq.door.z, 3.6, 3.2, 16, p, 0.4, 0)
      disc(fx, WORLD.offeringBox.x, FX_Y + 0.02, WORLD.offeringBox.z, 2.0, 2.0, 14, PAL.warmGlow, 0.26, 0)
    }
  }

  buildNorthWall(c)
}

/** 광장 바닥 무늬와 단상 */
function buildPlaza(c: BuildCtx): void {
  const { solid, decal } = c.main
  const pz = WORLD.plaza
  const pd = WORLD.podium
  const seg = c.low ? 32 : 48
  disc(decal, pz.x, L1, pz.z, pz.r, pz.r, seg, PAL.plaza)
  ring(decal, pz.x, L2, pz.z, pz.r - 0.7, pz.r, seg, PAL.plazaTrim)
  ring(decal, pz.x, L2, pz.z, 7.0, 7.35, seg, PAL.plazaRing)
  ring(decal, pz.x, L2, pz.z, 8.6, 8.72, seg, PAL.plazaRing)
  // 단상에서 퍼져 나가는 햇살 무늬
  const rays = 16
  const r0 = pd.r + pd.ramp + 0.75
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2
    const d = (Math.PI * 2) / rays / 3.2
    const tip = i % 2 === 0 ? 6.6 : 5.8
    floorTri(
      decal,
      pz.x + Math.cos(a - d) * r0,
      pz.z + Math.sin(a - d) * r0,
      pz.x + Math.cos(a + d) * r0,
      pz.z + Math.sin(a + d) * r0,
      pz.x + Math.cos(a) * tip,
      pz.z + Math.sin(a) * tip,
      L2,
      i % 2 === 0 ? PAL.plazaRay : PAL.plazaRay2,
    )
  }
  ring(decal, pd.x, L2, pd.z, pd.r + pd.ramp + 0.08, pd.r + pd.ramp + 0.5, seg, mix(PAL.purple, PAL.plaza, 0.25))

  // 교주 행차길: 남쪽 들머리에서 단상까지 깔린 포도주색 융단
  const wine = rgb(0x8e3b56)
  const zA = pd.z + pd.r + pd.ramp + 0.06
  const zB = pz.z + pz.r - 0.75
  floorRect(decal, -1.05, zA, 1.05, zB, L3, wine)
  floorRect(decal, -1.05, zA, -0.9, zB, L3 + 0.008, PAL.gold)
  floorRect(decal, 0.9, zA, 1.05, zB, L3 + 0.008, PAL.gold)

  // 단상: 경사 둘레 + 평평한 윗면(groundHeight 와 같은 치수)
  // 경사 둘레는 바닥과 뚜렷이 다른 색이어야 '올라서는 곳'으로 읽힌다
  const stage = rgb(0xcf9f7e)
  const pseg = c.low ? 20 : 28
  cyl(solid, pd.x, 0, pd.z, pd.r + pd.ramp, pd.r, pd.h, pseg, stage, { cap: rgb(0x6f58a8), ao: 0.8 })
  const top = pd.h
  ring(decal, pd.x, top + L1, pd.z, pd.r - 0.16, pd.r, pseg, PAL.gold)
  ring(decal, pd.x, top + L1, pd.z, 1.55, 1.7, pseg, mix(PAL.gold, PAL.cream, 0.4))
  // 가운데 눈 문양
  disc(decal, pd.x, top + L1, pd.z, 1.05, 0.62, 16, PAL.cream)
  disc(decal, pd.x, top + L2, pd.z, 0.42, 0.42, 12, PAL.gold)
  disc(decal, pd.x, top + L3, pd.z, 0.18, 0.18, 8, PAL.purpleDeep)
  // 경사로 발 디딤 띠(높이를 읽기 쉽게)
  const midR = pd.r + pd.ramp * 0.5
  ring(decal, pd.x, pd.h * 0.5 + L2, pd.z, midR - 0.05, midR + 0.05, pseg, PAL.gold)
}

/** 북쪽 경계: 낮은 돌담 + 생울타리 + 담 너머 아파트 단지의 나무 */
function buildNorthWall(c: BuildCtx): void {
  const { solid, fx } = c.main
  const z = LAYOUT.northWall
  // 건물이 차지하지 않는 구간에만 담을 세운다(건물 벽과 겹쳐 그리지 않게)
  const spans: [number, number][] = []
  let x = -30
  for (const b of [...BUILDINGS].filter((b) => b.collide && b.z0 <= z && b.z1 > z).sort((p, q) => p.x0 - q.x0)) {
    if (b.x0 > x) spans.push([x, Math.min(b.x0, 48)])
    x = Math.max(x, b.x1)
  }
  if (x < 48) spans.push([x, 48])
  const rnd = c.rnd
  for (const [a, b] of spans) {
    box(solid, a, 0, z - 0.45, b, 1.35, z, PAL.stone, { top: PAL.stoneDark, ao: 0.8, skip: 'b' })
    box(solid, a, 1.35, z - 0.5, b, 1.5, z + 0.05, PAL.stoneDark)
    const n = Math.max(1, Math.round((b - a) / 3.2))
    for (let i = 0; i < n; i++) {
      const h = 2.2 + rnd() * 0.5
      const col = jitter(PAL.hedge, rnd, 0.08)
      box(solid, a + ((b - a) * i) / n, 1.5, z - 2.0, a + ((b - a) * (i + 1)) / n, h, z - 0.45, col, { top: mul(col, 1.12) })
    }
    if (fx) fx.quad([a, FX_Y, z + 1.3], [b, FX_Y, z + 1.3], [b, FX_Y, z], [a, FX_Y, z], PAL.shade, PAL.shade, [0, 0, 0.3, 0.3])
  }
  if (c.low) return
  // 담 너머 나무 줄: 광장 배경을 채우고 아파트 아랫부분을 가린다
  for (let i = 0; i < 9; i++) {
    const tx = -27 + i * 5.1 + (rnd() - 0.5) * 1.6
    const tz = z - 4.2 - rnd() * 1.5
    const h = 4.6 + rnd() * 1.8
    cyl(solid, tx, 0, tz, 0.22, 0.16, h * 0.55, 5, PAL.woodDark, { cap: null })
    const leaf: RGB = jitter(i % 3 === 0 ? rgb(0xd9b548) : rgb(0x6f9e5c), rnd, 0.1)
    ico(solid, tx, h * 0.8, tz, 2.0, h * 0.42, 2.0, leaf, rnd, 0.1)
  }
}

/** 넓은 포장 바닥의 잔무늬: 인도의 줄눈과 광장 둘레의 바둑판 판석. 밋밋한 넓은 면을 줄인다 */
function buildPaving(c: BuildCtx, stairHole: Box): void {
  const { decal } = c.main
  const nw = LAYOUT.northWalk
  const sw = LAYOUT.southWalk
  const joint = mul(PAL.sidewalk, 0.9)
  for (let x = -58; x <= 58; x += 2) {
    floorRect(decal, x - 0.03, nw.z0, x + 0.03, nw.z1 - 0.28, L0, joint)
    floorRect(decal, x - 0.03, sw.z0 + 0.28, x + 0.03, sw.z1, L0, joint)
  }
  // 바둑판 판석: 건물 발자국·잔디·광장 원판(전부 L1)보다 아래 층이라 그 밑으로 깔린다.
  // 지하철 계단 구멍 위에는 깔면 안 된다(계단을 덮어 버린다)
  const cell = 3
  const alt = mul(PAL.paving, 0.94)
  const z1 = nw.z0 - 0.12
  for (let x = -48; x < 48; x += cell) {
    for (let z = LAYOUT.northWall; z < z1; z += cell) {
      const i = Math.round((x + 48) / cell)
      const j = Math.round((z - LAYOUT.northWall) / cell)
      if ((i + j) % 2 !== 0) continue
      const xb = x + cell
      const zb = Math.min(z + cell, z1)
      if (x < stairHole.x1 + 0.4 && xb > stairHole.x0 - 0.4 && z < stairHole.z1 + 0.4 && zb > stairHole.z0 - 0.4) continue
      floorRect(decal, x, z, xb, zb, L0, alt)
    }
  }
}

/** 바닥에 흩어진 전단지: 끈질긴 길거리 포교의 흔적(꾸밈 전용) */
function buildLitter(c: BuildCtx): void {
  const { decal } = c.main
  const spots: [number, number][] = [
    [16.2, -11.8],
    [19.3, -12.9],
    [23.1, -11.4],
    [27.4, -12.6],
    [14.6, -13.1],
    [7.6, -12.2],
    [-3.4, -11.2],
    [-16.6, -11.6],
    [-13.1, -9.6],
    [-1.4, 13.6],
    [1.2, 20.3],
    [0.6, 23.2],
    [6.2, 12.2],
    [12.9, 11.3],
  ]
  const cols = [PAL.white, rgb(0xf3ecff), rgb(0xfff3c4)]
  const rnd = c.rnd
  spots.forEach(([x, z], i) => {
    decal.at(x, 0, z, rnd() * Math.PI)
    floorRect(decal, -0.15, -0.21, 0.15, 0.21, L3, cols[i % cols.length]!)
    floorRect(decal, -0.1, -0.15, 0.1, -0.08, L3 + 0.006, mul(PAL.purple, 1.1))
  })
  decal.origin()
}
