/**
 * Room 단위 테스트.
 *
 * NPC 시뮬·월드·기능 시스템은 다른 담당이 병렬로 다시 쓰는 중이라, 여기서는 계약(NpcSimApi/RoomSystem)만 따르는
 * 가짜 구현을 끼워 Room 자체의 동작만 본다(맨 아래 '기본 구성' 테스트만 실제 구현과 함께 돌린다).
 */
import { describe, expect, it } from 'vitest'
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

// ───────────────────────── 가짜 호스트 ─────────────────────────

class FakeHost implements RoomHost {
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

const LOOK0: Look = [0, 0, 0, 0, 0, 0, 0]

function makeArch(over: Partial<Archetype> = {}): Archetype {
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
class FakeSim {
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
      gather: () => [],
      ungather: () => {},
      onPlayerLeave: (playerId) => {
        calls.push(`onPlayerLeave:${playerId}`)
        for (const n of list) {
          if (n.talker === playerId) api.endListen(n)
          if (n.owner === playerId) api.release(n, 'leave')
          n.memo.delete(playerId)
        }
      },
      retire: () => {},
      addScripted: () => null,
      removeScripted: () => {},
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
const TEST_WORLD: WorldDef = {
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

interface SetupOpts {
  capacity?: number
  npcs?: number
  systems?: RoomSystemFactory[]
  cults?: CultRegistry
}

interface JoinOpts {
  pid?: string
  name?: unknown
  look?: unknown
  save?: SignedSave | null
  v?: number
}

/** 판정 난수를 순서대로 지정한다(room.rnd 를 바꿔 끼움). 다 쓰면 0.5 */
function scriptRnd(room: Room): { push: (...v: number[]) => void } {
  const queue: number[] = []
  ;(room as unknown as { rnd: Rnd }).rnd = () => (queue.length > 0 ? (queue.shift() as number) : 0.5)
  return { push: (...v) => void queue.push(...v) }
}

// resolvePitch 의 난수 소비 순서: [합류?] → (1라운드만)[더 듣기?] → [도망?] → [무시?]
const R_JOIN = [0]
const R_MORE = [0.99, 0]
const R_FLEE = [0.99, 0.99, 0]
const R_IGNORE = [0.99, 0.99, 0.99, 0]
const R_NO = [0.99, 0.99, 0.99, 0.99]

function setup(o: SetupOpts = {}) {
  const host = new FakeHost()
  if (o.cults) host.cults = o.cults
  const sim = new FakeSim()
  const room = new Room(
    host,
    { id: '1', name: '시험 방', capacity: o.capacity ?? 20, npcCount: o.npcs ?? 9, seed: 7, world: TEST_WORLD, systems: o.systems ?? [] },
    { createNpcSim: sim.factory },
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
    const n = sim.list[id - 1]
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

/** 훅 호출을 전부 기록하는 시험용 시스템 */
function recordingSystem(over: Partial<RoomSystem> = {}) {
  const log: string[] = []
  const got: { room: RoomApi | null; messages: ClientMsg[] } = { room: null, messages: [] }
  const factory: RoomSystemFactory = () => ({
    name: 'rec',
    handles: ['prophecy', 'invite', 'sermon'],
    init(room) {
      got.room = room
      log.push('init')
    },
    onMessage(p, msg) {
      got.messages.push(msg)
      log.push(`msg:${p.id}:${msg.t}`)
    },
    onTick(_now, dt) {
      log.push(`tick:${dt.toFixed(1)}`)
    },
    onJoin(p) {
      log.push(`join:${p.id}`)
    },
    onLeave(p) {
      log.push(`leave:${p.id}`)
    },
    onPitch(p, npc, line, outcome) {
      log.push(`pitch:${p.id}:${npc.id}:${line.id}:${outcome}`)
    },
    onStat(p, stat, value) {
      log.push(`stat:${p.id}:${stat}:${value}`)
    },
    onWelcome(p, w) {
      log.push(`welcome:${p.id}`)
      w.sermon = { leader: 77, startedAt: 1, endsAt: 2, joined: [77] }
    },
    ...over,
  })
  return { log, got, factory }
}

// ═════════════════════════ 접속 ═════════════════════════

describe('hello → welcome', () => {
  it('welcome 에 방·NPC·진행도·서명 저장본이 담긴다', () => {
    const t = setup()
    const a = t.join({ name: '수상한김밥' })
    const w = a.w
    expect(w.id).toBe(1)
    expect(w.room).toEqual({ id: '1', name: '시험 방', players: 1, cap: 20, npcs: 9 })
    expect(w.now).toBe(t.host.t)
    expect(w.players).toEqual([])
    expect(w.npcs).toHaveLength(9)
    expect(w.npcs[0]).toMatchObject({ id: 1, arch: 'test', name: '시민1', owner: 0, role: '' })
    expect(w.name).toBe('수상한김밥')
    expect(w.look).toEqual(LOOK0)
    // 시작 위치는 스폰 지점 근처(흩뿌림 ±1.2m)
    expect(Math.abs(w.x)).toBeLessThanOrEqual(1.21)
    expect(Math.abs(w.z)).toBeLessThanOrEqual(1.21)
    expect(w.me).toMatchObject({ v: 1, pid: 'device-1-abcdefgh', inf: 0, fol: 0, rank: 0 })
    expect(w.sermon).toBeNull()
    expect(w.battles).toEqual([])
    // 저장본은 진행도 그대로이고 서명이 맞아야 한다
    expect(t.host.signer.verify(w.save.d, w.save.s)).toBe(true)
    expect(JSON.parse(w.save.d)).toEqual(w.me)
    expect(t.host.claims).toEqual([['device-1-abcdefgh', '1']])
    expect(t.room.info().players).toBe(1)
    expect(t.host.errors()).toEqual([])
  })

  it('두 번째 사람의 welcome 에는 먼저 온 사람이 있고, 먼저 온 사람은 join 을 받는다', () => {
    const t = setup()
    const a = t.join({ name: '먼저온이' })
    const b = t.join({ name: '나중온이' })
    expect(b.id).toBe(2)
    expect(b.w.players).toHaveLength(1)
    expect(b.w.players[0]).toMatchObject({ id: a.id, name: '먼저온이', rank: 0, fol: 0, cult: null, emote: null })
    expect(b.w.room.players).toBe(2)
    const joins = t.host.of(a.conn, 'join')
    expect(joins).toHaveLength(1)
    expect(joins[0]?.p).toMatchObject({ id: b.id, name: '나중온이', x: b.w.x, z: b.w.z })
    // 본인에게는 join 이 가지 않는다
    expect(t.host.of(b.conn, 'join')).toHaveLength(0)
  })

  it('버전이 다르면 kick(ver) 후 닫는다', () => {
    const t = setup()
    t.hello(1, { v: PROTOCOL_VERSION + 1 })
    expect(t.host.json(1)).toEqual([{ t: 'kick', why: 'ver' }])
    expect(t.host.closes.get(1)?.code).toBe(CLOSE_KICK)
    expect(t.room.players.size).toBe(0)
    expect(t.room.pending).toBe(0)
  })

  it('pid 형식이 틀리면 kick(bad)', () => {
    for (const pid of ['short', 'has space in it', 'a'.repeat(65), 12345678, null, '한글pid는안돼요']) {
      const t = setup()
      t.room.connect(1)
      t.send(1, { t: 'hello', v: PROTOCOL_VERSION, pid, name: '아무개', look: LOOK0 })
      expect(t.host.json(1)).toEqual([{ t: 'kick', why: 'bad' }])
      expect(t.host.closes.get(1)?.code).toBe(CLOSE_BAD)
    }
  })

  it('방이 가득 차면 full(방 목록) 후 CLOSE_FULL 로 닫는다', () => {
    const t = setup({ capacity: 2 })
    t.join()
    t.join()
    t.hello(3)
    expect(t.host.json(3)).toEqual([{ t: 'full', rooms: t.host.roomList }])
    expect(t.host.closes.get(3)).toEqual({ code: CLOSE_FULL, reason: 'full' })
    expect(t.room.players.size).toBe(2)
    expect(t.room.pending).toBe(0)
  })

  it('가득 찬 방이라도 같은 pid 의 재접속은 자리를 교체해 받는다', () => {
    const t = setup({ capacity: 2 })
    const a = t.join({ pid: 'same-device-0001' })
    t.join()
    const a2 = t.join({ pid: 'same-device-0001' })
    expect(a2.w.room.players).toBe(2)
    expect(t.host.of(a.conn, 'kick')).toEqual([{ t: 'kick', why: 'dup' }])
  })

  it('같은 방에 같은 pid 가 들어오면 옛 연결을 dup 으로 내보내고 진행도를 이어받는다', () => {
    const t = setup()
    const a = t.join({ pid: 'same-device-0001', name: '원래사람' })
    const b = t.join({ name: '구경꾼' })
    // 옛 세션이 메모리에만 들고 있던 진행(아직 저장본으로 못 내려간 것)
    t.room.grant(t.player(a.id), { why: 'test', inf: 50, fol: 3 })
    t.host.clear()

    const a2 = t.join({ pid: 'same-device-0001', name: '원래사람' })
    expect(t.host.of(a.conn, 'kick')).toEqual([{ t: 'kick', why: 'dup' }])
    expect(t.host.closes.get(a.conn)).toEqual({ code: CLOSE_KICK, reason: 'dup' })
    // 쫓겨나기 전에 마지막 저장본을 받는다
    expect(t.host.of(a.conn, 'save')[0]?.me.inf).toBe(50)
    expect(a2.id).not.toBe(a.id)
    expect(a2.w.me).toMatchObject({ inf: 50, fol: 3, rank: 1 })
    expect(t.room.players.size).toBe(2)
    expect(t.room.playerByPid('same-device-0001')?.id).toBe(a2.id)
    // 구경꾼은 leave(옛 id) → join(새 id) 순서로 본다
    const seen = t.host.json(b.conn).filter((m) => m.t === 'leave' || m.t === 'join')
    expect(seen.map((m) => m.t)).toEqual(['leave', 'join'])
    expect(seen[0]).toEqual({ t: 'leave', id: a.id })
    // 옛 연결이 뒤늦게 끊겨도 새 세션에는 영향이 없다
    t.room.disconnect(a.conn)
    expect(t.room.players.has(a2.id)).toBe(true)
  })

  it('닉네임을 다듬고, 못 쓰는 이름은 임의 닉네임으로, 겹치면 숫자를 붙인다', () => {
    const t = setup()
    expect(t.join({ name: '  철수​  ' }).w.name).toBe('철수')
    expect(t.join({ name: '철수' }).w.name).toBe('철수2')
    expect(t.join({ name: '철수' }).w.name).toBe('철수3')
    // 꺾쇠 등은 지워진다(마크업 주입 방지)
    const tagged = t.join({ name: '<b>영희</b>' }).w.name
    expect(tagged).toContain('영희')
    expect(tagged).not.toMatch(/[<>&"']/)
    // 욕설·빈 값·숫자 → 서버가 붙인 임의 닉네임(검사를 통과하는 이름이어야 한다)
    for (const bad of ['시발놈', '', 'x', 42, null]) {
      const name = t.join({ name: bad }).w.name
      expect(checkNickname(name)).toEqual({ ok: true, text: name })
      expect(name).not.toContain('시발')
    }
    // 길이 제한 안에서 숫자를 붙인다
    const long = '가나다라마바사아자차'
    expect(Array.from(long)).toHaveLength(NAME_MAX)
    expect(t.join({ name: long }).w.name).toBe(long)
    const dup = t.join({ name: long }).w.name
    expect(dup).toBe('가나다라마바사아자2')
    expect(Array.from(dup).length).toBeLessThanOrEqual(NAME_MAX)
    // 방 안의 이름은 전부 서로 다르다
    const names = [...t.room.players.values()].map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('잠긴 외형은 기본값으로 되돌린다', () => {
    const t = setup()
    // 복장 9(직급 5 전용)·모자 10(직급 5 전용)은 직급 0 에서 못 쓴다
    const a = t.join({ look: [1, 9, 2, 10, 1, 1, 4] })
    expect(a.w.look).toEqual([1, 0, 2, 0, 1, 1, 0])
    expect(t.join({ look: 'nonsense' }).w.look).toEqual(LOOK0)
  })

  it('플레이어 id 는 1부터 올라가고, 65535 다음에는 쓰이지 않는 번호로 돌아온다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    expect([a.id, b.id]).toEqual([1, 2])
    t.room.disconnect(b.conn)
    expect(t.join().id).toBe(3) // 방금 비운 번호를 바로 재사용하지 않는다
    ;(t.room as unknown as { nextId: number }).nextId = 65535
    expect(t.join().id).toBe(65535)
    expect(t.join().id).toBe(2) // 1 은 사용 중이라 건너뛴다
    expect(t.join().id).toBe(4) // 3 도 사용 중
  })

  it('hello 가 제때 오지 않으면 CLOSE_BAD 로 닫는다', () => {
    const t = setup()
    t.room.connect(1)
    expect(t.room.pending).toBe(1)
    t.advance(HELLO_TIMEOUT_MS - 200)
    expect(t.host.closes.has(1)).toBe(false)
    t.advance(400)
    expect(t.host.closes.get(1)?.code).toBe(CLOSE_BAD)
    expect(t.room.pending).toBe(0)
    // 닫힌 뒤에 온 hello 는 무시된다
    t.send(1, { t: 'hello', v: PROTOCOL_VERSION, pid: 'device-1-abcdefgh', name: '늦은이', look: LOOK0 })
    expect(t.room.players.size).toBe(0)
  })

  it('입장 전에는 hello 외의 메시지를 무시하고, 입장 후의 hello 도 무시한다', () => {
    const t = setup()
    t.room.connect(1)
    t.send(1, { t: 'ping', c: 1 })
    t.send(1, { t: 'emote', e: 'wave' })
    t.room.message(1, encodeMove(1, 1, 0, 1))
    expect(t.host.json(1)).toEqual([])
    const a = t.join()
    t.send(a.conn, { t: 'hello', v: PROTOCOL_VERSION, pid: 'another-device-01', name: '또왔어요', look: LOOK0 })
    expect(t.host.of(a.conn, 'welcome')).toHaveLength(1)
    expect(t.room.players.size).toBe(1)
  })

  it('큰 저장본이 실린 hello 는 받고, 입장 후의 큰 프레임은 버린다', () => {
    const t = setup()
    const big = 'x'.repeat(MAX_MSG_BYTES * 2)
    // 서명이 틀린 큰 저장본: 접속은 되고 진행도만 새로 시작한다
    const a = t.join({ save: { d: big, s: 'A'.repeat(43) } })
    expect(a.w.me.inf).toBe(0)
    t.host.clear()
    t.send(a.conn, { t: 'ping', c: 1, pad: big })
    expect(t.host.of(a.conn, 'pong')).toHaveLength(0)
    t.send(a.conn, { t: 'ping', c: 2 })
    expect(t.host.of(a.conn, 'pong')).toHaveLength(1)
    // 한글은 글자 수보다 바이트가 많다: 2000자(6000바이트)도 버려진다
    t.send(a.conn, { t: 'ping', c: 3, pad: '가'.repeat(2000) })
    expect(t.host.of(a.conn, 'pong')).toHaveLength(1)
    // hello 도 상한을 넘으면 버려진다
    t.room.connect(50)
    t.send(50, { t: 'hello', v: PROTOCOL_VERSION, pid: 'device-50-abcdefgh', name: '거대함', look: LOOK0, pad: 'x'.repeat(MAX_HELLO_BYTES) })
    expect(t.host.json(50)).toEqual([])
  })
})

// ═════════════════════════ 저장본 ═════════════════════════

describe('서명 저장본', () => {
  it('다시 들어오면 진행도가 복원된다', () => {
    const t = setup()
    const a = t.join({ pid: 'saver-device-001' })
    const p = t.player(a.id)
    t.room.grant(p, { why: 'test', inf: 150, fol: 4, coins: 9, items: ['sock', 'sock'] })
    t.room.bump(p, STAT.joins, 4)
    t.room.unlockAchievement(p, ACHIEVEMENTS[0]!.id)
    t.advance(1100)
    const saves = t.host.of(a.conn, 'save')
    const last = saves[saves.length - 1]
    expect(last).toBeDefined()
    expect(t.host.signer.verify(last!.save.d, last!.save.s)).toBe(true)
    expect(JSON.parse(last!.save.d)).toEqual(last!.me)
    t.room.disconnect(a.conn)

    const again = t.join({ pid: 'saver-device-001', save: last!.save })
    expect(again.w.me).toMatchObject({
      inf: 150 + ACHIEVEMENTS[0]!.inf,
      fol: 4,
      coins: 9,
      items: { sock: 2 },
      ach: [ACHIEVEMENTS[0]!.id],
    })
    const rank = rankForInfluence(150 + ACHIEVEMENTS[0]!.inf)
    expect(rank).toBeGreaterThanOrEqual(2)
    expect(again.w.me.rank).toBe(rank)
    expect(again.w.me.stats[STAT.joins]).toBe(4)
    expect(t.player(again.id).prog.rank).toBe(rank)
  })

  it('조작된 저장본·남의 저장본은 버리고 새로 시작한다', () => {
    const t = setup()
    const a = t.join({ pid: 'saver-device-001' })
    t.room.grant(t.player(a.id), { why: 'test', inf: 500 })
    t.advance(1100)
    const save = t.host.of(a.conn, 'save').pop()!.save
    t.room.disconnect(a.conn)

    // 내용만 고친 경우
    const forged = { d: save.d.replace('"inf":500', '"inf":999999'), s: save.s }
    expect(forged.d).not.toBe(save.d)
    expect(t.join({ pid: 'saver-device-001', save: forged }).w.me).toMatchObject({ inf: 0, rank: 0 })
    t.room.disconnect(2)
    // 서명만 고친 경우
    const badSig = { d: save.d, s: save.s.slice(0, -1) + (save.s.endsWith('A') ? 'B' : 'A') }
    expect(t.join({ pid: 'saver-device-001', save: badSig }).w.me.inf).toBe(0)
    t.room.disconnect(3)
    // 서명은 맞지만 다른 기기(pid)의 저장본
    expect(t.join({ pid: 'other-device-0002', save }).w.me.inf).toBe(0)
    // 형식이 엉망인 값들
    for (const junk of [{ d: 1, s: 2 }, { d: save.d }, 'string', 7, []]) {
      expect(t.join({ save: junk as unknown as SignedSave }).w.me.inf).toBe(0)
    }
    // 원본은 여전히 유효하다
    expect(t.join({ pid: 'saver-device-001', save }).w.me).toMatchObject({ inf: 500, rank: 3 })
    expect(t.host.errors()).toEqual([])
  })

  it('저장본은 바뀐 사람에게만, 1초에 한 번을 넘지 않게 보낸다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    t.advance(3000)
    expect(t.host.of(a.conn, 'save')).toHaveLength(0)
    const p = t.player(a.id)
    for (let i = 0; i < 30; i++) {
      t.room.bump(p, 'talks')
      t.advance(100)
    }
    const n = t.host.of(a.conn, 'save').length
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(4)
    expect(t.host.of(b.conn, 'save')).toHaveLength(0)
    // 마지막 저장본에는 최신 값이 들어 있다
    t.advance(1100)
    expect(t.host.of(a.conn, 'save').pop()?.me.stats.talks).toBe(30)
  })
})

// ═════════════════════════ 이동 / 스냅샷 ═════════════════════════

describe('MOVE 검증과 스냅샷', () => {
  it('정상 이동은 다음 스냅샷으로 다른 사람에게 전달된다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.advance(100)
    t.host.clear()
    const pa = t.player(a.id)
    const x = pa.x + 0.3
    const z = pa.z - 0.2
    t.move(a.conn, x, z, Math.PI / 2, Anim.Walk)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)
    t.advance(100)
    const snaps = t.host.snaps(b.conn)
    expect(snaps).toHaveLength(1)
    expect(snaps[0]?.time).toBe(t.host.t)
    expect(snaps[0]?.players).toHaveLength(1)
    const ent = snaps[0]!.players[0]!
    expect(ent.id).toBe(a.id)
    expect(ent.x).toBeCloseTo(x, 2)
    expect(ent.z).toBeCloseTo(z, 2)
    expect(ent.yaw).toBeCloseTo(Math.PI / 2, 1)
    expect(ent.st).toBe(Anim.Walk)
    // 같은 스냅샷이 본인에게도 간다(본인은 클라이언트에서 무시)
    expect(t.host.snaps(a.conn)).toEqual(snaps)
    expect(pa.lastMoveAt).toBe(t.host.t - 100)
  })

  it('순간이동은 거절하고 pos 로 원래 위치를 돌려준다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.advance(100)
    t.host.clear()
    const pa = t.player(a.id)
    const before = { x: pa.x, z: pa.z }
    t.move(a.conn, pa.x + 18, pa.z)
    expect(t.host.of(a.conn, 'pos')).toEqual([{ t: 'pos', x: before.x, z: before.z }])
    expect({ x: pa.x, z: pa.z }).toEqual(before)
    t.advance(100)
    expect(t.host.snaps(b.conn)).toHaveLength(0)
    // 한참 서 있었다고 해서 멀리 뛸 수 있게 되지는 않는다(허용량에 상한이 있다)
    t.advance(30_000)
    t.host.clear()
    t.move(a.conn, pa.x + 18, pa.z)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(1)
    expect(pa.x).toBe(before.x)
  })

  it('망에서 뭉쳐 온 패킷은 받아 주되, 계속되는 과속은 걸러 낸다', () => {
    const t = setup()
    const a = t.join()
    const pa = t.player(a.id)
    pa.x = -15
    pa.z = 0
    t.advance(1000)
    t.host.clear()
    // 0.3초치 달리기 패킷 3개가 한꺼번에 도착
    const step = RUN_SPEED * 0.1
    for (let i = 1; i <= 3; i++) t.move(a.conn, -15 + step * i, 0, 0, Anim.Run)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)
    expect(pa.x).toBeCloseTo(-15 + step * 3, 2)

    // 달리기 속도로 10초: 한 번도 걸리지 않는다
    const run = (speed: number, ms: number): number => {
      let dir = 1
      let x = pa.x
      for (let el = 0; el < ms; el += 100) {
        t.host.t += 100
        x += dir * speed * 0.1
        if (x > 15 || x < -15) {
          dir = -dir
          x += 2 * dir * speed * 0.1
        }
        t.move(a.conn, x, 0, 0, Anim.Run)
        x = pa.x // 거절되면 서버 위치로 끌려온다
        t.room.tick()
      }
      return t.host.of(a.conn, 'pos').length
    }
    expect(run(RUN_SPEED, 10_000)).toBe(0)
    // 달리기의 3배 속도: 처음 쌓인 허용량을 다 쓰면 걸린다
    expect(run(RUN_SPEED * 3, 10_000)).toBeGreaterThan(0)
    expect(t.host.errors()).toEqual([])
  })

  it('경계 밖 좌표는 경계 안으로 자르고 pos 로 알려 준다', () => {
    const t = setup()
    const a = t.join()
    const pa = t.player(a.id)
    pa.x = 19.3
    pa.z = 0
    t.host.clear()
    t.move(a.conn, 20.6, 0)
    expect(pa.x).toBeLessThanOrEqual(TEST_WORLD.bounds.x1)
    expect(pa.x).toBeGreaterThan(19.3)
    expect(t.host.of(a.conn, 'pos')).toEqual([{ t: 'pos', x: pa.x, z: pa.z }])
    // 경계 안쪽(클라이언트가 설 수 있는 가장 바깥)은 건드리지 않는다
    t.host.clear()
    t.host.t += 500
    t.move(a.conn, 19.55, 0)
    expect(pa.x).toBe(19.55)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)
  })

  it('벽 속·닫힌 교단 건물 안 좌표는 밀어내고, 직급이 되면 통과시킨다', () => {
    const t = setup()
    const a = t.join()
    const pa = t.player(a.id)
    // 벽(10..12, -12..-10) 한가운데로
    pa.x = 9.4
    pa.z = -11
    t.host.clear()
    t.move(a.conn, 10.5, -11)
    expect(pa.x).toBeLessThan(10)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(1)
    // 벽에 붙어 선 정상 위치(반지름 0.45)는 그대로
    t.host.clear()
    t.host.t += 500
    t.move(a.conn, 9.55, -11)
    expect(pa.x).toBe(9.55)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)

    // 교단 건물 문(직급 3부터)
    pa.x = 0
    pa.z = 13.4
    t.host.t += 500
    t.move(a.conn, 0, 14.5)
    expect(pa.z).toBeLessThan(14)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(1)
    t.room.grant(pa, { why: 'test', inf: RANKS[3]!.inf })
    expect(pa.prog.rank).toBe(3)
    t.host.clear()
    t.host.t += 500
    t.move(a.conn, 0, 14.5)
    expect(pa.z).toBe(14.5)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)
  })

  it('얼어붙은 동안의 이동은 무시하고, 상태는 Stun 으로 방송된다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    const pa = t.player(a.id)
    t.advance(100)
    const before = { x: pa.x, z: pa.z }
    pa.stunUntil = t.host.t + 3000
    t.host.clear()
    t.move(a.conn, pa.x + 0.4, pa.z)
    expect({ x: pa.x, z: pa.z }).toEqual(before)
    expect(t.host.of(a.conn, 'pos')).toEqual([{ t: 'pos', ...before }])
    // 제자리 패킷에는 보정을 보내지 않는다
    t.host.clear()
    t.move(a.conn, pa.x, pa.z)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)
    t.advance(100)
    expect(pa.st).toBe(Anim.Stun)
    expect(t.host.snaps(b.conn)[0]?.players).toEqual([expect.objectContaining({ id: a.id, st: Anim.Stun })])
    // 풀리면 다시 움직일 수 있다
    t.advance(3000)
    expect(pa.st).toBe(Anim.Idle)
    t.host.clear()
    t.move(a.conn, pa.x + 0.4, pa.z)
    expect(pa.x).toBeCloseTo(before.x + 0.4, 2)
    expect(t.host.of(a.conn, 'pos')).toHaveLength(0)
  })

