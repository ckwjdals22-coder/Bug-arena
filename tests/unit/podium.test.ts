/**
 * 단상 시스템(오늘의 계시 · 집단 설교 · 정각 대집회) 단위 테스트.
 * 가짜 NPC 시뮬은 NPC 를 움직이지 않으므로, 필요한 NPC 는 직접 자리에 옮겨 놓는다.
 */
import { describe, expect, it } from 'vitest'
import {
  FOLLOW_DURATION_MS,
  INF_PROPHECY,
  INF_SERMON_JOIN,
  INF_SERMON_LEADER,
  MAX_ENTOURAGE,
  PROPHECY_COOLDOWN_MS,
  SERMON_DURATION_MS,
  SERMON_ROOM_COOLDOWN_MS,
  SERMON_ROUNDS,
  npcKey,
} from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import { PROPHECIES, PROPHECY_REACTIONS, SERMON_CHANTS, SERMON_CHEERS } from '../../shared/content/prophecies'
import type { ServerMsgOf } from '../../shared/protocol'
import {
  HOUR_MS,
  PROPHECY_BUFF,
  PROPHECY_REACT_MAX,
  RALLY_MS,
  SERMON_CALL_GAP_MS,
  SERMON_FIRST_CALL_MS,
  SERMON_RESP_MS,
  createPodiumSystem,
} from '../../server/core/systems/podium'
import { TEST_WORLD, setup } from './helpers'

const PD = TEST_WORLD.podium

function make(npcs = 9) {
  const base = setup({ systems: [createPodiumSystem], npcs })
  // 긴 시간을 돌리는 테스트에서 유휴 접속 끊김(IDLE_TIMEOUT_MS)에 걸리지 않게 주기적으로 ping 을 보낸다
  const conns: number[] = []
  const ping = (): void => {
    for (const c of conns) base.send(c, { t: 'ping', c: 1 })
  }
  const join: typeof base.join = (j) => {
    const r = base.join(j)
    conns.push(r.conn)
    return r
  }
  const advance = (ms: number): void => {
    for (let left = ms; left > 0; left -= 5000) {
      ping()
      base.advance(Math.min(5000, left))
    }
  }
  /** 시계를 훌쩍 옮긴다(정각 테스트용) */
  const jump = (to: number): void => {
    base.host.t = to
    ping()
  }
  const t = { ...base, join, advance, jump }
  const put = (id: number, x: number, z: number): void => {
    const p = t.player(id)
    p.x = x
    p.z = z
  }
  const toPodium = (who: { id: number }): void => put(who.id, PD.x, PD.z)
  const sermons = (conn: number): ServerMsgOf<'sermon'>[] => t.host.of(conn, 'sermon')
  const last = (conn: number): ServerMsgOf<'sermon'> | undefined => sermons(conn).at(-1)
  const calls = (conn: number) => sermons(conn).filter((m) => m.ph === 'call')
  const rewards = (conn: number, why: string) => t.host.of(conn, 'reward').filter((r) => r.why === why)
  /** 시작 후 n 번째 라운드 구호 시각까지 */
  const toCall = (n: number, startedAt: number): void => {
    const at = startedAt + SERMON_FIRST_CALL_MS + (n - 1) * SERMON_CALL_GAP_MS
    t.advance(Math.max(0, at - t.host.t) + 100)
  }
  return { ...t, put, toPodium, sermons, last, calls, rewards, toCall }
}

