/**
 * 두 손가락이 거의 동시에 닿았는데 서로 멀리 떨어져 있을 때, 이것이 핀치(확대/축소)인지
 * 양손 엄지 조작(왼손 조이스틱 + 오른손 시점)인지를 '처음 몇 픽셀의 움직임'으로 가른다.
 * 축소 핀치는 손가락을 벌린 채로 시작하므로 시작 거리만으로는 양손 엄지와 구별할 수 없다.
 * DOM 과 상관없는 순수 함수라 단위 테스트로 확인한다(tests/unit/client/pinch.test.ts).
 */

export interface TrackPt {
  startX: number
  startY: number
  lastX: number
  lastY: number
}

/** 어느 한 손가락이 이만큼 움직이기 전에는 판단하지 않는다(손 떨림) */
export const PINCH_DECIDE_PX = 8
/** 두 손가락 모두 선을 따라 이만큼은 움직여야 핀치로 본다 */
export const PINCH_ALONG_MIN_PX = 4
/**
 * 한 손가락만 이만큼 움직이고 다른 손가락은 그대로면 핀치가 아니다(걷기 또는 시점 돌리기).
 * 판단을 시간이 아니라 움직인 거리로 끝내는 이유: 조이스틱은 움직여야만 걷게 하므로, 묶어 두는 것은 '처음 몇 픽셀'뿐이다.
 * 시간 제한을 두면 느린 기기(프레임이 늦게 오는 폰)에서 두 번째 움직임이 오기도 전에 판단이 끝나 핀치가 걷기가 된다.
 */
export const PINCH_DECIDE_MAX_PX = 24
/**
 * 선을 '따라' 움직였다고 볼 각도: 가로지르는 성분이 선 방향 성분의 이 비율 이하(약 27도 안).
 * 대각선으로 미는 조이스틱(예: 왼쪽 위로 걷기)까지 핀치로 오인하지 않게 좁게 잡는다
 */
export const PINCH_ALIGN = 0.5
/** 이보다 멀리 떨어져 닿은 두 손가락은 한 손 핀치가 아니라 양손 엄지다(가로 화면의 양손 엄지는 500px 안팎) */
export const PINCH_FAR_MAX_PX = 420

export type PinchVerdict = 'pinch' | 'not' | 'wait'

/**
 * a, b: 두 손가락(시작점과 지금 위치).
 * - 두 손가락이 둘을 잇는 선을 따라 서로 반대쪽으로(모이거나 벌어지게) 움직였다 → 'pinch'
 * - 어느 손가락이든 선에서 비스듬히(PINCH_ALIGN 밖으로) 움직였다(조이스틱을 위나 대각선으로 미는 엄지 등) → 'not'
 * - 둘이 같은 쪽으로 움직였거나, 한 손가락만 한참 움직였다 → 'not'
 * - 아직 움직임이 작다 → 'wait'
 * 한계: 왼손 엄지가 오른쪽(상대 손가락 쪽)으로 밀면서 오른손이 왼쪽으로 끄는 동작은 모양이 축소 핀치와 똑같아 핀치로 본다.
 * 두 손가락이 0.25초 안에 함께 닿고 조이스틱이 아직 안 움직였을 때만 이 판단을 하므로, 이미 걷던 엄지에는 해당하지 않는다.
 */
export function classifyPinch(a: TrackPt, b: TrackPt): PinchVerdict {
  let ux = b.startX - a.startX
  let uy = b.startY - a.startY
  const ul = Math.hypot(ux, uy)
  if (ul < 1) return 'not'
  ux /= ul
  uy /= ul
  const dax = a.lastX - a.startX
  const day = a.lastY - a.startY
  const dbx = b.lastX - b.startX
  const dby = b.lastY - b.startY
  const ma = Math.hypot(dax, day)
  const mb = Math.hypot(dbx, dby)
  if (Math.max(ma, mb) < PINCH_DECIDE_PX) return 'wait'
  // 선 방향 성분(부호 있음)과 가로지르는 성분(크기)
  const aa = dax * ux + day * uy
  const ab = dbx * ux + dby * uy
  const pa = Math.abs(dax * uy - day * ux)
  const pb = Math.abs(dbx * uy - dby * ux)
  const skewA = pa > Math.abs(aa) * PINCH_ALIGN
  const skewB = pb > Math.abs(ab) * PINCH_ALIGN
  if ((ma >= PINCH_DECIDE_PX && skewA) || (mb >= PINCH_DECIDE_PX && skewB)) return 'not'
  if (Math.min(Math.abs(aa), Math.abs(ab)) >= PINCH_ALONG_MIN_PX) {
    if (aa * ab > 0) return 'not'
    // 아직 조금밖에 안 움직인 손가락이 비스듬하면 핀치라고 단정하지 않고 조금 더 본다(대각선으로 미는 조이스틱)
    if (skewA || skewB) return Math.max(ma, mb) >= PINCH_DECIDE_MAX_PX ? 'not' : 'wait'
    return 'pinch'
  }
  if (Math.max(ma, mb) >= PINCH_DECIDE_MAX_PX) return 'not'
  return 'wait'
}
