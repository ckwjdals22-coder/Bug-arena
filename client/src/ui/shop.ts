/**
 * 가상 매점: 헌금함 천막에서 가상 코인을 쓸모없는 칭호와 바꾼다.
 *  - 메뉴에서 언제든 구경할 수 있지만, 바꾸는 것은 천막 앞에서만 된다(세상 속 장소에 갈 이유).
 *  - 실제 결제는 어디에도 없다. 화면에도 그렇게 적는다.
 */
import './shop.css'
import { SHOP_BY_ID, SHOP_ITEMS, ownsTitle } from '../../../shared/content/shop'
import type { AppContext } from '../core/contracts'
import { playSfx } from './hud'
import { clear, fmt, h } from './kit'

const NOTE = '전부 가상입니다. 실제 돈으로 코인을 살 수 없고, 코인을 돈으로 바꿀 수도 없어요. 칭호는 이름표 장식일 뿐 게임이 유리해지지 않습니다.'
const WHY: Record<string, string> = {
  far: '헌금함 천막 앞에서만 바꿀 수 있어요.',
  poor: '가상 코인이 모자라요. 신도를 헌금함에 데려가 보세요.',
  owned: '이미 가지고 있는 칭호예요.',
  bad: '그런 물건은 팔지 않아요.',
}

export function mountShop(ctx: AppContext): void {
  const { store, bus, ui, net } = ctx
  const atTent = (): boolean => store.near.poi === 'offering'
  let redraw: () => void = () => {}

  // 천막 앞에서는 상황 버튼으로 바로 연다(헌납 타임 옆의 작은 버튼)
  ui.addContextProvider(() => {
    if (!store.me || !atTent() || store.talk) return null
    return { id: 'shop.open', icon: '🏪', label: '가상 매점', onClick: () => ui.openPanel('shop') }
  })
  ui.addMenuItem({ id: 'shop', icon: '🏪', label: '가상 매점', order: 45, onClick: () => ui.openPanel('shop') })

  ui.registerPanel({
    id: 'shop',
    title: '🏪 가상 매점',
    render(body) {
      const draw = (): void => {
        clear(body)
        const prog = store.me?.prog
        if (!prog) return
        const here = atTent()
        const owned = SHOP_ITEMS.filter((i) => (prog.items[i.id] ?? 0) > 0).length
        body.append(
          h(
            'div.shop-head',
            h('div.shop-coins', '🪙 가상 코인 ', h('b', fmt(prog.coins))),
            h('div.shop-owned.muted.small', `칭호 ${owned} / ${SHOP_ITEMS.length}`),
          ),
          h('p.shop-lead', '신도가 내민 잡동사니에 딸려 온 코인을 드디어 쓸 수 있습니다. 쓸모없는 것에.'),
        )
        if (!here) body.append(h('div.shop-far', '🎪 구경은 어디서나, 바꾸는 것은 ', h('b', '헌금함 천막 앞'), '에서만 할 수 있어요.'))
        const list = h('div.shop-list')
        for (const item of SHOP_ITEMS) {
          const has = (prog.items[item.id] ?? 0) > 0
          const worn = prog.tag === item.id
          const can = here && !has && prog.coins >= item.price
          const action = has
            ? h(
                'button.btn.sm.shop-wear',
                {
                  type: 'button',
                  class: worn ? 'on' : '',
                  disabled: worn,
                  onclick: () => {
                    playSfx(ctx, 'pick')
                    net.send({ t: 'profile', tag: item.id })
                    // 저장본이 오기 전에 미리 반영(서버가 보유 여부를 다시 검사한다)
                    if (store.me) {
                      store.me.prog.tag = item.id
                      bus.emit('profile')
                    }
                    draw()
                  },
                },
                worn ? '다는 중' : '이름표에 달기',
              )
            : h(
                'button.btn.sm.primary.shop-buy',
                {
                  type: 'button',
                  disabled: !can,
                  onclick: () => {
                    playSfx(ctx, 'click')
                    net.send({ t: 'buy', id: item.id })
                  },
                },
                `🪙 ${fmt(item.price)}`,
              )
          list.append(
            h(
              'div.shop-item',
              { class: has ? 'has' : '', dataset: { id: item.id } },
              h('div.shop-icon', item.icon),
              h('div.shop-text', h('div.shop-name', item.name), h('div.shop-desc.muted.small', item.desc)),
              action,
            ),
          )
        }
        body.append(list, h('p.muted.small.shop-note', NOTE))
      }
      redraw = draw
      draw()
      return () => {
        redraw = () => {}
      }
    },
  })

  bus.onMsg('shopRes', (m) => {
    const me = store.me
    if (!me) return
    if (m.ok) {
      const item = SHOP_BY_ID.get(m.id)
      me.prog.coins = m.coins
      me.prog.items[m.id] = 1
      bus.emit('progress', me.prog)
      playSfx(ctx, 'coin')
      if (item) ui.toast(`🧾 칭호 「${item.name}」 획득! ${item.desc}`, 'gold', 4200)
    } else {
      // 서버가 알려 준 잔액으로 맞춘다
      me.prog.coins = m.coins
      ui.toast(WHY[m.why ?? 'bad'] ?? WHY.bad!, 'bad')
    }
    redraw()
  })
  // 코인이 늘거나(헌납) 천막에 다가서면 열려 있는 매점 화면을 바로 고친다
  bus.on('progress', () => redraw())
  let lastHere = false
  bus.on('near', () => {
    const here = atTent()
    if (here !== lastHere) {
      lastHere = here
      redraw()
    }
  })
  // 달고 있던 매점 칭호를 더는 가지고 있지 않다면(저장본 초기화 등) 표시를 정리한다
  bus.on('entered', () => {
    const prog = store.me?.prog
    if (prog?.tag && SHOP_BY_ID.has(prog.tag) && !ownsTitle(prog, prog.tag)) delete prog.tag
  })
}
