/**
 * 월드 콘텐츠(계시·구호·업적·일일 수행·헌납품·말풍선·닉네임·팁·기싸움) 검증.
 * 데이터 파일은 사람이 계속 고치므로, 화면에 넘치는 길이·깨진 id·금지 소재가 섞여 들어오면 여기서 먼저 걸리게 한다.
 */
import { describe, expect, it } from 'vitest'
import { NAME_MAX } from '../../shared/constants'
import * as contentIndex from '../../shared/content'
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BY_ID,
  DAILY_QUESTS,
  DAILY_QUEST_BY_ID,
  DAILY_QUEST_COUNT,
} from '../../shared/content/achievements'
import { MAX_RANK, STAT } from '../../shared/content/core'
import { DISCLAIMER, DUELS, LOADING_TIPS, NICK_ADJ, NICK_NOUN, QUICK_CHATS } from '../../shared/content/misc'
import { OFFER_ITEMS, OFFER_ITEM_BY_ID } from '../../shared/content/offerings'
import { PROPHECIES, PROPHECY_REACTIONS, SERMON_CHANTS, SERMON_CHEERS } from '../../shared/content/prophecies'
import type { AchievementDef } from '../../shared/content/types'
import type { TextCheck } from '../../shared/rules/moderation'

// ───────── 도우미 ─────────

/**
 * 이름 필터(shared/rules/moderation.ts)는 다른 담당의 파일이라 여기서만 동적으로 불러온다.
 * 뼈대 커밋의 그 파일은 정규식 리터럴 안에 줄 구분 문자(U+2028)가 그대로 들어 있어 esbuild/oxc 가 읽지 못한다
 * (tsc 는 통과). 정적 import 로 두면 그 한 줄 때문에 이 파일의 모든 검사가 통째로 죽으므로,
 * 못 읽는 동안에는 checkNickname 검사만 '건너뜀'으로 표시하고 나머지는 그대로 돌린다. 파일이 고쳐지면 자동으로 다시 검사한다.
 */
async function loadCheckNickname(): Promise<((input: unknown) => TextCheck) | null> {
  try {
    const mod = await import('../../shared/rules/moderation')
    return mod.checkNickname
  } catch {
    return null
  }
}

/** 화면에 보이는 글자 수(코드 포인트 기준) */
const len = (s: string): number => Array.from(s).length

/** 목록 안에서 두 번 이상 나온 값 */
function dupes(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out = new Set<string>()
  for (const s of list) {
    if (seen.has(s)) out.add(s)
    seen.add(s)
  }
  return [...out]
}

/** 길이 제한을 넘는 항목(실패 메시지에 어떤 문장인지 보이도록 문자열로 돌려준다) */
function tooLong(list: readonly string[], max: number): string[] {
  return list.filter((s) => len(s) > max).map((s) => `${len(s)}자 > ${max}자: ${s}`)
}

/** 띄어쓰기·문장부호를 지운 형태. "라면교 회원" 처럼 띄어쓰기 너머로 금지어가 생기는 경우까지 잡는다 */
const squash = (s: string): string => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

function hits(text: string, words: readonly string[]): string[] {
  const raw = text.toLowerCase()
  const sq = squash(text)
  return words.filter((w) => raw.includes(w) || sq.includes(w))
}

/** 이모지 하나짜리 아이콘인지: 그림 문자를 포함하고 글자·숫자는 없어야 한다 */
const isEmojiIcon = (s: string): boolean =>
  /\p{Extended_Pictographic}/u.test(s) && !/[\p{L}\p{N}]/u.test(s) && len(s) <= 3

/**
 * 2019년(Emoji 12.0)까지 나온 그림 문자인지. 그 뒤에 추가된 것(🪨 🪠 🫥 등)은 업데이트가 끊긴 기기에서
 * 빈 네모로 보이므로 아이콘으로 쓰지 않는다. 13.0 이후 추가분이 모여 있는 코드 구간만 골라 막는다.
 */
function isWidelySupportedEmoji(s: string): boolean {
  const late = new Set([
    0x1f6d6, 0x1f6d7, 0x1f6dc, 0x1f6dd, 0x1f6de, 0x1f6df, 0x1f6fb, 0x1f6fc, 0x1f7f0, 0x1f90c, 0x1f972, 0x1f977,
    0x1f978, 0x1f979, 0x1f9a3, 0x1f9a4, 0x1f9ab, 0x1f9ac, 0x1f9ad, 0x1f9cb, 0x1f9cc,
  ])
  // U+1FA70 블록 중 12.0 에 이미 있던 것: 발레화·반바지류, 혈액·반창고류, 요요·연, 행성·의자 등
  const early1fa = (cp: number): boolean =>
    (cp >= 0x1fa70 && cp <= 0x1fa73) || (cp >= 0x1fa78 && cp <= 0x1fa7a) || (cp >= 0x1fa80 && cp <= 0x1fa82) || (cp >= 0x1fa90 && cp <= 0x1fa95)
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (late.has(cp)) return false
    if (cp >= 0x1fa70 && cp <= 0x1faff && !early1fa(cp)) return false
    if (cp >= 0x1fb00) return false
  }
  return true
}

