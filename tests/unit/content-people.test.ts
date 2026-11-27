/**
 * 포교 멘트(lines.ts)와 시민 유형(archetypes.ts) 검증.
 * 데이터 파일이라 사람이 한 줄 고치다 깨뜨리기 쉽다 — 스키마 규칙, 가드레일(금칙어), 밸런스를 자동으로 지킨다.
 */
import { describe, expect, it } from 'vitest'
import { LINES_PER_TALK } from '../../shared/constants'
import { ARCHETYPE_BY_ID, ARCHETYPES } from '../../shared/content/archetypes'
import { ARCHETYPE_INFO, ARCHETYPE_INFO_BY_ID } from '../../shared/content/archetypeInfo'
import { ACCESSORIES, FACES, HATS, MAX_RANK, OUTFIT_COLORS, OUTFITS } from '../../shared/content/core'
import { PITCH_LINES } from '../../shared/content/lines'
import { PITCH_CATEGORIES } from '../../shared/content/types'
import type { Archetype, PitchCategory, PitchLine, ReactionSet } from '../../shared/content/types'
import { JOIN_CHANCE_MIN, type PitchContext, joinChance, pickLines, resolvePitch } from '../../shared/rules/pitch'
import { mulberry32, pick, pickWeighted } from '../../shared/rng'
import type { PitchOutcome } from '../../shared/types'

const LINE_MAX = 34
const SAY_MAX = 40
const NAME_TAG_MAX = 12

const REACTION_KEYS = ['join', 'more', 'no', 'flee', 'ignore'] as const

/** 사용자가 보는 글자 수(서로게이트 쌍도 1자로 센다) */
const len = (s: string): number => Array.from(s).length

interface Tagged {
  /** 어디에 있는 문자열인지(실패 메시지용) */
  where: string
  text: string
}

function reactionStrings(prefix: string, set: ReactionSet | undefined): Tagged[] {
  if (!set) return []
  return REACTION_KEYS.flatMap((k) => (set[k] ?? []).map((text) => ({ where: `${prefix}.${k}`, text })))
}

/** 말풍선으로 뜨는 대사 전부 */
function spokenStrings(a: Archetype): Tagged[] {
  const out: Tagged[] = []
  const add = (key: string, arr: readonly string[]): void => {
    for (const text of arr) out.push({ where: `${a.id}.${key}`, text })
  }
  add('greet', a.greet)
  add('mutter', a.mutter)
  add('follow', a.follow)
  add('leave', a.leave)
  out.push(...reactionStrings(`${a.id}.re`, a.re))
  for (const c of PITCH_CATEGORIES) out.push(...reactionStrings(`${a.id}.catRe.${c}`, a.catRe?.[c]))
  return out
}

/** 유형이 가진 모든 사용자 노출 문자열(이름표·도감 포함) */
function allStrings(a: Archetype): Tagged[] {
  return [
    { where: `${a.id}.name`, text: a.name },
    { where: `${a.id}.desc`, text: a.desc },
    ...a.names.map((text) => ({ where: `${a.id}.names`, text })),
    ...spokenStrings(a),
  ]
}

const LINE_STRINGS: Tagged[] = PITCH_LINES.map((l) => ({ where: `line#${l.id}`, text: l.text }))
const ARCH_STRINGS: Tagged[] = ARCHETYPES.flatMap(allStrings)
const EVERY_STRING: Tagged[] = [...LINE_STRINGS, ...ARCH_STRINGS]

function findHits(strings: readonly Tagged[], words: readonly string[]): string[] {
  const hits: string[] = []
  for (const s of strings) {
    const lower = s.text.toLowerCase()
    for (const w of words) if (lower.includes(w.toLowerCase())) hits.push(`${s.where}: "${s.text}" ← ${w}`)
  }
  return hits
}

const ctx = (over: Partial<PitchContext> = {}): PitchContext => ({
  rank: 0,
  streak: 0,
  failStreak: 0,
  round: 1,
  buff: 0,
  poach: false,
  ...over,
})

/** 소재만 다른 '중립 멘트'로 본 합류 확률(멘트 보정 0) */
function chanceFor(a: Archetype, cat: PitchCategory): number {
  return joinChance(a, { id: -1, text: '', cat, rank: 0, power: 0 }, ctx())
}

const lineAt = (id: number): PitchLine => {
  const l = PITCH_LINES[id]
  if (!l) throw new Error(`없는 멘트 id ${id}`)
  return l
}

// ───────────────────────── 멘트 ─────────────────────────

