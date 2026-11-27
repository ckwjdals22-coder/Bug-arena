/**
 * Node 어댑터: HTTP(정적 파일 · /api/rooms · /healthz) + WebSocket(/ws).
 *
 * 게임 규칙은 전부 server/core 에 있고, 여기는 "연결을 받아 Room 에 넘기고 Room 이 보내라는 것을 보내는" 일만 한다.
 * 그래서 같은 코어를 Cloudflare Workers 어댑터에서도 그대로 쓸 수 있다.
 *
 * 실행: `npx tsx server/node/main.ts` 또는 번들(`npm run build:server` → `node dist/server/main.js`).
 * 환경변수: PORT · HOST · ROOMS · MAX_ROOMS · ROOM_CAPACITY · NPCS · MAX_PRE_HELLO · MAX_CONNS_PER_IP · TRUST_PROXY · SAVE_SECRET · CLIENT_DIR ·
 *           ALLOWED_ORIGINS · FRAME_ANCESTORS · DATA_DIR
 * 운영: 로그는 한 줄에 JSON 하나(docs/DEPLOY.md §8). 저장 문제는 부팅 때 exit 1, 돌던 중이면 /healthz 503.
 */
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
import {
  ErrorTally,
  formatLogLine,
  frameAncestorsFrom,
  LogBudget,
  type LogLevel,
  originAllowed,
  originPolicyFrom,
  pickEncoding,
  securityHeaders,
} from './ops'
import { acquireDataLock, createCultRegistry, type DataLock, loadSecret, newPersistStatus, PersistFatal, probeDataDir } from './persist'

// ───────────────────────── 로그 ─────────────────────────
// 설정을 읽는 중에도 경고를 남기므로 맨 앞에 둔다.

/** 10초 창마다: 오류 50건, 경고 100건까지. 넘친 것은 건수만 요약한다 */
const errorBudget = new LogBudget(50)
const warnBudget = new LogBudget(100)
/** 소켓 오류(잘못된 프레임, 상한 초과 프레임)는 연결마다 쓰지 않고 10초마다 종류별 건수로 묶는다 */
const socketErrors = new ErrorTally()

