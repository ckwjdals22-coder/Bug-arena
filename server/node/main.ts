/**
 * Node 어댑터: HTTP(정적 파일 · /api/rooms · /healthz) + WebSocket(/ws).
 *
 * 게임 규칙은 전부 server/core 에 있고, 여기는 "연결을 받아 Room 에 넘기고 Room 이 보내라는 것을 보내는" 일만 한다.
 * 그래서 같은 코어를 Cloudflare Workers 어댑터에서도 그대로 쓸 수 있다.
 *
 * 실행: `npx tsx server/node/main.ts` 또는 번들(`npm run build:server` → `node dist/server/main.js`).
 * 환경변수: PORT · HOST · ROOMS · MAX_ROOMS · ROOM_CAPACITY · NPCS · MAX_PRE_HELLO · MAX_CONNS_PER_IP · TRUST_PROXY · SAVE_SECRET · CLIENT_DIR · ALLOWED_ORIGINS · DATA_DIR
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { type Duplex, pipeline } from 'node:stream'
import * as zlib from 'node:zlib'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import {
  DEFAULT_ROOM_COUNT,
  MAX_ROOM_COUNT,
  NPCS_PER_ROOM,
  ROOM_CAPACITY,
  TICK_HZ,
  TICK_MS,
} from '../../shared/constants'
import { CLOSE_FULL, type ServerMsg } from '../../shared/protocol'
import type { CultScore, RoomInfo } from '../../shared/types'
import type { CultRegistry, PlayerMemory, RoomHost } from '../core/api'
import { Lobby } from '../core/lobby'
import { MAX_HELLO_BYTES, Room } from '../core/room'
import { createSigner } from '../core/save'

// ───────────────────────── 설정 ─────────────────────────

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    console.warn(`[server] 환경변수 ${name}="${raw}" 는 숫자가 아니라 기본값 ${def} 을 씁니다`)
    return def
  }
  return Math.max(min, Math.min(max, Math.floor(n)))
}

const PORT = envInt('PORT', 8787, 0, 65535)
const HOST = process.env.HOST?.trim() || undefined
const ROOMS = envInt('ROOMS', DEFAULT_ROOM_COUNT, 1, MAX_ROOM_COUNT)
/** 자동 증설 상한. 기본은 ROOMS 와 같다(= 증설 안 함) */
const MAX_ROOMS = Math.max(ROOMS, envInt('MAX_ROOMS', ROOMS, 1, MAX_ROOM_COUNT))
// 스냅샷은 한 번에 255개까지만 실을 수 있으므로 정원/NPC 수에 상한을 둔다
const CAPACITY = envInt('ROOM_CAPACITY', ROOM_CAPACITY, 1, 100)
const NPCS = envInt('NPCS', NPCS_PER_ROOM, 0, 200)
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || '.data')
const CLIENT_DIR = path.resolve(process.cwd(), process.env.CLIENT_DIR?.trim() || 'dist/client')
const normOrigin = (o: string): string => o.trim().toLowerCase().replace(/\/+$/, '')
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(normOrigin).filter(Boolean)

/** 이만큼 보낼 것이 밀려 있으면 받지 못하는 연결로 본다 */
const MAX_BUFFERED_BYTES = 1024 * 1024
const HEARTBEAT_MS = 20_000
/** close 프레임에 답이 없을 때 강제로 끊기까지 */
const CLOSE_GRACE_MS = 2000
/** 정원 + 입장 대기 여유. 소켓만 열어 두는 공격으로 자원이 끝없이 늘지 않게 한다 */
const MAX_CONNS = MAX_ROOMS * CAPACITY * 2 + 100
/**
 * hello 를 아직 보내지 않은 연결의 전체 상한. 넘치면 새 연결을 막는 대신 '가장 오래 인사하지 않은 연결'을 끊는다
 * → 연결만 열어 두고 버티는 공격은 뒤에 오는 정상 접속에 밀려난다(정상 클라이언트는 수십 ms 안에 hello 를 보낸다).
 */
