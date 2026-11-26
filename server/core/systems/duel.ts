/**
 * 라이벌 교주 기싸움(outcome=rival 가로채기)
 * [2단계 기능 담당이 구현할 파일] 지금은 아무 일도 하지 않는 자리표시다.
 */
import type { RoomSystem } from '../api'

export function createDuelSystem(): RoomSystem {
  return {
    name: 'duel',
    handles: ['duel'],
  }
}
