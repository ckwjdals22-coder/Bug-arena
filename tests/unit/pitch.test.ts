/**
 * 포교 판정 규칙(shared/rules/pitch.ts) 단위 테스트.
 * 확률 식의 각 항, 특수 분기(라이벌·전생의 왕·더 들어볼게요), 멘트 고르기, 그리고 현재 콘텐츠 기준 체감 성공률을 본다.
 */
import { describe, expect, it } from 'vitest'
import { LINES_PER_TALK, MAX_TALK_ROUNDS } from '../../shared/constants'
import { ARCHETYPES } from '../../shared/content/archetypes'
import { PITCH_LINES } from '../../shared/content/lines'
import type { Archetype, PitchCategory, PitchLine } from '../../shared/content/types'
import { mulberry32, pickWeighted } from '../../shared/rng'
import {
  JOIN_CHANCE_MAX,
  JOIN_CHANCE_MIN,
  type PitchContext,
  joinChance,
  pickLines,
  resolvePitch,
} from '../../shared/rules/pitch'

const ctx = (over: Partial<PitchContext> = {}): PitchContext => ({
  rank: 0,
  streak: 0,
  failStreak: 0,
  round: 1,
  buff: 0,
  poach: false,
  ...over,
})

function arch(over: Partial<Archetype> = {}): Archetype {
  return {
    id: 'test',
    name: '시험용 시민',
    desc: '',
    names: ['아무개'],
    weight: 1,
    base: 0.3,
    like: {},
    flee: 0,
    ignore: 0,
    curious: 0,
    speed: 1,
    look: { outfits: [0], hats: [0], colors: [0], faces: [0], accs: [0] },
    greet: ['네?'],
    re: { join: ['합류'], more: ['더'], no: ['거절'], flee: ['도망'], ignore: ['무시'] },
    mutter: [],
    follow: [],
    leave: [],
    ...over,
  }
}

const line = (cat: PitchCategory = 'dao', power = 0, fleeBias?: number): PitchLine => ({
  id: 0,
  text: '시험용 멘트',
  cat,
  rank: 0,
  power,
  ...(fleeBias === undefined ? {} : { fleeBias }),
})

/** 정해 둔 값을 차례로 돌려주는 가짜 난수(다 쓰면 마지막 값을 계속 준다) */
function seq(...values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]!
}