/** 모든 문자열에 공통으로 적용하는 깔끔함 검사 */
function untidy(list: readonly string[]): string[] {
  return list.filter((s) => s.length === 0 || s !== s.trim() || /\s{2,}/.test(s) || /[<>&\\\n\t]/.test(s))
}

// 실존 종교·정치를 떠올리게 하는 단어(다른 콘텐츠 작성자와 같은 목록)
const DENY: readonly string[] = [
  '교회', '성당', '스님', '목사', '신부님', '불교', '기독', '천주', '이슬람', '신천지', '통일교', '여호와',
  '하나님', '예수', '부처', '알라', '대통령', '국회의원',
]

// 명백한 욕설·비속어 어근
const PROFANITY: readonly string[] = [
  '시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '좆', '존나', '졸라', 'ㅈㄴ', '개새', '새끼', '지랄', '닥쳐', '꺼져',
  '미친', '염병', '젠장', '빌어먹', '썅', '씹', '엿먹', '섹스', 'fuck', 'shit',
]

/**
 * 닉네임 전용 추가 목록. 임의 닉네임은 서버의 이름 필터를 통과해야 하고, 그 필터는 앞으로 더 엄격해질 수 있다.
 * 그래서 조사 문서(03-satire-comedy-design 6.6절)의 확장 차단어와 흔한 비속어 어근까지 미리 피한다.
 */
const NICK_EXTRA_DENY: readonly string[] = [
  '개신교', '가톨릭', '카톨릭', '정교회', '성공회', '원불교', '천도교', '대종교', '유교', '무슬림', '힌두', '유대교',
  '장로', '감리교', '침례', '성결교', '순복음', '구세군', '조계종', '증거장막', '가정연합', '대순', '진리회', '증산',
  'jms', '구원', '안상홍', '영생교', '천부교', '전도관', '파룬궁', '라엘', '사찰', '법당', '모스크', '성전',
  '선교', '수련원', '전도사', '수녀', '법사', '추기경', '교황', '메시아', '재림', '구세주', '그리스도', '하느님',
  '석가', '미륵', '무함마드', '성모', '상제', '무당', '정당', '운영자', '관리자', 'admin', 'gm',
  '보지', '자지', '젖', '창녀', '걸레', '변태', '호구', '찐따', '멍청', '바보', '쓰레기', '죽어', '자살', '살인',
]

/** 내 담당 파일의 모든 문자열 */
const ALL_STRINGS: readonly string[] = [
  ...PROPHECIES,
  ...SERMON_CHANTS.flatMap((c) => [c.call, c.resp]),
  ...PROPHECY_REACTIONS,
  ...SERMON_CHEERS,
  ...ACHIEVEMENTS.flatMap((a) => [a.name, a.desc]),
  ...DAILY_QUESTS.map((q) => q.text),
  ...OFFER_ITEMS.flatMap((i) => [i.name, i.desc]),
  ...QUICK_CHATS.map((q) => q.text),
  ...NICK_ADJ,
  ...NICK_NOUN,
  ...LOADING_TIPS,
  ...DUELS.flatMap((d) => [d.say, ...d.choices, d.winText, d.loseText]),
  DISCLAIMER,
]

const STAT_KEYS: readonly string[] = Object.values(STAT)

// ───────── 검사 도구 자체 점검 ─────────
// 아래 검사들은 "걸린 것이 없다"를 확인하는 방식이라, 도우미가 고장 나면 조용히 전부 통과해 버린다.
// 그래서 일부러 걸려야 하는 입력으로 도우미부터 확인한다.

