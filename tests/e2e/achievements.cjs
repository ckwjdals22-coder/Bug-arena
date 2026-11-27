#!/usr/bin/env node
/**
 * 업적 · 일일 수행 · 칭호 E2E. 실제 서버 + 브라우저 두 개(PC, 모바일).
 *
 *   npm run build && E2E_PORT=8825 node tests/e2e/achievements.cjs
 *
 * 흐름: PC 가 '신비로운 춤 3번' 수행이 뽑히는 기기 id 로 입장 → 춤 3번 → 수령 가능 토스트 →
 *       포교해서 첫 업적(보통 '첫 신도') 배너 → 진짜 메뉴로 패널을 열어 보상 받기 → 칭호 달기 →
 *       모바일 화면의 이름표에 칭호가 보이는지 확인. 모바일은 동작 30번으로 업적 배너를 띄우고 세 탭을 찍는다.
 * 스크린샷: tests/e2e/out/ach-*.png
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(__dirname, 'out')
const PORT = Number(process.env.E2E_PORT || 8825)
const BASE = process.env.E2E_URL || `http://localhost:${PORT}`
const results = []
let server = null

const log = (...a) => console.log('[ach-e2e]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-ach-e2e-'))
  server = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ROOMS: '2', ROOM_CAPACITY: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d))
  if (process.env.E2E_LOG) {
    const f = fs.createWriteStream(process.env.E2E_LOG)
    server.stdout.pipe(f)
  }
  server.on('exit', (code, sig) => log('server exit', code, sig))
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

/** 서버와 같은 함수로 '오늘 d_dance3 가 뽑히는' 기기 id 를 찾는다 */
function findPid() {
  const code = `
    import('./server/core/systems/achievements.ts').then((m) => {
      const day = m.kstDayKey(Date.now())
      for (let i = 0; i < 5000; i++) {
        const pid = 'e2e-ach-' + i.toString(36).padStart(6, '0')
        if (m.pickDailyQuests(pid, day).includes('d_dance3')) { console.log(pid); return }
      }
    })`
  return execFileSync('npx', ['tsx', '-e', code], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop()
}

async function waitFor(page, fn, arg, timeout, label) {
  try {
    return await page.waitForFunction(fn, arg, { timeout, polling: 100 })
  } catch {
    throw new Error('시간 초과: ' + label)
  }
}

/** 토스트/배너 글자를 모두 모아 둔다(잠깐 떴다 사라지므로) */
async function recordToasts(page) {
  await page.addInitScript(() => {
    window.__toasts = []
    const obs = new MutationObserver((list) => {
      for (const m of list)
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent)
        }
      const b = document.querySelector('.ach-banner.pop')
      if (b && !window.__toasts.includes('banner:' + b.textContent)) window.__toasts.push('banner:' + b.textContent)
    })
    document.addEventListener('DOMContentLoaded', () => obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }))
  })
}

async function openPanelViaMenu(page) {
  await page.click('.hud-menu-btn')
  const item = page.locator('.hud-menu-item', { hasText: '업적·수행' })
  await item.waitFor({ timeout: 3000 })
  await item.click()
  await page.waitForSelector('.ach-content', { timeout: 3000 })
}
async function clickTab(page, id) {
  await page.click(`.ach-tabs .tab[data-tab="${id}"]`)
  await page.waitForSelector(`.ach-tabs .tab.on[data-tab="${id}"]`, { timeout: 2000 })
  await sleep(150)
}

