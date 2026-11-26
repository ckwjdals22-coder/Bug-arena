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
    if (e.key === 'Escape' && openId) closePanel()
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
      const done = (v: boolean): void => {
        layer.remove()
        resolve(v)
      }
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