describe('검사 도우미', () => {
  it('글자 수는 코드 포인트로 센다', () => {
    expect(len('한글 3자')).toBe(5)
    expect(len('🧦')).toBe(1)
  })

  it('금지어를 띄어쓰기·문장부호 너머로도 찾는다', () => {
    expect(hits('라면교 회원 모집', DENY)).toEqual(['교회'])
    expect(hits('명예 수달', DENY)).toEqual(['예수'])
    expect(hits('전부, 처음입니다', DENY)).toEqual(['부처'])
    expect(hits('수상한 행인', [...DENY, ...PROFANITY, ...NICK_EXTRA_DENY])).toEqual([])
  })

  it('중복·길이 초과·지저분한 문자열을 골라낸다', () => {
    expect(dupes(['가', '나', '가'])).toEqual(['가'])
    expect(tooLong(['짧다', '이건 좀 길다'], 3)).toHaveLength(1)
    expect(untidy(['정상', ' 앞공백', '이중  공백', '<b>', ''])).toHaveLength(4)
  })

  it('아이콘은 이모지 하나만 인정한다', () => {
    for (const ok of ['🧦', '🎟️', '☘️', '➰', '🚽']) expect(isEmojiIcon(ok), ok).toBe(true)
    for (const no of ['', 'A', '1', '가', '🧦🧦🧦🧦']) expect(isEmojiIcon(no), no).toBe(false)
    for (const ok of ['🧦', '🪐', '🪑', '🟡', '🧃']) expect(isWidelySupportedEmoji(ok), ok).toBe(true)
    for (const no of ['🪨', '🪠', '🪶', '🫥', '🥲']) expect(isWidelySupportedEmoji(no), no).toBe(false)
  })
})

// ───────── 계시 / 설교 ─────────

describe('오늘의 계시', () => {
  it('120개 이상, 46자 이하, 중복 없음', () => {
    expect(PROPHECIES.length).toBeGreaterThanOrEqual(120)
    expect(tooLong(PROPHECIES, 46)).toEqual([])
    expect(dupes(PROPHECIES)).toEqual([])
  })

  it('명세의 예시 4개를 그대로 유지한다', () => {
    for (const s of [
      '내일은 오늘보다 하루 뒤입니다.',
      '배고픈 자에게 치킨이 찾아올지어다.',
      '월요일을 견딘 자, 화요일을 맞이하리라.',
      '신도들이여, 오늘 저녁 메뉴는 김치찌개다!',
    ]) {
      expect(PROPHECIES).toContain(s)
    }
  })

  it('실제 피해·질병·죽음·당첨·투자처럼 믿고 행동할 수 있는 예언이 없다', () => {
    const banned = [
      '사망', '죽', '질병', '암에', '병원', '수술', '재앙', '종말', '멸망', '로또', '복권', '당첨', '주식', '코인',
      '투자', '횡재', '대박', '부자', '사고가', '교통사고', '이혼', '합격', '불합격',
    ]
    const bad = PROPHECIES.filter((p) => hits(p, banned).length > 0)
    expect(bad).toEqual([])
  })

  it('경전 번역 문체("복이 있나니" 등)에 기대지 않는다', () => {
    const scripture = ['복이 있나니', '진실로 이르노니', '새 하늘', '심판', '천국', '지옥', '구원']
    expect(PROPHECIES.filter((p) => hits(p, scripture).length > 0)).toEqual([])
  })
})

describe('집단 설교 구호와 반응', () => {
  it('구호 24쌍 이상, 선창 22자 / 후창 10자 이하, 선창 중복 없음', () => {
    expect(SERMON_CHANTS.length).toBeGreaterThanOrEqual(24)
    expect(tooLong(SERMON_CHANTS.map((c) => c.call), 22)).toEqual([])
    expect(tooLong(SERMON_CHANTS.map((c) => c.resp), 10)).toEqual([])
    expect(dupes(SERMON_CHANTS.map((c) => c.call))).toEqual([])
    expect(SERMON_CHANTS.map((c) => c.call)).toContain('퇴근을 믿습니까?')
  })

  it('후창은 외치는 말이므로 느낌표로 끝난다', () => {
    expect(SERMON_CHANTS.filter((c) => !c.resp.endsWith('!')).map((c) => c.resp)).toEqual([])
  })

  it('계시 반응·설교 환호 각각 24개 이상, 16자 이하, 중복 없음', () => {
    for (const list of [PROPHECY_REACTIONS, SERMON_CHEERS]) {
      expect(list.length).toBeGreaterThanOrEqual(24)
      expect(tooLong(list, 16)).toEqual([])
      expect(dupes(list)).toEqual([])
    }
  })
})

// ───────── 업적 / 일일 수행 ─────────