const MAX_PRE_HELLO = Math.max(32, envInt('MAX_PRE_HELLO', 64, 8, 10_000))
/** IP 하나당 동시 연결 상한(0 = 끔). 프록시 뒤에서는 TRUST_PROXY(프록시 단계 수)를 같이 줘야 진짜 주소를 본다 */
const MAX_CONNS_PER_IP = envInt('MAX_CONNS_PER_IP', 0, 0, 100_000)
const TRUST_PROXY = envInt('TRUST_PROXY', 0, 0, 8)
const CULT_FLUSH_MS = 30_000
const MAX_CULTS = 5000
const ROOM_LIST_CACHE_MS = 250

// ───────────────────────── 로그 ─────────────────────────

let errorBudget = 50
let errorDropped = 0
setInterval(() => {
  if (errorDropped > 0) console.error(`${new Date().toISOString()} [error] (같은 기간 오류 ${errorDropped}건 생략)`)
  errorBudget = 50
  errorDropped = 0
}, 10_000).unref()

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  if (level === 'error') {
    // 틱마다 터지는 버그가 로그를 초당 수백 줄로 도배하지 않게 양을 제한한다
    if (errorBudget <= 0) {
      errorDropped++
      return
    }
    errorBudget--
  }
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  const detail = extra instanceof Error ? (extra.stack ?? extra.message) : extra
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (detail === undefined) out(line)
  else out(line, detail)
}

// ───────────────────────── 저장 서명 비밀키 ─────────────────────────

/** SAVE_SECRET 이 없으면 DATA_DIR/secret 에 만들어 두고 재사용한다(재시작해도 플레이어 저장본이 유효하도록) */
function loadSecret(): string {
  const fromEnv = process.env.SAVE_SECRET
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
  const file = path.join(DATA_DIR, 'secret')
  const read = (): string | null => {
    try {
      const s = fs.readFileSync(file, 'utf8').trim()
      return s.length >= 16 ? s : null
    } catch {
      return null
    }
  }
  const existing = read()
  if (existing) return existing
  const secret = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // wx: 동시에 뜬 다른 프로세스가 먼저 만들었다면 덮어쓰지 않고 그쪽 것을 쓴다
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
    return secret
  } catch (err) {
    const other = read()
    if (other) return other
    log('warn', `비밀키를 ${file} 에 저장하지 못했습니다. 재시작하면 기존 저장본이 무효가 됩니다(SAVE_SECRET 을 지정하세요)`, err)
    return secret
  }
}

// ───────────────────────── 교단 기록 저장소(메모리 + 파일) ─────────────────────────

interface FileCultRegistry extends CultRegistry {
  flush(sync: boolean): void
}

