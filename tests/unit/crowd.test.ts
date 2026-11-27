/**
 * 붐비는 방(2차 검수): 시민 수가 접속자 수를 따라 늘고 줄며, 신도 정원이 줄고, 신도를 빼앗기면 알려 준다.
 * 시뮬 단위 검증은 결정적인 합성 월드로, 방 단위 검증은 가짜 시뮬(FakeSim)과 진짜 시뮬 둘 다로 한다.
 */
import { describe, expect, it } from 'vitest'
import type { NpcSimApi, NpcState, PlayerState } from '../../server/core/api'
import { createNpcSim } from '../../server/core/npcSim'
import {
  Anim,
  FOLLOWER_LOYALTY_MS,
  MAX_ENTOURAGE,
  NPC_MAX_PER_ROOM,
  NPC_POP_BASE,
  NPC_POP_PER_PLAYER,
  NPCS_PER_ROOM,
  PITCH_COOLDOWN_MS,
  POACH_NOTICE_MS,
  entourageCap,
} from '../../shared/constants'
import { ARCHETYPES } from '../../shared/content/archetypes'
import { decodeSnapshot } from '../../shared/protocol'
import { mulberry32 } from '../../shared/rng'
import type { WorldDef } from '../../shared/world'
import { LOOK0, R_JOIN, setup } from './helpers'

const DT = 0.1
const T0 = 1_700_000_000_000

/** 출구 셋(0, 9, 11)이 있는 작은 마을 — npcSim.test 의 townWorld 와 같은 모양 */
function townWorld(): WorldDef {
  return {
    bounds: { x0: -40, z0: -30, x1: 40, z1: 30 },
    boxes: [
      { x0: -12, z0: -10, x1: -4, z1: -2 },
      { x0: 4, z0: -10, x1: 12, z1: -2 },
      { x0: -12, z0: 4, x1: 12, z1: 9 },
    ],
    circles: [{ x: -20, z: 0, r: 0.6 }],
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
        { x: -36, z: 0, kind: 'exit' },
        { x: -20, z: 1.2, kind: 'walk' },
        { x: -20, z: -14, kind: 'walk' },
        { x: 0, z: -14, kind: 'plaza' },
        { x: 16, z: -14, kind: 'walk' },
        { x: 16, z: 1, kind: 'shop' },
        { x: 0, z: 1, kind: 'cross' },
        { x: -20, z: 14, kind: 'rest' },
        { x: 16, z: 14, kind: 'walk' },
        { x: 36, z: 14, kind: 'exit' },
        { x: 0, z: 14, kind: 'walk' },
        { x: 36, z: -14, kind: 'exit' },
      ],
      edges: [
        [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 1], [3, 6],
        [1, 7], [7, 10], [10, 8], [8, 5], [8, 9], [4, 11],
      ],
    },
  }
}
const EXITS = [
  { x: -36, z: 0 },
  { x: 36, z: 14 },
  { x: 36, z: -14 },
]

function makePlayer(id: number, x: number, z: number): PlayerState {
  return {
    id,
    conn: id,
    pid: 'crowd-' + id,
    name: '교주' + id,
    look: [0, 0, 0, 0, 0, 0, 0],
    prog: {
      v: 1, pid: 'crowd-' + id, inf: 0, fol: 0, coins: 0, rank: 0, stats: {}, ach: [], items: {}, met: [],
      cult: null, cultFol: 0, cultInf: 0, daily: null, ts: 0,
    },
    x, z, yaw: 0, st: Anim.Idle, emote: null, dirty: false, joinedAt: 0, lastMsgAt: 0, lastMoveAt: 0, talk: null,
    cd: new Map(), buff: 0, buffUntil: 0, stunUntil: 0, sprintUntil: 0, blocked: new Set(), mutedUntil: 0,
    nameLockUntil: 0, saveDirty: false, ext: {},
  }
}

interface Crowd {
  sim: NpcSimApi
  players: Map<number, PlayerState>
  now: number
  spawns: { id: number; at: number; x: number; z: number; mode: string }[]
  gone: { id: number; at: number; owner: number; talker: number; mode: string; scripted: boolean; gslot: boolean }[]
  step(n: number, each?: () => void): void
  setPlayers(n: number): void
}

