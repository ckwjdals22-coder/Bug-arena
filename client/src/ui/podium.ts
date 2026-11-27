/**
 * 단상 UI: 오늘의 계시(상황 버튼 + 예능 자막) · 집단 설교(상단 배너, 구호 자막, 큰 응답 버튼, 결과 카드).
 *
 * 설계 메모
 *  - 판정은 전부 서버가 한다. 여기서는 서버 메시지를 보여 주고, 버튼을 누르면 의사만 보낸다.
 *  - 자막/배너/결과 카드는 pointer-events 를 받지 않는다(응답 버튼만 받는다) → 연출 중에도 이동·포교가 막히지 않는다.
 *  - 응답 버튼은 오른손 엄지가 닿는 오른쪽 아래(상황 버튼 바로 위)에 둔다. 왼쪽 아래는 조이스틱 자리다.
 *  - 서버 시각(until/endsAt)은 store.serverNow() 와의 차이로 바꿔 performance.now() 기준으로만 센다.
 */
import './podium.css'
import { PROPHECY_COOLDOWN_MS, SERMON_ROOM_COOLDOWN_MS } from '../../../shared/constants'
import type { SSermon } from '../../../shared/protocol'
import { WORLD } from '../../../shared/world'
import type { AppContext } from '../core/contracts'
import { isTyping, playSfx } from './hud'
import { h } from './kit'

/** 계시 자막이 보이는 거리 */
const CAPTION_RANGE = 25
const CAPTION_MS = 3500
const RESULT_MS = 4200
/** 설교 참여 버튼이 뜨는 거리(서버 판정과 같게) */
const JOIN_RANGE = WORLD.plaza.r + 4
/** 구호 자막을 보여 줄 거리(참여하지 않았어도 광장 근처면 분위기는 보여 준다) */
const CALL_VIEW_RANGE = WORLD.plaza.r + 22
const RING_R = 52
const RING_LEN = 2 * Math.PI * RING_R

interface Call {
  round: number
  call: string
  resp: string
  /** performance.now 기준 마감 */
  until: number
  total: number
  answered: boolean
}

