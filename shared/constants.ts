/**
 * 게임 전역 상수. 클라이언트/서버/워커가 모두 같은 값을 쓴다.
 * 단위: 거리 m, 시간 ms(이름에 _MS), 속도 m/s.
 */

export const PROTOCOL_VERSION = 1

// ───────── 방 / 서버 ─────────
export const ROOM_CAPACITY = 20
export const DEFAULT_ROOM_COUNT = 3
export const MAX_ROOM_COUNT = 500
export const NPCS_PER_ROOM = 28

export const TICK_HZ = 10
export const TICK_MS = 1000 / TICK_HZ
/** 클라이언트가 자기 위치를 보내는 최대 빈도 */
export const CLIENT_SEND_HZ = 10
/** 원격 엔티티 보간 지연(스냅샷 2틱 분량 근처) */
export const INTERP_DELAY_MS = 190
export const PING_INTERVAL_MS = 4000
/** 이 시간 동안 아무 메시지도 없으면 서버가 연결을 끊는다 */
export const IDLE_TIMEOUT_MS = 45_000
/** 연결 후 hello 를 보내야 하는 제한 시간 */
export const HELLO_TIMEOUT_MS = 8000
export const MAX_MSG_BYTES = 4096
/** 연결당 초당 허용 메시지 수(버스트 포함) */
export const RATE_LIMIT_PER_SEC = 40

// ───────── 이동 ─────────
export const WALK_SPEED = 3.4
export const RUN_SPEED = 5.6
/** '도망가기' 스프린트 */
export const SPRINT_SPEED = 8.4
export const SPRINT_MS = 2600
export const SPRINT_COOLDOWN_MS = 8000
export const PLAYER_RADIUS = 0.45
export const NPC_RADIUS = 0.42
export const NPC_WALK_SPEED = 1.5
export const NPC_FLEE_SPEED = 7.2
export const NPC_FOLLOW_SPEED = 6.0
/** 서버 이동 검증: 허용 속도 여유 배수 */
export const SPEED_TOLERANCE = 1.5

// ───────── 포교 ─────────
export const TALK_RANGE = 2.8
export const PLAYER_INTERACT_RANGE = 4.0
export const POI_RANGE_PAD = 0.4
export const TALK_TIMEOUT_MS = 16_000
export const PITCH_COOLDOWN_MS = 2200
/** 거절한 NPC가 같은 플레이어를 기억하는 시간 */
export const NPC_REJECT_MEMORY_MS = 35_000
export const FOLLOW_DURATION_MS = 100_000
export const MAX_ENTOURAGE = 6
export const LINES_PER_TALK = 4
export const MAX_TALK_ROUNDS = 2

// ───────── 보상 ─────────
export const INF_JOIN = 10
export const INF_MORE = 2
export const INF_FAIL = 1
export const INF_STREAK_BONUS = 2 // 연속 성공 1회당 추가
export const INF_STREAK_MAX = 10
export const INF_PROPHECY = 5
export const INF_SERMON_LEADER = 25
/** 혼자(참여자가 교주뿐) 연 설교의 교주 보상 상한. 혼자 단상에서 게이지를 채우는 농사를 막는다 */
export const INF_SERMON_SOLO = 10
/** 혼자 연 설교에서 합류하는 신도 상한 */
export const SERMON_SOLO_CONVERTS = 1
/** 계시는 20초마다 할 수 있지만 영향력은 PROPHECY_PAY_WINDOW_MS 동안 PROPHECY_PAY_SLOTS 번까지만 준다(버프·농담은 그대로) */
export const PROPHECY_PAY_SLOTS = 6
export const PROPHECY_PAY_WINDOW_MS = 10 * 60_000
export const INF_SERMON_JOIN = 12
export const INF_BATTLE_WIN = 30
export const INF_BATTLE_LOSE = 8

// ───────── 상호작용 쿨타임 ─────────
export const EMOTE_COOLDOWN_MS = 500
export const SAY_COOLDOWN_MS = 1500
export const INVITE_COOLDOWN_MS = 60_000 // 같은 대상에게
export const INVITE_GLOBAL_COOLDOWN_MS = 5000
export const INVITE_TTL_MS = 20_000
export const PROPHECY_COOLDOWN_MS = 20_000
export const SERMON_DURATION_MS = 26_000
export const SERMON_ROOM_COOLDOWN_MS = 75_000
export const SERMON_ROUNDS = 3
export const BATTLE_DURATION_MS = 60_000
export const BATTLE_COOLDOWN_MS = 20_000
export const OFFER_COOLDOWN_MS = 12_000
export const REPORT_COOLDOWN_MS = 10_000

// ───────── 문자열 제한 ─────────
export const NAME_MIN = 2
export const NAME_MAX = 10
export const CULT_NAME_MIN = 2
export const CULT_NAME_MAX = 12
export const TITLE_MAX = 8

// ───────── 엔티티 키 (클라이언트 렌더/오버레이에서 플레이어와 NPC를 한 공간에 담을 때) ─────────
export const NPC_KEY_BASE = 100_000
export const npcKey = (npcId: number): number => NPC_KEY_BASE + npcId
export const isNpcKey = (key: number): boolean => key >= NPC_KEY_BASE

// ───────── 애니메이션 상태 바이트 ─────────
/** 플레이어/NPC 공통 이동 상태(스냅샷의 st 바이트) */
export enum Anim {
  Idle = 0,
  Walk = 1,
  Run = 2,
  /** 플레이어 '도망가기' 스프린트 / NPC 도망 */
  Sprint = 3,
  /** NPC: 플레이어의 말을 듣는 중(멈춰서 바라봄) */
  Listen = 4,
  /** NPC: 설교를 구경하며 환호 / 플레이어: 미사용 */
  Cheer = 5,
  /** 단속에 걸려 잠시 얼어붙음 */
  Stun = 6,
  /** NPC: 지하철 등으로 퇴장/등장 중(축소 연출) */
  Vanish = 7,
}

// ───────── 붐비는 방(2차 검수): 시민 수와 신도 정원이 접속자 수를 따라간다 ─────────
/** 방 하나의 시민 수 상한(설정한 기본 수가 이보다 크면 기본 수가 상한) */
export const NPC_MAX_PER_ROOM = 52
/** 목표 시민 수 = NPC_POP_BASE + NPC_POP_PER_PLAYER × 접속자, [기본 수, 상한] 으로 자른다 */
export const NPC_POP_BASE = 20
export const NPC_POP_PER_PLAYER = 1.6
/** 남의 신도를 데려갔을 때 원래 교주에게 가는 알림의 최소 간격(교주당) */
export const POACH_NOTICE_MS = 5000
/**
 * 갓 따라나선 신도는 이 시간 동안 다른 교주의 말을 듣지 않는다(의리 기간).
 * 붐비는 방에서 방금 얻은 신도를 바로 옆 사람이 곧장 데려가 줄이 생기지 않던 문제를 줄인다.
 * 빼앗긴 직후에도 새로 따라나선 것이므로 같은 기간이 다시 시작된다.
 */
export const FOLLOWER_LOYALTY_MS = 40_000

/**
 * 지금 방 인원에서 교주 한 명이 거느릴 수 있는 신도 수. 사람이 많으면 시민도 모자라므로 정원을 줄인다.
 * MAX_ENTOURAGE 가 절대 상한이다.
 */
export function entourageCap(players: number): number {
  const cap = players <= 8 ? 6 : players <= 14 ? 5 : 4
  return Math.min(cap, MAX_ENTOURAGE)
}
