/**
 * 코드가 직접 의존하는 핵심 카탈로그: 직급, 이모트, 복장/모자/얼굴/소품/오라, 색상 팔레트, 교단 엠블럼, 통계 키.
 * 여기의 id 는 렌더러/서버 로직과 맞물려 있으므로 순서를 바꾸거나 지우지 말고 뒤에 추가만 한다.
 */
import type { CosmeticDef, EmoteDef, OutfitDef, RankDef } from './types'

// ───────── 직급 ─────────
export const RANKS: readonly RankDef[] = [
  {
    id: 0,
    name: '수상한 행인',
    inf: 0,
    cheer: '오늘도 어딘가 수상합니다.',
    unlock: '기본 동작 전부, 시민·전도사·초보 교주 복장',
  },
  {
    id: 1,
    name: '길거리 전도사',
    inf: 30,
    cheer: '이제 전단지 쥐는 손이 제법 자연스럽습니다!',
    unlock: '만세·큰절 동작, 갓·삿갓, 등산복, 수상한 반짝이',
  },
  {
    id: 2,
    name: '열정적인 포교왕',
    inf: 140,
    cheer: '반경 5m 안의 시민들이 눈을 피하기 시작했습니다!',
    unlock: '회전 기도·계시의 손가락, 은박지 모자·피라미드 모자, 흰 도복',
  },
  {
    id: 3,
    name: '신흥 교단장',
    inf: 420,
    cheer: '명함에 "교단장"이라고 써도 아무도 말리지 않습니다!',
    unlock: '황금 교주 로브, 왕관·안테나 수신기, 후광, 비밀 교단 건물 출입',
  },
  {
    id: 4,
    name: '대교주',
    inf: 1000,
    cheer: '당신이 헛기침만 해도 신도들이 받아 적습니다!',
    unlock: '공중부양, 반짝이 망토, 후광 머리띠, 무지개 오라',
  },
  {
    id: 5,
    name: '우주급 절대교주',
    inf: 2500,
    cheer: '안드로메다에서 가입 문의가 왔습니다!',
    unlock: '우주 교신, 우주 절대교주 슈트, UFO 모자, 우주 오라',
  },
]

export const MAX_RANK = RANKS.length - 1

export function rankForInfluence(inf: number): number {
  let r = 0
  for (const def of RANKS) if (inf >= def.inf) r = def.id
  return r
}

// ───────── 이모트 ─────────
// 요청 명세의 기본 행동 8종은 모두 직급 0부터 사용 가능.
export const EMOTES: readonly EmoteDef[] = [
  { id: 'wave', name: '손 흔들기', icon: '👋', rank: 0, loop: false, ms: 1700, key: '1' },
  { id: 'bow', name: '정중한 인사', icon: '🙇', rank: 0, loop: false, ms: 1900, key: '2' },
  { id: 'smirk', name: '수상한 미소', icon: '😏', rank: 0, loop: false, ms: 2400, key: '3' },
  { id: 'pray', name: '두 손 모으기', icon: '🙏', rank: 0, loop: true, ms: 0, key: '4' },
  { id: 'flyer', name: '전단 흔들기', icon: '📄', rank: 0, loop: true, ms: 0, key: '5' },
  { id: 'preach', name: '설교하기', icon: '🙌', rank: 0, loop: true, ms: 0, key: '6' },
  { id: 'dance', name: '신비로운 춤', icon: '💃', rank: 0, loop: true, ms: 0, key: '7' },
  // 'flee' 는 이모트이자 스프린트 발동(클라이언트가 이동 상태 Anim.Sprint 로 전환)
  { id: 'flee', name: '도망가기', icon: '💨', rank: 0, loop: false, ms: 2600, key: '8' },
  { id: 'cheer', name: '만세', icon: '🎉', rank: 1, loop: false, ms: 2000 },
  { id: 'kneel', name: '큰절', icon: '🧎', rank: 1, loop: false, ms: 2600 },
  { id: 'spin', name: '회전 기도', icon: '🌀', rank: 2, loop: true, ms: 0 },
  { id: 'point', name: '계시의 손가락', icon: '☝️', rank: 2, loop: false, ms: 2200 },
  { id: 'levitate', name: '공중부양', icon: '🧘', rank: 4, loop: true, ms: 0 },
  { id: 'cosmic', name: '우주 교신', icon: '🛸', rank: 5, loop: true, ms: 0 },
]