describe('joinChance', () => {
  it('기본값 + 소재 취향 + 멘트 보정', () => {
    expect(joinChance(arch({ base: 0.3 }), line('dao', 0), ctx())).toBeCloseTo(0.3, 10)
    expect(joinChance(arch({ base: 0.3 }), line('dao', 0.05), ctx())).toBeCloseTo(0.35, 10)
    const a = arch({ base: 0.3, like: { past: 0.15, time: -0.25 } })
    expect(joinChance(a, line('past'), ctx())).toBeCloseTo(0.45, 10)
    expect(joinChance(a, line('time'), ctx())).toBeCloseTo(0.05, 10)
    // 취향에 없는 소재는 영향 없음
    expect(joinChance(a, line('cosmic'), ctx())).toBeCloseTo(0.3, 10)
  })

  it('4% ~ 92% 로 자른다', () => {
    expect(JOIN_CHANCE_MIN).toBe(0.04)
    expect(JOIN_CHANCE_MAX).toBe(0.92)
    expect(joinChance(arch({ base: -1 }), line(), ctx())).toBe(JOIN_CHANCE_MIN)
    expect(joinChance(arch({ base: 0.02 }), line('dao', -0.15), ctx({ poach: true }))).toBe(JOIN_CHANCE_MIN)
    expect(joinChance(arch({ base: 5 }), line(), ctx())).toBe(JOIN_CHANCE_MAX)
    expect(joinChance(arch({ base: 0.9 }), line('dao', 0.2), ctx({ rank: 5, round: 2, buff: 0.2 }))).toBe(JOIN_CHANCE_MAX)
    // 어떤 조합이든 범위 안
    const rnd = mulberry32(1)
    for (let i = 0; i < 2000; i++) {
      const c = joinChance(
        arch({ base: rnd() * 2 - 0.5, like: { dao: rnd() - 0.5 } }),
        line('dao', rnd() * 0.4 - 0.2),
        ctx({ rank: Math.floor(rnd() * 6), streak: Math.floor(rnd() * 20), failStreak: Math.floor(rnd() * 20), round: 1 + Math.floor(rnd() * 2), buff: rnd() * 0.3, poach: rnd() < 0.5 }),
      )
      expect(c).toBeGreaterThanOrEqual(JOIN_CHANCE_MIN)
      expect(c).toBeLessThanOrEqual(JOIN_CHANCE_MAX)
    }
  })

  it('직급은 단계당 2%', () => {
    const a = arch({ base: 0.3 })
    for (let rank = 0; rank <= 5; rank++) expect(joinChance(a, line(), ctx({ rank }))).toBeCloseTo(0.3 + rank * 0.02, 10)
  })

  it('연속 성공은 회당 1%, 5회까지만', () => {
    const a = arch({ base: 0.3 })
    expect(joinChance(a, line(), ctx({ streak: 3 }))).toBeCloseTo(0.33, 10)
    expect(joinChance(a, line(), ctx({ streak: 5 }))).toBeCloseTo(0.35, 10)
    expect(joinChance(a, line(), ctx({ streak: 50 }))).toBeCloseTo(0.35, 10)
  })

  it('연속 실패 동정표는 회당 3.5%, 8회까지만', () => {
    const a = arch({ base: 0.2 })
    expect(joinChance(a, line(), ctx({ failStreak: 1 }))).toBeCloseTo(0.235, 10)
    expect(joinChance(a, line(), ctx({ failStreak: 4 }))).toBeCloseTo(0.34, 10)
    expect(joinChance(a, line(), ctx({ failStreak: 8 }))).toBeCloseTo(0.48, 10)
    expect(joinChance(a, line(), ctx({ failStreak: 30 }))).toBeCloseTo(0.48, 10)
    // 실패가 쌓일수록 줄어들지 않는다
    let prev = 0
    for (let f = 0; f <= 12; f++) {
      const c = joinChance(a, line(), ctx({ failStreak: f }))
      expect(c).toBeGreaterThanOrEqual(prev)
      prev = c
    }
  })

  it("2라운드('더 들어볼게요' 뒤)는 +25%", () => {
    const a = arch({ base: 0.3 })
    expect(joinChance(a, line(), ctx({ round: 2 })) - joinChance(a, line(), ctx({ round: 1 }))).toBeCloseTo(0.25, 10)
    expect(joinChance(a, line(), ctx({ round: 3 }))).toBeCloseTo(0.55, 10)
  })

  it('버프는 그대로 더하고, 남의 신도 빼앗기는 −20%', () => {
    const a = arch({ base: 0.3 })
    expect(joinChance(a, line(), ctx({ buff: 0.12 }))).toBeCloseTo(0.42, 10)
    expect(joinChance(a, line(), ctx({ poach: true }))).toBeCloseTo(0.1, 10)
    expect(joinChance(a, line(), ctx({ poach: true, buff: 0.2, rank: 2 }))).toBeCloseTo(0.34, 10)
  })
})

