/** 가상 매점: 가상 코인으로 쓸모없는 칭호를 바꾼다. 서버가 가격·잔액·위치를 판정한다. */
import { describe, expect, it } from 'vitest'
import { ACHIEVEMENT_BY_ID } from '../../shared/content/achievements'
import { SHOP_BY_ID, SHOP_ITEMS, ownsTitle, titleNameOf } from '../../shared/content/shop'
import { checkTitle } from '../../shared/rules/moderation'
import { newProgress, normalizeProgress } from '../../shared/rules/progress'
import { SHOP_COOLDOWN_MS, SHOP_REACH, createShopSystem } from '../../server/core/systems/shop'
import { setup } from './helpers'

type T = ReturnType<typeof setup>
const atTent = (t: T, id: number): void => {
  const box = t.room.world.offeringBox
  t.player(id).x = box.x + box.r + 1
  t.player(id).z = box.z
}
const last = (t: T, conn: number) => t.host.of(conn, 'shopRes').at(-1)

describe('가상 매점: 콘텐츠', () => {
  it('id 는 s_ 로 시작하고 겹치지 않으며 업적 id 와도 겹치지 않는다. 가격은 오름차순, 이름은 필터를 통과한다', () => {
    const ids = new Set<string>()
    let prev = 0
    for (const item of SHOP_ITEMS) {
      expect(item.id.startsWith('s_'), item.id).toBe(true)
      expect(item.id.length, item.id).toBeLessThanOrEqual(24)
      expect(ids.has(item.id), item.id).toBe(false)
      ids.add(item.id)
      expect(ACHIEVEMENT_BY_ID.has(item.id), item.id).toBe(false)
      expect(Number.isInteger(item.price) && item.price > prev, `${item.id} 가격`).toBe(true)
      prev = item.price
      expect(Array.from(item.name).length, item.name).toBeLessThanOrEqual(12)
      expect(Array.from(item.desc).length, item.desc).toBeLessThanOrEqual(30)
      // 실존 단체·욕설 필터에 걸리는 이름을 팔지 않는다
      expect(checkTitle(item.name), item.name).toMatchObject({ ok: true })
    }
    expect(SHOP_ITEMS.length).toBeGreaterThanOrEqual(10)
  })

  it('titleNameOf / ownsTitle 은 업적 칭호와 매점 칭호를 모두 다룬다', () => {
    const item = SHOP_ITEMS[0]!
    const ach = [...ACHIEVEMENT_BY_ID.values()][0]!
    expect(titleNameOf(item.id)).toBe(item.name)
    expect(titleNameOf(ach.id)).toBe(ach.name)
    expect(titleNameOf('nope')).toBe('')
    expect(titleNameOf(undefined)).toBe('')
    expect(ownsTitle({ ach: [], items: {} }, item.id)).toBe(false)
    expect(ownsTitle({ ach: [], items: { [item.id]: 1 } }, item.id)).toBe(true)
    expect(ownsTitle({ ach: [ach.id], items: {} }, ach.id)).toBe(true)
    expect(ownsTitle({ ach: [], items: {} }, ach.id)).toBe(false)
  })
})

