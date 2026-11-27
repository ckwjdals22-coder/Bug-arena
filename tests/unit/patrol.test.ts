import { describe, expect, it } from 'vitest'
import { Anim, NPC_RADIUS, PITCH_COOLDOWN_MS } from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import { ARCHETYPE_BY_ID } from '../../shared/content/archetypes'
import { WORLD, inBox, insideHq } from '../../shared/world'
import type { NpcState } from '../../server/core/api'
import {
  PATROL_ALERT_MS,
  PATROL_CHASE_MS,
  PATROL_COOLDOWN_MS,
  PATROL_GRACE_JOINS,
  PATROL_LINES,
  PATROL_SEE_RANGE,
  PATROL_STUN_MS,
  createPatrolSystem,
} from '../../server/core/systems/patrol'
import { R_NO, TEST_WORLD, setup } from './helpers'

type T = ReturnType<typeof setup>

function patrolOf(t: T): NpcState {
  const n = t.room.npcs.list.find((x) => x.role === 'patrol')
  if (!n) throw new Error('단속반 없음')
  return n
}

/** 새내기 유예(합류 PATROL_GRACE_JOINS 번 미만)를 넘긴 사람으로 만든다 */
function veteran(t: T, who: { id: number }): void {
  const stats = t.player(who.id).prog.stats
  stats[STAT.joins] = Math.max(stats[STAT.joins] ?? 0, PATROL_GRACE_JOINS)
}

/** 단속반에게서 약 8m 떨어진 NPC 5(x=0,z=8) 옆에서 포교한다(새내기 유예는 넘긴 사람으로) */
function pitchNear(t: T, who: { conn: number; id: number }, npcId = 5, rnd = R_NO, fresh = false): void {
  if (!fresh) veteran(t, who)
  t.talk(who, npcId)
  t.pitch(who, npcId, rnd)
}

function phases(t: T, conn: number): string[] {
  return t.host.of(conn, 'patrol').map((m) => m.ph)
}

/** 플레이어를 단속반에게서 늘 8m 떨어진 곳에 둔다(잡히지도, 놓치지도 않게) */
function keepAway(t: T, id: number, ms: number): void {
  const p = t.player(id)
  for (let left = ms; left > 0; left -= 100) {
    const n = patrolOf(t)
    p.x = n.x < 0 ? n.x + 8 : n.x - 8
    p.z = n.z
    t.advance(100)
  }
}

describe('단속반: 등장과 순찰', () => {
  it('방이 열리면 단속반 한 명이 script 모드로 추가된다(시민 유형 목록에는 없다)', () => {
    const t = setup({ systems: [createPatrolSystem] })
    expect(t.sim.called('addScripted')).toEqual(['addScripted:10:patrol'])
    const n = patrolOf(t)
    expect(n.mode).toBe('script')
    expect(n.arch.id).toBe('patrol')
    expect(n.arch.recruitable).toBe(false)
    expect(ARCHETYPE_BY_ID.has('patrol')).toBe(false)
    expect(n.name).toBe('구청 단속반')
  })

  it('실제 맵에서 2분 동안 순찰해도 경계 밖으로 나가거나 충돌체/비밀 건물 안에 들어가지 않는다', () => {
    const t = setup({ systems: [createPatrolSystem], world: WORLD })
    t.join()
    const n = patrolOf(t)
    const seen = new Set<string>()
    let walked = 0
    let prev = { x: n.x, z: n.z }
    for (let i = 0; i < 1200; i++) {
      t.advance(100)
      const b = WORLD.bounds
      expect(n.x).toBeGreaterThanOrEqual(b.x0)
      expect(n.x).toBeLessThanOrEqual(b.x1)
      expect(n.z).toBeGreaterThanOrEqual(b.z0)
      expect(n.z).toBeLessThanOrEqual(b.z1)
      for (const box of WORLD.boxes) expect(inBox(n.x, n.z, box, NPC_RADIUS - 0.05), `box ${JSON.stringify(box)}`).toBe(false)
      expect(insideHq(n.x, n.z, WORLD)).toBe(false)
      const step = Math.hypot(n.x - prev.x, n.z - prev.z)
      // 순찰 걸음(1.8 m/s)보다 빨리 움직이지 않는다
      expect(step).toBeLessThanOrEqual(1.8 * 0.1 + 0.02)
      walked += step
      prev = { x: n.x, z: n.z }
      seen.add(`${Math.round(n.x / 5)},${Math.round(n.z / 5)}`)
    }
    // 실제로 돌아다닌다(멈춰 서기만 하지 않는다)
    expect(walked).toBeGreaterThan(40)
    expect(seen.size).toBeGreaterThan(4)
    expect(t.host.errors()).toEqual([])
  })
})

