#!/usr/bin/env node
/**
 * 교단/초대 E2E: 실제 서버 + 브라우저 세 개(PC A, 모바일 B, 포교 링크로 들어오는 C)를 실제 UI 로 조작한다.
 *
 *   npm run build && node tests/e2e/cult.cjs
 *   (옵션) E2E_PORT=8821  E2E_OUT=<스크린샷 폴더>
 *
 * 흐름: A 가 교단 창설(UI) → B 화면의 A 이름표 갱신 → A 가 B 에게 걸어가 초대 → B 카드에서 수락 → 같은 교단
 *       → B 탈퇴 → A 재초대 → B 거절 → A 쿨타임 → B 가 A 차단 → (쿨타임 뒤) A 초대는 거절로만 보이고 B 에게 카드 없음
 *       → C 가 ?by=A 링크로 들어오면 초대 카드가 자동으로 뜬다.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = process.env.E2E_OUT || path.join(__dirname, 'out')
const PORT = Number(process.env.E2E_PORT || 8821)
const BASE = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function step(name, fn) {
  try {
    const d = await fn()
    console.log(`  ✅ ${name}${d ? ' — ' + d : ''}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name} — ${err && err.message ? err.message : err}`)
    throw err
  }
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-cult-e2e-'))
  const server = spawn(process.execPath, [path.join(ROOT, 'dist/server/main.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ROOMS: '2', ROOM_CAPACITY: '20' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d))
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return server
    } catch {
      /* 아직 */
    }
    await sleep(200)
  }
  server.kill()
  throw new Error('서버가 뜨지 않았습니다')
}

/** 페이지 안 상태 요약 */
const snap = (page) =>
  page.evaluate(() => {
    const s = window.__doas.store
    const me = s.me
    return {
      phase: s.phase,
      id: me ? me.id : 0,
      x: me ? me.x : 0,
      z: me ? me.z : 0,
      name: s.profile.name,
      cult: me ? me.prog.cult : null,
      near: s.near.player,
      players: [...s.players.values()].map((p) => ({ id: p.pub.id, name: p.pub.name, x: p.x, z: p.z, cult: p.pub.cult })),
      invited: window.__invited || 0,
      inviteRes: window.__inviteRes || [],
    }
  })

async function waitFor(page, pred, timeout, label) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await snap(page)
    if (pred(last)) return last
    await sleep(120)
  }
  throw new Error(`시간 초과: ${label} (${JSON.stringify({ cult: last && last.cult, near: last && last.near, res: last && last.inviteRes })})`)
}

async function enter(page, url) {
  await page.goto(url, { waitUntil: 'load' })
  await waitFor(page, (s) => s.phase === 'playing' && s.id > 0, 25000, 'playing')
  // 서버 메시지 기록용 훅(검증 전용)
  await page.evaluate(() => {
    window.__invited = 0
    window.__inviteRes = []
    window.__doas.bus.onMsg('invited', () => window.__invited++)
    window.__doas.bus.onMsg('inviteRes', (m) => window.__inviteRes.push(m.r))
  })
}

async function openCultPanel(page) {
  await page.locator('.hud-menu-btn').click()
  await page.locator('.hud-menu-item', { hasText: '교단' }).first().click()
  await page.locator('.panel .cult-tabs').waitFor({ timeout: 4000 })
}
const closePanel = (page) => page.locator('.panel-close').first().click()

async function walkNear(page, target, other) {
  // 서버가 속도를 검증하므로 실제로 걸어간다
  await page.evaluate(([x, z]) => window.__doas.player.moveTo(x, z), [target.x + 1.6, target.z])
  await waitFor(page, (s) => s.near === other, 20000, 'near player')
}

