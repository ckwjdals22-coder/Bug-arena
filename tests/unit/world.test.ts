/**
 * 월드 레이아웃 검증. 화면을 보지 않고도 "걸을 수 있는 곳 / 막힌 곳 / NPC 길"이 서로 맞는지 잡아낸다.
 * 레이아웃(shared/world/data.ts)을 고치면 이 테스트가 먼저 깨지도록 해 두었다.
 */
import { describe, expect, it } from 'vitest'
import {
  WORLD,
  findNavPath,
  groundHeight,
  inBox,
  insideHq,
  isFree,
  navAdjacency,
  navNodesOfKind,
  nearestNavNode,
  onPodiumTop,
  resolveCollision,
  segmentFree,
} from '../../shared/world'
import { BUILDINGS, HQ, HQ_WALLS, LAYOUT, PROPS, PROP_SHAPE, propColliders } from '../../shared/world/data'

const R = 0.45 // 플레이어·NPC 를 대표하는 반지름
const CLEAR = 0.3 // 이동망이 지켜야 하는 여유
const STEP = 0.25

// ───────── 격자 채우기(걸어서 닿는 범위) ─────────

interface Grid {
  nx: number
  nz: number
  x0: number
  z0: number
  free: Uint8Array
}

function standable(x: number, z: number, r: number, hqOpen: boolean): boolean {
  const p = resolveCollision({ x, z }, r, hqOpen)
  return Math.abs(p.x - x) < 1e-4 && Math.abs(p.z - z) < 1e-4
}

function makeGrid(r: number, hqOpen: boolean): Grid {
  const b = WORLD.bounds
  const nx = Math.round((b.x1 - b.x0) / STEP) + 1
  const nz = Math.round((b.z1 - b.z0) / STEP) + 1
  const free = new Uint8Array(nx * nz)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (standable(b.x0 + i * STEP, b.z0 + j * STEP, r, hqOpen)) free[j * nx + i] = 1
    }
  }
  return { nx, nz, x0: b.x0, z0: b.z0, free }
}

const cellOf = (g: Grid, x: number, z: number): number => Math.round((z - g.z0) / STEP) * g.nx + Math.round((x - g.x0) / STEP)

/** 시작 칸들에서 4방향으로 번져 닿는 칸 표시 */
function flood(g: Grid, starts: number[]): Uint8Array {
  const seen = new Uint8Array(g.free.length)
  const stack: number[] = []
  for (const s of starts) {
    if (g.free[s] && !seen[s]) {
      seen[s] = 1
      stack.push(s)
    }
  }
  while (stack.length) {
    const c = stack.pop()!
    const i = c % g.nx
    const j = (c - i) / g.nx
    const next = [i > 0 ? c - 1 : -1, i < g.nx - 1 ? c + 1 : -1, j > 0 ? c - g.nx : -1, j < g.nz - 1 ? c + g.nx : -1]
    for (const n of next) {
      if (n >= 0 && g.free[n] && !seen[n]) {
        seen[n] = 1
        stack.push(n)
      }
    }
  }
  return seen
}

function anyReached(g: Grid, seen: Uint8Array, test: (x: number, z: number) => boolean): boolean {
  for (let c = 0; c < seen.length; c++) {
    if (!seen[c]) continue
    const i = c % g.nx
    const j = (c - i) / g.nx
    if (test(g.x0 + i * STEP, g.z0 + j * STEP)) return true
  }
  return false
}

const spawnCells = (g: Grid): number[] => WORLD.spawns.map((s) => cellOf(g, s.x, s.z))

const gridOpen = makeGrid(R, true)
const gridClosed = makeGrid(R, false)
const reachOpen = flood(gridOpen, spawnCells(gridOpen))
const reachClosed = flood(gridClosed, spawnCells(gridClosed))

// ───────── 테스트 ─────────