describe('단속반: 발각과 추격', () => {
  it('9m 안에서 포교하면 alert → 0.8초 뒤 chase, 방 전체가 본다', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    const b = t.join()
    t.host.clear()
    pitchNear(t, a)
    const n = patrolOf(t)
    expect(t.host.of(b.conn, 'patrol')).toEqual([{ t: 'patrol', ph: 'alert', n: n.id, p: a.id }])
    t.advance(TICK)
    const said = t.host.of(b.conn, 'npcSay').flatMap((m) => m.l)
    expect(said).toContainEqual([n.id, PATROL_LINES.alert])
    t.advance(PATROL_ALERT_MS - 200)
    expect(phases(t, a.conn)).toEqual(['alert'])
    t.advance(300)
    expect(phases(t, a.conn)).toEqual(['alert', 'chase'])
    expect(phases(t, b.conn)).toEqual(['alert', 'chase'])
    t.advance(200)
    expect(n.st).toBe(Anim.Run)
  })

  it('9m 밖이거나 비밀 건물 안이면 못 본 척한다', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    pitchNear(t, a, 1) // NPC 1(x=-12) 옆 → 단속반과 13m 이상
    expect(phases(t, a.conn)).toEqual([])
    // 비밀 건물 안: NPC 를 건물 안에 두고 그 옆에서 포교
    t.advance(PITCH_COOLDOWN_MS + 100)
    const n2 = t.npc(2)
    n2.x = -1
    n2.z = 16
    const p = t.player(a.id)
    const pa = patrolOf(t)
    pa.x = 0
    pa.z = 10 // 6m 거리지만 건물 안
    p.x = 0
    p.z = 16.5
    veteran(t, a)
    t.send(a.conn, { t: 'talk', n: 2 })
    t.pitch(a, 2, R_NO)
    expect(phases(t, a.conn)).toEqual([])
  })

  it('보는 거리는 PATROL_SEE_RANGE(9m): 10m 떨어진 포교는 못 본 척한다', () => {
    expect(PATROL_SEE_RANGE).toBe(9)
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    const pa = patrolOf(t)
    const n5 = t.npc(5)
    n5.x = pa.x + 11
    n5.z = pa.z
    pitchNear(t, a, 5) // 플레이어는 NPC 옆(+1m) → 단속반과 12m
    expect(phases(t, a.conn)).toEqual([])
  })

  it('새내기 유예: 합류 3번 미만인 사람의 포교에는 호루라기를 불지 않는다', () => {
    expect(PATROL_GRACE_JOINS).toBe(3)
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    const p = t.player(a.id)
    p.prog.stats[STAT.joins] = 2
    pitchNear(t, a, 5, R_NO, true)
    expect(phases(t, a.conn)).toEqual([])
    t.advance(PITCH_COOLDOWN_MS + 100)
    p.prog.stats[STAT.joins] = 3
    pitchNear(t, a, 6, R_NO, true)
    expect(phases(t, a.conn)).toEqual(['alert'])
  })

  it('잡히면 3초 얼어붙고, 신도 절반(내림)이 scatter 로 흩어지며, 누적 신도 수는 줄지 않는다', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    const b = t.join()
    // 신도 둘(누적 신도 2) — 포교 흐름 대신 시뮬 계약과 grant 로 만든다(포교하면 단속반이 먼저 반응하므로)
    const p = t.player(a.id)
    for (const id of [7, 8]) t.room.npcs.startFollow(t.npc(id), a.id, t.host.t + 60_000, t.host.t)
    t.room.grant(p, { why: 'join', fol: 2 })
    const fol = p.prog.fol
    expect(t.room.npcs.followersOf(a.id).length).toBe(2)
    const caughtBefore = t.stat(a.id, STAT.caught)
    t.host.clear()
    t.sim.calls.length = 0
    pitchNear(t, a)
    // 가만히 서 있으면 곧 잡힌다
    for (let i = 0; i < 40 && !phases(t, a.conn).includes('caught'); i++) t.advance(100)
    const caught = t.host.of(b.conn, 'patrol').find((m) => m.ph === 'caught')
    expect(caught).toMatchObject({ ph: 'caught', p: a.id, ms: PATROL_STUN_MS })
    expect(p.stunUntil).toBeGreaterThan(t.host.t + PATROL_STUN_MS - 200)
    // 둘 중 하나(먼저 따라온 쪽)만 흩어지고 하나는 남는다
    expect(t.sim.called('release:')).toEqual(['release:7:scatter'])
    expect(t.room.npcs.followersOf(a.id).map((n) => n.id)).toEqual([8])
    expect(p.prog.fol).toBe(fol)
    expect(t.stat(a.id, STAT.caught)).toBe(caughtBefore + 1)
    t.advance(TICK)
    expect(t.host.of(b.conn, 'npcSay').flatMap((m) => m.l).map((x) => x[1])).toContain(PATROL_LINES.caught)

    // 얼어붙은 동안은 움직일 수 없고, 풀리면 다시 움직인다
    const x0 = p.x
    t.move(a.conn, x0 + 0.3, p.z)
    expect(p.x).toBe(x0)
    t.advance(PATROL_STUN_MS + 200)
    t.move(a.conn, x0 + 0.3, p.z)
    expect(p.x).toBeCloseTo(x0 + 0.3, 2)
    expect(t.host.errors()).toEqual([])
  })

  it('9초 동안 버티면 놓친다(lost + escapes)', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    pitchNear(t, a)
    t.advance(PATROL_ALERT_MS + 100)
    expect(phases(t, a.conn)).toEqual(['alert', 'chase'])
    keepAway(t, a.id, PATROL_CHASE_MS - 500)
    expect(phases(t, a.conn)).toEqual(['alert', 'chase'])
    keepAway(t, a.id, 800)
    expect(phases(t, a.conn)).toEqual(['alert', 'chase', 'lost'])
    expect(t.stat(a.id, STAT.escapes)).toBe(1)
    expect(t.stat(a.id, STAT.caught)).toBe(0)
    expect(t.player(a.id).stunUntil).toBe(0)
  })

  it('24m 넘게 벌어지면 놓친다', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    pitchNear(t, a)
    t.advance(PATROL_ALERT_MS + 100)
    const n = patrolOf(t)
    const p = t.player(a.id)
    p.x = n.x > 0 ? -19 : 19
    p.z = -19
    expect(Math.hypot(p.x - n.x, p.z - n.z)).toBeGreaterThan(24)
    t.advance(200)
    expect(phases(t, a.conn)).toEqual(['alert', 'chase', 'lost'])
    expect(t.stat(a.id, STAT.escapes)).toBe(1)
  })

  it('비밀 건물 안으로 숨으면 놓친다', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    pitchNear(t, a)
    t.advance(PATROL_ALERT_MS + 100)
    const p = t.player(a.id)
    const hq = TEST_WORLD.hq.inside
    p.x = (hq.x0 + hq.x1) / 2
    p.z = (hq.z0 + hq.z1) / 2
    t.advance(200)
    expect(phases(t, a.conn)).toEqual(['alert', 'chase', 'lost'])
  })

  it('쫓기던 사람이 나가면(경고 중이든 추격 중이든) lost 로 정리되고 단속반은 순찰로 돌아간다', () => {
    for (const wait of [100, PATROL_ALERT_MS + 300]) {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join()
      const b = t.join()
      pitchNear(t, a)
      t.advance(wait)
      t.room.disconnect(a.conn)
      expect(t.host.of(b.conn, 'patrol').map((m) => m.ph).at(-1)).toBe('lost')
      t.advance(10_000)
      expect(t.host.of(b.conn, 'patrol').filter((m) => m.ph === 'lost')).toHaveLength(1)
      expect(patrolOf(t).st).not.toBe(Anim.Run)
      expect(t.host.errors()).toEqual([])
    }
  })

  it('쫓기는 중에 나갔다 바로 들어와도 신도를 되찾지 못한다(자리 기억이 탈출구가 되지 않는다)', () => {
    const hello = (t: T, pid: string) => {
      const conn = t.nextConn()
      t.room.connect(conn)
      t.send(conn, { t: 'hello', v: 1, pid, name: '돌아온사람', look: [0, 0, 0, 0, 0, 0, 0], save: null })
      return { conn, id: t.host.of(conn, 'welcome')[0]!.id }
    }
    // 비교: 쫓기지 않을 때 나갔다 들어오면 신도를 되찾는다
    {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join({ pid: 'runner-aaaaaaaa' })
      t.room.npcs.startFollow(t.npc(1), a.id, t.host.t + 90_000, t.host.t)
      t.room.npcs.startFollow(t.npc(2), a.id, t.host.t + 90_000, t.host.t)
      t.room.disconnect(a.conn)
      const a2 = hello(t, 'runner-aaaaaaaa')
      expect(t.room.npcs.followersOf(a2.id)).toHaveLength(2)
    }
    for (const wait of [100, PATROL_ALERT_MS + 300]) {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join({ pid: 'runner-aaaaaaaa' })
      t.room.npcs.startFollow(t.npc(1), a.id, t.host.t + 90_000, t.host.t)
      t.room.npcs.startFollow(t.npc(2), a.id, t.host.t + 90_000, t.host.t)
      pitchNear(t, a)
      t.advance(wait)
      t.room.disconnect(a.conn)
      const a2 = hello(t, 'runner-aaaaaaaa')
      expect(t.room.npcs.followersOf(a2.id)).toHaveLength(0)
      expect(t.host.errors()).toEqual([])
    }
  })

  it('쫓기던 중에 끊겼다 이어 붙으면 지금 단계(경고·추격·훈방)를 다시 알려 준다', () => {
    const reopen = (t: T, pid: string) => {
      const conn = t.nextConn()
      t.room.connect(conn)
      t.send(conn, { t: 'hello', v: 1, pid, name: '돌아온사람', look: [0, 0, 0, 0, 0, 0, 0], save: null })
      return conn
    }
    // 추격 중
    {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join({ pid: 'runner-bbbbbbbb' })
      pitchNear(t, a)
      t.advance(PATROL_ALERT_MS + 200)
      keepAway(t, a.id, 2000)
      t.room.disconnect(a.conn, false)
      const conn = reopen(t, 'runner-bbbbbbbb')
      const got = t.host.of(conn, 'patrol')
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ ph: 'chase', n: patrolOf(t).id, p: a.id })
      expect(got[0]!.ms).toBeGreaterThan(PATROL_CHASE_MS - 3000)
      expect(got[0]!.ms).toBeLessThan(PATROL_CHASE_MS - 1500)
    }
    // 호루라기 중
    {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join({ pid: 'runner-bbbbbbbb' })
      pitchNear(t, a)
      t.room.disconnect(a.conn, false)
      const conn = reopen(t, 'runner-bbbbbbbb')
      expect(phases(t, conn)).toEqual(['alert'])
    }
    // 끊긴 사이에 잡혔다: 얼어붙은 남은 시간과 함께 알려 준다
    {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join({ pid: 'runner-bbbbbbbb' })
      pitchNear(t, a)
      t.room.disconnect(a.conn, false)
      const p = t.player(a.id)
      for (let i = 0; i < 80 && p.stunUntil <= t.host.t; i++) t.advance(100)
      expect(p.stunUntil).toBeGreaterThan(t.host.t)
      const conn = reopen(t, 'runner-bbbbbbbb')
      const got = t.host.of(conn, 'patrol')
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ ph: 'caught', p: a.id })
      expect(got[0]!.ms).toBeGreaterThan(0)
      expect(got[0]!.ms).toBeLessThanOrEqual(PATROL_STUN_MS)
    }
    // 아무 일도 없을 때는 아무것도 보내지 않는다
    {
      const t = setup({ systems: [createPatrolSystem] })
      const a = t.join({ pid: 'runner-bbbbbbbb' })
      t.room.disconnect(a.conn, false)
      const conn = reopen(t, 'runner-bbbbbbbb')
      expect(t.host.of(conn, 'patrol')).toEqual([])
    }
  })

  it('한 번에 한 명만 쫓고, 추격이 끝난 뒤 90초 동안은 아무도 쫓지 않는다', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    const b = t.join()
    pitchNear(t, a, 5)
    t.advance(PATROL_ALERT_MS + 100)
    // 추격 중에 다른 사람이 근처에서 포교해도 그대로
    pitchNear(t, b, 6)
    expect(t.host.of(b.conn, 'patrol').filter((m) => m.ph === 'alert')).toHaveLength(1)
    expect(t.host.of(b.conn, 'patrol').every((m) => m.p === a.id)).toBe(true)
    // a 를 잡을 때까지
    for (let i = 0; i < 60 && !phases(t, a.conn).some((x) => x === 'caught' || x === 'lost'); i++) t.advance(100)
    const endAt = t.host.t
    // 쿨타임 중: b 가 바로 옆에서 포교해도 못 본 척
    t.advance(PITCH_COOLDOWN_MS + 100)
    const n = patrolOf(t)
    t.npc(3).x = n.x + 2
    t.npc(3).z = n.z
    pitchNear(t, b, 3)
    expect(t.host.of(b.conn, 'patrol').filter((m) => m.ph === 'alert')).toHaveLength(1)
    // 쿨타임이 지나면 다시 본다
    // (무응답 퇴장에 걸리지 않게 ping 을 보내며 기다린다)
    for (let left = PATROL_COOLDOWN_MS - (t.host.t - endAt) + 100; left > 0; left -= 5000) {
      t.send(a.conn, { t: 'ping', c: 1 })
      t.send(b.conn, { t: 'ping', c: 1 })
      t.advance(Math.min(5000, left))
    }
    t.npc(4).x = n.x + 2
    t.npc(4).z = n.z
    pitchNear(t, b, 4)
    const alerts = t.host.of(b.conn, 'patrol').filter((m) => m.ph === 'alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[1]!.p).toBe(b.id)
  })

  it('단속반에게는 말을 걸 수 없다(코어 규칙)', () => {
    const t = setup({ systems: [createPatrolSystem] })
    const a = t.join()
    const n = patrolOf(t)
    t.talk(a, n.id)
    expect(t.host.of(a.conn, 'talkNo').at(-1)).toMatchObject({ n: n.id, why: 'gone' })
    expect(t.player(a.id).talk).toBeNull()
  })
})

const TICK = 100
