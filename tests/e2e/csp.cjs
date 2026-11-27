/**
 * 보안 헤더(CSP) 아래에서 게임이 그대로 동작하는지: PC·휴대폰 에뮬레이션 각각
 *   로드 → 입장 → 포교 → 메뉴의 모든 패널 열기 → 공유 카드(canvas → blob) 생성·저장 → 소리(AudioContext) 재생
 * 동안 CSP 위반(securitypolicyviolation 이벤트·콘솔 오류)이 0건이어야 한다.
 *
 *   준비: npm run build
 *   실행: E2E_PORT=9047 node tests/e2e/csp.cjs
 */
const path = require('node:path')
const { OUT, sleep, startServer, launch, pitchOnce, devices } = require('./lib.cjs')

const PORT = Number(process.env.E2E_PORT || 9047)

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

/** 페이지 스크립트보다 먼저: CSP 위반과 AudioContext 생성을 기록한다 */
function instrument() {
  window.__csp = []
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile || ''}:${e.lineNumber || 0}`)
  })
  window.__audio = []
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Orig = window[name]
    if (!Orig) continue
    window[name] = class extends Orig {
      constructor(...args) {
        super(...args)
        window.__audio.push(this)
      }
    }
  }
}

async function runOne(browser, base, kind) {
  const context = await browser.newContext({
    ...(kind === 'mobile' ? devices['iPhone 13'] : { viewport: { width: 1280, height: 720 } }),
    acceptDownloads: true,
  })
  await context.addInitScript(instrument)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`exception: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  const res = await page.goto(`${base}/?room=1`, { waitUntil: 'load' })
  check(/script-src 'self'/.test(res.headers()['content-security-policy'] || ''), `${kind}: 문서에 CSP 가 붙어 있다`)
  await page.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing' && window.__doas.store.me, null, { timeout: 25000 })
  await page.locator('.tutorial-skip').click({ timeout: 3000 }).catch(() => {})
  check(true, `${kind}: 입장(phase=playing)`)

  // 소리: 첫 사용자 입력(클릭/탭)에서 AudioContext 가 만들어진다
  const canvas = page.locator('#game')
  if (kind === 'mobile') await canvas.tap({ position: { x: 40, y: 200 } }).catch(() => {})
  else await canvas.click({ position: { x: 60, y: 300 } }).catch(() => {})
  await page.keyboard.press('1').catch(() => {})
  const outcome = await pitchOnce(page)
  check(outcome !== null, `${kind}: 포교 한 번`, String(outcome))

  // 메뉴의 모든 항목을 차례로 연다
  const menuBtn = page.locator('.hud-menu-btn').first()
  await menuBtn.click()
  await sleep(300)
  const labels = await page.locator('.hud-menu-item').allInnerTexts()
  await page.keyboard.press('Escape').catch(() => {})
  let opened = 0
  for (let i = 0; i < labels.length; i++) {
    if (!(await page.locator('.hud-menu-item').first().isVisible().catch(() => false))) {
      await menuBtn.click()
      await sleep(250)
    }
    await page.locator('.hud-menu-item').nth(i).click()
    await sleep(700)
    const panel = page.locator('.panel').first()
    if (await panel.isVisible().catch(() => false)) {
      opened++
      // 공유 카드 패널: 탭마다 canvas → blob 이미지를 만들고, 저장(다운로드)까지 눌러 본다
      const tabs = panel.locator('button', { hasText: /임명장|결산|짤/ })
      const nTabs = await tabs.count()
      if (nTabs >= 2 && (await panel.locator('.cert-save').count()) > 0) {
        const made = []
        for (let t = 0; t < nTabs; t++) {
          await tabs.nth(t).click().catch(() => {})
          // 1080×1920 카드를 그리는 데 휴대폰 에뮬레이션에서는 몇 초 걸린다
          const src = await page
            .waitForFunction(() => {
              const img = document.querySelector('.panel .cert-img')
              const s = img && img.getAttribute('src')
              return s && (s.startsWith('blob:') || s.startsWith('data:')) && img.complete && img.naturalWidth > 0 ? s : null
            }, null, { timeout: 12000 })
            .then((h) => h.jsonValue())
            .catch(() => '')
          made.push(String(src).slice(0, 5) || '없음')
        }
        check(made.every((s) => s === 'blob:' || s === 'data:'), `${kind}: 공유 카드 이미지 ${nTabs}종(blob/data URL)`, made.join(','))
        const dl = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), panel.locator('.cert-save').first().click()])
          .then(([d]) => d.suggestedFilename())
          .catch((e) => `실패 ${e.message}`)
        check(/\.png$/.test(dl), `${kind}: 공유 카드 저장(다운로드)`, dl)
      }
      await page.locator('.panel-close').first().click().catch(() => page.keyboard.press('Escape'))
      await sleep(300)
    }
  }
  check(opened >= 5, `${kind}: 메뉴 패널 ${opened}/${labels.length}개 열림`, labels.join(' · ').replace(/\s+/g, ' '))

  const audio = await page.evaluate(() => window.__audio.map((c) => c.state))
  check(audio.length > 0 && audio.includes('running'), `${kind}: 소리(AudioContext) 재생 중`, JSON.stringify(audio))

  await page.screenshot({ path: path.join(OUT, `csp-${kind}.png`) })
  const violations = await page.evaluate(() => window.__csp)
  const cspConsole = errors.filter((e) => /Content Security Policy|Refused to/i.test(e))
  check(violations.length === 0 && cspConsole.length === 0, `${kind}: CSP 위반 0건`, [...violations, ...cspConsole].slice(0, 5).join(' | '))
  check(errors.length === 0, `${kind}: 페이지 오류 없음`, errors.slice(0, 5).join(' | '))
  await context.close()
}

async function main() {
  const srv = await startServer(PORT, { ROOMS: '1' })
  const browser = await launch()
  try {
    await runOne(browser, srv.base, 'pc')
    await runOne(browser, srv.base, 'mobile')
  } catch (err) {
    failed++
    console.log(`[FAIL] 예외: ${err && err.stack ? err.stack : err}`)
  } finally {
    await browser.close().catch(() => {})
    srv.stop()
  }
  console.log(failed === 0 ? '\ncsp: 전부 통과' : `\ncsp: 실패 ${failed}건`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
