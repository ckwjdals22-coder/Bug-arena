/**
 * 가상 헌금함 UI + 도감.
 *  - 헌금함 앞: 상황 버튼 [헌납 타임]
 *  - 내가 받았을 때: 물건을 하나씩 보여 주는 공개 카드(희귀도 테두리, 처음 보는 물건은 NEW)
 *  - 남이 받았을 때: 헌납한 시민 머리 위 작은 글자 + 동전 이펙트(구경거리)
 *  - 메뉴 [도감]: 헌납품 / 만난 시민
 * 헌납품과 가상 코인은 장식일 뿐이며 실제 돈과 무관하다는 문구를 항상 보여 준다.
 */
import { OFFER_COOLDOWN_MS, npcKey } from '../../../shared/constants'
import { ARCHETYPE_INFO } from '../../../shared/content/archetypeInfo'
import { OFFER_ITEMS, OFFER_ITEM_BY_ID } from '../../../shared/content/offerings'
import type { OfferItem } from '../../../shared/content/types'
import { WORLD } from '../../../shared/world'
import type { AppContext } from '../core/contracts'
import { playSfx } from './hud'
import { clear, fmt, h } from './kit'
import { stagePlay } from './stage'
import './offering.css'

const RARITY_NAME = ['', '흔함', '드묾', '희귀', '전설'] as const
const NOTE = '가상 코인과 헌납품은 게임 속 장식입니다. 실제 돈과 무관하며, 돈으로 살 수도 돈으로 바꿀 수도 없습니다. 코인은 천막의 가상 매점에서 쓸모없는 칭호와 바꿀 수 있어요.'

