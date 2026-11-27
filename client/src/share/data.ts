/**
 * 공유 카드에 들어갈 숫자와 문구를 고르는 순수 함수 모음(DOM 없음 → 단위 테스트 가능).
 *
 * 문구 원칙(조사 02 §5.4, 03 §2.15·§5):
 * - "공문서의 진지한 말투 + 하찮은 내용". 놀림의 대상은 언제나 플레이어 본인(교주 지망생)이다.
 * - 시민(NPC)은 평범한 사람들이고, 거절·도망은 시민이 옳았다는 쪽으로만 쓴다.
 * - 실제 포교 기법·연락처 요구·불안 조장 문구는 쓰지 않는다.
 */
import { rankTitle } from '../../../shared/content/core'
import type { CultRef, Look } from '../../../shared/types'

/** 카드를 그리는 데 필요한 내 정보(스토어에서 뽑거나, 하네스에서 가짜로 만든다) */
export interface ShareProfile {
  pid: string
  name: string
  look: Look
  rank: number
  /** 누적 신도 수 */
  fol: number
  inf: number
  coins: number
  cult: CultRef | null
  stats: Record<string, number>
  /** 선택한 칭호(업적 이름으로 바꿔서 넣는다). 없으면 '' */
  tagName: string
}

/** 이번 접속(세션) 동안의 숫자 */
export interface SessionNumbers {
  /** 말 건 사람 */
  talks: number
  /** 멘트를 고른 횟수(포교 시도) */
  pitches: number
  joins: number
  /** 거절(no/ignore/flee 모두) */
  rejects: number
  flees: number
  ignores: number
  kings: number
  dances: number
  emotes: number
  catTalks: number
  caught: number
  /** 이번 세션 최고 연속 실패 */
  worstFail: number
  /** 플레이한 분 */
  minutes: number
}

export const SESSION_KEYS = ['talks', 'pitches', 'joins', 'rejects', 'flees', 'ignores', 'kings', 'dances', 'emotes', 'catTalks', 'caught'] as const

/** 세션 시작 시점 통계와 지금 통계의 차이. 저장본이 갈아엎혀 줄어든 경우는 0으로 본다 */
export function sessionDiff(start: Record<string, number>, now: Record<string, number>, worstFail: number, minutes: number): SessionNumbers {
  const d = (k: string): number => Math.max(0, Math.floor((now[k] ?? 0) - (start[k] ?? 0)))
  return {
    talks: d('talks'),
    pitches: d('pitches'),
    joins: d('joins'),
    rejects: d('rejects'),
    flees: d('flees'),
    ignores: d('ignores'),
    kings: d('kings'),
    dances: d('dances'),
    emotes: d('emotes'),
    catTalks: d('catTalks'),
    caught: d('caught'),
    worstFail: Math.max(0, Math.floor(worstFail)),
    minutes: Math.max(0, Math.floor(minutes)),
  }
}

/** 성공률(0..1). 시도한 포교 결과(합류+거절) 기준 */
export function successRate(s: SessionNumbers): number {
  const tries = s.joins + s.rejects
  return tries > 0 ? s.joins / tries : 0
}

export interface Verdict {
  id: string
  icon: string
  /** "○○형" */
  name: string
  /** 플레이어를 놀리는 한 줄 */
  roast: string
  /** 위로 한 줄 */
  comfort: string
}

/**
 * 교주 유형 판정. 위에서부터 처음 맞는 규칙 하나.
 * 순서가 곧 우선순위: 숫자가 극단적인 쪽(웃긴 쪽)을 먼저 본다. 못한 날일수록 재밌게.
 */
