/**
 * 코드가 직접 의존하는 핵심 카탈로그: 직급, 이모트, 복장/모자/얼굴/소품/오라, 색상 팔레트, 교단 엠블럼, 통계 키.
 * 여기의 id 는 렌더러/서버 로직과 맞물려 있으므로 순서를 바꾸거나 지우지 말고 뒤에 추가만 한다.
 */
import { WORLD } from '../world/data'
import { PITCH_LINES } from './lines'
import type { CosmeticDef, EmoteDef, OutfitDef, RankDef } from './types'

// ───────── 직급 ─────────
// 잠금 해제 안내(unlock)는 손으로 쓰지 않고 아래 카탈로그에서 만든다(파일 끝의 RANKS) → 카탈로그에 항목을 더하면 안내도 따라온다.
// 문턱은 '1직급은 몇십 초, 3직급은 한 세션의 목표, 5직급은 여러 세션' 이 되게 잡았다(2차 검수의 봇 측정 기준).
const RANK_BASE: readonly Omit<RankDef, 'unlock'>[] = [
  { id: 0, name: '수상한 행인', inf: 0, cheer: '오늘도 어딘가 수상합니다.' },
  { id: 1, name: '길거리 전도사', inf: 30, cheer: '이제 전단지 쥐는 손이 제법 자연스럽습니다!' },
  { id: 2, name: '열정적인 포교왕', inf: 200, cheer: '반경 5m 안의 시민들이 눈을 피하기 시작했습니다!' },
  { id: 3, name: '신흥 교단장', inf: 800, cheer: '명함에 "교단장"이라고 써도 아무도 말리지 않습니다!' },
  { id: 4, name: '대교주', inf: 2500, cheer: '당신이 헛기침만 해도 신도들이 받아 적습니다!' },
  { id: 5, name: '우주급 절대교주', inf: 8000, cheer: '안드로메다에서 가입 문의가 왔습니다!' },
]

export const MAX_RANK = RANK_BASE.length - 1

export function rankForInfluence(inf: number): number {
  let r = 0
  for (const def of RANK_BASE) if (inf >= def.inf) r = def.id
  return r
}

/**
 * 최고 직급 뒤의 끝없는 '회차'(칭호만 바뀐다. 해금·보상 없음): 최고 직급 문턱에서 1회차, PRESTIGE_STEP 마다 +1.
 * 더 열 것이 없어도 숫자 하나는 계속 올라가게 하는 장치다. 놀림의 대상은 여전히 교주 본인.
 */
export const PRESTIGE_STEP = 5000

/** 영향력 → 회차(최고 직급 문턱 미만이면 0) */
export function prestigeOf(inf: number): number {
  const base = RANK_BASE[MAX_RANK]!.inf
  if (!(inf >= base)) return 0
  return 1 + Math.floor((inf - base) / PRESTIGE_STEP)
}

/** 다음 회차가 되는 영향력(최고 직급 전이면 최고 직급 문턱) */
export function nextPrestigeInf(inf: number): number {
  return RANK_BASE[MAX_RANK]!.inf + prestigeOf(inf) * PRESTIGE_STEP
}

/** 표시용 직급 이름: 최고 직급이면 '우주급 절대교주 N회차' */
export function rankTitle(rank: number, inf: number): string {
  const r = Math.max(0, Math.min(MAX_RANK, Math.floor(rank) || 0))
  const name = RANK_BASE[r]!.name
  const n = r === MAX_RANK ? prestigeOf(inf) : 0
  return n > 0 ? `${name} ${n}회차` : name
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
  { id: 'spin', name: '회전 수련', icon: '🌀', rank: 2, loop: true, ms: 0 },
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
  { id: 5, name: '개량한복 산책러', rank: 1, shape: 'hanbok', tint: true },
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
  { id: 2, name: '수상한 구슬 목걸이', rank: 0 },
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
  '🍜', '🛵', '🎰', '😴', '🧄', '👁️', '🛸', '🩴', '🍗', '☕', '🧦', '🥱', '🪙', '🔔', '🌀', '🥟', '🐈', '🧽', '🍚', '⚡', '🧻', '🪑', '📎', '🥒',
]

export const CULT_NAME_SUGGESTIONS: readonly string[] = [
  '퇴근을 믿는 사람들',
  '라면교',
  '월요병 구원회',
  '배달의 성자들',
  '로또의 계시',
  '만성피로 구원단',
]

export const CULT_TITLE_SUGGESTIONS: readonly string[] = ['교주', '명예 과장', '면장', '총무', '큰형님', '수석 졸음이']

/** 교단원(멤버)에게 붙는 표시 문구 */
export const CULT_MEMBER_TITLE = '교단원'

// ───────── 통계 키 (Progress.stats) ─────────
// 서버가 올리는 카운터. 업적/일일 수행 정의는 이 키를 참조한다.
export const STAT = {
  /** 말 걸기 시도 */
  talks: 'talks',
  /** 멘트 선택(포교 시도) */
  pitches: 'pitches',
  /** 합류 성공(포교로 합류한 횟수만) */
  joins: 'joins',
  /** 얻은 신도 누계: 포교·설교·기싸움 등 어떤 길로든 prog.fol 이 늘 때마다 같이 오른다(HUD 의 신도 수와 같은 값) */
  folTotal: 'folTotal',
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

// ───────── 직급별 잠금 해제 안내(카탈로그에서 만든다) ─────────

/** 직급 r 에서 새로 열리는 것을 한 줄로: 동작(…), 복장(…), …, 새 멘트 N개, 비밀 교단 건물 출입 */
export function rankUnlockText(r: number): string {
  const named = (list: readonly { name: string; rank: number; id: number | string; ach?: string }[]): string[] =>
    list.filter((x) => x.rank === r && !x.ach && !(x.id === 0 && x.name === '없음')).map((x) => x.name)
  const lines = PITCH_LINES.filter((l) => l.rank === r).length
  if (r === 0) {
    // 처음부터 열린 것은 이름을 다 늘어놓으면 너무 길어서 개수로 말한다
    const count = (list: readonly { rank: number; id: number | string; name: string }[]): number =>
      list.filter((x) => x.rank === 0 && !(x.id === 0 && x.name === '없음')).length
    return `기본 동작 ${count(EMOTES)}가지, 복장 ${count(OUTFITS)}벌, 모자 ${count(HATS)}개, 얼굴 ${count(FACES)}가지, 소품 ${count(ACCESSORIES)}개, 멘트 ${lines}개`
  }
  const parts: string[] = []
  const add = (label: string, names: string[]): void => {
    if (names.length > 0) parts.push(`${label}(${names.join('·')})`)
  }
  add('동작', named(EMOTES))
  add('복장', named(OUTFITS))
  add('모자', named(HATS))
  add('얼굴', named(FACES))
  add('소품', named(ACCESSORIES))
  add('오라', named(AURAS))
  if (lines > 0) parts.push(`새 멘트 ${lines}개`)
  if (WORLD.hq.minRank === r) parts.push('비밀 교단 건물 출입')
  return parts.join(', ')
}

export const RANKS: readonly RankDef[] = RANK_BASE.map((d) => ({ ...d, unlock: rankUnlockText(d.id) }))
