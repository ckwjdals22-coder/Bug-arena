/**
 * NPC 시뮬레이션 — 방 하나의 시민 NPC 전원을 서버 틱(10Hz)마다 움직인다.
 *
 * 설계 요점(왜 이렇게 했는가)
 *  - 전송 무관: Node API·타이머·Date.now·Math.random 을 쓰지 않는다. 시간은 tick(now, dt), 난수는 rnd 로만 받는다.
 *  - 어떤 WorldDef 에서도 동작: 좌표를 하드코딩하지 않고 world.nav / world.subway / world.bounds 와 resolveCollision 만 쓴다.
 *  - 틱당 할당 없음: 경로(findNavPath)는 목적지를 정할 때만 계산하고, 틱 안에서는 숫자 필드와 재사용 배열만 만진다.
 *  - 스냅샷 절약: 전송 양자화(1cm, 1/256 바퀴) 기준으로 값이 실제로 달라졌을 때만 dirty 를 세운다 → 서 있는 NPC 는 트래픽 0.
 *  - 보기 좋은 움직임: 등속 보행, 사람마다 다른 차선(우측통행), 모퉁이 돌기, 제한된 회전 속도, 마주 오는 사람 비켜 가기.
 */
import { Anim, NPC_FLEE_SPEED, NPC_FOLLOW_SPEED, NPC_RADIUS, NPC_WALK_SPEED } from '../../shared/constants'
import { ARCHETYPES } from '../../shared/content/archetypes'
import { SKIN_COLORS } from '../../shared/content/core'
import type { Archetype } from '../../shared/content/types'
import { quantPos, quantYaw } from '../../shared/protocol'
import { type Rnd, pick, pickWeighted } from '../../shared/rng'
import type { Look, NpcPublic } from '../../shared/types'
import { type NavKind, type WorldDef, findNavPath, navNodesOfKind, nearestNavNode, resolveCollision } from '../../shared/world'
import type { NpcSimApi, NpcSimEvents, NpcState, OwnerChangeReason, PlayerState } from './api'

const TAU = Math.PI * 2

// 틱마다 수천 번 읽는 값은 모듈 지역 상수/함수로 받아 둔다. 번들러·테스트 러너에 따라 import 한 이름이
// 게터를 거치는 속성 조회가 되고 enum 도 객체 조회라서, 그대로 쓰면 뜨거운 경로가 눈에 띄게 느려진다.
const IDLE: number = Anim.Idle
const WALK: number = Anim.Walk
const RUN: number = Anim.Run
const SPRINT: number = Anim.Sprint
const LISTEN: number = Anim.Listen
const CHEER: number = Anim.Cheer
const VANISH: number = Anim.Vanish
const RADIUS = NPC_RADIUS
const WALK_V = NPC_WALK_SPEED
const FLEE_V = NPC_FLEE_SPEED
const FOLLOW_V = NPC_FOLLOW_SPEED
const qPos = quantPos
const qYaw = quantYaw
const resolve = resolveCollision

// ───────── 조정값 ─────────
/** 스냅샷 NPC id 가 u8 이라 255 가 상한. 시민은 250 까지만 쓰고 나머지는 특수 NPC 몫으로 남긴다 */
const MAX_ID = 255
const MAX_CITIZENS = 250
/** 틱 간격이 벌어져도(빈 방은 1Hz) 한 번에 너무 멀리 뛰지 않게 */
const MAX_DT = 1.5
/**
 * 새 목적지를 출구로 고를 확률 — 시민이 눈에 띄게 물갈이되도록.
 * 갓 등장한 시민의 첫 목적지는 출구로 잡지 않으므로(곧바로 되돌아 나가면 어색하다) 전체 목적지 중 출구 비율은 약 15%가 된다.
 */
const EXIT_CHANCE = 0.17
const TRIPS_BEFORE_EXIT = 1
const VANISH_S = 1.0
const ENTER_S = 0.9

/** 중간 경유점은 이 거리 안에 들면 다음 지점으로 넘어간다 → 모퉁이를 둥글게 돈다 */
const CORNER_R = 0.45
const ARRIVE_EPS = 0.03
/** 한 번의 충돌 검사로 움직이는 최대 거리. NPC 반지름보다 작아야 얇은 벽도 뚫지 못한다 */
const CHUNK = 0.4
const TURN_WALK = 7
const TURN_RUN = 12
const TURN_STAND = 9
/** 걷기 시작할 때 갈 방향과 이만큼(rad) 넘게 어긋나 있으면 제자리에서 먼저 돌고, PIVOT_DONE 안으로 들어오면 출발한다 */
const PIVOT_FROM = 1.0
const PIVOT_DONE = 0.5

/** 차선(진행 방향 기준 오른쪽이 +) 최대 폭 */
const MAX_LANE = 1.0
const LANE_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1.0]
/** 서 있을 자리·노드 위치를 잡을 때 벽에서 띄우는 여유 */
const SPOT_MARGIN = 0.05
const SPOT_SPACING = 0.9
/** 간선에서 이만큼 안쪽이면 '그 간선 위를 걷는 중'으로 본다 */
const EDGE_NEAR = 2.5

/** 벽에 막혔다고 보는 기준(의도한 걸음 대비 실제 진척 비율)과, 다시 뚫렸다고 보는 기준 */
const BLOCKED = 0.3
const UNBLOCKED = 0.6
/** 벽을 끼고 도는 최대 거리. 넘으면 반대 방향으로 돌아 본다 */
const DETOUR_LEN = 10
const SIDE_LOCK_S = 1.5
/** 이만큼(초) 목표에 조금도 가까워지지 못하면 길을 다시 잡는다(작은 장애물을 돌아갈 시간은 준다) */
const STUCK_S = 7

/** 마주친 캐릭터를 비켜 가기 시작하는 거리와 세기 */
const AVOID_R = 2.0
const AVOID_W = 0.9
/** 진행선에서 옆으로 이만큼 넘게 떨어진 상대는 부딪힐 일이 없으므로 무시한다 */
const AVOID_LAT = 0.9
/** 옆 간격이 AVOID_LAT 에 가까워질 때 비켜 가는 세기를 서서히 줄이는 폭 */
const AVOID_SOFT = 0.35

const HURRY_MUL = 1.35
const HURRY_S = 3.5
/** 구경하러 모일 때의 잰걸음 */
const BRISK_SPEED = 2.6

// 신도(콩가 라인)
const SLOT_FIRST = 1.1
const SLOT_GAP = 0.95
const CRUMB = 0.35
/** 발자취 칸 수: 0.35m 간격으로 40m(포기 거리)를 넘게 덮는다 */
const TRAIL_CAP = 128
/** 주인이 한 틱에 이보다 멀리 움직였으면 순간이동(위치 보정)으로 보고 발자취를 새로 시작한다 */
const TRAIL_TELEPORT = 6
const FOLLOW_GAIN = 4
const FOLLOW_START = 0.5
const FOLLOW_MIN_SPEED = 1.6
const FOLLOW_GIVE_UP = 40
/** 달리기 표시로 바꾸는/되돌리는 속도 — 주인의 걷기(3.4)·달리기(5.6) 사이에 둔다 */
const RUN_ON = 4.4
const RUN_OFF = 3.9
/** 이보다 뒤처지면 자리로 곧장 가지 않고 주인의 발자취를 따라 달린다(건물을 가로지르지 않게) */
const PURSUE_FROM = 2.0
/** 이보다 뒤처지면 '한참 뒤처진' 것으로 보고 시야 확인·이동망 우회를 쓴다 */
const FAR_GAP = 6
const LOOKAHEAD = 0.8
/** 발자취에 '올라탈 수 있다'고 보는 거리 */
const TRAIL_REACH = 1.0
/** 신도는 주인에게 이보다 가까이 서지 않는다(주인을 가로막지 않게) */
const OWNER_CLEAR = 1.0
const HOLD_NEAR = 0.6
/** 주인이 이만큼 서 있으면 뒤쪽에 부채꼴로 모인다 */
const FAN_DELAY = 1.5
const FAN_SPEED = 2.2
const FAN_RADIUS = 1.5
const FAN_ROW = 0.95

const FLEE_MIN_MS = 2500
const FLEE_VAR_MS = 1500
/** 도망 경로가 일찍 끝났을 때 이만큼 멀어졌으면 그만 뛴다 */
const FLEE_SAFE = 10
/** 직접 도주(길 없이 곧장)를 택하려면 위협 반대쪽으로 이만큼은 트여 있어야 한다 */
const FLEE_OPEN = 12

const GATHER_RANGE = 34
const GATHER_RINGS = 4
const GATHER_RING_FIRST = 2.3
const GATHER_RING_GAP = 1.15
const GATHER_SEAT_GAP = 1.3

const MUTTER_MIN_S = 25
const MUTTER_VAR_S = 35
/** 방 전체 혼잣말 간격(초): 2~3초에 한 번을 넘지 않게 */
const MUTTER_ROOM_MIN_S = 2
const MUTTER_ROOM_VAR_S = 1

const KIND_WEIGHT: Record<NavKind, number> = { walk: 1, plaza: 1.4, cross: 0.2, shop: 1.6, rest: 1.2, exit: 0 }

// ───────── 작은 도우미 ─────────

/** 2차원 길이. Math.hypot 은 인자 검사·넘침 방지 때문에 뜨거운 경로에서 몇 배 느리다 */
function hyp(x: number, z: number): number {
  return Math.sqrt(x * x + z * z)
}

/** 재사용 좌표(충돌 질의용). 틱 안에서 객체를 새로 만들지 않기 위해 둔다 */
const P = { x: 0, z: 0 }

/** cur 에서 want 로 최대 max 라디안만큼 돈 각(−π..π) */
function stepAngle(cur: number, want: number, max: number): number {
  let d = want - cur
  d -= Math.round(d / TAU) * TAU
  if (d > max) d = max
  else if (d < -max) d = -max
  let r = cur + d
  if (r > Math.PI) r -= TAU
  else if (r <= -Math.PI) r += TAU
  return r
}

function angleGap(a: number, b: number): number {
  let d = a - b
  d -= Math.round(d / TAU) * TAU
  return d < 0 ? -d : d
}

/** 두 점 사이를 반지름 r 의 원이 막힘 없이 지나갈 수 있는가(촘촘히 찍어서 확인) */
function lineFree(world: WorldDef, x0: number, z0: number, x1: number, z1: number, r: number): boolean {
  const len = hyp(x1 - x0, z1 - z0)
  const steps = Math.max(1, Math.ceil(len / 0.4))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const sx = x0 + (x1 - x0) * t
    const sz = z0 + (z1 - z0) * t
    P.x = sx
    P.z = sz
    resolve(P, r, true, world)
    if (Math.abs(P.x - sx) > 1e-3 || Math.abs(P.z - sz) > 1e-3) return false
  }
  return true
}

// ───────── 월드 전처리(월드 객체당 한 번, 모든 방이 공유) ─────────

interface NavInfo {
  n: number
  /** 충돌체 밖으로 보정한 노드 좌표 */
  nx: Float64Array
  nz: Float64Array
  kind: NavKind[]
  exits: number[]
  /** 출구가 아닌 노드(평소 목적지 후보) */
  inner: number[]
  /** a*n+b → a 에서 b 로 걸을 때 오른쪽으로 비켜 걸어도 되는 폭(m). 왼쪽 폭은 b*n+a 를 본다 */
  clear: Map<number, number>
  ea: number[]
  eb: number[]
  elen: number[]
  etotal: number
  /** 새 시민이 올라오는 곳(지하철 출입구) */
  entryX: number
  entryZ: number
  entryYaw: number
  entryNode: number
  /** 충돌 격자(1m 칸): 0 인 칸은 어떤 충돌체·경계에도 닿지 않으므로 충돌 검사를 건너뛴다 */
  gx0: number
  gz0: number
  gw: number
  gh: number
  grid: Uint8Array | null
}

