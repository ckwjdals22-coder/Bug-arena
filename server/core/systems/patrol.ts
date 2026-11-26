/**
 * 구청 단속반 순찰/추격 이벤트
 * [2단계 기능 담당이 구현할 파일] 지금은 아무 일도 하지 않는 자리표시다.
 */
import type { RoomSystem } from '../api'

export function createPatrolSystem(): RoomSystem {
  return {
    name: 'patrol',
    handles: [],
  }
}
