/**
 * NPC 시뮬레이션 눈검사 도구.
 *   npx tsx tools/npc-debug.ts [--seed 7] [--minutes 3] [--npcs 28] [--quiet] [--trace]
 *
 * 가짜 플레이어 한 명이 이동망을 따라 돌면서 시민 3명에게 달려가 말을 걸어 신도로 만들고, 한 명은 도망가게 하고,
 * 단상 앞에서 구경꾼을 한 번 모은다(실제 방이 시뮬을 부르는 순서 그대로: beginListen → startFollow / flee, gather).
 * 30초마다 위에서 내려다본 ASCII 지도를 찍고, 끝에 요약 통계(걸은 거리, 모드별 시간, 교체 횟수, dirty 비율 …)를 낸다.
 * 서버를 띄우지 않고 시뮬만 돌리므로 포트를 쓰지 않는다. 좌표는 전부 world 데이터에서 얻으므로 월드가 바뀌어도 그대로 쓴다.
 */
import { createNpcSim } from '../server/core/npcSim'
import type { NpcMode, NpcState, PlayerState } from '../server/core/api'
import {
  Anim,
  FOLLOW_DURATION_MS,
  NPC_RADIUS,
  NPCS_PER_ROOM,
  PLAYER_RADIUS,
  RUN_SPEED,
  TALK_RANGE,
  TALK_TIMEOUT_MS,
  TICK_MS,
  WALK_SPEED,
} from '../shared/constants'
import { mulberry32 } from '../shared/rng'
import { WORLD, findNavPath, nearestNavNode, resolveCollision } from '../shared/world'
import type { WorldDef } from '../shared/world'

function arg(name: string, def: number): number {
  const i = process.argv.indexOf('--' + name)
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : def
}
const SEED = arg('seed', 7)
const MINUTES = arg('minutes', 3)
const NPCS = arg('npcs', NPCS_PER_ROOM)
const QUIET = process.argv.includes('--quiet')
/** --trace: 1초마다 플레이어와 신도의 상태를 한 줄씩 찍는다(줄 서기 디버깅용) */
const TRACE = process.argv.includes('--trace')

const world: WorldDef = WORLD
const rnd = mulberry32(SEED)
const DT = TICK_MS / 1000

function makePlayer(id: number, x: number, z: number): PlayerState {
  return {
    id,
    conn: id,
    pid: 'debug-player-' + id,
    name: '가짜 교주',
    look: [0, 3, 8, 0, 1, 0, 0],
    prog: {
      v: 1,
      pid: 'debug-player-' + id,
      inf: 0,
      fol: 0,
      coins: 0,
      rank: 0,
      stats: {},
      ach: [],
      items: {},
      met: [],
      cult: null,
      cultFol: 0,
      cultInf: 0,
      daily: null,
      ts: 0,
    },
    x,
    z,
    yaw: 0,
    st: Anim.Idle,
    emote: null,
    dirty: false,
    joinedAt: 0,
    lastMsgAt: 0,
    lastMoveAt: 0,
    talk: null,
    cd: new Map(),
    buff: 0,
    buffUntil: 0,
    stunUntil: 0,
    sprintUntil: 0,
    blocked: new Set(),
    mutedUntil: 0,
    saveDirty: false,
    ext: {},
  }
}

// ───────── 통계 ─────────
const stats = {
  spawns: 0,
  says: 0,
  leaveSays: 0,
  owner: {} as Record<string, number>,
  npcTicks: 0,
  dirtyTicks: 0,
  idleDirty: 0,
  outOfBounds: 0,
  inCollider: 0,
  tickMs: [] as number[],
  ticks: 0,
  followerSamples: 0,
  followerDistSum: 0,
  followerDistMin: Infinity,
  followerDistMax: 0,
  fleeEndDist: [] as number[],
  gathered: 0,
  gatherArrived: 0,
  overlapPairTicks: 0,
}
const modeTime: Record<NpcMode, number> = {
  wander: 0,
  pause: 0,
  listen: 0,
  follow: 0,
  flee: 0,
  leave: 0,
  enter: 0,
  gather: 0,
  script: 0,
}
const walked = new Map<number, number>()
const sayLog: string[] = []
/** 직전 틱의 위치(걸은 거리 계산용). 새 시민으로 바뀌면 지운다 */
const prevPos = new Map<number, { x: number; z: number }>()
/** 시뮬 시작부터 흐른 시간(ms) */
let simTime = 0