  it('클라이언트가 주장할 수 없는 상태 바이트는 고친다', () => {
    const t = setup()
    const a = t.join()
    const pa = t.player(a.id)
    t.move(a.conn, pa.x + 0.1, pa.z, 0, Anim.Stun)
    expect(pa.st).toBe(Anim.Idle)
    t.move(a.conn, pa.x + 0.1, pa.z, 0, 200)
    expect(pa.st).toBe(Anim.Idle)
    // 스프린트 창 밖에서 Sprint 를 주장하면 달리기로 낮춘다
    t.move(a.conn, pa.x + 0.1, pa.z, 0, Anim.Sprint)
    expect(pa.st).toBe(Anim.Run)
  })

  it('스냅샷에는 변한 엔티티만 들어가고, 조용할 때는 1초에 한 번 빈 스냅샷이 간다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.advance(100)
    // 첫 스냅샷: 막 들어온 두 사람 + 전체 NPC(처음엔 전부 dirty)
    const first = t.host.snaps(b.conn)
    expect(first).toHaveLength(1)
    expect(first[0]?.players.map((e) => e.id).sort()).toEqual([a.id, b.id])
    expect(first[0]?.npcs).toHaveLength(9)
    t.host.clear()

    // 아무 변화 없음 → 1초 동안 딱 한 번, 비어 있는 스냅샷
    t.advance(1000)
    const quiet = t.host.snaps(b.conn)
    expect(quiet).toHaveLength(1)
    expect(quiet[0]).toMatchObject({ players: [], npcs: [] })
    t.host.clear()

    // NPC 하나와 플레이어 하나만 변함
    const n3 = t.npc(3)
    n3.x = 1.23
    n3.z = -4.56
    n3.yaw = Math.PI
    n3.st = Anim.Walk
    n3.dirty = true
    const pa = t.player(a.id)
    t.move(a.conn, pa.x + 0.2, pa.z)
    t.advance(100)
    const snaps = t.host.snaps(b.conn)
    expect(snaps).toHaveLength(1)
    expect(snaps[0]?.players.map((e) => e.id)).toEqual([a.id])
    expect(snaps[0]?.npcs).toHaveLength(1)
    expect(snaps[0]?.npcs[0]).toMatchObject({ id: 3, x: 1.23, z: -4.56, st: Anim.Walk })
    expect(snaps[0]?.npcs[0]?.yaw).toBeCloseTo(Math.PI, 1)
    expect(n3.dirty).toBe(false)
    expect(pa.dirty).toBe(false)
    // 같은 내용을 다시 보내지 않는다
    t.host.clear()
    t.advance(100)
    expect(t.host.snaps(b.conn)).toHaveLength(0)
    // 같은 좌표를 또 보내면 변한 게 아니다
    t.move(a.conn, pa.x, pa.z, pa.yaw, pa.st)
    t.advance(100)
    expect(t.host.snaps(b.conn)).toHaveLength(0)
  })

  it('잘못된 바이너리는 무시한다', () => {
    const t = setup()
    const a = t.join()
    const pa = t.player(a.id)
    const before = { x: pa.x, z: pa.z }
    t.room.message(a.conn, new Uint8Array(0))
    t.room.message(a.conn, new Uint8Array([1, 2, 3]))
    t.room.message(a.conn, new Uint8Array(7)) // 종류 바이트가 0
    t.room.message(a.conn, new Uint8Array(8).fill(1))
    t.room.message(a.conn, new Uint8Array(MAX_MSG_BYTES + 1))
    t.room.message(a.conn, new ArrayBuffer(3))
    expect({ x: pa.x, z: pa.z }).toEqual(before)
    expect(t.host.errors()).toEqual([])
    // 버퍼 중간을 가리키는 뷰(Node Buffer 풀)도 올바르게 읽는다
    const padded = new Uint8Array(32)
    padded.set(new Uint8Array(encodeMove(before.x + 0.2, before.z, 0, Anim.Walk)), 9)
    t.room.message(a.conn, padded.subarray(9, 16))
    expect(pa.x).toBeCloseTo(before.x + 0.2, 2)
  })
})