export const EMOTE_BY_ID: ReadonlyMap<string, EmoteDef> = new Map(EMOTES.map((e) => [e.id, e]))

// ───────── 외형 카탈로그 (Look 튜플의 각 칸) ─────────

/** Look[0] 피부색 */
export const SKIN_COLORS: readonly number[] = [0xffdfc4, 0xf4c7a1, 0xe0a878, 0xc68655, 0x9a6240, 0xffe9d6]

/** Look[2] 옷 주색 팔레트 */
export const OUTFIT_COLORS: readonly number[] = [
  0xf2f2ef, // 0 흰색
  0x2f2b3a, // 1 먹색
  0xe85d4a, // 2 다홍
  0xf2a03d, // 3 귤색
  0xf6d24a, // 4 노랑
  0x6cc070, // 5 연두
  0x2fa39a, // 6 청록
  0x4f8fe6, // 7 하늘
  0x6a55d8, // 8 보라
  0xd96bb0, // 9 분홍
  0x8a6b52, // 10 갈색
  0x9aa3ad, // 11 회색
]

/** Look[1] 복장 */
export const OUTFITS: readonly OutfitDef[] = [
  { id: 0, name: '평범한 시민', rank: 0, shape: 'shirt', tint: true },
  { id: 1, name: '후드티 대학생', rank: 0, shape: 'hoodie', tint: true },
  { id: 2, name: '수상한 전도사', rank: 0, shape: 'suit', tint: false },
  { id: 3, name: '초보 교주 도복', rank: 0, shape: 'robe', tint: true },
  { id: 4, name: '등산복 포교단', rank: 1, shape: 'vest', tint: true },
  { id: 5, name: '개량한복 도인', rank: 1, shape: 'hanbok', tint: true },
  { id: 6, name: '흰 도복 도사', rank: 2, shape: 'robe', tint: false },
  { id: 7, name: '황금 교주 로브', rank: 3, shape: 'robe', tint: false },
  { id: 8, name: '반짝이 망토 대교주', rank: 4, shape: 'cape', tint: true },
  { id: 9, name: '우주 절대교주 슈트', rank: 5, shape: 'cape', tint: false },
]

/** Look[3] 모자 */
export const HATS: readonly CosmeticDef[] = [
  { id: 0, name: '없음', rank: 0 },
  { id: 1, name: '야구모자', rank: 0 },
  { id: 2, name: '밀짚모자', rank: 0 },
  { id: 3, name: '갓', rank: 1 },
  { id: 4, name: '삿갓', rank: 1 },
  { id: 5, name: '은박지 모자', rank: 2 },
  { id: 6, name: '피라미드 모자', rank: 2 },
  { id: 7, name: '왕관', rank: 3 },
  { id: 8, name: '안테나 수신기', rank: 3 },
  { id: 9, name: '후광 머리띠', rank: 4 },
  { id: 10, name: 'UFO 모자', rank: 5 },
]

/** Look[4] 얼굴 */
export const FACES: readonly CosmeticDef[] = [
  { id: 0, name: '기본 미소', rank: 0 },
  { id: 1, name: '수상한 눈웃음', rank: 0 },
  { id: 2, name: '졸린 눈', rank: 0 },
  { id: 3, name: '초롱초롱', rank: 0 },
  { id: 4, name: '선글라스', rank: 0 },
  { id: 5, name: '콧수염', rank: 1 },
  { id: 6, name: '도사 수염', rank: 2 },
]

/** Look[5] 소품 */
export const ACCESSORIES: readonly CosmeticDef[] = [
  { id: 0, name: '없음', rank: 0 },
  { id: 1, name: '"도를 아십니까" 어깨띠', rank: 0 },
  { id: 2, name: '염주 목걸이', rank: 0 },
  { id: 3, name: '배낭', rank: 0 },
  { id: 4, name: '확성기', rank: 1 },
  { id: 5, name: '금목걸이', rank: 3 },
]

