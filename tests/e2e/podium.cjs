#!/usr/bin/env node
/**
 * 단상 E2E: 실제 서버 + 브라우저 두 개(A = PC, B = 모바일)로 오늘의 계시와 집단 설교를 실제 버튼으로 돌려 본다.
 *
 *   npm run build && node tests/e2e/podium.cjs
 *   (옵션) E2E_PORT=8822  E2E_URL=http://… (이미 떠 있는 서버 사용)  E2E_OUT=<스크린샷 폴더>
 */
const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = process.env.E2E_OUT || path.join(__dirname, 'out', 'podium')
const PORT = Number(process.env.E2E_PORT || 8822)
const BASE = process.env.E2E_URL || `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let server = null

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function check(name, fn) {
  try {
    const d = await fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}${typeof d === 'string' && d ? ' — ' + d : ''}`)
    return true
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`  ❌ ${name} — ${err && err.message ? err.message : err}`)
    return false
  }
}

async function startServer() {
  if (process.env.E2E_URL) return
  const entry = path.join(ROOT, 'dist/server/main.js')
  assert(fs.existsSync(entry), 'dist/server/main.js 가 없습니다. 먼저 npm run build')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-podium-'))
  server = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ROOMS: '2' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d))
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return
    } catch {
      /* 아직 */
    }
    await sleep(200)
  }
  throw new Error('서버가 뜨지 않았습니다')
}

/** 실제 맵의 단상/광장 좌표(월드 데이터가 바뀌어도 따라가게 소스에서 읽는다) */
function worldInfo() {
  const js = "import {WORLD} from './shared/world'; console.log(JSON.stringify({podium: WORLD.podium, plaza: WORLD.plaza}))"
  return JSON.parse(execSync(`npx tsx -e "${js}"`, { cwd: ROOT }).toString().trim().split('\n').pop())
}

const state = (page) =>
  page.evaluate(() => {
    const g = window.__doas
    const s = g.store
    const me = s.me
    return {
      phase: s.phase,
      id: me ? me.id : 0,
      x: me ? me.x : 0,
      z: me ? me.z : 0,
      inf: me ? me.prog.inf : 0,
      entourage: me ? me.entourage : 0,
      emote: me ? me.emote : null,
      poi: s.near.poi,
      sermon: s.sermon,
      msgs: window.__podiumMsgs || [],
    }
  })
async function waitFor(page, pred, timeout, label) {
  const end = Date.now() + timeout
  let last = null
  while (Date.now() < end) {
    last = await state(page)
    if (pred(last)) return last
    await sleep(100)
  }
  throw new Error(`시간 초과: ${label} (poi=${last && last.poi}, x=${last && last.x.toFixed(1)}, z=${last && last.z.toFixed(1)})`)
}
/** 서버 메시지 기록기 설치(검증용) */
const record = (page) =>
  page.evaluate(() => {
    window.__podiumMsgs = []
    const bus = window.__doas.bus
    for (const t of ['prophecy', 'sermon', 'reward']) bus.onMsg(t, (m) => window.__podiumMsgs.push(m))
  })
const action = (page, label) => page.locator(`.hud-action[aria-label="${label}"]`)
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) })