// ═════════════════════════ 이모트 / 말풍선 / 프로필 ═════════════════════════

describe('이모트', () => {
  it('다른 사람에게만 방송하고 쿨타임을 지킨다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    t.send(a.conn, { t: 'emote', e: 'wave' })
    expect(t.host.of(b.conn, 'emote')).toEqual([{ t: 'emote', id: a.id, e: 'wave' }])
    expect(t.host.of(a.conn, 'emote')).toHaveLength(0)
    // 쿨타임 중에는 무시
    t.host.t += 200
    t.send(a.conn, { t: 'emote', e: 'bow' })
    expect(t.host.of(b.conn, 'emote')).toHaveLength(1)
    t.host.t += EMOTE_COOLDOWN_MS
    t.send(a.conn, { t: 'emote', e: 'bow' })
    expect(t.host.of(b.conn, 'emote')).toHaveLength(2)
    expect(t.stat(a.id, STAT.emotes)).toBe(2)
    // 1회성 이모트는 기억하지 않는다
    expect(t.player(a.id).emote).toBeNull()
  })

  it('직급이 안 되는 이모트·없는 이모트·형식이 틀린 값은 방송하지 않는다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    const locked = EMOTES.find((e) => e.rank > 0)
    expect(locked).toBeDefined()
    for (const e of [locked!.id, 'nope', 123, null, { id: 'wave' }, 'x'.repeat(100)]) {
      t.host.t += 1000
      t.send(a.conn, { t: 'emote', e })
    }
    expect(t.host.of(b.conn, 'emote')).toHaveLength(0)
    expect(t.stat(a.id, STAT.emotes)).toBe(0)
    // 형식이 틀린 4건(숫자, null, 객체, 너무 긴 문자열)만 err(bad) 로 알려 준다. 잠긴/없는 이모트는 조용히 무시
    expect(t.host.of(a.conn, 'err')).toEqual(Array.from({ length: 4 }, () => ({ t: 'err', code: 'bad', msg: 'emote' })))
    // 직급이 오르면 쓸 수 있다
    t.room.grant(t.player(a.id), { why: 'test', inf: RANKS[locked!.rank]!.inf })
    t.host.t += 1000
    t.send(a.conn, { t: 'emote', e: locked!.id })
    expect(t.host.of(b.conn, 'emote')).toEqual([{ t: 'emote', id: a.id, e: locked!.id }])
  })

  it('반복 이모트는 기억되어 나중에 온 사람에게도 보이고, 움직이면 풀린다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.send(a.conn, { t: 'emote', e: 'dance' })
    expect(t.player(a.id).emote).toBe('dance')
    expect(t.stat(a.id, STAT.dances)).toBe(1)
    const late = t.join()
    expect(late.w.players.find((p) => p.id === a.id)?.emote).toBe('dance')
    t.host.clear()

    // 제자리에서 방향만 바꾸는 것은 이동이 아니다
    const pa = t.player(a.id)
    t.move(a.conn, pa.x, pa.z, 1.5, Anim.Idle)
    expect(pa.emote).toBe('dance')
    t.move(a.conn, pa.x + 0.3, pa.z)
    expect(pa.emote).toBeNull()
    expect(t.host.of(b.conn, 'emote')).toEqual([{ t: 'emote', id: a.id, e: '' }])
    expect(t.host.of(a.conn, 'emote')).toHaveLength(0)

    // 빈 문자열로 직접 풀 수도 있다(이미 풀려 있으면 조용히)
    t.host.t += 1000
    t.send(a.conn, { t: 'emote', e: 'pray' })
    t.host.clear()
    t.send(a.conn, { t: 'emote', e: '' })
    t.send(a.conn, { t: 'emote', e: '' })
    expect(t.host.of(b.conn, 'emote')).toEqual([{ t: 'emote', id: a.id, e: '' }])
    expect(pa.emote).toBeNull()
  })

  it('flee 는 스프린트 창을 열어 준다: 창 안에서는 빠른 이동 통과, 끝나면 거절', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    const pa = t.player(a.id)
    pa.x = -15
    pa.z = 0
    t.advance(500)
    t.host.clear()

    // 달리기 허용치(RUN×1.5)보다 빠르고 스프린트 허용치(SPRINT×1.5)보다 느린 속도
    const speed = SPRINT_SPEED * 1.4
    expect(speed).toBeGreaterThan(RUN_SPEED * 1.5)
    expect(speed).toBeLessThan(SPRINT_SPEED * 1.5)
    let dir = 1
    const dash = (ms: number): number => {
      const before = t.host.of(a.conn, 'pos').length
      let x = pa.x
      for (let el = 0; el < ms; el += 100) {
        t.host.t += 100
        x += dir * speed * 0.1
        if (x > 15 || x < -15) {
          dir = -dir
          x += 2 * dir * speed * 0.1
        }
        t.move(a.conn, x, 0, 0, Anim.Sprint)
        x = pa.x
        t.room.tick()
      }
      return t.host.of(a.conn, 'pos').length - before
    }

    t.send(a.conn, { t: 'emote', e: 'flee' })
    expect(t.host.of(b.conn, 'emote')).toEqual([{ t: 'emote', id: a.id, e: 'flee' }])
    expect(pa.sprintUntil).toBe(t.host.t + SPRINT_MS + 400)
    expect(t.stat(a.id, STAT.sprints)).toBe(1)
    expect(dash(SPRINT_MS)).toBe(0)
    expect(pa.st).toBe(Anim.Sprint)

    // 쿨타임 중의 flee 는 창을 다시 열어 주지 않는다
    const until = pa.sprintUntil
    t.send(a.conn, { t: 'emote', e: 'flee' })
    expect(pa.sprintUntil).toBe(until)
    expect(t.stat(a.id, STAT.sprints)).toBe(1)

    // 창이 끝난 뒤 같은 속도로 계속 달리면 거절된다(쌓여 있던 허용량을 다 쓴 뒤)
    expect(dash(6000)).toBeGreaterThan(0)
    expect(pa.st).not.toBe(Anim.Sprint)

    // 쿨타임이 지나면 다시 가능하고, 손 흔든 직후라도 도망은 갈 수 있다
    expect(t.host.t - (until - SPRINT_MS - 400)).toBeGreaterThan(SPRINT_COOLDOWN_MS)
    t.advance(1000)
    t.send(a.conn, { t: 'emote', e: 'wave' })
    t.send(a.conn, { t: 'emote', e: 'flee' })
    expect(t.stat(a.id, STAT.sprints)).toBe(2)
    expect(pa.sprintUntil).toBe(t.host.t + SPRINT_MS + 400)
  })
})

