/**
 * Lobby(방 목록/자동 배정) 테스트. 실제 Room 을 쓰되 NPC·기능 시스템은 비워서 가볍게 만든다.
 */
import { describe, expect, it } from 'vitest'
import { MAX_ROOM_COUNT, PROTOCOL_VERSION } from '../../shared/constants'
import type { RoomInfo } from '../../shared/types'
import type { NpcSimApi, RoomHost } from '../../server/core/api'
import { Lobby, roomName } from '../../server/core/lobby'
import { Room } from '../../server/core/room'
import { createSigner } from '../../server/core/save'

/** NPC 가 한 명도 없는 시뮬(로비 테스트에는 필요 없다) */
const emptySim = (): NpcSimApi => ({
  list: [],
  get: () => undefined,
  tick: () => {},
  canTalk: () => 'gone',
  beginListen: () => {},
  endListen: () => {},
  startFollow: () => {},
  release: () => {},
  flee: () => {},
  walkOff: () => {},
  remember: () => {},
  followersOf: () => [],
  gather: () => [],
  ungather: () => {},
  onPlayerLeave: () => {},
  retire: () => {},
  addScripted: () => null,
  removeScripted: () => {},
  publicOf: () => {
    throw new Error('NPC 없음')
  },
})

function makeLobby(roomCount: number, capacity = 3) {
  let now = 1_700_000_000_000
  let lobby: Lobby
  const closed = new Set<number>()
  const host: RoomHost = {
    send: () => {},
    close: (conn) => void closed.add(conn),
    now: () => now,
    random: () => 0.5,
    signer: createSigner('lobby-test'),
    listRooms: (): RoomInfo[] => lobby.rooms(),
    claimPid: () => {},
    log: () => {},
  }
  const made: string[] = []
  lobby = new Lobby((id, name) => {
    made.push(`${id}:${name}`)
    return new Room(host, { id, name, capacity, npcCount: 0, systems: [], seed: 1 }, { createNpcSim: emptySim })
  }, roomCount)
  let conn = 0
  /** 방에 실제 접속자를 n 명 넣는다 */
  const fill = (roomId: string, n: number): number[] => {
    const room = lobby.get(roomId)
    if (!room) throw new Error(`방 ${roomId} 없음`)
    const conns: number[] = []
    for (let i = 0; i < n; i++) {
      const c = ++conn
      room.connect(c)
      room.message(c, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid: `lobby-device-${c}`, name: `손님${c}`, look: [0, 0, 0, 0, 0, 0, 0] }))
      conns.push(c)
    }
    return conns
  }
  /** hello 를 아직 보내지 않은 연결만 걸어 둔다 */
  const pend = (roomId: string, n: number): number[] => {
    const room = lobby.get(roomId)!
    const conns: number[] = []
    for (let i = 0; i < n; i++) {
      const c = ++conn
      room.connect(c)
      conns.push(c)
    }
    return conns
  }
  return { lobby, made, fill, pend, closed, tick: (ms: number) => void (now += ms) }
}