async function walkTo(page, x, z, pred, label) {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(([x, z]) => window.__doas.player.moveTo(x, z), [x, z])
    try {
      return await waitFor(page, pred, 9000, label)
    } catch (err) {
      if (i === 3) throw err
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const W = worldInfo()
  await startServer()
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const errors = []
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const ctxB = await browser.newContext({ ...devices['iPhone 13'] })
  const A = await ctxA.newPage()
  const B = await ctxB.newPage()
  for (const [p, tag] of [[A, 'A'], [B, 'B']]) {
    p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`))
    p.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`))
  }
  try {
    await A.goto(`${BASE}/?room=1`)
    await B.goto(`${BASE}/?room=1`)
    const a0 = await waitFor(A, (s) => s.phase === 'playing' && s.id > 0, 20000, 'A 입장')
    const b0 = await waitFor(B, (s) => s.phase === 'playing' && s.id > 0, 20000, 'B 입장')
    await record(A)
    await record(B)

    await check('A 가 단상에 올라가면 계시/설교 버튼이 뜬다', async () => {
      await walkTo(A, W.podium.x, W.podium.z, (s) => s.poi === 'podium', 'A 단상 도착')
      await action(A, '오늘의 계시').waitFor({ timeout: 3000 })
      await action(A, '집단 설교').waitFor({ timeout: 3000 })
      await sleep(400)
      await shot(A, 'desktop-podium-buttons.png')
    })
    await check('B 는 광장 가장자리로 이동', async () => {
      const s = await walkTo(B, W.plaza.x + 5, W.plaza.z + 5, (s) => Math.hypot(s.x - W.plaza.x - 5, s.z - W.plaza.z - 5) < 1.2, 'B 광장')
      return `(${s.x.toFixed(1)}, ${s.z.toFixed(1)})`
    })

    await check('오늘의 계시: 실제 버튼 → 두 클라이언트 모두 수신, B 에 자막', async () => {
      await action(A, '오늘의 계시').click()
      const a = await waitFor(A, (s) => s.msgs.some((m) => m.t === 'prophecy'), 4000, 'A prophecy')
      const b = await waitFor(B, (s) => s.msgs.some((m) => m.t === 'prophecy'), 4000, 'B prophecy')
      const pa = a.msgs.find((m) => m.t === 'prophecy')
      assert(pa.p === a0.id, '말한 사람이 A 가 아님')
      assert(b.msgs.find((m) => m.t === 'prophecy').text === pa.text, '계시 문구 불일치')
      assert(a.msgs.some((m) => m.t === 'reward' && m.why === 'prophecy' && m.inf > 0), 'A 영향력 보상 없음')
      await B.locator('.podium-caption:not(.hidden)').waitFor({ timeout: 2000 })
      const cap = await B.locator('.podium-caption-text').textContent()
      assert(cap === pa.text, `자막 "${cap}"`)
      await sleep(450)
      await shot(B, 'mobile-prophecy-caption.png')
      await shot(A, 'desktop-prophecy-caption.png')
      // 쿨타임 표시
      const cooling = await action(A, '오늘의 계시').evaluate((el) => el.classList.contains('cooling'))
      assert(cooling, '계시 버튼에 쿨타임이 표시되지 않음')
      return `"${pa.text}" · 반응 ${pa.re.length}개`
    })

    const infA0 = (await state(A)).inf
    const infB0 = (await state(B)).inf
    let endMsg = null
    await check('집단 설교: A 시작 → B 가 [설교 참여] 버튼으로 합류', async () => {
      await action(A, '집단 설교').click()
      await waitFor(B, (s) => !!s.sermon, 4000, 'B 설교 상태')
      await action(B, '설교 참여').waitFor({ timeout: 3000 })
      await B.locator('.podium-banner:not(.hidden)').waitFor({ timeout: 2000 })
      await shot(B, 'mobile-sermon-join.png')
      await action(B, '설교 참여').tap()
      const b = await waitFor(B, (s) => s.sermon && s.sermon.joined.includes(b0.id), 3000, 'B joined')
      assert(b.sermon.leader === a0.id, '교주가 A 가 아님')
      const a = await waitFor(A, (s) => s.emote === 'preach', 3000, 'A preach 이모트')
      return `참여 ${b.sermon.joined.length}명, A 이모트 ${a.emote}`
    })

    for (let round = 1; round <= 3; round++) {
      await check(`구호 ${round}: 두 사람 모두 실제 응답 버튼으로 응답`, async () => {
        await A.locator('.podium-resp:not(.hidden):not(.done)').waitFor({ timeout: 10000 })
        await B.locator('.podium-resp:not(.hidden):not(.done)').waitFor({ timeout: 3000 })
        const callText = await B.locator('.podium-call-text').textContent()
        // 응답 창은 3.5초뿐이다. 스크린샷이 창을 잡아먹지 않게 A 가 먼저 응답하고, B 화면은 응답 전 모습을 한 장만 찍는다
        // (PC 는 2라운드에서 Space 키로 응답해 본다)
        if (round === 2) await A.keyboard.press('Space')
        else await A.locator('.podium-resp').click()
        if (round === 1) await shot(B, 'mobile-sermon-call.png')
        await B.locator('.podium-resp').tap()
        await A.locator('.podium-resp.done').waitFor({ timeout: 3000 })
        await B.locator('.podium-resp.done').waitFor({ timeout: 3000 })
        // 모바일: 응답 버튼이 둥근 버튼(말풍선/이모트/도망)·상황 버튼을 덮지 않고, 그 버튼들의 가운데를 누르면 그 버튼이 눌린다
        const cover = await B.evaluate(() => {
          const R = (el) => el.getBoundingClientRect()
          const rr = R(document.querySelector('.podium-resp'))
          const bad = []
          for (const el of document.querySelectorAll('.emotes-tbtn, .hud-action')) {
            if (!el.getClientRects().length) continue
            const r = R(el)
            const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
            const ov = !(r.right <= rr.left || rr.right <= r.left || r.bottom <= rr.top || rr.bottom <= r.top)
            if (ov || !hit || !el.contains(hit)) bad.push(el.getAttribute('aria-label'))
          }
          return bad
        })
        assert(cover.length === 0, `모바일 응답 버튼이 가리는 버튼: ${cover.join(', ')}`)
        if (round === 1) await shot(A, 'desktop-sermon-call.png')
        return callText
      })
    }

    await check('설교 종료: 결과 카드(게이지/합류 신도/영향력), 둘 다 영향력 획득', async () => {
      const a = await waitFor(A, (s) => s.msgs.some((m) => m.t === 'sermon' && m.ph === 'end'), 15000, 'A end')
      endMsg = a.msgs.find((m) => m.t === 'sermon' && m.ph === 'end')
      await A.locator('.podium-result:not(.hidden)').waitFor({ timeout: 2000 })
      await B.locator('.podium-result:not(.hidden)').waitFor({ timeout: 2000 })
      await sleep(400)
      await shot(A, 'desktop-sermon-end.png')
      await shot(B, 'mobile-sermon-end.png')
      const resA = await A.locator('.podium-result').textContent()
      const resB = await B.locator('.podium-result').textContent()
      assert(endMsg.score === 100, `게이지 ${endMsg.score}`)
      assert(resA.includes(`${endMsg.converts}명`), `A 카드에 합류 수 없음: ${resA}`)
      assert(resA.includes('100%') && resB.includes('100%'), '카드에 게이지 없음')
      const a2 = await state(A)
      const b2 = await state(B)
      assert(a2.inf > infA0, `A 영향력 변화 없음 ${infA0}→${a2.inf}`)
      assert(b2.inf > infB0, `B 영향력 변화 없음 ${infB0}→${b2.inf}`)
      // 카드에는 설교 보상만 적힌다. 같은 순간 업적 보상이 겹치면 실제 증가분이 더 클 수 있다
      const shown = Number((/\+(\d+)/.exec(resB) || [])[1] || 0)
      assert(shown > 0 && b2.inf - infB0 >= shown, `B 카드의 영향력 표시: ${resB} (실제 +${b2.inf - infB0})`)
      assert(a2.sermon === null && b2.sermon === null, '설교 상태가 남아 있음')
      return `게이지 ${endMsg.score}%, 합류 ${endMsg.converts}명, A +${a2.inf - infA0}, B +${b2.inf - infB0}`
    })
    await check('합류한 신도가 A 를 따라다닌다', async () => {
      if (!endMsg || endMsg.converts === 0) return '합류 0명(구경꾼이 없었음)'
      const s = await waitFor(A, (s) => s.entourage >= endMsg.converts, 4000, 'A 신도 수')
      return `신도 ${s.entourage}명`
    })
    await check('모바일: 단상에서 계시/설교 버튼(설교는 쿨타임)', async () => {
      await walkTo(B, W.podium.x + 0.8, W.podium.z, (s) => s.poi === 'podium', 'B 단상')
      await action(B, '오늘의 계시').waitFor({ timeout: 3000 })
      await action(B, '집단 설교').waitFor({ timeout: 3000 })
      await sleep(400)
      await shot(B, 'mobile-podium-buttons.png')
      const cool = await action(B, '집단 설교').evaluate((el) => el.classList.contains('cooling'))
      assert(cool, '설교 버튼에 방 쿨타임이 표시되지 않음')
    })
    await check('브라우저 오류 없음', async () => {
      assert(errors.length === 0, errors.slice(0, 5).join(' | '))
    })
  } finally {
    await browser.close()
    if (server) server.kill()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n[podium e2e] ${results.length - failed}/${results.length} 통과, 스크린샷: ${OUT}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  if (server) server.kill()
  process.exit(1)
})
