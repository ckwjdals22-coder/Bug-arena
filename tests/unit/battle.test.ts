import { describe, expect, it } from 'vitest'
import {
  BATTLE_COOLDOWN_MS,
  BATTLE_DURATION_MS,
  INF_BATTLE_LOSE,
  INF_BATTLE_WIN,
  INVITE_TTL_MS,
  PITCH_COOLDOWN_MS,
} from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import { BATTLE_CAP_CODE, BATTLE_PAIR_WINDOW_MS, createBattleSystem } from '../../server/core/systems/battle'
import { R_JOIN, R_NO, setup } from './helpers'

type T = ReturnType<typeof setup>
type Who = { conn: number; id: number }

function near(t: T, a: Who, b: Who): void {
  const pa = t.player(a.id)
  const pb = t.player(b.id)
  pb.x = pa.x + 1
  pb.z = pa.z
}
function start(t: T): { a: Who; b: Who } {
  const a = t.join()
  const b = t.join()
  near(t, a, b)
  t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
  t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
  return { a, b }
}
const last = <X,>(arr: X[]): X => arr[arr.length - 1] as X
/** 긴 시간을 돌릴 때: 무응답 퇴장(45초)에 걸리지 않게 5초마다 ping 을 보낸다 */
function advanceAlive(t: T, ms: number, whos: Who[]): void {
  for (let left = ms; left > 0; left -= 5000) {
    for (const w of whos) t.send(w.conn, { t: 'ping', c: 1 })
    t.advance(Math.min(5000, left))
  }
}
const phases = (t: T, conn: number): string[] => t.host.of(conn, 'battle').map((m) => m.ph)

describe('포교 배틀: 신청과 수락', () => {
  it('신청 → 상대에게 카드, 수락 → 방 전체에 시작 방송', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    const c = t.join()
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    const inv = t.host.of(b.conn, 'battle')
    expect(inv).toHaveLength(1)
    expect(inv[0]).toMatchObject({ ph: 'inv', from: a.id })
    expect(inv[0]!.until).toBe(t.host.t + INVITE_TTL_MS)
    expect(t.host.of(c.conn, 'battle')).toEqual([]) // 구경꾼에게는 아직 아무것도 없다

    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
    for (const who of [a, b, c]) {
      const m = last(t.host.of(who.conn, 'battle'))
      expect(m.ph).toBe('start')
      expect(m.b).toMatchObject({ a: a.id, b: b.id, sa: 0, sb: 0, endsAt: t.host.t + BATTLE_DURATION_MS })
    }
    expect(t.host.of(c.conn, 'feed').some((f) => f.k === 'battle')).toBe(true)
    expect(t.host.errors()).toEqual([])
  })

  it('동의 없이는 시작되지 않는다: 거절, 무응답, 엉뚱한 응답', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    const c = t.join()
    near(t, a, b)
    near(t, a, c)
    // 신청받지 않은 사람이 수락을 보내도 아무 일도 없다
    t.send(c.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
    // 신청자가 스스로 수락할 수 없다
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.send(a.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
    // 다른 사람 이름으로 수락할 수 없다
    t.send(b.conn, { t: 'battle', a: 'ans', from: c.id, ok: true })
    expect(phases(t, a.conn)).not.toContain('start')
    // 거절
    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: false })
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'no' })
    // 거절당하면 쿨타임
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'cool' })
    // 무응답 → 만료
    t.advance(BATTLE_COOLDOWN_MS + 200)
    t.host.clear()
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.advance(INVITE_TTL_MS + 300)
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'no' })
    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true }) // 만료 뒤 수락은 무효
    expect(phases(t, b.conn)).not.toContain('start')
  })

  it('멀리 있는 사람, 없는 사람, 자기 자신에게는 신청할 수 없다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    t.player(b.id).x = t.player(a.id).x + 15
    for (const to of [b.id, 999, a.id]) {
      t.host.clear()
      t.send(a.conn, { t: 'battle', a: 'req', to })
      expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'far' })
    }
    expect(t.host.of(b.conn, 'battle')).toEqual([])
  })

  it('배틀 중이거나 신청이 걸려 있으면 busy', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = start(t)
    const c = t.join()
    near(t, a, c)
    t.send(c.conn, { t: 'battle', a: 'req', to: a.id })
    expect(last(t.host.of(c.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'busy' })
    t.send(a.conn, { t: 'battle', a: 'req', to: c.id })
    expect(last(t.host.of(a.conn, 'battle')).ph).not.toBe('inv')
    expect(phases(t, c.conn)).not.toContain('inv')
    void b
  })

  it('나를 차단한 사람에게 보낸 신청은 전달되지 않고 몇 초 뒤 거절로만 보인다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join({ pid: 'battle-blocked-0001' })
    const b = t.join()
    near(t, a, b)
    t.player(b.id).blocked.add('battle-blocked-0001')
    t.host.clear()
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    expect(t.host.of(b.conn, 'battle')).toEqual([])
    expect(t.host.of(a.conn, 'battle')).toEqual([]) // 바로 거절되지 않는다
    t.advance(4200)
    expect(t.host.of(a.conn, 'battle')).toEqual([{ t: 'battle', ph: 'no', why: 'no' }])
    expect(t.host.of(b.conn, 'battle')).toEqual([])
  })

  it('입막음된 사람은 신청할 수 없다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    near(t, a, b)
    t.player(a.id).mutedUntil = t.host.t + 60_000
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    expect(t.host.of(b.conn, 'battle')).toEqual([])
  })
})

