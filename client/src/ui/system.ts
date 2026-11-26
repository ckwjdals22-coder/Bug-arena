/**
 * 시스템 안내: 재접속 배너, 내보내짐/만원/접속 실패 카드, 소식 피드, 승급 축하.
 * 문구 원칙(조사 01 §4-11, §4-16): "무엇이 안 됐는지 + 다음에 할 일"을 세계관 말투(~해요)로 짧게.
 */
import './system.css'
import type { RankDef } from '../../../shared/content/types'
import type { FeedKind, RoomInfo } from '../../../shared/types'
import { roomFromUrl } from '../core/config'
import type { AppContext } from '../core/contracts'
import { playSfx, rankDef } from './hud'
import { clear, h } from './kit'

interface Notice {
  icon: string
  title: string
  body: string
}

const KICK: Record<string, Notice> = {
  dup: { icon: '🪟', title: '이 창은 잠시 쉬어요', body: '다른 창에서 접속해서 이 창의 연결을 끊었어요. 포교는 한 번에 한 창에서만 할 수 있어요.' },
  idle: { icon: '😴', title: '잠깐 쉬고 계셨네요', body: '한동안 움직임이 없어서 연결을 쉬게 했어요. 그동안 모은 것은 그대로 남아 있어요.' },
  rate: { icon: '🥵', title: '너무 열정적이었어요', body: '요청이 한꺼번에 너무 많아서 연결이 끊겼어요. 잠깐 숨을 고른 뒤 다시 들어와 주세요.' },
  ver: { icon: '🆕', title: '새 버전이 나왔어요', body: '게임이 업데이트됐어요. 새로고침하면 바로 이어서 할 수 있어요.' },
  shutdown: { icon: '🛠️', title: '서버가 점검 중이에요', body: '거리를 잠깐 정비하고 있어요. 조금 뒤에 다시 접속해 주세요.' },
  bad: { icon: '🤔', title: '연결에 문제가 생겼어요', body: '서버가 요청을 알아듣지 못했어요. 다시 접속해 주세요.' },
}

const FEED_ICON: Record<FeedKind, string> = {
  rank: '🎉',
  ach: '🏅',
  cult: '🚩',
  join: '🙏',
  battle: '⚔️',
  sermon: '📣',
  rare: '💎',
  patrol: '🚨',
  info: '📢',
}

const FULL_ONE = '이 방은 정원이 꽉 찼어요. 옆 방도 똑같은 거리니까 바로 옮겨 드릴게요.'
const FULL_ALL = '지금은 모든 방이 가득 찼어요. 자리가 나면 바로 들어갈 수 있어요.'

const FEED_MAX = 3
const FEED_MS = 5600
const RANK_MS = 4800
const CONFETTI = ['#ffd23f', '#7b5cff', '#ff7eb6', '#3ccb7f', '#4f8fe6', '#ff5d5d']

