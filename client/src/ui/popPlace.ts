/**
 * 떠오르는 글자 묶음("신도 +1 / +25 영향력 / 🪙 +15")을 어디에 둘지 정하는 순수 계산(overlay.ts 가 매 프레임 부른다).
 *
 * 왜 따로 떼었나: 첫 신도를 얻는 순간은 이 게임에서 가장 중요한 장면인데, 그때 화면에는 결과 배너(아래),
 * HUD(위), 내 말풍선, 0.6초 뒤 NPC 의 대답 말풍선이 한꺼번에 몰린다. 예전에는 위·아래가 다 막히면 묶음을 통째로 지워
 * 1.4초짜리 글자가 0.7초 만에 사라졌다. 이제는 "절대 통째로 버리지 않는다"를 지키려고 갈 곳을 차례로 찾는다.
 *   1) 위로 비킨다(HUD 에 닿지 않을 만큼)  2) 아래로 비킨다(결과 배너 아래로 내려가도 된다, 화면 아래 조작부 위까지)
 *   3) 옆으로 비킨다(말풍선 옆, 위로 올릴 수 있는 만큼 올린 높이 / 제자리 / 아래로 내린 높이에서)
 *   4) 그래도 없으면 핵심 줄(첫 줄 "신도 +1")만 남기고 나머지 줄은 물러난다 → 첫 줄만으로 1)~3)을 다시 찾는다
 *   5) 그마저 없으면 첫 줄을 가장 덜 겹치는 자리에 둔다(지우지는 않는다)
 * 레이아웃을 읽지 않는다: 모든 상자는 호출하는 쪽이 어림한 숫자다. 단위는 화면 px, 상자는 [왼, 위, 오른, 아래].
 */

export interface PopLine {
  /** 비키기 전 가운데 x / 아랫변 y */
  x: number
  y: number
  w: number
  h: number
  /** 핵심 줄(묶음의 첫 줄): 자리가 정말 없을 때도 이 줄은 남긴다 */
  main: boolean
}

export interface PopArea {
  /** 글자 윗변이 이보다 위로 가면 HUD 를 덮는다 */
  top: number
  /** 글자 아랫변이 이보다 아래로 가면 화면 아래 조작부(조이스틱·상황 버튼)를 덮는다 */
  bottom: number
  left: number
  right: number
}

export interface PopPlace {
  /** 옆으로 옮길 양(px, +면 오른쪽) */
  dx: number
  /** 위로 옮길 양(px, +면 위로, -면 아래로) */
  dy: number
  /** 핵심 줄만 남겼는가 */
  trim: boolean
}

/** 폭은 글자 수로 어림한 값이라 가로로 이만큼 살짝 겹치는 것은 봐준다(overlay.ts 의 hitTop 과 같은 값) */
const SLACK_X = 4
/** 비킨 뒤 장애물과 띄우는 간격 */
const GAP = 3
const TRIES = 6

/** 줄 하나가 (dx, dy) 만큼 옮겼을 때 처음 부딪히는 상자의 시작 인덱스, 없으면 -1 */
function hit(m: PopLine, dx: number, dy: number, boxes: readonly number[]): number {
  const hw = m.w / 2
  const x0 = m.x + dx - hw
  const x1 = m.x + dx + hw
  const y1 = m.y - dy
  const y0 = y1 - m.h
  for (let i = 0; i < boxes.length; i += 4) {
    if (x1 - SLACK_X <= boxes[i]! || x0 + SLACK_X >= boxes[i + 2]! || y1 <= boxes[i + 1]! || y0 >= boxes[i + 3]!) continue
    return i
  }
  return -1
}

/** 겹치는 넓이의 합(마지막 수단에서 가장 덜 겹치는 자리를 고를 때) */
function overlapArea(lines: readonly PopLine[], dx: number, dy: number, boxes: readonly number[]): number {
  let sum = 0
  for (const m of lines) {
    const hw = m.w / 2
    const x0 = m.x + dx - hw
    const x1 = m.x + dx + hw
    const y1 = m.y - dy
    const y0 = y1 - m.h
    for (let i = 0; i < boxes.length; i += 4) {
      const w = Math.min(x1, boxes[i + 2]!) - Math.max(x0, boxes[i]!)
      const hh = Math.min(y1, boxes[i + 3]!) - Math.max(y0, boxes[i + 1]!)
      if (w > 0 && hh > 0) sum += w * hh
    }
  }
  return sum
}

function inside(lines: readonly PopLine[], dx: number, dy: number, area: PopArea): boolean {
  for (const m of lines) {
    const hw = m.w / 2
    if (m.y - dy - m.h < area.top || m.y - dy > area.bottom) return false
    if (m.x + dx - hw < area.left || m.x + dx + hw > area.right) return false
  }
  return true
}

function fits(lines: readonly PopLine[], dx: number, dy: number, boxes: readonly number[], area: PopArea): boolean {
  if (!inside(lines, dx, dy, area)) return false
  for (const m of lines) if (hit(m, dx, dy, boxes) >= 0) return false
  return true
}

