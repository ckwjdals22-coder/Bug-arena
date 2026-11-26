/**
 * 기능 시스템 등록부. Room 은 생성 시 이 목록의 시스템을 순서대로 만든다.
 */
import type { RoomSystemFactory } from '../api'
import { createAchievementsSystem } from './achievements'
import { createBattleSystem } from './battle'
import { createCultSystem } from './cult'
import { createDuelSystem } from './duel'
import { createOfferingSystem } from './offering'
import { createPatrolSystem } from './patrol'
import { createPodiumSystem } from './podium'

export const DEFAULT_SYSTEMS: readonly RoomSystemFactory[] = [
  createAchievementsSystem,
  createCultSystem,
  createPodiumSystem,
  createBattleSystem,
  createOfferingSystem,
  createDuelSystem,
  createPatrolSystem,
]
