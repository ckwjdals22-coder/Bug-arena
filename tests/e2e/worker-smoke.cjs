/**
 * Cloudflare 어댑터(worker/) 연기 시험: `wrangler dev`(로컬 workerd)를 띄우고 실제로 접속해 본다.
 *
 *   준비: npm run build && (cd worker && npm install)
 *   실행: node tests/e2e/worker-smoke.cjs        (WORKER_PORT=8840, STATIC_PORT=8841 이 기본)
 *
 * 확인하는 것
 *   1. /api/rooms, /healthz 응답, 업그레이드 없는 /ws → 426, 남의 Origin → 403
 *   1b. hello 없이 버티는 연결이 방 하나에 MAX_PRE_HELLO(8)를 넘으면 오래된 것부터 끊기고, 정상 입장은 그대로 된다
 *   2. tools/wsprobe.ts --check 전체(Node ws 클라이언트 둘이 같은 방 입장·join 확인·이진 스냅샷 해독·이모트 중계·leave·
 *      같은 방/다른 방 중복 pid 정리·가득 찬 방 우회·전부 가득이면 full·저장본 복원)를 Worker 에 대고 실행
 *   3. 브라우저: (a) Worker 가 정적 에셋까지 서빙하는 주소로 데스크톱, (b) 따로 띄운 정적 서버 + ?server=<Worker> 로 모바일.
 *      둘이 같은 방에서 phase === 'playing', 서로 보이고, NPC 가 실제로 움직이는지.
 * 스크린샷은 tests/e2e/out/worker-*.png 에 남는다.
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')
const { ROOT, OUT, sleep, launch, openPlayer, waitState } = require('./lib.cjs')

const WORKER_PORT = Number(process.env.WORKER_PORT || 8840)
const STATIC_PORT = Number(process.env.STATIC_PORT || 8841)
const WORKER_DIR = path.join(ROOT, 'worker')
const BASE = `http://127.0.0.1:${WORKER_PORT}`

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

async function waitHttp(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(500)
  }
  throw new Error(`${url} 이 응답하지 않습니다`)
}

function startWrangler(tmp) {
  const bin = path.join(WORKER_DIR, 'node_modules/.bin/wrangler')
  if (!fs.existsSync(bin)) throw new Error('worker/node_modules 가 없습니다. 먼저 `cd worker && npm install`')
  if (!fs.existsSync(path.join(ROOT, 'dist/client/index.html'))) throw new Error('dist/client 가 없습니다. 먼저 `npm run build`')
  // 비밀은 임시 파일로만 넘긴다(저장소의 .dev.vars 를 건드리지 않게)
  const envFile = path.join(tmp, 'smoke.env')
  fs.writeFileSync(envFile, 'SAVE_SECRET="worker-smoke-secret-0123456789"\n')
  const args = [
    'dev',
    '--port', String(WORKER_PORT),
    '--ip', '127.0.0.1',
    '--env-file', envFile,
    '--persist-to', path.join(tmp, 'state'),
    '--var', 'ROOMS:2',
    '--var', 'MAX_ROOMS:2',
    '--var', 'ROOM_CAPACITY:5',
    // 기본은 같은 출처만. 아래 3(b)는 클라이언트를 다른 출처(STATIC_PORT)에 따로 올린 경우라 두 출처를 적어 준다
    '--var', `ALLOWED_ORIGINS:http://127.0.0.1:${WORKER_PORT},http://127.0.0.1:${STATIC_PORT}`,
    '--show-interactive-dev-session=false',
  ]
  const proc = spawn(bin, args, { cwd: WORKER_DIR, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const logFile = path.join(OUT, 'worker-wrangler.log')
  const log = fs.createWriteStream(logFile)
  proc.stdout.pipe(log)
  proc.stderr.pipe(log)
  return {
    proc,
    logFile,
    /** wrangler 는 workerd 자식 프로세스를 띄우므로 프로세스 그룹째 끝낸다. 5초 안에 안 끝나면 강제 종료 */
    async stop() {
      const kill = (sig) => {
        try {
          process.kill(-proc.pid, sig)
        } catch {
          /* 이미 끝남 */
        }
      }
      if (proc.exitCode !== null) return
      const exited = new Promise((r) => proc.once('exit', r))
      kill('SIGTERM')
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
      if (!done) kill('SIGKILL')
    },
  }
}

