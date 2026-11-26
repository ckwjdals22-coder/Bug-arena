/**
 * 가상 헌금함 — 신도 NPC 가 터무니없는 잡동사니를 헌납한다.
 *
 * 전부 가상이고 전부 쓸모없다는 것이 이 기능의 농담이다:
 *  - 플레이어가 무언가를 '요구'하는 행동은 없다. 신도가 제 발로 내놓는다.
 *  - 가상 코인은 아무것도 살 수 없고, 실제 돈·결제와 이어지는 지점이 없다.
 *
 * 흐름
 *  1) 포교 성공 직후 일정 확률로 새 신도가 즉석에서 한 개 내민다.
 *  2) 신도를 데리고 헌금함 앞에서 '헌납 타임'을 누르면, 아직 헌납하지 않은 신도마다 한 개씩 내놓는다.
 */
import { OFFER_COOLDOWN_MS, POI_RANGE_PAD } from '../../../shared/constants'
import { STAT } from '../../../shared/content/core'
import { OFFER_ITEMS } from '../../../shared/content/offerings'
import type { OfferItem } from '../../../shared/content/types'
import type { NpcState, PlayerState, RoomApi, RoomSystem } from '../api'

/** 포교 성공 직후 즉석 헌납 확률 */
export const INSTANT_GIFT_CHANCE = 0.22
/** 헌금함에서 이 거리 안에 있어야 한다(헌금함 반지름 + 여유) */
export const OFFER_REACH = POI_RANGE_PAD + 1.5
/** 헌납 타임에 참여하려면 신도가 교주에게서 이 거리 안에 있어야 한다 */
export const FOLLOWER_REACH = 12
/** 희귀도별 기본 가중치(1 흔함 … 4 전설) */
const BASE_WEIGHT = [60, 27, 10, 3] as const

const BY_RARITY: OfferItem[][] = [[], [], [], []]
for (const item of OFFER_ITEMS) BY_RARITY[item.rarity - 1]!.push(item)

/** 직급이 오르면 희귀한 잡동사니가 조금 더 잘 나온다(그래 봐야 잡동사니다) */
export function rarityWeights(rank: number): number[] {
  const r = Math.max(0, Math.min(5, Math.floor(rank)))
  return [BASE_WEIGHT[0], BASE_WEIGHT[1], BASE_WEIGHT[2] + r, BASE_WEIGHT[3] + r * 0.4]
}

export function rollItem(rank: number, rnd: () => number): OfferItem {
  const w = rarityWeights(rank)
  // 비어 있는 희귀도(콘텐츠가 줄었을 때)는 건너뛴다
  let total = 0
  for (let i = 0; i < 4; i++) if (BY_RARITY[i]!.length > 0) total += w[i]!
  let x = rnd() * total
  let tier = 0
  for (let i = 0; i < 4; i++) {
    if (BY_RARITY[i]!.length === 0) continue
    tier = i
    x -= w[i]!
    if (x < 0) break
  }
  const pool = BY_RARITY[tier]!
  return pool[Math.floor(rnd() * pool.length) % pool.length] as OfferItem
}

export function createOfferingSystem(): RoomSystem {
  let room: RoomApi

  function give(p: PlayerState, givers: NpcState[]): void {
    const pairs: [number, string][] = []
    const ids: string[] = []
    let coins = 0
    for (const npc of givers) {
      const item = rollItem(p.prog.rank, room.rnd)
      npc.offered = true
      pairs.push([npc.id, item.id])
      ids.push(item.id)
      coins += item.coins
    }
    if (ids.length > 0) {
      room.grant(p, { why: 'offer', items: ids, coins })
      room.bump(p, STAT.offerings, ids.length)
    }
    // 방 전체가 본다: 누가 무엇을 내놨는지(연출용). 받은 사람이 없어도 요청자에게는 빈 결과를 알려 준다
    if (ids.length > 0) room.broadcast({ t: 'offered', p: p.id, items: pairs, coins })
    else room.send(p, { t: 'offered', p: p.id, items: [], coins: 0 })
  }

  return {
    name: 'offering',
    handles: ['offer'],
    init(r) {
      room = r
    },
    onMessage(p, msg) {
      if (msg.t !== 'offer') return
      const box = room.world.offeringBox
      if (Math.hypot(p.x - box.x, p.z - box.z) > box.r + OFFER_REACH) {
        room.send(p, { t: 'err', code: 'far', msg: '헌금함이 너무 멀어요.' })
        return
      }
      if (room.cooldown(p, 'offer', OFFER_COOLDOWN_MS) > 0) return
      const givers = room.npcs
        .followersOf(p.id)
        .filter((n) => !n.offered && Math.hypot(n.x - p.x, n.z - p.z) <= FOLLOWER_REACH)
      give(p, givers)
    },
    onPitch(p, npc, _line, outcome) {
      if (outcome !== 'join' && outcome !== 'king') return
      // 방금 합류한 신도가 내 신도가 맞을 때만(가로챈 시스템이 다르게 처리했을 수 있다)
      if (npc.owner !== p.id || npc.offered) return
      if (room.rnd() < INSTANT_GIFT_CHANCE) give(p, [npc])
    },
  }
}
