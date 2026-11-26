/**
 * 황당한 업적 / 일일 수행. stat 은 shared/content/core.ts 의 STAT 키.
 * [콘텐츠 작성자가 확장할 파일] 지금은 최소 예시만 들어 있다.
 */
import type { AchievementDef, DailyQuestDef } from './types'

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_join', name: '첫 신도', desc: '첫 번째 신도를 얻었다. 왜 따라오는지는 본인도 모른다.', icon: '🐣', stat: 'joins', gte: 1, inf: 5 },
  { id: 'fail10', name: '철벽 앞의 수행자', desc: '포교 10번 연속 실패', icon: '🧱', stat: 'worstStreak', gte: 10, inf: 20 },
  { id: 'reject100', name: '거절 수집가', desc: 'NPC에게 거절당한 횟수 100회', icon: '🙅', stat: 'rejects', gte: 100, inf: 50 },
  { id: 'king3', name: '왕실 전문가', desc: '전생의 왕 3명 발견', icon: '👑', stat: 'kings', gte: 3, inf: 30 },
  { id: 'fol50', name: '중견 교단', desc: '신도 50명 확보', icon: '🏛️', stat: 'joins', gte: 50, inf: 60 },
]

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))

export const DAILY_QUESTS: readonly DailyQuestDef[] = [
  { id: 'd_pitch5', text: '시민 5명에게 말 걸기', stat: 'talks', n: 5, inf: 15 },
  { id: 'd_join2', text: '신도 2명 모으기', stat: 'joins', n: 2, inf: 20 },
  { id: 'd_dance3', text: '신비로운 춤 3번 추기', stat: 'dances', n: 3, inf: 10 },
]

export const DAILY_QUEST_BY_ID: ReadonlyMap<string, DailyQuestDef> = new Map(DAILY_QUESTS.map((q) => [q.id, q]))

/** 하루에 뽑히는 수행 개수 */
export const DAILY_QUEST_COUNT = 3
