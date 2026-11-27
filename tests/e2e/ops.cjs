/**
 * 운영(서버 수명) E2E: 실제 dist/server/main.js 프로세스를 띄우고 죽이고 다시 띄운다.
 *
 *   준비: npm run build
 *   실행: E2E_PORT=9046 node tests/e2e/ops.cjs
 *
 * 확인하는 것
 *   1. /healthz 모양(persist 포함), 로그가 JSON 한 줄씩인지, 없는 /assets → 404, HTML 보안 헤더, Accept-Encoding q=0
 *   2. WebSocket Origin 기본값(같은 출처만): 남의 출처·null → 403, 같은 출처·Origin 없음 → 연결
 *   3. 같은 DATA_DIR 에 두 번째 프로세스 → exit 1(한 줄 이유)
 *   4. SIGTERM → 접속자에게 '점검' 안내 → 새 프로세스에 자동 재접속, 진행도·교단 기록 유지, 잠금 해제
 *   5. kill -9 → 다음 부팅이 남은 잠금을 알아보고 뜬다, cults.json 은 온전한 JSON
 *   6. 깨진 cults.json → cults.json.corrupt-<시각> 으로 보존되고 .bak 에서 되살아난다
 *   7. 쓸 수 없는 DATA_DIR · 너무 짧은 secret 파일 → exit 1
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')
const { ROOT, sleep, launch, openPlayer, state, waitState, pitchOnce } = require('./lib.cjs')

const PORT = Number(process.env.E2E_PORT || 9046)
const BASE = `http://localhost:${PORT}`
const ENTRY = path.join(ROOT, 'dist/server/main.js')

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

/** 서버 프로세스 하나. 출력은 줄 단위로 모아 둔다(JSON 한 줄 검사용) */
function start(dataDir, extraEnv = {}, port = PORT) {
  const proc = spawn(process.execPath, ['--enable-source-maps', ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ROOMS: '1', ROOM_CAPACITY: '20', SAVE_SECRET: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  const take = (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push(l)
  }
  proc.stdout.on('data', take)
  proc.stderr.on('data', take)
  const exited = new Promise((r) => proc.once('exit', (code, sig) => r({ code, sig })))
  return { proc, lines, exited }
}

async function waitHealthy(timeout = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return res.json()
    } catch {
      /* 아직 */
    }
    await sleep(150)
  }
  throw new Error('서버가 healthy 가 되지 않았습니다')
}

async function exitWithin(srv, ms) {
  return Promise.race([srv.exited, sleep(ms).then(() => null)])
}

