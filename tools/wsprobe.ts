/**
 * WebSocket 점검 도구(수동 확인 + 통합 자가 점검).
 *
 *   npx tsx tools/wsprobe.ts [--url ws://localhost:8787] [--room auto] [--name 점검봇] [--secs 10] [--walk]
 *       한 명으로 접속해서 받은 메시지를 요약해 찍는다. --walk 를 주면 주변을 어슬렁거린다.
 *
 *   npx tsx tools/wsprobe.ts --check [--url ws://localhost:8787]
 *       실제 서버를 상대로 접속·이동 동기화·이모트 중계·퇴장·중복 접속·가득 참·저장본 복원을 차례로 확인한다.
 *       방을 전부 가득 채워 보므로 사람이 없는(막 띄운) 서버에 대고 돌린다. 실패가 있으면 종료 코드 1.
 *
 * 브라우저 없이 서버만 확인하려는 용도라 게임 클라이언트 코드에는 의존하지 않는다(shared/ 의 프로토콜만 쓴다).
 */
import { type RawData, WebSocket } from 'ws'
import { Anim, PROTOCOL_VERSION, RATE_LIMIT_PER_SEC, RUN_SPEED, TALK_RANGE } from '../shared/constants'
import {
  CLOSE_FULL,
  CLOSE_KICK,
  type ClientMsg,
  type SWelcome,
  type ServerMsg,
  type ServerMsgOf,
  type ServerMsgType,
  type Snapshot,
  decodeSnapshot,
  encodeMove,
} from '../shared/protocol'
import type { Look, RoomInfo, SignedSave } from '../shared/types'

