/**
 * 임명장·공유 패널: 교주 임명장 / 오늘의 포교 결산 / 거절 짤 이미지를 만들어 저장·공유한다.
 *
 * 왜 이렇게 만들었나:
 * - 카드는 "열 때만" 그린다(1080×1920 캔버스는 무겁다). 그린 결과는 Blob → object URL <img> 로 보여 줘서
 *   인앱 브라우저에서도 길게 눌러 저장할 수 있게 한다(조사 02 §5.5). 바꿀 때마다 이전 URL 은 revoke 한다.
 * - 공유 버튼은 사용자 제스처 안에서 곧바로 navigator.share 를 불러야 해서, Blob 을 미리 만들어 둔다.
 *   파일 공유가 안 되는 브라우저에서는 버튼을 숨기고 "길게 눌러 저장" 안내만 보인다. 자동 게시·권한 요청은 없다.
 * - 결산 카드는 이번 접속에서 처음 입장했을 때의 통계를 기억해 두고 그 차이로 계산한다(서버 변경 없음).
 * - 거절 짤은 WebGL 캔버스를 render() 직후 같은 작업 안에서 drawImage 로 복사한다
 *   (preserveDrawingBuffer 가 꺼져 있어도 같은 태스크 안에서는 그림이 남아 있다).
 */
import './certificate.css'
import { ACHIEVEMENTS } from '../../../shared/content/achievements'
import type { SPitchRes } from '../../../shared/protocol'
import type { AppContext } from '../core/contracts'
import { judge, sessionDiff, shareLine, type SessionNumbers, type ShareProfile } from '../share/data'
import { CARD_SIZE, canvasToBlob, cardFileName, renderCard, type CardType, type MemeInput } from '../share/index'
import { placeholderPortrait } from '../share/kit'
import { playSfx, rankName } from './hud'
import { h } from './kit'

const SNAP_MS = 6000
const SUMMARY_HINT_MS = 5 * 60 * 1000
const SHARE_HINT = '이미지를 길게 눌러 저장한 뒤 스토리에 올려 보세요'

const TABS: readonly { type: CardType; label: string }[] = [
  { type: 'certificate', label: '📜 임명장' },
  { type: 'summary', label: '📊 오늘의 결산' },
  { type: 'meme', label: '📸 거절 짤' },
]

/** 거절 결과(짤 자막으로 쓸 것) */
const REJECT = new Set(['no', 'flee', 'ignore'])

