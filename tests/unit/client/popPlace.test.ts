import { describe, expect, it } from 'vitest'
import { placePopGroup, type PopArea, type PopLine } from '../../../client/src/ui/popPlace'

/** 아이폰 13 세로(390×664), HUD 아래 90px, 아래 조작부 위 544px */
const AREA: PopArea = { top: 90, bottom: 544, left: 4, right: 386 }

/** 첫 신도 순간의 묶음: 신도 +1 / +25 영향력 / 🪙 +15 (아래 줄부터 34px 간격) */
function group(x: number, y: number): PopLine[] {
  return [
    { x, y, w: 92, h: 28, main: true },
    { x, y: y - 34, w: 96, h: 28, main: false },
    { x, y: y - 68, w: 60, h: 28, main: false },
  ]
}

function overlaps(lines: readonly PopLine[], dx: number, dy: number, boxes: readonly number[]): boolean {
  for (const m of lines) {
    const x0 = m.x + dx - m.w / 2 + 4
    const x1 = m.x + dx + m.w / 2 - 4
    const y1 = m.y - dy
    const y0 = y1 - m.h
    for (let i = 0; i < boxes.length; i += 4) {
      if (x1 > boxes[i]! && x0 < boxes[i + 2]! && y1 > boxes[i + 1]! && y0 < boxes[i + 3]!) return true
    }
  }
  return false
}

describe('보상 글자 묶음 자리(placePopGroup)', () => {
  it('막힌 것이 없으면 제자리', () => {
    expect(placePopGroup(group(195, 260), [], AREA)).toEqual({ dx: 0, dy: 0, trim: false })
  })

  it('말풍선 하나에 걸리면 위로 비킨다', () => {
    const bubble = [110, 200, 280, 258]
    const g = group(195, 330)
    const p = placePopGroup(g, bubble, AREA)
    expect(p.trim).toBe(false)
    expect(p.dx).toBe(0)
    expect(p.dy).toBeGreaterThan(0)
    expect(overlaps(g, p.dx, p.dy, bubble)).toBe(false)
  })

  it('위(HUD)도 아래(결과 배너)도 막히면 지우지 않고 말풍선 옆으로 비킨다 — 첫 신도 순간의 재현', () => {
    // 첫 신도 순간(390px 세로): 내 말풍선, NPC 대답 말풍선, 내 이름표, 결과 배너가 가운데 세로로 몰려 있다
    const boxes = [
      105, 225, 285, 283, // 내 말풍선
      135, 95, 315, 153, // NPC 대답 말풍선(위)
      150, 160, 330, 218, // NPC 말풍선(가운데)
      109, 283, 281, 310, // 내 이름표
      17, 388, 373, 472, // 결과 배너
    ]
    const g = group(195, 250)
    const p = placePopGroup(g, boxes, AREA)
    expect(Number.isNaN(p.dx) || Number.isNaN(p.dy)).toBe(false)
    expect(p.trim).toBe(false)
    expect(p.dx).not.toBe(0)
    expect(overlaps(g, p.dx, p.dy, boxes)).toBe(false)
    // 화면 안, HUD 아래
    for (const m of g) {
      expect(m.x + p.dx - m.w / 2).toBeGreaterThanOrEqual(AREA.left)
      expect(m.x + p.dx + m.w / 2).toBeLessThanOrEqual(AREA.right)
      expect(m.y - p.dy - m.h).toBeGreaterThanOrEqual(AREA.top)
    }
  })

  it('옆에도 자리가 없으면 핵심 줄("신도 +1")만 남기고, 그 줄은 겹치지 않는 자리에 둔다', () => {
    // 가운데 넓은 말풍선 기둥과 아래 결과 배너: 세 줄 묶음은 어디에도 안 들어가지만 한 줄은 들어간다
    const boxes = [
      40, 90, 350, 230, // 위쪽 말풍선들
      40, 262, 350, 470, // 이름표·결과 배너
    ]
    const g = group(195, 250)
    const p = placePopGroup(g, boxes, AREA)
    expect(p.trim).toBe(true)
    expect(overlaps([g[0]!], p.dx, p.dy, boxes)).toBe(false)
  })

  it('정말 둘 곳이 없어도 숫자를 돌려준다(묶음을 지우지 않는다)', () => {
    const boxes = [0, 0, 390, 664]
    const p = placePopGroup(group(195, 250), boxes, AREA)
    expect(p.trim).toBe(true)
    expect(Number.isFinite(p.dx) && Number.isFinite(p.dy)).toBe(true)
  })

  it('지난 프레임의 자리가 아직 괜찮으면 그대로 둔다(흔들리지 않게)', () => {
    const g = group(195, 250)
    const prev = { dx: -120, dy: 10, trim: false }
    expect(placePopGroup(g, [], AREA, prev)).toEqual(prev)
  })

  it('한 번 핵심 줄만 남긴 묶음은 자리가 생겨도 다시 늘어나지 않는다(깜빡이지 않게)', () => {
    const g = group(195, 250)
    const p = placePopGroup(g, [], AREA, { dx: 0, dy: 0, trim: true })
    expect(p.trim).toBe(true)
  })
})
