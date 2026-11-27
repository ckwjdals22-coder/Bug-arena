/**
 * NPC 시뮬레이션 단위 테스트.
 * 전부 결정적이다(mulberry32 시드 + 손으로 돌리는 시계). 실제 WORLD 는 다른 담당이 바꾸는 중이므로
 * 수치에 기대는 검증은 여기서 만든 합성 월드로 하고, WORLD 로는 "어떤 월드에서도 지켜져야 하는 성질"만 본다.
 */
import { describe, expect, it, vi } from 'vitest'
import type { NpcSimApi, NpcState, OwnerChangeReason, PlayerState } from '../../server/core/api'
import { createNpcSim } from '../../server/core/npcSim'
import {
  Anim,
  FOLLOW_DURATION_MS,
  NPC_FLEE_SPEED,
  NPC_FOLLOW_SPEED,
  NPC_RADIUS,
  NPC_WALK_SPEED,
  NPCS_PER_ROOM,
  RUN_SPEED,
  WALK_SPEED,
} from '../../shared/constants'
import { ARCHETYPES } from '../../shared/content/archetypes'
import { SKIN_COLORS } from '../../shared/content/core'
import type { Archetype } from '../../shared/content/types'
import { quantPos, quantYaw } from '../../shared/protocol'
import { mulberry32 } from '../../shared/rng'
import { WORLD, isFree } from '../../shared/world'
import type { WorldDef } from '../../shared/world'

const DT = 0.1
const T0 = 1_700_000_000_000
/**
 * 시드 흔들기: NPC_TEST_SEED_SHIFT=3 npx vitest run … 처럼 주면 모든 시뮬 시드가 그만큼 밀린다.
 * 콘텐츠(유형 목록)가 바뀌면 난수 흐름도 바뀌므로, 특정 시드의 운에 기대는 검증이 없는지 확인할 때 쓴다.
 */
const SEED_SHIFT = Number(process.env.NPC_TEST_SEED_SHIFT ?? 0) || 0

// ───────── 합성 월드 ─────────

/** 건물 3채 + 얇은 담 + 가로수/가로등이 있는 작은 마을. 이동망은 건물 사이 길을 돈다 */
function townWorld(): WorldDef {
  return {
    bounds: { x0: -40, z0: -30, x1: 40, z1: 30 },
    boxes: [
      { x0: -12, z0: -10, x1: -4, z1: -2 },
      { x0: 4, z0: -10, x1: 12, z1: -2 },
      { x0: -12, z0: 4, x1: 12, z1: 9 },
      // 두께 30cm 담: 빠르게 달려도 뚫고 지나가면 안 된다
      { x0: 20, z0: -12, x1: 20.3, z1: -4 },
    ],
    circles: [
      { x: 2.2, z: -6, r: 0.8 },
      { x: -20, z: 0, r: 0.6 },
    ],
    podium: { x: 0, z: -19, r: 2, h: 0.5, ramp: 1 },
    plaza: { x: 0, z: -19, r: 9 },
    offeringBox: { x: 26, z: 20, r: 1 },
    tent: { x: 26, z: 21.5, r: 3 },
    subway: { x: -36, z: 0, r: 1.5, yaw: Math.PI / 2 },
    booths: [],
    hq: {
      door: { x: 0, z: 25, r: 1.5 },
      gate: { x0: -1.5, z0: 24.5, x1: 1.5, z1: 25.5 },
      inside: { x0: -6, z0: 25.5, x1: 6, z1: 29.5 },
      minRank: 3,
    },
    spawns: [{ x: 0, z: -13, yaw: 0 }],
    nav: {
      nodes: [
        { x: -36, z: 0, kind: 'exit' }, // 0 지하철
        { x: -20, z: 1.2, kind: 'walk' }, // 1
        { x: -20, z: -14, kind: 'walk' }, // 2
        { x: 0, z: -14, kind: 'plaza' }, // 3
        { x: 16, z: -14, kind: 'walk' }, // 4
        { x: 16, z: 1, kind: 'shop' }, // 5
        { x: 0, z: 1, kind: 'cross' }, // 6
        { x: -20, z: 14, kind: 'rest' }, // 7
        { x: 16, z: 14, kind: 'walk' }, // 8
        { x: 36, z: 14, kind: 'exit' }, // 9
        { x: 0, z: 14, kind: 'walk' }, // 10
        { x: 36, z: -14, kind: 'exit' }, // 11
      ],
      edges: [
        [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 1], [3, 6],
        [1, 7], [7, 10], [10, 8], [8, 5], [8, 9], [4, 11],
      ],
    },
  }
}