describe('PITCH_LINES', () => {
  it('64개 이상이고 id 가 배열 인덱스와 같다', () => {
    expect(PITCH_LINES.length).toBeGreaterThanOrEqual(64)
    PITCH_LINES.forEach((l, i) => expect(l.id, `index ${i}`).toBe(i))
  })

  it('명세 원본 멘트 0~7 은 그대로다', () => {
    const original: PitchLine[] = [
      { id: 0, text: '도를 아십니까?', cat: 'dao', rank: 0, power: 0 },
      { id: 1, text: '혹시 인상이 좋다는 말 들어보셨어요?', cat: 'face', rank: 0, power: 0.02 },
      { id: 2, text: '제가 관상을 조금 볼 줄 아는데요.', cat: 'face', rank: 0, power: 0 },
      { id: 3, text: '잠깐이면 됩니다. 정말 1분만요.', cat: 'time', rank: 0, power: -0.03, fleeBias: 0.25 },
      { id: 4, text: '전생에 아주 귀한 분이셨습니다.', cat: 'past', rank: 0, power: 0.03 },
      { id: 5, text: '오늘 저를 만난 건 우연이 아닙니다.', cat: 'fate', rank: 0, power: 0 },
      { id: 6, text: '혹시 조상님께서 꿈에 나오신 적 있나요?', cat: 'ancestor', rank: 0, power: 0.02 },
      { id: 7, text: '오늘부터 좋은 기운을 받아 가세요.', cat: 'energy', rank: 0, power: 0.01 },
    ]
    expect(PITCH_LINES.slice(0, 8)).toEqual(original)
  })

  it(`문구는 비어 있지 않고 ${LINE_MAX}자 이하이며 중복이 없다`, () => {
    const seen = new Set<string>()
    for (const l of PITCH_LINES) {
      expect(l.text.trim(), `line#${l.id}`).toBe(l.text)
      expect(len(l.text), `line#${l.id} "${l.text}"`).toBeGreaterThan(0)
      expect(len(l.text), `line#${l.id} "${l.text}"`).toBeLessThanOrEqual(LINE_MAX)
      expect(seen.has(l.text), `중복 멘트 "${l.text}"`).toBe(false)
      seen.add(l.text)
    }
  })

  it('소재·직급·보정값이 허용 범위 안이다', () => {
    for (const l of PITCH_LINES) {
      expect(PITCH_CATEGORIES, `line#${l.id}`).toContain(l.cat)
      expect(Number.isInteger(l.rank), `line#${l.id}`).toBe(true)
      expect(l.rank, `line#${l.id}`).toBeGreaterThanOrEqual(0)
      expect(l.rank, `line#${l.id}`).toBeLessThanOrEqual(MAX_RANK)
      expect(l.power, `line#${l.id}`).toBeGreaterThanOrEqual(-0.12)
      expect(l.power, `line#${l.id}`).toBeLessThanOrEqual(0.18)
      if (l.fleeBias !== undefined) {
        expect(l.fleeBias, `line#${l.id}`).toBeGreaterThanOrEqual(0.1)
        expect(l.fleeBias, `line#${l.id}`).toBeLessThanOrEqual(0.45)
      }
    }
  })

  it('대부분의 멘트는 보정이 0 근처다(상성이 주인공이어야 한다)', () => {
    const near = PITCH_LINES.filter((l) => Math.abs(l.power) <= 0.08).length
    expect(near / PITCH_LINES.length).toBeGreaterThan(0.7)
  })

  it('소재마다 7개 이상, 직급 0 에 3개 이상, 모든 직급에 1개 이상 있다', () => {
    for (const c of PITCH_CATEGORIES) {
      const ofCat = PITCH_LINES.filter((l) => l.cat === c)
      expect(ofCat.length, c).toBeGreaterThanOrEqual(7)
      expect(ofCat.filter((l) => l.rank === 0).length, `${c} rank0`).toBeGreaterThanOrEqual(3)
      for (let r = 0; r <= MAX_RANK; r++) {
        expect(ofCat.filter((l) => l.rank === r).length, `${c} rank${r}`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('직급이 오를 때마다 새 멘트가 8개 이상 열리고, 평균 보정도 오른다', () => {
    const avgPower = (r: number): number => {
      const ls = PITCH_LINES.filter((l) => l.rank === r && l.fleeBias === undefined)
      return ls.reduce((s, l) => s + l.power, 0) / ls.length
    }
    for (let r = 1; r <= MAX_RANK; r++) {
      expect(PITCH_LINES.filter((l) => l.rank === r).length, `rank${r}`).toBeGreaterThanOrEqual(8)
      expect(avgPower(r), `rank${r} 평균 power`).toBeGreaterThan(avgPower(r - 1))
    }
  })

  it('소재마다 도망 개그(fleeBias) 멘트가 2개 이상, 직급 0 에도 1개 이상 있다', () => {
    for (const c of PITCH_CATEGORIES) {
      const flee = PITCH_LINES.filter((l) => l.cat === c && l.fleeBias !== undefined)
      expect(flee.length, c).toBeGreaterThanOrEqual(2)
      expect(flee.filter((l) => l.rank === 0).length, `${c} rank0`).toBeGreaterThanOrEqual(1)
    }
    // 도망 멘트가 전부가 되면 안 된다("1분만요" 계열인 time 은 예외적으로 많다)
    const share = PITCH_LINES.filter((l) => l.fleeBias !== undefined).length / PITCH_LINES.length
    expect(share).toBeLessThan(0.35)
  })

  it('pickLines 는 어느 직급에서든 소재가 겹치지 않는 멘트 4개를 주고, 2라운드에서도 4개를 준다', () => {
    const rnd = mulberry32(7)
    for (let rank = 0; rank <= MAX_RANK; rank++) {
      for (let i = 0; i < 300; i++) {
        const first = pickLines(rank, rnd)
        expect(first.length).toBe(LINES_PER_TALK)
        expect(new Set(first.map((id) => lineAt(id).cat)).size).toBe(LINES_PER_TALK)
        for (const id of first) expect(lineAt(id).rank).toBeLessThanOrEqual(rank)
        const second = pickLines(rank, rnd, LINES_PER_TALK, first)
        expect(second.length).toBe(LINES_PER_TALK)
        for (const id of second) expect(first).not.toContain(id)
      }
    }
  })
})

// ───────────────────────── 시민 유형 ─────────────────────────

describe('ARCHETYPES', () => {
  it('24종 이상이고 id 가 유일하며 ARCHETYPE_BY_ID 와 일치한다', () => {
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(24)
    const ids = ARCHETYPES.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ARCHETYPE_BY_ID.size).toBe(ARCHETYPES.length)
    for (const a of ARCHETYPES) {
      expect(a.id).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(ARCHETYPE_BY_ID.get(a.id)).toBe(a)
    }
    for (const id of ['office', 'student', 'rival', 'cat']) expect(ARCHETYPE_BY_ID.has(id), id).toBe(true)
  })

  it('클라이언트용 가벼운 표(archetypeInfo)가 전체 표와 같은 순서·id·이름·설명이다', () => {
    expect(ARCHETYPE_INFO.map((a) => ({ id: a.id, name: a.name, desc: a.desc }))).toEqual(
      ARCHETYPES.map((a) => ({ id: a.id, name: a.name, desc: a.desc })),
    )
    expect(ARCHETYPE_INFO_BY_ID.size).toBe(ARCHETYPES.length)
    // 대사·확률은 들어 있지 않다(번들에 실려 상성이 읽히지 않게)
    for (const a of ARCHETYPE_INFO) expect(Object.keys(a).sort()).toEqual(['desc', 'id', 'name'])
  })

  it('특수 유형: 라이벌 1종, 전생의 왕(royal) 2종 이상, 동물은 고양이뿐이다', () => {
    const by = (s: Archetype['special']): string[] => ARCHETYPES.filter((a) => a.special === s).map((a) => a.id)
    expect(by('rival')).toEqual(['rival'])
    expect(by('royal').length).toBeGreaterThanOrEqual(2)
    // 고양이 통계(catTalks/catJoins)가 id 로 세든 special 로 세든 같은 결과가 나오도록 동물은 한 종만 둔다
    expect(by('animal')).toEqual(['cat'])
    for (const a of ARCHETYPES) {
      expect([undefined, 'rival', 'royal', 'animal'], a.id).toContain(a.special)
      if (a.special === 'animal') expect(a.model, a.id).toBe(1)
      else expect(a.model ?? 0, a.id).toBe(0)
    }
  })

  it('숫자 필드가 허용 범위 안이다', () => {
    for (const a of ARCHETYPES) {
      expect(a.weight, `${a.id}.weight`).toBeGreaterThanOrEqual(0.3)
      expect(a.weight, `${a.id}.weight`).toBeLessThanOrEqual(3)
      // 고양이만 기본 확률이 범위 밖으로 낮다("아주 낮은 확률로 합류" — 전설 업적용)
      if (a.special !== 'animal') expect(a.base, `${a.id}.base`).toBeGreaterThanOrEqual(0.12)
      expect(a.base, `${a.id}.base`).toBeGreaterThan(0)
      expect(a.base, `${a.id}.base`).toBeLessThanOrEqual(0.5)
      expect(a.flee, `${a.id}.flee`).toBeGreaterThanOrEqual(0)
      expect(a.flee, `${a.id}.flee`).toBeLessThanOrEqual(0.5)
      expect(a.ignore, `${a.id}.ignore`).toBeGreaterThanOrEqual(0)
      expect(a.ignore, `${a.id}.ignore`).toBeLessThanOrEqual(0.5)
      expect(a.curious, `${a.id}.curious`).toBeGreaterThanOrEqual(0)
      expect(a.curious, `${a.id}.curious`).toBeLessThanOrEqual(0.35)
      expect(a.speed, `${a.id}.speed`).toBeGreaterThanOrEqual(0.7)
      expect(a.speed, `${a.id}.speed`).toBeLessThanOrEqual(1.4)
      for (const [cat, v] of Object.entries(a.like)) {
        expect(PITCH_CATEGORIES, `${a.id}.like`).toContain(cat)
        expect(v, `${a.id}.like.${cat}`).toBeGreaterThanOrEqual(-0.3)
        expect(v, `${a.id}.like.${cat}`).toBeLessThanOrEqual(0.4)
      }
    }
    expect(ARCHETYPE_BY_ID.get('cat')?.base).toBeLessThanOrEqual(0.05)
    expect(ARCHETYPE_BY_ID.get('cat')?.weight).toBeCloseTo(0.6, 5)
    expect(ARCHETYPE_BY_ID.get('rival')?.weight).toBeCloseTo(0.5, 5)
  })

  it('필수 대사 묶음이 규칙만큼 채워져 있다', () => {
    for (const a of ARCHETYPES) {
      expect(a.name.length, `${a.id}.name`).toBeGreaterThan(0)
      expect(a.desc.length, `${a.id}.desc`).toBeGreaterThan(0)
      expect(a.names.length, `${a.id}.names`).toBeGreaterThanOrEqual(5)
      expect(a.greet.length, `${a.id}.greet`).toBeGreaterThanOrEqual(3)
      // 합류 불가 유형은 합류 대사를 두지 않는다(절대 쓰이지 않는 '넘어가는' 대사가 데이터에 남지 않게)
      if (a.recruitable === false) {
        expect(a.re.join ?? [], `${a.id}.re.join`).toEqual([])
        for (const c of PITCH_CATEGORIES) expect(a.catRe?.[c]?.join ?? [], `${a.id}.catRe.${c}.join`).toEqual([])
      } else expect(a.re.join?.length ?? 0, `${a.id}.re.join`).toBeGreaterThanOrEqual(4)
      expect(a.re.no?.length ?? 0, `${a.id}.re.no`).toBeGreaterThanOrEqual(5)
      if (a.curious > 0) expect(a.re.more?.length ?? 0, `${a.id}.re.more`).toBeGreaterThanOrEqual(2)
      // flee 가 0 인 유형도 멘트의 fleeBias 로 도망칠 수 있으므로 도망 대사는 전원 필수
      expect(a.re.flee?.length ?? 0, `${a.id}.re.flee`).toBeGreaterThanOrEqual(3)
      if (a.ignore > 0) expect(a.re.ignore?.length ?? 0, `${a.id}.re.ignore`).toBeGreaterThanOrEqual(3)
      expect(a.mutter.length, `${a.id}.mutter`).toBeGreaterThanOrEqual(4)
      expect(a.follow.length, `${a.id}.follow`).toBeGreaterThanOrEqual(3)
      expect(a.leave.length, `${a.id}.leave`).toBeGreaterThanOrEqual(3)
      // 이 게임은 실패가 더 웃겨야 한다: 거절이 합류보다 적으면 안 된다
      expect(a.re.no?.length ?? 0, `${a.id} no ≥ join`).toBeGreaterThanOrEqual(a.re.join?.length ?? 0)
    }
  })

  it('소재 전용 반응(catRe)이 2개 소재 이상에 있고, 빈 배열이 없다', () => {
    for (const a of ARCHETYPES) {
      const cats = Object.keys(a.catRe ?? {})
      expect(cats.length, `${a.id}.catRe`).toBeGreaterThanOrEqual(2)
      for (const c of cats) {
        expect(PITCH_CATEGORIES, `${a.id}.catRe`).toContain(c)
        const set = a.catRe?.[c as PitchCategory] ?? {}
        const keys = Object.keys(set)
        expect(keys.length, `${a.id}.catRe.${c}`).toBeGreaterThan(0)
        for (const k of keys) {
          expect(REACTION_KEYS as readonly string[], `${a.id}.catRe.${c}`).toContain(k)
          expect(set[k as keyof ReactionSet]?.length ?? 0, `${a.id}.catRe.${c}.${k}`).toBeGreaterThan(0)
        }
      }
      // 가장 좋아하는 소재와 가장 싫어하는 소재에는 전용 반응이 있어야 상성이 '보인다'
      if (a.special !== 'animal') {
        const sorted = PITCH_CATEGORIES.slice().sort((x, y) => (a.like[y] ?? 0) - (a.like[x] ?? 0))
        const best = sorted[0] as PitchCategory
        const worst = sorted[sorted.length - 1] as PitchCategory
        expect(cats, `${a.id} 최애 소재 ${best}`).toContain(best)
        expect(cats, `${a.id} 최악 소재 ${worst}`).toContain(worst)
      }
    }
  })

  it(`대사는 ${SAY_MAX}자 이하, 이름표는 ${NAME_TAG_MAX}자 이하이고 앞뒤 공백·빈 문자열이 없다`, () => {
    for (const s of ARCH_STRINGS) {
      expect(s.text.trim(), s.where).toBe(s.text)
      expect(len(s.text), s.where).toBeGreaterThan(0)
    }
    for (const a of ARCHETYPES) {
      for (const s of spokenStrings(a)) expect(len(s.text), `${s.where} "${s.text}"`).toBeLessThanOrEqual(SAY_MAX)
      for (const n of a.names) expect(len(n), `${a.id}.names "${n}"`).toBeLessThanOrEqual(NAME_TAG_MAX)
      expect(len(a.name), `${a.id}.name`).toBeLessThanOrEqual(14)
      expect(len(a.desc), `${a.id}.desc`).toBeLessThanOrEqual(SAY_MAX)
    }
  })

  it('한 묶음 안에 같은 대사가 두 번 들어가지 않는다', () => {
    for (const a of ARCHETYPES) {
      const groups = new Map<string, string[]>()
      groups.set(`${a.id}.names`, a.names)
      for (const s of spokenStrings(a)) groups.set(s.where, [...(groups.get(s.where) ?? []), s.text])
      for (const [where, arr] of groups) expect(new Set(arr).size, where).toBe(arr.length)
    }
  })

  it('외형 풀은 카탈로그에 있는 id 만 쓰고, 시민은 평범한 차림이다', () => {
    const CITIZEN_OUTFITS = [0, 1, 2, 4, 5]
    const CITIZEN_HATS = [0, 1, 2]
    for (const a of ARCHETYPES) {
      const pools: [string, readonly number[], number][] = [
        ['outfits', a.look.outfits, OUTFITS.length],
        ['hats', a.look.hats, HATS.length],
        ['colors', a.look.colors, OUTFIT_COLORS.length],
        ['faces', a.look.faces, FACES.length],
        ['accs', a.look.accs, ACCESSORIES.length],
      ]
      for (const [key, pool, size] of pools) {
        expect(pool.length, `${a.id}.look.${key}`).toBeGreaterThan(0)
        for (const id of pool) {
          expect(Number.isInteger(id), `${a.id}.look.${key}`).toBe(true)
          expect(id, `${a.id}.look.${key}`).toBeGreaterThanOrEqual(0)
          expect(id, `${a.id}.look.${key}`).toBeLessThan(size)
        }
      }
      if (a.special !== 'rival') {
        for (const id of a.look.outfits) expect(CITIZEN_OUTFITS, `${a.id} 복장 ${id}`).toContain(id)
        for (const id of a.look.hats) expect(CITIZEN_HATS, `${a.id} 모자 ${id}`).toContain(id)
        // 어깨띠(1)는 포교하는 쪽의 소품, 염주(2)는 실존 종교의 법구라 시민에게 주지 않는다
        for (const id of a.look.accs) expect([0, 3, 4, 5], `${a.id} 소품 ${id}`).toContain(id)
      }
      expect(a.look.accs, `${a.id} 염주`).not.toContain(2)
    }
  })

  it('고양이는 사람 말을 하지 않는다(모든 대사가 괄호 속 소리·행동)', () => {
    const cat = ARCHETYPE_BY_ID.get('cat')
    expect(cat).toBeDefined()
    if (!cat) return
    for (const s of spokenStrings(cat)) expect(s.text, s.where).toMatch(/^\(.+\)$/)
    expect(cat.curious).toBe(0)
  })

  it('라이벌의 거절 대사는 전부 역포교 문장이다(rival 결과의 대사로도 쓰인다)', () => {
    const rival = ARCHETYPE_BY_ID.get('rival')
    expect(rival).toBeDefined()
    if (!rival) return
    const nos = [...(rival.re.no ?? []), ...PITCH_CATEGORIES.flatMap((c) => rival.catRe?.[c]?.no ?? [])]
    expect(nos).toContain('저도 사실 교주입니다.')
    for (const s of nos) expect(s, s).toMatch(/교주|포교|도를|명함|구역|멘트|대사/)
    expect(rival.curious).toBe(0)
  })

  it('제품 명세의 대표 반응이 들어 있다(실존 종교 시설을 말하는 대사는 허구 문장으로 대체)', () => {
    const spoken = new Set(ARCHETYPES.flatMap(spokenStrings).map((s) => s.text))
    for (const must of [
      '저 지금 너무 바빠요!',
      '아, 저 이미 다른 데 다녀요!',
      '혹시 전생에 제가 왕이었나요?',
      '1분이라면서 왜 20분째예요?',
      '인상이 좋으면 그냥 지나가게 해 주세요.',
      '흥미로운데요? 더 들어볼게요.',
      '저도 사실 교주입니다.',
    ]) {
      expect(spoken.has(must), must).toBe(true)
    }
    expect(spoken.has('아, 저 교회 다녀요!')).toBe(false)
    // 맥락이 맞는 자리에 있어야 한다
    expect(ARCHETYPE_BY_ID.get('office')?.catRe?.time?.no).toContain('1분이라면서 왜 20분째예요?')
    expect(ARCHETYPE_BY_ID.get('office')?.re.more).toContain('흥미로운데요? 더 들어볼게요.')
    expect(ARCHETYPE_BY_ID.get('rival')?.re.no).toContain('저도 사실 교주입니다.')
  })

  it('왕 결과의 고정 대사는 합류/추가 반응 풀에 넣지 않는다(왕이 아닌데 왕 대사가 뜨면 헷갈린다)', () => {
    for (const a of ARCHETYPES) {
      const sets = [a.re, ...PITCH_CATEGORIES.map((c) => a.catRe?.[c] ?? {})]
      for (const set of sets) {
        for (const k of REACTION_KEYS) expect(set[k] ?? [], `${a.id} ${k}`).not.toContain('혹시 전생에 제가 왕이었나요?')
      }
    }
  })
})

// ───────────────────────── 가드레일 ─────────────────────────

describe('가드레일(금칙어)', () => {
  it('실존 종교·정치 관련 단어가 어디에도 없다', () => {
    const REAL = [
      // 과제 지정 목록
      '교회', '성당', '절에', '스님', '목사', '신부님', '불교', '기독', '천주', '이슬람', '신천지', '통일교', '여호와',
      '하나님', '예수', '부처', '알라', '대통령', '국회의원',
      // 조사 문서(03) 6장의 용어·직함·구호 중 오탐 위험이 낮은 것('업보'는 "졸업보다", '기도'는 "믿기도"에 걸려서 뺐다)
      '하느님', '그리스도', '가톨릭', '개신교', '힌두', '유대교', '무슬림', '원불교', '천도교', '증산', '대순', '진리회',
      '구원', '축복', '은혜', '성령', '예배', '헌금', '십일조', '간증', '안수', '휴거', '재림', '메시아', '구세주', '선지자',
      '아멘', '할렐루야', '나무아미', '관세음', '성불', '시주', '공양', '법회', '천도재', '목탁', '염주', '묵주', '십자가',
      '전도사', '권사', '수녀', '추기경', '교황', '법당', '사찰', '모스크', '성전', '선교', '포덕', '천복', '절값', '치성', '신내림',
      '정당', '여당', '야당',
    ]
    expect(findHits(EVERY_STRING, REAL)).toEqual([])
  })

  it('욕설·비하 표현이 없다', () => {
    const PROFANITY = [
      '시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '좆', '존나', '졸라', '개새', '새끼', '지랄', '미친', '닥쳐', '꺼져라', '썅', '염병',
      '엿 먹', '등신', '찐따', '한남', '김치녀', '맘충', '틀딱', '급식충', '잼민', '짱깨', '쪽바리', '흑형', '외노자', '장애',
      'fuck', 'shit', 'bitch', '섹스', '야동', '성인',
    ]
    expect(findHits(EVERY_STRING, PROFANITY)).toEqual([])
  })

  it('실존 브랜드·서비스 이름이 없다', () => {
    const BRANDS = [
      '에어팟', '카톡', '카카오', '인스타', '유튜브', '넷플릭스', '배민', '쿠팡', '스타벅스', '로또', '츄르', '비트코인',
      '이더리움', '틱톡', '네이버', '구글', '삼성', '애플', '아이폰', '갤럭시', 'mbti', '다이소', '당근마켓', '테슬라',
      '페이스북', '트위터',
    ]
    expect(findHits(EVERY_STRING, BRANDS)).toEqual([])
  })

  it('포교 멘트는 실제 권유 수법의 다음 단계나 불안 조성으로 넘어가지 않는다', () => {
    // 신상·연락처·자리 옮기기·의식·돈·사칭(설문, 테스트) / 액운·건강·가족을 건드리는 말
    const TACTICS = [
      '연락처', '전화번호', '번호 좀', '이름이 뭐', '어디 사', '무슨 일 하', '카페', '차 한잔', '따라오', '같이 가',
      '설문', '테스트', '동아리', '취재', '상담', '제사', '합숙', '수련', '입금', '계좌', '후원', '돈', '만 원', '공짜',
      '액운', '액땜', '삼재', '살이 ', '저주', '불행', '큰일', '막혀', '막힌', '병원', '건강', '아프', '가족', '부모', '자녀',
      '안 그러면', '놓치면', '오늘뿐', '마지막 기회',
    ]
    expect(findHits(LINE_STRINGS, TACTICS)).toEqual([])
  })

  it('미성년자 유형이 없다(현재 규칙으로는 합류 확률을 0 으로 만들 수 없다)', () => {
    const MINOR = ['초등', '중학생', '고등학생', '고3', '수험생', '어린이', '유치원', '초딩', '급식']
    const identity = ARCHETYPES.flatMap((a) => [
      { where: `${a.id}.id`, text: a.id },
      { where: `${a.id}.name`, text: a.name },
      { where: `${a.id}.desc`, text: a.desc },
      ...a.names.map((text) => ({ where: `${a.id}.names`, text })),
    ])
    expect(findHits(identity, MINOR)).toEqual([])
    for (const id of ['kid', 'child', 'teen', 'senior']) expect(ARCHETYPE_BY_ID.has(id), id).toBe(false)
  })
})

// ───────────────────────── 밸런스 ─────────────────────────

describe('상성과 밸런스', () => {
  const people = ARCHETYPES.filter((a) => a.special !== 'animal')

  it('유형마다 좋아하는 소재와 싫어하는 소재가 분명하다(최고·최저 합류 확률 차 0.2 이상)', () => {
    for (const a of people) {
      const chances = PITCH_CATEGORIES.map((c) => chanceFor(a, c))
      const spread = Math.max(...chances) - Math.min(...chances)
      // 합류 불가 유형은 확률이 늘 0 이고, 상한이 있는 유형은 상한이 허락하는 만큼만 벌어진다
      if (a.recruitable !== false) {
        const room = Math.min(0.2, (a.maxChance ?? 1) - JOIN_CHANCE_MIN)
        expect(spread, `${a.id} spread`).toBeGreaterThanOrEqual(room - 1e-9)
      }
      const likes = PITCH_CATEGORIES.map((c) => a.like[c] ?? 0)
      expect(Math.max(...likes), `${a.id} 좋아하는 소재`).toBeGreaterThanOrEqual(0.1)
      expect(Math.min(...likes), `${a.id} 싫어하는 소재`).toBeLessThanOrEqual(-0.1)
    }
  })

  it('고양이에게는 어떤 소재도 거의 통하지 않는다(전설 업적이 쉬워지면 안 된다)', () => {
    const cat = ARCHETYPE_BY_ID.get('cat')
    expect(cat).toBeDefined()
    if (!cat) return
    for (const c of PITCH_CATEGORIES) expect(chanceFor(cat, c), c).toBeLessThanOrEqual(0.1)
  })

  it('모든 소재에 그것을 좋아하는 유형과 싫어하는 유형이 3종 이상 있다', () => {
    for (const c of PITCH_CATEGORIES) {
      expect(people.filter((a) => (a.like[c] ?? 0) >= 0.1).length, `${c} 좋아함`).toBeGreaterThanOrEqual(3)
      expect(people.filter((a) => (a.like[c] ?? 0) <= -0.1).length, `${c} 싫어함`).toBeGreaterThanOrEqual(3)
    }
  })

  it("현실 수법과 가장 가까운 '조상'과 질척이는 '1분만요'는 평균적으로 손해 보는 소재다", () => {
    const total = people.reduce((s, a) => s + a.weight, 0)
    const avg = (c: PitchCategory): number => people.reduce((s, a) => s + a.weight * (a.like[c] ?? 0), 0) / total
    expect(avg('ancestor')).toBeLessThan(0)
    expect(avg('time')).toBeLessThan(0)
    for (const c of PITCH_CATEGORIES) expect(avg('time'), `time ≤ ${c}`).toBeLessThanOrEqual(avg(c))
  })

  it('현실에서 표적이 되기 쉬운 사람을 닮은 유형은 평균보다 넘어오지 않는다', () => {
    const total = people.reduce((s, a) => s + a.weight, 0)
    const mean = people.reduce((s, a) => s + a.weight * a.base, 0) / total
    for (const id of ['granny', 'jobseeker', 'expat']) {
      const a = ARCHETYPE_BY_ID.get(id)
      expect(a, id).toBeDefined()
      if (a) expect(a.base, id).toBeLessThan(mean)
    }
    // 동네 어른과 취준생은 절대 신도가 되지 않는다(역할이 뒤집히는 것이 농담이다)
    expect(ARCHETYPE_BY_ID.get('granny')?.recruitable).toBe(false)
    expect(ARCHETYPE_BY_ID.get('jobseeker')?.recruitable).toBe(false)
    // 외국인 이웃·육아 중인 아빠는 상한이 낮고, 고양이는 전설이다
    expect(ARCHETYPE_BY_ID.get('expat')?.maxChance).toBeLessThanOrEqual(0.22)
    expect(ARCHETYPE_BY_ID.get('dad')?.maxChance).toBeLessThanOrEqual(0.3)
    expect(ARCHETYPE_BY_ID.get('cat')?.maxChance).toBeLessThanOrEqual(0.03)
  })

  it('합류 불가 유형은 최고 직급·2라운드·최선의 멘트·온갖 보정에도 확률 0, 상한 있는 유형은 상한을 넘지 않는다', () => {
    const hot = ctx({ rank: MAX_RANK, round: 2, streak: 9, failStreak: 9, buff: 0.3 })
    for (const a of ARCHETYPES) {
      const best = Math.max(...PITCH_LINES.map((l) => joinChance(a, l, hot)))
      if (a.recruitable === false) expect(best, a.id).toBe(0)
      if (a.maxChance !== undefined) expect(best, a.id).toBeLessThanOrEqual(a.maxChance + 1e-12)
      // 실제 판정에서도 합류·왕 결과가 나오지 않는다
      if (a.recruitable === false) {
        const rnd = mulberry32(31)
        for (let i = 0; i < 2000; i++) {
          const r = resolvePitch(a, pick(PITCH_LINES as PitchLine[], rnd), hot, rnd)
          expect(['join', 'king'], `${a.id} ${r.outcome}`).not.toContain(r.outcome)
        }
      }
    }
    // 최소한 위 두 유형은 실제로 합류 불가로 표시돼 있어야 이 검사가 의미가 있다
    expect(ARCHETYPES.filter((a) => a.recruitable === false).length).toBeGreaterThanOrEqual(2)
  })

  interface SimResult {
    talks: number
    pitches: number
    joinedTalks: number
    outcomes: Record<PitchOutcome, number>
    fallbackSays: number
  }

  /**
   * 플레이어 한 명이 거리의 시민에게 차례로 말을 거는 상황을 흉내 낸다.
   * choose: 제시된 4개 중 무엇을 고르는가. 연속 성공/실패 보정은 0 으로 둔다(순수한 콘텐츠 밸런스만 본다).
   */
  function simulate(rank: number, seed: number, talks: number, choose: (a: Archetype, ids: number[]) => number): SimResult {
    const rnd = mulberry32(seed)
    const res: SimResult = {
      talks,
      pitches: 0,
      joinedTalks: 0,
      outcomes: { join: 0, more: 0, no: 0, flee: 0, ignore: 0, rival: 0, king: 0 },
      fallbackSays: 0,
    }
    for (let i = 0; i < talks; i++) {
      const a = pickWeighted(ARCHETYPES, (x) => x.weight, rnd)
      let round = 1
      let used: number[] = []
      for (;;) {
        const ids = pickLines(rank, rnd, LINES_PER_TALK, used)
        const r = resolvePitch(a, lineAt(choose(a, ids)), ctx({ rank, round }), rnd)
        res.pitches++
        res.outcomes[r.outcome]++
        if (r.say.trim() === '' || r.say === '…') res.fallbackSays++
        if (r.outcome === 'join' || r.outcome === 'king') res.joinedTalks++
        if (r.outcome !== 'more') break
        round = 2
        used = ids
      }
    }
    return res
  }

  const randomPick = (seed: number): ((a: Archetype, ids: number[]) => number) => {
    const rnd = mulberry32(seed)
    return (_a, ids) => pick(ids, rnd)
  }
  const bestPick = (rank: number) => (a: Archetype, ids: number[]): number =>
    ids.reduce((best, id) => (joinChance(a, lineAt(id), ctx({ rank })) > joinChance(a, lineAt(best), ctx({ rank })) ? id : best))
  const worstPick = (rank: number) => (a: Archetype, ids: number[]): number =>
    ids.reduce((worst, id) => (joinChance(a, lineAt(id), ctx({ rank })) < joinChance(a, lineAt(worst), ctx({ rank })) ? id : worst))

  const TALKS = 40_000

  // 설계 목표(2차 밸런스 조정): 실패 농담을 충분히 보게 합류율을 낮췄다 — 재도전 보정 0.25 → 0.15, 직급 보정 축소,
  // 취약해 보이는 유형(할머니·취준생)은 절대 넘어오지 않음. 동정표(연속 실패 보정)는 이 계산에 넣지 않으므로 실제 체감은 이보다 조금 높다.
  it('직급 0 에서 아무 멘트나 고르면 합류율이 25~45% 다', () => {
    const r = simulate(0, 101, TALKS, randomPick(202))
    const perTalk = r.joinedTalks / r.talks
    const perPitch = (r.outcomes.join + r.outcomes.king) / r.pitches
    expect(perTalk).toBeGreaterThan(0.25)
    expect(perTalk).toBeLessThan(0.45)
    expect(perPitch).toBeGreaterThan(0.25)
    expect(perPitch).toBeLessThan(0.45)
  })

  it('도망 결과는 전체 포교의 8~25% 다', () => {
    const r = simulate(0, 303, TALKS, randomPick(404))
    const flee = r.outcomes.flee / r.pitches
    expect(flee).toBeGreaterThan(0.08)
    expect(flee).toBeLessThan(0.25)
  })

  it('모든 결과가 실제로 나오고, 대사가 비거나 "…" 로 떨어지지 않는다', () => {
    for (let rank = 0; rank <= MAX_RANK; rank++) {
      const r = simulate(rank, 500 + rank, 20_000, randomPick(600 + rank))
      for (const o of ['join', 'more', 'no', 'flee', 'ignore', 'rival', 'king'] as const) {
        expect(r.outcomes[o], `rank${rank} ${o}`).toBeGreaterThan(0)
      }
      expect(r.fallbackSays, `rank${rank}`).toBe(0)
    }
  })

  it('상성을 아는 플레이어가 확실히 유리하지만 필승은 아니다', () => {
    const random = simulate(0, 701, TALKS, randomPick(702))
    const smart = simulate(0, 703, TALKS, bestPick(0))
    const clueless = simulate(0, 704, TALKS, worstPick(0))
    const rate = (r: SimResult): number => r.joinedTalks / r.talks
    expect(rate(smart) - rate(random)).toBeGreaterThan(0.1)
    expect(rate(random) - rate(clueless)).toBeGreaterThan(0.1)
    expect(rate(smart)).toBeLessThan(0.7)
    expect(rate(clueless)).toBeGreaterThan(0.12)
  })

  it('직급이 올라도 합류율이 폭주하지 않는다(최고 직급 + 최선의 선택 80% 미만)', () => {
    const r0 = simulate(0, 801, 30_000, randomPick(802))
    const r5 = simulate(MAX_RANK, 803, 30_000, randomPick(804))
    const r5smart = simulate(MAX_RANK, 805, 30_000, bestPick(MAX_RANK))
    expect(r5.joinedTalks / r5.talks).toBeGreaterThan(r0.joinedTalks / r0.talks)
    expect(r5smart.joinedTalks / r5smart.talks).toBeLessThan(0.8)
  })

  it('전생 멘트 + royal 유형이면 "왕" 결과가 나오고, 그 밖에서는 절대 나오지 않는다', () => {
    const rnd = mulberry32(909)
    const pastLines = PITCH_LINES.filter((l) => l.cat === 'past' && l.rank === 0)
    const otherLines = PITCH_LINES.filter((l) => l.cat !== 'past' && l.rank === 0)
    expect(pastLines.length).toBeGreaterThanOrEqual(3)
    for (const a of ARCHETYPES) {
      let kingsOnPast = 0
      let joinsOnPast = 0
      let kingsElsewhere = 0
      for (let i = 0; i < 3000; i++) {
        const onPast = resolvePitch(a, pick(pastLines, rnd), ctx(), rnd)
        if (onPast.outcome === 'king') {
          kingsOnPast++
          expect(onPast.say).toBe('혹시 전생에 제가 왕이었나요?')
        }
        if (onPast.outcome === 'join') joinsOnPast++
        if (resolvePitch(a, pick(otherLines, rnd), ctx(), rnd).outcome === 'king') kingsElsewhere++
      }
      expect(kingsElsewhere, `${a.id} 전생 아닌 멘트`).toBe(0)
      if (a.special === 'royal') {
        // 3000번 중 합류의 절반가량이 왕 — 넉넉히 150회 이상이어야 '찾아낼 수 있는' 이벤트다
        expect(kingsOnPast, `${a.id} 왕`).toBeGreaterThan(150)
        expect(joinsOnPast, `${a.id} 그냥 합류`).toBeGreaterThan(150)
        expect(a.like.past ?? 0, `${a.id} 는 전생 얘기를 좋아해야 한다`).toBeGreaterThanOrEqual(0.1)
      } else {
        expect(kingsOnPast, `${a.id} 는 왕이 아니다`).toBe(0)
      }
    }
  })

  it('royal 유형은 거리에서 충분히 자주 마주친다(전체 등장 비중 10~30%)', () => {
    const total = ARCHETYPES.reduce((s, a) => s + a.weight, 0)
    const royal = ARCHETYPES.filter((a) => a.special === 'royal').reduce((s, a) => s + a.weight, 0)
    expect(royal / total).toBeGreaterThan(0.1)
    expect(royal / total).toBeLessThan(0.3)
  })

  it('라이벌은 첫 라운드에 대체로 역포교(rival)를 걸고, 그 대사는 교주 선언이다', () => {
    const rival = ARCHETYPE_BY_ID.get('rival')
    expect(rival).toBeDefined()
    if (!rival) return
    const rnd = mulberry32(1001)
    const lines = PITCH_LINES.filter((l) => l.rank === 0)
    let duels = 0
    const N = 4000
    for (let i = 0; i < N; i++) {
      const r = resolvePitch(rival, pick(lines, rnd), ctx(), rnd)
      if (r.outcome === 'rival') {
        duels++
        expect(r.say).toMatch(/교주|포교|도를|명함|구역|멘트|대사/)
      }
      expect(r.outcome).not.toBe('more')
    }
    expect(duels / N).toBeGreaterThan(0.6)
    expect(duels / N).toBeLessThan(0.8)
  })
})