/** 업그레이드 결과: 'open' 또는 HTTP 상태 코드 */
function tryWs(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=1`, { headers })
    const done = (v) => {
      resolve(v)
      try {
        ws.terminate()
      } catch {
        /* 이미 닫힘 */
      }
    }
    ws.once('open', () => done('open'))
    ws.once('unexpected-response', (_req, res) => done(res.statusCode))
    ws.once('error', (e) => done(`error ${e.message}`))
  })
}

async function main() {
  if (!fs.existsSync(ENTRY)) throw new Error('dist/server/main.js 가 없습니다. 먼저 npm run build')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-ops-'))
  const data = path.join(tmp, 'data')
  let srv = start(data)
  let browser = null
  const errors = []
  try {
    // ── 1. HTTP ──
    const h = await waitHealthy()
    check(h.ok === true && h.persist && h.persist.ok === true && 'lastCultSaveAt' in h.persist && 'lastError' in h.persist, '/healthz 에 persist{ok,lastCultSaveAt,lastError}', JSON.stringify(h.persist))
    check(['rooms', 'players', 'conns', 'uptime', 'tickMsP95'].every((k) => k in h), '/healthz 기본 필드', Object.keys(h).join(','))
    const nonJson = srv.lines.filter((l) => {
      try {
        const o = JSON.parse(l)
        return !(o.ts && o.level && o.msg)
      } catch {
        return true
      }
    })
    check(srv.lines.length > 0 && nonJson.length === 0, '로그가 전부 JSON 한 줄(ts·level·msg)', nonJson.slice(0, 2).join(' | '))
    for (const p of ['/assets/whatever', '/assets/', '/assets', '/assets/nope.js']) {
      const r = await fetch(BASE + p)
      check(r.status === 404 && !/immutable/.test(r.headers.get('cache-control') || ''), `없는 ${p} → 404(영구 캐시 없음)`, `${r.status} ${r.headers.get('cache-control')}`)
    }
    const page = await fetch(`${BASE}/`)
    const csp = page.headers.get('content-security-policy') || ''
    check(/script-src 'self'/.test(csp) && /frame-ancestors 'self'/.test(csp), 'HTML 에 CSP', csp.slice(0, 80))
    check(!!page.headers.get('referrer-policy') && !!page.headers.get('permissions-policy'), 'HTML 에 referrer-policy·permissions-policy')
    const html = await page.text()
    const js = (html.match(/\/assets\/index-[^"]+\.js/) || [])[0]
    const noBr = await fetch(BASE + js, { headers: { 'accept-encoding': 'identity, br;q=0, gzip;q=0' } })
    check(!noBr.headers.get('content-encoding'), 'Accept-Encoding q=0 이면 압축하지 않는다', String(noBr.headers.get('content-encoding')))
    const three = (html.match(/\/assets\/three-[^"]+\.js/) || [])[0]
    check(!!three, 'three.js 가 별도 청크(modulepreload)로 나간다', String(three))
    const lic = await fetch(`${BASE}/THIRD_PARTY_LICENSES.txt`)
    check(lic.ok && (await lic.text()).includes('three.js authors'), '제3자 라이선스 고지 제공')
    const man = await fetch(`${BASE}/manifest.webmanifest`)
    const manifest = man.ok ? await man.json() : {}
    check(manifest.display === 'standalone' && (manifest.icons || []).some((i) => i.purpose === 'maskable'), '매니페스트(standalone, maskable 아이콘)')

    // ── 2. Origin ──
    check((await tryWs({ origin: 'https://evil.example' })) === 403, '남의 출처 → 403')
    check((await tryWs({ origin: 'null' })) === 403, 'Origin null → 403')
    check((await tryWs({ origin: BASE })) === 'open', '같은 출처 → 연결')
    check((await tryWs({})) === 'open', 'Origin 없음(도구) → 연결')

    // ── 3. 같은 DATA_DIR 에 두 번째 프로세스 ──
    const second = start(data, {}, PORT + 1)
    const r2 = await exitWithin(second, 10000)
    check(r2 && r2.code === 1, '같은 DATA_DIR 의 두 번째 서버 → exit 1', JSON.stringify(r2))
    check(second.lines.some((l) => l.includes('다른 서버 프로세스')), '이유가 한 줄로 남는다', second.lines.slice(-1)[0])

    // ── 4. SIGTERM → 재접속, 진행도 유지 ──
    browser = await launch()
    const A = await openPlayer(browser, BASE, 'pc', 1, errors)
    const B = await openPlayer(browser, BASE, 'mobile', 1, errors)
    for (const p of [A.page, B.page]) await p.locator('.tutorial-skip').click({ timeout: 3000 }).catch(() => {})
    await A.page.evaluate(() => window.__doas.net.send({ t: 'cultCreate', name: '점검교', color: 2, emblem: 1, title: '점검장' }))
    for (let i = 0; i < 6; i++) {
      const s = await state(A.page)
      if (s.inf > 0) break
      await pitchOnce(A.page)
    }
    await sleep(1500)
    const before = await state(A.page)
    check(before.inf > 0, '종료 전 진행도가 있다', `inf ${before.inf}, fol ${before.fol}`)
    const phases = []
    await A.page.exposeFunction('__opsPhase', (p) => phases.push(p))
    await A.page.evaluate(() => window.__doas.bus.on('phase', (p) => window.__opsPhase(String(p))))
    srv.proc.kill('SIGTERM')
    const ex = await exitWithin(srv, 5000)
    check(ex && ex.code === 0, 'SIGTERM → 정상 종료(exit 0)', JSON.stringify(ex))
    check(!fs.existsSync(path.join(data, 'server.lock')), '종료하면 잠금 파일을 지운다')
    const cultsFile = path.join(data, 'cults.json')
    const saved = fs.existsSync(cultsFile) ? JSON.parse(fs.readFileSync(cultsFile, 'utf8')) : []
    check(saved.some((c) => c.name === '점검교'), '종료 직전 교단 기록이 저장된다', `${saved.length}개`)
    const told = await A.page.evaluate(() => window.__doas.store.phase)
    check(told === 'reconnecting' || phases.includes('reconnecting'), '접속자에게 점검(재접속 중) 안내', `${told} / ${phases.join(',')}`)
    await sleep(800)
    srv = start(data)
    await waitHealthy()
    const sA = await waitState(A.page, (x) => x.phase === 'playing' && x.id > 0, 60000, 'A 재접속')
    const sB = await waitState(B.page, (x) => x.phase === 'playing' && x.id > 0, 60000, 'B 재접속')
    check(sA.inf === before.inf && sA.fol >= 0 && sA.cult, '재시작 뒤 진행도·교단 유지(PC)', `inf ${before.inf}→${sA.inf}, cult ${JSON.stringify(sA.cult)}`)
    check(sB.phase === 'playing', '재시작 뒤 자동 재접속(모바일)')
    const rooms = await (await fetch(`${BASE}/api/rooms`)).json()
    check(rooms.rooms[0].players === 2, '두 사람 모두 같은 방으로 돌아왔다', JSON.stringify(rooms.rooms))
    await A.context.close()
    await B.context.close()

    // ── 5. kill -9 ──
    srv.proc.kill('SIGKILL')
    await srv.exited
    check(fs.existsSync(path.join(data, 'server.lock')), 'kill -9 뒤에는 잠금이 남아 있다(정상)')
    srv = start(data)
    const h5 = await waitHealthy()
    check(h5.ok === true, 'kill -9 뒤 다시 띄우면 남은 잠금을 알아보고 뜬다')
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(cultsFile, 'utf8'))
    } catch {
      parsed = null
    }
    check(Array.isArray(parsed) && parsed.some((c) => c.name === '점검교'), 'kill -9 뒤에도 cults.json 은 온전하다')
    srv.proc.kill('SIGTERM')
    await srv.exited

    // ── 6. 깨진 cults.json ──
    const good = fs.readFileSync(cultsFile, 'utf8')
    fs.writeFileSync(`${cultsFile}.bak`, good)
    fs.writeFileSync(cultsFile, good.slice(0, Math.floor(good.length / 2)))
    srv = start(data)
    await waitHealthy()
    const corrupt = fs.readdirSync(data).filter((f) => f.startsWith('cults.json.corrupt-'))
    check(corrupt.length === 1 && fs.readFileSync(path.join(data, corrupt[0]), 'utf8') === good.slice(0, Math.floor(good.length / 2)), '깨진 파일은 corrupt-<시각> 으로 보존', corrupt.join(','))
    check(srv.lines.some((l) => l.includes('corrupt-')), '로그에 옮긴 사실이 남는다')
    const h6 = await (await fetch(`${BASE}/healthz`)).json()
    check(h6.ok === true && h6.persist.ok === true, '깨진 파일을 치운 뒤 정상 운영', JSON.stringify(h6.persist))
    srv.proc.kill('SIGTERM')
    await srv.exited
    const restored = JSON.parse(fs.readFileSync(cultsFile, 'utf8'))
    check(restored.some((c) => c.name === '점검교'), '.bak 에서 교단 기록을 되살렸다(종료 때 다시 저장)', `${restored.length}개`)

    // ── 7. 쓸 수 없는 DATA_DIR, 짧은 비밀키 ──
    const blocker = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const bad = start(path.join(blocker, 'sub'))
    const r7 = await exitWithin(bad, 10000)
    check(r7 && r7.code === 1, '쓸 수 없는 DATA_DIR → exit 1', JSON.stringify(r7))
    check(bad.lines.length === 1 && JSON.parse(bad.lines[0]).level === 'error', '이유는 JSON 한 줄', bad.lines.join(' | ').slice(0, 160))
    const shortDir = path.join(tmp, 'short')
    fs.mkdirSync(shortDir)
    fs.writeFileSync(path.join(shortDir, 'secret'), 'short\n')
    const sh = start(shortDir)
    const r8 = await exitWithin(sh, 10000)
    check(r8 && r8.code === 1 && sh.lines.some((l) => l.includes('너무 짧')), '너무 짧은 secret 파일 → exit 1', sh.lines.join(' | ').slice(0, 160))

    // 서버가 내려가 있던 사이의 재접속 시도 실패는 예상된 것이다
    const unexpected = errors.filter((e) => !/ERR_CONNECTION_REFUSED/.test(e))
    check(unexpected.length === 0, '브라우저 오류 없음(재시작 중 연결 거부 제외)', unexpected.slice(0, 3).join(' | '))
  } catch (err) {
    failed++
    console.log(`[FAIL] 예외: ${err && err.stack ? err.stack : err}`)
    console.log(srv.lines.slice(-10).join('\n'))
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (srv.proc.exitCode === null) {
      srv.proc.kill('SIGTERM')
      await exitWithin(srv, 3000)
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(failed === 0 ? '\nops: 전부 통과' : `\nops: 실패 ${failed}건`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
