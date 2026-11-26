#!/usr/bin/env node
/**
 * 헤드리스 Chromium 으로 페이지를 열어 스크린샷을 찍는 개발 도구.
 *   node tools/shot.cjs --url http://localhost:5173/ --out /tmp/a.png [--w 1280 --h 720] [--mobile] [--wait 1500]
 *                       [--eval "<페이지에서 실행할 JS>"] [--eval2 "<찍기 직전 실행할 JS>"] [--keys "w:800,d:400"] [--full]
 * 페이지 콘솔 오류/예외를 표준 출력에 적는다. Playwright 는 전역 설치본을 쓴다(playwright install 금지).
 */
const { chromium, devices } = require('playwright')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

;(async () => {
  const url = arg('url')
  const out = arg('out')
  if (!url || !out) {
    console.error('usage: node tools/shot.cjs --url <url> --out <png> [--w 1280 --h 720] [--mobile] [--wait 1500] [--eval js] [--keys "w:800"]')
    process.exit(2)
  }
  const mobile = !!arg('mobile', false)
  const wait = Number(arg('wait', 1500))
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const context = mobile
    ? await browser.newContext({ ...devices['iPhone 13'] })
    : await browser.newContext({ viewport: { width: Number(arg('w', 1280)), height: Number(arg('h', 720)) }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  let errors = 0
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      if (m.type() === 'error') errors++
      console.log(`[page ${m.type()}] ${m.text()}`)
    }
  })
  page.on('pageerror', (e) => {
    errors++
    console.log(`[page exception] ${e.message}`)
  })
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  const ev = arg('eval')
  if (typeof ev === 'string') {
    try {
      const r = await page.evaluate(ev)
      if (r !== undefined) console.log('[eval]', JSON.stringify(r))
    } catch (e) {
      console.log('[eval error]', e.message)
    }
  }
  const keys = arg('keys')
  if (typeof keys === 'string') {
    for (const part of keys.split(',')) {
      const [k, ms] = part.split(':')
      await page.keyboard.down(k)
      await page.waitForTimeout(Number(ms || 300))
      await page.keyboard.up(k)
    }
  }
  await page.waitForTimeout(wait)
  const ev2 = arg('eval2')
  if (typeof ev2 === 'string') {
    try {
      const r = await page.evaluate(ev2)
      if (r !== undefined) console.log('[eval2]', JSON.stringify(r))
    } catch (e) {
      console.log('[eval2 error]', e.message)
    }
  }
  await page.screenshot({ path: out, fullPage: !!arg('full', false) })
  console.log(`saved ${out} (${errors} page errors)`)
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
