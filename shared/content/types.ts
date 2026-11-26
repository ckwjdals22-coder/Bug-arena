/**
 * 콘텐츠 데이터 스키마. 데이터 파일(shared/content/*.ts)은 전부 이 타입을 따른다.
 * 모든 콘텐츠는 허구이며, 실존 종교·정치 단체·인물을 연상시키면 안 된다.
 */

/**
 * 포교 멘트의 '맛' 분류. 실제 설득 기법이 아니라 개그 소재 구분이다.
 * NPC 유형마다 소재별 취향(like)이 달라서 가벼운 상성 놀이가 된다.
 */
export type PitchCategory =
  | 'dao' // "도를 아십니까?" 정통파
  | 'face' // 인상·관상
  | 'past' // 전생
  | 'ancestor' // 조상님·꿈
  | 'energy' // 기운
  | 'time' // "1분이면 됩니다"
  | 'fate' // 우연·인연
  | 'cosmic' // 우주·외계 교신

export const PITCH_CATEGORIES: readonly PitchCategory[] = [
  'dao',
  'face',
  'past',
  'ancestor',
  'energy',
  'time',
  'fate',
  'cosmic',
]

export interface PitchLine {
  /** 배열 인덱스와 같아야 한다 */
  id: number
  text: string
  cat: PitchCategory
  /** 이 직급(0..5)부터 사용 가능 */
  rank: number
  /** 성공 확률 가감 (-0.15 ~ +0.2) */
  power: number
  /** 이 멘트를 쓰면 NPC가 전력 질주로 도망갈 추가 확률 (0 ~ 0.5). '도망가는 시민' 개그용 */
  fleeBias?: number
}

/** 반응 대사 묶음 */
export interface ReactionSet {
  join?: string[]
  more?: string[]
  no?: string[]
  flee?: string[]
  ignore?: string[]
}

export interface Archetype {
  id: string
  /** 유형 이름 (도감 표시): '퇴근길 직장인' */
  name: string
  /** 도감 설명 한 줄 */
  desc: string
  /** 머리 위에 뜨는 이름 후보: '김대리', '박과장' ... */
  names: string[]
  /** 등장 가중치 */
  weight: number
  /** 기본 합류 확률 0..1 */
  base: number
  /** 소재별 취향 가감 (-0.3 ~ +0.4) */
  like: Partial<Record<PitchCategory, number>>
  /** 실패 시 도망칠 확률 0..1 */
  flee: number
  /** 실패 시 무시할 확률 0..1 (나머지는 말로 거절) */
  ignore: number
  /** '더 들어볼게요'(2라운드) 확률 0..1 */
  curious: number
  /** 걷는 속도 배수 */
  speed: number
  /** 외형 생성 풀 (cosmetics 카탈로그 id) */
  look: {
    outfits: number[]
    hats: number[]
    colors: number[]
    faces: number[]
    accs: number[]
  }
  /** NpcModel (0 사람, 1 고양이 ...) */
  model?: number
  /**
   * false 면 절대 신도가 되지 않는다(합류 확률 0). 현실에서 피해를 입기 쉬운 사람을 닮은 유형(어린이, 길 잃은 관광객 등)은
   * 속는 역할이 아니라 교주를 제압하는 역할만 맡긴다. 기본값 true.
   */
  recruitable?: boolean
  /** 특수 유형: rival = "저도 사실 교주입니다" / royal = 전생 멘트에 "제가 왕이었나요?" 확률 / animal = 사람 말이 안 통함 */
  special?: 'rival' | 'royal' | 'animal'
  /** 말을 걸었을 때 첫마디 */
  greet: string[]
  /** 기본 반응 */
  re: ReactionSet
  /** 특정 소재에 대한 전용 반응 (있으면 우선) */
  catRe?: Partial<Record<PitchCategory, ReactionSet>>
  /** 걸어 다니며 하는 혼잣말 */
  mutter: string[]
  /** 신도가 된 뒤 따라다니며 하는 말 */
  follow: string[]
  /** 정신 차리고 떠날 때 하는 말 */
  leave: string[]
}

export interface RankDef {
  /** 0..5 */
  id: number
  name: string
  /** 이 영향력 이상이면 도달 */
  inf: number
  /** 승급 축하 문구 */
  cheer: string
  /** 잠금 해제 안내 문구 */
  unlock: string
}

export interface EmoteDef {
  id: string
  name: string
  icon: string
  /** 해금 직급 */
  rank: number
  /** true 면 이동/취소 전까지 반복 */
  loop: boolean
  /** 1회성 이모트의 길이(ms) */
  ms: number
  /** PC 단축키(숫자) */
  key?: string
}

export interface CosmeticDef {
  /** 배열 인덱스와 같아야 한다 */
  id: number
  name: string
  /** 해금 직급 */
  rank: number
  /** 해금에 필요한 업적 id (있으면 직급 대신 업적으로 해금) */
  ach?: string
}

export interface OutfitDef extends CosmeticDef {
  /** 몸통 실루엣 */
  shape: 'shirt' | 'hoodie' | 'suit' | 'vest' | 'hanbok' | 'robe' | 'cape'
  /** true 면 플레이어가 고른 색(color)이 주색이 된다. false 면 고정색 */
  tint: boolean
}

export interface QuickChat {
  id: number
  text: string
  icon: string
  rank: number
}

export interface AchievementDef {
  id: string
  name: string
  desc: string
  icon: string
  /** 이 통계 키가 */
  stat: string
  /** 이 값 이상이면 달성 */
  gte: number
  /** 보상 영향력 */
  inf: number
  /** 달성 전에는 내용을 숨김 */
  secret?: boolean
}

export interface OfferItem {
  id: string
  name: string
  /** 한 줄 설명(개그) */
  desc: string
  icon: string
  /** 1 흔함 · 2 드묾 · 3 희귀 · 4 전설 */
  rarity: 1 | 2 | 3 | 4
  /** 함께 받는 가상 코인 */
  coins: number
}

export interface SermonChant {
  call: string
  resp: string
}

export interface DailyQuestDef {
  id: string
  text: string
  stat: string
  n: number
  inf: number
}

/** 라이벌 교주 기싸움 한 판 */
export interface DuelDef {
  /** 라이벌의 멘트 */
  say: string
  /** 내 선택지 3개 */
  choices: string[]
  /** 정답 인덱스들(여러 개 가능) — 정답은 '더 황당한 쪽' */
  win: number[]
  winText: string
  loseText: string
}