/** 장애물이 없는 넓은 평지 — 줄 서기(신도) 수치를 방해 없이 재기 위한 월드 */
function fieldWorld(): WorldDef {
  return {
    bounds: { x0: -100, z0: -100, x1: 100, z1: 100 },
    boxes: [],
    circles: [],
    podium: { x: 0, z: 0, r: 2, h: 0.5, ramp: 1 },
    plaza: { x: 0, z: 0, r: 9 },
    offeringBox: { x: 50, z: 50, r: 1 },
    tent: { x: 50, z: 52, r: 3 },
    subway: { x: -90, z: 0, r: 1.5, yaw: Math.PI / 2 },
    booths: [],
    hq: {
      door: { x: 0, z: 90, r: 1.5 },
      gate: { x0: -1.5, z0: 89.5, x1: 1.5, z1: 90.5 },
      inside: { x0: -6, z0: 90.5, x1: 6, z1: 99 },
      minRank: 3,
    },
    spawns: [{ x: 0, z: 0, yaw: 0 }],
    nav: {
      nodes: [
        { x: -90, z: 0, kind: 'exit' },
        { x: -60, z: 0, kind: 'walk' },
        { x: 0, z: 0, kind: 'plaza' },
        { x: 60, z: 0, kind: 'walk' },
        { x: 90, z: 0, kind: 'exit' },
        { x: 0, z: 60, kind: 'rest' },
        { x: 0, z: -60, kind: 'shop' },
      ],
      edges: [
        [0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [2, 6],
      ],
    },
  }
}

// ───────── 도우미 ─────────

function makePlayer(id: number, x: number, z: number): PlayerState {
  return {
    id,
    conn: id,
    pid: 'test-player-' + id,
    name: '테스트' + id,
    look: [0, 0, 0, 0, 0, 0, 0],
    prog: {
      v: 1,
      pid: 'test-player-' + id,
      inf: 0,
      fol: 0,
      coins: 0,
      rank: 0,
      stats: {},
      ach: [],
      items: {},
      met: [],
      cult: null,
      cultFol: 0,
      cultInf: 0,
      daily: null,
      ts: 0,
    },
    x,
    z,
    yaw: 0,
    st: Anim.Idle,
    emote: null,
    dirty: false,
    joinedAt: 0,
    lastMsgAt: 0,
    lastMoveAt: 0,
    talk: null,
    cd: new Map(),
    buff: 0,
    buffUntil: 0,
    stunUntil: 0,
    sprintUntil: 0,
    blocked: new Set(),
    mutedUntil: 0,
    nameLockUntil: 0,
    saveDirty: false,
    ext: {},
  }
}

interface Harness {
  sim: NpcSimApi
  world: WorldDef
  players: Map<number, PlayerState>
  now: number
  spawns: number[]
  says: { id: number; text: string; at: number }[]
  owners: { id: number; prev: number; owner: number; reason: OwnerChangeReason }[]
  /** Room 처럼 dirty 를 내린 뒤 n틱 돈다. each 는 매 틱이 끝난 뒤 불린다 */
  step(n?: number, each?: () => void, dt?: number): void
  addPlayer(id: number, x: number, z: number): PlayerState
}

function harness(world: WorldDef, seed: number, count: number = NPCS_PER_ROOM): Harness {
  const h: Harness = {
    sim: undefined as unknown as NpcSimApi,
    world,
    players: new Map(),
    now: T0,
    spawns: [],
    says: [],
    owners: [],
    step(n = 1, each, dt = DT) {
      for (let i = 0; i < n; i++) {
        h.now += dt * 1000
        for (const npc of h.sim.list) npc.dirty = false
        h.sim.tick(h.now, dt, h.players)
        if (each) each()
      }
    },
    addPlayer(id, x, z) {
      const p = makePlayer(id, x, z)
      h.players.set(id, p)
      return p
    },
  }
  h.sim = createNpcSim(
    world,
    mulberry32(seed + SEED_SHIFT),
    {
      onSpawn: (npc) => h.spawns.push(npc.id),
      onOwnerChange: (npc, prev, reason) => h.owners.push({ id: npc.id, prev, owner: npc.owner, reason }),
      onSay: (npc, text) => h.says.push({ id: npc.id, text, at: h.now }),
    },
    count,
  )
  return h
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z)

function angleGap(a: number, b: number): number {
  let d = a - b
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2
  return Math.abs(d)
}

/** 경계 밖이거나 충돌체에 파묻혔으면 이유를 돌려준다 */
function violation(world: WorldDef, n: { x: number; z: number }, eps = 0.02): string | null {
  const b = world.bounds
  const r = NPC_RADIUS
  if (!Number.isFinite(n.x) || !Number.isFinite(n.z)) return 'NaN'
  if (n.x < b.x0 + r - eps || n.x > b.x1 - r + eps || n.z < b.z0 + r - eps || n.z > b.z1 - r + eps) return 'bounds'
  for (const bx of world.boxes) {
    const cx = Math.max(bx.x0, Math.min(bx.x1, n.x))
    const cz = Math.max(bx.z0, Math.min(bx.z1, n.z))
    if (Math.hypot(n.x - cx, n.z - cz) < r - eps) return 'box'
  }
  for (const c of world.circles) if (Math.hypot(n.x - c.x, n.z - c.z) < c.r + r - eps) return 'circle'
  return null
}

/** 플레이어를 (tx,tz)로 speed 만큼 한 틱 움직인다. 도착하면 true */
function walkPlayer(p: PlayerState, tx: number, tz: number, speed: number): boolean {
  const dx = tx - p.x
  const dz = tz - p.z
  const d = Math.hypot(dx, dz)
  if (d < 1e-6) return true
  const step = Math.min(d, speed * DT)
  p.x += (dx / d) * step
  p.z += (dz / d) * step
  p.yaw = Math.atan2(dx, dz)
  p.st = speed > 4.5 ? Anim.Run : Anim.Walk
  return step >= d - 1e-9
}

/** 배회 중이고 한가한 사람 NPC 를 플레이어 가까운 순으로 고른다 */
function freeCitizens(h: Harness, near: { x: number; z: number }): NpcState[] {
  return h.sim.list
    .filter((n) => n.owner === 0 && n.talker === 0 && (n.mode === 'wander' || n.mode === 'pause'))
    .sort((a, b) => dist(a, near) - dist(b, near) || a.id - b.id)
}

// ───────── 테스트 ─────────

describe('합성 월드 자체 점검', () => {
  it('노드는 전부 빈 곳에 있고 이동망이 이어져 있다', () => {
    for (const w of [townWorld(), fieldWorld()]) {
      for (const nd of w.nav.nodes) expect(isFree(nd.x, nd.z, NPC_RADIUS, w)).toBe(true)
    }
  })
})

describe('생성', () => {
  it('count 명을 이동망 위에 만들고 유형·이름·외형을 규칙대로 뽑는다', () => {
    for (const world of [townWorld(), WORLD]) {
      const h = harness(world, 11)
      expect(h.sim.list.length).toBe(NPCS_PER_ROOM)
      const ids = new Set<number>()
      for (const n of h.sim.list) {
        expect(n.id).toBeGreaterThanOrEqual(1)
        expect(n.id).toBeLessThanOrEqual(255)
        ids.add(n.id)
        expect(h.sim.get(n.id)).toBe(n)
        expect(ARCHETYPES).toContain(n.arch)
        expect(n.arch.names).toContain(n.name)
        expect(n.look.length).toBe(7)
        expect(n.arch.look.outfits).toContain(n.look[1])
        expect(n.arch.look.colors).toContain(n.look[2])
        expect(n.arch.look.hats).toContain(n.look[3])
        expect(n.arch.look.faces).toContain(n.look[4])
        expect(n.arch.look.accs).toContain(n.look[5])
        expect(n.look[0]).toBeGreaterThanOrEqual(0)
        expect(n.look[0]).toBeLessThan(SKIN_COLORS.length)
        expect(n.model).toBe(n.arch.model ?? 0)
        expect(n.role).toBe(n.arch.special === 'rival' ? 'rival' : '')
        expect(n.owner).toBe(0)
        expect(n.talker).toBe(0)
        expect(violation(world, n)).toBeNull()
        // 이동망(간선) 근처에 서 있어야 한다
        let nearest = Infinity
        for (const [a, b] of world.nav.edges) {
          const A = world.nav.nodes[a]!
          const B = world.nav.nodes[b]!
          const l2 = (B.x - A.x) ** 2 + (B.z - A.z) ** 2
          const t = Math.max(0, Math.min(1, ((n.x - A.x) * (B.x - A.x) + (n.z - A.z) * (B.z - A.z)) / l2))
          nearest = Math.min(nearest, Math.hypot(A.x + (B.x - A.x) * t - n.x, A.z + (B.z - A.z) * t - n.z))
        }
        expect(nearest).toBeLessThan(1.6)
      }
      expect(ids.size).toBe(NPCS_PER_ROOM)
      expect(h.sim.get(0)).toBeUndefined()
      expect(h.sim.get(999)).toBeUndefined()
    }
  })

  it('가중치대로 뽑는다(가중치가 큰 유형이 더 많이 나온다)', () => {
    const counts = new Map<string, number>()
    for (let seed = 1; seed <= 40; seed++) {
      for (const n of harness(townWorld(), seed).sim.list) counts.set(n.arch.id, (counts.get(n.arch.id) ?? 0) + 1)
    }
    const total = 40 * NPCS_PER_ROOM
    const wsum = ARCHETYPES.reduce((s, a) => s + a.weight, 0)
    for (const a of ARCHETYPES) {
      const share = (counts.get(a.id) ?? 0) / total
      const want = a.weight / wsum
      expect(Math.abs(share - want)).toBeLessThan(0.05 + want * 0.25)
    }
  })

  it('같은 시드면 똑같이 움직인다(결정적)', () => {
    const run = (): string => {
      const h = harness(townWorld(), 77)
      h.step(600)
      return h.sim.list.map((n) => `${n.id}:${n.arch.id}:${n.x.toFixed(4)},${n.z.toFixed(4)},${n.mode}`).join('|')
    }
    expect(run()).toBe(run())
  })

  it('publicOf 는 공개 정보만 담는다', () => {
    const h = harness(townWorld(), 3)
    const n = h.sim.list[0]!
    expect(h.sim.publicOf(n)).toEqual({
      id: n.id,
      arch: n.arch.id,
      name: n.name,
      look: n.look,
      model: n.model,
      x: n.x,
      z: n.z,
      yaw: n.yaw,
      st: n.st,
      owner: 0,
      role: n.role,
    })
  })
})

describe('배회', () => {
  it('5분 동안 경계 안·충돌체 밖에 머문다 (합성 월드 + 실제 WORLD, 신도·도망·구경 포함)', () => {
    for (const world of [townWorld(), WORLD]) {
      const h = harness(world, 2024)
      const p = h.addPlayer(1, world.spawns[0]!.x, world.spawns[0]!.z)
      const nodes = world.nav.nodes
      let target = 0
      let bad: string | null = null
      let tick = 0
      h.step(3000, () => {
        tick++
        // 플레이어는 이동망 노드를 이리저리 돌아다닌다(걷다 뛰다)
        const nd = nodes[target % nodes.length]!
        if (walkPlayer(p, nd.x, nd.z, tick % 400 < 200 ? WALK_SPEED : RUN_SPEED)) target += 5
        if (tick % 150 === 20) {
          const c = freeCitizens(h, p)[0]
          if (c && h.sim.followersOf(1).length < 6) h.sim.startFollow(c, 1, h.now + 40_000, h.now)
        }
        if (tick % 170 === 90) {
          const c = freeCitizens(h, p)[0]
          if (c) h.sim.flee(c, p.x, p.z, h.now)
        }
        if (tick % 900 === 300) h.sim.gather(world.podium, world.podium.r + world.podium.ramp, h.now + 20_000, 8)
        for (const n of h.sim.list) {
          const v = violation(world, n)
          if (v && !bad) bad = `tick ${tick} #${n.id} ${n.mode} ${v} (${n.x.toFixed(2)}, ${n.z.toFixed(2)})`
        }
      })
      expect(bad).toBeNull()
      expect(h.sim.list.length).toBe(NPCS_PER_ROOM)
    }
  })

  it('걷는 속도는 NPC_WALK_SPEED × arch.speed 이고 한 틱에 순간이동하지 않는다', () => {
    for (const world of [townWorld(), WORLD]) {
      const h = harness(world, 5)
      const before = new Map<number, { x: number; z: number; mode: string; arch: string }>()
      let distSum = 0
      let wantSum = 0
      let maxRatio = 0
      const snap = (): void => {
        for (const n of h.sim.list) before.set(n.id, { x: n.x, z: n.z, mode: n.mode, arch: n.arch.id })
      }
      snap()
      const spawnedAt = h.spawns.length
      let seen = spawnedAt
      h.step(1800, () => {
        const fresh = new Set(h.spawns.slice(seen))
        seen = h.spawns.length
        for (const n of h.sim.list) {
          const b = before.get(n.id)!
          if (fresh.has(n.id)) continue
          const d = Math.hypot(n.x - b.x, n.z - b.z)
          const speed = NPC_WALK_SPEED * n.arch.speed
          // 어떤 모드에서도 배회 중에는 한 틱에 걷는 속도 이상으로 움직이지 않는다
          maxRatio = Math.max(maxRatio, d / (speed * DT))
          if (b.mode === 'wander' && n.mode === 'wander' && n.st === Anim.Walk) {
            distSum += d
            wantSum += speed * DT
          }
        }
        snap()
      })
      expect(wantSum).toBeGreaterThan(1000)
      const ratio = distSum / wantSum
      // 모퉁이를 둥글게 도는 만큼만 살짝 짧다
      expect(ratio).toBeGreaterThan(0.96)
      expect(ratio).toBeLessThan(1.001)
      // 장애물 모서리에서 밀려나는 몫을 빼면 한 틱에 걷는 속도보다 멀리 가지 않는다
      expect(maxRatio).toBeLessThan(1.2)
    }
  })

  it('방향은 부드럽게 돈다(걷는 중 한 틱에 0.8rad 이하)', () => {
    const h = harness(townWorld(), 9)
    const prevYaw = new Map<number, number>()
    for (const n of h.sim.list) prevYaw.set(n.id, n.yaw)
    let maxTurn = 0
    let seen = 0
    h.step(1200, () => {
      const fresh = new Set(h.spawns.slice(seen))
      seen = h.spawns.length
      for (const n of h.sim.list) {
        if (!fresh.has(n.id)) maxTurn = Math.max(maxTurn, angleGap(n.yaw, prevYaw.get(n.id)!))
        prevYaw.set(n.id, n.yaw)
        expect(n.yaw).toBeGreaterThanOrEqual(-Math.PI - 1e-9)
        expect(n.yaw).toBeLessThanOrEqual(Math.PI + 1e-9)
      }
    })
    expect(maxTurn).toBeGreaterThan(0.1)
    expect(maxTurn).toBeLessThanOrEqual(0.9 + 1e-6)
  })

  it('st 는 보이는 동작과 맞는다: 움직이면 Walk, 서 있으면 Idle', () => {
    const h = harness(townWorld(), 21)
    const before = new Map<number, { x: number; z: number; mode: string }>()
    for (const n of h.sim.list) before.set(n.id, { x: n.x, z: n.z, mode: n.mode })
    let walkTicks = 0
    let idleTicks = 0
    h.step(900, () => {
      for (const n of h.sim.list) {
        const b = before.get(n.id)!
        const moved = Math.hypot(n.x - b.x, n.z - b.z) > 0.011
        if (n.mode === 'pause') {
          expect(n.st).toBe(Anim.Idle)
          // 도착한 바로 그 틱(걷다가 멈춤)만 빼면 제자리에 서 있다
          if (b.mode === 'pause') expect(moved).toBe(false)
          idleTicks++
        }
        if (n.mode === 'wander' && moved) {
          expect(n.st).toBe(Anim.Walk)
          walkTicks++
        }
        if (n.mode === 'enter') expect(n.st).toBe(Anim.Vanish)
        b.x = n.x
        b.z = n.z
        b.mode = n.mode
      }
    })
    expect(walkTicks).toBeGreaterThan(5000)
    expect(idleTicks).toBeGreaterThan(300)
  })

  it('dirty 는 전송 양자화 값이 바뀐 틱에만 선다(서 있는 NPC 는 트래픽 0)', () => {
    for (const world of [townWorld(), WORLD]) {
      const h = harness(world, 31)
      const p = h.addPlayer(1, world.spawns[0]!.x, world.spawns[0]!.z)
      const q = (n: NpcState): string => `${quantPos(n.x)},${quantPos(n.z)},${quantYaw(n.yaw)},${n.st}`
      const last = new Map<number, string>()
      for (const n of h.sim.list) last.set(n.id, q(n))
      let seen = 0
      let wrong: string | null = null
      let idle = 0
      let dirty = 0
      let tick = 0
      h.step(1500, () => {
        tick++
        const fresh = new Set(h.spawns.slice(seen))
        seen = h.spawns.length
        for (const n of h.sim.list) {
          const now = q(n)
          const changed = now !== last.get(n.id)
          if (!fresh.has(n.id) && n.dirty !== changed && !wrong) wrong = `tick ${tick} #${n.id} ${n.mode}: dirty=${n.dirty} changed=${changed}`
          if (n.dirty) dirty++
          else idle++
          last.set(n.id, now)
        }
        // 틱 사이에 방(Room)이 부르는 API 도 섞는다 — 그때 바뀐 값은 그 자리에서 dirty 가 서야 한다
        if (tick % 200 === 50) {
          const c = freeCitizens(h, p)[0]!
          for (const n of h.sim.list) n.dirty = false
          h.sim.beginListen(c, p, h.now + 3000)
          expect(c.dirty).toBe(true)
          for (const n of h.sim.list) last.set(n.id, q(n))
        }
      })
      expect(wrong).toBeNull()
      expect(idle).toBeGreaterThan(500)
      expect(dirty).toBeGreaterThan(5000)
    }
  })

  it('오래 서 있는 NPC 는 dirty 가 한 번도 서지 않는다', () => {
    const h = harness(townWorld(), 13)
    const p = h.addPlayer(1, 0, -13)
    h.step(30)
    const c = freeCitizens(h, p)[0]!
    p.x = c.x + 1.5
    p.z = c.z + 0.5
    h.sim.beginListen(c, p, h.now + 60_000)
    h.step(10) // 고개 돌리는 동안
    let dirtyTicks = 0
    h.step(300, () => {
      if (c.dirty) dirtyTicks++
    })
    expect(c.mode).toBe('listen')
    expect(dirtyTicks).toBe(0)
  })

  it('목적지의 약 15%가 출구라서 시민이 계속 물갈이되고, 총원은 변하지 않는다', () => {
    const h = harness(townWorld(), 99)
    const exits = h.world.nav.nodes.filter((n) => n.kind === 'exit')
    const born: { x: number; z: number }[] = []
    const gone: { x: number; z: number }[] = []
    const last = new Map<number, { x: number; z: number }>()
    for (const n of h.sim.list) last.set(n.id, { x: n.x, z: n.z })
    let seen = 0
    h.step(6000, () => {
      for (const id of h.spawns.slice(seen)) {
        const n = h.sim.get(id)!
        born.push({ x: n.x, z: n.z })
        gone.push(last.get(id)!)
        expect(n.mode).toBe('enter')
        expect(n.st).toBe(Anim.Vanish)
        expect(n.dirty).toBe(true)
      }
      seen = h.spawns.length
      for (const n of h.sim.list) last.set(n.id, { x: n.x, z: n.z })
      expect(h.sim.list.length).toBe(NPCS_PER_ROOM)
    })
    // 사라지는 곳은 언제나 출구다(길이 막혀 그 자리에서 퇴장하는 비상 처리가 한 번도 없었다)
    for (const g of gone) expect(Math.min(...exits.map((e) => dist(e, g)))).toBeLessThan(1.0)
    // 10분에 28명 → 물갈이가 눈에 띄게(수십 번) 일어난다
    expect(h.spawns.length).toBeGreaterThan(20)
    expect(h.spawns.length).toBeLessThan(160)
    // 새 시민은 지하철이나 다른 출구에서 나타난다
    let atSubway = 0
    for (const b of born) {
      const d = Math.min(...exits.map((e) => dist(e, b)))
      expect(d).toBeLessThan(1.0)
      if (dist(b, h.world.subway) < 1.0) atSubway++
    }
    expect(atSubway).toBeGreaterThan(born.length * 0.4)
    expect(new Set(h.sim.list.map((n) => n.id)).size).toBe(NPCS_PER_ROOM)
  })

  it('혼잣말은 방 전체로 2초에 한 번을 넘지 않고, 유형의 mutter 대사만 쓴다', () => {
    const h = harness(townWorld(), 4)
    h.step(3000)
    expect(h.says.length).toBeGreaterThan(60)
    expect(h.says.length).toBeLessThanOrEqual(150)
    const all = new Set(ARCHETYPES.flatMap((a) => a.mutter))
    for (let i = 0; i < h.says.length; i++) {
      expect(all.has(h.says[i]!.text)).toBe(true)
      if (i > 0) expect(h.says[i]!.at - h.says[i - 1]!.at).toBeGreaterThanOrEqual(1999)
    }
  })

  it('틱 간격이 길어도(빈 방 1Hz) 멀쩡히 걷는다', () => {
    const world = townWorld()
    const h = harness(world, 8)
    const start = new Map<number, { x: number; z: number }>()
    for (const n of h.sim.list) start.set(n.id, { x: n.x, z: n.z })
    let bad: string | null = null
    let moved = 0
    h.step(
      300,
      () => {
        for (const n of h.sim.list) {
          const v = violation(world, n)
          if (v && !bad) bad = `#${n.id} ${v}`
        }
      },
      1.0,
    )
    for (const n of h.sim.list) if (dist(n, start.get(n.id)!) > 3) moved++
    expect(bad).toBeNull()
    expect(moved).toBeGreaterThan(20)
    expect(h.spawns.length).toBeGreaterThan(5)
    // dt 가 0·음수·NaN 이어도 터지지 않는다
    h.sim.tick(h.now, 0, h.players)
    h.sim.tick(h.now, -1, h.players)
    h.sim.tick(h.now, Number.NaN, h.players)
    for (const n of h.sim.list) expect(violation(world, n)).toBeNull()
  })

  it('이상한 이동망(노드 1개, 간선 없음, 출구 없음, 노드 0개)에서도 터지지 않는다', () => {
    const base = fieldWorld()
    const worlds: WorldDef[] = [
      { ...base, nav: { nodes: [{ x: 0, z: 0, kind: 'walk' }], edges: [] } },
      { ...base, nav: { nodes: [{ x: 0, z: 0, kind: 'walk' }, { x: 20, z: 0, kind: 'shop' }], edges: [] } },
      { ...base, nav: { nodes: [{ x: 0, z: 0, kind: 'exit' }, { x: 20, z: 0, kind: 'exit' }], edges: [[0, 1]] } },
      { ...base, nav: { nodes: [], edges: [] } },
    ]
    for (const world of worlds) {
      const h = harness(world, 6, 8)
      const p = h.addPlayer(1, 1, 1)
      h.step(300)
      const c = h.sim.list[0]!
      h.sim.startFollow(c, 1, h.now + 5000, h.now)
      h.sim.flee(h.sim.list[1]!, 0, 0, h.now)
      h.sim.retire(h.sim.list[2]!)
      h.sim.gather({ x: 0, z: 0 }, 3, h.now + 5000, 4)
      h.step(300, () => walkPlayer(p, 30, 10, WALK_SPEED))
      expect(h.sim.list.length).toBe(8)
      for (const n of h.sim.list) expect(violation(world, n)).toBeNull()
    }
  })

  it('count 가 0·음수·과대여도 안전하다', () => {
    expect(harness(townWorld(), 1, 0).sim.list.length).toBe(0)
    expect(harness(townWorld(), 1, -5).sim.list.length).toBe(0)
    const big = harness(townWorld(), 1, 1000)
    expect(big.sim.list.length).toBeLessThanOrEqual(255)
    expect(Math.max(...big.sim.list.map((n) => n.id))).toBeLessThanOrEqual(255)
    big.step(20)
  })
})

describe('대화(listen)', () => {
  it('멈춰서 플레이어를 바라보고, until 이 지나면 스스로 끝낸다', () => {
    const h = harness(townWorld(), 17)
    const p = h.addPlayer(1, 0, -13)
    h.step(60)
    const c = h.sim.list.find((n) => n.mode === 'wander')!
    p.x = c.x + 1.8
    p.z = c.z - 1.1
    const at = { x: c.x, z: c.z }
    h.sim.beginListen(c, p, h.now + 3000)
    expect(c.mode).toBe('listen')
    expect(c.talker).toBe(1)
    expect(c.st).toBe(Anim.Listen)
    expect(h.sim.canTalk(c, 1, h.now)).toBe('ok')
    expect(h.sim.canTalk(c, 2, h.now)).toBe('busy')
    h.step(10)
    expect(c.x).toBe(at.x)
    expect(c.z).toBe(at.z)
    expect(c.st).toBe(Anim.Listen)
    expect(angleGap(c.yaw, Math.atan2(p.x - c.x, p.z - c.z))).toBeLessThan(0.03)
    h.step(15)
    expect(c.mode).toBe('listen')
    h.step(8) // 3.3초 경과
    expect(c.mode).not.toBe('listen')
    expect(c.talker).toBe(0)
    expect(c.st).not.toBe(Anim.Listen)
    // 하던 길을 마저 간다
    h.step(30)
    expect(dist(c, at)).toBeGreaterThan(1)
  })

  it('endListen 은 하던 일로 돌려보내고, walkOff 는 곧바로 걸음을 재촉한다', () => {
    const h = harness(townWorld(), 18)
    const p = h.addPlayer(1, 0, -13)
    h.step(60)
    const walkers = h.sim.list.filter((n) => n.mode === 'wander')
    expect(walkers.length).toBeGreaterThan(10)
    for (const n of walkers) h.sim.beginListen(n, p, h.now + 10_000)
    h.step(5)
    // 절반은 그냥 대화 종료, 절반은 "제 갈 길"(walkOff)
    const ended = walkers.filter((_, i) => i % 2 === 0)
    const walkedOff = walkers.filter((_, i) => i % 2 === 1)
    for (const n of ended) h.sim.endListen(n)
    for (const n of walkedOff) h.sim.walkOff(n)
    for (const n of walkers) {
      expect(n.talker).toBe(0)
      expect(n.mode).toBe('wander')
    }
    // 이어서 걷는 동안의 속도 배수(자기 걷는 속도 대비)를 잰다
    const prev = new Map<number, { x: number; z: number }>()
    for (const n of walkers) prev.set(n.id, { x: n.x, z: n.z })
    const ratio = (group: NpcState[]): number => {
      let d = 0
      let want = 0
      for (const n of group) {
        const b = prev.get(n.id)!
        if (n.mode === 'wander') {
          d += dist(n, b)
          want += NPC_WALK_SPEED * n.arch.speed * DT
        }
      }
      return d / want
    }
    const a: number[] = []
    const b: number[] = []
    h.step(20, () => {
      a.push(ratio(ended))
      b.push(ratio(walkedOff))
      for (const n of walkers) prev.set(n.id, { x: n.x, z: n.z })
    })
    const mean = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length
    expect(mean(a)).toBeGreaterThan(0.9)
    expect(mean(a)).toBeLessThan(1.01)
    // 못 들은 척 빨라진 걸음(약 1.35배)
    expect(mean(b)).toBeGreaterThan(1.2)
    expect(mean(b)).toBeLessThan(1.4)
    // 대화 중이 아닌 NPC 에 endListen 을 불러도 아무 일 없다
    const c = ended[0]!
    const mode = c.mode
    h.sim.endListen(c)
    expect(c.mode).toBe(mode)
  })

  it('말을 건 플레이어가 사라지면 다음 틱에 대화를 끝낸다', () => {
    const h = harness(townWorld(), 19)
    const p = h.addPlayer(1, 0, -13)
    h.step(40)
    const c = freeCitizens(h, p)[0]!
    h.sim.beginListen(c, p, h.now + 60_000)
    h.players.delete(1)
    h.step(1)
    expect(c.mode).not.toBe('listen')
    expect(c.talker).toBe(0)
  })
})

describe('canTalk / remember', () => {
  it('상태별 결과', () => {
    const h = harness(townWorld(), 23)
    const p = h.addPlayer(1, 0, -13)
    h.step(40)
    const [a, b, c, d] = freeCitizens(h, p)
    expect(h.sim.canTalk(a!, 1, h.now)).toBe('ok')

    // memo: until 전에는 그 플레이어만 막힌다
    h.sim.remember(a!, 1, h.now + 5000)
    expect(h.sim.canTalk(a!, 1, h.now)).toBe('memo')
    expect(h.sim.canTalk(a!, 2, h.now)).toBe('ok')
    expect(h.sim.canTalk(a!, 1, h.now + 4999)).toBe('memo')
    expect(h.sim.canTalk(a!, 1, h.now + 5000)).toBe('ok')
    expect(a!.memo.get(1)).toBe(h.now + 5000)

    // busy 가 memo 보다 먼저다
    const p2 = h.addPlayer(2, a!.x + 1, a!.z)
    h.sim.beginListen(a!, p2, h.now + 5000)
    expect(h.sim.canTalk(a!, 1, h.now)).toBe('busy')
    expect(h.sim.canTalk(a!, 2, h.now)).toBe('ok')

    // gone: 도망·퇴장·등장·특수 NPC
    h.sim.flee(b!, p.x, p.z, h.now)
    expect(h.sim.canTalk(b!, 1, h.now)).toBe('gone')
    h.sim.retire(c!)
    expect(c!.mode).toBe('leave')
    expect(h.sim.canTalk(c!, 1, h.now)).toBe('gone')
    const s = h.sim.addScripted(ARCHETYPES[0]!, 'patrol', '단속반', [0, 0, 0, 0, 0, 0, 0], 0, 0)!
    expect(h.sim.canTalk(s, 1, h.now)).toBe('gone')

    // 신도는 다른 사람이 말을 걸 수 있다(빼앗기)
    h.sim.startFollow(d!, 1, h.now + 50_000, h.now)
    expect(h.sim.canTalk(d!, 2, h.now)).toBe('ok')
  })

  it('기억은 새 시민으로 바뀌면 사라지고, 많이 쌓여도 지난 것은 정리된다', () => {
    const h = harness(townWorld(), 24)
    h.step(20)
    const c = h.sim.list[0]!
    for (let pid = 1; pid <= 40; pid++) h.sim.remember(c, pid, h.now + 1000)
    h.step(20) // 2초 → 전부 만료
    h.sim.remember(c, 99, h.now + 1000)
    expect(c.memo.size).toBeLessThan(10)
    expect(h.sim.canTalk(c, 99, h.now)).toBe('memo')
    h.sim.retire(c)
    const n0 = h.spawns.length
    h.step(900)
    expect(h.spawns.slice(n0)).toContain(c.id)
    expect(c.memo.size).toBe(0)
  })
})

describe('신도(follow)', () => {
  /** 평지에서 주인 뒤에 k 명을 붙이고 동쪽으로 걷게 한다 */
  function conga(k: number, seed = 41): { h: Harness; p: PlayerState; f: NpcState[] } {
    const h = harness(fieldWorld(), seed, 12)
    const p = h.addPlayer(1, -50, 20)
    p.yaw = Math.PI / 2
    const f = h.sim.list.slice(0, k)
    f.forEach((n, i) => {
      n.x = p.x - 2 - i * 0.7
      n.z = p.z + (i % 2 ? 0.6 : -0.6)
      h.sim.startFollow(n, 1, h.now + FOLLOW_DURATION_MS, h.now)
    })
    return { h, p, f }
  }

  it('걷는 주인 뒤 1~8m 에서 합류 순서대로 줄지어 따른다', () => {
    const { h, p, f } = conga(6)
    expect(h.owners.map((o) => o.reason)).toEqual(['join', 'join', 'join', 'join', 'join', 'join'])
    expect(h.sim.followersOf(1)).toEqual(f)
    let tick = 0
    let minD = Infinity
    let maxD = 0
    let maxLateral = 0
    h.step(150, () => {
      tick++
      walkPlayer(p, 60, 20, WALK_SPEED)
      if (tick < 30) return
      f.forEach((n, i) => {
        const d = dist(n, p)
        minD = Math.min(minD, d)
        maxD = Math.max(maxD, d)
        maxLateral = Math.max(maxLateral, Math.abs(n.z - p.z))
        // i번째 자리: 1.1 + 0.95·i 에 속도만큼의 지연(≤ 0.9m)
        expect(d).toBeGreaterThan(1.1 + 0.95 * i - 0.05)
        expect(d).toBeLessThan(1.1 + 0.95 * i + 1.0)
        expect(n.x).toBeLessThan(p.x)
        expect(n.st).toBe(Anim.Walk)
        expect(n.mode).toBe('follow')
      })
    })
    expect(minD).toBeGreaterThanOrEqual(1.0)
    expect(maxD).toBeLessThanOrEqual(8)
    expect(maxLateral).toBeLessThan(0.2)
  })

  it('달리는(RUN_SPEED) 주인도 놓치지 않고, 달리기 표시로 바뀐다', () => {
    const { h, p, f } = conga(6)
    let tick = 0
    let maxD = 0
    h.step(200, () => {
      tick++
      walkPlayer(p, 90, 20, RUN_SPEED)
      if (tick < 30 || p.x >= 90) return
      for (const n of f) {
        maxD = Math.max(maxD, dist(n, p))
        expect(n.st).toBe(Anim.Run)
      }
    })
    expect(maxD).toBeLessThanOrEqual(8)
    expect(maxD).toBeGreaterThan(5)
    // 따라잡는 속도는 NPC_FOLLOW_SPEED 를 넘지 않는다
    const far = f[0]!
    p.x -= 30
    const before = { x: far.x, z: far.z }
    h.step(1)
    expect(dist(far, before)).toBeLessThanOrEqual(NPC_FOLLOW_SPEED * DT + 1e-6)
    expect(dist(far, before)).toBeGreaterThan(NPC_FOLLOW_SPEED * DT * 0.9)
  })

  it('주인이 서면 가까이에서 떨지 않고 멈춘다(이력) — 그 뒤로는 dirty 0', () => {
    const { h, p, f } = conga(4)
    h.step(60, () => walkPlayer(p, 0, 20, WALK_SPEED))
    p.st = Anim.Idle
    h.step(60) // 줄 → 부채꼴로 자리 잡는 시간
    let dirty = 0
    const at = f.map((n) => ({ x: n.x, z: n.z }))
    h.step(100, () => {
      for (const n of f) if (n.dirty) dirty++
    })
    expect(dirty).toBe(0)
    f.forEach((n, i) => {
      expect(dist(n, at[i]!)).toBe(0)
      expect(n.st).toBe(Anim.Idle)
      // 주인 뒤쪽(서쪽) 반원, 1m 이상 떨어져서, 주인을 바라본다
      expect(dist(n, p)).toBeGreaterThanOrEqual(1.0)
      expect(dist(n, p)).toBeLessThan(3)
      expect(n.x).toBeLessThan(p.x + 0.3)
      expect(angleGap(n.yaw, Math.atan2(p.x - n.x, p.z - n.z))).toBeLessThan(0.6)
    })
    // 서로 겹쳐 서지 않는다
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) expect(dist(f[i]!, f[j]!)).toBeGreaterThan(0.8)
    // 주인이 살짝(0.3m) 움직인 정도로는 다시 걷지 않는다
    p.x += 0.3
    h.step(20)
    f.forEach((n, i) => expect(dist(n, at[i]!)).toBe(0))
  })

  it('한 명이 빠지면 뒤 사람들이 줄을 당겨 선다', () => {
    const { h, p, f } = conga(4)
    h.step(60, () => walkPlayer(p, 60, 20, WALK_SPEED))
    const before = f.map((n) => dist(n, p))
    expect(before[0]!).toBeLessThan(before[1]!)
    expect(before[1]!).toBeLessThan(before[2]!)
    expect(before[2]!).toBeLessThan(before[3]!)
    h.sim.release(f[1]!, 'leave')
    expect(h.sim.followersOf(1)).toEqual([f[0], f[2], f[3]])
    expect(f[1]!.owner).toBe(0)
    h.step(40, () => walkPlayer(p, 60, 20, WALK_SPEED))
    expect(Math.abs(dist(f[0]!, p) - before[0]!)).toBeLessThan(0.1)
    expect(Math.abs(dist(f[2]!, p) - before[1]!)).toBeLessThan(0.1)
    expect(Math.abs(dist(f[3]!, p) - before[2]!)).toBeLessThan(0.1)
    // 풀려난 사람은 따라오지 않는다
    expect(dist(f[1]!, p)).toBeGreaterThan(8)
  })

  it('주인이 돌아서 걸어와도 1m 안으로 막아서지 않는다', () => {
    const { h, p, f } = conga(5)
    h.step(60, () => walkPlayer(p, 60, 20, WALK_SPEED))
    let minD = Infinity
    // 왔던 길로 되돌아간다(줄을 정면으로 뚫고 지나감)
    h.step(80, () => {
      // 방(Room)의 스냅샷은 틱 직후에 나가므로, 틱 직후의 간격이 보이는 간격이다
      for (const n of f) minD = Math.min(minD, dist(n, p))
      walkPlayer(p, -60, 20, WALK_SPEED)
    })
    expect(minD).toBeGreaterThanOrEqual(1.0 - 1e-6)
    // 다시 뒤에 줄을 선다
    h.step(60, () => walkPlayer(p, -60, 20, WALK_SPEED))
    for (const n of f) {
      expect(n.x).toBeGreaterThan(p.x)
      expect(dist(n, p)).toBeLessThan(8)
    }
  })

  it('건물 모퉁이를 돌아도 벽에 끼지 않고 따라온다(발자취 추적)', () => {
    const world = townWorld()
    const h = harness(world, 43)
    const p = h.addPlayer(1, -16, -14)
    const f = freeCitizens(h, p).slice(0, 5)
    f.forEach((n, i) => {
      n.x = -18 - i * 0.8
      n.z = -14
      h.sim.startFollow(n, 1, h.now + 600_000, h.now)
    })
    // 광장 → 골목(건물 사이) → 남쪽 길 → 담을 한 바퀴 → 남쪽 큰길 → 서쪽 길: 모퉁이를 여러 번 돈다(전부 걸을 수 있는 길)
    const route = [
      [0, -14], [0, 1], [16, 1], [16, -14], [24, -14], [24, 0], [16, 1], [16, 14], [-20, 14], [-22, 2], [-22, -14],
    ]
    for (let i = 0; i < route.length; i++) {
      const a = route[i]!
      const b = route[(i + 1) % route.length]!
      for (let t = 0; t <= 1; t += 0.02) expect(isFree(a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, 0.45, world)).toBe(true)
    }
    let leg = 0
    let bad: string | null = null
    let maxD = 0
    let idleTicks = 0
    let tick = 0
    h.step(1200, () => {
      tick++
      for (const n of f) {
        const v = violation(world, n)
        if (v && !bad) bad = `tick ${tick} #${n.id} ${v}`
        if (tick > 30) {
          maxD = Math.max(maxD, dist(n, p))
          if (n.st === Anim.Idle) idleTicks++
        }
        expect(n.mode).toBe('follow')
      }
      const t = route[leg % route.length]!
      if (walkPlayer(p, t[0]!, t[1]!, tick % 300 < 150 ? WALK_SPEED : RUN_SPEED)) leg++
    })
    expect(bad).toBeNull()
    expect(leg).toBeGreaterThan(12)
    expect(maxD).toBeLessThan(8)
    // 주인이 계속 걷는 동안에는 섰다 걷다 하지 않는다
    expect(idleTicks).toBe(0)
  })

  it('도망갔던 신도는 건물을 돌아서(이동망·발자취) 주인에게 돌아온다', () => {
    const world = townWorld()
    for (const ownerMoves of [false, true]) {
      const h = harness(world, 46)
      const p = h.addPlayer(1, 0, 1)
      const c = freeCitizens(h, p)[0]!
      c.x = -1.5
      c.z = 1
      h.sim.startFollow(c, 1, h.now + FOLLOW_DURATION_MS, h.now)
      h.step(20)
      // 동쪽에서 누가 겁을 줬다 → 서쪽으로 달아난다
      h.sim.flee(c, 1, 1, h.now)
      let bad: string | null = null
      let fled = 0
      let back = -1
      let tick = 0
      h.step(450, () => {
        tick++
        const v = violation(world, c)
        if (v && !bad) bad = `tick ${tick} ${c.mode} ${v}`
        if (c.mode === 'flee') fled = Math.max(fled, dist(c, p))
        // 그 사이 주인은 골목을 지나 건물 반대편(광장)으로 가 버린다
        if (ownerMoves) walkPlayer(p, 0, -14, WALK_SPEED)
        if (back < 0 && tick > 45 && c.mode === 'follow' && dist(c, p) < 2.5) back = tick
      })
      expect(bad).toBeNull()
      expect(fled).toBeGreaterThan(8)
      expect(c.owner).toBe(1)
      expect(c.mode).toBe('follow')
      expect(back).toBeGreaterThan(0)
      expect(back).toBeLessThan(300)
      expect(dist(c, p)).toBeLessThan(2.5)
    }
  })

  it('시간이 다 되면 풀려난다: 떠나는 말 + onOwnerChange(expire), 그리고 출구로 떠나 새 시민으로 바뀐다', () => {
    const h = harness(townWorld(), 44)
    const p = h.addPlayer(1, 0, -13)
    h.step(30)
    const c = freeCitizens(h, p)[0]!
    const arch = c.arch
    h.sim.startFollow(c, 1, h.now + 2000, h.now)
    expect(c.owner).toBe(1)
    expect(c.followSince).toBe(h.now)
    expect(c.until).toBe(h.now + 2000)
    h.says.length = 0
    h.owners.length = 0
    h.step(19)
    expect(c.owner).toBe(1)
    h.step(3)
    expect(c.owner).toBe(0)
    expect(c.mode).not.toBe('follow')
    expect(h.owners).toEqual([{ id: c.id, prev: 1, owner: 0, reason: 'expire' }])
    const said = h.says.filter((s) => s.id === c.id)
    expect(said.length).toBe(arch.leave.length > 0 ? 1 : 0)
    for (const s of said) expect(arch.leave).toContain(s.text)
    expect(h.sim.followersOf(1)).toEqual([])
    // "정신 차린" 신도는 출구로 걸어가 사라지고 같은 id 의 새 시민이 온다
    const n0 = h.spawns.length
    h.step(1200)
    expect(h.spawns.slice(n0)).toContain(c.id)
  })

  it('남의 신도를 startFollow 하면 poach 로 알리고 줄을 옮긴다', () => {
    const h = harness(townWorld(), 45)
    const p1 = h.addPlayer(1, 0, -13)
    h.addPlayer(2, 2, -13)
    h.step(20)
    const c = freeCitizens(h, p1)[0]!
    h.sim.startFollow(c, 1, h.now + 50_000, h.now)
    c.offered = true
    h.step(10)
    h.sim.startFollow(c, 2, h.now + 60_000, h.now)
    expect(h.owners).toEqual([
      { id: c.id, prev: 0, owner: 1, reason: 'join' },
      { id: c.id, prev: 1, owner: 2, reason: 'poach' },
    ])
    expect(c.owner).toBe(2)
    expect(c.offered).toBe(false)
    expect(c.followSince).toBe(h.now)
    expect(h.sim.followersOf(1)).toEqual([])
    expect(h.sim.followersOf(2)).toEqual([c])
    // 같은 주인이 다시 부르면 기한만 늘고 이벤트는 없다
    h.sim.startFollow(c, 2, h.now + 90_000, h.now)
    expect(h.owners.length).toBe(2)
    expect(c.until).toBe(h.now + 90_000)
    expect(h.sim.followersOf(2)).toEqual([c])
  })

  it('따라다니는 동안 20~40초에 한 번 follow 대사를 한다', () => {
    const { h, p, f } = conga(3)
    h.says.length = 0
    let leg = 0
    h.step(900, () => {
      if (walkPlayer(p, leg % 2 ? -50 : 50, 20, WALK_SPEED)) leg++
    })
    for (const n of f) {
      const mine = h.says.filter((s) => s.id === n.id)
      if (n.arch.follow.length === 0) {
        expect(mine.length).toBe(0)
        continue
      }
      expect(mine.length).toBeGreaterThanOrEqual(2)
      expect(mine.length).toBeLessThanOrEqual(5)
      for (const s of mine) expect(n.arch.follow).toContain(s.text)
      for (let i = 1; i < mine.length; i++) {
        const gap = mine[i]!.at - mine[i - 1]!.at
        expect(gap).toBeGreaterThanOrEqual(19_900)
        expect(gap).toBeLessThanOrEqual(40_200)
      }
    }
  })

  it('주인을 40m 넘게 놓치면 포기하고 풀려난다(순간이동은 하지 않는다)', () => {
    const { h, p, f } = conga(2)
    h.step(20)
    p.x += 70
    const before = f.map((n) => ({ x: n.x, z: n.z }))
    h.step(1)
    f.forEach((n, i) => {
      expect(dist(n, before[i]!)).toBeLessThan(1)
      expect(n.owner).toBe(0)
    })
    expect(h.owners.filter((o) => o.reason === 'expire').length).toBe(2)
  })

  it('대화가 끝나면 다시 주인을 따른다(기한 유지)', () => {
    const { h, p, f } = conga(2)
    const p2 = h.addPlayer(2, p.x - 3, p.z + 1)
    h.step(20)
    const c = f[0]!
    const until = c.until
    h.sim.beginListen(c, p2, h.now + 4000)
    expect(c.mode).toBe('listen')
    expect(h.sim.followersOf(1)).toEqual(f)
    h.step(10, () => walkPlayer(p, 60, 20, WALK_SPEED))
    expect(c.mode).toBe('listen')
    h.sim.endListen(c)
    expect(c.mode).toBe('follow')
    expect(c.until).toBe(until)
    h.step(60, () => walkPlayer(p, 60, 20, WALK_SPEED))
    expect(dist(c, p)).toBeLessThan(3)
  })
})

