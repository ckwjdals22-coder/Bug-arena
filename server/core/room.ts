/**
 * Room: 방 하나의 권위 시뮬레이션.
 *   세션(접속/퇴장) · 이동 검증 · 스냅샷 · 이모트/말풍선 · 대화/포교 · 보상 · 저장본 서명 · 기능 시스템 연결.
 *
 * 전송 계층과 무관하다(§4.1). 어댑터(Node ws / Workers DO)가 connect/message/disconnect/tick 을 불러 주고,
 * Room 은 RoomHost 로만 바깥과 이야기한다. 그래서 여기서는 Date.now/Math.random/타이머/Node API 를 쓰지 않는다.
 *
 * 안정성 원칙: 클라이언트가 보낸 것은 전부 의심한다. 메시지 하나, 시스템 훅 하나가 예외를 던져도
 * 방 전체가 멈추면 안 되므로 경계마다 try/catch 로 막고 로그만 남긴다.
 */
import {
  Anim,
  EMOTE_COOLDOWN_MS,
  FOLLOW_DURATION_MS,
  HELLO_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  INF_FAIL,
  INF_JOIN,
  INF_MORE,
  INF_STREAK_BONUS,
  INF_STREAK_MAX,
  LINES_PER_TALK,
  MAX_ENTOURAGE,
  MAX_MSG_BYTES,
  NAME_MAX,
  NPCS_PER_ROOM,
  NPC_REJECT_MEMORY_MS,
  PITCH_COOLDOWN_MS,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  RATE_LIMIT_PER_SEC,
  ROOM_CAPACITY,
  RUN_SPEED,
  SAY_COOLDOWN_MS,
  SPEED_TOLERANCE,
  SPRINT_COOLDOWN_MS,
  SPRINT_MS,
  SPRINT_SPEED,
  TALK_RANGE,
  TALK_TIMEOUT_MS,
} from '../../shared/constants'
import { ACHIEVEMENT_BY_ID } from '../../shared/content/achievements'
import { EMOTE_BY_ID, RANKS, STAT, rankForInfluence } from '../../shared/content/core'
import { PITCH_LINES } from '../../shared/content/lines'
import { NICK_ADJ, NICK_NOUN, QUICK_CHATS } from '../../shared/content/misc'
import type { PitchLine } from '../../shared/content/types'
import {
  CLOSE_BAD,
  CLOSE_FULL,
  CLOSE_KICK,
  CLOSE_SHUTDOWN,
  type ClientMsg,
  type SKick,
  type SPlayerUpdate,
  type SReward,
  type STalkEnd,
  type SWelcome,
  type ServerMsg,
  decodeMove,
  encodeSnapshot,
  parseJsonMsg,
} from '../../shared/protocol'
import { hashString, mulberry32, pick, type Rnd } from '../../shared/rng'
import { checkNickname, cleanText } from '../../shared/rules/moderation'
import { type PitchResult, pickLines, resolvePitch } from '../../shared/rules/pitch'
import { newProgress, normalizeProgress, sanitizeLook } from '../../shared/rules/progress'
import type { FeedKind, Look, PitchOutcome, PlayerPublic, Progress, RoomInfo, SignedSave } from '../../shared/types'
import { WORLD, type WorldDef, resolveCollision } from '../../shared/world'
import type {
  ConnId,
  Grant,
  LastSeat,
  NpcSimApi,
  NpcSimEvents,
  NpcState,
  PlayerMemory,
  PlayerState,
  RoomApi,
  RoomHost,
  RoomOptions,
  RoomSystem,
} from './api'
import { createNpcSim } from './npcSim'
import { DEFAULT_SYSTEMS } from './systems'

// ───────────────────────── 조정값 ─────────────────────────

/**
 * hello 프레임만은 일반 메시지보다 크게 허용한다.
 * hello 에는 서명 저장본(진행도 JSON)이 통째로 실려 오는데, 업적·도감이 쌓이면 MAX_MSG_BYTES(4KB)를 넘을 수 있다.
 * 그때 hello 를 버리면 오래 한 사람일수록 접속을 못 하게 되므로, 입장 전 프레임 한정으로 넉넉히 받는다.
 * (어댑터의 프레임 상한도 이 값에 맞춘다. 입장 후 프레임은 Room 이 MAX_MSG_BYTES 로 다시 거른다.)
 */
export const MAX_HELLO_BYTES = 32 * 1024

/** 토큰 버킷 용량(버스트). 평소 클라이언트는 초당 10~15개라 닿을 일이 없다 */
const RATE_BURST = RATE_LIMIT_PER_SEC * 2
/**
 * 입장 전에 받아 주는 프레임 수. 정상 클라이언트는 hello 하나만 보낸다.
 * 입장 전에는 큰 프레임(MAX_HELLO_BYTES)도 파싱해 주므로, 그 상태로 계속 떠드는 연결은 일찍 끊는다.
 */
const MAX_PRE_HELLO_FRAMES = 4

/** 이동 검증: 패킷 한 번에 눈감아 주는 오차(m) */
const MOVE_SLACK_M = 0.5
/**
 * 이동 검증: 쌓아 둘 수 있는 '이동 허용량'의 상한(초 단위).
 * 모바일 망이 잠깐 멎었다가 밀린 패킷이 한꺼번에 오는 것은 정상이라 그만큼은 받아 줘야 하고,
 * 반대로 한참 서 있다가 맵 끝까지 순간이동하는 것은 막아야 한다.
 */
const MOVE_BURST_MS = 1500
/**
 * 서버 쪽 충돌 검사 반지름. 클라이언트(PLAYER_RADIUS)보다 일부러 작게 잡는다.
 * 정상 클라이언트는 항상 더 바깥에 서 있으므로 절대 걸리지 않고, 벽 속이나 닫힌 교단 건물 안으로
 * 들어가려는 조작된 좌표만 걸린다.
 */
const COLLIDE_RADIUS = Math.max(0.05, PLAYER_RADIUS - 0.25)
/** 같은 위치 보정(pos)을 다시 보내기까지의 최소 간격 — 밀린 패킷이 한꺼번에 거절될 때 도배 방지 */
const POS_RESEND_MS = 200
/** 이 거리(m) 넘게 움직여야 '이동했다'로 본다(반복 이모트 해제 판단) */
const MOVED_EPS = 0.02
/** 대화 중인 NPC 에게서 이만큼 멀어지면 대화를 끊는다(NPC 가 빈자리를 보며 서 있지 않게) */
const TALK_LEASH_M = TALK_RANGE + 3

/**
 * 쿨타임 여유. 클라이언트는 '보낸 시각', 서버는 '받은 시각'으로 재기 때문에 망 지연이 출렁이면
 * 정확히 쿨타임에 맞춰 보낸 요청이 수십 ms 일찍 도착할 수 있다. 그 정도는 통과시킨다.
 */
const COOLDOWN_GRACE_MS = 120
/** 스프린트는 거절되면 클라이언트만 달리다 끌려오므로 더 넉넉하게(sprintUntil 의 +400 과 같은 값) */
const SPRINT_GRACE_MS = 400
/** NPC 시뮬의 자체 대화 만료를 Room 보다 조금 늦게 잡는다 → 평소에는 Room 이 먼저 'timeout' 으로 끝낸다 */
const LISTEN_GRACE_MS = 1500
/**
 * 말만 걸어 놓고 멘트를 고르지 않은 채 끝낸(취소/시간 초과) 사람을 NPC 가 잠깐 피하는 시간.
 * 이게 없으면 '말 걸기 → 취소'를 반복해 마음에 드는 멘트가 나올 때까지 다시 뽑거나,
 * 한 NPC 를 계속 붙잡아 다른 사람이 말을 못 걸게 할 수 있다.
 */
const TALK_ABANDON_MEMORY_MS = 4000

const SAVE_INTERVAL_MS = 1000
const EMPTY_SNAPSHOT_MS = 1000
/** 틱 간격이 벌어져도 NPC 가 한 번에 건너뛰는 시간의 상한(초). 빈 방은 1초에 한 번 틱한다 */
const MAX_TICK_DT = 1
/** 쿨타임 맵 청소 주기(틱) */
const CD_SWEEP_TICKS = 300
/** 접속자별 메모(쿨타임·차단·입막음) 청소 주기 */
const MEMORY_SWEEP_TICKS = 600
/** 차단 목록을 접속이 끊긴 뒤에도 기억하는 시간 */
const BLOCK_MEMORY_MS = 6 * 60 * 60_000
/** 메모 저장소 상한(넘으면 접속 중이 아닌 오래된 것부터 버린다) */
const MEMORY_MAX = 20_000
/**
 * 연결이 '비정상적으로' 끊긴 사람(망 전환, 터널, 잠깐의 끊김)을 방에 그대로 세워 두는 시간.
 * 이 안에 같은 pid 가 다시 붙으면 같은 번호·같은 자리·같은 상태(배틀, 신도, 쿨타임)로 이어진다.
 */
export const RESUME_GRACE_MS = 15_000
/** 방에서 완전히 나간 뒤에도 서 있던 자리와 따라오던 신도를 기억해 두는 시간(다른 앱에 다녀온 경우) */
export const REJOIN_MEMORY_MS = 5 * 60_000
/** 이보다 짧게 머물렀고 신도도 없던 사람의 자리는 기억하지 않는다(스쳐 지나간 접속으로 메모가 쌓이지 않게) */
const REJOIN_MIN_SESSION_MS = 20_000
/** 닉네임을 다시 바꿀 수 있기까지의 시간 */
export const NAME_CHANGE_COOLDOWN_MS = 5000
/** 한 번에 내보내는 NPC 말풍선 수 상한 */
const MAX_SAY_BATCH = 24
/** onStat → bump → onStat … 로 시스템끼리 물고 물리는 경우의 안전장치 */
const MAX_STAT_DEPTH = 8

