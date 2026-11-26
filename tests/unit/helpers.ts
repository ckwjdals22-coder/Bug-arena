/**
 * 서버 단위 테스트 공용 도우미: 가짜 호스트(FakeHost), 가짜 NPC 시뮬(FakeSim), 작은 시험용 월드, setup().
 *
 *   const t = setup({ systems: [createCultSystem] })
 *   const a = t.join({ name: "교주" })            // { conn, id, w(elcome) }
 *   t.send(a.conn, { t: "cultCreate", ... })      // 클라이언트 메시지 보내기
 *   t.host.of(a.conn, "cultRes")                  // 그 연결이 받은 특정 종류 메시지
 *   t.advance(1000)                               // 시계를 돌리며 틱
 *   t.talk(a, npcId); t.pitch(a, npcId, R_JOIN)   // 포교(판정 난수 지정)
 *
 * FakeSim 은 NPC 를 움직이지 않는다(계약대로 상태만 바꾸고 호출을 기록). 실제 이동이 필요한 테스트는
 * setup({ realSim: true }) 로 진짜 createNpcSim 을 쓴다.
 */
import {
  Anim,
  EMOTE_COOLDOWN_MS,
  HELLO_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  INF_FAIL,
  INF_JOIN,
  INF_MORE,
  INF_STREAK_BONUS,
  LINES_PER_TALK,
  MAX_ENTOURAGE,
  MAX_MSG_BYTES,
  NAME_MAX,
  NPC_REJECT_MEMORY_MS,
  PITCH_COOLDOWN_MS,
  PROTOCOL_VERSION,
  RATE_LIMIT_PER_SEC,
  RUN_SPEED,
  SAY_COOLDOWN_MS,
  SPRINT_COOLDOWN_MS,
  SPRINT_MS,
  SPRINT_SPEED,
  TALK_RANGE,
  TALK_TIMEOUT_MS,
  TICK_MS,
} from '../../shared/constants'
import { ACHIEVEMENTS } from '../../shared/content/achievements'
import { EMOTES, RANKS, STAT, rankForInfluence } from '../../shared/content/core'
import { PITCH_LINES } from '../../shared/content/lines'
import { QUICK_CHATS } from '../../shared/content/misc'
import type { Archetype } from '../../shared/content/types'
import {
  CLOSE_BAD,
  CLOSE_FULL,
  CLOSE_KICK,
  CLOSE_SHUTDOWN,
  type ClientMsg,
  type ServerMsg,
  type ServerMsgOf,
  type ServerMsgType,
  type Snapshot,
  decodeSnapshot,
  encodeMove,
} from '../../shared/protocol'
import type { Rnd } from '../../shared/rng'
import { checkNickname } from '../../shared/rules/moderation'
import type { CultScore, Look, NpcPublic, Progress, RoomInfo, SignedSave } from '../../shared/types'
import type { WorldDef } from '../../shared/world/def'
import type {
  CultRegistry,
  NpcSimApi,
  NpcSimEvents,
  NpcState,
  PlayerState,
  RoomApi,
  RoomHost,
  RoomSystem,
  RoomSystemFactory,
} from '../../server/core/api'
import { MAX_HELLO_BYTES, Room } from '../../server/core/room'
import { createSigner } from '../../server/core/save'
import { createNpcSim } from '../../server/core/npcSim'

// ───────────────────────── 가짜 호스트 ─────────────────────────

export class FakeHost implements RoomHost {
  t = 1_700_000_000_000
  readonly frames = new Map<number, (string | Uint8Array)[]>()
  readonly closes = new Map<number, { code: number; reason: string }>()
  readonly logs: { level: string; msg: string; extra?: unknown }[] = []
  readonly claims: [string, string][] = []
  roomList: RoomInfo[] = [{ id: '9', name: '다른 방', players: 3, cap: 20, npcs: 28 }]
  readonly signer = createSigner('unit-test-secret')
  cults?: CultRegistry
  private seed = 20261126