describe('업적', () => {
  it('48개 이상, id·이름이 유일하고 조회 맵과 일치한다', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(48)
    expect(dupes(ACHIEVEMENTS.map((a) => a.id))).toEqual([])
    expect(dupes(ACHIEVEMENTS.map((a) => a.name))).toEqual([])
    expect(dupes(ACHIEVEMENTS.map((a) => a.desc))).toEqual([])
    expect(ACHIEVEMENT_BY_ID.size).toBe(ACHIEVEMENTS.length)
    for (const a of ACHIEVEMENTS) expect(ACHIEVEMENT_BY_ID.get(a.id)).toBe(a)
  })

  it('필드 형식: id, 존재하는 STAT, 문턱값, 보상 5~150, 이름 14자, 설명 44자, 이모지 아이콘', () => {
    const bad: string[] = []
    for (const a of ACHIEVEMENTS) {
      if (!/^[a-z][a-z0-9_]{1,23}$/.test(a.id)) bad.push(`${a.id}: id 형식`)
      if (!STAT_KEYS.includes(a.stat)) bad.push(`${a.id}: 없는 통계 ${a.stat}`)
      if (!Number.isInteger(a.gte) || a.gte < 1) bad.push(`${a.id}: gte ${a.gte}`)
      if (!Number.isInteger(a.inf) || a.inf < 5 || a.inf > 150) bad.push(`${a.id}: inf ${a.inf}`)
      if (len(a.name) > 14) bad.push(`${a.id}: 이름 ${len(a.name)}자`)
      if (len(a.desc) > 44) bad.push(`${a.id}: 설명 ${len(a.desc)}자`)
      if (!isEmojiIcon(a.icon)) bad.push(`${a.id}: 아이콘 ${a.icon}`)
      if (a.secret !== undefined && a.secret !== true) bad.push(`${a.id}: secret 은 true 이거나 생략`)
    }
    expect(bad).toEqual([])
  })

  it('오르내리는 현재 값 통계(streak, failStreak)는 조건으로 쓰지 않는다', () => {
    expect(ACHIEVEMENTS.filter((a) => a.stat === STAT.streak || a.stat === STAT.failStreak).map((a) => a.id)).toEqual([])
  })

  it('기존 업적 5개의 id·조건·보상이 그대로다', () => {
    const kept: Array<[string, string, number, number]> = [
      ['first_join', 'joins', 1, 5],
      ['fail10', 'worstStreak', 10, 20],
      ['reject100', 'rejects', 100, 50],
      ['king3', 'kings', 3, 30],
      ['fol50', 'joins', 50, 60],
    ]
    for (const [id, stat, gte, inf] of kept) {
      const a = ACHIEVEMENT_BY_ID.get(id)
      expect(a, id).toBeDefined()
      expect([a?.stat, a?.gte, a?.inf]).toEqual([stat, gte, inf])
    }
  })

  it('주요 통계마다 정해진 단계가 있다', () => {
    const ladder: Record<string, number[]> = {
      joins: [1, 10, 50, 200, 1000],
      rejects: [10, 100, 500],
      worstStreak: [5, 10],
      bestStreak: [3, 7, 12],
      kings: [1, 3, 10],
      catTalks: [1, 20],
      catJoins: [1],
      days: [2, 7, 30],
    }
    const missing: string[] = []
    for (const [stat, steps] of Object.entries(ladder)) {
      for (const gte of steps) {
        if (!ACHIEVEMENTS.some((a) => a.stat === stat && a.gte === gte)) missing.push(`${stat} >= ${gte}`)
      }
    }
    expect(missing).toEqual([])

    const covered = [
      'flees', 'ignores', 'rivals', 'rivalWins', 'emotes', 'dances', 'says', 'prophecies', 'sermonsLed',
      'sermonsJoined', 'battles', 'battleWins', 'offerings', 'caught', 'escapes', 'sprints', 'invites', 'recruits',
      'joinedCults', 'cultsMade', 'poaches',
    ]
    expect(covered.filter((s) => !ACHIEVEMENTS.some((a) => a.stat === s))).toEqual([])
  })

  it('같은 통계 안에서 조건이 겹치지 않고, 어려울수록 보상이 줄지 않는다', () => {
    const bad: string[] = []
    const byStat = new Map<string, AchievementDef[]>()
    for (const a of ACHIEVEMENTS) byStat.set(a.stat, [...(byStat.get(a.stat) ?? []), a])
    for (const [stat, list] of byStat) {
      const sorted = [...list].sort((x, y) => x.gte - y.gte)
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!
        const cur = sorted[i]!
        if (cur.gte === prev.gte) bad.push(`${stat}: ${prev.id}/${cur.id} 조건 중복`)
        if (cur.inf < prev.inf) bad.push(`${stat}: ${cur.id} 보상이 ${prev.id} 보다 작다`)
      }
    }
    expect(bad).toEqual([])
  })

  it('비밀 업적은 전체의 4분의 1쯤이고, 고양이 신도는 비밀 전설 업적이다', () => {
    const ratio = ACHIEVEMENTS.filter((a) => a.secret).length / ACHIEVEMENTS.length
    expect(ratio).toBeGreaterThanOrEqual(0.17)
    expect(ratio).toBeLessThanOrEqual(0.33)
    const cat = ACHIEVEMENTS.find((a) => a.stat === STAT.catJoins)
    expect(cat?.secret).toBe(true)
    expect(cat?.inf).toBe(150)
  })
})