const PID_RE = /^[\w-]{8,64}$/
const TOTAL_MAX = 1e9
/** normalizeProgress 가 24자를 넘는 키를 버리므로 저장되는 키는 그 안에서만 받는다 */
const KEY_MAX = 24
const PUB_NAME = 1
const PUB_LOOK = 2
const PUB_TAG = 4

const KICK_JSON: Record<SKick['why'], string> = {
  dup: '{"t":"kick","why":"dup"}',
  idle: '{"t":"kick","why":"idle"}',
  rate: '{"t":"kick","why":"rate"}',
  ver: '{"t":"kick","why":"ver"}',
  bad: '{"t":"kick","why":"bad"}',
  shutdown: '{"t":"kick","why":"shutdown"}',
}

type PubField = 'name' | 'look' | 'rank' | 'fol' | 'cult' | 'tag'
type InMsg = { t: string } & Record<string, unknown>

/**
 * 기능 시스템으로 넘기기 전에 하는 최소한의 형태 검사.
 * i = 정수, s = 짧은 문자열, b = 불리언, 뒤에 ? 가 붙으면 생략 가능.
 * 값의 '범위/의미'는 각 시스템이 판단한다(열거값을 여기서 고정하면 프로토콜에 값을 추가할 때 조용히 막힌다).
 * 표에 없는 종류·필드는 그대로 통과한다.
 */
type FieldSpec = readonly [key: string, kind: 'i' | 's' | 'b' | 'i?' | 's?' | 'b?']
const SYSTEM_FIELDS = new Map<string, readonly FieldSpec[]>([
  ['cultCreate', [['name', 's'], ['color', 'i'], ['emblem', 'i'], ['title', 's']]],
  ['invite', [['to', 'i']]],
  ['inviteAns', [['from', 'i'], ['ok', 'b'], ['block', 'b?']]],
  ['block', [['id', 'i'], ['on', 'b']]],
  ['report', [['id', 'i'], ['why', 's']]],
  ['sermon', [['a', 's'], ['r', 'i?']]],
  ['battle', [['a', 's'], ['to', 'i?'], ['from', 'i?'], ['ok', 'b?']]],
  ['duel', [['c', 'i']]],
  ['daily', [['q', 's']]],
])
const SYSTEM_STR_MAX = 64

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function fieldsOk(msg: InMsg): boolean {
  const spec = SYSTEM_FIELDS.get(msg.t)
  if (!spec) return true
  for (const [key, kind] of spec) {
    const v = msg[key]
    if (v === undefined || v === null) {
      if (kind.endsWith('?')) continue
      return false
    }
    const k = kind.charAt(0)
    if (k === 'i' ? !isInt(v) : k === 'b' ? typeof v !== 'boolean' : typeof v !== 'string' || v.length > SYSTEM_STR_MAX) {
      return false
    }
  }
  return true
}

/** UTF-8 로 보냈을 때의 바이트 수(TextEncoder 로 실제 인코딩하지 않고 센다) */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      // 서로게이트 쌍 = 4바이트
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** 받침에 따라 '로/으로' 를 붙인다(ㄹ 받침은 '로') */
function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1)
  if (!(code >= 0xac00 && code <= 0xd7a3)) return `${word}(으)로`
  const jong = (code - 0xac00) % 28
  return word + (jong === 0 || jong === 8 ? '로' : '으로')
}

const round2 = (v: number): number => Math.round(v * 100) / 100

function toDelta(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
}

function clampTotal(v: number): number {
  return v < 0 ? 0 : v > TOTAL_MAX ? TOTAL_MAX : v
}

function sameLook(a: Look, b: Look): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return a.length === b.length
}

/** 연결 하나의 서버 쪽 상태(PlayerState 에 넣기엔 Room 내부 사정인 것들) */
/** 연결이 떨어진 채 방에 남아 있는 사람의 conn 값(어떤 실제 연결과도 겹치지 않는다 → 보내는 것은 조용히 버려진다) */
const DETACHED_CONN = -1

interface Session {
  conn: ConnId
  connectedAt: number
  lastMsgAt: number
  /** 토큰 버킷 */
  tokens: number
  tokensAt: number
  /** hello 를 통과하기 전에는 null */
  player: PlayerState | null
  /** 입장 전에 받은 프레임 수 */
  preFrames: number
  /** 이동 허용량(m)과 마지막으로 채운 시각 */
  budget: number
  budgetAt: number
  /** 마지막으로 보낸 위치 보정 */
  posAt: number
  posX: number
  posZ: number
  saveAt: number
  /** 다음 틱에 방송할 프로필 변경(PUB_*) */
  pubMask: number
  /** 바뀐 게 없어도 본인에게는 확정값을 돌려줘야 하는가 */
  pubAck: boolean
}

/** 테스트에서 NPC 시뮬을 바꿔 끼우기 위한 틈. 평소에는 생략한다 */
export interface RoomDeps {
  createNpcSim?: (world: WorldDef, rnd: Rnd, events: NpcSimEvents, count: number) => NpcSimApi
}

export class Room implements RoomApi {
  readonly id: string
  readonly name: string
  readonly capacity: number
  readonly players = new Map<number, PlayerState>()
  readonly npcs: NpcSimApi
  readonly world: WorldDef
  readonly host: RoomHost
  readonly rnd: Rnd

  private readonly conns = new Map<ConnId, Session>()
  private readonly byPid = new Map<string, PlayerState>()
  /** 접속이 끊겨도 잠깐 남는 접속자별 메모(pid → 쿨타임·차단·입막음·이름 고정) */
  private readonly memory: Map<string, PlayerMemory>
  /** 연결은 끊겼지만 아직 방에 서 있는 사람들(pid → 이 시각까지 기다린다) */
  private readonly lingering = new Map<string, { p: PlayerState; until: number }>()
  private readonly systems: RoomSystem[] = []
  private readonly routes = new Map<string, RoomSystem[]>()
  private nextId = 1
  private pendingCount = 0
  private closed = false
  private lastTickAt: number
  private lastSnapAt = 0
  private tickCount = 0
  private statDepth = 0
  private sayBuf: [number, string][] = []
  /** 스냅샷용 재사용 배열(틱마다 새로 만들지 않는다) */
  private readonly snapPlayers: PlayerState[] = []
  private readonly snapNpcs: NpcState[] = []
  private readonly tmpPos = { x: 0, z: 0 }