describe('Lobby', () => {
  it("방 id 는 '1','2',… 이고 이름은 출구 번호를 딴다", () => {
    const t = makeLobby(3)
    expect(t.made).toEqual(['1:수상역 1번 출구', '2:수상역 2번 출구', '3:수상역 3번 출구'])
    expect(roomName(12)).toBe('수상역 12번 출구')
    expect(t.lobby.size).toBe(3)
    expect(t.lobby.all()).toHaveLength(3)
    expect(t.lobby.get('2')?.id).toBe('2')
    expect(t.lobby.get('4')).toBeUndefined()
    expect(t.lobby.get('auto')).toBeUndefined()
    expect(t.lobby.rooms()).toEqual([
      { id: '1', name: '수상역 1번 출구', players: 0, cap: 3, npcs: 0 },
      { id: '2', name: '수상역 2번 출구', players: 0, cap: 3, npcs: 0 },
      { id: '3', name: '수상역 3번 출구', players: 0, cap: 3, npcs: 0 },
    ])
  })

  it('방 개수는 1 ~ MAX_ROOM_COUNT 로 맞춘다', () => {
    expect(makeLobby(0).lobby.size).toBe(1)
    expect(makeLobby(-5).lobby.size).toBe(1)
    expect(makeLobby(Number.NaN).lobby.size).toBe(1)
    expect(makeLobby(2.9).lobby.size).toBe(2)
    expect(makeLobby(MAX_ROOM_COUNT + 50).lobby.size).toBe(MAX_ROOM_COUNT)
  })

  it('rooms() 는 실제 접속자 수를 보여 준다(입장 전 연결은 세지 않는다)', () => {
    const t = makeLobby(2)
    t.fill('2', 2)
    t.pend('1', 1)
    expect(t.lobby.rooms().map((r) => r.players)).toEqual([0, 2])
    expect(t.lobby.totalPlayers()).toBe(2)
  })

  it('auto: 전부 비었으면 1번 방', () => {
    const t = makeLobby(3)
    expect(t.lobby.pick('auto')?.id).toBe('1')
    expect(t.lobby.pick(null)?.id).toBe('1')
  })

  it('auto: 자리가 있는 방 중 사람이 가장 많은 방(동률이면 번호가 빠른 방)', () => {
    const t = makeLobby(4)
    t.fill('2', 1)
    t.fill('3', 2)
    expect(t.lobby.pick('auto')?.id).toBe('3')
    t.fill('2', 1) // 2번 2명, 3번 2명 → 번호가 빠른 2번
    expect(t.lobby.pick('auto')?.id).toBe('2')
    t.fill('3', 1) // 3번이 가득(3/3) → 다음으로 많은 2번
    expect(t.lobby.pick('auto')?.id).toBe('2')
    t.fill('2', 1) // 2번도 가득 → 남은 빈 방 중 첫 번째
    expect(t.lobby.pick('auto')?.id).toBe('1')
  })

  it('방을 지정하면 자리가 있는 한 그 방으로', () => {
    const t = makeLobby(3)
    t.fill('1', 2)
    expect(t.lobby.pick('3')?.id).toBe('3')
    expect(t.lobby.pick('1')?.id).toBe('1')
  })

  it('지정한 방이 가득 찼거나 없는 방이면 auto 규칙으로', () => {
    const t = makeLobby(3)
    t.fill('1', 3)
    t.fill('3', 1)
    expect(t.lobby.pick('1')?.id).toBe('3')
    expect(t.lobby.pick('99')?.id).toBe('3')
    expect(t.lobby.pick('')?.id).toBe('3')
    expect(t.lobby.pick('constructor')?.id).toBe('3')
  })

  it('전부 가득이면 undefined, 자리가 나면 다시 배정된다', () => {
    const t = makeLobby(2, 2)
    const first = t.fill('1', 2)
    t.fill('2', 2)
    expect(t.lobby.pick('auto')).toBeUndefined()
    expect(t.lobby.pick('1')).toBeUndefined()
    expect(t.lobby.pick(null)).toBeUndefined()
    t.lobby.get('1')!.disconnect(first[0]!)
    expect(t.lobby.pick('2')?.id).toBe('1')
  })

  it('입장 대기 중인 연결도 자리로 쳐서 한 방에 정원보다 많이 보내지 않는다', () => {
    const t = makeLobby(2, 3)
    t.fill('1', 1)
    const waiting = t.pend('1', 2)
    // 1번은 1명 + 대기 2 = 3 → 꽉 찬 것으로 본다
    expect(t.lobby.pick('1')?.id).toBe('2')
    expect(t.lobby.pick('auto')?.id).toBe('2')
    // 대기 연결이 끊기면 다시 1번(사람이 더 많은 방)으로
    t.lobby.get('1')!.disconnect(waiting[0]!)
    expect(t.lobby.pick('auto')?.id).toBe('1')
  })
})