function createCultRegistry(file: string): FileCultRegistry {
  const map = new Map<string, CultScore>()
  let dirty = false
  let version = 0
  let sorted: CultScore[] = []
  let sortedVersion = -1
  let writing = false

  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1e12, Math.floor(v))) : 0)
  /** 띄어쓰기·대소문자만 다른 이름은 같은 이름으로 본다 */
  const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, '')

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (map.size >= MAX_CULTS) break
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        const id = str(r.id, 80)
        const name = str(r.name, 40)
        if (!id || !name) continue
        map.set(id, {
          id,
          name,
          color: int(r.color),
          emblem: int(r.emblem),
          leaderName: str(r.leaderName, 40),
          title: str(r.title, 40),
          online: 0,
          fol: int(r.fol),
          inf: int(r.inf),
        })
      }
    }
  } catch (err) {
    // 파일이 없는 것은 첫 실행이라 정상. 깨진 파일이면 알리고 빈 상태로 시작한다
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `교단 기록 ${file} 을 읽지 못해 빈 상태로 시작합니다`, err)
  }

  const touch = (): void => {
    dirty = true
    version++
  }
  const serialize = (): string => JSON.stringify([...map.values()].map((c) => ({ ...c, online: 0 })))

  return {
    record(cult, delta) {
      const id = str(cult.id, 80)
      const name = str(cult.name, 40)
      if (!id || !name) return
      let entry = map.get(id)
      if (!entry) {
        if (map.size >= MAX_CULTS) {
          // 자리가 없으면 영향력이 가장 낮은 기록을 내보낸다
          let lowest: CultScore | undefined
          for (const c of map.values()) if (!lowest || c.inf < lowest.inf) lowest = c
          if (lowest) map.delete(lowest.id)
        }
        entry = { id, name, color: 0, emblem: 0, leaderName: '', title: '', online: 0, fol: 0, inf: 0 }
        map.set(id, entry)
      }
      entry.name = name
      entry.color = int(cult.color)
      entry.emblem = int(cult.emblem)
      entry.leaderName = str(cult.leaderName, 40) || entry.leaderName
      // 칭호가 비어 오면(교단원이 올린 기록) 기존 교주 칭호를 유지한다
      entry.title = str(cult.title, 40) || entry.title
      entry.fol = int(entry.fol + int(delta.fol))
      entry.inf = int(entry.inf + int(delta.inf))
      touch()
    },
    nameTaken(name, exceptId) {
      const key = nameKey(String(name))
      for (const c of map.values()) if (c.id !== exceptId && nameKey(c.name) === key) return true
      return false
    },
    get(id) {
      const c = map.get(id)
      // 복사본을 준다: 받는 쪽이 online 등을 채워도 원본이 바뀌지 않게
      return c ? { ...c } : undefined
    },
    top(n) {
      if (sortedVersion !== version) {
        sorted = [...map.values()].sort((a, b) => b.inf - a.inf || b.fol - a.fol || a.name.localeCompare(b.name, 'ko'))
        sortedVersion = version
      }
      return sorted.slice(0, Math.max(0, Math.floor(n))).map((c) => ({ ...c }))
    },
    remove(id) {
      if (map.delete(id)) touch()
    },
    flush(sync) {
      if (!dirty || (writing && !sync)) return
      dirty = false
      const tmp = `${file}.tmp`
      const text = serialize()
      // 임시 파일에 쓴 뒤 이름을 바꾼다 → 쓰는 도중 죽어도 기존 파일이 깨지지 않는다
      if (sync) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(tmp, text)
          fs.renameSync(tmp, file)
        } catch (err) {
          log('warn', '교단 기록 저장 실패', err)
        }
        return
      }
      writing = true
      fs.promises
        .mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.writeFile(tmp, text))
        .then(() => fs.promises.rename(tmp, file))
        .catch((err: unknown) => {
          dirty = true
          log('warn', '교단 기록 저장 실패(다음 주기에 다시 시도)', err)
        })
        .finally(() => {
          writing = false
        })
    },
  }
}

// ───────────────────────── 방 / 호스트 ─────────────────────────

interface Conn {
  id: number
  ws: WebSocket
  room: Room
  /** 마지막 하트비트 이후 살아 있다는 신호(pong 또는 메시지)가 있었는가 */
  alive: boolean
  /** 접속 주소(IP당 상한 계산용) */
  ip: string
}

const conns = new Map<number, Conn>()
/** hello 가 아직 처리되지 않은 연결(삽입 순서 = 오래된 순) */
const preHello = new Set<number>()
const connsPerIp = new Map<string, number>()

function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY > 0) {
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 오른쪽에서 TRUST_PROXY 번째가 '우리가 믿는 프록시가 본 상대 주소'다(왼쪽 값은 상대가 꾸며 낼 수 있다)
    const ip = xff[xff.length - TRUST_PROXY]
    if (ip) return ip
  }
  return req.socket.remoteAddress ?? 'unknown'
}
let nextConnId = 1
let shuttingDown = false
const startedAt = Date.now()