const sim = createNpcSim(
  world,
  rnd,
  {
    onSpawn(npc) {
      stats.spawns++
      prevPos.delete(npc.id)
    },
    onOwnerChange(_npc, _prev, reason) {
      stats.owner[reason] = (stats.owner[reason] ?? 0) + 1
    },
    onSay(npc, text) {
      stats.says++
      if (npc.arch.leave.includes(text)) stats.leaveSays++
      if (sayLog.length < 400) sayLog.push(`${(simTime / 1000).toFixed(1).padStart(6)}s  #${npc.id} ${npc.name}: ${text}`)
    },
  },
  NPCS,
)

// ───────── 가짜 플레이어 ─────────
const spawn = world.spawns[0] ?? { x: (world.bounds.x0 + world.bounds.x1) / 2, z: (world.bounds.z0 + world.bounds.z1) / 2, yaw: 0 }
const player = makePlayer(1, spawn.x, spawn.z)
const players = new Map<number, PlayerState>([[player.id, player]])

/** 이동망을 한 바퀴 도는 순회 경로: 지금 있는 곳에서 가장 먼 노드로 가기를 반복한다 */
const tour: { x: number; z: number }[] = []
{
  const nodes = world.nav.nodes
  let cur = nearestNavNode(player.x, player.z, world)
  const visited = new Set<number>([cur])
  for (let leg = 0; leg < 12 && nodes.length > 1; leg++) {
    let best = -1
    let bestD = -1
    for (let i = 0; i < nodes.length; i++) {
      if (visited.has(i) || nodes[i]!.kind === 'exit') continue
      const d = Math.hypot(nodes[i]!.x - nodes[cur]!.x, nodes[i]!.z - nodes[cur]!.z)
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) {
      visited.clear()
      continue
    }
    const path = findNavPath(cur, best, world)
    for (const i of path) tour.push({ x: nodes[i]!.x, z: nodes[i]!.z })
    cur = path[path.length - 1]!
    visited.add(cur)
  }
  if (tour.length === 0) tour.push({ x: player.x, z: player.z })
}
let tourI = 0
let running = false

// ───────── 각본 ─────────
const T0 = 1_700_000_000_000
const notes: string[] = []
function note(msg: string): void {
  notes.push(`${(simTime / 1000).toFixed(1).padStart(6)}s  ${msg}`)
}

/**
 * 가짜 플레이어의 행동: 평소엔 순회(tour), 포교하려면 가까운 시민에게 달려가(chase) 말을 걸고(talk)
 * 2초 뒤 결과(합류 또는 도망)를 적용한다 — 실제 방(Room)이 시뮬을 부르는 순서와 같다.
 */
type Outcome = 'join' | 'flee'
const act: { state: 'tour' | 'chase' | 'talk'; npc: NpcState | null; outcome: Outcome; until: number } = {
  state: 'tour',
  npc: null,
  outcome: 'join',
  until: 0,
}
/** 도망 관찰 대상 */
const watch: { flee: { npc: NpcState; fx: number; fz: number } | null } = { flee: null }
let gatherList: NpcState[] = []
let gatherCenter = { x: 0, z: 0 }
let gatherRadius = 0

