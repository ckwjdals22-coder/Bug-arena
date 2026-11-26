/** [효과음 담당이 구현할 파일] WebAudio 합성 효과음(음원 파일 없음) */
import type { SfxApi } from '../core/contracts'

export function createSfx(): SfxApi {
  return { unlock() {}, play() {}, setEnabled() {}, setMusic() {} }
}
