/**
 * 부하 테스트: 실제 프로토콜로 접속하는 봇 클라이언트를 여러 방에 넣고 서버 상태를 잰다.
 *
 *   npm run loadtest -- --url ws://localhost:8830 --rooms 3 --bots 20 --seconds 60 [--ramp 10] [--out report.json]
 *
 * 봇이 하는 일(사람과 같은 메시지를 보낸다): hello → 10Hz 이동(충돌 처리 포함 무작위 걷기) → 가끔 이모트 →
 * 가까운 NPC 에게 말 걸기/멘트 선택 → 4초마다 ping.
 * 재는 것: 접속 성공/실패/내보내짐, 봇 1명당 송수신 메시지·바이트, 스냅샷 수신율, ping 왕복 시간,
 *          서버 /healthz 의 틱 시간(p95/최대)·메모리·CPU.
 *
 * 봇은 어디까지나 시험용 클라이언트다. 남의 서버를 두드리지 않도록 localhost 가 아니면 실행을 거부한다
 * (자기 서버라면 --i-own-this-server 를 붙인다).
 */
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import { Anim, CLIENT_SEND_HZ, PLAYER_RADIUS, PROTOCOL_VERSION, TALK_RANGE, WALK_SPEED } from '../shared/constants'
import { type ServerMsg, decodeSnapshot, encodeMove } from '../shared/protocol'
import { mulberry32 } from '../shared/rng'
import { WORLD, resolveCollision } from '../shared/world'

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  return v === undefined || v.startsWith('--') ? def : v
}
const flag = (name: string): boolean => process.argv.includes('--' + name)

const URL_BASE = arg('url', 'ws://localhost:8787').replace(/\/+$/, '')
const ROOMS = Math.max(1, Number(arg('rooms', '3')))
const BOTS_PER_ROOM = Math.max(1, Number(arg('bots', '20')))
const SECONDS = Math.max(5, Number(arg('seconds', '60')))
const RAMP = Math.max(0, Number(arg('ramp', '10')))
const OUT = arg('out', '')
const TOTAL = ROOMS * BOTS_PER_ROOM

const host = new URL(URL_BASE.replace(/^ws/, 'http')).hostname
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && !flag('i-own-this-server')) {
  console.error(`[loadtest] ${host} 는 localhost 가 아닙니다. 직접 운영하는 서버라면 --i-own-this-server 를 붙이세요.`)
  process.exit(2)
}
const HTTP_BASE = URL_BASE.replace(/^ws/, 'http')

interface Stats {
  opened: number
  welcomed: number
  failed: number
  kicked: Record<string, number>
  full: number
  closedEarly: number
  sentMsgs: number
  sentBytes: number
  recvMsgs: number
  recvBytes: number
  snapshots: number
  snapshotBytes: number
  posCorrections: number
  talks: number
  pitches: number
  joins: number
  rtts: number[]
}
const stats: Stats = {
  opened: 0, welcomed: 0, failed: 0, kicked: {}, full: 0, closedEarly: 0, sentMsgs: 0, sentBytes: 0, recvMsgs: 0, recvBytes: 0,
  snapshots: 0, snapshotBytes: 0, posCorrections: 0, talks: 0, pitches: 0, joins: 0, rtts: [],
}
let stopping = false
let measuring = false

class Bot {
  ws: WebSocket | null = null
  id = 0
  x = 0
  z = 0
  yaw = 0
  dirX = 1
  dirZ = 0
  until = 0
  alive = false
  talking = false
  talkAt = 0
  npcs = new Map<number, { x: number; z: number; owner: number }>()
  rnd: () => number
  timers: ReturnType<typeof setInterval>[] = []

  constructor(
    readonly index: number,
    readonly room: number,
  ) {
    this.rnd = mulberry32(1000 + index * 7919)
  }

