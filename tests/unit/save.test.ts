/**
 * 저장 서명기(순수 JS SHA-256/HMAC) 테스트.
 * 코어는 node:crypto 를 쓸 수 없지만, 테스트에서는 그것을 기준 구현으로 삼아 결과를 맞춰 본다.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SIGNATURE_LENGTH, createSigner, hmacSha256, sha256, toBase64Url } from '../../server/core/save'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('sha256', () => {
  it('표준 테스트 벡터와 일치한다', () => {
    expect(hex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // FIPS 180-4 예제: 56바이트 메시지(패딩이 블록 하나를 더 쓰는 경우)
    expect(hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('모든 길이(블록 경계 포함)에서 node:crypto 와 같다', () => {
    // 55/56/63/64/119/120 바이트 근처가 패딩 분기의 경계다
    for (let len = 0; len <= 300; len++) {
      const data = new Uint8Array(randomBytes(len))
      expect(hex(sha256(data)), `길이 ${len}`).toBe(createHash('sha256').update(data).digest('hex'))
    }
    for (const len of [1000, 4096, 65_537]) {
      const data = new Uint8Array(randomBytes(len))
      expect(hex(sha256(data)), `길이 ${len}`).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })

  it('버퍼 중간을 가리키는 뷰도 올바르게 읽는다', () => {
    const whole = new Uint8Array(randomBytes(200))
    const view = whole.subarray(37, 150)
    expect(hex(sha256(view))).toBe(createHash('sha256').update(view).digest('hex'))
  })
})

describe('hmacSha256', () => {
  it('RFC 4231 테스트 벡터와 일치한다', () => {
    // Test Case 1
    expect(hex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
    // Test Case 2
    expect(hex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
    // Test Case 6: 블록(64바이트)보다 긴 키는 먼저 해시한다
    expect(
      hex(hmacSha256(new Uint8Array(131).fill(0xaa), utf8('Test Using Larger Than Block-Size Key - Hash Key First'))),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  })

  it('여러 키 길이·메시지 길이에서 node:crypto 와 같다', () => {
    for (const keyLen of [1, 20, 32, 63, 64, 65, 100, 200]) {
      for (const msgLen of [0, 1, 55, 56, 64, 119, 120, 500, 3000]) {
        const key = new Uint8Array(randomBytes(keyLen))
        const msg = new Uint8Array(randomBytes(msgLen))
        expect(hex(hmacSha256(key, msg)), `키 ${keyLen} / 메시지 ${msgLen}`).toBe(
          createHmac('sha256', key).update(msg).digest('hex'),
        )
      }
    }
  })
})

describe('toBase64Url', () => {
  it('패딩 없는 base64url 을 만든다', () => {
    for (let len = 0; len <= 40; len++) {
      const data = new Uint8Array(randomBytes(len))
      expect(toBase64Url(data), `길이 ${len}`).toBe(Buffer.from(data).toString('base64url'))
    }
    // +, / 가 나오는 값이 -, _ 로 바뀌는지
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-')
  })
})

describe('createSigner', () => {
  const nodeSign = (secret: string, data: string): string =>
    createHmac('sha256', secret).update(data, 'utf8').digest('base64url')

  it('서명이 node:crypto HMAC(base64url) 과 같다 — 한글, 이모지, 64바이트를 넘는 키 포함', () => {
    const secrets = [
      'k',
      'unit-test-secret',
      '수상역 4번 출구 앞 비밀키',
      'x'.repeat(64),
      'y'.repeat(65),
      '아주 긴 비밀키입니다. '.repeat(20),
      randomBytes(48).toString('hex'),
    ]
    const messages = [
      '',
      'a',
      '{"v":1,"pid":"device-1","inf":120}',
      '도를 아십니까? 인상이 참 좋으시네요!',
      '교단 엠블럼 🍜🛸👁️ 과 조합형 한글 ㅎㅏㄴㄱㅡㄹ',
      JSON.stringify({ v: 1, pid: 'p'.repeat(40), cult: { name: '월요병 구원회', title: '수석 졸음이' }, stats: { joins: 12345 } }),
      '가'.repeat(3000),
    ]
    for (const secret of secrets) {
      const signer = createSigner(secret)
      for (const msg of messages) {
        const sig = signer.sign(msg)
        expect(sig, `키 ${secret.slice(0, 12)}… / 메시지 ${msg.slice(0, 12)}…`).toBe(nodeSign(secret, msg))
        expect(sig).toHaveLength(SIGNATURE_LENGTH)
        expect(sig).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(signer.verify(msg, sig)).toBe(true)
      }
    }
  })

  it('내용이나 서명이 한 글자라도 다르면 검증에 실패한다', () => {
    const signer = createSigner('unit-test-secret')
    const data = '{"v":1,"pid":"device-1","inf":120}'
    const sig = signer.sign(data)
    expect(signer.verify(data, sig)).toBe(true)
    expect(signer.verify(data.replace('120', '999'), sig)).toBe(false)
    expect(signer.verify(`${data} `, sig)).toBe(false)
    // 서명의 모든 자리에 대해 한 글자씩 바꿔 본다
    for (let i = 0; i < sig.length; i++) {
      const ch = sig[i] === 'A' ? 'B' : 'A'
      expect(signer.verify(data, sig.slice(0, i) + ch + sig.slice(i + 1)), `자리 ${i}`).toBe(false)
    }
    // 길이가 다른 값
    expect(signer.verify(data, '')).toBe(false)
    expect(signer.verify(data, sig.slice(0, -1))).toBe(false)
    expect(signer.verify(data, `${sig}A`)).toBe(false)
    expect(signer.verify(data, `${sig}=`)).toBe(false)
    expect(signer.verify(data, 'x'.repeat(100_000))).toBe(false)
    // 다른 비밀키로 만든 서명
    expect(signer.verify(data, createSigner('other-secret').sign(data))).toBe(false)
  })

  it('문자열이 아닌 값은 예외 없이 false', () => {
    const signer = createSigner('unit-test-secret')
    const sig = signer.sign('x')
    const loose = signer as unknown as { verify(d: unknown, s: unknown): boolean }
    expect(loose.verify('x', null)).toBe(false)
    expect(loose.verify('x', 12345)).toBe(false)
    expect(loose.verify('x', { length: 43 })).toBe(false)
    expect(loose.verify(null, sig)).toBe(false)
    expect(loose.verify({ toString: () => 'x' }, sig)).toBe(false)
  })

  it('같은 입력에는 항상 같은 서명, 비밀키가 다르면 다른 서명', () => {
    const a = createSigner('secret-a')
    const again = createSigner('secret-a')
    const b = createSigner('secret-b')
    expect(a.sign('hello')).toBe(again.sign('hello'))
    expect(a.sign('hello')).toBe(a.sign('hello'))
    expect(a.sign('hello')).not.toBe(b.sign('hello'))
    expect(a.sign('hello')).not.toBe(a.sign('hellp'))
  })

  it('빈 비밀키는 거부한다', () => {
    expect(() => createSigner('')).toThrow()
    expect(() => createSigner(undefined as unknown as string)).toThrow()
  })

  it('저장본 크기(수 KB)를 충분히 빠르게 서명한다', () => {
    const signer = createSigner('unit-test-secret')
    const data = JSON.stringify({ stats: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`stat${i}`, i * 7])) })
    expect(data.length).toBeGreaterThan(1500)
    const t0 = performance.now()
    let sig = ''
    for (let i = 0; i < 200; i++) sig = signer.sign(data)
    const per = (performance.now() - t0) / 200
    expect(sig).toBe(nodeSign('unit-test-secret', data))
    // 넉넉한 상한: 한 번에 5ms 를 넘으면 틱 예산(100ms)에 부담이 된다
    expect(per).toBeLessThan(5)
  })
})