describe('도망(flee)', () => {
  it('위협 반대쪽으로 2.5~4초 전력 질주해 8m 이상 멀어지고, 경계·건물을 지킨다', () => {
    for (const world of [townWorld(), WORLD]) {
      let runs = 0
      for (let seed = 1; seed <= 6; seed++) {
        const h = harness(world, 500 + seed)
        h.step(100 + seed * 13)
        const rnd = mulberry32(seed)
        for (const c of h.sim.list.filter((n) => n.mode === 'wander' || n.mode === 'pause').slice(0, 8)) {
          // 말 걸던 플레이어 자리: NPC 에서 1.5~2.5m, 임의 방향(벽 속이면 건너뛴다)
          const a = rnd() * Math.PI * 2
          const r = 1.5 + rnd()
          const threat = { x: c.x + Math.sin(a) * r, z: c.z + Math.cos(a) * r }
          if (violation(world, threat)) continue
          // 앞 사람이 뛰는 동안 이 사람이 퇴장하기 시작했을 수 있다
          if (!['wander', 'pause'].includes(c.mode)) continue
          const id = c.id
          const spawned = h.spawns.length
          h.sim.flee(c, threat.x, threat.z, h.now)
          expect(c.mode).toBe('flee')
          expect(c.st).toBe(Anim.Sprint)
          expect(c.until).toBeGreaterThanOrEqual(h.now + 2500)
          expect(c.until).toBeLessThanOrEqual(h.now + 4000)
          let ticks = 0
          let burst = 0
          let prev = { x: c.x, z: c.z }
          while (c.mode === 'flee' && ticks < 60) {
            h.step(1)
            ticks++
            const step = dist(c, prev)
            // 모서리에서 밀려나는 몫만큼은 한 걸음보다 살짝 길 수 있다(순간이동은 아니다)
            expect(step).toBeLessThanOrEqual(NPC_FLEE_SPEED * DT * 1.2)
            if (ticks <= 15) burst += step
            prev = { x: c.x, z: c.z }
            expect(violation(world, c)).toBeNull()
            if (c.mode === 'flee') expect(c.st).toBe(Anim.Sprint)
          }
          expect(h.spawns.slice(spawned)).not.toContain(id)
          expect(c.id).toBe(id)
          expect(ticks).toBeLessThanOrEqual(41)
          expect(dist(c, threat)).toBeGreaterThanOrEqual(8)
          // 처음 1.5초는 전속력으로 내달린다(그 뒤로는 맵 구석에 몰려 일찍 멈출 수도 있다)
          expect(burst / (Math.min(ticks, 15) * DT)).toBeGreaterThan(NPC_FLEE_SPEED * 0.8)
          expect(c.st).not.toBe(Anim.Sprint)
          runs++
          // 숨을 고른 뒤 다시 배회한다
          h.step(40)
          expect(['wander', 'pause', 'leave', 'enter']).toContain(c.mode)
        }
      }
      expect(runs).toBeGreaterThan(20)
    }
  })

  it('막다른 구석에서도 경계를 벗어나지 않는다(이동망 없이 직접 도주)', () => {
    const world: WorldDef = { ...fieldWorld(), nav: { nodes: [{ x: 0, z: 0, kind: 'walk' }], edges: [] } }
    const h = harness(world, 3, 4)
    const c = h.sim.list[0]!
    c.x = 95
    c.z = 95
    h.sim.flee(c, 90, 90, h.now)
    h.step(60, () => expect(violation(world, c)).toBeNull())
    expect(c.mode).not.toBe('flee')
  })
})