describe('말풍선 / 프로필 / ping / 방 목록', () => {
  it('say 는 방 전체(본인 포함)에 방송되고 쿨타임이 있다', () => {
    // 직급 0 에서 쓸 수 있는 말풍선 두 개(콘텐츠가 바뀌어도 테스트가 따라가게 목록에서 고른다)
    const free = QUICK_CHATS.filter((q) => q.rank === 0)
    expect(free.length).toBeGreaterThanOrEqual(2)
    const [q1, q2] = [free[0]!.id, free[1]!.id]
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    t.send(a.conn, { t: 'say', q: q1 })
    expect(t.host.of(b.conn, 'say')).toEqual([{ t: 'say', id: a.id, q: q1 }])
    expect(t.host.of(a.conn, 'say')).toHaveLength(1)
    t.send(a.conn, { t: 'say', q: q2 })
    expect(t.host.of(b.conn, 'say')).toHaveLength(1)
    t.host.t += SAY_COOLDOWN_MS
    for (const q of [-1, QUICK_CHATS.length, 0.5, '0', null]) t.send(a.conn, { t: 'say', q })
    expect(t.host.of(b.conn, 'say')).toHaveLength(1)
    t.send(a.conn, { t: 'say', q: q2 })
    expect(t.host.of(b.conn, 'say')).toEqual([
      { t: 'say', id: a.id, q: q1 },
      { t: 'say', id: a.id, q: q2 },
    ])
    expect(t.stat(a.id, STAT.says)).toBe(2)
    // 직급이 안 되는 말풍선은 방송하지 않는다
    const locked = QUICK_CHATS.find((q) => q.rank > 0)
    if (locked) {
      t.host.t += SAY_COOLDOWN_MS
      t.send(a.conn, { t: 'say', q: locked.id })
      expect(t.host.of(b.conn, 'say')).toHaveLength(2)
    }
  })

  it('profile 은 이름·외형을 검사해 다음 틱에 pu 로 방송한다', () => {
    const t = setup()
    const a = t.join({ name: '원래이름' })
    const b = t.join({ name: '붙박이' })
    t.host.clear()
    // 연달아 바꿔도 마지막 상태 하나만 나간다
    t.send(a.conn, { t: 'profile', name: '중간이름' })
    t.send(a.conn, { t: 'profile', name: '새이름', look: [2, 1, 3, 1, 0, 0, 0] })
    expect(t.host.of(b.conn, 'pu')).toHaveLength(0)
    t.advance(100)
    const pu = t.host.of(b.conn, 'pu')
    expect(pu).toEqual([{ t: 'pu', id: a.id, name: '새이름', look: [2, 1, 3, 1, 0, 0, 0] }])
    expect(t.host.of(a.conn, 'pu')).toEqual(pu)

    // 겹치는 이름은 숫자가 붙고, 못 쓰는 이름은 err + 본인에게 현재 값 확인
    t.host.clear()
    t.send(a.conn, { t: 'profile', name: '붙박이' })
    t.advance(100)
    expect(t.host.of(b.conn, 'pu')).toEqual([{ t: 'pu', id: a.id, name: '붙박이2' }])
    t.host.clear()
    t.send(a.conn, { t: 'profile', name: '시발' })
    expect(t.host.of(a.conn, 'err')[0]?.code).toBe('name')
    t.advance(100)
    expect(t.host.of(b.conn, 'pu')).toHaveLength(0)
    expect(t.host.of(a.conn, 'pu')).toEqual([{ t: 'pu', id: a.id, name: '붙박이2', look: [2, 1, 3, 1, 0, 0, 0] }])
    // 잠긴 외형은 기본값으로
    t.host.clear()
    t.send(a.conn, { t: 'profile', look: [0, 9, 0, 10, 0, 0, 4] })
    t.advance(100)
    expect(t.host.of(b.conn, 'pu')).toEqual([{ t: 'pu', id: a.id, look: LOOK0 }])
    // 자기 이름 그대로 보내는 것은 겹침이 아니다
    t.host.clear()
    t.send(a.conn, { t: 'profile', name: '붙박이2' })
    t.advance(100)
    expect(t.player(a.id).name).toBe('붙박이2')
    expect(t.host.of(b.conn, 'pu')).toHaveLength(0)
  })

  it('ping → pong, rooms → 방 목록', () => {
    const t = setup()
    const a = t.join()
    t.host.clear()
    t.host.t += 1234
    t.send(a.conn, { t: 'ping', c: 987654 })
    expect(t.host.of(a.conn, 'pong')).toEqual([{ t: 'pong', c: 987654, s: t.host.t }])
    t.send(a.conn, { t: 'ping', c: 'x' })
    t.send(a.conn, { t: 'ping' })
    expect(t.host.of(a.conn, 'pong')).toHaveLength(1)
    t.send(a.conn, { t: 'rooms' })
    expect(t.host.of(a.conn, 'rooms')).toEqual([{ t: 'rooms', rooms: t.host.roomList }])
  })
})

// ═════════════════════════ 대화 / 포교 ═════════════════════════

