/**
 * 업적 / 일일 수행 시스템 단위 테스트.
 * 이 시스템만 등록해(다른 기능 시스템과 섞이지 않게) FakeHost 시계로 날짜를 조종한다.
 */
import { describe, expect, it } from 'vitest'
import { ACHIEVEMENTS, DAILY_QUESTS, DAILY_QUEST_BY_ID, DAILY_QUEST_COUNT } from '../../shared/content/achievements'
import { STAT } from '../../shared/content/core'
import { PROPHECIES } from '../../shared/content/prophecies'
import { newProgress, normalizeProgress } from '../../shared/rules/progress'
import type { DailyState, Progress, SignedSave } from '../../shared/types'
import {
  DAILY_BONUS,
  createAchievementsSystem,
  kstDayKey,
  nextStreak,
  pickDailyQuests,
  sanitizeDaily,
} from '../../server/core/systems/achievements'
import { setup } from './helpers'

const T0 = Date.UTC(2026, 10, 26, 3, 0, 0) // KST 2026-11-26 12:00
const DAY = 86_400_000

function make(t0 = T0) {
  const t = setup({ systems: [createAchievementsSystem] })
  t.host.t = t0
  // Room 은 생성 시각을 lastTickAt 으로 들고 있다 → 첫 틱의 dt 가 튀지 않도록 한 번 돌려 둔다
  t.advance(50)
  return t
}

function signed(t: ReturnType<typeof make>, prog: Progress): SignedSave {
  const d = JSON.stringify(prog)
  return { d, s: t.host.signer.sign(d) }
}

function lastSave(t: ReturnType<typeof make>, conn: number): SignedSave {
  t.advance(1100)
  const saves = t.host.of(conn, 'save')
  const last = saves[saves.length - 1]
  if (!last) throw new Error('save 없음')
  return last.save
}

/** 오늘의 수행을 원하는 것으로 바꿔 끼운다(무작위 선택에 테스트가 휘둘리지 않게) */
function forceQuests(t: ReturnType<typeof make>, id: number, quests: string[]): DailyState {
  const d = t.player(id).prog.daily!
  d.quests = quests
  d.prog = {}
  d.done = []
  return d
}

describe('KST 날짜 키', () => {
  it('UTC 14:59 와 15:00 사이에서 날짜가 바뀐다', () => {
    expect(kstDayKey(Date.UTC(2026, 10, 26, 14, 59, 59, 999))).toBe('2026-11-26')
    expect(kstDayKey(Date.UTC(2026, 10, 26, 15, 0, 0, 0))).toBe('2026-11-27')
    expect(kstDayKey(Date.UTC(2026, 11, 31, 15, 0, 0))).toBe('2027-01-01')
    expect(kstDayKey(Date.UTC(2026, 10, 26, 0, 0, 0))).toBe('2026-11-26')
  })
})

describe('퀘스트 선택', () => {
  it('pid+날짜로 결정되고, 서로 다른 퀘스트 DAILY_QUEST_COUNT 개', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const pid = `device-${i}-abcdefgh`
      for (const day of ['2026-11-26', '2026-11-27']) {
        const q = pickDailyQuests(pid, day)
        expect(q).toEqual(pickDailyQuests(pid, day))
        expect(q).toHaveLength(DAILY_QUEST_COUNT)
        expect(new Set(q).size).toBe(q.length)
        for (const id of q) expect(DAILY_QUEST_BY_ID.has(id)).toBe(true)
        seen.add(q.join(','))
      }
    }
    // 사람·날짜마다 달라야 한다(전부 같으면 해시가 고장)
    expect(seen.size).toBeGreaterThan(20)
    // 모든 퀘스트가 언젠가는 뽑힌다
    const all = new Set<string>()
    for (let i = 0; i < 400; i++) for (const id of pickDailyQuests(`p${i}`, '2026-11-26')) all.add(id)
    expect(all.size).toBe(DAILY_QUESTS.length)
  })
})

