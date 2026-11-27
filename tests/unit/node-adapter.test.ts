/**
 * Node 어댑터 운영 규칙: 로그 한 줄 모양, 압축 협상, WebSocket Origin 기본값, 보안 헤더,
 * DATA_DIR 점검·잠금, 비밀키, 교단 기록 파일(깨진 파일 보존·.bak·프로세스별 임시 파일).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptsEncoding,
  ErrorTally,
  formatLogLine,
  frameAncestorsFrom,
  LogBudget,
  originAllowed,
  originPolicyFrom,
  pickEncoding,
  securityHeaders,
} from '../../server/node/ops'
import {
  acquireDataLock,
  createCultRegistry,
  LOCK_STALE_MS,
  loadSecret,
  LockLostError,
  newPersistStatus,
  PersistFatal,
  probeDataDir,
  restoreSecretFile,
} from '../../server/node/persist'

const dirs: string[] = []
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-node-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o755)
    } catch {
      /* 이미 없음 */
    }
    fs.rmSync(d, { recursive: true, force: true })
  }
})

const NL = String.fromCharCode(10)
type Logged = { level: string; msg: string; extra?: unknown }
const collector = (): { log: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void; lines: Logged[] } => {
  const lines: Logged[] = []
  return { lines, log: (level, msg, extra) => lines.push({ level, msg, extra }) }
}

describe('로그 한 줄', () => {
  it('모든 수준이 JSON 한 줄이고, 신고 기록의 필드가 그대로 남는다', () => {
    const line = formatLogLine('warn', 'report', { room: '1', why: 'abuse', target: 'p_3f9a', targetName: '수상한교주123', by: 'p_aa11' })
    expect(line.includes(NL)).toBe(false)
    const o = JSON.parse(line)
    expect(o).toMatchObject({ level: 'warn', msg: 'report', data: { why: 'abuse', targetName: '수상한교주123', by: 'p_aa11' } })
    expect(typeof o.ts).toBe('string')
  })
  it('오류는 err·stack 을 한 줄 안에 이스케이프해서 담는다', () => {
    const err = new Error(`첫 줄${NL}둘째 줄`)
    const line = formatLogLine('error', '틱 예외', err)
    expect(line.includes(NL)).toBe(false)
    const o = JSON.parse(line)
    expect(o.err).toBe(`첫 줄${NL}둘째 줄`)
    expect(String(o.stack)).toContain('Error')
  })
  it('Map·Set·BigInt·순환 참조에도 한 줄을 지킨다', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(JSON.parse(formatLogLine('info', 'x', { m: new Map([['k', 1]]), s: new Set([2]), b: BigInt(3) })).data).toEqual({ m: { k: 1 }, s: [2], b: '3' })
    const l = formatLogLine('info', 'cyc', cyc)
    expect(l.includes(NL)).toBe(false)
    expect(JSON.parse(l).msg).toBe('cyc')
  })
  it('예산을 넘으면 버린 건수를 세고, 창을 넘기면 돌려준다', () => {
    const b = new LogBudget(3)
    const taken = Array.from({ length: 10 }, () => b.take()).filter(Boolean).length
    expect(taken).toBe(3)
    expect(b.reset()).toBe(7)
    expect(b.take()).toBe(true)
  })
  it('소켓 오류는 종류별 건수로 묶이고 종류 수도 제한된다', () => {
    const t = new ErrorTally()
    for (let i = 0; i < 300; i++) t.add(Object.assign(new Error('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' }))
    for (let i = 0; i < 100; i++) t.add(Object.assign(new Error('Invalid opcode 3'), { code: 'WS_ERR_INVALID_OPCODE' }))
    for (let i = 0; i < 50; i++) t.add(new Error(`random ${i}`))
    const s = t.drain()
    expect(s?.total).toBe(450)
    expect(s?.kinds['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']).toBe(300)
    expect(Object.keys(s?.kinds ?? {}).length).toBeLessThanOrEqual(21)
    expect(t.drain()).toBeNull()
  })
})

