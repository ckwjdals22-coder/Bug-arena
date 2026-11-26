/**
 * 월드 질의 함수: 지면 높이, 충돌 해소, NPC 이동망 탐색.
 * 시그니처는 서버 NPC 시뮬과 클라이언트 이동 코드가 의존하므로 유지한다.
 */
import type { Box, NavKind, WorldDef } from './def'
import { WORLD } from './data'

export * from './def'
export { WORLD }

export interface Vec2 {
  x: number
  z: number
}

/** (x,z) 지점의 지면 높이. 단상 위는 h, 경사 구간은 선형 보간, 그 외는 0 */
export function groundHeight(x: number, z: number, world: WorldDef = WORLD): number {
  const p = world.podium
  const d = Math.hypot(x - p.x, z - p.z)
  if (d <= p.r) return p.h
  if (d >= p.r + p.ramp) return 0
  return p.h * (1 - (d - p.r) / p.ramp)
}

export function inBox(x: number, z: number, b: Box, pad = 0): boolean {
  return x >= b.x0 - pad && x <= b.x1 + pad && z >= b.z0 - pad && z <= b.z1 + pad
}

/**
 * pos 를 충돌체 밖으로 밀어내고 경계 안으로 가둔다(제자리 수정). 반지름 r 의 원으로 취급.
 * hqOpen 이 false 면 비밀 교단 건물의 gate 도 벽으로 취급한다.
 */
export function resolveCollision(pos: Vec2, r: number, hqOpen = true, world: WorldDef = WORLD): Vec2 {
  // 두 번 반복하면 모서리에서의 떨림이 줄어든다
  for (let iter = 0; iter < 2; iter++) {
    for (const b of world.boxes) pushOutOfBox(pos, r, b)
    if (!hqOpen) pushOutOfBox(pos, r, world.hq.gate)
    for (const c of world.circles) {
      const dx = pos.x - c.x
      const dz = pos.z - c.z
      const min = c.r + r
      const d2 = dx * dx + dz * dz
      if (d2 < min * min) {
        const d = Math.sqrt(d2)
        if (d < 1e-6) {
          pos.x = c.x + min
        } else {
          pos.x = c.x + (dx / d) * min
          pos.z = c.z + (dz / d) * min
        }
      }
    }
  }
  const bd = world.bounds
  if (pos.x < bd.x0 + r) pos.x = bd.x0 + r
  if (pos.x > bd.x1 - r) pos.x = bd.x1 - r
  if (pos.z < bd.z0 + r) pos.z = bd.z0 + r
  if (pos.z > bd.z1 - r) pos.z = bd.z1 - r
  return pos
}

function pushOutOfBox(pos: Vec2, r: number, b: Box): void {
  const cx = pos.x < b.x0 ? b.x0 : pos.x > b.x1 ? b.x1 : pos.x
  const cz = pos.z < b.z0 ? b.z0 : pos.z > b.z1 ? b.z1 : pos.z
  const dx = pos.x - cx
  const dz = pos.z - cz
  const d2 = dx * dx + dz * dz
  if (d2 >= r * r) return
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2)
    pos.x = cx + (dx / d) * r
    pos.z = cz + (dz / d) * r
    return
  }
  // 중심이 박스 안에 있다: 가장 가까운 면으로 밀어낸다
  const left = pos.x - b.x0
  const right = b.x1 - pos.x
  const top = pos.z - b.z0
  const bottom = b.z1 - pos.z
  const m = Math.min(left, right, top, bottom)
  if (m === left) pos.x = b.x0 - r
  else if (m === right) pos.x = b.x1 + r
  else if (m === top) pos.z = b.z0 - r
  else pos.z = b.z1 + r
}

/** 그 지점에 반지름 r 의 원이 설 수 있는가 */
export function isFree(x: number, z: number, r: number, world: WorldDef = WORLD): boolean {
  const p = { x, z }
  resolveCollision(p, r, true, world)
  return Math.abs(p.x - x) < 1e-4 && Math.abs(p.z - z) < 1e-4
}

// ───────── NPC 이동망 ─────────

let adjCache: { world: WorldDef; adj: number[][] } | null = null

export function navAdjacency(world: WorldDef = WORLD): number[][] {
  if (adjCache && adjCache.world === world) return adjCache.adj
  const adj: number[][] = world.nav.nodes.map(() => [])
  for (const [a, b] of world.nav.edges) {
    adj[a]!.push(b)
    adj[b]!.push(a)
  }
  adjCache = { world, adj }
  return adj
}

export function nearestNavNode(x: number, z: number, world: WorldDef = WORLD): number {
  let best = 0
  let bestD = Infinity
  const nodes = world.nav.nodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** from → to 최단 경로(노드 인덱스 배열, from 포함). 연결되지 않으면 [from] */
export function findNavPath(from: number, to: number, world: WorldDef = WORLD): number[] {
  if (from === to) return [from]
  const adj = navAdjacency(world)
  const nodes = world.nav.nodes
  const n = nodes.length
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  dist[from] = 0
  for (let step = 0; step < n; step++) {
    let u = -1
    let best = Infinity
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i]! < best) {
        best = dist[i]!
        u = i
      }
    }
    if (u < 0 || u === to) break
    done[u] = 1
    for (const v of adj[u]!) {
      const a = nodes[u]!
      const b = nodes[v]!
      const d = dist[u]! + Math.hypot(a.x - b.x, a.z - b.z)
      if (d < dist[v]!) {
        dist[v] = d
        prev[v] = u
      }
    }
  }
  if (prev[to] === -1) return [from]
  const path: number[] = []
  for (let c = to; c !== -1; c = prev[c]!) path.push(c)
  return path.reverse()
}

export function navNodesOfKind(kinds: readonly NavKind[], world: WorldDef = WORLD): number[] {
  const out: number[] = []
  world.nav.nodes.forEach((n, i) => {
    if (kinds.includes(n.kind)) out.push(i)
  })
  return out
}