describe('입장과 일일 상태', () => {
  it('welcome 에 오늘의 수행이 실리고, 출석 일수가 오른다', () => {
    const t = make()
    const a = t.join({ pid: 'device-aaa-111111' })
    const d = a.w.me.daily!
    expect(d.day).toBe('2026-11-26')
    expect(d.quests).toEqual(pickDailyQuests('device-aaa-111111', '2026-11-26'))
    expect(d.prog).toEqual({})
    expect(d.done).toEqual([])
    expect(d.streak).toBe(1)
    expect(d.fortune).toBeGreaterThanOrEqual(0)
    expect(d.fortune).toBeLessThan(PROPHECIES.length)
    expect(t.stat(a.id, STAT.days)).toBe(1)
    // 서명은 훅 뒤에 했으므로 welcome 저장본에도 daily 가 있다
    expect(JSON.parse(a.w.save.d).daily.day).toBe('2026-11-26')
    // 업적 보상은 welcome 뒤에 와야 한다(클라이언트가 me 를 가진 뒤)
    const types = t.host.json(a.conn).map((m) => m.t)
    expect(types.indexOf('welcome')).toBe(0)
  })

  it('같은 날 다시 들어와도 출석 일수는 한 번만 오른다', () => {
    const t = make()
    const a = t.join({ pid: 'device-aaa-111111' })
    const save = lastSave(t, a.conn)
    t.room.disconnect(a.conn)
    t.advance(60_000)
    const b = t.join({ pid: 'device-aaa-111111', save })
    expect(t.stat(b.id, STAT.days)).toBe(1)
    expect(b.w.me.daily!.streak).toBe(1)
  })

  it('연속 출석: 어제 → +1, 하루 건너뜀 → 유지, 이틀 이상 → 1', () => {
    const cases: [number, number][] = [
      [1, 5],
      [2, 4],
      [3, 1],
      [10, 1],
    ]
    for (const [gap, expected] of cases) {
      const t = make()
      const prog = newProgress('device-streak-01', T0)
      prog.stats[STAT.days] = 9
      prog.daily = { day: kstDayKey(T0 - gap * DAY), quests: ['d_pitch5'], prog: { d_pitch5: 3 }, done: [], streak: 4, fortune: 0 }
      const a = t.join({ pid: 'device-streak-01', save: signed(t, prog) })
      expect(a.w.me.daily!.streak, `gap ${gap}`).toBe(expected)
      expect(a.w.me.daily!.prog).toEqual({})
      expect(t.stat(a.id, STAT.days)).toBe(10)
    }
    expect(nextStreak(null, 100)).toBe(1)
  })

  it('자정을 넘기면 접속 중에도 새 날이 시작된다', () => {
    const t = make(Date.UTC(2026, 10, 26, 14, 58, 30))
    const a = t.join({ pid: 'device-night-01' })
    const p = t.player(a.id)
    forceQuests(t, a.id, ['d_pitch5', 'd_dance3', 'd_say5'])
    t.room.bump(p, STAT.talks, 2)
    expect(p.prog.daily!.prog.d_pitch5).toBe(2)
    // 오래 가만히 있으면 잠수로 내보내지므로 ping 을 보내며 시계를 돌린다
    for (let i = 0; i < 6; i++) {
      t.send(a.conn, { t: 'ping', c: 0 })
      t.advance(30_000)
    }
    expect(t.room.players.get(a.id)).toBe(p)
    const d = p.prog.daily!
    expect(d.day).toBe('2026-11-27')
    expect(d.streak).toBe(2)
    expect(d.prog).toEqual({})
    expect(d.quests).toEqual(pickDailyQuests('device-night-01', '2026-11-27'))
    expect(t.stat(a.id, STAT.days)).toBe(2)
    // 이틀 출석 업적
    expect(p.prog.ach).toContain('day2')
    expect(t.host.errors()).toEqual([])
  })

  it('자정 직후의 통계 증가는 분 단위 검사 전이라도 새 날에 센다', () => {
    const t = make(Date.UTC(2026, 10, 26, 14, 59, 50))
    const a = t.join({ pid: 'device-night-02' })
    const p = t.player(a.id)
    t.host.t = Date.UTC(2026, 10, 26, 15, 0, 5) // 틱 없이 시계만
    t.room.bump(p, STAT.talks, 1)
    expect(p.prog.daily!.day).toBe('2026-11-27')
    const q = p.prog.daily!.quests.find((id) => DAILY_QUEST_BY_ID.get(id)!.stat === STAT.talks)
    if (q) expect(p.prog.daily!.prog[q]).toBe(1)
  })
})

