/**
 * 받침에 맞춰 조사를 붙인다. 이름·교단명처럼 플레이어가 지은 말 뒤에 "을(를)" 같은 어색한 표기가 남지 않게.
 * 마지막 글자가 한글이 아니면(영문·숫자·기호) 받침을 알 수 없으므로 "을(를)" 처럼 둘 다 적는다.
 */

/** 조사 짝: [받침 있을 때, 받침 없을 때] */
const PAIRS = {
  을: ['을', '를'],
  이: ['이', '가'],
  은: ['은', '는'],
  과: ['과', '와'],
  으로: ['으로', '로'],
} as const

export type JosaKind = keyof typeof PAIRS

/** 마지막 글자의 받침 번호(0 = 없음). 한글 음절이 아니면 -1 */
function jongOf(word: string): number {
  const code = word.charCodeAt(word.length - 1)
  if (!(code >= 0xac00 && code <= 0xd7a3)) return -1
  return (code - 0xac00) % 28
}

/** word 뒤에 올 조사만 돌려준다(괄호 「」 등으로 감싼 뒤 붙일 때). '으로' 는 ㄹ 받침이면 '로' */
export function josaOf(word: string, kind: JosaKind): string {
  const [hard, soft] = PAIRS[kind]
  const jong = jongOf(word)
  if (jong < 0) return kind === '으로' ? '(으)로' : `${hard}(${soft})`
  if (kind === '으로') return jong === 0 || jong === 8 ? soft : hard
  return jong === 0 ? soft : hard
}

/** word 뒤에 알맞은 조사를 붙여 돌려준다 */
export function withJosa(word: string, kind: JosaKind): string {
  return word + josaOf(word, kind)
}
