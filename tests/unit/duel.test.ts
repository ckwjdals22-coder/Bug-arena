import { describe, expect, it } from 'vitest'
import { MAX_ENTOURAGE, PITCH_COOLDOWN_MS } from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import { CAPTIONS, CAPTION_KEYS, CAPTION_MAX_LEN, pickCaption } from '../../shared/content/captions'
import { DUELS } from '../../shared/content/misc'
import type { DuelDef } from '../../shared/content/types'
import {
  DUEL_MS,
  FOL_DUEL_WIN,
  INF_DUEL_LOSE,
  INF_DUEL_WIN,
  POACHED_LINE,
  createDuelSystem,
} from '../../server/core/systems/duel'
import { R_NO, makeArch, setup } from './helpers'

type T = ReturnType<typeof setup>
/** resolvePitch: 라이벌 첫 라운드 [역포교?] 난수 */
const R_RIVAL = [0]

function makeRival(t: T, id: number): void {
  const n = t.npc(id)
  n.arch = makeArch({ id: 'rival', special: 'rival', base: 0.1 })
  n.role = 'rival'
}

/** 라이벌에게 포교 → 기싸움 시작. 시작 메시지와 정의를 돌려준다 */
function startDuel(t: T, who: { conn: number; id: number }, npcId: number) {
  makeRival(t, npcId)
  t.talk(who, npcId)
  t.pitch(who, npcId, R_RIVAL)
  const start = t.host.of(who.conn, 'duel').filter((m) => m.ph === 'start').at(-1)
  if (!start) throw new Error('기싸움이 시작되지 않음')
  const def = DUELS.find((d) => d.say === start.say) as DuelDef
  return { start, def }
}

const winIdx = (def: DuelDef): number => def.win[0]!
const loseIdx = (def: DuelDef): number => [0, 1, 2].find((i) => !def.win.includes(i))!

function follow(t: T, npcId: number, playerId: number, since: number): void {
  t.room.npcs.startFollow(t.npc(npcId), playerId, t.host.t + 60_000, since)
}

describe('기싸움: 시작(interceptPitch)', () => {
  it('rival 결과를 가로채 대화를 닫고 기싸움을 연다(pitchRes 는 코어가 한 번만 보낸다)', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    const b = t.join()
    t.host.clear()
    const { start, def } = startDuel(t, a, 3)
    expect(t.host.of(a.conn, 'pitchRes')).toHaveLength(1)
    expect(t.host.of(a.conn, 'pitchRes')[0]!.o).toBe('rival')
    expect(t.host.of(b.conn, 'pitchRes')).toHaveLength(1)
    expect(start).toMatchObject({ t: 'duel', ph: 'start', n: 3, say: def.say, choices: def.choices, until: t.host.t + DUEL_MS })
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 3, why: 'done' }])
    // 기싸움은 당사자에게만
    expect(t.host.of(b.conn, 'duel')).toEqual([])
    const p = t.player(a.id)
    expect(p.talk).toBeNull()
    const n = t.npc(3)
    expect(n.talker).toBe(a.id)
    expect(n.mode).toBe('listen')
    expect(t.stat(a.id, STAT.rivals)).toBe(1)
    // 코어의 거절 처리(remember/walkOff)는 일어나지 않았다
    expect(t.sim.called('walkOff')).toEqual([])
    expect(t.sim.called('remember')).toEqual([])
    // 코어가 포교 쿨타임은 그대로 건다
    expect(p.cd.get('pitch')).toBe(t.host.t + PITCH_COOLDOWN_MS)
  })

  it('rival 이 아닌 결과는 가로채지 않는다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    t.talk(a, 2)
    t.pitch(a, 2, R_NO)
    expect(t.host.of(a.conn, 'duel')).toEqual([])
    expect(t.sim.called('walkOff:2')).toHaveLength(1)
  })

  it('기싸움 중에 또 다른 라이벌을 만나면 가로채지 않고 코어가 거절로 처리한다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    startDuel(t, a, 3)
    t.advance(PITCH_COOLDOWN_MS + 100)
    makeRival(t, 5)
    t.talk(a, 5)
    t.pitch(a, 5, R_RIVAL)
    expect(t.host.of(a.conn, 'duel').filter((m) => m.ph === 'start')).toHaveLength(1)
    expect(t.sim.called('remember:5')).toHaveLength(1)
  })

  it('바로 직전과 같은 기싸움 문제는 연달아 나오지 않는다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    let last = ''
    for (let i = 0; i < 6; i++) {
      const { start, def } = startDuel(t, a, 1 + i)
      expect(start.say).not.toBe(last)
      last = start.say!
      t.send(a.conn, { t: 'duel', c: loseIdx(def) })
      t.advance(PITCH_COOLDOWN_MS + 100)
    }
  })
})

