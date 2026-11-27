/**
 * RoomDO: 방 하나 = DO 하나. server/core 의 Room 을 그대로 감싼다(server/node/main.ts 와 같은 역할).
 *
 * WebSocket API 선택: 표준 API(server.accept()). Hibernation API 를 쓰지 않는 이유
 *   1. 10Hz 틱(setTimeout)이 걸려 있는 동안은 어차피 동면하지 못한다 → 과금이 같다.
 *   2. 로컬 실측에서 Hibernation API 는 서버가 틱·fetch 문맥에서 close() 한 소켓의 종료가 클라이언트에
 *      10초 늦게, 또는 아예 도착하지 않았다. 코어는 가득 참·중복 접속·무응답을 바로 그 문맥에서 host.close() 한다.
 *   3. 연결 표를 Map 하나로 들고 있으면 되고 '소켓은 살아 있는데 방 메모리는 빈' 복귀 경로가 없다.
 * (근거: docs/research/06-cloudflare-durable-objects.md §3)
 *
 * 남용 방지(Node 어댑터와 같은 규칙, 단 '방 단위'):
 *   - 인사(hello) 전 연결이 MAX_PRE_HELLO 를 넘으면 가장 오래 인사하지 않은 연결부터 끊는다(빈 연결로 방 막기 방지).
 *   - MAX_CONNS_PER_IP(기본 0 = 끔): CF-Connecting-IP 하나가 이 방에 동시에 열 수 있는 연결 수.
 *   - 접속자 메모(쿨타임·차단·입막음·이름 고정·마지막 자리)는 DO 저장소에 남겨 DO 가 내려갔다 깨어나도 이어진다(memory.ts).
 *
 * 과금 핵심: 사람이 없으면 타이머를 지운다. 타이머가 남아 있으면 DO 가 내려가지 못하고 벽시계 시간 전부가 과금된다.
 * 그래서 Node 판처럼 '빈 방도 1초에 한 번 틱'을 하지 않는다. 빈 방의 NPC 는 멈춰 있다가 다음 입장 때 다시 움직인다.
 */
import { DurableObject } from 'cloudflare:workers'
import { TICK_MS } from '../../shared/constants'
import type { RoomInfo } from '../../shared/types'
import type { ConnId, PlayerMemory, RoomHost } from '../../server/core/api'
import { roomName } from '../../server/core/lobby'
import { Room } from '../../server/core/room'
import { createSigner } from '../../server/core/save'
import { CultCache } from './cults'
import { type Env, lobbyStub, policyOf } from './env'
import type { ReportResult } from './lobby'
import { type LiveView, MEMORY_KEY, restoreMemory, serializeMemory } from './memory'
import { REPORT_EVERY_MS } from './policy'

/** close 이후 상대가 답하지 않을 때 연결을 정리하기까지 */
const CLOSE_GRACE_MS = 2000
/** 틱이 이만큼 넘게 밀리면 따라잡기를 포기한다 */
const MAX_CATCHUP_TICKS = 5
/** 종료 사유는 UTF-8 123바이트까지(넘으면 예외) */
const MAX_REASON_BYTES = 120
/** 접속자 메모 저장 주기(변화가 있을 때만 쓴다). 사람이 모두 나가면 바로 쓴다 */
const MEMORY_SAVE_EVERY_MS = 5000
/** 인사 전 연결을 밀어낼 때 쓰는 종료 코드(정책 위반) */
const CLOSE_PRE_HELLO = 1008

interface Conn {
  ws: WebSocket
  closing: boolean
  /** CF-Connecting-IP(IP당 상한 계산용) */
  ip: string
}

/** 오류 로그가 틱마다 쏟아지지 않게 10초당 50건으로 묶는다(로그도 과금 대상이다) */
class LogBudget {
  private budget = 50
  private dropped = 0
  private windowAt = 0

