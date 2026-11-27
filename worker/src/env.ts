/**
 * Worker 바인딩/설정 타입과 설정값 해석.
 *
 * `wrangler types` 로 Env 를 생성할 수도 있지만(약 640KB 생성물), 바인딩이 몇 개 안 되므로 손으로 적어 둔다.
 * 그래야 wrangler 를 돌리지 않고도 `tsc` 만으로 타입 검사가 끝난다. wrangler.jsonc 를 바꾸면 여기도 맞춘다.
 */
import { DEFAULT_ROOM_COUNT, MAX_ROOM_COUNT, NPCS_PER_ROOM, ROOM_CAPACITY } from '../../shared/constants'
import type { LobbyDO } from './lobby'
import type { Policy } from './policy'
import type { RoomDO } from './room'

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>
  LOBBY: DurableObjectNamespace<LobbyDO>
  /** Workers Static Assets(dist/client). 설정에서 assets 를 빼면 없다 */
  ASSETS?: Fetcher
  /** 비밀(wrangler secret put SAVE_SECRET / 로컬은 .dev.vars). Node 서버와 같은 값이면 저장본이 양쪽에서 통한다 */
  SAVE_SECRET?: string
  ROOMS?: string
  MAX_ROOMS?: string
  ROOM_CAPACITY?: string
  NPCS?: string
  ALLOWED_ORIGINS?: string
  /** 방 하나에서 인사(hello) 전 연결의 상한(기본 8). 넘으면 가장 오래된 것부터 끊는다 */
  MAX_PRE_HELLO?: string
  /** IP(CF-Connecting-IP) 하나가 방 하나에 동시에 열 수 있는 연결 수(기본 0 = 끔) */
  MAX_CONNS_PER_IP?: string
}

/** Node 어댑터(server/node/main.ts)의 envInt 와 같은 규칙: 비었거나 숫자가 아니면 기본값, 범위 밖이면 자른다 */
function envInt(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || String(raw).trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.floor(n)))
}

// Policy 모양은 policy.ts 에 있다(Workers 타입 없이 단위 테스트할 수 있게)
export type { Policy }

export function policyOf(env: Env): Policy {
  const rooms = envInt(env.ROOMS, DEFAULT_ROOM_COUNT, 1, MAX_ROOM_COUNT)
  return {
    rooms,
    maxRooms: Math.max(rooms, envInt(env.MAX_ROOMS, rooms, 1, MAX_ROOM_COUNT)),
    // 스냅샷 한 번에 255개까지라 Node 와 같은 상한을 둔다
    capacity: envInt(env.ROOM_CAPACITY, ROOM_CAPACITY, 1, 100),
    npcs: envInt(env.NPCS, NPCS_PER_ROOM, 0, 200),
    maxPreHello: envInt(env.MAX_PRE_HELLO, 8, 2, 1000),
    maxConnsPerIp: envInt(env.MAX_CONNS_PER_IP, 0, 0, 10_000),
  }
}

const normOrigin = (o: string): string => o.trim().toLowerCase().replace(/\/+$/, '')

export function allowedOrigins(env: Env): string[] {
  return String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(normOrigin)
    .filter(Boolean)
}

/**
 * Node 어댑터와 같은 규칙(server/node/ops.ts). 목적은 '남의 웹 페이지가 이 서버를 끌어다 쓰는 것'을 막는 것이라
 * Origin 헤더가 없는 비브라우저 클라이언트(점검 도구, 부하 테스트)는 통과시킨다.
 *   - 비었음(기본): 같은 출처만(Origin 의 host 가 요청 URL 의 host 와 같아야 한다)
 *   - '*': 전부 허용
 *   - 목록: 목록에 있는 출처만
 */
export function originAllowed(env: Env, origin: string | null, requestHost: string): boolean {
  const list = allowedOrigins(env)
  if (list.includes('*') || !origin) return true
  if (list.length > 0) return list.includes(normOrigin(origin))
  try {
    const u = new URL(origin)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.host.toLowerCase() === requestHost.toLowerCase()
  } catch {
    // 'null' 등
    return false
  }
}

/** DO 이름 규칙. 이름이 곧 인스턴스이므로 바꾸면 전부 새 DO 가 된다(위치를 다시 잡고 싶을 때만 바꾼다) */
export const roomObjectName = (id: string): string => `room-${id}`
export const LOBBY_NAME = 'lobby'
/**
 * DO 는 처음 만들어진 곳에 계속 머문다. 한국 사용자가 대상이므로 첫 호출 때 동북아를 힌트로 준다(best effort).
 * 이미 다른 곳에 만들어진 DO 에는 영향이 없다.
 */
export const LOCATION_HINT: DurableObjectLocationHint = 'apac-ne'

export function lobbyStub(env: Env): DurableObjectStub<LobbyDO> {
  return env.LOBBY.getByName(LOBBY_NAME, { locationHint: LOCATION_HINT })
}

export function roomStub(env: Env, id: string): DurableObjectStub<RoomDO> {
  return env.ROOM.getByName(roomObjectName(id), { locationHint: LOCATION_HINT })
}