describe('포교 배틀: 진행과 결과', () => {
  it('배틀 중인 사람의 합류만 점수가 되고, 시간이 끝나면 승패와 보상이 정해진다', () => {
    const t = setup({ systems: [createBattleSystem], npcs: 9 })
    const { a, b } = start(t)
    const c = t.join()
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    expect(last(t.host.of(b.conn, 'battle'))).toMatchObject({ ph: 'score', b: { sa: 1, sb: 0 } })
    t.advance(PITCH_COOLDOWN_MS + 300)
    t.talk(a, 2)
    t.pitch(a, 2, R_NO) // 거절은 점수 없음
    t.talk(b, 3)
    t.pitch(b, 3, R_JOIN)
    t.talk(c, 4) // 구경꾼의 합류는 점수와 무관
    t.pitch(c, 4, R_JOIN)
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'score', b: { sa: 1, sb: 1 } })
    t.advance(PITCH_COOLDOWN_MS + 300)
    t.talk(a, 5)
    t.pitch(a, 5, R_JOIN)
    const infA = t.player(a.id).prog.inf
    const infB = t.player(b.id).prog.inf
    advanceAlive(t, BATTLE_DURATION_MS, [a, b, c])
    const end = last(t.host.of(c.conn, 'battle'))
    expect(end).toMatchObject({ ph: 'end', winner: a.id, b: { sa: 2, sb: 1 } })
    expect(t.player(a.id).prog.inf - infA).toBe(INF_BATTLE_WIN)
    expect(t.player(b.id).prog.inf - infB).toBe(INF_BATTLE_LOSE)
    expect(t.stat(a.id, STAT.battles)).toBe(1)
    expect(t.stat(a.id, STAT.battleWins)).toBe(1)
    expect(t.stat(b.id, STAT.battles)).toBe(1)
    expect(t.stat(b.id, STAT.battleWins)).toBe(0)
    // 끝난 뒤의 합류는 더 이상 점수가 아니다
    t.host.clear()
    t.advance(PITCH_COOLDOWN_MS + 300)
    t.talk(b, 6)
    t.pitch(b, 6, R_JOIN)
    expect(t.host.of(a.conn, 'battle')).toEqual([])
    expect(t.host.errors()).toEqual([])
  })

  it('1:1 이상 동점이면 무승부로 둘 다 같은 보상을 받는다', () => {
    const t = setup({ systems: [createBattleSystem], npcs: 9 })
    const { a, b } = start(t)
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    t.talk(b, 2)
    t.pitch(b, 2, R_JOIN)
    const infA = t.player(a.id).prog.inf
    advanceAlive(t, BATTLE_DURATION_MS + 200, [a, b])
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'end', winner: 0, b: { sa: 1, sb: 1 } })
    const tie = Math.round((INF_BATTLE_WIN + INF_BATTLE_LOSE) / 2)
    expect(t.player(a.id).prog.inf - infA).toBe(tie)
    expect(t.stat(a.id, STAT.battles)).toBe(1)
    expect(t.stat(b.id, STAT.battleWins)).toBe(0)
  })

  it('시간이 끝났는데 0:0 이면 무효: 보상도 전적도 없다(가만히 서서 배틀만 반복하는 농사 차단)', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = start(t)
    const infA = t.player(a.id).prog.inf
    const infB = t.player(b.id).prog.inf
    advanceAlive(t, BATTLE_DURATION_MS + 200, [a, b])
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'end', winner: 0, b: { sa: 0, sb: 0 } })
    expect(t.player(a.id).prog.inf).toBe(infA)
    expect(t.player(b.id).prog.inf).toBe(infB)
    expect(t.stat(a.id, STAT.battles)).toBe(0)
    expect(t.stat(b.id, STAT.battles)).toBe(0)
    expect(t.host.of(a.conn, 'feed').some((f) => f.k === 'battle' && f.text.includes('무효'))).toBe(true)
  })

  it('같은 두 사람은 10분에 세 판까지만 보상을 받는다(재접속해도 유지)', () => {
    const t = setup({ systems: [createBattleSystem], npcs: 9 })
    const a = t.join({ pid: 'battle-pair-a-0001' })
    const b = t.join({ pid: 'battle-pair-b-0001' })
    let npc = 1
    const alive: Who[] = [a, b]
    const round = (who: { a: Who; b: Who }): void => {
      near(t, who.a, who.b)
      t.send(who.a.conn, { t: 'battle', a: 'req', to: who.b.id })
      t.send(who.b.conn, { t: 'battle', a: 'ans', from: who.a.id, ok: true })
      t.talk(who.a, npc)
      t.pitch(who.a, npc, R_JOIN)
      npc = (npc % 9) + 1
      advanceAlive(t, BATTLE_DURATION_MS + 200, alive)
      advanceAlive(t, BATTLE_COOLDOWN_MS + 200, alive)
    }
    let pair = { a, b }
    for (let i = 0; i < 3; i++) round(pair)
    expect(t.stat(a.id, STAT.battleWins)).toBe(3)
    expect(t.stat(b.id, STAT.battles)).toBe(3)
    // 재접속해도 칸은 이어진다(쿨타임 표는 접속자 메모로 남는다). 저장본 없이 들어오므로 전적은 0부터 다시 센다
    t.room.disconnect(a.conn)
    const a2 = t.join({ pid: 'battle-pair-a-0001' })
    alive.splice(0, alive.length, a2, b)
    pair = { a: a2, b }
    const before = t.player(a2.id).prog.inf
    round(pair)
    const joinGain = t.host.of(a2.conn, 'reward').filter((r) => r.why === 'join').reduce((s, r) => s + (r.inf ?? 0), 0)
    expect(t.player(a2.id).prog.inf - before).toBe(joinGain) // 배틀 보상 없음
    expect(t.stat(a2.id, STAT.battleWins)).toBe(0)
    expect(t.host.of(a2.conn, 'err').some((e) => e.code === BATTLE_CAP_CODE)).toBe(true)
    // 다른 상대와는 따로 센다
    const c = t.join({ pid: 'battle-pair-c-0001' })
    alive.push(c)
    round({ a: a2, b: c })
    expect(t.stat(a2.id, STAT.battleWins)).toBe(1)
    // 10분이 지나면 다시 보상
    advanceAlive(t, BATTLE_PAIR_WINDOW_MS, [a2, b, c])
    round(pair)
    expect(t.stat(a2.id, STAT.battleWins)).toBe(2)
  })

  it('점수 없이 한쪽이 나가면 무효다(승리·보상 없음, 배틀은 정리된다)', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = start(t)
    const infB = t.player(b.id).prog.inf
    t.room.disconnect(a.conn)
    expect(last(t.host.of(b.conn, 'battle'))).toMatchObject({ ph: 'end', winner: 0, why: 'left' })
    expect(t.player(b.id).prog.inf - infB).toBe(0)
    expect(t.stat(b.id, STAT.battleWins)).toBe(0)
    expect(t.host.errors()).toEqual([])
  })

  it('신청만 걸어 둔 채 어느 한쪽이 나가도 깨끗이 정리된다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.room.disconnect(a.conn) // 신청자가 나감 → 상대 카드 회수
    expect(last(t.host.of(b.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'left' })
    const c = t.join()
    near(t, b, c)
    t.send(c.conn, { t: 'battle', a: 'req', to: b.id })
    expect(last(t.host.of(b.conn, 'battle'))).toMatchObject({ ph: 'inv', from: c.id })
    t.room.disconnect(b.conn) // 받은 사람이 나감 → 신청자에게 알림
    expect(last(t.host.of(c.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'left' })
    t.advance(INVITE_TTL_MS + 500)
    expect(t.host.errors()).toEqual([])
  })

  it('여러 배틀이 동시에 돌 수 있고, 끝난 뒤에는 쿨타임이 걸린다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = start(t)
    const c = t.join()
    const d = t.join()
    near(t, c, d)
    t.send(c.conn, { t: 'battle', a: 'req', to: d.id })
    t.send(d.conn, { t: 'battle', a: 'ans', from: c.id, ok: true })
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'start', b: { a: c.id, b: d.id } })
    advanceAlive(t, BATTLE_DURATION_MS + 200, [a, b, c, d])
    const ends = t.host.of(a.conn, 'battle').filter((m) => m.ph === 'end')
    expect(ends).toHaveLength(2)
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    expect(last(t.host.of(a.conn, 'battle'))).toMatchObject({ ph: 'no', why: 'cool' })
    advanceAlive(t, BATTLE_COOLDOWN_MS, [a, b, c, d])
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    expect(last(t.host.of(b.conn, 'battle'))).toMatchObject({ ph: 'inv', from: a.id })
  })

  it('나중에 들어온 사람도 진행 중인 배틀을 본다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = start(t)
    const late = t.join()
    expect(late.w.battles).toHaveLength(1)
    expect(late.w.battles[0]).toMatchObject({ a: a.id, b: b.id })
  })

  it('형식이 틀린 메시지는 무시한다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    near(t, a, b)
    for (const m of [
      { t: 'battle' },
      { t: 'battle', a: 'req' },
      { t: 'battle', a: 'req', to: 'x' },
      { t: 'battle', a: 'ans', ok: true },
      { t: 'battle', a: 'zzz', to: b.id },
      { t: 'battle', a: 'req', to: -1 },
      { t: 'battle', a: 'req', to: 1.5 },
    ]) t.send(a.conn, m)
    expect(t.host.of(b.conn, 'battle')).toEqual([])
    expect(t.host.errors()).toEqual([])
  })
})