function nearestNpc(filter: (n: NpcState) => boolean): NpcState | null {
  let best: NpcState | null = null
  let bestD = Infinity
  for (const n of sim.list) {
    if (!filter(n)) continue
    const d = Math.hypot(n.x - player.x, n.z - player.z)
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return best
}

function approach(outcome: Outcome, now: number): void {
  const npc = nearestNpc((n) => n.owner === 0 && n.model === 0 && sim.canTalk(n, player.id, now) === 'ok')
  if (!npc) return
  act.state = 'chase'
  act.npc = npc
  act.outcome = outcome
  act.until = now + 15_000
}

function stepToward(x: number, z: number, speed: number): number {
  const dx = x - player.x
  const dz = z - player.z
  const d = Math.hypot(dx, dz)
  if (d < 1e-6) return 0
  const step = Math.min(speed * DT, d)
  player.x += (dx / d) * step
  player.z += (dz / d) * step
  player.yaw = Math.atan2(dx, dz)
  return d - step
}

function movePlayer(now: number): void {
  const npc = act.npc
  if (act.state === 'chase' && npc) {
    if (now > act.until || sim.canTalk(npc, player.id, now) !== 'ok') {
      act.state = 'tour'
    } else if (
      // 이미 말 걸 거리 안이면 더 다가가지 않는다(NPC 위에 올라서지 않게)
      Math.hypot(npc.x - player.x, npc.z - player.z) <= TALK_RANGE - 0.6 ||
      stepToward(npc.x, npc.z, RUN_SPEED) <= TALK_RANGE - 0.6
    ) {
      // 말 걸기: NPC 가 멈춰 서서 플레이어를 본다
      sim.beginListen(npc, player, now + TALK_TIMEOUT_MS)
      act.state = 'talk'
      act.until = now + 2000
      note(`말 걸기 → #${npc.id} ${npc.name} (거리 ${Math.hypot(npc.x - player.x, npc.z - player.z).toFixed(1)}m)`)
    }
    resolveCollision(player, PLAYER_RADIUS, false, world)
    player.st = act.state === 'chase' ? Anim.Run : Anim.Idle
    return
  }
  if (act.state === 'talk' && npc) {
    player.st = Anim.Idle
    if (now < act.until) return
    if (act.outcome === 'join') {
      sim.startFollow(npc, player.id, now + FOLLOW_DURATION_MS, now)
      note(`합류 → #${npc.id} ${npc.name} (동행 ${sim.followersOf(player.id).length}명)`)
    } else {
      sim.flee(npc, player.x, player.z, now)
      watch.flee = { npc, fx: player.x, fz: player.z }
      note(`도망 → #${npc.id} ${npc.name}`)
    }
    act.state = 'tour'
    act.npc = null
    return
  }
  const speed = running ? RUN_SPEED : WALK_SPEED
  let budget = speed * DT
  for (let guard = 0; guard < 8 && budget > 1e-6; guard++) {
    const t = tour[tourI % tour.length]!
    const d = Math.hypot(t.x - player.x, t.z - player.z)
    if (d < 0.05) {
      tourI++
      // 구간마다 걷기/달리기를 번갈아 한다
      if (tourI % 5 === 0) running = !running
      continue
    }
    const before = d
    const left = stepToward(t.x, t.z, budget / DT)
    budget -= before - left
  }
  resolveCollision(player, PLAYER_RADIUS, false, world)
  player.st = running ? Anim.Run : Anim.Walk
}

interface Cue {
  at: number
  run: (now: number) => void
  done?: boolean
}
const cues: Cue[] = [
  { at: 8, run: (now) => approach('join', now) },
  { at: 20, run: (now) => approach('join', now) },
  { at: 32, run: (now) => approach('join', now) },
  { at: 70, run: (now) => approach('flee', now) },
  {
    at: 95,
    run(now) {
      gatherCenter = { x: world.podium.x, z: world.podium.z }
      gatherRadius = world.podium.r + world.podium.ramp
      gatherList = sim.gather(gatherCenter, gatherRadius, now + 26_000, 8)
      stats.gathered = gatherList.length
      note(`구경 모으기(단상) → ${gatherList.length}명: ${gatherList.map((n) => '#' + n.id).join(' ')}`)
    },
  },
  {
    at: 118,
    run() {
      for (const n of gatherList) {
        const d = Math.hypot(n.x - gatherCenter.x, n.z - gatherCenter.z)
        if (n.mode === 'gather' && d >= gatherRadius + 1.5 && d <= gatherRadius + 6.5) stats.gatherArrived++
      }
      note(`구경 자리 도착 ${stats.gatherArrived}/${gatherList.length}`)
    },
  },
]

// ───────── ASCII 지도 ─────────
const GLYPH: Record<NpcMode, string> = {
  wander: 'w',
  pause: 'p',
  listen: 'L',
  follow: 'f',
  flee: '!',
  leave: 'x',
  enter: '+',
  gather: 'g',
  script: 'S',
}

function drawMap(): string {
  const b = world.bounds
  const W = Math.ceil(b.x1 - b.x0)
  const ROW = 2 // 세로는 2m 를 한 줄로(글자가 세로로 길어서)
  const H = Math.ceil((b.z1 - b.z0) / ROW)
  const g: string[][] = []
  for (let r = 0; r < H; r++) g.push(new Array<string>(W).fill(' '))
  const put = (x: number, z: number, ch: string): void => {
    const c = Math.floor(x - b.x0)
    const r = Math.floor((z - b.z0) / ROW)
    if (r >= 0 && r < H && c >= 0 && c < W) g[r]![c] = ch
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x = b.x0 + c + 0.5
      const z = b.z0 + r * ROW + ROW / 2
      if (world.boxes.some((bx) => x >= bx.x0 && x <= bx.x1 && z >= bx.z0 && z <= bx.z1)) g[r]![c] = '#'
      else if (world.circles.some((ci) => Math.hypot(x - ci.x, z - ci.z) <= ci.r)) g[r]![c] = 'o'
      else if (Math.hypot(x - world.podium.x, z - world.podium.z) <= world.podium.r) g[r]![c] = '='
    }
  }
  for (const nd of world.nav.nodes) put(nd.x, nd.z, nd.kind === 'exit' ? 'E' : '.')
  put(world.subway.x, world.subway.z, 'U')
  for (const n of sim.list) put(n.x, n.z, n.mode === 'gather' && n.st === Anim.Cheer ? 'G' : GLYPH[n.mode])
  put(player.x, player.z, '@')
  const border = '+' + '-'.repeat(W) + '+'
  return [border, ...g.map((row) => '|' + row.join('') + '|'), border].join('\n')
}

