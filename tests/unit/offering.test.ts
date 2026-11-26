import { describe, expect, it } from 'vitest'
import { MAX_ENTOURAGE, OFFER_COOLDOWN_MS } from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import { OFFER_ITEM_BY_ID, OFFER_ITEMS } from '../../shared/content/offerings'
import { mulberry32 } from '../../shared/rng'
import { INSTANT_GIFT_CHANCE, createOfferingSystem, rarityWeights, rollItem } from '../../server/core/systems/offering'
import { R_JOIN, R_NO, TEST_WORLD, setup } from './helpers'

const BOX = TEST_WORLD.offeringBox

function atBox(t: ReturnType<typeof setup>, id: number): void {
  const p = t.player(id)
  p.x = BOX.x + 1
  p.z = BOX.z
}
/** NPC 를 플레이어의 신도로 만든다(포교 흐름을 거치지 않고 시뮬 계약만 사용) */
function follow(t: ReturnType<typeof setup>, npcId: number, playerId: number): void {
  const n = t.npc(npcId)
  const p = t.player(playerId)
  t.room.npcs.startFollow(n, playerId, t.host.t + 60_000, t.host.t)
  n.x = p.x + 1
  n.z = p.z
}

describe('헌금함: 헌납 타임', () => {
  it('헌금함 앞에서 아직 헌납하지 않은 신도마다 한 개씩 받는다', () => {
    const t = setup({ systems: [createOfferingSystem] })
    const a = t.join()
    const b = t.join()
    atBox(t, a.id)
    follow(t, 1, a.id)
    follow(t, 2, a.id)
    t.host.clear()
    t.send(a.conn, { t: 'offer' })

    const got = t.host.of(a.conn, 'offered')
    expect(got).toHaveLength(1)
    expect(got[0]!.p).toBe(a.id)
    expect(got[0]!.items.map((x) => x[0]).sort()).toEqual([1, 2])
    for (const [, itemId] of got[0]!.items) expect(OFFER_ITEM_BY_ID.has(itemId)).toBe(true)
    // 방 전체가 본다
    expect(t.host.of(b.conn, 'offered')).toHaveLength(1)

    const prog = t.player(a.id).prog
    const total = Object.values(prog.items).reduce((s, n) => s + n, 0)
    expect(total).toBe(2)
    const coins = got[0]!.items.reduce((s, [, id]) => s + OFFER_ITEM_BY_ID.get(id)!.coins, 0)
    expect(got[0]!.coins).toBe(coins)
    expect(prog.coins).toBe(coins)
    expect(t.stat(a.id, STAT.offerings)).toBe(2)
    expect(t.npc(1).offered && t.npc(2).offered).toBe(true)
    const reward = t.host.of(a.conn, 'reward').find((r) => r.why === 'offer')
    expect(reward?.items).toHaveLength(2)
    expect(t.host.errors()).toEqual([])
  })

  it('같은 신도는 두 번 내지 않고, 새로 합류한 신도는 다시 낸다', () => {
    const t = setup({ systems: [createOfferingSystem] })
    const a = t.join()
    atBox(t, a.id)
    follow(t, 1, a.id)
    t.send(a.conn, { t: 'offer' })
    t.advance(OFFER_COOLDOWN_MS + 200)
    t.host.clear()
    t.send(a.conn, { t: 'offer' })
    expect(t.host.of(a.conn, 'offered')[0]!.items).toEqual([])
    expect(t.stat(a.id, STAT.offerings)).toBe(1)

    // 떠났다가 다시 신도가 되면 offered 가 초기화된다
    t.room.npcs.release(t.npc(1), 'expire')
    follow(t, 1, a.id)
    t.advance(OFFER_COOLDOWN_MS + 200)
    t.host.clear()
    t.send(a.conn, { t: 'offer' })
    expect(t.host.of(a.conn, 'offered')[0]!.items).toHaveLength(1)
  })

  it('헌금함에서 멀면 거절한다', () => {
    const t = setup({ systems: [createOfferingSystem] })
    const a = t.join()
    follow(t, 1, a.id)
    t.host.clear()
    t.send(a.conn, { t: 'offer' })
    expect(t.host.of(a.conn, 'offered')).toEqual([])
    expect(t.host.of(a.conn, 'err')[0]?.code).toBe('far')
    expect(t.npc(1).offered).toBe(false)
  })

  it('쿨타임 안의 연타는 무시한다', () => {
    const t = setup({ systems: [createOfferingSystem] })
    const a = t.join()
    atBox(t, a.id)
    follow(t, 1, a.id)
    follow(t, 2, a.id)
    t.send(a.conn, { t: 'offer' })
    t.npc(2).offered = false
    t.host.clear()
    for (let i = 0; i < 5; i++) t.send(a.conn, { t: 'offer' })
    expect(t.host.of(a.conn, 'offered')).toEqual([])
    expect(t.stat(a.id, STAT.offerings)).toBe(2)
  })

  it('남의 신도, 멀리 떨어진 신도, 신도가 아닌 시민은 내지 않는다', () => {
    const t = setup({ systems: [createOfferingSystem] })
    const a = t.join()
    const b = t.join()
    atBox(t, a.id)
    atBox(t, b.id)
    follow(t, 1, b.id) // 남의 신도
    follow(t, 2, a.id)
    t.npc(2).x += 40 // 멀리 있음
    t.host.clear()
    t.send(a.conn, { t: 'offer' })
    expect(t.host.of(a.conn, 'offered')[0]!.items).toEqual([])
    expect(t.npc(1).offered).toBe(false)
    expect(t.npc(2).offered).toBe(false)
    expect(t.npc(3).offered).toBe(false)
  })

  it('헌납품은 저장본에 실려 다음 접속에도 남는다', () => {
    const t = setup({ systems: [createOfferingSystem] })
    const a = t.join({ pid: 'offer-device-0001' })
    atBox(t, a.id)
    follow(t, 1, a.id)
    t.send(a.conn, { t: 'offer' })
    t.advance(1500)
    const save = t.host.of(a.conn, 'save').pop()
    expect(save).toBeTruthy()
    const items = save!.me.items
    expect(Object.values(items).reduce((s, n) => s + n, 0)).toBe(1)
    t.room.disconnect(a.conn)
    const again = t.join({ pid: 'offer-device-0001', save: save!.save })
    expect(again.w.me.items).toEqual(items)
  })

  it('최대 동행 수만큼 한꺼번에 받아도 문제없다', () => {
    const t = setup({ systems: [createOfferingSystem], npcs: 12 })
    const a = t.join()
    atBox(t, a.id)
    for (let i = 1; i <= MAX_ENTOURAGE; i++) follow(t, i, a.id)
    t.send(a.conn, { t: 'offer' })
    expect(t.host.of(a.conn, 'offered')[0]!.items).toHaveLength(MAX_ENTOURAGE)
    expect(t.host.errors()).toEqual([])
  })
})

