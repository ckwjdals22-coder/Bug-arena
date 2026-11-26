/**
 * 1대1 포교 배틀(상호 동의, 제한 시간, 서버 채점)
 * [2단계 기능 담당이 구현할 파일] 지금은 아무 일도 하지 않는 자리표시다.
 */
import type { RoomSystem } from '../api'

export function createBattleSystem(): RoomSystem {
  return {
    name: 'battle',
    handles: ['battle'],
  }
}
