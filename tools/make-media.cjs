#!/usr/bin/env node
/**
 * README/링크 미리보기용 이미지를 실제 게임 화면에서 뽑는다.
 *   npm run build && node tools/make-media.cjs
 * 만드는 파일: docs/img/pc.jpg, docs/img/mobile.jpg, docs/img/certificate.png, client/public/og.jpg(1200×630)
 */
const fs = require('node:fs')
const path = require('node:path')
const { startServer, launch, openPlayer, state, sleep, walkTo, pitchOnce } = require('../tests/e2e/lib.cjs')

const ROOT = path.resolve(__dirname, '..')
const IMG = path.join(ROOT, 'docs/img')

;(async () => {
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
  } finally {
    await browser.close()
    srv.stop()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