export function mountCertificate(ctx: AppContext): void {
  const { store, bus, ui } = ctx

  // ───────── 세션 기록 ─────────
  let sessionStart: Record<string, number> | null = null
  let playStart = 0
  let curFail = 0
  let worstFail = 0
  let summarySeen = false
  let lastReject: { line: string; who: string; kind: string } | null = null
  /** 마지막으로 찍어 둔 게임 화면(정사각형) */
  let lastShot: HTMLCanvasElement | null = null
  let pendingTab: CardType = 'certificate'

  bus.on('entered', () => {
    // 재접속·방 이동 때도 entered 가 다시 오지만, "오늘의 결산"은 페이지를 연 뒤 첫 입장부터 센다
    if (!sessionStart && store.me) {
      sessionStart = { ...store.me.prog.stats }
      playStart = performance.now()
    }
  })

  bus.onMsg('pitchRes', (msg: SPitchRes) => {
    const me = store.me
    if (!me || msg.p !== me.id) return
    if (REJECT.has(msg.o)) {
      curFail++
      worstFail = Math.max(worstFail, curFail)
      const who = store.npcs.get(msg.n)?.pub.name ?? ''
      lastReject = { line: String(msg.say ?? '').slice(0, 120), who: who.slice(0, 20), kind: msg.o }
      showSnap()
    } else if (msg.o === 'join' || msg.o === 'king') {
      curFail = 0
    }
  })

  function session(): SessionNumbers {
    const now = store.me?.prog.stats ?? {}
    const mins = playStart ? (performance.now() - playStart) / 60000 : 0
    return sessionDiff(sessionStart ?? now, now, worstFail, mins)
  }

  function profile(): ShareProfile | null {
    const me = store.me
    if (!me) return null
    const p = me.prog
    const tag = p.tag ? (ACHIEVEMENTS.find((a) => a.id === p.tag)?.name ?? '') : ''
    return {
      pid: p.pid,
      name: store.profile.name,
      look: store.profile.look,
      rank: p.rank,
      fol: p.fol,
      inf: p.inf,
      coins: p.coins,
      cult: p.cult,
      stats: p.stats,
      tagName: tag,
    }
  }

  // ───────── 화면 캡처 ─────────
  /** 지금 게임 화면을 정사각형으로 잘라 복사한다. 실패하면 null */
  function capture(): HTMLCanvasElement | null {
    try {
      const src = ctx.engine.canvas
      // 렌더 직후 같은 작업 안에서 복사해야 WebGL 버퍼가 비워지기 전의 그림을 얻는다
      ctx.engine.render()
      const sw = src.width
      const sh = src.height
      if (sw < 2 || sh < 2) return null
      const side = Math.min(sw, sh)
      const out = document.createElement('canvas')
      out.width = out.height = Math.min(side, CARD_SIZE.meme.w)
      const g = out.getContext('2d')
      if (!g) return null
      g.drawImage(src, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, out.width, out.height)
      return out
    } catch (err) {
      console.warn('[certificate] capture failed', err)
      return null
    }
  }

  // ───────── 거절 직후 "📸 짤 저장" 버튼 ─────────
  const snapBtn = h(
    'button.cert-snap.hidden',
    {
      type: 'button',
      'aria-label': '방금 거절당한 장면을 짤로 저장',
      onclick: () => {
        playSfx(ctx, 'click')
        lastShot = capture()
        hideSnap()
        openTab('meme')
      },
    },
    h('span.cert-snap-icon', '📸'),
    h('span', '짤 저장'),
  )
  ui.root.append(snapBtn)
  let snapTimer = 0
  function showSnap(): void {
    if (store.phase !== 'playing') return
    snapBtn.classList.remove('hidden', 'out')
    // 애니메이션을 다시 재생
    void snapBtn.offsetWidth
    snapBtn.classList.add('in')
    clearTimeout(snapTimer)
    snapTimer = window.setTimeout(hideSnap, SNAP_MS)
  }
  function hideSnap(): void {
    clearTimeout(snapTimer)
    snapBtn.classList.add('hidden')
    snapBtn.classList.remove('in')
  }
  bus.on('phase', (ph) => {
    if (ph !== 'playing') hideSnap()
  })

  // ───────── 승급 토스트(행동 버튼) ─────────
  bus.on('rankUp', (rank) => {
    // 승급 연출(system 모듈)과 겹치지 않게 조금 늦게 띄운다
    window.setTimeout(() => rankToast(rank), 1600)
  })
  function rankToast(rank: number): void {
    const box = ui.root.querySelector('.toasts')
    if (!box) return
    const el = h(
      'div.toast.gold.cert-toast',
      h('span', `🎉 ${rankName(rank)} 승급!`),
      h(
        'button.btn.sm.cert-toast-btn',
        {
          type: 'button',
          onclick: () => {
            playSfx(ctx, 'click')
            el.remove()
            openTab('certificate')
          },
        },
        '📜 임명장 받기',
      ),
    )
    box.append(el)
    window.setTimeout(() => el.classList.add('out'), 7000)
    window.setTimeout(() => el.remove(), 7400)
  }

  // ───────── 메뉴 ─────────
  const summaryHint = (): boolean =>
    store.phase === 'playing' && !summarySeen && playStart > 0 && performance.now() - playStart >= SUMMARY_HINT_MS
  ui.addMenuItem({
    id: 'certificate',
    icon: '📜',
    label: '임명장·공유',
    order: 35,
    badge: summaryHint,
    onClick: () => openTab(summaryHint() ? 'summary' : 'certificate'),
  })

  function openTab(type: CardType): void {
    pendingTab = type
    ui.openPanel('certificate')
  }

  // ───────── 패널 ─────────
  ui.registerPanel({
    id: 'certificate',
    title: '임명장 · 공유',
    render(body) {
      let type: CardType = pendingTab
      let url = ''
      let blob: Blob | null = null
      let seq = 0
      let closed = false

      const tabs = h('div.tabs.cert-tabs', { role: 'tablist' })
      const tabBtns = new Map<CardType, HTMLButtonElement>()
      for (const t of TABS) {
        const b = h('button.tab', { type: 'button', role: 'tab', dataset: { type: t.type }, onclick: () => select(t.type) }, t.label)
        tabBtns.set(t.type, b)
        tabs.append(b)
      }
      const img = h('img.cert-img', { alt: '공유 카드 미리보기', draggable: true })
      const loading = h('div.cert-loading', '그리는 중…')
      const frame = h('div.cert-frame', img, loading)
      const caption = h('p.small.muted.center.cert-caption')
      const saveBtn = h('button.btn.primary.cert-save', { type: 'button', onclick: save }, '⬇️ 이미지 저장')
      const shareBtn = h('button.btn.purple.cert-share.hidden', { type: 'button', onclick: share }, '📤 공유하기')
      const retakeBtn = h('button.btn.sm.cert-retake.hidden', { type: 'button', onclick: retake }, '📸 지금 화면으로 다시 찍기')
      const hint = h('p.small.muted.center.cert-hint', SHARE_HINT)
      body.append(tabs, frame, caption, h('div.row.cert-actions', saveBtn, shareBtn), retakeBtn, hint)

      const canShareFiles = (() => {
        try {
          const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
          if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
          const probe = new File([new Uint8Array([137, 80, 78, 71])], 'probe.png', { type: 'image/png' })
          return nav.canShare({ files: [probe] })
        } catch {
          return false
        }
      })()
      shareBtn.classList.toggle('hidden', !canShareFiles)
      // 파일 공유가 되는 기기에서는 안내를 조금 다르게(공유 시트가 안 떠도 저장은 가능)
      hint.textContent = canShareFiles ? '공유하기를 누르면 휴대폰 공유 창이 열려요. 안 되면 이미지를 길게 눌러 저장!' : SHARE_HINT

      function setUrl(next: string): void {
        if (url) URL.revokeObjectURL(url)
        url = next
      }

      async function draw(): Promise<void> {
        const my = ++seq
        const prof = profile()
        saveBtn.disabled = true
        shareBtn.disabled = true
        loading.classList.remove('hidden')
        if (!prof) {
          loading.textContent = '게임에 들어가면 만들 수 있어요.'
          return
        }
        loading.textContent = '그리는 중…'
        try {
          // 시스템 글꼴이 준비되기 전에 그리면 기본 글꼴로 찍힌다
          await (document.fonts?.ready ?? Promise.resolve())
        } catch {
          /* 무시 */
        }
        if (closed || my !== seq) return
        if (type === 'meme' && !lastShot) lastShot = capture()
        let portrait: HTMLCanvasElement | null = null
        if (type !== 'meme') {
          try {
            portrait = ctx.chars.portrait(prof.look, 640)
          } catch {
            portrait = placeholderPortrait(640)
          }
        }
        const meme: MemeInput = { shot: lastShot, line: lastReject?.line ?? '', who: lastReject?.who ?? '', kind: lastReject?.kind ?? 'no' }
        let canvas: HTMLCanvasElement
        try {
          canvas = renderCard({ type, profile: prof, session: session(), portrait, meme, env: { host: location.host, date: new Date() } })
        } catch (err) {
          console.error('[certificate] render failed', err)
          loading.textContent = '이미지를 만들지 못했어요.'
          return
        }
        const b = await canvasToBlob(canvas)
        if (closed || my !== seq) return
        if (!b) {
          loading.textContent = '이 브라우저에서는 이미지를 만들 수 없어요.'
          return
        }
        blob = b
        setUrl(URL.createObjectURL(b))
        img.src = url
        img.dataset.type = type
        loading.classList.add('hidden')
        saveBtn.disabled = false
        shareBtn.disabled = false
      }

      function select(t: CardType): void {
        type = t
        pendingTab = t
        for (const [k, b] of tabBtns) {
          b.classList.toggle('on', k === t)
          b.setAttribute('aria-selected', String(k === t))
        }
        frame.classList.toggle('square', t === 'meme')
        retakeBtn.classList.toggle('hidden', t !== 'meme')
        if (t === 'summary') summarySeen = true
        caption.textContent = captionFor(t)
        blob = null
        void draw()
      }

      function captionFor(t: CardType): string {
        if (t === 'certificate') return '직급·신도 수·굴욕 기록이 담긴 (효력 없는) 임명장'
        if (t === 'summary') {
          const v = judge(session())
          return `이번 접속 기록으로 뽑은 교주 유형: ${v.icon} ${v.name}`
        }
        return lastReject ? '마지막으로 들은 거절 대사를 예능 자막으로' : '아직 거절당한 적이 없어요. 지금 화면으로 찍어요'
      }

      function save(): void {
        if (!url) return
        playSfx(ctx, 'click')
        const a = h('a', { href: url, download: cardFileName(type, new Date()) })
        a.style.display = 'none'
        document.body.append(a)
        a.click()
        a.remove()
        ui.toast('이미지를 저장했어요 (효력은 없습니다)', 'good')
      }

      function share(): void {
        if (!blob) return
        playSfx(ctx, 'click')
        const me = store.me
        const file = new File([blob], cardFileName(type, new Date()), { type: 'image/png' })
        const link = location.origin + '/'
        const text = `${shareLine(type, rankName(me?.prog.rank ?? 0), judge(session()))}\n${link}`
        const data: ShareData = { files: [file], title: '도를 아십니까? — 교주 시뮬레이터', text }
        // 제스처가 만료되지 않게 기다리는 일 없이 곧바로 부른다
        navigator.share(data).catch((err: unknown) => {
          if ((err as DOMException)?.name === 'AbortError') return
          ui.toast(SHARE_HINT, 'info', 3600)
        })
      }

      function retake(): void {
        playSfx(ctx, 'click')
        lastShot = capture()
        void draw()
      }

      select(type)
      return () => {
        closed = true
        seq++
        setUrl('')
        img.removeAttribute('src')
        blob = null
      }
    },
  })
}
