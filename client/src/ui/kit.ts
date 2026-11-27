/**
 * UI 공용 도구: DOM 헬퍼, 토스트, 패널(모달) 관리, 메뉴/상황 버튼 등록부.
 * 모든 UI 모듈은 이 도구와 styles/base.css 의 클래스를 써서 같은 모양을 유지한다.
 * 보안: 사용자 입력 문자열(닉네임, 교단 이름 등)은 반드시 textContent 로만 넣는다(innerHTML 금지).
 */
import type { Bus } from '../core/bus'
import type { ContextProvider, MenuItem, PanelDef, UiApi } from '../core/contracts'

type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, unknown>

/**
 * DOM 생성 헬퍼.
 *   h('button.btn.primary', { onclick: fn, title: '확인' }, '확인')
 * - 첫 인자: 'tag.class1.class2#id'
 * - attrs: on* 는 이벤트 핸들러, style 은 객체 가능, dataset 은 객체, 그 외는 속성/프로퍼티
 * - children: 문자열은 텍스트 노드(= 안전)
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}` | `${K}#${string}`,
  attrs?: Attrs | Child | Child[],
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(spec)
  const tag = (m?.[1] ?? 'div') as K
  const el = document.createElement(tag)
  const rest = m?.[2] ?? ''
  for (const part of rest.match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1))
    else el.id = part.slice(1)
  }
  let kids: (Child | Child[])[] = children
  if (attrs !== undefined && attrs !== null && attrs !== false) {
    if (attrs instanceof Node || typeof attrs === 'string' || typeof attrs === 'number' || Array.isArray(attrs)) {
      kids = [attrs as Child | Child[], ...children]
    } else {
      for (const [k, v] of Object.entries(attrs as Attrs)) {
        if (v === undefined || v === null || v === false) continue
        if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
        } else if (k === 'style' && typeof v === 'object') {
          Object.assign(el.style, v)
        } else if (k === 'dataset' && typeof v === 'object') {
          Object.assign(el.dataset, v)
        } else if (k === 'class') {
          for (const c of String(v).split(/\s+/)) if (c) el.classList.add(c)
        } else if (k in el) {
          ;(el as unknown as Record<string, unknown>)[k] = v
        } else {
          el.setAttribute(k, String(v))
        }
      }
    }
  }
  appendChildren(el, kids)
  return el
}

function appendChildren(el: Element, kids: (Child | Child[])[]): void {
  for (const k of kids) {
    if (Array.isArray(k)) appendChildren(el, k)
    else if (k === null || k === undefined || k === false) continue
    else el.append(k instanceof Node ? k : String(k))
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/** 0xRRGGBB → '#rrggbb' */
export function hex(color: number): string {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

/** 큰 수를 한국식으로 짧게: 12,345 → '1.2만' */
export function fmt(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억'
  if (n >= 10_000) return (n / 10_000).toFixed(1).replace(/\.0$/, '') + '만'
  return n.toLocaleString('ko-KR')
}

/**
 * 누름 처리. 터치는 손가락을 떼는 순간(pointerup) 바로 실행한다: 다른 손가락(조이스틱)이 화면에 닿아 있는 동안에는
 * 브라우저가 click 을 만들어 주지 않아, 달리면서 [도망]·[말 걸기]를 누를 수 없기 때문이다.
 * 마우스·키보드(Enter/Space)는 평소처럼 click 으로 처리한다.
 * 터치로 눌렀을 때 브라우저가 뒤따라 보내는 click 은 armGhostClickGuard 가 화면 전체에서 버린다(아래 설명).
 */
export function onPress(el: HTMLElement, fn: () => void): void {
  installGhostClickGuard()
  let downId = -1
  let firedAt = -1e9
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') downId = e.pointerId
  })
  el.addEventListener('pointercancel', () => {
    downId = -1
  })
  el.addEventListener('pointerup', (e) => {
    if (e.pointerId !== downId) return
    downId = -1
    if ((el as HTMLButtonElement).disabled) return
    // 버튼 밖으로 밀어서 뗐다면 취소로 본다
    const r = el.getBoundingClientRect()
    if (e.clientX < r.left - 10 || e.clientX > r.right + 10 || e.clientY < r.top - 10 || e.clientY > r.bottom + 10) return
    firedAt = performance.now()
    armGhostClickGuard(e.clientX, e.clientY)
    fn()
  })
  el.addEventListener('click', () => {
    // 터치로 이미 처리했다면 뒤따라오는 click 은 버린다
    if (performance.now() - firedAt < 700) return
    fn()
  })
}