const cults = createCultRegistry(path.join(DATA_DIR, 'cults.json'))
const signer = createSigner(loadSecret())

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    ws.terminate()
    return
  }
  // 상대가 close 에 답하지 않으면(죽은 연결) 소켓이 한참 남는다 → 잠깐 기다렸다가 강제로 끊는다
  setTimeout(() => {
    if (ws.readyState !== ws.CLOSED) ws.terminate()
  }, CLOSE_GRACE_MS).unref()
}

const onSendDone = (err?: Error | null): void => {
  // 닫히는 중인 소켓에 쓴 경우 등. 연결 종료 처리는 close 이벤트에서 하므로 여기서는 할 일이 없다
  void err
}

/** 방을 만드는 도중(Room 생성자 안)에도 host 가 불릴 수 있어서, 로비는 다 만들어진 뒤에 채운다 */
let lobbyRef: Lobby | null = null
let roomListCache: RoomInfo[] = []
let roomListAt = 0
/** 방 목록은 요청이 몰려도 방 수만큼의 계산을 매번 하지 않게 잠깐 캐시한다 */
function listRooms(): RoomInfo[] {
  const now = Date.now()
  if (lobbyRef && now - roomListAt >= ROOM_LIST_CACHE_MS) {
    roomListCache = lobbyRef.rooms()
    roomListAt = now
  }
  return roomListCache
}

const host: RoomHost = {
  send(connId, data) {
    const c = conns.get(connId)
    if (!c) return
    const ws = c.ws
    if (ws.readyState !== ws.OPEN) return
    // Room 이 welcome 을 보냈다 = 인사를 마친 정상 접속
    if (preHello.size > 0 && typeof data === 'string' && data.startsWith('{"t":"welcome"')) preHello.delete(connId)
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // 스냅샷은 '변한 것만' 보내는 방식이라 중간 하나를 건너뛰면 그 클라이언트 화면이 영영 어긋난다.
      // 그래서 건너뛰지 않고 끊는다 — 클라이언트는 자동 재접속으로 전체 상태를 새로 받는다.
      log('warn', `연결 ${connId}: 전송이 ${ws.bufferedAmount}바이트 밀려 끊습니다`)
      ws.terminate()
      return
    }
    ws.send(data, onSendDone)
  },
  close(connId, code, reason) {
    const c = conns.get(connId)
    if (c) closeSocket(c.ws, code, reason)
  },
  now: () => Date.now(),
  random: () => Math.random(),
  signer,
  listRooms,
  claimPid(pid, roomId) {
    // 같은 기기 id 는 서버 전체에서 한 곳에만 있게 한다. 방마다 pid 맵이 있으므로 그냥 물어보면 되고,
    // 따로 전역 표를 두지 않아 나간 사람의 기록이 남아 쌓일 일도 없다.
    if (!lobbyRef) return
    for (const room of lobbyRef.all()) {
      if (room.id !== roomId) room.kickPid(pid, 'dup')
    }
  },
  log,
  cults,
}

// 쿨타임·차단·입막음·이름 고정은 방을 옮겨도 따라가야 하므로 모든 방이 같은 메모 저장소를 쓴다
const playerMemory = new Map<string, PlayerMemory>()
const lobby = new Lobby((id, name) => new Room(host, { id, name, capacity: CAPACITY, npcCount: NPCS, memory: playerMemory }), ROOMS, MAX_ROOMS)
lobbyRef = lobby

// ───────────────────────── 틱 ─────────────────────────

const tickSamples = new Float64Array(600) // 최근 1분
let tickSampleCount = 0
let tickSeq = 0
let tickMax = 0

