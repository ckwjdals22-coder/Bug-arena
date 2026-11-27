/**
 * 포교 배틀 UI: 신청 버튼 → 상대의 수락 카드 → 점수판 → 결과.
 * 양쪽이 동의해야만 시작한다(카드를 무시하거나 '사양할게요'를 누르면 아무 일도 일어나지 않는다).
 */
import { BATTLE_COOLDOWN_MS, INF_BATTLE_LOSE, INF_BATTLE_WIN } from '../../../shared/constants'
import type { BattleState } from '../../../shared/protocol'
import type { AppContext } from '../core/contracts'
import { anyPopupOpen, isTyping, playSfx } from './hud'
import { clear, h } from './kit'
import './battle.css'

export function mountBattle(ctx: AppContext): void {
  const { store, bus, ui, net } = ctx
  /** 신청 버튼 재사용 가능 시각(performance.now) */
  let readyAt = 0
  /** 내가 보낸 신청이 응답을 기다리는 중인가 */
  let waiting = false

  const myBattle = (): BattleState | undefined => {
    const me = store.me
    return me ? store.battles.find((b) => b.a === me.id || b.b === me.id) : undefined
  }
  const inBattle = (id: number): boolean => store.battles.some((b) => b.a === id || b.b === id)

  // ───────── 상황 버튼: 배틀 신청 ─────────
  ui.addContextProvider(() => {
    const me = store.me
    const target = store.near.player
    if (!me || !target || store.talk || myBattle() || inBattle(target)) return null
    return {
      id: 'battle',
      icon: '⚔️',
      label: waiting ? '응답 대기' : '배틀 신청',
      readyAt,
      disabled: waiting,
      onClick() {
        if (waiting || performance.now() < readyAt) return
        waiting = true
        playSfx(ctx, 'click')
        net.send({ t: 'battle', a: 'req', to: target })
        ui.toast(`${store.nameOf(target)}님에게 포교 배틀을 신청했어요`, 'info')
        ui.refreshContext()
      },
    }
  })

  // ───────── 신청 카드(받는 쪽) ─────────
  const card = h('div.battle-card.hidden', { role: 'dialog', 'aria-label': '포교 배틀 신청' })
  ui.root.append(card)
  let cardFrom = 0
  let cardTimer: ReturnType<typeof setTimeout> | undefined

  function closeCard(): void {
    clearTimeout(cardTimer)
    cardFrom = 0
    card.classList.add('hidden')
  }
  function answer(ok: boolean): void {
    if (!cardFrom) return
    net.send({ t: 'battle', a: 'ans', from: cardFrom, ok })
    playSfx(ctx, ok ? 'accept' : 'decline')
    closeCard()
  }
  function showCard(from: number, until: number): void {
    // 설정에서 초대·배틀 신청을 받지 않기로 했다면 조용히 사양한다
    if (store.profile.settings.noInvites) {
      net.send({ t: 'battle', a: 'ans', from, ok: false })
      return
    }
    cardFrom = from
    const ms = Math.max(1500, until - store.serverNow())
    clear(card)
    card.append(
      h('div.battle-card-title', '⚔️ 포교 배틀 신청'),
      h('div.battle-card-text', h('b', store.nameOf(from)), '님이 승부를 걸어 왔어요.'),
      h('div.battle-card-sub', '60초 동안 시민 신도를 더 많이 모으는 쪽이 이겨요.'),
      h('div.battle-card-bar', h('i', { style: { animationDuration: `${ms}ms` } })),
      h(
        'div.row.end',
        h('button.btn.sm', { onclick: () => answer(false) }, '사양할게요'),
        h('button.btn.primary', { onclick: () => answer(true) }, '받아들일게요'),
      ),
    )
    card.classList.remove('hidden')
    playSfx(ctx, 'invite')
    clearTimeout(cardTimer)
    cardTimer = setTimeout(closeCard, ms)
  }

  // ───────── 점수판(내 배틀) + 구경용 칩 ─────────
  const board = h('div.battle-board.hidden', { 'aria-live': 'off' })
  const chips = h('div.battle-chips')
  const result = h('div.battle-result.hidden', { role: 'status' })
  ui.root.append(board, chips, result)
  let boardTimer: ReturnType<typeof setInterval> | undefined
  let resultTimer: ReturnType<typeof setTimeout> | undefined
  let lastScore = ''

  function drawBoard(): void {
    const me = store.me
    const b = myBattle()
    if (!me || !b) {
      board.classList.add('hidden')
      clearInterval(boardTimer)
      boardTimer = undefined
      return
    }
    const mineIsA = b.a === me.id
    const my = mineIsA ? b.sa : b.sb
    const their = mineIsA ? b.sb : b.sa
    const other = mineIsA ? b.b : b.a
    const left = Math.max(0, Math.ceil((b.endsAt - store.serverNow()) / 1000))
    clear(board)
    board.append(
      h('div.battle-side.me', h('div.battle-name', '나'), h('div.battle-score', String(my))),
      h('div.battle-mid', h('div.battle-vs', '⚔️'), h('div.battle-time', { class: left <= 10 ? 'hurry' : '' }, `${left}초`)),
      h('div.battle-side', h('div.battle-name', store.nameOf(other)), h('div.battle-score', String(their))),
    )
    board.classList.remove('hidden')
    const score = `${my}:${their}`
    if (score !== lastScore) {
      lastScore = score
      board.classList.remove('pulse')
      void board.offsetWidth
      board.classList.add('pulse')
    }
    if (!boardTimer) boardTimer = setInterval(drawBoard, 500)
  }

  function drawChips(): void {
    const me = store.me
    clear(chips)
    let shown = 0
    for (const b of store.battles) {
      if (me && (b.a === me.id || b.b === me.id)) continue
      if (shown++ >= 2) break
      chips.append(h('div.battle-chip', `⚔️ ${store.nameOf(b.a)} ${b.sa} : ${b.sb} ${store.nameOf(b.b)}`))
    }
  }

  /** 다음 결과 카드가 '보상 없는 친선 경기'인가(서버의 battleCap 안내가 end 보다 먼저 온다) */
  let capped = false
  bus.onMsg('err', (m) => {
    if (m.code === 'battleCap') capped = true
  })

  function showResult(b: BattleState, winner: number, left: boolean): void {
    const me = store.me
    if (!me) return
    const mineIsA = b.a === me.id
    const my = mineIsA ? b.sa : b.sb
    const their = mineIsA ? b.sb : b.sa
    const won = winner === me.id
    const tie = winner === 0
    // 상대가 나갔는데 내가 앞서 있지 않았거나, 둘 다 0명(0:0)이면 서버가 승부를 무효로 처리한다(보상·전적 없음)
    const scoreless = my + their === 0
    const voided = tie && (left || scoreless)
    // 같은 상대와 보상 상한을 넘긴 판(서버가 battleCap 으로 알려 준다)은 영향력 줄을 띄우지 않는다
    const friendly = capped
    capped = false
    const inf = tie ? Math.round((INF_BATTLE_WIN + INF_BATTLE_LOSE) / 2) : won ? INF_BATTLE_WIN : INF_BATTLE_LOSE
    clear(result)
    result.className = 'battle-result ' + (tie ? 'tie' : won ? 'win' : 'lose')
    result.append(
      h('div.battle-result-title', voided ? '🚪 무효' : tie ? '🤝 무승부' : won ? '🏆 승리!' : '😵 패배'),
      h('div.battle-result-score', `${my} : ${their}`),
      h(
        'div.battle-result-text',
        voided
          ? scoreless && !left
            ? '둘 다 한 명도 못 모아서 없던 승부가 됐어요.'
            : '상대가 자리를 떠서 없던 승부가 됐어요.'
          : friendly
            ? '같은 상대와 너무 자주 붙어서 이번 판은 친선 경기예요.'
          : left && won
            ? '상대가 자리를 떴어요. 앞서고 있었으니 승리예요.'
            : tie
              ? '둘 다 말은 많았어요.'
              : won
                ? '오늘 이 거리의 포교왕은 당신이에요.'
                : '괜찮아요. 거절도 수집이 됩니다.',
      ),
      ...(voided || friendly ? [] : [h('div.battle-result-inf', `✨ 영향력 +${inf}`)]),
    )
    playSfx(ctx, tie ? 'pop' : won ? 'win' : 'lose')
    if (!tie) ctx.actions.emote(won ? 'cheer' : 'bow')
    clearTimeout(resultTimer)
    resultTimer = setTimeout(() => result.classList.add('hidden'), 4800)
  }
  result.addEventListener('click', () => result.classList.add('hidden'))

  bus.onMsg('battle', (m) => {
    const me = store.me
    if (!me) return
    switch (m.ph) {
      case 'inv':
        if (m.from !== undefined) showCard(m.from, m.until ?? store.serverNow() + 20_000)
        break
      case 'no': {
        // 받은 카드가 회수된 경우(신청자가 나감)와 내가 보낸 신청이 거절된 경우가 모두 이쪽으로 온다
        if (cardFrom && m.why === 'left') closeCard()
        if (waiting || m.why === 'cool' || m.why === 'busy' || m.why === 'far') {
          const wasWaiting = waiting
          waiting = false
          if (m.why === 'cool') {
            readyAt = Math.max(readyAt, performance.now() + 4000)
            ui.toast('방금 배틀을 했거나 거절당했어요. 잠시 뒤에 다시 신청해 주세요.', 'info')
          } else if (m.why === 'busy') ui.toast('상대가 지금 다른 승부 중이에요.', 'info')
          else if (m.why === 'far') ui.toast('너무 멀어요. 가까이 가서 신청해 주세요.', 'info')
          else if (wasWaiting) {
            readyAt = performance.now() + BATTLE_COOLDOWN_MS
            ui.toast(m.why === 'left' ? '상대가 자리를 떴어요.' : '상대가 승부를 사양했어요. 현명한 선택일지도요.', 'info')
            playSfx(ctx, 'decline')
          }
          ui.refreshContext()
        }
        break
      }
      case 'start':
        if (m.b && (m.b.a === me.id || m.b.b === me.id)) {
          waiting = false
          closeCard()
          lastScore = ''
          playSfx(ctx, 'battleStart')
          ui.toast('⚔️ 포교 배틀 시작! 60초 동안 시민에게 말을 걸어 신도를 모으세요.', 'gold', 3600)
        }
        break
      case 'score':
        if (m.b && (m.b.a === me.id || m.b.b === me.id)) playSfx(ctx, 'pop')
        break
      case 'end':
        if (m.b) {
          const b = m.b
          const w = m.winner ?? 0
          if (b.a === me.id || b.b === me.id) {
            readyAt = performance.now() + BATTLE_COOLDOWN_MS
            showResult(b, w, m.why === 'left')
          }
          // 승자 머리 위 색종이는 방 전체가 본다
          const wv = w === me.id ? me : store.players.get(w)
          if (wv) ctx.fx.burst('rank', wv.x, wv.y, wv.z)
        }
        break
      default:
        break
    }
    drawBoard()
    drawChips()
    ui.refreshContext()
  })

  bus.on('entered', () => {
    waiting = false
    closeCard()
    result.classList.add('hidden')
    lastScore = ''
    drawBoard()
    drawChips()
  })
  bus.on('phase', (p) => {
    if (p !== 'playing' && p !== 'reconnecting') {
      closeCard()
      board.classList.add('hidden')
      clear(chips)
    }
  })
  bus.on('playerLeave', drawChips)

  // Y / N 으로 카드에 답하기(PC)
  window.addEventListener('keydown', (e) => {
    if (!cardFrom || isTyping() || anyPopupOpen() || ui.openPanelId) return
    if (e.code === 'KeyY') answer(true)
    else if (e.code === 'KeyN') answer(false)
  })
}
