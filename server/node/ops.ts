/**
 * Node 어댑터의 '운영' 규칙 중 파일·소켓 없이 판단할 수 있는 것들(순수 함수).
 * main.ts 는 부팅하자마자 포트를 열고 타이머를 거는 스크립트라 단위 테스트에서 불러올 수 없다.
 * 그래서 테스트해야 하는 판단(로그 한 줄 모양, 압축 협상, Origin 검사, 보안 헤더)은 여기 모아 둔다.
 */

// ───────────────────────── 로그 한 줄 ─────────────────────────

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * 로그 한 건 = JSON 한 줄. grep·호스팅 로그 검색·로그 수집기가 항목을 쪼개지 않게 줄바꿈을 절대 넣지 않는다
 * (JSON.stringify 는 문자열 안의 줄바꿈을 \n 으로 이스케이프한다).
 */
export function formatLogLine(level: LogLevel, msg: string, extra: unknown, now: Date = new Date()): string {
  const entry: Record<string, unknown> = { ts: now.toISOString(), level, msg }
  if (extra instanceof Error) {
    entry.err = extra.message
    if (extra.stack) entry.stack = extra.stack
    const code = (extra as NodeJS.ErrnoException).code
    if (code) entry.code = code
  } else if (extra !== undefined) {
    entry.data = extra
  }
  try {
    return JSON.stringify(entry, jsonSafe)
  } catch {
    // 순환 참조 등: 내용을 포기하더라도 한 줄은 지킨다
    return JSON.stringify({ ts: entry.ts, level, msg, data: String(extra) })
  }
}

/** JSON 으로 그대로 못 내보내는 값(Map, Set, BigInt, 중첩된 Error)을 읽을 수 있는 모양으로 바꾼다 */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Map) return Object.fromEntries(value)
  if (value instanceof Set) return [...value]
  if (value instanceof Error) return { err: value.message, stack: value.stack }
  return value
}

/**
 * 같은 종류의 로그가 쏟아질 때(틱마다 터지는 버그, 잘못된 프레임을 보내는 연결 수백 개) 10초에 일정 건수만 남기고
 * 나머지는 '몇 건 생략'으로 묶는다. 디스크·로그 과금이 공격자 손에 들어가지 않게 한다.
 */
export class LogBudget {
  private left: number
  dropped = 0
  constructor(private readonly perWindow: number) {
    this.left = perWindow
  }
  take(): boolean {
    if (this.left > 0) {
      this.left--
      return true
    }
    this.dropped++
    return false
  }
  /** 창을 넘긴다. 이번 창에서 버린 건수를 돌려준다 */
  reset(): number {
    const d = this.dropped
    this.left = this.perWindow
    this.dropped = 0
    return d
  }
}

/** 소켓 오류를 종류별로 세어 두었다가 한 줄로 요약한다(연결마다 한 줄씩 쓰면 누구나 로그를 도배할 수 있다) */
export class ErrorTally {
  private readonly counts = new Map<string, number>()
  total = 0
  add(err: Error): void {
    const code = (err as NodeJS.ErrnoException).code
    // 종류 수도 무한히 늘지 않게: 코드가 없으면 메시지 앞부분만, 종류는 20개까지
    const kind = code || err.message.slice(0, 60) || 'unknown'
    this.total++
    if (this.counts.has(kind) || this.counts.size < 20) this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1)
    else this.counts.set('other', (this.counts.get('other') ?? 0) + 1)
  }
  /** 요약을 꺼내고 비운다. 없었으면 null */
  drain(): { total: number; kinds: Record<string, number> } | null {
    if (this.total === 0) return null
    const out = { total: this.total, kinds: Object.fromEntries(this.counts) }
    this.counts.clear()
    this.total = 0
    return out
  }
}

// ───────────────────────── HTTP ─────────────────────────

/**
 * Accept-Encoding 에서 이 인코딩을 받겠다고 했는가. q=0 은 '절대 보내지 말라'는 뜻이고,
 * `*` 는 따로 적지 않은 인코딩 전부를 뜻한다(`*;q=0` 이면 적지 않은 것은 거절).
 */
export function acceptsEncoding(header: string | string[] | undefined, enc: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '')
  let star: boolean | null = null
  for (const part of raw.split(',')) {
    const [nameRaw, ...params] = part.trim().split(';')
    const name = (nameRaw ?? '').trim().toLowerCase()
    if (!name) continue
    let q = 1
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)
      if (m) q = Number(m[1])
    }
    const ok = Number.isFinite(q) && q > 0
    if (name === enc) return ok
    if (name === '*') star = ok
  }
  return star === true
}