describe('대화와 포교', () => {
  it('talk → talkOk: 멘트 제시, NPC 가 듣기 시작, 통계·도감 기록', () => {
    const t = setup()
    const a = t.join()
    t.host.clear()
    t.talk(a, 2)
    const ok = t.host.of(a.conn, 'talkOk')
    expect(ok).toHaveLength(1)
    expect(ok[0]).toMatchObject({ n: 2, greet: '네? 저요?', round: 1 })
    const available = PITCH_LINES.filter((l) => l.rank === 0).length
    expect(ok[0]?.lines).toHaveLength(Math.min(LINES_PER_TALK, available))
    expect(new Set(ok[0]?.lines).size).toBe(ok[0]?.lines.length)
    for (const l of ok[0]!.lines) expect(PITCH_LINES[l]?.rank).toBe(0)
    expect(t.npc(2).talker).toBe(a.id)
    expect(t.sim.called('beginListen:2:')).toHaveLength(1)
    expect(t.player(a.id).talk).toMatchObject({ npc: 2, round: 1, used: [], until: t.host.t + TALK_TIMEOUT_MS })
    expect(t.stat(a.id, STAT.talks)).toBe(1)
    expect(t.player(a.id).prog.met).toEqual(['test'])
  })

  it('말을 걸 수 없는 경우마다 talkNo 사유가 맞게 온다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    const no = (conn: number) => t.host.of(conn, 'talkNo').pop()
    // 너무 멂
    const pa = t.player(a.id)
    pa.x = t.npc(1).x + TALK_RANGE + 1.5
    pa.z = t.npc(1).z
    t.send(a.conn, { t: 'talk', n: 1 })
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 1, why: 'far' })
    // 없는 NPC / 단속반
    t.send(a.conn, { t: 'talk', n: 200 })
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 200, why: 'gone' })
    t.npc(9).role = 'patrol'
    t.talk(a, 9)
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 9, why: 'gone' })
    // 퇴장 중인 NPC
    t.npc(8).mode = 'leave'
    t.talk(a, 8)
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 8, why: 'gone' })
    // 다른 사람과 대화 중
    t.talk(b, 1)
    expect(t.host.of(b.conn, 'talkOk')).toHaveLength(1)
    t.talk(a, 1)
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 1, why: 'busy' })
    // 이미 내 신도
    t.npc(3).owner = a.id
    t.talk(a, 3)
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 3, why: 'mine' })
    // 얼어붙은 동안
    pa.stunUntil = t.host.t + 2000
    t.talk(a, 4)
    expect(no(a.conn)).toEqual({ t: 'talkNo', n: 4, why: 'cool', ms: 2000 })
    // 형식이 틀린 요청은 조용히 버린다
    const count = t.host.of(a.conn, 'talkNo').length
    for (const n of ['1', 1.5, null, undefined]) t.send(a.conn, { t: 'talk', n })
    expect(t.host.of(a.conn, 'talkNo')).toHaveLength(count)
    expect(t.stat(a.id, STAT.talks)).toBe(0)
  })

  it('join: 신도 +1, 따라다니기 시작, 방 전체에 결과 방송', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.talk(a, 1)
    t.host.clear()
    const line = t.pitch(a, 1, R_JOIN)

    const res = { t: 'pitchRes', p: a.id, n: 1, l: line, o: 'join', say: '합류할게요' }
    expect(t.host.of(a.conn, 'pitchRes')).toEqual([res])
    expect(t.host.of(b.conn, 'pitchRes')).toEqual([res])
    expect(t.npc(1)).toMatchObject({ owner: a.id, talker: 0, mode: 'follow' })
    expect(t.sim.called('startFollow:1:')).toHaveLength(1)
    expect(t.host.of(b.conn, 'nu')).toEqual([{ t: 'nu', n: 1, owner: a.id }])
    expect(t.host.of(a.conn, 'reward')).toEqual([{ t: 'reward', why: 'join', inf: INF_JOIN, fol: 1, streak: 1 }])
    expect(t.host.of(b.conn, 'reward')).toHaveLength(0)
    expect(t.host.of(b.conn, 'pu')).toEqual([{ t: 'pu', id: a.id, fol: 1 }])
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 1, why: 'done' }])
    const p = t.player(a.id)
    expect(p.talk).toBeNull()
    expect(p.prog).toMatchObject({ inf: INF_JOIN, fol: 1 })
    expect(p.prog.stats).toMatchObject({ joins: 1, streak: 1, bestStreak: 1, pitches: 1, talks: 1 })
    expect(p.prog.stats.failStreak ?? 0).toBe(0)
    expect(p.saveDirty).toBe(true)
    expect(p.cd.get('pitch')).toBe(t.host.t + PITCH_COOLDOWN_MS)
  })

  it('연속 성공 보너스가 붙고, 포교 직후에는 쿨타임으로 말을 걸 수 없다', () => {
    const t = setup()
    const a = t.join()
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    t.host.clear()
    t.talk(a, 2)
    expect(t.host.of(a.conn, 'talkNo')).toEqual([{ t: 'talkNo', n: 2, why: 'cool', ms: PITCH_COOLDOWN_MS }])
    expect(t.npc(2).talker).toBe(0)
    t.advance(PITCH_COOLDOWN_MS)
    t.talk(a, 2)
    t.host.clear()
    t.pitch(a, 2, R_JOIN)
    expect(t.host.of(a.conn, 'reward')).toEqual([
      { t: 'reward', why: 'join', inf: INF_JOIN + INF_STREAK_BONUS, fol: 1, streak: 2 },
    ])
    expect(t.stat(a.id, STAT.bestStreak)).toBe(2)
  })

  it('동행 신도가 MAX_ENTOURAGE 를 넘으면 가장 오래된 신도를 보내 준다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    for (let n = 1; n <= MAX_ENTOURAGE; n++) {
      t.talk(a, n)
      t.pitch(a, n, R_JOIN)
      t.advance(PITCH_COOLDOWN_MS)
    }
    expect(t.sim.list.filter((n) => n.owner === a.id)).toHaveLength(MAX_ENTOURAGE)
    expect(t.sim.called('release:')).toHaveLength(0)
    t.host.clear()
    t.talk(a, MAX_ENTOURAGE + 1)
    t.pitch(a, MAX_ENTOURAGE + 1, R_JOIN)
    expect(t.sim.called('release:')).toEqual(['release:1:expire'])
    expect(t.npc(1).owner).toBe(0)
    expect(t.npc(MAX_ENTOURAGE + 1).owner).toBe(a.id)
    expect(t.sim.list.filter((n) => n.owner === a.id)).toHaveLength(MAX_ENTOURAGE)
    // 누적 신도 수는 줄지 않는다
    expect(t.player(a.id).prog.fol).toBe(MAX_ENTOURAGE + 1)
    expect(t.host.of(b.conn, 'nu')).toEqual([
      { t: 'nu', n: 1, owner: 0 },
      { t: 'nu', n: MAX_ENTOURAGE + 1, owner: a.id },
    ])
    // 떠나는 말은 다음 틱에 한 묶음으로 나간다
    expect(t.host.of(b.conn, 'npcSay')).toHaveLength(0)
    t.advance(100)
    expect(t.host.of(b.conn, 'npcSay')).toEqual([{ t: 'npcSay', l: [[1, '어? 제가 왜 여기 있죠?']] }])
  })

  it('more: 2라운드로 넘어가 새 멘트를 받고, 다시 고를 수 있다', () => {
    const t = setup()
    const a = t.join()
    t.talk(a, 1)
    t.host.clear()
    t.host.t += 5000
    const used = t.pitch(a, 1, R_MORE)
    expect(t.host.of(a.conn, 'pitchRes')[0]).toMatchObject({ o: 'more', say: '더 들어볼게요' })
    expect(t.host.of(a.conn, 'reward')).toEqual([{ t: 'reward', why: 'more', inf: INF_MORE }])
    const ok = t.host.of(a.conn, 'talkOk')
    expect(ok).toHaveLength(1)
    expect(ok[0]).toMatchObject({ n: 1, round: 2, greet: '더 들어볼게요' })
    expect(ok[0]!.lines.length).toBeGreaterThan(0)
    if (PITCH_LINES.filter((l) => l.rank === 0).length > LINES_PER_TALK) expect(ok[0]!.lines).not.toContain(used)
    const talk = t.player(a.id).talk
    expect(talk).toMatchObject({ npc: 1, round: 2, used: [used], lines: ok[0]!.lines, until: t.host.t + TALK_TIMEOUT_MS })
    expect(t.npc(1).talker).toBe(a.id)
    expect(t.host.of(a.conn, 'talkEnd')).toHaveLength(0)
    // 연속 기록은 그대로
    expect(t.stat(a.id, STAT.streak)).toBe(0)
    expect(t.stat(a.id, STAT.failStreak)).toBe(0)
    expect(t.stat(a.id, STAT.pitches)).toBe(1)

    // 1라운드에 제시됐던 멘트라도 지금 제시된 게 아니면 못 쓴다
    if (!ok[0]!.lines.includes(used)) {
      t.send(a.conn, { t: 'pitch', n: 1, l: used })
      expect(t.host.of(a.conn, 'err')).toEqual([{ t: 'err', code: 'pitch' }])
    }
    // 2라운드에는 '더 듣기' 판정이 없다: [합류 실패, 도망 실패, 무시 실패] → 거절
    t.pitch(a, 1, [0.99, 0.99, 0.99])
    expect(t.host.of(a.conn, 'pitchRes')[1]).toMatchObject({ o: 'no' })
    expect(t.player(a.id).talk).toBeNull()
    expect(t.stat(a.id, STAT.pitches)).toBe(2)
  })

  it('no / ignore / flee: NPC 가 기억하고, 연속 실패가 쌓인다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    // 먼저 한 번 성공해서 연속 성공을 만들어 둔다
    t.talk(a, 9)
    t.pitch(a, 9, R_JOIN)
    expect(t.stat(a.id, STAT.streak)).toBe(1)

    const cases: [number, number[], string, string][] = [
      [1, R_NO, 'no', '싫어요'],
      [2, R_IGNORE, 'ignore', '(못 들은 척)'],
      [3, R_FLEE, 'flee', '으악'],
    ]
    let fails = 0
    for (const [n, rnd, outcome, say] of cases) {
      t.advance(PITCH_COOLDOWN_MS)
      t.talk(a, n)
      t.host.clear()
      const line = t.pitch(a, n, rnd)
      fails++
      expect(t.host.of(b.conn, 'pitchRes')).toEqual([{ t: 'pitchRes', p: a.id, n, l: line, o: outcome, say }])
      expect(t.host.of(a.conn, 'reward')).toEqual([{ t: 'reward', why: 'fail', inf: INF_FAIL }])
      expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n, why: 'done' }])
      expect(t.npc(n)).toMatchObject({ owner: 0, talker: 0 })
      expect(t.npc(n).memo.get(a.id)).toBe(t.host.t + NPC_REJECT_MEMORY_MS)
      expect(t.player(a.id).talk).toBeNull()
      expect(t.stat(a.id, STAT.streak)).toBe(0)
      expect(t.stat(a.id, STAT.failStreak)).toBe(fails)
      expect(t.stat(a.id, STAT.worstStreak)).toBe(fails)
      expect(t.stat(a.id, STAT.rejects)).toBe(fails)
    }
    expect(t.stat(a.id, STAT.ignores)).toBe(1)
    expect(t.stat(a.id, STAT.flees)).toBe(1)
    expect(t.stat(a.id, STAT.bestStreak)).toBe(1)
    expect(t.sim.called('walkOff:1')).toHaveLength(1)
    expect(t.sim.called('flee:')).toEqual(['flee:3'])
    // 도망은 플레이어 위치를 기준으로 반대쪽으로
    expect(t.sim.lastFlee).toEqual({ npc: 3, x: t.player(a.id).x, z: t.player(a.id).z })

    // 거절한 NPC 는 한동안 같은 사람 말을 안 듣는다(다른 사람은 가능)
    t.advance(PITCH_COOLDOWN_MS)
    t.host.clear()
    t.talk(a, 1)
    const no = t.host.of(a.conn, 'talkNo')[0]
    expect(no).toMatchObject({ n: 1, why: 'memo' })
    expect(no?.ms).toBeGreaterThan(NPC_REJECT_MEMORY_MS - 3 * PITCH_COOLDOWN_MS - 1000)
    expect(no?.ms).toBeLessThanOrEqual(NPC_REJECT_MEMORY_MS)
    t.talk(b, 1)
    expect(t.host.of(b.conn, 'talkOk')).toHaveLength(1)

    // 성공하면 연속 실패가 풀린다(최고 기록은 남는다)
    t.advance(PITCH_COOLDOWN_MS)
    t.talk(a, 4)
    t.pitch(a, 4, R_JOIN)
    expect(t.stat(a.id, STAT.failStreak)).toBe(0)
    expect(t.stat(a.id, STAT.worstStreak)).toBe(3)
    expect(t.stat(a.id, STAT.pitches)).toBe(5)
  })

  it('king: 전생 멘트에 감격하며 합류하고 kings 가 오른다', () => {
    const past = PITCH_LINES.find((l) => l.cat === 'past' && l.rank === 0)
    expect(past).toBeDefined()
    const t = setup()
    const a = t.join()
    t.npc(1).arch = makeArch({ special: 'royal' })
    t.talk(a, 1)
    t.player(a.id).talk!.lines = [past!.id]
    t.host.clear()
    t.pitch(a, 1, [0, 0])
    expect(t.host.of(a.conn, 'pitchRes')[0]).toMatchObject({ o: 'king', l: past!.id, say: '혹시 전생에 제가 왕이었나요?' })
    expect(t.npc(1).owner).toBe(a.id)
    expect(t.host.of(a.conn, 'reward')[0]).toMatchObject({ why: 'join', fol: 1 })
    expect(t.stat(a.id, STAT.kings)).toBe(1)
    expect(t.stat(a.id, STAT.joins)).toBe(1)
  })

  it('rival: 가로채는 시스템이 없으면 거절로 처리한다', () => {
    const t = setup()
    const a = t.join()
    t.npc(1).arch = makeArch({ special: 'rival' })
    t.talk(a, 1)
    t.host.clear()
    t.pitch(a, 1, [0])
    expect(t.host.of(a.conn, 'pitchRes')[0]).toMatchObject({ o: 'rival', say: '싫어요' })
    expect(t.npc(1)).toMatchObject({ owner: 0, talker: 0 })
    expect(t.npc(1).memo.has(a.id)).toBe(true)
    expect(t.host.of(a.conn, 'reward')).toEqual([{ t: 'reward', why: 'fail', inf: INF_FAIL }])
    expect(t.stat(a.id, STAT.rejects)).toBe(1)
    expect(t.player(a.id).talk).toBeNull()
  })

  it('남의 신도 빼앗기: 성공하면 주인이 바뀌고, 실패하면 원래 주인에게 돌아간다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.talk(b, 1)
    t.pitch(b, 1, R_JOIN)
    expect(t.npc(1).owner).toBe(b.id)

    // 실패(도망 판정이어도 주인을 떠나지 않는다)
    t.talk(a, 1)
    t.pitch(a, 1, R_FLEE)
    expect(t.npc(1)).toMatchObject({ owner: b.id, talker: 0, mode: 'follow' })
    expect(t.sim.called('flee:')).toHaveLength(0)
    expect(t.sim.called('walkOff:')).toHaveLength(0)
    expect(t.stat(a.id, STAT.poaches)).toBe(0)

    // 성공
    t.npc(1).memo.clear()
    t.advance(PITCH_COOLDOWN_MS)
    t.talk(a, 1)
    t.host.clear()
    t.pitch(a, 1, R_JOIN)
    expect(t.npc(1).owner).toBe(a.id)
    expect(t.host.of(b.conn, 'nu')).toEqual([{ t: 'nu', n: 1, owner: a.id }])
    expect(t.stat(a.id, STAT.poaches)).toBe(1)
    expect(t.stat(a.id, STAT.joins)).toBe(1)
  })

  it('제시하지 않은 멘트·열리지 않은 대화의 pitch 는 거절한다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    // 대화 없이
    t.send(a.conn, { t: 'pitch', n: 1, l: 0 })
    expect(t.host.of(a.conn, 'err')).toEqual([{ t: 'err', code: 'pitch' }])
    t.talk(a, 1)
    t.host.clear()
    const offered = t.player(a.id).talk!.lines
    const notOffered = PITCH_LINES.find((l) => !offered.includes(l.id))
    // 제시되지 않은 멘트 / 없는 멘트 / 다른 NPC
    if (notOffered) t.send(a.conn, { t: 'pitch', n: 1, l: notOffered.id })
    t.send(a.conn, { t: 'pitch', n: 1, l: 99999 })
    t.send(a.conn, { t: 'pitch', n: 2, l: offered[0] })
    const errs = (code: string): number => t.host.of(a.conn, 'err').filter((e) => e.code === code).length
    expect(errs('pitch')).toBe(notOffered ? 3 : 2)
    // 형식이 틀리면 판정까지 가지 않고 err(bad)
    t.send(a.conn, { t: 'pitch', n: 1, l: '0' })
    t.send(a.conn, { t: 'pitch', n: 1 })
    expect(errs('pitch')).toBe(notOffered ? 3 : 2)
    expect(errs('bad')).toBe(2)
    expect(t.host.of(b.conn, 'pitchRes')).toHaveLength(0)
    expect(t.stat(a.id, STAT.pitches)).toBe(0)
    // 세션은 그대로 살아 있어서 정상 멘트는 통한다
    t.pitch(a, 1, R_JOIN)
    expect(t.host.of(b.conn, 'pitchRes')).toHaveLength(1)
  })

  it('대화 시간이 지나면 talkEnd(timeout) 으로 끝난다', () => {
    const t = setup()
    const a = t.join()
    t.talk(a, 1)
    t.host.clear()
    t.advance(TALK_TIMEOUT_MS - 200)
    expect(t.host.of(a.conn, 'talkEnd')).toHaveLength(0)
    expect(t.npc(1).talker).toBe(a.id)
    t.advance(300)
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 1, why: 'timeout' }])
    expect(t.player(a.id).talk).toBeNull()
    expect(t.npc(1).talker).toBe(0)
    expect(t.sim.called('endListen:1')).toHaveLength(1)
    // 시간 초과 뒤의 pitch 는 거절
    t.send(a.conn, { t: 'pitch', n: 1, l: 0 })
    expect(t.host.of(a.conn, 'err')).toEqual([{ t: 'err', code: 'pitch' }])
    // 고르지 않고 흘려보낸 NPC 는 잠깐 그 사람을 피한다(붙잡아 두기·멘트 다시 뽑기 방지)
    t.talk(a, 1)
    const no = t.host.of(a.conn, 'talkNo')[0]
    expect(no).toMatchObject({ n: 1, why: 'memo' })
    expect(no?.ms).toBeGreaterThan(3000)
    expect(no?.ms).toBeLessThanOrEqual(4000)
    // 포교를 한 게 아니므로 쿨타임은 없다: 다른 NPC 에게는 바로 말을 걸 수 있다
    t.talk(a, 2)
    expect(t.host.of(a.conn, 'talkOk')).toMatchObject([{ n: 2 }])
    t.send(a.conn, { t: 'talkEnd' })
    t.advance(4000)
    t.host.clear()
    t.talk(a, 1)
    expect(t.host.of(a.conn, 'talkOk')).toMatchObject([{ n: 1 }])
  })

  it('talkEnd(취소)·다른 NPC 에게 말 걸기·멀어지기·NPC 교체로도 세션이 정리된다', () => {
    const t = setup()
    const a = t.join()
    // 직접 취소
    t.talk(a, 1)
    t.host.clear()
    t.send(a.conn, { t: 'talkEnd' })
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 1, why: 'cancel' }])
    expect(t.npc(1).talker).toBe(0)
    t.send(a.conn, { t: 'talkEnd' }) // 열린 대화가 없으면 조용히
    expect(t.host.of(a.conn, 'talkEnd')).toHaveLength(1)
    // 취소한 NPC 는 잠깐 그 사람을 피한다
    expect(t.npc(1).memo.get(a.id)).toBe(t.host.t + 4000)

    // 같은 NPC 에게 말 걸기를 두 번 보내도(버튼 연타) 열린 대화는 그대로다
    t.talk(a, 5)
    const session = t.player(a.id).talk
    t.host.clear()
    t.send(a.conn, { t: 'talk', n: 5 })
    expect(t.host.json(a.conn)).toEqual([])
    expect(t.player(a.id).talk).toBe(session)
    expect(t.npc(5).talker).toBe(a.id)
    expect(t.stat(a.id, STAT.talks)).toBe(2)

    // 대화 중에 다른 NPC 에게 말을 걸면 앞 세션부터 끝낸다
    t.talk(a, 2)
    expect(t.host.json(a.conn).map((m) => m.t)).toEqual(['talkEnd', 'talkOk'])
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 5, why: 'cancel' }])
    expect(t.npc(5).talker).toBe(0)
    expect(t.npc(2).talker).toBe(a.id)

    // 대화 중에 멀리 걸어가 버리면 NPC 를 놓아준다
    t.host.clear()
    const p = t.player(a.id)
    t.host.t += 2000
    t.move(a.conn, p.x + 7, p.z, 0, Anim.Run)
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 2, why: 'cancel' }])
    expect(t.npc(2).talker).toBe(0)

    // 상대 NPC 가 시뮬 쪽 사정으로 풀리면(교체 등) gone
    t.talk(a, 3)
    t.host.clear()
    t.npc(3).talker = 0
    t.advance(100)
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 3, why: 'gone' }])
    expect(t.player(a.id).talk).toBeNull()
    // pitch 시점에 이미 풀려 있었던 경우
    t.talk(a, 4)
    t.npc(4).talker = 0
    t.host.clear()
    t.send(a.conn, { t: 'pitch', n: 4, l: t.player(a.id).talk!.lines[0] })
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 4, why: 'gone' }])
    expect(t.host.of(a.conn, 'pitchRes')).toHaveLength(0)
  })

  it('버프는 판정에 반영되고 만료되면 사라진다', () => {
    const t = setup()
    const a = t.join()
    const p = t.player(a.id)
    p.buff = 0.2
    p.buffUntil = t.host.t + 1000
    t.advance(900)
    expect(p.buff).toBe(0.2)
    t.advance(200)
    expect(p.buff).toBe(0)
    expect(p.buffUntil).toBe(0)
  })
})

// ═════════════════════════ 퇴장 / 제재 ═════════════════════════