  send(conn: number, data: string | Uint8Array): void {
    // 계약: 닫힌 연결로 보낸 것은 조용히 버린다
    if (this.closes.has(conn)) return
    let list = this.frames.get(conn)
    if (!list) this.frames.set(conn, (list = []))
    list.push(data)
  }
  close(conn: number, code: number, reason: string): void {
    if (!this.closes.has(conn)) this.closes.set(conn, { code, reason })
  }
  now(): number {
    return this.t
  }
  random(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }
  listRooms(): RoomInfo[] {
    return this.roomList
  }
  claimPid(pid: string, roomId: string): void {
    this.claims.push([pid, roomId])
  }
  log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    this.logs.push({ level, msg, extra })
  }

  json(conn: number): ServerMsg[] {
    const out: ServerMsg[] = []
    for (const f of this.frames.get(conn) ?? []) if (typeof f === 'string') out.push(JSON.parse(f) as ServerMsg)
    return out
  }
  of<T extends ServerMsgType>(conn: number, t: T): ServerMsgOf<T>[] {
    return this.json(conn).filter((m): m is ServerMsgOf<T> => m.t === t)
  }
  snaps(conn: number): Snapshot[] {
    const out: Snapshot[] = []
    for (const f of this.frames.get(conn) ?? []) {
      if (typeof f === 'string') continue
      const snap = decodeSnapshot(f)
      if (!snap) throw new Error('해독할 수 없는 바이너리 프레임')
      out.push(snap)
    }
    return out
  }
  clear(): void {
    this.frames.clear()
  }
  errors(): string[] {
    return this.logs.filter((l) => l.level === 'error').map((l) => `${l.msg} ${String(l.extra)}`)
  }
}

// ───────────────────────── 가짜 NPC 시뮬 ─────────────────────────

export const LOOK0: Look = [0, 0, 0, 0, 0, 0, 0]

export function makeArch(over: Partial<Archetype> = {}): Archetype {
  return {
    id: 'test',
    name: '시험 시민',
    desc: '테스트용',
    names: ['시민'],
    weight: 1,
    base: 0.5,
    like: {},
    flee: 0.5,
    ignore: 0.5,
    curious: 0.5,
    speed: 1,
    look: { outfits: [0], hats: [0], colors: [0], faces: [0], accs: [0] },
    greet: ['네? 저요?'],
    re: { join: ['합류할게요'], more: ['더 들어볼게요'], no: ['싫어요'], flee: ['으악'], ignore: ['(못 들은 척)'] },
    mutter: ['배고프다'],
    follow: ['교주님!'],
    leave: ['어? 제가 왜 여기 있죠?'],
    ...over,
  }
}

/** api.ts 의 NpcSimApi 설명대로만 움직이는 최소 구현 + 호출 기록 */
export class FakeSim {
  readonly calls: string[] = []
  readonly list: NpcState[] = []
  events!: NpcSimEvents
  ticks = 0
  lastDt = -1
  lastFlee: { npc: number; x: number; z: number } | null = null
  throwOnTick = false

