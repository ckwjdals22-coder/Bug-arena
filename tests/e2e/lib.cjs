/**
 * E2E 공용 도우미: 서버 띄우기, 브라우저 컨텍스트 만들기, 게임 상태 조회, 대기.
 * 기능별 스크립트(battle.cjs 등)가 가져다 쓴다. Playwright 는 전역 설치본을 쓴다.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(__dirname, 'out')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startServer(port, env = {}) {
  const entry = path.join(ROOT, 'dist/server/main.js')
  if (!fs.existsSync(entry)) throw new Error('dist/server/main.js 가 없습니다. 먼저 npm run build 를 실행하세요.')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doas-e2e-'))
  const proc = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ROOMS: '3', ROOM_CAPACITY: '20', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d))
  const base = `http://localhost:${port}`
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.ok) return { proc, base, dataDir, stop: () => proc.kill('SIGTERM') }
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(200)
  }
  proc.kill('SIGTERM')
  throw new Error('서버가 뜨지 않았습니다')
}

async function launch() {
  fs.mkdirSync(OUT, { recursive: true })
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
}

/** kind: 'pc' | 'mobile' */
async function openPlayer(browser, base, kind, room, errors, query = '') {
  const context = await browser.newContext(kind === 'mobile' ? { ...devices['iPhone 13'] } : { viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${kind} exception: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${kind} console.error: ${m.text()}`)
  })
  await page.goto(`${base}/?room=${room}${query}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__doas && window.__doas.store.phase === 'playing' && window.__doas.store.me, null, { timeout: 25000 })
  return { context, page }
}

function state(page) {
  return page.evaluate(() => {
    const g = window.__doas
    const s = g.store
    const me = s.me
    return {
      phase: s.phase,
      id: me.id,
      x: me.x,
      z: me.z,
      name: s.profile.name,
      fol: me.prog.fol,
      inf: me.prog.inf,
      coins: me.prog.coins,
      rank: me.prog.rank,
      entourage: me.entourage,
      cult: me.prog.cult,
      ach: me.prog.ach,
      near: s.near,
      battles: s.battles,
      sermon: s.sermon,
      players: [...s.players.values()].map((p) => ({ id: p.pub.id, name: p.pub.name, x: p.x, z: p.z, cult: p.pub.cult, tag: p.pub.tag, emote: p.emote })),
    }
  })
}

async function waitState(page, pred, timeout = 10000, label = 'condition') {
  const end = Date.now() + timeout
  let last = null
  while (Date.now() < end) {
    last = await state(page)
    if (pred(last)) return last
    await sleep(120)
  }
  throw new Error(`시간 초과: ${label}`)
}

/** (x,z) 근처까지 걸어간다(서버가 속도를 검증하므로 순간이동은 없다) */
async function walkTo(page, x, z, reach = 1.2, timeout = 40000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const d = await page.evaluate(
      ([tx, tz]) => {
        const g = window.__doas
        const me = g.store.me
        const dist = Math.hypot(me.x - tx, me.z - tz)
        if (!g.player.target) g.player.moveTo(tx, tz)
        return dist
      },
      [x, z],
    )
    if (d <= reach) {
      await page.evaluate(() => window.__doas.player.cancelMove())
      return
    }
    await sleep(300)
  }
  throw new Error(`walkTo(${x}, ${z}) 시간 초과`)
}

/** 다른 플레이어 옆으로 걸어간다 */
async function walkToPlayer(page, otherPage, gap = 1.6) {
  for (let i = 0; i < 80; i++) {
    const o = await state(otherPage)
    const d = await page.evaluate(
      ([ox, oz, g]) => {
        const s = window.__doas
        const me = s.store.me
        const dist = Math.hypot(me.x - ox, me.z - oz)
        if (dist > g && !s.player.target) s.player.moveTo(ox + 0.9, oz + 0.6)
        return dist
      },
      [o.x, o.z, gap],
    )
    if (d <= gap) {
      await page.evaluate(() => window.__doas.player.cancelMove())
      return
    }
    await sleep(300)
  }
  throw new Error('walkToPlayer 시간 초과')
}

/**
 * 가까운 시민에게 걸어가 말을 걸고 첫 멘트를 고른다. 결과 종류를 돌려준다(시민이 없으면 null).
 * 확률 게임이므로 원하는 결과가 나올 때까지 여러 번 부르는 식으로 쓴다.
 */
async function pitchOnce(page) {
  const ok = await page.evaluate(() => {
    const g = window.__doas
    const me = g.store.me
    let best = null
    let bd = 1e9
    for (const n of g.store.npcs.values()) {
      if (n.pub.owner || n.pub.role || n.pub.model) continue
      const d = Math.hypot(n.x - me.x, n.z - me.z)
      if (d < bd) {
        bd = d
        best = n
      }
    }
    if (!best) return false
    g.player.moveTo(best.x, best.z, best.pub.id)
    return true
  })
  if (!ok) return null
  try {
    await page.waitForFunction(() => window.__doas.store.talk !== null, null, { timeout: 12000 })
  } catch {
    return 'none'
  }
  let outcome = 'none'
  for (let round = 0; round < 2; round++) {
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
    const sent = await page.evaluate(() => {
      const t = window.__doas.store.talk
      if (!t || t.waiting) return false
      window.__doas.actions.pitch(t.lines[0])
      return true
    })
    if (!sent) break
    outcome = await res
    if (outcome !== 'more') break
    await sleep(700)
  }
  await sleep(2400)
  return outcome
}

module.exports = { ROOT, OUT, sleep, startServer, launch, openPlayer, state, waitState, walkTo, walkToPlayer, pitchOnce, devices }