describe('기싸움: 결과', () => {
  it('이기면 라이벌이 신도가 되고 영향력 20, 신도 +2', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    const { def } = startDuel(t, a, 3)
    const fol = t.player(a.id).prog.fol
    t.host.clear()
    t.send(a.conn, { t: 'duel', c: winIdx(def) })
    expect(t.host.of(a.conn, 'duel')).toEqual([{ t: 'duel', ph: 'end', n: 3, win: true, text: def.winText }])
    expect(t.npc(3).owner).toBe(a.id)
    expect(t.npc(3).talker).toBe(0)
    const reward = t.host.of(a.conn, 'reward').find((r) => r.why === 'duel')
    expect(reward).toMatchObject({ inf: INF_DUEL_WIN, fol: FOL_DUEL_WIN })
    expect(t.player(a.id).prog.fol).toBe(fol + FOL_DUEL_WIN)
    expect(t.stat(a.id, STAT.rivalWins)).toBe(1)
    t.advance(100)
    expect(t.host.of(a.conn, 'npcSay').flatMap((m) => m.l)).toContainEqual([3, def.winText])
    // 끝난 뒤 다시 보내면 무시
    t.host.clear()
    t.send(a.conn, { t: 'duel', c: winIdx(def) })
    expect(t.host.of(a.conn, 'duel')).toEqual([])
    expect(t.stat(a.id, STAT.rivalWins)).toBe(1)
  })

  it('이길 때 수행원 정원이 차 있으면 가장 오래된 신도를 보내 준다', () => {
    const t = setup({ systems: [createDuelSystem], npcs: 12 })
    const a = t.join()
    for (let i = 0; i < MAX_ENTOURAGE; i++) follow(t, 4 + i, a.id, t.host.t - 1000 * (10 - i))
    const { def } = startDuel(t, a, 1)
    t.send(a.conn, { t: 'duel', c: winIdx(def) })
    expect(t.sim.called('release:')).toEqual(['release:4:expire'])
    expect(t.room.npcs.followersOf(a.id)).toHaveLength(MAX_ENTOURAGE)
    expect(t.npc(1).owner).toBe(a.id)
  })

  it('지면 신도가 없을 때는 라이벌만 떠나고 영향력 3', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    const { def } = startDuel(t, a, 3)
    t.host.clear()
    t.send(a.conn, { t: 'duel', c: loseIdx(def) })
    expect(t.host.of(a.conn, 'duel')).toEqual([{ t: 'duel', ph: 'end', n: 3, win: false, text: def.loseText }])
    expect(t.sim.called('release:')).toEqual([])
    expect(t.sim.called('remember:3')).toHaveLength(1)
    expect(t.sim.called('walkOff:3')).toHaveLength(1)
    expect(t.npc(3).owner).toBe(0)
    expect(t.npc(3).talker).toBe(0)
    expect(t.host.of(a.conn, 'reward').find((r) => r.why === 'duel')).toMatchObject({ inf: INF_DUEL_LOSE })
    expect(t.stat(a.id, STAT.rivalWins)).toBe(0)
  })

  it('지면 가장 오래된 신도 한 명이 라이벌 쪽으로 넘어간다(누적 신도 수는 그대로)', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    follow(t, 6, a.id, t.host.t - 1000)
    follow(t, 5, a.id, t.host.t - 5000)
    t.room.grant(t.player(a.id), { why: 'join', fol: 2 })
    const fol = t.player(a.id).prog.fol
    const { def } = startDuel(t, a, 3)
    t.send(a.conn, { t: 'duel', c: loseIdx(def) })
    expect(t.sim.called('release:')).toEqual(['release:5:poach'])
    expect(t.room.npcs.followersOf(a.id).map((n) => n.id)).toEqual([6])
    expect(t.player(a.id).prog.fol).toBe(fol)
    t.advance(100)
    const said = t.host.of(a.conn, 'npcSay').flatMap((m) => m.l)
    expect(said).toContainEqual([5, POACHED_LINE])
    expect(said).toContainEqual([3, def.loseText])
  })

  it('12초 안에 고르지 않으면 패배로 끝난다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    follow(t, 6, a.id, t.host.t - 1000)
    const { def } = startDuel(t, a, 3)
    t.advance(DUEL_MS - 500)
    expect(t.host.of(a.conn, 'duel').filter((m) => m.ph === 'end')).toEqual([])
    t.advance(1200)
    expect(t.host.of(a.conn, 'duel').filter((m) => m.ph === 'end')).toEqual([{ t: 'duel', ph: 'end', n: 3, win: false, text: def.loseText }])
    expect(t.sim.called('release:')).toEqual(['release:6:poach'])
    // 마감 뒤에 정답을 보내도 소용없다
    t.send(a.conn, { t: 'duel', c: winIdx(def) })
    expect(t.stat(a.id, STAT.rivalWins)).toBe(0)
  })

  it('잘못된 선택(범위 밖/정수 아님/문자열)은 거절하고 기싸움은 계속된다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    const { def } = startDuel(t, a, 3)
    t.host.clear()
    for (const c of [-1, 3, 99, 1.5, '1', null, Number.NaN]) t.send(a.conn, { t: 'duel', c })
    t.send(a.conn, { t: 'duel' })
    expect(t.host.of(a.conn, 'duel')).toEqual([])
    t.send(a.conn, { t: 'duel', c: winIdx(def) })
    expect(t.host.of(a.conn, 'duel')).toHaveLength(1)
    expect(t.stat(a.id, STAT.rivalWins)).toBe(1)
    expect(t.host.errors()).toEqual([])
  })

  it('기싸움이 없는데 보낸 선택은 무시한다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    t.send(a.conn, { t: 'duel', c: 0 })
    expect(t.host.of(a.conn, 'duel')).toEqual([])
    expect(t.player(a.id).prog.inf).toBe(0)
  })

  it('라이벌이 사라지면(교체) 벌칙 없이 무효로 끝난다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    follow(t, 6, a.id, t.host.t - 1000)
    const { def } = startDuel(t, a, 3)
    t.room.npcs.endListen(t.npc(3))
    t.send(a.conn, { t: 'duel', c: winIdx(def) })
    const end = t.host.of(a.conn, 'duel').filter((m) => m.ph === 'end')
    expect(end).toHaveLength(1)
    expect(end[0]!.win).toBe(false)
    expect(t.sim.called('release:')).toEqual([])
    expect(t.stat(a.id, STAT.rivalWins)).toBe(0)
  })

  it('기싸움 중 나가도 예외 없이 정리된다', () => {
    const t = setup({ systems: [createDuelSystem] })
    const a = t.join()
    const b = t.join()
    startDuel(t, a, 3)
    t.room.disconnect(a.conn)
    t.advance(DUEL_MS + 1000)
    expect(t.npc(3).talker).toBe(0)
    expect(t.host.errors()).toEqual([])
    // 남은 사람은 정상적으로 기싸움을 할 수 있다
    t.advance(PITCH_COOLDOWN_MS)
    const { def } = startDuel(t, b, 4)
    t.send(b.conn, { t: 'duel', c: winIdx(def) })
    expect(t.stat(b.id, STAT.rivalWins)).toBe(1)
  })
})