/** 터치 누름 뒤 이 시간 안에, 이 거리 안에서 오는 click 은 그 누름이 남긴 '유령 click' 으로 본다 */
export const GHOST_CLICK_MS = 600
export const GHOST_CLICK_PX = 40

export interface GhostGuard {
  at: number
  x: number
  y: number
}

/**
 * 이 click 을 버려야 하나? (순수 함수: 단위 테스트용)
 * - 키보드(Enter/Space)·코드가 만든 click 은 detail 이 0 이다 → 손가락과 상관없으니 통과
 * - 누른 자리에서 멀리 떨어진 click, 시간이 지난 click 은 다른 손가락의 진짜 누름이다 → 통과
 */
export function isGhostClick(g: GhostGuard | null, now: number, detail: number, x: number, y: number): boolean {
  if (!g || detail === 0) return false
  if (now - g.at > GHOST_CLICK_MS || now < g.at) return false
  return Math.hypot(x - g.x, y - g.y) <= GHOST_CLICK_PX
}

let ghost: GhostGuard | null = null
let ghostInstalled = false

/**
 * 왜 필요한가: onPress 는 터치를 pointerup 에서 처리하는데, 그 안에서 시트(말풍선·이모트)가 열리면
 * 브라우저가 곧이어 보내는 호환용 click 이 '지금 손가락 밑에 새로 생긴' 타일에 떨어진다.
 * 그러면 고르지도 않은 말풍선이 방 전체에 나가거나 잠긴 동작 안내가 뜬다.
 * 그래서 터치 누름의 시각·위치를 기억해 두고, 그 자리로 곧바로 오는 click 을 캡처 단계에서 통째로 버린다.
 * 각 버튼이 따로 막는 대신 여기 한 곳에서 막으면, 누름의 결과로 손가락 밑에 무엇이 나타나든(onclick 만 쓰는 버튼 포함) 안전하다.
 * 새 손가락이 화면에 닿으면(pointerdown) 그 뒤의 click 은 새 누름의 것이므로 기억을 지운다.
 */
function installGhostClickGuard(): void {
  if (ghostInstalled || typeof window === 'undefined') return
  ghostInstalled = true
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'mouse') ghost = null
    },
    true,
  )
  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return
      if (!isGhostClick(ghost, performance.now(), e.detail, e.clientX, e.clientY)) return
      ghost = null
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true,
  )
}

function armGhostClickGuard(x: number, y: number): void {
  ghost = { at: performance.now(), x, y }
}

/** 버튼 쿨타임 표시: readyAt(performance.now 기준) 까지 비활성 + 남은 초 표시 */
export function bindCooldown(btn: HTMLElement, readyAt: number): void {
  const prev = (btn as unknown as { __cd?: number }).__cd
  if (prev) cancelAnimationFrame(prev)
  const tick = (): void => {
    const left = readyAt - performance.now()
    if (left <= 0) {
      btn.classList.remove('cooling')
      btn.removeAttribute('data-cd')
      ;(btn as unknown as { __cd?: number }).__cd = undefined
      return
    }
    btn.classList.add('cooling')
    btn.setAttribute('data-cd', String(Math.ceil(left / 1000)))
    ;(btn as unknown as { __cd?: number }).__cd = requestAnimationFrame(tick)
  }
  tick()
}

