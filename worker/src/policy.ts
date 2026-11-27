/**
 * 로비의 방 배정 규칙(순수 로직). Node 의 server/core/lobby.ts 와 같은 정책을 'DO 가 보고한 인원표' 위에서 돌린다.
 *
 * Node 판과 다른 점
 *   - Node 는 Room 객체를 직접 들여다보지만, 여기서는 각 방 DO 가 보내 준 인원 보고(players/pending)만 안다.
 *   - 그래서 '방금 배정했지만 아직 접속이 도착하지 않은' 자리를 reserved 로 잠깐 잡아 둔다.
 *     (한꺼번에 몰릴 때 같은 방으로 정원보다 많이 보내지 않게 — Node 가 pending 을 세는 것과 같은 목적)
 *   - 방 DO 는 배포·재시작 때 '0명' 보고 없이 사라진다 → 보고가 STALE_MS 넘게 끊긴 방은 0명으로 본다.
 */
import type { RoomInfo } from '../../shared/types'
import { EXTRA_ROOM_IDLE_MS, GROW_AT, PENDING_SEAT_CAP, roomName } from '../../server/core/lobby'

/** 운영 설정(env.ts 의 policyOf 가 Worker 환경변수에서 만든다) */
export interface Policy {
  /** 처음부터 있는(비어도 없애지 않는) 방 수 */
  rooms: number
  /** 자동 증설 상한(= rooms 면 증설 안 함) */
  maxRooms: number
  capacity: number
  npcs: number
  maxPreHello: number
  maxConnsPerIp: number
}

/** 방 DO 의 정기 보고 간격 */
export const REPORT_EVERY_MS = 10_000
/** 이만큼 보고가 없으면 그 방은 사라진 것으로 본다(정기 보고 3번 놓침) */
export const STALE_MS = REPORT_EVERY_MS * 3 + 5_000
/** 배정만 하고 접속이 오지 않은 자리를 붙잡아 두는 시간 */
export const RESERVE_MS = 10_000

export interface Occupancy {
  id: string
  players: number
  /** hello 전 연결 수 */
  pending: number
  cap: number
  npcs: number
  /** 마지막 보고 시각(0 = 보고 없음) */
  at: number
  /** 방 DO 인스턴스 표식 + 보고 순번: 늦게 도착한 옛 보고가 새 값을 덮지 않게 */
  inst: string
  seq: number
  /** 배정했지만 아직 보고에 반영되지 않은 자리 */
  reserved: number
  reservedAt: number
  /** 최근 틱 처리 시간 p95(ms, 로컬 개발에서만 의미 있음 — 프로덕션 Date.now() 는 실행 중 멈춰 있다) */
  tickP95: number
  /** 자동 증설로 생긴 방이 비기 시작한 시각 */
  emptySince: number
}

export interface Report {
  id: string
  inst: string
  seq: number
  players: number
  pending: number
  cap: number
  npcs: number
  tickP95: number
}

export class RoomTable {
  readonly rows = new Map<string, Occupancy>()

  constructor(readonly policy: Policy) {
    for (let i = 1; i <= policy.rooms; i++) this.ensure(String(i))
  }

  /** 방 번호로 쓸 수 있는 id 인가(1..maxRooms 정수) */
  validId(id: string): boolean {
    if (!/^\d{1,4}$/.test(id)) return false
    const n = Number(id)
    return n >= 1 && n <= this.policy.maxRooms
  }

  isBase(id: string): boolean {
    return Number(id) <= this.policy.rooms
  }

  ensure(id: string): Occupancy {
    let r = this.rows.get(id)
    if (!r) {
      r = {
        id,
        players: 0,
        pending: 0,
        cap: this.policy.capacity,
        npcs: this.policy.npcs,
        at: 0,
        inst: '',
        seq: 0,
        reserved: 0,
        reservedAt: 0,
        tickP95: 0,
        emptySince: 0,
      }
      this.rows.set(id, r)
    }
    return r
  }

  /** 오래된 보고·예약을 걸러 낸 실제 인원 */
  live(r: Occupancy, now: number): { players: number; pending: number; reserved: number } {
    const stale = r.at === 0 || now - r.at > STALE_MS
    const reserved = now - r.reservedAt > RESERVE_MS ? 0 : r.reserved
    return { players: stale ? 0 : r.players, pending: stale ? 0 : r.pending, reserved }
  }