/** dist/client 를 그대로 내주는 최소 정적 서버(클라이언트를 Worker 와 다른 출처에 따로 올린 경우를 흉내) */
function startStatic() {
  const dir = path.join(ROOT, 'dist/client')
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    let p = path.normalize(path.join(dir, decodeURIComponent(u.pathname)))
    if (!p.startsWith(dir)) p = dir
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html')
    if (!fs.existsSync(p)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' })
    fs.createReadStream(p).pipe(res)
  })
  return new Promise((resolve) => server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server)))
}

/** 업그레이드 결과: 'open' 또는 HTTP 상태 코드 */
function upgradeStatus(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/ws?room=1`, { headers })
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

/** 연결만 열고 hello 는 보내지 않는다 */
function openIdle() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/ws?room=1`)
    ws.on('error', () => {})
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', () => resolve(ws))
  })
}

const PROTOCOL_VERSION = Number((fs.readFileSync(path.join(ROOT, 'shared/constants.ts'), 'utf8').match(/PROTOCOL_VERSION\s*=\s*(\d+)/) || [])[1])

/** 정상 클라이언트처럼 hello 를 보내고 welcome/full 중 무엇을 받는지 */
function helloJoin() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}/ws?room=1`)
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
      // 정상 종료(1000): 방이 자리를 지켜 주지 않고 바로 내보낸다(뒤의 인원 검사가 어긋나지 않게)
      if (ws.readyState === WebSocket.OPEN) ws.close(1000)
      else ws.terminate()
    }
    ws.on('error', (e) => done(`error ${e.message}`))
    ws.once('open', () =>
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid: 'smoke-prehello-0001', name: '정상손님', look: [0, 0, 0, 0, 0, 0, 0], save: null })),
    )
    ws.on('message', (d, bin) => {
      if (bin) return
      const m = JSON.parse(String(d))
      if (m.t === 'welcome' || m.t === 'full' || m.t === 'kick') done(m.t)
    })
    setTimeout(() => done('timeout'), 5000)
  })
}

async function npcMotion(page) {
  const snap = () =>
    page.evaluate(() => [...window.__doas.store.npcs.values()].map((n) => [n.pub.id, n.x, n.z]))
  const a = await snap()
  await sleep(2500)
  const b = new Map((await snap()).map(([id, x, z]) => [id, [x, z]]))
  let moved = 0
  for (const [id, x, z] of a) {
    const q = b.get(id)
    if (q && Math.hypot(q[0] - x, q[1] - z) > 0.3) moved++
  }
  return { total: a.length, moved }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-worker-'))
  const wr = startWrangler(tmp)
  let staticServer = null
  let browser = null
  try {
    // 1. HTTP
    const rooms = await (await waitHttp(`${BASE}/api/rooms`)).json()
    check(Array.isArray(rooms.rooms) && rooms.rooms.length === 2 && rooms.policy.capacity === 5, '/api/rooms', JSON.stringify(rooms))
    const health = await (await fetch(`${BASE}/healthz`)).json()
    check(health.ok === true && health.runtime === 'cloudflare', '/healthz', JSON.stringify(health))
    const plain = await fetch(`${BASE}/ws`)
    check(plain.status === 426, '업그레이드 없는 /ws → 426', String(plain.status))
    const cors = await fetch(`${BASE}/api/rooms`, { headers: { origin: 'https://elsewhere.example' } })
    check(cors.headers.get('access-control-allow-origin') === '*', '/api/rooms CORS 헤더')
    const page = await fetch(`${BASE}/`)
    check(page.ok && (await page.text()).includes('<'), 'Worker 정적 에셋(/) 서빙')
    const missing = await fetch(`${BASE}/assets/nope-123.js`)
    check(missing.status === 404, '없는 에셋 → 404', String(missing.status))
    check(/script-src 'self'/.test(page.headers.get('content-security-policy') || ''), '정적 에셋에 CSP(_headers)', String(page.headers.get('content-security-policy')).slice(0, 60))
    check((await upgradeStatus({ origin: 'https://evil.example' })) === 403, '남의 Origin → 403')
    check((await upgradeStatus({})) === 'open', 'Origin 없음(도구) → 연결')

    // 1b. hello 없이 버티는 연결 12개(정원 5인 방 2개) → 방마다 오래된 것부터 끊기고, 정상 입장은 막히지 않는다
    const idle = []
    for (let i = 0; i < 12; i++) idle.push(await openIdle())
    await sleep(600)
    const welcome = await helloJoin()
    check(welcome === 'welcome', 'hello 없는 연결 12개가 있어도 정상 입장은 된다', String(welcome))
    const closedIdle = idle.filter((w) => w.readyState === WebSocket.CLOSED || w.readyState === WebSocket.CLOSING).length
    console.log(`       (hello 없는 연결 중 끊긴 것: ${closedIdle}/12)`)
    for (const w of idle) w.terminate()
    await sleep(500)

    // 2. 프로토콜 전체 점검(Node ws 클라이언트)
    const probe = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'tools/wsprobe.ts', '--check', '--url', `ws://127.0.0.1:${WORKER_PORT}`], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 240_000,
    })
    process.stdout.write(probe.stdout.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n'))
    if (probe.stderr) process.stdout.write(probe.stderr)
    check(probe.status === 0, 'wsprobe --check (입장·스냅샷·이모트·퇴장·중복 pid·가득 참·저장본)', `종료 코드 ${probe.status}`)

    // 3. 브라우저
    staticServer = await startStatic()
    browser = await launch()
    const errors = []
    const pc = await openPlayer(browser, BASE, 'pc', '1', errors)
    const st = await pc.page.evaluate(() => ({ phase: window.__doas.store.phase, room: window.__doas.store.room && window.__doas.store.room.id }))
    check(st.phase === 'playing', '데스크톱(Worker 가 서빙한 클라이언트) phase=playing', JSON.stringify(st))
    const m1 = await npcMotion(pc.page)
    check(m1.total > 0 && m1.moved >= 3, 'NPC 가 움직인다(데스크톱)', `${m1.moved}/${m1.total}명 이동`)

    const staticBase = `http://127.0.0.1:${STATIC_PORT}`
    const mob = await openPlayer(browser, staticBase, 'mobile', '1', errors, `&server=${encodeURIComponent(BASE)}`)
    const ms = await mob.page.evaluate(() => ({ phase: window.__doas.store.phase, origin: location.origin }))
    check(ms.phase === 'playing', '모바일(따로 호스팅 + ?server=Worker) phase=playing', JSON.stringify(ms))
    const meMob = await mob.page.evaluate(() => window.__doas.store.me.id)
    await waitState(pc.page, (s) => s.players.some((p) => p.id === meMob), 10000, '데스크톱에서 모바일 플레이어가 보임')
    check(true, '두 브라우저가 같은 방에서 서로 보인다')
    const m2 = await npcMotion(mob.page)
    check(m2.total > 0 && m2.moved >= 3, 'NPC 가 움직인다(모바일)', `${m2.moved}/${m2.total}명 이동`)

    await pc.page.screenshot({ path: path.join(OUT, 'worker-pc.png') })
    await mob.page.screenshot({ path: path.join(OUT, 'worker-mobile.png') })
    check(errors.length === 0, '브라우저 오류 없음', errors.slice(0, 5).join(' | '))
    await pc.context.close()
    await mob.context.close()

    // 모두 나가면 0명으로 돌아오는지(방 DO 가 로비에 퇴장을 보고)
    let after = null
    for (let i = 0; i < 20; i++) {
      after = await (await fetch(`${BASE}/api/rooms`)).json()
      if (after.rooms.every((r) => r.players === 0)) break
      await sleep(300)
    }
    check(after.rooms.every((r) => r.players === 0), '브라우저가 떠난 뒤 인원 0', JSON.stringify(after.rooms.map((r) => `${r.id}:${r.players}`)))
  } catch (err) {
    failed++
    console.log(`[FAIL] 예외: ${err && err.stack ? err.stack : err}`)
    console.log(`       wrangler 로그: ${wr.logFile}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (staticServer) staticServer.close()
    await wr.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(failed === 0 ? '\nworker-smoke: 전부 통과' : `\nworker-smoke: 실패 ${failed}건`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
