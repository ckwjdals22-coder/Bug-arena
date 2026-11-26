/** [클라이언트 코어 담당이 구현할 파일] 키보드/마우스/터치 조이스틱 입력 */
import type { InputApi } from '../core/contracts'

export function createInput(_canvas: HTMLCanvasElement, _uiRoot: HTMLElement): InputApi {
  return {
    moveX: 0,
    moveY: 0,
    run: false,
    consumeCamera: () => ({ yaw: 0, pitch: 0, zoom: 0 }),
    consumeTap: () => null,
    update() {},
  }
}
