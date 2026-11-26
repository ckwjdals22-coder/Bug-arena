/**
 * 교단 창설/탈퇴, 플레이어 초대(수락·거절·쿨타임·차단), 신고, 교단 순위표
 * [2단계 기능 담당이 구현할 파일] 지금은 아무 일도 하지 않는 자리표시다.
 */
import type { RoomSystem } from '../api'

export function createCultSystem(): RoomSystem {
  return {
    name: 'cult',
    handles: ['cultCreate', 'cultLeave', 'invite', 'inviteAns', 'block', 'report', 'cults'],
  }
}
