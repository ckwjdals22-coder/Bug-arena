/**
 * Cloudflare 어댑터의 접속자 메모 저장(worker/src/memory.ts).
 * DO 가 내려갔다 깨어나는 것을 '저장 → 새 표에 되살리기 → 새 Room' 으로 흉내 내어,
 * 입막음·이름 고정·쿨타임·차단이 재접속으로 풀리지 않는지 확인한다.
 */
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../shared/constants'
import type { PlayerMemory } from '../../server/core/api'
import { Room } from '../../server/core/room'
import { MEMORY_SAVE_MAX, restoreMemory, serializeMemory } from '../../worker/src/memory'
import { FakeHost, LOOK0, TEST_WORLD } from './helpers'

const PID = 'device-mem-aaaaaaaa'

function makeRoom(host: FakeHost, memory: Map<string, PlayerMemory>): Room {
  return new Room(host, { id: '1', name: '시험 방', npcCount: 0, seed: 3, world: TEST_WORLD, systems: [], memory })
}

function join(host: FakeHost, room: Room, conn: number, name: string): number {
  room.connect(conn)
  room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid: PID, name, look: LOOK0, save: null }))
  const w = host.of(conn, 'welcome')[0]
  if (!w) throw new Error('welcome 없음')
  return w.id
}

/** DO 저장소를 거치는 것처럼 JSON 으로 한 번 왕복시킨다 */
const roundTrip = <T>(v: T): unknown => JSON.parse(JSON.stringify(v))

function sanction(room: Room, id: number, now: number): void {
  const p = room.players.get(id)
  if (!p) throw new Error('플레이어 없음')
  p.mutedUntil = now + 60_000
  p.nameLockUntil = now + 120_000
  p.name = '개명된교주'
  p.cd.set('battle.ask', now + 30_000)
  p.cd.set('old.key', now - 1)
  p.blocked.add('device-bully-bbbbbbbb')
}

describe('접속자 메모 저장(Workers)', () => {
  it('접속 중에 저장해도(사람에게서 최신 값을 읽어) 깨어난 뒤 다시 들어오면 제재가 이어진다', () => {
    const host = new FakeHost()
    const memA = new Map<string, PlayerMemory>()
    const roomA = makeRoom(host, memA)
    const id = join(host, roomA, 1, '원래이름')
    const now = host.now()
    sanction(roomA, id, now)
    const live = new Map([...roomA.players.values()].map((p) => [p.pid, { mutedUntil: p.mutedUntil, nameLockUntil: p.nameLockUntil, name: p.name }]))
    const stored = roundTrip(serializeMemory(memA, now, (pid) => live.get(pid)))

    // DO 가 내려갔다 깨어났다: 새 표, 새 방
    const memB = new Map<string, PlayerMemory>()
    expect(restoreMemory(memB, stored, now + 1000)).toBe(1)
    const host2 = new FakeHost()
    host2.t = host.t + 1000
    const roomB = makeRoom(host2, memB)
    const id2 = join(host2, roomB, 1, '원래이름')
    const p = roomB.players.get(id2)!
    expect(p.name).toBe('개명된교주')
    expect(p.mutedUntil).toBe(now + 60_000)
    expect(p.nameLockUntil).toBe(now + 120_000)
    expect(p.cd.get('battle.ask')).toBe(now + 30_000)
    expect(p.cd.has('old.key')).toBe(false)
    expect(p.blocked.has('device-bully-bbbbbbbb')).toBe(true)
  })

  it('나간 뒤 저장한 메모(코어가 정리한 기한)도 그대로 되살아난다', () => {
    const host = new FakeHost()
    const memA = new Map<string, PlayerMemory>()
    const roomA = makeRoom(host, memA)
    const id = join(host, roomA, 1, '원래이름')
    const now = host.now()
    sanction(roomA, id, now)
    roomA.disconnect(1, true)
    expect(memA.get(PID)?.live).toBe(false)
    const stored = roundTrip(serializeMemory(memA, now, () => undefined)) as Record<string, { keepUntil: number }>
    expect(stored[PID]?.keepUntil).toBeGreaterThanOrEqual(now + 120_000)
    const memB = new Map<string, PlayerMemory>()
    restoreMemory(memB, stored, now + 5000)
    const m = memB.get(PID)!
    expect(m.live).toBe(false)
    expect(m.lockedName).toBe('개명된교주')
    expect(m.cd.get('battle.ask')).toBe(now + 30_000)
  })

  it('만료된 메모는 저장하지도 되살리지도 않고, 이미 있는 pid 는 덮어쓰지 않는다', () => {
    const now = 1_000_000
    const mem = new Map<string, PlayerMemory>([
      ['gone', { cd: new Map([['x', now - 5]]), blocked: new Set(), mutedUntil: 0, nameLockUntil: 0, lockedName: '', live: false, keepUntil: now - 1 }],
      ['kept', { cd: new Map([['x', now + 50]]), blocked: new Set(), mutedUntil: 0, nameLockUntil: 0, lockedName: '', live: false, keepUntil: now + 50 }],
    ])
    const stored = serializeMemory(mem, now, () => undefined)
    expect(Object.keys(stored)).toEqual(['kept'])
    const target = new Map<string, PlayerMemory>()
    const mine: PlayerMemory = { cd: new Map(), blocked: new Set(), mutedUntil: 0, nameLockUntil: 0, lockedName: '', live: true, keepUntil: 0 }
    target.set('kept', mine)
    expect(restoreMemory(target, roundTrip(stored), now)).toBe(0)
    expect(target.get('kept')).toBe(mine)
    // 시간이 지나 저장본 자체가 만료됐다
    expect(restoreMemory(new Map(), roundTrip(stored), now + 100)).toBe(0)
  })

  it('깨진 저장본은 그 항목만 버린다', () => {
    const now = 10
    const m = new Map<string, PlayerMemory>()
    const n = restoreMemory(m, { a: null, b: 'x', c: { keepUntil: 99, cd: [['k', 50], [1, 2], 'bad'], blocked: ['p', 3] }, d: { keepUntil: 'soon' } }, now)
    expect(n).toBe(1)
    expect([...m.get('c')!.cd]).toEqual([['k', 50]])
    expect([...m.get('c')!.blocked]).toEqual(['p'])
    expect(restoreMemory(m, undefined, now)).toBe(0)
    expect(restoreMemory(m, 'garbage', now)).toBe(0)
  })

  it('상한을 넘으면 오래 남을 메모부터 남긴다', () => {
    const now = 0
    const mem = new Map<string, PlayerMemory>()
    for (let i = 0; i < MEMORY_SAVE_MAX + 50; i++) {
      mem.set(`p${i}`, { cd: new Map([['k', 1000 + i]]), blocked: new Set(), mutedUntil: 0, nameLockUntil: 0, lockedName: '', live: false, keepUntil: 1000 + i })
    }
    const stored = serializeMemory(mem, now, () => undefined)
    expect(Object.keys(stored).length).toBe(MEMORY_SAVE_MAX)
    expect(stored['p0']).toBeUndefined()
    expect(stored[`p${MEMORY_SAVE_MAX + 49}`]).toBeDefined()
  })
})
