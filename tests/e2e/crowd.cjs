/**
 * 붐비는 방 E2E: 부하 테스트 봇 16명 + 브라우저 1명이 한 방에 있을 때
 *   - 시민이 접속자 수만큼 늘어나고(출입구에서 걸어 들어오고)
 *   - 봇이 나간 뒤에는 줄어들며(출구까지 걸어가서 사라지고, 화면에서도 지워지고)
 *   - 브라우저 오류가 없는지 본다. 광장 스크린샷을 남긴다.
 *
 *   npm run build && E2E_PORT=9031 node tests/e2e/crowd.cjs
 * 약 4분 걸린다(인구가 줄기 전 유예 60초 + 한 명씩 내보내는 시간).
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const { ROOT, OUT, sleep, startServer, launch, openPlayer } = require('./lib.cjs')

const PORT = Number(process.env.E2E_PORT || 9031)
const BOTS = Number(process.env.CROWD_BOTS || 16)
// shared/world 의 출구 노드(지하철·길 끝). 맵이 바뀌면 같이 고친다
const EXITS = [
  [-46, -8.2],
  [46, -8.2],
  [-46, 7.4],
  [46, 7.4],
  [-17.6, -13],
]
const nearExit = (x, z) => Math.min(...EXITS.map(([ex, ez]) => Math.hypot(ex - x, ez - z)))

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  const srv = await startServer(PORT)
  const errors = []
  const browser = await launch()
  let bots = null
  try {
    const { page } = await openPlayer(browser, srv.base, 'pc', 1, errors)
    // 브라우저 안에서 시민의 등장/퇴장을 기록한다(처음 보인 자리, 마지막 자리)
    await page.evaluate(() => {
      const g = window.__doas
      const log = { first: {}, last: {}, gone: [], spawn: 0, max: g.store.npcs.size, min: g.store.npcs.size }
      window.__crowd = log
      for (const [id, v] of g.store.npcs) log.first[id] = null
      g.bus.onMsg('npcSpawn', (m) => {
        log.spawn++
        log.first[m.n.id] = [m.n.x, m.n.z]
      })
      g.bus.onMsg('npcGone', (m) => {
        log.gone.push({ id: m.n, at: log.last[m.n] || null, still: g.store.npcs.has(m.n) })
      })
      setInterval(() => {
        for (const [id, v] of g.store.npcs) log.last[id] = [v.x, v.z]
        log.max = Math.max(log.max, g.store.npcs.size)
        log.min = Math.min(log.min, g.store.npcs.size)
      }, 100)
    })
    const n0 = await page.evaluate(() => window.__doas.store.npcs.size)

    bots = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'tools/loadtest.ts', '--url', `ws://localhost:${PORT}`, '--rooms', '1', '--bots', String(BOTS), '--seconds', '70', '--ramp', '4'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let report = ''
    bots.stdout.on('data', (d) => (report += d))
    await sleep(45_000)
    const peak = await page.evaluate(() => window.__doas.store.npcs.size)
    const players = await page.evaluate(() => window.__doas.store.players.size + 1)
    const want = Math.min(52, Math.max(28, 20 + Math.round(1.6 * players)))
    check(peak > n0 + 10, '접속자가 늘면 시민도 늘어난다', `처음 ${n0 - 1}+특수 → 지금 ${peak}명(접속자 ${players}명, 목표 시민 ${want}명)`)
    // 광장으로 걸어가 보지 않고, 카메라가 보는 화면 그대로 찍는다
    await page.screenshot({ path: path.join(OUT, 'crowd-peak.png') })
    const firsts = await page.evaluate(() => Object.values(window.__crowd.first).filter(Boolean))
    const fromExit = firsts.filter(([x, z]) => nearExit(x, z) < 3).length
    check(firsts.length > 0 && fromExit === firsts.length, '새 시민은 출입구에서 등장한다', `${fromExit}/${firsts.length}명이 출구 3m 안에서 처음 보임`)

    await new Promise((r) => bots.on('exit', r))
    const m = report.match(/"stunCorrections": (\d+)/)
    const pc = report.match(/"posCorrections": (\d+)/)
    console.log(`  [loadtest] posCorrections ${pc ? pc[1] : '?'} · stunCorrections ${m ? m[1] : '?'}`)
    bots = null
    // 봇이 다 나갔다 → 60초 유예 뒤 한 명씩 출구로 나간다
    await sleep(150_000)
    const log = await page.evaluate(() => window.__crowd)
    const end = await page.evaluate(() => window.__doas.store.npcs.size)
    check(log.gone.length > 0 && end < peak, '사람이 빠지면 시민도 줄어든다', `최대 ${log.max} → 지금 ${end}명, 퇴장 알림 ${log.gone.length}건`)
    const atExit = log.gone.filter((g) => g.at && nearExit(g.at[0], g.at[1]) < 4).length
    check(atExit >= Math.ceil(log.gone.length * 0.9), '빠지는 시민은 출구까지 걸어가서 사라진다(그 자리에서 뿅 하고 사라지지 않음)', `${atExit}/${log.gone.length}명이 출구 4m 안에서 사라짐`)
    check(log.gone.every((g) => !g.still), '빠진 시민은 화면 목록에서 지워진다')
    const ids = await page.evaluate(() => [...window.__doas.store.npcs.keys()])
    const dupes = ids.length - new Set(ids).size
    check(dupes === 0, '남은 시민 id 가 겹치지 않는다')
    await page.screenshot({ path: path.join(OUT, 'crowd-after.png') })
    check(errors.length === 0, '브라우저 오류 없음', errors.slice(0, 3).join(' | '))
  } finally {
    if (bots) bots.kill('SIGTERM')
    await browser.close()
    srv.stop()
  }
  console.log(`\n[crowd e2e] ${pass}/${pass + fail} 통과, 스크린샷: ${path.join(OUT, 'crowd-peak.png')}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
