/**
 * HUD: 프로필 칩 · 영향력/신도 · 방 칩(실제 접속자 vs NPC 구분) · 메뉴 · 상황 버튼 · 방 목록 패널.
 *
 * 설계 메모
 *  - 표시 값은 이벤트가 올 때 + 0.5초마다 store 에서 다시 읽어 "바뀐 것만" DOM 에 쓴다.
 *    (다른 모듈이 이벤트 발행을 빠뜨려도 화면이 틀린 채로 남지 않게 하려는 안전망)
 *  - 상황 버튼은 id 로 DOM 을 재사용한다. 0.5초마다 통째로 다시 만들면 손가락이 눌린 사이에
 *    버튼이 바뀌어 탭이 씹히기 때문이다.
 *  - 터치/PC 배치 차이는 최상위(#ui)의 `hud-touch` 클래스 하나로 CSS 가 처리한다.
 */
import './hud.css'
import { ROOM_CAPACITY } from '../../../shared/constants'
import { CULT_COLORS, CULT_EMBLEMS, MAX_RANK, PRESTIGE_STEP, RANKS, nextPrestigeInf, prestigeOf, rankTitle } from '../../../shared/content/core'
import type { RankDef } from '../../../shared/content/types'
import type { RoomInfo } from '../../../shared/types'
import type { AppContext, ContextAction, SfxName } from '../core/contracts'
import { bindCooldown, clear, fmt, h, hex, onContextRefresh, onPress } from './kit'

// ───────────────────────── 형제 모듈(talk/emotes/system/profile)과 같이 쓰는 도우미 ─────────────────────────

/** 효과음은 게임 진행에 필수가 아니므로 실패해도 조용히 넘어간다 */
export function playSfx(ctx: AppContext, name: SfxName): void {
  try {
    ctx.sfx.play(name)
  } catch {
    /* 소리 실패는 무시 */
  }
}

/** 글자를 입력하는 중인지 — 단축키가 닉네임 입력 같은 타이핑을 가로채면 안 된다 */
export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function rankDef(rank: number): RankDef {
  return RANKS[Math.max(0, Math.min(RANKS.length - 1, Math.floor(rank) || 0))] ?? RANKS[0]!
}

export function rankName(rank: number): string {
  return rankDef(rank).name
}

/** 다음 직급까지의 진행도. 최고 직급이면 next = null, ratio = 1 */
export function rankProgress(inf: number, rank: number): { cur: RankDef; next: RankDef | null; ratio: number; left: number } {
  const cur = rankDef(rank)
  const next = RANKS[cur.id + 1] ?? null
  if (!next) return { cur, next: null, ratio: 1, left: 0 }
  const span = Math.max(1, next.inf - cur.inf)
  const ratio = Math.max(0, Math.min(1, (inf - cur.inf) / span))
  return { cur, next, ratio, left: Math.max(0, next.inf - inf) }
}

/** 배경색 위에 올릴 글자색(밝은 배경이면 먹색, 어두우면 흰색) */
export function inkOn(color: number): string {
  const r = (color >> 16) & 255
  const g = (color >> 8) & 255
  const b = color & 255
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#241b35' : '#ffffff'
}

/** 바깥을 누르거나 Esc 로 닫히는 작은 시트/팝오버 */
export interface Popup {
  readonly open: boolean
  show(): void
  /** silent: 닫힘 소리를 내지 않는다(항목을 골라 닫힐 때 — 고른 동작의 소리와 겹치지 않게) */
  hide(silent?: boolean): void
  toggle(): void
}

const popups = new Set<Popup>()

/** 내 시트/팝오버 중 하나라도 열려 있는지(단축키 판단용) */
export function anyPopupOpen(): boolean {
  for (const p of popups) if (p.open) return true
  return false
}

export function closePopups(except?: Popup): void {
  for (const p of popups) if (p !== except && p.open) p.hide()
}

