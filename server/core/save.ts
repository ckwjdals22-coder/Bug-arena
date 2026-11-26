/**
 * 저장본 서명기: 순수 JS 동기 SHA-256 + HMAC-SHA256.
 *
 * 왜 직접 구현하는가
 *   - 코어는 Node 와 Cloudflare Workers 양쪽에서 돌아야 해서 node:crypto 를 쓸 수 없다.
 *   - WebCrypto(subtle)는 비동기라 "hello → 서명 검증 → welcome" 흐름을 한 번의 동기 처리로 끝낼 수 없다.
 *     (비동기가 끼면 그 사이에 같은 연결의 다른 메시지가 끼어들어 순서 문제가 생긴다.)
 * 저장본은 수 KB 수준이라 순수 JS 로도 한 번에 0.1ms 안팎이면 충분하다.
 */
import type { SaveSigner } from './api'

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const BLOCK = 64
const DIGEST = 32

/** 조각을 이어 붙이지 않고 순서대로 넣을 수 있는 SHA-256 (HMAC 의 pad‖메시지 복사를 피하려고) */
class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly w = new Uint32Array(64)
  private readonly buf = new Uint8Array(BLOCK)
  private filled = 0
  private total = 0

  update(data: Uint8Array): this {
    let i = 0
    const n = data.length
    this.total += n
    // 앞에서 남은 조각을 먼저 채운다
    if (this.filled > 0) {
      while (i < n && this.filled < BLOCK) this.buf[this.filled++] = data[i++]!
      if (this.filled < BLOCK) return this
      this.compress(this.buf, 0)
      this.filled = 0
    }
    for (; i + BLOCK <= n; i += BLOCK) this.compress(data, i)
    while (i < n) this.buf[this.filled++] = data[i++]!
    return this
  }

  digest(): Uint8Array {
    const total = this.total
    const buf = this.buf
    buf[this.filled++] = 0x80
    if (this.filled > BLOCK - 8) {
      buf.fill(0, this.filled)
      this.compress(buf, 0)
      this.filled = 0
    }
    buf.fill(0, this.filled)
    // 길이는 비트 수(64비트 빅엔디언). JS 정수 범위(2^53) 안에서는 나눗셈으로 상위 워드를 얻는다
    const dv = new DataView(buf.buffer)
    dv.setUint32(BLOCK - 8, Math.floor(total / 0x20000000), false)
    dv.setUint32(BLOCK - 4, (total << 3) >>> 0, false)
    this.compress(buf, 0)
    const out = new Uint8Array(DIGEST)
    const ov = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.h[i]!, false)
    return out
  }

  private compress(src: Uint8Array, off: number): void {
    const w = this.w
    const h = this.h
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = ((src[j]! << 24) | (src[j + 1]! << 16) | (src[j + 2]! << 8) | src[j + 3]!) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!
      const b = w[i - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h[0]!
    let b = h[1]!
    let c = h[2]!
    let d = h[3]!
    let e = h[4]!
    let f = h[5]!
    let g = h[6]!
    let hh = h[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest()
}

/** 키를 블록 크기에 맞추고(길면 해시) pad 값과 XOR 한 블록을 만든다 */
function padKey(key: Uint8Array, pad: number): Uint8Array {
  const k = key.length > BLOCK ? sha256(key) : key
  const out = new Uint8Array(BLOCK).fill(pad)
  for (let i = 0; i < k.length; i++) out[i] = k[i]! ^ pad
  return out
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const inner = new Sha256().update(padKey(key, 0x36)).update(data).digest()
  return new Sha256().update(padKey(key, 0x5c)).update(inner).digest()
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 패딩 없는 base64url — JSON/URL/localStorage 어디에 넣어도 이스케이프가 필요 없다 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  const n = bytes.length
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64URL[v >>> 18]! + B64URL[(v >>> 12) & 63]! + B64URL[(v >>> 6) & 63]! + B64URL[v & 63]!
  }
  if (i + 1 === n) {
    const v = bytes[i]! << 16
    out += B64URL[v >>> 18]! + B64URL[(v >>> 12) & 63]!
  } else if (i + 2 === n) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64URL[v >>> 18]! + B64URL[(v >>> 12) & 63]! + B64URL[(v >>> 6) & 63]!
  }
  return out
}

/**
 * 상수 시간 비교. 틀린 위치에 따라 걸리는 시간이 달라지면 서명을 한 글자씩 맞춰 볼 수 있으므로
 * 끝까지 다 훑은 뒤에 결과를 낸다. (길이는 항상 43자로 공개된 값이라 숨길 필요가 없다.)
 */
function safeEqual(expected: string, given: string): boolean {
  let diff = expected.length ^ given.length
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ (i < given.length ? given.charCodeAt(i) : 0)
  }
  return diff === 0
}

/** HMAC-SHA256 서명 길이(base64url, 패딩 없음) */
export const SIGNATURE_LENGTH = 43

export function createSigner(secret: string): SaveSigner {
  if (typeof secret !== 'string' || secret.length === 0) {
    // 빈 비밀키로 조용히 돌아가면 누구나 저장본을 위조할 수 있다 → 시작 단계에서 바로 드러나게 한다
    throw new Error('저장 서명 비밀키가 비어 있습니다')
  }
  const enc = new TextEncoder()
  const key = enc.encode(secret)
  // pad 블록은 서명할 때마다 같으므로 한 번만 만든다
  const ipad = padKey(key, 0x36)
  const opad = padKey(key, 0x5c)

  const sign = (data: string): string => {
    const inner = new Sha256().update(ipad).update(enc.encode(data)).digest()
    return toBase64Url(new Sha256().update(opad).update(inner).digest())
  }

  return {
    sign,
    verify(data: string, sig: string): boolean {
      if (typeof data !== 'string' || typeof sig !== 'string') return false
      // 터무니없이 긴 값은 비교할 필요도 없다(연산 낭비 방지)
      if (sig.length !== SIGNATURE_LENGTH) return false
      return safeEqual(sign(data), sig)
    },
  }
}
