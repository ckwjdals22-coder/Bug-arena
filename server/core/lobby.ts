/**
 * Lobby: 방 목록과 자동 배정.
 * 방끼리는 상태를 공유하지 않으므로 로비는 "어느 방으로 보낼까"만 정한다.
 */
import { MAX_ROOM_COUNT } from '../../shared/constants'
import type { RoomInfo } from '../../shared/types'
import type { Room } from './room'

/** 방 표시 이름. 거리 배경이 '수상역 4번 출구'라서 방마다 출구 번호를 붙인다 */
export function roomName(index: number): string {
  return `수상역 ${index}번 출구`
}

/** 모든 방이 이 비율 이상 차면 다음 방을 미리 만든다(자동 증설이 켜져 있을 때) */
export const GROW_AT = 0.8
/** 자동으로 늘어난 방이 이만큼 비어 있으면 정리한다 */
export const EXTRA_ROOM_IDLE_MS = 5 * 60_000

export class Lobby {
  private readonly list: Room[] = []
  private readonly byId = new Map<string, Room>()
  /** 처음부터 있던 방 수. 이 방들은 비어도 없애지 않는다 */
  readonly baseCount: number
  /** 자동 증설 상한. baseCount 와 같으면 증설하지 않는다 */
  readonly maxRooms: number
  /** 증설된 방이 비기 시작한 시각 */
  private readonly emptySince = new Map<string, number>()

  /**
   * roomCount: 처음 만들어 둘 방 수.
   * maxRooms: 자동 증설 상한(생략하면 증설 없음). 모든 방이 GROW_AT 이상 찼을 때 다음 방을 하나 미리 만든다.
   */
  constructor(
    private readonly makeRoom: (id: string, name: string) => Room,
    roomCount: number,
    maxRooms?: number,
  ) {
    const wanted = Number.isFinite(roomCount) ? Math.floor(roomCount) : 1
    const count = Math.max(1, Math.min(MAX_ROOM_COUNT, wanted))
    this.baseCount = count
    const cap = maxRooms !== undefined && Number.isFinite(maxRooms) ? Math.floor(maxRooms) : count
    this.maxRooms = Math.max(count, Math.min(MAX_ROOM_COUNT, cap))
    for (let i = 1; i <= count; i++) this.addRoom(i)
  }

  private addRoom(index: number): Room {
    const id = String(index)
    const room = this.makeRoom(id, roomName(index))
    this.list.push(room)
    this.list.sort((a, b) => Number(a.id) - Number(b.id))
    this.byId.set(id, room)
    return room
  }

  /** 모든 방이 붐비면 다음 방을 미리 만든다. 만들었으면 그 방을 돌려준다 */
  private growIfCrowded(): Room | undefined {
    if (this.list.length >= this.maxRooms) return undefined
    for (const room of this.list) {
      if (room.players.size + room.pending < room.capacity * GROW_AT) return undefined
    }
    let index = this.baseCount + 1
    while (this.byId.has(String(index))) index++
    return this.addRoom(index)
  }

  /**
   * 자동으로 늘어난 방 가운데 오래 비어 있는 방을 정리한다. 어댑터가 가끔(몇 초~수십 초 간격) 불러 준다.
   * 정리한 방 id 목록을 돌려준다.
   */
  sweep(now: number): string[] {
    const removed: string[] = []
    for (const room of [...this.list]) {
      if (Number(room.id) <= this.baseCount) continue
      if (room.players.size + room.pending > 0) {
        this.emptySince.delete(room.id)
        continue
      }
      const since = this.emptySince.get(room.id)
      if (since === undefined) {
        this.emptySince.set(room.id, now)
      } else if (now - since >= EXTRA_ROOM_IDLE_MS) {
        this.emptySince.delete(room.id)
        this.byId.delete(room.id)
        const i = this.list.indexOf(room)
        if (i >= 0) this.list.splice(i, 1)
        removed.push(room.id)
      }
    }
    return removed
  }

  get size(): number {
    return this.list.length
  }

  /** 틱 등에서 순회할 때 쓰는 전체 방 목록(순서 고정) */
  all(): readonly Room[] {
    return this.list
  }

  rooms(): RoomInfo[] {
    return this.list.map((r) => r.info())
  }

  get(id: string): Room | undefined {
    return this.byId.get(id)
  }

  /** 실제 접속자 수 합계(NPC 제외) */
  totalPlayers(): number {
    let n = 0
    for (const r of this.list) n += r.players.size
    return n
  }

  /**
   * 들어갈 방 고르기.
   * - 요청한 방이 있고 자리가 있으면 그 방.
   * - 'auto'·없는 방·가득 찬 방이면: 자리가 있는 방 중 사람이 가장 많은 방(빈 방에 혼자 떨어지지 않게).
   *   전부 비었으면 자연히 1번 방이 된다(동률이면 번호가 빠른 방).
   * - 전부 가득이면 undefined.
   *
   * 자리 계산에는 아직 hello 를 보내지 않은 연결도 넣는다. 한꺼번에 몰릴 때 같은 방으로 정원보다 많이
   * 보내 놓고 뒤늦게 '가득 참'으로 튕기는 일을 줄이기 위해서다.
   */
  pick(requested: string | null): Room | undefined {
    if (requested !== null && requested !== 'auto') {
      const room = this.byId.get(requested)
      if (room && hasSeat(room)) return room
    }
    // 자리가 모자라기 전에 다음 방을 준비해 둔다. 새 방은 비어 있으므로 아래 규칙상 기존 방이 다 찬 뒤에야 쓰인다
    this.growIfCrowded()
    let best: Room | undefined
    let bestPlayers = -1
    for (const room of this.list) {
      if (!hasSeat(room)) continue
      const n = room.players.size
      if (n > bestPlayers) {
        best = room
        bestPlayers = n
      }
    }
    return best
  }
}

function hasSeat(room: Room): boolean {
  return room.players.size + room.pending < room.capacity
}
