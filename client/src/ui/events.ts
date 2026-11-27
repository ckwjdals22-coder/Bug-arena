/**
 * 돌발 이벤트 UI: 구청 단속반 추격 + 라이벌 교주 기싸움 (+ 예능 자막 장착).
 *
 * 단속반은 '교주가 쫓기는' 장면이다. 화면 연출은 당사자에게만 크게(빨간 테두리, 호루라기, 도망가기 버튼),
 * 다른 사람에게는 서버 소식(feed) 한 줄과 단속반 머리 위 🚨 정도만 보인다.
 * 기싸움 시트는 12초짜리 모달이다(이동 잠금은 하지 않는다: 코어의 잠금은 store.talk 에만 걸려 있고,
 * 걸어가 버려도 서버가 시간 초과로 정리한다).
 */
import { npcKey } from '../../../shared/constants'
import type { SDuel, SPatrol } from '../../../shared/protocol'
import type { AppContext, ContextProvider } from '../core/contracts'
import { mountCaptions } from './captions'
import { anyPopupOpen, isTyping, playSfx } from './hud'
import { clear, h } from './kit'
import './events.css'

/** 서버(patrol.ts)의 추격 최대 시간과 같은 값 — 남은 시간 표시용 */
const CHASE_MS = 9000
const DUEL_KEYS = ['1', '2', '3'] as const