function snapshotLine(): string {
  const counts: Record<string, number> = {}
  for (const n of sim.list) counts[n.mode] = (counts[n.mode] ?? 0) + 1
  return Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

// ───────── 검사 ─────────
function outside(n: NpcState): { bounds: boolean; collider: boolean } {
  const b = world.bounds
  const r = NPC_RADIUS
  const eps = 0.02
  const bounds = n.x < b.x0 + r - eps || n.x > b.x1 - r + eps || n.z < b.z0 + r - eps || n.z > b.z1 - r + eps
  let collider = false
  for (const bx of world.boxes) {
    const cx = Math.max(bx.x0, Math.min(bx.x1, n.x))
    const cz = Math.max(bx.z0, Math.min(bx.z1, n.z))
    if (Math.hypot(n.x - cx, n.z - cz) < r - eps) collider = true
  }
  for (const c of world.circles) if (Math.hypot(n.x - c.x, n.z - c.z) < c.r + r - eps) collider = true
  return { bounds, collider }
}

// ───────── 실행 ─────────
const totalTicks = Math.round((MINUTES * 60_000) / TICK_MS)
const lastQ = new Map<number, string>()
if (!QUIET) {
  console.log(`seed=${SEED} npcs=${NPCS} minutes=${MINUTES} world: nodes=${world.nav.nodes.length} boxes=${world.boxes.length} circles=${world.circles.length}`)
  console.log('범례: w 배회 · p 정지 · L 대화 · f 신도 · ! 도망 · x 퇴장 · + 등장 · g/G 구경(G=환호) · @ 플레이어 · E 출구 · U 지하철 · # 벽 · = 단상')
}

for (let tick = 0; tick <= totalTicks; tick++) {
  simTime = tick * TICK_MS
  const now = T0 + simTime
  const sec = simTime / 1000

  for (const cue of cues) {
    if (!cue.done && sec >= cue.at) {
      cue.done = true
      cue.run(now)
    }
  }
  movePlayer(now)

  // Room 처럼: 직전 스냅샷을 보낸 뒤 dirty 를 내린 상태에서 틱을 돈다
  for (const n of sim.list) n.dirty = false
  const t0 = performance.now()
  sim.tick(now, DT, players)
  const ms = performance.now() - t0
  stats.tickMs.push(ms)
  stats.ticks++

  for (const n of sim.list) {
    stats.npcTicks++
    modeTime[n.mode] += DT
    if (n.dirty) stats.dirtyTicks++
    const q = `${Math.round(n.x * 100)},${Math.round(n.z * 100)},${Math.round((((n.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 256) & 255},${n.st}`
    if (lastQ.get(n.id) === q && n.dirty) stats.idleDirty++
    lastQ.set(n.id, q)
    const prev = prevPos.get(n.id)
    if (prev) {
      walked.set(n.id, (walked.get(n.id) ?? 0) + Math.hypot(n.x - prev.x, n.z - prev.z))
      prev.x = n.x
      prev.z = n.z
    } else prevPos.set(n.id, { x: n.x, z: n.z })
    const o = outside(n)
    if (o.bounds) stats.outOfBounds++
    if (o.collider) stats.inCollider++
    if (n.mode === 'follow' && n.owner === player.id && now - n.followSince > 3000) {
      const d = Math.hypot(n.x - player.x, n.z - player.z)
      stats.followerSamples++
      stats.followerDistSum += d
      if (d < stats.followerDistMin) stats.followerDistMin = d
      if (d > stats.followerDistMax) stats.followerDistMax = d
    }
  }
  // 걷는 시민끼리 겹쳐 지나가는 순간(0.5m 미만)을 센다 — 비켜 가기가 잘 되는지 보는 지표
  for (let i = 0; i < sim.list.length; i++) {
    const a = sim.list[i]!
    if (a.mode !== 'wander') continue
    for (let j = i + 1; j < sim.list.length; j++) {
      const c = sim.list[j]!
      if (c.mode !== 'wander') continue
      if (Math.hypot(a.x - c.x, a.z - c.z) < 0.5) stats.overlapPairTicks++
    }
  }
  const fw = watch.flee
  if (fw && fw.npc.mode !== 'flee') {
    const d = Math.hypot(fw.npc.x - fw.fx, fw.npc.z - fw.fz)
    stats.fleeEndDist.push(d)
    note(`도망 끝 → #${fw.npc.id} 위협에서 ${d.toFixed(1)}m`)
    watch.flee = null
  }

  if (TRACE && tick % Math.round(1000 / TICK_MS) === 0) {
    const fs = sim
      .followersOf(player.id)
      .map((n) => `#${n.id} ${n.mode}/${n.st} ${Math.hypot(n.x - player.x, n.z - player.z).toFixed(1)}m`)
      .join(' | ')
    console.log(`${sec.toFixed(0).padStart(4)}s @(${player.x.toFixed(1)},${player.z.toFixed(1)}) st=${player.st}  ${fs}`)
  }
  if (!QUIET && tick % Math.round(30_000 / TICK_MS) === 0) {
    console.log(`\n── t=${sec.toFixed(0)}s  ${snapshotLine()}  동행=${sim.followersOf(player.id).length}`)
    console.log(drawMap())
  }
}

// ───────── 요약 ─────────
const dists = sim.list.map((n) => walked.get(n.id) ?? 0)
const sum = dists.reduce((a, b) => a + b, 0)
const totalModeTime = Object.values(modeTime).reduce((a, b) => a + b, 0) || 1
console.log('\n══ 각본 기록')
for (const l of notes) console.log(l)
if (!QUIET) {
  console.log('\n══ 말풍선(처음 12개)')
  for (const l of sayLog.slice(0, 12)) console.log(l)
}
console.log('\n══ 요약')
console.log(`시뮬 시간 ${MINUTES}분 · NPC ${sim.list.length}명 · 틱 ${stats.ticks}회`)
console.log(
  `걸은 거리(id별 m): ${sim.list.map((n) => `#${n.id}:${(walked.get(n.id) ?? 0).toFixed(0)}`).join(' ')}`,
)
console.log(`걸은 거리 합계 ${sum.toFixed(0)}m · 평균 ${(sum / Math.max(1, dists.length)).toFixed(0)}m · 최소 ${Math.min(...dists).toFixed(0)}m · 최대 ${Math.max(...dists).toFixed(0)}m`)
console.log(
  '모드별 시간 비율: ' +
    (Object.keys(modeTime) as NpcMode[])
      .filter((m) => modeTime[m] > 0)
      .map((m) => `${m} ${((modeTime[m] / totalModeTime) * 100).toFixed(1)}%`)
      .join(' · '),
)
console.log(`교체(onSpawn) ${stats.spawns}회 · 주인 변경 ${JSON.stringify(stats.owner)}`)
console.log(`말풍선 ${stats.says}회(평균 ${(MINUTES * 60 / Math.max(1, stats.says)).toFixed(1)}초에 1번) · 그중 떠나는 말 ${stats.leaveSays}회`)
console.log(`dirty 비율 ${((stats.dirtyTicks / Math.max(1, stats.npcTicks)) * 100).toFixed(1)}% (NPC·틱 ${stats.npcTicks} 중 ${stats.dirtyTicks}) · 값이 그대로인데 dirty 인 경우 ${stats.idleDirty}`)
console.log(`경계 밖 ${stats.outOfBounds} · 충돌체 안 ${stats.inCollider} · 걷는 시민끼리 겹침(0.5m 미만) ${stats.overlapPairTicks} 쌍·틱`)
if (stats.followerSamples > 0) {
  console.log(
    `신도-주인 거리(합류 3초 뒤부터): 평균 ${(stats.followerDistSum / stats.followerSamples).toFixed(2)}m · 최소 ${stats.followerDistMin.toFixed(2)}m · 최대 ${stats.followerDistMax.toFixed(2)}m`,
  )
}
console.log(`도망 종료 거리: ${stats.fleeEndDist.map((d) => d.toFixed(1) + 'm').join(', ') || '없음'} · 구경 ${stats.gatherArrived}/${stats.gathered}명 자리 도착`)
// 앞부분은 JIT 예열이라 느리다 → 중앙값이 평소 값에 가깝다
const sorted = stats.tickMs.slice().sort((a, b) => a - b)
const pct = (q: number): string => ((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) * 1000).toFixed(1)
console.log(`틱 시간(NPC ${sim.list.length}명 한 틱): 중앙값 ${pct(0.5)}µs · p95 ${pct(0.95)}µs · 최대 ${pct(1)}µs`)
