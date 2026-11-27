/**
 * 포교 결과 판정. 순수 함수 — 서버가 호출한다.
 * 결과는 '게임 내 확률 + NPC의 가상 성격'으로만 정해진다(현실 설득 기법과 무관한 개그 상성).
 */
import type { Archetype, PitchLine, ReactionSet } from '../content/types'
import { PITCH_LINES } from '../content/lines'
import { LINES_PER_TALK, MAX_TALK_ROUNDS } from '../constants'
import type { PitchOutcome } from '../types'
import { type Rnd, pick, sample } from '../rng'

export interface PitchContext {
  /** 플레이어 직급 0..5 */
  rank: number
  /** 현재 연속 성공 수 */
  streak: number
  /** 현재 연속 실패 수(불쌍해서 조금씩 잘 통하게 됨) */
  failStreak: number
  /** 대화 라운드: 1 또는 2('더 들어볼게요' 이후) */
  round: number
  /** 기타 버프 합(지금은 단상 계시 버프뿐). 보통 0 ~ 0.1 */
  buff: number
  /** 이 NPC가 이미 다른 플레이어의 신도인가(뺏기 시도) */
  poach: boolean
}

export interface PitchResult {
  outcome: PitchOutcome
  /** NPC 대사 */
  say: string
  /** 계산된 합류 확률(테스트/디버그용) */
  chance: number
  /** 연속 실패가 SYMPATHY_SHOW_AT 번 이상 쌓인 뒤의 합류(동정표 덕을 본 합류). UI 가 '(동정표 획득)' 을 보여 줄 때 쓴다 */
  sympathy?: boolean
}

export const JOIN_CHANCE_MIN = 0.04
export const JOIN_CHANCE_MAX = 0.92
/** 직급 하나당 더해지는 확률 */
export const RANK_BONUS = 0.01
/** 연속 성공 하나당(최대 STREAK_BONUS_MAX 번까지) */
export const STREAK_BONUS = 0.01
export const STREAK_BONUS_MAX = 5
/** 동정표: 연속 실패 하나당(최대 SYMPATHY_MAX 번까지). 거절이 이어지면 시민도 조금 딱해진다 */
export const SYMPATHY_BONUS = 0.03
export const SYMPATHY_MAX = 6
/** 동정표가 '눈에 띄게' 붙었다고 보는 연속 실패 수(결과에 sympathy 표시) */
export const SYMPATHY_SHOW_AT = 5
/** '더 들어볼게요' 뒤 2라운드 보너스 */
export const ROUND2_BONUS = 0.15
/** 남의 신도를 빼앗으려 할 때의 감점(이미 다른 교주를 따라가는 중인 사람은 잘 안 넘어온다) */
export const POACH_PENALTY = 0.35

/** 합류 확률 계산 */
export function joinChance(arch: Archetype, line: PitchLine, ctx: PitchContext): number {
  // 합류 불가 유형은 어떤 보정으로도 넘어오지 않는다(하한 4% 도 적용하지 않음)
  if (arch.recruitable === false) return 0
  let c = arch.base + (arch.like[line.cat] ?? 0) + line.power
  c += ctx.rank * RANK_BONUS
  c += Math.min(ctx.streak, STREAK_BONUS_MAX) * STREAK_BONUS
  c += Math.min(ctx.failStreak, SYMPATHY_MAX) * SYMPATHY_BONUS
  c += ctx.buff
  if (ctx.round >= 2) c += ROUND2_BONUS
  if (ctx.poach) c -= POACH_PENALTY
  c = Math.max(JOIN_CHANCE_MIN, Math.min(JOIN_CHANCE_MAX, c))
  // 유형별 상한: 보정이 아무리 쌓여도 이 유형은 이 확률을 넘지 않는다(하한 4% 보다 낮은 상한도 그대로 지킨다)
  if (arch.maxChance !== undefined) c = Math.min(c, Math.max(0, arch.maxChance))
  return c
}

function reaction(arch: Archetype, line: PitchLine, key: keyof ReactionSet, rnd: Rnd): string {
  const special = arch.catRe?.[line.cat]?.[key]
  if (special && special.length > 0 && rnd() < 0.75) return pick(special, rnd)
  const base = arch.re[key]
  if (base && base.length > 0) return pick(base, rnd)
  const fallback = arch.re.no
  return fallback && fallback.length > 0 ? pick(fallback, rnd) : '…'
}

export function resolvePitch(arch: Archetype, line: PitchLine, ctx: PitchContext, rnd: Rnd): PitchResult {
  const chance = joinChance(arch, line, ctx)

  // 특수: 라이벌 교주는 첫 라운드에 일정 확률로 역포교(기싸움)를 건다
  if (arch.special === 'rival' && ctx.round === 1 && rnd() < 0.7) {
    return { outcome: 'rival', say: reaction(arch, line, 'no', rnd), chance }
  }

  if (rnd() < chance) {
    // 특수: 전생 멘트 + royal 유형이면 "제가 왕이었나요?"
    if (arch.special === 'royal' && line.cat === 'past' && rnd() < 0.5) {
      return { outcome: 'king', say: '혹시 전생에 제가 왕이었나요?', chance, ...(ctx.failStreak >= SYMPATHY_SHOW_AT ? { sympathy: true } : {}) }
    }
    const out: PitchResult = { outcome: 'join', say: reaction(arch, line, 'join', rnd), chance }
    if (ctx.failStreak >= SYMPATHY_SHOW_AT) out.sympathy = true
    return out
  }

  // 실패 분기: 2라운드 기회 → 도망 → 무시 → 말로 거절
  if (ctx.round < MAX_TALK_ROUNDS && arch.special !== 'animal' && rnd() < arch.curious) {
    return { outcome: 'more', say: reaction(arch, line, 'more', rnd), chance }
  }
  const fleeChance = Math.min(0.95, arch.flee + (line.fleeBias ?? 0))
  if (rnd() < fleeChance) return { outcome: 'flee', say: reaction(arch, line, 'flee', rnd), chance }
  if (rnd() < arch.ignore) return { outcome: 'ignore', say: reaction(arch, line, 'ignore', rnd), chance }
  return { outcome: 'no', say: reaction(arch, line, 'no', rnd), chance }
}

/** 이번 대화에서 제시할 멘트 id 고르기: 해금된 것 중 서로 다른 소재 위주로 count 개 */
export function pickLines(rank: number, rnd: Rnd, count = LINES_PER_TALK, exclude: readonly number[] = []): number[] {
  const pool = PITCH_LINES.filter((l) => l.rank <= rank && !exclude.includes(l.id))
  const shuffled = sample(pool, pool.length, rnd)
  const out: PitchLine[] = []
  const usedCats = new Set<string>()
  for (const l of shuffled) {
    if (out.length >= count) break
    if (usedCats.has(l.cat)) continue
    usedCats.add(l.cat)
    out.push(l)
  }
  for (const l of shuffled) {
    if (out.length >= count) break
    if (!out.includes(l)) out.push(l)
  }
  return out.map((l) => l.id)
}