describe('퇴장과 교체(retire)', () => {
  it('출구로 걸어가 사라지고 같은 id 의 새 시민이 지하철/출구에서 등장한다', () => {
    const world = townWorld()
    const h = harness(world, 61)
    h.step(50)
    const c = h.sim.list.find((n) => n.mode === 'wander')!
    const id = c.id
    h.spawns.length = 0
    h.sim.retire(c)
    expect(c.mode).toBe('leave')
    // 출구 쪽으로 돌아선 뒤(길어야 0.5초) 걸어 나간다
    expect([Anim.Walk, Anim.Idle]).toContain(c.st)
    h.step(5)
    expect(c.mode).toBe('leave')
    // (출구 바로 앞에 있었다면 벌써 사라지는 중일 수도 있다)
    expect([Anim.Walk, Anim.Vanish]).toContain(c.st)
    const exits = world.nav.nodes.filter((n) => n.kind === 'exit')
    let sawVanish = false
    let last = { x: c.x, z: c.z }
    let ticks = 0
    while (!h.spawns.includes(id) && ticks < 1200) {
      last = { x: c.x, z: c.z }
      if (c.mode === 'leave' && c.st === Anim.Vanish) sawVanish = true
      expect(h.sim.canTalk(c, 1, h.now)).toBe('gone')
      h.step(1)
      ticks++
    }
    expect(h.spawns).toContain(id)
    expect(sawVanish).toBe(true)
    // 사라진 곳은 출구 근처
    expect(Math.min(...exits.map((e) => dist(e, last)))).toBeLessThan(1.0)
    // 같은 객체·같은 id 로 새 시민
    expect(h.sim.get(id)).toBe(c)
    expect(c.mode).toBe('enter')
    expect(c.st).toBe(Anim.Vanish)
    expect(Math.min(...exits.map((e) => dist(e, c)))).toBeLessThan(1.0)
    expect(h.sim.canTalk(c, 1, h.now)).toBe('gone')
    expect(c.arch.names).toContain(c.name)
    h.step(15)
    expect(c.mode).toBe('wander')
    expect(c.st).toBe(Anim.Walk)
    expect(h.sim.list.length).toBe(NPCS_PER_ROOM)
  })

  it('신도를 retire 하면 주인과의 연결이 replace 로 끊긴다', () => {
    const h = harness(townWorld(), 62)
    const p = h.addPlayer(1, 0, -13)
    h.step(20)
    const c = freeCitizens(h, p)[0]!
    h.sim.startFollow(c, 1, h.now + 50_000, h.now)
    h.owners.length = 0
    h.sim.retire(c)
    expect(h.owners).toEqual([{ id: c.id, prev: 1, owner: 0, reason: 'replace' }])
    expect(h.sim.followersOf(1)).toEqual([])
    expect(c.mode).toBe('leave')
  })
})