function tickAll(): void {
  const t0 = performance.now()
  const rooms = lobby.all()
  tickSeq++
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i]
    if (!room) continue
    // 빈 방은 1초에 한 번만(NPC 는 계속 살아 움직이되 가볍게). 방마다 엇갈리게 해서 한 틱에 몰리지 않게 한다
    if (room.players.size === 0 && (tickSeq + i) % TICK_HZ !== 0) continue
    try {
      room.tick()
    } catch (err) {
      log('error', `방 ${room.id} 틱 예외`, err)
    }
  }
  // 10초에 한 번: 자동으로 늘어났다가 오래 비어 있는 방 정리
  if (tickSeq % (TICK_HZ * 10) === 0) {
    const removed = lobby.sweep(Date.now())
    if (removed.length > 0) log('info', `빈 방 정리: ${removed.join(', ')}`)
  }
  const ms = performance.now() - t0
  tickSamples[tickSampleCount % tickSamples.length] = ms
  tickSampleCount++
  if (ms > tickMax) tickMax = ms
}

function tickP95(): number {
  const n = Math.min(tickSampleCount, tickSamples.length)
  if (n === 0) return 0
  const sortedSamples = Array.from(tickSamples.subarray(0, n)).sort((a, b) => a - b)
  return sortedSamples[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0
}

// ───────────────────────── HTTP ─────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.xml', '.svg'])
const COMPRESS_MIN_BYTES = 1024
const COMPRESS_MAX_BYTES = 8 * 1024 * 1024
const COMPRESS_CACHE_MAX = 256

/** 로그/안내용 경로 표기: 작업 폴더 안이면 상대 경로, 밖이면 절대 경로 */
function displayPath(p: string): string {
  const rel = path.relative(process.cwd(), p)
  return rel === '' ? '.' : rel.startsWith('..') ? p : rel
}

const NO_CLIENT_HINT =
  '도를 아십니까? — 게임 서버가 실행 중입니다.\n' +
  `클라이언트 빌드(${displayPath(CLIENT_DIR)})가 없어 화면은 제공하지 않습니다.\n` +
  '`npm run build` 후 다시 열거나, 개발 중이라면 `npm run dev` 로 Vite(5173)를 함께 띄우세요.\n' +
  '방 목록: /api/rooms · 상태: /healthz · 게임 접속: /ws\n'

function sendText(res: http.ServerResponse, status: number, text: string, headers: http.OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

async function statFile(file: string): Promise<fs.Stats | null> {
  try {
    const st = await fs.promises.stat(file)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

/** 요청 경로 → CLIENT_DIR 안의 파일 경로. 밖으로 나가려 하거나 숨김 파일이면 null */
function resolveClientPath(pathname: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  // 맨 앞에 / 를 붙여 정규화하면 '..' 이 루트 위로 올라가지 못한다
  const clean = path.normalize(`/${rel.replace(/\\/g, '/')}`)
  const full = path.join(CLIENT_DIR, clean)
  if (full !== CLIENT_DIR && !full.startsWith(CLIENT_DIR + path.sep)) return null
  // .env, .git 같은 숨김 경로는 정적 폴더를 잘못 지정했더라도 내주지 않는다
  if (clean.split(path.sep).some((seg) => seg.startsWith('.') && seg.length > 1)) return null
  return full
}

const compressCache = new Map<string, Promise<Buffer>>()

function compressed(file: string, st: fs.Stats, enc: 'br' | 'gzip'): Promise<Buffer> {
  const key = `${enc}|${st.size}|${st.mtimeMs}|${file}`
  let hit = compressCache.get(key)
  if (hit) return hit
  if (compressCache.size >= COMPRESS_CACHE_MAX) compressCache.clear()
  hit = fs.promises.readFile(file).then(
    (buf) =>
      new Promise<Buffer>((resolve, reject) => {
        const done = (err: Error | null, out: Buffer): void => (err ? reject(err) : resolve(out))
        if (enc === 'br') {
          zlib.brotliCompress(
            buf,
            { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 8, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } },
            done,
          )
        } else {
          zlib.gzip(buf, { level: 9 }, done)
        }
      }),
  )
  compressCache.set(key, hit)
  // 실패한 결과가 캐시에 남아 계속 실패하지 않게 한다
  hit.catch(() => compressCache.delete(key))
  return hit
}

function cacheControlFor(urlPath: string, file: string): string {
  const base = path.basename(file)
  // 빌드가 파일 이름에 해시를 넣어 주는 자산은 내용이 바뀌면 이름도 바뀐다 → 영구 캐시
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  // 진입 문서와 런타임 설정은 배포 즉시 반영돼야 한다
  if (base === 'config.js' || base.endsWith('.html')) return 'no-cache'
  return 'public, max-age=300'
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
  const isRoot = urlPath === '/' || urlPath === '/index.html'
  let file = resolveClientPath(urlPath)
  if (!file) {
    sendText(res, 404, '찾을 수 없습니다.\n')
    return
  }
  let st = await statFile(file)
  if (!st && urlPath.endsWith('/')) {
    file = path.join(file, 'index.html')
    st = await statFile(file)
  }
  if (!st) {
    // 확장자가 있는 경로는 없는 자산이다: index.html 을 대신 주면 브라우저가 HTML 을 스크립트로 읽다 엉뚱한 오류를 낸다
    if (!isRoot && path.extname(urlPath) !== '') {
      sendText(res, 404, '찾을 수 없습니다.\n')
      return
    }
    file = path.join(CLIENT_DIR, 'index.html')
    st = await statFile(file)
    if (!st) {
      sendText(res, isRoot ? 200 : 404, NO_CLIENT_HINT)
      return
    }
  }

  const ext = path.extname(file).toLowerCase()
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const headers: http.OutgoingHttpHeaders = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': cacheControlFor(urlPath, file),
    etag,
    'last-modified': st.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  }
  const canCompress = COMPRESSIBLE.has(ext) && st.size >= COMPRESS_MIN_BYTES && st.size <= COMPRESS_MAX_BYTES
  if (canCompress) headers.vary = 'Accept-Encoding'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  if (canCompress) {
    const accept = String(req.headers['accept-encoding'] ?? '')
    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null
    if (enc) {
      try {
        const body = await compressed(file, st, enc)
        headers['content-encoding'] = enc
        headers['content-length'] = body.length
        res.writeHead(200, headers)
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      } catch (err) {
        log('warn', `압축 실패, 원본으로 보냅니다: ${file}`, err)
      }
    }
  }
  headers['content-length'] = st.size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  // pipeline 은 받는 쪽이 중간에 끊어도 파일 핸들을 닫아 준다(pipe 만 쓰면 열린 채 남는다)
  pipeline(fs.createReadStream(file), res, (err) => {
    if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') log('warn', `파일 전송 실패: ${file}`, err)
  })
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let urlPath: string
  try {
    urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    sendText(res, 400, '잘못된 요청입니다.\n')
    return
  }
  const method = req.method ?? 'GET'

  if (urlPath === '/api/rooms') {
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, '허용되지 않는 메서드입니다.\n', { allow: 'GET, OPTIONS', ...CORS })
      return
    }
    sendJson(res, 200, { rooms: lobby.rooms(), policy: { capacity: CAPACITY, rooms: ROOMS, maxRooms: MAX_ROOMS } }, CORS)
    return
  }
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(res, 405, '허용되지 않는 메서드입니다.\n', { allow: 'GET, HEAD' })
    return
  }
  if (urlPath === '/healthz') {
    sendJson(res, shuttingDown ? 503 : 200, {
      ok: !shuttingDown,
      rooms: lobby.size,
      players: lobby.totalPlayers(),
      conns: conns.size,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      tickMsP95: Math.round(tickP95() * 1000) / 1000,
      // 부하 측정용: 프로세스 메모리와 누적 CPU 시간(사용자+시스템)
      rssMb: Math.round(process.memoryUsage().rss / 104857.6) / 10,
      heapMb: Math.round(process.memoryUsage().heapUsed / 104857.6) / 10,
      cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
      tickMsMax: Math.round(tickMax * 1000) / 1000,
    })
    return
  }
  if (urlPath === '/ws') {
    // 업그레이드 헤더 없이 들어온 요청(주소창에 직접 입력 등)
    sendText(res, 426, '이 주소는 WebSocket 전용입니다.\n', { upgrade: 'websocket' })
    return
  }
  await serveStatic(req, res, urlPath)
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err: unknown) => {
    log('error', `HTTP 처리 예외: ${req.method ?? ''} ${req.url ?? ''}`, err)
    if (!res.headersSent) sendText(res, 500, '서버 오류입니다.\n')
    else res.destroy()
  })
})

