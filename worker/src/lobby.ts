/**
 * LobbyDO: 싱글턴(이름 "lobby"). 방 인원표 · 자동 배정 · 중복 pid 정리 · 교단 기록 원본.
 *
 * 게임 메시지는 여기를 지나지 않는다(방 DO 로 바로 간다). 로비를 부르는 것은
 *   Worker: /api/rooms, /healthz, /ws 의 방 고르기 1회
 *   방 DO : 인원이 바뀔 때 + REPORT_EVERY_MS 마다 보고, 새 플레이어의 pid 알림
 * 뿐이라 DO 하나의 처리량 한도(초당 약 1,000건)에서 멀다.
 *
 * 타이머·소켓이 없어서 요청이 끊기면 곧 메모리에서 내려간다 → 상태는 SQLite 에 두고 생성자에서 다시 읽는다.
 * 저장소 API 는 동기라서 생성자/메서드 안에서 await 없이 쓴다.
 */
import { DurableObject } from 'cloudflare:workers'
import type { RoomInfo } from '../../shared/types'
import { type CultOp, type CultSync, CultStore } from './cults'
import { type Env, type Policy, policyOf, roomStub } from './env'
import { type Report, RoomTable } from './policy'

/** 인원이 그대로여도 이 간격으로는 저장한다(로비가 재시작된 뒤 '살아 있는 방'으로 보이게) */
const PERSIST_EVERY_MS = 60_000
/** pid → 방 기억 상한. 넘치면 오래된 것부터 잊는다 */
const MAX_PIDS = 50_000
/**
 * 로비 인스턴스가 막 올라온 직후에는 이전 인스턴스가 알던 pid 를 모른다.
 * 그동안은 모르는 pid 가 오면 '사람이 있는 다른 방 전부'에 확인을 보낸다(이후엔 기억표만 쓴다).
 */
const FANOUT_WINDOW_MS = 30 * 60_000

export interface ReportResult {
  rooms: RoomInfo[]
  cults: CultSync
}

export interface Health {
  ok: boolean
  rooms: number
  players: number
  tickMsP95: number
  tickMsMax: number
}

