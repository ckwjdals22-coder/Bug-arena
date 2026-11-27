/**
 * Cloudflare Worker 진입점: 상태 없는 라우터.
 *
 *   GET /api/rooms      → LobbyDO.list()          (Node 서버와 같은 JSON: { rooms, policy })
 *   GET /healthz        → LobbyDO.health()
 *   GET /ws?room=<id|auto> (WebSocket) → LobbyDO.pick() 으로 방을 고른 뒤 그 방 DO(room-<id>)로 업그레이드를 넘긴다
 *   그 밖             → Workers Static Assets(dist/client). 에셋과 일치하는 요청은 Worker 까지 오지도 않는다(무료).
 *
 * 잘못된 요청(업그레이드 헤더 없음, 허용되지 않은 Origin, 엉뚱한 경로)은 여기서 거른다 — DO 로 넘긴 요청은 과금된다.
 */
import { CLOSE_FULL, type ServerMsg } from '../../shared/protocol'
import { type Env, lobbyStub, originAllowed, roomStub } from './env'

export { LobbyDO } from './lobby'
export { RoomDO } from './room'

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

const BASE_HEADERS: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...BASE_HEADERS, ...headers } })
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...headers },
  })
}

/**
 * 전부 가득 찼을 때: 브라우저는 업그레이드 실패(HTTP 4xx)의 사유를 읽지 못한다.
 * 그래서 Worker 가 직접 연결을 받아 주고 { t:'full', rooms } 를 보낸 뒤 4001 로 닫는다(Node 서버와 같은 동작).
 */
function fullResponse(rooms: Extract<ServerMsg, { t: 'full' }>['rooms']): Response {
  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()
  const msg: ServerMsg = { t: 'full', rooms }
  server.send(JSON.stringify(msg))
  server.close(CLOSE_FULL, 'full')
  return new Response(null, { status: 101, webSocket: client })
}

async function handleWs(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return text(426, '이 주소는 WebSocket 전용입니다.\n', { upgrade: 'websocket' })
  }
  if (!originAllowed(env, request.headers.get('Origin'))) return text(403, 'Forbidden\n')
  if (!env.SAVE_SECRET || env.SAVE_SECRET.trim() === '') {
    console.error('[worker] SAVE_SECRET 이 설정되지 않았습니다. `npx wrangler secret put SAVE_SECRET` 으로 넣으세요')
    return text(503, '서버 설정 오류입니다.\n')
  }
  const requested = url.searchParams.get('room')
  const lobby = lobbyStub(env)
  const id = await lobby.pick(requested)
  if (id === null) {
    const { rooms } = await lobby.list()
    return fullResponse(rooms)
  }
  // 같은 이름 → 전 세계에서 항상 같은 DO 인스턴스. 원래 요청(업그레이드 헤더 포함)을 그대로 넘기면 DO 가 101 을 돌려준다
  return roomStub(env, id).fetch(request)
}

export default {
  async fetch(request, env): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return text(400, '잘못된 요청입니다.\n')
    }
    const path = url.pathname
    try {
      if (path === '/ws') return await handleWs(request, env, url)

      if (path === '/api/rooms') {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return text(405, '허용되지 않는 메서드입니다.\n', { allow: 'GET, OPTIONS', ...CORS })
        }
        return json(200, await lobbyStub(env).list(), CORS)
      }
      if (path === '/healthz') {
        return json(200, { ...(await lobbyStub(env).health()), runtime: 'cloudflare' })
      }
      if (path.startsWith('/api/')) return json(404, { error: 'not_found' })
    } catch (err) {
      console.error(`[worker] ${request.method} ${path} 처리 예외`, err)
      return text(500, '서버 오류입니다.\n')
    }

    // 에셋과 일치하는 요청은 Worker 까지 오지 않는다(assets.run_worker_first 에 적은 경로 제외).
    // 여기까지 왔으면 없는 파일이다. env.ASSETS.fetch 로 넘기면 _headers 의 장기 캐시 규칙이 404 에도 붙을 수 있어 직접 낸다.
    if (env.ASSETS && (path === '/' || path === '/index.html')) return env.ASSETS.fetch(request)
    if (!env.ASSETS && path === '/') {
      return text(
        200,
        '도를 아십니까? — 게임 서버(Cloudflare)가 실행 중입니다.\n클라이언트는 별도로 호스팅됩니다.\n방 목록: /api/rooms · 상태: /healthz · 게임 접속: /ws\n',
      )
    }
    return text(404, '찾을 수 없습니다.\n')
  },
} satisfies ExportedHandler<Env>