// ───────────────────────── WebSocket ─────────────────────────

const wss = new WebSocketServer({
  noServer: true,
  // 스냅샷은 수백 바이트짜리 이진 데이터라 압축 이득이 거의 없고, 연결마다 압축 상태를 들고 있는 비용만 든다
  perMessageDeflate: false,
  // 입장 전 hello 에는 서명 저장본이 실려 오므로 그 크기까지는 받는다. 입장 후의 큰 프레임은 Room 이 버린다
  maxPayload: MAX_HELLO_BYTES,
})

function originAllowed(origin: string | undefined): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true
  // Origin 헤더는 브라우저만 붙인다(위조도 브라우저 밖에서는 자유롭다). 이 검사의 목적은 '남의 웹 페이지가
  // 이 서버를 끌어다 쓰는 것'을 막는 것이므로, 헤더가 없는 비브라우저 클라이언트(점검 도구, 부하 테스트)는 통과시킨다.
  if (!origin) return true
  return ALLOWED_ORIGINS.includes(normOrigin(origin))
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return data
}

function attach(ws: WebSocket, room: Room, ip: string): void {
  const id = nextConnId++
  const c: Conn = { id, ws, room, alive: true, ip }
  conns.set(id, c)
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1)
  // 인사 전 연결이 너무 많으면 가장 오래 버틴 것부터 끊는다
  preHello.add(id)
  while (preHello.size > MAX_PRE_HELLO) {
    const oldest = preHello.values().next().value as number
    preHello.delete(oldest)
    conns.get(oldest)?.ws.terminate()
  }
  ws.on('message', (data: RawData, isBinary: boolean) => {
    c.alive = true
    const buf = toBuffer(data)
    room.message(id, isBinary ? buf : buf.toString('utf8'))
  })
  ws.on('pong', () => {
    c.alive = true
  })
  ws.on('close', (code: number) => {
    // 표에서 먼저 지운다: 퇴장 처리 중 이 연결로 보내려는 것이 조용히 버려지게
    conns.delete(id)
    preHello.delete(id)
    const left = (connsPerIp.get(ip) ?? 1) - 1
    if (left > 0) connsPerIp.set(ip, left)
    else connsPerIp.delete(ip)
    // 상대가 스스로 닫았으면(1000 정상, 1001 탭 닫기·페이지 이동, 1005 코드 없음) 바로 퇴장시킨다.
    // 그 밖(1006 끊김, 응답 없어 끊은 경우 등)은 방이 잠시 자리를 지켜 주며 재접속을 기다린다.
    room.disconnect(id, code === 1000 || code === 1001 || code === 1005)
  })
  ws.on('error', (err: Error) => {
    // 프레임 상한 초과·잘못된 프레임 등. ws 가 알아서 닫고 close 이벤트가 뒤따른다
    log('warn', `연결 ${id} 소켓 오류: ${err.message}`)
  })
  room.connect(id)
}

