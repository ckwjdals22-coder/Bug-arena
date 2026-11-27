import { describe, expect, it } from 'vitest'
import { classifyPinch, type TrackPt } from '../../../client/src/input/pinch'
import { GHOST_CLICK_MS, isGhostClick } from '../../../client/src/ui/kit'

const pt = (sx: number, sy: number, dx: number, dy: number): TrackPt => ({ startX: sx, startY: sy, lastX: sx + dx, lastY: sy + dy })

describe('멀리 떨어져 닿은 두 손가락: 핀치인가 양손 엄지인가', () => {
  it('선을 따라 서로 모이면(축소 핀치) 시작 거리와 상관없이 핀치다', () => {
    for (const sep of [180, 240, 300]) {
      expect(classifyPinch(pt(100, 400, 8, 0), pt(100 + sep, 400, -8, 0))).toBe('pinch')
      // 비스듬한 두 손가락
      expect(classifyPinch(pt(100, 400, 6, -6), pt(100 + sep, 400 - sep, -6, 6))).toBe('pinch')
    }
  })
  it('선을 따라 서로 벌어지면(확대 핀치) 핀치다', () => {
    expect(classifyPinch(pt(100, 400, -9, 1), pt(320, 420, 9, 0))).toBe('pinch')
  })
  it('움직임이 아직 작으면 기다린다', () => {
    expect(classifyPinch(pt(100, 400, 3, 0), pt(300, 400, -3, 0))).toBe('wait')
  })
  it('왼손 엄지가 조이스틱을 위로 밀고 오른손이 옆으로 끌면 핀치가 아니다', () => {
    expect(classifyPinch(pt(70, 500, 0, -12), pt(300, 500, 8, 0))).toBe('not')
    expect(classifyPinch(pt(70, 500, 2, -9), pt(300, 500, 0, 0))).toBe('not')
  })
  it('오른손만 옆으로 끌고 왼손은 가만히 있으면(시점 돌리기) 핀치가 아니다', () => {
    expect(classifyPinch(pt(70, 500, 0, 0), pt(300, 500, 12, 0))).toBe('wait')
    expect(classifyPinch(pt(70, 500, 1, 0), pt(300, 500, 26, 0))).toBe('not')
  })
  it('두 손가락이 같은 쪽으로 움직이면 핀치가 아니다', () => {
    expect(classifyPinch(pt(70, 500, 10, 0), pt(300, 500, 10, 0))).toBe('not')
  })
})

describe('터치 누름 뒤의 유령 click', () => {
  const g = { at: 1000, x: 300, y: 600 }
  it('누른 자리로 곧바로 오는 click 은 버린다', () => {
    expect(isGhostClick(g, 1010, 1, 302, 598)).toBe(true)
  })
  it('키보드가 만든 click(detail 0)은 통과', () => {
    expect(isGhostClick(g, 1010, 0, 0, 0)).toBe(false)
  })
  it('다른 자리, 시간이 지난 click 은 통과', () => {
    expect(isGhostClick(g, 1010, 1, 100, 600)).toBe(false)
    expect(isGhostClick(g, 1000 + GHOST_CLICK_MS + 1, 1, 300, 600)).toBe(false)
    expect(isGhostClick(null, 1010, 1, 300, 600)).toBe(false)
  })
})

describe('대각선 조이스틱', () => {
  it('왼손 엄지를 왼쪽 위(45도)로 밀고 오른손을 옆으로 끌면 핀치가 아니다', () => {
    expect(classifyPinch(pt(70, 500, -7, -7), pt(300, 500, 8, 0))).toBe('not')
    // 조이스틱 손가락이 아직 덜 움직였어도(5.7px) 핀치로 단정하지 않는다
    expect(classifyPinch(pt(70, 500, -4, -4), pt(300, 500, 8, 0))).toBe('wait')
  })
  it('조금 비스듬한(20도 안쪽) 핀치는 핀치다', () => {
    expect(classifyPinch(pt(70, 500, 9, 3), pt(300, 500, -9, -2))).toBe('pinch')
  })
})