export function createUi(root: HTMLElement, bus: Bus): UiApi {
  const toastBox = h('div.toasts', { 'aria-live': 'polite' })
  const panelLayer = h('div.panel-layer.hidden')
  root.append(toastBox, panelLayer)

  const panels = new Map<string, PanelDef>()
  const menuItems: MenuItem[] = []
  const providers: ContextProvider[] = []
  let openId: string | null = null
  let cleanup: void | (() => void)

  function closePanel(): void {
    if (!openId) return
    try {
      if (typeof cleanup === 'function') cleanup()
    } catch (err) {
      console.error('[ui] panel cleanup error', err)
    }
    cleanup = undefined
    openId = null
    clear(panelLayer)
    panelLayer.classList.add('hidden')
  }

  function openPanel(id: string): void {
    const def = panels.get(id)
    if (!def) {
      console.warn('[ui] unknown panel', id)
      return
    }
    closePanel()
    openId = id
    const body = h('div.panel-body')
    const win = h(
      'div.panel',
      { class: def.wide ? 'wide' : '', role: 'dialog', 'aria-label': def.title },
      h('div.panel-head', h('div.panel-title', def.title), h('button.icon-btn.panel-close', { 'aria-label': '닫기', onclick: closePanel }, '✕')),
      body,
    )
    panelLayer.append(win)
    panelLayer.classList.remove('hidden')
    try {
      cleanup = def.render(body, closePanel)
    } catch (err) {
      console.error('[ui] panel render error', id, err)
      body.append(h('p.muted', '화면을 여는 중 문제가 생겼습니다.'))
    }
  }

  panelLayer.addEventListener('pointerdown', (e) => {
    if (e.target === panelLayer) closePanel()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId) {
      closePanel()
      // Esc 한 번에는 한 가지만 닫는다: 패널을 닫았으면 그 아래의 대화 창·팝업까지 같이 닫히지 않게 한다
      e.stopImmediatePropagation()
    }
  })

  function toast(text: string, kind: 'info' | 'good' | 'bad' | 'gold' = 'info', ms = 2600): void {
    const el = h('div.toast', { class: kind }, text)
    toastBox.append(el)
    while (toastBox.children.length > 4) toastBox.firstElementChild?.remove()
    setTimeout(() => el.classList.add('out'), ms)
    setTimeout(() => el.remove(), ms + 350)
  }

  function confirm(text: string, okLabel = '확인', cancelLabel = '취소'): Promise<boolean> {
    return new Promise((resolve) => {
      const layer = h('div.panel-layer.confirm-layer')
      // Esc 는 '취소'다. 캡처 단계에서 먼저 받아 전파를 끊는다: 그러지 않으면 아래 패널의 Esc 처리기가 패널만 닫고
      // 확인 창은 주인 없이 화면에 남는다(Esc 한 번에는 맨 위의 것 하나만 닫는다)
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopImmediatePropagation()
        done(false)
      }
      const done = (v: boolean): void => {
        window.removeEventListener('keydown', onKey, true)
        layer.remove()
        resolve(v)
      }
      window.addEventListener('keydown', onKey, true)
      layer.append(
        h(
          'div.panel.confirm',
          { role: 'alertdialog' },
          h('p.confirm-text', text),
          h('div.row.end', h('button.btn', { onclick: () => done(false) }, cancelLabel), h('button.btn.primary', { onclick: () => done(true) }, okLabel)),
        ),
      )
      root.append(layer)
    })
  }

  let refreshQueued = false
  const api: UiApi = {
    root,
    toast,
    registerPanel(def) {
      panels.set(def.id, def)
    },
    openPanel,
    closePanel,
    get openPanelId() {
      return openId
    },
    addMenuItem(item) {
      menuItems.push(item)
      menuItems.sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
    },
    menuItems,
    addContextProvider(p) {
      providers.push(p)
    },
    contextProviders: providers,
    refreshContext() {
      // 같은 프레임에 여러 번 불려도 한 번만 다시 그리도록 near 이벤트를 재발행한다
      if (refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        contextRefreshers.forEach((fn) => fn())
      })
    },
    confirm,
  }
  void bus
  return api
}

/** HUD 가 상황 버튼을 다시 그리는 함수를 등록한다(ui.refreshContext() 가 호출) */
const contextRefreshers = new Set<() => void>()
export function onContextRefresh(fn: () => void): () => void {
  contextRefreshers.add(fn)
  return () => contextRefreshers.delete(fn)
}