server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  // 업그레이드 도중 상대가 끊으면 소켓 오류가 처리되지 않은 예외로 번진다
  socket.on('error', () => {})
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request')
    return
  }
  if (url.pathname !== '/ws') {
    rejectUpgrade(socket, 404, 'Not Found')
    return
  }
  if (!originAllowed(req.headers.origin)) {
    rejectUpgrade(socket, 403, 'Forbidden')
    return
  }
  if (shuttingDown || conns.size >= MAX_CONNS) {
    rejectUpgrade(socket, 503, 'Service Unavailable')
    return
  }
  const ip = clientIp(req)
  if (MAX_CONNS_PER_IP > 0 && (connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
    rejectUpgrade(socket, 429, 'Too Many Requests')
    return
  }
  const requested = url.searchParams.get('room')
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = lobby.pick(requested)
    if (!room) {
      // 전부 가득: 연결은 받아서 사유와 방 목록을 알려 준 뒤 닫는다(클라이언트가 안내를 띄울 수 있게)
      ws.on('error', () => {})
      const full: ServerMsg = { t: 'full', rooms: lobby.rooms() }
      ws.send(JSON.stringify(full), onSendDone)
      closeSocket(ws, CLOSE_FULL, 'full')
      return
    }
    attach(ws, room, ip)
  })
})

