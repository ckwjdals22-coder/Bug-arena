/**
 * 닉네임/교단 이름 검사. [중재 담당이 조사 결과(docs/research/08-*.md)를 반영해 강화할 파일]
 * 시그니처는 서버/클라이언트가 의존하므로 유지한다.
 */
import { CULT_NAME_MAX, CULT_NAME_MIN, NAME_MAX, NAME_MIN, TITLE_MAX } from '../constants'

export type TextCheck = { ok: true; text: string } | { ok: false; why: 'empty' | 'short' | 'long' | 'bad' | 'real' }

/** 보이지 않는 문자/제어문자 제거, 공백 정리, NFKC 정규화 */
export function cleanText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return ''
  let s = input.normalize('NFKC')
  // 제어문자, zero-width, 방향 제어 문자 제거
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '')
  s = s.replace(/[<>&"'`\\]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  return Array.from(s).slice(0, maxLen).join('')
}

const BAD_ROOTS: readonly string[] = ['시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '좆', '섹스', 'fuck', 'shit', '운영자', 'admin', 'gm']
/** 교단 이름에 쓸 수 없는 실존 단체명(부분 일치) — 게임 속 교단은 전부 허구여야 한다 */
const REAL_GROUPS: readonly string[] = ['신천지', '통일교', '기독교', '불교', '천주교', '이슬람', '여호와', '교회', '성당']

function squash(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}_]/gu, '')
}

export function hasBadWord(text: string): boolean {
  const s = squash(text)
  return BAD_ROOTS.some((w) => s.includes(w))
}

export function looksLikeRealGroup(text: string): boolean {
  const s = squash(text)
  return REAL_GROUPS.some((w) => s.includes(w))
}

export function checkNickname(input: unknown): TextCheck {
  const text = cleanText(input, NAME_MAX)
  if (!text) return { ok: false, why: 'empty' }
  if (Array.from(text).length < NAME_MIN) return { ok: false, why: 'short' }
  if (hasBadWord(text)) return { ok: false, why: 'bad' }
  return { ok: true, text }
}

export function checkCultName(input: unknown): TextCheck {
  const text = cleanText(input, CULT_NAME_MAX)
  if (!text) return { ok: false, why: 'empty' }
  if (Array.from(text).length < CULT_NAME_MIN) return { ok: false, why: 'short' }
  if (hasBadWord(text)) return { ok: false, why: 'bad' }
  if (looksLikeRealGroup(text)) return { ok: false, why: 'real' }
  return { ok: true, text }
}

export function checkTitle(input: unknown): TextCheck {
  const text = cleanText(input, TITLE_MAX)
  if (!text) return { ok: false, why: 'empty' }
  if (hasBadWord(text)) return { ok: false, why: 'bad' }
  if (looksLikeRealGroup(text)) return { ok: false, why: 'real' }
  return { ok: true, text }
}
