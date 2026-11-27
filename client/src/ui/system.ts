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
import { stagePlay } from './stage'

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
  /** 무대(stage.ts) 자리를 돌려주는 함수: 눌러서 일찍 닫으면 다음 알림이 바로 이어진다 */
  let releaseStage: (() => void) | undefined

  let rankFrame = 0

  function hideRank(): void {
    clearTimeout(rankTimer)
    // 보이기 직전(다음 프레임)에 숨기라는 말이 오면 그 보이기도 취소한다(결과 배너에 비켜 줄 때 카드가 남지 않게)
    cancelAnimationFrame(rankFrame)
    rankBox.classList.add('hidden')
    const release = releaseStage
    releaseStage = undefined
    release?.()
  }
  function showRank(def: RankDef, done?: () => void): void {
    rankName.textContent = def.name
    rankCheer.textContent = def.cheer
    rankUnlock.textContent = def.unlock
    // 연달아 승급해도 등장 연출이 다시 돌도록 한 번 숨겼다가 보인다
    rankBox.classList.add('hidden')
    cancelAnimationFrame(rankFrame)
    rankFrame = requestAnimationFrame(() => rankBox.classList.remove('hidden'))
    clearTimeout(rankTimer)
    // 앞 카드의 자리는 여기서 돌려주지 않는다(이미 끝난 차례다) → 새 자리만 기억
    releaseStage = done
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
  // 끊겼다 돌아왔을 때: 그사이 사라진 것이 있으면 한 줄로 알려 준다(아무 말 없이 점수판·대화 창이 사라지면 고장처럼 보인다)
  bus.on('resumed', (r) => {
    const parts: string[] = []
    if (r.lost.includes('battle')) parts.push('진행 중이던 배틀은 취소됐어요.')
    if (r.lost.includes('sermon')) parts.push('듣던 설교는 끝났어요.')
    if (r.lost.includes('talk')) parts.push('하던 대화는 닫혔어요.')
    let head = ''
    if (r.idle) head = r.same ? '' : '자리를 비운 사이 잠시 나가 있었어요. 다시 들어왔습니다.'
    else if (parts.length > 0) head = '연결이 잠깐 끊겼다 돌아왔어요.'
    const text = [head, ...parts].filter(Boolean).join(' ')
    if (text) window.setTimeout(() => ui.toast(`📡 ${text}`, 'info', 5200), 600)
  })

  // 가려던 방이 가득 차 다른 방으로 왔을 때: 친구 링크로 왔다면 친구가 여기 없다는 뜻이므로 꼭 알려 준다
  bus.on('redirected', ({ from }) => {
    const here = store.room?.name ?? '다른 방'
    const known = store.rooms.find((r) => r.id === from)
    // 방 목록을 알고 있는데 거기에 없는 방이면 '자리가 없다'가 아니라 '지금 열려 있지 않다'가 맞다(예전 링크의 방 번호 등)
    const text =
      !known && store.rooms.length > 0
        ? `🚧 가려던 방(${from.slice(0, 8)})은 지금 열려 있지 않아서 「${here}」에 들어왔어요.`
        : `🚧 가려던 ${known?.name ?? `${from}번 출구`}에 자리가 없어서 「${here}」에 들어왔어요. 방 목록에서 자리가 나면 옮길 수 있어요.`
    window.setTimeout(() => ctx.ui.toast(text, 'info', 6500), 900)
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
    // 첫 신도를 얻는 순간에는 승급(영향력 30)도 같이 오는 일이 많다 → 결과 배너·헌납 카드·업적 배너가 지나간 뒤 마지막에 띄운다.
    // 소리·불꽃도 카드가 뜰 때 같이 나야 "무엇을 축하하는지" 이어진다
    stagePlay(3, RANK_MS, (done) => {
      if (store.phase !== 'playing') {
        done()
        return
      }
      playSfx(ctx, 'rank')
      const me = store.me
      if (me) {
        try {
          ctx.fx.burst('rank', me.x, me.y, me.z)
        } catch {
          /* 이펙트 실패는 무시 */
        }
      }
      showRank(def, done)
      // 카드가 떠 있는 동안 다음 포교 결과 배너가 뜨면 비켜 준다(stage.ts)
      return hideRank
    })
  })

  resetNames()
  applyPhase()
}
