#!/usr/bin/env node
/**
 * 가상 매점 E2E: 메뉴에서 구경 → 멀리서는 살 수 없음 → 천막까지 걸어가 상황 버튼으로 열기 → 가상 코인으로 칭호 바꾸기
 * → 이름표에 달기 → 다른 사람 화면의 이름표에 보임 → 새로고침해도 유지.
 */
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ROOT, OUT, sleep, startServer, launch, openPlayer, state, waitState, walkTo, devices } = require('./lib.cjs')

const SECRET = 'shop-e2e-secret-0123456789abcdef'
/** 가상 코인이 든 서명된 저장본을 만든다(서버와 같은 비밀 값으로 서명) */
function profileWithCoins(pid, coins) {
  const code = `
    import { createSigner } from './server/core/save.ts'
    import { newProgress } from './shared/rules/progress.ts'
    const p = newProgress(${JSON.stringify(pid)}, Date.now())
    p.coins = ${coins}
    const d = JSON.stringify(p)
    console.log(JSON.stringify({ pid: ${JSON.stringify(pid)}, name: '매점손님', tutorialDone: true, save: { d, s: createSigner(${JSON.stringify(SECRET)}).sign(d) } }))
  `
  return execFileSync('npx', ['tsx', '-e', code], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop()
}

;(async () => {
  const port = Number(process.env.E2E_PORT || 8896)
  const srv = await startServer(port, { SAVE_SECRET: SECRET })
  const browser = await launch()
  const errors = []
  let failed = 0
  const check = (name, ok, detail = '') => {
    if (!ok) failed++
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  try {
    const profile = profileWithCoins('shop-e2e-buyer-0001', 120)
    const ctxA = await browser.newContext({ ...devices['iPhone 13'] })
    await ctxA.addInitScript((p) => {
      if (!localStorage.getItem('doas.profile.v1')) localStorage.setItem('doas.profile.v1', p)
    }, profile)
    const A = await ctxA.newPage()
    A.on('pageerror', (e) => errors.push(`A exception: ${e.message}`))
    A.on('console', (m) => {
      if (m.type() === 'error') errors.push(`A console.error: ${m.text()}`)
    })
    await A.goto(`${srv.base}/?room=1`, { waitUntil: 'load' })
    await A.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing' && window.__doas.store.me, null, { timeout: 25000 })
    const B = (await openPlayer(browser, srv.base, 'pc', 1, errors)).page
    const a0 = await state(A)
    check('저장본의 가상 코인을 가지고 입장한다', a0.coins === 120, `코인 ${a0.coins}`)

    // 1) 메뉴에서 구경: 멀리서는 바꿀 수 없다
    await A.locator('.hud-menu-btn').tap()
    await A.locator('.hud-menu-item, .hud-more-item, button', { hasText: '가상 매점' }).first().tap()
    await A.locator('.shop-list').waitFor({ state: 'visible', timeout: 4000 })
    const items = await A.locator('.shop-item').count()
    check('매점 화면에 물건 목록과 "전부 가상" 안내가 보인다', items >= 10 && (await A.locator('.shop-note').innerText()).includes('실제 돈'), `${items}개`)
    check('천막에서 멀면 바꾸기 버튼이 꺼져 있고 이유가 적혀 있다', (await A.locator('.shop-buy').first().isDisabled()) && (await A.locator('.shop-far').isVisible()))
    await A.screenshot({ path: path.join(OUT, 'shop-1-far-mobile.png') })
    await A.locator('.panel-close').tap()

    // 2) 천막까지 걸어가면 상황 버튼이 뜬다
    const box = await A.evaluate(() => {
      const g = window.__doas
      return { poi: g.store.near.poi }
    })
    void box
    const tent = JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./shared/world/index.ts').then((m) => console.log(JSON.stringify(m.WORLD.offeringBox)))"], { cwd: ROOT, encoding: 'utf8' })
        .trim()
        .split('\n')
        .pop(),
    )
    await walkTo(A, tent.x - 0.4, tent.z - tent.r - 1.1, 1.3, 60000)
    await waitState(A, (s) => s.near.poi === 'offering', 8000, 'at tent')
    const openBtn = A.locator('.hud-action[aria-label="가상 매점"]')
    await openBtn.waitFor({ state: 'visible', timeout: 4000 })
    check('천막 앞에서는 [가상 매점] 상황 버튼이 뜬다', true)
    await openBtn.tap()
    await A.locator('.shop-list').waitFor({ state: 'visible', timeout: 4000 })
    check('천막 앞에서는 안내 문구가 사라지고, 살 수 있는 것만 버튼이 켜진다', !(await A.locator('.shop-far').count()) && !(await A.locator('.shop-item[data-id="s_receipt"] .shop-buy').isDisabled()) && (await A.locator('.shop-item[data-id="s_allin"] .shop-buy').isDisabled()))

    // 3) 바꾸기 → 코인 차감, 보유 표시
    await A.locator('.shop-item[data-id="s_receipt"] .shop-buy').tap()
    await waitState(A, (s) => s.coins === 100, 4000, 'coins 120 → 100')
    await A.locator('.shop-item[data-id="s_receipt"] .shop-wear').waitFor({ state: 'visible', timeout: 3000 })
    check('바꾸면 가상 코인이 줄고(120 → 100) [이름표에 달기]로 바뀐다', (await A.locator('.shop-coins b').innerText()).trim() === '100')
    await A.screenshot({ path: path.join(OUT, 'shop-2-bought-mobile.png') })

    // 4) 이름표에 달기 → 다른 사람 화면에도
    await A.locator('.shop-item[data-id="s_receipt"] .shop-wear').tap()
    await waitState(B, (s) => s.players.some((p) => p.id === a0.id && p.tag === 's_receipt'), 5000, 'B sees tag')
    check('칭호를 달면 다른 사람 화면의 내 정보에도 반영된다', true)
    await A.locator('.panel-close').tap()
    await sleep(500)
    const myTag = await A.locator('.overlay-tag.me .overlay-rank').innerText()
    check('내 이름표에 매점 칭호가 보인다', myTag.includes('영수증 수집가'), myTag)
    await A.screenshot({ path: path.join(OUT, 'shop-3-tag-mobile.png') })

    // 5) 새로고침해도 유지
    await sleep(1300)
    await A.reload({ waitUntil: 'load' })
    await A.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing' && window.__doas.store.me, null, { timeout: 25000 })
    const a1 = await A.evaluate(() => ({ coins: window.__doas.store.me.prog.coins, has: window.__doas.store.me.prog.items.s_receipt, tag: window.__doas.store.me.prog.tag }))
    check('새로고침해도 코인·칭호·착용 상태가 유지된다', a1.coins === 100 && a1.has === 1 && a1.tag === 's_receipt', JSON.stringify(a1))

    const real = errors.filter((e) => !/WebSocket|ERR_CONNECTION|net::/.test(e))
    check('브라우저 콘솔 오류가 없다', real.length === 0, real.slice(0, 3).join(' | '))
  } catch (err) {
    failed++
    console.log(`  ❌ 실행 중 예외 — ${err.message}`)
  } finally {
    await browser.close()
    srv.stop()
  }
  console.log(failed === 0 ? '[shop e2e] 전부 통과' : `[shop e2e] 실패 ${failed}건`)
  process.exit(failed === 0 ? 0 : 1)
})()