describe('resolvePitch', () => {
  it('난수가 합류 확률보다 작으면 join, 계산된 확률을 함께 돌려준다', () => {
    const a = arch({ base: 0.3 })
    const ok = resolvePitch(a, line(), ctx(), seq(0.29, 0))
    expect(ok.outcome).toBe('join')
    expect(ok.say).toBe('합류')
    expect(ok.chance).toBeCloseTo(0.3, 10)
    expect(resolvePitch(a, line(), ctx(), seq(0.31, 0.99)).outcome).toBe('no')
  })

  it('실패 분기 순서: 더 들어볼게요 → 도망 → 무시 → 거절', () => {
    const a = arch({ base: 0.1, curious: 0.5, flee: 0.4, ignore: 0.3 })
    // [합류 판정, curious, flee, ignore, 대사 고르기…]
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.49, 0)).outcome).toBe('more')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.51, 0.39, 0)).outcome).toBe('flee')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.51, 0.41, 0.29, 0)).outcome).toBe('ignore')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.51, 0.41, 0.31, 0)).outcome).toBe('no')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.49, 0)).say).toBe('더')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.51, 0.39, 0)).say).toBe('도망')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.51, 0.41, 0.29, 0)).say).toBe('무시')
    expect(resolvePitch(a, line(), ctx(), seq(0.9, 0.51, 0.41, 0.31, 0)).say).toBe('거절')
  })

  it("마지막 라운드와 동물에게는 '더 들어볼게요'가 없다", () => {
    const curious = arch({ base: 0.04, curious: 1 })
    const rnd = mulberry32(3)
    let more1 = 0
    for (let i = 0; i < 300; i++) {
      if (resolvePitch(curious, line(), ctx({ round: 1 }), rnd).outcome === 'more') more1++
      expect(resolvePitch(curious, line(), ctx({ round: MAX_TALK_ROUNDS }), rnd).outcome).not.toBe('more')
      expect(resolvePitch(arch({ base: 0.04, curious: 1, special: 'animal' }), line(), ctx(), rnd).outcome).not.toBe('more')
    }
    expect(more1).toBeGreaterThan(250)
  })

  it('멘트의 fleeBias 만큼 도망 확률이 오른다(최대 95%)', () => {
    const a = arch({ base: 0.04, flee: 0.1 })
    const count = (l: PitchLine): number => {
      const rnd = mulberry32(9)
      let n = 0
      for (let i = 0; i < 4000; i++) if (resolvePitch(a, l, ctx(), rnd).outcome === 'flee') n++
      return n / 4000
    }
    const plain = count(line('time', -0.2))
    const pushy = count(line('time', -0.2, 0.4))
    const absurd = count(line('time', -0.2, 5))
    // 합류(4%)를 뺀 나머지 96% 중에서 flee 확률만큼
    expect(plain).toBeGreaterThan(0.96 * 0.1 - 0.03)
    expect(plain).toBeLessThan(0.96 * 0.1 + 0.03)
    expect(pushy).toBeGreaterThan(0.96 * 0.5 - 0.04)
    expect(pushy).toBeLessThan(0.96 * 0.5 + 0.04)
    expect(absurd).toBeGreaterThan(0.96 * 0.95 - 0.03)
    expect(absurd).toBeLessThan(0.96 * 0.95 + 0.02)
  })

  it('라이벌 교주: 첫 라운드에 70% 확률로 역포교(rival), 2라운드에는 없다', () => {
    const rival = arch({ base: 0.05, special: 'rival', re: { join: ['졌습니다'], no: ['저도 사실 교주입니다.'] } })
    expect(resolvePitch(rival, line(), ctx(), seq(0.69, 0)).outcome).toBe('rival')
    expect(resolvePitch(rival, line(), ctx(), seq(0.69, 0)).say).toBe('저도 사실 교주입니다.')
    // 70% 를 넘기면 보통 판정으로: [rival 판정, 합류 판정, …]
    expect(resolvePitch(rival, line(), ctx(), seq(0.71, 0.01, 0)).outcome).toBe('join')
    expect(resolvePitch(rival, line(), ctx(), seq(0.71, 0.99)).outcome).toBe('no')
    // 2라운드에는 rival 분기를 거치지 않는다: 첫 난수가 곧 합류 판정
    expect(resolvePitch(rival, line(), ctx({ round: 2 }), seq(0.01, 0)).outcome).toBe('join')
    const rnd = mulberry32(5)
    let n = 0
    for (let i = 0; i < 4000; i++) {
      if (resolvePitch(rival, line(), ctx(), rnd).outcome === 'rival') n++
      expect(resolvePitch(rival, line(), ctx({ round: 2 }), rnd).outcome).not.toBe('rival')
    }
    expect(n / 4000).toBeGreaterThan(0.66)
    expect(n / 4000).toBeLessThan(0.74)
    // 다른 유형은 rival 이 나오지 않는다
    for (let i = 0; i < 500; i++) expect(resolvePitch(arch(), line(), ctx(), rnd).outcome).not.toBe('rival')
  })

  it('전생의 왕: royal 유형 + 전생 멘트로 합류하면 절반은 king', () => {
    const royal = arch({ base: 0.9, special: 'royal' })
    expect(resolvePitch(royal, line('past'), ctx(), seq(0.1, 0.49)).outcome).toBe('king')
    expect(resolvePitch(royal, line('past'), ctx(), seq(0.1, 0.49)).say).toBe('혹시 전생에 제가 왕이었나요?')
    expect(resolvePitch(royal, line('past'), ctx(), seq(0.1, 0.51, 0)).outcome).toBe('join')
    // 합류에 실패하면 king 도 없다
    expect(resolvePitch(royal, line('past'), ctx(), seq(0.95, 0.99)).outcome).toBe('no')
    const rnd = mulberry32(8)
    let king = 0
    let join = 0
    for (let i = 0; i < 4000; i++) {
      const o = resolvePitch(royal, line('past'), ctx(), rnd).outcome
      if (o === 'king') king++
      if (o === 'join') join++
      // 전생 멘트가 아니거나 royal 이 아니면 king 은 없다
      expect(resolvePitch(royal, line('dao'), ctx(), rnd).outcome).not.toBe('king')
      expect(resolvePitch(arch({ base: 0.9 }), line('past'), ctx(), rnd).outcome).not.toBe('king')
    }
    expect(king / (king + join)).toBeGreaterThan(0.45)
    expect(king / (king + join)).toBeLessThan(0.55)
  })

  it('소재 전용 반응(catRe)을 우선 쓰고, 대사가 없으면 거절 대사나 "…"로 대신한다', () => {
    const a = arch({ base: 0.04, re: { no: ['기본 거절'] }, catRe: { time: { no: ['1분이라면서요?'] } } })
    // [합류 실패, curious(0 이라 실패), flee 실패, ignore 실패, catRe 사용(<0.75), 고르기]
    expect(resolvePitch(a, line('time'), ctx(), seq(0.9, 0.9, 0.9, 0.9, 0.5, 0)).say).toBe('1분이라면서요?')
    expect(resolvePitch(a, line('time'), ctx(), seq(0.9, 0.9, 0.9, 0.9, 0.8, 0)).say).toBe('기본 거절')
    expect(resolvePitch(a, line('dao'), ctx(), seq(0.9, 0.9, 0.9, 0.9, 0)).say).toBe('기본 거절')
    // join 대사가 없는 유형이 합류하면 거절 대사로라도 말한다
    expect(resolvePitch(arch({ base: 0.9, re: { no: ['어…'] } }), line(), ctx(), seq(0.1, 0)).say).toBe('어…')
    expect(resolvePitch(arch({ base: 0.9, re: {} }), line(), ctx(), seq(0.1, 0)).say).toBe('…')
  })

  it('실제 콘텐츠의 모든 유형×멘트 조합에서 빈 대사가 나오지 않는다', () => {
    const rnd = mulberry32(77)
    const outcomes = new Set<string>()
    for (const a of ARCHETYPES) {
      for (const l of PITCH_LINES) {
        for (let i = 0; i < 60; i++) {
          const r = resolvePitch(a, l, ctx({ round: 1 + (i % 2), failStreak: i % 9 }), rnd)
          expect(typeof r.say).toBe('string')
          expect(r.say.length).toBeGreaterThan(0)
          expect(r.chance).toBeGreaterThanOrEqual(JOIN_CHANCE_MIN)
          expect(r.chance).toBeLessThanOrEqual(JOIN_CHANCE_MAX)
          outcomes.add(r.outcome)
        }
      }
    }
    for (const o of ['join', 'more', 'no', 'flee', 'ignore']) expect(outcomes.has(o)).toBe(true)
  })
})