describe('퇴장 정리', () => {
  it('끊기면 leave 를 방송하고 신도를 풀어 주고 대화를 끝낸다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    t.advance(PITCH_COOLDOWN_MS)
    t.talk(a, 2)
    expect(t.npc(1).owner).toBe(a.id)
    expect(t.npc(2).talker).toBe(a.id)
    t.host.clear()

    t.room.disconnect(a.conn)
    expect(t.room.players.has(a.id)).toBe(false)
    expect(t.room.playerByPid('device-1-abcdefgh')).toBeUndefined()
    expect(t.npc(1).owner).toBe(0)
    expect(t.npc(2).talker).toBe(0)
    expect(t.sim.called('onPlayerLeave:')).toEqual([`onPlayerLeave:${a.id}`])
    const seen = t.host.json(b.conn)
    expect(seen).toContainEqual({ t: 'nu', n: 1, owner: 0 })
    expect(seen[seen.length - 1]).toEqual({ t: 'leave', id: a.id })
    expect(t.room.info().players).toBe(1)
    // 두 번 끊겨도 한 번만 처리한다
    t.room.disconnect(a.conn)
    expect(t.host.of(b.conn, 'leave')).toHaveLength(1)
    // 나간 연결에서 뒤늦게 온 메시지는 무시
    t.send(a.conn, { t: 'ping', c: 1 })
    expect(t.host.errors()).toEqual([])
  })

  it('입장 전 연결이 끊기면 조용히 정리된다', () => {
    const t = setup()
    const a = t.join()
    t.room.connect(77)
    expect(t.room.pending).toBe(1)
    t.host.clear()
    t.room.disconnect(77)
    expect(t.room.pending).toBe(0)
    expect(t.host.json(a.conn)).toEqual([])
  })

  it('오랫동안 아무 메시지도 없으면 kick(idle)', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    // b 는 ping 을 계속 보낸다
    for (let el = 0; el < IDLE_TIMEOUT_MS + 2000; el += 4000) {
      t.advance(4000)
      t.send(b.conn, { t: 'ping', c: el })
    }
    expect(t.host.of(a.conn, 'kick')).toEqual([{ t: 'kick', why: 'idle' }])
    expect(t.host.closes.get(a.conn)).toEqual({ code: CLOSE_KICK, reason: 'idle' })
    expect(t.room.players.has(a.id)).toBe(false)
    expect(t.room.players.has(b.id)).toBe(true)
    expect(t.host.of(b.conn, 'leave')).toEqual([{ t: 'leave', id: a.id }])
  })

  it('메시지를 쏟아부으면 kick(rate)', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    // 정상 속도(초당 20개)로는 얼마든지
    for (let i = 0; i < 200; i++) {
      t.host.t += 50
      t.send(a.conn, { t: 'ping', c: i })
    }
    expect(t.host.of(a.conn, 'pong')).toHaveLength(200)
    expect(t.host.closes.has(a.conn)).toBe(false)
    // 한순간에 버스트(2초치)를 넘기면 내보낸다
    t.host.t += 1000
    t.host.clear()
    for (let i = 0; i < RATE_LIMIT_PER_SEC * 2 + 5; i++) t.send(a.conn, { t: 'ping', c: i })
    expect(t.host.of(a.conn, 'pong')).toHaveLength(RATE_LIMIT_PER_SEC * 2)
    expect(t.host.of(a.conn, 'kick')).toEqual([{ t: 'kick', why: 'rate' }])
    expect(t.host.closes.get(a.conn)).toEqual({ code: CLOSE_KICK, reason: 'rate' })
    expect(t.room.players.has(a.id)).toBe(false)
    expect(t.host.of(b.conn, 'leave')).toEqual([{ t: 'leave', id: a.id }])
  })

  it('입장 전에 hello 아닌 것을 계속 보내는 연결은 일찍 끊는다', () => {
    const t = setup()
    t.room.connect(90)
    for (let i = 0; i < 4; i++) t.room.message(90, 'garbage')
    expect(t.host.closes.has(90)).toBe(false)
    // 그 안에 제대로 된 hello 가 오면 받는다
    t.send(90, { t: 'hello', v: PROTOCOL_VERSION, pid: 'late-hello-device', name: '뒤늦은이', look: LOOK0 })
    expect(t.host.closes.has(90)).toBe(true)
    expect(t.host.closes.get(90)?.code).toBe(CLOSE_BAD)
    expect(t.host.json(90)).toEqual([{ t: 'kick', why: 'bad' }])
    expect(t.room.pending).toBe(0)

    t.room.connect(91)
    for (let i = 0; i < 3; i++) t.room.message(91, new Uint8Array([1, 2, 3]))
    t.send(91, { t: 'hello', v: PROTOCOL_VERSION, pid: 'late-hello-device', name: '뒤늦은이', look: LOOK0 })
    expect(t.host.of(91, 'welcome')).toHaveLength(1)
    // 입장한 뒤에는 이 제한이 없다
    for (let i = 0; i < 20; i++) t.send(91, { t: 'ping', c: i })
    expect(t.host.of(91, 'pong')).toHaveLength(20)
  })

  it('kickPid: 다른 방에서 같은 pid 가 들어왔을 때 어댑터가 부른다', () => {
    const t = setup()
    const a = t.join({ pid: 'roaming-device-1' })
    const b = t.join()
    t.room.grant(t.player(a.id), { why: 'test', inf: 7 })
    t.host.clear()
    expect(t.room.kickPid('nobody-here-0000', 'dup')).toBe(false)
    expect(t.room.kickPid('roaming-device-1', 'dup')).toBe(true)
    // 내보내기 전에 못 보낸 진행도를 건넨다
    expect(t.host.json(a.conn).map((m) => m.t)).toEqual(['save', 'kick'])
    expect(t.host.of(a.conn, 'kick')).toEqual([{ t: 'kick', why: 'dup' }])
    expect(t.host.closes.get(a.conn)?.code).toBe(CLOSE_KICK)
    expect(t.host.of(b.conn, 'leave')).toEqual([{ t: 'leave', id: a.id }])
    expect(t.room.kickPid('roaming-device-1', 'dup')).toBe(false)
  })

  it('shutdown: 전원에게 저장본과 kick(shutdown) 을 보내고 더는 받지 않는다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.room.connect(60)
    t.room.grant(t.player(a.id), { why: 'test', inf: 3 })
    t.host.clear()
    t.room.shutdown()
    expect(t.host.json(a.conn).map((m) => m.t)).toEqual(['save', 'kick'])
    expect(t.host.json(b.conn)).toEqual([{ t: 'kick', why: 'shutdown' }])
    for (const conn of [a.conn, b.conn, 60]) expect(t.host.closes.get(conn)?.code).toBe(CLOSE_SHUTDOWN)
    expect(t.room.players.size).toBe(0)
    t.room.connect(61)
    expect(t.host.closes.get(61)?.code).toBe(CLOSE_SHUTDOWN)
    t.room.tick()
    t.room.shutdown()
    expect(t.host.errors()).toEqual([])
  })
})

// ═════════════════════════ 견고함 ═════════════════════════

describe('잘못된 입력', () => {
  it('깨진 JSON·엉뚱한 형식·모르는 종류는 예외 없이 무시한다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    const junk = [
      '',
      '{',
      'null',
      '[]',
      '42',
      '"hello"',
      '{"t":5}',
      '{"no":"type"}',
      '{"t":"nope"}',
      '{"t":"__proto__"}',
      '{"t":"constructor"}',
      '{"t":"toString","e":"wave"}',
      '{"t":"emote"}',
      '{"t":"emote","e":{"toString":1}}',
      '{"t":"say","q":{}}',
      '{"t":"talk","n":[1]}',
      '{"t":"pitch","n":null,"l":null}',
      '{"t":"profile","name":{"a":1},"look":"x"}',
      '{"t":"profile","look":[1e99,-1,null,"a",{},[],0.5]}',
      '{"t":"talkEnd","extra":true}',
      '\u0000\u0001\u0002',
      '{"t":"ping","c":1e999}',
    ]
    for (const text of junk) {
      t.host.t += 100
      t.room.message(a.conn, text)
    }
    t.advance(200)
    expect(t.host.errors()).toEqual([])
    expect(t.room.players.size).toBe(2)
    // 다른 사람에게 새어 나간 방송이 없다(스냅샷·빈 프로필 확인 외)
    expect(t.host.json(b.conn)).toEqual([])
    // 방은 계속 정상 동작한다
    t.send(a.conn, { t: 'ping', c: 5 })
    expect(t.host.of(a.conn, 'pong')).toHaveLength(1)
  })

  it('처리 중 예외가 나도 로그만 남기고 방은 계속 돈다', () => {
    const boom: RoomSystemFactory = () => ({
      name: 'boom',
      handles: ['offer', 'cults'],
      onMessage() {
        throw new Error('message boom')
      },
      onTick() {
        throw new Error('tick boom')
      },
      onJoin() {
        throw new Error('join boom')
      },
      onLeave() {
        throw new Error('leave boom')
      },
      onStat() {
        throw new Error('stat boom')
      },
      onPitch() {
        throw new Error('pitch boom')
      },
      interceptPitch() {
        throw new Error('intercept boom')
      },
      onWelcome() {
        throw new Error('welcome boom')
      },
    })
    const rec = recordingSystem()
    const t = setup({ systems: [boom, rec.factory] })
    const a = t.join()
    const b = t.join()
    expect(t.host.of(a.conn, 'welcome')).toHaveLength(1)
    expect(t.host.of(a.conn, 'join')).toHaveLength(1)
    t.send(a.conn, { t: 'offer' })
    t.sim.throwOnTick = true
    t.advance(300)
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    expect(t.npc(1).owner).toBe(a.id)
    t.room.disconnect(b.conn)
    expect(t.host.of(a.conn, 'leave')).toEqual([{ t: 'leave', id: b.id }])
    const errors = t.host.errors().join('\n')
    for (const what of ['message boom', 'tick boom', 'join boom', 'leave boom', 'stat boom', 'pitch boom', 'intercept boom', 'welcome boom', 'sim boom']) {
      expect(errors).toContain(what)
    }
    // 뒤에 등록된 시스템은 영향 없이 훅을 다 받는다
    expect(rec.log).toContain(`join:${a.id}`)
    expect(rec.log).toContain(`leave:${b.id}`)
    expect(rec.log.filter((l) => l.startsWith('tick:'))).toHaveLength(3)
    expect(rec.log).toContain(`stat:${a.id}:joins:1`)
    // 스냅샷도 계속 나간다
    t.host.clear()
    t.move(a.conn, t.player(a.id).x + 0.1, t.player(a.id).z)
    t.advance(100)
    expect(t.host.snaps(a.conn)).toHaveLength(1)
  })

  it('init 에서 실패한 시스템은 빼고 방을 연다', () => {
    const bad: RoomSystemFactory = () => ({
      name: 'bad',
      handles: ['offer'],
      init() {
        throw new Error('init boom')
      },
      onMessage() {
        throw new Error('불려서는 안 됨')
      },
    })
    const t = setup({ systems: [bad] })
    const a = t.join()
    expect(t.host.errors().join()).toContain('init boom')
    const before = t.host.errors().length
    t.send(a.conn, { t: 'offer' })
    expect(t.host.errors()).toHaveLength(before)
  })
})

// ═════════════════════════ 기능 시스템 연결 ═════════════════════════

