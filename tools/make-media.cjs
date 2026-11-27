#!/usr/bin/env node
/**
 * README/링크 미리보기/홈 화면 아이콘 이미지를 만든다. 외부 그림 파일 없이 전부 절차적으로 그린다.
 *   npm run build && node tools/make-media.cjs        → 아래 전부
 *   node tools/make-media.cjs --icons                 → 아이콘만(서버·빌드 없이, 몇 초)
 * 만드는 파일
 *   - docs/img/pc.jpg, docs/img/mobile.jpg, docs/img/certificate.png, client/public/og.jpg(1200×630): 실제 게임 화면에서
 *   - client/public/icons/icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png(180): SVG 로 그린 교주 얼굴
 */
const fs = require('node:fs')
const path = require('node:path')
const { startServer, launch, openPlayer, state, sleep, walkTo, pitchOnce } = require('../tests/e2e/lib.cjs')

const ROOT = path.resolve(__dirname, '..')
const IMG = path.join(ROOT, 'docs/img')
const ICONS = path.join(ROOT, 'client/public/icons')

/**
 * 아이콘: 노란 바탕에 '후광을 단 채 땀 흘리는 수상한 교주' 얼굴. 게임 속 주인공(놀림받는 쪽)이 아이콘의 주인공이다.
 * pad = 가장자리 여백 비율. 마스커블 아이콘은 기기가 원·물방울 등으로 잘라 내므로 가운데 80% 안에 얼굴을 넣는다.
 * 글꼴·이모지에 기대지 않는다(서버·CI 에 한글/이모지 글꼴이 없어도 같은 그림이 나오게).
 */
function iconSvg({ pad, rounded }) {
  const s = 512
  const inner = s * (1 - pad * 2)
  const k = inner / 512
  const o = s * pad
  const bg = rounded
    ? `<rect x="8" y="8" width="496" height="496" rx="112" fill="#ffd23f" stroke="#241b35" stroke-width="16"/>`
    : `<rect width="512" height="512" fill="#ffd23f"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  ${bg}
  <g transform="translate(${o} ${o}) scale(${k})">
    <circle cx="256" cy="282" r="210" fill="#ffe680"/>
    <ellipse cx="256" cy="92" rx="120" ry="34" fill="none" stroke="#fff7d6" stroke-width="22"/>
    <ellipse cx="256" cy="92" rx="120" ry="34" fill="none" stroke="#241b35" stroke-width="6" opacity=".35"/>
    <path d="M118 300 L150 182 L256 140 L362 182 L394 300 L352 400 L256 436 L160 400 Z" fill="#ffd9b0" stroke="#241b35" stroke-width="16" stroke-linejoin="round"/>
    <path d="M150 182 L256 140 L362 182 L346 214 L256 190 L166 214 Z" fill="#241b35"/>
    <path d="M178 286 Q206 262 234 286" fill="none" stroke="#241b35" stroke-width="14" stroke-linecap="round"/>
    <path d="M278 286 Q306 262 334 286" fill="none" stroke="#241b35" stroke-width="14" stroke-linecap="round"/>
    <ellipse cx="184" cy="330" rx="26" ry="15" fill="#ff8fa3" opacity=".8"/>
    <ellipse cx="328" cy="330" rx="26" ry="15" fill="#ff8fa3" opacity=".8"/>
    <path d="M206 356 Q256 396 306 356" fill="none" stroke="#241b35" stroke-width="14" stroke-linecap="round"/>
    <path d="M372 214 Q392 250 372 268 Q352 250 372 214 Z" fill="#8fd0f2" stroke="#241b35" stroke-width="8" stroke-linejoin="round"/>
  </g>
</svg>`
}

