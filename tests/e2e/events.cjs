#!/usr/bin/env node
/**
 * 돌발 이벤트 E2E: 단속반(발각 → 추격 → 훈방/따돌림) + 라이벌 기싸움 + 예능 자막.
 *  1) PC(A): 단속반 근처에서 포교 → alert/chase → 가만히 있다가 잡힘 → 3초 얼어붙음 → 다시 움직임
 *  2) PC(A): 단속반 쉬는 동안 라이벌(role 'rival')을 찾아 포교 → 기싸움 시트에서 선택 → 결과 배너 (확률: 제한 시간 안에 못 만나면 '미실행'으로 보고)
 *  3) 모바일(B): 쉬는 시간이 끝난 뒤 단속반 근처에서 포교 → 진짜 '도망가기' 버튼을 눌러 달아남 → lost 또는 caught
 *  4) 스크린숏: 자막 3가지 스타일(실제 화면에 뜬 것 + 부족하면 화면 전용 로컬 이벤트로 채움)
 */
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ROOT, OUT, sleep, startServer, launch, openPlayer, state, walkTo } = require('./lib.cjs')

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `events-${name}.png`) })

// 맵의 NPC 이동망(인도) — 탭 이동은 직선이라 건물에 막히므로, 멀리 갈 때는 이동망 노드를 따라 걷는다
const NAV = JSON.parse(
  execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./shared/world/index.ts').then((m) => console.log(JSON.stringify(m.WORLD.nav)))"], {
    cwd: ROOT,
    encoding: 'utf8',
  }),
)
function nearestNode(x, z) {
  let best = 0
  let bd = Infinity
  NAV.nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - x, n.z - z)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best
}
function navPath(a, b) {
  const adj = NAV.nodes.map(() => [])
  for (const [u, v] of NAV.edges) {
    adj[u].push(v)
    adj[v].push(u)
  }
  const dist = NAV.nodes.map(() => Infinity)
  const prev = NAV.nodes.map(() => -1)
  const done = new Set()
  dist[a] = 0
  while (done.size < NAV.nodes.length) {
    let u = -1
    for (let i = 0; i < dist.length; i++) if (!done.has(i) && (u < 0 || dist[i] < dist[u])) u = i
    if (u < 0 || dist[u] === Infinity || u === b) break
    done.add(u)
    for (const v of adj[u]) {
      const d = dist[u] + Math.hypot(NAV.nodes[u].x - NAV.nodes[v].x, NAV.nodes[u].z - NAV.nodes[v].z)
      if (d < dist[v]) {
        dist[v] = d
        prev[v] = u
      }
    }
  }
  const out = []
  for (let c = b; c !== -1; c = prev[c]) out.unshift(c)
  return out[0] === a ? out : [b]
}
/** 이동망을 따라 (x,z) 근처까지 걷는다. 목표가 움직이면 getTarget 으로 매번 다시 읽는다 */
async function walkPath(page, getTarget, reach = 3, timeout = 45000) {
  const end = Date.now() + timeout
  const t0 = await getTarget()
  const me = await state(page)
  if (Math.hypot(me.x - t0.x, me.z - t0.z) <= reach) return true
  const nodes = navPath(nearestNode(me.x, me.z), nearestNode(t0.x, t0.z))
  for (const i of nodes) {
    const n = NAV.nodes[i]
    const left = end - Date.now()
    if (left <= 0) return false
    try {
      await walkTo(page, n.x, n.z, 1.6, Math.min(left, 15000))
    } catch {
      /* 노드 하나 못 가도 다음 노드로 */
    }
    const t = await getTarget()
    const s = await state(page)
    if (Math.hypot(s.x - t.x, s.z - t.z) <= reach) return true
  }
  const t = await getTarget()
  try {
    await walkTo(page, t.x, t.z, reach, Math.max(1000, end - Date.now()))
    return true
  } catch {
    return false
  }
}

/** 단속반/기싸움 메시지를 페이지 안에 기록해 둔다 */
async function record(page) {
  await page.evaluate(() => {
    const g = window.__doas
    window.__ev = []
    // events.ts 의 구독이 먼저 등록돼 있으므로, 여기서 읽는 DOM 은 그 메시지를 처리한 직후의 모습이다
    g.bus.onMsg('patrol', (m) => {
      const chip = document.querySelector('.ev-chip')
      window.__ev.push({ ...m, at: performance.now(), chip: chip.classList.contains('hidden') ? '' : chip.className + ' ' + chip.textContent })
    })
    g.bus.onMsg('duel', (m) => window.__ev.push({ ...m, at: performance.now() }))
    // 실제로 화면에 뜬 자막 스타일 기록
    window.__caps = []
    const cap = document.querySelector('.cap')
    new MutationObserver(() => {
      if (cap.classList.contains('show')) window.__caps.push({ style: cap.dataset.style, text: cap.textContent })
    }).observe(cap, { attributes: true, attributeFilter: ['class'] })
  })
}
const events = (page) => page.evaluate(() => window.__ev)
async function waitEvent(page, pred, timeout, label) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const ev = await events(page)
    const hit = ev.find(pred)
    if (hit) return hit
    await sleep(60)
  }
  throw new Error(`시간 초과: ${label}`)
}