describe('구경(gather)', () => {
  it('근처 배회자를 max 명까지 고리에 모아 중심을 보게 하고, ungather 로 풀어 준다', () => {
    const world = townWorld()
    const h = harness(world, 71)
    h.step(100)
    const center = { x: world.podium.x, z: world.podium.z }
    const radius = 3
    const got = h.sim.gather(center, radius, h.now + 60_000, 7)
    expect(got.length).toBe(7)
    expect(new Set(got.map((n) => n.id)).size).toBe(7)
    for (const n of got) {
      expect(n.mode).toBe('gather')
      expect(n.owner).toBe(0)
      expect(n.model).toBe(0)
      expect(h.sim.canTalk(n, 1, h.now)).toBe('ok')
    }
    let cheers = 0
    let bad: string | null = null
    h.step(300, () => {
      for (const n of got) {
        if (n.st === Anim.Cheer) cheers++
        const v = violation(world, n)
        if (v && !bad) bad = v
      }
    })
    expect(bad).toBeNull()
    expect(cheers).toBeGreaterThan(100)
    for (const n of got) {
      expect(n.mode).toBe('gather')
      const d = dist(n, center)
      expect(d).toBeGreaterThanOrEqual(radius + 2 - 0.05)
      expect(d).toBeLessThanOrEqual(radius + 6 + 0.05)
      expect(angleGap(n.yaw, Math.atan2(center.x - n.x, center.z - n.z))).toBeLessThan(0.1)
      expect([Anim.Cheer, Anim.Idle]).toContain(n.st)
    }
    for (let i = 0; i < got.length; i++) for (let j = i + 1; j < got.length; j++) expect(dist(got[i]!, got[j]!)).toBeGreaterThan(1.0)

    const seats = got.map((n) => ({ x: n.x, z: n.z }))
    h.sim.ungather()
    for (const n of got) {
      expect(n.mode).not.toBe('gather')
      expect(n.st).not.toBe(Anim.Cheer)
    }
    // 흩어져 다시 제 갈 길을 간다: 10초 안에 전원이 자리를 뜬다
    const left = new Set<number>()
    h.step(100, () => {
      got.forEach((n, i) => {
        expect(n.mode).not.toBe('gather')
        if (dist(n, seats[i]!) > 1) left.add(n.id)
      })
    })
    expect(left.size).toBe(got.length)
  })

  it('until 이 지나면 저절로 풀리고, 신도·대화 중·멀리 있는 NPC 는 부르지 않는다', () => {
    const world = townWorld()
    const h = harness(world, 72)
    const p = h.addPlayer(1, 0, -13)
    h.step(100)
    const [a, b] = freeCitizens(h, world.podium)
    h.sim.startFollow(a!, 1, h.now + 50_000, h.now)
    h.sim.beginListen(b!, p, h.now + 50_000)
    const got = h.sim.gather(world.podium, 3, h.now + 5000, 28)
    expect(got).not.toContain(a)
    expect(got).not.toContain(b)
    expect(got.length).toBeGreaterThan(3)
    for (const n of got) expect(dist(n, world.podium)).toBeLessThan(3 + 34 + 0.01)
    h.step(49)
    expect(got.some((n) => n.mode === 'gather')).toBe(true)
    h.step(3)
    expect(got.some((n) => n.mode === 'gather')).toBe(false)
    expect(h.sim.gather(world.podium, 3, h.now + 5000, 0)).toEqual([])
  })

  it('구경꾼을 신도로 만들면 고리를 떠나 주인을 따른다', () => {
    const world = townWorld()
    const h = harness(world, 73)
    const p = h.addPlayer(1, world.podium.x, world.podium.z)
    h.step(100)
    const got = h.sim.gather(world.podium, 3, h.now + 20_000, 6)
    h.step(150)
    const c = got[0]!
    h.sim.startFollow(c, 1, h.now + 50_000, h.now)
    h.sim.ungather()
    expect(c.mode).toBe('follow')
    h.step(100, () => walkPlayer(p, 0, -13, WALK_SPEED))
    expect(c.mode).toBe('follow')
    expect(dist(c, p)).toBeLessThan(3)
  })
})