function crowd(seed: number, count: number, max?: number, world: WorldDef = townWorld()): Crowd {
  const c: Crowd = {
    sim: undefined as unknown as NpcSimApi,
    players: new Map(),
    now: T0,
    spawns: [],
    gone: [],
    step(n, each) {
      for (let i = 0; i < n; i++) {
        c.now += DT * 1000
        for (const npc of c.sim.list) npc.dirty = false
        c.sim.tick(c.now, DT, c.players)
        each?.()
      }
    },
    setPlayers(n) {
      // 플레이어는 맵 가장자리 한쪽에 둔다(시민을 막지 않게)
      const top = Math.max(n, ...c.players.keys(), 0)
      for (let id = 1; id <= top; id++) {
        if (id <= n && !c.players.has(id)) c.players.set(id, makePlayer(id, -30 + (id % 10) * 2, 24 + Math.floor(id / 10)))
        else if (id > n) c.players.delete(id)
      }
    },
  }
  c.sim = createNpcSim(
    world,
    mulberry32(seed),
    {
      onSpawn: (npc) => c.spawns.push({ id: npc.id, at: c.now, x: npc.x, z: npc.z, mode: npc.mode }),
      onOwnerChange: () => {},
      onSay: () => {},
      onGone: (npc) =>
        c.gone.push({
          id: npc.id,
          at: c.now,
          owner: npc.owner,
          talker: npc.talker,
          mode: npc.mode,
          scripted: (npc as NpcState & { scripted?: boolean }).scripted === true,
          gslot: (npc as NpcState & { gslot?: boolean }).gslot === true,
        }),
    },
    count,
    max,
  )
  return c
}

const want = (players: number, base: number, max: number): number =>
  Math.min(max, Math.max(base, NPC_POP_BASE + Math.round(NPC_POP_PER_PLAYER * players)))

const citizens = (sim: NpcSimApi): NpcState[] => sim.list.filter((n) => n.mode !== 'script')

/** 목록·id 표가 서로 맞는가(유령 없음) */
function checkIds(sim: NpcSimApi): void {
  const seen = new Set<number>()
  for (const n of sim.list) {
    expect(n.id).toBeGreaterThanOrEqual(1)
    expect(n.id).toBeLessThanOrEqual(255)
    expect(seen.has(n.id)).toBe(false)
    seen.add(n.id)
    expect(sim.get(n.id)).toBe(n)
  }
  for (let id = 1; id <= 255; id++) if (!seen.has(id)) expect(sim.get(id)).toBeUndefined()
}