/**
 * el 을 팝업으로 만든다. 한 번에 하나만 열리고, 바깥 탭/Esc 로 닫힌다.
 * anchors: 팝업을 여닫는 버튼들(바깥 탭 판정에서 제외 — 안 그러면 닫히자마자 다시 열린다)
 */
export function makePopup(
  ctx: AppContext,
  el: HTMLElement,
  opts: { anchors?: HTMLElement[] | (() => HTMLElement[]); onShow?: () => void; onHide?: () => void } = {},
): Popup {
  let open = false
  const anchors = (): HTMLElement[] => (typeof opts.anchors === 'function' ? opts.anchors() : (opts.anchors ?? []))
  const onDown = (e: PointerEvent): void => {
    const t = e.target as Node | null
    if (!t) return
    if (el.contains(t)) return
    for (const a of anchors()) if (a.contains(t)) return
    popup.hide()
  }
  // Esc 한 번에는 맨 위의 것 하나만 닫는다: 대화 창 위에 메뉴 팝업이 떠 있으면 팝업만 닫고 대화는 남긴다.
  // 캡처 단계에서 먼저 받아 전파를 끊는다(대화 창의 Esc 처리기가 같은 키로 대화까지 끝내지 않게)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !open) return
    popup.hide()
    e.stopImmediatePropagation()
  }
  const popup: Popup = {
    get open() {
      return open
    },
    show() {
      if (open) return
      closePopups(popup)
      open = true
      el.classList.remove('hidden')
      for (const a of anchors()) a.classList.add('active')
      // 캡처 단계에서 듣는다: 캔버스(입력 모듈)가 이벤트를 먹어도 닫을 수 있어야 한다
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('keydown', onKey, true)
      playSfx(ctx, 'open')
      opts.onShow?.()
    },
    hide(silent = false) {
      if (!open) return
      open = false
      el.classList.add('hidden')
      for (const a of anchors()) a.classList.remove('active')
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      if (!silent) playSfx(ctx, 'close')
      opts.onHide?.()
    },
    toggle() {
      if (open) popup.hide()
      else popup.show()
    },
  }
  el.classList.add('hidden')
  popups.add(popup)
  return popup
}

/**
 * 마우스로 누른 버튼에 포커스가 남으면 Space 가 그 버튼을 또 눌러 버린다(상황 버튼 대신).
 * 포인터로 누른 경우에만 포커스를 풀어 준다(키보드 탐색 사용자의 포커스는 건드리지 않는다).
 */
export function blurAfterPointerClick(container: HTMLElement): void {
  container.addEventListener('click', (e) => {
    if (e.detail === 0) return
    const btn = (e.target as HTMLElement | null)?.closest('button')
    if (btn && container.contains(btn)) btn.blur()
  })
}

