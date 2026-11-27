#!/usr/bin/env node
/**
 * 공유 카드(임명장 · 오늘의 결산 · 거절 짤) 종단 간 확인.
 *
 *   npm run build && node tests/e2e/share.cjs
 *   (옵션) E2E_PORT=8827  E2E_URL=http://… (이미 떠 있는 서버 사용)
 *
 * - PC: 메뉴(☰) → "임명장·공유" → 탭 전환 → [이미지 저장] 다운로드 PNG 크기 확인
 * - PC: NPC 에게 거절당할 때까지 포교 → "📸 짤 저장" 버튼 → 거절 짤이 빈 화면이 아닌지 픽셀 확인
 * - PC: 승급 이벤트 → 토스트의 [임명장 받기] → 임명장 탭
 * - 모바일: 같은 흐름 + 5분 뒤 메뉴 배지(시계를 앞당겨서)
 * 스크린샷은 tests/e2e/out/share-*.png 에 남는다.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(__dirname, 'out')
const PORT = Number(process.env.E2E_PORT || 8827)
const BASE = process.env.E2E_URL || `http://localhost:${PORT}`
const results = []
let server = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}${typeof detail === 'string' && detail ? ' — ' + detail : ''}`)
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
  assert(fs.existsSync(entry), 'dist/server/main.js 가 없습니다. 먼저 npm run build 를 실행하세요.')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-share-'))
  server = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ROOMS: '2', ROOM_CAPACITY: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
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

/** PNG 헤더(IHDR)에서 가로·세로를 읽는다 */
function pngSize(buf) {
  assert(buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47, 'PNG 파일이 아닙니다')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

async function join(page) {
  await page.goto(`${BASE}/?room=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing' && window.__doas.store.me, null, { timeout: 25000 })
  await sleep(800)
}

async function openPanelViaMenu(page) {
  await page.locator('.hud-menu-btn').click()
  const item = page.locator('.hud-menu-item', { hasText: '임명장·공유' })
  await item.waitFor({ state: 'visible', timeout: 3000 })
  await item.click()
  await page.locator('.panel .cert-frame').waitFor({ state: 'visible', timeout: 3000 })
}

async function waitCard(page, type) {
  await page.waitForFunction((t) => {
    const img = document.querySelector('.cert-img')
    return img && img.dataset.type === t && img.complete && img.naturalWidth > 0 && img.getAttribute('src')?.startsWith('blob:')
  }, type, { timeout: 8000 })
  return page.evaluate(() => {
    const img = document.querySelector('.cert-img')
    return { w: img.naturalWidth, h: img.naturalHeight }
  })
}

async function downloadPng(page, type) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), page.locator('.cert-save').click()])
  const name = dl.suggestedFilename()
  assert(new RegExp(`^doas-${type}-\\d{8}\\.png$`).test(name), `파일 이름이 이상합니다: ${name}`)
  const p = path.join(OUT, `share-dl-${type}.png`)
  await dl.saveAs(p)
  return { name, ...pngSize(fs.readFileSync(p)) }
}

/** 미리보기 이미지의 위쪽 70%(자막 제외)에서 픽셀을 뽑아 색이 다양한지 본다 */
function sampleVariety(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.cert-img')
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.7, 0, 0, 64, 64)
    const d = g.getImageData(0, 0, 64, 64).data
    const colors = new Set()
    let min = 255
    let max = 0
    for (let i = 0; i < d.length; i += 4) {
      colors.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3))
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3
      min = Math.min(min, l)
      max = Math.max(max, l)
    }
    return { colors: colors.size, range: max - min }
  })
}

/** 거절(no/flee/ignore)이 나올 때까지 가까운 시민에게 포교 */
async function getRejected(page, maxTries = 14) {
  const outcomes = []
  const tried = new Set()
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const cand = await page.evaluate((tried) => {
      const g = window.__doas
      const me = g.store.me
      let best = null
      for (const n of g.store.npcs.values()) {
        if (tried.includes(n.pub.id) || n.pub.owner !== 0 || n.pub.role !== '' || n.pub.model !== 0) continue
        const d = Math.hypot(n.x - me.x, n.z - me.z)
        if (!best || d < best.d) best = { id: n.pub.id, d }
      }
      if (best) {
        const v = g.store.npcs.get(best.id)
        g.player.moveTo(v.x, v.z, best.id)
      }
      return best
    }, [...tried])
    if (!cand) break
    tried.add(cand.id)
    try {
      await page.waitForFunction(() => window.__doas.store.talk !== null, null, { timeout: 12000 })
    } catch {
      continue
    }
    for (let round = 0; round < 3; round++) {
      const talk = await page.evaluate(() => window.__doas.store.talk && { lines: window.__doas.store.talk.lines, waiting: window.__doas.store.talk.waiting })
      if (!talk) break
      const res = page.evaluate(
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
      // 일부러 마지막 멘트(대개 덜 먹히는 쪽)를 고른다
      await page.evaluate((l) => window.__doas.actions.pitch(l), talk.lines[talk.lines.length - 1])
      const o = await res
      outcomes.push(o)
      if (o === 'no' || o === 'flee' || o === 'ignore') return { outcome: o, outcomes }
      if (o !== 'more') break
      await page.waitForFunction(() => window.__doas.store.talk && !window.__doas.store.talk.waiting, null, { timeout: 4000 }).catch(() => {})
    }
    await sleep(2400)
  }
  throw new Error(`거절당하지 못했습니다(결과: ${outcomes.join(', ')})`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  await startServer()
  console.log('[share] server', BASE)
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const errors = []
  const watch = (page, tag) => {
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`))
    page.on('console', (m) => m.type() === 'error' && errors.push(`${tag}: ${m.text()}`))
  }
  try {
    // ───────── PC ─────────
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true })
    const A = await ctxA.newPage()
    watch(A, 'PC')
    await join(A)

    await check('PC: 메뉴에서 임명장 패널을 열면 1080×1920 임명장이 그려진다', async () => {
      await openPanelViaMenu(A)
      const s = await waitCard(A, 'certificate')
      assert(s.w === 1080 && s.h === 1920, `${s.w}×${s.h}`)
      await A.screenshot({ path: path.join(OUT, 'share-pc-certificate.png') })
      return `${s.w}×${s.h}`
    })
    await check('PC: [이미지 저장] → doas-certificate-yyyymmdd.png 1080×1920', async () => {
      const d = await downloadPng(A, 'certificate')
      assert(d.w === 1080 && d.h === 1920, `${d.w}×${d.h}`)
      return `${d.name} ${d.w}×${d.h}`
    })
    await check('PC: 결산 탭 → 1080×1920 + 저장', async () => {
      await A.locator('.cert-tabs .tab', { hasText: '오늘의 결산' }).click()
      const s = await waitCard(A, 'summary')
      assert(s.w === 1080 && s.h === 1920, `${s.w}×${s.h}`)
      const d = await downloadPng(A, 'summary')
      assert(d.w === 1080 && d.h === 1920, `${d.w}×${d.h}`)
      await A.screenshot({ path: path.join(OUT, 'share-pc-summary.png') })
      return d.name
    })
    await check('PC: 공유하기 버튼이 없는 브라우저에서는 숨기고 길게 눌러 저장 안내', async () => {
      const shareHidden = await A.locator('.cert-share').evaluate((el) => el.classList.contains('hidden'))
      const hint = await A.locator('.cert-hint').textContent()
      const canShare = await A.evaluate(() => typeof navigator.canShare === 'function')
      if (!canShare) assert(shareHidden && /길게 눌러/.test(hint), `share hidden=${shareHidden}, hint=${hint}`)
      return canShare ? 'canShare 지원 브라우저(버튼 표시)' : '버튼 숨김 + 안내 표시'
    })
    await A.keyboard.press('Escape')

    let rejected = null
    await check('PC: 시민에게 거절당하면 "📸 짤 저장" 버튼이 잠깐 나타난다', async () => {
      rejected = await getRejected(A)
      await A.locator('.cert-snap').waitFor({ state: 'visible', timeout: 2000 })
      await A.screenshot({ path: path.join(OUT, 'share-pc-snap-button.png') })
      // 상황 버튼(오른쪽 아래)과 겹치지 않는지
      const overlap = await A.evaluate(() => {
        const a = document.querySelector('.cert-snap').getBoundingClientRect()
        for (const el of document.querySelectorAll('.hud-dock button')) {
          const b = el.getBoundingClientRect()
          if (b.width && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) return true
        }
        return false
      })
      assert(!overlap, '짤 버튼이 상황 버튼을 가립니다')
      return `결과 ${rejected.outcomes.join(' → ')}`
    })
    await check('PC: 📸 버튼 → 거절 짤(1080×1080), 게임 화면이 비어 있지 않음, 저장', async () => {
      await A.locator('.cert-snap').click()
      const s = await waitCard(A, 'meme')
      assert(s.w === 1080 && s.h === 1080, `${s.w}×${s.h}`)
      const v = await sampleVariety(A)
      assert(v.colors > 20 && v.range > 40, `캡처가 단색에 가깝습니다(colors=${v.colors}, range=${v.range})`)
      const d = await downloadPng(A, 'meme')
      assert(d.w === 1080 && d.h === 1080, `${d.w}×${d.h}`)
      await A.screenshot({ path: path.join(OUT, 'share-pc-meme.png') })
      return `색 ${v.colors}종, 밝기 범위 ${Math.round(v.range)}`
    })
    await A.keyboard.press('Escape')
    await check('PC: 승급하면 토스트의 [임명장 받기]가 임명장 탭을 연다', async () => {
      await A.evaluate(() => window.__doas.bus.emit('rankUp', 1))
      const btn = A.locator('.cert-toast-btn')
      // 토스트는 승급 카드(4.8초)가 무대에서 내려간 뒤에 뜬다(ui/stage.ts 순서: 승급 카드 → 토스트).
      // 패널이 열려 있는 동안 기다리던 업적 배너(2.2초)·자막(2.4초)이 있으면 그것들이 먼저 지나간다 → 넉넉히 기다린다
      await btn.waitFor({ state: 'visible', timeout: 20000 })
      await btn.click()
      await waitCard(A, 'certificate')
      return '임명장 탭 열림'
    })
    await A.keyboard.press('Escape')
    await check('PC: 승급 토스트는 다른 알림에 밀려도 두 번까지만 뜨고, 그 뒤로는 메뉴에 점이 남는다', async () => {
      await A.evaluate(() => {
        window.__certShows = 0
        new MutationObserver((muts) => {
          for (const m of muts) for (const n of m.addedNodes) if (n.classList && n.classList.contains('cert-toast')) window.__certShows++
        }).observe(document.querySelector('.toasts'), { childList: true })
        window.__doas.bus.emit('rankUp', 2)
      })
      const toast = A.locator('.cert-toast')
      await toast.waitFor({ state: 'visible', timeout: 20000 })
      // 떠 있는 토스트를 업적 배너가 밀어낸다 → 배너가 지나가면 토스트가 한 번 더 뜬다
      await A.evaluate(() => window.__doas.bus.emitMsg({ t: 'reward', why: 'ach', ach: ['first_join'], inf: 0 }))
      await toast.waitFor({ state: 'hidden', timeout: 2000 })
      await A.waitForFunction(() => window.__certShows === 2, null, { timeout: 6000 })
      // 또 밀려나면 이번에는 다시 뜨지 않는다(누르려는 순간마다 사라지는 깜빡임 방지)
      await A.evaluate(() => window.__doas.bus.emitMsg({ t: 'reward', why: 'ach', ach: ['reject10'], inf: 0 }))
      await toast.waitFor({ state: 'hidden', timeout: 2000 })
      await sleep(5000)
      const shows = await A.evaluate(() => window.__certShows)
      assert(shows === 2, `토스트가 ${shows}번 떴습니다`)
      assert((await toast.count()) === 0, '토스트가 남아 있습니다')
      // 놓친 임명장은 메뉴의 점 표시로 찾을 수 있다
      await A.locator('.hud-menu-btn').click()
      const item = A.locator('.hud-menu-item', { hasText: '임명장·공유' })
      await item.waitFor({ state: 'visible', timeout: 3000 })
      assert((await item.locator('.badge').count()) === 1, '메뉴에 점 표시가 없습니다')
      await item.click()
      await waitCard(A, 'certificate')
      await A.keyboard.press('Escape')
      await A.locator('.hud-menu-btn').click()
      await item.waitFor({ state: 'visible', timeout: 3000 })
      assert((await item.locator('.badge').count()) === 0, '임명장을 본 뒤에도 점 표시가 남아 있습니다')
      await A.locator('.hud-menu-btn').click()
      await item.waitFor({ state: 'hidden', timeout: 3000 })
      return '토스트 2번 → 메뉴 점 → 임명장 탭 → 점 사라짐'
    })

    // ───────── 모바일 ─────────
    const ctxB = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true })
    const B = await ctxB.newPage()
    watch(B, 'mobile')
    await join(B)
    await check('모바일: 5분 넘게 놀면 메뉴에 결산 배지가 붙고, 결산을 보면 사라진다', async () => {
      await B.evaluate(() => {
        const orig = performance.now.bind(performance)
        performance.now = () => orig() + 6 * 60 * 1000
      })
      await B.locator('.hud-menu-btn').click()
      const item = B.locator('.hud-menu-item', { hasText: '임명장·공유' })
      await item.waitFor({ state: 'visible', timeout: 3000 })
      const badge = await item.locator('.badge').count()
      assert(badge === 1, '배지가 없습니다: ' + (await B.locator('.hud-menu').innerHTML()).slice(0, 400) + ' now=' + (await B.evaluate(() => performance.now())))
      await B.screenshot({ path: path.join(OUT, 'share-mobile-menu-badge.png') })
      await item.click()
      await waitCard(B, 'summary')
      await B.locator('.panel-close').click()
      await B.locator('.hud-menu-btn').click()
      await item.waitFor({ state: 'visible', timeout: 3000 })
      const after = await item.locator('.badge').count()
      assert(after === 0, '결산을 본 뒤에도 배지가 남아 있습니다')
      // 열어 둔 메뉴를 닫는다(다음 단계가 메뉴 버튼을 다시 누른다)
      await B.locator('.hud-menu-btn').click()
      await item.waitFor({ state: 'hidden', timeout: 3000 })
      return '배지 → 결산 탭 → 배지 사라짐'
    })
    await check('모바일: 거절 직후 📸 버튼이 HUD 아래 오른쪽에 뜬다(조이스틱·상황 버튼과 안 겹침)', async () => {
      // 모바일은 포교 왕복이 느려서 서버가 보낼 법한 거절 메시지를 클라이언트 버스로 흉내 낸다(UI 배치 확인용)
      await B.evaluate(() => {
        const g = window.__doas
        const n = [...g.store.npcs.values()][0]
        g.bus.emitMsg({ t: 'pitchRes', p: g.store.me.id, n: n ? n.pub.id : 1, l: 0, o: 'flee', say: '어머 저 지금 진짜 바빠서요!' })
      })
      const btn = B.locator('.cert-snap')
      await btn.waitFor({ state: 'visible', timeout: 2000 })
      const r = await btn.boundingBox()
      const vp = B.viewportSize()
      assert(r && r.y < vp.height * 0.5 && r.x > vp.width * 0.4, `버튼 위치가 이상합니다 ${JSON.stringify(r)}`)
      assert(r.height >= 42, `터치 영역이 작습니다(${r.height}px)`)
      await B.screenshot({ path: path.join(OUT, 'share-mobile-snap-button.png') })
      return `x=${Math.round(r.x)} y=${Math.round(r.y)} h=${Math.round(r.height)}`
    })
    await check('모바일: 메뉴 → 임명장 패널, 세 탭 모두 그려진다', async () => {
      await openPanelViaMenu(B)
      await waitCard(B, 'certificate')
      await B.screenshot({ path: path.join(OUT, 'share-mobile-certificate.png') })
      await B.locator('.cert-tabs .tab', { hasText: '오늘의 결산' }).click()
      await waitCard(B, 'summary')
      await B.screenshot({ path: path.join(OUT, 'share-mobile-summary.png') })
      await B.locator('.cert-tabs .tab', { hasText: '거절 짤' }).click()
      const s = await waitCard(B, 'meme')
      assert(s.w === 1080 && s.h === 1080, `${s.w}×${s.h}`)
      await B.screenshot({ path: path.join(OUT, 'share-mobile-meme.png') })
      const v = await sampleVariety(B)
      assert(v.colors > 20, `모바일 캡처가 단색에 가깝습니다(colors=${v.colors})`)
      const d = await downloadPng(B, 'meme')
      assert(d.w === 1080 && d.h === 1080, `${d.w}×${d.h}`)
      // 패널이 화면 밖으로 넘치지 않는지
      const box = await B.locator('.panel').boundingBox()
      const vp = B.viewportSize()
      assert(box && box.y >= 0 && box.y + box.height <= vp.height + 1, '패널이 화면을 넘칩니다')
      return '세 탭 + 저장'
    })
    await B.locator('.panel-close').click()
    const errs = errors.filter((e) => !/GL Driver|WebGL|GPU stall/i.test(e))
    await check('페이지 오류가 없다', async () => {
      assert(errs.length === 0, errs.slice(0, 5).join(' | '))
      return ''
    })
  } finally {
    await browser.close()
    if (server) server.kill()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n[share] ${results.length - failed}/${results.length} 통과`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  if (server) server.kill()
  process.exit(1)
})
