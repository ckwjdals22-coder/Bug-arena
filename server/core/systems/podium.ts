/**
 * 단상 — 오늘의 계시, 집단 설교 이벤트
 * [2단계 기능 담당이 구현할 파일] 지금은 아무 일도 하지 않는 자리표시다.
 */
import type { RoomSystem } from '../api'

export function createPodiumSystem(): RoomSystem {
  return {
    name: 'podium',
    handles: ['prophecy', 'sermon'],
  }
}