export function mountEvents(ctx: AppContext): void {
  const { store, bus, ui, net } = ctx
  const captions = mountCaptions(ctx)
  const root = ui.root

  // ═════════════════ 단속반 ═════════════════

  const vignette = h('div.ev-vignette', { 'aria-hidden': 'true' })
  const chip = h('div.ev-chip.hidden', { role: 'status' })
  const chipText = h('span.ev-chip-text')
  const chipTime = h('b.ev-chip-time')
  chip.append(chipText, chipTime)
  const freeze = h('div.ev-freeze.hidden', { role: 'status' })
  const freezeTitle = h('div.ev-freeze-title', '훈방 조치 중…')
  const freezeCount = h('div.ev-freeze-count')
  const freezeSub = h('div.ev-freeze-sub', '신도들이 모르는 척 흩어졌습니다')
  freeze.append(h('div.ev-freeze-card', h('div.ev-freeze-icon', '🚨'), freezeTitle, freezeCount, freezeSub))
  root.append(vignette, chip, freeze)

  /** 내가 쫓기는 중인가('alert' | 'chase') */
  let chased: 'alert' | 'chase' | null = null
  let chaseEndsAt = 0
  let chipTimer: number | undefined
  let chipHide: number | undefined
  let freezeTimer: number | undefined

  function setChip(kind: 'alert' | 'chase' | 'lost', label: string): void {
    window.clearTimeout(chipHide)
    chip.className = `ev-chip ${kind}`
    chipText.textContent = label
    chipTime.textContent = ''
  }
  function hideChip(): void {
    window.clearInterval(chipTimer)
    chipTimer = undefined
    chip.classList.add('hidden')
  }
  function tickChip(): void {
    const left = Math.max(0, Math.ceil((chaseEndsAt - performance.now()) / 1000))
    chipTime.textContent = `${left}초`
  }

  function flashVignette(): void {
    vignette.classList.remove('on')
    void vignette.offsetWidth
    vignette.classList.add('on')
  }

  function showFreeze(ms: number): void {
    const until = performance.now() + ms
    freeze.classList.remove('hidden')
    window.clearInterval(freezeTimer)
    const draw = (): void => {
      const left = Math.ceil((until - performance.now()) / 1000)
      if (left <= 0) {
        window.clearInterval(freezeTimer)
        freeze.classList.add('hidden')
        return
      }
      // 3·2·1 중 지금 숫자만 진하게
      clear(freezeCount)
      for (let i = Math.ceil(ms / 1000); i >= 1; i--) {
        freezeCount.append(h('span', { class: i === left ? 'now' : i > left ? 'done' : '' }, String(i)))
        if (i > 1) freezeCount.append(h('i', '·'))
      }
    }
    draw()
    freezeTimer = window.setInterval(draw, 200)
  }

  /** 쫓기는 동안에는 '도망가기'가 가장 큰 상황 버튼이 된다 */
  const fleeProvider: ContextProvider = () => {
    const me = store.me
    if (!chased || !me || store.talk) return null
    return {
      id: 'patrol-flee',
      icon: '💨',
      label: '도망가기',
      primary: true,
      readyAt: me.sprintReadyAt > performance.now() ? me.sprintReadyAt : undefined,
      onClick: () => void ctx.actions.sprint(),
    }
  }
  ui.addContextProvider(fleeProvider)
  // 상황 버튼은 '먼저 등록된 primary' 가 큰 버튼이 된다. 쫓기는 순간만큼은 말 걸기보다 도망가기가 먼저여야 하므로 맨 앞으로 옮긴다
  {
    const list = ui.contextProviders as ContextProvider[]
    const i = list.indexOf(fleeProvider)
    if (i > 0) {
      list.splice(i, 1)
      list.unshift(fleeProvider)
    }
  }

  function npcPos(n: number): { x: number; y: number; z: number } | null {
    const v = store.npcs.get(n)
    return v ? { x: v.x, y: v.y, z: v.z } : null
  }

  function onPatrol(m: SPatrol): void {
    const me = store.me
    if (!me) return
    const mine = m.p === me.id
    // 누구를 쫓든 추격 중인 단속반 머리 위에는 🚨 (다른 사람도 '저기 단속 중'임을 안다)
    if (m.ph === 'chase') ctx.overlay.bubble(npcKey(m.n), '🚨 거기 서요!', CHASE_MS, 'shout')
    if (!mine) return
    switch (m.ph) {
      case 'alert': {
        chased = 'alert'
        flashVignette()
        playSfx(ctx, 'whistle')
        const pos = npcPos(m.n)
        if (pos) ctx.fx.burst('alert', pos.x, pos.y, pos.z)
        setChip('alert', '🚨 단속반에게 들켰다!')
        captions.show('patrolAlert')
        ui.refreshContext()
        break
      }
      case 'chase':
        chased = 'chase'
        chaseEndsAt = performance.now() + CHASE_MS
        setChip('chase', '🚨 단속반 추격 중 — 도망가세요!')
        tickChip()
        window.clearInterval(chipTimer)
        chipTimer = window.setInterval(tickChip, 250)
        ui.refreshContext()
        break
      case 'caught':
        chased = null
        hideChip()
        playSfx(ctx, 'caught')
        showFreeze(m.ms ?? 3000)
        captions.muteFollowerLeft(4000)
        captions.show('patrolCaught')
        ui.refreshContext()
        break
      case 'lost':
        chased = null
        window.clearInterval(chipTimer)
        chipTimer = undefined
        setChip('lost', '💨 따돌렸다!')
        chipHide = window.setTimeout(hideChip, 1900)
        playSfx(ctx, 'pop')
        captions.show('patrolEscape')
        ui.refreshContext()
        break
    }
  }
  bus.onMsg('patrol', onPatrol)

  // ═════════════════ 라이벌 기싸움 ═════════════════

  const duelName = h('b.ev-duel-name')
  const duelSay = h('p.ev-duel-say')
  const duelBar = h('i')
  const duelChoices = h('div.ev-duel-choices')
  const sheet = h(
    'div.ev-duel.hidden',
    { role: 'dialog', 'aria-label': '라이벌 교주 기싸움' },
    h('div.ev-duel-timer', { 'aria-hidden': 'true' }, duelBar),
    h('div.ev-duel-head', h('span.ev-duel-badge', '😎 기싸움'), duelName, h('span.ev-duel-hint', '더 황당한 쪽이 이깁니다')),
    h('div.ev-duel-card', duelSay),
    duelChoices,
  )
  const banner = h('div.ev-duel-result.hidden', { role: 'status' })
  root.append(sheet, banner)

  let duel: { n: number; choices: string[]; chosen: boolean } | null = null
  let duelGuard: number | undefined
  let bannerTimer: number | undefined

  function closeDuel(): void {
    window.clearTimeout(duelGuard)
    duel = null
    sheet.classList.add('hidden')
    root.classList.remove('events-duel')
    ui.refreshContext()
  }

  function choose(i: number): void {
    if (!duel || duel.chosen || i < 0 || i >= duel.choices.length) return
    duel.chosen = true
    playSfx(ctx, 'pick')
    net.send({ t: 'duel', c: i })
    duelChoices.querySelectorAll('button').forEach((b, j) => {
      b.disabled = true
      b.classList.toggle('picked', j === i)
    })
  }

  function openDuel(m: SDuel): void {
    const choices = Array.isArray(m.choices) ? m.choices.slice(0, 3) : []
    if (choices.length === 0) return
    duel = { n: m.n, choices, chosen: false }
    const npc = store.npcs.get(m.n)
    duelName.textContent = npc ? npc.pub.name : '옆 동네 교주'
    duelSay.textContent = `“${m.say ?? '…'}”`
    clear(duelChoices)
    choices.forEach((c, i) => {
      duelChoices.append(
        h(
          'button.btn.block.ev-duel-choice',
          { type: 'button', onclick: () => choose(i) },
          h('kbd.ev-duel-key', DUEL_KEYS[i] ?? String(i + 1)),
          h('span.ev-duel-choice-text', c),
        ),
      )
    })
    const ms = Math.max(1500, (m.until ?? store.serverNow() + 12_000) - store.serverNow())
    duelBar.style.animation = 'none'
    void duelBar.offsetWidth
    duelBar.style.animation = ''
    duelBar.style.animationDuration = `${ms}ms`
    sheet.classList.remove('hidden')
    root.classList.add('events-duel')
    banner.classList.add('hidden')
    playSfx(ctx, 'battleStart')
    ctx.overlay.bubble(npcKey(m.n), m.say ?? '…', Math.min(ms, 6000), 'shout')
    // 결과가 끝내 안 오면(연결 문제) 시트가 영원히 남지 않게
    window.clearTimeout(duelGuard)
    duelGuard = window.setTimeout(closeDuel, ms + 4000)
    ui.refreshContext()
  }

  function endDuel(m: SDuel): void {
    closeDuel()
    const win = m.win === true
    banner.className = `ev-duel-result ${win ? 'win' : 'lose'}`
    clear(banner)
    banner.append(
      h('span.ev-duel-result-icon', win ? '🏆' : '😵'),
      h(
        'span.ev-duel-result-text',
        h('b.ev-duel-result-title', win ? '기싸움 승리! 신도 +2' : '기싸움 패배…'),
        h('span.ev-duel-result-sub', m.text ?? ''),
      ),
    )
    playSfx(ctx, win ? 'win' : 'lose')
    if (win) {
      const pos = npcPos(m.n)
      if (pos) ctx.fx.burst('join', pos.x, pos.y, pos.z)
    }
    captions.muteFollowerLeft(3000)
    captions.show(win ? 'duelWin' : 'duelLose')
    window.clearTimeout(bannerTimer)
    bannerTimer = window.setTimeout(() => banner.classList.add('hidden'), 3200)
  }

  bus.onMsg('duel', (m) => {
    if (m.ph === 'start') openDuel(m)
    else if (m.ph === 'end') endDuel(m)
  })

  // 1~3 = 선택지. 이모트 단축키(1~8)보다 먼저 받아서 삼킨다(캡처 단계)
  window.addEventListener(
    'keydown',
    (e) => {
      if (!duel || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping() || ui.openPanelId || anyPopupOpen()) return
      const m = /^(?:Digit|Numpad)([1-3])$/.exec(e.code)
      if (!m) return
      e.preventDefault()
      e.stopImmediatePropagation()
      choose(Number(m[1]) - 1)
    },
    true,
  )

  // ═════════════════ 정리 ═════════════════

  function resetAll(): void {
    chased = null
    hideChip()
    window.clearInterval(freezeTimer)
    freeze.classList.add('hidden')
    banner.classList.add('hidden')
    if (duel) closeDuel()
  }
  bus.on('phase', (ph) => {
    if (ph !== 'playing') resetAll()
  })
  bus.on('entered', resetAll)
}