  /**
   * 자리 계산. 인사(hello) 전 연결은 Node 처럼 PENDING_SEAT_CAP 까지만 친다: 전부 치면 hello 를 보내지 않는 소켓 몇 개로
   * 모든 방을 '가득 참'으로 만들 수 있다. 정원은 방(Room)이 hello 때 다시 확인하므로 느슨하게 세도 넘치지 않는다.
   * 방금 배정한 자리(reserved)는 그대로 센다(한꺼번에 몰린 정상 접속을 여러 방에 나누는 용도, 다음 보고 때 비워진다).
   */
  private used(r: Occupancy, now: number): number {
    const l = this.live(r, now)
    return l.players + Math.min(l.pending, PENDING_SEAT_CAP) + l.reserved
  }

  hasSeat(r: Occupancy, now: number): boolean {
    return this.used(r, now) < r.cap
  }

  /** 방 보고 반영. 바뀐 것이 있으면(저장할 만하면) true */
  report(rep: Report, now: number): boolean {
    if (!this.validId(rep.id)) return false
    // 증설 목록에 없는 방이 보고하면(증설 방이 정리된 뒤 누군가 직접 들어간 경우 등) 표에 다시 올린다
    const r = this.ensure(rep.id)
    if (r.inst === rep.inst && rep.seq <= r.seq) return false
    const changed = r.players !== rep.players || r.pending !== rep.pending || r.cap !== rep.cap || r.at === 0
    r.inst = rep.inst
    r.seq = rep.seq
    r.players = rep.players
    r.pending = rep.pending
    r.cap = rep.cap
    r.npcs = rep.npcs
    r.tickP95 = rep.tickP95
    r.at = now
    // 방이 자기 인원을 알려 왔으니 예약은 그 숫자에 녹아들었다고 본다
    r.reserved = 0
    return changed
  }

  /** 모든 방이 붐비면 다음 방을 미리 연다(Node Lobby.growIfCrowded 와 같은 규칙) */
  private growIfCrowded(now: number): void {
    if (this.rows.size >= this.policy.maxRooms) return
    for (const r of this.rows.values()) {
      if (this.used(r, now) < r.cap * GROW_AT) return
    }
    let index = this.policy.rooms + 1
    while (this.rows.has(String(index))) index++
    if (index <= this.policy.maxRooms) this.ensure(String(index))
  }

  /**
   * 들어갈 방 고르기 — Node Lobby.pick 과 같은 규칙.
   * 요청한 방에 자리가 있으면 그 방, 아니면 자리 있는 방 중 사람이 가장 많은 방(동률이면 번호가 빠른 방). 전부 가득이면 null.
   */
  pick(requested: string | null, now: number): string | null {
    let chosen: Occupancy | undefined
    if (requested !== null && requested !== 'auto') {
      const r = this.rows.get(requested)
      if (r && this.hasSeat(r, now)) chosen = r
    }
    if (!chosen) {
      this.growIfCrowded(now)
      let best = -1
      for (const r of this.sorted()) {
        if (!this.hasSeat(r, now)) continue
        const n = this.live(r, now).players
        if (n > best) {
          chosen = r
          best = n
        }
      }
    }
    if (!chosen) return null
    if (now - chosen.reservedAt > RESERVE_MS) chosen.reserved = 0
    chosen.reserved++
    chosen.reservedAt = now
    return chosen.id
  }

  /** 자동으로 늘어난 방 중 오래 빈 방을 표에서 뺀다. 뺀 id 목록 */
  sweep(now: number): string[] {
    const removed: string[] = []
    for (const r of [...this.rows.values()]) {
      if (this.isBase(r.id)) continue
      if (this.used(r, now) > 0) {
        r.emptySince = 0
        continue
      }
      if (r.emptySince === 0) r.emptySince = now
      else if (now - r.emptySince >= EXTRA_ROOM_IDLE_MS) {
        this.rows.delete(r.id)
        removed.push(r.id)
      }
    }
    return removed
  }

  sorted(): Occupancy[] {
    return [...this.rows.values()].sort((a, b) => Number(a.id) - Number(b.id))
  }

  /** 클라이언트에 보여 줄 방 목록(코어의 RoomInfo 와 같은 모양) */
  list(now: number): RoomInfo[] {
    return this.sorted().map((r) => ({
      id: r.id,
      name: roomName(Number(r.id)),
      players: this.live(r, now).players,
      cap: r.cap,
      npcs: r.npcs,
    }))
  }

  /** 지금 사람이 있는(보고가 살아 있는) 방 */
  liveRooms(now: number, except?: string): string[] {
    const out: string[] = []
    for (const r of this.rows.values()) {
      if (r.id === except) continue
      const l = this.live(r, now)
      if (l.players + l.pending > 0) out.push(r.id)
    }
    return out
  }
}
