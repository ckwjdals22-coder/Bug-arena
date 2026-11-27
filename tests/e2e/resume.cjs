#!/usr/bin/env node
/**
 * 가득 찬 방에서 끊겼다 돌아오기 E2E (방 2개, 정원 2명):
 *  1) 짧은 끊김: 로비가 보기에 '가득 찬' 방이어도 있던 방으로 돌아가 같은 번호·같은 자리로 이어진다.
 *     (가득 찬 자리 하나가 잠깐 끊긴 나 자신이다 — 예전에는 다른 방으로 보내져 상태를 잃었다.)
 *  2) 오래 끊겨 그사이 자리가 다른 사람에게 넘어갔다면: '가득 참' 화면에 세우지 않고 자리 있는 방으로 옮기고, 옮겼다고 알려 준다.
 *
 * 사용: npm run build 후 `node tests/e2e/resume.cjs` (포트는 E2E_PORT 로 바꿀 수 있다)
 */
const { sleep, startServer, launch, openPlayer, state } = require('./lib.cjs')

const roomOf = (page) => page.evaluate(() => window.__doas.store.room && window.__doas.store.room.id)
/** 재접속 관련 알림을 페이지 안에 적어 둔다 */
const watch = (page) =>
  page.evaluate(() => {
    const g = window.__doas
    window.__ev = []
    g.bus.on('resumed', (e) => window.__ev.push(['resumed', e]))
    g.bus.on('redirected', (e) => window.__ev.push(['redirected', e]))
    g.bus.on('phase', (p) => window.__ev.push(['phase', p]))
  })
const events = (page) => page.evaluate(() => window.__ev)

;(async () => {
  const port = Number(process.env.E2E_PORT || 8899)
  const srv = await startServer(port, { ROOMS: '2', ROOM_CAPACITY: '2' })
  const browser = await launch()
  const errors = []
  let failed = 0
  const check = (name, ok, detail = '') => {
    if (!ok) failed++
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  try {
    const A = await openPlayer(browser, srv.base, 'pc', '1', errors)
    const B = await openPlayer(browser, srv.base, 'pc', '1', errors)
    await watch(A.page)
    const a0 = await state(A.page)
    check('두 사람이 1번 방을 가득 채운다(2/2)', (await roomOf(A.page)) === '1' && (await roomOf(B.page)) === '1')

    // 1) 짧은 끊김(서버는 '비정상 끊김'으로 보고 A 를 잠깐 세워 둔다 → 로비에는 여전히 가득 찬 방이다)
    await A.page.evaluate(() => window.__doas.net.debugDrop())
    await A.page.waitForFunction(() => window.__ev.some((e) => e[0] === 'resumed'), null, { timeout: 15000 })
    const a1 = await state(A.page)
    const ev1 = await events(A.page)
    const resumed = ev1.find((e) => e[0] === 'resumed')[1]
    check('짧은 끊김 뒤에도 있던 방(1번)으로 돌아온다', (await roomOf(A.page)) === '1', `지금 ${await roomOf(A.page)}번`)
    check('같은 번호로 이어진다', a1.id === a0.id && resumed.same === true, `id ${a0.id} → ${a1.id}, same=${resumed.same}`)
    check('다른 방으로 옮겼다는 안내가 없다', !ev1.some((e) => e[0] === 'redirected'))
    const b1 = await state(B.page)
    check('상대 화면에도 그대로 서 있다', b1.players.some((p) => p.id === a0.id))

    // 2) 오래 끊김: 끊긴 뒤 새 연결을 만들지 못하게 막아 둔다(망이 한동안 죽은 상황)
    await A.page.evaluate(() => {
      window.__ev.length = 0
      const Real = window.WebSocket
      window.__RealWS = Real
      const Fake = function () {
        throw new Error('blocked for test')
      }
      Fake.OPEN = Real.OPEN
      Fake.CLOSED = Real.CLOSED
      Fake.CONNECTING = Real.CONNECTING
      Fake.CLOSING = Real.CLOSING
      window.WebSocket = Fake
      window.__doas.net.debugDrop()
    })
    await sleep(17500) // 서버가 기다려 주는 시간(15초)이 지나 A 의 자리가 빈다
    const C = await openPlayer(browser, srv.base, 'pc', '1', errors)
    check('그사이 다른 사람이 1번 방의 빈자리에 들어온다', (await roomOf(C.page)) === '1', `지금 ${await roomOf(C.page)}번`)
    await A.page.evaluate(() => {
      window.WebSocket = window.__RealWS
      window.dispatchEvent(new Event('online'))
    })
    await A.page.waitForFunction(() => window.__doas.store.phase === 'playing' && window.__ev.some((e) => e[0] === 'resumed'), null, { timeout: 30000 })
    const ev2 = await events(A.page)
    check('자리가 넘어간 뒤에는 자리 있는 방(2번)으로 들어간다', (await roomOf(A.page)) === '2', `지금 ${await roomOf(A.page)}번`)
    check(
      '방이 바뀌었다고 알려 준다',
      ev2.some((e) => e[0] === 'redirected' && e[1].from === '1' && e[1].to === '2'),
    )
    check("'가득 참' 화면에 서지 않는다", !ev2.some((e) => e[0] === 'phase' && e[1] === 'full'))

    const real = errors.filter((e) => !/WebSocket|blocked for test|ERR_CONNECTION|net::/.test(e))
    check('브라우저 콘솔 오류가 없다', real.length === 0, real.slice(0, 3).join(' | '))
  } catch (err) {
    failed++
    console.log(`  ❌ 실행 중 예외 — ${err.message}`)
  } finally {
    await browser.close()
    srv.stop()
  }
  console.log(failed === 0 ? '[resume e2e] 전부 통과' : `[resume e2e] 실패 ${failed}건`)
  process.exit(failed === 0 ? 0 : 1)
})()
