/**
 * Cloudflare 어댑터 로비의 자리 계산(worker/src/policy.ts): 인사 전 연결로 방을 '가득 참'으로 만들 수 없어야 한다.
 */
import { describe, expect, it } from 'vitest'
import { PENDING_SEAT_CAP } from '../../server/core/lobby'
import { RoomTable } from '../../worker/src/policy'

const policy = { rooms: 2, maxRooms: 2, capacity: 5, npcs: 0, maxPreHello: 8, maxConnsPerIp: 0 }

describe('Workers 로비 자리 계산', () => {
  it('hello 를 보내지 않는 연결이 많아도 PENDING_SEAT_CAP 까지만 자리로 친다', () => {
    const t = new RoomTable(policy)
    const now = 1_000_000
    // 방 1: 0명 + 인사 전 연결 30개(공격), 방 2: 정상 2명
    t.report({ id: '1', inst: 'a', seq: 1, players: 0, pending: 30, cap: 5, npcs: 0, tickP95: 0 }, now)
    t.report({ id: '2', inst: 'b', seq: 1, players: 2, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    expect(PENDING_SEAT_CAP).toBeLessThan(5)
    expect(t.pick('1', now)).toBe('1')
  })
  it('정원이 찬 방에는 보내지 않고, 전부 차면 null', () => {
    const t = new RoomTable(policy)
    const now = 1_000_000
    t.report({ id: '1', inst: 'a', seq: 1, players: 5, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    t.report({ id: '2', inst: 'b', seq: 1, players: 4, pending: 3, cap: 5, npcs: 0, tickP95: 0 }, now)
    expect(t.pick('1', now)).toBe(null)
  })
  it('끊겼다 돌아오는 재접속(resume)은 가득 찬 방이어도 있던 방으로 보낸다(예약 자리는 늘리지 않는다)', () => {
    const t = new RoomTable(policy)
    const now = 1_000_000
    t.report({ id: '1', inst: 'a', seq: 1, players: 5, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    t.report({ id: '2', inst: 'b', seq: 1, players: 1, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    expect(t.pick('1', now)).toBe('2') // 처음 오는 사람은 자리 있는 방으로
    expect(t.pick('1', now, true)).toBe('1')
    expect(t.pick('1', now, true)).toBe('1')
    // 없는 방을 대며 resume 을 붙여도 평소 규칙대로
    expect(t.pick('zz', now, true)).toBe('2')
    // 자리가 나면 평소처럼 들어갈 수 있다(재접속이 예약을 쌓아 두지 않았다)
    t.report({ id: '1', inst: 'a', seq: 2, players: 4, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    expect(t.pick('1', now)).toBe('1')
  })
  it('방금 배정한 자리(reserved)는 그대로 세어 몰린 접속을 나눈다', () => {
    const t = new RoomTable(policy)
    const now = 1_000_000
    t.report({ id: '1', inst: 'a', seq: 1, players: 0, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    t.report({ id: '2', inst: 'b', seq: 1, players: 0, pending: 0, cap: 5, npcs: 0, tickP95: 0 }, now)
    const picks = Array.from({ length: 10 }, () => t.pick('1', now))
    expect(picks.filter((p) => p === '1').length).toBe(5)
    expect(picks.filter((p) => p === '2').length).toBe(5)
    expect(t.pick('1', now)).toBe(null)
  })
})