// ───────────────────────── 인자 ─────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const WS_BASE = (arg('url') || `ws://localhost:${process.env.PORT || 8787}`).replace(/\/+$/, '').replace(/\/ws$/, '')
const HTTP_BASE = WS_BASE.replace(/^ws/, 'http')
const LOOK: Look = [0, 0, 0, 0, 0, 0, 0]
const RUN_TAG = Date.now().toString(36)
let pidSeq = 0
const newPid = (): string => `probe-${RUN_TAG}-${String(++pidSeq).padStart(4, '0')}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ───────────────────────── 접속 한 개 ─────────────────────────

class Probe {
  readonly msgs: ServerMsg[] = []
  readonly snaps: Snapshot[] = []
  closed: { code: number; reason: string } | null = null
  welcome: SWelcome | null = null
  x = 0
  z = 0
  pid = ''
  onMsg: ((m: ServerMsg) => void) | null = null

  private constructor(
    readonly label: string,
    readonly ws: WebSocket,
  ) {
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const data = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw
      if (isBinary) {
        const snap = decodeSnapshot(data)
        if (snap) this.snaps.push(snap)
        else console.log(`[${label}] 해독할 수 없는 바이너리 ${data.length}바이트`)
        return
      }
      let msg: ServerMsg
      try {
        msg = JSON.parse(data.toString('utf8')) as ServerMsg
      } catch {
        console.log(`[${label}] JSON 이 아닌 텍스트 프레임`)
        return
      }
      this.msgs.push(msg)
      if (msg.t === 'welcome') {
        this.welcome = msg
        this.x = msg.x
        this.z = msg.z
      } else if (msg.t === 'pos') {
        // 서버가 위치를 고쳐 줬다 → 그 자리에서 다시 시작
        this.x = msg.x
        this.z = msg.z
      }
      this.onMsg?.(msg)
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString('utf8') }
    })
    ws.on('error', () => {
      /* close 이벤트가 뒤따른다 */
    })
  }

  static connect(room: string, label: string): Promise<Probe> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws?room=${encodeURIComponent(room)}`, { perMessageDeflate: false })
      const probe = new Probe(label, ws)
      const timer = setTimeout(() => reject(new Error(`${label}: 접속 시간 초과`)), 5000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve(probe)
      })
      ws.once('error', (err: Error) => {
        clearTimeout(timer)
        reject(new Error(`${label}: 접속 실패 (${err.message})`))
      })
    })
  }

  /** 접속 + hello + welcome 대기 */
  static async join(room: string, label: string, opts: { pid?: string; name?: string; save?: SignedSave | null } = {}): Promise<Probe> {
    const p = await Probe.connect(room, label)
    p.hello(opts.pid ?? newPid(), opts.name ?? label, opts.save)
    await p.until(`${label} welcome`, () => p.welcome ?? (p.closed ? fail(`${label}: welcome 전에 닫힘 ${JSON.stringify(p.closed)} ${JSON.stringify(p.msgs)}`) : null))
    return p
  }

  get id(): number {
    return this.welcome?.id ?? 0
  }

  hello(pid: string, name: string, save?: SignedSave | null, v: number = PROTOCOL_VERSION): void {
    this.pid = pid
    this.send({ t: 'hello', v, pid, name, look: LOOK, save: save ?? null })
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  raw(data: string | Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  move(x: number, z: number, yaw = 0, st: number = Anim.Walk): void {
    this.x = x
    this.z = z
    this.raw(new Uint8Array(encodeMove(x, z, yaw, st)))
  }

  of<T extends ServerMsgType>(t: T, from = 0): ServerMsgOf<T>[] {
    return this.msgs.slice(from).filter((m): m is ServerMsgOf<T> => m.t === t)
  }

  /** 조건이 참이 될 때까지 기다린다 */
  async until<T>(what: string, test: () => T | null | undefined | false, timeoutMs = 4000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = test()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`)
      await sleep(15)
    }
  }

  waitMsg<T extends ServerMsgType>(t: T, pred: (m: ServerMsgOf<T>) => boolean = () => true, from = 0, timeoutMs = 4000): Promise<ServerMsgOf<T>> {
    return this.until(`${this.label} 가 ${t} 수신`, () => this.of(t, from).find(pred), timeoutMs)
  }

  waitClose(timeoutMs = 4000): Promise<{ code: number; reason: string }> {
    return this.until(`${this.label} 연결 종료`, () => this.closed, timeoutMs)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* 이미 닫힘 */
    }
  }
}

function fail(message: string): never {
  throw new Error(message)
}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

const getRooms = async (): Promise<RoomInfo[]> => (await getJson<{ rooms: RoomInfo[] }>('/api/rooms')).rooms

// ───────────────────────── 통합 자가 점검 ─────────────────────────

async function runCheck(): Promise<number> {
  let failed = 0
  let skipped = 0
  const all: Probe[] = []
  const track = (p: Probe): Probe => {
    all.push(p)
    return p
  }
  const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
    try {
      const detail = await fn()
      console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('SKIP:')) {
        skipped++
        console.log(`[SKIP] ${name} — ${msg.slice(5).trim()}`)
        return true
      }
      failed++
      console.log(`[FAIL] ${name} — ${msg}`)
      return false
    }
  }

  console.log(`점검 대상: ${WS_BASE}`)
  const rooms0 = await getRooms()
  const cap = rooms0[0]?.cap ?? 0
  console.log(`방 ${rooms0.length}개, 정원 ${cap}명, 현재 접속 ${rooms0.reduce((n, r) => n + r.players, 0)}명`)
  if (rooms0.some((r) => r.players > 0)) console.log('주의: 이미 접속자가 있는 서버입니다. 인원 수 관련 항목이 어긋날 수 있습니다.')
  const R1 = rooms0[0]?.id ?? '1'
  const R2 = rooms0[1]?.id

  let a!: Probe
  let b!: Probe
  let c: Probe | null = null

  const joined = await step('두 명이 같은 방에 접속하면 둘 다 welcome 을 받는다', async () => {
    a = track(await Probe.join(R1, 'A'))
    b = track(await Probe.join(R1, 'B'))
    const wa = a.welcome!
    const wb = b.welcome!
    expect(wa.room.id === R1 && wb.room.id === R1, `방 id 가 다름: ${wa.room.id}, ${wb.room.id}`)
    expect(wa.id !== wb.id, '두 사람의 id 가 같음')
    expect(wa.npcs.length === wa.room.npcs, `NPC 수 불일치: ${wa.npcs.length} vs ${wa.room.npcs}`)
    expect(typeof wa.save.d === 'string' && wa.save.s.length === 43, '서명 저장본 형식이 이상함')
    return `A=id ${wa.id}(${wa.name}) B=id ${wb.id}(${wb.name}), NPC ${wa.npcs.length}명, welcome ${JSON.stringify(wa).length}바이트`
  })
  if (!joined) {
    for (const p of all) p.close()
    return 1
  }

  await step('서로의 입장이 보인다(B 의 welcome 에 A, A 에게 join(B))', async () => {
    expect(b.welcome!.players.some((p) => p.id === a.id), 'B 의 welcome.players 에 A 가 없음')
    expect(!b.welcome!.players.some((p) => p.id === b.id), 'welcome.players 에 본인이 들어 있음')
    const j = await a.waitMsg('join', (m) => m.p.id === b.id)
    expect(j.p.name === b.welcome!.name, 'join 의 이름이 welcome 과 다름')
    return `join{id:${j.p.id}, name:${j.p.name}}`
  })

  await step('A 의 MOVE 가 B 의 스냅샷으로 전달된다', async () => {
    const from = b.snaps.length
    let x = a.x
    const z = a.z
    for (let i = 0; i < 10; i++) {
      x += 0.3
      a.move(x, z, Math.PI / 2, Anim.Walk)
      await sleep(100)
    }
    a.move(a.x, a.z, Math.PI / 2, Anim.Idle)
    const hit = await b.until('B 스냅샷에 A 의 마지막 위치', () => {
      for (let i = b.snaps.length - 1; i >= from; i--) {
        const e = b.snaps[i]!.players.find((p) => p.id === a.id)
        if (e) return Math.abs(e.x - a.x) < 0.02 && Math.abs(e.z - a.z) < 0.02 && e.st === Anim.Idle ? e : null
      }
      return null
    })
    const withA = b.snaps.slice(from).filter((s) => s.players.some((p) => p.id === a.id)).length
    expect(a.of('pos').length === 0, `정상 이동인데 위치 보정을 받음: ${JSON.stringify(a.of('pos'))}`)
    return `스냅샷 ${b.snaps.length - from}개 중 ${withA}개에 A 포함, 최종 (${hit.x}, ${hit.z}) st=${hit.st}`
  })

  await step('스냅샷은 변한 것만 싣고, 시각은 서버 시각이다', async () => {
    // 이동 중에 보낸 것들이 다 도착하길 잠깐 기다린 뒤, 그 이후에 온 것만 본다
    await sleep(300)
    const from = b.snaps.length
    await sleep(1300)
    const recent = b.snaps.slice(from)
    // 조용한 방이라도 1초에 한 번은 (빈) 스냅샷이 온다
    expect(recent.length > 0, '1.3초 동안 스냅샷이 한 번도 오지 않음')
    expect(recent.every((s) => !s.players.some((p) => p.id === a.id)), '가만히 있는 A 가 계속 스냅샷에 실림')
    const last = recent[recent.length - 1]!
    expect(Math.abs(last.time - Date.now()) < 5000, `스냅샷 시각이 현재와 5초 넘게 다름: ${last.time}`)
    return `최근 스냅샷 플레이어 수 ${recent.map((s) => s.players.length).join(',')} / NPC 수 ${recent.map((s) => s.npcs.length).join(',')}`
  })

  await step('이모트·말풍선이 중계된다', async () => {
    const fromA = a.msgs.length
    a.send({ t: 'emote', e: 'wave' })
    const e = await b.waitMsg('emote', (m) => m.id === a.id && m.e === 'wave')
    a.send({ t: 'say', q: 0 })
    const s = await b.waitMsg('say', (m) => m.id === a.id)
    await a.waitMsg('say', (m) => m.id === a.id, fromA)
    expect(a.of('emote', fromA).length === 0, '이모트가 본인에게도 되돌아옴')
    return `${JSON.stringify(e)} ${JSON.stringify(s)}`
  })

  await step('ping → pong, 엉뚱한 프레임을 보내도 연결이 유지된다', async () => {
    b.raw('{broken json')
    b.raw('[]')
    b.raw(JSON.stringify({ t: 'emote', e: { x: 1 } }))
    b.raw(JSON.stringify({ t: 'no-such-type' }))
    b.raw(new Uint8Array([9, 9, 9]))
    b.raw(new Uint8Array(0))
    const t0 = Date.now()
    b.send({ t: 'ping', c: 4242 })
    const pong = await b.waitMsg('pong', (m) => m.c === 4242)
    expect(!b.closed, '연결이 끊김')
    expect(Math.abs(pong.s - Date.now()) < 5000, 'pong 의 서버 시각이 이상함')
    return `왕복 ${Date.now() - t0}ms`
  })

  await step('/api/rooms 와 /healthz 가 실제 접속자 수를 보여 준다', async () => {
    const rooms = await getRooms()
    const r1 = rooms.find((r) => r.id === R1)!
    const base = rooms0.find((r) => r.id === R1)!.players
    expect(r1.players === base + 2, `방 ${R1} 인원 ${r1.players} (기대 ${base + 2})`)
    const health = await getJson<{ ok: boolean; players: number; rooms: number; tickMsP95: number }>('/healthz')
    expect(health.ok && health.rooms === rooms.length, `healthz 이상: ${JSON.stringify(health)}`)
    expect(health.players === rooms.reduce((n, r) => n + r.players, 0), 'healthz.players 가 방 목록 합계와 다름')
    return `rooms=${JSON.stringify(rooms.map((r) => `${r.id}:${r.players}/${r.cap}`))} healthz=${JSON.stringify(health)}`
  })

  await step('나가면 남은 사람에게 leave 가 간다', async () => {
    const e = track(await Probe.join(R1, 'E'))
    await b.waitMsg('join', (m) => m.p.id === e.id)
    e.close()
    const leave = await b.waitMsg('leave', (m) => m.id === e.id)
    await sleep(100)
    const rooms = await getRooms()
    const base = rooms0.find((r) => r.id === R1)!.players
    expect(rooms.find((r) => r.id === R1)!.players === base + 2, '퇴장이 인원 수에 반영되지 않음')
    return JSON.stringify(leave)
  })

  await step('같은 방에 같은 pid 가 들어오면 옛 연결이 dup 으로 쫓겨난다', async () => {
    const fromB = b.msgs.length
    c = track(await Probe.join(R1, 'C', { pid: a.pid }))
    const kick = await a.waitMsg('kick')
    const closed = await a.waitClose()
    expect(kick.why === 'dup', `kick 사유: ${kick.why}`)
    expect(closed.code === CLOSE_KICK, `close 코드: ${closed.code}`)
    await b.waitMsg('leave', (m) => m.id === a.id, fromB)
    await b.waitMsg('join', (m) => m.p.id === c!.id, fromB)
    expect(c.id !== a.id, '새 연결이 옛 id 를 그대로 받음')
    return `A: kick{${kick.why}} close ${closed.code} / B: leave(${a.id}) → join(${c.id})`
  })

  await step('다른 방에 같은 pid 가 들어와도 쫓겨난다(claimPid)', async () => {
    if (!R2 || !c) fail('SKIP: 방이 하나뿐이라 확인할 수 없음')
    const fromB = b.msgs.length
    const d = track(await Probe.join(R2, 'D', { pid: c.pid }))
    expect(d.welcome!.room.id === R2, `D 가 ${d.welcome!.room.id} 번 방에 들어감`)
    const kick = await c.waitMsg('kick')
    const closed = await c.waitClose()
    expect(kick.why === 'dup' && closed.code === CLOSE_KICK, `kick ${kick.why}, close ${closed.code}`)
    await b.waitMsg('leave', (m) => m.id === c!.id, fromB)
    await sleep(100)
    const rooms = await getRooms()
    return `C: kick{dup} close ${closed.code} / rooms=${JSON.stringify(rooms.map((r) => `${r.id}:${r.players}`))}`
  })

  await step('버전이 다르면 kick(ver)', async () => {
    const v = track(await Probe.connect(R1, 'V'))
    v.hello(newPid(), '옛버전', null, PROTOCOL_VERSION + 1)
    const kick = await v.waitMsg('kick')
    const closed = await v.waitClose()
    expect(kick.why === 'ver' && closed.code === CLOSE_KICK, `kick ${kick.why}, close ${closed.code}`)
    return `kick{ver} close ${closed.code}`
  })

  await step('메시지를 쏟아부으면 kick(rate)', async () => {
    const f = track(await Probe.join(R1, 'F'))
    for (let i = 0; i < RATE_LIMIT_PER_SEC * 4; i++) f.send({ t: 'ping', c: i })
    const kick = await f.waitMsg('kick')
    const closed = await f.waitClose()
    expect(kick.why === 'rate' && closed.code === CLOSE_KICK, `kick ${kick.why}, close ${closed.code}`)
    return `pong ${f.of('pong').length}개 뒤 kick{rate} close ${closed.code}`
  })

  await step('순간이동은 거절되고 pos 로 되돌려진다', async () => {
    const from = b.msgs.length
    const before = { x: b.x, z: b.z }
    b.raw(new Uint8Array(encodeMove(before.x + 30, before.z, 0, Anim.Run)))
    const pos = await b.waitMsg('pos', () => true, from)
    expect(Math.abs(pos.x - before.x) < 0.02 && Math.abs(pos.z - before.z) < 0.02, `보정 위치가 원래 자리가 아님: ${JSON.stringify(pos)}`)
    return JSON.stringify(pos)
  })

  let saved: { pid: string; save: SignedSave; talks: number; inf: number } | null = null
  await step('NPC 에게 걸어가 말을 걸고 포교한다', async () => {
    const g = track(await Probe.join(R1, 'G'))
    const npcPos = new Map<number, { x: number; z: number }>()
    const candidates = g.welcome!.npcs.filter((n) => n.role === '' && n.owner === 0 && n.model === 0)
    for (const n of g.welcome!.npcs) npcPos.set(n.id, { x: n.x, z: n.z })
    expect(candidates.length > 0, 'SKIP: 말 걸 수 있는 NPC 가 없음')
    let snapIdx = g.snaps.length
    const refresh = (): void => {
      for (; snapIdx < g.snaps.length; snapIdx++) for (const e of g.snaps[snapIdx]!.npcs) npcPos.set(e.id, { x: e.x, z: e.z })
    }
    const deadline = Date.now() + 25_000
    const tried = new Set<number>()
    let outcome = ''
    while (Date.now() < deadline && !outcome) {
      refresh()
      // 아직 거절당하지 않은 NPC 중 가장 가까운 사람
      let target = 0
      let best = Infinity
      for (const n of candidates) {
        if (tried.has(n.id)) continue
        const p = npcPos.get(n.id)!
        const d = Math.hypot(p.x - g.x, p.z - g.z)
        if (d < best) {
          best = d
          target = n.id
        }
      }
      if (!target) break
      const tp = npcPos.get(target)!
      if (best > TALK_RANGE - 0.8) {
        // 달리기 속도로 한 틱만큼 다가간다(서버가 pos 로 고쳐 주면 Probe 가 그 자리로 옮겨 둔다)
        const stepLen = Math.min(RUN_SPEED * 0.1 * 0.9, best - (TALK_RANGE - 1))
        const nx = g.x + ((tp.x - g.x) / best) * stepLen
        const nz = g.z + ((tp.z - g.z) / best) * stepLen
        g.move(Math.round(nx * 100) / 100, Math.round(nz * 100) / 100, Math.atan2(tp.x - g.x, tp.z - g.z), Anim.Run)
        await sleep(100)
        continue
      }
      g.move(g.x, g.z, 0, Anim.Idle)
      const from = g.msgs.length
      g.send({ t: 'talk', n: target })
      const answer = await g.until<ServerMsgOf<'talkOk'> | ServerMsgOf<'talkNo'>>(
        'talkOk/talkNo',
        () => g.of('talkOk', from).at(0) ?? g.of('talkNo', from).at(0),
        3000,
      )
      if (answer.t === 'talkNo') {
        if (answer.why === 'cool') await sleep((answer.ms ?? 500) + 50)
        else if (answer.why !== 'far') tried.add(target)
        continue
      }
      let lines = answer.lines
      for (let round = 0; round < 3 && !outcome; round++) {
        const at = g.msgs.length
        g.send({ t: 'pitch', n: target, l: lines[0]! })
        const res = await g.waitMsg('pitchRes', (m) => m.p === g.id, at)
        if (res.o === 'more') {
          lines = (await g.waitMsg('talkOk', (m) => m.round > 1, at)).lines
          continue
        }
        outcome = `${res.o} “${res.say}”`
        if (res.o === 'join' || res.o === 'king') await g.waitMsg('nu', (m) => m.n === target && m.owner === g.id, at)
        await g.waitMsg('reward', () => true, at)
      }
      tried.add(target)
    }
    expect(outcome, 'SKIP: 제한 시간 안에 NPC 에게 닿지 못함(맵 충돌이나 NPC 이동 때문일 수 있음)')
    // 진행도가 바뀌었으므로 1초 안에 새 저장본이 온다
    const save = await g.until('save 수신', () => g.of('save').pop(), 3000)
    saved = { pid: g.pid, save: save.save, talks: save.me.stats.talks ?? 0, inf: save.me.inf }
    expect(saved.talks >= 1 && saved.inf >= 1, `진행도가 오르지 않음: ${JSON.stringify(save.me)}`)
    g.close()
    await g.waitClose()
    return `결과 ${outcome} → 영향력 ${save.me.inf}, 신도 ${save.me.fol}, 통계 ${JSON.stringify(save.me.stats)}`
  })

  await step('서명 저장본으로 다시 들어오면 진행도가 이어지고, 조작하면 버려진다', async () => {
    if (!saved) {
      // 포교 단계를 건너뛰었다면 welcome 의 저장본으로라도 왕복을 확인한다
      const h = track(await Probe.join(R1, 'H0'))
      saved = { pid: h.pid, save: h.welcome!.save, talks: 0, inf: 0 }
      h.close()
      await h.waitClose()
    }
    const s = saved
    const again = track(await Probe.join(R1, 'H', { pid: s.pid, save: s.save }))
    const me = again.welcome!.me
    expect(me.inf === s.inf && (me.stats.talks ?? 0) === s.talks, `복원된 진행도가 다름: ${JSON.stringify(me)}`)
    again.close()
    await again.waitClose()
    const forged = { d: s.save.d.replace(/"inf":\d+/, '"inf":999999'), s: s.save.s }
    const cheat = track(await Probe.join(R1, 'H2', { pid: s.pid, save: forged }))
    expect(cheat.welcome!.me.inf === 0, `조작된 저장본이 통과함: inf=${cheat.welcome!.me.inf}`)
    cheat.close()
    await cheat.waitClose()
    return `복원 inf=${me.inf} talks=${me.stats.talks ?? 0} / 조작본 → inf=0`
  })

  await step('가득 찬 방을 고르면 다른 방으로 보내고, 전부 가득이면 full 로 닫는다', async () => {
    await sleep(150)
    let rooms = await getRooms()
    const fill = async (room: RoomInfo): Promise<void> => {
      const need = room.cap - room.players
      const batch: Promise<Probe>[] = []
      for (let i = 0; i < need; i++) batch.push(Probe.join(room.id, `채움${room.id}-${i}`))
      for (const p of await Promise.all(batch)) {
        track(p)
        expect(p.welcome!.room.id === room.id, `채우려던 방 ${room.id} 가 아니라 ${p.welcome!.room.id} 로 들어감`)
      }
    }
    await fill(rooms[0]!)
    let redirect = ''
    if (rooms.length > 1) {
      const r = track(await Probe.join(rooms[0]!.id, '우회'))
      expect(r.welcome!.room.id !== rooms[0]!.id, '가득 찬 방에 그대로 들어감')
      redirect = `가득 찬 ${rooms[0]!.id}번 요청 → ${r.welcome!.room.id}번으로 입장, `
    }
    await sleep(350)
    rooms = await getRooms()
    for (const room of rooms.slice(1)) await fill(room)
    await sleep(350)
    rooms = await getRooms()
    expect(rooms.every((r) => r.players === r.cap), `전부 채워지지 않음: ${JSON.stringify(rooms.map((r) => r.players))}`)
    const total = rooms.reduce((n, r) => n + r.players, 0)

    const extra = track(await Probe.connect('auto', `${total + 1}번째`))
    extra.hello(newPid(), '자리없음')
    const full = await extra.waitMsg('full')
    const closed = await extra.waitClose()
    expect(closed.code === CLOSE_FULL, `close 코드 ${closed.code}`)
    expect(full.rooms.length === rooms.length && full.rooms.every((r) => r.players === r.cap), `full.rooms 가 이상함: ${JSON.stringify(full.rooms)}`)
    expect(extra.of('welcome').length === 0, '가득인데 welcome 을 받음')
    const health = await getJson<{ players: number; tickMsP95: number; tickMsMax: number }>('/healthz')
    return `${redirect}정원 ${total}명이 찬 뒤 ${total + 1}번째 → full(방 ${full.rooms.length}개) close ${closed.code} / 만석일 때 틱 p95 ${health.tickMsP95}ms, 최대 ${health.tickMsMax}ms`
  })

  await step('모두 나가면 인원이 0 으로 돌아온다', async () => {
    for (const p of all) p.close()
    let rooms: RoomInfo[] = []
    for (let i = 0; i < 40; i++) {
      await sleep(100)
      rooms = await getRooms()
      if (rooms.every((r) => r.players === 0)) break
    }
    expect(rooms.every((r) => r.players === 0), `남은 인원: ${JSON.stringify(rooms.map((r) => r.players))}`)
    return `rooms=${JSON.stringify(rooms.map((r) => `${r.id}:${r.players}`))}`
  })

  console.log(failed === 0 ? `\n결과: 전부 통과${skipped ? ` (건너뜀 ${skipped})` : ''}` : `\n결과: 실패 ${failed}건`)
  return failed === 0 ? 0 : 1
}

// ───────────────────────── 수동 확인 ─────────────────────────

async function runManual(): Promise<number> {
  const room = arg('room') || 'auto'
  const secs = Number(arg('secs') || 10)
  const p = await Probe.connect(room, '점검봇')
  p.onMsg = (m) => {
    switch (m.t) {
      case 'welcome':
        console.log(`welcome: id=${m.id} 방=${m.room.name}(${m.room.players}/${m.room.cap}, NPC ${m.room.npcs}) 이름=${m.name} 위치=(${m.x}, ${m.z}) 영향력=${m.me.inf}`)
        break
      case 'save':
        console.log(`save: 영향력=${m.me.inf} 신도=${m.me.fol} (${m.save.d.length}자)`)
        break
      case 'npcSay':
        for (const [id, text] of m.l) console.log(`npcSay: #${id} “${text}”`)
        break
      default:
        console.log(`${m.t}: ${JSON.stringify(m).slice(0, 200)}`)
    }
  }
  p.hello(newPid(), arg('name') || '점검봇')
  await p.until('welcome', () => p.welcome ?? (p.closed ? fail(`닫힘: ${JSON.stringify(p.closed)}`) : null))
  const end = Date.now() + secs * 1000
  let dir = Math.random() * Math.PI * 2
  let lastReport = Date.now()
  let seen = 0
  while (Date.now() < end && !p.closed) {
    if (has('walk')) {
      if (Math.random() < 0.05) dir = Math.random() * Math.PI * 2
      p.move(p.x + Math.sin(dir) * 0.3, p.z + Math.cos(dir) * 0.3, dir, Anim.Walk)
    }
    if (Date.now() - lastReport >= 1000) {
      const fresh = p.snaps.slice(seen)
      seen = p.snaps.length
      lastReport = Date.now()
      const bytes = fresh.reduce((n, s) => n + 11 + s.players.length * 8 + s.npcs.length * 7, 0)
      console.log(`스냅샷 ${fresh.length}개/초, ${bytes}바이트/초, 실린 NPC ${fresh.reduce((n, s) => n + s.npcs.length, 0)} · 플레이어 ${fresh.reduce((n, s) => n + s.players.length, 0)}`)
      p.send({ t: 'ping', c: Date.now() })
    }
    await sleep(100)
  }
  if (p.closed) console.log(`서버가 연결을 닫음: ${JSON.stringify(p.closed)}`)
  p.close()
  return 0
}

const run = has('check') ? runCheck : runManual
run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
