#!/usr/bin/env node
/** 설정 · 첫 접속 안내 · 장소 표지 · 만석 대기 E2E. */
const path = require('node:path')
const { OUT, sleep, startServer, launch, openPlayer, state, waitState, walkTo } = require('./lib.cjs')

;(async () => {
  const port = Number(process.env.E2E_PORT || 8896)
  let srv = await startServer(port)
  const browser = await launch()
  const errors = []
  let failed = 0
  const check = (name, ok, detail = '') => {
    if (!ok) failed++
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  const step = async (name, fn) => {
    try {
      check(name, true, (await fn()) || '')
    } catch (err) {
      check(name, false, String(err.message || err).slice(0, 200))
    }
  }
  try {
    for (const kind of ['pc', 'mobile']) {
      const P = await openPlayer(browser, srv.base, kind, 1, errors)
      const page = P.page
      const hint = page.locator('.tutorial-hint')
      await step(`${kind}: 처음 접속하면 이동 안내가 뜬다`, async () => {
        await hint.waitFor({ state: 'visible', timeout: 4000 })
        const t = await hint.innerText()
        if (!/움직여/.test(t)) throw new Error(t)
        await page.screenshot({ path: path.join(OUT, `onb-${kind}-1-move.png`) })
        return t.replace(/\s+/g, ' ').slice(0, 40)
      })
      await step(`${kind}: 조금 걸으면 '말 걸기' 안내로 넘어간다`, async () => {
        const s0 = await state(page)
        await walkTo(page, s0.x + 3.5, s0.z - 3.5, 0.8, 15000)
        await page.waitForFunction(() => /말 걸기/.test(document.querySelector('.tutorial-hint')?.textContent || ''), null, { timeout: 5000 })
      })
      await step(`${kind}: 떨어진 장소에 표지가 보인다`, async () => {
        const n = await page.locator('.tutorial-pin:not(.hidden)').count()
        if (n < 1) throw new Error('보이는 표지 없음')
        await page.screenshot({ path: path.join(OUT, `onb-${kind}-2-pins.png`) })
        return `표지 ${n}개`
      })
      await step(`${kind}: 메뉴 → 설정·도움말, 설정을 바꾸면 저장되고 반영된다`, async () => {
        await page.locator('.hud-menu-btn, button[aria-label="메뉴"]').first().click()
        await page.locator('button', { hasText: '설정·도움말' }).first().click()
        await page.locator('.panel').waitFor({ state: 'visible', timeout: 3000 })
        await page.screenshot({ path: path.join(OUT, `onb-${kind}-3-settings.png`) })
        const sw = page.locator('.settings-switch')
        const before = await page.evaluate(() => ({ ...window.__doas.store.profile.settings }))
        await sw.nth(1).click() // 배경음(오디오가 깨어나기 전이어도 예외가 나면 안 된다)
        await sw.nth(3).click() // 초대 받지 않기
        await page.locator('.settings-seg-btn', { hasText: '낮음' }).click()
        const after = await page.evaluate(() => ({ s: { ...window.__doas.store.profile.settings }, q: window.__doas.engine.quality, saved: JSON.parse(localStorage.getItem('doas.profile.v1')).settings }))
        if (after.s.music === before.music || after.s.noInvites === before.noInvites) throw new Error('토글이 바뀌지 않음')
        if (after.s.quality !== 'low' || after.q !== 'low') throw new Error(`화질 ${after.s.quality}/${after.q}`)
        if (after.saved.quality !== 'low' || after.saved.noInvites !== after.s.noInvites) throw new Error('저장되지 않음')
        await page.locator('.panel-body').evaluate((el) => (el.scrollTop = el.scrollHeight))
        await sleep(200)
        await page.screenshot({ path: path.join(OUT, `onb-${kind}-4-settings-bottom.png`) })
        await page.keyboard.press('Escape')
        await page.locator('.panel-close').click().catch(() => {})
        return `배경음 ${after.s.music}, 초대 차단 ${after.s.noInvites}, 화질 ${after.q}`
      })
      await step(`${kind}: 안내를 끄면 새로고침해도 다시 뜨지 않고 설정도 남는다`, async () => {
        await page.locator('.tutorial-skip').click()
        await page.reload({ waitUntil: 'load' })
        await page.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing', null, { timeout: 25000 })
        await sleep(1200)
        if (await page.locator('.tutorial-hint').isVisible()) throw new Error('안내가 다시 보임')
        const q = await page.evaluate(() => window.__doas.store.profile.settings.quality)
        if (q !== 'low') throw new Error(`화질 설정이 유지되지 않음: ${q}`)
      })
      await P.context.close()
    }

    // ── 만석 대기: 정원 1명짜리 방 하나로 서버를 다시 띄운다 ──
    srv.stop()
    await sleep(800)
    srv = await startServer(port, { ROOMS: '1', ROOM_CAPACITY: '1' })
    const A = await openPlayer(browser, srv.base, 'pc', 1, errors)
    const ctxB = await browser.newContext({ viewport: { width: 420, height: 800 } })
    const B = await ctxB.newPage()
    B.on('pageerror', (e) => errors.push(`B exception: ${e.message}`))
    await step('만석: 두 번째 사람은 안내와 전단지 접기 화면을 본다', async () => {
      await B.goto(`${srv.base}/?room=1`, { waitUntil: 'load' })
      await B.waitForFunction(() => window.__doas && window.__doas.store.phase === 'full', null, { timeout: 20000 })
      const w = B.locator('.tutorial-wait')
      await w.waitFor({ state: 'visible', timeout: 4000 })
      await w.locator('button').click()
      await w.locator('button').click()
      const t = await w.innerText()
      if (!/2장/.test(t)) throw new Error(t)
      await B.screenshot({ path: path.join(OUT, 'onb-full-wait.png') })
      return t.replace(/\s+/g, ' ').slice(0, 60)
    })
    await step('만석: 자리가 나면 자동으로 들어간다', async () => {
      await A.context.close()
      await B.waitForFunction(() => window.__doas.store.phase === 'playing', null, { timeout: 20000 })
      if (await B.locator('.tutorial-wait').isVisible()) throw new Error('대기 화면이 남아 있음')
    })
    const real = errors.filter((e) => !/Failed to load resource|net::ERR_|WebSocket/.test(e))
    check('브라우저 콘솔 오류가 없다', real.length === 0, real.slice(0, 3).join(' | '))
    void waitState
  } catch (err) {
    failed++
    console.log('  ❌ 실행 중 예외 —', err.message)
  } finally {
    await browser.close()
    srv.stop()
  }
  console.log(failed ? `[onboarding e2e] 실패 ${failed}건` : '[onboarding e2e] 전부 통과')
  process.exit(failed ? 1 : 0)
})()