describe('Accept-Encoding', () => {
  it('q=0 은 거절이다', () => {
    expect(pickEncoding('identity, br;q=0, gzip;q=0')).toBeNull()
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip')
    expect(pickEncoding('gzip, deflate, br')).toBe('br')
    expect(pickEncoding('br;q=0.0')).toBeNull()
    expect(pickEncoding('br;q=0.5')).toBe('br')
    expect(pickEncoding(undefined)).toBeNull()
  })
  it('* 는 적지 않은 인코딩 전부, *;q=0 이면 거절', () => {
    expect(acceptsEncoding('*', 'br')).toBe(true)
    expect(acceptsEncoding('gzip, *;q=0', 'br')).toBe(false)
    expect(acceptsEncoding('gzip, *;q=0', 'gzip')).toBe(true)
    expect(acceptsEncoding('identity', 'gzip')).toBe(false)
  })
})

describe('WebSocket Origin', () => {
  const req = (origin: string | undefined, host = 'game.example.com', fwd?: string, trustProxy = 0) => ({
    origin,
    host,
    forwardedHost: fwd,
    trustProxy,
  })
  it('기본(비었음): 같은 출처와 Origin 없음만 통과, 남의 출처·null 은 거절', () => {
    const p = originPolicyFrom('')
    expect(p.kind).toBe('same')
    expect(originAllowed(p, req('https://game.example.com'))).toBe(true)
    expect(originAllowed(p, req('https://GAME.example.com/'))).toBe(true)
    expect(originAllowed(p, req(undefined))).toBe(true)
    expect(originAllowed(p, req('https://evil.example'))).toBe(false)
    expect(originAllowed(p, req('null'))).toBe(false)
    expect(originAllowed(p, req('https://game.example.com.evil.example'))).toBe(false)
    // 포트가 다르면 다른 출처
    expect(originAllowed(p, req('http://localhost:5173', 'localhost:8787'))).toBe(false)
    expect(originAllowed(p, req('http://localhost:8787', 'localhost:8787'))).toBe(true)
    // 기본 포트는 브라우저가 Origin 에서 뺀다
    expect(originAllowed(p, req('https://game.example.com', 'game.example.com:443'))).toBe(true)
  })
  it('프록시 뒤: TRUST_PROXY 일 때만 X-Forwarded-Host 를 믿는다', () => {
    const p = originPolicyFrom(undefined)
    expect(originAllowed(p, req('https://game.example.com', '127.0.0.1:8787', 'game.example.com', 1))).toBe(true)
    expect(originAllowed(p, req('https://game.example.com', '127.0.0.1:8787', 'game.example.com', 0))).toBe(false)
    expect(originAllowed(p, req('https://evil.example', '127.0.0.1:8787', 'game.example.com', 1))).toBe(false)
  })
  it('* 는 전부 허용, 목록은 목록만(+ Origin 없음)', () => {
    const all = originPolicyFrom('*')
    expect(originAllowed(all, req('https://evil.example'))).toBe(true)
    expect(originAllowed(all, req('null'))).toBe(true)
    const list = originPolicyFrom('https://play.example.com/, https://portal.example')
    expect(originAllowed(list, req('https://play.example.com', 'x'))).toBe(true)
    expect(originAllowed(list, req('https://portal.example', 'x'))).toBe(true)
    expect(originAllowed(list, req('https://evil.example', 'x'))).toBe(false)
    expect(originAllowed(list, req('null', 'x'))).toBe(false)
    expect(originAllowed(list, req(undefined, 'x'))).toBe(true)
    // 목록이 있으면 같은 출처라도 목록에 없으면 거절(운영자가 정한 대로)
    expect(originAllowed(list, req('https://x', 'x'))).toBe(false)
  })
})

describe('보안 헤더', () => {
  it('CSP 는 외부 스크립트를 막고 이 앱에 필요한 것만 연다', () => {
    const h = securityHeaders("'self'")
    const csp = h['content-security-policy']
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).toContain("connect-src 'self' ws: wss: https:")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(h['permissions-policy']).toContain('camera=()')
  })
  it('Cloudflare 정적 자산용 _headers 가 Node 서버와 같은 보안 헤더를 쓴다', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../client/public/_headers'), 'utf8')
    const h = securityHeaders("'self'")
    const value = (name: string): string | undefined =>
      text
        .split(NL)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim()
    expect(value('content-security-policy')).toBe(h['content-security-policy'])
    expect(value('referrer-policy')).toBe(h['referrer-policy'])
    expect(value('permissions-policy')).toBe(h['permissions-policy'])
  })
  it('FRAME_ANCESTORS: 비면 self, 출처 모양만 받고 헤더 주입은 버린다', () => {
    expect(frameAncestorsFrom(undefined)).toBe("'self'")
    expect(frameAncestorsFrom("'self' https://itch.io https://*.itch.zone")).toBe("'self' https://itch.io https://*.itch.zone")
    // 세미콜론·줄바꿈이 든 토큰은 버린다 → 다른 CSP 지시어나 헤더를 끼워 넣을 수 없다
    expect(frameAncestorsFrom('https://a.example; script-src *')).toBe("'self'")
    expect(frameAncestorsFrom('evil;\r\nx: y')).toBe("'self'")
    expect(frameAncestorsFrom("'none'")).toBe("'none'")
  })
})