const patrolPos = (page) =>
  page.evaluate(() => {
    for (const n of window.__doas.store.npcs.values()) if (n.pub.role === 'patrol') return { id: n.pub.id, x: n.x, z: n.z }
    return null
  })

/**
 * 단속반 옆으로 가서, 단속반과 가까운 시민에게 말을 걸고 첫 멘트로 포교한다(결과를 기다리지 않고 바로 돌아온다).
 * 'more' 가 나오면 대화를 닫는다(추격 중 대화 시트에 묶이지 않게).
 */
async function pitchNearPatrol(page) {
  const p = await patrolPos(page)
  if (!p) throw new Error('단속반 NPC 가 없습니다')
  if (!(await walkPath(page, () => patrolPos(page), 4, 40000))) return 'walk-timeout'
  const target = await page.evaluate(() => {
    const g = window.__doas
    const me = g.store.me
    let pat = null
    for (const n of g.store.npcs.values()) if (n.pub.role === 'patrol') pat = n
    let best = null
    let bd = 1e9
    for (const n of g.store.npcs.values()) {
      if (n.pub.owner || n.pub.role || n.pub.model) continue
      if (pat && Math.hypot(n.x - pat.x, n.z - pat.z) > 8) continue
      const d = Math.hypot(n.x - me.x, n.z - me.z)
      if (d < bd) {
        bd = d
        best = n
      }
    }
    if (!best) return 0
    g.player.moveTo(best.x, best.z, best.pub.id)
    return best.pub.id
  })
  if (!target) return 'no-citizen'
  try {
    await page.waitForFunction(() => window.__doas.store.talk !== null, null, { timeout: 9000 })
  } catch {
    await page.evaluate(() => window.__doas.player.cancelMove())
    return 'no-talk'
  }
  const outcome = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = window.__doas
        const off = g.bus.onMsg('pitchRes', (m) => {
          if (m.p !== g.store.me.id) return
          off()
          if (m.o === 'more') setTimeout(() => g.actions.endTalk(), 50)
          resolve(m.o)
        })
        const t = g.store.talk
        if (t) g.actions.pitch(t.lines[0])
        setTimeout(() => resolve('timeout'), 6000)
      }),
  )
  return outcome
}

/** 단속반에게 들킬 때까지 포교를 반복한다(근처에 시민이 없을 수도 있으니 여러 번) */
async function provokePatrol(page, label, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const before = (await events(page)).filter((e) => e.t === 'patrol' && e.ph === 'alert').length
    const o = await pitchNearPatrol(page)
    await sleep(250)
    const ev = (await events(page)).filter((e) => e.t === 'patrol' && e.ph === 'alert')
    if (ev.length > before) return ev[ev.length - 1]
    console.log(`    · ${label}: 시도 ${i + 1} (${o}) — 아직 안 들킴`)
    await sleep(2300)
  }
  throw new Error(`${label}: 단속반에게 들키지 못함`)
}

