/**
 * 부트 카드. "첫 화면 메뉴"가 아니다 — 링크를 열면 탭 0번으로 바로 입장한다(조사 01 §4-1, §7.1).
 * 접속하는 몇 초 동안만 3D 거리 위에 작은 카드로 떠 있다가 입장하면 사라진다.
 * 닉네임 입력·아바타 선택·약관 창은 일부러 두지 않는다(프로필 패널에서 원하는 사람만 나중에 바꾼다).
 */
import './title.css'
import { DISCLAIMER, LOADING_TIPS } from '../../../shared/content/misc'
import { roomFromUrl } from '../core/config'
import type { AppContext } from '../core/contracts'
import { playSfx } from './hud'
import { h } from './kit'

const TIP_ROTATE_MS = 3800
const FADE_MS = 450

export function mountTitle(ctx: AppContext): void {
  const { store, bus } = ctx

  const who = h('b.title-who')
  const tipText = h('span.title-tip-text')

  const enter = (): void => {
    // 친구 초대 링크(?room=)가 최우선. 없으면 서버가 사람 있는 방을 골라 준다
    ctx.actions.enter(roomFromUrl() ?? 'auto')
  }

  // 10초가 지나면 CSS 애니메이션만으로 나타난다(JS 타이머가 밀려도 뜬다). 지연 시간은 --title-slow-delay 로 조절
  const slowText = h('span.title-slow-text', '출구가 조금 붐비나 봐요.')
  const slow = h(
    'div.title-slow',
    slowText,
    h(
      'button.btn.primary.sm',
      {
        type: 'button',
        onclick: () => {
          playSfx(ctx, 'click')
          restartSlowTimer()
          enter()
        },
      },
      '다시 시도',
    ),
  )

  const loading = h(
    'div.title-load',
    h(
      'div.title-track',
      { 'aria-hidden': 'true' },
      h('span.title-station', '🚇'),
      h('span.title-rail', h('span.title-walker', '🚶')),
      h('span.title-exit', '4'),
    ),
    h('p.title-status', { role: 'status' }, who, '님, 4번 출구로 나가는 중', h('span.title-dots', { 'aria-hidden': 'true' }, h('i', '.'), h('i', '.'), h('i', '.'))),
    slow,
  )

  // 게임에서 스스로 나왔을 때(exitToTitle)만 보이는 쉬는 화면. 이때는 자동으로 다시 들여보내지 않는다
  const resting = h(
    'div.title-rest.hidden',
    h('p.title-status', '잠깐 쉬는 중이에요. 거리는 그대로 있어요.'),
    h(
      'button.btn.primary.big',
      {
        type: 'button',
        onclick: () => {
          playSfx(ctx, 'click')
          ctx.actions.enter(store.profile.lastRoom ?? roomFromUrl() ?? 'auto')
        },
      },
      '다시 포교하러 가기',
    ),
  )

  const card = h(
    'div.card.title-card',
    h('span.title-tape', { 'aria-hidden': 'true' }),
    h('span.title-badge', '수상역 4번 출구 앞'),
    h('h1.title-logo', h('span', '도를 아십니까'), h('em', '?')),
    h('div.title-sub', '교주 시뮬레이터'),
    loading,
    resting,
    h('p.title-tip', h('span.title-tip-icon', { 'aria-hidden': 'true' }, '💡'), tipText),
    h('p.title-disclaimer', DISCLAIMER),
  )
  const screen = h('div.title-screen.hidden', card)
  ctx.ui.root.append(screen)

  // ───────── 팁 돌려 보여 주기 ─────────
  let tipIdx = Math.floor(Math.random() * Math.max(1, LOADING_TIPS.length))
  let tipTimer = 0
  const showTip = (): void => {
    tipText.textContent = LOADING_TIPS[tipIdx % Math.max(1, LOADING_TIPS.length)] ?? ''
  }
  const startTips = (): void => {
    if (tipTimer || LOADING_TIPS.length < 2) return
    tipTimer = window.setInterval(() => {
      tipIdx++
      tipText.classList.add('swap')
      window.setTimeout(() => {
        showTip()
        tipText.classList.remove('swap')
      }, 180)
    }, TIP_ROTATE_MS)
  }
  const stopTips = (): void => {
    clearInterval(tipTimer)
    tipTimer = 0
  }
  showTip()

  function restartSlowTimer(): void {
    // 애니메이션을 처음부터 다시 돌리려면 노드를 뗐다 붙이는 것이 가장 확실하다(레이아웃 읽기 없이)
    const next = slow.nextSibling
    slow.remove()
    loading.insertBefore(slow, next)
  }

  // ───────── 표시 상태 ─────────
  let hideTimer = 0
  let visible = false

  function show(mode: 'loading' | 'resting'): void {
    clearTimeout(hideTimer)
    who.textContent = store.profile.name
    loading.classList.toggle('hidden', mode !== 'loading')
    resting.classList.toggle('hidden', mode !== 'resting')
    if (!visible || screen.classList.contains('out')) {
      visible = true
      screen.classList.remove('hidden', 'out')
      if (mode === 'loading') restartSlowTimer()
    }
    startTips()
  }

  function hide(): void {
    if (!visible) return
    visible = false
    stopTips()
    screen.classList.add('out')
    clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => screen.classList.add('hidden'), FADE_MS)
  }

  let leftTitle = false
  let requested = false

  function autoEnter(): void {
    if (requested || store.phase !== 'title') return
    requested = true
    enter()
  }

  function apply(): void {
    const phase = store.phase
    if (phase !== 'title') leftTitle = true
    // 연달아 실패 중이면 기다리게 두지 않고 바로 사정을 알린다(인기가 많아 줄 선 것으로 오해하지 않게)
    const unreachable = phase === 'connecting' && store.phaseWhy === 'unreachable'
    slowText.textContent = unreachable ? '서버에 연결하지 못하고 있어요. 인터넷 연결을 확인해 주세요. 계속 다시 시도하는 중이에요.' : '출구가 조금 붐비나 봐요.'
    slow.classList.toggle('now', unreachable)
    if (phase === 'connecting') show('loading')
    else if (phase === 'title') {
      if (leftTitle) show('resting')
      else {
        show('loading')
        autoEnter()
      }
    } else hide()
  }

  bus.on('phase', apply)
  // 닉네임은 서버가 바꿔 줄 수 있다(필터/중복). 카드가 떠 있는 동안에는 따라간다
  bus.on('profile', () => {
    if (visible) who.textContent = store.profile.name
  })

  if (store.phase === 'title') {
    show('loading')
    // 같은 틱에 뒤이어 붙는 다른 UI 모듈들이 'phase' 이벤트를 놓치지 않도록, 입장은 등록이 끝난 직후에 시작한다
    queueMicrotask(autoEnter)
  } else {
    apply()
  }
}