describe('기능 시스템(RoomSystem)', () => {
  it('handles 에 적은 메시지와 모든 훅이 전달된다', () => {
    const rec = recordingSystem()
    const t = setup({ systems: [rec.factory] })
    expect(rec.log).toEqual(['init'])
    expect(rec.got.room).toBe(t.room)

    const a = t.join()
    // onWelcome 이 채운 값이 welcome 에 실린다
    expect(a.w.sermon).toEqual({ leader: 77, startedAt: 1, endsAt: 2, joined: [77] })
    expect(rec.log).toEqual(['init', `welcome:${a.id}`, `join:${a.id}`])

    t.send(a.conn, { t: 'prophecy' })
    t.send(a.conn, { t: 'invite', to: 5 })
    t.send(a.conn, { t: 'sermon', a: 'resp', r: 2 })
    t.send(a.conn, { t: 'offer' }) // 아무도 맡지 않은 종류
    t.send(a.conn, { t: 'ping', c: 1 }) // 코어 전용
    expect(rec.got.messages).toEqual([
      { t: 'prophecy' },
      { t: 'invite', to: 5 },
      { t: 'sermon', a: 'resp', r: 2 },
    ])
    // 형태가 틀린 메시지는 시스템까지 가지 않는다
    for (const bad of [
      { t: 'invite' },
      { t: 'invite', to: '5' },
      { t: 'invite', to: 1.5 },
      { t: 'sermon', a: 3 },
      { t: 'sermon', a: 'resp', r: 'x' },
      { t: 'sermon', a: 'x'.repeat(100) },
    ]) {
      t.send(a.conn, bad)
    }
    expect(rec.got.messages).toHaveLength(3)
    // 보낸 쪽에는 형태가 틀렸다고 알려 준다(클라이언트 실수를 개발 중에 알아챌 수 있게)
    expect(t.host.of(a.conn, 'err')).toEqual([
      { t: 'err', code: 'bad', msg: 'invite' },
      { t: 'err', code: 'bad', msg: 'invite' },
      { t: 'err', code: 'bad', msg: 'invite' },
      { t: 'err', code: 'bad', msg: 'sermon' },
      { t: 'err', code: 'bad', msg: 'sermon' },
      { t: 'err', code: 'bad', msg: 'sermon' },
    ])

    t.advance(100)
    expect(rec.log).toContain('tick:0.1')
    rec.log.length = 0
    t.talk(a, 1)
    const line = t.pitch(a, 1, R_JOIN)
    expect(rec.log).toContain(`stat:${a.id}:talks:1`)
    expect(rec.log).toContain(`stat:${a.id}:joins:1`)
    expect(rec.log).toContain(`stat:${a.id}:streak:1`)
    expect(rec.log).toContain(`stat:${a.id}:pitches:1`)
    // onPitch 는 기본 처리가 끝난 뒤(맨 마지막)에 불린다
    expect(rec.log[rec.log.length - 1]).toBe(`pitch:${a.id}:1:${line}:join`)
    t.room.disconnect(a.conn)
    expect(rec.log[rec.log.length - 1]).toBe(`leave:${a.id}`)
    expect(t.host.errors()).toEqual([])
  })

  it('코어 메시지도 handles 에 적으면 코어 처리 뒤에 함께 받는다', () => {
    const seen: string[] = []
    const sys: RoomSystemFactory = () => ({
      name: 'tap',
      handles: ['emote', 'talkEnd', 'profile'],
      onMessage: (p, msg) => void seen.push(`${msg.t}:${p.emote ?? '-'}`),
    })
    const t = setup({ systems: [sys] })
    const a = t.join()
    t.send(a.conn, { t: 'emote', e: 'dance' })
    t.send(a.conn, { t: 'emote', e: 5 }) // 형식이 틀리면 넘기지 않는다
    t.send(a.conn, { t: 'talkEnd' })
    expect(seen).toEqual(['emote:dance', 'talkEnd:dance'])
  })

  it('interceptPitch 가 true 를 돌려주면 기본 처리(합류/거절·세션 정리)를 건너뛴다', () => {
    const order: string[] = []
    const duel: RoomSystemFactory = () => ({
      name: 'duel-test',
      handles: [],
      interceptPitch(p, npc, line, result) {
        order.push(`intercept:${p.id}:${npc.id}:${line.id}:${result.outcome}`)
        return result.outcome === 'join'
      },
      onPitch(_p, _npc, _line, outcome) {
        order.push(`onPitch:${outcome}`)
      },
    })
    const never: RoomSystemFactory = () => ({
      name: 'after',
      handles: [],
      interceptPitch() {
        order.push('second')
        return false
      },
    })
    const t = setup({ systems: [duel, never] })
    const a = t.join()
    const b = t.join()
    t.talk(a, 1)
    t.host.clear()
    const line = t.pitch(a, 1, R_JOIN)
    // 판정 결과 방송은 그대로 나간다
    expect(t.host.of(b.conn, 'pitchRes')).toEqual([{ t: 'pitchRes', p: a.id, n: 1, l: line, o: 'join', say: '합류할게요' }])
    // 합류 처리는 일어나지 않았다
    expect(t.npc(1)).toMatchObject({ owner: 0, talker: a.id })
    expect(t.sim.called('startFollow:')).toHaveLength(0)
    expect(t.host.of(a.conn, 'reward')).toHaveLength(0)
    expect(t.host.of(a.conn, 'talkEnd')).toHaveLength(0)
    expect(t.stat(a.id, STAT.joins)).toBe(0)
    expect(t.player(a.id).prog.fol).toBe(0)
    // 세션 정리는 가로챈 시스템 몫이라 그대로 남아 있다
    expect(t.player(a.id).talk).not.toBeNull()
    // 공통 처리(시도 횟수·쿨타임·onPitch)는 한다. 먼저 가로챈 시스템이 있으면 뒤 시스템에는 묻지 않는다
    expect(t.stat(a.id, STAT.pitches)).toBe(1)
    expect(t.player(a.id).cd.get('pitch')).toBe(t.host.t + PITCH_COOLDOWN_MS)
    expect(order).toEqual([`intercept:${a.id}:1:${line}:join`, 'onPitch:join'])

    // 가로채지 않는 결과는 평소대로(뒤 시스템에도 차례가 간다)
    order.length = 0
    t.pitch(a, 1, [0.99, 0.99, 0.99, 0.99])
    expect(order).toEqual([`intercept:${a.id}:1:${t.host.of(a.conn, 'pitchRes')[1]?.l}:no`, 'second', 'onPitch:no'])
    expect(t.player(a.id).talk).toBeNull()
    expect(t.stat(a.id, STAT.rejects)).toBe(1)
  })

  it('가로챈 시스템이 세션을 방치해도 시간이 지나면 Room 이 정리한다', () => {
    const lazy: RoomSystemFactory = () => ({ name: 'lazy', handles: [], interceptPitch: () => true })
    const t = setup({ systems: [lazy] })
    const a = t.join()
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    t.host.clear()
    t.advance(TALK_TIMEOUT_MS + 200)
    expect(t.host.of(a.conn, 'talkEnd')).toEqual([{ t: 'talkEnd', n: 1, why: 'timeout' }])
    expect(t.npc(1).talker).toBe(0)
  })
})

// ═════════════════════════ RoomApi ═════════════════════════

describe('RoomApi', () => {
  it('grant: 승급하면 reward.rankUp + 방 소식 + pu 방송, 저장 예약', () => {
    const t = setup()
    const a = t.join({ name: '승급이' })
    const b = t.join()
    const p = t.player(a.id)
    t.host.clear()
    t.room.grant(p, { why: 'sermon', inf: RANKS[1]!.inf - 1 })
    expect(t.host.of(a.conn, 'reward')).toEqual([{ t: 'reward', why: 'sermon', inf: RANKS[1]!.inf - 1 }])
    expect(t.host.of(b.conn, 'feed')).toHaveLength(0)
    expect(t.host.of(b.conn, 'pu')).toHaveLength(0)
    expect(p.prog.rank).toBe(0)

    t.host.clear()
    p.saveDirty = false
    t.room.grant(p, { why: 'battle', inf: 1, fol: 2, coins: 5, items: ['sock', 'lotto', 'sock'], streak: 4 })
    expect(t.host.of(a.conn, 'reward')).toEqual([
      { t: 'reward', why: 'battle', inf: 1, fol: 2, coins: 5, streak: 4, rankUp: 1, items: ['sock', 'lotto', 'sock'] },
    ])
    expect(p.prog).toMatchObject({ inf: RANKS[1]!.inf, fol: 2, coins: 5, rank: 1, items: { sock: 2, lotto: 1 } })
    const feed = { t: 'feed', k: 'rank', id: a.id, text: `승급이님이 ${RANKS[1]!.name}로 승급!` }
    expect(t.host.of(b.conn, 'feed')).toEqual([feed])
    expect(t.host.of(a.conn, 'feed')).toEqual([feed])
    expect(t.host.of(b.conn, 'pu')).toEqual([{ t: 'pu', id: a.id, rank: 1, fol: 2 }])
    expect(p.saveDirty).toBe(true)
    t.advance(1100)
    expect(t.host.of(a.conn, 'save').pop()?.me).toMatchObject({ inf: RANKS[1]!.inf, rank: 1 })

    // 한 번에 여러 직급을 뛰어도 소식은 한 번, 조사는 받침에 맞게
    t.host.clear()
    t.room.grant(p, { why: 'test', inf: RANKS[2]!.inf })
    expect(t.host.of(a.conn, 'reward')[0]?.rankUp).toBe(2)
    expect(t.host.of(b.conn, 'feed')).toEqual([{ t: 'feed', k: 'rank', id: a.id, text: `승급이님이 ${RANKS[2]!.name}으로 승급!` }])
  })

  it('grant: 이상한 값은 걸러 내고 합계는 음수가 되지 않으며 직급은 내려가지 않는다', () => {
    const t = setup()
    const a = t.join()
    const p = t.player(a.id)
    t.room.grant(p, { why: 'x', inf: 100 })
    expect(p.prog.rank).toBe(1)
    t.host.clear()
    t.room.grant(p, { why: 'x', inf: Number.NaN, fol: Infinity, coins: -50, items: ['', 'x'.repeat(30), 7 as unknown as string] })
    expect(p.prog).toMatchObject({ inf: 100, fol: 0, coins: 0, items: {} })
    expect(t.host.of(a.conn, 'reward')).toEqual([{ t: 'reward', why: 'x', coins: -50 }])
    t.room.grant(p, { why: 'x', inf: -90.7 })
    expect(p.prog.inf).toBe(10)
    expect(p.prog.rank).toBe(1)
    t.room.grant(p, { why: 'x', inf: 2e9 })
    expect(p.prog.inf).toBe(1e9)
    expect(p.prog.rank).toBe(RANKS.length - 1)
    expect(t.host.errors()).toEqual([])
  })

  it('grant: 교단이 있으면 교주 기록과 교단 저장소에 반영한다', () => {
    const records: { cult: Omit<CultScore, 'online' | 'fol' | 'inf'>; delta: { fol: number; inf: number } }[] = []
    const cults: CultRegistry = {
      record: (cult, delta) => void records.push({ cult, delta }),
      nameTaken: () => false,
      get: (id) =>
        id === 'c1'
          ? { id, name: '라면교', color: 1, emblem: 2, leaderName: '면장님', title: '면장', online: 0, fol: 0, inf: 0 }
          : undefined,
      top: () => [],
      remove: () => {},
    }
    const t = setup({ cults })
    const a = t.join()
    const b = t.join()
    const leader = t.player(a.id)
    const member = t.player(b.id)
    leader.prog.cult = { id: 'c1', name: '라면교', color: 1, emblem: 2, role: 'leader', title: '면장', leaderName: '면장님' }
    member.prog.cult = { id: 'c1', name: '라면교', color: 1, emblem: 2, role: 'member', title: '신도', leaderName: '면장님' }

    t.room.grant(leader, { why: 'join', inf: 10, fol: 1 })
    expect(leader.prog).toMatchObject({ cultInf: 10, cultFol: 1 })
    t.room.grant(member, { why: 'join', inf: 12, fol: 1 })
    expect(member.prog).toMatchObject({ cultInf: 0, cultFol: 0 })
    const meta = { id: 'c1', name: '라면교', color: 1, emblem: 2, leaderName: '면장님', title: '면장' }
    // 교단원의 '신도' 칭호가 교주 칭호를 덮어쓰지 않는다
    expect(records).toEqual([
      { cult: meta, delta: { fol: 1, inf: 10 } },
      { cult: meta, delta: { fol: 1, inf: 12 } },
    ])
    // 깎이는 값·코인만 있는 보상은 교단 기록에 넣지 않는다
    t.room.grant(leader, { why: 'x', inf: -5, coins: 3 })
    expect(records).toHaveLength(2)
    expect(leader.prog.cultInf).toBe(10)
  })

  it('unlockAchievement: 한 번만 달성되고 보상·소식이 나간다', () => {
    const t = setup()
    const a = t.join({ name: '업적왕' })
    const b = t.join()
    const p = t.player(a.id)
    const def = ACHIEVEMENTS[0]!
    t.host.clear()
    expect(t.room.unlockAchievement(p, def.id)).toBe(true)
    expect(p.prog.ach).toEqual([def.id])
    const reward = t.host.of(a.conn, 'reward')
    expect(reward).toHaveLength(1)
    expect(reward[0]).toMatchObject({ why: 'ach', ach: [def.id] })
    if (def.inf > 0) expect(reward[0]?.inf).toBe(def.inf)
    expect(p.prog.inf).toBe(def.inf)
    const feeds = t.host.of(b.conn, 'feed').filter((f) => f.k === 'ach')
    expect(feeds).toHaveLength(1)
    expect(feeds[0]).toMatchObject({ id: a.id })
    expect(feeds[0]?.text).toContain('업적왕')
    expect(feeds[0]?.text).toContain(def.name)
    expect(p.saveDirty).toBe(true)

    t.host.clear()
    expect(t.room.unlockAchievement(p, def.id)).toBe(false)
    expect(t.room.unlockAchievement(p, 'no_such_achievement')).toBe(false)
    expect(p.prog.ach).toEqual([def.id])
    expect(p.prog.inf).toBe(def.inf)
    expect(t.host.json(a.conn)).toEqual([])
    expect(t.host.json(b.conn)).toEqual([])
  })

  it('cooldown: 가능하면 0 을 돌려주며 걸고, 쿨타임 중이면 남은 시간만 알려 준다', () => {
    const t = setup()
    const a = t.join()
    const p = t.player(a.id)
    expect(t.room.cooldown(p, 'prophecy', 5000)).toBe(0)
    expect(p.cd.get('prophecy')).toBe(t.host.t + 5000)
    t.host.t += 1200
    // 남은 시간을 돌려주고, 더 긴 값을 넣어도 연장되지 않는다
    expect(t.room.cooldown(p, 'prophecy', 60_000)).toBe(3800)
    expect(p.cd.get('prophecy')).toBe(t.host.t + 3800)
    // 키가 다르면 서로 무관
    expect(t.room.cooldown(p, 'offer', 1000)).toBe(0)
    t.host.t += 3800
    expect(t.room.cooldown(p, 'prophecy', 100)).toBe(0)
    expect(p.cd.get('prophecy')).toBe(t.host.t + 100)
    // 만료된 쿨타임은 틱이 주기적으로 치운다
    t.advance(31_000)
    expect(p.cd.size).toBe(0)
  })

  it('bump / setStat: 값이 바뀔 때만 onStat 훅과 저장 예약', () => {
    const rec = recordingSystem()
    const t = setup({ systems: [rec.factory] })
    const a = t.join()
    const p = t.player(a.id)
    rec.log.length = 0
    p.saveDirty = false
    expect(t.room.bump(p, 'talks')).toBe(1)
    expect(t.room.bump(p, 'talks', 4)).toBe(5)
    expect(p.saveDirty).toBe(true)
    t.room.setStat(p, 'streak', 3)
    t.room.setStat(p, 'streak', 3) // 그대로면 훅 없음
    expect(t.room.bump(p, 'talks', 0)).toBe(5)
    t.room.setStat(p, 'streak', -4) // 음수는 0 으로
    expect(rec.log).toEqual([
      `stat:${a.id}:talks:1`,
      `stat:${a.id}:talks:5`,
      `stat:${a.id}:streak:3`,
      `stat:${a.id}:streak:0`,
    ])
    expect(p.prog.stats).toEqual({ talks: 5, streak: 0 })
    // 저장본을 다시 읽을 때 버려질 긴 키는 받지 않고 경고를 남긴다
    expect(t.room.bump(p, 'x'.repeat(25))).toBe(0)
    expect(t.host.logs.some((l) => l.level === 'warn')).toBe(true)
    expect(Object.keys(p.prog.stats)).toEqual(['talks', 'streak'])
  })

  it('onStat 안에서 업적을 주거나 다른 통계를 올려도 되고, 끝없이 물리면 끊는다', () => {
    const sys: RoomSystemFactory = () => {
      let room: RoomApi
      return {
        name: 'ach-test',
        handles: [],
        init: (r) => void (room = r),
        onStat(p, stat, value) {
          if (stat === 'joins' && value >= 1) room.unlockAchievement(p, ACHIEVEMENTS[0]!.id)
          if (stat === 'loopA') room.bump(p, 'loopB')
          if (stat === 'loopB') room.bump(p, 'loopA')
        },
      }
    }
    const t = setup({ systems: [sys] })
    const a = t.join()
    const p = t.player(a.id)
    t.room.bump(p, 'joins')
    expect(p.prog.ach).toEqual([ACHIEVEMENTS[0]!.id])
    t.room.bump(p, 'loopA')
    expect(t.host.errors().join()).toContain('onStat')
    expect(p.prog.stats.loopA).toBeLessThan(20)
    // 그 뒤에도 정상 동작
    expect(t.room.bump(p, 'talks')).toBe(1)
  })

  it('send / broadcast / publish / feed / playerPublic / playerByPid', () => {
    const t = setup()
    const a = t.join({ pid: 'api-device-00001', name: '공개정보' })
    const b = t.join()
    const p = t.player(a.id)
    t.host.clear()
    t.room.send(p, { t: 'err', code: 'x' })
    expect(t.host.json(a.conn)).toEqual([{ t: 'err', code: 'x' }])
    expect(t.host.json(b.conn)).toEqual([])
    t.host.clear()
    t.room.broadcast({ t: 'feed', k: 'info', id: 0, text: '모두에게' })
    t.room.broadcast({ t: 'feed', k: 'info', id: 0, text: 'a 빼고' }, p)
    expect(t.host.of(a.conn, 'feed').map((f) => f.text)).toEqual(['모두에게'])
    expect(t.host.of(b.conn, 'feed').map((f) => f.text)).toEqual(['모두에게', 'a 빼고'])
    t.host.clear()
    t.room.feed('sermon', a.id, '설교 시작!')
    expect(t.host.json(b.conn)).toEqual([{ t: 'feed', k: 'sermon', id: a.id, text: '설교 시작!' }])

    t.host.clear()
    p.prog.cult = { id: 'c9', name: '월요병 구원회', color: 3, emblem: 4, role: 'leader', title: '총무', leaderName: '공개정보' }
    t.room.publish(p, ['cult', 'name', 'look', 'rank', 'fol'])
    expect(t.host.json(b.conn)).toEqual([
      { t: 'pu', id: a.id, cult: p.prog.cult, name: '공개정보', look: LOOK0, rank: 0, fol: 0 },
    ])
    // 교단을 떠난 경우 null 이 그대로 실려야 한다(필드 생략과 구분)
    t.host.clear()
    p.prog.cult = null
    t.room.publish(p, ['cult'])
    expect(t.host.json(b.conn)).toEqual([{ t: 'pu', id: a.id, cult: null }])
    t.host.clear()
    t.room.publish(p, [])
    expect(t.host.json(b.conn)).toEqual([])

    expect(t.room.playerPublic(p)).toEqual({
      id: a.id,
      name: '공개정보',
      look: LOOK0,
      rank: 0,
      fol: 0,
      cult: null,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      st: Anim.Idle,
      emote: null,
      tag: '',
    })
    expect(t.room.playerByPid('api-device-00001')).toBe(p)
    expect(t.room.playerByPid('unknown-device-00')).toBeUndefined()
    expect(t.room.now()).toBe(t.host.t)
    expect(t.room.id).toBe('1')
    expect(t.room.name).toBe('시험 방')
    expect(t.room.world).toBe(TEST_WORLD)
    // 나간 사람에 대한 publish 는 방송하지 않는다
    t.room.disconnect(a.conn)
    t.host.clear()
    t.room.publish(p, ['fol'])
    t.room.grant(p, { why: 'late', inf: 5, fol: 1 })
    expect(t.host.of(b.conn, 'pu')).toHaveLength(0)
  })

  it('markSave 는 다음 저장 주기에 save 를 내보낸다', () => {
    const t = setup()
    const a = t.join()
    const p = t.player(a.id)
    t.advance(1000)
    t.host.clear()
    p.prog.daily = { day: '2026-11-26', quests: ['d_join2'], prog: {}, done: [], streak: 1, fortune: 0 }
    t.room.markSave(p)
    t.advance(100)
    const saves = t.host.of(a.conn, 'save')
    expect(saves).toHaveLength(1)
    expect(saves[0]?.me.daily?.day).toBe('2026-11-26')
    expect(saves[0]?.me.ts).toBe(t.host.t)
    expect((JSON.parse(saves[0]!.save.d) as Progress).daily?.quests).toEqual(['d_join2'])
    expect(p.saveDirty).toBe(false)
  })
})

