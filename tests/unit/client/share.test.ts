/**
 * 공유 카드 문구 고르기(순수 함수) 테스트: 결산 차이 계산, 교주 유형 판정, 임명장 특이사항, 발급번호.
 */
import { describe, expect, it } from 'vitest'
import { CERT_TITLES, VERDICTS, certTitle, issueNo, judge, selfRoast, sessionDiff, successRate } from '../../../client/src/share/data'

const S = (o: Record<string, number> = {}, worst = 0) => sessionDiff({}, o, worst, 10)

describe('sessionDiff', () => {
  it('세션 시작과 지금의 차이를 센다', () => {
    const s = sessionDiff({ talks: 5, joins: 2, rejects: 3 }, { talks: 12, joins: 4, rejects: 9, flees: 2 }, 4, 7.9)
    expect(s).toMatchObject({ talks: 7, joins: 2, rejects: 6, flees: 2, worstFail: 4, minutes: 7 })
  })
  it('저장본이 바뀌어 값이 줄어도 음수가 되지 않는다', () => {
    const s = sessionDiff({ talks: 50 }, { talks: 3 }, -2, -1)
    expect(s.talks).toBe(0)
    expect(s.worstFail).toBe(0)
    expect(s.minutes).toBe(0)
  })
})

describe('judge (교주 유형)', () => {
  it('유형이 10개 이상이고 id 가 겹치지 않는다', () => {
    expect(VERDICTS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(VERDICTS.map((v) => v.id)).size).toBe(VERDICTS.length)
  })
  it('아무에게도 말을 안 걸면 산책 수행형', () => {
    expect(judge(S()).id).toBe('walker')
  })
  it('거절이 많고 신도가 거의 없으면 철벽 수집가형', () => {
    expect(judge(S({ talks: 15, rejects: 12, joins: 1 })).id).toBe('wall')
  })
  it('도망이 많으면 인간 비상벨형', () => {
    expect(judge(S({ talks: 8, rejects: 8, flees: 6 })).id).toBe('alarm')
  })
  it('말을 걸었지만 신도 0명이면 무소유형', () => {
    expect(judge(S({ talks: 3, rejects: 2 })).id).toBe('empty')
  })
  it('성공률이 60% 이상이면 말발 천재형(자칭)', () => {
    const s = S({ talks: 8, joins: 5, rejects: 2 })
    expect(successRate(s)).toBeGreaterThanOrEqual(0.6)
    expect(judge(s).id).toBe('genius')
  })
  it('춤을 말보다 많이 추면 춤바람 교주형', () => {
    expect(judge(S({ talks: 2, dances: 20, rejects: 2 })).id).toBe('dancer')
  })
  it('연속 실패가 길면 불굴의 헛발질형', () => {
    expect(judge(S({ talks: 9, rejects: 8, joins: 2 }, 7)).id).toBe('unbreakable')
  })
  it('모든 유형 문구는 비어 있지 않고 한 줄 길이 안이다', () => {
    for (const v of VERDICTS) {
      expect(v.name.length).toBeGreaterThan(1)
      expect(v.roast.length).toBeLessThanOrEqual(40)
      expect(v.comfort.length).toBeLessThanOrEqual(34)
    }
  })
})

describe('selfRoast / certTitle / issueNo', () => {
  it('통계가 없으면 신중함을 놀린다', () => {
    expect(selfRoast({})).toContain('신중함')
  })
  it('가장 굴욕적인 통계를 고른다', () => {
    expect(selfRoast({ rejects: 37 })).toBe('거절 37회를 견딘 근성')
    expect(selfRoast({ rejects: 5, kings: 3 })).toBe('전생의 왕 3명 발굴')
  })
  it('직급별 제목, 범위 밖 값도 안전', () => {
    expect(CERT_TITLES).toHaveLength(6)
    expect(certTitle(0)).toBe('수상한 행인 확인서')
    expect(certTitle(5)).toBe('우주급 절대교주 임명장')
    expect(certTitle(99)).toBe(certTitle(5))
    expect(certTitle(-3)).toBe(certTitle(0))
  })
  it('발급번호 형식', () => {
    expect(issueNo(0xabcdef12, { y: 2026, m: 3, d: 7 })).toBe('2026-0307-EF12')
  })
})