/** Look[6] 오라(이펙트) */
export const AURAS: readonly CosmeticDef[] = [
  { id: 0, name: '없음', rank: 0 },
  { id: 1, name: '수상한 반짝이', rank: 1 },
  { id: 2, name: '후광', rank: 3 },
  { id: 3, name: '무지개 오라', rank: 4 },
  { id: 4, name: '우주 오라', rank: 5 },
]

// ───────── 교단 ─────────
export const CULT_COLORS: readonly number[] = [
  0xe85d4a, 0xf2a03d, 0xf6d24a, 0x6cc070, 0x2fa39a, 0x4f8fe6, 0x6a55d8, 0xd96bb0, 0x8a6b52, 0x3b3f52, 0xff7eb6, 0x7ad7f0,
]

/** 엠블럼은 이모지로 표현한다(에셋 없이 DOM/캔버스/3D 텍스처 어디서나 그릴 수 있다) */
export const CULT_EMBLEMS: readonly string[] = [
  '🍜', '🛵', '🎰', '😴', '🌙', '👁️', '🛸', '🐟', '🍗', '☕', '🧦', '🥱', '🪙', '🔔', '🌀', '🥟', '🐈', '🕊️', '🍚', '⚡', '🧻', '🪑', '📎', '🥒',
]

export const CULT_NAME_SUGGESTIONS: readonly string[] = [
  '퇴근을 믿는 사람들',
  '라면교',
  '월요병 구원회',
  '배달의 성자들',
  '로또의 계시',
  '만성피로 구원단',
]

export const CULT_TITLE_SUGGESTIONS: readonly string[] = ['교주', '대사제', '면장', '총무', '큰형님', '수석 졸음이']

/** 교단원(멤버)에게 붙는 표시 문구 */
export const CULT_MEMBER_TITLE = '신도'

// ───────── 통계 키 (Progress.stats) ─────────
// 서버가 올리는 카운터. 업적/일일 수행 정의는 이 키를 참조한다.
export const STAT = {
  /** 말 걸기 시도 */
  talks: 'talks',
  /** 멘트 선택(포교 시도) */
  pitches: 'pitches',
  /** 합류 성공 */
  joins: 'joins',
  /** 거절(no/ignore/flee) */
  rejects: 'rejects',
  /** 도망간 시민 */
  flees: 'flees',
  /** 무시당함 */
  ignores: 'ignores',
  /** 현재 연속 성공 */
  streak: 'streak',
  /** 최고 연속 성공 */
  bestStreak: 'bestStreak',
  /** 현재 연속 실패 */
  failStreak: 'failStreak',
  /** 최고 연속 실패 */
  worstStreak: 'worstStreak',
  /** 전생의 왕 발견 */
  kings: 'kings',
  /** 라이벌 교주를 만남 / 이김 */
  rivals: 'rivals',
  rivalWins: 'rivalWins',
  /** 고양이에게 포교 시도 / 성공 */
  catTalks: 'catTalks',
  catJoins: 'catJoins',
  /** 이모트 사용 횟수 */
  emotes: 'emotes',
  dances: 'dances',
  /** 말풍선 사용 */
  says: 'says',
  /** 계시 발표 */
  prophecies: 'prophecies',
  /** 설교 주최 / 참여 */
  sermonsLed: 'sermonsLed',
  sermonsJoined: 'sermonsJoined',
  /** 배틀 참가 / 승리 */
  battles: 'battles',
  battleWins: 'battleWins',
  /** 헌납 받은 물건 수 */
  offerings: 'offerings',
  /** 단속에 걸린 횟수 / 도망 성공 */
  caught: 'caught',
  escapes: 'escapes',
  /** 도망가기 사용 */
  sprints: 'sprints',
  /** 교단 초대 보냄 / 수락받음 / 내가 수락함 */
  invites: 'invites',
  recruits: 'recruits',
  joinedCults: 'joinedCults',
  /** 교단 창설 */
  cultsMade: 'cultsMade',
  /** 접속 일수 */
  days: 'days',
  /** 다른 사람의 신도를 빼앗음 */
  poaches: 'poaches',
} as const

export type StatKey = (typeof STAT)[keyof typeof STAT]