;(async () => {
  const port = Number(process.env.E2E_PORT || 8826)
  // 라이벌이 등장할 확률을 높이려고 시민을 조금 늘린다(기본 28)
  const srv = await startServer(port, { ROOMS: '1', NPCS: '44' })
  const browser = await launch()
  const errors = []
  let failed = 0
  const skipped = []
  const check = (name, ok, detail = '') => {
    if (!ok) failed++
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  try {
    const A = await openPlayer(browser, srv.base, 'pc', 1, errors)
    await record(A.page)
    const a0 = await state(A.page)
    check('단속반 NPC 가 보인다(이름: 구청 단속반)', await A.page.evaluate(() => [...window.__doas.store.npcs.values()].some((n) => n.pub.role === 'patrol' && n.pub.name.includes('단속반'))))

    // ───────── 1) 발각 → 추격 → 훈방 ─────────
    const alert = await provokePatrol(A.page, 'A')
    check('근처에서 포교하면 alert 가 온다', alert.p === a0.id)
    const fleeBtn = A.page.locator('.hud-action[aria-label="도망가기"]')
    // 바쁜 기계에서는 화면 갱신이 늦을 수 있어 고정 대기 대신 나타날 때까지 기다린다
    await fleeBtn.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
    await shot(A.page, '1-alert-pc')
    check('쫓기는 동안 "도망가기"가 큰 상황 버튼이 된다', (await fleeBtn.count()) === 1 && (await fleeBtn.evaluate((b) => b.classList.contains('primary'))))
    const chase = await waitEvent(A.page, (e) => e.t === 'patrol' && e.ph === 'chase', 3000, 'chase')
    check('0.8초 뒤 chase', chase.at - alert.at > 500 && chase.at - alert.at < 2000, `${Math.round(chase.at - alert.at)}ms`)
    check('추격 칩이 뜬다(남은 시간 포함)', /chase.*추격.*초/.test(chase.chip), chase.chip)
    await shot(A.page, '2-chase-pc')
    // 가만히 서 있으면 잡힌다(단속반 6.3 m/s)
    const end1 = await waitEvent(A.page, (e) => e.t === 'patrol' && (e.ph === 'caught' || e.ph === 'lost'), 11000, 'caught/lost')
    if (end1.ph === 'caught') {
      await sleep(250)
      check('잡히면 훈방 오버레이가 뜬다', await A.page.locator('.ev-freeze').isVisible())
      await shot(A.page, '3-caught-pc')
      const st = await A.page.evaluate(() => ({ stun: window.__doas.store.me.stunUntil - performance.now(), ent: window.__doas.store.me.entourage }))
      check('얼어붙음(stunUntil)이 걸린다', st.stun > 1500 && st.stun <= 3100, `${Math.round(st.stun)}ms`)
      const x0 = (await state(A.page)).x
      await A.page.evaluate(() => window.__doas.player.moveTo(window.__doas.store.me.x + 4, window.__doas.store.me.z))
      await sleep(800)
      check('얼어붙은 동안은 움직이지 않는다', Math.abs((await state(A.page)).x - x0) < 0.05)
      await sleep(2600)
      check('훈방 오버레이가 사라진다', !(await A.page.locator('.ev-freeze').isVisible()))
      const s1 = await state(A.page)
      await A.page.evaluate(() => window.__doas.player.moveTo(window.__doas.store.me.x - 3, window.__doas.store.me.z + 2))
      await sleep(1500)
      const s2 = await state(A.page)
      check('풀린 뒤에는 다시 움직인다', Math.hypot(s2.x - s1.x, s2.z - s1.z) > 1, `${Math.hypot(s2.x - s1.x, s2.z - s1.z).toFixed(2)}m`)
    } else {
      // 막힌 길 등으로 잡지 못했을 수도 있다 — 실패는 아니지만 기록
      skipped.push('1차 추격이 caught 대신 lost 로 끝나 훈방 오버레이를 확인하지 못함')
      console.log('    · 1차 추격: lost')
    }
    const cooldownFrom = Date.now()

    // ───────── 2) 라이벌 기싸움(확률) ─────────
    let duelDone = false
    const duelEnd = Date.now() + 55000
    const tried = new Set()
    let attempt = 0
    while (!duelDone && Date.now() < duelEnd) {
      const rival = await A.page.evaluate((tried) => {
        const g = window.__doas
        const me = g.store.me
        let best = null
        let bd = 1e9
        for (const n of g.store.npcs.values()) {
          if (n.pub.role !== 'rival' || n.pub.owner || tried.includes(n.pub.id)) continue
          const d = Math.hypot(n.x - me.x, n.z - me.z)
          if (d < bd) {
            bd = d
            best = n
          }
        }
        return best ? best.pub.id : 0
      }, [...tried])
      if (!rival) {
        await sleep(1500)
        continue
      }
      attempt++
      const rivalPos = () =>
        A.page.evaluate((id) => {
          const v = window.__doas.store.npcs.get(id)
          return v ? { x: v.x, z: v.z } : { x: 0, z: 0 }
        }, rival)
      await walkPath(A.page, rivalPos, 3, 30000)
      await A.page.evaluate((id) => {
        const v = window.__doas.store.npcs.get(id)
        if (v) window.__doas.player.moveTo(v.x, v.z, id)
      }, rival)
      try {
        await A.page.waitForFunction(() => window.__doas.store.talk !== null, null, { timeout: 8000 })
      } catch {
        console.log(`    · 기싸움 시도 ${attempt}: 라이벌 ${rival} 에게 말 걸기 실패`)
        await A.page.evaluate(() => window.__doas.player.cancelMove())
        tried.add(rival)
        continue
      }
      tried.add(rival)
      const before = (await events(A.page)).filter((e) => e.t === 'duel' && e.ph === 'start').length
      await A.page.evaluate(() => {
        const t = window.__doas.store.talk
        if (t) window.__doas.actions.pitch(t.lines[0])
      })
      await sleep(900)
      const starts = (await events(A.page)).filter((e) => e.t === 'duel' && e.ph === 'start')
      if (starts.length === before) {
        console.log(`    · 기싸움 시도 ${attempt}: 라이벌이 역포교 대신 일반 반응(30% 확률)`)
        await A.page.evaluate(() => window.__doas.actions.endTalk())
        await sleep(2400)
        continue
      }
      const st = starts[starts.length - 1]
      check('기싸움 시트가 열린다(선택지 3개)', (await A.page.locator('.ev-duel').isVisible()) && (await A.page.locator('.ev-duel-choice').count()) === 3)
      check('기싸움 중에는 대화 시트가 닫혀 있다', (await A.page.evaluate(() => window.__doas.store.talk)) === null)
      await shot(A.page, '4-duel-pc')
      const fol0 = (await state(A.page)).fol
      // 키보드 2번 = 두 번째 선택지(이모트 단축키와 겹치지 않아야 한다)
      await A.page.keyboard.press('Digit2')
      const end = await waitEvent(A.page, (e) => e.t === 'duel' && e.ph === 'end' && e.at > st.at, 4000, 'duel end')
      await sleep(300)
      check('결과 배너가 뜬다', await A.page.locator('.ev-duel-result').isVisible(), end.win ? '승리' : '패배')
      check('키 2 가 이모트를 재생하지 않는다', (await A.page.evaluate(() => window.__doas.store.me.emote)) === null)
      await shot(A.page, '5-duel-result-pc')
      if (end.win) {
        await sleep(1300)
        check('이기면 누적 신도 +2', (await state(A.page)).fol === fol0 + 2)
      }
      duelDone = true
    }
    if (!duelDone) skipped.push('제한 시간(55초) 안에 기싸움(rival 결과)이 나오지 않아 실제 기싸움은 미실행')

    // ───────── 3) 모바일: 도망가기 버튼으로 달아나기 ─────────
    const B = await openPlayer(browser, srv.base, 'mobile', 1, errors)
    await record(B.page)
    const b0 = await state(B.page)
    const wait = 31000 - (Date.now() - cooldownFrom)
    if (wait > 0) await sleep(wait)
    const alertB = await provokePatrol(B.page, 'B')
    check('모바일: alert', alertB.p === b0.id)
    // A 화면에도 단속 소식 한 줄은 뜬다(다른 사람 추격은 크게 보여 주지 않는다)
    check('다른 사람 화면에는 추격 칩이 뜨지 않는다', !(await A.page.locator('.ev-chip.alert, .ev-chip.chase').isVisible()))
    // 호루라기(alert) 0.8초 동안이 도망칠 기회다: 바로 진짜 '도망가기' 버튼을 누르고 반대쪽으로 달린다
    const btn = B.page.locator('.hud-action[aria-label="도망가기"]')
    await btn.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
    check('모바일: 도망가기 버튼이 보인다', await btn.isVisible())
    await shot(B.page, '6-alert-mobile')
    // 상황 버튼 줄은 근처 대상이 바뀔 때 다시 그려지며 잠깐 커지는 애니메이션이 있다 → 짧게 여러 번 시도
    let sprinting = false
    for (let i = 0; i < 8 && !sprinting; i++) {
      await btn.tap({ timeout: 600 }).catch(() => {})
      await sleep(120)
      sprinting = await B.page.evaluate(() => window.__doas.store.me.sprintUntil > performance.now())
    }
    check('도망가기 버튼을 누르면 스프린트가 시작된다', sprinting)
    // 단속반 반대쪽으로 달린다
    await B.page.evaluate(() => {
      const g = window.__doas
      const me = g.store.me
      let pat = null
      for (const n of g.store.npcs.values()) if (n.pub.role === 'patrol') pat = n
      const dx = me.x - pat.x
      const dz = me.z - pat.z
      const d = Math.hypot(dx, dz) || 1
      g.player.moveTo(me.x + (dx / d) * 30, me.z + (dz / d) * 30)
    })
    const chaseB = await waitEvent(B.page, (e) => e.t === 'patrol' && (e.ph === 'chase' || e.ph === 'caught'), 3000, 'chase B')
    if (chaseB.ph === 'chase') {
      check('모바일: 추격 칩', /chase.*추격/.test(chaseB.chip), chaseB.chip)
      await shot(B.page, '7-chase-mobile')
    }
    const end2 = await waitEvent(B.page, (e) => e.t === 'patrol' && (e.ph === 'caught' || e.ph === 'lost'), 12000, 'B caught/lost')
    await sleep(250)
    if (end2.ph === 'lost') {
      check('따돌리면 "따돌렸다" 칩', (await B.page.locator('.ev-chip.lost').isVisible()))
    } else {
      await B.page.locator('.ev-freeze').waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
      check('잡히면 모바일에도 훈방 오버레이', await B.page.locator('.ev-freeze').isVisible())
    }
    await shot(B.page, `8-${end2.ph}-mobile`)
    console.log(`    · 모바일 추격 결과: ${end2.ph}`)

    // 모바일 기싸움 시트 모양(화면 전용: 로컬 이벤트로 띄우고 고르지 않고 닫는다)
    await B.page.evaluate(() => {
      const g = window.__doas
      const n = [...g.store.npcs.values()].find((v) => !v.pub.role)
      g.bus.emitMsg({ t: 'duel', ph: 'start', n: n.pub.id, say: '저는 숨만 쉬어도 기운이 모입니다. 그쪽은요?', choices: ['저도 숨은 쉽니다만…', '저는 숨을 안 쉬어도 모입니다.', '죄송합니다, 지나갈게요.'], until: g.store.serverNow() + 12000 })
    })
    await sleep(400)
    const sheetBox = await B.page.locator('.ev-duel').boundingBox()
    const vp = B.page.viewportSize()
    check('모바일: 기싸움 시트가 화면 안에 들어간다', !!sheetBox && sheetBox.x >= 0 && sheetBox.x + sheetBox.width <= vp.width && sheetBox.y >= 0 && sheetBox.y + sheetBox.height <= vp.height)
    const choiceH = await B.page.locator('.ev-duel-choice').first().evaluate((b) => b.getBoundingClientRect().height)
    check('모바일: 선택지 버튼 높이 ≥ 42px', choiceH >= 42, `${choiceH}px`)
    await shot(B.page, '9-duel-mobile(local)')
    await B.page.evaluate(() => window.__doas.bus.emitMsg({ t: 'duel', ph: 'end', n: 1, win: true, text: '수… 숨을 안 쉬고도?! 제가 졌습니다, 형님!' }))
    await sleep(300)

    // ───────── 4) 자막 3가지 스타일 ─────────
    const seen = new Set([...(await A.page.evaluate(() => window.__caps)), ...(await B.page.evaluate(() => window.__caps))].map((c) => c.style))
    console.log(`    · 실제 게임 중 뜬 자막 스타일: ${[...seen].join(', ') || '없음'}`)
    check('실제 이벤트로 자막이 떴다', seen.size > 0)
    // 스타일별 스크린숏(화면 전용: 내 포교 결과 이벤트를 로컬로 흘려 자막을 띄운다)
    const want = ['gungseo', 'pop', 'whisper']
    for (const [P, kind] of [
      [A.page, 'pc'],
      [B.page, 'mobile'],
    ]) {
      const got = new Set()
      for (let i = 0; i < 14 && got.size < 3; i++) {
        const style = await P.evaluate(
          (i) =>
            new Promise((resolve) => {
              const g = window.__doas
              const me = g.store.me
              const keys = ['no', 'ignore', 'flee']
              g.bus.emitMsg({ t: 'pitchRes', p: me.id, n: 1, l: 0, o: keys[i % 3], say: '' })
              setTimeout(() => resolve(document.querySelector('.cap').dataset.style), 700)
            }),
          i,
        )
        if (want.includes(style) && !got.has(style)) {
          got.add(style)
          await shot(P, `10-caption-${style}-${kind}`)
        }
        await sleep(1600)
      }
      check(`${kind}: 자막 3가지 스타일 모두 표시`, got.size === 3, [...got].join(','))
    }

    const real = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e))
    check('브라우저 콘솔 오류가 없다', real.length === 0, real.slice(0, 3).join(' | '))
  } catch (err) {
    failed++
    console.log('  ❌ 실행 중 예외 —', err.message)
  } finally {
    await browser.close()
    srv.stop()
  }
  for (const s of skipped) console.log('  ⚠️  ' + s)
  console.log(failed ? `[events e2e] 실패 ${failed}건` : '[events e2e] 전부 통과')
  process.exit(failed ? 1 : 0)
})()