  constructor(host: RoomHost, opts: RoomOptions, deps: RoomDeps = {}) {
    this.host = host
    this.id = opts.id
    this.name = opts.name
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? ROOM_CAPACITY))
    this.world = opts.world ?? WORLD
    // 시드를 host.random() 에서 한 번만 뽑아 두면 이후 방 안의 모든 난수가 재현 가능해진다
    this.rnd = mulberry32(opts.seed ?? Math.floor(host.random() * 0x100000000))
    this.lastTickAt = host.now()
    this.memory = opts.memory ?? new Map()

    const events: NpcSimEvents = {
      onSpawn: (npc) => this.onNpcSpawn(npc),
      onOwnerChange: (npc) => this.onNpcOwnerChange(npc),
      onSay: (npc, text) => this.onNpcSay(npc, text),
    }
    const makeSim = deps.createNpcSim ?? createNpcSim
    this.npcs = makeSim(this.world, this.rnd, events, Math.max(0, Math.floor(opts.npcCount ?? NPCS_PER_ROOM)))

    for (const factory of opts.systems ?? DEFAULT_SYSTEMS) {
      let sys: RoomSystem
      try {
        sys = factory()
        sys.init?.(this)
      } catch (err) {
        // 시스템 하나가 초기화에 실패해도 방은 나머지 기능으로 열려야 한다
        host.log('error', `[방 ${this.id}] 시스템 초기화 실패 — 이 시스템 없이 계속합니다`, err)
        continue
      }
      this.systems.push(sys)
      for (const type of sys.handles) {
        const list = this.routes.get(type)
        if (list) list.push(sys)
        else this.routes.set(type, [sys])
      }
    }
  }

  // ═════════════════ 어댑터가 부르는 것 ═════════════════

  /** hello 를 아직 보내지 않은 연결 수 — 로비가 자리 계산에 쓴다 */
  get pending(): number {
    return this.pendingCount
  }

  now(): number {
    return this.host.now()
  }

  info(): RoomInfo {
    return { id: this.id, name: this.name, players: this.players.size, cap: this.capacity, npcs: this.npcs.list.length }
  }

  connect(conn: ConnId): void {
    if (this.closed) {
      this.host.close(conn, CLOSE_SHUTDOWN, 'shutdown')
      return
    }
    // 어댑터가 같은 id 를 다시 썼다면 이전 것을 먼저 정리한다(유령 세션 방지)
    if (this.conns.has(conn)) this.disconnect(conn)
    const now = this.host.now()
    this.conns.set(conn, {
      conn,
      connectedAt: now,
      lastMsgAt: now,
      tokens: RATE_BURST,
      tokensAt: now,
      player: null,
      preFrames: 0,
      budget: 0,
      budgetAt: now,
      posAt: 0,
      posX: 0,
      posZ: 0,
      saveAt: 0,
      pubMask: 0,
      pubAck: false,
    })
    this.pendingCount++
  }

  message(conn: ConnId, data: string | ArrayBuffer | Uint8Array): void {
    const s = this.conns.get(conn)
    if (!s) return
    try {
      const now = this.host.now()
      if (!this.takeToken(s, now)) {
        this.kickSession(s, 'rate')
        return
      }
      s.lastMsgAt = now
      if (!s.player && ++s.preFrames > MAX_PRE_HELLO_FRAMES) {
        this.kickSession(s, 'bad', CLOSE_BAD)
        return
      }
      if (typeof data === 'string') {
        // 입장 전에는 hello(저장본 포함)만 오므로 그때만 큰 프레임을 받는다
        const limit = s.player ? MAX_MSG_BYTES : MAX_HELLO_BYTES
        if (data.length > limit) return
        if (data.length * 3 > limit && utf8Length(data) > limit) return
        const msg = parseJsonMsg<InMsg>(data)
        if (msg) this.onJson(s, msg, now)
      } else {
        const p = s.player
        if (!p || data.byteLength > MAX_MSG_BYTES) return
        p.lastMsgAt = now
        this.onMove(s, p, data, now)
      }
    } catch (err) {
      this.host.log('error', `[방 ${this.id}] 메시지 처리 중 예외(연결 ${conn})`, err)
    }
  }

  /**
   * 연결이 닫혔다. clean = 상대가 스스로 정상 종료했는가(탭 닫기, 나가기, 방 옮기기 → 바로 퇴장).
   * false(망 끊김, 응답 없음 등)면 잠시 방에 세워 두고 같은 pid 의 재접속을 기다린다.
   */
  disconnect(conn: ConnId, clean = true): void {
    const s = this.conns.get(conn)
    if (!s) return
    this.forget(s)
    const p = s.player
    if (!p) return
    if (clean || this.closed) {
      this.removePlayer(p)
      return
    }
    // 대화는 접는다(시민을 붙잡아 둔 채로 기다리지 않는다). 그 밖의 상태는 그대로 둔다
    this.endTalk(p, 'cancel')
    p.conn = DETACHED_CONN
    if (p.st !== Anim.Stun) p.st = Anim.Idle
    p.dirty = true
    this.lingering.set(p.pid, { p, until: this.host.now() + RESUME_GRACE_MS })
  }

  tick(): void {
    if (this.closed) return
    const now = this.host.now()
    let dt = (now - this.lastTickAt) / 1000
    this.lastTickAt = now
    // 시계가 뒤로 가거나 프로세스가 멈췄다 깨어나도 시뮬이 튀지 않게 한다
    if (!(dt > 0)) dt = 0
    else if (dt > MAX_TICK_DT) dt = MAX_TICK_DT
    this.tickCount++

    try {
      this.npcs.tick(now, dt, this.players)
    } catch (err) {
      this.host.log('error', `[방 ${this.id}] NPC 시뮬 틱 예외`, err)
    }
    try {
      this.tickSessions(now)
    } catch (err) {
      this.host.log('error', `[방 ${this.id}] 세션 틱 예외`, err)
    }
    for (const sys of this.systems) {
      if (!sys.onTick) continue
      try {
        sys.onTick(now, dt)
      } catch (err) {
        this.hookError(sys, 'onTick', err)
      }
    }
    try {
      this.flushProfiles()
      this.flushSays()
      this.sendSnapshot(now)
      this.sendSaves(now)
    } catch (err) {
      this.host.log('error', `[방 ${this.id}] 틱 송신 예외`, err)
    }
  }

  /** 다른 방에 같은 pid 가 들어왔을 때 어댑터가 부른다 */
  kickPid(pid: string, why: SKick['why']): boolean {
    const p = this.byPid.get(pid)
    if (!p) return false
    const s = this.conns.get(p.conn)
    if (s && s.player === p) this.kickSession(s, why)
    else this.removePlayer(p)
    return true
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    const now = this.host.now()
    for (const s of this.conns.values()) {
      const p = s.player
      // 마지막 1초 안의 진행도를 잃지 않게 저장본부터 내려보낸다
      if (p && p.saveDirty) this.sendSave(s, p, now)
      this.host.send(s.conn, KICK_JSON.shutdown)
      this.host.close(s.conn, CLOSE_SHUTDOWN, 'shutdown')
    }
    this.conns.clear()
    this.players.clear()
    this.byPid.clear()
    this.pendingCount = 0
  }

  // ═════════════════ RoomApi ═════════════════

  send(p: PlayerState, msg: ServerMsg): void {
    this.sendTo(p.conn, msg)
  }

  broadcast(msg: ServerMsg, except?: PlayerState): void {
    if (this.players.size === 0) return
    // 직렬화는 한 번만 — 받는 사람 수만큼 반복하지 않는다
    const text = JSON.stringify(msg)
    for (const p of this.players.values()) {
      if (p !== except) this.host.send(p.conn, text)
    }
  }

  grant(p: PlayerState, g: Grant): void {
    this.applyGrant(p, g, undefined)
  }

  bump(p: PlayerState, stat: string, n = 1): number {
    const stats = p.prog.stats
    const cur = stats[stat] ?? 0
    const next = clampTotal(cur + toDelta(n))
    if (next === cur) return cur
    return this.writeStat(p, stat, next) ? next : cur
  }

  setStat(p: PlayerState, stat: string, value: number): void {
    const next = clampTotal(toDelta(value))
    if ((p.prog.stats[stat] ?? 0) === next) return
    this.writeStat(p, stat, next)
  }

  feed(kind: FeedKind, playerId: number, text: string): void {
    this.broadcast({ t: 'feed', k: kind, id: playerId, text })
  }

  publish(p: PlayerState, fields: readonly PubField[]): void {
    // 이미 나간 사람의 정보는 아무도 모르는 id 이므로 방송하지 않는다
    if (this.players.get(p.id) !== p) return
    const msg: SPlayerUpdate = { t: 'pu', id: p.id }
    let hasField = false
    for (const f of fields) {
      hasField = true
      if (f === 'name') msg.name = p.name
      else if (f === 'look') msg.look = p.look
      else if (f === 'rank') msg.rank = p.prog.rank
      else if (f === 'fol') msg.fol = p.prog.fol
      else if (f === 'cult') msg.cult = p.prog.cult
      else if (f === 'tag') msg.tag = p.prog.tag ?? ''
    }
    if (hasField) this.broadcast(msg)
  }

  markSave(p: PlayerState): void {
    p.saveDirty = true
  }

  npcSay(lines: [number, string][]): void {
    for (const line of lines) {
      if (Array.isArray(line) && isInt(line[0]) && typeof line[1] === 'string' && line[1]) this.sayBuf.push([line[0], line[1]])
    }
    // 시스템이 직접 부른 말풍선은 연출 타이밍이 중요하므로 틱을 기다리지 않고 바로 내보낸다.
    // (그 앞에 쌓여 있던 혼잣말도 함께 나가서 순서가 뒤바뀌지 않는다.)
    this.flushSays()
  }

  cooldown(p: PlayerState, key: string, ms: number): number {
    const now = this.host.now()
    const left = (p.cd.get(key) ?? 0) - now
    if (left > 0) return left
    p.cd.set(key, now + ms)
    return 0
  }

  playerPublic(p: PlayerState): PlayerPublic {
    return {
      id: p.id,
      name: p.name,
      look: p.look,
      rank: p.prog.rank,
      fol: p.prog.fol,
      cult: p.prog.cult,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      st: p.st,
      emote: p.emote,
      tag: p.prog.tag ?? '',
    }
  }

  playerByPid(pid: string): PlayerState | undefined {
    return this.byPid.get(pid)
  }

  unlockAchievement(p: PlayerState, achId: string): boolean {
    const def = ACHIEVEMENT_BY_ID.get(achId)
    if (!def) {
      this.host.log('warn', `[방 ${this.id}] 없는 업적 id: ${String(achId)}`)
      return false
    }
    if (p.prog.ach.includes(def.id)) return false
    p.prog.ach.push(def.id)
    this.applyGrant(p, { why: 'ach', inf: def.inf }, [def.id])
    this.feed('ach', p.id, `${p.name}님이 업적 ‘${def.name}’ 달성!`)
    return true
  }

  // ═════════════════ 연결/세션 ═════════════════

  private takeToken(s: Session, now: number): boolean {
    const elapsed = now - s.tokensAt
    s.tokensAt = now
    if (elapsed > 0) s.tokens = Math.min(RATE_BURST, s.tokens + (elapsed * RATE_LIMIT_PER_SEC) / 1000)
    if (s.tokens < 1) return false
    s.tokens -= 1
    return true
  }

  /** 연결을 표에서 지운다. 이미 지워졌으면 false */
  private forget(s: Session): boolean {
    if (this.conns.get(s.conn) !== s) return false
    this.conns.delete(s.conn)
    if (!s.player) this.pendingCount = Math.max(0, this.pendingCount - 1)
    return true
  }

  /** 사유를 알려 주고 내보낸다(멱등). 입장한 사람이면 퇴장 처리까지 */
  private kickSession(s: Session, why: SKick['why'], code: number = CLOSE_KICK): void {
    if (!this.forget(s)) return
    const p = s.player
    // 내보내기 전에 아직 못 보낸 진행도를 건넨다(다시 들어올 때 이어서 쓸 수 있게)
    if (p && p.saveDirty) this.sendSave(s, p, this.host.now())
    this.host.send(s.conn, KICK_JSON[why])
    this.host.close(s.conn, code, why)
    if (p) this.removePlayer(p)
  }

  private removePlayer(p: PlayerState): void {
    if (this.players.get(p.id) !== p) return
    const talk = p.talk
    p.talk = null
    if (talk) {
      const npc = this.npcs.get(talk.npc)
      if (npc && npc.talker === p.id) this.safeNpc('endListen', () => this.npcs.endListen(npc))
    }
    const now = this.host.now()
    // 신도가 흩어지기 전에: 서 있던 자리와 따라오던 신도를 적어 둔다(곧 돌아오면 되찾는다)
    let seat: LastSeat | undefined
    try {
      const followers = this.npcs.followersOf(p.id).map((n) => ({ id: n.id, key: this.npcMemoKey(n), until: n.until, offered: n.offered }))
      if (followers.length > 0 || now - p.joinedAt >= REJOIN_MIN_SESSION_MS) seat = { room: this.id, x: p.x, z: p.z, yaw: p.yaw, at: now, followers }
    } catch (err) {
      this.host.log('error', `[방 ${this.id}] 자리 기억 중 예외`, err)
    }
    // 훅이 방 상태를 다시 계산할 때 '이미 나간 뒤'의 모습을 보도록 먼저 뺀다
    this.players.delete(p.id)
    if (this.byPid.get(p.pid) === p) this.byPid.delete(p.pid)
    if (this.lingering.get(p.pid)?.p === p) this.lingering.delete(p.pid)
    this.safeNpc('onPlayerLeave', () => this.npcs.onPlayerLeave(p.id))
    for (const sys of this.systems) {
      if (!sys.onLeave) continue
      try {
        sys.onLeave(p)
      } catch (err) {
        this.hookError(sys, 'onLeave', err)
      }
    }
    // 훅이 마지막으로 건드린 쿨타임까지 담기도록 메모는 훅 뒤에 남긴다
    this.stash(p, now, seat)
    // leave 는 맨 마지막: 훅이 보낸 소식(배틀 종료 등)이 아직 이름을 아는 상태에서 도착하게
    this.broadcast({ t: 'leave', id: p.id })
  }

  // ═════════════════ 접속자별 메모(재접속으로 지울 수 없는 것) ═════════════════

  /** 들어올 때: 예전 메모가 있으면 이어받고, 없으면 새로 만든다 */
  private recall(pid: string, now: number): PlayerMemory {
    let mem = this.memory.get(pid)
    if (mem && !mem.live && mem.keepUntil <= now) mem = undefined
    if (!mem) {
      if (this.memory.size >= MEMORY_MAX) this.sweepMemory(now, true)
      mem = { cd: new Map(), blocked: new Set(), mutedUntil: 0, nameLockUntil: 0, lockedName: '', live: true, keepUntil: 0 }
      this.memory.delete(pid)
      this.memory.set(pid, mem)
    }
    mem.live = true
    return mem
  }

  /** 나갈 때: 아직 유효한 것만 남기고, 기억할 것이 없으면 메모 자체를 지운다 */
  private stash(p: PlayerState, now: number, seat?: LastSeat): void {
    let mem = this.memory.get(p.pid)
    // 같은 pid 가 다른 방에서 이미 새로 들어왔다면(메모의 주인이 바뀌었다면) 건드리지 않는다
    if (mem && mem.cd !== p.cd) return
    if (!mem) {
      mem = { cd: p.cd, blocked: p.blocked, mutedUntil: 0, nameLockUntil: 0, lockedName: '', live: false, keepUntil: 0 }
      this.memory.set(p.pid, mem)
    }
    mem.live = false
    mem.mutedUntil = p.mutedUntil
    mem.nameLockUntil = p.nameLockUntil
    mem.lockedName = p.nameLockUntil > now ? p.name : ''
    mem.last = seat
    let keep = Math.max(p.mutedUntil, p.nameLockUntil, mem.blocked.size > 0 ? now + BLOCK_MEMORY_MS : 0, seat ? now + REJOIN_MEMORY_MS : 0)
    for (const [key, until] of mem.cd) {
      if (until <= now) mem.cd.delete(key)
      else if (until > keep) keep = until
    }
    if (keep <= now) this.memory.delete(p.pid)
    else mem.keepUntil = keep
  }

  /**
   * 시민이 "방금 거절했다 / 말 걸다 말았다"를 기억하게 한다. 시민 쪽 기억은 방 안 번호(재접속하면 바뀐다)로 적히므로,
   * 같은 내용을 접속자 메모(쿨타임 표)에도 남겨 재접속으로 지우고 같은 시민에게 다시 뽑기를 못 하게 한다.
   */
  private rememberNpc(p: PlayerState, npc: NpcState, until: number): void {
    this.npcs.remember(npc, p.id, until)
    p.cd.set(this.npcMemoKey(npc), until)
  }

  /** 방 · 자리 번호 · 그 자리에 지금 있는 시민(이름)까지 넣는다: 시민이 교체되면 새 시민에게는 적용되지 않는다 */
  private npcMemoKey(npc: NpcState): string {
    return `npc.${this.id}.${npc.id}.${hashString(npc.name)}`
  }

  /** 다시 들어온 사람의 새 번호로 시민들의 기억을 되살린다 */
  private restoreNpcMemo(p: PlayerState, now: number): void {
    const prefix = `npc.${this.id}.`
    for (const [key, until] of p.cd) {
      if (until <= now || !key.startsWith(prefix)) continue
      const npc = this.npcs.get(Number(key.slice(prefix.length).split('.')[0]))
      if (npc && this.npcMemoKey(npc) === key) this.safeNpc('remember', () => this.npcs.remember(npc, p.id, until))
    }
  }

  /** 기한이 지난 메모를 버린다. hard = 상한에 닿았을 때: 접속 중이 아닌 오래된 것부터 더 버린다 */
  private sweepMemory(now: number, hard = false): void {
    for (const [pid, mem] of this.memory) {
      if (!mem.live && mem.keepUntil <= now) this.memory.delete(pid)
    }
    if (!hard) return
    let over = this.memory.size - Math.floor(MEMORY_MAX * 0.9)
    if (over <= 0) return
    for (const [pid, mem] of this.memory) {
      if (mem.live) continue
      this.memory.delete(pid)
      if (--over <= 0) break
    }
  }

  private tickSessions(now: number): void {
    let expired: Session[] | null = null
    let idle: Session[] | null = null
    for (const s of this.conns.values()) {
      const p = s.player
      if (!p) {
        if (now - s.connectedAt > HELLO_TIMEOUT_MS) (expired ??= []).push(s)
        continue
      }
      if (now - s.lastMsgAt > IDLE_TIMEOUT_MS) {
        ;(idle ??= []).push(s)
        continue
      }
      const talk = p.talk
      if (talk) {
        if (now >= talk.until) {
          this.endTalk(p, 'timeout')
        } else {
          // 상대 NPC 가 교체됐거나 다른 일로 대화가 풀렸다면 세션만 남아 있지 않게 정리한다
          const npc = this.npcs.get(talk.npc)
          if (!npc || npc.talker !== p.id) {
            p.talk = null
            this.send(p, { t: 'talkEnd', n: talk.npc, why: 'gone' })
          }
        }
      }
      if (p.buffUntil !== 0 && now >= p.buffUntil) {
        p.buff = 0
        p.buffUntil = 0
      }
      // 얼어붙음은 스냅샷의 st 로도 보여야 다른 사람 화면에서 부들부들 떤다
      if (p.stunUntil > now) {
        if (p.st !== Anim.Stun) {
          p.st = Anim.Stun
          p.dirty = true
        }
      } else if (p.st === Anim.Stun) {
        p.st = Anim.Idle
        p.dirty = true
      }
      if (this.tickCount % CD_SWEEP_TICKS === 0) {
        for (const [key, until] of p.cd) if (until <= now) p.cd.delete(key)
      }
    }
    if (this.lingering.size > 0) {
      for (const [pid, l] of this.lingering) {
        if (now < l.until) continue
        this.lingering.delete(pid)
        this.removePlayer(l.p)
      }
    }
    if (this.tickCount % MEMORY_SWEEP_TICKS === 0) this.sweepMemory(now)
    if (expired) {
      for (const s of expired) {
        if (this.forget(s)) this.host.close(s.conn, CLOSE_BAD, 'hello timeout')
      }
    }
    if (idle) for (const s of idle) this.kickSession(s, 'idle')
  }

  // ═════════════════ 메시지 분배 ═════════════════

  private onJson(s: Session, msg: InMsg, now: number): void {
    const p = s.player
    if (!p) {
      // 입장 전에는 hello 만 받는다
      if (msg.t === 'hello') this.onHello(s, msg, now)
      return
    }
    p.lastMsgAt = now
    let ok = true
    switch (msg.t) {
      case 'hello':
        return // 이미 입장함
      case 'ping':
        if (typeof msg.c === 'number' && Number.isFinite(msg.c)) this.send(p, { t: 'pong', c: msg.c, s: now })
        else ok = false
        break
      case 'emote':
        ok = this.onEmote(s, p, msg.e, now)
        break
      case 'say':
        ok = this.onSayMsg(p, msg.q, now)
        break
      case 'profile':
        this.onProfile(s, p, msg)
        break
      case 'rooms':
        this.send(p, { t: 'rooms', rooms: this.host.listRooms() })
        break
      case 'talk':
        if (isInt(msg.n)) this.onTalk(p, msg.n, now)
        else ok = false
        break
      case 'pitch':
        if (isInt(msg.n) && isInt(msg.l)) this.onPitch(p, msg.n, msg.l, now)
        else ok = false
        break
      case 'talkEnd':
        this.endTalk(p, 'cancel')
        break
      default:
        break
    }
    if (!ok) {
      this.sendBad(p, msg)
      return
    }
    const targets = this.routes.get(msg.t)
    if (!targets) return
    if (!fieldsOk(msg)) {
      this.sendBad(p, msg)
      return
    }
    for (const sys of targets) {
      if (!sys.onMessage) continue
      // 앞선 처리에서 쫓겨났다면 더 넘기지 않는다
      if (this.players.get(p.id) !== p) return
      try {
        sys.onMessage(p, msg as unknown as ClientMsg)
      } catch (err) {
        this.hookError(sys, `onMessage(${msg.t})`, err)
      }
    }
  }

  /**
   * 아는 종류인데 필드 형태가 틀린 메시지: 처리하지 않되 보낸 쪽에는 알려 준다.
   * 조용히 버리기만 하면 클라이언트 쪽 실수(필드 누락 등)를 개발 중에 알아채기 어렵다.
   */
  private sendBad(p: PlayerState, msg: InMsg): void {
    this.send(p, { t: 'err', code: 'bad', msg: msg.t.slice(0, KEY_MAX) })
  }

  // ═════════════════ hello → welcome ═════════════════

  private onHello(s: Session, msg: InMsg, now: number): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.kickSession(s, 'ver')
      return
    }
    const pid = msg.pid
    if (typeof pid !== 'string' || !PID_RE.test(pid)) {
      this.kickSession(s, 'bad', CLOSE_BAD)
      return
    }
    // 같은 pid 가 이미 이 방에 있으면 자리를 '교체'하는 것이라 정원 검사에서 빼 준다.
    // (망이 바뀌어 재접속했는데 죽은 옛 연결 때문에 '가득 참'으로 튕기면 안 된다.)
    const old = this.byPid.get(pid)
    if (!old && this.players.size >= this.capacity) {
      this.sendTo(s.conn, { t: 'full', rooms: this.host.listRooms() })
      if (this.forget(s)) this.host.close(s.conn, CLOSE_FULL, 'full')
      return
    }
    this.host.claimPid(pid, this.id)
    if (old) {
      // 같은 사람이 다시 붙었다(망이 바뀌어 새 연결로 왔거나, 잠깐 끊겼다 돌아왔거나, 다른 탭을 열었거나).
      // 새로 입장시키지 않고 방에 있던 그 사람에게 새 연결을 이어 붙인다 → 번호·자리·배틀·신도·쿨타임이 그대로다.
      this.resume(s, old, now)
      return
    }

    const prog = this.restoreProgress(msg.save, pid, now)
    // 쿨타임·차단·입막음·이름 고정은 재접속해도 이어진다
    const mem = this.recall(pid, now)
    const nick = checkNickname(msg.name)
    // 신고로 이름이 바뀐 동안에는 hello 에 실어 보낸 옛 이름을 받아 주지 않는다
    const locked = mem.nameLockUntil > now && mem.lockedName !== ''
    const name = this.uniqueName(locked ? mem.lockedName : nick.ok ? nick.text : this.randomNickname(), 0)
    const look = sanitizeLook(msg.look, prog.rank, prog.ach)
    // 조금 전까지 이 방에 있었다면 서 있던 자리로 돌아온다(다른 앱에 다녀온 사이 자리 비움으로 나간 경우 등)
    const seat = mem.last && mem.last.room === this.id && now - mem.last.at < REJOIN_MEMORY_MS ? mem.last : undefined
    mem.last = undefined
    const spawn = (seat && this.seatSpot(seat, prog.rank)) || this.spawnPoint()
    const p: PlayerState = {
      id: this.allocId(),
      conn: s.conn,
      pid,
      name,
      look,
      prog,
      x: spawn.x,
      z: spawn.z,
      yaw: spawn.yaw,
      st: Anim.Idle,
      emote: null,
      dirty: true,
      joinedAt: now,
      lastMsgAt: now,
      lastMoveAt: now,
      talk: null,
      cd: mem.cd,
      buff: 0,
      buffUntil: 0,
      stunUntil: 0,
      sprintUntil: 0,
      blocked: mem.blocked,
      mutedUntil: mem.mutedUntil,
      nameLockUntil: mem.nameLockUntil,
      saveDirty: false,
      ext: {},
    }
    // 초대 링크(?by=닉네임)로 들어온 경우: 교단 시스템이 참고한다
    const ref = cleanText(msg.ref, NAME_MAX)
    if (ref) p.ext['ref'] = ref
    s.player = p
    this.pendingCount = Math.max(0, this.pendingCount - 1)
    s.budget = (RUN_SPEED * SPEED_TOLERANCE * MOVE_BURST_MS) / 1000
    s.budgetAt = now
    this.players.set(p.id, p)
    this.byPid.set(pid, p)
    this.restoreNpcMemo(p, now)

    if (!this.sendWelcome(s, p, now)) return

    for (const sys of this.systems) {
      if (!sys.onJoin) continue
      try {
        sys.onJoin(p)
      } catch (err) {
        this.hookError(sys, 'onJoin', err)
      }
    }
    if (this.players.get(p.id) !== p) return
    // onJoin 이 공개 정보를 바꿨더라도 최종 상태가 실리도록 join 은 훅 뒤에 만든다
    this.broadcast({ t: 'join', p: this.playerPublic(p) }, p)
    if (seat) this.restoreFollowers(p, seat, now)
  }

  /** 방에 남아 있던 사람에게 새 연결을 이어 붙인다(재접속·새 탭). 다른 사람들에게는 아무 일도 없었던 것처럼 보인다 */
  private resume(s: Session, p: PlayerState, now: number): void {
    const oldSession = this.conns.get(p.conn)
    if (oldSession && oldSession !== s && oldSession.player === p && this.forget(oldSession)) {
      // 옛 연결이 아직 살아 있다(다른 탭이거나, 서버가 아직 끊긴 줄 모르는 죽은 연결): 안내하고 닫는다. 사람은 남긴다
      if (p.saveDirty) this.sendSave(oldSession, p, now)
      this.host.send(oldSession.conn, KICK_JSON.dup)
      this.host.close(oldSession.conn, CLOSE_KICK, 'dup')
    }
    this.lingering.delete(p.pid)
    // 열려 있던 대화는 접는다(새 화면은 대화 창 없이 시작한다). 옛 연결로 나가는 안내는 버려진다
    this.endTalk(p, 'cancel')
    p.conn = s.conn
    s.player = p
    this.pendingCount = Math.max(0, this.pendingCount - 1)
    s.budget = (RUN_SPEED * SPEED_TOLERANCE * MOVE_BURST_MS) / 1000
    s.budgetAt = now
    p.lastMsgAt = now
    p.lastMoveAt = now
    p.dirty = true
    this.sendWelcome(s, p, now)
  }

  /** welcome 을 만들어 보낸다. 훅이 그 사람을 내보냈다면 false */
  private sendWelcome(s: Session, p: PlayerState, now: number): boolean {
    const others: PlayerPublic[] = []
    for (const o of this.players.values()) if (o !== p) others.push(this.playerPublic(o))
    const w: SWelcome = {
      t: 'welcome',
      id: p.id,
      room: this.info(),
      now,
      // 본인은 넣지 않는다(본인 정보는 아래 name/look/x/z/me 로 따로 간다)
      players: others,
      npcs: this.npcs.list.map((n) => this.npcs.publicOf(n)),
      me: p.prog,
      save: { d: '', s: '' },
      sermon: null,
      battles: [],
      name: p.name,
      look: p.look,
      x: p.x,
      z: p.z,
    }
    for (const sys of this.systems) {
      if (!sys.onWelcome) continue
      try {
        sys.onWelcome(p, w)
      } catch (err) {
        this.hookError(sys, 'onWelcome', err)
      }
    }
    if (this.players.get(p.id) !== p) return false
    // 훅이 진행도를 손봤을 수 있으므로(일일 수행 초기화 등) 서명은 훅이 끝난 뒤에 한다
    w.save = this.signedSave(p, now)
    this.host.send(s.conn, JSON.stringify(w))
    p.saveDirty = false
    s.saveAt = now
    return true
  }

  /** 기억해 둔 자리가 지금도 설 수 있는 곳이면 그 자리, 아니면 null(평소 시작 위치를 쓴다) */
  private seatSpot(seat: LastSeat, rank: number): { x: number; z: number; yaw: number } | null {
    const { x, z, yaw } = seat
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return null
    const pos = { x, z }
    resolveCollision(pos, PLAYER_RADIUS, rank >= this.world.hq.minRank, this.world)
    // 충돌 보정으로 멀리 밀려났다면(그 사이 지형 규칙이 달라진 경우 등) 믿지 않는다
    if (Math.hypot(pos.x - x, pos.z - z) > 1.5) return null
    return { x: round2(pos.x), z: round2(pos.z), yaw }
  }

  /** 나가기 전에 따라오던 신도 가운데 아직 그 자리에 있고 임자가 없는 시민을 다시 따라오게 한다(남은 시간·헌납 여부는 그대로) */
  private restoreFollowers(p: PlayerState, seat: LastSeat, now: number): void {
    let room = MAX_ENTOURAGE - this.npcs.followersOf(p.id).length
    for (const f of seat.followers) {
      if (room <= 0) break
      if (f.until <= now + 1000) continue
      const npc = this.npcs.get(f.id)
      if (!npc || npc.owner !== 0 || npc.talker !== 0 || this.npcMemoKey(npc) !== f.key) continue
      if (npc.mode !== 'wander' && npc.mode !== 'pause') continue
      this.safeNpc('startFollow', () => {
        this.npcs.startFollow(npc, p.id, f.until, now)
        npc.offered = f.offered
      })
      room--
    }
  }

  private restoreProgress(save: unknown, pid: string, now: number): Progress {
    if (save && typeof save === 'object') {
      const { d, s } = save as { d?: unknown; s?: unknown }
      if (typeof d === 'string' && typeof s === 'string' && this.host.signer.verify(d, s)) {
        try {
          const prog = normalizeProgress(JSON.parse(d) as unknown, pid, now)
          if (prog) return prog
        } catch {
          /* 서명은 맞는데 JSON 이 아닌 경우는 사실상 없지만, 있더라도 새로 시작하면 된다 */
        }
      }
    }
    return newProgress(pid, now)
  }

  private randomNickname(): string {
    for (let i = 0; i < 20; i++) {
      const name = (pick(NICK_ADJ, this.rnd) ?? '') + (pick(NICK_NOUN, this.rnd) ?? '')
      const check = checkNickname(name)
      if (check.ok && check.text === name) return name
    }
    return '수상한행인'
  }

  /** 방 안에서 겹치지 않는 이름. 겹치면 뒤에 숫자를 붙인다(길이 제한 안에서) */
  private uniqueName(base: string, selfId: number): string {
    const taken = (name: string): boolean => {
      const key = name.toLowerCase()
      for (const o of this.players.values()) if (o.id !== selfId && o.name.toLowerCase() === key) return true
      return false
    }
    if (!taken(base)) return base
    const chars = Array.from(base)
    for (let n = 2; n < 1000; n++) {
      const suffix = String(n)
      const cand = chars.slice(0, NAME_MAX - suffix.length).join('') + suffix
      if (!taken(cand)) return cand
    }
    return base
  }

  private spawnPoint(): { x: number; z: number; yaw: number } {
    const spots = this.world.spawns
    const base = spots.length > 0 ? pick(spots, this.rnd) : { x: 0, z: 0, yaw: 0 }
    // 여러 명이 같은 자리에 겹쳐 서지 않게 조금 흩뿌린다
    const pos = { x: base.x + (this.rnd() - 0.5) * 2.4, z: base.z + (this.rnd() - 0.5) * 2.4 }
    resolveCollision(pos, PLAYER_RADIUS, false, this.world)
    return { x: round2(pos.x), z: round2(pos.z), yaw: base.yaw }
  }

  private allocId(): number {
    // 1..65535 를 돌려 쓴다. 방 정원이 훨씬 작으므로 반드시 빈 번호가 나온다
    for (let i = 0; i < 0xffff; i++) {
      const id = this.nextId
      this.nextId = id >= 0xffff ? 1 : id + 1
      if (!this.players.has(id)) return id
    }
    throw new Error('플레이어 id 가 모자랍니다')
  }

  // ═════════════════ 이동 ═════════════════

  /** 지난 시간만큼 이동 허용량을 채운다. 스프린트 구간은 더 빠른 속도로 계산한다 */
  private refillBudget(s: Session, p: PlayerState, now: number): void {
    const dt = now - s.budgetAt
    s.budgetAt = now
    const sprinting = now < p.sprintUntil
    if (dt > 0) {
      const sprintMs = Math.max(0, Math.min(dt, p.sprintUntil - (now - dt)))
      s.budget += ((sprintMs * SPRINT_SPEED + (dt - sprintMs) * RUN_SPEED) * SPEED_TOLERANCE) / 1000
    }
    const cap = ((sprinting ? SPRINT_SPEED : RUN_SPEED) * SPEED_TOLERANCE * MOVE_BURST_MS) / 1000
    if (s.budget > cap) s.budget = cap
  }

  private sendPos(s: Session, p: PlayerState, now: number): void {
    if (now - s.posAt < POS_RESEND_MS && s.posX === p.x && s.posZ === p.z) return
    s.posAt = now
    s.posX = p.x
    s.posZ = p.z
    this.send(p, { t: 'pos', x: p.x, z: p.z })
  }

  private onMove(s: Session, p: PlayerState, data: ArrayBuffer | Uint8Array, now: number): void {
    const m = decodeMove(data)
    if (!m) return
    if (p.stunUntil > now) {
      // 얼어붙은 동안은 받지 않는다. 가만히 있는 정상 클라이언트에게는 조용히, 어긋났을 때만 되돌린다
      if (Math.abs(m.x - p.x) > MOVED_EPS || Math.abs(m.z - p.z) > MOVED_EPS) this.sendPos(s, p, now)
      return
    }
    /*
     * 속도 검증은 '패킷 사이 시간 × 속도'가 아니라 시간에 따라 차오르는 허용량으로 한다.
     * 패킷은 망에서 뭉쳐 오기 때문에(앞 패킷이 늦고 뒤 패킷이 바로 붙어 옴) 패킷 간격만 보면
     * 정상적으로 달리는 사람도 수시로 걸린다. 허용량 방식은 평균 속도를 정확히 제한하면서 뭉침에는 관대하다.
     * 허용량은 -MOVE_SLACK_M 까지만 내려가므로 오차 여유가 패킷마다 공짜로 쌓이지도 않는다.
     */
    this.refillBudget(s, p, now)
    const dist = Math.hypot(m.x - p.x, m.z - p.z)
    if (dist > s.budget + MOVE_SLACK_M) {
      this.sendPos(s, p, now)
      return
    }
    s.budget -= dist

    const pos = this.tmpPos
    pos.x = m.x
    pos.z = m.z
    resolveCollision(pos, COLLIDE_RADIUS, p.prog.rank >= this.world.hq.minRank, this.world)
    const corrected = Math.abs(pos.x - m.x) > 0.011 || Math.abs(pos.z - m.z) > 0.011
    if (corrected) {
      pos.x = round2(pos.x)
      pos.z = round2(pos.z)
    } else {
      pos.x = m.x
      pos.z = m.z
    }

    // 클라이언트가 주장할 수 있는 상태는 서기/걷기/달리기/스프린트뿐이다(얼어붙음·환호 등은 서버가 정한다)
    let st = m.st
    if (st === Anim.Sprint) {
      if (now >= p.sprintUntil) st = Anim.Run
    } else if (st !== Anim.Idle && st !== Anim.Walk && st !== Anim.Run) {
      st = Anim.Idle
    }

    if (p.x !== pos.x || p.z !== pos.z || p.yaw !== m.yaw || p.st !== st) {
      p.x = pos.x
      p.z = pos.z
      p.yaw = m.yaw
      p.st = st
      p.dirty = true
    }
    p.lastMoveAt = now
    if (corrected) this.sendPos(s, p, now)

    if (dist > MOVED_EPS) {
      if (p.emote !== null) {
        p.emote = null
        this.broadcast({ t: 'emote', id: p.id, e: '' }, p)
      }
      const talk = p.talk
      if (talk) {
        const npc = this.npcs.get(talk.npc)
        if (npc && Math.hypot(npc.x - p.x, npc.z - p.z) > TALK_LEASH_M) this.endTalk(p, 'cancel')
      }
    }
  }

  // ═════════════════ 이모트 / 말풍선 / 프로필 ═════════════════

  private cdLeft(p: PlayerState, key: string, now: number): number {
    return (p.cd.get(key) ?? 0) - now
  }

  /** 형식이 틀렸으면 false(시스템으로도 넘기지 않는다) */
  private onEmote(s: Session, p: PlayerState, e: unknown, now: number): boolean {
    if (typeof e !== 'string' || e.length > KEY_MAX) return false
    if (e === '') {
      if (p.emote !== null) {
        p.emote = null
        this.broadcast({ t: 'emote', id: p.id, e: '' }, p)
      }
      return true
    }
    const def = EMOTE_BY_ID.get(e)
    // 없는 이모트/직급 미달/얼어붙은 동안: 조용히 무시(정상 UI 에서는 보낼 수 없는 요청)
    if (!def || p.prog.rank < def.rank || p.stunUntil > now) return true
    if (def.id === 'flee') {
      // 도망가기는 일반 이모트 쿨타임과 따로 센다. 손 흔든 직후라고 도망을 못 가면 안 된다
      if (this.cdLeft(p, 'sprint', now) > SPRINT_GRACE_MS) return true
      // 스프린트 전까지의 구간은 달리기 속도로 정산해 둔다
      this.refillBudget(s, p, now)
      p.cd.set('sprint', now + SPRINT_COOLDOWN_MS)
      p.sprintUntil = now + SPRINT_MS + SPRINT_GRACE_MS
    } else {
      if (this.cdLeft(p, 'emote', now) > COOLDOWN_GRACE_MS) return true
      p.cd.set('emote', now + EMOTE_COOLDOWN_MS)
    }
    // 반복 이모트만 기억한다 → 나중에 들어온 사람의 welcome 에도 실린다
    p.emote = def.loop ? def.id : null
    // 본인은 이미 재생 중이므로 다른 사람에게만
    this.broadcast({ t: 'emote', id: p.id, e: def.id }, p)
    this.bump(p, STAT.emotes)
    if (def.id === 'dance') this.bump(p, STAT.dances)
    if (def.id === 'flee') this.bump(p, STAT.sprints)
    return true
  }

  private onSayMsg(p: PlayerState, q: unknown, now: number): boolean {
    if (!isInt(q)) return false
    const def = q >= 0 ? QUICK_CHATS[q] : undefined
    if (!def || p.prog.rank < def.rank) return true
    // 신고 누적으로 입막음된 동안에는 말풍선을 방송하지 않는다
    if (p.mutedUntil > now) return true
    if (this.cdLeft(p, 'say', now) > COOLDOWN_GRACE_MS) return true
    p.cd.set('say', now + SAY_COOLDOWN_MS)
    // 본인에게도 보낸다: 클라이언트가 자기 말풍선을 서버 확인 뒤에 띄우는 구현이어도 동작하게
    this.broadcast({ t: 'say', id: p.id, q })
    this.bump(p, STAT.says)
    return true
  }

  private onProfile(s: Session, p: PlayerState, msg: InMsg): void {
    if (msg.name !== undefined) {
      const now = this.host.now()
      const check = checkNickname(msg.name)
      if (!check.ok) {
        this.send(p, { t: 'err', code: 'name', msg: '사용할 수 없는 이름이에요.' })
      } else if (check.text === p.name) {
        /* 그대로다 — 할 일 없음 */
      } else if (p.nameLockUntil > now) {
        // 신고로 바뀐 이름은 한동안 되돌릴 수 없다(바로 되돌리면 신고가 무의미해진다)
        this.send(p, { t: 'err', code: 'name', msg: '신고로 바뀐 이름은 잠시 동안 바꿀 수 없어요.' })
      } else if (this.cdLeft(p, 'name', now) > 0) {
        this.send(p, { t: 'err', code: 'name', msg: '이름은 잠시 뒤에 다시 바꿀 수 있어요.' })
      } else {
        const name = this.uniqueName(check.text, p.id)
        if (name !== p.name) {
          p.name = name
          s.pubMask |= PUB_NAME
          p.cd.set('name', now + NAME_CHANGE_COOLDOWN_MS)
        }
      }
    }
    if (msg.look !== undefined) {
      const look = sanitizeLook(msg.look, p.prog.rank, p.prog.ach)
      if (!sameLook(look, p.look)) {
        p.look = look
        s.pubMask |= PUB_LOOK
      }
    }
    if (msg.tag !== undefined) {
      // 칭호는 '내가 달성한 업적' 중에서만 고를 수 있다. 빈 문자열이면 칭호를 뗀다
      const tag = typeof msg.tag === 'string' && msg.tag.length <= KEY_MAX ? msg.tag : ''
      const next = tag && p.prog.ach.includes(tag) ? tag : undefined
      if (next !== p.prog.tag) {
        if (next) p.prog.tag = next
        else delete p.prog.tag
        this.markSave(p)
        s.pubMask |= PUB_TAG
      }
    }
    // 방송은 다음 틱에 모아서 한다. 꾸미기 화면에서 연달아 눌러도 마지막 상태가 반드시 전달되고,
    // 방 전체로 나가는 메시지는 초당 10개를 넘지 않는다.
    s.pubAck = true
  }

  private flushProfiles(): void {
    for (const s of this.conns.values()) {
      const p = s.player
      if (!p || (!s.pubAck && s.pubMask === 0)) continue
      const mask = s.pubMask
      s.pubMask = 0
      s.pubAck = false
      if (mask !== 0) {
        const fields: PubField[] = []
        if (mask & PUB_NAME) fields.push('name')
        if (mask & PUB_LOOK) fields.push('look')
        if (mask & PUB_TAG) fields.push('tag')
        this.publish(p, fields)
      } else {
        // 바뀐 게 없어도 요청한 본인에게는 서버가 확정한 값을 돌려준다(필터에 걸려 그대로인 경우 등)
        this.send(p, { t: 'pu', id: p.id, name: p.name, look: p.look })
      }
    }
  }

  // ═════════════════ 대화 / 포교 ═════════════════

  private endTalk(p: PlayerState, why: STalkEnd['why']): void {
    const talk = p.talk
    if (!talk) return
    p.talk = null
    const npc = this.npcs.get(talk.npc)
    if (npc && npc.talker === p.id) {
      this.safeNpc('endListen', () => this.npcs.endListen(npc))
      if (why === 'cancel' || why === 'timeout') {
        const until = this.host.now() + TALK_ABANDON_MEMORY_MS
        // 이미 더 오래 기억하고 있다면(방금 거절한 경우) 줄이지 않는다
        if ((npc.memo.get(p.id) ?? 0) < until) this.safeNpc('remember', () => this.rememberNpc(p, npc, until))
      }
    }
    this.send(p, { t: 'talkEnd', n: talk.npc, why })
  }

  private onTalk(p: PlayerState, n: number, now: number): void {
    // 지금 대화 중인 바로 그 NPC 에게 또 온 요청(버튼 두 번 누름)은 무시한다. 끊고 다시 열면 열려 있던 창만 닫힌다
    if (p.talk && p.talk.npc === n && this.npcs.get(n)?.talker === p.id) return
    // 다른 NPC 와 대화 중이었다면 그 세션을 먼저 끝낸다(NPC 를 붙잡아 둔 채로 새 대화를 열지 않게)
    this.endTalk(p, 'cancel')
    if (p.stunUntil > now) {
      this.send(p, { t: 'talkNo', n, why: 'cool', ms: Math.ceil(p.stunUntil - now) })
      return
    }
    const cool = this.cdLeft(p, 'pitch', now)
    if (cool > COOLDOWN_GRACE_MS) {
      this.send(p, { t: 'talkNo', n, why: 'cool', ms: Math.ceil(cool) })
      return
    }
    const npc = this.npcs.get(n)
    if (!npc || npc.role === 'patrol') {
      this.send(p, { t: 'talkNo', n, why: 'gone' })
      return
    }
    if (Math.hypot(npc.x - p.x, npc.z - p.z) > TALK_RANGE + 1.0) {
      this.send(p, { t: 'talkNo', n, why: 'far' })
      return
    }
    const can = this.npcs.canTalk(npc, p.id, now)
    if (can !== 'ok') {
      if (can === 'memo') {
        const ms = Math.max(0, Math.ceil((npc.memo.get(p.id) ?? 0) - now))
        this.send(p, { t: 'talkNo', n, why: 'memo', ms })
      } else {
        this.send(p, { t: 'talkNo', n, why: can })
      }
      return
    }
    if (npc.owner === p.id) {
      this.send(p, { t: 'talkNo', n, why: 'mine' })
      return
    }
    const lines = pickLines(p.prog.rank, this.rnd)
    if (lines.length === 0) {
      this.send(p, { t: 'talkNo', n, why: 'gone' })
      return
    }
    const until = now + TALK_TIMEOUT_MS
    this.npcs.beginListen(npc, p, until + LISTEN_GRACE_MS)
    p.talk = { npc: n, round: 1, lines, used: [], until }
    const greet = npc.arch.greet.length > 0 ? pick(npc.arch.greet, this.rnd) : '…'
    this.send(p, { t: 'talkOk', n, greet, lines, round: 1 })
    this.bump(p, STAT.talks)
    const met = p.prog.met
    if (!met.includes(npc.arch.id) && met.length < 200) {
      met.push(npc.arch.id)
      this.markSave(p)
    }
  }

  private onPitch(p: PlayerState, n: number, l: number, now: number): void {
    const talk = p.talk
    // 제시하지 않은 멘트(해금 전 멘트 등)를 보내는 것을 막는다
    if (!talk || talk.npc !== n || !talk.lines.includes(l)) {
      this.send(p, { t: 'err', code: 'pitch' })
      return
    }
    const npc = this.npcs.get(n)
    const line = PITCH_LINES[l]
    if (!npc || !line || npc.talker !== p.id) {
      this.endTalk(p, 'gone')
      return
    }
    const stats = p.prog.stats
    const streak = stats[STAT.streak] ?? 0
    const failStreak = stats[STAT.failStreak] ?? 0
    const poach = npc.owner !== 0 && npc.owner !== p.id
    const result = resolvePitch(
      npc.arch,
      line,
      { rank: p.prog.rank, streak, failStreak, round: talk.round, buff: p.buffUntil > now ? p.buff : 0, poach },
      this.rnd,
    )
    // 판정 결과(누가 무슨 멘트를 했고 NPC 가 뭐라 했는지)는 가로채기 여부와 무관하게 방 전체가 본다
    this.broadcast({ t: 'pitchRes', p: p.id, n, l, o: result.outcome, say: result.say })

    let intercepted = false
    for (const sys of this.systems) {
      if (!sys.interceptPitch) continue
      try {
        if (sys.interceptPitch(p, npc, line, result)) {
          intercepted = true
          break
        }
      } catch (err) {
        this.hookError(sys, 'interceptPitch', err)
      }
    }
    // 가로챈 시스템이 있으면 합류/거절 처리와 세션 정리는 그 시스템 몫이다
    if (!intercepted) this.applyOutcome(p, npc, talk, l, result, streak, failStreak, poach, now)

    this.bump(p, STAT.pitches)
    if (npc.arch.special === 'animal') this.bump(p, STAT.catTalks)
    p.cd.set('pitch', now + PITCH_COOLDOWN_MS)
    this.afterPitch(p, npc, line, result.outcome)
  }

  private afterPitch(p: PlayerState, npc: NpcState, line: PitchLine, outcome: PitchOutcome): void {
    for (const sys of this.systems) {
      if (!sys.onPitch) continue
      try {
        sys.onPitch(p, npc, line, outcome)
      } catch (err) {
        this.hookError(sys, 'onPitch', err)
      }
    }
  }

  private applyOutcome(
    p: PlayerState,
    npc: NpcState,
    talk: NonNullable<PlayerState['talk']>,
    lineId: number,
    result: PitchResult,
    streak: number,
    failStreak: number,
    poach: boolean,
    now: number,
  ): void {
    const outcome = result.outcome
    const n = npc.id

    if (outcome === 'more') {
      talk.used.push(lineId)
      talk.round += 1
      let lines = pickLines(p.prog.rank, this.rnd, LINES_PER_TALK, talk.used)
      // 쓸 멘트가 바닥났다면(멘트가 아주 적은 경우) 썼던 것도 다시 내놓는다
      if (lines.length === 0) lines = pickLines(p.prog.rank, this.rnd)
      talk.lines = lines
      talk.until = now + TALK_TIMEOUT_MS
      this.npcs.beginListen(npc, p, talk.until + LISTEN_GRACE_MS)
      this.grant(p, { why: 'more', inf: INF_MORE })
      this.send(p, { t: 'talkOk', n, greet: result.say, lines, round: talk.round })
      return
    }

    // 여기부터는 대화가 끝나는 결과
    p.talk = null

    if (outcome === 'join' || outcome === 'king') {
      // 정원이 찼으면 가장 오래 따라다닌 신도부터 보내 준다
      const mine = this.npcs.followersOf(p.id).filter((f) => f !== npc)
      mine.sort((a, b) => a.followSince - b.followSince)
      while (mine.length >= MAX_ENTOURAGE) {
        const oldest = mine.shift()
        if (oldest) this.npcs.release(oldest, 'expire')
      }
      this.npcs.startFollow(npc, p.id, now + FOLLOW_DURATION_MS, now)
      // 시뮬이 대화 상대를 비우지 않았더라도 다음 사람이 'busy' 에 막히지 않게 한다
      if (npc.talker === p.id) npc.talker = 0

      const newStreak = streak + 1
      this.grant(p, {
        why: 'join',
        inf: INF_JOIN + Math.min(streak * INF_STREAK_BONUS, INF_STREAK_MAX),
        fol: 1,
        streak: newStreak,
      })
      this.bump(p, STAT.joins)
      this.setStat(p, STAT.streak, newStreak)
      if (newStreak > (p.prog.stats[STAT.bestStreak] ?? 0)) this.setStat(p, STAT.bestStreak, newStreak)
      this.setStat(p, STAT.failStreak, 0)
      if (outcome === 'king') this.bump(p, STAT.kings)
      if (poach) this.bump(p, STAT.poaches)
      if (npc.arch.special === 'animal') this.bump(p, STAT.catJoins)
    } else {
      // no / ignore / flee / (가로채는 시스템이 없는) rival → 거절
      this.rememberNpc(p, npc, now + NPC_REJECT_MEMORY_MS)
      if (npc.owner !== 0) {
        // 남의 신도를 빼앗으려다 실패: 그 신도는 원래 주인에게 돌아간다(도망/배회로 보내면 주인이 신도를 잃는다)
        this.npcs.endListen(npc)
      } else if (outcome === 'flee') {
        this.npcs.endListen(npc)
        this.npcs.flee(npc, p.x, p.z, now)
      } else if (outcome === 'ignore') {
        this.npcs.endListen(npc)
      } else {
        this.npcs.walkOff(npc)
        if (npc.talker === p.id) this.npcs.endListen(npc)
      }
      if (npc.talker === p.id) npc.talker = 0

      this.grant(p, { why: 'fail', inf: INF_FAIL })
      this.bump(p, STAT.rejects)
      if (outcome === 'ignore') this.bump(p, STAT.ignores)
      if (outcome === 'flee') this.bump(p, STAT.flees)
      this.setStat(p, STAT.streak, 0)
      const newFail = failStreak + 1
      this.setStat(p, STAT.failStreak, newFail)
      if (newFail > (p.prog.stats[STAT.worstStreak] ?? 0)) this.setStat(p, STAT.worstStreak, newFail)
    }
    // 결과 연출(pitchRes)과 별개로 '세션이 끝났다'는 신호를 확실히 준다 → 클라이언트가 이동 잠금을 풀 수 있다
    this.send(p, { t: 'talkEnd', n, why: 'done' })
  }

  // ═════════════════ 보상 / 통계 / 저장 ═════════════════

  private applyGrant(p: PlayerState, g: Grant, ach: string[] | undefined): void {
    const prog = p.prog
    const inf = toDelta(g.inf)
    const fol = toDelta(g.fol)
    const coins = toDelta(g.coins)
    if (inf) prog.inf = clampTotal(prog.inf + inf)
    if (fol) prog.fol = clampTotal(prog.fol + fol)
    if (coins) prog.coins = clampTotal(prog.coins + coins)
    const items: string[] = []
    if (Array.isArray(g.items)) {
      for (const id of g.items) {
        if (typeof id !== 'string' || id.length === 0 || id.length > KEY_MAX) {
          // 긴 id 는 저장본을 다시 읽을 때 버려진다 → 줬다가 사라지는 물건이 되지 않게 아예 받지 않고 알린다
          this.host.log('warn', `[방 ${this.id}] 받을 수 없는 헌납품 id(1~${KEY_MAX}자 문자열이어야 함): ${String(id).slice(0, 40)}`)
          continue
        }
        prog.items[id] = Math.min(1e6, (prog.items[id] ?? 0) + 1)
        items.push(id)
      }
    }

    const reward: SReward = { t: 'reward', why: g.why }
    if (inf) reward.inf = inf
    if (fol) reward.fol = fol
    if (coins) reward.coins = coins
    if (typeof g.streak === 'number') reward.streak = g.streak
    if (ach && ach.length > 0) reward.ach = ach
    if (items.length > 0) reward.items = items

    const fields: PubField[] = []
    // 직급은 내려가지 않는다(영향력이 깎이는 일이 생겨도 이미 연 복장·동작이 다시 잠기면 안 된다)
    const rank = Math.max(prog.rank, rankForInfluence(prog.inf))
    const rankUp = rank > prog.rank
    if (rankUp) {
      prog.rank = rank
      reward.rankUp = rank
      fields.push('rank')
    }
    if (fol) fields.push('fol')

    const cult = prog.cult
    if (cult && (inf > 0 || fol > 0)) {
      const add = { fol: Math.max(0, fol), inf: Math.max(0, inf) }
      const leader = cult.role === 'leader'
      if (leader) {
        prog.cultFol = clampTotal(prog.cultFol + add.fol)
        prog.cultInf = clampTotal(prog.cultInf + add.inf)
      }
      const registry = this.host.cults
      if (registry) {
        try {
          // 교단원의 CultRef.title 은 '신도' 같은 표시용 문구라서 교주 칭호를 덮어쓰지 않게 기존 기록을 유지한다
          const title = leader ? cult.title : (registry.get(cult.id)?.title ?? '')
          registry.record(
            { id: cult.id, name: cult.name, color: cult.color, emblem: cult.emblem, leaderName: cult.leaderName, title },
            add,
          )
        } catch (err) {
          this.host.log('error', `[방 ${this.id}] 교단 기록 갱신 실패`, err)
        }
      }
    }

    this.send(p, reward)
    if (rankUp) {
      const def = RANKS[rank]
      if (def) this.feed('rank', p.id, `${p.name}님이 ${withRo(def.name)} 승급!`)
    }
    if (fields.length > 0) this.publish(p, fields)
    this.markSave(p)
  }

  /** 값을 기록하고 onStat 훅을 부른다. 받을 수 없는 키면 false */
  private writeStat(p: PlayerState, stat: string, value: number): boolean {
    if (typeof stat !== 'string' || stat.length === 0) return false
    if (stat.length > KEY_MAX) {
      // 긴 키는 저장본을 다시 읽을 때 버려지므로 조용히 사라지는 통계가 된다 → 만든 쪽이 알 수 있게 남긴다
      this.host.log('warn', `[방 ${this.id}] 통계 키가 너무 깁니다(${KEY_MAX}자 초과): ${stat}`)
      return false
    }
    p.prog.stats[stat] = value
    this.markSave(p)
    if (this.statDepth >= MAX_STAT_DEPTH) {
      this.host.log('error', `[방 ${this.id}] onStat 훅이 너무 깊게 물렸습니다: ${stat}`)
      return true
    }
    this.statDepth++
    try {
      for (const sys of this.systems) {
        if (!sys.onStat) continue
        try {
          sys.onStat(p, stat, value)
        } catch (err) {
          this.hookError(sys, 'onStat', err)
        }
      }
    } finally {
      this.statDepth--
    }
    return true
  }

  private signedSave(p: PlayerState, now: number): SignedSave {
    p.prog.ts = now
    const d = JSON.stringify(p.prog)
    return { d, s: this.host.signer.sign(d) }
  }

  private sendSave(s: Session, p: PlayerState, now: number): void {
    p.saveDirty = false
    s.saveAt = now
    this.send(p, { t: 'save', me: p.prog, save: this.signedSave(p, now) })
  }

  private sendSaves(now: number): void {
    for (const s of this.conns.values()) {
      const p = s.player
      if (p && p.saveDirty && now - s.saveAt >= SAVE_INTERVAL_MS) this.sendSave(s, p, now)
    }
  }

  // ═════════════════ 스냅샷 / NPC 알림 ═════════════════

  private sendSnapshot(now: number): void {
    const ps = this.snapPlayers
    const ns = this.snapNpcs
    ps.length = 0
    ns.length = 0
    for (const p of this.players.values()) {
      if (p.dirty) {
        p.dirty = false
        ps.push(p)
      }
    }
    const list = this.npcs.list
    for (let i = 0; i < list.length; i++) {
      const n = list[i]
      if (n && n.dirty) {
        n.dirty = false
        ns.push(n)
      }
    }
    // 아무도 없으면 보낼 곳이 없다(새로 들어오는 사람은 welcome 으로 전체 상태를 받는다)
    if (this.players.size === 0) return
    // 변한 게 없어도 1초에 한 번은 보낸다: 클라이언트가 "그 시각까지 그대로였다"를 알아야 보간 시계가 흐른다
    if (ps.length === 0 && ns.length === 0 && now - this.lastSnapAt < EMPTY_SNAPSHOT_MS) return
    this.lastSnapAt = now
    const bytes = encodeSnapshot(now, ps, ns)
    for (const p of this.players.values()) this.host.send(p.conn, bytes)
  }

  private flushSays(): void {
    if (this.sayBuf.length === 0) return
    const l = this.sayBuf
    this.sayBuf = []
    this.broadcast({ t: 'npcSay', l })
  }

  private onNpcSpawn(npc: NpcState): void {
    // 방 생성 중(시뮬이 아직 this.npcs 에 들어오기 전)이거나 아무도 없을 때는 알릴 대상이 없다
    if (this.players.size === 0) return
    // 떠나는 NPC 의 마지막 말이 새로 온 시민 머리 위에 뜨지 않게, 쌓인 말풍선을 먼저 내보낸다
    this.flushSays()
    this.broadcast({ t: 'npcSpawn', n: this.npcs.publicOf(npc) })
  }

  private onNpcOwnerChange(npc: NpcState): void {
    if (this.players.size === 0) return
    this.broadcast({ t: 'nu', n: npc.id, owner: npc.owner })
  }

  private onNpcSay(npc: NpcState, text: string): void {
    if (this.players.size === 0 || typeof text !== 'string' || text.length === 0) return
    if (this.sayBuf.length < MAX_SAY_BATCH) this.sayBuf.push([npc.id, text])
  }

  // ═════════════════ 도우미 ═════════════════

  private sendTo(conn: ConnId, msg: ServerMsg): void {
    this.host.send(conn, JSON.stringify(msg))
  }

  private hookError(sys: RoomSystem, hook: string, err: unknown): void {
    this.host.log('error', `[방 ${this.id}] 시스템 ${sys.name}.${hook} 예외`, err)
  }

  private safeNpc(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.host.log('error', `[방 ${this.id}] NPC 시뮬 ${what} 예외`, err)
    }
  }
}
