/** [UI 담당이 구현할 파일] 이름표/말풍선/뜨는 글자 (DOM 오버레이) */
import type { Bus } from '../core/bus'
import type { EngineApi, OverlayApi } from '../core/contracts'
import type { Store } from '../core/store'

export function createOverlay(_root: HTMLElement, _store: Store, _bus: Bus, _engine: EngineApi): OverlayApi {
  return { update() {}, bubble() {}, pop() {} }
}