export function mountOffering(ctx: AppContext): void {
  const { store, bus, ui } = ctx
  let readyAt = 0
  /** 도감을 마지막으로 연 뒤 새로 얻은 것이 있는가(메뉴 배지) */
  let fresh = false
  /** 이번 접속에서 본 적 있는 물건(NEW 표시 판단) */
  const seen = new Set<string>()
  bus.on('entered', () => {
    seen.clear()
    for (const id of Object.keys(store.me?.prog.items ?? {})) seen.add(id)
  })

  // ───────── 상황 버튼 ─────────
  ui.addContextProvider(() => {
    const me = store.me
    if (!me || store.near.poi !== 'offering' || store.talk) return null
    const n = me.entourage
    return {
      id: 'offer',
      icon: '🎁',
      label: n > 0 ? `헌납 타임 (${n})` : '헌납 타임',
      primary: store.near.npc === 0,
      readyAt,
      onClick() {
        if (performance.now() < readyAt) return
        readyAt = performance.now() + OFFER_COOLDOWN_MS
        playSfx(ctx, 'click')
        ctx.net.send({ t: 'offer' })
        ui.refreshContext()
      },
    }
  })

  // ───────── 공개 카드 ─────────
  const reveal = h('div.offering-reveal.hidden', { role: 'status' })
  ui.root.append(reveal)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const timers: ReturnType<typeof setTimeout>[] = []
  /** 무대(stage.ts)에서 받은 자리를 돌려주는 함수: 눌러서 일찍 닫으면 다음 카드(업적·승급)가 바로 이어진다 */
  let releaseStage: (() => void) | undefined

  function closeReveal(): void {
    clearTimeout(hideTimer)
    for (const t of timers.splice(0)) clearTimeout(t)
    reveal.classList.add('hidden')
    const release = releaseStage
    releaseStage = undefined
    release?.()
  }
  reveal.addEventListener('click', closeReveal)

  function itemRow(item: OfferItem, isNew: boolean): HTMLElement {
    return h(
      'div.offering-item',
      { class: `r${item.rarity}` },
      h('div.offering-icon', item.icon),
      h(
        'div.offering-text',
        h('div.offering-name', item.name, isNew ? h('span.offering-new', 'NEW') : null),
        h('div.offering-desc', item.desc),
      ),
      h('div.offering-rarity', RARITY_NAME[item.rarity] ?? ''),
    )
  }

  /** 공개 카드가 실제로 떠 있는 시간: 물건이 하나씩 나오는 만큼 길어진다(무대 자리도 이만큼 잡아야 다른 카드가 겹치지 않는다) */
  const revealMs = (n: number): number => 3200 + n * 700

  function showReveal(itemIds: string[], coins: number, done?: () => void, newIds?: ReadonlySet<string>): void {
    closeReveal()
    releaseStage = done
    clear(reveal)
    const list = h('div.offering-list')
    const best = itemIds.reduce((m, id) => Math.max(m, OFFER_ITEM_BY_ID.get(id)?.rarity ?? 1), 1)
    reveal.append(
      h('div.offering-head', best >= 4 ? '✨ 전설의 헌납품! ✨' : '🎁 신도들이 무언가 내밀었습니다'),
      list,
      h('div.offering-coins', `🪙 가상 코인 +${fmt(coins)}`),
      h('div.offering-note', '쓸모는 없지만 마음만은 받았습니다. 가상 코인은 실제 돈과 무관하며 천막 매점에서만 쓸 수 있어요. (눌러서 닫기)'),
    )
    reveal.classList.toggle('legend', best >= 4)
    reveal.classList.remove('hidden')
    itemIds.forEach((id, i) => {
      const item = OFFER_ITEM_BY_ID.get(id)
      if (!item) return
      const isNew = newIds ? newIds.has(id) : !seen.has(id)
      seen.add(id)
      timers.push(
        setTimeout(() => {
          list.append(itemRow(item, isNew))
          playSfx(ctx, item.rarity >= 3 ? 'ach' : 'item')
        }, 180 + i * 320),
      )
    })
    timers.push(setTimeout(() => playSfx(ctx, 'coin'), 180 + itemIds.length * 320))
    hideTimer = setTimeout(closeReveal, revealMs(itemIds.length))
  }

  bus.onMsg('offered', (m) => {
    const me = store.me
    const mine = !!me && m.p === me.id
    if (mine && m.items.length === 0) {
      ui.toast('헌납할 신도가 없어요. 신도를 가상 헌금함 앞으로 데려오세요.', 'info')
      return
    }
    // 구경거리: 헌납한 시민 머리 위에 물건 아이콘, 헌금함에 동전.
    // 내가 받은 것이면 머리 위 글자는 띄우지 않는다: 같은 물건을 공개 카드가 곧 크게 보여 주고,
    // 포교 성공 순간에는 "신도 +1"·영향력 글자와 말풍선이 이미 그 자리에 몰려 있어 이름이 겹쳐 읽히지 않는다
    for (const [npcId, itemId] of m.items) {
      const item = OFFER_ITEM_BY_ID.get(itemId)
      const v = store.npcs.get(npcId)
      if (!item || !v) continue
      if (!mine) ctx.overlay.pop(v.x, v.y + 1.9, v.z, `${item.icon} ${item.name}`, item.rarity >= 3 ? 'gold' : 'info')
      ctx.fx.burst('coin', v.x, v.y, v.z)
      if (item.rarity >= 4) ctx.overlay.bubble(npcKey(npcId), '이건… 가보입니다.', 2600, 'npc')
    }
    const box = WORLD.offeringBox
    if (m.items.length > 1) ctx.fx.burst('coin', box.x, 0, box.z)
    if (mine) {
      fresh = true
      const ids = m.items.map((x) => x[1])
      // 늘 무대 줄에 선다: 포교 성공 직후라면 결과 배너·자막이 지나간 뒤에 뜨고, 카드가 떠 있는 내내 업적·승급 카드가 기다린다.
      // 헌금함에서 직접 [헌납 타임]을 누른 경우처럼 무대가 비어 있으면 곧바로(40ms 뒤) 뜬다
      // 처음 보는 물건(NEW)은 지금 정해 둔다: 결과 배너에 밀려 카드가 다시 나와도 NEW 표시가 사라지지 않게
      const newIds = new Set(ids.filter((id) => !seen.has(id)))
      stagePlay(1.5, revealMs(ids.length), (done) => {
        if (store.phase !== 'playing') {
          done()
          return
        }
        showReveal(ids, m.coins, done, newIds)
        // 카드가 떠 있는 동안 다음 포교 결과 배너가 뜨면 비켜 준다(무대가 숨기고, 덜 보였으면 다시 줄 세운다)
        return closeReveal
      })
    }
  })
  bus.on('phase', (p) => {
    if (p !== 'playing') closeReveal()
  })

  // ───────── 도감 ─────────
  ui.addMenuItem({
    id: 'collection',
    icon: '📖',
    label: '도감',
    order: 40,
    badge: () => fresh,
    onClick: () => ui.openPanel('collection'),
  })

  ui.registerPanel({
    id: 'collection',
    title: '📖 도감',
    wide: true,
    render(body) {
      fresh = false
      const prog = store.me?.prog
      const items = prog?.items ?? {}
      const met = new Set(prog?.met ?? [])
      const tabs = h('div.tabs')
      const content = h('div.offering-book')
      let tab: 'items' | 'people' = 'items'

      function drawItems(): void {
        const owned = OFFER_ITEMS.filter((i) => (items[i.id] ?? 0) > 0).length
        const pct = OFFER_ITEMS.length ? Math.round((owned / OFFER_ITEMS.length) * 100) : 0
        content.append(
          h(
            'div.offering-summary',
            h('div', h('b', `${owned} / ${OFFER_ITEMS.length}`), ` 종 수집 (${pct}%)`),
            h('div', '🪙 가상 코인 ', h('b', fmt(prog?.coins ?? 0))),
          ),
          h('div.bar.gold', h('i', { style: { width: `${pct}%` } })),
        )
        for (const rarity of [4, 3, 2, 1] as const) {
          const group = OFFER_ITEMS.filter((i) => i.rarity === rarity)
          if (group.length === 0) continue
          const grid = h('div.offering-grid')
          for (const item of group) {
            const count = items[item.id] ?? 0
            grid.append(
              count > 0
                ? h(
                    'div.offering-cell',
                    { class: `r${rarity}`, title: item.desc },
                    h('div.offering-cell-icon', item.icon),
                    h('div.offering-cell-name', item.name),
                    h('div.offering-cell-desc', item.desc),
                    count > 1 ? h('div.offering-cell-count', `×${count}`) : null,
                  )
                : h('div.offering-cell.unknown', { class: `r${rarity}` }, h('div.offering-cell-icon', '❔'), h('div.offering-cell-name', '???')),
            )
          }
          content.append(h('h3.offering-h', { class: `r${rarity}` }, RARITY_NAME[rarity] ?? ''), grid)
        }
        content.append(h('p.muted.small.offering-legal', NOTE))
      }

      function drawPeople(): void {
        const known = ARCHETYPE_INFO.filter((a) => met.has(a.id)).length
        const pct = ARCHETYPE_INFO.length ? Math.round((known / ARCHETYPE_INFO.length) * 100) : 0
        content.append(
          h('div.offering-summary', h('div', h('b', `${known} / ${ARCHETYPE_INFO.length}`), ` 유형을 만났습니다 (${pct}%)`)),
          h('div.bar', h('i', { style: { width: `${pct}%` } })),
        )
        const list = h('div.offering-people')
        for (const a of ARCHETYPE_INFO) {
          list.append(
            met.has(a.id)
              ? h('div.card.flat.offering-person', h('div.offering-person-name', a.name), h('div.muted.small', a.desc))
              : h('div.card.flat.offering-person.unknown', h('div.offering-person-name', '???'), h('div.muted.small', '아직 말을 걸어 보지 못한 시민')),
          )
        }
        content.append(list, h('p.muted.small.offering-legal', '시민은 모두 가상의 인물입니다. 말을 걸면 도감에 기록됩니다.'))
      }

      function draw(): void {
        clear(content)
        clear(tabs)
        tabs.append(
          h('button.tab', { class: tab === 'items' ? 'on' : '', onclick: () => switchTab('items') }, '🎁 헌납품'),
          h('button.tab', { class: tab === 'people' ? 'on' : '', onclick: () => switchTab('people') }, '🧑 시민'),
        )
        if (tab === 'items') drawItems()
        else drawPeople()
      }
      function switchTab(next: 'items' | 'people'): void {
        if (tab === next) return
        tab = next
        playSfx(ctx, 'click')
        draw()
      }
      body.append(tabs, content)
      draw()
    },
  })
}