describe('pickLines', () => {
  it('서로 다른 멘트를 count 개 고르고, 될 수 있으면 소재가 겹치지 않는다', () => {
    const rnd = mulberry32(21)
    const pool0 = PITCH_LINES.filter((l) => l.rank <= 0)
    const cats0 = new Set(pool0.map((l) => l.cat)).size
    for (let i = 0; i < 300; i++) {
      const ids = pickLines(0, rnd)
      expect(ids.length).toBe(Math.min(LINES_PER_TALK, pool0.length))
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) {
        expect(PITCH_LINES[id]!.id).toBe(id)
        expect(PITCH_LINES[id]!.rank).toBe(0)
      }
      expect(new Set(ids.map((id) => PITCH_LINES[id]!.cat)).size).toBe(Math.min(ids.length, cats0))
    }
  })

  it('직급보다 높은 멘트는 주지 않고, 직급이 오르면 고를 수 있는 폭이 넓어진다', () => {
    const rnd = mulberry32(22)
    for (let rank = 0; rank <= 5; rank++) {
      const seen = new Set<number>()
      for (let i = 0; i < 800; i++) {
        for (const id of pickLines(rank, rnd)) {
          expect(PITCH_LINES[id]!.rank).toBeLessThanOrEqual(rank)
          seen.add(id)
        }
      }
      // 충분히 뽑으면 해금된 멘트가 전부 한 번은 나온다
      expect(seen.size).toBe(PITCH_LINES.filter((l) => l.rank <= rank).length)
    }
  })

  it('exclude 에 든 멘트는 다시 주지 않는다(2라운드)', () => {
    const rnd = mulberry32(23)
    for (let i = 0; i < 200; i++) {
      const first = pickLines(0, rnd)
      const second = pickLines(0, rnd, LINES_PER_TALK, first)
      expect(new Set(second).size).toBe(second.length)
      for (const id of second) expect(first).not.toContain(id)
      const left = PITCH_LINES.filter((l) => l.rank <= 0 && !first.includes(l.id)).length
      expect(second.length).toBe(Math.min(LINES_PER_TALK, left))
    }
  })

  it('count 를 바꿀 수 있고, 남은 멘트보다 많이 달라고 하면 있는 만큼만 준다', () => {
    const rnd = mulberry32(24)
    expect(pickLines(0, rnd, 2).length).toBe(2)
    expect(pickLines(0, rnd, 0)).toEqual([])
    const all = PITCH_LINES.filter((l) => l.rank <= 0).map((l) => l.id)
    const many = pickLines(0, rnd, 999)
    expect(many.slice().sort((a, b) => a - b)).toEqual(all)
    expect(pickLines(0, rnd, 4, all)).toEqual([])
    // 직급이 음수면 해금된 멘트가 없다
    expect(pickLines(-1, rnd)).toEqual([])
  })

  it('같은 시드면 같은 결과', () => {
    expect(pickLines(0, mulberry32(5))).toEqual(pickLines(0, mulberry32(5)))
  })
})

