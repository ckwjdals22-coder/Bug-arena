#!/usr/bin/env node
/**
 * 터치 입력 E2E: 실제 터치(Playwright tap · CDP 터치)로만 누르고, 서버로 나간 메시지를 기록해 확인한다.
 *  - 💬 말풍선 / 🙌 이모트를 한 번 탭하면 시트만 열리고, 손가락 밑에 새로 생긴 타일이 눌리지 않는다(유령 click)
 *  - 그다음 고른 말풍선 하나만 정확히 나간다
 *  - 두 손가락을 벌린 채 시작한 축소 핀치는 걷지 않고 줌만 바뀐다, 양손 엄지(조이스틱 + 시점)는 그대로 걷고 돈다
 *  - (PC) 확인 창이 떠 있을 때 Esc 는 확인 창만 닫는다(아래 패널은 남는다)
 *
 *   npm run build && node tests/e2e/touch.cjs
 *   (옵션) E2E_PORT=8897  E2E_URL=http://… (이미 떠 있는 서버 사용)
 */
const path = require('node:path')
const { OUT, sleep, startServer, launch, devices } = require('./lib.cjs')

const MOBILES = [
  ['iPhone 13', { ...devices['iPhone 13'] }],
  // 안드로이드 좁은 폰(리뷰에서 문제가 처음 보고된 크기)
  ['Android 360x740', { ...devices['Pixel 5'], viewport: { width: 360, height: 740 }, screen: { width: 360, height: 740 } }],
]