const navCache = new WeakMap<WorldDef, NavInfo>()

/** a→b 로 걷는 선을 오른쪽으로 얼마나 비켜도 막히지 않는가 */
function sideClearance(world: WorldDef, ax: number, az: number, bx: number, bz: number): number {
  const len = hyp(bx - ax, bz - az)
  if (len < 1e-6) return 0
  const rx = -(bz - az) / len
  const rz = (bx - ax) / len
  let ok = 0
  for (const lane of LANE_STEPS) {
    if (!lineFree(world, ax + rx * lane, az + rz * lane, bx + rx * lane, bz + rz * lane, RADIUS + SPOT_MARGIN)) break
    ok = lane
  }
  return ok
}

function buildNavInfo(world: WorldDef): NavInfo {
  const nodes = world.nav.nodes
  const n = nodes.length
  const nx = new Float64Array(n)
  const nz = new Float64Array(n)
  const kind: NavKind[] = []
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]!
    P.x = nd.x
    P.z = nd.z
    // 노드가 충돌체 안/경계 밖에 찍혀 있어도 NPC 가 닿을 수 있는 자리로 보정해 둔다
    resolve(P, RADIUS + SPOT_MARGIN, true, world)
    nx[i] = P.x
    nz[i] = P.z
    kind.push(nd.kind)
  }
  const exits = navNodesOfKind(['exit'], world)
  const inner: number[] = []
  for (let i = 0; i < n; i++) if (kind[i] !== 'exit') inner.push(i)

  const clear = new Map<number, number>()
  const ea: number[] = []
  const eb: number[] = []
  const elen: number[] = []
  let etotal = 0
  for (const [a, b] of world.nav.edges) {
    if (a === b || a < 0 || b < 0 || a >= n || b >= n) continue
    clear.set(a * n + b, sideClearance(world, nx[a]!, nz[a]!, nx[b]!, nz[b]!))
    clear.set(b * n + a, sideClearance(world, nx[b]!, nz[b]!, nx[a]!, nz[a]!))
    const len = hyp(nx[b]! - nx[a]!, nz[b]! - nz[a]!)
    ea.push(a)
    eb.push(b)
    elen.push(len)
    etotal += len
  }

  // 등장 지점: 지하철 출입구. 월드 담당이 입구 앞에 exit 노드를 두었으면 그 노드를 쓴다
  const sub = world.subway
  P.x = sub.x
  P.z = sub.z
  resolve(P, RADIUS + SPOT_MARGIN, true, world)
  let entryX = P.x
  let entryZ = P.z
  let entryNode = -1
  let bestExit = -1
  let bestD = Infinity
  for (const e of exits) {
    const d = hyp(nx[e]! - sub.x, nz[e]! - sub.z)
    if (d < bestD) {
      bestD = d
      bestExit = e
    }
  }
  if (bestExit >= 0 && bestD <= sub.r + 3) {
    entryNode = bestExit
    entryX = nx[bestExit]!
    entryZ = nz[bestExit]!
  } else if (n > 0 && hyp(entryX - sub.x, entryZ - sub.z) > sub.r + 1) {
    // 출입구 POI 가 충돌체 깊숙이 있다 → 가장 가까운 이동망 노드에서 등장
    entryNode = nearestNavNode(sub.x, sub.z, world)
    entryX = nx[entryNode]!
    entryZ = nz[entryNode]!
  }

  // 충돌 격자
  const b = world.bounds
  const gx0 = Math.floor(b.x0)
  const gz0 = Math.floor(b.z0)
  const gw = Math.ceil(b.x1) - gx0
  const gh = Math.ceil(b.z1) - gz0
  let grid: Uint8Array | null = null
  if (gw > 0 && gh > 0 && gw * gh <= 1_000_000) {
    const g = new Uint8Array(gw * gh)
    const mark = (x0: number, z0: number, x1: number, z1: number): void => {
      const c0 = Math.max(0, Math.floor(x0 - gx0))
      const c1 = Math.min(gw - 1, Math.floor(x1 - gx0))
      const r0 = Math.max(0, Math.floor(z0 - gz0))
      const r1 = Math.min(gh - 1, Math.floor(z1 - gz0))
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r * gw + c] = 1
    }
    const e = RADIUS + 0.05
    for (const bx of world.boxes) mark(bx.x0 - e, bx.z0 - e, bx.x1 + e, bx.z1 + e)
    for (const c of world.circles) mark(c.x - c.r - e, c.z - c.r - e, c.x + c.r + e, c.z + c.r + e)
    mark(gx0, gz0, b.x0 + e, gz0 + gh)
    mark(b.x1 - e, gz0, gx0 + gw, gz0 + gh)
    mark(gx0, gz0, gx0 + gw, b.z0 + e)
    mark(gx0, b.z1 - e, gx0 + gw, gz0 + gh)
    grid = g
  }

  return {
    n,
    nx,
    nz,
    kind,
    exits,
    inner,
    clear,
    ea,
    eb,
    elen,
    etotal,
    entryX,
    entryZ,
    entryYaw: sub.yaw,
    entryNode,
    gx0,
    gz0,
    gw,
    gh,
    grid,
  }
}

function navInfoOf(world: WorldDef): NavInfo {
  let info = navCache.get(world)
  if (!info) {
    info = buildNavInfo(world)
    navCache.set(world, info)
  }
  return info
}

// ───────── 내부 상태 ─────────

/** NpcState(계약) + 시뮬 내부 필드. 바깥에는 NpcState 로만 보인다 */
interface Sim extends NpcState {
  /** 경유점(차선 적용 완료). 배열은 재사용하고 wn 이 유효 길이, wi 가 다음에 갈 지점 */
  wx: number[]
  wz: number[]
  wn: number
  wi: number
  /** 지금 향하는 목적지 노드(-1 = 노드가 아닌 지점) */
  dest: number
  /** 마지막으로 도착한 노드(-1 = 이동망을 벗어나 있음) */
  curNode: number
  /** 이번 목적지에 닿으면 퇴장한다 */
  leaving: boolean
  /** 다음 목적지는 반드시 출구(정신 차린 신도) */
  exitNext: boolean
  /** retire() 로 퇴장 지시를 받았다 */
  retiring: boolean
  lane: number
  /** 남은 대기 시간(초): pause, enter, 사라지는 중, 환호 전환 */
  wait: number
  sayIn: number
  lookIn: number
  hurry: number
  trips: number
  /** leave: 0 걸어가는 중 / 1 사라지는 중 · gather: 0 걸어가는 중 / 1 구경 중 */
  phase: number
  /** 신도: 자리로 걷는 중인가(가까울 때 떨지 않게 하는 이력) */
  moving: boolean
  running: boolean
  followUntil: number
  /** 한참 뒤처진 신도의 접근 방식: 0 발자취 추적 / 1 자리가 보여 질러감 / 2 이동망 우회 */
  far: number
  farIn: number
  farPlan: number
  faceYaw: number
  turning: boolean
  /** 걷기 전에 제자리에서 돌아서는 중 */
  pivot: boolean
  // 막힘 처리
  detour: number
  side: number
  sideLock: number
  tanX: number
  tanZ: number
  bestD: number
  noProg: number
  fails: number
  // 구경
  gslot: boolean
  gx: number
  gz: number
  // 도망
  fx: number
  fz: number
  /** 직접 도주 중 위협에서 가장 멀어졌던 거리(더 못 멀어지면 멈추려고) */
  fleeBest: number
  /** 특수 NPC(addScripted)인가 */
  scripted: boolean
  // 마지막으로 dirty 를 세웠을 때의 전송 양자화 값
  qx: number
  qz: number
  qyaw: number
  qst: number
}

/** 주인 한 명의 신도 줄 + 주인이 걸어온 발자취 */
interface Group {
  /** 합류 순서 = 줄 순서 */
  list: Sim[]
  cx: Float64Array
  cz: Float64Array
  head: number
  count: number
  /** 주인의 진행 방향(단위 벡터) */
  hx: number
  hz: number
  /** 주인이 서 있은 시간(초) */
  idle: number
  stamp: number
}