function writeLine(level: LogLevel, msg: string, extra?: unknown): void {
  const line = formatLogLine(level, msg, extra)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

setInterval(() => {
  const errDropped = errorBudget.reset()
  const warnDropped = warnBudget.reset()
  if (errDropped > 0) writeLine('error', '같은 기간 오류 생략', { dropped: errDropped })
  if (warnDropped > 0) writeLine('warn', '같은 기간 경고 생략', { dropped: warnDropped })
  const sock = socketErrors.drain()
  if (sock) writeLine('warn', '소켓 오류(10초 요약)', sock)
}, 10_000).unref()

function log(level: LogLevel, msg: string, extra?: unknown): void {
  // 틱마다 터지는 버그나 공격성 요청이 로그를 초당 수백 줄로 도배하지 않게 양을 제한한다
  if (level === 'error' && !errorBudget.take()) return
  // 신고 기록(msg 'report')은 유일한 관리 기록이라 버리지 않는다(코어가 신고 자격·횟수를 이미 제한한다)
  if (level === 'warn' && msg !== 'report' && !warnBudget.take()) return
  writeLine(level, msg, extra)
}

/** 계속 돌면 안 되는 문제: 한 줄로 이유를 남기고 끝낸다(호스팅이 '죽음'으로 보여 주도록) */
function fatal(msg: string): never {
  writeLine('error', msg)
  process.exit(1)
}

// ───────────────────────── 설정 ─────────────────────────

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    log('warn', `환경변수 ${name}="${raw}" 는 숫자가 아니라 기본값 ${def} 을 씁니다`)
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
/** 비었으면 같은 출처만, '*' 면 전부, 아니면 쉼표 목록 */
const ORIGIN_POLICY = originPolicyFrom(process.env.ALLOWED_ORIGINS)
/** 이 게임을 iframe 으로 품을 수 있는 출처(CSP frame-ancestors). 기본 'self' */
const FRAME_ANCESTORS = frameAncestorsFrom(process.env.FRAME_ANCESTORS)
const HTML_SECURITY_HEADERS = securityHeaders(FRAME_ANCESTORS)

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

// ───────────────────────── 저장(DATA_DIR) ─────────────────────────
// 순서가 중요하다: 쓸 수 있는지 → 다른 서버가 쓰는 중인지(잠금) → 비밀키 → 교단 기록.
// 하나라도 안 되면 조용히 메모리로만 돌지 않고 끝낸다(재시작마다 진행도·순위가 사라지는 것을 숨기지 않게).

const persist = newPersistStatus()
/** 돌던 중 DATA_DIR 점검 실패 사유(교단 기록 저장 실패와 따로 둔다: 하나가 회복돼도 다른 하나는 남게) */
let dataDirError: string | null = null
let dataLock: DataLock
let cults: ReturnType<typeof createCultRegistry>
let saveSecret: string
try {
  probeDataDir(DATA_DIR)
  dataLock = acquireDataLock(DATA_DIR)
  saveSecret = loadSecret(DATA_DIR, process.env.SAVE_SECRET, log)
  cults = createCultRegistry({ file: path.join(DATA_DIR, 'cults.json'), maxCults: MAX_CULTS, log, status: persist })
} catch (err) {
  if (err instanceof PersistFatal) fatal(err.message)
  throw err
}
// 어떻게 끝나든(정상 종료·예외) 내 잠금은 지운다. kill -9 로 남은 잠금은 다음 부팅이 낡은 것으로 알아본다
process.on('exit', () => dataLock.release())

/** 30초마다: 잠금이 살아 있음을 표시하고, 디스크가 여전히 쓰이는지 확인한다 */
function checkDataDir(): void {
  try {
    probeDataDir(DATA_DIR)
    dataLock.refresh()
    if (dataDirError) log('info', 'DATA_DIR 에 다시 쓸 수 있습니다')
    dataDirError = null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (dataDirError === null) log('error', msg)
    dataDirError = msg
  }
}

function persistHealth(): { ok: boolean; lastCultSaveAt: string | null; lastError: string | null } {
  return {
    ok: persist.ok && dataDirError === null,
    lastCultSaveAt: persist.lastCultSaveAt > 0 ? new Date(persist.lastCultSaveAt).toISOString() : null,
    lastError: dataDirError ?? persist.lastError,
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

const signer = createSigner(saveSecret)

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

const ASSETS_DIR = path.join(CLIENT_DIR, 'assets')

function cacheControlFor(file: string): string {
  const base = path.basename(file)
  // 빌드가 파일 이름에 해시를 넣어 주는 자산은 내용이 바뀌면 이름도 바뀐다 → 영구 캐시.
  // URL 이 아니라 '실제로 내주는 파일'로 정한다: 없는 자산 대신 다른 파일을 내줄 때 그것이 영구 캐시되지 않게
  if (file.startsWith(ASSETS_DIR + path.sep)) return 'public, max-age=31536000, immutable'
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
    // 확장자가 있는 경로나 /assets 아래는 없는 자산이다: index.html 을 대신 주면 브라우저가 HTML 을 스크립트로 읽다
    // 엉뚱한 오류를 내고, /assets 아래라면 그 HTML 이 1년짜리 캐시에 박힌다
    const isAsset = urlPath === '/assets' || urlPath.startsWith('/assets/')
    if (!isRoot && (isAsset || path.extname(urlPath) !== '')) {
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
    'cache-control': cacheControlFor(file),
    etag,
    'last-modified': st.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
    // 문서(HTML)에만: 스크립트 출처 제한·iframe 허용 범위·리퍼러·기기 권한
    ...(ext === '.html' ? HTML_SECURITY_HEADERS : {}),
  }
  const canCompress = COMPRESSIBLE.has(ext) && st.size >= COMPRESS_MIN_BYTES && st.size <= COMPRESS_MAX_BYTES
  if (canCompress) headers.vary = 'Accept-Encoding'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  if (canCompress) {
    // q=0 은 '보내지 말라'는 뜻이다(단순 문자열 검색으로는 br;q=0 에도 br 을 보내게 된다)
    const enc = pickEncoding(req.headers['accept-encoding'])
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
    const persistNow = persistHealth()
    // 저장이 안 되는 동안은 '건강하지 않음': 호스팅의 헬스 체크가 알아채고 운영자에게 알리도록
    const healthy = !shuttingDown && persistNow.ok
    sendJson(res, healthy ? 200 : 503, {
      ok: healthy,
      persist: persistNow,
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
    // 프레임 상한 초과·잘못된 프레임 등. ws 가 알아서 닫고 close 이벤트가 뒤따른다.
    // 누구나 일으킬 수 있으므로 한 건씩 쓰지 않고 10초마다 종류별 건수로 요약한다
    socketErrors.add(err)
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
  // 기본은 같은 출처만(ALLOWED_ORIGINS 비었을 때). Origin 헤더가 없는 도구·부하 테스트는 통과(ops.ts 참고)
  const originOk = originAllowed(ORIGIN_POLICY, {
    origin: req.headers.origin,
    host: req.headers.host,
    forwardedHost: req.headers['x-forwarded-host'],
    trustProxy: TRUST_PROXY,
  })
  if (!originOk) {
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
    // resume=1: 끊겼다가 있던 방으로 돌아오는 재접속(가득 찬 방이어도 그 방이 직접 판정하게 보낸다)
    const room = lobby.pick(requested, url.searchParams.get('resume') === '1')
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

const cultTimer = setInterval(() => {
  checkDataDir()
  cults.flush(false)
}, CULT_FLUSH_MS)

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
  dataLock.release()
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
  const origins = ORIGIN_POLICY.kind === 'all' ? '전부 허용(*)' : ORIGIN_POLICY.kind === 'same' ? '같은 출처만' : ORIGIN_POLICY.list.join(',')
  log('info', `listening on http://${HOST ?? 'localhost'}:${port}`, {
    port,
    rooms: lobby.size,
    capacity: CAPACITY,
    npcs: NPCS,
    client,
    origins,
    frameAncestors: FRAME_ANCESTORS,
    dataDir: displayPath(DATA_DIR),
    cults: cults.size,
  })
})