describe('일일 수행', () => {
  it('14개 이상, id 는 d_ 로 시작하고 유일하며 조회 맵과 일치한다', () => {
    expect(DAILY_QUESTS.length).toBeGreaterThanOrEqual(14)
    expect(DAILY_QUESTS.filter((q) => !/^d_[a-z0-9_]{1,21}$/.test(q.id)).map((q) => q.id)).toEqual([])
    expect(dupes(DAILY_QUESTS.map((q) => q.id))).toEqual([])
    expect(dupes(DAILY_QUESTS.map((q) => q.text))).toEqual([])
    expect(DAILY_QUEST_BY_ID.size).toBe(DAILY_QUESTS.length)
    for (const id of ['d_pitch5', 'd_join2', 'd_dance3']) expect(DAILY_QUEST_BY_ID.has(id), id).toBe(true)
  })

  it('하루에 3개를 뽑고, 뽑을 만큼 충분히 있다', () => {
    expect(DAILY_QUEST_COUNT).toBe(3)
    expect(DAILY_QUESTS.length).toBeGreaterThanOrEqual(DAILY_QUEST_COUNT)
  })

  it('존재하는 STAT, 작은 목표치, 보상 10~30, 문구 22자 이하', () => {
    const bad: string[] = []
    for (const q of DAILY_QUESTS) {
      if (!STAT_KEYS.includes(q.stat)) bad.push(`${q.id}: 없는 통계 ${q.stat}`)
      if (!Number.isInteger(q.n) || q.n < 1 || q.n > 15) bad.push(`${q.id}: n ${q.n}`)
      if (!Number.isInteger(q.inf) || q.inf < 10 || q.inf > 30) bad.push(`${q.id}: inf ${q.inf}`)
      if (len(q.text) > 22) bad.push(`${q.id}: 문구 ${len(q.text)}자`)
    }
    expect(bad).toEqual([])
  })

  it('하루 증가량으로 셀 수 없거나 혼자서는 못 끝내는 통계를 쓰지 않는다', () => {
    const unfit: readonly string[] = [
      // 오르내리는 현재 값·최고 기록·접속 일수
      STAT.streak, STAT.failStreak, STAT.bestStreak, STAT.worstStreak, STAT.days,
      // 다른 접속자가 있어야 하는 것
      STAT.battles, STAT.battleWins, STAT.invites, STAT.recruits, STAT.joinedCults, STAT.sermonsJoined, STAT.poaches,
      // 등장 여부가 운에 달린 것
      STAT.kings, STAT.rivals, STAT.rivalWins, STAT.catTalks, STAT.catJoins, STAT.caught, STAT.escapes,
    ]
    expect(DAILY_QUESTS.filter((q) => unfit.includes(q.stat)).map((q) => q.id)).toEqual([])
  })

  it('같은 통계의 수행은 목표가 클수록 보상도 크다', () => {
    const bad: string[] = []
    for (const a of DAILY_QUESTS) {
      for (const b of DAILY_QUESTS) {
        if (a.stat === b.stat && a.n < b.n && a.inf >= b.inf) bad.push(`${a.id} / ${b.id}`)
        if (a !== b && a.stat === b.stat && a.n === b.n) bad.push(`${a.id} = ${b.id}`)
      }
    }
    expect(bad).toEqual([])
  })
})

// ───────── 헌납품 ─────────