describe('체감 성공률(몬테카를로)', () => {
  /**
   * 직급 0 플레이어가 길에서 만나는 순서대로(가중치 추첨) 말을 걸고, 제시된 멘트 중 아무거나 고른다고 가정한다.
   * '더 들어볼게요'가 나오면 2라운드까지 간다. 연속 성공/실패 보정은 방(Room)과 같은 방식으로 갱신한다.
   */
  function simulate(seed: number, talks: number): { join: number; flee: number; more: number; rival: number } {
    const rnd = mulberry32(seed)
    let streak = 0
    let failStreak = 0
    let join = 0
    let flee = 0
    let more = 0
    let rival = 0
    for (let i = 0; i < talks; i++) {
      const a = pickWeighted(ARCHETYPES, (x) => x.weight, rnd)
      let round = 1
      let used: number[] = []
      for (;;) {
        const offered = pickLines(0, rnd, LINES_PER_TALK, used)
        if (offered.length === 0) break
        const l = PITCH_LINES[offered[Math.floor(rnd() * offered.length) % offered.length]!]!
        const r = resolvePitch(a, l, { rank: 0, streak, failStreak, round, buff: 0, poach: false }, rnd)
        if (r.outcome === 'more') {
          more++
          round++
          used = used.concat(l.id)
          continue
        }
        if (r.outcome === 'join' || r.outcome === 'king') {
          join++
          streak++
          failStreak = 0
        } else {
          if (r.outcome === 'flee') flee++
          if (r.outcome === 'rival') rival++
          streak = 0
          failStreak++
        }
        break
      }
    }
    return { join, flee, more, rival }
  }

  it('직급 0 의 전체 합류율은 25% ~ 60% 사이다', () => {
    const talks = 40_000
    const r = simulate(2025, talks)
    const rate = r.join / talks
    console.log(
      `[pitch 몬테카를로] 직급 0 · 대화 ${talks}회: 합류 ${(rate * 100).toFixed(1)}% · 도망 ${((r.flee / talks) * 100).toFixed(1)}% · 더 들어볼게요 ${((r.more / talks) * 100).toFixed(1)}% · 라이벌 ${((r.rival / talks) * 100).toFixed(1)}%`,
    )
    expect(rate).toBeGreaterThan(0.25)
    expect(rate).toBeLessThan(0.6)
    // 시드가 달라도 비슷해야 한다(표본이 충분하다)
    const other = simulate(7, talks).join / talks
    expect(Math.abs(other - rate)).toBeLessThan(0.02)
  })

  it('동정표 덕분에 운이 나빠도 끝없이 실패하지는 않는다', () => {
    // 콘텐츠와 무관하게 규칙만 본다: 기본 10% 짜리 까다로운 시민에게 10번 연달아 말을 걸 때,
    // 실패가 쌓일수록 확률이 오르므로(회당 3.5%) 10번 안에 한 번은 성공할 가능성이 훨씬 높아진다
    const hard = arch({ base: 0.1 })
    const within10 = (pity: boolean, seed: number): number => {
      const rnd = mulberry32(seed)
      const trials = 4000
      let ok = 0
      for (let t = 0; t < trials; t++) {
        let failStreak = 0
        for (let i = 0; i < 10; i++) {
          const o = resolvePitch(hard, line(), ctx({ failStreak: pity ? failStreak : 0 }), rnd).outcome
          if (o === 'join') {
            ok++
            break
          }
          failStreak++
        }
      }
      return ok / trials
    }
    const withPity = within10(true, 31)
    const withoutPity = within10(false, 31)
    // 이론값: 동정표 없음 1 − 0.9^10 ≈ 65%, 있음 ≈ 93%
    expect(withoutPity).toBeGreaterThan(0.6)
    expect(withoutPity).toBeLessThan(0.7)
    expect(withPity).toBeGreaterThan(0.9)
    expect(withPity).toBeLessThan(0.96)
  })
})