export function mountPodium(ctx: AppContext): void {
  const { store, bus, ui, net } = ctx

  // ───────── 상태 ─────────
  let prophecyReadyAt = 0
  /** 누르고 서버 답을 기다리는 동안 연타 막기 */
  let prophecyLockUntil = 0
  let sermonCoolUntil = 0
  let call: Call | null = null
  let lastSermonReward = { inf: 0, at: 0 }

  const meId = (): number => store.me?.id ?? 0
  const joined = (): boolean => !!store.sermon && store.sermon.joined.includes(meId())
  const distToPlaza = (): number => {
    const me = store.me
    return me ? Math.hypot(me.x - WORLD.plaza.x, me.z - WORLD.plaza.z) : Infinity
  }
  const posOf = (id: number): { x: number; y: number; z: number } | null => {
    if (store.me && id === store.me.id) return store.me
    return store.players.get(id) ?? null
  }
  const toLocal = (serverAt: number): number => performance.now() + (serverAt - store.serverNow())

  // ───────── 상황 버튼 ─────────
  ui.addContextProvider(() => {
    if (store.phase !== 'playing' || store.near.poi !== 'podium') return null
    const now = performance.now()
    const ready = Math.max(prophecyReadyAt, prophecyLockUntil)
    const running = !!store.sermon
    return [
      {
        id: 'podium-prophecy',
        label: '오늘의 계시',
        icon: '📜',
        primary: true,
        readyAt: ready > now ? ready : undefined,
        onClick: () => {
          prophecyLockUntil = performance.now() + 900
          net.send({ t: 'prophecy' })
        },
      },
      {
        id: 'podium-sermon',
        label: '집단 설교',
        icon: '📣',
        disabled: running,
        readyAt: !running && sermonCoolUntil > now ? sermonCoolUntil : undefined,
        onClick: () => void net.send({ t: 'sermon', a: 'start' }),
      },
    ]
  })
  ui.addContextProvider(() => {
    const s = store.sermon
    if (store.phase !== 'playing' || !s || !store.me || joined()) return null
    if (distToPlaza() > JOIN_RANGE) return null
    return {
      id: 'podium-join',
      label: '설교 참여',
      icon: '🙌',
      primary: true,
      onClick: () => void net.send({ t: 'sermon', a: 'join' }),
    }
  })

  // ───────── DOM ─────────
  const caption = h('div.podium-caption.hidden', { 'aria-live': 'polite' })
  const capLabel = h('div.podium-caption-label', '📜 오늘의 계시')
  const capText = h('div.podium-caption-text')
  const capWho = h('div.podium-caption-who')
  caption.append(capLabel, capText, capWho)

  const banner = h('div.podium-banner.hidden')
  const bannerText = h('span.podium-banner-text')
  const bannerFill = h('i')
  banner.append(bannerText, h('div.podium-banner-bar', bannerFill))

  const callBox = h('div.podium-call.hidden')
  const callRound = h('div.podium-call-round')
  const callText = h('div.podium-call-text')
  const callHint = h('div.podium-call-hint')
  callBox.append(callRound, callText, callHint)

  const ringFg = svgEl('circle', { cx: '60', cy: '60', r: String(RING_R), class: 'podium-ring-fg' })
  const ring = svgEl('svg', { viewBox: '0 0 120 120', class: 'podium-ring', 'aria-hidden': 'true' })
  ring.append(svgEl('circle', { cx: '60', cy: '60', r: String(RING_R), class: 'podium-ring-bg' }), ringFg)
  ringFg.setAttribute('stroke-dasharray', String(RING_LEN))
  const respLabel = h('span.podium-resp-label')
  const respBtn = h(
    'button.podium-resp.hidden',
    { type: 'button', onclick: () => respond() },
    ring,
    respLabel,
    h('kbd.podium-resp-key', { 'aria-hidden': 'true' }, 'Space'),
  )

  const result = h('div.podium-result.hidden')

  const wrap = h('div.podium', caption, banner, callBox, respBtn, result)
  ui.root.append(wrap)

  // ───────── 계시 ─────────
  let captionTimer = 0
  bus.onMsg('prophecy', (m) => {
    const me = store.me
    if (!me) return
    if (m.p === me.id) prophecyReadyAt = performance.now() + PROPHECY_COOLDOWN_MS
    prophecyLockUntil = 0
    ui.refreshContext()
    const at = posOf(m.p)
    if (at) {
      try {
        ctx.fx.burst('prophecy', at.x, at.y, at.z)
      } catch {
        /* 연출 실패는 무시 */
      }
    }
    const d = at ? Math.hypot(at.x - me.x, at.z - me.z) : Infinity
    if (m.p !== me.id && d > CAPTION_RANGE) return
    playSfx(ctx, 'prophecy')
    capText.textContent = m.text
    capWho.textContent = m.p === me.id ? '— 내가 방금 받은 계시' : `— ${store.nameOf(m.p)} 교주`
    caption.classList.remove('hidden', 'out')
    // 애니메이션을 처음부터 다시 돌린다
    void caption.offsetWidth
    caption.classList.add('show')
    window.clearTimeout(captionTimer)
    captionTimer = window.setTimeout(() => {
      caption.classList.add('out')
      captionTimer = window.setTimeout(() => caption.classList.add('hidden'), 300)
    }, CAPTION_MS)
  })

  // ───────── 설교 ─────────
  bus.onMsg('reward', (m) => {
    if (m.why === 'sermon') lastSermonReward = { inf: m.inf ?? 0, at: performance.now() }
  })

  bus.onMsg('sermon', (m) => {
    switch (m.ph) {
      case 'no':
        onNo(m)
        break
      case 'start':
        playSfx(ctx, 'chant')
        if (m.s?.leader === meId()) {
          ctx.actions.emote('preach')
          ui.toast('📣 설교 시작! 단상에서 내려가지 마세요', 'gold')
        } else if (distToPlaza() <= JOIN_RANGE + 10) {
          ui.toast(`📣 ${store.nameOf(m.s?.leader ?? 0)}님의 설교! 광장에서 [설교 참여]`, 'info')
        }
        break
      case 'join':
        if (m.s && m.s.joined.at(-1) === meId()) {
          playSfx(ctx, 'accept')
          ui.toast('🙌 설교에 참여했어요. 구호가 뜨면 따라 외치세요!', 'good')
        }
        break
      case 'call':
        onCall(m)
        break
      case 'end':
        onEnd(m)
        break
    }
    paintBanner()
    ui.refreshContext()
  })

  function onNo(m: SSermon): void {
    playSfx(ctx, 'error')
    if (m.why === 'cool') {
      sermonCoolUntil = performance.now() + Math.max(0, m.ms ?? 0)
      ui.toast(`목이 아직 쉬어 있어요. ${Math.ceil((m.ms ?? 0) / 1000)}초 뒤에 다시 설교할 수 있어요`, 'info')
    } else if (m.why === 'far') ui.toast('단상 위에 올라가야 설교할 수 있어요', 'info')
    else ui.toast('이미 누군가 설교 중이에요. [설교 참여]로 함께하세요', 'info')
  }

  function onCall(m: SSermon): void {
    if (typeof m.round !== 'number' || typeof m.call !== 'string' || typeof m.resp !== 'string') return
    const until = toLocal(m.until ?? store.serverNow() + 3500)
    call = { round: m.round, call: m.call, resp: m.resp, until, total: Math.max(500, until - performance.now()), answered: false }
    const mine = joined()
    if (!mine && distToPlaza() > CALL_VIEW_RANGE) {
      call = null
      return
    }
    callRound.textContent = `구호 ${m.round}`
    callText.textContent = `“${m.call}”`
    callHint.textContent = mine ? '' : '광장에서 [설교 참여]를 누르면 같이 외칠 수 있어요'
    callHint.classList.toggle('hidden', mine)
    callBox.classList.remove('hidden')
    wrap.classList.add('calling')
    void callBox.offsetWidth
    callBox.classList.add('pop')
    if (mine) {
      respLabel.textContent = m.resp
      respBtn.classList.remove('hidden', 'done')
      respBtn.disabled = false
      placeResp()
    }
    playSfx(ctx, 'chant')
    // 교주는 구호마다 다시 설교 자세(이동했다가 돌아왔어도)
    if (store.sermon?.leader === meId() && store.me?.emote !== 'preach') ctx.actions.emote('preach')
    startRing()
  }

  function respond(): void {
    const c = call
    if (!c || c.answered || !joined() || performance.now() > c.until) return
    c.answered = true
    net.send({ t: 'sermon', a: 'resp', r: c.round })
    playSfx(ctx, 'chant')
    const me = store.me
    if (me) ctx.overlay.bubble(me.id, c.resp, 1500, 'shout')
    // 교주는 설교 자세를 유지하고, 참여자만 만세(직급이 낮으면 손 흔들기로 대신)
    if (store.sermon?.leader !== meId()) ctx.actions.emote((me?.prog.rank ?? 0) >= 1 ? 'cheer' : 'wave')
    respBtn.classList.add('done')
    respBtn.disabled = true
    respLabel.textContent = '✔ ' + c.resp
  }

  let ringRaf = 0
  function startRing(): void {
    cancelAnimationFrame(ringRaf)
    const step = (): void => {
      const c = call
      if (!c) return hideCall()
      const left = c.until - performance.now()
      if (left <= 0) {
        // 마감 직후 잠깐 남겨 두면 "놓쳤다"가 보인다
        if (left < -350) return hideCall()
      }
      const frac = Math.max(0, Math.min(1, left / c.total))
      placeResp()
      ringFg.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - frac)))
      ringRaf = requestAnimationFrame(step)
    }
    step()
  }
  /**
   * 터치: 응답 버튼을 오른쪽 아래 버튼 묶음(상황 버튼 + 말풍선/이모트/도망) 바로 위에 올린다.
   * 고정 높이로 두면 그 묶음을 덮어, 구호를 외치는 동안 [도망]·[이모트]를 누를 수 없고 엉뚱한 버튼이 눌린다.
   * 묶음의 높이는 상황 버튼 줄 수에 따라 변하므로 구호가 떠 있는 동안 매 프레임 실제 위치를 잰다.
   * 묶음이 안 보이면(대화 중 등) CSS 기본 자리로 둔다.
   */
  let respBottom = ''
  function placeResp(): void {
    let want = ''
    if (ui.root.classList.contains('hud-touch') && !respBtn.classList.contains('hidden')) {
      const dock = ui.root.querySelector<HTMLElement>('.hud-dock')
      const r = dock?.getBoundingClientRect()
      if (r && r.height > 0) want = Math.round(window.innerHeight - r.top + 12) + 'px'
    }
    if (want === respBottom) return
    respBottom = want
    respBtn.style.bottom = want
  }

  function hideCall(): void {
    cancelAnimationFrame(ringRaf)
    call = null
    callBox.classList.add('hidden')
    callBox.classList.remove('pop')
    wrap.classList.remove('calling')
    respBtn.classList.add('hidden')
  }

  // 데스크톱: Space / Enter 로 응답. 응답 창이 열린 동안은 HUD 의 Space(상황 버튼)보다 먼저 가로챈다
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping() || ui.openPanelId) return
      const c = call
      if (!c || c.answered || !joined() || respBtn.classList.contains('hidden')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      respBtn.classList.add('active')
      window.setTimeout(() => respBtn.classList.remove('active'), 120)
      respond()
    },
    true,
  )

  let resultTimer = 0
  function onEnd(m: SSermon): void {
    const s = m.s
    hideCall()
    sermonCoolUntil = performance.now() + SERMON_ROOM_COOLDOWN_MS
    const me = store.me
    if (me && s?.leader === me.id && me.emote === 'preach') ctx.actions.emote('')
    if (!s || !me) return
    const wasIn = s.joined.includes(me.id) || s.leader === me.id
    // 참여자 모두 환호(실패해도 분위기는 낸다)
    for (const id of s.joined) {
      const at = posOf(id)
      if (!at) continue
      try {
        ctx.fx.burst('cheer', at.x, at.y, at.z)
      } catch {
        /* 무시 */
      }
    }
    if (!wasIn) return
    playSfx(ctx, 'sermonEnd')
    const score = Math.max(0, Math.min(100, Math.round(m.score ?? 0)))
    const converts = Math.max(0, Math.floor(m.converts ?? 0))
    const inf = performance.now() - lastSermonReward.at < 3000 ? lastSermonReward.inf : 0
    const aborted = score === 0 && converts === 0 && inf === 0
    result.replaceChildren(
      h('div.podium-result-title', aborted ? '📣 설교가 흐지부지 끝났어요' : '📣 설교 끝!'),
      h(
        'div.podium-result-gauge',
        h('span', '신앙 게이지'),
        h('div.bar.gold', h('i', { style: { width: score + '%' } })),
        h('b', score + '%'),
      ),
      h(
        'div.podium-result-rows',
        h('div', h('span', '합류한 신도'), h('b', `${converts}명`)),
        h('div', h('span', '내가 받은 영향력'), h('b', inf > 0 ? `+${inf}` : '0')),
      ),
    )
    if (aborted) result.append(h('div.podium-result-note', '교주가 단상을 떠나면 설교는 무효예요'))
    result.classList.remove('hidden', 'out')
    window.clearTimeout(resultTimer)
    resultTimer = window.setTimeout(() => {
      result.classList.add('out')
      resultTimer = window.setTimeout(() => result.classList.add('hidden'), 300)
    }, RESULT_MS)
  }

  // ───────── 상단 배너 ─────────
  function paintBanner(): void {
    const s = store.sermon
    if (!s || store.phase !== 'playing') {
      banner.classList.add('hidden')
      return
    }
    const leader = s.leader === meId() ? '나' : store.nameOf(s.leader)
    const text = `📣 ${leader}의 집단 설교 · 참여 ${s.joined.length}명`
    if (bannerText.textContent !== text) bannerText.textContent = text
    banner.classList.toggle('mine', joined())
    banner.classList.remove('hidden')
    const total = Math.max(1, s.endsAt - s.startedAt)
    const left = Math.max(0, s.endsAt - store.serverNow())
    bannerFill.style.width = `${(100 * left) / total}%`
  }
  window.setInterval(paintBanner, 250)

  bus.on('entered', () => {
    hideCall()
    prophecyReadyAt = 0
    prophecyLockUntil = 0
    sermonCoolUntil = 0
    paintBanner()
  })
  bus.on('phase', () => {
    if (store.phase !== 'playing') {
      hideCall()
      caption.classList.add('hidden')
      result.classList.add('hidden')
    }
    paintBanner()
  })
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}