export const VERDICTS: readonly (Verdict & { test: (s: SessionNumbers) => boolean })[] = [
  {
    id: 'walker',
    icon: '🚶',
    name: '산책 수행형',
    roast: '오늘 한 일: 걷기. 포교는 마음속으로만 했다.',
    comfort: '만보기만은 오늘 무척 기뻐하고 있습니다.',
    test: (s) => s.talks === 0,
  },
  {
    id: 'dancer',
    icon: '💃',
    name: '춤바람 교주형',
    roast: '말보다 춤이 많았다. 교리는 아마 리듬인 듯.',
    comfort: '시민들이 도망은 가도 박자는 맞춰 줬습니다.',
    test: (s) => s.dances >= 10 && s.dances > s.talks,
  },
  {
    id: 'alarm',
    icon: '🚨',
    name: '인간 비상벨형',
    roast: `입을 여는 순간 시민들이 전력 질주. 동네 체력장이 열렸다.`,
    comfort: '덕분에 오늘 동네 평균 심박수가 올랐습니다.',
    test: (s) => s.flees >= 5 && s.flees * 2 >= s.rejects,
  },
  {
    id: 'wall',
    icon: '🧱',
    name: '철벽 수집가형',
    roast: '거절을 수집하는 취미가 생겼다. 도감이 곧 완성된다.',
    comfort: '거절당한 횟수만큼 멘탈 근육이 붙었습니다(아마).',
    test: (s) => s.rejects >= 10 && s.joins <= 1,
  },
  {
    id: 'unbreakable',
    icon: '🌧️',
    name: '불굴의 헛발질형',
    roast: '연속 실패 기록을 스스로 갱신했다. 반성은 내일 하기로.',
    comfort: '포기하지 않는 근성 하나는 우주급입니다.',
    test: (s) => s.worstFail >= 6,
  },
  {
    id: 'ghost',
    icon: '👻',
    name: '투명 망토형',
    roast: '말을 걸었는데 아무도 못 봤다. 존재감이 와이파이 수준.',
    comfort: '단속반 눈에도 안 띄는 재능입니다.',
    test: (s) => s.ignores >= 4 && s.ignores * 2 >= s.rejects,
  },
  {
    id: 'cat',
    icon: '🐈',
    name: '고양이 집사형',
    roast: '고양이에게 교리를 설명했다. 고양이는 하품으로 답했다.',
    comfort: '적어도 고양이는 도망가지 않았습니다(아마).',
    test: (s) => s.catTalks >= 3 && s.catTalks * 2 >= s.talks,
  },
  {
    id: 'royal',
    icon: '👑',
    name: '왕족 감별사형',
    roast: '오늘 만난 사람 중 전생의 왕이 나왔다. 감별 기준은 비밀.',
    comfort: '왕을 알아보는 눈, 쓸 데는 없지만 멋있습니다.',
    test: (s) => s.kings >= 1,
  },
  {
    id: 'empty',
    icon: '🍃',
    name: '빈손형',
    roast: '신도 0명. 교단 운영비가 0원이라 효율은 최고.',
    comfort: '아무도 없으니 내부 분열도 없습니다.',
    test: (s) => s.joins === 0,
  },
  {
    id: 'genius',
    icon: '🎤',
    name: '말발 천재형(자칭)',
    roast: '성공률이 수상하게 높다. 본인이 제일 놀란 눈치.',
    comfort: '내일은 아마 평소대로 거절당할 테니 오늘을 즐기세요.',
    test: (s) => s.joins + s.rejects >= 5 && successRate(s) >= 0.6,
  },
  {
    id: 'conga',
    icon: '🚃',
    name: '인간 기차형',
    roast: '뒤에 줄이 길다. 다들 왜 따라오는지 본인도 모른다.',
    comfort: '단체 사진은 가로로 찍으셔야 합니다.',
    test: (s) => s.joins >= 12,
  },
  {
    id: 'marathon',
    icon: '🏃',
    name: '오지랖 마라토너형',
    roast: '말을 건 사람 수가 동네 반상회 출석보다 많다.',
    comfort: '그 체력이면 포교 말고 다른 것도 됩니다.',
    test: (s) => s.talks >= 25,
  },
  {
    id: 'average',
    icon: '😐',
    name: '애매하게 수상한형',
    roast: '잘한 것도 못한 것도 아닌, 딱 수상한 행인 수준.',
    comfort: '평범함이야말로 최고의 위장입니다.',
    test: () => true,
  },
]