describe('오늘의 계시', () => {
  it('단상 위에서만 가능하다', () => {
    const t = make()
    const a = t.join()
    t.put(a.id, PD.x + PD.r + 1.5, PD.z)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.host.of(a.conn, 'prophecy')).toHaveLength(0)
    // 가장자리(+0.4 여유)는 된다
    t.put(a.id, PD.x + PD.r + 0.35, PD.z)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.host.of(a.conn, 'prophecy')).toHaveLength(1)
  })

  it('방 전체에 방송, 보상/통계/버프, 쿨타임', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    t.toPodium(a)
    t.send(a.conn, { t: 'prophecy' })
    const m = t.host.of(b.conn, 'prophecy')[0]!
    expect(m.p).toBe(a.id)
    expect(PROPHECIES).toContain(m.text)
    expect(t.rewards(a.conn, 'prophecy')[0]!.inf).toBe(INF_PROPHECY)
    expect(t.rewards(b.conn, 'prophecy')).toHaveLength(0)
    expect(t.stat(a.id, STAT.prophecies)).toBe(1)
    const p = t.player(a.id)
    expect(p.buff).toBeCloseTo(PROPHECY_BUFF)
    expect(p.buffUntil).toBe(t.host.t + 30_000)

    // 쿨타임 중에는 아무 일도 없다
    t.advance(PROPHECY_COOLDOWN_MS - 1000)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.host.of(b.conn, 'prophecy')).toHaveLength(1)
    t.advance(1100)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.host.of(b.conn, 'prophecy')).toHaveLength(2)
    // 쿨타임은 사람마다 따로
    t.toPodium(b)
    t.send(b.conn, { t: 'prophecy' })
    expect(t.host.of(a.conn, 'prophecy')).toHaveLength(3)
  })

  it('최근 5개 계시는 반복하지 않는다', () => {
    const t = make()
    const a = t.join()
    t.toPodium(a)
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      t.send(a.conn, { t: 'prophecy' })
      t.advance(PROPHECY_COOLDOWN_MS + 100)
      seen.push(t.host.of(a.conn, 'prophecy').at(-1)!.text)
    }
    for (let i = 0; i < seen.length; i++) {
      expect(seen.slice(Math.max(0, i - 5), i)).not.toContain(seen[i])
    }
  })

  it('반응은 14m 안의 실제 NPC 최대 6명(가까운 순), 플레이어는 자동 반응 없음', () => {
    const t = make(12)
    const a = t.join()
    const b = t.join()
    t.toPodium(a)
    t.put(b.id, PD.x + 2, PD.z)
    // 9명은 가까이, 1명은 멀리, 1명은 퇴장 중
    for (let i = 1; i <= 9; i++) Object.assign(t.npc(i), { x: PD.x + i, z: PD.z })
    Object.assign(t.npc(10), { x: PD.x + 20, z: PD.z })
    Object.assign(t.npc(11), { x: PD.x + 0.5, z: PD.z, mode: 'leave' })
    t.send(a.conn, { t: 'prophecy' })
    const re = t.host.of(a.conn, 'prophecy')[0]!.re
    expect(re).toHaveLength(PROPHECY_REACT_MAX)
    expect(re.map((r) => r[0])).toEqual([1, 2, 3, 4, 5, 6].map(npcKey))
    for (const [, text] of re) expect(PROPHECY_REACTIONS).toContain(text)
    expect(re.some((r) => r[0] === b.id)).toBe(false)
  })

  it('주변에 NPC 가 없으면 반응 목록은 비어 있다', () => {
    const t = make()
    const a = t.join()
    t.toPodium(a)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.host.of(a.conn, 'prophecy')[0]!.re).toEqual([])
  })
})

