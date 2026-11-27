/**
 * 가상 매점 — 헌금함 천막 옆에서 '가상 코인'을 쓸모없는 칭호와 바꾸는 곳.
 *
 * 이 기능의 농담은 "드디어 코인을 쓸 수 있게 됐는데, 살 수 있는 것이 전부 쓸모없다"는 것이다.
 *  - 실제 돈·결제와 이어지는 지점이 없다. 코인은 게임 안에서만 생기고(신도가 내민 잡동사니에 딸려 온다) 여기서만 사라진다.
 *  - 파는 것은 이름표에 다는 칭호뿐이다. 능력치·확률에는 아무 영향이 없다(돈으로 유리해지는 구조를 만들지 않는다).
 *  - 실존 브랜드·단체·인물을 연상시키는 이름은 쓰지 않는다.
 */
import { ACHIEVEMENT_BY_ID } from './achievements'

export interface ShopItem {
  /** 's_' 로 시작한다(업적 id 와 겹치지 않게). Progress.items 의 키로도 쓰므로 24자 이하 */
  id: string
  icon: string
  /** 이름표에 붙는 칭호 */
  name: string
  /** 가상 코인 가격 */
  price: number
  /** 영수증 한 줄(쓸모없음을 강조) */
  desc: string
}

export const SHOP_ITEMS: readonly ShopItem[] = [
  { id: 's_receipt', icon: '🧾', name: '영수증 수집가', price: 20, desc: '영수증만 드립니다. 물건은 없어요.' },
  { id: 's_sock', icon: '🧦', name: '양말 한 짝 후원자', price: 45, desc: '나머지 한 짝의 행방은 묻지 마세요.' },
  { id: 's_cushion', icon: '🪑', name: '가상 VIP 방석 보유', price: 90, desc: '앉을 수는 없지만 VIP 입니다.' },
  { id: 's_laminate', icon: '📄', name: '전단지 코팅 장인', price: 150, desc: '코팅해도 아무도 안 받습니다.' },
  { id: 's_tangerine', icon: '🍊', name: '명예 귤 감별사', price: 240, desc: '귤은 따로 구하셔야 합니다.' },
  { id: 's_dust', icon: '✨', name: '우주 먼지 한 톨 주인', price: 380, desc: '어느 먼지인지는 알려 드릴 수 없어요.' },
  { id: 's_regular', icon: '🎁', name: '가상 헌금함 단골', price: 600, desc: '단골 혜택은 준비 중입니다. 영원히.' },
  { id: 's_frame', icon: '🖼️', name: '빈 액자 수집가', price: 900, desc: '안에 넣을 것은 팔지 않습니다.' },
  { id: 's_rich', icon: '💰', name: '수상할 정도로 부자', price: 1400, desc: '가상입니다. 수상한 건 진짜고요.' },
  { id: 's_doctor', icon: '🎓', name: '쓸모없음 박사', price: 2200, desc: '학위 논문: 「아무것도 아닌 것에 관하여」' },
  { id: 's_waste', icon: '🕳️', name: '코인 낭비의 달인', price: 3500, desc: '방금 그 코인, 어디 갔을까요?' },
  { id: 's_allin', icon: '🚀', name: '전 재산 올인', price: 6000, desc: '축하합니다. 이제 정말 아무것도 없습니다.' },
]

export const SHOP_BY_ID: ReadonlyMap<string, ShopItem> = new Map(SHOP_ITEMS.map((i) => [i.id, i]))

/** 이름표에 다는 칭호의 표시 이름. 업적 칭호 또는 매점 칭호. 모르는 id 면 빈 문자열 */
export function titleNameOf(tag: string | undefined | null): string {
  if (!tag) return ''
  return ACHIEVEMENT_BY_ID.get(tag)?.name ?? SHOP_BY_ID.get(tag)?.name ?? ''
}

/** 이 칭호를 달 자격이 있는가: 달성한 업적이거나, 매점에서 바꾼 칭호 */
export function ownsTitle(prog: { ach: readonly string[]; items: Readonly<Record<string, number>> }, tag: string): boolean {
  if (!tag) return false
  if (SHOP_BY_ID.has(tag)) return (prog.items[tag] ?? 0) > 0
  return prog.ach.includes(tag)
}