describe('시민 수가 접속자 수를 따라간다', () => {
  it('목표 공식: 20 + 1.6 × 접속자, 기본 수 아래로도 상한 위로도 가지 않는다', () => {
    expect(want(0, 28, 52)).toBe(28)
    expect(want(5, 28, 52)).toBe(28)
    expect(want(10, 28, 52)).toBe(36)
    expect(want(20, 28, 52)).toBe(52)
    const c = crowd(1, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    for (const n of [0, 3, 8, 12, 20]) {
      c.setPlayers(n)
      c.step(1)
      expect(c.sim.population!().target).toBe(want(n, NPCS_PER_ROOM, NPC_MAX_PER_ROOM))
    }
  })

  it('접속자가 늘면 새 시민이 출구에서 한 명씩 걸어 들어온다(한꺼번에 튀어나오지 않는다)', () => {
    const c = crowd(2, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    expect(c.sim.list).toHaveLength(NPCS_PER_ROOM)
    c.setPlayers(20)
    c.step(10)
    // 1초 안에 몇 명만
    expect(c.spawns.length).toBeGreaterThan(0)
    expect(c.spawns.length).toBeLessThanOrEqual(3)
    c.step(600, () => checkIds(c.sim))
    expect(citizens(c.sim)).toHaveLength(52)
    expect(c.sim.population!()).toEqual({ citizens: 52, target: 52, base: NPCS_PER_ROOM, max: NPC_MAX_PER_ROOM })
    // 새 시민 24명은 모두 출구 곁에서 '등장' 상태로 나타났다
    const fresh = c.spawns.filter((s) => s.id > NPCS_PER_ROOM)
    expect(fresh.length).toBe(24)
    for (const s of fresh) {
      expect(s.mode).toBe('enter')
      expect(Math.min(...EXITS.map((e) => Math.hypot(e.x - s.x, e.z - s.z)))).toBeLessThan(2.5)
    }
    // 들어오는 간격: 같은 순간에 둘이 나오지 않는다
    const times = fresh.map((s) => s.at)
    expect(new Set(times).size).toBe(times.length)
    expect(c.gone).toHaveLength(0)
  })

  it('접속자가 줄면 한동안 기다렸다가 한가한 시민만 출구로 내보내 방에서 뺀다(id 는 한 번만 알린다)', () => {
    const c = crowd(3, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    c.setPlayers(20)
    c.step(600)
    expect(citizens(c.sim)).toHaveLength(52)

    // 신도 3명·대화 중 1명을 만들어 둔다(주인 = 1번)
    const owner = c.players.get(1)!
    // 주인과 40m 넘게 떨어진 신도는 스스로 떨어져 나가므로 가까운 사람으로 고른다
    const free = citizens(c.sim)
      .filter((n) => (n.mode === 'wander' || n.mode === 'pause') && n.model === 0)
      .sort((x, y) => Math.hypot(x.x - owner.x, x.z - owner.z) - Math.hypot(y.x - owner.x, y.z - owner.z))
    const fol = free.slice(0, 3)
    for (const n of fol) c.sim.startFollow(n, 1, c.now + 3_600_000, c.now)
    const talker = free[3]!
    c.sim.beginListen(talker, owner, c.now + 3_600_000)
    const keep = [...fol, talker]

    c.setPlayers(1)
    // 줄이기 전 유예 시간 동안은 아무도 빠지지 않는다
    c.step(550)
    expect(c.sim.population!().target).toBe(52)
    expect(c.gone).toHaveLength(0)
    c.step(100)
    expect(c.sim.population!().target).toBe(want(1, NPCS_PER_ROOM, NPC_MAX_PER_ROOM))
    // 충분히 돌리면 목표까지 줄어든다
    let k = 0
    c.step(6000, () => {
      if (++k % 20 === 0) checkIds(c.sim)
      // 남은 신도·대화 상대는 그대로
      for (const n of fol) expect(n.owner).toBe(1)
      expect(talker.talker).toBe(1)
    })
    expect(citizens(c.sim)).toHaveLength(NPCS_PER_ROOM)
    expect(c.sim.population!().citizens).toBe(NPCS_PER_ROOM)
    expect(c.gone).toHaveLength(52 - NPCS_PER_ROOM)
    // 몇 분 안에 다 빠진다(SHRINK_HOLD 60초 뒤부터 1.5초에 한 명씩 출구로)
    expect(Math.max(...c.gone.map((g) => g.at)) - T0).toBeLessThan(60_000 + 65_000 + 180_000)
    for (const g of c.gone) {
      expect(g.owner).toBe(0)
      expect(g.talker).toBe(0)
      expect(g.mode).toBe('leave')
      expect(g.scripted).toBe(false)
      expect(g.gslot).toBe(false)
    }
    for (const n of keep) expect(c.sim.get(n.id)).toBe(n)
    // 알림은 id 하나당 한 번(같은 id 가 다시 쓰였다면 그 사이에 등장이 있어야 한다)
    const events = [
      ...c.gone.map((g) => ({ id: g.id, at: g.at, k: 'gone' })),
      ...c.spawns.map((s) => ({ id: s.id, at: s.at, k: 'spawn' })),
    ].sort((a, b) => a.at - b.at)
    const alive = new Set(c.sim.list.map((n) => n.id))
    const state = new Map<number, string>()
    for (const e of events) {
      if (e.k === 'gone') expect(state.get(e.id)).not.toBe('gone')
      state.set(e.id, e.k)
    }
    for (const g of c.gone) if (state.get(g.id) === 'gone') expect(alive.has(g.id)).toBe(false)
  })

  it('사라지기 직전까지 출구 쪽으로 걸어간다(그 자리에서 뿅 사라지지 않는다)', () => {
    // 빠진 시민의 마지막 위치는 출구 곁이다
    const lastPos = new Map<number, { x: number; z: number }>()
    const c2 = crowd(4, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    c2.setPlayers(20)
    c2.step(600)
    c2.setPlayers(0)
    const seen = new Map<number, NpcState>()
    c2.step(5000, () => {
      for (const n of c2.sim.list) seen.set(n.id, n)
      for (const g of c2.gone) {
        if (lastPos.has(g.id)) continue
        const n = seen.get(g.id)
        if (n) lastPos.set(g.id, { x: n.x, z: n.z })
      }
    })
    expect(lastPos.size).toBeGreaterThan(0)
    for (const p of lastPos.values()) expect(Math.min(...EXITS.map((e) => Math.hypot(e.x - p.x, e.z - p.z)))).toBeLessThan(3)
  })

  it('한 명이 잠깐 나갔다 들어와도 시민 수가 출렁이지 않는다(이력 현상)', () => {
    const c = crowd(5, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    c.setPlayers(20)
    c.step(600)
    const spawns = c.spawns.length
    for (let k = 0; k < 5; k++) {
      c.setPlayers(19)
      c.step(150)
      c.setPlayers(20)
      c.step(50)
    }
    // 들락날락하는 동안 목표는 그대로이고 아무도 내보내지 않는다
    expect(c.sim.population!().target).toBe(52)
    expect(c.gone).toHaveLength(0)
    expect(c.sim.list.filter((n) => (n as NpcState & { retiring?: boolean }).retiring)).toHaveLength(0)
    // 자연스러운 물갈이(출구로 나갔다 새 시민이 오는 것)만 있다
    expect(c.spawns.length - spawns).toBeGreaterThanOrEqual(0)
  })

  it('지워진 id 는 한동안 쉬었다가 다시 쓰고, 그동안 다른 시민과 섞이지 않는다', () => {
    const c = crowd(6, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    c.setPlayers(20)
    c.step(600)
    c.setPlayers(0)
    c.step(4000)
    expect(c.gone.length).toBeGreaterThan(0)
    // 다시 붐빈다 → 새 시민이 지워졌던 id 를 다시 쓸 수 있다
    c.setPlayers(20)
    c.step(800, () => checkIds(c.sim))
    expect(citizens(c.sim)).toHaveLength(52)
    const goneAt = new Map<number, number>()
    for (const g of c.gone) goneAt.set(g.id, Math.max(goneAt.get(g.id) ?? 0, g.at))
    let reused = 0
    for (const s of c.spawns) {
      const at = goneAt.get(s.id)
      if (at === undefined || s.at < at) continue
      reused++
      expect(s.at - at).toBeGreaterThanOrEqual(10_000)
    }
    expect(reused).toBeGreaterThan(0)
  })

  it('특수 NPC(단속반 등)는 세지도 지우지도 않는다', () => {
    const c = crowd(7, NPCS_PER_ROOM, NPC_MAX_PER_ROOM)
    const patrol = c.sim.addScripted(ARCHETYPES[0]!, 'patrol', '단속반', LOOK0, 0, -14)!
    expect(patrol).not.toBeNull()
    expect(c.sim.population!().citizens).toBe(NPCS_PER_ROOM)
    c.setPlayers(20)
    c.step(600)
    expect(c.sim.population!().citizens).toBe(52)
    expect(c.sim.list).toHaveLength(53)
    c.setPlayers(0)
    c.step(5000)
    expect(c.sim.get(patrol.id)).toBe(patrol)
    expect(patrol.mode).toBe('script')
    expect(patrol.x).toBe(0)
    expect(patrol.z).toBe(-14)
    expect(c.gone.every((g) => g.id !== patrol.id)).toBe(true)
    expect(c.sim.list).toHaveLength(NPCS_PER_ROOM + 1)
  })

  it('기본 수가 0 이거나 상한을 주지 않으면 늘리지 않는다', () => {
    const zero = crowd(8, 0, NPC_MAX_PER_ROOM)
    zero.setPlayers(20)
    zero.step(300)
    expect(zero.sim.list).toHaveLength(0)
    expect(zero.spawns).toHaveLength(0)
    const fixed = crowd(8, 9)
    fixed.setPlayers(20)
    fixed.step(300)
    expect(citizens(fixed.sim)).toHaveLength(9)
    expect(fixed.sim.population!()).toEqual({ citizens: 9, target: 9, base: 9, max: 9 })
  })

  it('기본 수가 작아도 그 아래로는 줄지 않는다', () => {
    const c = crowd(9, 4, NPC_MAX_PER_ROOM)
    c.setPlayers(1)
    c.step(400)
    expect(citizens(c.sim)).toHaveLength(want(1, 4, NPC_MAX_PER_ROOM))
    c.setPlayers(0)
    c.step(6000)
    expect(citizens(c.sim)).toHaveLength(want(0, 4, NPC_MAX_PER_ROOM))
    expect(citizens(c.sim).length).toBeGreaterThanOrEqual(4)
  })
})

describe('신도 정원은 방이 붐빌수록 줄어든다', () => {
  it('8명 이하 6, 9~14명 5, 15명 이상 4 (MAX_ENTOURAGE 가 절대 상한)', () => {
    for (let n = 0; n <= 8; n++) expect(entourageCap(n)).toBe(6)
    for (let n = 9; n <= 14; n++) expect(entourageCap(n)).toBe(5)
    for (let n = 15; n <= 20; n++) expect(entourageCap(n)).toBe(4)
    for (let n = 0; n <= 20; n++) expect(entourageCap(n)).toBeLessThanOrEqual(MAX_ENTOURAGE)
  })

  it('15명 방에서는 다섯 번째 신도가 들어오면 가장 오래된 신도가 떠난다', () => {
    const t = setup({ npcs: 12 })
    const a = t.join()
    for (let i = 0; i < 14; i++) t.join()
    expect(t.room.players.size).toBe(15)
    for (let n = 1; n <= 4; n++) {
      t.talk(a, n)
      t.pitch(a, n, R_JOIN)
      t.advance(PITCH_COOLDOWN_MS)
    }
    expect(t.sim.called('release:')).toHaveLength(0)
    t.talk(a, 5)
    t.pitch(a, 5, R_JOIN)
    expect(t.sim.called('release:')).toEqual(['release:1:expire'])
    expect(t.sim.list.filter((n) => n.owner === a.id)).toHaveLength(4)
  })

  it('정원이 줄어도 이미 있는 신도는 내쫓지 않고, 다음 합류 때 정원에 맞춘다', () => {
    const t = setup({ npcs: 12 })
    const a = t.join()
    for (let n = 1; n <= 6; n++) {
      t.talk(a, n)
      t.pitch(a, n, R_JOIN)
      t.advance(PITCH_COOLDOWN_MS)
    }
    expect(t.sim.list.filter((n) => n.owner === a.id)).toHaveLength(6)
    for (let i = 0; i < 14; i++) t.join()
    t.advance(1000)
    // 사람이 늘었다고 신도를 빼앗지 않는다
    expect(t.sim.list.filter((n) => n.owner === a.id)).toHaveLength(6)
    expect(t.sim.called('release:')).toHaveLength(0)
    t.talk(a, 7)
    t.pitch(a, 7, R_JOIN)
    expect(t.sim.called('release:')).toEqual(['release:1:expire', 'release:2:expire', 'release:3:expire'])
    expect(t.sim.list.filter((n) => n.owner === a.id).map((n) => n.id)).toEqual([4, 5, 6, 7])
  })
})

describe('신도를 빼앗기면 원래 교주에게 알려 준다', () => {
  it('누가 누구를 데려갔는지 피해자에게만, 5초에 한 번', () => {
    const t = setup({ npcs: 6 })
    const a = t.join({ name: '피해교주' })
    const b = t.join({ name: '도둑교주' })
    for (const n of [1, 2]) {
      t.talk(a, n)
      t.pitch(a, n, R_JOIN)
      t.advance(PITCH_COOLDOWN_MS)
    }
    // 의리 기간(갓 따라나선 신도는 남의 말을 듣지 않는다)이 지난 신도들이다
    const aged = (n: number): void => {
      t.npc(n).followSince = t.host.t - FOLLOWER_LOYALTY_MS
    }
    aged(1)
    aged(2)
    t.host.clear()
    t.talk(b, 1)
    t.pitch(b, 1, R_JOIN)
    expect(t.npc(1).owner).toBe(b.id)
    const notices = (conn: number, thief: number) => t.host.of(conn, 'feed').filter((f) => f.k === 'info' && f.id === thief)
    const feeds = notices(a.conn, b.id)
    expect(feeds).toHaveLength(1)
    expect(feeds[0]!.k).toBe('info')
    expect(feeds[0]!.id).toBe(b.id)
    expect(feeds[0]!.text).toContain('도둑교주')
    expect(feeds[0]!.text).toContain(t.npc(1).name)
    expect(feeds[0]!.text).not.toContain('{')
    // 데려간 사람이나 구경꾼에게는 보내지 않는다
    expect(t.host.of(b.conn, 'feed').filter((f) => f.text === feeds[0]!.text)).toHaveLength(0)

    // 5초 안에 또 빼앗기면 알림은 생략
    t.advance(PITCH_COOLDOWN_MS)
    t.talk(b, 2)
    t.pitch(b, 2, R_JOIN)
    expect(t.npc(2).owner).toBe(b.id)
    expect(notices(a.conn, b.id)).toHaveLength(1)

    // 5초가 지나면 다시 알린다(a 가 되찾았다가 다시 빼앗김)
    t.advance(POACH_NOTICE_MS)
    aged(1)
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    expect(notices(b.conn, a.id)).toHaveLength(1)
    t.advance(PITCH_COOLDOWN_MS)
    aged(1)
    t.talk(b, 1)
    t.pitch(b, 1, R_JOIN)
    expect(notices(a.conn, b.id)).toHaveLength(2)
  })

  it('새로 합류하거나 시간이 다 되어 떠나는 것은 빼앗김이 아니다', () => {
    const t = setup({ npcs: 6 })
    const a = t.join()
    t.join()
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    expect(t.host.of(a.conn, 'feed').filter((f) => f.k === 'info')).toHaveLength(0)
  })
})

describe('방: 빠진 시민은 모두에게 지워지고 스냅샷에 다시 나오지 않는다', () => {
  it('npcGone 방송, 스냅샷·welcome 과 목록 일치', () => {
    const t = setup({ realSim: true, npcs: 10, world: townWorld(), seed: 11 })
    const joined = Array.from({ length: 20 }, () => t.join())
    // 가만히 있으면 잠수로 내보내지므로 가끔 핑을 보내며 시계를 돌린다
    const live = (ms: number, who: { conn: number }[]): void => {
      for (let left = ms; left > 0; left -= 10_000) {
        for (const j of who) if (!t.host.closes.has(j.conn)) t.send(j.conn, { t: 'ping', c: left })
        t.advance(Math.min(10_000, left))
      }
    }
    live(60_000, joined)
    expect(t.room.players.size).toBe(20)
    const peak = t.room.npcs.list.length
    expect(peak).toBe(want(20, 10, NPC_MAX_PER_ROOM))
    expect(t.host.of(joined[0]!.conn, 'npcSpawn').length).toBeGreaterThanOrEqual(peak - 10)
    // 한 명만 남기고 나간다
    for (const j of joined.slice(1)) t.room.disconnect(j.conn, true)
    const stay = joined[0]!
    t.host.clear()
    live(400_000, [stay])
    expect(t.room.players.size).toBe(1)
    expect(t.room.npcs.list.length).toBe(want(1, 10, NPC_MAX_PER_ROOM))
    const gone = t.host.of(stay.conn, 'npcGone').map((m) => m.n)
    expect(gone.length).toBeGreaterThan(0)
    // 지워진 뒤로 그 id 는 (다시 등장하기 전까지) 스냅샷에 나오지 않는다
    const alive = new Set<number>(t.room.npcs.list.map((n) => n.id))
    const frames = t.host.frames.get(stay.conn) ?? []
    const dead = new Set<number>()
    for (const f of frames) {
      if (typeof f === 'string') {
        const m = JSON.parse(f) as { t: string; n: number | { id: number } }
        if (m.t === 'npcGone') dead.add(m.n as number)
        if (m.t === 'npcSpawn') dead.delete((m.n as { id: number }).id)
        continue
      }
      const snap = decodeSnapshot(f)!
      for (const e of snap.npcs) expect(dead.has(e.id)).toBe(false)
    }
    for (const id of dead) expect(alive.has(id)).toBe(false)
    // 새로 들어온 사람의 welcome 은 지금 있는 시민만 정확히 담는다
    const late = t.join()
    const w = t.host.of(late.conn, 'welcome')[0]!
    expect(w.npcs.map((n) => n.id).sort((x, y) => x - y)).toEqual([...alive].sort((x, y) => x - y))
  })
})

