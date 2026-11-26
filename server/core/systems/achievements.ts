/**
 * 황당한 업적 판정, 일일 수행/출석
 * [2단계 기능 담당이 구현할 파일] 지금은 아무 일도 하지 않는 자리표시다.
 */
import type { RoomSystem } from '../api'

export function createAchievementsSystem(): RoomSystem {
  return {
    name: 'achievements',
    handles: ['daily'],
  }
}