export function createNpcSim(world: WorldDef, rnd: Rnd, events: NpcSimEvents, count: number): NpcSimApi {
  const nav = navInfoOf(world)
  const list: Sim[] = []
  const byId: (Sim | undefined)[] = new Array<Sim | undefined>(MAX_ID + 1).fill(undefined)
  const groups = new Map<number, Group>()

  let lastNow = 0
  let tickNo = 0
  let mutterCd = 0
  let curPlayers: ReadonlyMap<number, PlayerState> = new Map<number, PlayerState>()
  /** 이번 틱의 플레이어 목록(비켜 가기용). Map 반복자를 NPC 마다 만들지 않으려고 배열에 옮겨 둔다 */
  const plist: PlayerState[] = []
  let pn = 0
  const collectPlayer = (p: PlayerState): void => {
    plist[pn++] = p
  }

  // 구경(설교) 상태 — 한 번에 하나
  let gatherOn = false
  let gatherUntil = 0
  let gcx = 0
  let gcz = 0

  // 여러 값을 돌려주는 내부 함수들의 결과 칸(할당 없이 주고받기 위함)
  let outX = 0
  let outZ = 0
  let outS = 0
  let outA = -1
  let outB = -1

  // ───────── 생성 ─────────

  function poolPick(pool: readonly number[]): number {
    return pool.length > 0 ? pick(pool, rnd) : 0
  }

  function makeLook(arch: Archetype): Look {
    return [
      Math.floor(rnd() * SKIN_COLORS.length) % SKIN_COLORS.length,
      poolPick(arch.look.outfits),
      poolPick(arch.look.colors),
      poolPick(arch.look.hats),
      poolPick(arch.look.faces),
      poolPick(arch.look.accs),
      0,
    ]
  }

  function rollLane(): number {
    // 대체로 우측통행(+), 가끔 왼쪽으로 걷는 사람도 섞는다
    return -0.45 + rnd() * (MAX_LANE + 0.45)
  }

  function blank(id: number, arch: Archetype, name: string, look: Look, role: string): Sim {
    return {
      id,
      arch,
      name,
      look,
      model: arch.model ?? 0,
      role,
      x: 0,
      z: 0,
      yaw: 0,
      st: IDLE,
      mode: 'pause',
      owner: 0,
      talker: 0,
      until: 0,
      followSince: 0,
      offered: false,
      memo: new Map<number, number>(),
      dirty: true,
      wx: [],
      wz: [],
      wn: 0,
      wi: 0,
      dest: -1,
      curNode: -1,
      leaving: false,
      exitNext: false,
      retiring: false,
      lane: 0,
      wait: 0,
      sayIn: 0,
      lookIn: Infinity,
      hurry: 0,
      trips: 0,
      phase: 0,
      moving: false,
      running: false,
      followUntil: 0,
      far: 0,
      farIn: 0,
      farPlan: 0,
      faceYaw: 0,
      turning: false,
      pivot: false,
      detour: 0,
      side: id % 2 === 0 ? 1 : -1,
      sideLock: 0,
      tanX: 0,
      tanZ: 0,
      bestD: Infinity,
      noProg: 0,
      fails: 0,
      gslot: false,
      gx: 0,
      gz: 0,
      fx: 0,
      fz: 0,
      fleeBest: 0,
      scripted: false,
      qx: 0,
      qz: 0,
      qyaw: 0,
      qst: IDLE,
    }
  }

  /** 유형·이름·외형을 새로 뽑는다(처음 만들 때와 교체할 때 공용) */
  function rollIdentity(n: Sim): void {
    const arch = pickWeighted(ARCHETYPES, (a) => a.weight, rnd)
    n.arch = arch
    n.name = arch.names.length > 0 ? pick(arch.names, rnd) : arch.name
    n.look = makeLook(arch)
    n.model = arch.model ?? 0
    n.role = arch.special === 'rival' ? 'rival' : ''
    n.lane = rollLane()
    n.sayIn = 4 + rnd() * (MUTTER_MIN_S + MUTTER_VAR_S)
  }

  function remember(n: Sim): void {
    n.qx = qPos(n.x)
    n.qz = qPos(n.z)
    n.qyaw = qYaw(n.yaw)
    n.qst = n.st
  }

  /** 전송되는 값이 실제로 달라졌을 때만 dirty */
  function flush(n: Sim): void {
    const qx = qPos(n.x)
    const qz = qPos(n.z)
    const qyaw = qYaw(n.yaw)
    if (qx !== n.qx || qz !== n.qz || qyaw !== n.qyaw || n.st !== n.qst) {
      n.qx = qx
      n.qz = qz
      n.qyaw = qyaw
      n.qst = n.st
      n.dirty = true
    }
  }

  /** 처음 배치: 이동망 간선 위 임의 지점(길이 가중) */
  function placeInitial(n: Sim): void {
    if (nav.n === 0) {
      const b = world.bounds
      n.x = (b.x0 + b.x1) / 2
      n.z = (b.z0 + b.z1) / 2
    } else if (nav.etotal > 0) {
      let r = rnd() * nav.etotal
      let e = 0
      for (; e < nav.elen.length - 1; e++) {
        r -= nav.elen[e]!
        if (r <= 0) break
      }
      const a = nav.ea[e]!
      const b = nav.eb[e]!
      const t = rnd()
      const len = nav.elen[e]! || 1
      const ux = (nav.nx[b]! - nav.nx[a]!) / len
      const uz = (nav.nz[b]! - nav.nz[a]!) / len
      const right = nav.clear.get(a * nav.n + b) ?? 0
      const left = nav.clear.get(b * nav.n + a) ?? 0
      const off = -left + rnd() * (left + right)
      n.x = nav.nx[a]! + (nav.nx[b]! - nav.nx[a]!) * t - uz * off
      n.z = nav.nz[a]! + (nav.nz[b]! - nav.nz[a]!) * t + ux * off
      n.yaw = Math.atan2(ux, uz) + (rnd() < 0.5 ? 0 : Math.PI)
    } else {
      const i = Math.floor(rnd() * nav.n) % nav.n
      n.x = nav.nx[i]! + (rnd() - 0.5) * 2
      n.z = nav.nz[i]! + (rnd() - 0.5) * 2
      n.yaw = rnd() * TAU
    }
    resolve(n, RADIUS + SPOT_MARGIN, true, world)
    n.yaw = stepAngle(n.yaw, n.yaw, 0)
    n.mode = 'pause'
    n.st = IDLE
    // 다 같이 동시에 출발하지 않게 흩뜨린다
    n.wait = rnd() * 2.5
    n.curNode = -1
  }

  // 유형 목록이 비어 있으면(콘텐츠 누락) 시민을 만들 수 없다
  const citizens = ARCHETYPES.length === 0 ? 0 : Math.max(0, Math.min(Math.floor(count) || 0, MAX_CITIZENS))
  for (let i = 0; i < citizens; i++) {
    const n = blank(i + 1, ARCHETYPES[0]!, '', [0, 0, 0, 0, 0, 0, 0], '')
    rollIdentity(n)
    placeInitial(n)
    remember(n)
    list.push(n)
    byId[n.id] = n
  }

  // ───────── 충돌 / 걷기 ─────────

  /** 충돌체 밖·경계 안으로 보정한다(제자리 수정). NPC 자신이나 재사용 좌표 P 를 넘긴다 */
  function collide(pos: { x: number; z: number }): void {
    const g = nav.grid
    if (g) {
      const cx = Math.floor(pos.x - nav.gx0)
      const cz = Math.floor(pos.z - nav.gz0)
      // 주변에 충돌체도 경계도 없는 칸이면 검사할 것이 없다
      if (cx >= 0 && cz >= 0 && cx < nav.gw && cz < nav.gh && g[cz * nav.gw + cx] === 0) return
    }
    resolve(pos, RADIUS, true, world)
  }

  /** 두 점 사이를 NPC 가 막힘 없이 곧장 걸을 수 있는가. 충돌 격자로 빈 칸은 건너뛰므로 먼 거리도 싸다 */
  function clearLine(x0: number, z0: number, x1: number, z1: number): boolean {
    const g = nav.grid
    if (!g) return lineFree(world, x0, z0, x1, z1, RADIUS)
    const len = hyp(x1 - x0, z1 - z0)
    const steps = Math.max(1, Math.ceil(len / 0.4))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const sx = x0 + (x1 - x0) * t
      const sz = z0 + (z1 - z0) * t
      const cx = Math.floor(sx - nav.gx0)
      const cz = Math.floor(sz - nav.gz0)
      if (cx >= 0 && cz >= 0 && cx < nav.gw && cz < nav.gh && g[cz * nav.gw + cx] === 0) continue
      P.x = sx
      P.z = sz
      resolve(P, RADIUS, true, world)
      if (Math.abs(P.x - sx) > 1e-3 || Math.abs(P.z - sz) > 1e-3) return false
    }
    return true
  }

  function face(n: Sim, dx: number, dz: number, turn: number): void {
    n.yaw = stepAngle(n.yaw, Math.atan2(dx, dz), turn)
  }

  function turnStep(n: Sim, dt: number): void {
    n.yaw = stepAngle(n.yaw, n.faceYaw, TURN_STAND * dt)
    if (angleGap(n.yaw, n.faceYaw) < 1e-3) n.turning = false
  }

  function lookAt(n: Sim, x: number, z: number, minGap: number): void {
    const dx = x - n.x
    const dz = z - n.z
    if (dx * dx + dz * dz < 0.01) return
    const want = Math.atan2(dx, dz)
    if (angleGap(want, n.turning ? n.faceYaw : n.yaw) > minGap) {
      n.faceYaw = want
      n.turning = true
    }
  }

  function clearDetour(n: Sim): void {
    n.detour = 0
    n.sideLock = 0
    n.bestD = Infinity
    n.noProg = 0
  }

  /**
   * 앞쪽 가까이에 있는 캐릭터를 비켜 가도록 진행 방향을 옆으로 튼다(결과 outX/outZ, 단위 벡터).
   * 속력은 그대로 두고 방향만 바꾸므로 등속 보행이 유지된다. 정면이면 서로 오른쪽으로 비킨다(우측통행).
   */
  function steer(n: Sim, ux: number, uz: number, w: number): void {
    // 가장 '부딪힐 것 같은' 상대를 고른다: 가까울수록, 진행선에 가까울수록 크다.
    // 거리·옆 간격 모두 부드럽게 줄어드는 가중치라서, 경계에서 켜졌다 꺼졌다 하며 좌우로 떨지 않는다
    let best = 0
    let lat = 0
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!
      if (m === n || m.st === VANISH) continue
      const rx = m.x - n.x
      const rz = m.z - n.z
      const d2 = rx * rx + rz * rz
      if (d2 >= AVOID_R * AVOID_R || rx * ux + rz * uz <= 0) continue
      // 오른쪽 벡터 = (−uz, ux) → side > 0 이면 상대가 내 오른쪽
      const side = ux * rz - uz * rx
      const off = side < 0 ? -side : side
      if (off >= AVOID_LAT) continue
      const near = (AVOID_LAT - off) / AVOID_SOFT
      const wgt = (1 - Math.sqrt(d2) / AVOID_R) * (near < 1 ? near : 1)
      if (wgt > best) {
        best = wgt
        lat = side
      }
    }
    for (let i = 0; i < pn; i++) {
      const p = plist[i]!
      const rx = p.x - n.x
      const rz = p.z - n.z
      const d2 = rx * rx + rz * rz
      if (d2 >= AVOID_R * AVOID_R || rx * ux + rz * uz <= 0) continue
      const side = ux * rz - uz * rx
      const off = side < 0 ? -side : side
      if (off >= AVOID_LAT) continue
      const near = (AVOID_LAT - off) / AVOID_SOFT
      const wgt = (1 - Math.sqrt(d2) / AVOID_R) * (near < 1 ? near : 1)
      if (wgt > best) {
        best = wgt
        lat = side
      }
    }
    if (best <= 0) {
      outX = ux
      outZ = uz
      return
    }
    // 상대가 오른쪽에 있으면 왼쪽으로, 정면이거나 왼쪽이면 오른쪽으로 튼다
    const k = w * best * (lat > 0.05 ? -1 : 1)
    const vx = ux - uz * k
    const vz = uz + ux * k
    const vl = Math.sqrt(vx * vx + vz * vz)
    outX = vx / vl
    outZ = vz / vl
  }

  /**
   * 한 걸음(≤ CHUNK). (tx,tz) 쪽으로 step 만큼 나아가되, 벽에 막히면 벽을 끼고 돈다.
   * 단순히 미끄러지기만 하면 넓은 벽 앞에서 제자리걸음을 하므로, 한번 막히면 같은 방향으로 벽을 따라가다
   * 직진이 다시 뚫릴 때 빠져나온다. d0 = 목표까지 거리(> 0), turn = 이번 걸음에 돌 수 있는 최대 각.
   */
  function advance(n: Sim, tx: number, tz: number, d0: number, step: number, turn: number, avoidW: number): void {
    const ox = n.x
    const oz = n.z
    const ux = (tx - ox) / d0
    const uz = (tz - oz) / d0
    let dx = ux
    let dz = uz
    if (avoidW > 0 && n.detour <= 0) {
      steer(n, ux, uz, avoidW)
      dx = outX
      dz = outZ
    }
    let ax = ox + dx * step
    let az = oz + dz * step
    n.x = ax
    n.z = az
    collide(n)
    const pushed = n.x !== ax || n.z !== az
    const prog = d0 - hyp(tx - n.x, tz - n.z)
    if (n.detour <= 0) {
      if (!pushed || prog >= step * BLOCKED) {
        face(n, dx, dz, turn)
        return
      }
      // 막혔다 → 밀려난 방향(법선)에 수직인 접선으로 우회 시작
      const nx = n.x - ax
      const nz = n.z - az
      const nl = hyp(nx, nz) || 1
      if (n.sideLock <= 0) {
        // 새 장애물: 목표 쪽에 가까운 접선을 고른다. 정면으로 막혔으면 개인 취향대로
        const dot = (-nz * ux + nx * uz) / nl
        if (dot > 0.08) n.side = 1
        else if (dot < -0.08) n.side = -1
      }
      n.detour = DETOUR_LEN
      n.tanX = (-nz / nl) * n.side
      n.tanZ = (nx / nl) * n.side
    } else {
      if (!pushed || prog >= step * UNBLOCKED) {
        n.detour = 0
        n.sideLock = SIDE_LOCK_S
        face(n, ux, uz, turn)
        return
      }
      // 벽에 닿아 있는 동안은 접선을 계속 갱신한다(같은 회전 방향 유지 → 모서리를 돌아 나간다)
      const nx = n.x - ax
      const nz = n.z - az
      const nl = hyp(nx, nz) || 1
      n.tanX = (-nz / nl) * n.side
      n.tanZ = (nx / nl) * n.side
    }
    ax = ox + n.tanX * step
    az = oz + n.tanZ * step
    n.x = ax
    n.z = az
    collide(n)
    const mx = n.x - ox
    const mz = n.z - oz
    if (mx * mx + mz * mz < step * step * 0.09) {
      // 오목한 구석: 반대 방향으로 돌아 본다
      n.side = -n.side
      n.tanX = -n.tanX
      n.tanZ = -n.tanZ
    }
    n.detour -= step
    if (n.detour <= 0) n.side = -n.side
    n.sideLock = SIDE_LOCK_S
    face(n, n.tanX, n.tanZ, turn)
  }

  /**
   * (tx,tz) 로 budget(m)만큼 걷는다. stopAt 안에 들어오면 멈추고 남은 budget(≥ 0)을, 못 닿으면 −1 을 돌려준다.
   * avoid: 0 비켜 가지 않음 / 1 비켜 감 / 2 비켜 가되 목표 근처에서는 줄임(자리에 못 서고 맴도는 일 방지)
   */
  function walkTo(n: Sim, tx: number, tz: number, budget: number, stopAt: number, turnPerM: number, avoid: number): number {
    for (let guard = 0; guard < 64; guard++) {
      const dx = tx - n.x
      const dz = tz - n.z
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d <= stopAt) return budget
      if (budget <= 1e-6) return -1
      let step = d - stopAt + 1e-3
      if (step > d) step = d
      if (step > budget) step = budget
      if (step > CHUNK) step = CHUNK
      budget -= step
      const w = avoid === 0 ? 0 : avoid === 2 && d < 1.5 ? (AVOID_W * d) / 1.5 : AVOID_W
      advance(n, tx, tz, d, step, turnPerM * step, w)
    }
    return -1
  }

  /** 경유점을 따라 speed 로 dt 만큼 걷는다. 마지막 지점에 닿으면 true */
  function followRoute(n: Sim, speed: number, dt: number, avoid: boolean): boolean {
    let budget = speed * dt
    const turnPerM = (speed > 3.5 ? TURN_RUN : TURN_WALK) / speed
    while (n.wi < n.wn) {
      const last = n.wi === n.wn - 1
      const tx = n.wx[n.wi]!
      const tz = n.wz[n.wi]!
      const left = walkTo(n, tx, tz, budget, last ? ARRIVE_EPS : CORNER_R, turnPerM, avoid ? (last ? 2 : 1) : 0)
      if (left < 0) {
        const d = hyp(tx - n.x, tz - n.z)
        if (d < n.bestD - 0.03) {
          n.bestD = d
          n.noProg = 0
        } else n.noProg += dt
        return false
      }
      budget = left
      n.wi++
      n.bestD = Infinity
      n.noProg = 0
    }
    return true
  }

  function walkSpeed(n: Sim): number {
    const s = n.arch.speed
    return WALK_V * (s > 0 && s < 10 ? s : 1)
  }

  // ───────── 경로 만들기 ─────────

  function pushWp(n: Sim, x: number, z: number): void {
    n.wx[n.wn] = x
    n.wz[n.wn] = z
    n.wn++
  }

  /** 점이 노드 a→b 간선 '위'(양 끝 사이, 옆으로 pad 이내)에 있는가 */
  function onEdge(x: number, z: number, a: number, b: number, pad: number): boolean {
    const ax = nav.nx[a]!
    const az = nav.nz[a]!
    const ex = nav.nx[b]! - ax
    const ez = nav.nz[b]! - az
    const l2 = ex * ex + ez * ez
    if (l2 < 1e-6) return false
    const t = ((x - ax) * ex + (z - az) * ez) / l2
    if (t <= 0 || t >= 1) return false
    const px = ax + ex * t - x
    const pz = az + ez * t - z
    return px * px + pz * pz <= pad * pad
  }

  function clampLane(lane: number, p: number, c: number, q: number): number {
    let right = MAX_LANE
    let left = MAX_LANE
    if (p >= 0) {
      right = Math.min(right, nav.clear.get(p * nav.n + c) ?? 0)
      left = Math.min(left, nav.clear.get(c * nav.n + p) ?? 0)
    }
    if (q >= 0) {
      right = Math.min(right, nav.clear.get(c * nav.n + q) ?? 0)
      left = Math.min(left, nav.clear.get(q * nav.n + c) ?? 0)
    }
    return lane > 0 ? Math.min(lane, right) : Math.max(lane, -left)
  }

  /**
   * 노드 경로 + 마지막 지점(fx,fz) → 경유점 목록.
   * 각 노드에서는 들어오는/나가는 방향의 이등분선에 수직으로 자기 차선만큼 비켜 걷는다(한 줄로 서지 않게).
   * 차선 폭은 미리 재 둔 간선별 여유 폭으로 자른다(가로수·벤치에 걸리지 않게).
   */
  function buildRoute(n: Sim, path: readonly number[], fx: number, fz: number): void {
    let a = 0
    let b = path.length
    // 이미 첫 간선 위를 걷고 있으면 첫 노드로 되돌아가지 않는다
    if (b >= 2 && onEdge(n.x, n.z, path[0]!, path[1]!, EDGE_NEAR)) a = 1
    else if (b >= 1 && hyp(nav.nx[path[0]!]! - n.x, nav.nz[path[0]!]! - n.z) < 0.5) a = 1
    // 마지막 지점이 마지막 노드 곁이거나 마지막 간선 위면 노드를 찍고 되돌아오지 않는다
    if (b - a >= 1) {
      const lastNode = path[b - 1]!
      if (hyp(nav.nx[lastNode]! - fx, nav.nz[lastNode]! - fz) < 2.6) b--
      else if (b >= 2 && onEdge(fx, fz, path[b - 2]!, lastNode, 2.0)) b--
    }
    n.wn = 0
    n.wi = 0
    let px = n.x
    let pz = n.z
    for (let i = a; i < b; i++) {
      const c = path[i]!
      const cx = nav.nx[c]!
      const cz = nav.nz[c]!
      const last = i + 1 >= b
      const qx = last ? fx : nav.nx[path[i + 1]!]!
      const qz = last ? fz : nav.nz[path[i + 1]!]!
      let ix = cx - px
      let iz = cz - pz
      const il = hyp(ix, iz)
      let ox = qx - cx
      let oz = qz - cz
      const ol = hyp(ox, oz)
      if (il > 1e-6) {
        ix /= il
        iz /= il
      }
      if (ol > 1e-6) {
        ox /= ol
        oz /= ol
      }
      if (il <= 1e-6) {
        ix = ox
        iz = oz
      }
      if (ol <= 1e-6) {
        ox = ix
        oz = iz
      }
      let bx = ix + ox
      let bz = iz + oz
      const bl = hyp(bx, bz)
      if (bl < 0.2) {
        // 거의 U턴: 들어오는 방향 기준으로만 비킨다
        bx = ix
        bz = iz
      } else {
        bx /= bl
        bz /= bl
      }
      const lane = clampLane(n.lane, i > 0 ? path[i - 1]! : -1, c, i + 1 < path.length ? path[i + 1]! : -1)
      pushWp(n, cx - bz * lane, cz + bx * lane)
      px = cx
      pz = cz
    }
    pushWp(n, fx, fz)
    clearDetour(n)
  }

  /** (x,z)가 올라서 있는 간선(가장 가까운 간선, EDGE_NEAR 이내)의 양 끝 노드를 outA/outB 에 준다 */
  function edgeNear(x: number, z: number): boolean {
    let best = EDGE_NEAR * EDGE_NEAR
    outA = -1
    outB = -1
    for (let e = 0; e < nav.ea.length; e++) {
      const a = nav.ea[e]!
      const b = nav.eb[e]!
      const ax = nav.nx[a]!
      const az = nav.nz[a]!
      const ex = nav.nx[b]! - ax
      const ez = nav.nz[b]! - az
      const l2 = ex * ex + ez * ez
      if (l2 < 1e-6) continue
      let t = ((x - ax) * ex + (z - az) * ez) / l2
      if (t < 0) t = 0
      else if (t > 1) t = 1
      const px = ax + ex * t - x
      const pz = az + ez * t - z
      const d2 = px * px + pz * pz
      if (d2 < best) {
        best = d2
        outA = a
        outB = b
      }
    }
    return outA >= 0
  }

  /** 길을 잡을 때의 출발 노드 */
  function startNode(n: Sim): number {
    // 평소에는 방금 도착한 노드 곁에 서 있다
    if (n.curNode >= 0 && n.curNode < nav.n) {
      if (hyp(nav.nx[n.curNode]! - n.x, nav.nz[n.curNode]! - n.z) < 3) return n.curNode
    }
    // 간선 위를 걷던 중이면 그 간선의 가까운 쪽 끝에서 출발한다. (그냥 '가장 가까운 노드'를 고르면 옆길의 노드를
    // 찍고 되돌아오는 일이 생긴다. 경로가 반대쪽 끝으로 이어지면 buildRoute 가 첫 노드를 건너뛴다)
    if (edgeNear(n.x, n.z)) {
      const da = hyp(nav.nx[outA]! - n.x, nav.nz[outA]! - n.z)
      const db = hyp(nav.nx[outB]! - n.x, nav.nz[outB]! - n.z)
      return da <= db ? outA : outB
    }
    // 이동망을 벗어나 있다(신도였다가 풀려남, 도망 직후 등): 가까운 순으로 '곧장 걸어갈 수 있는' 노드를 찾는다
    let first = -1
    let prevD = -1
    for (let k = 0; k < 4; k++) {
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < nav.n; i++) {
        const d = hyp(nav.nx[i]! - n.x, nav.nz[i]! - n.z)
        if (d > prevD && d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best < 0) break
      if (first < 0) first = best
      if (clearLine(n.x, n.z, nav.nx[best]!, nav.nz[best]!)) return best
      prevD = bestD
    }
    return first
  }

  function spotTaken(n: Sim, x: number, z: number): boolean {
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!
      if (m === n) continue
      // 걷는 중인 사람은 '가서 설 자리', 서 있는 사람은 지금 자리와 비교한다
      const walking = (m.mode === 'wander' || m.mode === 'gather') && m.wn > 0
      const mx = walking ? m.wx[m.wn - 1]! : m.x
      const mz = walking ? m.wz[m.wn - 1]! : m.z
      const dx = mx - x
      const dz = mz - z
      if (dx * dx + dz * dz < SPOT_SPACING * SPOT_SPACING) return true
    }
    return false
  }

  /**
   * 노드 주변에서 설 자리를 고른다(결과 outX/outZ): 벽 밖, 가능하면 남과 겹치지 않게.
   * 출구(crowdOk)는 곧 사라질 자리라 겹쳐도 되므로 출구 가까이로만 고른다.
   */
  function pickSpot(n: Sim, node: number, radius: number, crowdOk: boolean): void {
    const cx = nav.nx[node]!
    const cz = nav.nz[node]!
    let bx = cx
    let bz = cz
    for (let t = 0; t < 6; t++) {
      const a = rnd() * TAU
      const r = Math.sqrt(rnd()) * (crowdOk ? radius : radius + t * 0.3)
      const sx = cx + Math.sin(a) * r
      const sz = cz + Math.cos(a) * r
      P.x = sx
      P.z = sz
      resolve(P, RADIUS + SPOT_MARGIN, true, world)
      if (Math.abs(P.x - sx) + Math.abs(P.z - sz) > 0.25) continue
      bx = P.x
      bz = P.z
      if (crowdOk || !spotTaken(n, bx, bz)) break
    }
    outX = bx
    outZ = bz
  }

  function pickExit(n: Sim, start: number, nearest: boolean): number {
    const ex = nav.exits
    if (ex.length === 0) return -1
    if (nearest) {
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < ex.length; i++) {
        const e = ex[i]!
        const d = hyp(nav.nx[e]! - n.x, nav.nz[e]! - n.z)
        if (d < bestD) {
          bestD = d
          best = e
        }
      }
      return best
    }
    const e = ex[Math.floor(rnd() * ex.length) % ex.length]!
    return e === start && ex.length > 1 ? ex[(ex.indexOf(e) + 1) % ex.length]! : e
  }

  /** 평소 목적지: 출구가 아닌 노드 중 종류 가중 추첨. 동물은 가까운 곳만 어슬렁거린다 */
  function pickInner(n: Sim, start: number): number {
    const pool = nav.inner.length > 0 ? nav.inner : null
    const size = pool ? pool.length : nav.n
    if (size === 0) return -1
    const near = n.model !== 0 ? 16 : Infinity
    for (let pass = 0; pass < 2; pass++) {
      const limit = pass === 0 ? near : Infinity
      let total = 0
      for (let k = 0; k < size; k++) {
        const i = pool ? pool[k]! : k
        if (i === start) continue
        if (limit !== Infinity && hyp(nav.nx[i]! - n.x, nav.nz[i]! - n.z) > limit) continue
        total += KIND_WEIGHT[nav.kind[i]!] || 1
      }
      if (total <= 0) {
        if (limit === Infinity) break
        continue
      }
      let r = rnd() * total
      let lastOk = -1
      for (let k = 0; k < size; k++) {
        const i = pool ? pool[k]! : k
        if (i === start) continue
        if (limit !== Infinity && hyp(nav.nx[i]! - n.x, nav.nz[i]! - n.z) > limit) continue
        lastOk = i
        r -= KIND_WEIGHT[nav.kind[i]!] || 1
        if (r <= 0) return i
      }
      if (lastOk >= 0) return lastOk
    }
    // 갈 곳이 지금 노드뿐이다(노드 1개짜리 월드 등): 그 주변을 서성인다
    return start >= 0 ? start : -1
  }

  /** 걷기 시작: 갈 방향이 지금 보는 방향과 많이 다르면 먼저 제자리에서 돌아선다 */
  function startWalking(n: Sim): void {
    n.pivot = false
    n.st = WALK
    if (n.wi >= n.wn) return
    const dx = n.wx[n.wi]! - n.x
    const dz = n.wz[n.wi]! - n.z
    if (dx * dx + dz * dz < 0.04) return
    if (angleGap(Math.atan2(dx, dz), n.yaw) > PIVOT_FROM) {
      n.pivot = true
      n.st = IDLE
    }
  }

  /** 출발 전 제자리 돌기 한 틱. 아직 도는 중이면 true — 등을 돌린 채 미끄러지듯 걸어 나가지 않게 한다 */
  function pivoting(n: Sim, dt: number): boolean {
    if (!n.pivot) return false
    if (n.wi < n.wn) {
      const want = Math.atan2(n.wx[n.wi]! - n.x, n.wz[n.wi]! - n.z)
      if (angleGap(want, n.yaw) > PIVOT_DONE) {
        n.yaw = stepAngle(n.yaw, want, TURN_STAND * dt)
        n.st = IDLE
        return true
      }
    }
    n.pivot = false
    return false
  }

  /** 새 목적지를 정하고 걷기 시작한다. 갈 곳이 없으면 false */
  function planTrip(n: Sim): boolean {
    if (nav.n === 0) return false
    const start = startNode(n)
    if (start < 0) return false
    let dest = -1
    let leaving = false
    if (n.exitNext || (n.trips >= TRIPS_BEFORE_EXIT && nav.exits.length > 0 && rnd() < EXIT_CHANCE)) {
      dest = pickExit(n, start, n.exitNext)
      leaving = dest >= 0
    }
    if (dest < 0) dest = pickInner(n, start)
    if (dest < 0) return false
    const path = findNavPath(start, dest, world)
    const end = path[path.length - 1]!
    if (end !== dest) {
      // 이어지지 않은 곳: 갈 수 있는 데까지만(출구가 아니면 퇴장하지 않는다)
      dest = end
      leaving = leaving && nav.kind[end] === 'exit'
    }
    pickSpot(n, dest, leaving ? 0.5 : 1.0, leaving)
    buildRoute(n, path, outX, outZ)
    n.dest = dest
    n.leaving = leaving
    n.exitNext = false
    n.mode = 'wander'
    n.until = 0
    n.turning = false
    startWalking(n)
    return true
  }

  /** 노드가 아닌 지점(구경 자리 등)까지의 길 */
  function routeToPoint(n: Sim, x: number, z: number): void {
    const d = hyp(x - n.x, z - n.z)
    if (nav.n === 0 || (d < 9 && clearLine(n.x, n.z, x, z))) {
      n.wn = 0
      n.wi = 0
      pushWp(n, x, z)
      clearDetour(n)
      return
    }
    const start = startNode(n)
    const end = nearestNavNode(x, z, world)
    buildRoute(n, start >= 0 ? findNavPath(start, end, world) : [], x, z)
  }

  // ───────── 모드 전환 ─────────

  function pause(n: Sim, secs: number): void {
    n.mode = 'pause'
    n.st = IDLE
    n.wait = secs
    n.until = 0
    n.moving = false
    n.running = false
    // 오래 서 있을 때만 가끔 두리번거린다(짧은 정지에서는 트래픽만 늘어난다)
    n.lookIn = secs >= 3 ? 1 + rnd() * 2 : Infinity
  }

  function beginVanish(n: Sim): void {
    n.mode = 'leave'
    n.phase = 1
    n.wait = VANISH_S
    n.st = VANISH
    n.until = 0
    n.talker = 0
    n.gslot = false
    n.wn = 0
    n.wi = 0
  }

  function groupOf(owner: number): Group {
    let g = groups.get(owner)
    if (!g) {
      g = {
        list: [],
        cx: new Float64Array(TRAIL_CAP),
        cz: new Float64Array(TRAIL_CAP),
        head: 0,
        count: 0,
        hx: 0,
        hz: 1,
        idle: 0,
        stamp: -1,
      }
      groups.set(owner, g)
    }
    return g
  }

  /** 주인과의 연결을 끊고 이전 주인 id 를 돌려준다. 남은 신도는 줄을 당겨 선다 */
  function detach(n: Sim): number {
    const prev = n.owner
    if (!prev) return 0
    const g = groups.get(prev)
    if (g) {
      const i = g.list.indexOf(n)
      if (i >= 0) g.list.splice(i, 1)
      if (g.list.length === 0) groups.delete(prev)
    }
    n.owner = 0
    n.followUntil = 0
    return prev
  }

  /** 새 시민으로 교체: 같은 id 로 유형·이름·외형을 새로 뽑아 출입구에서 등장 */
  function respawn(n: Sim): void {
    const prev = detach(n)
    rollIdentity(n)
    n.memo.clear()
    n.offered = false
    n.followSince = 0
    n.talker = 0
    n.until = 0
    n.trips = 0
    n.fails = 0
    n.hurry = 0
    n.leaving = false
    n.exitNext = false
    n.retiring = false
    n.gslot = false
    n.moving = false
    n.running = false
    n.turning = false
    n.wn = 0
    n.wi = 0
    clearDetour(n)

    // 대개 지하철에서 올라오고, 가끔은 길 끝(다른 출구)에서 걸어 들어온다
    let node = nav.entryNode
    let x = nav.entryX
    let z = nav.entryZ
    let yaw = nav.entryYaw
    if (nav.exits.length > 0 && rnd() < 0.42) {
      const e = nav.exits[Math.floor(rnd() * nav.exits.length) % nav.exits.length]!
      if (e !== nav.entryNode) {
        node = e
        x = nav.nx[e]!
        z = nav.nz[e]!
        // 맵 안쪽(가운데)을 보며 등장
        const b = world.bounds
        yaw = Math.atan2((b.x0 + b.x1) / 2 - x, (b.z0 + b.z1) / 2 - z)
      }
    }
    n.x = x + (rnd() - 0.5) * 0.8
    n.z = z + (rnd() - 0.5) * 0.8
    resolve(n, RADIUS + SPOT_MARGIN, true, world)
    n.yaw = stepAngle(yaw, yaw, 0)
    n.curNode = node
    n.mode = 'enter'
    n.phase = 0
    n.st = VANISH
    n.wait = ENTER_S
    remember(n)
    n.dirty = true
    if (prev) events.onOwnerChange(n, prev, 'replace')
    events.onSpawn(n)
  }

  function leaveGather(n: Sim): void {
    n.gslot = false
    if (n.mode === 'gather') {
      n.wn = 0
      n.wi = 0
      pause(n, 0.3 + rnd() * 2.2)
    }
  }

  function ungatherAll(): void {
    gatherOn = false
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!
      if (n.gslot) leaveGather(n)
    }
  }

  /** 대화·도망이 끝난 뒤 하던 일로 돌아간다 */
  function resume(n: Sim): void {
    n.turning = false
    if (n.owner) {
      n.mode = 'follow'
      n.until = n.followUntil
      n.moving = false
      n.running = false
      n.far = 0
      n.farIn = 0
      n.st = IDLE
    } else if (n.retiring) {
      n.mode = 'leave'
      n.phase = 0
      n.until = 0
      startWalking(n)
    } else if (n.gslot && gatherOn) {
      n.mode = 'gather'
      n.until = gatherUntil
      n.phase = 0
      n.wn = 0
      n.wi = 0
      pushWp(n, n.gx, n.gz)
      clearDetour(n)
      startWalking(n)
    } else if (n.wi < n.wn) {
      n.mode = 'wander'
      n.until = 0
      startWalking(n)
    } else {
      pause(n, 0.4 + rnd() * 0.8)
    }
  }

  function endListenSim(n: Sim): void {
    n.talker = 0
    if (n.mode !== 'listen') return
    n.gslot = n.gslot && gatherOn
    resume(n)
  }

  function releaseSim(n: Sim, reason: OwnerChangeReason): void {
    const prev = detach(n)
    if (!prev) return
    // 시간이 다 되어 "정신 차린" 신도는 다음 걸음에 출구로 떠난다(→ 새 시민으로 물갈이)
    n.exitNext = reason === 'expire'
    if (n.mode === 'follow') {
      // "어? 제가 왜 여기 있죠?" — 잠깐 멍하니 섰다가 제 갈 길로
      n.wn = 0
      n.wi = 0
      n.curNode = -1
      pause(n, 1.2 + rnd() * 1.0)
      n.sayIn = MUTTER_MIN_S + rnd() * MUTTER_VAR_S
    }
    if (n.arch.leave.length > 0) events.onSay(n, pick(n.arch.leave, rnd))
    events.onOwnerChange(n, prev, reason)
  }

  // ───────── 신도 줄(발자취) ─────────

  function updateTrail(g: Group, p: PlayerState, dt: number): void {
    g.stamp = tickNo
    if (g.count === 0) {
      // 첫 발자취: 주인이 바라보는 쪽을 진행 방향으로 본다
      g.hx = Math.sin(p.yaw)
      g.hz = Math.cos(p.yaw)
      g.head = 0
      g.cx[0] = p.x
      g.cz[0] = p.z
      g.count = 1
      g.idle = 0
      return
    }
    const dx = p.x - g.cx[g.head]!
    const dz = p.z - g.cz[g.head]!
    const d2 = dx * dx + dz * dz
    if (d2 < CRUMB * CRUMB) {
      g.idle += dt
      return
    }
    const d = Math.sqrt(d2)
    if (d > TRAIL_TELEPORT) {
      g.count = 0
      g.head = TRAIL_CAP - 1
    } else {
      g.hx = dx / d
      g.hz = dz / d
    }
    g.head = (g.head + 1) % TRAIL_CAP
    g.cx[g.head] = p.x
    g.cz[g.head] = p.z
    if (g.count < TRAIL_CAP) g.count++
    g.idle = 0
  }

  /** 주인(ox,oz)에서 발자취를 따라 s 만큼 뒤의 지점(outX/outZ). 발자취보다 뒤는 꼬리 방향으로 곧게 잇는다 */
  function trailPoint(g: Group, ox: number, oz: number, s: number): void {
    let px = ox
    let pz = oz
    let qx = ox
    let qz = oz
    let acc = 0
    for (let j = 0; j < g.count; j++) {
      const i = (g.head - j + TRAIL_CAP) % TRAIL_CAP
      const cx = g.cx[i]!
      const cz = g.cz[i]!
      const seg = hyp(cx - px, cz - pz)
      if (acc + seg >= s && seg > 1e-9) {
        const t = (s - acc) / seg
        outX = px + (cx - px) * t
        outZ = pz + (cz - pz) * t
        return
      }
      acc += seg
      if (seg > 1e-6) {
        qx = px
        qz = pz
      }
      px = cx
      pz = cz
    }
    let tx = px - qx
    let tz = pz - qz
    const tl = hyp(tx, tz)
    if (tl > 1e-6) {
      tx /= tl
      tz /= tl
    } else {
      tx = -g.hx
      tz = -g.hz
    }
    outX = px + tx * (s - acc)
    outZ = pz + tz * (s - acc)
  }

  /**
   * (x,z)에서 올라탈 발자취 지점까지, 주인에게서 발자취를 따라 잰 거리(outS).
   * 주인 쪽에서부터 훑어 '손 닿는 거리'에 처음 들어오는 지점을 고른다 — 가장 가까운 지점을 고르면
   * 주인이 왔던 길을 되돌아갔을 때 신도가 옛 발자취를 한 바퀴 다 돌게 된다.
   */
  function nearestOnTrail(g: Group, ox: number, oz: number, x: number, z: number): void {
    let px = ox
    let pz = oz
    let acc = 0
    let best = (x - ox) * (x - ox) + (z - oz) * (z - oz)
    let bestS = 0
    outS = 0
    if (best <= TRAIL_REACH * TRAIL_REACH) return
    for (let j = 0; j < g.count; j++) {
      const i = (g.head - j + TRAIL_CAP) % TRAIL_CAP
      const cx = g.cx[i]!
      const cz = g.cz[i]!
      acc += hyp(cx - px, cz - pz)
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz)
      if (d2 <= TRAIL_REACH * TRAIL_REACH) {
        outS = acc
        return
      }
      if (d2 < best) {
        best = d2
        bestS = acc
      }
      px = cx
      pz = cz
    }
    outS = bestS
  }

  /** 주인이 서 있을 때의 자리: 뒤쪽 반원에 부채꼴(줄마다 5, 7, 9 … 명, 가운데부터 채운다) */
  function fanSlot(g: Group, p: PlayerState, idx: number): void {
    let row = 0
    let start = 0
    let cap = 5
    while (idx >= start + cap) {
      start += cap
      cap += 2
      row++
    }
    const m = Math.min(cap, g.list.length - start)
    const j = idx - start
    const half = (j + 1) >> 1
    const mid = (m - 1) >> 1
    const pos = (j & 1) === 1 ? mid + half : mid - half
    const radius = FAN_RADIUS + row * FAN_ROW
    const spread = m > 1 ? Math.min(1.25, 0.42 * (m - 1)) : 0
    const a = m > 1 ? -spread + (2 * spread * pos) / (m - 1) : 0
    const bx = -g.hx
    const bz = -g.hz
    const c = Math.cos(a)
    const s = Math.sin(a)
    outX = p.x + (bx * c + bz * s) * radius
    outZ = p.z + (-bx * s + bz * c) * radius
  }

  // ───────── 모드별 갱신 ─────────

  /** 배회/정지 중 혼잣말. 방 전체로 너무 잦지 않게 공용 쿨타임을 둔다 */
  function mutter(n: Sim, dt: number): void {
    n.sayIn -= dt
    if (n.sayIn > 0) return
    if (mutterCd > 0 || n.arch.mutter.length === 0) {
      n.sayIn = 2 + rnd() * 5
      return
    }
    n.sayIn = MUTTER_MIN_S + rnd() * MUTTER_VAR_S
    mutterCd = MUTTER_ROOM_MIN_S + rnd() * MUTTER_ROOM_VAR_S
    events.onSay(n, pick(n.arch.mutter, rnd))
  }

  function arrive(n: Sim): void {
    n.trips++
    n.fails = 0
    n.curNode = n.dest
    n.wn = 0
    n.wi = 0
    if (n.leaving) {
      beginVanish(n)
      return
    }
    const kind = n.dest >= 0 ? nav.kind[n.dest] : undefined
    let secs = kind === 'shop' ? 2 + rnd() * 3 : kind === 'rest' ? 5 + rnd() * 7 : 0.5 + rnd() * 1.5
    // 동물은 더 자주, 더 오래 멈춘다
    if (n.model !== 0) secs = secs * 2 + 1
    pause(n, secs)
  }

  function updateWander(n: Sim, dt: number): void {
    if (n.wi >= n.wn) {
      // 길이 없다(밖에서 모드만 바꿨거나 방금 다른 일을 마쳤다) → 새 목적지
      if (!planTrip(n)) pause(n, 1 + rnd() * 2)
      return
    }
    if (pivoting(n, dt)) return
    let speed = walkSpeed(n)
    if (n.hurry > 0) {
      n.hurry -= dt
      speed *= HURRY_MUL
    }
    n.st = WALK
    if (followRoute(n, speed, dt, true)) arrive(n)
    else if (n.noProg > STUCK_S) stuck(n)
    else mutter(n, dt)
  }

  /** 오래 막혔을 때: 한 번은 차선 없이 길을 다시 잡고, 그래도 안 되면 그 자리에서 퇴장(새 시민으로 교체) */
  function stuck(n: Sim): void {
    const last = n.wn - 1
    if (n.wi === last && hyp(n.wx[last]! - n.x, n.wz[last]! - n.z) < 1.0) {
      arrive(n)
      return
    }
    n.fails++
    n.wn = 0
    n.wi = 0
    n.curNode = -1
    if (n.fails >= 2) {
      beginVanish(n)
      return
    }
    n.lane = 0
    pause(n, 0.3 + rnd() * 0.6)
  }

  function updatePause(n: Sim, dt: number): void {
    if (n.turning) turnStep(n, dt)
    n.wait -= dt
    if (n.wait <= 0) {
      if (!planTrip(n)) n.wait = 2 + rnd() * 3
      return
    }
    n.lookIn -= dt
    if (n.lookIn <= 0) {
      n.faceYaw = stepAngle(n.yaw, n.yaw + (rnd() - 0.5) * 2.6, Math.PI)
      n.turning = true
      n.lookIn = 2.5 + rnd() * 4
    }
    mutter(n, dt)
  }

  function updateEnter(n: Sim, dt: number): void {
    n.wait -= dt
    if (n.wait > 0) return
    if (!planTrip(n)) pause(n, 1 + rnd() * 2)
  }

  function updateLeave(n: Sim, dt: number): void {
    if (n.phase === 0) {
      if (pivoting(n, dt)) return
      n.st = WALK
      if (n.wi >= n.wn || followRoute(n, walkSpeed(n), dt, true) || n.noProg > STUCK_S) beginVanish(n)
      return
    }
    n.wait -= dt
    if (n.wait <= 0) respawn(n)
  }

  function updateListen(n: Sim, now: number, dt: number): void {
    const p = curPlayers.get(n.talker)
    if (!p || (n.until !== 0 && now >= n.until)) {
      endListenSim(n)
      return
    }
    n.st = LISTEN
    lookAt(n, p.x, p.z, 0.06)
    if (n.turning) turnStep(n, dt)
  }

  function updateFollow(n: Sim, now: number, dt: number): void {
    if (!n.owner) {
      pause(n, 0.5)
      return
    }
    const p = curPlayers.get(n.owner)
    if (!p) {
      releaseSim(n, 'leave')
      return
    }
    if (n.until !== 0 && now >= n.until) {
      releaseSim(n, 'expire')
      return
    }
    const g = groupOf(n.owner)
    let idx = g.list.indexOf(n)
    if (idx < 0) {
      g.list.push(n)
      idx = g.list.length - 1
    }
    if (g.stamp !== tickNo) updateTrail(g, p, dt)

    const ddx = p.x - n.x
    const ddz = p.z - n.z
    const dOwner = Math.sqrt(ddx * ddx + ddz * ddz)
    if (dOwner > FOLLOW_GIVE_UP) {
      // 주인을 완전히 놓쳤다
      releaseSim(n, 'expire')
      return
    }

    // 내 자리: 걷는 주인 뒤로는 발자취를 따라 한 줄, 서 있는 주인 뒤로는 부채꼴
    const s = SLOT_FIRST + SLOT_GAP * idx
    let fan = g.idle >= FAN_DELAY
    if (fan) {
      fanSlot(g, p, idx)
      // 멀리서 부채꼴 자리로 곧장 가로지르지 않는다 — 먼저 줄을 따라 다가온다
      if (hyp(outX - n.x, outZ - n.z) > FAR_GAP) fan = false
    }
    if (!fan) trailPoint(g, p.x, p.z, s)
    P.x = outX
    P.z = outZ
    collide(P)
    const tx = P.x
    const tz = P.z
    let ax = tx
    let az = tz
    let gap = hyp(tx - n.x, tz - n.z)
    let direct = true
    if (!fan && gap > PURSUE_FROM) {
      nearestOnTrail(g, p.x, p.z, n.x, n.z)
      if (outS - LOOKAHEAD > s) {
        // 뒤처졌다: 자리로 곧장 가로지르지 않고 주인이 걸어간 길을 따라 달린다(건물 모퉁이를 뚫지 않게)
        if (outS - s > gap) gap = outS - s
        trailPoint(g, p.x, p.z, outS - LOOKAHEAD)
        ax = outX
        az = outZ
        direct = false
      }
    }

    // 한참 뒤처졌다(대화에 붙잡혔거나 도망갔다 돌아오는 길): 0.5초마다 시야를 확인해서
    //  · 자리가 바로 보이면 발자취를 다 돌지 않고 질러가고
    //  · 발자취조차 안 보이면(건물 너머) 이동망을 따라 주인 쪽으로 간다
    let viaNav = false
    if (gap > FAR_GAP) {
      n.farIn -= dt
      if (n.farIn <= 0) {
        n.farIn = 0.5
        const was = n.far
        if (clearLine(n.x, n.z, tx, tz)) n.far = 1
        else if (clearLine(n.x, n.z, ax, az)) n.far = 0
        else n.far = 2
        if (n.far === 2 && (was !== 2 || n.wi >= n.wn || --n.farPlan <= 0)) {
          // 주인이 계속 움직이므로 2초마다 길을 다시 잡는다
          routeToPoint(n, tx, tz)
          n.farPlan = 4
        }
      }
      if (n.far === 1) {
        ax = tx
        az = tz
        direct = true
      } else if (n.far === 2 && n.wi < n.wn) viaNav = true
    } else if (n.far !== 0 || n.farIn !== 0) {
      n.far = 0
      n.farIn = 0
    }
    if (!viaNav && n.wn !== 0) {
      n.wn = 0
      n.wi = 0
      clearDetour(n)
    }

    // 주인이 되돌아와 발자취가 접히면 자리가 주인 발밑에 놓인다 — 그때는 다가가지 않고 기다린다.
    // (모퉁이에서는 자리가 0.8m 쯤으로 가까워질 뿐이라 멈추지 않는다. 1m 원 밖으로 밀리며 따라 돈다)
    const ownerMoving = g.idle < 0.25
    let hold = false
    if (hyp(tx - p.x, tz - p.z) < HOLD_NEAR) {
      gap = 0
      hold = true
      n.moving = false
    }

    // 이력: 주인이 서 있을 때는 꽤 벌어져야 출발하고, 걷기 시작하면 자리에 닿을 때까지 간다(가까이서 떨지 않게).
    // 주인이 걷는 동안은 자리에 닿아도 '걷는 중'으로 둔다 — 모퉁이에서 주인이 잠깐 느려질 때마다 섰다 걷다 하지 않게.
    if (!n.moving && !hold && gap > (ownerMoving ? 0.05 : FOLLOW_START)) {
      n.moving = true
      n.turning = false
    }
    if (n.moving) {
      // 벌어진 만큼 빨리 걷는다 → 주인 속도에 자연스럽게 맞춰진다
      let v = gap * FOLLOW_GAIN
      const vmax = fan && gap < 4 ? FAN_SPEED : FOLLOW_V
      if (v > vmax) v = vmax
      if (v < FOLLOW_MIN_SPEED) v = FOLLOW_MIN_SPEED
      if (viaNav) followRoute(n, v, dt, false)
      else {
        const left = walkTo(n, ax, az, v * dt, ARRIVE_EPS, (v > RUN_ON ? TURN_RUN : TURN_WALK) / v, 0)
        if (left >= 0 && direct && !ownerMoving) n.moving = false
      }
      if (n.running) {
        if (v < RUN_OFF) n.running = false
      } else if (v > RUN_ON) n.running = true
    }

    // 주인이 다가오면 비켜 준다
    const ex = n.x - p.x
    const ez = n.z - p.z
    const e2 = ex * ex + ez * ez
    let scoot = false
    if (e2 < OWNER_CLEAR * OWNER_CLEAR) {
      const e = Math.sqrt(e2)
      const qx = e > 1e-4 ? ex / e : -g.hx
      const qz = e > 1e-4 ? ez / e : -g.hz
      // 주인 주위 1m 원 밖으로 밀어낸다(자리로 걷다가 주인을 스치면 원을 따라 돌아가게 된다)
      n.x += qx * (OWNER_CLEAR - e)
      n.z += qz * (OWNER_CLEAR - e)
      collide(n)
      scoot = true
    }

    if (n.moving) n.st = n.running ? RUN : WALK
    else if (scoot) n.st = p.st === RUN || p.st === SPRINT ? RUN : WALK
    else {
      n.st = IDLE
      n.running = false
      // 서 있을 때는 주인을 바라본다(조금 움직였다고 계속 돌지는 않는다)
      if (dOwner > 0.3) lookAt(n, p.x, p.z, 0.5)
      if (n.turning) turnStep(n, dt)
    }

    n.sayIn -= dt
    if (n.sayIn <= 0) {
      n.sayIn = 20 + rnd() * 20
      if (n.arch.follow.length > 0) events.onSay(n, pick(n.arch.follow, rnd))
    }
  }

  function endFlee(n: Sim): void {
    n.wn = 0
    n.wi = 0
    n.curNode = -1
    n.until = 0
    clearDetour(n)
    if (n.owner) resume(n)
    else pause(n, 0.8 + rnd() * 1.2)
  }

  /** 위협 반대쪽으로 뻗은 이동망 경로를 고른다. 마땅한 길이 없으면 경유점 없이 둔다(직접 도주) */
  function planFlee(n: Sim): void {
    n.wn = 0
    n.wi = 0
    clearDetour(n)
    if (nav.n === 0) return
    let ax = n.x - n.fx
    let az = n.z - n.fz
    let al = hyp(ax, az)
    if (al < 1e-3) {
      ax = Math.sin(n.yaw)
      az = Math.cos(n.yaw)
      al = 1
    }
    const d0 = al
    ax /= al
    az /= al
    // 점수 상위 3곳을 차례로 시도한다
    let c0 = -1
    let c1 = -1
    let c2 = -1
    let s0 = -Infinity
    let s1 = -Infinity
    let s2 = -Infinity
    for (let i = 0; i < nav.n; i++) {
      const dx = nav.nx[i]! - n.x
      const dz = nav.nz[i]! - n.z
      const dn = hyp(dx, dz)
      if (dn < 5) continue
      const align = (dx * ax + dz * az) / dn
      if (align < 0.1) continue
      const dThreat = hyp(nav.nx[i]! - n.fx, nav.nz[i]! - n.fz)
      const score = Math.min(dThreat, 36) + align * 14 + rnd() * 5
      if (score > s0) {
        c2 = c1
        s2 = s1
        c1 = c0
        s1 = s0
        c0 = i
        s0 = score
      } else if (score > s1) {
        c2 = c1
        s2 = s1
        c1 = i
        s1 = score
      } else if (score > s2) {
        c2 = i
        s2 = score
      }
    }
    // 출발 노드: 간선 위에 있으면 위협 반대쪽 끝
    let start: number
    if (edgeNear(n.x, n.z)) {
      const a = outA
      const b = outB
      const da = (nav.nx[a]! - n.x) * ax + (nav.nz[a]! - n.z) * az
      const db = (nav.nx[b]! - n.x) * ax + (nav.nz[b]! - n.z) * az
      start = da >= db ? a : b
    } else start = startNode(n)
    if (start < 0) return
    const near = Math.min(d0, 3) * 0.8
    for (let k = 0; k < 3; k++) {
      const c = k === 0 ? c0 : k === 1 ? c1 : c2
      if (c < 0) break
      const path = findNavPath(start, c, world)
      if (path[path.length - 1] !== c) continue
      buildRoute(n, path, nav.nx[c]!, nav.nz[c]!)
      if (fleeRouteOk(n, ax, az, near)) return
    }
    // 반대쪽으로 난 길이 없다. 탁 트인 곳이면 길 없이 곧장 달아나고(직접 도주),
    // 막다른 곳이면 위협 곁을 스쳐서라도 가장 먼 곳으로 빠져나간다
    n.wn = 0
    n.wi = 0
    if (clearLine(n.x, n.z, n.x + ax * FLEE_OPEN, n.z + az * FLEE_OPEN)) return
    let far = -1
    let farD = FLEE_SAFE
    for (let i = 0; i < nav.n; i++) {
      const d = hyp(nav.nx[i]! - n.fx, nav.nz[i]! - n.fz)
      if (d > farD) {
        farD = d
        far = i
      }
    }
    if (far < 0) return
    const path = findNavPath(startNode(n), far, world)
    if (path[path.length - 1] === far) buildRoute(n, path, nav.nx[far]!, nav.nz[far]!)
  }

  /**
   * 도망 경로 검사: 첫걸음이 위협 쪽이 아니고, 어느 구간도 위협 곁(near)을 지나지 않으며,
   * 어느 정도 달린 뒤(10m~)에는 줄곧 위협에서 충분히 멀어야 한다(빙 돌아 되돌아오는 길 배제).
   */
  function fleeRouteOk(n: Sim, ax: number, az: number, near: number): boolean {
    const fdx = n.wx[0]! - n.x
    const fdz = n.wz[0]! - n.z
    const fl = hyp(fdx, fdz) || 1
    if ((fdx * ax + fdz * az) / fl <= -0.25) return false
    let px = n.x
    let pz = n.z
    let run = 0
    for (let i = 0; i < n.wn; i++) {
      const qx = n.wx[i]!
      const qz = n.wz[i]!
      // 위협에서 구간 p→q 까지의 거리
      const ex = qx - px
      const ez = qz - pz
      const l2 = ex * ex + ez * ez
      let t = l2 > 1e-9 ? ((n.fx - px) * ex + (n.fz - pz) * ez) / l2 : 0
      if (t < 0) t = 0
      else if (t > 1) t = 1
      if (hyp(px + ex * t - n.fx, pz + ez * t - n.fz) < near) return false
      // 10m 넘게 달린 뒤의 구간은(도망이 구간 한가운데서 끝날 수도 있으므로) 통째로 위협에서 멀어야 한다
      const len = Math.sqrt(l2)
      if (run + len >= 10) {
        const t10 = run >= 10 ? 0 : (10 - run) / len
        if (t < t10) t = t10
        if (hyp(px + ex * t - n.fx, pz + ez * t - n.fz) < FLEE_SAFE - 1) return false
      }
      run += len
      px = qx
      pz = qz
    }
    return true
  }

  function updateFlee(n: Sim, now: number, dt: number): void {
    if (now >= n.until) {
      endFlee(n)
      return
    }
    n.st = SPRINT
    if (n.wi < n.wn) {
      if (followRoute(n, FLEE_V, dt, false)) {
        // 길이 일찍 끝났다: 충분히 멀어졌으면 숨을 고르고, 아니면 남은 시간은 곧장 멀어진다
        const dx = n.x - n.fx
        const dz = n.z - n.fz
        n.wn = 0
        n.wi = 0
        if (dx * dx + dz * dz >= FLEE_SAFE * FLEE_SAFE) endFlee(n)
      } else if (n.noProg > 0.8) {
        n.wn = 0
        n.wi = 0
        clearDetour(n)
      }
      return
    }
    let ax = n.x - n.fx
    let az = n.z - n.fz
    let al = hyp(ax, az)
    if (al < 1e-3) {
      ax = Math.sin(n.yaw)
      az = Math.cos(n.yaw)
      al = 1
    }
    walkTo(n, n.x + (ax / al) * 30, n.z + (az / al) * 30, FLEE_V * dt, ARRIVE_EPS, TURN_RUN / FLEE_V, 0)
    // 구석에 몰려 위협에서 더 멀어지지 못하면 그만 뛴다(벽을 끼고 왔다 갔다 하지 않게)
    const far = hyp(n.x - n.fx, n.z - n.fz)
    if (far > n.fleeBest + 0.15) {
      n.fleeBest = far
      n.noProg = 0
    } else {
      n.noProg += dt
      if (n.noProg > 0.4) endFlee(n)
    }
  }

  function updateGather(n: Sim, now: number, dt: number): void {
    if (!n.gslot || !gatherOn || (n.until !== 0 && now >= n.until)) {
      n.gslot = false
      n.wn = 0
      n.wi = 0
      pause(n, 0.3 + rnd() * 2.2)
      return
    }
    if (n.phase === 0) {
      if (pivoting(n, dt)) return
      n.st = WALK
      if (followRoute(n, Math.max(walkSpeed(n), BRISK_SPEED), dt, true)) {
        n.phase = 1
        n.st = CHEER
        n.wait = 1.5 + rnd() * 2.5
        lookAt(n, gcx, gcz, 0.02)
      } else if (n.noProg > STUCK_S) leaveGather(n)
      return
    }
    if (n.turning) turnStep(n, dt)
    // 내내 뛰기만 하면 어색하므로 환호와 구경을 번갈아 한다
    n.wait -= dt
    if (n.wait <= 0) {
      if (n.st === CHEER) {
        n.st = IDLE
        n.wait = 1 + rnd() * 2.5
      } else {
        n.st = CHEER
        n.wait = 1.5 + rnd() * 3
      }
    }
  }

  // ───────── 공개 API ─────────

  /** 이 시뮬이 관리하는 NPC 인지 확인(다른 방의 객체나 지워진 특수 NPC 는 무시) */
  function own(npc: NpcState): Sim | null {
    const s = byId[npc.id]
    return s !== undefined && s === npc ? s : null
  }

  const api: NpcSimApi = {
    list,

    get(id) {
      return id >= 1 && id <= MAX_ID ? byId[id] : undefined
    },

    tick(now, dt, players) {
      lastNow = now
      if (!(dt > 0)) dt = 0
      else if (dt > MAX_DT) dt = MAX_DT
      tickNo++
      curPlayers = players
      pn = 0
      players.forEach(collectPlayer)
      if (mutterCd > 0) mutterCd -= dt
      if (gatherOn && now >= gatherUntil) ungatherAll()

      for (let i = 0; i < list.length; i++) {
        const n = list[i]!
        // 특수 NPC 는 기능 시스템이 직접 움직인다 — 시뮬은 손대지 않는다
        if (n.mode === 'script') continue
        if (n.sideLock > 0) n.sideLock -= dt
        switch (n.mode) {
          case 'wander':
            updateWander(n, dt)
            break
          case 'pause':
            updatePause(n, dt)
            break
          case 'listen':
            updateListen(n, now, dt)
            break
          case 'follow':
            updateFollow(n, now, dt)
            break
          case 'flee':
            updateFlee(n, now, dt)
            break
          case 'leave':
            updateLeave(n, dt)
            break
          case 'enter':
            updateEnter(n, dt)
            break
          case 'gather':
            updateGather(n, now, dt)
            break
        }
        flush(n)
      }
    },

    canTalk(npc, playerId, now) {
      if (npc.mode === 'leave' || npc.mode === 'enter' || npc.mode === 'flee' || npc.mode === 'script') return 'gone'
      if (npc.talker !== 0 && npc.talker !== playerId) return 'busy'
      if ((npc.memo.get(playerId) ?? 0) > now) return 'memo'
      return 'ok'
    },

    beginListen(npc, player, until) {
      const n = own(npc)
      // canTalk 가 'gone' 인 상태에서는 대화를 시작하지 않는다
      if (!n || n.mode === 'script' || n.mode === 'leave' || n.mode === 'enter' || n.mode === 'flee') return
      n.mode = 'listen'
      n.talker = player.id
      n.until = until
      n.st = LISTEN
      n.moving = false
      n.running = false
      n.turning = false
      lookAt(n, player.x, player.z, 0)
      flush(n)
    },

    endListen(npc) {
      const n = own(npc)
      if (!n || n.mode === 'script') return
      endListenSim(n)
      flush(n)
    },

    startFollow(npc, playerId, until, now) {
      const n = own(npc)
      if (!n || n.mode === 'script' || !playerId) return
      const prev = n.owner
      if (prev !== playerId) {
        detach(n)
        groupOf(playerId).list.push(n)
        n.owner = playerId
        n.followSince = now
        n.offered = false
        n.sayIn = 8 + rnd() * 12
      }
      n.talker = 0
      n.gslot = false
      n.retiring = false
      n.leaving = false
      n.exitNext = false
      n.mode = 'follow'
      n.until = until
      n.followUntil = until
      n.moving = false
      n.running = false
      n.turning = false
      n.far = 0
      n.farIn = 0
      n.st = IDLE
      n.wn = 0
      n.wi = 0
      n.curNode = -1
      clearDetour(n)
      flush(n)
      // 같은 주인이 다시 부른 경우는 주인이 바뀐 것이 아니므로 알리지 않는다
      if (prev !== playerId) events.onOwnerChange(n, prev, prev ? 'poach' : 'join')
    },

    release(npc, reason) {
      const n = own(npc)
      if (!n) return
      releaseSim(n, reason)
      flush(n)
    },

    flee(npc, fromX, fromZ, now) {
      const n = own(npc)
      if (!n || n.mode === 'script') return
      n.talker = 0
      // 퇴장/등장 연출 중이거나 이미 떠나는 시민은 그대로 둔다
      if (n.mode === 'leave' || n.mode === 'enter') return
      n.gslot = false
      n.mode = 'flee'
      n.until = now + FLEE_MIN_MS + rnd() * FLEE_VAR_MS
      n.fx = fromX
      n.fz = fromZ
      n.fleeBest = 0
      n.st = SPRINT
      n.moving = false
      n.running = false
      n.turning = false
      n.hurry = 0
      planFlee(n)
      flush(n)
    },

    walkOff(npc) {
      const n = own(npc)
      if (!n || n.mode === 'script') return
      endListenSim(n)
      // 못 들은 척 걸음을 재촉한다
      if (n.mode === 'pause') n.wait = Math.min(n.wait, 0.15)
      if (n.mode === 'pause' || n.mode === 'wander') n.hurry = HURRY_S
      flush(n)
    },

    remember(npc, playerId, until) {
      const n = own(npc)
      if (!n) return
      if (n.memo.size >= 16) {
        // 이미 지난 기억은 버린다(오래 사는 NPC 의 메모가 끝없이 쌓이지 않게)
        n.memo.forEach((t, k) => {
          if (t <= lastNow) n.memo.delete(k)
        })
      }
      n.memo.set(playerId, until)
    },

    followersOf(playerId) {
      const g = groups.get(playerId)
      return g ? g.list.slice() : []
    },

    gather(center, radius, until, max) {
      ungatherAll()
      const want = Math.floor(max)
      if (!(want > 0)) return []
      // 근처를 배회 중인 사람만 부른다(대화 중·신도·동물·퇴장 중은 제외)
      const cands: Sim[] = []
      for (const n of list) {
        if ((n.mode !== 'wander' && n.mode !== 'pause') || n.owner !== 0 || n.talker !== 0 || n.model !== 0) continue
        if (hyp(n.x - center.x, n.z - center.z) > radius + GATHER_RANGE) continue
        cands.push(n)
      }
      if (cands.length === 0) return []
      const dist = (n: Sim): number => hyp(n.x - center.x, n.z - center.z)
      cands.sort((a, b) => dist(a) - dist(b) || a.id - b.id)

      // 자리: 중심을 둘러싼 고리 여러 겹. 벽 속이나 경계 밖 자리는 뺀다
      const sx: number[] = []
      const sz: number[] = []
      const ring: number[] = []
      for (let k = 0; k < GATHER_RINGS; k++) {
        const R = radius + GATHER_RING_FIRST + k * GATHER_RING_GAP
        const m = Math.max(6, Math.floor((TAU * R) / GATHER_SEAT_GAP))
        for (let j = 0; j < m; j++) {
          const a = ((j + (k % 2) * 0.5) / m) * TAU
          const x = center.x + Math.sin(a) * R
          const z = center.z + Math.cos(a) * R
          P.x = x
          P.z = z
          resolve(P, RADIUS + SPOT_MARGIN, true, world)
          if (Math.abs(P.x - x) + Math.abs(P.z - z) > 0.05) continue
          sx.push(x)
          sz.push(z)
          ring.push(k)
        }
      }
      const taken = new Uint8Array(sx.length)
      const out: NpcState[] = []
      for (const n of cands) {
        if (out.length >= want) break
        // 가까운 빈자리, 되도록 앞줄부터
        let best = -1
        let bestScore = Infinity
        for (let i = 0; i < sx.length; i++) {
          if (taken[i]) continue
          const score = hyp(sx[i]! - n.x, sz[i]! - n.z) + ring[i]! * 1.2
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        }
        if (best < 0) break
        taken[best] = 1
        n.gslot = true
        n.gx = sx[best]!
        n.gz = sz[best]!
        n.mode = 'gather'
        n.phase = 0
        n.until = until
        n.turning = false
        n.leaving = false
        n.hurry = 0
        routeToPoint(n, n.gx, n.gz)
        n.curNode = -1
        startWalking(n)
        flush(n)
        out.push(n)
      }
      gatherOn = out.length > 0
      gatherUntil = until
      gcx = center.x
      gcz = center.z
      return out
    },

    ungather() {
      ungatherAll()
      for (const n of list) if (n.mode !== 'script') flush(n)
    },

    onPlayerLeave(playerId) {
      // release 가 목록을 건드리지 않으므로(같은 객체 유지) 그대로 순회해도 안전하다
      for (let i = 0; i < list.length; i++) {
        const n = list[i]!
        n.memo.delete(playerId)
        if (n.mode === 'script') continue
        if (n.talker === playerId) endListenSim(n)
        if (n.owner === playerId) releaseSim(n, 'leave')
        flush(n)
      }
      groups.delete(playerId)
    },

    retire(npc) {
      const n = own(npc)
      if (!n || n.mode === 'script' || n.mode === 'leave') return
      const prev = detach(n)
      n.talker = 0
      n.gslot = false
      n.retiring = true
      n.leaving = false
      n.exitNext = false
      n.until = 0
      n.moving = false
      n.running = false
      n.turning = false
      n.hurry = 0
      n.mode = 'leave'
      n.phase = 0
      n.st = WALK
      n.wn = 0
      n.wi = 0
      // 가장 가까운 출구로 걸어 나간다. 출구가 없는 월드면 그 자리에서 사라진다
      const start = nav.n > 0 ? startNode(n) : -1
      const exit = start >= 0 ? pickExit(n, start, true) : -1
      if (exit >= 0) {
        const path = findNavPath(start, exit, world)
        if (path[path.length - 1] === exit) {
          pickSpot(n, exit, 0.5, true)
          buildRoute(n, path, outX, outZ)
          n.dest = exit
        }
      }
      if (n.wn === 0) beginVanish(n)
      else startWalking(n)
      flush(n)
      if (prev) events.onOwnerChange(n, prev, 'replace')
    },

    addScripted(arch, role, name, look, x, z) {
      let id = 0
      for (let i = 1; i <= MAX_ID; i++) {
        if (byId[i] === undefined) {
          id = i
          break
        }
      }
      if (id === 0) return null
      const n = blank(id, arch, name, look, role)
      n.x = x
      n.z = z
      n.mode = 'script'
      n.scripted = true
      remember(n)
      list.push(n)
      byId[id] = n
      // 클라이언트가 새 NPC 를 알 수 있게 등장 이벤트를 낸다
      events.onSpawn(n)
      return n
    },

    removeScripted(npc) {
      const n = own(npc)
      // 일반 시민은 지우지 않는다(방의 시민 수는 일정해야 한다)
      if (!n || !n.scripted) return
      detach(n)
      n.talker = 0
      const i = list.indexOf(n)
      if (i >= 0) list.splice(i, 1)
      byId[n.id] = undefined
    },

    publicOf(npc): NpcPublic {
      return {
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
      }
    },
  }
  return api
}
