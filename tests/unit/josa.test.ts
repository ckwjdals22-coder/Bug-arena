import { describe, expect, it } from 'vitest'
import { josaOf, withJosa } from '../../shared/rules/josa'

describe('조사 붙이기', () => {
  it('받침 유무에 따라 을/를, 이/가, 은/는', () => {
    expect(withJosa('라면교', '을')).toBe('라면교를')
    expect(withJosa('사람들', '을')).toBe('사람들을')
    expect(withJosa('교단', '이')).toBe('교단이')
    expect(withJosa('교주', '은')).toBe('교주는')
  })
  it("'으로' 는 ㄹ 받침이면 '로'", () => {
    expect(withJosa('대교주', '으로')).toBe('대교주로')
    expect(withJosa('길거리 전도사', '으로')).toBe('길거리 전도사로')
    expect(withJosa('신흥 교단장', '으로')).toBe('신흥 교단장으로')
    expect(withJosa('달', '으로')).toBe('달로')
  })
  it('한글이 아니면 둘 다 적는다', () => {
    expect(josaOf('ABC', '을')).toBe('을(를)')
    expect(josaOf('7', '으로')).toBe('(으)로')
  })
})