export function mountSystem(ctx: AppContext): void {
  const { store, bus, ui } = ctx
  const root = ui.root
  const click = (): void => playSfx(ctx, 'click')

  // ───────── 재접속 배너 + 소식 피드 (HUD 바로 아래, 화면을 막지 않는다) ─────────
  const banner = h('div.system-banner.hidden', { role: 'status' }, h('i.system-spin', { 'aria-hidden': 'true' }), '연결이 끊겼어요. 다시 연결 중…')
  const feed = h('div.system-feed', { 'aria-live': 'polite' })
  const stack = h('div.system-stack.hidden', banner, feed)

  function pushFeed(icon: string, text: string, subtle = false): void {
    if (!text) return
    // 플레이어 이름이 섞인 글이다 → 텍스트 노드로만 넣는다
    const el = h('div.system-feed-line', { class: subtle ? 'subtle' : '' }, h('span.system-feed-icon', icon), h('span.system-feed-text', text))
    feed.append(el)
    while (feed.children.length > FEED_MAX) feed.firstElementChild?.remove()
    window.setTimeout(() => el.classList.add('out'), FEED_MS)
    window.setTimeout(() => el.remove(), FEED_MS + 320)
  }

  // ───────── 전체 화면 카드: 내보내짐 / 만원 / 접속 실패 ─────────
  const cardIcon = h('div.system-card-icon')
  const cardTitle = h('h2.system-card-title')
  const cardBody = h('p.system-card-body')
  const cardExtra = h('div.system-card-extra')
  const cardActions = h('div.system-card-actions')
  const cardCode = h('p.system-card-code.small.muted')
  const screen = h('div.screen.system-screen.hidden', h('div.card.system-card', { role: 'alertdialog', 'aria-live': 'assertive' }, cardIcon, cardTitle, cardBody, cardExtra, cardActions, cardCode))

  let everPlayed = false
  let roomsTimer = 0
  let roomsSig = ''

  const retryRoom = (): string => (everPlayed ? (store.profile.lastRoom ?? roomFromUrl() ?? 'auto') : (roomFromUrl() ?? store.profile.lastRoom ?? 'auto'))

  function bigButton(label: string, onClick: () => void, cls = 'primary'): HTMLButtonElement {
    return h(
      'button.btn.big.block',
      {
        type: 'button',
        class: cls,
        onclick: () => {
          click()
          onClick()
        },
      },
      label,
    )
  }

  function fillCard(n: Notice, code: string): void {
    cardIcon.textContent = n.icon
    cardTitle.textContent = n.title
    cardBody.textContent = n.body
    cardCode.textContent = code ? `안내 코드: ${code}` : ''
    cardCode.classList.toggle('hidden', !code)
    clear(cardExtra)
    clear(cardActions)
  }

  function drawFullRooms(): void {
    const rooms: RoomInfo[] = store.rooms
    const sig = rooms.map((r) => `${r.id}:${r.name}:${r.players}:${r.cap}:${r.npcs}`).join('|')
    if (sig === roomsSig && cardExtra.childElementCount > 0) return
    roomsSig = sig
    clear(cardExtra)
    const anyFree = rooms.some((r) => r.players < r.cap)
    if (rooms.length === 0) cardExtra.append(h('p.small.muted.center', '다른 방을 찾아보는 중…'))
    for (const r of rooms) {
      const isFull = r.players >= r.cap
      cardExtra.append(
        h(
          'div.card.flat.system-room',
          { class: isFull ? 'full' : '' },
          h('div.grow', h('b', r.name), h('div.system-room-nums', h('span', `👤 ${r.players}/${r.cap}`), h('span.muted', `🤖 ${r.npcs}`))),
          h(
            'button.btn.sm',
            {
              type: 'button',
              disabled: isFull,
              onclick: () => {
                click()
                ctx.actions.enter(r.id)
              },
            },
            isFull ? '가득 참' : '이 방으로',
          ),
        ),
      )
    }
    clear(cardActions)
    cardActions.append(bigButton(anyFree || rooms.length === 0 ? '옆 방으로' : '다시 시도', () => ctx.actions.enter('auto')))
    cardBody.textContent = rooms.length > 0 && !anyFree ? FULL_ALL : FULL_ONE
  }

  function refreshRooms(): void {
    try {
      ctx.net.refreshRooms().then(
        () => {
          if (store.phase === 'full') drawFullRooms()
        },
        () => {
          /* 목록 갱신 실패: 가진 목록을 그대로 둔다 */
        },
      )
    } catch {
      /* 무시 */
    }
  }

  function showCard(): void {
    clearInterval(roomsTimer)
    roomsTimer = 0
    const phase = store.phase
    if (phase === 'kicked') {
      const why = store.phaseWhy
      const known = Object.prototype.hasOwnProperty.call(KICK, why)
      fillCard(known ? KICK[why]! : KICK['bad']!, known ? '' : why)
      if (why === 'ver') cardActions.append(bigButton('새로고침', () => location.reload()))
      else cardActions.append(bigButton('다시 접속', () => ctx.actions.enter(store.profile.lastRoom ?? 'auto')))
    } else if (phase === 'full') {
      fillCard({ icon: '🚧', title: '방이 가득 찼어요', body: FULL_ONE }, '')
      roomsSig = ''
      drawFullRooms()
      refreshRooms()
      roomsTimer = window.setInterval(refreshRooms, 5000)
    } else {
      fillCard({ icon: '📡', title: '접속에 실패했어요', body: '서버에 닿지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.' }, store.phaseWhy)
      cardActions.append(bigButton('다시 시도', () => ctx.actions.enter(retryRoom())))
    }
    screen.classList.remove('hidden')
  }

  function hideCard(): void {
    clearInterval(roomsTimer)
    roomsTimer = 0
    screen.classList.add('hidden')
  }

  // ───────── 승급 축하 ─────────
  const rankName = h('b.system-rank-name')
  const rankCheer = h('p.system-rank-cheer')
  const rankUnlock = h('span.system-rank-unlock-text')
  const confetti = h('div.system-confetti', { 'aria-hidden': 'true' })
  for (let i = 0; i < 16; i++) {
    const bit = h('i')
    bit.style.left = 4 + ((i * 37) % 92) + '%'
    bit.style.background = CONFETTI[i % CONFETTI.length]!
    bit.style.animationDelay = (i % 8) * 0.14 + 's'
    bit.style.animationDuration = 1.5 + (i % 5) * 0.22 + 's'
    confetti.append(bit)
  }
  const rankCard = h(
    'div.system-rank-card.interactive',
    { role: 'button', tabIndex: 0, 'aria-label': '승급 축하 닫기' },
    confetti,
    h('span.system-rank-ribbon', '승급!'),
    rankName,
    rankCheer,
    h('p.system-rank-unlock', h('span', { 'aria-hidden': 'true' }, '🔓'), rankUnlock),
    h('small.system-rank-hint', '누르면 닫혀요'),
  )
  const rankBox = h('div.system-rank.hidden', { role: 'status' }, rankCard)
  let rankTimer = 0

  function hideRank(): void {
    clearTimeout(rankTimer)
    rankBox.classList.add('hidden')
  }
  function showRank(def: RankDef): void {
    rankName.textContent = def.name
    rankCheer.textContent = def.cheer
    rankUnlock.textContent = def.unlock
    // 연달아 승급해도 등장 연출이 다시 돌도록 한 번 숨겼다가 보인다
    rankBox.classList.add('hidden')
    requestAnimationFrame(() => rankBox.classList.remove('hidden'))
    clearTimeout(rankTimer)
    rankTimer = window.setTimeout(hideRank, RANK_MS)
  }
  rankCard.addEventListener('click', hideRank)
  rankCard.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') hideRank()
  })

  root.append(stack, rankBox, screen)

  // ───────── 화면 단계 ─────────
  function applyPhase(): void {
    const phase = store.phase
    if (phase === 'playing') everPlayed = true
    const inGame = phase === 'playing' || phase === 'reconnecting'
    stack.classList.toggle('hidden', !inGame)
    banner.classList.toggle('hidden', phase !== 'reconnecting')
    root.classList.toggle('system-reconnecting', phase === 'reconnecting')
    if (!inGame) {
      clear(feed)
      hideRank()
    }
    if (phase === 'kicked' || phase === 'full' || phase === 'error') showCard()
    else hideCard()
  }
  bus.on('phase', applyPhase)
  bus.on('rooms', () => {
    if (store.phase === 'full') drawFullRooms()
  })

  // ───────── 소식 ─────────
  bus.onMsg('feed', (m) => {
    pushFeed(FEED_ICON[m.k] ?? '📢', m.text)
  })

  // 퇴장 소식에는 "나가기 전의 이름"이 필요하다(store 에서는 이미 지워진 뒤에 이벤트가 온다) → 이름을 따로 기억해 둔다
  const names = new Map<number, string>()
  const remember = (id: number): string | undefined => {
    const name = store.players.get(id)?.pub.name
    if (name) names.set(id, name)
    return name
  }
  const resetNames = (): void => {
    names.clear()
    store.players.forEach((p, id) => names.set(id, p.pub.name))
  }
  let enteredAt = 0
  bus.on('entered', () => {
    enteredAt = performance.now()
    resetNames()
  })
  bus.on('playerUpdate', (id) => void remember(id))
  bus.on('playerJoin', (id) => {
    const name = remember(id)
    // 내가 방에 들어서는 순간 이미 있던 사람들까지 "나왔습니다"로 줄줄이 뜨지 않게 한다
    if (store.phase !== 'playing' || performance.now() - enteredAt < 800) return
    if (name) pushFeed('🚶', `${name}님이 4번 출구로 나왔습니다`, true)
  })
  bus.on('playerLeave', (id) => {
    const name = names.get(id) ?? store.players.get(id)?.pub.name
    names.delete(id)
    if (name) pushFeed('🚇', `${name}님이 지하철을 탔습니다`, true)
  })

  bus.on('rankUp', (rank) => {
    const def = rankDef(rank)
    playSfx(ctx, 'rank')
    const me = store.me
    if (me) {
      try {
        ctx.fx.burst('rank', me.x, me.y, me.z)
      } catch {
        /* 이펙트 실패는 무시 */
      }
    }
    showRank(def)
  })

  resetNames()
  applyPhase()
}