describe('월드 경계와 기본 치수', () => {
  it('경계가 말이 된다', () => {
    const b = WORLD.bounds
    expect(b.x1 - b.x0).toBeGreaterThan(60)
    expect(b.z1 - b.z0).toBeGreaterThan(40)
    expect(b.x0).toBeLessThan(0)
    expect(b.x1).toBeGreaterThan(0)
    expect(b.z0).toBeLessThan(0)
    expect(b.z1).toBeGreaterThan(0)
    for (const box of WORLD.boxes) {
      expect(box.x1).toBeGreaterThan(box.x0)
      expect(box.z1).toBeGreaterThan(box.z0)
    }
    for (const c of WORLD.circles) expect(c.r).toBeGreaterThan(0)
  })

  it('단상은 광장 안에 있고 설계 치수를 지킨다', () => {
    const { podium, plaza } = WORLD
    const d = Math.hypot(podium.x - plaza.x, podium.z - plaza.z)
    expect(d + podium.r + podium.ramp).toBeLessThan(plaza.r)
    expect(podium.r).toBeCloseTo(2.6, 5)
    expect(podium.h).toBeCloseTo(0.5, 5)
    expect(podium.ramp).toBeCloseTo(1.2, 5)
  })

  it('groundHeight: 단상 위는 h, 경사로는 단조 감소, 멀리서는 0', () => {
    const p = WORLD.podium
    expect(groundHeight(p.x, p.z)).toBe(p.h)
    expect(groundHeight(p.x + p.r - 0.01, p.z)).toBe(p.h)
    expect(groundHeight(p.x, p.z - p.r + 0.01)).toBe(p.h)
    let prev = p.h
    for (let d = p.r; d <= p.r + p.ramp + 0.001; d += 0.1) {
      const h = groundHeight(p.x + d, p.z)
      expect(h).toBeLessThanOrEqual(prev + 1e-9)
      prev = h
    }
    expect(groundHeight(p.x + p.r + p.ramp + 0.01, p.z)).toBe(0)
    expect(groundHeight(40, 7)).toBe(0)
    expect(groundHeight(-17, -13)).toBe(0)
    expect(onPodiumTop(p.x + 1, p.z + 1)).toBe(true)
    expect(onPodiumTop(p.x + p.r + 0.2, p.z)).toBe(false)
  })

  it('단상 위와 경사로에는 충돌체가 없다(올라서서 설교할 수 있다)', () => {
    const p = WORLD.podium
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      for (const d of [0, 1.2, 2.4, p.r + p.ramp]) {
        expect(isFree(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, R)).toBe(true)
      }
    }
  })

  it('설교 구경꾼이 모이는 고리(r+2 ~ r+6)가 비어 있다', () => {
    const p = WORLD.podium
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      for (let d = p.r + 2; d <= p.r + 6; d += 0.5) {
        expect(isFree(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, R)).toBe(true)
      }
    }
  })
})