  readonly factory = (_world: WorldDef, _rnd: Rnd, events: NpcSimEvents, count: number): NpcSimApi => {
    this.events = events
    const arch = makeArch()
    for (let i = 0; i < count; i++) {
      this.list.push({
        id: i + 1,
        arch,
        name: `시민${i + 1}`,
        look: LOOK0,
        model: 0,
        role: '',
        x: -12 + i * 3,
        z: 8,
        yaw: 0,
        st: Anim.Idle,
        mode: 'pause',
        owner: 0,
        talker: 0,
        until: 0,
        followSince: 0,
        offered: false,
        memo: new Map(),
        dirty: true,
      })
    }
    const list = this.list
    const calls = this.calls
    const api: NpcSimApi = {
      list,
      get: (id) => list[id - 1],
      tick: (_now, dt) => {
        this.ticks++
        this.lastDt = dt
        if (this.throwOnTick) throw new Error('sim boom')
      },
      canTalk: (npc, playerId, now) => {
        if (npc.mode === 'leave' || npc.mode === 'enter' || npc.mode === 'flee' || npc.mode === 'script') return 'gone'
        if (npc.talker !== 0 && npc.talker !== playerId) return 'busy'
        if ((npc.memo.get(playerId) ?? 0) > now) return 'memo'
        return 'ok'
      },
      beginListen: (npc, player, until) => {
        calls.push(`beginListen:${npc.id}:${player.id}:${until}`)
        npc.mode = 'listen'
        npc.talker = player.id
        npc.until = until
        npc.st = Anim.Listen
        npc.dirty = true
      },
      endListen: (npc) => {
        calls.push(`endListen:${npc.id}`)
        npc.talker = 0
        npc.mode = npc.owner ? 'follow' : 'pause'
        npc.st = Anim.Idle
        npc.dirty = true
      },
      startFollow: (npc, playerId, until, now) => {
        calls.push(`startFollow:${npc.id}:${playerId}:${until}`)
        const prev = npc.owner
        npc.owner = playerId
        npc.talker = 0
        npc.mode = 'follow'
        npc.until = until
        npc.followSince = now
        npc.offered = false
        npc.dirty = true
        events.onOwnerChange(npc, prev, prev ? 'poach' : 'join')
      },
      release: (npc, reason) => {
        calls.push(`release:${npc.id}:${reason}`)
        const prev = npc.owner
        if (!prev) return
        npc.owner = 0
        npc.mode = 'pause'
        npc.dirty = true
        events.onSay(npc, npc.arch.leave[0] ?? '…')
        events.onOwnerChange(npc, prev, reason)
      },
      flee: (npc, x, z) => {
        calls.push(`flee:${npc.id}`)
        this.lastFlee = { npc: npc.id, x, z }
        npc.talker = 0
        npc.mode = 'pause'
        npc.dirty = true
      },
      walkOff: (npc) => {
        calls.push(`walkOff:${npc.id}`)
        npc.talker = 0
        npc.mode = 'pause'
        npc.dirty = true
      },
      remember: (npc, playerId, until) => {
        calls.push(`remember:${npc.id}:${playerId}:${until}`)
        npc.memo.set(playerId, until)
      },
      followersOf: (playerId) => list.filter((n) => n.owner === playerId),
      gather: (_center, _radius, until, max) => {
        calls.push(`gather:${max}`)
        const out: NpcState[] = []
        for (const n of list) {
          if (out.length >= max) break
          if (n.mode !== 'pause' || n.owner !== 0 || n.talker !== 0) continue
          n.mode = 'gather'
          n.until = until
          n.st = Anim.Cheer
          n.dirty = true
          out.push(n)
        }
        return out
      },
      ungather: () => {
        calls.push('ungather')
        for (const n of list) {
          if (n.mode !== 'gather') continue
          n.mode = 'pause'
          n.st = Anim.Idle
          n.dirty = true
        }
      },
      onPlayerLeave: (playerId) => {
        calls.push(`onPlayerLeave:${playerId}`)
        for (const n of list) {
          if (n.talker === playerId) api.endListen(n)
          if (n.owner === playerId) api.release(n, 'leave')
          n.memo.delete(playerId)
        }
      },
      retire: (npc) => {
        calls.push(`retire:${npc.id}`)
      },
      addScripted: (arch, role, name, look, x, z) => {
        if (list.length >= 255) return null
        const npc: NpcState = {
          id: list.length + 1, arch, name, look, model: arch.model ?? 0, role, x, z, yaw: 0, st: Anim.Idle,
          mode: 'script', owner: 0, talker: 0, until: 0, followSince: 0, offered: false, memo: new Map(), dirty: true,
        }
        list.push(npc)
        calls.push(`addScripted:${npc.id}:${role}`)
        return npc
      },
      removeScripted: (npc) => {
        calls.push(`removeScripted:${npc.id}`)
        npc.mode = 'leave'
      },
      publicOf: (npc): NpcPublic => ({
        id: npc.id,
        arch: npc.arch.id,
        name: npc.name,
        look: npc.look,
        model: npc.model,
        x: npc.x,
        z: npc.z,
        yaw: npc.yaw,
        st: npc.st,
        owner: npc.owner,
        role: npc.role,
      }),
    }
    return api
  }

  called(prefix: string): string[] {
    return this.calls.filter((c) => c.startsWith(prefix))
  }
}

// ───────────────────────── 시험용 월드 ─────────────────────────

/** 실제 맵 데이터는 바뀔 수 있으므로 검증에 필요한 것만 있는 작은 맵을 쓴다 */
export const TEST_WORLD: WorldDef = {
  bounds: { x0: -20, z0: -20, x1: 20, z1: 20 },
  boxes: [{ x0: 10, z0: -12, x1: 12, z1: -10 }],
  circles: [],
  podium: { x: 0, z: -15, r: 1.5, h: 0.5, ramp: 1 },
  plaza: { x: 0, z: -15, r: 4 },
  offeringBox: { x: 15, z: 15, r: 1 },
  tent: { x: 15, z: 15, r: 2 },
  subway: { x: -15, z: -15, r: 1, yaw: 0 },
  booths: [],
  hq: {
    door: { x: 0, z: 15, r: 1 },
    gate: { x0: -1, z0: 14, x1: 1, z1: 15 },
    inside: { x0: -3, z0: 15, x1: 3, z1: 19 },
    minRank: 3,
  },
  spawns: [{ x: 0, z: 0, yaw: 0 }],
  nav: {
    nodes: [
      { x: 0, z: 0, kind: 'walk' },
      { x: 5, z: 0, kind: 'walk' },
    ],
    edges: [[0, 1]],
  },
}

// ───────────────────────── 테스트 도우미 ─────────────────────────

