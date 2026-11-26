/** 작은 결정적 난수기(mulberry32). 테스트에서 재현 가능한 난수가 필요할 때 쓴다. */
export type Rnd = () => number

export function mulberry32(seed: number): Rnd {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(arr: readonly T[], rnd: Rnd): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length] as T
}

export function randInt(min: number, maxInclusive: number, rnd: Rnd): number {
  return min + Math.floor(rnd() * (maxInclusive - min + 1))
}

/** 가중치 추첨. weights 합이 0 이면 첫 항목 */
export function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, rnd: Rnd): T {
  let total = 0
  for (const it of items) total += Math.max(0, weight(it))
  let r = rnd() * total
  for (const it of items) {
    r -= Math.max(0, weight(it))
    if (r <= 0) return it
  }
  return items[0] as T
}

/** 배열에서 서로 다른 n개 뽑기 */
export function sample<T>(arr: readonly T[], n: number, rnd: Rnd): T[] {
  const copy = arr.slice()
  const out: T[] = []
  while (out.length < n && copy.length > 0) {
    const i = Math.floor(rnd() * copy.length) % copy.length
    out.push(copy.splice(i, 1)[0] as T)
  }
  return out
}

/** 문자열 → 32bit 해시(FNV-1a). 시드/색상 결정 등에 사용 */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