describe('플레이어 퇴장', () => {
  it('onPlayerLeave 는 신도·대화·기억을 정리한다', () => {
    const h = harness(townWorld(), 81)
    const p = h.addPlayer(1, 0, -13)
    const p2 = h.addPlayer(2, 5, -13)
    h.step(30)
    const [a, b, c, d] = freeCitizens(h, p)
    h.sim.startFollow(a!, 1, h.now + 50_000, h.now)
    h.sim.startFollow(b!, 1, h.now + 50_000, h.now)
    h.sim.startFollow(d!, 2, h.now + 50_000, h.now)
    h.sim.beginListen(c!, p, h.now + 50_000)
    h.sim.remember(d!, 1, h.now + 50_000)
    h.owners.length = 0
    h.says.length = 0
    h.players.delete(1)
    h.sim.onPlayerLeave(1)
    expect(h.owners).toEqual([
      { id: a!.id, prev: 1, owner: 0, reason: 'leave' },
      { id: b!.id, prev: 1, owner: 0, reason: 'leave' },
    ].sort((x, y) => h.sim.list.indexOf(h.sim.get(x.id)!) - h.sim.list.indexOf(h.sim.get(y.id)!)))
    expect(h.says.map((s) => s.id).sort()).toEqual([a!, b!].filter((n) => n.arch.leave.length > 0).map((n) => n.id).sort())
    expect(h.sim.followersOf(1)).toEqual([])
    expect(a!.owner).toBe(0)
    expect(b!.owner).toBe(0)
    expect(a!.mode).not.toBe('follow')
    expect(c!.talker).toBe(0)
    expect(c!.mode).not.toBe('listen')
    expect(d!.memo.has(1)).toBe(false)
    // 다른 플레이어의 신도는 그대로
    expect(d!.owner).toBe(2)
    expect(h.sim.followersOf(2)).toEqual([d])
    h.step(50, () => walkPlayer(p2, 5, 10, WALK_SPEED))
    expect(d!.mode).toBe('follow')
    expect(['wander', 'pause']).toContain(a!.mode)
  })
})