describe('DATA_DIR 점검과 잠금', () => {
  it('쓸 수 없는 경로(중간이 파일)면 PersistFatal', () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, 'file'), 'x')
    expect(() => probeDataDir(path.join(d, 'file', 'sub'))).toThrow(PersistFatal)
  })
  it.skipIf(process.getuid?.() === 0)('읽기 전용 폴더면 PersistFatal', () => {
    const d = tmpDir()
    fs.chmodSync(d, 0o555)
    expect(() => probeDataDir(d)).toThrow(PersistFatal)
  })
  it('쓸 수 있으면 흔적을 남기지 않는다', () => {
    const d = tmpDir()
    probeDataDir(path.join(d, 'data'))
    expect(fs.readdirSync(path.join(d, 'data'))).toEqual([])
  })
  it('살아 있는 다른 프로세스의 잠금이 있으면 거절, 풀면 다시 잡힌다', () => {
    const d = tmpDir()
    const a = acquireDataLock(d)
    // 같은 기계의 살아 있는 다른 pid(부모 프로세스)인 척한다
    const info = JSON.parse(fs.readFileSync(a.file, 'utf8'))
    fs.writeFileSync(a.file, JSON.stringify({ ...info, pid: process.ppid }))
    expect(() => acquireDataLock(d)).toThrow(/다른 서버 프로세스/)
    // 내 것이 아니게 바뀐 잠금은 release 가 지우지 않는다
    a.release()
    expect(fs.existsSync(a.file)).toBe(true)
    fs.unlinkSync(a.file)
    const b = acquireDataLock(d)
    b.release()
    expect(fs.existsSync(b.file)).toBe(false)
  })
  it('refresh: 잠금 파일이 사라졌다 돌아와도 스스로 되살리고, 남의 잠금은 갱신하지 않는다', () => {
    const d = tmpDir()
    const lock = acquireDataLock(d)
    const body = fs.readFileSync(lock.file, 'utf8')
    // 평소: 갱신 시각만 바뀐다
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock.file, old, old)
    lock.refresh()
    expect(Date.now() - fs.statSync(lock.file).mtimeMs).toBeLessThan(5000)
    // 디스크가 잠깐 빠졌다 돌아온 상황: 파일이 없다 → 같은 내용으로 다시 만든다(예전에는 영영 실패했다)
    fs.unlinkSync(lock.file)
    lock.refresh()
    expect(fs.readFileSync(lock.file, 'utf8')).toBe(body)
    lock.refresh()
    // 깨진 잠금(쓰다 만 파일)도 내 것으로 다시 쓴다
    fs.writeFileSync(lock.file, '{')
    lock.refresh()
    expect(fs.readFileSync(lock.file, 'utf8')).toBe(body)
    // 그사이 다른 서버가 차지했다면: 계속 실패로 알리고, 그 잠금의 갱신 시각은 건드리지 않는다
    const info = JSON.parse(body)
    fs.writeFileSync(lock.file, JSON.stringify({ ...info, pid: process.ppid, startedAt: info.startedAt + 1 }))
    fs.utimesSync(lock.file, old, old)
    expect(() => lock.refresh()).toThrow(/다른 서버 프로세스/)
    // 어댑터가 '저장 중단'으로 알아볼 수 있게 전용 오류로 던진다
    expect(() => lock.refresh()).toThrow(LockLostError)
    expect(Date.now() - fs.statSync(lock.file).mtimeMs).toBeGreaterThan(30_000)
    // 풀고 나면 refresh 는 아무것도 하지 않는다
    fs.unlinkSync(lock.file)
    lock.release()
    lock.refresh()
    expect(fs.existsSync(lock.file)).toBe(false)
  })

  it('죽은 pid·내 pid(컨테이너 재시작)·오래 갱신 안 된 잠금은 남은 것으로 보고 차지한다', () => {
    const d = tmpDir()
    const file = path.join(d, 'server.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: 1 }))
    acquireDataLock(d).release()
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: 1 }))
    acquireDataLock(d).release()
    // 다른 기계의 잠금: 최근 것이면 거절, 오래됐으면 차지
    fs.writeFileSync(file, JSON.stringify({ pid: 1, host: 'other-machine', startedAt: 1 }))
    expect(() => acquireDataLock(d)).toThrow(PersistFatal)
    const old = new Date(Date.now() - LOCK_STALE_MS - 5000)
    fs.utimesSync(file, old, old)
    acquireDataLock(d).release()
    // 깨진 잠금 파일
    fs.writeFileSync(file, '{')
    const old2 = new Date(Date.now() - LOCK_STALE_MS - 5000)
    fs.utimesSync(file, old2, old2)
    acquireDataLock(d).release()
  })
})