async function contextButton(page, label) {
  const b = page.locator(`.hud-action[aria-label="${label}"]`)
  await b.waitFor({ timeout: 5000 })
  return b
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const server = await startServer()
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const errors = []
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`))
    p.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`))
  }
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const ctxB = await browser.newContext({ ...devices['iPhone 13'] })
  await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {})
  const A = await ctxA.newPage()
  const B = await ctxB.newPage()
  watch(A, 'A')
  watch(B, 'B')
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, name) })

  try {
    await enter(A, `${BASE}/?room=1`)
    await enter(B, `${BASE}/?room=1`)
    const a0 = await snap(A)
    const b0 = await snap(B)
    console.log(`[cult-e2e] A=${a0.name}(${a0.id}) B=${b0.name}(${b0.id})`)

    await step('A: 창설 폼 — 실존 단체명 거절 안내, 추천, 미리보기', async () => {
      await openCultPanel(A)
      await A.locator('.cult-name-input').fill('통일교 친목회')
      const msg = await A.locator('.cult-msg').first().textContent()
      assert(msg.includes('실존 단체'), `안내 문구: ${msg}`)
      assert(await A.locator('.cult-submit').isDisabled(), '막힌 이름인데 버튼이 켜져 있음')
      await A.locator('.cult-dice').click()
      const suggested = await A.locator('.cult-name-input').inputValue()
      assert(suggested.length >= 2, '추천 이름 없음')
      await A.locator('.cult-name-input').fill('퇴근 연구회')
      await A.locator('.cult-swatches .swatch').nth(6).click()
      await A.locator('.cult-emblem-tile').nth(3).click()
      await A.locator('.cult-chip', { hasText: '명예 과장' }).click()
      const pv = await A.locator('.cult-preview .cult-tagline').textContent()
      assert(pv.includes('퇴근 연구회') && pv.includes('명예 과장'), `미리보기: ${pv}`)
      await shot(A, 'cult-01-form-desktop.png')
      return `추천 "${suggested}", 미리보기 "${pv}"`
    })

    await step('B(모바일): 창설 폼 화면', async () => {
      await openCultPanel(B)
      await B.locator('.cult-name-input').fill('낮잠 수호단')
      await shot(B, 'cult-02-form-mobile.png')
      await closePanel(B)
    })

    let cultId = ''
    await step('A 가 UI 로 교단 창설 → B 화면의 A 이름표/교단이 바뀐다', async () => {
      await A.locator('.cult-submit').click()
      const a = await waitFor(A, (s) => !!s.cult, 5000, 'A cult')
      cultId = a.cult.id
      assert(a.cult.role === 'leader' && a.cult.name === '퇴근 연구회' && a.cult.title === '명예 과장', JSON.stringify(a.cult))
      await waitFor(B, (s) => s.players.some((p) => p.id === a0.id && p.cult && p.cult.id === cultId), 5000, 'B sees A cult')
      await A.locator('.cult-info').waitFor({ timeout: 3000 })
      await shot(A, 'cult-03-info-desktop.png')
      return cultId
    })

    await step('A: 포교 링크 복사', async () => {
      await A.locator('.cult-link').click()
      await sleep(300)
      const clip = await A.evaluate(() => navigator.clipboard.readText().catch(() => ''))
      assert(!clip || clip.includes(`by=${encodeURIComponent(a0.name)}`), `클립보드: ${clip}`)
      await closePanel(A)
      return clip ? clip.slice(0, 80) : '(클립보드 읽기 불가 — 토스트만 확인)'
    })

    await step('A 가 B 에게 걸어가 초대 → B 에게 초대 카드 → 수락 → 같은 교단', async () => {
      await walkNear(A, (await snap(B)), b0.id)
      await waitFor(B, (s) => s.near === a0.id, 8000, 'B near A')
      const btn = await contextButton(A, '교단 초대')
      await btn.click()
      await B.locator('.invite-card').waitFor({ timeout: 5000 })
      const text = await B.locator('.invite-card').textContent()
      assert(text.includes('퇴근 연구회') && text.includes(a0.name), `카드: ${text}`)
      await sleep(400)
      await shot(B, 'cult-04-invite-card-mobile.png')
      await B.locator('.invite-yes').click()
      const b = await waitFor(B, (s) => s.cult && s.cult.id === cultId, 5000, 'B joined')
      assert(b.cult.role === 'member', 'B 역할')
      await waitFor(A, (s) => s.players.some((p) => p.id === b0.id && p.cult && p.cult.id === cultId), 5000, 'A sees B tag')
      await waitFor(A, (s) => s.inviteRes.includes('ok'), 3000, 'A ok')
      return 'A 화면의 B 이름표도 교단으로 갱신'
    })

    await step('정보 카드(교단원 목록) + 순위표 — PC/모바일', async () => {
      await openCultPanel(A)
      const members = await A.locator('.cult-member').count()
      assert(members === 2, `교단원 줄 ${members}`)
      await A.locator('.cult-tabs .tab', { hasText: '교단 순위' }).click()
      await A.locator('.cult-rank-row').first().waitFor({ timeout: 4000 })
      const row = await A.locator('.cult-rank-row').first().textContent()
      assert(row.includes('퇴근 연구회') && row.includes('2명 접속'), `순위 줄: ${row}`)
      await shot(A, 'cult-05-rank-desktop.png')
      await closePanel(A)
      await openCultPanel(B)
      await shot(B, 'cult-06-info-mobile.png')
      await B.locator('.cult-tabs .tab', { hasText: '교단 순위' }).click()
      await B.locator('.cult-rank-row').first().waitFor({ timeout: 4000 })
      await shot(B, 'cult-07-rank-mobile.png')
      await B.locator('.cult-tabs .tab', { hasText: '내 교단' }).click()
      await B.locator('.cult-info .cult-leave').waitFor({ timeout: 3000 })
      return row.replace(/\s+/g, ' ')
    })

    await step('B 가 탈퇴(확인 대화상자)', async () => {
      await B.locator('.cult-leave').click()
      await B.locator('.confirm-layer .btn.primary').waitFor({ timeout: 3000 })
      await sleep(200)
      await B.locator('.confirm-layer .btn.primary').click()
      await waitFor(B, (s) => !s.cult, 4000, 'B left')
      await waitFor(A, (s) => s.players.some((p) => p.id === b0.id && !p.cult), 4000, 'A sees B left')
      await closePanel(B)
    })

    await step('A 재초대 → B 거절 → A 쪽 버튼 쿨타임', async () => {
      await sleep(5200) // 전체 초대 쿨타임
      await (await contextButton(A, '교단 초대')).click()
      await B.locator('.invite-card').waitFor({ timeout: 5000 })
      await B.locator('.invite-no').click()
      await waitFor(A, (s) => s.inviteRes.filter((r) => r === 'no').length === 1, 4000, 'A no')
      await A.locator('.hud-action[aria-label="교단 초대"].cooling').waitFor({ timeout: 3000 })
      const cd = await A.locator('.hud-action[aria-label="교단 초대"]').getAttribute('data-cd')
      assert(Number(cd) > 50, `남은 초 ${cd}`)
      await shot(A, 'cult-08-decline-cooldown-desktop.png')
      return `남은 ${cd}초`
    })

    await step('B 가 더보기 시트에서 A 차단 → (쿨타임 뒤) A 의 초대는 거절로만 보이고 B 에게 카드 없음', async () => {
      const more = B.locator('.hud-action', { has: B.locator('.hud-action-icon', { hasText: '👤' }) })
      await more.first().click()
      await B.locator('.social-sheet:not(.hidden)').waitFor({ timeout: 3000 })
      await shot(B, 'cult-09-sheet-mobile.png')
      await B.locator('.social-block').click()
      await sleep(300)
      const label = await B.locator('.social-block').textContent()
      assert(label.includes('차단 해제'), `버튼: ${label}`)
      await B.keyboard.press('Escape').catch(() => {})
      const before = (await snap(B)).invited
      console.log('    (대상별 쿨타임 60초 대기…)')
      await sleep(61_000)
      await (await contextButton(A, '교단 초대')).click()
      await waitFor(A, (s) => s.inviteRes.filter((r) => r === 'no').length === 2, 8000, 'A fake no')
      const after = await snap(B)
      assert(after.invited === before, `B 가 초대를 받음 (${before} → ${after.invited})`)
      assert((await B.locator('.invite-card').count()) === 0, 'B 화면에 카드가 있음')
      const res = (await snap(A)).inviteRes
      return `A 가 받은 결과: ${res.join(',')}`
    })

    await step('C 가 포교 링크(?room=1&by=A)로 들어오면 초대 카드가 자동으로 뜬다', async () => {
      const ctxC = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const C = await ctxC.newPage()
      watch(C, 'C')
      await enter(C, `${BASE}/?room=1&by=${encodeURIComponent(a0.name)}`)
      await C.locator('.invite-card').waitFor({ timeout: 6000 })
      const text = await C.locator('.invite-card').textContent()
      assert(text.includes('퇴근 연구회'), text)
      assert(!C.url().includes('by='), `주소에 by 가 남음: ${C.url()}`)
      await sleep(400)
      await shot(C, 'cult-10-deeplink-card-desktop.png')
      await C.locator('.invite-yes').click()
      await waitFor(C, (s) => s.cult && s.cult.id === cultId, 5000, 'C joined')
      await ctxC.close()
      return 'C 수락 → 같은 교단'
    })

    assert(errors.length === 0, '페이지 오류: ' + errors.join(' | '))
    console.log('[cult-e2e] 전부 통과')
  } finally {
    if (errors.length) console.log('[cult-e2e] page errors:', errors)
    await browser.close().catch(() => {})
    server.kill()
  }
}

main().catch((err) => {
  console.error('[cult-e2e] 실패:', err && err.message ? err.message : err)
  process.exit(1)
}).then(() => process.exit(failed ? 1 : 0))