async function pitchUntilAchievement(page) {
  const outcomes = []
  const tried = new Set()
  for (let attempt = 0; attempt < 16; attempt++) {
    const ach = await page.evaluate(() => window.__doas.store.me.prog.ach.length)
    if (ach > 0 && outcomes.length > 0) break
    const cand = await page.evaluate((triedIds) => {
      const s = window.__doas.store
      const me = s.me
      let best = null
      for (const [id, v] of s.npcs) {
        if (triedIds.includes(id) || v.pub.owner !== 0 || v.pub.role !== '' || v.pub.model !== 0) continue
        const d = Math.hypot(v.x - me.x, v.z - me.z)
        if (!best || d < best.d) best = { id, d }
      }
      if (best) {
        const v = s.npcs.get(best.id)
        window.__doas.player.moveTo(v.x, v.z, best.id)
      }
      return best ? best.id : 0
    }, [...tried])
    if (!cand) break
    tried.add(cand)
    try {
      await waitFor(page, () => window.__doas.store.talk !== null, null, 12000, 'talk')
    } catch {
      continue
    }
    for (let round = 0; round < 2; round++) {
      const o = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const g = window.__doas
            const t = g.store.talk
            if (!t || t.waiting) return resolve('none')
            const off = g.bus.onMsg('pitchRes', (m) => {
              if (m.p === g.store.me.id) {
                off()
                resolve(m.o)
              }
            })
            g.actions.pitch(t.lines[0])
            setTimeout(() => resolve('timeout'), 6000)
          }),
      )
      outcomes.push(o)
      if (await page.evaluate(() => window.__doas.store.me.prog.ach.length > 0)) return outcomes
      if (o !== 'more') break
      await sleep(400)
    }
    // 포교 쿨타임 동안 업적이 오면 바로 돌아간다
    for (let i = 0; i < 23; i++) {
      if (await page.evaluate(() => window.__doas.store.me.prog.ach.length > 0)) return outcomes
      await sleep(100)
    }
  }
  return outcomes
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const pid = findPid()
  assert(pid, '기기 id 를 찾지 못했습니다')
  await startServer()
  log('server', BASE, 'pid', pid)
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const errors = []
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const ctxB = await browser.newContext({ ...devices['iPhone 13'] })
  await ctxA.addInitScript((p) => {
    try {
      if (!localStorage.getItem('doas.profile.v1')) localStorage.setItem('doas.profile.v1', JSON.stringify({ pid: p, name: '수상한교주', tutorialDone: true }))
    } catch {}
  }, pid)
  await ctxB.addInitScript(() => {
    try {
      if (!localStorage.getItem('doas.profile.v1')) localStorage.setItem('doas.profile.v1', JSON.stringify({ name: '구경꾼', tutorialDone: true }))
    } catch {}
  })
  const A = await ctxA.newPage()
  const B = await ctxB.newPage()
  for (const [pg, tag] of [
    [A, 'A'],
    [B, 'B'],
  ]) {
    pg.on('pageerror', (e) => errors.push(`${tag} exception: ${e.message}`))
    pg.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console.error: ${m.text()}`))
    await recordToasts(pg)
  }

  try {
    let aId = 0
    await check('입장하면 오늘의 수행(KST 날짜, 3개)이 도착한다', async () => {
      await A.goto(`${BASE}/?room=1`, { waitUntil: 'load' })
      await B.goto(`${BASE}/?room=1`, { waitUntil: 'load' })
      await waitFor(A, () => window.__doas.store.phase === 'playing' && !!window.__doas.store.me, null, 20000, 'A playing')
      await waitFor(B, () => window.__doas.store.phase === 'playing' && !!window.__doas.store.me, null, 20000, 'B playing')
      const d = await A.evaluate(() => window.__doas.store.me.prog.daily)
      aId = await A.evaluate(() => window.__doas.store.me.id)
      assert(d && d.quests.length === 3, '수행 없음')
      assert(d.quests.includes('d_dance3'), '고른 기기 id 인데 d_dance3 가 없음')
      assert(d.streak === 1, 'streak ' + d.streak)
      return `${d.day}: ${d.quests.join(', ')} / 계시 #${d.fortune}`
    })

    await check('춤 3번 → 진행도 3/3 + 수령 가능 토스트 + 메뉴 배지', async () => {
      for (let i = 0; i < 3; i++) {
        await A.evaluate(() => window.__doas.net.send({ t: 'emote', e: 'dance' }))
        await sleep(700)
      }
      await waitFor(A, () => (window.__doas.store.me.prog.daily.prog.d_dance3 || 0) >= 3, null, 4000, 'd_dance3 3/3')
      await waitFor(A, () => window.__toasts.some((t) => t.includes('수행 완료')), null, 3000, '수행 완료 토스트')
      await A.waitForSelector('.hud-menu-badge:not(.hidden)', { timeout: 3000 })
      await A.evaluate(() => window.__doas.net.send({ t: 'emote', e: '' }))
      return '토스트: ' + (await A.evaluate(() => window.__toasts.find((t) => t.includes('수행 완료'))))
    })

    let firstAch = ''
    await check('포교해서 첫 업적 → 달성 배너', async () => {
      const outcomes = await pitchUntilAchievement(A)
      await waitFor(A, () => window.__doas.store.me.prog.ach.length > 0, null, 5000, '업적 달성')
      await A.waitForSelector('.ach-banner.pop', { timeout: 4000 })
      // 헤드리스(소프트웨어 렌더링)는 프레임이 느려 2.2초 애니메이션 중 어디가 찍힐지 모른다 → 찍는 동안만 멈춰 둔다
      await A.evaluate(() => (document.querySelector('.ach-banner').style.animation = 'none'))
      await A.screenshot({ path: path.join(OUT, 'ach-pc-banner.png') })
      await A.evaluate(() => (document.querySelector('.ach-banner').style.animation = ''))
      const banners = await A.evaluate(() => window.__toasts.filter((t) => t.startsWith('banner:')))
      firstAch = await A.evaluate(() => window.__doas.store.me.prog.ach[0])
      assert(banners.length > 0 && banners[0].includes('업적 달성'), '배너 글자: ' + banners.join('|'))
      return `포교 결과 ${outcomes.join(',')} → 업적 ${firstAch}; 배너 "${banners[0].slice(7)}"`
    })

    await check('진짜 메뉴로 패널 열기 → 보상 받기', async () => {
      await sleep(2500) // 배너가 지나가게
      await openPanelViaMenu(A)
      await A.waitForSelector('.ach-claim[data-q="d_dance3"]', { timeout: 3000 })
      await A.screenshot({ path: path.join(OUT, 'ach-pc-daily.png') })
      const inf0 = await A.evaluate(() => window.__doas.store.me.prog.inf)
      await A.click('.ach-claim[data-q="d_dance3"]')
      await waitFor(A, () => window.__doas.store.me.prog.daily.done.includes('d_dance3'), null, 4000, 'done 반영')
      await A.waitForSelector('.ach-quest.done', { timeout: 3000 })
      const inf1 = await A.evaluate(() => window.__doas.store.me.prog.inf)
      assert(inf1 >= inf0 + 10, `영향력 ${inf0} → ${inf1}`)
      return `영향력 ${inf0} → ${inf1}`
    })

    await check('업적 탭: 달성한 업적이 맨 위, 비밀 업적은 ???', async () => {
      await clickTab(A, 'ach')
      const info = await A.evaluate(() => ({
        first: document.querySelector('.ach-item')?.className,
        secret: [...document.querySelectorAll('.ach-item.secret .ach-item-name')].map((e) => e.textContent).slice(0, 2),
        pct: document.querySelector('.ach-summary-pct')?.textContent,
      }))
      assert(info.first && info.first.includes('got'), '첫 항목이 달성 업적이 아님')
      assert(info.secret.length > 0 && info.secret.every((t) => t === '???'), '비밀 업적이 드러남')
      await A.screenshot({ path: path.join(OUT, 'ach-pc-list.png') })
      return `완료율 ${info.pct}`
    })

    await check('칭호 탭에서 고르면 다른 사람 화면의 이름표에 보인다', async () => {
      await clickTab(A, 'title')
      await A.click(`.ach-title-tile[data-tag="${firstAch}"]`)
      await A.waitForSelector(`.ach-title-tile.on[data-tag="${firstAch}"]`, { timeout: 2000 })
      const preview = await A.textContent('.ach-preview-tag')
      await A.screenshot({ path: path.join(OUT, 'ach-pc-title.png') })
      await waitFor(B, ([id, tag]) => window.__doas.store.players.get(id)?.pub.tag === tag, [aId, firstAch], 4000, 'B 가 칭호 받음')
      // B 가 A 를 화면에서 보도록 A 근처로 걸어간다
      await B.evaluate((id) => {
        const v = window.__doas.store.players.get(id)
        window.__doas.player.moveTo(v.x + 1.5, v.z + 1.5)
      }, aId)
      const name = await A.evaluate(() => window.__doas.store.profile.name)
      const handle = await waitFor(
        B,
        (nm) => [...document.querySelectorAll('.overlay-tag:not(.off)')].map((e) => e.textContent).find((t) => t.includes(nm)),
        name,
        15000,
        'B 화면 이름표',
      )
      const text = await handle.jsonValue()
      await B.screenshot({ path: path.join(OUT, 'ach-mobile-nametag.png') })
      return `미리보기 "${preview}" / B 이름표 "${text}"`
    })
    await A.keyboard.press('Escape')

    await check('모바일: 동작 30번 → 업적 배너, 세 탭 스크린샷', async () => {
      for (let i = 0; i < 31; i++) {
        await B.evaluate(() => window.__doas.net.send({ t: 'emote', e: 'wave' }))
        await sleep(560)
      }
      await B.waitForSelector('.ach-banner.pop', { timeout: 5000 })
      // 헤드리스(소프트웨어 렌더링)는 프레임이 느려 2.2초 애니메이션 중 어디가 찍힐지 모른다 → 찍는 동안만 멈춰 둔다
      await B.evaluate(() => (document.querySelector('.ach-banner').style.animation = 'none'))
      await B.screenshot({ path: path.join(OUT, 'ach-mobile-banner.png') })
      await B.evaluate(() => (document.querySelector('.ach-banner').style.animation = ''))
      await sleep(2400)
      await openPanelViaMenu(B)
      await B.screenshot({ path: path.join(OUT, 'ach-mobile-daily.png') })
      await B.evaluate(() => document.querySelector('.ach-fortune')?.scrollIntoView())
      await B.screenshot({ path: path.join(OUT, 'ach-mobile-fortune.png') })
      await clickTab(B, 'ach')
      await B.screenshot({ path: path.join(OUT, 'ach-mobile-list.png') })
      await clickTab(B, 'title')
      await B.screenshot({ path: path.join(OUT, 'ach-mobile-title.png') })
      const ach = await B.evaluate(() => window.__doas.store.me.prog.ach)
      assert(ach.includes('emote30'), 'emote30 없음: ' + ach.join(','))
      return 'emote30 달성'
    })

    await check('브라우저 오류 없음', async () => {
      const real = errors.filter((e) => !/WebGL|GPU|swiftshader/i.test(e))
      assert(real.length === 0, real.join(' | '))
    })
  } finally {
    await browser.close()
    if (server) server.kill()
  }
  const failed = results.filter((r) => !r.ok)
  log(`${results.length - failed.length}/${results.length} 통과`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  if (server) server.kill()
  process.exit(1)
})