describe('비밀키', () => {
  it('없으면 만들고, 다음 부팅에 같은 값을 읽는다', () => {
    const d = tmpDir()
    const a = loadSecret(d, undefined)
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(loadSecret(d, '')).toBe(a)
    expect(loadSecret(d, '  env-secret-0123456789  ')).toBe('env-secret-0123456789')
  })
  it('돌던 중 파일이 사라지면 메모리의 키로 다시 만들고(다음 부팅이 같은 키를 읽는다), 있는 파일은 건드리지 않는다', () => {
    const d = tmpDir()
    const a = loadSecret(d, undefined)
    expect(restoreSecretFile(d, a)).toBe(false)
    fs.unlinkSync(path.join(d, 'secret'))
    expect(restoreSecretFile(d, a)).toBe(true)
    expect(loadSecret(d, undefined)).toBe(a)
    expect(fs.statSync(path.join(d, 'secret')).mode & 0o777).toBe(0o600)
    // 사람이 바꿔 둔 파일은 덮어쓰지 않는다
    fs.writeFileSync(path.join(d, 'secret'), 'operator-chosen-secret-0123456789\n')
    expect(restoreSecretFile(d, a)).toBe(false)
    expect(loadSecret(d, undefined)).toBe('operator-chosen-secret-0123456789')
  })
  it('짧은 파일은 조용히 넘기지 않고 PersistFatal', () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, 'secret'), 'short\n')
    expect(() => loadSecret(d, undefined)).toThrow(/너무 짧습니다/)
  })
  it('만들 수 없으면 PersistFatal(메모리 임시 키로 돌지 않는다)', () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, 'file'), 'x')
    expect(() => loadSecret(path.join(d, 'file', 'sub'), undefined)).toThrow(PersistFatal)
  })
  it('SAVE_SECRET 이 짧으면 경고만 한다(기존 저장본 보호)', () => {
    const c = collector()
    expect(loadSecret(tmpDir(), 'abc', c.log)).toBe('abc')
    expect(c.lines[0]?.level).toBe('warn')
  })
})