// ───────────────────────── 예능 자막 콘텐츠(클라이언트가 쓰는 shared 데이터) ─────────────────────────

describe('예능 자막 콘텐츠', () => {
  const all = CAPTION_KEYS.flatMap((k) => CAPTIONS[k].map((c) => ({ k, ...c })))

  it('모든 키에 자막이 6개 이상, 단계(min)별로도 3개 이상 있다', () => {
    expect(new Set(CAPTION_KEYS).size).toBe(Object.keys(CAPTIONS).length)
    for (const k of CAPTION_KEYS) {
      expect(CAPTIONS[k].length, k).toBeGreaterThanOrEqual(6)
      const tiers = new Map<number, number>()
      for (const c of CAPTIONS[k]) tiers.set(c.min ?? 0, (tiers.get(c.min ?? 0) ?? 0) + 1)
      for (const [tier, n] of tiers) expect(n, `${k} min=${tier}`).toBeGreaterThanOrEqual(3)
      // 스타일 세 가지가 골고루 섞인다
      expect(new Set(CAPTIONS[k].map((c) => c.style)).size, k).toBe(3)
    }
    expect([...new Set(CAPTIONS.failStreak.map((c) => c.min))].sort((a, b) => a! - b!)).toEqual([3, 5, 10])
    expect([...new Set(CAPTIONS.winStreak.map((c) => c.min))].sort((a, b) => a! - b!)).toEqual([3, 5])
    expect(CAPTIONS.bigEntourage.every((c) => c.min === 4)).toBe(true)
  })

  it("'{n}' 은 min 이 있는 항목에서만 쓰고, 숫자를 넣어도 28자 이내다", () => {
    for (const c of all) {
      if (c.text.includes('{n}')) expect(c.min, `${c.k}: ${c.text}`).toBeGreaterThan(0)
      expect(c.text.replace(/\{n\}/g, ''), c.text).not.toMatch(/[{}]/)
      expect(Array.from(c.text.split('{n}').join('999')).length, c.text).toBeLessThanOrEqual(CAPTION_MAX_LEN)
      expect(['gungseo', 'pop', 'whisper']).toContain(c.style)
    }
  })

  it('pickCaption: 가장 높은 단계를 고르고, 카운터에 따라 돌아가며, 숫자를 채운다', () => {
    const a = pickCaption('failStreak', 12, 0)!
    expect(CAPTIONS.failStreak.filter((c) => c.min === 10).map((c) => c.text.split('{n}').join('12'))).toContain(a.text)
    expect(pickCaption('failStreak', 2, 0)).toBeNull()
    expect(pickCaption('bigEntourage', 3, 0)).toBeNull()
    const seen = new Set([0, 1, 2, 3, 4, 5].map((i) => pickCaption('reject', 0, i)!.text))
    expect(seen.size).toBe(6)
    expect(pickCaption('winStreak', 4, 7)!.text).not.toContain('{n}')
  })

  it('금칙어(실존 종교·정치·브랜드·욕설·실제 권유 수법)가 없다', () => {
    const DENY = [
      '교회', '성당', '스님', '목사', '불교', '기독', '천주', '이슬람', '하나님', '예수', '부처', '대통령', '국회의원', '구원', '축복',
      '은혜', '예배', '헌금', '십일조', '아멘', '할렐루야', '성불', '전도사', '선교', '정당', '여당', '야당',
      '시발', '씨발', '병신', '존나', '새끼', '지랄', '미친', '등신', '찐따', '장애', '틀딱', '급식충', '잼민',
      '카톡', '인스타', '유튜브', '스타벅스', '네이버', '삼성', '애플', '아이폰',
      '연락처', '전화번호', '카페', '차 한잔', '따라오세요', '설문', '상담', '입금', '계좌', '후원', '돈', '액운', '저주', '불행', '병원',
    ]
    const hits = all.filter((c) => DENY.some((w) => c.text.includes(w))).map((c) => c.text)
    expect(hits).toEqual([])
  })

  it('시민이나 다른 플레이어를 깎아내리는 표현을 쓰지 않는다(놀림 대상은 교주 자신)', () => {
    const MOCK = ['멍청', '바보', '호구', '어리석', '속았', '넘어갔', '먹잇감', '낚였']
    expect(all.filter((c) => MOCK.some((w) => c.text.includes(w))).map((c) => c.text)).toEqual([])
  })
})
