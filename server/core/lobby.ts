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

export class Lobby {
  private readonly list: Room[] = []
  private readonly byId = new Map<string, Room>()

  constructor(makeRoom: (id: string, name: string) => Room, roomCount: number) {
    const wanted = Number.isFinite(roomCount) ? Math.floor(roomCount) : 1
    const count = Math.max(1, Math.min(MAX_ROOM_COUNT, wanted))
    for (let i = 1; i <= count; i++) {
      const id = String(i)
      const room = makeRoom(id, roomName(i))
      this.list.push(room)
      this.byId.set(id, room)
    }
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