describe('업적', () => {
  it('문턱을 넘으면 정확히 한 번 달성된다', () => {
    const t = make()
    const a = t.join()
    const p = t.player(a.id)
    t.host.clear()
    t.room.bump(p, STAT.joins)
    expect(p.prog.ach).toContain('first_join')
    const rewards = t.host.of(a.conn, 'reward').filter((r) => r.ach?.includes('first_join'))
    expect(rewards).toHaveLength(1)
    expect(rewards[0]!.inf).toBe(ACHIEVEMENTS.find((x) => x.id === 'first_join')!.inf)
    t.room.bump(p, STAT.joins)
    t.room.bump(p, STAT.joins, 8)
    expect(t.host.of(a.conn, 'reward').filter((r) => r.ach?.includes('first_join'))).toHaveLength(1)
    // '신도 N명' 업적은 얻은 신도 누계(folTotal)를 본다
    expect(p.prog.ach).not.toContain('fol10')
    t.room.bump(p, STAT.folTotal, 10)
    expect(p.prog.ach).toContain('fol10')
    expect(p.prog.ach).not.toContain('fol50')
    // 한 번에 여러 문턱을 넘으면 각각 달성
    t.room.bump(p, STAT.folTotal, 500)
    expect(p.prog.ach).toEqual(expect.arrayContaining(['fol50', 'fol200']))
    expect(p.prog.ach.filter((x) => x === 'fol10')).toHaveLength(1)
  })

  it('최고 기록(setStat)으로도 달성되고, 현재 값이 내려가도 취소되지 않는다', () => {
    const t = make()
    const a = t.join()
    const p = t.player(a.id)
    t.room.setStat(p, STAT.worstStreak, 5)
    expect(p.prog.ach).toContain('fail5')
    t.room.setStat(p, STAT.worstStreak, 0)
    expect(p.prog.ach).toContain('fail5')
  })

  it('입장 때 저장본 통계로 놓친 업적을 따라잡는다', () => {
    const t = make()
    const prog = newProgress('device-catch-01', T0)
    prog.stats[STAT.joins] = 12
    prog.fol = 12 // folTotal 이 없던 옛 저장본: 입장 때 prog.fol 로 채워진다
    prog.stats[STAT.rejects] = 10
    prog.ach = ['first_join']
    const a = t.join({ pid: 'device-catch-01', save: signed(t, prog) })
    const p = t.player(a.id)
    expect(p.prog.ach).toEqual(expect.arrayContaining(['first_join', 'fol10', 'reject10']))
    const got = t.host.of(a.conn, 'reward').flatMap((r) => r.ach ?? [])
    expect(got).not.toContain('first_join')
    expect(got).toEqual(expect.arrayContaining(['fol10', 'reject10']))
  })
})

describe('얻은 신도 누계(folTotal)', () => {
  it('포교·설교·기싸움 어느 길로 얻든 HUD 신도 수(prog.fol)와 업적 진행(folTotal)이 같다', () => {
    const t = make()
    const a = t.join()
    const p = t.player(a.id)
    // 포교 합류(1), 설교(3), 기싸움 승리(2) 를 grant 로 흉내 낸다(각 시스템은 room.grant 로 fol 을 준다)
    t.room.grant(p, { why: 'join', inf: 10, fol: 1 })
    t.room.grant(p, { why: 'sermon', inf: 25, fol: 3 })
    t.room.grant(p, { why: 'duel', inf: 20, fol: 2 })
    t.room.grant(p, { why: 'battle', inf: 30 }) // 신도 없는 보상은 세지 않는다
    expect(p.prog.fol).toBe(6)
    expect(p.prog.stats[STAT.folTotal]).toBe(6)
    t.room.grant(p, { why: 'sermon', fol: 4 })
    expect(p.prog.stats[STAT.folTotal]).toBe(p.prog.fol)
    expect(p.prog.ach).toContain('fol10')
  })

  it('옛 저장본은 normalizeProgress 에서 prog.fol 로 채운다(이미 더 크면 그대로)', () => {
    const old = { ...newProgress('device-old-0001', T0), fol: 57, stats: { joins: 40 } }
    expect(normalizeProgress(old, 'device-old-0001', T0)!.stats[STAT.folTotal]).toBe(57)
    const newer = { ...newProgress('device-old-0001', T0), fol: 57, stats: { folTotal: 60 } }
    expect(normalizeProgress(newer, 'device-old-0001', T0)!.stats[STAT.folTotal]).toBe(60)
    const empty = newProgress('device-old-0001', T0)
    expect(normalizeProgress(empty, 'device-old-0001', T0)!.stats[STAT.folTotal]).toBeUndefined()
  })
})