/** 세로로만 밀어 본다: dir=+1 위로, -1 아래로. 부딪히는 상자를 넘어설 때까지 */
function pushY(lines: readonly PopLine[], dx: number, dir: 1 | -1, boxes: readonly number[]): number {
  let dy = 0
  for (let k = 0; k < TRIES; k++) {
    let moved = false
    for (const m of lines) {
      const i = hit(m, dx, dy, boxes)
      if (i < 0) continue
      // 위로: 줄의 아랫변을 상자 윗변 위로 / 아래로: 줄의 윗변을 상자 아랫변 아래로
      dy = dir > 0 ? m.y - boxes[i + 1]! + GAP : -(boxes[i + 3]! - (m.y - m.h) + GAP)
      moved = true
    }
    if (!moved) break
  }
  return dy
}

/** 가로로만 밀어 본다: dir=+1 오른쪽, -1 왼쪽 */
function pushX(lines: readonly PopLine[], dy: number, dir: 1 | -1, boxes: readonly number[]): number {
  let dx = 0
  for (let k = 0; k < TRIES; k++) {
    let moved = false
    for (const m of lines) {
      const i = hit(m, dx, dy, boxes)
      if (i < 0) continue
      const hw = m.w / 2
      const next = dir > 0 ? boxes[i + 2]! - SLACK_X - (m.x - hw) + GAP : boxes[i]! + SLACK_X - (m.x + hw) - GAP
      // 반대 방향으로 되돌아가지는 않는다(왼쪽 상자를 피하려다 오른쪽 상자로 다시 들어가는 왕복 방지)
      if (dir > 0 ? next <= dx : next >= dx) continue
      dx = next
      moved = true
    }
    if (!moved) break
  }
  return dx
}

/** 이 줄들만으로 겹치지 않는 자리를 찾는다. 없으면 null */
function search(lines: readonly PopLine[], boxes: readonly number[], area: PopArea, prev: PopPlace | null): { dx: number; dy: number } | null {
  if (lines.length === 0) return { dx: 0, dy: 0 }
  // 지난 프레임의 자리가 아직 괜찮으면 그대로 둔다(묶음이 이쪽저쪽으로 흔들리지 않게)
  if (prev && fits(lines, prev.dx, prev.dy, boxes, area)) return { dx: prev.dx, dy: prev.dy }
  const up = pushY(lines, 0, 1, boxes)
  if (fits(lines, 0, up, boxes, area)) return { dx: 0, dy: up }
  const down = pushY(lines, 0, -1, boxes)
  if (fits(lines, 0, down, boxes, area)) return { dx: 0, dy: down }
  // 옆으로: HUD 바로 아래까지 올린 높이(말풍선보다 위 줄에서 옆), 제자리, 아래로 내린 높이에서 좌우를 본다
  let top = Infinity
  let bottom = -Infinity
  for (const m of lines) {
    top = Math.min(top, m.y - m.h)
    bottom = Math.max(bottom, m.y)
  }
  const maxUp = Math.max(0, top - area.top)
  const maxDown = Math.max(0, area.bottom - bottom)
  const heights = [0, Math.min(Math.max(up, 0), maxUp), maxUp, -Math.min(Math.max(-down, 0), maxDown)]
  let best: { dx: number; dy: number } | null = null
  let bestCost = Infinity
  for (const dy of heights) {
    if (!inside(lines, 0, dy, { ...area, left: -Infinity, right: Infinity })) continue
    for (const dir of [1, -1] as const) {
      const dx = pushX(lines, dy, dir, boxes)
      if (!fits(lines, dx, dy, boxes, area)) continue
      // 가까운 자리일수록 좋다(세로로 옮기는 것이 가로보다 눈에 덜 튄다)
      const cost = Math.abs(dx) + Math.abs(dy) * 0.6
      if (cost < bestCost) {
        bestCost = cost
        best = { dx, dy }
      }
    }
  }
  return best
}

/**
 * 묶음의 자리. boxes = 피해야 할 상자들(말풍선, 내 이름표, 먼저 자리 잡은 글자, 결과 배너).
 * prev = 지난 프레임의 결과(있으면 그 자리를 먼저 본다). 한 번 핵심 줄만 남긴 묶음은 다시 늘어나지 않는다(깜빡이지 않게).
 * 늘 숫자를 돌려준다: 묶음을 통째로 지우는 일은 없다.
 */
export function placePopGroup(lines: readonly PopLine[], boxes: readonly number[], area: PopArea, prev: PopPlace | null = null): PopPlace {
  if (!prev?.trim) {
    const all = search(lines, boxes, area, prev)
    if (all) return { ...all, trim: false }
  }
  const main = lines.filter((m) => m.main)
  const one = main.length > 0 ? main : lines.slice(0, 1)
  const solo = search(one, boxes, area, prev?.trim ? prev : null)
  if (solo) return { ...solo, trim: true }
  // 마지막 수단: 화면 안의 후보 중 가장 덜 겹치는 자리(제자리, 위로 올린 자리, 아래로 내린 자리)
  const cands = [
    { dx: 0, dy: 0 },
    { dx: 0, dy: pushY(one, 0, 1, boxes) },
    { dx: 0, dy: pushY(one, 0, -1, boxes) },
  ].filter((c) => inside(one, c.dx, c.dy, area))
  let pick = { dx: 0, dy: 0 }
  let least = Infinity
  for (const c of cands) {
    const a = overlapArea(one, c.dx, c.dy, boxes)
    if (a < least) {
      least = a
      pick = c
    }
  }
  return { ...pick, trim: true }
}
