/**
 * 이모트와 말풍선(퀵챗). 자유 채팅이 없는 게임이라 이 두 가지가 접속자끼리의 유일한 소통 수단이다.
 *  - PC: 화면 아래 가운데 바(기본 8종 + 단축키 1~8) + '더보기'(해금 동작) + 💬
 *  - 터치: HUD 오른쪽 아래 묶음에 둥근 버튼 3개(말풍선 / 이모트 / 도망)
 * 두 배치의 DOM 을 모두 만들어 두고, 어느 쪽을 보일지는 CSS(.hud-touch)가 정한다.
 */
import './emotes.css'
import { SAY_COOLDOWN_MS } from '../../../shared/constants'
import { EMOTES } from '../../../shared/content/core'
import { QUICK_CHATS } from '../../../shared/content/misc'
import type { EmoteDef } from '../../../shared/content/types'
import type { AppContext } from '../core/contracts'
import { blurAfterPointerClick, isTyping, makePopup, playSfx, rankName } from './hud'
import { bindCooldown, clear, h, onPress } from './kit'

export function mountEmotes(ctx: AppContext): void {
  const { store, bus, ui } = ctx
  const root = ui.root
  const click = (): void => playSfx(ctx, 'click')

  const baseEmotes = EMOTES.filter((e) => e.key)
  const extraEmotes = EMOTES.filter((e) => !e.key)
  const fleeDef = EMOTES.find((e) => e.id === 'flee')

  const emoteBtns = new Map<string, HTMLElement[]>()
  const fleeBtns: HTMLElement[] = []
  const chatBtns: HTMLElement[] = []
  const remember = (id: string, btn: HTMLElement): void => {
    const list = emoteBtns.get(id)
    if (list) list.push(btn)
    else emoteBtns.set(id, [btn])
    if (id === 'flee') fleeBtns.push(btn)
  }

  const myRank = (): number => store.me?.prog.rank ?? 0

  // ───────── 동작 실행 ─────────
  // 소리 메모: 동작/도망이 실제로 나갈 때의 효과음은 actions 가 낸다. 여기서는 "안 됐을 때"와 시트 여닫기만 소리를 낸다.
  function flee(): void {
    if (!store.me || store.phase !== 'playing') return
    const ok = ctx.actions.sprint()
    if (!ok) {
      playSfx(ctx, 'error')
      const left = Math.ceil((store.me.sprintReadyAt - performance.now()) / 1000)
      ui.toast(left > 0 ? `아직 숨이 차요! ${left}초 뒤에 다시 도망칠 수 있어요.` : '지금은 도망칠 수 없어요. 잠시 뒤에 다시 눌러 주세요.', 'info')
    }
    syncState()
  }

  function doEmote(def: EmoteDef): void {
    const me = store.me
    if (!me || store.phase !== 'playing') return
    if (me.prog.rank < def.rank) {
      click()
      ui.toast(`'${rankName(def.rank)}' 직급이 되면 쓸 수 있어요.`, 'info')
      return
    }
    if (def.id === 'flee') {
      flee()
      return
    }
    // 반복 동작은 같은 버튼을 한 번 더 누르면 멈춘다(버튼이 곧 취소 버튼)
    if (def.loop && me.emote === def.id) ctx.actions.emote('')
    else ctx.actions.emote(def.id)
    syncState()
  }

  function doSay(id: number): void {
    if (!store.me || store.phase !== 'playing') return
    ctx.actions.say(id)
    const until = performance.now() + SAY_COOLDOWN_MS
    for (const b of chatBtns) bindCooldown(b, until)
  }

  // ───────── PC 바 ─────────
  const bar = h('div.emotes-bar.hidden', { role: 'toolbar', 'aria-label': '이모트' })
  for (const def of baseEmotes) {
    const btn = h(
      'button.emotes-btn',
      {
        type: 'button',
        title: `${def.name} (${def.key})`,
        'aria-label': def.name,
        dataset: { name: def.name },
        onclick: () => doEmote(def),
      },
      h('span.emotes-icon', def.icon),
      h('kbd', { 'aria-hidden': 'true' }, def.key ?? ''),
    )
    remember(def.id, btn)
    bar.append(btn)
  }
  const moreBtn = h('button.emotes-btn.emotes-wide', { type: 'button', title: '해금한 동작 더보기', 'aria-haspopup': 'true' }, h('span.emotes-icon', '➕'), h('small', '더보기'))
  const chatBtn = h('button.emotes-btn.emotes-wide', { type: 'button', title: '말풍선', 'aria-haspopup': 'true' }, h('span.emotes-icon', '💬'), h('small', '말풍선'))
  chatBtns.push(chatBtn)
  bar.append(h('span.emotes-div', { 'aria-hidden': 'true' }), moreBtn, chatBtn)

  // ───────── 터치 버튼 ─────────
  const tChat = h('button.round-btn.emotes-tbtn', { type: 'button', 'aria-label': '말풍선', 'aria-haspopup': 'true' }, '💬', h('small', '말풍선'))
  const tEmote = h('button.round-btn.emotes-tbtn', { type: 'button', 'aria-label': '이모트', 'aria-haspopup': 'true' }, '🙌', h('small', '이모트'))
  const tFlee = h('button.round-btn.emotes-tbtn', { type: 'button', 'aria-label': '도망가기' }, fleeDef?.icon ?? '💨', h('small', '도망'))
  // 달리는 중(조이스틱 손가락이 닿아 있는 중)에도 눌려야 한다 → 터치는 pointerup 에서 처리
  onPress(tFlee, flee)
  chatBtns.push(tChat)
  fleeBtns.push(tFlee)
  const touchBox = h('div.emotes-touch.hidden', tChat, tEmote, tFlee)

  // HUD 가 만들어 둔 자리에 끼운다(상황 버튼 줄 수가 변해도 겹치지 않는다). HUD 가 없으면 스스로 자리를 잡는다
  const slot = root.querySelector<HTMLElement>('.hud-dock-slot')
  if (slot) slot.append(touchBox)
  else {
    touchBox.classList.add('emotes-touch-alone')
    root.append(touchBox)
  }

  // ───────── 이모트 시트 ─────────
  const sheetBody = h('div.emotes-grid')
  const sheetTitle = h('b.emotes-sheet-title')
  const sheetBox = h('div.emotes-sheet.interactive', { role: 'menu' })
  let sheetMode: 'all' | 'extra' = 'all'
  const sheet = makePopup(ctx, sheetBox, { anchors: [moreBtn, tEmote], onShow: renderSheet })
  sheetBox.append(h('div.emotes-sheet-head', sheetTitle, h('button.icon-btn.emotes-close', { type: 'button', 'aria-label': '닫기', onclick: () => sheet.hide() }, '✕')), sheetBody)

  function renderSheet(): void {
    clear(sheetBody)
    const rank = myRank()
    const list = sheetMode === 'all' ? EMOTES : extraEmotes
    sheetTitle.textContent = sheetMode === 'all' ? '이모트' : '직급으로 여는 동작'
    for (const def of list) {
      const locked = rank < def.rank
      const on = store.me?.emote === def.id
      sheetBody.append(
        h(
          'button.tile.emotes-tile',
          {
            type: 'button',
            class: (locked ? 'locked ' : '') + (on ? 'on' : ''),
            'aria-disabled': locked ? 'true' : undefined,
            onclick: () => {
              // 잠긴 동작도 눌리긴 한다: 왜 안 되는지 알려 주는 편이 친절하다
              if (!locked) sheet.hide(true)
              doEmote(def)
            },
          },
          h('span.big', def.icon),
          h('span.emotes-tile-name', def.name),
          locked ? h('span.emotes-lock', '🔒 ' + rankName(def.rank)) : null,
        ),
      )
    }
  }

  moreBtn.addEventListener('click', () => {
    click()
    if (sheet.open && sheetMode !== 'extra') sheet.hide()
    sheetMode = 'extra'
    sheet.toggle()
  })
  onPress(tEmote, () => {
    click()
    if (sheet.open && sheetMode !== 'all') sheet.hide()
    sheetMode = 'all'
    sheet.toggle()
  })

  // ───────── 말풍선(퀵챗) 시트 ─────────
  const chatList = h('div.emotes-chat-list')
  const chatBox = h('div.emotes-chat.interactive', { role: 'menu' })
  const chat = makePopup(ctx, chatBox, { anchors: [chatBtn, tChat], onShow: renderChat })
  chatBox.append(h('div.emotes-sheet-head', h('b.emotes-sheet-title', '말풍선'), h('button.icon-btn.emotes-close', { type: 'button', 'aria-label': '닫기', onclick: () => chat.hide() }, '✕')), chatList)

  function renderChat(): void {
    clear(chatList)
    const rank = myRank()
    for (const q of QUICK_CHATS) {
      const locked = rank < q.rank
      chatList.append(
        h(
          'button.btn.block.emotes-chat-item',
          {
            type: 'button',
            class: locked ? 'locked' : '',
            'aria-disabled': locked ? 'true' : undefined,
            onclick: () => {
              click()
              if (locked) {
                ui.toast(`'${rankName(q.rank)}' 직급이 되면 쓸 수 있어요.`, 'info')
                return
              }
              chat.hide(true)
              doSay(q.id)
            },
          },
          h('span.emotes-chat-icon', q.icon),
          h('span.emotes-chat-text', q.text),
          locked ? h('span.emotes-lock', '🔒 ' + rankName(q.rank)) : null,
        ),
      )
    }
  }
  const toggleChat = (): void => {
    click()
    chat.toggle()
  }
  chatBtn.addEventListener('click', toggleChat)
  onPress(tChat, toggleChat)

  root.append(bar, sheetBox, chatBox)
  blurAfterPointerClick(bar)
  blurAfterPointerClick(touchBox)

  // ───────── 상태 표시: 재생 중인 반복 동작 / 도망 쿨타임 ─────────
  let lastActive: string | null = null
  let lastFleeReady = 0

  function syncState(): void {
    const me = store.me
    const cur = me?.emote ?? null
    if (cur !== lastActive) {
      if (lastActive) for (const b of emoteBtns.get(lastActive) ?? []) b.classList.remove('on')
      if (cur) for (const b of emoteBtns.get(cur) ?? []) b.classList.add('on')
      lastActive = cur
    }
    const ready = me?.sprintReadyAt ?? 0
    if (ready !== lastFleeReady) {
      lastFleeReady = ready
      for (const b of fleeBtns) bindCooldown(b, ready)
    }
  }

  function applyPhase(): void {
    const visible = store.phase === 'playing' || store.phase === 'reconnecting'
    bar.classList.toggle('hidden', !visible)
    touchBox.classList.toggle('hidden', !visible)
    if (!visible) {
      sheet.hide()
      chat.hide()
    }
    syncState()
  }

  bus.on('phase', applyPhase)
  bus.on('entered', applyPhase)
  bus.on('talk', (t) => {
    // 대화 중에는 숫자키가 멘트 선택이므로 시트를 닫아 헷갈리지 않게 한다
    if (t) {
      sheet.hide()
      chat.hide()
    }
  })
  window.setInterval(() => {
    if (store.phase === 'playing') syncState()
  }, 250)

  // 숫자키 1~8. 대화 시트가 열려 있으면 같은 키가 멘트 선택이므로 여기서는 손대지 않는다
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
    if (!m) return
    if (store.phase !== 'playing' || store.talk || ui.openPanelId || isTyping()) return
    if (root.querySelector('.confirm-layer')) return
    const def = baseEmotes.find((d) => d.key === m[1])
    if (!def) return
    e.preventDefault()
    for (const b of emoteBtns.get(def.id) ?? []) {
      b.classList.add('active')
      window.setTimeout(() => b.classList.remove('active'), 120)
    }
    doEmote(def)
  })

  applyPhase()
}