// ───────────────────────── 주기 작업 / 종료 ─────────────────────────

const tickTimer = setInterval(tickAll, TICK_MS)

const heartbeatTimer = setInterval(() => {
  for (const c of conns.values()) {
    if (!c.alive) {
      // 지난 주기의 ping 에 답이 없고 메시지도 없었다 → 죽은 연결
      c.ws.terminate()
      continue
    }
    c.alive = false
    try {
      c.ws.ping()
    } catch {
      c.ws.terminate()
    }
  }
}, HEARTBEAT_MS)

const cultTimer = setInterval(() => cults.flush(false), CULT_FLUSH_MS)

function shutdown(signal: string): void {
  if (shuttingDown) {
    // 두 번째 신호는 기다리지 않고 바로 끝낸다
    process.exit(1)
  }
  shuttingDown = true
  log('info', `${signal} 수신 — 접속자에게 알리고 종료합니다(접속 ${conns.size}명)`)
  clearInterval(tickTimer)
  clearInterval(heartbeatTimer)
  clearInterval(cultTimer)
  for (const room of lobby.all()) {
    try {
      room.shutdown()
    } catch (err) {
      log('error', `방 ${room.id} 종료 처리 예외`, err)
    }
  }
  cults.flush(true)
  server.close()
  server.closeIdleConnections()
  // 마지막 저장본과 kick(shutdown) 이 실제로 나갈 시간을 잠깐 준 뒤 끝낸다
  setTimeout(() => {
    for (const c of conns.values()) c.ws.terminate()
    process.exit(0)
  }, 700)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// 예상 못 한 예외 하나로 모든 방의 접속이 끊기는 것보다, 기록하고 계속 도는 편이 낫다(방 상태는 Room 이 스스로 지킨다)
process.on('uncaughtException', (err) => log('error', '처리되지 않은 예외', err))
process.on('unhandledRejection', (err) => log('error', '처리되지 않은 Promise 거부', err))

server.on('error', (err: NodeJS.ErrnoException) => {
  if (server.listening) {
    // 이미 돌고 있는 중의 오류(연결 수락 실패 등)로 접속자 전원을 끊을 이유는 없다
    log('error', 'HTTP 서버 오류', err)
    return
  }
  if (err.code === 'EADDRINUSE') log('error', `포트 ${PORT} 를 이미 다른 프로그램이 쓰고 있습니다`)
  else log('error', '서버를 시작하지 못했습니다', err)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : PORT
  const client = fs.existsSync(path.join(CLIENT_DIR, 'index.html')) ? displayPath(CLIENT_DIR) : '없음(API·WS 만 제공)'
  const origins = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(',') : '전부 허용'
  console.log(
    `[server] listening on http://${HOST ?? 'localhost'}:${port} — 포트 ${port} · 방 ${lobby.size}개(정원 ${CAPACITY}명, NPC ${NPCS}명) · 정적 파일: ${client} · 허용 출처: ${origins}`,
  )
})