describe('충돌체는 건물·소품에서 파생된다', () => {
  it('충돌하는 건물 한가운데는 설 수 없다', () => {
    for (const b of BUILDINGS) {
      if (!b.collide || b.kind === 'hq') continue
      const cx = Math.min(Math.max((b.x0 + b.x1) / 2, WORLD.bounds.x0 + 1), WORLD.bounds.x1 - 1)
      const cz = Math.min(Math.max((b.z0 + b.z1) / 2, WORLD.bounds.z0 + 1), WORLD.bounds.z1 - 1)
      if (!inBox(cx, cz, b)) continue
      expect(isFree(cx, cz, R), b.id).toBe(false)
    }
  })

  it('박스 소품은 90° 단위로만 놓인다(축 정렬 충돌체와 모양이 같아야 한다)', () => {
    for (const p of PROPS) {
      if (PROP_SHAPE[p.kind].t !== 'box') continue
      const q = (p.yaw ?? 0) / (Math.PI / 2)
      expect(Math.abs(q - Math.round(q)), `${p.kind} @ ${p.x},${p.z}`).toBeLessThan(1e-9)
    }
  })

  it('꾸밈 전용(deco) 소품에는 충돌체가 없다 — 낮은 품질에서 빼도 길이 달라지지 않는다', () => {
    for (const p of PROPS) {
      if (!p.deco) continue
      const c = propColliders(p)
      expect(c.boxes.length + c.circles.length, p.kind).toBe(0)
    }
  })

  it('충돌체가 있는 소품 자리는 실제로 막혀 있다', () => {
    for (const p of PROPS) {
      const c = propColliders(p)
      for (const b of c.boxes) expect(isFree((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, R), p.kind).toBe(false)
      for (const k of c.circles) expect(isFree(k.x, k.z, R), p.kind).toBe(false)
    }
  })

  it('월드 충돌체 개수 = 경계 담 + 건물 + 교단 벽 + 소품', () => {
    let boxes = 1
    let circles = 0
    for (const b of BUILDINGS) if (b.collide) boxes += b.kind === 'hq' ? HQ_WALLS.length : 1
    for (const p of PROPS) {
      const c = propColliders(p)
      boxes += c.boxes.length
      circles += c.circles.length
    }
    expect(WORLD.boxes.length).toBe(boxes)
    expect(WORLD.circles.length).toBe(circles)
  })
})

describe('POI / 시작 위치 / 부스', () => {
  const b = WORLD.bounds
  const inside = (x: number, z: number): boolean => x > b.x0 + R && x < b.x1 - R && z > b.z0 + R && z < b.z1 - R

  it('시작 위치: 8곳 이상, 서로 1.2m 이상, 전부 비어 있고 광장을 본다', () => {
    const s = WORLD.spawns
    expect(s.length).toBeGreaterThanOrEqual(8)
    for (let i = 0; i < s.length; i++) {
      const a = s[i]!
      expect(inside(a.x, a.z)).toBe(true)
      expect(isFree(a.x, a.z, R)).toBe(true)
      // 접속할 때 서버가 조금 흩뿌려도 벽에 박히지 않게 여유를 본다
      expect(isFree(a.x, a.z, R + 0.6)).toBe(true)
      for (let j = i + 1; j < s.length; j++) {
        expect(Math.hypot(a.x - s[j]!.x, a.z - s[j]!.z)).toBeGreaterThanOrEqual(1.2)
      }
      // 바라보는 방향(sin yaw, cos yaw)이 광장 중심 쪽
      const dx = WORLD.plaza.x - a.x
      const dz = WORLD.plaza.z - a.z
      const dot = (Math.sin(a.yaw) * dx + Math.cos(a.yaw) * dz) / Math.hypot(dx, dz)
      expect(dot).toBeGreaterThan(0.95)
      // 지하철 출구 / 광장 가장자리 근처
      expect(Math.hypot(a.x - WORLD.subway.x, a.z - WORLD.subway.z)).toBeLessThan(8)
      expect(Math.hypot(dx, dz)).toBeLessThan(WORLD.plaza.r + 8)
    }
  })

  it('POI 와 부스 자리는 경계 안이고 설 수 있다', () => {
    const spots: [string, number, number][] = [
      ['subway', WORLD.subway.x, WORLD.subway.z],
      ['hq.door', WORLD.hq.door.x, WORLD.hq.door.z],
      ['podium', WORLD.podium.x, WORLD.podium.z],
      ['plaza', WORLD.plaza.x, WORLD.plaza.z],
      ...WORLD.booths.map((s, i): [string, number, number] => [`booth${i}`, s.x, s.z]),
    ]
    for (const [name, x, z] of spots) {
      expect(inside(x, z), name).toBe(true)
      expect(isFree(x, z, R), name).toBe(true)
    }
    // 헌금함과 천막은 '물건'이라 그 자리는 막혀 있어야 한다(경계 안인지는 확인)
    expect(inside(WORLD.offeringBox.x, WORLD.offeringBox.z)).toBe(true)
    expect(inside(WORLD.tent.x, WORLD.tent.z)).toBe(true)
    expect(isFree(WORLD.offeringBox.x, WORLD.offeringBox.z, R)).toBe(false)
    expect(isFree(WORLD.tent.x, WORLD.tent.z, R)).toBe(false)
  })

  it('부스는 3개이고, 자리 바로 앞(바라보는 쪽)에 탁자가 있다', () => {
    expect(WORLD.booths.length).toBe(3)
    for (const s of WORLD.booths) {
      const fx = s.x + Math.sin(s.yaw) * 1.3
      const fz = s.z + Math.cos(s.yaw) * 1.3
      expect(isFree(fx, fz, R)).toBe(false)
    }
  })

  it('헌금함에 다가설 수 있다(r + 1.2 안에 설 자리가 있고 걸어서 닿는다)', () => {
    const o = WORLD.offeringBox
    const ok = anyReached(gridOpen, reachOpen, (x, z) => Math.hypot(x - o.x, z - o.z) <= o.r + 1.2)
    expect(ok).toBe(true)
    // 천막 앞쪽(북쪽)에서 다가서는 자리가 넉넉하다
    expect(isFree(o.x, o.z - (o.r + R + 0.05), R)).toBe(true)
  })

  it('교단 건물 치수가 스키마 값과 일치한다', () => {
    expect(WORLD.hq.gate).toEqual(HQ.gate)
    expect(WORLD.hq.inside).toEqual(HQ.inside)
    expect(WORLD.hq.minRank).toBe(3)
    expect(insideHq((HQ.inside.x0 + HQ.inside.x1) / 2, (HQ.inside.z0 + HQ.inside.z1) / 2)).toBe(true)
    expect(insideHq(WORLD.hq.door.x, WORLD.hq.door.z)).toBe(false)
  })
})

describe('비밀 교단 건물의 문', () => {
  const inHq = (x: number, z: number): boolean => inBox(x, z, WORLD.hq.inside)

  it('문이 닫혀 있으면 시작 위치에서 안으로 들어갈 수 없다', () => {
    expect(anyReached(gridClosed, reachClosed, inHq)).toBe(false)
  })

  it('문이 열리면 들어갈 수 있고, 안쪽 대부분을 걸어 다닐 수 있다', () => {
    expect(anyReached(gridOpen, reachOpen, inHq)).toBe(true)
    let cells = 0
    for (let c = 0; c < reachOpen.length; c++) {
      if (!reachOpen[c]) continue
      const i = c % gridOpen.nx
      const j = (c - i) / gridOpen.nx
      if (inHq(gridOpen.x0 + i * STEP, gridOpen.z0 + j * STEP)) cells++
    }
    // 12 × 6.8m 방에서 벽 여유와 왕좌를 빼고도 40㎡ 이상
    expect(cells * STEP * STEP).toBeGreaterThan(40)
  })

  it('문 앞까지는 누구나 갈 수 있다', () => {
    const d = WORLD.hq.door
    expect(anyReached(gridClosed, reachClosed, (x, z) => Math.hypot(x - d.x, z - d.z) < 0.5)).toBe(true)
  })

  it('문 말고는 들어가는 길이 없다(문이 열려야만 닿는 칸은 문틈이거나 안쪽이다)', () => {
    for (let c = 0; c < reachOpen.length; c++) {
      if (!reachOpen[c] || reachClosed[c]) continue
      const i = c % gridOpen.nx
      const j = (c - i) / gridOpen.nx
      const x = gridOpen.x0 + i * STEP
      const z = gridOpen.z0 + j * STEP
      expect(inBox(x, z, WORLD.hq.inside, R) || inBox(x, z, WORLD.hq.gate, R), `${x},${z}`).toBe(true)
    }
  })
})

describe('NPC 이동망', () => {
  const { nodes, edges } = WORLD.nav

  it('노드 45개 이상, 종류가 골고루 있다', () => {
    expect(nodes.length).toBeGreaterThanOrEqual(45)
    for (const k of ['walk', 'plaza', 'cross', 'shop', 'rest', 'exit'] as const) {
      expect(navNodesOfKind([k]).length, k).toBeGreaterThan(0)
    }
    expect(navNodesOfKind(['shop']).length).toBeGreaterThanOrEqual(6)
    expect(navNodesOfKind(['rest']).length).toBeGreaterThanOrEqual(4)
  })

  it('출구: 지하철 + 길 양 끝', () => {
    const exits = navNodesOfKind(['exit']).map((i) => nodes[i]!)
    expect(exits.some((n) => Math.hypot(n.x - WORLD.subway.x, n.z - WORLD.subway.z) < 0.01)).toBe(true)
    expect(exits.some((n) => n.x < WORLD.bounds.x0 + 4)).toBe(true)
    expect(exits.some((n) => n.x > WORLD.bounds.x1 - 4)).toBe(true)
  })

  it('모든 노드가 비어 있고 여유가 있다', () => {
    nodes.forEach((n, i) => {
      expect(isFree(n.x, n.z, R), `node ${i}`).toBe(true)
      expect(isFree(n.x, n.z, R + CLEAR), `node ${i} 여유`).toBe(true)
    })
  })

  it('모든 간선이 0.25m 간격으로 막힘이 없다(여유 0.3m 포함)', () => {
    for (const [a, b] of edges) {
      const p = nodes[a]!
      const q = nodes[b]!
      expect(segmentFree(p.x, p.z, q.x, q.z, R + CLEAR, STEP), `edge ${a}-${b} (${p.x},${p.z})→(${q.x},${q.z})`).toBe(true)
    }
  })

  it('간선은 중복·자기 자신 연결이 없고 인덱스가 유효하다', () => {
    const seen = new Set<string>()
    for (const [a, b] of edges) {
      expect(a).not.toBe(b)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(nodes.length)
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it('그래프가 하나로 이어져 있다', () => {
    const adj = navAdjacency()
    const seen = new Set<number>([0])
    const stack = [0]
    while (stack.length) {
      for (const v of adj[stack.pop()!]!) {
        if (!seen.has(v)) {
          seen.add(v)
          stack.push(v)
        }
      }
    }
    expect(seen.size).toBe(nodes.length)
  })

  it('findNavPath: 지하철에서 어디든 갈 수 있다', () => {
    const from = nearestNavNode(WORLD.subway.x, WORLD.subway.z)
    for (let to = 0; to < nodes.length; to++) {
      const path = findNavPath(from, to)
      expect(path[0]).toBe(from)
      expect(path[path.length - 1]).toBe(to)
    }
  })

  it('시작 위치에서 걸어서 닿는 범위가 모든 노드를 포함한다', () => {
    nodes.forEach((n, i) => {
      // 노드와 가장 가까운 격자 칸 주변 어디든 닿으면 된다
      const ok = anyReached(gridClosed, reachClosed, (x, z) => Math.abs(x - n.x) <= STEP && Math.abs(z - n.z) <= STEP)
      expect(ok, `node ${i} (${n.x},${n.z})`).toBe(true)
    })
  })

  it('NPC 는 교단 건물에 들어가지 않는다(문에서 5m 안에는 노드가 없다)', () => {
    for (const n of nodes) {
      expect(inBox(n.x, n.z, WORLD.hq.inside, 1)).toBe(false)
      expect(Math.hypot(n.x - WORLD.hq.door.x, n.z - WORLD.hq.door.z)).toBeGreaterThan(5)
    }
  })

  it('양쪽 인도, 횡단보도, 광장을 덮는다', () => {
    const count = (f: (x: number, z: number) => boolean): number => nodes.filter((n) => f(n.x, n.z)).length
    expect(count((_x, z) => z <= LAYOUT.northWalk.z1 && z >= LAYOUT.northWalk.z0 - 0.5)).toBeGreaterThanOrEqual(8)
    expect(count((_x, z) => z >= LAYOUT.southWalk.z0 && z <= LAYOUT.southWalk.z1)).toBeGreaterThanOrEqual(8)
    expect(count((x, z) => Math.abs(z) < 5 && x >= LAYOUT.cross.x0 && x <= LAYOUT.cross.x1)).toBeGreaterThanOrEqual(2)
    expect(count((x, z) => Math.hypot(x - WORLD.plaza.x, z - WORLD.plaza.z) < WORLD.plaza.r)).toBeGreaterThanOrEqual(12)
  })
})

describe('걷는 느낌(끼임 방지)', () => {
  it('닿을 수 있는 어디에서 어느 쪽으로 밀어도 충돌 해소 결과는 안정적이다', () => {
    // 한 걸음(0.3m) 밀고 해소한 자리를 다시 해소했을 때 더 움직이면, 그 자리에서 캐릭터가 떨린다
    let worst = 0
    const dirs = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos((k * Math.PI) / 4) * 0.3, Math.sin((k * Math.PI) / 4) * 0.3] as const)
    for (let c = 0; c < reachOpen.length; c += 3) {
      if (!reachOpen[c]) continue
      const i = c % gridOpen.nx
      const j = (c - i) / gridOpen.nx
      const x = gridOpen.x0 + i * STEP
      const z = gridOpen.z0 + j * STEP
      for (const [dx, dz] of dirs) {
        const p = resolveCollision({ x: x + dx, z: z + dz }, R)
        const q = resolveCollision({ x: p.x, z: p.z }, R)
        worst = Math.max(worst, Math.hypot(q.x - p.x, q.z - p.z))
      }
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('반지름 0.45 로만 겨우 들어가는 좁은 틈(0.9~1.2m)이 없다', () => {
    // 0.6 반지름으로 닿는 범위에서 0.5m 넘게 떨어진 0.45 전용 칸 = 끼기 쉬운 틈새
    const wide = makeGrid(0.6, true)
    const wideReach = flood(wide, spawnCells(wide))
    const reach = Math.ceil(0.5 / STEP)
    const bad: string[] = []
    for (let c = 0; c < reachOpen.length; c++) {
      if (!reachOpen[c] || wideReach[c]) continue
      const i = c % gridOpen.nx
      const j = (c - i) / gridOpen.nx
      let near = false
      for (let dj = -reach; dj <= reach && !near; dj++) {
        for (let di = -reach; di <= reach && !near; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= gridOpen.nx || jj >= gridOpen.nz) continue
          if (wideReach[jj * gridOpen.nx + ii]) near = true
        }
      }
      if (!near) bad.push(`${gridOpen.x0 + i * STEP},${gridOpen.z0 + j * STEP}`)
    }
    expect(bad).toEqual([])
  })

  it('걸을 수 있는 넓이가 충분하다', () => {
    let cells = 0
    for (let c = 0; c < reachClosed.length; c++) if (reachClosed[c]) cells++
    expect(cells * STEP * STEP).toBeGreaterThan(2500)
  })
})