/** 브라우저가 고른 순서가 아니라 우리 선호(br → gzip)로 고른다. 둘 다 거절이면 null(원본) */
export function pickEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  if (acceptsEncoding(header, 'br')) return 'br'
  if (acceptsEncoding(header, 'gzip')) return 'gzip'
  return null
}

/**
 * HTML 응답에 붙이는 보안 헤더.
 * - 이 앱에는 인라인 스크립트가 없다(boot.js·config.js 는 외부 파일) → script-src 'self'.
 * - index.html 에 인라인 <style> 이 있고 UI 가 style 속성을 많이 쓴다 → style-src 'unsafe-inline'.
 * - 공유 이미지는 canvas → blob: URL, 파비콘은 data: SVG → img-src data: blob:.
 * - config.js 로 실시간 서버를 다른 주소에 둘 수 있다 → connect-src 에 ws: wss: https:.
 * - frameAncestors: 기본은 'self'. 게임 포털에 iframe 으로 올릴 때만 FRAME_ANCESTORS 로 그 주소를 더한다.
 */
export function securityHeaders(frameAncestors: string): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws: wss: https:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ')
  return {
    'content-security-policy': csp,
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  }
}

/**
 * FRAME_ANCESTORS 환경변수 → CSP frame-ancestors 값. 비었으면 'self'.
 * 헤더·지시어 주입을 막으려고 출처에 쓰지 않는 문자(; 줄바꿈 등)가 하나라도 있으면 통째로 버리고 기본값을 쓴다.
 * 남은 것도 출처 모양('self', 'none', https://…, *.example.com)인 토큰만 받는다.
 */
export function frameAncestorsFrom(raw: string | undefined): string {
  if (/[^\w\s:/.*'\-,]/.test(String(raw ?? ''))) return "'self'"
  const tokens = String(raw ?? '')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => /^('self'|'none'|\*|(https?:\/\/)?[a-z0-9*.-]+(:\d+)?|https?:)$/i.test(t))
  if (tokens.includes("'none'")) return "'none'"
  return tokens.length > 0 ? tokens.join(' ') : "'self'"
}

// ───────────────────────── WebSocket Origin ─────────────────────────

export const normOrigin = (o: string): string => o.trim().toLowerCase().replace(/\/+$/, '')

/** ALLOWED_ORIGINS → 'all'(*) | 'same'(비었음: 같은 출처만) | 목록 */
export type OriginPolicy = { kind: 'all' } | { kind: 'same' } | { kind: 'list'; list: string[] }

export function originPolicyFrom(raw: string | undefined): OriginPolicy {
  const list = String(raw ?? '')
    .split(',')
    .map(normOrigin)
    .filter(Boolean)
  if (list.includes('*')) return { kind: 'all' }
  if (list.length === 0) return { kind: 'same' }
  return { kind: 'list', list }
}

export interface OriginRequest {
  origin: string | undefined
  host: string | undefined
  forwardedHost: string | string[] | undefined
  trustProxy: number
}

/**
 * Origin 헤더는 브라우저만 붙인다. 이 검사의 목적은 '남의 웹 페이지가 이 서버를 끌어다 쓰는 것'을 막는 것이므로,
 * 헤더가 없는 비브라우저 클라이언트(점검 도구, 부하 테스트)는 어느 정책에서든 통과시킨다.
 * 기본(목록 없음)은 같은 출처만: Origin 의 host 가 요청 Host(프록시 뒤면 X-Forwarded-Host)와 같아야 한다.
 */
export function originAllowed(policy: OriginPolicy, req: OriginRequest): boolean {
  if (policy.kind === 'all') return true
  if (!req.origin) return true
  const origin = normOrigin(req.origin)
  if (policy.kind === 'list') return policy.list.includes(origin)
  // 'null'(파일로 연 페이지, sandbox iframe) 등 URL 이 아닌 값은 같은 출처일 수 없다
  let originHost: string
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    originHost = u.host
  } catch {
    return false
  }
  const hosts: string[] = []
  if (req.host) hosts.push(req.host)
  if (req.trustProxy > 0 && req.forwardedHost) {
    const fh = Array.isArray(req.forwardedHost) ? req.forwardedHost.join(',') : req.forwardedHost
    // 프록시가 여러 단계면 쉼표로 이어진다. 맨 앞이 브라우저가 처음 연 주소다
    const first = fh.split(',')[0]?.trim()
    if (first) hosts.push(first)
  }
  return hosts.some((h) => sameHost(originHost, h))
}

/** 기본 포트(:80, :443)는 브라우저가 Origin 에서 빼고 보내므로 비교할 때도 뺀다 */
function sameHost(originHost: string, header: string): boolean {
  const strip = (h: string): string => h.trim().toLowerCase().replace(/:(80|443)$/, '')
  return strip(originHost) === strip(header)
}
