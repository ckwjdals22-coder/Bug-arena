/** [캐릭터 렌더러 담당이 구현할 파일] 파티클 이펙트 */
import type { EngineApi, FxApi } from '../core/contracts'

export function createFx(_engine: EngineApi): FxApi {
  return { burst() {}, update() {}, dispose() {} }
}