describe('가상 매점: 바꾸기', () => {
  it('천막 앞에서 코인이 충분하면 바꾼다: 코인이 줄고, 칭호를 가지게 되고, 저장본에 실린다', () => {
    const t = setup({ systems: [createShopSystem] })
    const a = t.join()
    const item = SHOP_ITEMS[1]!
    t.player(a.id).prog.coins = item.price + 7
    atTent(t, a.id)
    t.send(a.conn, { t: 'buy', id: item.id })
    expect(last(t, a.conn)).toEqual({ t: 'shopRes', ok: true, id: item.id, coins: 7 })
    expect(t.player(a.id).prog.coins).toBe(7)
    expect(t.player(a.id).prog.items[item.id]).toBe(1)
    t.advance(1200)
    const save = t.host.of(a.conn, 'save').at(-1)
    expect(save?.me.items[item.id]).toBe(1)
    expect(save?.me.coins).toBe(7)
  })

  it('코인 부족 · 이미 보유 · 없는 물건 · 천막에서 멂 은 각각 사유와 함께 거절하고 아무것도 바꾸지 않는다', () => {
    const t = setup({ systems: [createShopSystem] })
    const a = t.join()
    const item = SHOP_ITEMS[2]!
    const p = t.player(a.id)
    const box = t.room.world.offeringBox
    // 멀다
    p.prog.coins = 99999
    p.x = box.x + box.r + SHOP_REACH + 3
    p.z = box.z
    t.send(a.conn, { t: 'buy', id: item.id })
    expect(last(t, a.conn)).toMatchObject({ ok: false, why: 'far' })
    expect(p.prog.items[item.id]).toBeUndefined()
    // 코인 부족
    atTent(t, a.id)
    p.prog.coins = item.price - 1
    t.advance(SHOP_COOLDOWN_MS + 100)
    t.send(a.conn, { t: 'buy', id: item.id })
    expect(last(t, a.conn)).toMatchObject({ ok: false, why: 'poor', coins: item.price - 1 })
    expect(p.prog.coins).toBe(item.price - 1)
    // 삼 → 다시 사려 하면 이미 보유
    p.prog.coins = item.price * 3
    t.advance(SHOP_COOLDOWN_MS + 100)
    t.send(a.conn, { t: 'buy', id: item.id })
    expect(last(t, a.conn)).toMatchObject({ ok: true })
    t.advance(SHOP_COOLDOWN_MS + 100)
    t.send(a.conn, { t: 'buy', id: item.id })
    expect(last(t, a.conn)).toMatchObject({ ok: false, why: 'owned' })
    expect(p.prog.coins).toBe(item.price * 2)
    // 없는 물건, 형식이 틀린 요청
    t.advance(SHOP_COOLDOWN_MS + 100)
    t.send(a.conn, { t: 'buy', id: 's_nope' })
    expect(last(t, a.conn)).toMatchObject({ ok: false, why: 'bad' })
    t.send(a.conn, { t: 'buy', id: 12345 })
    t.send(a.conn, { t: 'buy' })
    expect(p.prog.coins).toBe(item.price * 2)
    expect(t.host.errors()).toEqual([])
  })

  it('연타해도 한 번만 처리된다', () => {
    const t = setup({ systems: [createShopSystem] })
    const a = t.join()
    const [x, y] = [SHOP_ITEMS[0]!, SHOP_ITEMS[1]!]
    t.player(a.id).prog.coins = x.price + y.price
    atTent(t, a.id)
    t.send(a.conn, { t: 'buy', id: x.id })
    t.send(a.conn, { t: 'buy', id: y.id })
    expect(t.host.of(a.conn, 'shopRes')).toHaveLength(1)
    expect(t.player(a.id).prog.items[y.id]).toBeUndefined()
  })
})

describe('가상 매점: 칭호 달기', () => {
  it('바꾼 칭호만 이름표에 달 수 있고, 다른 사람에게도 보인다', () => {
    const t = setup({ systems: [createShopSystem] })
    const a = t.join()
    const b = t.join()
    const item = SHOP_ITEMS[0]!
    // 아직 없는 칭호는 달 수 없다
    t.send(a.conn, { t: 'profile', tag: item.id })
    t.advance(200)
    expect(t.player(a.id).prog.tag).toBeUndefined()
    t.player(a.id).prog.coins = item.price
    atTent(t, a.id)
    t.send(a.conn, { t: 'buy', id: item.id })
    t.host.clear()
    t.send(a.conn, { t: 'profile', tag: item.id })
    t.advance(200)
    expect(t.player(a.id).prog.tag).toBe(item.id)
    expect(t.host.of(b.conn, 'pu').some((m) => m.id === a.id && m.tag === item.id)).toBe(true)
  })

  it('저장본을 다시 읽어도 매점 칭호가 유지되고, 가지지 않은 칭호는 떨어진다', () => {
    const item = SHOP_BY_ID.values().next().value!
    const pid = 'shop-save-000001'
    const prog = newProgress(pid, 1000)
    prog.items[item.id] = 1
    prog.tag = item.id
    expect(normalizeProgress(JSON.parse(JSON.stringify(prog)), pid, 2000)?.tag).toBe(item.id)
    const forged = { ...prog, items: {}, tag: item.id }
    expect(normalizeProgress(JSON.parse(JSON.stringify(forged)), pid, 2000)?.tag).toBeUndefined()
  })
})