describe('특수 NPC(script)', () => {
  it('시뮬은 script NPC 를 절대 건드리지 않는다', () => {
    const h = harness(townWorld(), 91)
    const p = h.addPlayer(1, 3, 3)
    h.spawns.length = 0
    const s = h.sim.addScripted(ARCHETYPES[0]!, 'patrol', '단속반 김주무관', [1, 2, 0, 1, 0, 0, 0], 3, 2)!
    expect(s).not.toBeNull()
    expect(s.id).toBeGreaterThan(NPCS_PER_ROOM)
    expect(s.id).toBeLessThanOrEqual(255)
    expect(s.mode).toBe('script')
    expect(s.role).toBe('patrol')
    expect(s.name).toBe('단속반 김주무관')
    expect(h.sim.get(s.id)).toBe(s)
    expect(h.sim.list).toContain(s)
    expect(h.spawns).toEqual([s.id])
    // 시스템이 직접 쓴 값이 그대로 남는다
    s.x = 7.25
    s.z = -3.5
    s.yaw = 1.234
    s.st = Anim.Run
    s.dirty = false
    s.until = 12345
    h.step(300, () => {
      expect(s.x).toBe(7.25)
      expect(s.z).toBe(-3.5)
      expect(s.yaw).toBe(1.234)
      expect(s.st).toBe(Anim.Run)
      expect(s.dirty).toBe(false)
      expect(s.mode).toBe('script')
    })
    // 다른 API 도 script NPC 는 그대로 둔다
    h.sim.beginListen(s, p, h.now + 1000)
    h.sim.flee(s, 0, 0, h.now)
    h.sim.startFollow(s, 1, h.now + 1000, h.now)
    h.sim.retire(s)
    h.sim.walkOff(s)
    expect(s.mode).toBe('script')
    expect(s.owner).toBe(0)
    expect(s.x).toBe(7.25)
    expect(h.sim.gather({ x: 7, z: -3 }, 1, h.now + 1000, 50)).not.toContain(s)

    h.sim.removeScripted(s)
    expect(h.sim.get(s.id)).toBeUndefined()
    expect(h.sim.list).not.toContain(s)
    expect(h.sim.list.length).toBe(NPCS_PER_ROOM)
    // 일반 시민은 removeScripted 로 지워지지 않는다
    h.sim.removeScripted(h.sim.list[0]!)
    expect(h.sim.list.length).toBe(NPCS_PER_ROOM)
  })

  it('id 는 255 이하에서 겹치지 않게 주고, 자리가 없으면 null', () => {
    const h = harness(townWorld(), 92)
    const made: NpcState[] = []
    for (;;) {
      const s = h.sim.addScripted(ARCHETYPES[0]!, 'x', '특수', [0, 0, 0, 0, 0, 0, 0], 0, 0)
      if (!s) break
      made.push(s)
      expect(made.length).toBeLessThan(300)
    }
    expect(made.length).toBe(255 - NPCS_PER_ROOM)
    const ids = new Set(h.sim.list.map((n) => n.id))
    expect(ids.size).toBe(255)
    expect(Math.max(...ids)).toBe(255)
    expect(Math.min(...ids)).toBe(1)
    expect(h.sim.addScripted(ARCHETYPES[0]!, 'x', '특수', [0, 0, 0, 0, 0, 0, 0], 0, 0)).toBeNull()
    // 지운 자리는 다시 쓸 수 있다
    const gone = made[10]!
    h.sim.removeScripted(gone)
    const again = h.sim.addScripted(ARCHETYPES[0]!, 'x', '특수', [0, 0, 0, 0, 0, 0, 0], 0, 0)!
    expect(again.id).toBe(gone.id)
    expect(again).not.toBe(gone)
    h.step(5)
  })
})