async function makeIcons(browser) {
  fs.mkdirSync(ICONS, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const shots = [
    // 일반 아이콘: 둥근 모서리 + 테두리(투명 바깥)
    { file: 'icon-192.png', size: 192, pad: 0.06, rounded: true, transparent: true },
    { file: 'icon-512.png', size: 512, pad: 0.06, rounded: true, transparent: true },
    // 마스커블: 바탕이 끝까지 차고 그림은 안전 영역(가운데 80%) 안
    { file: 'maskable-512.png', size: 512, pad: 0.14, rounded: false, transparent: false },
    // iOS 는 투명을 검게 칠하고 모서리를 알아서 둥글린다 → 꽉 찬 바탕
    { file: 'apple-touch-icon.png', size: 180, pad: 0.08, rounded: false, transparent: false },
  ]
  for (const sh of shots) {
    await page.setViewportSize({ width: sh.size, height: sh.size })
    const svg = iconSvg(sh).replace('width="512" height="512"', `width="${sh.size}" height="${sh.size}"`)
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`)
    await page.screenshot({ path: path.join(ICONS, sh.file), omitBackground: sh.transparent, clip: { x: 0, y: 0, width: sh.size, height: sh.size } })
  }
  await ctx.close()
  console.log('만든 아이콘:', shots.map((s) => `client/public/icons/${s.file}`).join(', '))
}

;(async () => {
  if (process.argv.includes('--icons')) {
    const browser = await launch()
    try {
      await makeIcons(browser)
    } finally {
      await browser.close()
    }
    return
  }
  fs.mkdirSync(IMG, { recursive: true })
  const srv = await startServer(Number(process.env.MEDIA_PORT || 8893))
  const browser = await launch()
  const errors = []
  try {
    const A = await openPlayer(browser, srv.base, 'pc', 1, errors)
    const B = await openPlayer(browser, srv.base, 'mobile', 1, errors)
    // 안내 힌트는 사진에 넣지 않는다
    for (const p of [A.page, B.page]) await p.locator('.tutorial-skip').click({ timeout: 3000 }).catch(() => {})
    // A: 교단을 만들고 신도를 몇 명 모은다
    await A.page.evaluate(() => window.__doas.net.send({ t: 'cultCreate', name: '라면교', color: 1, emblem: 0, title: '면장' }))
    for (let i = 0; i < 12; i++) {
      const s = await state(A.page)
      if (s.entourage >= 3) break
      await pitchOnce(A.page)
    }
    // 광장 한복판으로 가서 춤(신도들이 따라 춘다)
    await walkTo(A.page, -4.5, -16.5, 1.2).catch(() => {})
    await walkTo(B.page, -1.5, -14.5, 1.2).catch(() => {})
    await A.page.evaluate(() => {
      const g = window.__doas
      g.rig.yaw = Math.PI * 0.86
      g.rig.pitch = 0.5
      g.rig.dist = 11
      g.actions.emote('dance')
    })
    await B.page.evaluate(() => window.__doas.actions.emote('wave'))
    await sleep(2600)
    await A.page.screenshot({ path: path.join(IMG, 'pc.jpg'), type: 'jpeg', quality: 86 })
    const shot = (await A.page.screenshot({ type: 'jpeg', quality: 90 })).toString('base64')
    await B.page.evaluate(() => {
      const g = window.__doas
      g.rig.pitch = 0.5
      g.rig.dist = 10
    })
    await sleep(600)
    await B.page.screenshot({ path: path.join(IMG, 'mobile.jpg'), type: 'jpeg', quality: 86 })

    // 임명장: 실제 메뉴 → 패널 → 저장
    await A.page.locator('.hud-menu-btn, button[aria-label="메뉴"]').first().click()
    await A.page.locator('button', { hasText: '임명장' }).first().click()
    await A.page.locator('.panel').waitFor({ state: 'visible', timeout: 4000 })
    await sleep(900)
    const [dl] = await Promise.all([A.page.waitForEvent('download', { timeout: 8000 }), A.page.locator('button', { hasText: '이미지 저장' }).first().click()])
    await dl.saveAs(path.join(IMG, 'certificate.png'))

    // 링크 미리보기(1200×630): 게임 화면 위에 제목을 얹는다
    const og = await (await browser.newContext({ viewport: { width: 1200, height: 630 } })).newPage()
    await og.setContent(`<!doctype html><html lang="ko"><body style="margin:0;width:1200px;height:630px;overflow:hidden;font-family:'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif">
      <img src="data:image/jpeg;base64,${shot}" style="position:absolute;inset:0;width:1200px;height:675px;object-fit:cover;filter:saturate(1.08)">
      <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(36,27,53,.82) 0%,rgba(36,27,53,.55) 46%,rgba(36,27,53,0) 78%)"></div>
      <div style="position:absolute;left:64px;top:150px;color:#fff">
        <div style="display:inline-block;padding:6px 18px;border:4px solid #241b35;border-radius:999px;background:#ffd23f;color:#241b35;font-weight:900;font-size:26px">교주 시뮬레이터</div>
        <div style="margin-top:18px;font-size:92px;font-weight:900;line-height:1.05;text-shadow:0 6px 0 #241b35">도를<br>아십니까?</div>
        <div style="margin-top:22px;font-size:32px;font-weight:800">(모르셔도 됩니다)</div>
        <div style="margin-top:14px;font-size:24px;font-weight:700;opacity:.92">가입 없이 바로 접속 · 전부 허구인 풍자 게임</div>
      </div></body></html>`)
    await sleep(300)
    await og.screenshot({ path: path.join(ROOT, 'client/public/og.jpg'), type: 'jpeg', quality: 84 })
    console.log('만든 파일:', fs.readdirSync(IMG).join(', '), '+ client/public/og.jpg', errors.length ? `(페이지 오류 ${errors.length}건)` : '')
    await makeIcons(browser)
  } finally {
    await browser.close()
    srv.stop()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