describe('헌금함: 즉석 헌납', () => {
  it('포교 성공 직후 확률적으로 한 개 내민다', () => {
    const t = setup({ systems: [createOfferingSystem], npcs: 9 })
    const a = t.join()
    t.talk(a, 1)
    // 판정 난수(합류) 다음 난수가 즉석 헌납 판정에 쓰인다 → 0 이면 헌납, 그 뒤 두 개는 물건 추첨
    t.pitch(a, 1, [...R_JOIN, 0, 0.1, 0.1])
    const got = t.host.of(a.conn, 'offered')
    expect(got).toHaveLength(1)
    expect(got[0]!.items).toHaveLength(1)
    expect(got[0]!.items[0]![0]).toBe(1)
    expect(t.npc(1).offered).toBe(true)
  })
  it('확률에 걸리지 않으면 내지 않고, 거절당했을 때는 절대 내지 않는다', () => {
    const t = setup({ systems: [createOfferingSystem], npcs: 9 })
    const a = t.join()
    t.talk(a, 1)
    t.pitch(a, 1, [...R_JOIN, 0.99])
    expect(t.host.of(a.conn, 'offered')).toEqual([])
    t.advance(3000)
    t.talk(a, 2)
    t.pitch(a, 2, [...R_NO, 0])
    expect(t.host.of(a.conn, 'offered')).toEqual([])
  })
})

describe('헌납품 추첨', () => {
  it('희귀도 분포가 가중치를 따른다', () => {
    const rnd = mulberry32(42)
    const n = 20_000
    const count = [0, 0, 0, 0]
    for (let i = 0; i < n; i++) count[rollItem(0, rnd).rarity - 1]!++
    const w = rarityWeights(0)
    const sum = w.reduce((a, b) => a + b, 0)
    for (let i = 0; i < 4; i++) expect(Math.abs(count[i]! / n - w[i]! / sum)).toBeLessThan(0.012)
  })
  it('직급이 높을수록 희귀한 것이 조금 더 잘 나온다', () => {
    const share = (rank: number): number => {
      const w = rarityWeights(rank)
      return (w[2]! + w[3]!) / w.reduce((a, b) => a + b, 0)
    }
    for (let r = 1; r <= 5; r++) expect(share(r)).toBeGreaterThan(share(r - 1))
    expect(rarityWeights(99)).toEqual(rarityWeights(5))
    expect(rarityWeights(-3)).toEqual(rarityWeights(0))
  })
  it('모든 물건이 뽑힐 수 있고 즉석 헌납 확률은 22% 근처다', () => {
    const rnd = mulberry32(7)
    const seen = new Set<string>()
    for (let i = 0; i < 60_000; i++) seen.add(rollItem(3, rnd).id)
    expect(seen.size).toBe(OFFER_ITEMS.length)
    expect(INSTANT_GIFT_CHANCE).toBeCloseTo(0.22, 5)
  })
})