export function judge(s: SessionNumbers): Verdict {
  for (const v of VERDICTS) if (v.test(s)) return { id: v.id, icon: v.icon, name: v.name, roast: v.roast, comfort: v.comfort }
  const last = VERDICTS[VERDICTS.length - 1]!
  return { id: last.id, icon: last.icon, name: last.name, roast: last.roast, comfort: last.comfort }
}

/**
 * 임명장 "특이사항" 한 줄: 내 통계에서 가장 웃긴(=가장 큰) 굴욕 하나를 고른다.
 * 숫자가 클수록, 그리고 굴욕스러운 항목일수록 가중치를 높게 준다.
 */
export function selfRoast(stats: Record<string, number>): string {
  const v = (k: string): number => Math.max(0, Math.floor(stats[k] ?? 0))
  const cands: [score: number, text: string][] = [
    [v('rejects') * 1.2, `거절 ${v('rejects')}회를 견딘 근성`],
    [v('flees') * 2, `도망간 시민 ${v('flees')}명`],
    [v('ignores') * 1.6, `투명인간 취급 ${v('ignores')}회`],
    [v('kings') * 6, `전생의 왕 ${v('kings')}명 발굴`],
    [v('worstStreak') >= 3 ? v('worstStreak') * 3 : 0, `연속 헛발질 최고 ${v('worstStreak')}회`],
    [v('catTalks') * 3, `고양이에게 포교 시도 ${v('catTalks')}회`],
    [v('caught') * 4, `단속반에게 붙잡힌 ${v('caught')}회`],
    [v('dances') * 0.8, `길에서 춤춘 ${v('dances')}회`],
    [v('sprints') * 0.6, `도망가기 버튼 ${v('sprints')}회 연타`],
  ]
  let best: [number, string] | null = null
  for (const c of cands) if (c[0] >= 1 && (!best || c[0] > best[0])) best = c
  if (best) return best[1]
  if (v('talks') > 0) return `말 건 ${v('talks')}명 모두 무사히 귀가`
  return '아직 아무에게도 말을 못 건 신중함'
}

/** 직급별 임명장 제목. 낮은 직급일수록 문서 이름부터 하찮게 */
export const CERT_TITLES: readonly string[] = [
  '수상한 행인 확인서',
  '길거리 전도사 자격(?)증',
  '열정적인 포교왕 인정서',
  '신흥 교단장 임명장',
  '대교주 임명장',
  '우주급 절대교주 임명장',
]

/** 카드에 찍을 직급 이름: 최고 직급 뒤에는 '우주급 절대교주 N회차' */
export function rankLabel(p: Pick<ShareProfile, 'rank' | 'inf'>): string {
  return rankTitle(p.rank, p.inf)
}

export function certTitle(rank: number): string {
  return CERT_TITLES[Math.max(0, Math.min(CERT_TITLES.length - 1, Math.floor(rank)))] ?? CERT_TITLES[0]!
}

/** 발급번호: pid+날짜 해시 → "2026-1126-4F3A" */
export function issueNo(hash: number, date: { y: number; m: number; d: number }): string {
  const hx = (hash & 0xffff).toString(16).toUpperCase().padStart(4, '0')
  return `${date.y}-${String(date.m).padStart(2, '0')}${String(date.d).padStart(2, '0')}-${hx}`
}

/** 공유 시트에 같이 넣을 한 줄(링크는 따로 붙인다) */
export function shareLine(type: 'certificate' | 'summary' | 'meme', rankName: string, verdict?: Verdict): string {
  if (type === 'certificate') return `나 오늘부터 ${rankName}(효력 없음) 🙏 너도 수상한 거리 와 봐`
  if (type === 'summary') return `오늘의 포교 결산: 나는 ${verdict?.name ?? '애매하게 수상한형'} 교주였다 🙏`
  return '오늘도 시민께서 현명한 선택을 하셨습니다 📸'
}