describe('집단 설교', () => {
  it('시작 거절: 단상 밖(far), 진행 중(busy), 쿨타임(cool)', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    t.put(a.id, 5, 5)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    expect(t.last(a.conn)).toMatchObject({ ph: 'no', why: 'far' })
    t.toPodium(a)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    expect(t.last(b.conn)?.ph).toBe('start')
    t.toPodium(b)
    t.send(b.conn, { t: 'sermon', a: 'start' })
    expect(t.last(b.conn)).toMatchObject({ ph: 'no', why: 'busy' })
    t.advance(SERMON_DURATION_MS + 200)
    expect(t.last(b.conn)?.ph).toBe('end')
    t.send(b.conn, { t: 'sermon', a: 'start' })
    const no = t.last(b.conn)!
    expect(no).toMatchObject({ ph: 'no', why: 'cool' })
    expect(no.ms).toBeGreaterThan(SERMON_ROOM_COOLDOWN_MS - 1000)
    expect(no.ms).toBeLessThanOrEqual(SERMON_ROOM_COOLDOWN_MS)
    t.advance(SERMON_ROOM_COOLDOWN_MS)
    t.send(b.conn, { t: 'sermon', a: 'start' })
    expect(t.last(b.conn)?.ph).toBe('start')
  })

  it('이상한 a/r 값은 조용히 무시한다', () => {
    const t = make()
    const a = t.join()
    t.toPodium(a)
    t.send(a.conn, { t: 'sermon', a: 'boom' })
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.send(a.conn, { t: 'sermon', a: 'join' })
    t.send(a.conn, { t: 'sermon', a: 'start' })
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 99 })
    t.send(a.conn, { t: 'sermon', a: 'resp' })
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 'x' })
    expect(t.host.errors()).toEqual([])
    expect(t.sermons(a.conn).map((m) => m.ph)).toEqual(['start'])
  })

  it('전체 흐름: 시작 → 참여 → 3라운드 → 응답 창/중복 → 결과 계산/보상', () => {
    const t = make(9)
    const a = t.join()
    const b = t.join()
    const c = t.join()
    const far = t.join()
    t.toPodium(a)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    const st = t.last(b.conn)!
    expect(st.ph).toBe('start')
    expect(st.s).toMatchObject({ leader: a.id, joined: [a.id] })
    expect(st.s!.endsAt - st.s!.startedAt).toBe(SERMON_DURATION_MS)
    expect(t.sim.called('gather')).toEqual(['gather:12'])
    expect(t.host.of(b.conn, 'feed').some((f) => f.k === 'sermon')).toBe(true)

    // 참여: 광장 근처만, 두 번은 안 됨
    t.put(b.id, TEST_WORLD.plaza.x + TEST_WORLD.plaza.r + 3, TEST_WORLD.plaza.z)
    t.put(c.id, TEST_WORLD.plaza.x, TEST_WORLD.plaza.z + 2)
    t.put(far.id, 15, 15)
    t.send(b.conn, { t: 'sermon', a: 'join' })
    t.send(b.conn, { t: 'sermon', a: 'join' })
    t.send(c.conn, { t: 'sermon', a: 'join' })
    t.send(far.conn, { t: 'sermon', a: 'join' })
    const joins = t.sermons(far.conn).filter((m) => m.ph === 'join')
    expect(joins).toHaveLength(2)
    expect(joins.at(-1)!.s!.joined).toEqual([a.id, b.id, c.id])

    const startedAt = st.s!.startedAt
    // 1라운드: a, b, c 모두 응답 (b 는 두 번)
    t.toCall(1, startedAt)
    const c1 = t.calls(far.conn)
    expect(c1).toHaveLength(1)
    expect(c1[0]!.round).toBe(1)
    expect(c1[0]!.until! - t.host.t).toBeLessThanOrEqual(SERMON_RESP_MS)
    expect(SERMON_CHANTS.some((ch) => ch.call === c1[0]!.call && ch.resp === c1[0]!.resp)).toBe(true)
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.send(b.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.send(b.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.send(c.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.send(far.conn, { t: 'sermon', a: 'resp', r: 1 }) // 참여 안 함 → 무시
    // 구경꾼 환호 약 1초 뒤 3~5명
    t.advance(1200)
    const cheers = t.host.of(far.conn, 'npcSay').flatMap((m) => m.l)
    expect(cheers.length).toBeGreaterThanOrEqual(3)
    expect(cheers.length).toBeLessThanOrEqual(5)
    for (const [, text] of cheers) expect(SERMON_CHEERS).toContain(text)

    // 2라운드: a 만 응답, c 는 창이 닫힌 뒤 응답(무시), b 는 이전 라운드 번호(무시)
    t.toCall(2, startedAt)
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 2 })
    t.send(b.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.advance(SERMON_RESP_MS + 1000)
    t.send(c.conn, { t: 'sermon', a: 'resp', r: 2 })

    // 3라운드: 아무도 안 함 (미래 라운드 미리 보내기도 무시됨)
    t.send(b.conn, { t: 'sermon', a: 'resp', r: 3 })
    t.toCall(3, startedAt)
    const allCalls = t.calls(far.conn)
    expect(allCalls.map((m) => m.round)).toEqual([1, 2, 3])
    expect(new Set(allCalls.map((m) => m.call)).size).toBe(SERMON_ROUNDS)

    t.advance(SERMON_DURATION_MS)
    const end = t.last(far.conn)!
    expect(end.ph).toBe('end')
    // 응답 4 / (3라운드 × 3명) = 44%
    expect(end.score).toBe(44)
    // floor(44/34)=1 + (3명 이상) 1 = 2
    expect(end.converts).toBe(2)
    expect(t.room.npcs.followersOf(a.id)).toHaveLength(2)
    expect(t.sim.called('startFollow')).toHaveLength(2)
    for (const n of t.room.npcs.followersOf(a.id)) expect(n.until).toBeGreaterThanOrEqual(end.s!.endsAt + FOLLOW_DURATION_MS)
    expect(t.sim.called('ungather')).toHaveLength(1)

    expect(t.rewards(a.conn, 'sermon')).toEqual([expect.objectContaining({ inf: INF_SERMON_LEADER, fol: 2 })])
    expect(t.rewards(b.conn, 'sermon')).toEqual([expect.objectContaining({ inf: INF_SERMON_JOIN })])
    expect(t.rewards(c.conn, 'sermon')).toEqual([expect.objectContaining({ inf: INF_SERMON_JOIN })])
    expect(t.rewards(far.conn, 'sermon')).toEqual([])
    expect(t.stat(a.id, STAT.sermonsLed)).toBe(1)
    expect(t.stat(b.id, STAT.sermonsJoined)).toBe(1)
    expect(t.stat(c.id, STAT.sermonsJoined)).toBe(1)
    expect(t.stat(a.id, STAT.sermonsJoined)).toBe(0)
    expect(t.player(a.id).prog.fol).toBe(2)
  })

  it('응답하지 않은 참여자는 보상이 없다', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    t.toPodium(a)
    t.put(b.id, PD.x + 1, PD.z + 1)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    t.send(b.conn, { t: 'sermon', a: 'join' })
    const startedAt = t.last(a.conn)!.s!.startedAt
    for (let r = 1; r <= SERMON_ROUNDS; r++) {
      t.toCall(r, startedAt)
      t.send(a.conn, { t: 'sermon', a: 'resp', r })
    }
    t.advance(SERMON_DURATION_MS)
    const end = t.last(b.conn)!
    // 3 / (3×2) = 50% → floor(50/34) = 1, 2명이라 보너스 없음
    expect(end).toMatchObject({ ph: 'end', score: 50, converts: 1 })
    expect(t.rewards(b.conn, 'sermon')).toEqual([])
    expect(t.stat(b.id, STAT.sermonsJoined)).toBe(0)
  })

  it.each([
    // [참여자 수, 각자 응답 라운드 수, 기대 게이지, 기대 합류]
    [1, 3, 100, 2],
    [1, 0, 0, 0],
    [2, 2, 67, 1],
    [3, 3, 100, 3],
    [6, 3, 100, 4],
    [6, 1, 33, 2],
  ])('게이지/합류 계산: 참여 %i명, 응답 %i회', (n, answers, score, converts) => {
    const t = make(12)
    const ps = Array.from({ length: n }, () => t.join())
    t.toPodium(ps[0]!)
    for (const p of ps.slice(1)) t.put(p.id, PD.x + 1, PD.z + 1)
    t.send(ps[0]!.conn, { t: 'sermon', a: 'start' })
    for (const p of ps.slice(1)) t.send(p.conn, { t: 'sermon', a: 'join' })
    const startedAt = t.last(ps[0]!.conn)!.s!.startedAt
    for (let r = 1; r <= SERMON_ROUNDS; r++) {
      t.toCall(r, startedAt)
      if (r <= answers) for (const p of ps) t.send(p.conn, { t: 'sermon', a: 'resp', r })
    }
    t.advance(SERMON_DURATION_MS)
    const end = t.last(ps[0]!.conn)!
    expect(end.score).toBe(score)
    expect(end.converts).toBe(converts)
    expect(t.room.npcs.followersOf(ps[0]!.id)).toHaveLength(converts)
  })

  it('합류 수는 신도 정원과 모인 구경꾼 수로 제한된다', () => {
    // 정원: 이미 신도 MAX_ENTOURAGE-1 명
    const t = make(12)
    const a = t.join()
    t.toPodium(a)
    for (let i = 1; i < MAX_ENTOURAGE; i++) t.room.npcs.startFollow(t.npc(i), a.id, t.host.t + FOLLOW_DURATION_MS, t.host.t)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    const startedAt = t.last(a.conn)!.s!.startedAt
    for (let r = 1; r <= SERMON_ROUNDS; r++) {
      t.toCall(r, startedAt)
      t.send(a.conn, { t: 'sermon', a: 'resp', r })
    }
    t.advance(SERMON_DURATION_MS)
    expect(t.last(a.conn)).toMatchObject({ score: 100, converts: 1 })
    expect(t.room.npcs.followersOf(a.id)).toHaveLength(MAX_ENTOURAGE)

    // 구경꾼: NPC 가 1명뿐
    const u = make(1)
    const b = u.join()
    u.toPodium(b)
    u.send(b.conn, { t: 'sermon', a: 'start' })
    const s2 = u.last(b.conn)!.s!.startedAt
    for (let r = 1; r <= SERMON_ROUNDS; r++) {
      u.toCall(r, s2)
      u.send(b.conn, { t: 'sermon', a: 'resp', r })
    }
    u.advance(SERMON_DURATION_MS)
    expect(u.last(b.conn)).toMatchObject({ score: 100, converts: 1 })
  })

  it('다른 사람에게 이미 넘어간 구경꾼은 합류시키지 않는다', () => {
    const t = make(2)
    const a = t.join()
    const other = t.join()
    t.toPodium(a)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    // 구경 중인 NPC 1 을 다른 사람이 포섭
    t.room.npcs.startFollow(t.npc(1), other.id, t.host.t + 1000, t.host.t)
    const startedAt = t.last(a.conn)!.s!.startedAt
    for (let r = 1; r <= SERMON_ROUNDS; r++) {
      t.toCall(r, startedAt)
      t.send(a.conn, { t: 'sermon', a: 'resp', r })
    }
    t.advance(SERMON_DURATION_MS)
    expect(t.last(a.conn)!.converts).toBe(1)
    expect(t.npc(1).owner).toBe(other.id)
    expect(t.npc(2).owner).toBe(a.id)
  })

  it('교주가 단상에서 6m 넘게 벗어나면 점수 0, 보상 없이 끝난다', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    t.toPodium(a)
    t.put(b.id, PD.x + 1, PD.z)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    t.send(b.conn, { t: 'sermon', a: 'join' })
    t.toCall(1, t.last(a.conn)!.s!.startedAt)
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 1 })
    t.send(b.conn, { t: 'sermon', a: 'resp', r: 1 })
    // 5m 정도는 괜찮다
    t.put(a.id, PD.x + PD.r + 5, PD.z)
    t.advance(300)
    expect(t.last(b.conn)!.ph).not.toBe('end')
    t.put(a.id, PD.x + PD.r + 6.5, PD.z)
    t.advance(200)
    expect(t.last(b.conn)).toMatchObject({ ph: 'end', score: 0, converts: 0 })
    expect(t.rewards(a.conn, 'sermon')).toEqual([])
    expect(t.rewards(b.conn, 'sermon')).toEqual([])
    expect(t.stat(a.id, STAT.sermonsLed)).toBe(0)
    expect(t.sim.called('ungather')).toHaveLength(1)
    expect(t.room.npcs.followersOf(a.id)).toHaveLength(0)
    // 흐지부지 끝나도 방 쿨타임은 걸린다
    t.toPodium(b)
    t.send(b.conn, { t: 'sermon', a: 'start' })
    expect(t.last(b.conn)).toMatchObject({ ph: 'no', why: 'cool' })
  })

  it('교주가 나가면 즉시 끝(점수 0), 참여자가 나가면 명단에서 빠진다', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    const c = t.join()
    t.toPodium(a)
    t.put(b.id, PD.x + 1, PD.z)
    t.put(c.id, PD.x - 1, PD.z)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    t.send(b.conn, { t: 'sermon', a: 'join' })
    t.send(c.conn, { t: 'sermon', a: 'join' })
    t.room.disconnect(c.conn)
    // 늦게 들어온 사람의 welcome 에는 c 가 빠진 명단
    const late = t.join()
    expect(late.w.sermon).toMatchObject({ leader: a.id, joined: [a.id, b.id] })
    t.room.disconnect(a.conn)
    const end = t.last(b.conn)!
    expect(end).toMatchObject({ ph: 'end', score: 0, converts: 0 })
    expect(t.rewards(b.conn, 'sermon')).toEqual([])
    const later = t.join()
    expect(later.w.sermon).toBeNull()
  })

  it('welcome: 진행 중이 아니면 null, 진행 중이면 현재 상태', () => {
    const t = make()
    const a = t.join()
    expect(a.w.sermon).toBeNull()
    t.toPodium(a)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    const b = t.join()
    expect(b.w.sermon).toMatchObject({ leader: a.id, joined: [a.id] })
    // 늦게 온 사람도 참여할 수 있다
    t.put(b.id, PD.x, PD.z + 2)
    t.send(b.conn, { t: 'sermon', a: 'join' })
    expect(t.last(a.conn)).toMatchObject({ ph: 'join', s: { joined: [a.id, b.id] } })
  })
})