describe('교단 기록 파일', () => {
  const cult = (id: string, name: string) => ({ id, name, color: 1, emblem: 2, leaderName: '교주', title: '' })

  it('저장 → 다시 읽기, 쓸 때마다 이전 것을 .bak 으로 남기고 임시 파일은 프로세스별 이름', async () => {
    const d = tmpDir()
    const file = path.join(d, 'cults.json')
    const st = newPersistStatus()
    const c = collector()
    const r = createCultRegistry({ file, maxCults: 100, log: c.log, status: st })
    r.record(cult('c1', '라면교'), { fol: 3, inf: 10 })
    r.flush(true)
    expect(st.ok).toBe(true)
    expect(st.lastCultSaveAt).toBeGreaterThan(0)
    r.record(cult('c2', '김밥교'), { fol: 1, inf: 1 })
    r.flush(false)
    for (let i = 0; i < 100 && fs.readFileSync(file, 'utf8').indexOf('c2') < 0; i++) await new Promise((res) => setTimeout(res, 10))
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).map((x: { id: string }) => x.id)).toEqual(['c1'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).length).toBe(2)
    expect(fs.readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const again = createCultRegistry({ file, maxCults: 100, log: c.log, status: newPersistStatus() })
    expect(again.get('c1')).toMatchObject({ name: '라면교', fol: 3, inf: 10 })
    expect(again.size).toBe(2)
  })

  it('돌던 중 기록 파일이 사라지면 ensureFile 이 다시 쓰게 한다(기록이 없으면 아무것도 하지 않는다)', () => {
    const d = tmpDir()
    const file = path.join(d, 'cults.json')
    const c = collector()
    const r = createCultRegistry({ file, maxCults: 100, log: c.log, status: newPersistStatus() })
    // 기록이 없으면 만들 파일도 없다
    expect(r.ensureFile()).toBe(false)
    r.record(cult('c1', '라면교'), { fol: 3, inf: 10 })
    r.flush(true)
    expect(r.ensureFile()).toBe(false)
    // 폴더가 비워졌다
    fs.rmSync(file)
    fs.rmSync(`${file}.bak`, { force: true })
    r.flush(true) // 바뀐 것이 없으니 평소에는 쓰지 않는다
    expect(fs.existsSync(file)).toBe(false)
    expect(r.ensureFile()).toBe(true)
    r.flush(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).map((x: { id: string }) => x.id)).toEqual(['c1'])
    expect(r.ensureFile()).toBe(false)
  })

  it('깨진 cults.json 은 덮어쓰지 않고 corrupt-<시각> 으로 옮긴 뒤 .bak 에서 되살린다', () => {
    const d = tmpDir()
    const file = path.join(d, 'cults.json')
    fs.writeFileSync(`${file}.bak`, JSON.stringify([{ id: 'old', name: '옛교', fol: 1, inf: 5 }]))
    fs.writeFileSync(file, '[{"id":"c1","name":"라면')
    const c = collector()
    const r = createCultRegistry({ file, maxCults: 100, log: c.log, status: newPersistStatus(), now: () => 1234 })
    expect(fs.readFileSync(`${file}.corrupt-1234`, 'utf8')).toBe('[{"id":"c1","name":"라면')
    expect(c.lines.some((l) => l.msg.includes('corrupt-1234'))).toBe(true)
    expect(r.get('old')?.inf).toBe(5)
    // 되살린 내용은 다음 저장에 현재 파일로 다시 쓰인다
    r.flush(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].id).toBe('old')
    expect(fs.existsSync(`${file}.corrupt-1234`)).toBe(true)
  })

  it('.bak 도 없으면 빈 상태로 시작하되 깨진 파일은 남아 있다', () => {
    const d = tmpDir()
    const file = path.join(d, 'cults.json')
    fs.writeFileSync(file, '{"not":"array"}')
    const r = createCultRegistry({ file, maxCults: 100, log: collector().log, status: newPersistStatus(), now: () => 99 })
    expect(r.size).toBe(0)
    expect(fs.existsSync(`${file}.corrupt-99`)).toBe(true)
    r.record(cult('n', '새교'), { fol: 0, inf: 1 })
    r.flush(true)
    expect(fs.readFileSync(`${file}.corrupt-99`, 'utf8')).toBe('{"not":"array"}')
  })

  it('쓰기 도중 죽어 현재 파일이 없으면 .bak 을 읽는다', () => {
    const d = tmpDir()
    const file = path.join(d, 'cults.json')
    fs.writeFileSync(`${file}.bak`, JSON.stringify([{ id: 'b', name: '백업교', fol: 2, inf: 7 }]))
    const r = createCultRegistry({ file, maxCults: 100, log: collector().log, status: newPersistStatus() })
    expect(r.get('b')?.fol).toBe(2)
  })

  it('저장에 실패하면 상태가 not-ok 가 되고, 다시 성공하면 회복한다', () => {
    const d = tmpDir()
    const sub = path.join(d, 'sub')
    fs.mkdirSync(sub)
    const file = path.join(sub, 'cults.json')
    const st = newPersistStatus()
    const c = collector()
    const r = createCultRegistry({ file, maxCults: 100, log: c.log, status: st })
    r.record(cult('c1', '라면교'), { fol: 1, inf: 1 })
    // 폴더 자리를 파일로 바꿔 쓰기를 실패시킨다
    fs.rmSync(sub, { recursive: true })
    fs.writeFileSync(sub, 'x')
    r.flush(true)
    expect(st.ok).toBe(false)
    expect(st.lastError).toMatch(/cults/)
    expect(c.lines.some((l) => l.level === 'error')).toBe(true)
    fs.rmSync(sub)
    r.flush(true)
    expect(st.ok).toBe(true)
    expect(st.lastError).toBeNull()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].id).toBe('c1')
  })
})