describe('헌납품', () => {
  it('80개 이상, id·이름·설명이 유일하고 조회 맵과 일치한다', () => {
    expect(OFFER_ITEMS.length).toBeGreaterThanOrEqual(80)
    expect(dupes(OFFER_ITEMS.map((i) => i.id))).toEqual([])
    expect(dupes(OFFER_ITEMS.map((i) => i.name))).toEqual([])
    expect(dupes(OFFER_ITEMS.map((i) => i.desc))).toEqual([])
    expect(OFFER_ITEM_BY_ID.size).toBe(OFFER_ITEMS.length)
    for (const id of ['sock', 'coupon9', 'kimbap', 'lotto', 'gold_remote']) expect(OFFER_ITEM_BY_ID.has(id), id).toBe(true)
  })

  it('필드 형식: ascii snake_case id(저장 키 한도 24자), 이름 16자, 설명 44자, 이모지 아이콘', () => {
    const bad: string[] = []
    for (const i of OFFER_ITEMS) {
      // normalizeProgress 가 24자를 넘는 도감 키를 버리므로 id 가 길면 수집 기록이 사라진다
      if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(i.id) || i.id.length > 24) bad.push(`${i.id}: id 형식`)
      if (len(i.name) > 16) bad.push(`${i.id}: 이름 ${len(i.name)}자`)
      if (len(i.desc) > 44) bad.push(`${i.id}: 설명 ${len(i.desc)}자`)
      if (!isEmojiIcon(i.icon)) bad.push(`${i.id}: 아이콘 ${i.icon}`)
    }
    expect(bad).toEqual([])
  })

  it('코인은 희귀도별 범위 안이다 (1~3 / 4~8 / 10~25 / 40~100)', () => {
    const range: Record<number, [number, number]> = { 1: [1, 3], 2: [4, 8], 3: [10, 25], 4: [40, 100] }
    const bad: string[] = []
    for (const i of OFFER_ITEMS) {
      const r = range[i.rarity]
      if (!r) bad.push(`${i.id}: 희귀도 ${i.rarity}`)
      else if (!Number.isInteger(i.coins) || i.coins < r[0] || i.coins > r[1]) bad.push(`${i.id}: 코인 ${i.coins}`)
    }
    expect(bad).toEqual([])
  })

  it('희귀도 비율이 50 / 28 / 16 / 6 % 에서 ±8%p 안이다', () => {
    const target: Record<number, number> = { 1: 50, 2: 28, 3: 16, 4: 6 }
    for (const [rarity, pct] of Object.entries(target)) {
      const actual = (OFFER_ITEMS.filter((i) => i.rarity === Number(rarity)).length / OFFER_ITEMS.length) * 100
      expect(Math.abs(actual - pct), `희귀도 ${rarity}: ${actual.toFixed(1)}%`).toBeLessThanOrEqual(8)
    }
    // 전설은 정말 드물어야 하지만 도감에 채울 칸은 있어야 한다
    expect(OFFER_ITEMS.filter((i) => i.rarity === 4).length).toBeGreaterThanOrEqual(4)
  })

  it('실제 돈·약물·술담배·무기·개인정보를 닮은 물건이 없다', () => {
    const banned = [
      '현금', '지폐', '동전', '통장', '계좌', '신용카드', '체크카드', '상품권', '금괴', '수표', '만 원', '천 원',
      '주민등록', '신분증', '여권', '전화번호', '연락처', '주소', '명함',
      '소주', '맥주', '막걸리', '와인', '담배', '마약', '약병', '알약', '주사기', '권총', '식칼', '흉기', '폭탄',
    ]
    const bad = OFFER_ITEMS.filter((i) => hits(`${i.name} ${i.desc}`, banned).length > 0).map((i) => i.id)
    expect(bad).toEqual([])
    // 화폐 기호도 쓰지 않는다(가상 코인은 숫자 필드로만 존재한다)
    expect(OFFER_ITEMS.filter((i) => /[₩$€¥]/.test(i.name + i.desc)).map((i) => i.id)).toEqual([])
  })
})

// ───────── 말풍선 / 닉네임 / 팁 / 기싸움 ─────────

describe('말풍선(퀵챗)', () => {
  it('30개 이상, id 는 배열 인덱스, 18자 이하, 중복 없음', () => {
    expect(QUICK_CHATS.length).toBeGreaterThanOrEqual(30)
    QUICK_CHATS.forEach((q, i) => expect(q.id).toBe(i))
    expect(tooLong(QUICK_CHATS.map((q) => q.text), 18)).toEqual([])
    expect(dupes(QUICK_CHATS.map((q) => q.text))).toEqual([])
    expect(QUICK_CHATS.filter((q) => !isEmojiIcon(q.icon)).map((q) => q.id)).toEqual([])
  })

  it('기존 6개는 id 와 문구가 그대로다', () => {
    expect(QUICK_CHATS.slice(0, 6).map((q) => [q.id, q.text, q.rank])).toEqual([
      [0, '도를 아십니까?', 0],
      [1, '인상이 참 좋으시네요!', 0],
      [2, '저 지금 바빠요!', 0],
      [3, '믿습니다!', 0],
      [4, '저희 교단으로 오세요~', 0],
      [5, 'ㅋㅋㅋㅋㅋ', 0],
    ])
  })

  it('직급 0 에 10개 안팎, 나머지는 직급 1~5 에 고루 퍼져 있다', () => {
    const count = (r: number): number => QUICK_CHATS.filter((q) => q.rank === r).length
    expect(QUICK_CHATS.every((q) => Number.isInteger(q.rank) && q.rank >= 0 && q.rank <= MAX_RANK)).toBe(true)
    expect(count(0)).toBeGreaterThanOrEqual(8)
    expect(count(0)).toBeLessThanOrEqual(13)
    for (let r = 1; r <= MAX_RANK; r++) expect(count(r), `직급 ${r}`).toBeGreaterThanOrEqual(3)
    // 목록을 직급순으로 두면 UI 가 그대로 잘라 보여 줄 수 있다
    for (let i = 1; i < QUICK_CHATS.length; i++) expect(QUICK_CHATS[i]!.rank).toBeGreaterThanOrEqual(QUICK_CHATS[i - 1]!.rank)
  })
})

