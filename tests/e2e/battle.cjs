#!/usr/bin/env node
/** 포교 배틀 E2E: PC(A)가 신청 → 모바일(B)이 카드에서 수락 → 점수판 → 60초 뒤 결과. */
const path = require('node:path')
const { OUT, sleep, startServer, launch, openPlayer, state, waitState, walkToPlayer, pitchOnce } = require('./lib.cjs')

;(async () => {
  const port = Number(process.env.E2E_PORT || 8898)
  const srv = await startServer(port)
  const browser = await launch()
  const errors = []
  let failed = 0
  const check = (name, ok, detail = '') => {
    if (!ok) failed++
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  try {
    const A = await openPlayer(browser, srv.base, 'pc', 1, errors)
    const B = await openPlayer(browser, srv.base, 'mobile', 1, errors)
    const a0 = await state(A.page)
    const b0 = await state(B.page)
    await walkToPlayer(B.page, A.page)
    await waitState(A.page, (s) => s.near.player === b0.id, 8000, 'A near B')

    const reqBtn = A.page.locator('button', { hasText: '배틀 신청' }).first()
    await reqBtn.waitFor({ state: 'visible', timeout: 5000 })
    await A.page.screenshot({ path: path.join(OUT, 'battle-1-request-pc.png') })
    await reqBtn.click()
    const card = B.page.locator('.battle-card')
    await card.waitFor({ state: 'visible', timeout: 5000 })
    check('신청하면 상대 화면에 수락 카드가 뜬다', (await card.innerText()).includes(a0.name))
    await B.page.screenshot({ path: path.join(OUT, 'battle-2-card-mobile.png') })
    check('수락 전에는 배틀이 시작되지 않는다', (await state(A.page)).battles.length === 0)
    await card.locator('button', { hasText: '받아들인다' }).click()
    await waitState(A.page, (s) => s.battles.length === 1, 5000, 'battle start A')
    await waitState(B.page, (s) => s.battles.length === 1, 5000, 'battle start B')
    check('수락하면 양쪽 모두 점수판이 뜬다', (await A.page.locator('.battle-board').isVisible()) && (await B.page.locator('.battle-board').isVisible()))

    // 배틀 도중 B(모바일)의 연결이 1초쯤 끊긴다(와이파이 ↔ 데이터 전환 같은 상황): 배틀은 무효가 되지 않고 이어져야 한다
    const posB = await state(B.page)
    await B.page.evaluate(() => window.__doas.net.debugDrop())
    await waitState(B.page, (s) => s.phase === 'playing' && s.battles.length === 1, 12000, 'B resumes with battle')
    const afterB = await state(B.page)
    check('배틀 중 잠깐 끊겨도 같은 번호·같은 자리로 이어지고 배틀이 유지된다', afterB.id === b0.id && Math.hypot(afterB.x - posB.x, afterB.z - posB.z) < 1.5 && (await state(A.page)).battles.length === 1, `id ${b0.id}→${afterB.id}, 이동 ${Math.hypot(afterB.x - posB.x, afterB.z - posB.z).toFixed(2)}m`)
    check('상대 화면에는 퇴장·무효 소식이 뜨지 않는다', !(await A.page.locator('.battle-result:not(.hidden)').count()) && (await A.page.locator('.battle-board').isVisible()))
    await B.page.locator('.battle-board').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    check('돌아온 쪽 화면에도 점수판이 다시 보인다', await B.page.locator('.battle-board').isVisible())

    // 60초 동안 A 는 포교를 시도한다(결과는 확률). 합류 횟수 = 점수여야 한다
    let joins = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 38000) {
      const o = await pitchOnce(A.page)
      if (o === 'join' || o === 'king') joins++
      if (o === null) await sleep(1000)
    }
    const mid = await state(A.page)
    const b = mid.battles[0]
    const myScore = b ? (b.a === mid.id ? b.sa : b.sb) : -1
    check('내 점수는 배틀 중 합류시킨 시민 수와 같다', myScore === joins, `합류 ${joins}회, 점수 ${myScore}`)
    await A.page.screenshot({ path: path.join(OUT, 'battle-3-board-pc.png') })
    await B.page.screenshot({ path: path.join(OUT, 'battle-3-board-mobile.png') })

    const infA = mid.inf
    await waitState(A.page, (s) => s.battles.length === 0, 40000, 'battle end')
    await sleep(700)
    check('시간이 끝나면 양쪽에 결과가 뜬다', (await A.page.locator('.battle-result').isVisible()) && (await B.page.locator('.battle-result').isVisible()))
    await A.page.screenshot({ path: path.join(OUT, 'battle-4-result-pc.png') })
    await B.page.screenshot({ path: path.join(OUT, 'battle-4-result-mobile.png') })
    const endA = await state(A.page)
    check('결과에 따라 영향력을 받는다', endA.inf > infA, `+${endA.inf - infA}`)
    const real = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e))
    check('브라우저 콘솔 오류가 없다', real.length === 0, real.slice(0, 3).join(' | '))
    void b0
  } catch (err) {
    failed++
    console.log('  ❌ 실행 중 예외 —', err.message)
  } finally {
    await browser.close()
    srv.stop()
  }
  console.log(failed ? `[battle e2e] 실패 ${failed}건` : '[battle e2e] 전부 통과')
  process.exit(failed ? 1 : 0)
})()