  start(): void {
    const ws = new WebSocket(`${URL_BASE}/ws?room=${this.room}`, { perMessageDeflate: false })
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.on('open', () => {
      stats.opened++
      this.send({ t: 'hello', v: PROTOCOL_VERSION, pid: `loadtest-bot-${String(this.index).padStart(6, '0')}`, name: `봇${this.index}`, look: [this.index % 6, this.index % 4, this.index % 12, 0, 0, 0, 0] })
    })
    ws.on('message', (data: ArrayBuffer | Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer)
        if (measuring) {
          stats.recvMsgs++
          stats.recvBytes += buf.byteLength
          stats.snapshots++
          stats.snapshotBytes += buf.byteLength
        }
        const snap = decodeSnapshot(buf)
        if (snap) for (const n of snap.npcs) {
          const cur = this.npcs.get(n.id)
          if (cur) {
            cur.x = n.x
            cur.z = n.z
          }
        }
        return
      }
      const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      if (measuring) {
        stats.recvMsgs++
        stats.recvBytes += Buffer.byteLength(text)
      }
      let msg: ServerMsg
      try {
        msg = JSON.parse(text) as ServerMsg
      } catch {
        return
      }
      this.onMsg(msg)
    })
    ws.on('close', () => {
      if (this.alive && !stopping) stats.closedEarly++
      this.stop()
    })
    ws.on('error', () => {
      if (!this.alive) stats.failed++
    })
  }

  send(msg: object): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const text = JSON.stringify(msg)
    ws.send(text)
    if (measuring) {
      stats.sentMsgs++
      stats.sentBytes += Buffer.byteLength(text)
    }
  }

  onMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.alive = true
        this.id = msg.id
        this.x = msg.x
        this.z = msg.z
        stats.welcomed++
        for (const n of msg.npcs) this.npcs.set(n.id, { x: n.x, z: n.z, owner: n.owner })
        this.timers.push(setInterval(() => this.step(), 1000 / CLIENT_SEND_HZ))
        this.timers.push(setInterval(() => this.send({ t: 'ping', c: Date.now() }), 4000))
        this.timers.push(setInterval(() => this.act(), 3000 + Math.floor(this.rnd() * 3000)))
        break
      case 'pong':
        if (measuring) stats.rtts.push(Date.now() - msg.c)
        break
      case 'kick':
        stats.kicked[msg.why] = (stats.kicked[msg.why] ?? 0) + 1
        break
      case 'full':
        stats.full++
        break
      case 'pos':
        this.x = msg.x
        this.z = msg.z
        if (measuring) stats.posCorrections++
        break
      case 'npcSpawn':
        this.npcs.set(msg.n.id, { x: msg.n.x, z: msg.n.z, owner: msg.n.owner })
        break
      case 'nu': {
        const n = this.npcs.get(msg.n)
        if (n && msg.owner !== undefined) n.owner = msg.owner
        break
      }
      case 'talkOk':
        this.talking = true
        if (measuring) stats.talks++
        // 사람처럼 잠깐 고민한 뒤 첫 멘트를 고른다
        setTimeout(() => {
          if (!this.alive) return
          this.send({ t: 'pitch', n: msg.n, l: msg.lines[Math.floor(this.rnd() * msg.lines.length)] })
          if (measuring) stats.pitches++
        }, 600 + Math.floor(this.rnd() * 900))
        break
      case 'pitchRes':
        if (msg.p === this.id) {
          if (measuring && (msg.o === 'join' || msg.o === 'king')) stats.joins++
          if (msg.o !== 'more') this.talking = false
        }
        break
      case 'talkEnd':
      case 'talkNo':
        this.talking = false
        break
      default:
        break
    }
  }

  /** 10Hz: 무작위 걷기(가끔 방향 전환, 가끔 서 있기) */
  step(): void {
    if (!this.alive || this.talking) return
    const now = Date.now()
    if (now > this.until) {
      const a = this.rnd() * Math.PI * 2
      const pause = this.rnd() < 0.25
      this.dirX = pause ? 0 : Math.sin(a)
      this.dirZ = pause ? 0 : Math.cos(a)
      this.until = now + 1500 + Math.floor(this.rnd() * 3500)
      if (pause) this.sendMove(Anim.Idle)
    }
    if (this.dirX === 0 && this.dirZ === 0) return
    const dt = 1 / CLIENT_SEND_HZ
    const pos = { x: this.x + this.dirX * WALK_SPEED * dt, z: this.z + this.dirZ * WALK_SPEED * dt }
    resolveCollision(pos, PLAYER_RADIUS, false)
    // 벽에 막혔으면 다음 스텝에 방향을 바꾼다
    if (Math.hypot(pos.x - this.x, pos.z - this.z) < WALK_SPEED * dt * 0.4) this.until = 0
    this.x = pos.x
    this.z = pos.z
    this.yaw = Math.atan2(this.dirX, this.dirZ)
    this.sendMove(Anim.Walk)
  }

  sendMove(st: number): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const buf = encodeMove(this.x, this.z, this.yaw, st)
    ws.send(buf)
    if (measuring) {
      stats.sentMsgs++
      stats.sentBytes += buf.byteLength
    }
  }

  /** 몇 초에 한 번: 이모트 또는 가까운 시민에게 말 걸기 */
  act(): void {
    if (!this.alive || this.talking) return
    if (this.rnd() < 0.4) {
      this.send({ t: 'emote', e: ['wave', 'bow', 'dance', 'pray'][Math.floor(this.rnd() * 4)] })
      return
    }
    let best = 0
    let bd = TALK_RANGE * TALK_RANGE
    for (const [id, n] of this.npcs) {
      if (n.owner === this.id) continue
      const d = (n.x - this.x) * (n.x - this.x) + (n.z - this.z) * (n.z - this.z)
      if (d < bd) {
        bd = d
        best = id
      }
    }
    if (best) this.send({ t: 'talk', n: best })
  }

  stop(): void {
    this.alive = false
    for (const t of this.timers.splice(0)) clearInterval(t)
  }
}