describe('정각 대집회', () => {
  it('정각이 지나면 알리고 3분 동안 계시/설교 보상 2배', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    // 다음 정각 직전으로 시계를 옮긴다
    const next = (Math.floor(t.host.t / HOUR_MS) + 1) * HOUR_MS
    t.jump(next - 50)
    t.advance(200)
    const info = t.host.of(a.conn, 'feed').filter((f) => f.k === 'info' && f.text.includes('정각 대집회'))
    expect(info).toHaveLength(1)

    t.toPodium(a)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.rewards(a.conn, 'prophecy').at(-1)!.inf).toBe(INF_PROPHECY * 2)

    t.put(b.id, PD.x + 1, PD.z)
    t.send(a.conn, { t: 'sermon', a: 'start' })
    t.send(b.conn, { t: 'sermon', a: 'join' })
    const startedAt = t.last(a.conn)!.s!.startedAt
    for (let r = 1; r <= SERMON_ROUNDS; r++) {
      t.toCall(r, startedAt)
      t.send(b.conn, { t: 'sermon', a: 'resp', r })
    }
    t.advance(SERMON_DURATION_MS)
    expect(t.rewards(a.conn, 'sermon').at(-1)!.inf).toBe(INF_SERMON_LEADER * 2)
    expect(t.rewards(b.conn, 'sermon').at(-1)!.inf).toBe(INF_SERMON_JOIN * 2)

    // 3분이 지나면 원래대로, 같은 시간대에는 다시 알리지 않는다
    t.jump(next + RALLY_MS + 10)
    t.advance(100)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.rewards(a.conn, 'prophecy').at(-1)!.inf).toBe(INF_PROPHECY)
    expect(t.host.of(a.conn, 'feed').filter((f) => f.text.includes('정각 대집회'))).toHaveLength(1)
  })

  it('빈 방에서는 정각이 지나가도 보너스가 켜지지 않는다', () => {
    const t = make()
    const next = (Math.floor(t.host.t / HOUR_MS) + 1) * HOUR_MS
    t.jump(next - 50)
    t.advance(200)
    const a = t.join()
    t.toPodium(a)
    t.send(a.conn, { t: 'prophecy' })
    expect(t.rewards(a.conn, 'prophecy').at(-1)!.inf).toBe(INF_PROPHECY)
    expect(t.host.of(a.conn, 'feed').filter((f) => f.text.includes('정각 대집회'))).toHaveLength(0)
  })
})