export class LobbyDO extends DurableObject<Env> {
  private readonly policy: Policy
  private readonly table: RoomTable
  private readonly cults: CultStore
  private readonly pids = new Map<string, string>()
  private readonly bornAt = Date.now()
  private readonly savedAt = new Map<string, number>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.policy = policyOf(env)
    this.table = new RoomTable(this.policy)
    const sql = ctx.storage.sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, players INTEGER NOT NULL, pending INTEGER NOT NULL, cap INTEGER NOT NULL, npcs INTEGER NOT NULL, at INTEGER NOT NULL)',
    )
    type Row = { id: string; players: number; pending: number; cap: number; npcs: number; at: number }
    for (const r of sql.exec<Row>('SELECT id, players, pending, cap, npcs, at FROM rooms')) {
      // 설정(MAX_ROOMS)이 줄었으면 범위 밖의 옛 방은 버린다
      if (!this.table.validId(r.id)) continue
      const o = this.table.ensure(r.id)
      o.players = r.players
      o.pending = r.pending
      o.cap = r.cap
      o.npcs = r.npcs
      o.at = r.at
    }
    this.cults = new CultStore(sql)
  }

  // ───────── Worker → 로비 ─────────

  /** 방 목록(/api/rooms). 오래 빈 증설 방은 이때 정리한다(로비에는 타이머가 없다) */
  list(): { rooms: RoomInfo[]; policy: { capacity: number; rooms: number; maxRooms: number } } {
    const now = Date.now()
    this.sweep(now)
    return {
      rooms: this.table.list(now),
      policy: { capacity: this.policy.capacity, rooms: this.policy.rooms, maxRooms: this.policy.maxRooms },
    }
  }

  /** 들어갈 방 id. 전부 가득이면 null(그때 Worker 가 full 안내를 보낸다) */
  pick(requested: string | null, resume = false): string | null {
    const now = Date.now()
    this.sweep(now)
    const req = typeof requested === 'string' && /^[\w-]{1,16}$/.test(requested) ? requested : null
    return this.table.pick(req, now, resume === true)
  }

  health(): Health {
    const now = Date.now()
    const rooms = this.table.list(now)
    let p95 = 0
    for (const r of this.table.rows.values()) if (this.table.live(r, now).players > 0) p95 = Math.max(p95, r.tickP95)
    return { ok: true, rooms: rooms.length, players: rooms.reduce((n, r) => n + r.players, 0), tickMsP95: p95, tickMsMax: p95 }
  }

  // ───────── 방 DO → 로비 ─────────

  /** 인원 보고 + 교단 기록 동기화. 응답으로 방 목록 사본과 교단 변경분을 돌려준다 */
  report(rep: Report, cultOps: CultOp[], cultSince: number): ReportResult {
    const now = Date.now()
    const clean = cleanReport(rep)
    if (clean && this.table.report(clean, now)) this.persist(clean.id, now, true)
    else if (clean) this.persist(clean.id, now, false)
    if (Array.isArray(cultOps) && cultOps.length > 0) this.cults.apply(cultOps)
    this.sweep(now)
    return { rooms: this.table.list(now), cults: this.cults.since(Number(cultSince) || 0) }
  }

  /**
   * 새 플레이어가 roomId 에 들어왔다. 같은 pid 가 다른 방에 있으면 그 방에서 내보낸다
   * (Node 어댑터의 claimPid 와 같은 의미. 같은 방 안의 중복은 Room 이 직접 처리한다).
   */
  claimPid(pid: string, roomId: string): void {
    if (typeof pid !== 'string' || pid.length > 64 || typeof roomId !== 'string' || !this.table.validId(roomId)) return
    const prev = this.pids.get(pid)
    this.pids.delete(pid)
    this.pids.set(pid, roomId)
    if (this.pids.size > MAX_PIDS) {
      const oldest = this.pids.keys().next().value
      if (oldest !== undefined) this.pids.delete(oldest)
    }
    const now = Date.now()
    let targets: string[] = []
    if (prev !== undefined) {
      if (prev !== roomId) targets = [prev]
    } else if (now - this.bornAt < FANOUT_WINDOW_MS) {
      targets = this.table.liveRooms(now, roomId)
    }
    for (const id of targets) {
      // 비어 있는 방 DO 를 깨우지 않도록 사람이 있다고 보고된 방에만 보낸다(prev 도 마찬가지로 확인)
      const r = this.table.rows.get(id)
      if (!r) continue
      const l = this.table.live(r, now)
      if (l.players + l.pending === 0) continue
      this.ctx.waitUntil(
        roomStub(this.env, id)
          .kickPid(pid)
          .catch((err: unknown) => console.warn(`[lobby] 방 ${id} 에 중복 접속 정리 요청 실패`, err)),
      )
    }
  }

  // ───────── 내부 ─────────

  private sweep(now: number): void {
    const removed = this.table.sweep(now)
    for (const id of removed) {
      this.ctx.storage.sql.exec('DELETE FROM rooms WHERE id = ?', id)
      this.savedAt.delete(id)
    }
  }

  private persist(id: string, now: number, changed: boolean): void {
    const last = this.savedAt.get(id) ?? 0
    // 행 쓰기도 과금 대상이라 인원이 바뀌었을 때와 1분에 한 번만 쓴다
    if (!changed && now - last < PERSIST_EVERY_MS) return
    const r = this.table.rows.get(id)
    if (!r) return
    this.savedAt.set(id, now)
    this.ctx.storage.sql.exec(
      'INSERT INTO rooms (id, players, pending, cap, npcs, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET players = excluded.players, pending = excluded.pending, cap = excluded.cap, npcs = excluded.npcs, at = excluded.at',
      r.id,
      r.players,
      r.pending,
      r.cap,
      r.npcs,
      r.at,
    )
  }
}

const num = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0)

function cleanReport(rep: unknown): Report | null {
  if (!rep || typeof rep !== 'object') return null
  const o = rep as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.inst !== 'string') return null
  return {
    id: o.id,
    inst: o.inst.slice(0, 40),
    seq: num(o.seq, Number.MAX_SAFE_INTEGER),
    players: num(o.players, 1000),
    pending: num(o.pending, 1000),
    cap: Math.max(1, num(o.cap, 1000)),
    npcs: num(o.npcs, 1000),
    tickP95: typeof o.tickP95 === 'number' && Number.isFinite(o.tickP95) ? Math.max(0, o.tickP95) : 0,
  }
}