  log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    const now = Date.now()
    if (now - this.windowAt > 10_000) {
      if (this.dropped > 0) console.error(`[error] (같은 기간 오류 ${this.dropped}건 생략)`)
      this.windowAt = now
      this.budget = 50
      this.dropped = 0
    }
    if (level === 'error') {
      if (this.budget <= 0) {
        this.dropped++
        return
      }
      this.budget--
    }
    const detail = extra instanceof Error ? (extra.stack ?? extra.message) : extra
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    if (detail === undefined) out(`[${level}] ${msg}`)
    else out(`[${level}] ${msg}`, detail)
  }
}

function shortReason(reason: string): string {
  const enc = new TextEncoder()
  if (enc.encode(reason).length <= MAX_REASON_BYTES) return reason
  let s = reason
  while (s.length > 0 && enc.encode(s).length > MAX_REASON_BYTES) s = s.slice(0, -1)
  return s
}

export class RoomDO extends DurableObject<Env> {
  private readonly roomId: string
  private readonly room: Room | null
  private readonly conns = new Map<ConnId, Conn>()
  private readonly cults = new CultCache()
  private readonly logger = new LogBudget()
  private readonly maxConns: number
  private readonly maxPreHello: number
  private readonly maxConnsPerIp: number
  /** hello 가 아직 처리되지 않은 연결(삽입 순서 = 오래된 순) */
  private readonly preHello = new Set<ConnId>()
  private readonly connsPerIp = new Map<string, number>()
  /** 접속자 메모. Room 이 이 표를 직접 고친다 → 주기적으로 DO 저장소에 남긴다 */
  private readonly memory = new Map<string, PlayerMemory>()
  private memorySavedJson = ''
  private memorySavedAt = 0
  private memorySaving = false
  /** 쓰는 도중에 '지금 꼭 남겨야 하는' 요청이 오면 끝난 뒤 한 번 더 쓴다 */
  private memorySaveAgain = false
  private nextConn = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextTickAt = 0
  /** 로비가 알려 준 방 목록 사본(RoomHost.listRooms 는 동기라서) */
  private rooms: RoomInfo[] = []
  /** 이 인스턴스 표식 + 보고 순번(로비가 늦게 도착한 옛 보고를 버리게) */
  private readonly inst: string
  private reportSeq = 0
  private reportedPlayers = -1
  private reportedPending = -1
  private lastReportAt = 0
  private reporting = false
  private reportAgain = false
  private readonly tickSamples = new Float64Array(300)
  private tickSampleCount = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // 생성자는 인스턴스가 메모리에 올라올 때마다 다시 돈다(비어서 내려간 뒤, 배포 뒤, 런타임 업데이트 뒤)
    const name = ctx.id.name ?? ''
    this.roomId = /^room-\d{1,4}$/.test(name) ? name.slice(5) : ''
    this.inst = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0x7fffffff).toString(36)}`
    const policy = policyOf(env)
    this.maxConns = policy.capacity * 2 + 20
    this.maxPreHello = policy.maxPreHello
    this.maxConnsPerIp = policy.maxConnsPerIp
    this.rooms = [{ id: this.roomId, name: roomName(Number(this.roomId) || 1), players: 0, cap: policy.capacity, npcs: policy.npcs }]

    const secret = env.SAVE_SECRET?.trim() ?? ''
    if (!this.roomId || secret.length === 0) {
      // 비밀키 없이 돌면 누구나 저장본을 위조할 수 있다 → 방을 열지 않는다(fetch 에서 503)
      this.room = null
      if (!secret) this.logger.log('error', 'SAVE_SECRET 이 설정되지 않아 방을 열지 않습니다(wrangler secret put SAVE_SECRET)')
      return
    }
    const host: RoomHost = {
      send: (conn, data) => this.send(conn, data),
      close: (conn, code, reason) => this.close(conn, code, reason),
      now: () => Date.now(),
      random: () => Math.random(),
      signer: createSigner(secret),
      listRooms: () => this.listRooms(),
      claimPid: (pid, roomId) => this.claimPid(pid, roomId),
      log: (level, msg, extra) => this.logger.log(level, msg, extra),
      cults: this.cults,
    }
    this.room = new Room(host, {
      id: this.roomId,
      name: roomName(Number(this.roomId)),
      capacity: policy.capacity,
      npcCount: policy.npcs,
      memory: this.memory,
    })
    // 깨어날 때 지난번 메모를 되살린다. blockConcurrencyWhile 이 끝나기 전에는 fetch 가 들어오지 않는다
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const stored = await ctx.storage.get(MEMORY_KEY)
        const n = restoreMemory(this.memory, stored, Date.now())
        this.memorySavedJson = stored === undefined ? '' : JSON.stringify(stored)
        if (n > 0) this.logger.log('info', `방 ${this.roomId}: 접속자 메모 ${n}건을 되살렸습니다`)
      } catch (err) {
        this.logger.log('error', `방 ${this.roomId}: 접속자 메모를 읽지 못했습니다`, err)
      }
    })
  }

  // ───────── 접속 ─────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('이 주소는 WebSocket 전용입니다.\n', { status: 426, headers: { upgrade: 'websocket' } })
    }
    const room = this.room
    if (!room) return new Response('서버 설정 오류입니다.\n', { status: 503 })
    // 자리가 없으면 먼저 '인사도 안 하고 버티는' 연결을 밀어낸다 → 빈 연결 수십 개로 방을 막을 수 없다
    while (this.conns.size >= this.maxConns && this.preHello.size > 0) this.evictOldestPreHello()
    if (this.conns.size >= this.maxConns) return new Response('Service Unavailable', { status: 503 })
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (this.maxConnsPerIp > 0 && (this.connsPerIp.get(ip) ?? 0) >= this.maxConnsPerIp) {
      return new Response('Too Many Requests', { status: 429 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // compatibility_date ≥ 2026-03-17 부터 이진 프레임 기본값이 Blob 이다. accept() 전에 바꾼다
    server.binaryType = 'arraybuffer'
    server.accept()

    const id = this.nextConn++
    const c: Conn = { ws: server, closing: false, ip }
    this.conns.set(id, c)
    this.connsPerIp.set(ip, (this.connsPerIp.get(ip) ?? 0) + 1)
    this.preHello.add(id)
    while (this.preHello.size > this.maxPreHello) this.evictOldestPreHello()
    server.addEventListener('message', (ev: MessageEvent) => {
      const data: unknown = ev.data
      if (typeof data === 'string' || data instanceof ArrayBuffer) room.message(id, data)
      this.afterEvent()
    })
    // compatibility_date ≥ 2026-04-07: 상대의 Close 에 런타임이 알아서 답한다
    // 상대가 스스로 닫았으면(1000·1001·1005) 바로 퇴장, 그 밖의 끊김은 방이 잠시 자리를 지켜 준다(Node 어댑터와 같은 규칙)
    server.addEventListener('close', (e) => this.drop(id, e.code === 1000 || e.code === 1001 || e.code === 1005))
    server.addEventListener('error', () => this.drop(id, false))
    room.connect(id)
    this.startLoop()
    this.afterEvent()
    return new Response(null, { status: 101, webSocket: client })
  }

  /** 로비 → 방: 같은 pid 가 다른 방에 들어왔으니 여기서 내보낸다 */
  kickPid(pid: string): boolean {
    if (!this.room || typeof pid !== 'string') return false
    const hit = this.room.kickPid(pid, 'dup')
    if (hit) this.afterEvent()
    return hit
  }

  private drop(id: ConnId, clean = true): void {
    // 표에서 먼저 지운다: 퇴장 처리 중 이 연결로 보내려는 것이 조용히 버려지게
    const c = this.conns.get(id)
    if (!c || !this.conns.delete(id)) return
    this.preHello.delete(id)
    const left = (this.connsPerIp.get(c.ip) ?? 1) - 1
    if (left > 0) this.connsPerIp.set(c.ip, left)
    else this.connsPerIp.delete(c.ip)
    this.room?.disconnect(id, clean)
    this.afterEvent()
    if (this.conns.size === 0) {
      this.stopLoop()
      // 아무도 없으면 곧 DO 가 내려갈 수 있다 → 메모를 지금 남긴다
      this.saveMemory(true)
    }
  }

  /** 가장 오래 인사하지 않은 연결을 끊는다(정상 클라이언트는 수십 ms 안에 hello 를 보낸다) */
  private evictOldestPreHello(): void {
    const oldest = this.preHello.values().next().value as ConnId | undefined
    if (oldest === undefined) return
    this.preHello.delete(oldest)
    const c = this.conns.get(oldest)
    if (c) {
      try {
        c.ws.close(CLOSE_PRE_HELLO, 'hello timeout')
      } catch {
        /* 이미 닫힘 */
      }
    }
    // close 이벤트를 기다리지 않고 바로 자리를 비운다
    this.drop(oldest, true)
  }

  // ───────── 접속자 메모 저장 ─────────

  /** force = 사람이 모두 나갔을 때. 아니면 MEMORY_SAVE_EVERY_MS 에 한 번만. 내용이 같으면 쓰지 않는다 */
  private saveMemory(force = false): void {
    const room = this.room
    if (!room) return
    if (this.memorySaving) {
      if (force) this.memorySaveAgain = true
      return
    }
    const now = Date.now()
    if (!force && now - this.memorySavedAt < MEMORY_SAVE_EVERY_MS) return
    this.memorySavedAt = now
    const byPid = new Map<string, LiveView>()
    for (const p of room.players.values()) byPid.set(p.pid, { mutedUntil: p.mutedUntil, nameLockUntil: p.nameLockUntil, name: p.name })
    const data = serializeMemory(this.memory, now, (pid) => byPid.get(pid))
    const json = JSON.stringify(data)
    if (json === this.memorySavedJson) return
    const empty = json === '{}'
    this.memorySaving = true
    const op = empty ? this.ctx.storage.delete(MEMORY_KEY).then(() => undefined) : this.ctx.storage.put(MEMORY_KEY, data)
    this.ctx.waitUntil(
      op
        .then(() => {
          this.memorySavedJson = empty ? '' : json
        })
        .catch((err: unknown) => this.logger.log('error', `방 ${this.roomId}: 접속자 메모 저장 실패`, err))
        .finally(() => {
          this.memorySaving = false
          if (this.memorySaveAgain) {
            this.memorySaveAgain = false
            this.saveMemory(true)
          }
        }),
    )
  }

  // ───────── RoomHost ─────────

  private send(id: ConnId, data: string | Uint8Array): void {
    const c = this.conns.get(id)
    if (!c || c.closing) return
    // Room 이 welcome 을 보냈다 = 인사를 마친 정상 접속
    if (this.preHello.size > 0 && typeof data === 'string' && data.startsWith('{"t":"welcome"')) this.preHello.delete(id)
    try {
      c.ws.send(data)
    } catch {
      // Close 를 보낸(또는 받은) 소켓에 send() 하면 예외 → 끊긴 연결로 정리(비정상 끊김: 방이 잠시 자리를 지켜 준다)
      this.drop(id, false)
    }
  }

  private close(id: ConnId, code: number, reason: string): void {
    const c = this.conns.get(id)
    if (!c || c.closing) return
    c.closing = true
    try {
      c.ws.close(code, shortReason(reason))
    } catch {
      this.drop(id)
      return
    }
    // 상대가 Close 에 답하지 않으면(죽은 연결) close 이벤트가 늦는다 → 잠깐 뒤 직접 정리한다.
    // 이 타이머는 2초짜리라 DO 가 내려가는 것을 오래 막지 않는다
    setTimeout(() => this.drop(id), CLOSE_GRACE_MS)
  }

  private listRooms(): RoomInfo[] {
    // 사본은 최대 REPORT_EVERY_MS 묵었을 수 있다. 내 방 인원만큼은 지금 값으로 고쳐 준다
    const room = this.room
    if (!room) return this.rooms
    const mine = room.info()
    let found = false
    const out = this.rooms.map((r) => {
      if (r.id !== mine.id) return r
      found = true
      return mine
    })
    if (!found) out.push(mine)
    return out.sort((a, b) => Number(a.id) - Number(b.id))
  }

  private claimPid(pid: string, roomId: string): void {
    this.ctx.waitUntil(
      lobbyStub(this.env)
        .claimPid(pid, roomId)
        .catch((err: unknown) => this.logger.log('warn', '로비에 pid 알림 실패', err)),
    )
  }

  // ───────── 틱: 매번 다시 거는 setTimeout + 밀림 보정 ─────────

  private startLoop(): void {
    if (this.timer !== null) return
    this.nextTickAt = Date.now() + TICK_MS
    this.timer = setTimeout(this.onTimer, TICK_MS)
  }

  private stopLoop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private readonly onTimer = (): void => {
    this.timer = null
    const room = this.room
    if (!room || this.conns.size === 0) return
    const now = Date.now()
    let steps = 0
    while (now >= this.nextTickAt && steps < MAX_CATCHUP_TICKS) {
      const t0 = performance.now()
      try {
        room.tick()
      } catch (err) {
        // 예외로 루프가 끊기면 방이 조용히 멈춘다 → 반드시 잡는다
        this.logger.log('error', `방 ${this.roomId} 틱 예외`, err)
      }
      // 프로덕션에서는 실행 중 시계가 멈춰 있어 0 에 가깝게 나온다(로컬 개발에서만 의미 있는 값)
      this.tickSamples[this.tickSampleCount++ % this.tickSamples.length] = performance.now() - t0
      this.nextTickAt += TICK_MS
      steps++
    }
    if (now >= this.nextTickAt) this.nextTickAt = now + TICK_MS
    this.afterEvent()
    if (this.conns.size === 0) return
    this.timer = setTimeout(this.onTimer, Math.max(1, this.nextTickAt - Date.now()))
  }

  // ───────── 로비 보고 ─────────

  /** 이벤트 뒤마다: 인원이 바뀌었거나 정기 보고 때가 됐거나 교단 기록이 쌓였으면 보고한다 */
  private afterEvent(): void {
    const room = this.room
    if (!room || !this.roomId) return
    const now = Date.now()
    const changed = room.players.size !== this.reportedPlayers || room.pending !== this.reportedPending
    const due = now - this.lastReportAt >= REPORT_EVERY_MS
    const cultsDue = this.cults.pendingOps > 0 && now - this.lastReportAt >= 2000
    if (changed || due || cultsDue) this.report()
    this.saveMemory()
  }

  private report(): void {
    const room = this.room
    if (!room) return
    if (this.reporting) {
      // 한 번에 하나만 보낸다(교단 작업이 두 번 실리지 않게). 끝나면 최신 값으로 한 번 더
      this.reportAgain = true
      return
    }
    this.reporting = true
    this.reportAgain = false
    const players = room.players.size
    const pending = room.pending
    this.reportedPlayers = players
    this.reportedPending = pending
    this.lastReportAt = Date.now()
    const ops = this.cults.take()
    const rep = {
      id: this.roomId,
      inst: this.inst,
      seq: ++this.reportSeq,
      players,
      pending,
      cap: room.capacity,
      npcs: room.npcs.list.length,
      tickP95: this.tickP95(),
    }
    this.ctx.waitUntil(
      lobbyStub(this.env)
        .report(rep, ops, this.cults.seq)
        .then((res: ReportResult) => {
          if (Array.isArray(res.rooms)) this.rooms = res.rooms
          if (res.cults) this.cults.applySync(res.cults)
        })
        .catch((err: unknown) => {
          this.cults.failed()
          this.logger.log('warn', `방 ${this.roomId}: 로비 보고 실패`, err)
        })
        .finally(() => {
          this.reporting = false
          if (this.reportAgain) this.afterEventForce()
        }),
    )
  }

  private afterEventForce(): void {
    this.reportedPlayers = -1
    this.afterEvent()
  }

  private tickP95(): number {
    const n = Math.min(this.tickSampleCount, this.tickSamples.length)
    if (n === 0) return 0
    const s = Array.from(this.tickSamples.subarray(0, n)).sort((a, b) => a - b)
    return Math.round((s[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0) * 1000) / 1000
  }
}
