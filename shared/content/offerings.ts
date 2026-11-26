/**
 * 가상 헌금함에 NPC가 헌납하는 터무니없는 물건들. 실제 금전과 무관.
 * [콘텐츠 작성자가 확장할 파일] 지금은 최소 예시만 들어 있다.
 */
import type { OfferItem } from './types'

export const OFFER_ITEMS: readonly OfferItem[] = [
  { id: 'sock', name: '한 짝만 남은 양말', desc: '나머지 한 짝은 세탁기가 가져갔다.', icon: '🧦', rarity: 1, coins: 1 },
  { id: 'coupon9', name: '도장 9개 찍힌 쿠폰', desc: '10개째는 영원히 오지 않는다.', icon: '🎟️', rarity: 1, coins: 2 },
  { id: 'kimbap', name: '유통기한 임박 삼각김밥', desc: '마음만은 신선하다.', icon: '🍙', rarity: 1, coins: 2 },
  { id: 'lotto', name: '낙첨된 로또 용지', desc: '번호 하나 차이였다고 한다. 여섯 개 다.', icon: '🎫', rarity: 2, coins: 5 },
  { id: 'gold_remote', name: '황금 리모컨', desc: '채널 선택권이 곧 권력이다.', icon: '📺', rarity: 4, coins: 50 },
]

export const OFFER_ITEM_BY_ID: ReadonlyMap<string, OfferItem> = new Map(OFFER_ITEMS.map((i) => [i.id, i]))
