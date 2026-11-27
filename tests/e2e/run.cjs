#!/usr/bin/env node
/**
 * 종단 간(E2E) 검증: 실제 서버를 띄우고 브라우저 두 개(PC + 모바일 에뮬레이션)로 접속해
 * 명세의 "완성 및 테스트 조건"을 하나씩 확인한다.
 *
 *   npm run build && npm run test:e2e
 *   (옵션) E2E_PORT=8899  E2E_KEEP=1(서버를 끄지 않음)  E2E_URL=http://… (이미 떠 있는 서버 사용)
 *
 * Playwright 는 전역 설치본을 쓴다. 결과 스크린샷은 tests/e2e/out/ 에 남는다.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(__dirname, 'out')
const PORT = Number(process.env.E2E_PORT || 8899)
const BASE = process.env.E2E_URL || `http://localhost:${PORT}`
const results = []
let server = null
let serverDataDir = ''

function log(...a) {
  console.log('[e2e]', ...a)
}
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
    return true
  } catch (err) {
    record(name, false, String(err && err.message ? err.message : err))
    return false
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startServer() {
  if (process.env.E2E_URL) return
  const entry = path.join(ROOT, 'dist/server/main.js')
  assert(fs.existsSync(entry), 'dist/server/main.js 가 없습니다. 먼저 npm run build 를 실행하세요.')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-e2e-'))
  serverDataDir = dataDir
  server = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ROOMS: '3', ROOM_CAPACITY: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write('[server] ' + d))
  server.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d))
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(200)
  }
  throw new Error('서버가 뜨지 않았습니다')
}

/** 페이지 안의 게임 상태를 요약해서 가져온다 */
function snapshot(page) {
  return page.evaluate(() => {
    const g = window.__doas
    if (!g) return null
    const s = g.store
    const me = s.me
    return {
      phase: s.phase,
      why: s.phaseWhy,
      room: s.room ? s.room.id : null,
      id: me ? me.id : 0,
      x: me ? me.x : 0,
      z: me ? me.z : 0,
      fol: me ? me.prog.fol : 0,
      inf: me ? me.prog.inf : 0,
      rank: me ? me.prog.rank : 0,
      entourage: me ? me.entourage : 0,
      emote: me ? me.emote : null,
      name: s.profile.name,
      players: [...s.players.values()].map((p) => ({ id: p.pub.id, name: p.pub.name, x: p.x, z: p.z, emote: p.emote, st: p.st })),
      npcs: [...s.npcs.values()].map((n) => ({ id: n.pub.id, x: n.x, z: n.z, owner: n.pub.owner, st: n.st, role: n.pub.role, model: n.pub.model })),
      talk: s.talk ? { npc: s.talk.npc, lines: s.talk.lines, round: s.talk.round, waiting: s.talk.waiting } : null,
    }
  })
}
async function waitFor(page, predicate, timeout = 10000, label = 'condition') {
  const end = Date.now() + timeout
  let last = null
  while (Date.now() < end) {
    last = await snapshot(page)
    if (last && predicate(last)) return last
    await sleep(100)
  }
  throw new Error(`시간 초과: ${label} (마지막 상태: ${last ? JSON.stringify({ phase: last.phase, why: last.why, players: last.players.length, npcs: last.npcs.length }) : 'null'})`)
}
function watchErrors(page, tag, bag) {
  page.on('pageerror', (e) => bag.push(`${tag} exception: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') bag.push(`${tag} console.error: ${m.text()}`)
  })
}

/** CDP 로 터치 드래그(가상 조이스틱)를 흉내 낸다 */
async function touchDrag(page, from, to, holdMs) {
  const cdp = await page.context().newCDPSession(page)
  const pt = (p) => [{ x: p.x, y: p.y, id: 1, radiusX: 8, radiusY: 8, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) })
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(p) })
    await sleep(20)
  }
  await sleep(holdMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  await startServer()
  log('server ready at', BASE)
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const errors = []
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const ctxB = await browser.newContext({ ...devices['iPhone 13'] })
  let A = await ctxA.newPage()
  const B = await ctxB.newPage()
  watchErrors(A, 'A(PC)', errors)
  watchErrors(B, 'B(mobile)', errors)

  try {
    // ── 1. 접속 ──
    await check('PC: 접속하면 별도 절차 없이 게임에 들어간다', async () => {
      const t0 = Date.now()
      await A.goto(`${BASE}/?room=1`, { waitUntil: 'load' })
      const s = await waitFor(A, (x) => x.phase === 'playing' && x.id > 0, 20000, 'A playing')
      assert(s.npcs.length > 0, 'NPC가 없습니다')
      assert(s.name && s.name.length >= 2, '임의 닉네임이 없습니다')
      return `입장 ${Date.now() - t0}ms, 닉네임 "${s.name}", NPC ${s.npcs.length}명`
    })
    await check('모바일: 접속하면 게임에 들어간다', async () => {
      await B.goto(`${BASE}/?room=1`, { waitUntil: 'load' })
      const s = await waitFor(B, (x) => x.phase === 'playing' && x.id > 0, 20000, 'B playing')
      return `닉네임 "${s.name}"`
    })
    const a0 = await snapshot(A)
    const b0 = await snapshot(B)

    // ── 2. 서로 보임 ──
    await check('같은 방의 두 브라우저에서 서로의 캐릭터가 보인다', async () => {
      const a = await waitFor(A, (x) => x.players.some((p) => p.id === b0.id), 5000, 'A sees B')
      const b = await waitFor(B, (x) => x.players.some((p) => p.id === a0.id), 5000, 'B sees A')
      assert(a.players.length === 1 && b.players.length === 1, `접속자 수가 맞지 않습니다 (A:${a.players.length}, B:${b.players.length})`)
      return `A(id ${a0.id}) ↔ B(id ${b0.id})`
    })
    await check('방 목록 API가 실제 접속자 수와 NPC 수를 구분해 알려준다', async () => {
      const res = await fetch(`${BASE}/api/rooms`)
      const data = await res.json()
      const r1 = data.rooms.find((r) => r.id === '1')
      assert(r1, '1번 방이 없습니다')
      assert(r1.players === 2, `players=${r1.players} (기대 2)`)
      assert(r1.npcs > 0 && r1.cap === 20, `npcs=${r1.npcs}, cap=${r1.cap}`)
      assert(data.rooms.length === 3, `방 개수 ${data.rooms.length}`)
      return `1번 방 👤${r1.players}/${r1.cap} 🤖${r1.npcs}, 방 ${data.rooms.length}개`
    })

    // ── 3. PC 이동 + 동기화 ──
    await check('PC: 키보드(WASD)로 캐릭터를 이동할 수 있다', async () => {
      await A.locator('#game').click({ position: { x: 640, y: 200 } }).catch(() => {})
      await sleep(300)
      const before = await snapshot(A)
      await A.keyboard.down('KeyW')
      await sleep(1200)
      await A.keyboard.up('KeyW')
      await A.keyboard.down('KeyD')
      await sleep(700)
      await A.keyboard.up('KeyD')
      await sleep(300)
      const after = await snapshot(A)
      const d = Math.hypot(after.x - before.x, after.z - before.z)
      assert(d > 1.5, `이동 거리 ${d.toFixed(2)}m`)
      return `${d.toFixed(1)}m 이동`
    })
    await check('한쪽에서 이동하면 다른 쪽 화면에도 이동이 표시된다', async () => {
      await sleep(600)
      const a = await snapshot(A)
      const b = await waitFor(
        B,
        (x) => {
          const p = x.players.find((q) => q.id === a.id)
          return p && Math.hypot(p.x - a.x, p.z - a.z) < 0.6
        },
        4000,
        'B sees A moved',
      )
      const p = b.players.find((q) => q.id === a.id)
      return `B가 본 A 위치 오차 ${Math.hypot(p.x - a.x, p.z - a.z).toFixed(2)}m`
    })

    // ── 4. 모바일 이동 ──
    await check('모바일: 가상 조이스틱(터치 드래그)으로 이동할 수 있다', async () => {
      const before = await snapshot(B)
      const vp = B.viewportSize()
      await touchDrag(B, { x: vp.width * 0.25, y: vp.height * 0.7 }, { x: vp.width * 0.25, y: vp.height * 0.7 - 70 }, 1400)
      await sleep(300)
      const after = await snapshot(B)
      const d = Math.hypot(after.x - before.x, after.z - before.z)
      assert(d > 1.5, `이동 거리 ${d.toFixed(2)}m`)
      const a = await waitFor(
        A,
        (x) => {
          const p = x.players.find((q) => q.id === after.id)
          return p && Math.hypot(p.x - after.x, p.z - after.z) < 0.6
        },
        4000,
        'A sees B moved',
      )
      void a
      return `${d.toFixed(1)}m 이동, PC 화면에도 반영`
    })

    // ── 5. 행동 동기화 ──
    await check('행동(이모트)이 다른 이용자에게 실시간으로 보인다', async () => {
      // PC: 숫자 키 7 = 신비로운 춤 (내부 함수가 아니라 실제 키 입력)
      await A.keyboard.press('Digit7')
      const b = await waitFor(B, (x) => x.players.some((p) => p.id === a0.id && p.emote === 'dance'), 3000, 'B sees dance')
      void b
      // 모바일: [이모트] 버튼 → 시트에서 '손 흔들기'를 손가락으로 누른다
      await B.locator('.emotes-tbtn[aria-label="이모트"]').tap()
      await B.locator('.emotes-tile', { hasText: '손 흔들기' }).tap()
      await waitFor(A, (x) => x.players.some((p) => p.id === b0.id && p.emote === 'wave'), 3000, 'A sees wave')
      return 'A 숫자 키 7(춤) → B 화면, B 이모트 시트에서 손 흔들기 탭 → A 화면'
    })
    await A.screenshot({ path: path.join(OUT, '01-pc-two-players.png') })
    await B.screenshot({ path: path.join(OUT, '02-mobile-two-players.png') })

    // ── 6. NPC 포교 ──
    let joined = false
    await check('NPC에게 다가가 말을 걸고 포교 멘트를 고를 수 있다', async () => {
      const tried = new Set()
      let outcomes = []
      for (let attempt = 0; attempt < 14 && !joined; attempt++) {
        const s = await snapshot(A)
        const cand = s.npcs
          .filter((n) => !tried.has(n.id) && n.owner === 0 && n.role === '' && n.model === 0)
          .map((n) => ({ ...n, d: Math.hypot(n.x - s.x, n.z - s.z) }))
          .sort((p, q) => p.d - q.d)[0]
        if (!cand) break
        tried.add(cand.id)
        // 시민 곁까지는 걸어가고(이동 자체는 3·4번에서 키보드·터치로 검증했다),
        // 말 걸기와 멘트 고르기는 화면에 보이는 것을 실제로 누른다
        await A.evaluate((id) => {
          const g = window.__doas
          const v = g.store.npcs.get(id)
          if (v) g.player.moveTo(v.x, v.z)
        }, cand.id)
        const talkBtn = A.locator('.hud-action[aria-label="말 걸기"]')
        try {
          await talkBtn.waitFor({ state: 'visible', timeout: 12000 })
        } catch {
          continue
        }
        // PC: E 키 = 큰 상황 버튼(말 걸기)
        await A.keyboard.press('KeyE')
        let talk = null
        try {
          talk = (await waitFor(A, (x) => x.talk !== null, 4000, 'talk open')).talk
        } catch {
          continue
        }
        tried.add(talk.npc)
        assert(talk.lines.length >= 2, '멘트 선택지가 부족합니다')
        assert((await A.locator('.talk-line').count()) === talk.lines.length, '화면의 멘트 버튼 수가 서버가 준 멘트 수와 다릅니다')
        // 시트는 뜬 직후 잠깐(연타 방지) 누름을 받지 않는다. 사람이 멘트를 읽는 시간만큼 기다린다
        await sleep(450)
        // 최대 2라운드
        for (let round = 0; round < 2; round++) {
          const cur = (await snapshot(A)).talk
          if (!cur) break
          const res = A.evaluate(
            () =>
              new Promise((resolve) => {
                const g = window.__doas
                const off = g.bus.onMsg('pitchRes', (m) => {
                  if (m.p === g.store.me.id) {
                    off()
                    resolve(m.o)
                  }
                })
                setTimeout(() => resolve('timeout'), 6000)
              }),
          )
          // 첫 번째 멘트 카드를 마우스로 누른다
          await A.locator('.talk-line').first().click()
          const o = await res
          outcomes.push(o)
          if (o === 'join' || o === 'king') joined = true
          if (o !== 'more') break
          await waitFor(A, (x) => x.talk !== null && x.talk.round === 2 && !x.talk.waiting, 4000, 'round 2')
        }
        await sleep(2400) // 포교 쿨타임
      }
      assert(outcomes.length > 0, '포교 결과를 한 번도 받지 못했습니다')
      return `시도 결과: ${outcomes.join(', ')}`
    })
    await check('포교에 성공하면 신도 수가 늘고 신도가 따라다닌다', async () => {
      assert(joined, '14번 시도 안에 합류가 나오지 않았습니다(확률 문제일 수 있음)')
      const a = await waitFor(A, (x) => x.fol >= 1 && x.entourage >= 1, 4000, 'fol++')
      const b = await waitFor(B, (x) => x.npcs.some((n) => n.owner === a.id), 4000, 'B sees follower')
      void b
      return `신도 ${a.fol}명(동행 ${a.entourage}), 영향력 ${a.inf} — 다른 사람 화면에도 따라다니는 신도로 표시`
    })
    await A.screenshot({ path: path.join(OUT, '03-pc-after-pitch.png') })

    await check('모바일: 터치로 [말 걸기]와 멘트를 눌러 포교할 수 있다', async () => {
      const outcomes = []
      for (let attempt = 0; attempt < 6 && outcomes.length === 0; attempt++) {
        const s = await snapshot(B)
        const cand = s.npcs
          .filter((n) => n.owner === 0 && n.role === '' && n.model === 0)
          .map((n) => ({ ...n, d: Math.hypot(n.x - s.x, n.z - s.z) }))
          .sort((p, q) => p.d - q.d)[attempt % 3]
        if (!cand) break
        await B.evaluate((id) => {
          const g = window.__doas
          const v = g.store.npcs.get(id)
          if (v) g.player.moveTo(v.x, v.z)
        }, cand.id)
        const talkBtn = B.locator('.hud-action[aria-label="말 걸기"]')
        try {
          await talkBtn.waitFor({ state: 'visible', timeout: 12000 })
          await talkBtn.tap({ timeout: 3000 })
          await waitFor(B, (x) => x.talk !== null, 4000, 'talk open (mobile)')
        } catch {
          continue
        }
        const res = B.evaluate(
          () =>
            new Promise((resolve) => {
              const g = window.__doas
              const off = g.bus.onMsg('pitchRes', (m) => {
                if (m.p === g.store.me.id) {
                  off()
                  resolve(m.o)
                }
              })
              setTimeout(() => resolve('timeout'), 6000)
            }),
        )
        await sleep(450)
        await B.locator('.talk-line').first().tap()
        const o = await res
        if (o !== 'timeout') outcomes.push(o)
        // 대화가 이어지는 결과('더 들어볼게요')면 [그만두기]도 눌러 본다
        if (o === 'more') await B.locator('.talk-quit').tap({ timeout: 3000 }).catch(() => {})
      }
      assert(outcomes.length > 0, '터치로 포교 결과를 받지 못했습니다')
      return `결과: ${outcomes.join(', ')}`
    })

    // ── 7. 퇴장 ──
    const aBeforeLeave = await snapshot(A)
    await check('접속자가 나가면 다른 사람 화면에서 캐릭터가 사라진다', async () => {
      await A.close()
      await waitFor(B, (x) => !x.players.some((p) => p.id === aBeforeLeave.id), 5000, 'B sees A leave')
      const res = await fetch(`${BASE}/api/rooms`)
      const data = await res.json()
      const r1 = data.rooms.find((r) => r.id === '1')
      assert(r1.players === 1, `players=${r1.players} (기대 1)`)
      return '퇴장 즉시 반영, 방 인원 1명'
    })

    // ── 8. 재접속 ──
    await check('다시 접속해도 정상적으로 플레이되고 진행도가 이어진다', async () => {
      A = await ctxA.newPage()
      watchErrors(A, 'A2(PC)', errors)
      await A.goto(`${BASE}/?room=1`, { waitUntil: 'load' })
      const s = await waitFor(A, (x) => x.phase === 'playing' && x.id > 0, 20000, 'A replay')
      assert(s.fol === aBeforeLeave.fol, `신도 수가 이어지지 않았습니다 (${s.fol} ≠ ${aBeforeLeave.fol})`)
      assert(s.name === aBeforeLeave.name, '닉네임이 바뀌었습니다')
      await waitFor(B, (x) => x.players.some((p) => p.id === s.id), 5000, 'B sees A again')
      await A.keyboard.down('KeyS')
      await sleep(600)
      await A.keyboard.up('KeyS')
      const s2 = await snapshot(A)
      assert(Math.hypot(s2.x - s.x, s2.z - s.z) > 0.5, '재접속 후 이동이 안 됩니다')
      return `신도 ${s.fol}명 유지, 닉네임 유지, 이동 가능`
    })

    // ── 9. 끊김 후 자동 재연결 ──
    await check('연결이 끊기면 자동으로 다시 연결된다', async () => {
      const before = await snapshot(B)
      await B.evaluate(() => window.__doas.net.debugDrop())
      await waitFor(B, (x) => x.phase === 'reconnecting', 3000, 'B reconnecting')
      const s = await waitFor(B, (x) => x.phase === 'playing' && x.id > 0, 15000, 'B back to playing')
      assert(s.name === before.name, '닉네임이 바뀌었습니다')
      await waitFor(A, (x) => x.players.some((p) => p.id === s.id), 5000, 'A sees B again')
      return `끊김 → 재접속 중 → 다시 플레이 (id ${before.id} → ${s.id})`
    })
    if (server) {
      await check('서버가 재시작돼도 자동 재접속되고 진행도가 유지된다', async () => {
        const before = await snapshot(A)
        const env = { ...process.env, PORT: String(PORT), DATA_DIR: serverDataDir, ROOMS: '3', ROOM_CAPACITY: '20' }
        server.kill('SIGTERM')
        await sleep(1200)
        server = spawn(process.execPath, [path.join(ROOT, 'dist/server/main.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
        server.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d))
        const s = await waitFor(A, (x) => x.phase === 'playing' && x.id > 0 && x.npcs.length > 0, 30000, 'A back after restart')
        await waitFor(B, (x) => x.phase === 'playing' && x.id > 0, 30000, 'B back after restart')
        assert(s.fol === before.fol && s.inf === before.inf, `진행도 불일치: 신도 ${s.fol}/${before.fol}, 영향력 ${s.inf}/${before.inf}`)
        return `재시작 후 재접속, 신도 ${s.fol}명·영향력 ${s.inf} 유지`
      })
    }

    // ── 10. 중복 접속 ──
    await check('같은 이용자가 다른 탭에서 접속하면 이전 탭은 안내와 함께 끊긴다', async () => {
      const A3 = await ctxA.newPage()
      await A3.goto(`${BASE}/?room=2`, { waitUntil: 'load' })
      await waitFor(A3, (x) => x.phase === 'playing', 20000, 'A3 playing')
      const old = await waitFor(A, (x) => x.phase === 'kicked', 6000, 'old tab kicked')
      assert(old.why === 'dup', `사유 ${old.why}`)
      await A.screenshot({ path: path.join(OUT, '04-kicked-dup.png') })
      const res = await fetch(`${BASE}/api/rooms`)
      const data = await res.json()
      const total = data.rooms.reduce((n, r) => n + r.players, 0)
      assert(total === 2, `전체 접속자 ${total} (기대 2)`)
      await A3.close()
      return '이전 탭 kicked(dup), 전체 접속자 수 중복 없음'
    })
  } finally {
    await check('브라우저 콘솔 오류가 없다', async () => {
      const real = errors.filter((e) => !/Failed to load resource|net::ERR_|WebSocket connection|ERR_INTERNET_DISCONNECTED/.test(e))
      assert(real.length === 0, real.slice(0, 5).join(' | '))
      return errors.length ? `네트워크 끊김 테스트로 인한 메시지 ${errors.length}건 제외` : ''
    })
    await browser.close()
    if (server && !process.env.E2E_KEEP) server.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} 통과`)
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('[e2e] 실행 실패:', err)
  if (server) server.kill('SIGTERM')
  process.exit(1)
})