function detectTouch(): boolean {
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true
    return navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer: fine)').matches
  } catch {
    return 'ontouchstart' in window
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

function setTitle(el: HTMLElement, text: string): void {
  if (el.title !== text) el.title = text
}

/** 방 이름에서 역 이름을 뗀 짧은 표기(좁은 화면용): '수상역 1번 출구' → '1번 출구' */
function shortRoomName(name: string): string {
  const s = name.replace(/^\S+역\s+/, '')
  return s || name
}

const MAX_SMALL_ACTIONS = 4
const MORE_ID = '__more'

interface ActionView {
  btn: HTMLButtonElement
  icon: HTMLElement
  label: HTMLElement
  readyAt: number
}

export function mountHud(ctx: AppContext): void {
  const { store, bus, ui } = ctx
  const root = ui.root
  const click = (): void => playSfx(ctx, 'click')

  // ───────── 터치 배치 판별 ─────────
  const applyTouch = (on: boolean): void => {
    root.classList.toggle('hud-touch', on)
  }
  applyTouch(detectTouch())
  try {
    window.matchMedia('(pointer: coarse)').addEventListener('change', () => applyTouch(detectTouch()))
  } catch {
    /* 구형 브라우저: 처음 판별값 유지 */
  }
  // 터치 노트북처럼 판별이 애매한 기기는 실제 첫 터치에서 터치 배치로 바꾼다
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') applyTouch(true)
    },
    { passive: true, capture: true },
  )

  // ───────── 상단: 프로필 / 영향력 / 신도 ─────────
  const emblem = h('span.hud-emblem')
  const nameEl = h('span.hud-name')
  const rankEl = h('span.hud-rank')
  const profileBtn = h(
    'button.chip.hud-profile',
    {
      type: 'button',
      'aria-label': '내 프로필 열기',
      onclick: () => {
        click()
        ui.openPanel('profile')
      },
    },
    emblem,
    h('span.hud-profile-text', nameEl, rankEl),
  )

  const infNum = h('b.hud-num')
  const infNext = h('span.hud-inf-next')
  const infFill = h('i')
  const infChip = h('div.chip.hud-stat.hud-inf', h('span.hud-stat-icon', '✨'), h('span.hud-stat-label', '영향력'), infNum, infNext, h('span.bar.hud-inf-bar', infFill))

  const folNum = h('b.hud-num')
  const folWith = h('span.hud-fol-with')
  const folChip = h('div.chip.hud-stat.hud-fol', h('span.hud-stat-icon', '🙏'), h('span.hud-stat-label', '신도'), folNum, folWith)

  // ───────── 상단: 방 칩 / 네트워크 / 메뉴 ─────────
  const netDot = h('i.hud-net-dot')
  const netLabel = h('span.hud-net-label')
  const roomFull = h('span.hud-room-full')
  const roomShort = h('span.hud-room-short')
  const realCount = h('span.hud-count')
  const npcCount = h('span.hud-count')
  const roomBtn = h(
    'button.chip.hud-room',
    {
      type: 'button',
      'aria-label': '방 목록 열기',
      onclick: () => {
        click()
        ui.openPanel('rooms')
      },
    },
    netDot,
    h('span.hud-room-text', h('span.hud-room-name', roomFull, roomShort), h('span.hud-room-sep', '·'), h('span.hud-room-counts', realCount, h('span.hud-room-sep', '·'), npcCount)),
  )
  // 👤/🤖 가 무엇인지 헷갈리지 않게: 마우스를 올리면 범례가 뜬다(탭하면 방 패널 맨 위에 같은 설명)
  const legend = h('div.hud-legend', { 'aria-hidden': 'true' }, '👤 접속자 · 🤖 NPC')
  const netChip = h('div.chip.hud-net.hidden', { role: 'status' }, h('i.hud-net-dot.bad.pulse'), netLabel)

  const menuBadge = h('span.badge.hud-menu-badge.hidden')
  const menuBtn = h('button.icon-btn.hud-menu-btn', { type: 'button', 'aria-label': '메뉴', 'aria-haspopup': 'true' }, '☰', menuBadge)
  const menuBox = h('div.hud-menu.interactive', { role: 'menu' })

  // 그리드 배치(hud.css): 첫 줄 = 프로필 | 방·메뉴, 둘째 줄 = 영향력·신도(화면 폭 전체 사용)
  const top = h('div.hud-top', profileBtn, h('div.hud-right', netChip, h('div.hud-room-wrap', roomBtn, legend), menuBtn), h('div.hud-stats', infChip, folChip))

  // ───────── 하단 오른쪽: 상황 버튼 ─────────
  // 이모트 모듈이 터치용 버튼(이모트/도망/말풍선)을 끼워 넣는 자리. 상황 버튼 줄 수가 바뀌어도 겹치지 않게 같은 흐름에 둔다.
  const dockSlot = h('div.hud-dock-slot')
  const actionsEl = h('div.hud-actions')
  const dock = h('div.hud-dock', dockSlot, actionsEl)
  const moreBox = h('div.hud-more.interactive', { role: 'menu' })

  const hud = h('div.hud.hidden', top, menuBox, dock, moreBox)
  root.append(hud)
  blurAfterPointerClick(hud)

  // 토스트/소식 피드가 HUD 와 겹치지 않도록 HUD 아래쪽 위치를 CSS 변수로 알린다(줄바꿈으로 높이가 변해도 따라간다)
  const publishBottom = (): void => {
    const r = top.getBoundingClientRect()
    if (r.height > 0) root.style.setProperty('--hud-bottom', Math.round(r.bottom) + 'px')
    else root.style.removeProperty('--hud-bottom')
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(publishBottom).observe(top)
  window.addEventListener('resize', publishBottom)

  // ───────── 표시 값 동기화 ─────────
  let lastEmblemColor = -2
  let lastBar = -1
  let lastNet = ''

  function population(): { players: number; npcs: number; cap: number } {
    const room = store.room
    const cap = room?.cap ?? ROOM_CAPACITY
    // 접속 중이면 실제 목록 크기가 가장 정확하다(방 정보는 입장 시점 값일 수 있다)
    if (store.me) return { players: store.players.size + 1, npcs: store.npcs.size, cap }
    return { players: room?.players ?? 0, npcs: room?.npcs ?? 0, cap }
  }

  function sync(): void {
    const me = store.me
    const prog = me?.prog
    const cult = prog?.cult ?? null

    setText(nameEl, store.profile.name)
    // 최고 직급 뒤에는 '우주급 절대교주 N회차'(칭호만 오르는 끝없는 회차)
    setText(rankEl, rankTitle(prog?.rank ?? 0, prog?.inf ?? 0))
    setText(emblem, cult ? (CULT_EMBLEMS[cult.emblem] ?? '🚩') : '🙂')
    const color = cult ? cult.color : -1
    if (color !== lastEmblemColor) {
      lastEmblemColor = color
      emblem.style.background = cult ? hex(CULT_COLORS[cult.color] ?? 0xffd23f) : ''
    }
    setTitle(profileBtn, cult ? `${cult.name} · ${cult.title}` : '내 프로필')

    const inf = prog?.inf ?? 0
    const rp = rankProgress(inf, prog?.rank ?? 0)
    setText(infNum, fmt(inf))
    // 최고 직급이면 막대는 다음 회차까지의 진행도를 보여 준다
    const atMax = !rp.next && (prog?.rank ?? 0) >= MAX_RANK
    const prestigeAt = atMax ? nextPrestigeInf(inf) : 0
    setText(infNext, rp.next ? '/' + fmt(rp.next.inf) : atMax ? '/' + fmt(prestigeAt) : '')
    const ratio = atMax ? Math.max(0, Math.min(1, 1 - (prestigeAt - inf) / PRESTIGE_STEP)) : rp.ratio
    const pct = Math.round(ratio * 100)
    if (pct !== lastBar) {
      lastBar = pct
      infFill.style.width = pct + '%'
    }
    setTitle(
      infChip,
      rp.next
        ? `다음 직급 '${rp.next.name}'까지 영향력 ${fmt(rp.left)}`
        : atMax
          ? `${prestigeOf(inf) + 1}회차까지 영향력 ${fmt(prestigeAt - inf)} (칭호만 바뀌어요)`
          : '최고 직급에 도달했어요',
    )
    infChip.classList.toggle('max', !rp.next)

    setText(folNum, fmt(prog?.fol ?? 0))
    const ent = me?.entourage ?? 0
    setText(folWith, ent > 0 ? `(동행 ${ent})` : '')
    setTitle(folChip, ent > 0 ? `누적 신도 ${fmt(prog?.fol ?? 0)}명 · 지금 따라다니는 신도 ${ent}명` : `누적 신도 ${fmt(prog?.fol ?? 0)}명`)

    const room = store.room
    const pop = population()
    const full = room?.name ?? '수상역'
    setText(roomFull, full)
    setText(roomShort, shortRoomName(full))
    setText(realCount, `👤 ${pop.players}/${pop.cap}`)
    setText(npcCount, `🤖 ${pop.npcs}`)
    setTitle(roomBtn, `${full} — 실제 접속자 ${pop.players}명(정원 ${pop.cap}), NPC ${pop.npcs}명`)

    const reconnecting = store.phase === 'reconnecting'
    const rtt = store.rtt
    const quality = reconnecting ? 'bad pulse' : rtt <= 0 || rtt < 160 ? 'good' : rtt < 380 ? 'ok' : 'bad'
    if (quality !== lastNet) {
      lastNet = quality
      netDot.className = 'hud-net-dot ' + quality
    }
    setTitle(netDot, reconnecting ? '재접속 중' : rtt > 0 ? `응답 속도 ${Math.round(rtt)}ms` : '연결됨')
    netChip.classList.toggle('hidden', !reconnecting)
    setText(netLabel, reconnecting ? '재접속 중' : '')

    let badge = false
    for (const item of ui.menuItems) {
      try {
        if (item.badge?.()) {
          badge = true
          break
        }
      } catch {
        /* 배지 계산 실패는 배지 없음으로 */
      }
    }
    menuBadge.classList.toggle('hidden', !badge)
  }

  // ───────── 메뉴(☰) ─────────
  const menu = makePopup(ctx, menuBox, {
    anchors: [menuBtn],
    onShow: renderMenu,
    onHide: () => clear(menuBox),
  })
  menuBtn.addEventListener('click', () => {
    click()
    menu.toggle()
  })

  function renderMenu(): void {
    clear(menuBox)
    // 다른 모듈이 나중에 항목을 추가하므로 열 때마다 새로 그린다
    const items = ui.menuItems
    if (items.length === 0) {
      menuBox.append(h('p.small.muted.center.hud-menu-empty', '아직 메뉴가 준비되지 않았어요.'))
      return
    }
    for (const item of items) {
      let badge: number | boolean = false
      try {
        badge = item.badge?.() ?? false
      } catch {
        badge = false
      }
      menuBox.append(
        h(
          'button.hud-menu-item',
          {
            type: 'button',
            role: 'menuitem',
            onclick: () => {
              click()
              menu.hide(true)
              try {
                item.onClick()
              } catch (err) {
                console.error('[hud] menu item error', item.id, err)
              }
            },
          },
          h('span.hud-menu-icon', item.icon),
          h('span.hud-menu-label', item.label),
          badge ? h('span.badge', typeof badge === 'number' ? (badge > 99 ? '99+' : String(badge)) : '!') : null,
        ),
      )
    }
  }

  // ───────── 상황 버튼 ─────────
  const views = new Map<string, ActionView>()
  let current = new Map<string, ContextAction>()
  let primaryId: string | null = null
  let overflow: ContextAction[] = []
  let lastOrder = ''
  let lastMoreSig = ''
  const warned = new WeakSet<object>()

  const more = makePopup(ctx, moreBox, {
    // '⋯' 버튼은 그때그때 만들어지므로 열려 있는 시점의 버튼을 찾아 준다
    anchors: () => {
      const v = views.get(MORE_ID)
      return v ? [v.btn] : []
    },
    onShow: renderMore,
    onHide: () => clear(moreBox),
  })

  function gather(): ContextAction[] {
    const out: ContextAction[] = []
    const seen = new Set<string>()
    for (const provider of ui.contextProviders) {
      let res: ReturnType<typeof provider>
      try {
        res = provider()
      } catch (err) {
        // 제공자 하나가 터져도 다른 버튼은 떠야 한다. 같은 오류로 콘솔이 도배되지 않게 한 번만 알린다
        if (!warned.has(provider)) {
          warned.add(provider)
          console.error('[hud] context provider error', err)
        }
        continue
      }
      if (!res) continue
      for (const a of Array.isArray(res) ? res : [res]) {
        if (!a || typeof a.id !== 'string' || seen.has(a.id)) continue
        seen.add(a.id)
        out.push(a)
      }
    }
    return out
  }

  function trigger(id: string): void {
    if (id === MORE_ID) {
      click()
      more.toggle()
      return
    }
    const a = current.get(id)
    if (!a || a.disabled) return
    if (a.readyAt !== undefined && a.readyAt > performance.now()) return
    click()
    try {
      a.onClick()
    } catch (err) {
      console.error('[hud] context action error', id, err)
    }
    // 누른 결과(쿨타임, 버튼 교체)가 다음 0.5초 틱을 기다리지 않고 바로 보이게
    ui.refreshContext()
  }

  function viewFor(id: string): ActionView {
    let v = views.get(id)
    if (!v) {
      const icon = h('span.hud-action-icon')
      const label = h('small.hud-action-label')
      const btn = h('button.round-btn.hud-action', { type: 'button' }, icon, label, h('kbd.hud-key', { 'aria-hidden': 'true' }, 'E'))
      // 조이스틱을 누른 채로도 눌리도록 터치는 pointerup 에서 처리한다
      onPress(btn, () => trigger(id))
      v = { btn, icon, label, readyAt: 0 }
      views.set(id, v)
    }
    return v
  }

  function paint(v: ActionView, a: { icon: string; label: string; primary?: boolean; disabled?: boolean; readyAt?: number }): void {
    setText(v.icon, a.icon)
    setText(v.label, a.label)
    v.btn.classList.toggle('primary', !!a.primary)
    v.btn.classList.toggle('long', Array.from(a.label).length > 5)
    if (v.btn.disabled !== !!a.disabled) v.btn.disabled = !!a.disabled
    v.btn.setAttribute('aria-label', a.label)
    const readyAt = a.readyAt ?? 0
    if (readyAt !== v.readyAt) {
      v.readyAt = readyAt
      bindCooldown(v.btn, readyAt)
    }
  }

  function refreshActions(): void {
    const active = store.phase === 'playing' && !store.talk
    // 대화 시트가 열린 동안에는 하단 버튼들을 치운다(이모트 바도 이 클래스를 본다)
    root.classList.toggle('hud-talking', !!store.talk)
    const list = active ? gather() : []
    const pIdx = list.findIndex((a) => a.primary)
    const primary = pIdx >= 0 ? list[pIdx]! : null
    const rest = list.filter((_, i) => i !== pIdx)
    let shown = rest
    let extra: ContextAction[] = []
    if (rest.length > MAX_SMALL_ACTIONS) {
      shown = rest.slice(0, MAX_SMALL_ACTIONS - 1)
      extra = rest.slice(MAX_SMALL_ACTIONS - 1)
    }

    current = new Map(list.map((a) => [a.id, a]))
    primaryId = primary ? primary.id : null
    overflow = extra

    const order: string[] = []
    if (primary) {
      paint(viewFor(primary.id), primary)
      order.push(primary.id)
    }
    for (const a of shown) {
      paint(viewFor(a.id), { ...a, primary: false })
      order.push(a.id)
    }
    if (extra.length > 0) {
      paint(viewFor(MORE_ID), { icon: '⋯', label: '더보기' })
      order.push(MORE_ID)
    }

    // 순서가 그대로면 DOM 을 건드리지 않는다(누르는 중인 버튼이 옮겨지면 탭이 취소된다)
    const key = order.join('|')
    if (key !== lastOrder) {
      lastOrder = key
      const keep = new Set(order)
      for (const [id, v] of views) {
        if (keep.has(id)) continue
        bindCooldown(v.btn, 0)
        v.btn.remove()
        views.delete(id)
      }
      actionsEl.replaceChildren(...order.map((id) => views.get(id)!.btn))
    }

    if (extra.length === 0) {
      if (more.open) more.hide()
    } else if (more.open) {
      const sig = extra.map((a) => `${a.id}:${a.label}:${a.icon}:${a.disabled ? 1 : 0}:${a.readyAt ?? 0}`).join('|')
      if (sig !== lastMoreSig) renderMore()
    }
  }

  function renderMore(): void {
    clear(moreBox)
    lastMoreSig = overflow.map((a) => `${a.id}:${a.label}:${a.icon}:${a.disabled ? 1 : 0}:${a.readyAt ?? 0}`).join('|')
    for (const a of overflow) {
      const btn = h(
        'button.btn.block.hud-more-item',
        {
          type: 'button',
          disabled: !!a.disabled,
          onclick: () => {
            more.hide(true)
            trigger(a.id)
          },
        },
        h('span.hud-menu-icon', a.icon),
        h('span.hud-menu-label', a.label),
      )
      if (a.readyAt !== undefined && a.readyAt > performance.now()) bindCooldown(btn, a.readyAt)
      moreBox.append(btn)
    }
  }

  // E / Space = 큰 상황 버튼. e.code 로 본다(한글 입력 상태에서는 e.key 가 'ㄷ' 으로 온다)
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' && e.code !== 'Space') return
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    if (store.phase !== 'playing' || store.talk || ui.openPanelId || isTyping() || anyPopupOpen()) return
    if (root.querySelector('.confirm-layer')) return
    if (!primaryId) return
    // Space 의 기본 동작(포커스된 버튼 누르기, 스크롤)을 막고 상황 버튼으로 돌린다
    e.preventDefault()
    const v = views.get(primaryId)
    if (v) {
      v.btn.classList.add('active')
      setTimeout(() => v.btn.classList.remove('active'), 120)
    }
    trigger(primaryId)
  })

  // ───────── 방 목록 패널 ─────────
  ui.registerPanel({
    id: 'rooms',
    title: '방 고르기',
    render(body, close) {
      const list = h('div.col.hud-rooms-list')
      const status = h('p.small.muted.center.hud-rooms-status')
      const linkField = h('input.field.hud-invite-field.hidden', {
        type: 'text',
        readOnly: true,
        'aria-label': '친구 초대 링크',
        onfocus: (e: Event) => (e.target as HTMLInputElement).select(),
      })
      const inviteUrl = (): string => {
        const id = store.room?.id
        return location.origin + location.pathname + (id ? '?room=' + encodeURIComponent(id) : '')
      }
      const copyBtn = h(
        'button.btn.purple.block',
        {
          type: 'button',
          onclick: () => {
            click()
            const url = inviteUrl()
            const fallback = (): void => {
              // 클립보드를 못 쓰는 환경(인앱 브라우저 등): 링크를 보여 주고 직접 복사하게 한다
              linkField.value = url
              linkField.classList.remove('hidden')
              linkField.focus()
              linkField.select()
              ui.toast('링크를 길게 눌러 복사해 주세요.', 'info')
            }
            try {
              if (!navigator.clipboard?.writeText) return fallback()
              navigator.clipboard.writeText(url).then(() => ui.toast('초대 링크를 복사했어요. 친구에게 보내 보세요!', 'good'), fallback)
            } catch {
              fallback()
            }
          },
        },
        '🔗 친구 초대 링크 복사',
      )

      let failed = false
      let loaded = store.rooms.length > 0
      let lastSig = ''

      const draw = (): void => {
        const hereId = store.room?.id ?? null
        const pop = population()
        const rooms: RoomInfo[] = store.rooms.map((r) => (r.id === hereId && store.me ? { ...r, players: pop.players, npcs: pop.npcs } : r))
        const sig = (failed ? 'F' : '') + (loaded ? 'L' : '') + hereId + '|' + rooms.map((r) => `${r.id}:${r.name}:${r.players}:${r.cap}:${r.npcs}`).join('|')
        if (sig === lastSig) return
        lastSig = sig
        clear(list)
        if (rooms.length === 0) {
          setText(status, failed ? '방 목록을 불러오지 못했어요. 잠시 뒤에 다시 열어 주세요.' : '방 목록을 불러오는 중…')
          status.classList.remove('hidden')
          return
        }
        setText(status, failed ? '최신 목록을 받지 못했어요. 조금 전 정보를 보여 드려요.' : '')
        status.classList.toggle('hidden', !failed)
        for (const r of rooms) {
          const here = r.id === hereId
          const isFull = r.players >= r.cap
          const fill = h('i')
          fill.style.width = Math.round(Math.min(1, r.players / Math.max(1, r.cap)) * 100) + '%'
          list.append(
            h(
              'div.card.flat.hud-room-row',
              { class: (here ? 'here ' : '') + (isFull ? 'full' : '') },
              h(
                'div.grow.hud-room-info',
                h('div.hud-room-title', h('b', r.name), here ? h('span.tag.real', '지금 여기') : isFull ? h('span.tag', '만원') : null),
                h('div.hud-room-nums', h('span', `👤 ${r.players}/${r.cap}`), h('span.muted', `🤖 ${r.npcs}`), h('span.bar.hud-room-bar', { class: isFull ? 'gold' : '' }, fill)),
              ),
              here
                ? null
                : h(
                    'button.btn.sm.primary',
                    {
                      type: 'button',
                      disabled: isFull,
                      onclick: () => {
                        click()
                        close()
                        ctx.actions.switchRoom(r.id)
                      },
                    },
                    isFull ? '가득 참' : '이 방으로 이동',
                  ),
            ),
          )
        }
      }

      const refresh = (): void => {
        let p: Promise<void>
        try {
          p = ctx.net.refreshRooms()
        } catch {
          p = Promise.reject(new Error('refreshRooms failed'))
        }
        p.then(
          () => {
            // 실패를 조용히 삼키는 구현도 있다 → 끝났는데도 목록이 비어 있으면 실패로 본다
            failed = store.rooms.length === 0
            loaded = true
            draw()
          },
          () => {
            failed = true
            draw()
          },
        )
      }

      body.append(
        h(
          'div.col.hud-rooms',
          h('p.small.muted.hud-rooms-legend', '👤 실제 접속자 · 🤖 NPC(컴퓨터가 움직이는 시민)'),
          status,
          list,
          h('div.col.hud-invite', copyBtn, linkField, h('p.small.muted.center', '링크를 받은 친구는 바로 이 방으로 들어와요.')),
        ),
      )
      draw()
      refresh()
      const timer = window.setInterval(refresh, 5000)
      const offRooms = bus.on('rooms', draw)
      const offPop = bus.on('population', draw)
      return () => {
        clearInterval(timer)
        offRooms()
        offPop()
      }
    },
  })

  // ───────── 화면 단계 / 이벤트 ─────────
  function applyPhase(): void {
    const visible = store.phase === 'playing' || store.phase === 'reconnecting'
    hud.classList.toggle('hidden', !visible)
    if (!visible) closePopups()
    sync()
    refreshActions()
    publishBottom()
  }

  bus.on('phase', applyPhase)
  bus.on('entered', applyPhase)
  bus.on('progress', sync)
  bus.on('profile', sync)
  bus.on('rankUp', sync)
  bus.on('population', sync)
  bus.on('net', sync)
  bus.on('playerJoin', sync)
  bus.on('playerLeave', sync)
  bus.on('npcUpdate', sync)
  bus.on('near', refreshActions)
  bus.on('talk', refreshActions)
  onContextRefresh(refreshActions)

  window.setInterval(() => {
    if (store.phase !== 'playing' && store.phase !== 'reconnecting') return
    sync()
    refreshActions()
  }, 500)

  applyPhase()
}
