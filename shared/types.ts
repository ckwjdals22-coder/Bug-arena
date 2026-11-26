/**
 * 클라이언트/서버 공용 데이터 타입.
 */

/**
 * 캐릭터 외형. 네트워크로 짧게 보내기 위해 튜플로 쓴다.
 * 각 숫자는 shared/content/cosmetics.ts 카탈로그의 id(=배열 인덱스).
 */
export type Look = [skin: number, outfit: number, color: number, hat: number, face: number, acc: number, aura: number]

export const LOOK_LEN = 7

/** 플레이어에게 붙는 교단 표시 정보 */
export interface CultRef {
  /** 교단 고유 id (창설자 기준으로 서버가 발급) */
  id: string
  name: string
  /** CULT_COLORS 인덱스 */
  color: number
  /** CULT_EMBLEMS 인덱스 */
  emblem: number
  role: 'leader' | 'member'
  /** 교주 칭호(leader) — 멤버에게는 교주의 칭호가 아니라 '신도' 같은 표시용 문구가 들어간다 */
  title: string
  /** 교주 닉네임(초대 카드/임명장 표시용) */
  leaderName: string
}

/** 방 안의 다른 사람에게 공개되는 플레이어 정보 */
export interface PlayerPublic {
  id: number
  name: string
  look: Look
  /** 0..5 (RANKS 인덱스) */
  rank: number
  /** 누적 신도 수 */
  fol: number
  cult: CultRef | null
  x: number
  z: number
  yaw: number
  /** Anim */
  st: number
  /** 현재 반복 재생 중인 이모트 id (없으면 null) */
  emote: string | null
}

/** NPC 모델 종류 */
export enum NpcModel {
  Human = 0,
  Cat = 1,
  Pigeon = 2,
}

/** 방 안 NPC의 공개 정보 */
export interface NpcPublic {
  /** 1..255, 방 안에서 유일. 같은 id로 새 npcSpawn 이 오면 '새 시민으로 교체'를 뜻한다 */
  id: number
  /** Archetype.id */
  arch: string
  /** 표시 이름 (예: '퇴근길 김대리') */
  name: string
  look: Look
  model: number
  x: number
  z: number
  yaw: number
  st: number
  /** 따라다니는 대상 플레이어 id (없으면 0) */
  owner: number
  /** 특수 역할: 단속반, 라이벌 교주 등. 없으면 '' */
  role: string
}

export interface RoomInfo {
  id: string
  name: string
  /** 실제 접속자 수(NPC 제외) */
  players: number
  cap: number
  /** NPC 수(구분 표시용) */
  npcs: number
}

/** 일일 수행(퀘스트) 진행 상태 */
export interface DailyState {
  /** KST 기준 날짜 키 'YYYY-MM-DD' */
  day: string
  /** 오늘 뽑힌 퀘스트 id 목록 */
  quests: string[]
  /** 퀘스트 id → 진행도 */
  prog: Record<string, number>
  /** 보상 수령한 퀘스트 id */
  done: string[]
  /** 연속 출석 일수 */
  streak: number
  /** 오늘의 운세(계시) 인덱스 */
  fortune: number
}

/**
 * 플레이어 진행도. 서버가 권위를 갖고, 서명해서 클라이언트 localStorage 에 맡겨 둔다.
 */
export interface Progress {
  v: 1
  pid: string
  /** 교단 영향력 포인트 */
  inf: number
  /** 누적 신도 수 */
  fol: number
  /** 가상 코인(공덕 코인). 실제 화폐와 무관 */
  coins: number
  /** 0..5 */
  rank: number
  /** 업적/통계용 카운터. 키 목록은 shared/content/stats.ts */
  stats: Record<string, number>
  /** 달성한 업적 id */
  ach: string[]
  /** 헌납품 도감: itemId → 개수 */
  items: Record<string, number>
  /** 만난 시민 도감: archetype id */
  met: string[]
  cult: CultRef | null
  /** 교단 기록(내가 교주일 때): 교단이 모은 NPC 신도 수 / 누적 영향력 */
  cultFol: number
  cultInf: number
  daily: DailyState | null
  /** 마지막 갱신 시각 (서버 epoch ms) */
  ts: number
}

/** 서버 서명이 붙은 저장 데이터. d 는 Progress 의 JSON 문자열. */
export interface SignedSave {
  d: string
  s: string
}

/** 교단 순위표 항목 */
export interface CultScore {
  id: string
  name: string
  color: number
  emblem: number
  leaderName: string
  title: string
  /** 현재 방에 접속 중인 교단원 수(교주 포함) */
  online: number
  /** 교단이 모은 NPC 신도 수 */
  fol: number
  /** 누적 영향력 */
  inf: number
}

/** 포교 결과 종류 */
export type PitchOutcome =
  | 'join' // 신도로 합류
  | 'more' // 흥미를 보임 → 한 번 더 멘트 선택
  | 'no' // 거절하고 제 갈 길
  | 'flee' // 전력 질주로 도망
  | 'ignore' // 무시
  | 'rival' // "저도 사실 교주입니다" → 기싸움(듀얼)
  | 'king' // "전생에 제가 왕이었나요?" → 감격하며 합류

export type FeedKind = 'rank' | 'ach' | 'cult' | 'join' | 'battle' | 'sermon' | 'rare' | 'patrol' | 'info'