describe('임의 닉네임 재료', () => {
  it('형용사·명사 각각 48개 이상, 5자 이하, 중복 없음', () => {
    for (const list of [NICK_ADJ, NICK_NOUN]) {
      expect(list.length).toBeGreaterThanOrEqual(48)
      expect(tooLong(list, 5)).toEqual([])
      expect(dupes(list)).toEqual([])
      // 붙여 쓰는 재료라 공백·기호가 있으면 안 된다
      expect(list.filter((s) => !/^[가-힣]+$/.test(s))).toEqual([])
    }
  })

  it('모든 조합이 NAME_MAX 이하다', () => {
    const bad: string[] = []
    for (const adj of NICK_ADJ) {
      for (const noun of NICK_NOUN) {
        if (len(adj + noun) > NAME_MAX) bad.push(`${adj + noun}: ${len(adj + noun)}자`)
      }
    }
    expect(bad).toEqual([])
  })

  it('모든 조합이 checkNickname 을 그대로 통과한다', async (ctx) => {
    const checkNickname = await loadCheckNickname()
    if (!checkNickname) {
      console.warn(
        '[content-world] shared/rules/moderation.ts 를 불러오지 못해 checkNickname 검사를 건너뜁니다. ' +
          '정규식 리터럴 안의 U+2028 문자를 \\u2028 표기로 바꾸면 다시 검사합니다.',
      )
      ctx.skip()
      return
    }
    const bad: string[] = []
    for (const adj of NICK_ADJ) {
      for (const noun of NICK_NOUN) {
        const name = adj + noun
        const res = checkNickname(name)
        if (!res.ok) bad.push(`${name}: ${res.why}`)
        else if (res.text !== name) bad.push(`${name}: 필터가 '${res.text}' 로 바꿈`)
      }
    }
    expect(bad).toEqual([])
  })

  it('이어 붙인 경계에서 금지어·비속어·실존 종교 용어가 생기지 않는다', () => {
    const words = [...DENY, ...PROFANITY, ...NICK_EXTRA_DENY]
    const bad: string[] = []
    for (const adj of NICK_ADJ) {
      for (const noun of NICK_NOUN) {
        const found = hits(adj + noun, words)
        if (found.length > 0) bad.push(`${adj + noun}: ${found.join(',')}`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('로딩 팁', () => {
  it('30개 이상, 44자 이하, 중복 없음', () => {
    expect(LOADING_TIPS.length).toBeGreaterThanOrEqual(30)
    expect(tooLong(LOADING_TIPS, 44)).toEqual([])
    expect(dupes(LOADING_TIPS)).toEqual([])
  })

  it('전부 허구인 풍자라는 안내와 현실에서는 거절해도 된다는 안내가 각각 들어 있다', () => {
    const fiction = LOADING_TIPS.filter((t) => /허구|풍자|가짜/.test(t))
    const sayNo = LOADING_TIPS.filter((t) => /현실/.test(t) && /거절|사양|지나가/.test(t))
    expect(fiction.length).toBeGreaterThanOrEqual(2)
    expect(sayNo.length).toBeGreaterThanOrEqual(2)
    expect(new Set([...fiction, ...sayNo]).size).toBeGreaterThanOrEqual(3)
  })

  it('상수에서 가져온 수치가 문장에 제대로 들어갔다', () => {
    expect(LOADING_TIPS.filter((t) => /NaN|undefined|\$\{/.test(t))).toEqual([])
  })
})

describe('라이벌 기싸움', () => {
  it('16판 이상, 라이벌 멘트 44자 / 선택지 26자 / 결과 대사 40자 이하', () => {
    expect(DUELS.length).toBeGreaterThanOrEqual(16)
    expect(tooLong(DUELS.map((d) => d.say), 44)).toEqual([])
    expect(tooLong(DUELS.flatMap((d) => d.choices), 26)).toEqual([])
    expect(tooLong(DUELS.flatMap((d) => [d.winText, d.loseText]), 40)).toEqual([])
    expect(dupes(DUELS.map((d) => d.say))).toEqual([])
  })

  it('선택지는 정확히 3개, 정답은 1~2개이고 전부 정답인 판은 없다', () => {
    const bad: string[] = []
    for (const d of DUELS) {
      if (d.choices.length !== 3) bad.push(`${d.say}: 선택지 ${d.choices.length}개`)
      if (dupes(d.choices).length > 0) bad.push(`${d.say}: 선택지 중복`)
      if (d.win.length < 1 || d.win.length > 2) bad.push(`${d.say}: 정답 ${d.win.length}개`)
      if (new Set(d.win).size !== d.win.length) bad.push(`${d.say}: 정답 인덱스 중복`)
      if (d.win.some((w) => !Number.isInteger(w) || w < 0 || w > 2)) bad.push(`${d.say}: 정답 인덱스 범위`)
      if (d.winText === d.loseText) bad.push(`${d.say}: 결과 대사가 같다`)
    }
    expect(bad).toEqual([])
  })

  it('정답 위치가 한쪽으로 쏠리지 않는다', () => {
    for (const idx of [0, 1, 2]) {
      const n = DUELS.filter((d) => d.win.includes(idx)).length
      expect(n / DUELS.length, `정답 위치 ${idx}: ${n}판`).toBeGreaterThanOrEqual(0.25)
      expect(n / DUELS.length, `정답 위치 ${idx}: ${n}판`).toBeLessThanOrEqual(0.55)
    }
    // 정답이 하나인 판과 둘인 판이 모두 있어야 '둘 중 하나 찍기'로 굳지 않는다
    expect(DUELS.some((d) => d.win.length === 1)).toBe(true)
    expect(DUELS.some((d) => d.win.length === 2)).toBe(true)
  })

  it('실존 종교의 기적 이야기를 닮은 허세가 없다', () => {
    const miracle = ['물 위', '부활', '병을 고', '치유', '승천', '기적']
    const bad = DUELS.filter((d) => hits([d.say, ...d.choices, d.winText, d.loseText].join(' '), miracle).length > 0)
    expect(bad.map((d) => d.say)).toEqual([])
  })
})

describe('고지 문구', () => {
  it('허구 풍자, 실존 종교·단체·인물과 무관, 실제 포교·금전·개인정보 없음을 모두 밝힌다', () => {
    for (const word of ['허구', '풍자', '실존', '종교', '단체', '인물', '무관', '포교', '금전', '개인정보']) {
      expect(DISCLAIMER, word).toContain(word)
    }
  })
})

// ───────── 전체 문자열 공통 검사 ─────────

describe('전체 문자열', () => {
  it('실존 종교·정치를 떠올리게 하는 단어가 없다(띄어쓰기를 지운 형태까지 검사)', () => {
    // 고지 문구는 "실존 종교와 무관"을 말해야 하므로 '종교' 자체는 금지어가 아니다
    const bad = ALL_STRINGS.map((s) => ({ s, found: hits(s, DENY) })).filter((x) => x.found.length > 0)
    expect(bad).toEqual([])
  })

  it('욕설·비속어가 없다', () => {
    const bad = ALL_STRINGS.map((s) => ({ s, found: hits(s, PROFANITY) })).filter((x) => x.found.length > 0)
    expect(bad).toEqual([])
  })

  it('실제 권유 수법의 다음 단계(연락처·제사·합숙 등)나 실존 종교 구호를 닮은 표현이 없다', () => {
    const banned = [
      '연락처', '전화번호', '제사', '절값', '치성', '천도', '합숙', '입금', '송금', '계좌',
      '아멘', '할렐루야', '나무아미타불', '관세음', '십일조', '성불', '휴거', '간증', '안수', '부적', '굿판',
    ]
    const bad = ALL_STRINGS.map((s) => ({ s, found: hits(s, banned) })).filter((x) => x.found.length > 0)
    expect(bad).toEqual([])
  })

  it('아이콘은 오래된 기기에서도 보이는 이모지만 쓴다(Emoji 12.0 이하)', () => {
    const icons = [...ACHIEVEMENTS.map((a) => a.icon), ...OFFER_ITEMS.map((i) => i.icon), ...QUICK_CHATS.map((q) => q.icon)]
    expect(icons.filter((i) => !isWidelySupportedEmoji(i))).toEqual([])
  })

  it('앞뒤 공백·이중 공백·HTML 로 오해될 문자가 없다', () => {
    expect(untidy(ALL_STRINGS)).toEqual([])
    expect(untidy(ACHIEVEMENTS.map((a) => a.icon))).toEqual([])
    expect(untidy(OFFER_ITEMS.map((i) => i.icon))).toEqual([])
  })

  it('shared/content 의 index 로도 같은 데이터를 꺼낼 수 있다', () => {
    expect(contentIndex.PROPHECIES).toBe(PROPHECIES)
    expect(contentIndex.SERMON_CHANTS).toBe(SERMON_CHANTS)
    expect(contentIndex.ACHIEVEMENTS).toBe(ACHIEVEMENTS)
    expect(contentIndex.DAILY_QUESTS).toBe(DAILY_QUESTS)
    expect(contentIndex.OFFER_ITEMS).toBe(OFFER_ITEMS)
    expect(contentIndex.QUICK_CHATS).toBe(QUICK_CHATS)
    expect(contentIndex.DUELS).toBe(DUELS)
    expect(contentIndex.LOADING_TIPS).toBe(LOADING_TIPS)
  })
})