;(async () => {
  const port = Number(process.env.E2E_PORT || 8897)
  const srv = process.env.E2E_URL ? { base: process.env.E2E_URL, stop: () => {} } : await startServer(port)
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
      check(name, false, String(err.message || err).slice(0, 300))
    }
  }

  async function open(ctxOpts, tag, room) {
    const context = await browser.newContext(ctxOpts)
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(`${tag} exception: ${e.message}`))
    page.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console.error: ${m.text()}`))
    await page.goto(`${srv.base}/?room=${room}`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing' && window.__doas.store.me, null, { timeout: 25000 })
    // 보낸 메시지 기록기(검증용): 실제 전송은 그대로 한다
    await page.evaluate(() => {
      const net = window.__doas.net
      const send = net.send.bind(net)
      window.__sent = []
      net.send = (m) => {
        window.__sent.push(m)
        return send(m)
      }
    })
    return { context, page }
  }
  const sent = (page, t) => page.evaluate((t) => window.__sent.filter((m) => m.t === t), t)
  const clearSent = (page) => page.evaluate(() => (window.__sent.length = 0))
  const visible = (page, sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0
  }, sel)
  const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent))

  try {
    let room = 1
    for (const [label, ctxOpts] of MOBILES) {
      const { context, page } = await open(ctxOpts, label, room++)
      const cdp = await context.newCDPSession(page)
      const rawTap = async (loc) => {
        const b = await loc.boundingBox()
        const pt = [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1, radiusX: 6, radiusY: 6, force: 1 }]
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt })
        await sleep(60)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      await page.locator('.emotes-touch:not(.hidden)').waitFor({ timeout: 5000 })
      const tChat = page.locator('.emotes-tbtn[aria-label="말풍선"]')
      const tEmote = page.locator('.emotes-tbtn[aria-label="이모트"]')
      const close = async () => {
        // 시트 바깥(화면 위쪽 빈 곳)을 눌러 닫는다
        await page.evaluate(() => {
          for (const s of document.querySelectorAll('.emotes-chat, .emotes-sheet')) s.querySelector('.emotes-close')?.click()
        })
        await sleep(200)
      }

      for (const [how, tap] of [['tap', (l) => l.tap()], ['CDP 터치', rawTap]]) {
        await step(`${label}: 💬 말풍선 ${how} → 시트만 열리고 아무 말풍선도 나가지 않는다`, async () => {
          await clearSent(page)
          await tap(tChat)
          await sleep(500)
          const open = await visible(page, '.emotes-chat')
          const says = await sent(page, 'say')
          if (!open) throw new Error('시트가 열리지 않음(유령 click 이 고른 뒤 닫았을 수 있음)')
          if (says.length) throw new Error('고르지 않은 말풍선이 나감: ' + JSON.stringify(says))
          if (how === 'tap') await page.screenshot({ path: path.join(OUT, `touch-${room}-chat-open.png`) })
          return 'sheet open, say 0'
        })
        await step(`${label}: 시트에서 말풍선 하나를 ${how} → 정확히 그것만 나간다`, async () => {
          const item = page.locator('.emotes-chat-item:not(.locked)').nth(2)
          const text = await item.locator('.emotes-chat-text').textContent()
          const want = await page.evaluate((text) => {
            const el = [...document.querySelectorAll('.emotes-chat-item')].findIndex((b) => b.querySelector('.emotes-chat-text').textContent === text)
            return el
          }, text)
          await clearSent(page)
          await tap(item)
          await sleep(500)
          const says = await sent(page, 'say')
          if (says.length !== 1) throw new Error('say ' + JSON.stringify(says))
          if (says[0].q !== want) throw new Error(`보낸 q=${says[0].q}, 고른 것=${want}`)
          if (await visible(page, '.emotes-chat')) throw new Error('고른 뒤에도 시트가 열려 있음')
          return `"${text}" (q=${want})`
        })
        // 말풍선 쿨타임(버튼이 잠긴다)이 풀리기를 기다린다
        await page.waitForFunction(() => !document.querySelector('.emotes-tbtn[aria-label="말풍선"]').classList.contains('cooling'), null, { timeout: 8000 }).catch(() => {})
        await close()

        await step(`${label}: 🙌 이모트 ${how} → 시트만 열리고 동작·안내가 나가지 않는다`, async () => {
          await clearSent(page)
          const t0 = (await toasts(page)).length
          await tap(tEmote)
          await sleep(500)
          const open = await visible(page, '.emotes-sheet')
          const em = await sent(page, 'emote')
          const tl = await toasts(page)
          if (!open) throw new Error('시트가 열리지 않음')
          if (em.length) throw new Error('고르지 않은 동작이 나감: ' + JSON.stringify(em))
          const lockToast = tl.slice(t0).filter((t) => /직급이 되면/.test(t))
          if (lockToast.length) throw new Error('잠긴 동작 안내가 뜸: ' + lockToast[0])
          return 'sheet open, emote 0, toast 0'
        })
        await step(`${label}: 이모트 시트에서 '손 흔들기' ${how} → 그 동작만 나간다`, async () => {
          const tile = page.locator('.emotes-tile:not(.locked)').first()
          await clearSent(page)
          await tap(tile)
          await sleep(500)
          const em = await sent(page, 'emote')
          if (em.length !== 1) throw new Error('emote ' + JSON.stringify(em))
          return JSON.stringify(em[0])
        })
        await close()
        await sleep(400)
      }

      // ───── 옆 사람 상황 버튼 → 상대 시트: 시트의 [배틀]·[신고] 등이 손가락 밑에서 저절로 눌리지 않는다 ─────
      if (label === 'iPhone 13') {
        await step(`${label}: [인사·더보기] 탭 → 상대 시트만 열리고 배틀 신청 등이 나가지 않는다`, async () => {
          const pc = await open({ viewport: { width: 1280, height: 720 } }, 'pc-near', room - 1)
          const me = await page.evaluate(() => [window.__doas.store.me.x, window.__doas.store.me.z])
          for (let i = 0; i < 60; i++) {
            const d = await pc.page.evaluate(([x, z]) => {
              const g = window.__doas
              const m = g.store.me
              if (!g.player.target) g.player.moveTo(x + 1.8, z)
              return Math.hypot(m.x - x - 1.8, m.z - z)
            }, me)
            if (d < 0.9) break
            await sleep(300)
          }
          await pc.page.evaluate(() => window.__doas.player.cancelMove())
          const btn = page.locator('.hud-action[aria-label="인사·더보기"]')
          await btn.waitFor({ timeout: 6000 })
          await sleep(300)
          await clearSent(page)
          await rawTap(btn)
          await sleep(600)
          const sheetOpen = await visible(page, '.social-sheet')
          const s = await page.evaluate(() => window.__sent.filter((m) => m.t !== 'mv' && m.t !== 'move' && m.t !== 'pos' && m.t !== 'ping'))
          await page.screenshot({ path: path.join(OUT, 'touch-social-sheet.png') })
          await pc.context.close()
          if (!sheetOpen) throw new Error('상대 시트가 열리지 않음')
          if (s.length) throw new Error('고르지 않은 동작이 나감: ' + JSON.stringify(s))
          await page.keyboard.press('Escape')
          return 'sheet open, sent 0'
        })
      }

      // ───── 핀치 / 양손 엄지 (CDP 멀티 터치) ─────
      const W = await page.evaluate(() => innerWidth)
      const H = await page.evaluate(() => innerHeight)
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) })
      const snap = () => page.evaluate(() => { const g = window.__doas; return { x: g.store.me.x, z: g.store.me.z, dist: g.rig.dist, yaw: g.rig.yaw } })
      const settle = async () => {
        await sleep(700)
        await page.evaluate(() => window.__doas.player.cancelMove())
      }
      async function pinch(sep, spread, gap) {
        await settle()
        const s0 = await snap()
        const y = Math.round(H * 0.55)
        const a = [W / 2 - sep / 2, y]
        const b = [W / 2 + sep / 2, y]
        await touch('touchStart', [[a[0], a[1], 1]])
        await sleep(gap)
        await touch('touchStart', [[a[0], a[1], 1], [b[0], b[1], 2]])
        for (let i = 1; i <= 10; i++) {
          const f = (spread * i) / 10
          await touch('touchMove', [[a[0] - f, a[1], 1], [b[0] + f, b[1], 2]])
          await sleep(30)
        }
        await touch('touchEnd', [])
        await sleep(400)
        const s1 = await snap()
        return { moved: Math.hypot(s1.x - s0.x, s1.z - s0.z), dDist: s1.dist - s0.dist }
      }
      await step(`${label}: 손가락을 벌린 채 시작한 축소 핀치(240px) → 걷지 않고 멀어진다`, async () => {
        // 줌 한계에 걸려 있지 않게 먼저 가깝게 당겨 둔다
        await page.evaluate(() => (window.__doas.rig.dist = 7))
        const r = await pinch(Math.min(240, W - 60), -40, 30)
        if (r.moved >= 0.1) throw new Error(`걸었다 ${r.moved.toFixed(2)}m`)
        if (!(r.dDist > 0.3)) throw new Error(`줌 변화 ${r.dDist.toFixed(2)}`)
        return `moved ${r.moved.toFixed(2)}m, dist +${r.dDist.toFixed(2)}`
      })
      await step(`${label}: 확대 핀치(가까이서 벌리기) → 걷지 않고 가까워진다`, async () => {
        const r = await pinch(80, 50, 30)
        if (r.moved >= 0.1) throw new Error(`걸었다 ${r.moved.toFixed(2)}m`)
        if (!(r.dDist < -0.3)) throw new Error(`줌 변화 ${r.dDist.toFixed(2)}`)
        return `moved ${r.moved.toFixed(2)}m, dist ${r.dDist.toFixed(2)}`
      })
      await step(`${label}: 양손 엄지(왼손 조이스틱 위로 + 오른손 옆으로) → 걸으면서 돈다`, async () => {
        await settle()
        const s0 = await snap()
        const ty = Math.round(H * 0.62)
        const a = [W * 0.18, ty]
        const b = [W * 0.78, ty]
        await touch('touchStart', [[a[0], a[1], 1]])
        await sleep(40)
        await touch('touchStart', [[a[0], a[1], 1], [b[0], b[1], 2]])
        for (let i = 1; i <= 25; i++) {
          await touch('touchMove', [[a[0], Math.max(a[1] - 60, a[1] - i * 6), 1], [b[0] + i * 4, b[1], 2]])
          await sleep(40)
        }
        const s1 = await snap()
        await touch('touchEnd', [])
        const moved = Math.hypot(s1.x - s0.x, s1.z - s0.z)
        const dYaw = Math.abs(s1.yaw - s0.yaw)
        if (moved < 0.5) throw new Error(`걷지 않음 ${moved.toFixed(2)}m`)
        if (dYaw < 0.1) throw new Error(`돌지 않음 ${dYaw.toFixed(3)}`)
        return `moved ${moved.toFixed(2)}m, yaw ${dYaw.toFixed(2)}`
      })
      await context.close()
    }

    // ───── PC: 확인 창 위의 Esc ─────
    await step('PC: 설정 → 초기화 확인 창에서 Esc → 확인 창만 닫히고 설정 패널은 남는다', async () => {
      const { context, page } = await open({ viewport: { width: 1280, height: 720 } }, 'pc', room++)
      await page.locator('.hud-menu-btn').click()
      await page.locator('button', { hasText: '설정·도움말' }).first().click()
      await page.locator('.panel').waitFor({ state: 'visible', timeout: 3000 })
      const reset = page.locator('.panel-layer button', { hasText: '초기화' }).first()
      await reset.scrollIntoViewIfNeeded()
      await reset.click()
      await page.locator('.confirm-layer').waitFor({ timeout: 2000 })
      await page.keyboard.press('Escape')
      await sleep(250)
      const st = await page.evaluate(() => ({ panel: window.__doas && !!document.querySelector('.panel-layer:not(.hidden):not(.confirm-layer) .panel'), confirm: !!document.querySelector('.confirm-layer') }))
      if (st.confirm) throw new Error('확인 창이 남아 있음')
      if (!st.panel) throw new Error('설정 패널까지 닫힘')
      await page.keyboard.press('Escape')
      await sleep(250)
      const panel2 = await page.evaluate(() => !!document.querySelector('.panel-layer:not(.hidden):not(.confirm-layer) .panel'))
      if (panel2) throw new Error('두 번째 Esc 로 패널이 닫히지 않음')
      await context.close()
      return 'Esc1: confirm 닫힘·패널 유지, Esc2: 패널 닫힘'
    })
    await step('브라우저 오류 없음', async () => {
      if (errors.length) throw new Error(errors.slice(0, 5).join(' | '))
    })
  } finally {
    await browser.close()
    srv.stop()
  }
  console.log(failed ? `\n[touch e2e] 실패 ${failed}건` : '\n[touch e2e] 모두 통과')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