export interface SetupOpts {
  capacity?: number
  npcs?: number
  systems?: RoomSystemFactory[]
  cults?: CultRegistry
  /** true 면 진짜 NPC 시뮬(createNpcSim)을 쓴다. 이때 t.sim.list 는 비어 있고 t.room.npcs 를 직접 쓴다 */
  realSim?: boolean
  world?: WorldDef
  seed?: number
}

export interface JoinOpts {
  pid?: string
  name?: unknown
  look?: unknown
  save?: SignedSave | null
  v?: number
}

/** 판정 난수를 순서대로 지정한다(room.rnd 를 바꿔 끼움). 다 쓰면 0.5 */
export function scriptRnd(room: Room): { push: (...v: number[]) => void } {
  const queue: number[] = []
  ;(room as unknown as { rnd: Rnd }).rnd = () => (queue.length > 0 ? (queue.shift() as number) : 0.5)
  return { push: (...v) => void queue.push(...v) }
}

// resolvePitch 의 난수 소비 순서: [합류?] → (1라운드만)[더 듣기?] → [도망?] → [무시?]
export const R_JOIN = [0]
export const R_MORE = [0.99, 0]
export const R_FLEE = [0.99, 0.99, 0]
export const R_IGNORE = [0.99, 0.99, 0.99, 0]
export const R_NO = [0.99, 0.99, 0.99, 0.99]

export function setup(o: SetupOpts = {}) {
  const host = new FakeHost()
  if (o.cults) host.cults = o.cults
  const sim = new FakeSim()
  const room = new Room(
    host,
    { id: '1', name: '시험 방', capacity: o.capacity ?? 20, npcCount: o.npcs ?? 9, seed: o.seed ?? 7, world: o.world ?? TEST_WORLD, systems: o.systems ?? [] },
    { createNpcSim: o.realSim ? createNpcSim : sim.factory },
  )
  const script = scriptRnd(room)
  let nextConn = 1

  const send = (conn: number, msg: ClientMsg | Record<string, unknown>): void => room.message(conn, JSON.stringify(msg))
  const hello = (conn: number, j: JoinOpts = {}): void => {
    room.connect(conn)
    send(conn, {
      t: 'hello',
      v: j.v ?? PROTOCOL_VERSION,
      pid: j.pid ?? `device-${conn}-abcdefgh`,
      name: j.name === undefined ? `손님${conn}` : j.name,
      look: j.look ?? LOOK0,
      save: j.save ?? null,
    })
  }
  const join = (j: JoinOpts = {}) => {
    const conn = nextConn++
    hello(conn, j)
    const w = host.of(conn, 'welcome')[0]
    if (!w) throw new Error(`welcome 을 받지 못함: ${JSON.stringify(host.json(conn))}`)
    return { conn, id: w.id, w }
  }
  const player = (id: number): PlayerState => {
    const p = room.players.get(id)
    if (!p) throw new Error(`플레이어 ${id} 없음`)
    return p
  }
  const move = (conn: number, x: number, z: number, yaw = 0, st: number = Anim.Walk): void =>
    room.message(conn, encodeMove(x, z, yaw, st))
  /** 시계를 돌리며 틱한다 */
  const advance = (ms: number): void => {
    for (let left = ms; left > 0; left -= TICK_MS) {
      host.t += Math.min(TICK_MS, left)
      room.tick()
    }
  }
  const npc = (id: number): NpcState => {
    const n = room.npcs.get(id)
    if (!n) throw new Error(`NPC ${id} 없음`)
    return n
  }
  /** NPC 옆으로 옮겨 놓고 말을 건다 */
  const talk = (who: { conn: number; id: number }, npcId: number): void => {
    const p = player(who.id)
    const n = npc(npcId)
    p.x = n.x + 1
    p.z = n.z
    send(who.conn, { t: 'talk', n: npcId })
  }
  /** 제시된 첫 멘트로 포교한다. rnd 는 판정 난수 */
  const pitch = (who: { conn: number; id: number }, npcId: number, rnd: number[], lineIndex = 0): number => {
    const line = player(who.id).talk?.lines[lineIndex]
    if (line === undefined) throw new Error('열린 대화가 없음')
    script.push(...rnd)
    send(who.conn, { t: 'pitch', n: npcId, l: line })
    return line
  }
  const stat = (id: number, key: string): number => player(id).prog.stats[key] ?? 0

  return { host, sim, room, script, send, hello, join, player, move, advance, npc, talk, pitch, stat, nextConn: () => nextConn++ }
}


export { LOOK0 as TEST_LOOK }
export type TestRoom = ReturnType<typeof setup>
