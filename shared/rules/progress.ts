/**
 * 진행도(Progress) 생성/검증/해금 판정. 순수 함수.
 */
import { ACCESSORIES, AURAS, FACES, HATS, OUTFITS, OUTFIT_COLORS, SKIN_COLORS, rankForInfluence } from '../content/core'
import type { CosmeticDef } from '../content/types'
import { LOOK_LEN, type Look, type Progress } from '../types'

export function newProgress(pid: string, now: number): Progress {
  return {
    v: 1,
    pid,
    inf: 0,
    fol: 0,
    coins: 0,
    rank: 0,
    stats: {},
    ach: [],
    items: {},
    met: [],
    cult: null,
    cultFol: 0,
    cultInf: 0,
    daily: null,
    ts: now,
  }
}

const num = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0

/** 서명이 검증된 저장본이라도 형태를 한 번 더 다듬는다(구버전/손상 대비). 형태가 아니면 null */
export function normalizeProgress(raw: unknown, pid: string, now: number): Progress | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || r.pid !== pid) return null
  const p = newProgress(pid, now)
  p.inf = num(r.inf, 1e9)
  p.fol = num(r.fol, 1e9)
  p.coins = num(r.coins, 1e9)
  p.rank = rankForInfluence(p.inf)
  if (r.stats && typeof r.stats === 'object') {
    for (const [k, v] of Object.entries(r.stats as Record<string, unknown>)) {
      if (k.length <= 24) p.stats[k] = num(v, 1e9)
    }
  }
  if (Array.isArray(r.ach)) p.ach = r.ach.filter((x): x is string => typeof x === 'string').slice(0, 300)
  if (r.items && typeof r.items === 'object') {
    for (const [k, v] of Object.entries(r.items as Record<string, unknown>)) {
      if (k.length <= 24) p.items[k] = num(v, 1e6)
    }
  }
  if (Array.isArray(r.met)) p.met = r.met.filter((x): x is string => typeof x === 'string').slice(0, 200)
  if (r.cult && typeof r.cult === 'object') p.cult = r.cult as Progress['cult']
  p.cultFol = num(r.cultFol, 1e9)
  p.cultInf = num(r.cultInf, 1e9)
  if (r.daily && typeof r.daily === 'object') p.daily = r.daily as Progress['daily']
  return p
}

function unlocked(def: CosmeticDef | undefined, rank: number, ach: readonly string[]): boolean {
  if (!def) return false
  if (def.ach) return ach.includes(def.ach)
  return rank >= def.rank
}

export function defaultLook(seed = 0): Look {
  return [seed % SKIN_COLORS.length, 0, (seed >>> 3) % OUTFIT_COLORS.length, 0, (seed >>> 7) % 4, 0, 0]
}

/** 잠긴 항목/범위 밖 값은 기본값으로 되돌린 Look 을 돌려준다 */
export function sanitizeLook(input: unknown, rank: number, ach: readonly string[] = []): Look {
  const out = defaultLook()
  if (!Array.isArray(input) || input.length < LOOK_LEN) return out
  const v = input.map((n) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0))
  out[0] = v[0]! < SKIN_COLORS.length ? v[0]! : 0
  out[1] = unlocked(OUTFITS[v[1]!], rank, ach) ? v[1]! : 0
  out[2] = v[2]! < OUTFIT_COLORS.length ? v[2]! : 0
  out[3] = unlocked(HATS[v[3]!], rank, ach) ? v[3]! : 0
  out[4] = unlocked(FACES[v[4]!], rank, ach) ? v[4]! : 0
  out[5] = unlocked(ACCESSORIES[v[5]!], rank, ach) ? v[5]! : 0
  out[6] = unlocked(AURAS[v[6]!], rank, ach) ? v[6]! : 0
  return out
}

export function isCosmeticUnlocked(def: CosmeticDef, rank: number, ach: readonly string[] = []): boolean {
  return unlocked(def, rank, ach)
}