interface Health {
  tickMsP95?: number
  tickMsMax?: number
  players?: number
  rooms?: number
  conns?: number
  rssMb?: number
  heapMb?: number
  cpuMs?: number
  uptime?: number
}
async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${HTTP_BASE}/healthz`)
    return res.ok ? ((await res.json()) as Health) : null
  } catch {
    return null
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

async function main(): Promise<void> {
  const before = await health()
  if (!before) {
    console.error(`[loadtest] ${HTTP_BASE}/healthz 에 연결할 수 없습니다. 서버를 먼저 띄우세요.`)
    process.exit(1)
  }
  console.log(`[loadtest] 방 ${ROOMS}개 × 봇 ${BOTS_PER_ROOM}명 = ${TOTAL}명, 측정 ${SECONDS}초, 투입 ${RAMP}초 (서버 방 ${before.rooms ?? '?'}개)`)
  const bots: Bot[] = []
  for (let i = 0; i < TOTAL; i++) bots.push(new Bot(i, (i % ROOMS) + 1))
  const gap = TOTAL > 0 ? (RAMP * 1000) / TOTAL : 0
  for (const b of bots) {
    b.start()
    if (gap > 0) await sleep(gap)
  }
  await sleep(2500)
  const cpu0 = (await health())?.cpuMs ?? 0
  measuring = true
  const t0 = Date.now()
  const ticks: number[] = []
  const tickMax: number[] = []
  let peakRss = 0
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(2000)
    const h = await health()
    if (h) {
      if (typeof h.tickMsP95 === 'number') ticks.push(h.tickMsP95)
      if (typeof h.tickMsMax === 'number') tickMax.push(h.tickMsMax)
      if (typeof h.rssMb === 'number') peakRss = Math.max(peakRss, h.rssMb)
    }
    const alive = bots.filter((b) => b.alive).length
    process.stdout.write(`\r[loadtest] ${Math.round((Date.now() - t0) / 1000)}s  접속 ${alive}/${TOTAL}  틱 p95 ${h?.tickMsP95?.toFixed(2) ?? '?'}ms  `)
  }
  measuring = false
  const elapsed = (Date.now() - t0) / 1000
  const after = await health()
  const alive = bots.filter((b) => b.alive).length
  stopping = true
  for (const b of bots) {
    b.stop()
    b.ws?.close()
  }
  await sleep(500)

  const rtts = stats.rtts.slice().sort((a, b) => a - b)
  const perBot = Math.max(1, alive)
  const cpuMs = (after?.cpuMs ?? 0) - cpu0
  const report = {
    config: { url: URL_BASE, rooms: ROOMS, botsPerRoom: BOTS_PER_ROOM, total: TOTAL, seconds: Math.round(elapsed), ramp: RAMP },
    connections: { opened: stats.opened, welcomed: stats.welcomed, aliveAtEnd: alive, failed: stats.failed, full: stats.full, kicked: stats.kicked, closedEarly: stats.closedEarly },
    server: {
      tickMsP95: ticks.length ? Math.max(...ticks) : null,
      tickMsMax: tickMax.length ? Math.max(...tickMax) : null,
      rssMbPeak: peakRss || null,
      cpuPercentOfOneCore: cpuMs > 0 ? Math.round((cpuMs / (elapsed * 1000)) * 1000) / 10 : null,
      players: after?.players ?? null,
    },
    perClient: {
      recvKBps: Math.round((stats.recvBytes / perBot / elapsed / 1024) * 100) / 100,
      sentKBps: Math.round((stats.sentBytes / perBot / elapsed / 1024) * 100) / 100,
      recvMsgsPerSec: Math.round((stats.recvMsgs / perBot / elapsed) * 10) / 10,
      snapshotsPerSec: Math.round((stats.snapshots / perBot / elapsed) * 10) / 10,
      avgSnapshotBytes: stats.snapshots ? Math.round(stats.snapshotBytes / stats.snapshots) : 0,
    },
    total: { outboundMbps: Math.round(((stats.recvBytes * 8) / elapsed / 1e6) * 100) / 100 },
    ping: { samples: rtts.length, p50: pct(rtts, 0.5), p95: pct(rtts, 0.95), p99: pct(rtts, 0.99) },
    gameplay: { talks: stats.talks, pitches: stats.pitches, joins: stats.joins, posCorrections: stats.posCorrections },
  }
  console.log('\n' + JSON.stringify(report, null, 2))
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2))
  const ok = report.connections.welcomed === TOTAL && report.connections.closedEarly === 0
  process.exit(ok ? 0 : 1)
}

void main()
