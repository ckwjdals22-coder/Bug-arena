/**
 * 가상 매점 — 헌금함 천막에서 가상 코인을 쓸모없는 칭호와 바꾼다.
 *
 *  - 코인은 서버가 센다. 클라이언트가 보낸 가격·잔액은 믿지 않는다.
 *  - 실제 결제와 이어지는 지점이 없고, 산 것은 이름표 칭호일 뿐 게임의 확률·보상에 영향을 주지 않는다.
 *  - 천막 근처에 있어야 살 수 있다(세상 속 장소에 의미를 준다).
 */
import { POI_RANGE_PAD } from '../../../shared/constants'
import { SHOP_BY_ID } from '../../../shared/content/shop'
import type { RoomSystem, RoomApi } from '../api'

/** 헌금함에서 이 거리 안에 있어야 매점을 쓸 수 있다(헌금함 반지름 + 여유; 화면의 버튼이 뜨는 범위보다 조금 넉넉하게) */
export const SHOP_REACH = POI_RANGE_PAD + 3.5
/** 연타 방지 */
export const SHOP_COOLDOWN_MS = 400

export function createShopSystem(): RoomSystem {
  let room: RoomApi
  return {
    name: 'shop',
    handles: ['buy'],
    init(r) {
      room = r
    },
    onMessage(p, msg) {
      if (msg.t !== 'buy') return
      const id = typeof msg.id === 'string' ? msg.id : ''
      const item = SHOP_BY_ID.get(id)
      const no = (why: 'bad' | 'far' | 'owned' | 'poor'): void => room.send(p, { t: 'shopRes', ok: false, id: id.slice(0, 24), coins: p.prog.coins, why })
      if (!item) return no('bad')
      if (room.cooldown(p, 'shop', SHOP_COOLDOWN_MS) > 0) return
      const box = room.world.offeringBox
      if (Math.hypot(p.x - box.x, p.z - box.z) > box.r + SHOP_REACH) return no('far')
      if ((p.prog.items[item.id] ?? 0) > 0) return no('owned')
      if (p.prog.coins < item.price) return no('poor')
      p.prog.coins -= item.price
      p.prog.items[item.id] = 1
      room.markSave(p)
      room.send(p, { t: 'shopRes', ok: true, id: item.id, coins: p.prog.coins })
    },
  }
}
