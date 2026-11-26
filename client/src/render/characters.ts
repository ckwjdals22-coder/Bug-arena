/** [캐릭터 렌더러 담당이 구현할 파일] 인스턴싱 기반 로우폴리 캐릭터 + 절차 애니메이션 */
import type { CharacterRendererApi, EngineApi } from '../core/contracts'

export function createCharacterRenderer(_engine: EngineApi): CharacterRendererApi {
  return {
    update() {},
    portrait(_look, size) {
      const c = document.createElement('canvas')
      c.width = c.height = size
      return c
    },
    dispose() {},
  }
}
