/**
 * 방 하나의 틱 비용과 스냅샷 크기를 잰다: 실제 Room + 실제 NPC 시뮬 + DEFAULT_SYSTEMS, 플레이어 20명이 계속 걸어 다닌다.
 *   npx tsx tests/r2bal/tickbench.ts [seconds=180] [players=20]
 *   NPC_MAX=28 이면 시민 수를 28 로 고정(시민 수 조절 전과 비교용)
 * 앞 60초는 시민이 다 들어오기를 기다리는 예열이고 그 뒤만 잰다.
 */
import { Anim, PROTOCOL_VERSION, TICK_MS, WALK_SPEED, PLAYER_RADIUS } from '../../shared/constants'
import { encodeMove } from '../../shared/protocol'
import { WORLD, resolveCollision } from '../../shared/world'
import { Room } from '../../server/core/room'
import { DEFAULT_SYSTEMS } from '../../server/core/systems'
import { FakeHost, LOOK0 } from '../unit/helpers'

const SECONDS = Number(process.argv[2] ?? 180)
const PLAYERS = Number(process.argv[3] ?? 20)
const WARM_MS = 60_000

const host = new FakeHost()
const room = new Room(host, {
  id: '1',
  name: 'bench',
  capacity: 20,
  npcCount: 28,
  ...(process.env.NPC_MAX ? { npcMax: Number(process.env.NPC_MAX) } : {}),
  seed: 42,
  world: WORLD,
  systems: [...DEFAULT_SYSTEMS],
} as ConstructorParameters<typeof Room>[1])

let seed = 7
const rnd = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296
}
interface B { conn: number; id: number; x: number; z: number; dx: number; dz: number; until: number }
const bots: B[] = []
for (let i = 0; i < PLAYERS; i++) {
  const conn = i + 1
  room.connect(conn)
  room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid: `bench-${i}-xxxxxxxx`, name: `벤치${i}`, look: LOOK0, save: null }))
  const w = host.of(conn, 'welcome')[0]!
  bots.push({ conn, id: w.id, x: w.x, z: w.z, dx: 0, dz: 0, until: 0 })
}

const times: number[] = []
let bytes = 0
let snaps = 0
const total = WARM_MS + SECONDS * 1000
for (let ms = 0; ms < total; ms += TICK_MS) {
  host.t += TICK_MS
  for (const b of bots) {
    const p = room.players.get(b.id)
    if (!p) continue
    // 서버가 보정한 자리를 따른다
    b.x = p.x
    b.z = p.z
    if (host.t > b.until) {
      const a = rnd() * Math.PI * 2
      b.dx = Math.sin(a)
      b.dz = Math.cos(a)
      b.until = host.t + 1500 + rnd() * 3500
    }
    const pos = { x: b.x + (b.dx * WALK_SPEED * TICK_MS) / 1000, z: b.z + (b.dz * WALK_SPEED * TICK_MS) / 1000 }
    resolveCollision(pos, PLAYER_RADIUS, false)
    if (Math.hypot(pos.x - b.x, pos.z - b.z) < 0.1) b.until = 0
    room.message(b.conn, encodeMove(pos.x, pos.z, Math.atan2(b.dx, b.dz), Anim.Walk))
    if (ms % 10_000 === 0) room.message(b.conn, JSON.stringify({ t: 'ping', c: ms }))
  }
  const t0 = performance.now()
  room.tick()
  const dt = performance.now() - t0
  if (ms >= WARM_MS) {
    times.push(dt)
    for (const f of host.frames.get(bots[0]!.conn) ?? []) {
      bytes += typeof f === 'string' ? Buffer.byteLength(f) : f.byteLength
      if (typeof f !== 'string') snaps++
    }
  }
  host.frames.clear()
}
times.sort((a, b) => a - b)
const mean = times.reduce((a, b) => a + b, 0) / times.length
const pct = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))]!
console.log(
  JSON.stringify({
    players: room.players.size,
    npcs: room.npcs.list.length,
    population: room.npcs.population?.(),
    tickMeanMs: +mean.toFixed(3),
    tickP95Ms: +pct(0.95).toFixed(3),
    tickP99Ms: +pct(0.99).toFixed(3),
    recvKBpsPerClient: +(bytes / 1024 / SECONDS).toFixed(2),
    snapshotsPerSec: +(snaps / SECONDS).toFixed(1),
  }),
)