describe('일일 진행도', () => {
  it('오늘 생긴 증가량만 세고, n 에서 멈추며, 값이 내려간 것은 무시한다', () => {
    const t = make()
    const prog = newProgress('device-delta-01', T0)
    prog.stats[STAT.talks] = 100 // 어제까지 쌓인 값은 오늘 진행도가 아니다
    const a = t.join({ pid: 'device-delta-01', save: signed(t, prog) })
    const p = t.player(a.id)
    const d = forceQuests(t, a.id, ['d_pitch5', 'd_reject5', 'd_join2'])
    expect(d.prog.d_pitch5 ?? 0).toBe(0)
    t.room.bump(p, STAT.talks, 3)
    expect(d.prog.d_pitch5).toBe(3)
    t.room.bump(p, STAT.talks, 10)
    expect(d.prog.d_pitch5).toBe(5)
    // 통계가 초기화(감소)돼도 진행도는 줄지 않고, 그 뒤 증가분부터 다시 센다
    t.room.bump(p, STAT.rejects, 2)
    t.room.setStat(p, STAT.rejects, 0)
    expect(d.prog.d_reject5).toBe(2)
    t.room.bump(p, STAT.rejects, 1)
    expect(d.prog.d_reject5).toBe(3)
    // 상관없는 통계는 진행도에 영향 없음
    t.room.bump(p, STAT.dances, 4)
    expect(Object.keys(d.prog).sort()).toEqual(['d_pitch5', 'd_reject5'])
  })

  it('보상 받기 검증: 오늘 것 아님 / 미완료 / 중복 / 형식 오류', () => {
    const t = make()
    const a = t.join()
    const p = t.player(a.id)
    forceQuests(t, a.id, ['d_pitch5', 'd_dance3', 'd_say5'])
    const errs = () => t.host.of(a.conn, 'err').filter((e) => e.code === 'daily')
    const dailyRewards = () => t.host.of(a.conn, 'reward').filter((r) => r.why === 'daily')

    t.send(a.conn, { t: 'daily', q: 'd_join5' })
    t.advance(300)
    expect(errs()).toHaveLength(1)
    t.send(a.conn, { t: 'daily', q: 'd_pitch5' })
    t.advance(300)
    expect(errs()).toHaveLength(2)
    for (const bad of [123, null, '', 'x'.repeat(500), { a: 1 }]) {
      t.send(a.conn, { t: 'daily', q: bad })
      t.advance(300)
    }
    expect(dailyRewards()).toHaveLength(0)

    t.room.bump(p, STAT.talks, 5)
    const inf0 = p.prog.inf
    t.send(a.conn, { t: 'daily', q: 'd_pitch5' })
    expect(dailyRewards()).toHaveLength(1)
    expect(p.prog.inf).toBe(inf0 + DAILY_QUEST_BY_ID.get('d_pitch5')!.inf)
    expect(p.prog.daily!.done).toEqual(['d_pitch5'])
    t.advance(300)
    t.send(a.conn, { t: 'daily', q: 'd_pitch5' })
    t.advance(300)
    expect(dailyRewards()).toHaveLength(1)
    expect(errs().at(-1)!.msg).toContain('이미')
    // 안내 문구는 해요체
    for (const e of errs()) expect(e.msg).toMatch(/요\.$/)
    // 완료된 퀘스트는 더 세지 않는다
    t.room.bump(p, STAT.talks, 5)
    expect(p.prog.daily!.prog.d_pitch5).toBe(5)
    expect(t.host.errors()).toEqual([])
  })

  it('연타는 쿨타임으로 무시된다(보상은 한 번)', () => {
    const t = make()
    const a = t.join()
    const p = t.player(a.id)
    forceQuests(t, a.id, ['d_dance3', 'd_pitch5', 'd_say5'])
    t.room.bump(p, STAT.dances, 3)
    for (let i = 0; i < 5; i++) t.send(a.conn, { t: 'daily', q: 'd_dance3' })
    expect(t.host.of(a.conn, 'reward').filter((r) => r.why === 'daily')).toHaveLength(1)
  })

  it('모두 끝내면 보너스를 한 번만 준다', () => {
    const t = make()
    const a = t.join()
    const p = t.player(a.id)
    forceQuests(t, a.id, ['d_pitch5', 'd_dance3', 'd_say5'])
    t.room.bump(p, STAT.talks, 5)
    t.room.bump(p, STAT.dances, 3)
    t.room.bump(p, STAT.says, 5)
    const coins0 = p.prog.coins
    for (const q of ['d_pitch5', 'd_dance3', 'd_say5', 'd_say5', 'd_pitch5']) {
      t.send(a.conn, { t: 'daily', q })
      t.advance(300)
    }
    const daily = t.host.of(a.conn, 'reward').filter((r) => r.why === 'daily')
    expect(daily).toHaveLength(4)
    const bonus = daily.filter((r) => r.coins === DAILY_BONUS.coins)
    expect(bonus).toHaveLength(1)
    expect(bonus[0]!.inf).toBe(DAILY_BONUS.inf)
    expect(p.prog.coins).toBe(coins0 + DAILY_BONUS.coins)
  })

  it('대화 중 끊겨도 진행도는 저장본에 남고, 다시 들어와 보상을 받을 수 있다', () => {
    const t = make()
    const a = t.join({ pid: 'device-round-01' })
    const p = t.player(a.id)
    forceQuests(t, a.id, ['d_pitch5', 'd_dance3', 'd_say5'])
    t.room.bump(p, STAT.talks, 5)
    t.room.bump(p, STAT.dances, 1)
    const save = lastSave(t, a.conn)
    t.room.disconnect(a.conn)

    // normalizeProgress 를 거쳐도 daily 가 그대로
    const norm = normalizeProgress(JSON.parse(save.d), 'device-round-01', T0)!
    expect(norm.daily).toMatchObject({ day: '2026-11-26', quests: ['d_pitch5', 'd_dance3', 'd_say5'], prog: { d_pitch5: 5, d_dance3: 1 } })

    t.advance(5000)
    const b = t.join({ pid: 'device-round-01', save })
    expect(b.w.me.daily!.prog).toEqual({ d_pitch5: 5, d_dance3: 1 })
    t.send(b.conn, { t: 'daily', q: 'd_pitch5' })
    expect(t.host.of(b.conn, 'reward').filter((r) => r.why === 'daily')).toHaveLength(1)
    // 다시 들어온 직후의 증가도 제대로 센다(스냅숏이 저장본 값에서 시작)
    t.room.bump(t.player(b.id), STAT.dances, 1)
    expect(t.player(b.id).prog.daily!.prog.d_dance3).toBe(2)
  })

  it('손상된 daily 는 걸러지거나 새로 만들어진다', () => {
    expect(sanitizeDaily(null)).toBeNull()
    expect(sanitizeDaily({ day: 'tomorrow' })).toBeNull()
    const s = sanitizeDaily({ day: '2026-11-26', quests: ['d_pitch5', 'nope', 'd_pitch5', 7], prog: { d_pitch5: 999, nope: 3 }, done: ['nope', 'd_pitch5'], streak: -3, fortune: 1e9 })!
    expect(s).toEqual({ day: '2026-11-26', quests: ['d_pitch5'], prog: { d_pitch5: 5 }, done: ['d_pitch5'], streak: 1, fortune: 0 })

    const t = make()
    const prog = newProgress('device-broken-01', T0)
    ;(prog as unknown as { daily: unknown }).daily = { day: 12, quests: 'x' }
    const a = t.join({ pid: 'device-broken-01', save: signed(t, prog) })
    expect(a.w.me.daily!.day).toBe('2026-11-26')
    expect(a.w.me.daily!.quests).toHaveLength(DAILY_QUEST_COUNT)
    expect(t.host.errors()).toEqual([])
  })
})
