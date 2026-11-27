/**
 * 직급 사다리: 문턱, 카탈로그에서 만든 잠금 해제 안내, 최고 직급 뒤의 회차(칭호만).
 */
import { describe, expect, it } from 'vitest'
import {
  ACCESSORIES,
  AURAS,
  EMOTES,
  FACES,
  HATS,
  MAX_RANK,
  OUTFITS,
  PRESTIGE_STEP,
  RANKS,
  nextPrestigeInf,
  prestigeOf,
  rankForInfluence,
  rankTitle,
  rankUnlockText,
} from '../../shared/content/core'
import { PITCH_LINES } from '../../shared/content/lines'
import { WORLD } from '../../shared/world/data'
import { rankLabel } from '../../client/src/share/data'

describe('직급 문턱', () => {
  it('30 / 200 / 800 / 2500 / 8000', () => {
    expect(RANKS.map((r) => r.inf)).toEqual([0, 30, 200, 800, 2500, 8000])
    expect(MAX_RANK).toBe(5)
    expect(rankForInfluence(29)).toBe(0)
    expect(rankForInfluence(30)).toBe(1)
    expect(rankForInfluence(799)).toBe(2)
    expect(rankForInfluence(800)).toBe(3)
    expect(rankForInfluence(7999)).toBe(4)
    expect(rankForInfluence(1e9)).toBe(5)
  })
})

describe('잠금 해제 안내는 카탈로그에서 만든다', () => {
  const catalogs = [EMOTES, OUTFITS, HATS, FACES, ACCESSORIES, AURAS] as const
  for (let r = 1; r <= MAX_RANK; r++) {
    it(`직급 ${r}: 그 직급에서 열리는 항목 이름을 모두 말한다`, () => {
      const text = RANKS[r]!.unlock
      expect(text).toBe(rankUnlockText(r))
      const missing: string[] = []
      for (const list of catalogs) {
        for (const item of list as readonly { name: string; rank: number; ach?: string }[]) {
          if (item.rank === r && !item.ach && !text.includes(item.name)) missing.push(item.name)
        }
      }
      expect(missing).toEqual([])
      const lines = PITCH_LINES.filter((l) => l.rank === r).length
      if (lines > 0) expect(text).toContain(`새 멘트 ${lines}개`)
      expect(text.includes('비밀 교단 건물')).toBe(WORLD.hq.minRank === r)
      // 다른 직급의 항목은 말하지 않는다
      for (const list of catalogs) {
        for (const item of list as readonly { name: string; rank: number; id: number | string }[]) {
          if (item.rank !== r && item.rank > 0 && item.name !== '없음' && text.split(/[(),·]\s*/).includes(item.name)) missing.push(`다른 직급: ${item.name}`)
        }
      }
      expect(missing).toEqual([])
    })
  }
  it('직급 0 은 개수로 요약한다', () => {
    const text = RANKS[0]!.unlock
    expect(text).toContain(`기본 동작 ${EMOTES.filter((e) => e.rank === 0).length}가지`)
    expect(text).toContain(`멘트 ${PITCH_LINES.filter((l) => l.rank === 0).length}개`)
  })
})

describe('최고 직급 뒤의 회차', () => {
  it('prestigeOf = 1 + floor((inf − 8000) / 5000), 8000 미만은 0', () => {
    expect(PRESTIGE_STEP).toBe(5000)
    expect(prestigeOf(0)).toBe(0)
    expect(prestigeOf(7999)).toBe(0)
    expect(prestigeOf(8000)).toBe(1)
    expect(prestigeOf(12_999)).toBe(1)
    expect(prestigeOf(13_000)).toBe(2)
    expect(prestigeOf(58_000)).toBe(11)
    expect(nextPrestigeInf(5000)).toBe(8000)
    expect(nextPrestigeInf(8000)).toBe(13_000)
    expect(nextPrestigeInf(14_000)).toBe(18_000)
  })
  it('표시 이름: 최고 직급에서만 회차가 붙는다(HUD 와 공유 카드가 같은 함수를 쓴다)', () => {
    expect(rankTitle(5, 8000)).toBe('우주급 절대교주 1회차')
    expect(rankTitle(5, 23_500)).toBe('우주급 절대교주 4회차')
    expect(rankTitle(4, 9000)).toBe('대교주')
    expect(rankTitle(0, 0)).toBe('수상한 행인')
    expect(rankLabel({ rank: 5, inf: 13_000 })).toBe('우주급 절대교주 2회차')
    expect(rankLabel({ rank: 2, inf: 300 })).toBe(RANKS[2]!.name)
  })
})