// ═════════════════════════ NPC 알림 ═════════════════════════

describe('NpcSim 이벤트 연결', () => {
  it('onSpawn → npcSpawn, onOwnerChange → nu', () => {
    const t = setup()
    const a = t.join()
    t.host.clear()
    const n = t.npc(4)
    n.name = '새로 온 시민'
    t.sim.events.onSpawn(n)
    expect(t.host.of(a.conn, 'npcSpawn')).toEqual([
      { t: 'npcSpawn', n: expect.objectContaining({ id: 4, name: '새로 온 시민', arch: 'test', owner: 0 }) },
    ])
    n.owner = a.id
    t.sim.events.onOwnerChange(n, 0, 'join')
    n.owner = 0
    t.sim.events.onOwnerChange(n, a.id, 'expire')
    expect(t.host.of(a.conn, 'nu')).toEqual([
      { t: 'nu', n: 4, owner: a.id },
      { t: 'nu', n: 4, owner: 0 },
    ])
  })

  it('onSay 는 모아서 틱마다 npcSay 한 번으로 내보낸다', () => {
    const t = setup()
    const a = t.join()
    t.advance(100)
    t.host.clear()
    t.sim.events.onSay(t.npc(1), '집에 가고 싶다…')
    t.sim.events.onSay(t.npc(2), '오늘 점심 뭐 먹지…')
    t.sim.events.onSay(t.npc(3), '')
    expect(t.host.of(a.conn, 'npcSay')).toHaveLength(0)
    t.advance(100)
    expect(t.host.of(a.conn, 'npcSay')).toEqual([
      { t: 'npcSay', l: [[1, '집에 가고 싶다…'], [2, '오늘 점심 뭐 먹지…']] },
    ])
    t.host.clear()
    t.advance(500)
    expect(t.host.of(a.conn, 'npcSay')).toHaveLength(0)
  })

  it('떠나는 말은 교체(npcSpawn)보다 먼저 나간다', () => {
    const t = setup()
    const a = t.join()
    t.host.clear()
    t.sim.events.onSay(t.npc(5), '아 맞다, 조별과제…')
    t.sim.events.onSpawn(t.npc(5))
    expect(t.host.json(a.conn).map((m) => m.t)).toEqual(['npcSay', 'npcSpawn'])
  })

  it('RoomApi.npcSay 는 바로 방송한다(쌓여 있던 말과 함께, 순서대로)', () => {
    const t = setup()
    const a = t.join()
    t.host.clear()
    t.sim.events.onSay(t.npc(1), '먼저 한 말')
    t.room.npcSay([[2, '거기! 무단 포교 금지!'], [3, '']])
    expect(t.host.of(a.conn, 'npcSay')).toEqual([{ t: 'npcSay', l: [[1, '먼저 한 말'], [2, '거기! 무단 포교 금지!']] }])
    t.room.npcSay([])
    expect(t.host.of(a.conn, 'npcSay')).toHaveLength(1)
  })

  it('아무도 없는 방에서는 알림을 쌓아 두지 않는다', () => {
    const t = setup()
    for (let i = 0; i < 100; i++) t.sim.events.onSay(t.npc(1), '혼잣말')
    t.sim.events.onSpawn(t.npc(1))
    t.advance(1000)
    const a = t.join()
    t.advance(100)
    expect(t.host.of(a.conn, 'npcSay')).toHaveLength(0)
    expect(t.host.of(a.conn, 'npcSpawn')).toHaveLength(0)
  })
})

// ═════════════════════════ 틱 ═════════════════════════

describe('틱', () => {
  it('NPC 시뮬과 시스템에 경과 시간을 초 단위로 넘기고, 멈췄다 깨어나도 1초로 자른다', () => {
    const rec = recordingSystem()
    const t = setup({ systems: [rec.factory] })
    t.advance(100)
    expect(t.sim.ticks).toBe(1)
    expect(t.sim.lastDt).toBeCloseTo(0.1, 5)
    t.host.t += 60_000
    t.room.tick()
    expect(t.sim.lastDt).toBe(1)
    // 시계가 뒤로 가도 음수가 되지 않는다
    t.host.t -= 5000
    t.room.tick()
    expect(t.sim.lastDt).toBe(0)
    expect(rec.log.filter((l) => l.startsWith('tick:'))).toEqual(['tick:0.1', 'tick:1.0', 'tick:0.0'])
  })

  it('빈 방은 스냅샷을 만들지 않지만 dirty 는 치운다', () => {
    const t = setup()
    expect(t.npc(1).dirty).toBe(true)
    t.advance(100)
    expect(t.npc(1).dirty).toBe(false)
    expect(t.host.frames.size).toBe(0)
  })
})

// ═════════════════════════ 실제 구성으로 한 바퀴 ═════════════════════════

describe('기본 구성(실제 NPC 시뮬 + 기본 시스템)', () => {
  it('두 사람이 들어와 움직이고 30초가 지나도 예외 없이 돌아간다', () => {
    const host = new FakeHost()
    const room = new Room(host, { id: '7', name: '수상역 7번 출구', seed: 123 })
    const say = (conn: number, msg: ClientMsg): void => room.message(conn, JSON.stringify(msg))
    room.connect(1)
    say(1, { t: 'hello', v: PROTOCOL_VERSION, pid: 'smoke-device-0001', name: '첫손님', look: LOOK0 })
    room.connect(2)
    say(2, { t: 'hello', v: PROTOCOL_VERSION, pid: 'smoke-device-0002', name: '둘째손님', look: LOOK0 })
    const w1 = host.of(1, 'welcome')[0]
    const w2 = host.of(2, 'welcome')[0]
    expect(w1).toBeDefined()
    expect(w2).toBeDefined()
    expect(w2!.players.map((p) => p.id)).toEqual([w1!.id])
    expect(w1!.npcs.length).toBe(room.info().npcs)
    expect(w1!.npcs.length).toBeGreaterThan(0)

    let x = w1!.x
    for (let i = 0; i < 300; i++) {
      host.t += TICK_MS
      x += 0.2 * (i % 40 < 20 ? 1 : -1)
      room.message(1, encodeMove(x, w1!.z, 0, Anim.Walk))
      if (i % 40 === 0) say(1, { t: 'ping', c: i })
      if (i % 40 === 0) say(2, { t: 'ping', c: i })
      if (i === 50) say(2, { t: 'emote', e: 'dance' })
      if (i === 100) say(1, { t: 'talk', n: w1!.npcs[0]!.id })
      if (i === 150) say(1, { t: 'talkEnd' })
      room.tick()
    }
    expect(host.errors()).toEqual([])
    expect(room.players.size).toBe(2)
    // 모든 바이너리 프레임이 스냅샷으로 해독되고, 1번의 이동이 2번에게 전달됐다
    const snaps = host.snaps(2)
    expect(snaps.length).toBeGreaterThan(100)
    expect(snaps.some((s) => s.players.some((e) => e.id === w1!.id))).toBe(true)
    expect(host.of(1, 'emote')).toEqual([{ t: 'emote', id: w2!.id, e: 'dance' }])
    room.shutdown()
    expect(host.closes.size).toBe(2)
  })
})