describe('잘못 만든 월드에서도 버틴다', () => {
  it('이동망 간선 위에 장애물이 놓여 있어도 돌아서 지나간다(끼거나 뚫지 않는다)', () => {
    const world = fieldWorld()
    // 길 한가운데 가로수(반지름 1.2m)와 가판대(2×3m)
    world.circles.push({ x: -30, z: 0, r: 1.2 })
    world.boxes.push({ x0: 29, z0: -1.5, x1: 31, z1: 1.5 })
    const h = harness(world, 12, 16)
    const exits = world.nav.nodes.filter((n) => n.kind === 'exit')
    const last = new Map<number, { x: number; z: number }>()
    for (const n of h.sim.list) last.set(n.id, { x: n.x, z: n.z })
    const still = new Map<number, number>()
    let bad: string | null = null
    let seen = 0
    let crossedTree = 0
    let crossedStall = 0
    let longestStill = 0
    h.step(6000, () => {
      for (const id of h.spawns.slice(seen)) {
        // 그 자리에서 퇴장(비상 처리)하지 않고 출구까지 걸어가서 사라졌다
        expect(Math.min(...exits.map((e) => dist(e, last.get(id)!)))).toBeLessThan(1.0)
      }
      seen = h.spawns.length
      for (const n of h.sim.list) {
        const v = violation(world, n)
        if (v && !bad) bad = `#${n.id} ${n.mode} ${v}`
        const b = last.get(n.id)!
        if ((b.x + 30) * (n.x + 30) < 0 && Math.abs(n.z) < 4) crossedTree++
        if ((b.x - 30) * (n.x - 30) < 0 && Math.abs(n.z) < 5) crossedStall++
        // 걷는 중인데 제자리인 시간(막혀서 비비는 시간)
        const stuck = n.mode === 'wander' && dist(n, b) < 0.02 ? (still.get(n.id) ?? 0) + 1 : 0
        still.set(n.id, stuck)
        longestStill = Math.max(longestStill, stuck)
        b.x = n.x
        b.z = n.z
      }
    })
    expect(bad).toBeNull()
    expect(crossedTree).toBeGreaterThan(10)
    expect(crossedStall).toBeGreaterThan(10)
    expect(longestStill).toBeLessThan(10)
  })
})

describe('동물(model ≠ 0)', () => {
  it('같은 이동망을 어슬렁거리되 더 자주 멈추고, 구경에는 끼지 않는다', async () => {
    const cat: Archetype = {
      id: 'cat',
      name: '길고양이',
      desc: '사람 말이 통하지 않는다.',
      names: ['치즈', '나비'],
      weight: 1,
      base: 0.01,
      like: {},
      flee: 0.5,
      ignore: 0.5,
      curious: 0,
      speed: 1.2,
      look: { outfits: [0], hats: [0], colors: [3], faces: [0], accs: [0] },
      model: 1,
      special: 'animal',
      greet: ['야옹'],
      re: { no: ['야옹'] },
      mutter: ['야옹…'],
      follow: ['냐아'],
      leave: ['(휙 돌아선다)'],
    }
    // 유형 목록만 고양이로 바꿔 시뮬 모듈을 새로 불러온다(다른 테스트에는 영향 없음)
    vi.resetModules()
    vi.doMock('../../shared/content/archetypes', () => ({ ARCHETYPES: [cat], ARCHETYPE_BY_ID: new Map([['cat', cat]]) }))
    try {
      const mod = await import('../../server/core/npcSim')
      const world = townWorld()
      const pauseShare = (make: typeof createNpcSim): { share: number; sim: NpcSimApi; walked: number } => {
        const sim = make(world, mulberry32(15), { onSpawn() {}, onOwnerChange() {}, onSay() {} }, 20)
        const players = new Map<number, PlayerState>()
        let pause = 0
        let total = 0
        let walked = 0
        let now = T0
        const prev = sim.list.map((n) => ({ x: n.x, z: n.z }))
        for (let t = 0; t < 2400; t++) {
          sim.tick((now += 100), DT, players)
          sim.list.forEach((n, i) => {
            expect(violation(world, n)).toBeNull()
            if (n.mode === 'pause') pause++
            if (n.mode === 'pause' || n.mode === 'wander') total++
            if (n.mode === 'wander') walked += dist(n, prev[i]!)
            prev[i]!.x = n.x
            prev[i]!.z = n.z
          })
        }
        return { share: pause / total, sim, walked }
      }
      const cats = pauseShare(mod.createNpcSim)
      const humans = pauseShare(createNpcSim)
      for (const n of cats.sim.list) {
        expect(n.arch.id).toBe('cat')
        expect(n.model).toBe(1)
        expect(n.role).toBe('')
        expect(cat.names).toContain(n.name)
      }
      expect(cats.walked).toBeGreaterThan(1000)
      expect(cats.share).toBeGreaterThan(humans.share * 1.5)
      expect(cats.sim.gather(world.podium, 3, T0 + 999_999_999, 10)).toEqual([])
    } finally {
      vi.doUnmock('../../shared/content/archetypes')
      vi.resetModules()
    }
  })
})

describe('성능', () => {
  it('100개 방 × 28명 한 틱이 10ms 를 한참 밑돈다', () => {
    const sims: Harness[] = []
    for (let i = 0; i < 100; i++) sims.push(harness(WORLD, 1000 + i))
    // 워밍업(JIT) + 다양한 상태로 퍼뜨리기
    for (let t = 0; t < 60; t++) for (const h of sims) h.step(1)
    const rounds: number[] = []
    for (let t = 0; t < 40; t++) {
      const t0 = performance.now()
      for (const h of sims) h.sim.tick((h.now += 100), DT, h.players)
      rounds.push(performance.now() - t0)
    }
    rounds.sort((a, b) => a - b)
    const median = rounds[rounds.length >> 1]!
    console.log(`[npcSim 성능] 100 sims × ${NPCS_PER_ROOM} NPC 한 틱: 중앙값 ${median.toFixed(3)}ms · 최소 ${rounds[0]!.toFixed(3)}ms · 최대 ${rounds[rounds.length - 1]!.toFixed(3)}ms`)
    // 함께 도는 다른 작업 때문에 느려질 수 있으므로 넉넉하게 잡는다(평소 1~2ms)
    expect(median).toBeLessThan(10)
  })
})
