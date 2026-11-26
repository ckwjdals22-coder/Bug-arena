# 05. 넷코드: WebSocket 방 기반 캐주얼 3D 게임 (Node.js + ws)

- 조사일: 2026-11-26
- 대상: 방당 접속자 20명 + 서버 시뮬레이션 NPC 약 28명, 지금은 3방, 나중에 100방 이상. Node.js + `ws`, 선택적으로 Cloudflare Workers + Durable Objects.
- 조사 방법: 웹 검색 + 원문 열람(WebFetch, curl), `npm view`, 설치한 패키지 소스 직접 읽기, 그리고 **임시 폴더에서 직접 돌린 벤치마크와 스니펫 검증**. 저장소 파일은 이 문서 말고는 건드리지 않았다. 설계 문서(`docs/ARCHITECTURE.md`)와 `shared/protocol.ts`, `shared/constants.ts`, 작성 중인 `client/src/net/*`를 읽고 거기에 맞춰 썼다.
- 표기 규칙: **[확인]** 원문·소스에서 읽음 / **[측정]** 이번에 직접 돌려서 얻은 수치 / **[요약]** 검색 결과 요약으로만 봄 / **[추론]** 근거에서 끌어낸 설계 판단 / **[상식]** 이번에 원문 확인을 못 한 일반 지식 / **확인 못함** 근거를 못 찾음
- 측정 환경(7장 전체에 해당): Intel Xeon 2.10GHz 가상 CPU 4개짜리 VM, 메모리 16GB, Linux 6.18, Node v22.23.5, ws 8.23.0. 서버 프로세스는 코어 1개에 고정(`taskset -c 0`), 봇 프로세스 2개는 나머지 코어 3개. **루프백, TLS 없음, 패킷 손실 없음.** 방 로직은 "NPC 무작위 걷기 + 이동 검증 + 더티 스냅샷 방송"만 넣은 최소 구현이라 **네트워크 입출력 비용의 하한선**이다. 실제 `Room`(길 찾기, 포교 판정, 시스템 플러그인)의 CPU는 포함돼 있지 않다.

---

## 0. 한 페이지 요약

1. **`ws`는 8.23.0(2026-11-12)이 최신이고, 저장소가 이미 이 버전으로 고정돼 있다. 내리면 안 된다.** 8.23.0은 원격 메모리 고갈 DoS(상대가 읽기를 멈춘 채 ping을 퍼부으면 자동 pong이 쌓임) 보안 수정이고 `maxPendingAutoPongs`(기본 60) 옵션이 추가됐다. [확인]
2. **100방 × 20명(2,000 접속)은 `ws` 프로세스 하나로 된다.** 코어 1개의 약 32%, RSS 약 95MB. 150방은 45%, 200방은 57%(틱 지연이 흔들리기 시작), 300방은 84%로 포화 직전이다. [측정] 실제 게임 로직이 얹히므로 **프로세스당 100방을 계획 상한**으로 잡는다. [추론]
3. **병목은 CPU가 아니라 대역폭이다.** 바이너리 더티 스냅샷은 접속자당 약 2.5KB/s(WebSocket 수준), TLS·TCP·IP를 더하면 약 3.2KB/s, 2,000명이면 약 52Mbps다. 같은 내용을 JSON 배열로 보내면 3.3배, 전체 상태 JSON이면 14배다. CPU는 JSON이어도 4.5~6.4%p밖에 안 늘었다. [측정+추론] 현재의 바이너리(플레이어 8B, NPC 7B) 설계가 맞다.
4. **uWebSockets.js는 지금 필요 없다.** 같은 부하에서 CPU가 32% → 23~25%로 줄 뿐이고(커널 시스템 콜이 절반이라 줄일 수 없는 부분이 크다), 네이티브 바이너리 91MB와 Node ABI 종속(v20.67.0에서 Node 20 지원 제거)을 떠안는다. [측정+확인] 한계에 닿으면 프로세스를 나누는 쪽이 낫다.
5. **모든 방을 한 틱에 몰아 돌리면 안 된다.** 100방을 한 번에 돌리면 틱 한 번이 p50 14ms, p99 27ms 동안 이벤트 루프를 막는다. 틱 간격을 10칸으로 나눠 방을 분산하면 p99 3ms가 되고 봇이 잰 왕복 시간 p95가 13ms → 1.9ms로 내려간다. [측정]
6. **보간용 시계는 "도착 기준"이어야 한다.** 지금 클라이언트는 `진짜 서버 시각 − 190ms`를 렌더 시각으로 쓰는데, 이러면 실제 버퍼가 `190 − 편도 지연`이 된다. 편도 지연이 90ms를 넘는 사용자(왕복 180ms 이상)는 매 틱 끊긴다. 스냅샷 도착 시각으로 오프셋을 잡으면 지연과 무관하게 버퍼가 일정하다. [추론, geckos 라이브러리 소스로 같은 방식임을 확인]
7. **"직전 패킷과의 도착 간격"으로 속도를 검증하면 정직한 모바일 사용자가 튕긴다.** TCP는 정체 뒤에 패킷을 몰아서 준다. 달리기(5.6m/s)는 100ms에 0.56m를 가는데 현재 여유값이 0.5m라, 몰려 온 패킷은 첫 장을 빼고 전부 거절된다. 시뮬레이션에서 5초마다 300ms 정체 시 5.9%가 오탐, 거리 예산 방식은 0건이었다. [측정]
8. **`bufferedAmount`는 늦게 울리는 경보다.** 읽기를 멈춘 상대에게 보낸 데이터는 먼저 커널 버퍼에 쌓이고(루프백 실측 약 4MB), 그 뒤에야 `bufferedAmount`가 오른다. 우리 전송률(2.5KB/s)에서 설계 문서의 "1MB" 기준은 사실상 영원히 안 걸린다. 죽은 연결은 하트비트가 먼저 잡아야 하고, 임계값은 "스냅샷 몇 초치" 단위로 낮게 잡는다. [측정+추론]
9. **모바일 백그라운드는 "끊긴다"를 전제로 설계한다.** 숨은 탭은 `requestAnimationFrame`이 멈추고 타이머가 1초(5분 뒤 조건부로 1분) 단위로 묶인다. iOS 26.3 Safari에는 백그라운드 복귀 뒤 `new WebSocket()`이 영영 CONNECTING에 머무는 미해결 버그 보고가 있다. 접속 타임아웃, 탭 복귀 시 즉시 재시도와 생존 확인이 필요하다. [확인]
10. **Durable Objects에서 10Hz 틱을 돌리면 절전(hibernation)이 안 되고, 상시 가동 방 100개의 체류 요금만 월 $412.50이다(Cloudflare 문서의 계산 예).** [확인] 기본 부하는 VM, DO는 0으로 줄어드는 탄력 용량으로 본다. [추론]

---

## 1. `ws` 패키지: 현재 버전과 운영 설정

### 1.1 버전과 최근 릴리스 [확인]

`npm view ws version` → **8.23.0**. 의존성 없음, MIT, `engines: node >= 10`, 풀린 크기 약 154KB. 선택적 peer 의존성으로 `bufferutil ^4.0.1`, `utf-8-validate >=5.0.2`.

| 버전 | npm 게시일 | 내용 |
|---|---|---|
| **8.23.0** | 2026-11-12 | `maxPendingAutoPongs` 옵션 추가. **보안 수정**: 상대가 읽기를 멈춘 채 ping을 계속 보내면 자동 pong이 버퍼에 쌓여 메모리가 고갈되는 원격 DoS. 같은 날 7.5.14, 6.2.7, 5.2.8로 백포트. 업그레이드 전 임시 조치는 `autoPong: false` 또는 하트비트로 제한. |
| 8.22.2 | 2026-11-08 | URL userinfo 퍼센트 디코딩, 생성자가 `URL` 객체를 변형하지 않음 |
| 8.22.1 | 2026-10-31 | Node의 `http.websocketMask()`/`websocketUnmask()`가 있으면 `bufferutil` 대신 사용 |
| 8.22.0 | 2026-09-26 | `protocols` 옵션 추가 |
| 8.21.3 | 2026-08-07 | permessage-deflate 협상 버그 수정 |

릴리스 노트에 CVE 번호는 적혀 있지 않았다. 저장소 `package.json`은 이미 `"ws": "8.23.0"`으로 고정돼 있다.

### 1.2 서버 옵션 기본값과 권장값

기본값은 설치한 `ws@8.23.0`의 `lib/websocket-server.js`와 `doc/ws.md`에서 읽었다. [확인]

| 옵션 | 기본값 | 우리 설정 | 이유 |
|---|---|---|---|
| `noServer` | `false` | **`true`** | HTTP(정적 파일, `/api/rooms`, `/healthz`)와 포트를 같이 쓰고, `upgrade` 이벤트에서 Origin·IP·방을 직접 심사한다. 공식 문서도 `verifyClient`는 "권장하지 않음, `upgrade` 이벤트에서 인증하라"고 한다. |
| `perMessageDeflate` | 서버 `false` (클라이언트 `true`) | **`false` 명시** | README: "성능과 메모리 소비 면에서 상당한 오버헤드", 리눅스에서 동시성이 높으면 zlib 때문에 "치명적인 메모리 파편화"가 날 수 있다. 250B짜리 바이너리 스냅샷은 압축 이득도 거의 없다. |
| `maxPayload` | **104,857,600 (100MiB)** | **4,096** (`MAX_MSG_BYTES`) | 기본값은 게임 서버에 지나치게 크다. 넘으면 ws가 1009로 닫는다(검증 스크립트에서 확인). |
| `clientTracking` | `true` | `false` | 어댑터가 `connId → 연결` Map을 이미 갖는다. |
| `autoPong` | `true` | 그대로 | 브라우저는 ping을 못 보내지만 악성 클라이언트는 보낸다. |
| `maxPendingAutoPongs` | 60 | 그대로 | 8.23.0 신규. 넘으면 강제 종료. |
| `maxFragments` | 16,384 | 그대로 | 신규 계열 옵션. `maxPayload`가 작으므로 기본값으로 충분. |
| `maxBufferedChunks` | 262,144 | 그대로 | 넘으면 1008로 닫는다. |
| `closeTimeout` | 30,000ms | 그대로 또는 5,000 | `close()` 뒤 종료 핸드셰이크를 기다리는 시간. 쫓아낸 연결을 빨리 정리하려면 줄인다. |
| `skipUTF8Validation` | `false` | 그대로 | 문서: "클라이언트를 신뢰할 때만 `true`". |
| `allowSynchronousEvents` | `true` | 그대로 | 한 틱에 여러 `message` 이벤트를 낼 수 있어 처리량에 유리. |

소스에서 확인한 동작 몇 가지: [확인]

- ws는 소켓을 받으면 스스로 `socket.setNoDelay()`(Nagle 끔)와 `socket.setTimeout(0)`을 호출한다. 따로 할 필요 없다.
- `bufferedAmount`는 `socket._writableState.length + sender._bufferedBytes`다. 즉 **아직 커널로 넘기지 못한 바이트**이고, 커널 버퍼에 들어간 것은 세지 않는다.
- 닫힌 소켓에 `send()`해도 예외를 던지지 않는다(콜백이 있으면 오류 전달). `CONNECTING` 상태에서만 던진다.
- 서버 → 클라이언트 프레임은 마스킹하지 않는다(RFC 6455 "서버는 마스킹하면 안 된다"). 그래서 같은 `Uint8Array`를 20명에게 복사 없이 보낼 수 있다.
- `bufferutil`: README에 따르면 Node v26.12.0 이상은 내장 함수를 쓰므로 설치해도 로드하지 않는다. 그 이하(우리 Node 22 포함)에서는 로드하지만, 소스를 보면 마스킹 48바이트 미만·언마스킹 32바이트 미만은 어차피 JS 경로다. 우리 클라이언트 → 서버 프레임은 7바이트라 **`bufferutil`을 넣어도 이득이 없다.** `utf-8-validate`는 Node v18.14.0 이상에서 불필요.

### 1.3 서버 설정 코드 (검증함)

아래 코드는 임시 폴더에서 `tsc --strict`(TypeScript 7.0.2)와 통합 테스트를 통과했다. 통합 테스트에서 확인한 것: 접속과 스냅샷 수신, 느린 클라이언트 건너뛰기 후 강제 종료, pong을 안 하는 상대 종료와 정상 유휴 연결 유지, 4,096바이트 초과 시 1009 종료, 초당 제한 초과분 버리기.

검증한 파일에서는 한 함수 안에 있던 것을 읽기 쉽게 절별로 나눠 실었고, 나눠 실은 블록들을 다시 한 파일로 모아 타입 검사를 통과시켰다. `handleHttp`, `allowedOrigins`, `trustProxy`, `lobby`, `metrics`, `RoomLike`(`connect`/`message`/`disconnect`/`tick`을 가진 방)는 어댑터의 다른 부분에 있다고 본다. 7.2절의 `lobby.all()`은 방 객체 배열을 돌려주는 가상의 접근자다(현재 `Lobby`에는 `rooms()`와 `get()`만 있다). `takeToken`은 5.2절, `send`는 1.6절, 하트비트는 1.5절, 틱 루프와 종료는 7.2절, 지표는 8.3절에 있다.

```ts
// server/node — ws 서버 설정 + 업그레이드 심사 + 연결 수명 관리
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

const MAX_MSG_BYTES = 4096
const MAX_CONNS_PER_IP = 24 // 통신사 NAT 를 감안해 넉넉히
const RATE_PER_SEC = 40
const RATE_BURST = 60
const RATE_KICK_AFTER_MS = 3_000
const CLOSE_KICK = 4002

interface Conn {
  id: number
  ws: WebSocket
  ip: string
  room: RoomLike
  /** 마지막으로 무엇이든(메시지·pong) 받은 시각 */
  lastSeenAt: number
  lastPingAt: number
  tokens: number
  tokenAt: number
  overLimitSince: number
  snapSkipped: number
}

const conns = new Map<number, Conn>()
const connsPerIp = new Map<string, number>()
let nextConnId = 1

const http = createServer(handleHttp) // 정적 파일, /api/rooms, /healthz

const wss = new WebSocketServer({
  noServer: true, // HTTP 서버와 포트를 같이 쓰고, 업그레이드를 직접 심사한다
  perMessageDeflate: false, // 서버 기본값도 false. 작은 바이너리에는 손해(메모리·CPU)
  maxPayload: MAX_MSG_BYTES, // 기본 100MiB → 4KB. 넘으면 ws 가 1009 로 닫는다
  clientTracking: false, // wss.clients 대신 우리 Map 으로 추적
})

http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const onSocketError = (): void => {
    socket.destroy()
  }
  socket.on('error', onSocketError)

  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found')

  const origin = req.headers.origin
  if (allowedOrigins.size > 0 && (!origin || !allowedOrigins.has(origin))) return refuse(socket, 403, 'Forbidden')

  const ip = clientIp(req, trustProxy)
  if ((connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) return refuse(socket, 429, 'Too Many Requests')

  const room = lobby.pick(url.searchParams.get('room'))
  // 방이 전부 가득이면: 설계대로라면 일단 받은 뒤 full 메시지 + CLOSE_FULL 로 알려 준다. 여기서는 단순화해 503 으로 거절한다.
  if (!room) return refuse(socket, 503, 'Service Unavailable')

  wss.handleUpgrade(req, socket, head, (ws) => {
    socket.removeListener('error', onSocketError)
    accept(ws, ip, room)
  })
})

function accept(ws: WebSocket, ip: string, room: RoomLike): void {
  const now = performance.now()
  const c: Conn = { id: nextConnId++, ws, ip, room, lastSeenAt: now, lastPingAt: 0, tokens: RATE_BURST, tokenAt: now, overLimitSince: 0, snapSkipped: 0 }
  conns.set(c.id, c)
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1)

  // 'error' 리스너가 없으면 프로토콜 오류(잘못된 프레임, 1009 등) 한 번에 프로세스가 죽는다
  ws.on('error', () => {})
  ws.on('pong', () => {
    c.lastSeenAt = performance.now()
  })
  ws.on('message', (data: RawData, isBinary: boolean) => {
    const t = performance.now()
    c.lastSeenAt = t
    if (!takeToken(c, t)) return
    try {
      const bytes = toBytes(data)
      // 텍스트 프레임도 ws 8 에서는 Buffer 로 온다(isBinary=false). UTF-8 검증은 ws 가 이미 했다.
      c.room.message(c.id, isBinary ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'))
    } catch (err) {
      console.error('message handler failed', err) // 한 메시지의 예외가 방을 죽이지 않게
    }
  })
  ws.on('close', () => {
    if (!conns.delete(c.id)) return
    const n = (connsPerIp.get(ip) ?? 1) - 1
    if (n <= 0) connsPerIp.delete(ip)
    else connsPerIp.set(ip, n)
    c.room.disconnect(c.id)
  })
  room.connect(c.id)
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function clientIp(req: IncomingMessage, trust: boolean): string {
  if (trust) {
    // 프록시가 덧붙인 "마지막" 값만 믿는다(앞쪽 값은 클라이언트가 위조할 수 있다)
    const xff = req.headers['x-forwarded-for']
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff
    const last = raw?.split(',').pop()?.trim()
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** binaryType 기본값('nodebuffer')이면 Buffer 하나가 온다. 나머지 분기는 설정이 바뀌었을 때의 안전망 */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data
}
```

### 1.4 바이너리 프레임과 ArrayBuffer 처리에서 틀리기 쉬운 것

- **서버 쪽 `binaryType`은 기본값 `'nodebuffer'`를 그대로 쓴다.** 허용 값은 `nodebuffer`, `arraybuffer`, `fragments`, (Blob이 있는 런타임에서) `blob`이다. [확인] `Buffer`는 `Uint8Array`의 하위 클래스라 `Room.message(conn, data: string | ArrayBuffer | Uint8Array)`에 그대로 넘길 수 있다. `'arraybuffer'`로 바꾸면 ws가 새 `ArrayBuffer`로 복사하는 경우가 생긴다.
- **`Buffer`는 큰 `ArrayBuffer`의 일부를 가리키는 뷰일 수 있다.** `new DataView(buf.buffer)`는 버그다. 반드시 `new DataView(buf.buffer, buf.byteOffset, buf.byteLength)`를 쓴다. `shared/protocol.ts`의 `toView()`는 이미 이렇게 한다. [확인]
- **ws 8에서는 텍스트 프레임도 `Buffer`로 오고 `isBinary`가 `false`다.** `typeof data === 'string'`으로 분기하면 안 된다. [확인]
- **브라우저 쪽은 `ws.binaryType = 'arraybuffer'`를 반드시 설정한다.** 기본값 `'blob'`은 비동기 변환이 필요하다. 수신 시 `typeof ev.data === 'string'`이면 JSON, 아니면 `ArrayBuffer`다.
- **`send()`에 넘긴 버퍼를 다시 쓰면 안 된다.** 소켓이 밀려 있으면 데이터가 참조로 큐에 남는다. 할당을 줄이려고 스냅샷 인코딩 버퍼를 풀링하면 느린 클라이언트에게 깨진 데이터가 나간다. 스냅샷마다 새 `Uint8Array`를 만든다(100방에서 초당 1,000개, 250B씩이라 부담이 없다). `encodeSnapshot()`은 이미 매번 새로 만든다. [추론: `bufferedAmount` 구현과 Node 스트림 큐 동작에 근거]
- 프레임 헤더 크기(RFC 6455) [확인]: 기본 2바이트, 페이로드가 126바이트 이상이면 길이 2바이트 추가(65,536 이상이면 8바이트), 클라이언트 → 서버는 마스킹 키 4바이트 추가. 우리 스냅샷(약 250B)은 헤더 4바이트, 이동 패킷(7B)은 헤더 6바이트다.
- ping/pong 제어 프레임은 페이로드 125바이트 이하, ping을 받으면 pong을 보내야 한다. 종료 코드 4000~4999는 사설 용도라 우리 `CLOSE_FULL=4001` 등이 규격에 맞다. [확인]

### 1.5 하트비트: ping/pong + terminate

ws README의 표준 패턴은 "30초마다 전원에게 `ping()`, 지난 주기에 pong이 없던 연결은 `terminate()`"다. `close()`가 아니라 `terminate()`를 쓰는 이유는 죽은 상대와는 종료 핸드셰이크가 안 끝나기 때문이다. [확인]

우리 서버에 맞춘 변형은 두 가지다. [추론]

1. **무엇이든 받으면 살아 있는 것으로 친다.** 플레이 중인 연결은 10Hz로 이동 패킷을 보내거나 4초마다 앱 ping을 보내므로 프로토콜 ping이 필요 없다. 조용한 연결(숨은 탭)만 ping한다. 2,000명에게 동시에 ping을 쓰는 버스트도 없어진다.
2. **"연결이 살아 있는가"와 "사람이 자리에 있는가"를 분리한다.** 브라우저는 JS 타이머가 묶여도 네트워크 스택이 pong을 자동으로 돌려준다. pong만 오는 숨은 탭은 연결은 살아 있지만 자리를 차지하고 있다. 자리 비움은 별도 타이머(입력 없음 3~5분 → `kick{why:'idle'}`)로 처리한다. 현재 `IDLE_TIMEOUT_MS = 45초`("아무 메시지도 없으면 끊는다")는 두 개념이 섞여 있다. 숨은 탭에서 앱 ping 타이머가 1분 간격으로 묶이면(6.4절) 45초 기준에 걸려 끊긴다.

프록시 유휴 타임아웃도 주기를 정하는 근거다. nginx는 프록시된 서버가 60초 동안 아무것도 보내지 않으면 연결을 닫는다(`proxy_read_timeout`으로 조정, 또는 서버가 주기적으로 ping 프레임을 보내면 된다). [확인] Cloudflare는 "일정 시간" 양방향 데이터가 없으면 닫고, 새 코드를 배포할 때 서버 재시작으로 WebSocket이 끊길 수 있다고 적어 두었다(구체적 초 수는 문서에 없음). [확인] 우리 서버는 방이 조용해도 1초에 한 번 빈 스냅샷을 보내므로 유휴 타임아웃에는 걸리지 않는다.

```ts
const HEARTBEAT_SWEEP_MS = 5_000
const PING_AFTER_SILENT_MS = 15_000 // 이만큼 조용하면 ws ping 을 보낸다
const DEAD_AFTER_SILENT_MS = 40_000 // 이만큼 조용하면(메시지도 pong 도 없음) 끊는다

const heartbeat = setInterval(() => {
  const now = performance.now()
  for (const c of conns.values()) {
    const silent = now - c.lastSeenAt
    if (silent > DEAD_AFTER_SILENT_MS) {
      metrics.heartbeatKills++
      c.ws.terminate() // close 핸드셰이크를 기다리지 않는다 → 'close' 이벤트에서 정리
    } else if (silent > PING_AFTER_SILENT_MS && now - c.lastPingAt > PING_AFTER_SILENT_MS / 2) {
      c.lastPingAt = now
      if (c.ws.readyState === WebSocket.OPEN) c.ws.ping()
    }
  }
}, HEARTBEAT_SWEEP_MS)
```

브라우저 JS에는 ping API가 없다. 클라이언트 쪽 생존 확인은 "서버가 최소 1초에 한 번은 뭔가 보낸다"는 사실을 이용한 침묵 감시(5초)로 한다(6.1절 코드).

### 1.6 백프레셔: `bufferedAmount`로 느린 클라이언트 다루기

[측정] 읽기를 멈춘 클라이언트(`ws.pause()`)에게 250B 프레임을 계속 보낸 결과:

- 약 **4.06MB**를 보낼 때까지 `bufferedAmount`는 0이었다. 커널 송수신 버퍼가 전부 흡수했다(이 기기의 `tcp_wmem` 최대 4MB, `tcp_rmem` 최대 32MB, 루프백).
- 그 뒤로는 프로세스 메모리에 그대로 쌓였다. 4초 뒤 `bufferedAmount` 4.9MB.

[추론] 이 수치에서 나오는 결론:

- 실제 인터넷에서는 커널이 흡수하는 양이 더 작지만(상대 수신 창과 혼잡 창에 묶임), 순서는 같다. **`bufferedAmount > 0`은 이미 한참 밀렸다는 뜻이다.**
- 우리 전송률은 접속자당 약 2.5KB/s다. 설계 문서의 "1MB를 넘으면" 기준은 400초 분량이라 하트비트(40초)보다 훨씬 늦다. 임계값을 "스냅샷 몇 초치"로 다시 잡는다.
- 스냅샷(위치)은 늦으면 가치가 없으므로 버린다. JSON 이벤트(합류, 보상, 초대)는 버리면 상태가 어긋나므로 버리지 않는다. 이벤트까지 크게 밀리면 끊고 재접속시키는 편이 싸다(재접속하면 `welcome`으로 전체 상태를 다시 받는다).
- 죽은 상대는 하트비트가 잡고, `bufferedAmount`는 메모리 상한을 지키는 안전망이다.

```ts
const SNAP_SKIP_BYTES = 16 * 1024 // 스냅샷 약 5초치(2.5KB/s 기준)가 밀렸으면 위치는 버린다
const HARD_LIMIT_BYTES = 256 * 1024 // 이벤트까지 이만큼 밀리면 끊는다(재접속이 더 싸다)

/** 코어의 host.send 구현. droppable=true 는 스냅샷처럼 "늦으면 버려도 되는" 데이터 */
function send(connId: number, data: string | Uint8Array, droppable = false): boolean {
  const c = conns.get(connId)
  if (!c || c.ws.readyState !== WebSocket.OPEN) return false
  // bufferedAmount = 아직 커널로 못 넘긴 바이트(소켓 쓰기 큐 + ws 내부 큐). 정상 연결이면 항상 0 에 가깝다.
  const queued = c.ws.bufferedAmount
  if (queued > HARD_LIMIT_BYTES) {
    metrics.slowKicks++
    c.ws.terminate() // close() 는 큐가 빠질 때까지 기다리므로 느린 상대에게는 의미가 없다
    return false
  }
  if (droppable && queued > SNAP_SKIP_BYTES) {
    c.snapSkipped++
    metrics.snapSkipped++
    return false
  }
  // 같은 Uint8Array 를 여러 소켓에 그대로 넘긴다(서버→클라는 마스킹이 없어 복사하지 않는다).
  // 큐에 참조로 남을 수 있으므로 send 뒤에 이 버퍼를 재사용/수정하면 안 된다.
  c.ws.send(data, { binary: typeof data !== 'string' })
  metrics.framesOut++
  const len = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
  metrics.bytesOut += len + (len < 126 ? 2 : 4)
  return true
}

// Room 쪽: 스냅샷은 한 번만 인코딩해서 방 전원에게 같은 버퍼를 보낸다
// for (const p of players) host.send(p.conn, snapshotBytes, true)
```

`welcome`은 수 KB일 수 있다. `SNAP_SKIP_BYTES`가 그보다 작으면 접속 직후 스냅샷 몇 장이 건너뛰어질 수 있지만, `hold` 처리 덕에 해가 없다.

클라이언트 → 서버 방향에도 같은 원리를 쓴다. 브라우저 `WebSocket.bufferedAmount`는 "`send()`로 큐에 넣었지만 아직 네트워크로 나가지 않은 바이트"다. [확인] 이동 패킷을 보내기 전에 `ws.bufferedAmount > 0`이면 이번 것은 건너뛴다. 업링크가 막혔을 때 낡은 위치가 쌓였다가 한꺼번에 나가는 것(5.2절의 속도 제한 오탐 원인)을 원천에서 막는다. [추론]

### 1.7 uWebSockets.js는 쓸 만한가

[확인] 현황:

- 최신은 **v20.72.0**(릴리스 페이지에 11월 24일로 표시). npm 레지스트리에는 없고(`npm view uWebSockets.js`는 404) `npm install uNetworking/uWebSockets.js#v20.72.0`처럼 GitHub에서 받는다. Apache-2.0.
- v20.67.0에서 **Node 26 지원 추가, Node 20과 25 지원 제거**. v20.72.0 패키지에는 ABI 127/137/147(Node 22/24/26)용 바이너리가 darwin arm64·x64, linux arm64·x64, win32 x64로 들어 있고 풀린 크기가 **91MB**다. 우리 `package.json`은 `engines: node >= 20`이다.
- API가 다르다. 자체 HTTP 서버라 `node:http`와 붙지 않고, 메시지 `ArrayBuffer`는 콜백 안에서만 유효하며, 방송은 내장 pub/sub(`ws.subscribe`, `app.publish`)을 쓴다.

[측정] 같은 방 로직, 같은 봇으로 비교(100방 2,000접속, 바이너리, 10Hz):

| 라이브러리 | CPU(코어 1개 대비) | 그중 user / sys | RSS | 접속당 RSS 증가 |
|---|---|---|---|---|
| ws 8.23.0 | 32.2% | 16.6 / 15.6 | 94MB | 약 8~11KB |
| uWebSockets.js 20.72.0 | 24.7% | 8.3 / 16.5 | 73MB | 약 7KB |
| uWebSockets.js 20.52.0 | 22.9% | 7.9 / 15.1 | 74MB | 약 7KB |

300방 6,000접속에서는 ws 84.3%, uWS(20.52.0) 60.2%였다.

[추론] 판단: **지금은 도입하지 않는다.**

- 줄어드는 것은 user 시간(JS 프레이밍)뿐이고, 커널 시스템 콜 시간(약 15%)은 그대로다. 100방에서 아끼는 것은 코어의 8%p 정도다.
- 대가는 네이티브 의존성, Node 버전 종속, 어댑터 재작성, "런타임 의존성은 `three`와 `ws`만"이라는 프로젝트 규칙 위반이다.
- 프로세스 하나가 250방 이상을 감당해야 하는 상황이 오면 다시 볼 만하지만, 그 전에 방 id로 프로세스를 나누는 편이 장애 격리와 무중단 배포까지 같이 해결한다(7.4절).
- 외부 벤치마크는 `ws`와의 직접 비교를 찾지 못했다. Evil Martians(2026-06-24)의 5종 비교에는 uWebSockets.js는 있지만 `ws`는 없다(uWS 유휴 연결당 약 5KB, Socket.io 약 52KB). [확인] uWebSockets.js 쪽의 "ws보다 10~30배 빠르다"는 주장은 검색 요약으로만 봤고 검증하지 못했다. [요약] 우리 부하에서 CPU 기준 차이는 1.3~1.4배였다. [측정]

---

## 2. 전송 주기와 스냅샷 설계

### 2.1 권장 주기 [추론, 근거는 3.1절 표]

| 방향 | 권장 | 근거 |
|---|---|---|
| 클라이언트 → 서버 이동 | **10Hz**, 움직일 때만, 멈출 때 Idle 1회 | 서버 틱이 10Hz라 그보다 자주 보내도 서버는 마지막 값만 쓴다. 12~15Hz는 대역폭만 늘린다. 현재 `CLIENT_SEND_HZ = 10` 유지. |
| 서버 → 클라이언트 스냅샷 | **10Hz**, 변한 엔티티만, 조용하면 1Hz 빈 스냅샷 | 보간 지연 200ms와 짝. 8Hz로 내리면 대역폭 −20%지만 지연을 250ms로 늘려야 한다. 지금은 불필요. |
| 앱 ping | 4초 (`PING_INTERVAL_MS`) | 시계 보정과 RTT 표시용. 접속 직후 0.2초 간격으로 3~5회 몰아 보내면 빨리 수렴한다. |
| 서버 틱 | 10Hz, 방을 10칸에 분산 | 7.2절 측정. |

다른 플레이어가 화면에 보이기까지의 지연은 대략 `올라가는 편도 지연 + 틱 대기(평균 50ms) + 내려오는 편도 지연 + 보간 200ms`로 300~350ms다. 전투가 없는 사교형 게임에서는 문제가 되지 않는다. 포교 판정, 배틀, 설교는 서버 권위 이벤트(JSON)라 이 지연과 무관하다.

참고: Colyseus(Node 게임 서버 프레임워크)의 기본 상태 패치 주기는 50ms(20Hz)다. [확인]

### 2.2 더티 스냅샷과 델타

- 현재 설계(변한 엔티티만 전송, 스냅샷에 없는 엔티티는 "그 시각까지 제자리")는 그대로 둔다.
- Gaffer on Games의 델타 압축이 복잡한 이유는 UDP 손실 때문에 기준 스냅샷을 ack로 맞춰야 해서다. **WebSocket(TCP)은 손실도 역순도 없으므로 기준은 항상 "직전 메시지"다.** 다만 서버가 백프레셔로 스냅샷을 건너뛴 클라이언트는 사슬이 끊기므로 클라이언트별 "키프레임 필요" 플래그가 있어야 한다. [추론]
- 그래서 좌표를 int8 델타로 줄이는 방식(엔티티당 7~8B → 4B, 약 −40%)은 대역폭이 실제 문제가 될 때까지 미룬다.
- 먼저 할 만한 절감은 **NPC만 5Hz**(홀수 틱에는 NPC 블록 생략)다. NPC 블록이 평균 프레임의 절반 이상이라 WebSocket 수준으로 약 −28%, 전선 수준으로 약 −21%다(2.4절 계산). `hold` 보간이 이미 있어서 클라이언트 변경이 거의 없다. 다만 신도 행렬(콩가 라인)은 주인을 10Hz로 따라가야 자연스러우므로 "따라다니는 NPC는 10Hz, 배회 NPC는 5Hz"로 나눈다. [추론]
- 배회 NPC는 이동망 위를 일정 속도로 걷는다. "출발점·도착점·속도·출발 시각"만 보내면 위치 전송이 거의 사라지지만 구조 변경이 크다. 장기 과제로만 적어 둔다. [추론]

### 2.3 양자화

현재 형식 [확인: `shared/protocol.ts`]:

- 위치: `int16` cm, 범위 ±327.67m. 맵 반경이 이 안에 들어오는지만 확인하면 된다. 정밀도 1cm는 충분하다.
- yaw: `uint8`, 한 칸 360/256 ≈ 1.4°. 캐릭터 방향으로 충분하다.
- 스냅샷 헤더 11B = 종류 1 + 시각 `f64` 8 + 플레이어 수 1 + NPC 수 1. 플레이어 8B, NPC 7B. 리틀 엔디언 명시.

시각을 `f64`(8B) 대신 방 시작 기준 `u32` ms(약 49일에 한 바퀴)로 바꾸면 프레임당 4B, 약 2%가 준다. 프로토콜 버전을 올릴 일이 생길 때 같이 하면 된다. [추론]

### 2.4 대역폭 계산

[측정] 플레이어의 60%가 움직이고 NPC의 70%가 움직이는 조건에서 스냅샷 평균 크기:

| 형식 | 스냅샷 평균 | WebSocket 수준 접속자당 | 2,000명 합계 | 서버 CPU |
|---|---|---|---|---|
| 바이너리, 더티만 (현재 설계) | 245B | **2,485 B/s** | 39.8 Mbps | 32.2% |
| JSON 배열 `[id,x,z,yaw,st]`, 더티만, 소수 2자리 | 804B | 8,078 B/s | 129 Mbps | 36.7% |
| JSON 객체, 매 틱 전체 상태 | 3,431B | 34,315 B/s | 549 Mbps | 38.6% |

클라이언트 → 서버는 바이너리 49 B/s, JSON 309 B/s였다.

[추론] 실제 전선 위에서는 프레임마다 TLS 1.3 레코드 약 22B(헤더 5 + 인증 태그 16 + 타입 1)와 TCP/IP 헤더 40~52B(IPv4, 타임스탬프 옵션 포함 시 52)가 더 붙는다. 초당 10프레임이면 **내용과 무관하게 약 0.74KB/s**가 추가된다.

| 형식 | 전선 수준 접속자당 | 플레이 1시간 | 2,000명 최대 | 2,000명 24시간 × 30일 |
|---|---|---|---|---|
| 바이너리 | 약 3.24 KB/s (26 kbps) | 약 11.7MB | 약 52 Mbps | 약 16.8TB |
| JSON 더티 | 약 8.8 KB/s (71 kbps) | 약 32MB | 약 141 Mbps | 약 46TB |
| JSON 전체 | 약 35 KB/s (281 kbps) | 약 126MB | 약 561 Mbps | 약 182TB |

읽는 법:

- 사용자는 대부분 모바일 데이터로 들어온다. 바이너리는 시간당 약 12MB다.
- 서버 비용은 "플레이어-시간당 11.7MB"로 계산한다. 예: 하루 5,000명이 평균 15분 = 1,250 플레이어-시간 → 하루 14.6GB, 한 달 약 440GB.
- 전송량을 GB 단위로 과금하는 클라우드에서는 CPU보다 이 숫자가 비용을 정한다. 전송량이 포함된 요금제를 고른다(업체별 요금은 이번에 확인하지 않았다).

---

## 3. 스냅샷 보간

### 3.1 보간 지연은 얼마가 적당한가

| 출처 | 내용 | 표기 |
|---|---|---|
| Gabriel Gambetta, Entity Interpolation | 서버가 100ms마다 보내면 다른 플레이어를 약 100ms 과거로 그린다. 예측은 하지 않고 서버가 준 실제 데이터만 쓴다. 추측 항법(외삽)은 방향·속도가 순간적으로 바뀌는 게임에는 맞지 않는다. | [확인] |
| Gaffer on Games, Snapshot Interpolation | UDP 기준. 버퍼는 연속 2패킷 손실을 견디게 잡는다. 손실 2~5%에서 전송 간격의 3배, 10pps면 300ms(지터 포함 350ms). 200ms 외삽을 시험했으나 충돌이 있는 물리에서는 나빴고, 외삽은 대체로 직선 운동에서 50~250ms만 통한다. 전송률을 30pps로 올리면 지연 150ms, 60pps면 85ms. | [확인] |
| @geckos.io/snapshot-interpolation 1.1.1 (JS 라이브러리) | 기본 버퍼 = 서버 프레임 3개분 `(1000 / serverFPS) * 3`. 시계 오프셋은 `도착 시각 − 스냅샷 시각`으로 잡고("지연 포함"), 50ms 넘게 어긋나면 갈아 끼운다. | [확인: 패키지 소스] |
| Valve Source 엔진 위키 | 기본 보간 100ms, 최대 외삽 0.25초로 기억하지만 위키가 봇 차단으로 열리지 않았다. | 확인 못함 |

[추론] 우리 값: **200ms(전송 간격의 2배) + 최대 100ms 외삽.** 현재 `INTERP_DELAY_MS = 190`을 200으로 올린다.

- 2배면 스냅샷 한 장이 최대 100ms 늦어도 화면에 티가 나지 않는다. 외삽 100ms를 더하면 200ms 늦어도 멈춤이 보이지 않는다.
- 3배(300ms)는 UDP에서 "연속 2패킷 손실"을 견디려는 값이다. TCP에는 손실이 없고 지연만 있으며, 사교형 게임에서 300ms는 다른 사람의 반응이 굼떠 보인다.

### 3.2 TCP 위에서 달라지는 점

- **손실이 지연으로 바뀐다.** 세그먼트 하나를 잃으면 재전송이 도착할 때까지 뒤따르는 스냅샷도 전부 막힌다(HOL 블로킹). 풀리면 여러 장이 한꺼번에 온다. [상식]
- 얼마나 늦는가: RFC 8985(RACK-TLP)에 따르면 꼬리 손실 탐침의 기본 대기는 `2 × SRTT`(전송 중인 세그먼트가 하나뿐이면 구현별 ACK 지연 여유를 더할 수 있음), 재정렬 창은 `min_RTT / 4`에서 시작한다. [확인] 10Hz처럼 듬성듬성한 흐름에서는 잃은 스냅샷이 대략 `2 × RTT`에서 `100ms + 1.25 × RTT` 사이만큼 늦게 온다. RTT 40ms면 80~150ms 지각이고, 200ms 지연 + 100ms 외삽 안에 대부분 숨는다. [추론: 실제 손실 조건에서 측정하지 못했다. 이 환경의 커널에 netem이 없다.]
- 따라서 클라이언트는 다음을 처리해야 한다. [추론]
  - 낡은 스냅샷 여러 장이 한꺼번에 도착 → 전부 버퍼에 넣되 렌더 시각으로 알맞은 쌍을 고른다.
  - 몰려 온 표본으로 시계 오프셋을 흔들지 않는다.
  - 버퍼가 바닥나면 짧게 외삽하고 그 뒤로는 멈춘다(달려 나가게 두지 않는다).

### 3.3 재생 시계는 "도착 기준"으로 잡는다 (현재 설계의 문제)

현재 클라이언트는 ping/pong으로 맞춘 진짜 서버 시각을 써서 `rt = serverNow() − INTERP_DELAY_MS`로 그린다(`client/src/net/client.ts`, 설계 문서 5.3절). 이 방식은 편도 지연이 버퍼를 갉아먹는다. [추론]

- 스냅샷 k(서버 시각 `T_k`)는 클라이언트에 `T_k + L`(L = 편도 지연)에 도착한다.
- 다음 스냅샷이 도착하기 직전(`T_k + 100 + L`)의 렌더 시각은 `T_k + L − 90`이다. 이 값이 `T_k`보다 크면, 즉 **L > 90ms면 보간할 다음 표본이 아직 없다.**
- 버퍼 부족 비율은 대략 `(L − 90) / 100`이다. 편도 100ms(왕복 200ms)면 프레임의 10%, 편도 150ms면 60%가 멈춘다. 지터를 감안하면 왕복 120ms 근처부터 증상이 나온다.
- 서울·도쿄 리전에 붙는 국내 사용자는 괜찮지만, 서버 리전이 멀거나 Durable Object가 먼 곳에 생기면 바로 드러난다.

해법: 보간에는 **스냅샷이 도착한 시각으로 잡은 오프셋**을 쓴다. 이 오프셋은 진짜 오프셋에서 편도 지연만큼 뒤처진 값이라, 지연이 큰 사용자도 버퍼가 항상 `INTERP_DELAY_MS`다. geckos 라이브러리가 같은 방식이다. [확인]

진짜 서버 시각(ping/pong)은 쿨타임, 설교 남은 시간 같은 **게임 타이머 UI에만** 쓴다(4장). 시계를 두 개 둔다.

몰려 온 표본 처리: 지연이 가장 작았던 도착을 기준으로 삼는다. 덜 늦은 표본 쪽으로는 빨리 따라가고, 더 늦은 표본 쪽으로는 아주 천천히 따라간다(지연이 정말 늘었을 때만 수십 초에 걸쳐 적응).

### 3.4 `hold` 보정 하나

현재 구현(`client/src/net/interp.ts`)은 스냅샷에 없는 엔티티의 `hold`를 그 스냅샷 시각까지 늘린다. 방이 완전히 조용하면 스냅샷이 1초에 한 번만 오므로, 그 사이에 누가 출발하면 `hold`가 최대 1초 낡아 있다. 이때 첫 구간이 100ms가 아니라 최대 1초에 걸쳐 느리게 미끄러진다. [추론]

고치는 법: 새 표본을 넣을 때 직전 표본의 `hold`가 `t − TICK_MS`보다 작으면 `t − TICK_MS`로 올린다. "움직임은 항상 직전 틱에서 시작했다"고 보는 것이다. 서버는 더티가 있으면 매 틱 보내고 TCP는 빠뜨리지 않으므로 이 가정은 안전하다(서버가 백프레셔로 건너뛴 경우에만 살짝 어긋난다).

### 3.5 보간 버퍼 코드 (검증함)

단위 테스트로 확인한 것: 선형 보간, 서 있다 출발할 때 미끄러짐 없음(1Hz 빈 스냅샷 경우 포함), 외삽 100ms 한도와 정지 엔티티 외삽 금지, 순간이동 시 보간 생략, yaw 최단 방향, 역순·중복 무시, 600ms 정체 뒤 6장이 몰려 와도 재생 시계가 10ms 이상 밀리지 않음, 2초 이상 어긋나면 즉시 재설정.

```ts
// client/src/net — 재생 시계 + 엔티티 보간 버퍼
export const TICK_MS = 100
export const INTERP_DELAY_MS = 200 // 스냅샷 간격의 2배
const EXTRAPOLATE_MAX_MS = 100 // 버퍼가 바닥났을 때 직전 속도로 더 밀어 주는 한도
const TELEPORT_M = 4 // 이보다 멀면 보간하지 않고 순간이동
const MAX_SAMPLES = 16 // 10Hz × 1.6초

/**
 * 재생 시계: "스냅샷이 도착한 시각" 기준의 서버 시각 추정.
 * 진짜 서버 시각(NTP 방식)에서 편도 지연만큼 뒤처진 값이라, 지연이 큰 사람도 버퍼 길이가 INTERP_DELAY_MS 로 일정하다.
 * 지연이 가장 작았던 도착을 기준으로 삼고(빠른 추종), 늦게 온 표본(TCP 정체 뒤 몰아 오기)은 거의 무시한다.
 */
export class PlayoutClock {
  private offset = Number.NaN

  /** localNow 는 performance.now() */
  onSnapshot(serverTime: number, localNow: number): void {
    const d = serverTime - localNow
    if (Number.isNaN(this.offset) || Math.abs(d - this.offset) > 1000) {
      this.offset = d // 첫 표본, 또는 절전/탭 복귀로 시계가 크게 어긋났을 때
      return
    }
    // d 가 크다 = 덜 늦게 도착했다. 그쪽으로는 빨리, 반대쪽(늦은 도착)으로는 아주 천천히(지연이 정말 늘었을 때만 따라감)
    this.offset += (d - this.offset) * (d > this.offset ? 0.1 : 0.005)
  }

  /** 지금 화면에 그릴 서버 시각 */
  renderTime(localNow: number): number {
    return localNow + this.offset - INTERP_DELAY_MS
  }

  get ready(): boolean {
    return !Number.isNaN(this.offset)
  }
}

interface Sample {
  /** 이 위치가 찍힌 서버 시각 */
  t: number
  /** 이 시각까지는 같은 자리에 있었다(더티 스냅샷에 안 실린 동안 늘어난다) */
  hold: number
  x: number
  z: number
  yaw: number
  st: number
}

export interface Pose {
  x: number
  z: number
  yaw: number
  st: number
}

export class EntityTrack {
  private readonly buf: Sample[] = []

  /** 스냅샷에 이 엔티티가 실려 있을 때 */
  push(t: number, x: number, z: number, yaw: number, st: number): void {
    const last = this.buf[this.buf.length - 1]
    if (last) {
      if (t <= last.t) return // 중복/역순(재접속 직후 등)
      // 움직임은 항상 직전 틱에서 시작했다고 본다: 오래 서 있다 출발할 때 '느린 미끄러짐'을 막는다
      if (last.hold < t - TICK_MS) last.hold = t - TICK_MS
    }
    this.buf.push({ t, hold: t, x, z, yaw, st })
    if (this.buf.length > MAX_SAMPLES) this.buf.shift()
  }

  /** 스냅샷에 이 엔티티가 없을 때: 그 시각까지 제자리였다 */
  touch(t: number): void {
    const last = this.buf[this.buf.length - 1]
    if (last && t > last.hold) last.hold = t
  }

  clear(): void {
    this.buf.length = 0
  }

  /** rt 시각의 자세를 out 에 쓴다. 표본이 없으면 false */
  sample(rt: number, out: Pose): boolean {
    const buf = this.buf
    const n = buf.length
    if (n === 0) return false

    // rt 이하인 가장 최근 표본 a 를 뒤에서부터 찾는다(대부분 끝에서 1~3번째)
    let i = n - 1
    while (i > 0 && buf[i]!.t > rt) i--
    const a = buf[i]!
    const b = buf[i + 1]

    if (rt <= a.hold || (!b && a.st === 0)) return copy(a, out)

    if (b) {
      const span = b.t - a.hold
      const dx = b.x - a.x
      const dz = b.z - a.z
      if (span <= 0 || dx * dx + dz * dz > TELEPORT_M * TELEPORT_M) return copy(rt >= b.t ? b : a, out)
      const k = Math.min(1, (rt - a.hold) / span)
      out.x = a.x + dx * k
      out.z = a.z + dz * k
      out.yaw = lerpAngle(a.yaw, b.yaw, k)
      out.st = b.st !== 0 ? b.st : a.st // 구간 안에서는 '움직이는 쪽' 애니메이션
      return true
    }

    // 버퍼 바닥(최신 표본보다 rt 가 앞섬): 직전 구간 속도로 잠깐만 외삽하고 그 뒤로는 멈춘다
    const p = buf[i - 1]
    if (!p) return copy(a, out)
    const span = a.t - p.hold
    const over = Math.min(rt - a.hold, EXTRAPOLATE_MAX_MS)
    const dx = a.x - p.x
    const dz = a.z - p.z
    if (span <= 0 || dx * dx + dz * dz > TELEPORT_M * TELEPORT_M) return copy(a, out)
    const k = over / span
    out.x = a.x + dx * k
    out.z = a.z + dz * k
    out.yaw = a.yaw
    out.st = a.st
    return true
  }
}

function copy(s: Sample, out: Pose): boolean {
  out.x = s.x
  out.z = s.z
  out.yaw = s.yaw
  out.st = s.st
  return true
}

const TWO_PI = Math.PI * 2
/** 최단 방향 각도 보간 */
export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % TWO_PI
  if (d > Math.PI) d -= TWO_PI
  else if (d < -Math.PI) d += TWO_PI
  return a + d * k
}

/** 스냅샷 한 장을 트랙들에 반영: 실린 엔티티는 push, 안 실린 엔티티는 touch */
export function applySnapshot(
  tracks: Map<number, EntityTrack>,
  time: number,
  ents: readonly { id: number; x: number; z: number; yaw: number; st: number }[],
): void {
  const seen = new Set<number>()
  for (const e of ents) {
    let tr = tracks.get(e.id)
    if (!tr) tracks.set(e.id, (tr = new EntityTrack()))
    tr.push(time, e.x, e.z, e.yaw, e.st)
    seen.add(e.id)
  }
  for (const [id, tr] of tracks) if (!seen.has(id)) tr.touch(time)
}
```

사용:

```ts
// 스냅샷 수신 시
clock.onSnapshot(snap.time, performance.now())
applySnapshot(playerTracks, snap.time, snap.players)
applySnapshot(npcTracks, snap.time, snap.npcs)

// 매 프레임
const rt = clock.renderTime(performance.now())
for (const [id, tr] of playerTracks) if (id !== me.id && tr.sample(rt, pose)) writeView(id, pose)

// 재접속(welcome)·탭 복귀 시: 트랙을 비운다(낡은 표본으로 미끄러지지 않게)
```

선택 사항(나중에): 버퍼 부족 비율이 10초 동안 2%를 넘으면 지연을 +50ms(최대 400), 60초 동안 0이면 −25ms(최소 150)로 조절하는 적응형 지연. 값을 바꿀 때는 렌더 시각이 튀지 않게 재생 속도를 ±5% 안에서 조절한다. 고정 200ms로 시작해 실제 지표(버퍼 부족 횟수)를 보고 결정한다. [추론]

---

## 4. 시간 동기화 (게임 타이머용)

쿨타임, 설교·배틀 남은 시간처럼 서버가 준 절대 시각(`until`)을 표시할 때만 진짜 서버 시각이 필요하다.

방식: ping/pong 왕복. `offset = s + rtt/2 − 수신 시 로컬 시각`(s = 서버가 pong에 적은 시각). 왕복이 대칭이라는 가정이 깨질수록 틀리므로, **최근 8개 표본 중 왕복 시간이 가장 짧은 표본**을 쓴다(혼잡이나 HOL로 부풀려진 표본을 거른다. NTP의 시계 필터와 같은 생각이다 [상식]).

주의점: [추론]

- 로컬 시계는 `performance.now()`를 쓴다. `Date.now()`는 사용자가 시계를 바꾸거나 OS가 시각을 맞출 때 튄다. 현재 클라이언트는 `Date.now()`를 쓴다.
- 서버는 `ping`을 받는 즉시 `pong`을 보낸다(다음 틱까지 미루면 최대 100ms가 한쪽으로 치우친다). 현재 설계는 즉시 응답이다.
- 500ms 넘게 어긋나면 바로 맞추고, 아니면 25%씩 당긴다(타이머 숫자가 튀지 않게).
- 스냅샷 시각으로 하한을 보정하는 현재 방식(`snap.time`이 `serverNow()`보다 앞서면 올린다)은 유지해도 된다. 메시지는 보낸 뒤에만 도착하므로 항상 참인 하한이다.
- 타이머 UI는 100ms 단위로 충분하다. 이 정도 정밀도면 TCP 위에서도 문제없다.

```ts
/**
 * 게임 타이머(쿨타임·설교 남은 시간)용 '진짜' 서버 시각. ping/pong 왕복으로 추정한다.
 * 최근 8개 표본 중 왕복 시간이 가장 짧은 것을 믿는다(혼잡으로 부풀려진 표본을 거른다).
 */
export class ServerClock {
  private readonly samples: { rtt: number; offset: number }[] = []
  private offset = 0
  rtt = 0

  /** c: ping 에 실어 보낸 performance.now(), s: 서버가 pong 에 적은 epoch ms */
  onPong(c: number, s: number, localNow: number): void {
    const rtt = localNow - c
    if (!(rtt >= 0 && rtt < 5000)) return
    this.samples.push({ rtt, offset: s + rtt / 2 - localNow })
    if (this.samples.length > 8) this.samples.shift()
    let best = this.samples[0]!
    for (const x of this.samples) if (x.rtt < best.rtt) best = x
    const first = this.samples.length === 1
    // 처음이거나 크게 어긋났으면 바로 맞추고, 아니면 조금씩 당긴다(타이머 UI 가 튀지 않게)
    this.offset = first || Math.abs(best.offset - this.offset) > 500 ? best.offset : this.offset + (best.offset - this.offset) * 0.25
    this.rtt = best.rtt
  }

  /** 서버 epoch ms */
  now(localNow: number): number {
    return localNow + this.offset
  }
}
```

검증: 대칭 지연 표본 뒤에 돌아오는 길만 300ms 걸린 표본을 넣어도 오프셋이 1ms 이내로 유지됐다.

---

## 5. 서버 검증과 제한

### 5.1 이동 검증: 도착 간격 방식은 오탐한다 → 거리 예산 방식

현재 설계(ARCHITECTURE 4.2): `이동 거리 > 허용 속도 × (직전 패킷 이후 경과 시간) × 1.5 + 0.5m`면 되돌리고 `pos` 보정.

문제: TCP는 정체 뒤에 패킷을 몰아서 준다. 몰려 온 패킷 사이의 경과 시간은 0에 가깝고, 그러면 허용 거리는 0.5m뿐이다. 달리기는 100ms에 0.56m, 스프린트는 0.84m를 가므로 **몰려 온 패킷은 첫 장 빼고 전부 거절**된다. 사용자는 터널을 나오는 순간 뒤로 끌려간다.

[측정] 정직한 클라이언트가 달리기 속도로 100ms마다 보내고, 네트워크가 주기적으로 정체되는 시뮬레이션(3,000패킷):

| 조건 | 도착 간격 방식 거절 | 거리 예산 방식 거절 |
|---|---|---|
| 달리기 5.6m/s, 5초마다 300ms 정체 | 177 (5.9%) | 0 |
| 달리기 5.6m/s, 2초마다 500ms 정체 | 745 (24.8%) | 0 |
| 스프린트 8.4m/s, 5초마다 300ms 정체 | 177 | 0 |
| 걷기 3.4m/s, 5초마다 300ms 정체 | 0 | 0 |
| 달리기, 3초마다 1,000ms 정체 | 990 | 0 |
| 달리기, 5초마다 2,000ms 정체 | 1,180 | 413 (예산 창 1.2초를 넘는 정체. 의도된 보정) |

부하 벤치마크에서도 같은 일이 났다. 200방 실행 중 이벤트 루프가 밀렸을 때 도착 간격 방식이 정직한 봇의 이동을 20초 동안 68건 거절했다. [측정]

거리 예산 방식: 시간이 흐른 만큼 "쓸 수 있는 거리"가 쌓이고(상한 있음), 이동할 때마다 쓴다. 몰림은 예산이 흡수하므로 여유 배수를 1.5에서 1.15로 줄일 수 있다. 장기 평균 속도는 `허용 속도 × 1.15`를 넘지 못한다.

```ts
/** 예산 방식은 몰림을 예산이 흡수하므로 여유 배수를 작게 잡아도 된다(프레임 적분 오차·시계 차이만 덮으면 됨) */
const CREDIT_TOLERANCE = 1.15
const CREDIT_WINDOW_S = 1.2 // 예산은 최대 1.2초치까지만 쌓인다(오래 서 있다가 순간이동하는 것 방지)
const SLACK_M = 0.3 // 예산이 이만큼까지는 '빚'이 될 수 있다(양자화 오차 등)

interface Mover {
  x: number
  z: number
  /** 쓸 수 있는 이동 거리(m) */
  credit: number
  creditAt: number
}

/** 통과하면 true(위치 갱신), 아니면 false(서버가 pos 보정 전송) */
function validateMove(p: Mover, x: number, z: number, now: number, maxSpeed: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false
  const cap = maxSpeed * CREDIT_TOLERANCE * CREDIT_WINDOW_S
  p.credit = Math.min(cap, p.credit + ((now - p.creditAt) / 1000) * maxSpeed * CREDIT_TOLERANCE)
  p.creditAt = now
  const dist = Math.hypot(x - p.x, z - p.z)
  if (dist > p.credit + SLACK_M) return false
  p.credit -= dist // 음수(빚) 허용: 여유분이 패킷마다 공짜로 주어지지 않게
  p.x = x
  p.z = z
  return true
}
```

[측정] 치터 확인: 2배속으로 달리면 60초 동안 600건 전부 거절. 1.3배속은 69건 거절되고 실제 전진 거리가 386.6m(= 5.6 × 1.15 × 60)로 묶였다.

그 밖의 검증: [추론]

- `maxSpeed`는 서버가 아는 상태로 정한다(`sprintUntil` 안이면 SPRINT, 아니면 RUN). 얼어붙은 상태(`stunUntil`)면 무시하고 보정.
- 경계 밖은 자른다. 추가로 서버에서도 `resolveCollision`을 한 번 돌려 건물 안, 직급이 모자란 HQ 내부 같은 **들어가면 안 되는 곳**을 막는다. 속도 검증만으로는 벽 통과를 못 막는다.
- 바이너리 이동 패킷은 길이가 정확히 7바이트이고 첫 바이트가 `BIN_MOVE`일 때만 받는다(현재 `decodeMove`가 그렇게 한다). int16이라 NaN은 올 수 없다.
- 거절이 계속되는 연결(예: 10초에 20회 이상)은 기록하고, 필요하면 쫓아낸다.

### 5.2 연결당 속도 제한

현재 설계: 토큰 버킷 `RATE_LIMIT_PER_SEC = 40`, "넘치면 `kick{why:'rate'}`".

문제: 업링크가 5초 막혔다 풀리면 이동 패킷 50장이 한꺼번에 온다. 버킷이 40이면 10장이 넘치고 정직한 사용자가 쫓겨난다. [추론]

권장: [추론, 코드는 검증함]

- 넘치는 메시지는 **버린다**. 쫓아내는 것은 초과 상태가 3초 넘게 이어질 때만.
- 버스트 용량을 60으로(평소 유입은 초당 10~11개라 여유가 크다).
- 클라이언트는 `bufferedAmount > 0`이면 이동 패킷을 건너뛴다(1.6절). 몰림 자체가 줄어든다.

```ts
/** 토큰 버킷. 넘치면 버리고, 3초 넘게 계속 넘치면 끊는다(탭 복귀 직후의 몰아 보내기로 오탐하지 않게) */
function takeToken(c: Conn, now: number): boolean {
  c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.tokenAt) / 1000) * RATE_PER_SEC)
  c.tokenAt = now
  if (c.tokens >= 1) {
    c.tokens -= 1
    c.overLimitSince = 0
    return true
  }
  metrics.rateDrops++
  if (c.overLimitSince === 0) c.overLimitSince = now
  else if (now - c.overLimitSince > RATE_KICK_AFTER_MS) c.ws.close(CLOSE_KICK, 'rate')
  return false
}
```

접속 전 단계의 제한: [추론]

- `upgrade`에서 Origin 검사(`ALLOWED_ORIGINS`). 운영에서는 비워 두지 않는다.
- IP당 동시 접속 상한. 국내 이동통신은 여러 사용자가 한 IP를 같이 쓰는 경우가 있으므로 20~30 정도로 넉넉히 잡는다. 프록시 뒤라면 `X-Forwarded-For`의 **마지막** 값만 믿는다.
- `hello` 제한 시간(`HELLO_TIMEOUT_MS = 8초`)은 이미 있다.
- 종류별 쿨타임(이모트, 말풍선, 초대)도 이미 있다. 버킷은 총량, 쿨타임은 종류별 방어로 둘 다 유지한다.

### 5.3 메시지 크기와 형식

- 크기: `maxPayload: 4096`으로 ws가 막는다. 실제 클라이언트 메시지는 `hello`(저장본 포함)를 빼면 100바이트 안팎이다. `hello`가 4KB를 넘지 않는지 저장본 크기로 확인한다. [추론]
- JSON: `parseJsonMsg`로 `t`가 문자열인지 확인한 뒤 종류별로 필드 타입을 전부 검사한다(현재 설계). 클라이언트 객체를 상태에 그대로 펼쳐 넣지 않는다. 문자열은 길이 상한(`NAME_MAX` 등)을 적용한다.
- 알 수 없는 `t`와 형식 오류는 조용히 무시하되 횟수를 센다. 계속되면 `kick{why:'bad'}`.

### 5.4 중복 세션 (같은 pid로 탭 두 개)

현재 설계: 같은 방에 같은 pid가 있으면 **기존 연결에 `kick{why:'dup'}` 후 새 연결을 받는다.** 다른 방은 어댑터의 `pid → roomId` 맵으로 정리. 이 "나중 접속 우선" 방식은 맞다. 사용자는 보통 죽은 탭을 버리고 새 탭을 여는 것이기 때문이다. [추론]

지켜야 할 것: [추론]

1. **`dup`으로 쫓겨난 탭은 자동 재접속하지 않는다.** 재접속하면 두 탭이 서로를 쫓아내는 무한 루프가 된다(6.1절 코드에서 `CLOSE_KICK`은 재시도 안 함. 테스트로 확인). 쫓겨난 탭에는 "다른 탭에서 접속했어요"와 **[여기서 계속하기]** 버튼만 보여 준다.
2. **pid는 비밀로 취급한다.** 서명이 없는 값이라 남의 pid를 알면 그 사람을 쫓아낼 수 있다. 다른 플레이어에게 가는 메시지(`PlayerPublic`, `join` 등)에 pid가 실리면 안 된다(방 안 식별은 숫자 id로). 구현 후 한 번 점검할 항목이다.
3. 프로세스를 나누면 `pid → roomId` 맵이 프로세스마다 따로라 **다른 샤드의 중복은 못 잡는다.** 초기에는 허용한다(같은 저장본으로 두 캐릭터가 생기지만 저장은 나중 것이 덮는다). 문제가 되면 로비가 `pid → 샤드`를 갖고 접속 전에 확인한다.
4. 선택: 접속 전에 `BroadcastChannel`로 같은 브라우저의 다른 탭에 물어보고, 이미 플레이 중이면 접속 전에 안내한다. [상식: 지원 범위는 이번에 확인하지 않았다.]

---

## 6. 재접속과 복구

### 6.1 클라이언트 재접속 상태기계 (검증함)

상태: `idle → connecting → handshaking → playing ⇄ waiting(백오프)`, 종착 `stopped`(사용자 종료, kick, full, 포기).

현재 설계(0.5초부터 8초까지 지수 백오프, ±30% 지터, 8회 실패 시 오류)에 더할 것: [추론]

| 추가 항목 | 이유 |
|---|---|
| 접속 타임아웃(8초) + 세대 번호 | iOS에서 `new WebSocket()`이 open도 error도 close도 없이 CONNECTING에 머무는 보고가 있다(6.4절). 타임아웃으로 직접 버리고, 버린 소켓의 뒤늦은 이벤트는 세대 번호로 무시한다. |
| `welcome` 타임아웃(6초) | 소켓은 열렸는데 서버가 응답하지 않는 경우. |
| 침묵 감시(5초) | 서버는 최소 1초에 한 번 스냅샷을 보낸다. 5초 동안 아무것도 안 오면 죽은 소켓이다. TCP가 알려 주기를 기다리면 몇 분이 걸릴 수 있다. 숨은 탭에서는 타이머가 밀리므로 판정하지 않는다. |
| 안정 시간(5초) 뒤에만 시도 횟수 초기화 | 접속 직후 바로 끊기는 상황에서 0.5초마다 재시도하는 루프를 막는다. Colyseus SDK도 `minUptime` 5,000ms를 둔다. [확인] |
| 종료 코드별 처리 | 4001(가득), 4002(kick), 4003(잘못된 요청)은 재시도 안 함. 4004(서버 종료)는 1~4초를 더 기다린다. 나머지(1006, 1001 등)는 재시도. |
| 탭 복귀·`online` 때 즉시 재시도 | 사용자가 돌아왔는데 8초 백오프를 기다리게 하지 않는다. |
| 탭 복귀 때 생존 확인 | 백그라운드에서 죽은 소켓은 close 이벤트가 안 올 수 있다. ping을 보내고 2초 안에 아무것도 안 오면 버린다. |
| 끊긴 동안의 입력은 쌓지 않음 | 위치는 "상태"라 최신 값만 의미가 있다. |
| `url()`을 매번 다시 계산 | 샤딩 뒤에는 방이 다른 서버로 옮겨졌을 수 있다. 2회 연속 실패하면 로비에서 주소를 다시 받는다. |

참고로 Colyseus SDK의 자동 재접속 기본값은 최대 15회, 지연 100ms~5,000ms, 지수 백오프, 끊긴 동안 메시지는 최대 10개만 보관이다. [확인]

```ts
// client/src/net — 브라우저 WebSocket 재접속 상태기계
export type Phase = 'idle' | 'connecting' | 'handshaking' | 'playing' | 'waiting' | 'stopped'
export type StopReason = 'user' | 'kicked' | 'full' | 'bad' | 'gaveup'

const CLOSE_FULL = 4001
const CLOSE_KICK = 4002
const CLOSE_BAD = 4003
const CLOSE_SHUTDOWN = 4004

export interface LinkOptions {
  url: () => string
  /** 소켓이 열리면 바로 보낼 hello(JSON 문자열). 재접속 때마다 최신 저장본으로 다시 만든다 */
  hello: () => string
  /** 서버 메시지. welcome 을 받았으면 true 를 돌려준다 → playing 으로 전환 */
  onMessage: (data: string | ArrayBuffer) => boolean | void
  onPhase: (phase: Phase, info: { attempt: number; delayMs?: number; why?: StopReason; code?: number }) => void
  baseMs?: number
  capMs?: number
  maxAttempts?: number
  connectTimeoutMs?: number
  welcomeTimeoutMs?: number
  /** playing 중 이만큼 아무것도 안 오면 죽은 소켓으로 본다(서버는 최소 1초에 한 번 스냅샷을 보낸다) */
  silenceTimeoutMs?: number
  /** 이만큼 playing 을 유지해야 재시도 횟수를 0 으로 되돌린다(접속 직후 끊기는 루프 방지) */
  stableMs?: number
  /** 탭 복귀 때 생존 확인용으로 보낼 메시지(예: ping). 서버가 바로 답하는 종류여야 한다 */
  probe?: () => string
  random?: () => number
}

export interface Link {
  readonly phase: Phase
  start(): void
  stop(why?: StopReason): void
  /** playing 일 때만 보낸다. 끊긴 동안의 입력은 쌓아 두지 않는다(위치는 '상태'라 최신 값만 의미가 있다) */
  send(data: string | ArrayBuffer): boolean
  /** 탭 복귀·online 이벤트 때 호출: 대기 중이면 즉시 재시도, 접속 중이면 생존 확인 */
  nudge(): void
}

export function createLink(o: LinkOptions): Link {
  const base = o.baseMs ?? 500
  const cap = o.capMs ?? 8000
  const maxAttempts = o.maxAttempts ?? 8
  const connectTimeout = o.connectTimeoutMs ?? 8000
  const welcomeTimeout = o.welcomeTimeoutMs ?? 6000
  const silenceTimeout = o.silenceTimeoutMs ?? 5000
  const stableMs = o.stableMs ?? 5000
  const rnd = o.random ?? Math.random

  let phase: Phase = 'idle'
  let ws: WebSocket | null = null
  let gen = 0 // 세대 번호: 버린 소켓의 뒤늦은 이벤트를 무시한다
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setInterval> | undefined
  let lastMsgAt = 0
  let playingSince = 0
  let msgCount = 0

  const now = (): number => performance.now()

  function setPhase(p: Phase, info: { delayMs?: number; why?: StopReason; code?: number } = {}): void {
    phase = p
    o.onPhase(p, { attempt, ...info })
  }

  function dropSocket(): void {
    gen++
    clearTimeout(timer)
    clearInterval(watchdog)
    const old = ws
    ws = null
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close() // CONNECTING 상태여도 안전. 영영 CONNECTING 인 소켓도 여기서 버린다
      } catch {
        /* ignore */
      }
    }
  }

  function open(): void {
    dropSocket()
    const my = gen
    setPhase('connecting')
    let sock: WebSocket
    try {
      sock = new WebSocket(o.url())
    } catch {
      return fail(0) // 잘못된 URL/혼합 콘텐츠 등
    }
    ws = sock
    sock.binaryType = 'arraybuffer' // 기본값 'blob' 은 비동기 변환이 필요하다
    // 열리지 않는 소켓(오류도 close 도 안 오는 경우 포함)을 직접 포기한다
    timer = setTimeout(() => my === gen && fail(0), connectTimeout)

    sock.onopen = () => {
      if (my !== gen) return
      clearTimeout(timer)
      setPhase('handshaking')
      sock.send(o.hello())
      timer = setTimeout(() => my === gen && fail(0), welcomeTimeout)
    }
    sock.onmessage = (ev: MessageEvent) => {
      if (my !== gen) return
      lastMsgAt = now()
      msgCount++
      const welcomed = o.onMessage(ev.data as string | ArrayBuffer)
      if (welcomed === true && phase === 'handshaking') {
        clearTimeout(timer)
        playingSince = lastMsgAt
        setPhase('playing')
        watchdog = setInterval(() => {
          if (my !== gen) return
          const t = now()
          if (attempt > 0 && t - playingSince > stableMs) attempt = 0
          // 숨은 탭에서는 타이머가 밀리므로 판정하지 않는다(복귀 때 nudge 가 처리)
          if (!isHidden() && t - lastMsgAt > silenceTimeout) fail(0)
        }, 1000)
      }
    }
    sock.onclose = (ev: CloseEvent) => {
      if (my !== gen) return
      fail(ev.code)
    }
    // onerror 는 정보가 없다(보안상 사유를 안 준다). 뒤따르는 onclose 에서 처리한다.
    sock.onerror = () => {}
  }

  function fail(code: number): void {
    dropSocket()
    // 서버가 "다시 오지 마"라고 한 경우: 자동 재접속 금지(특히 dup 은 두 탭이 서로 쫓아내는 무한 루프가 된다)
    if (code === CLOSE_KICK) return setPhase('stopped', { why: 'kicked', code })
    if (code === CLOSE_FULL) return setPhase('stopped', { why: 'full', code })
    if (code === CLOSE_BAD) return setPhase('stopped', { why: 'bad', code })
    if (attempt >= maxAttempts) return setPhase('stopped', { why: 'gaveup', code })

    // Full Jitter: 0 ~ min(cap, base·2^attempt) 에서 무작위. 서버 재시작 때 전원이 같은 순간에 몰려오지 않게 한다.
    let delayMs = rnd() * Math.min(cap, base * 2 ** attempt)
    if (code === CLOSE_SHUTDOWN) delayMs += 1000 + rnd() * 3000 // 배포 중: 새 프로세스가 뜰 시간 + 추가 분산
    delayMs = Math.max(150, delayMs)
    attempt++
    setPhase('waiting', { delayMs, code })
    timer = setTimeout(open, delayMs)
  }

  function nudge(): void {
    if (phase === 'waiting') {
      open() // 사용자가 돌아왔으면 백오프를 기다리지 않는다
      return
    }
    if (phase !== 'playing' || !ws) return
    // 백그라운드에서 죽은 소켓(close 이벤트도 안 오는 좀비)을 잡는다: 탐침을 보내고 2초 안에 아무것도 안 오면 버린다
    const my = gen
    const seen = msgCount
    lastMsgAt = now() // 워치독이 복귀 직후 바로 오판하지 않게
    if (o.probe && ws.readyState === WebSocket.OPEN) ws.send(o.probe())
    setTimeout(() => {
      if (my === gen && phase === 'playing' && msgCount === seen) fail(0)
    }, 2000)
  }

  return {
    get phase() {
      return phase
    },
    start() {
      attempt = 0
      open()
    },
    stop(why: StopReason = 'user') {
      dropSocket()
      setPhase('stopped', { why })
    },
    send(data) {
      if (phase !== 'playing' || !ws || ws.readyState !== WebSocket.OPEN) return false
      ws.send(data)
      return true
    },
    nudge,
  }
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** 브라우저 이벤트 연결(호출은 한 번만) */
export function bindLifecycle(link: Link, hooks: { onHidden?: () => void; onVisible?: () => void } = {}): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      hooks.onVisible?.() // 보간 버퍼 비우기, dt 초기화 등
      link.nudge()
    } else {
      hooks.onHidden?.() // 마지막 Idle 이동 패킷 보내기 등
    }
  })
  window.addEventListener('online', () => link.nudge())
  // 페이지를 떠날 때는 직접 닫아 자리를 비우고, bfcache 에서 돌아오면 새로 접속한다. unload/beforeunload 는 쓰지 않는다.
  window.addEventListener('pagehide', () => link.stop('user'))
  window.addEventListener('pageshow', (ev) => {
    if ((ev as PageTransitionEvent).persisted) link.start()
  })
}
```

Node 22의 전역 `WebSocket`으로 돌린 통합 테스트에서 확인한 흐름: `connecting > handshaking > playing` → 서버 종료(4004) 후 `waiting` → 서버 재기동 후 자동으로 `playing` 복귀 → `nudge()` 뒤 살아 있는 소켓 유지 → 4002를 받으면 `stopped`이고 다시 접속하지 않음. 실제 모바일 브라우저에서는 돌려 보지 않았다.

### 6.2 백오프와 지터

AWS 아키텍처 블로그(2015, Marc Brooker) [확인]:

- 지터 없는 지수 백오프는 호출이 여전히 뭉쳐서 온다. 지터를 넣으면 호출률이 거의 일정해지고, 경합 클라이언트 100개 기준 총 호출 수가 절반 이하로 준다.
- 세 방식 중 Equal Jitter가 가장 나쁘다. Full Jitter는 일이 적고 시간이 약간 더 걸리며, Decorrelated Jitter와의 우열은 분명하지 않다. 결론은 "지터를 넣은 백오프를 표준으로 삼아라"다.
- 수식은 원문에서 그림이라 글자로 추출하지 못했다. 널리 알려진 형태는 Full Jitter `sleep = random(0, min(cap, base × 2^attempt))`다. [상식]

현재 설계의 "±30% 지터"는 Equal Jitter에 가깝다. 서버 재시작 때 2,000명이 0.35~0.65초 사이에 몰려온다. **Full Jitter로 바꾸고, 서버 종료 코드(4004)에는 1~4초를 더한다.** [추론]

재접속 폭주 참고: Evil Martians 측정에서 uWebSockets.js 서버는 2만 클라이언트 재접속 폭주를 흡수하는 데 약 9초가 걸렸다. [확인] 우리 벤치마크에서는 `ws` 서버가 초당 1,000개 속도의 접속을 오류 없이 받았다(더 높은 속도는 시험하지 않음). [측정]

### 6.3 재개(resume): 짧은 끊김에 자리를 지켜 주기

현재 설계: 끊기면 즉시 `disconnect`(신도 해산, `leave` 방송), 재접속하면 새 `welcome`으로 전체 상태를 다시 받는다. 진행도는 서명 저장본이라 잃지 않지만 **방 안의 일시 상태**(위치, 따라다니는 신도 행렬, 진행 중인 배틀·설교)는 사라진다.

엘리베이터나 지하철에서 2~10초 끊기는 일이 흔하므로 유예를 두는 편이 낫다. [추론]

- 비정상 종료(1006 등)면 `PlayerState`를 지우지 않고 `offlineSince = now`만 찍는다. 다른 사람에게는 "연결 끊김" 표시. 신도는 그 자리에 선다.
- `RESUME_GRACE_MS`(20초 권장) 안에 같은 pid로 `hello`가 오면 기존 `PlayerState`에 새 연결을 붙이고 `welcome`에 `resumed: true`를 실어 보낸다. 넘으면 평소대로 `leave`.
- 의도적 종료(`pagehide`에서 보낸 1000, kick)는 유예 없이 즉시 정리한다.
- 유예 중인 자리도 정원에 포함한다(돌아왔는데 방이 가득 차 있으면 안 된다).

Colyseus가 같은 구조다. 서버가 `allowReconnection(client, 초)`로 자리를 잡아 두고(문서 예시 30초, 0.17 릴리스 글 예시 10초), 동의한 종료(코드 4000)는 유예 없이 바로 `onLeave`로 간다. [확인]

### 6.4 모바일·백그라운드 탭에서 일어나는 일

[확인] 브라우저 동작:

| 항목 | 내용 | 출처 |
|---|---|---|
| `requestAnimationFrame` | 대부분의 브라우저가 백그라운드 탭에는 콜백을 보내지 않는다. | MDN Page Visibility |
| 타이머(Chrome) | 숨은 페이지는 1초에 한 번만 깨어난다. **집중 스로틀(1분에 한 번)** 조건은 전부 충족 시: 5분 넘게 숨김, 타이머 연쇄 5회 이상, 30초 이상 무음, WebRTC 미사용. | Chrome 88 타이머 글 |
| WebSocket 예외 | MDN은 예산 기반 스로틀에 대해 "WebSocket·WebRTC 같은 실시간 연결을 쓰는 탭은 스로틀하지 않는다"고 적는다. Chrome 88 글의 집중 스로틀 조건에는 WebSocket 예외가 없다. **현재 Chrome에서 WebSocket이 집중 스로틀을 면제하는지는 확인 못함.** | MDN, Chrome |
| 얼림(frozen) | 숨은 페이지가 얼면 타이머와 fetch 콜백이 실행되지 않는다. 얼기 전에 WebSocket을 닫으라고 권한다. | Chrome Page Lifecycle |
| 종료 감지 | 모바일에서는 탭·앱을 닫아도 `beforeunload`, `pagehide`, `unload`가 안 올 수 있다. **`hidden`이 믿을 수 있는 마지막 상태**다. | Chrome Page Lifecycle |
| bfcache | Chrome(149 기준)과 Safari는 WebSocket이 열려 있어도 bfcache를 막지 않지만 다른 브라우저는 막는다. `pagehide`/`freeze`에서 닫고 `pageshow`/`resume`에서 다시 열 것을 강하게 권한다. `unload`는 쓰지 말 것. | web.dev bfcache |
| iOS Safari | WebKit 버그 308073(2026-02-17 등록, Safari 26.3 / iOS 26.3, 상태 NEW, 미배정): 10초 이상 백그라운드에 있다 돌아오면 기존 소켓이 1006으로 닫히고, 이후 `new WebSocket()`이 readyState 0에 머물며 open·error·close가 전혀 오지 않는다. 같은 서버로 `fetch()`는 된다. 보고자는 전체 새로고침만 통했다고 한다. 같은 기기의 다른 브라우저는 바로 재접속됐다. WebKit 엔지니어의 답글은 없다(확정된 버그가 아니다). | WebKit Bugzilla |
| iOS 일반 | 백그라운드 전환·화면 잠금 때 소켓이 닫힌다는 보고가 iOS 15 무렵부터 이어진다. | [요약] Apple 포럼, WebKit 메일링 리스트 |

[추론] 여기서 나오는 설계:

1. **숨은 탭에서 앱 타이머에 기대는 로직을 두지 않는다.** 숨으면 rAF가 멈춰 이동 패킷이 안 나가고, 앱 ping은 1초~1분 간격으로 밀린다. 서버의 생존 판정은 프로토콜 ping/pong으로, 자리 비움 판정은 별도 타이머로 한다(1.5절).
2. **숨는 순간(`visibilitychange → hidden`)에 Idle 이동 패킷을 한 번 보낸다.** 안 그러면 다른 사람 화면에서 내 캐릭터가 달리는 자세로 멈춰 있다.
3. **돌아오는 순간(`visible`)에 세 가지를 한다.** 소켓이 대기 중이면 즉시 재시도, 열려 있으면 생존 확인(ping 후 2초), 보간 버퍼와 프레임 `dt` 초기화.
4. **접속 타임아웃은 필수다.** iOS 버그 보고대로면 이벤트가 하나도 안 온다. 타임아웃이 2번 연속 나면 "새로고침" 버튼을 띄운다(진행도는 localStorage의 서명 저장본에 있어 새로고침해도 안전하다).
5. **자리 비움은 서버가 명시적으로 정리한다.** 20명 방에서 숨은 탭이 자리를 차지하면 안 된다. 입력 없이 3~5분이면 `kick{why:'idle'}`. 클라이언트는 숨은 상태에서는 재접속하지 않고, 돌아오면 버튼 한 번으로 다시 들어간다.
6. **`pagehide`에서 소켓을 직접 닫는다.** 자리가 바로 비고 bfcache에도 걸리지 않는다.
7. `performance.now()`는 기기 절전 중 멈추는 플랫폼이 있다. 복귀 후 스냅샷 오프셋이 1초 이상 튀면 재생 시계를 다시 잡는다(3.5절 코드에 포함).

---

## 7. 용량 추정

### 7.1 측정 방법 [측정]

- 서버: 방 N개, 방마다 플레이어 20 + NPC 28. 단일 타이머로 10Hz 틱. NPC는 1.5m/s 무작위 걷기(70%가 이동 중). 틱마다 더티 엔티티를 `shared/protocol.ts`와 같은 바이트 배치(헤더 11B, 플레이어 8B, NPC 7B)로 인코딩해 방 전원에게 방송. 수신 메시지마다 토큰 버킷과 이동 속도 검증.
- 봇: `ws` 클라이언트. 접속 후 60%의 시간 동안 5.6m/s로 움직이며 100ms마다 7바이트 이동 패킷 전송, 4초마다 JSON ping. 방당 한 봇이 스냅샷 도착 간격을 기록.
- 절차: 전원 접속 후 6초 예열, 20초 측정. 서버 CPU는 `process.cpuUsage()`, 이벤트 루프는 `monitorEventLoopDelay`와 `eventLoopUtilization()`.
- 이 벤치마크 스크립트는 임시 폴더에 있어 보존되지 않는다. 8.2절의 봇 뼈대로 `tools/loadtest.ts`를 만들면 같은 측정을 실제 서버에 할 수 있다.

### 7.2 결과 [측정]

ws 8.23.0, 바이너리 더티 스냅샷, 틱을 10칸으로 분산:

| 방 | 접속 | CPU(코어 1개 대비) | 이벤트 루프 사용률 | 틱 칸당 소요 p50 / p95 / p99 | 틱 지각 p99 | 루프 지연 p99 | 접속자당 프레임/초 | RSS |
|---|---|---|---|---|---|---|---|---|
| 100 | 2,000 | 32% | 0.31 | 1.4 / 2.1 / 3.1ms | 0.9~2.3ms | 2~3ms | 10.0 | 94~98MB |
| 150 | 3,000 | 45% | 0.44 | 2.0 / 3.0 / 4.5ms | 1.1ms | 2.9ms | 10.0 | 106MB |
| 200 | 4,000 | 57~58% | 0.61~0.66 | 2.8 / 4.2~6.4 / 8~11ms | 5~14ms | 9~20ms | 9.6~9.9 | 117~120MB |
| 300 | 6,000 | 84% | 0.85 | 4.1 / 5.8 / 7.4ms | 11ms | 15ms | 9.64 | 125MB |

- 100방과 200방은 2회씩, 나머지는 1회 측정했다. 200방은 두 번의 결과가 달랐다(루프 지연 최대 33ms와 100ms).
- 200방 이상에서는 봇 4,000~6,000개가 코어 3개를 나눠 쓰느라 봇 쪽도 바빴다. 클라이언트 측 수치(왕복 시간, 도착 간격)는 100방까지만 믿을 만하다.
- CPU는 방 수에 거의 비례한다. 방 하나의 틱 한 번(쓰기 20회 + 읽기 약 12회)에 CPU 약 0.3ms다.
- 수신은 100방에서 초당 약 12,500메시지, 송신은 초당 20,000프레임이었다.

틱 분산 효과(100방, 2,000접속):

| 방식 | 틱 소요 p50 / p99 | 루프 지연 p99 | 봇이 잰 왕복 시간 p95 / p99 | 스냅샷 도착 간격 편차 p95 |
|---|---|---|---|---|
| 모든 방을 한 틱에 | 14.4 / 26.6ms | 18.1ms | 11~13 / 16~19ms | 약 8ms |
| 10칸에 분산 | 1.4 / 3.1ms | 2.0ms | 1.9 / 3.2~3.8ms | 약 2.2ms |

CPU 총량은 같다(31% 대 32%). 달라지는 것은 한 번에 루프를 막는 시간이다. 한 틱에 몰면 그동안 들어온 ping, 이동 패킷, 새 접속이 전부 기다린다.

분산 틱 루프(검증함). 방마다 타이머를 두지 않고 타이머 하나가 칸을 돌며, 각 방은 여전히 100ms마다 한 번 틱한다:

```ts
const TICK_MS = 100
const SLOTS = 10 // 틱 간격을 10칸으로 나눈다 → 10ms 마다 방의 1/10 을 돌린다
const slotMs = TICK_MS / SLOTS
const tickDur: number[] = []
const tickLate: number[] = []
let slot = 0
let nextAt = performance.now() + slotMs
let tickTimer: NodeJS.Timeout | undefined

function tickLoop(): void {
  const t0 = performance.now()
  record(tickLate, Math.max(0, t0 - nextAt)) // 예정보다 얼마나 늦게 시작했나
  const rooms = lobby.all()
  for (let i = slot; i < rooms.length; i += SLOTS) {
    try {
      rooms[i]!.tick() // 빈 방은 1초에 한 번만 돌리는 최적화는 여기서 건너뛰면 된다
    } catch (err) {
      console.error('room tick failed', err)
    }
  }
  const t1 = performance.now()
  record(tickDur, t1 - t0)
  slot = (slot + 1) % SLOTS
  nextAt += slotMs
  if (nextAt < t1) nextAt = t1 // 밀렸으면 몰아서 따라잡지 않는다(죽음의 나선 방지)
  tickTimer = setTimeout(tickLoop, Math.max(0, nextAt - performance.now()))
}
tickTimer = setTimeout(tickLoop, slotMs)

function record(arr: number[], v: number): void {
  if (arr.length >= 2048) arr.shift()
  arr.push(v)
}

// 종료: 새 접속을 막고, 전원에게 4004 를 보낸 뒤, 잠깐 기다렸다가 남은 소켓을 끊는다
async function shutdown(): Promise<void> {
  clearInterval(heartbeat)
  clearTimeout(tickTimer)
  http.close()
  for (const c of conns.values()) c.ws.close(4004, 'shutdown')
  await new Promise((r) => setTimeout(r, 1500)) // close 프레임이 나갈 시간
  for (const c of conns.values()) c.ws.terminate()
}
```

방마다 `dt`를 따로 잰다면(`host.now()` 차이) 칸 배치와 무관하게 시뮬레이션이 맞는다.

### 7.3 작은 VM 한 대에 100방 × 20명이 되는가 [추론, 7.2 수치 기반]

| 자원 | 100방 2,000명 기준 | 판단 |
|---|---|---|
| CPU | 네트워크 입출력만 코어의 약 1/3. 실제 방 로직은 미측정. | 1 vCPU로 돌아가겠지만 GC, TLS, 로직 여유를 보면 **2 vCPU** 권장(Node 1개 + 프록시·OS). |
| 메모리 | RSS 약 95~100MB(접속당 약 8~11KB 증가) | 1GB로 충분. 메모리는 제약이 아니다. |
| 대역폭 | 최대 약 52Mbps 하향(바이너리, TLS·TCP 포함 추정). JSON이면 141Mbps. | **여기가 제약이다.** 요금제의 포트 속도와 월 전송량을 확인한다. |
| 파일 디스크립터 | 소켓 2,000개 | `ulimit -n`을 8,192 이상으로. Colyseus FAQ도 리눅스 기본 약 1,024를 65,535로 올리라고 한다. [확인] |

Colyseus FAQ의 경험칙은 "작은 클라우드 서버가 단순한 게임 기준 동시 접속 1,000~2,000", "접속당 메모리 2~5KB"다. [확인] 우리 측정과 같은 범위다.

측정하지 않은 것: TLS를 Node가 직접 처리할 때의 CPU, 실제 `Room` 로직의 CPU, 실제 인터넷의 손실과 지연.

### 7.4 언제, 어떻게 프로세스를 나누는가

**시점** [추론]: 프로세스당 계획 상한 **100방**. 아래 중 하나가 지속되면 나눈다.

- 이벤트 루프 사용률(ELU) 0.5 초과
- 틱 지각 p99 10ms 초과, 또는 루프 지연 p99 20ms 초과
- 접속자당 프레임 수가 10/초 밑으로 내려감
- 무중단 배포가 필요해짐(프로세스 하나면 배포 때 전원이 끊긴다)

**방법** [추론, 구조는 Colyseus 문서로 확인]:

- 방은 서로 상태를 공유하지 않으므로 **방 id로 프로세스를 정한다.** 예: `샤드 = floor((방 번호 − 1) / 100)`. 공유 저장소(Redis)가 필요 없다.
- WebSocket은 한 번 연결되면 그 TCP 연결이 계속 쓰이므로 쿠키 기반 "스티키 세션"은 필요 없다. 필요한 것은 **업그레이드 요청을 방을 가진 프로세스로 보내는 결정적 라우팅**이다.
- 로비(디렉터리)는 각 샤드의 `/api/rooms`를 1~2초마다 모아 합친 목록을 내려 주고, 방마다 접속 주소를 같이 준다: `{ id, name, players, cap, ws: "wss://example.com/s/1/ws?room=157" }`. 자동 배정("가득 차지 않은 방 중 사람이 가장 많은 방")도 로비가 한다.
- 한 VM에서 여러 프로세스: 프로세스마다 포트를 달리하고 프록시가 경로로 나눈다. Node `cluster`나 PM2 cluster 모드는 쓰지 않는다. 연결이 워커에 무작위로 배분돼 방을 가진 프로세스에 닿지 않는다. Colyseus 문서도 "cluster 모드를 쓰지 말고 fork 모드로, 프로세스마다 자기 공개 주소를 가져라", "방 하나는 프로세스 하나에 속하고 클라이언트는 그 프로세스에 직접 연결한다"고 적는다. [확인]
- 여러 VM: 샤드마다 호스트 이름을 주거나(`s1.example.com`), 플랫폼 라우팅을 쓴다. Fly.io는 앱이 `fly-replay: instance=<머신 id>` 응답 헤더를 돌려주면 프록시가 요청을 그 머신으로 다시 보낸다(응답하는 쪽은 업그레이드를 직접 협상하지 말 것, 1MB 넘는 요청은 불가). [확인]
- 배포: 샤드를 하나씩 내린다. `SIGTERM` → 새 접속 중단 → 전원에게 `kick{why:'shutdown'}` + 4004 → 클라이언트는 1~4초 흩어져 재접속. 방 일시 상태는 사라지고 진행도는 서명 저장본으로 복구된다.
- 샤드 간 중복 pid는 5.4절 참고.

nginx 예시(설정 문법은 nginx 공식 문서의 WebSocket 프록시 예시를 따랐다. 이 환경에서 실행해 보지는 않았다):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
upstream shard0 { server 127.0.0.1:8790; }
upstream shard1 { server 127.0.0.1:8791; }

server {
    # /s/0/ws?room=57 → 샤드 0 의 /ws?room=57
    location /s/0/ {
        proxy_pass http://shard0/;
        proxy_http_version 1.1;            # nginx 1.29.7 미만에서 필요
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 75s;            # 기본 60초: 서버가 60초간 아무것도 안 보내면 끊긴다
    }
    location /s/1/ {
        proxy_pass http://shard1/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 75s;
    }
}
```

### 7.5 Cloudflare Durable Objects 어댑터의 비용 구조

[확인] Cloudflare 문서:

- `setTimeout`/`setInterval`, 알람, 들어오는 요청은 절전(hibernation)을 막는다. 절전 중에는 체류 요금(GB-s)이 붙지 않는다. 표준 API로 `accept()`한 WebSocket은 연결돼 있는 내내 체류 요금이 붙는다.
- 체류 요금은 실제 사용량과 무관하게 객체당 128MB로 계산한다. 유료 플랜은 월 400,000 GB-s 포함, 초과분 100만 GB-s당 $12.50. 요청은 월 100만 건 포함, 초과분 100만 건당 $0.15.
- 들어오는 WebSocket 메시지는 20건을 요청 1건으로 센다. 나가는 메시지와 프로토콜 ping은 무료.
- 문서의 계산 예 3: 객체 100개가 항상 활성이면 체류 33,177,600 GB-s → **$412.50/월**(요청 요금 별도).
- 객체 하나의 소프트 한도는 초당 1,000요청. 받는 WebSocket 메시지 최대 32MiB. 요청당 CPU 기본 30초.
- 고빈도 데이터는 50~100ms 단위로 묶어 한 프레임에 보내라고 권한다(우리 10Hz 스냅샷과 같다).
- 새 코드를 배포하면 표준 API 연결은 끊긴다.

[추론] 우리 게임에 대입:

- 10Hz 틱은 타이머이므로 사람이 있는 방은 절전할 수 없다. 방이 비면 타이머를 멈춰 객체가 내려가게 해야 한다(NPC 상태는 사라져도 된다).
- 활성 방 1개·1시간의 비용(포함분 초과 기준): 체류 0.128GB × 3,600초 = 460.8 GB-s ≈ $0.0058. 수신 메시지 20명 × 약 6.3건/초 × 3,600초 ≈ 45만 건 → 요청 약 2.3만 건 ≈ $0.0034. 합계 **방-시간당 약 $0.009**.
- 100방을 24시간 30일 돌리면 약 $660. 같은 부하를 VM 한두 대로 처리하는 것보다 훨씬 비싸다. 반대로 한 달에 2,000 방-시간만 쓰면 약 $18이다.
- 결론: 상시 부하는 Node VM, DO는 "0까지 줄어드는" 탄력 용량 또는 초기 무운영 배포용으로 본다. DO 어댑터에서는 보간 시계 문제(3.3절)가 더 중요해진다. 객체가 사용자와 먼 곳에 생기면 지연이 커지기 때문이다.

---

## 8. 부하 테스트를 정직하게 하는 법

### 8.1 도구

| 도구 | 현재 상태 | 우리 프로토콜에 맞는가 |
|---|---|---|
| **직접 만든 Node 봇** (`ws` + `shared/protocol`) | — | **가장 적합.** 실제 클라이언트와 같은 코덱으로 `hello`, 이동, 포교 흐름을 그대로 흉내 낼 수 있고 스냅샷을 디코드해 프로토콜 버그까지 잡는다. `package.json`에 `"loadtest": "tsx tools/loadtest.ts"`가 이미 있다. |
| **k6** `k6/websockets` | `k6/experimental/websockets`는 폐기 예정이고 `k6/websockets`를 쓰라고 문서가 안내한다. `binaryType = 'arraybuffer'` 지원, `send()`는 문자열·ArrayBuffer·Blob·ArrayBufferView를 받는다. 전역 이벤트 루프라 VU 하나가 연결 여러 개를 가질 수 있다. 릴리스 노트 목록의 최신은 2.3.0. [확인] 안정 모듈 승격은 v1.6.0이라고 한다. [요약] | 접속 수 램프업, 임계값 판정, CI 연동에 좋다. 다만 k6는 자체 JS 런타임이라 우리 TS 코덱을 번들해서 넣어야 한다. 봇을 대체하기보다 "접속 폭주" 시나리오 보조용. |
| **Artillery** `engine: ws` | npm 2.0.34. 동작은 `connect`, `send`(문자열 또는 JSON 직렬화 객체), `think`, `loop`, `function`. 문서에 바이너리 프레임 전송과 수신 메시지 검증(match/capture)에 대한 설명이 없다. [확인] | 바이너리 프로토콜과 "응답을 보고 다음 행동" 흐름에 맞지 않는다. 쓰지 않는다. |

### 8.2 봇 뼈대 (검증함)

저장소의 `shared/protocol.ts`(`encodeMove`, `decodeSnapshot`)를 그대로 불러와 벤치마크 서버에 붙여 돌렸다. 봇 100개가 8초 동안 스냅샷 7,450장을 받아 전부 디코드에 성공했다(실패 0). 실제 서버의 `welcome` 처리는 서버가 아직 없어 확인하지 못했다.

```ts
// tools/loadtest.ts — 실행 예: BOTS=400 ROOMS=20 URL=ws://127.0.0.1:8787 DURATION=60 npm run loadtest
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from '../shared/constants'
import { decodeSnapshot, encodeMove } from '../shared/protocol'

const URL_BASE = process.env.URL ?? 'ws://127.0.0.1:8787'
const BOTS = Number(process.env.BOTS ?? 200)
const ROOMS = Number(process.env.ROOMS ?? 10)
const DURATION_S = Number(process.env.DURATION ?? 60)
const RAMP_PER_S = Number(process.env.RAMP ?? 100) // 초당 접속 수(실서비스 유입처럼 천천히)
const SEND_MS = 100
const RUN_SPEED = 5.6

const stat = { opened: 0, welcomed: 0, closed: 0, errors: 0, snaps: 0, bytesIn: 0, badSnaps: 0 }
const rtts: number[] = []
const gaps: number[] = [] // 스냅샷 도착 간격(방당 1명만 기록)
const welcomeMs: number[] = []

function bot(index: number): void {
  const room = (index % ROOMS) + 1
  const startedAt = performance.now()
  const ws = new WebSocket(`${URL_BASE}/ws?room=${room}`, { perMessageDeflate: false })
  let x = 0
  let z = 0
  let yaw = Math.random() * Math.PI * 2
  let moving = false
  let until = 0
  let lastSnapAt = 0
  let nextSendAt = 0
  let timers: NodeJS.Timeout[] = []

  ws.on('open', () => {
    stat.opened++
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid: `bot-${randomUUID()}`, name: `봇${index}`, look: [0, 0, 0, 0, 0, 0, 0], save: null }))
    // 고정 일정으로 보낸다: 타이머가 밀려도 '원래 보냈어야 할 시각' 기준으로 다음 전송을 잡아 부하를 스스로 줄이지 않는다
    nextSendAt = performance.now() + Math.random() * SEND_MS
    const loop = (): void => {
      const now = performance.now()
      while (nextSendAt <= now) {
        step(SEND_MS / 1000)
        nextSendAt += SEND_MS
      }
      timers[0] = setTimeout(loop, Math.max(1, nextSendAt - performance.now()))
    }
    loop()
    timers[1] = setInterval(() => ws.send(JSON.stringify({ t: 'ping', c: performance.now() })), 4000)
  })

  function step(dt: number): void {
    const now = performance.now()
    if (now >= until) {
      const was = moving
      moving = Math.random() < 0.6
      until = now + 1500 + Math.random() * 5000
      yaw = Math.random() * Math.PI * 2
      if (was && !moving) ws.send(encodeMove(x, z, yaw, 0)) // 멈출 때 Idle 한 번
    }
    if (!moving || ws.readyState !== WebSocket.OPEN) return
    x += Math.sin(yaw) * RUN_SPEED * dt
    z += Math.cos(yaw) * RUN_SPEED * dt
    if (Math.abs(x) > 60 || Math.abs(z) > 60) {
      x = Math.max(-60, Math.min(60, x))
      z = Math.max(-60, Math.min(60, z))
      yaw += Math.PI
    }
    ws.send(encodeMove(x, z, yaw, 2))
  }

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    stat.bytesIn += data.byteLength
    if (isBinary) {
      const snap = decodeSnapshot(data) // 실제 클라이언트가 하는 일을 봇도 한다(디코드 실패 = 프로토콜 버그)
      if (!snap) {
        stat.badSnaps++
        return
      }
      stat.snaps++
      const now = performance.now()
      if (index < ROOMS && lastSnapAt) gaps.push(now - lastSnapAt)
      lastSnapAt = now
      return
    }
    const msg = JSON.parse(data.toString()) as { t: string; c?: number }
    if (msg.t === 'welcome') {
      stat.welcomed++
      welcomeMs.push(performance.now() - startedAt)
    } else if (msg.t === 'pong' && typeof msg.c === 'number') rtts.push(performance.now() - msg.c)
  })
  ws.on('close', () => {
    stat.closed++
    for (const t of timers) clearTimeout(t)
    timers = []
  })
  ws.on('error', () => {
    stat.errors++
  })
}

let spawned = 0
const ramp = setInterval(() => {
  for (let n = 0; n < RAMP_PER_S / 10 && spawned < BOTS; n++) bot(spawned++)
  if (spawned >= BOTS) clearInterval(ramp)
}, 100)

const pct = (a: number[], p: number): number => {
  if (a.length === 0) return 0
  const s = Float64Array.from(a).sort()
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10
}
setTimeout(() => {
  console.log(
    JSON.stringify({
      ...stat,
      welcomeMs: { p50: pct(welcomeMs, 50), p99: pct(welcomeMs, 99) },
      rttMs: { p50: pct(rtts, 50), p95: pct(rtts, 95), p99: pct(rtts, 99) },
      snapGapMs: { p50: pct(gaps, 50), p95: pct(gaps, 95), p99: pct(gaps, 99) },
      inBytesPerBotPerSec: Math.round(stat.bytesIn / BOTS / DURATION_S),
    }),
  )
  process.exit(0)
}, DURATION_S * 1000)
```

봇에 더할 시나리오: 포교 흐름(`talk` → `pitch`), 읽기를 멈춘 느린 봇(`ws.pause()`), 60초간 조용해지는 봇(숨은 탭), 전체의 30%가 동시에 끊고 재접속, 서버 재시작.

### 8.3 보고할 지표

서버(`/healthz`에 노출, 조회할 때마다 구간을 넘긴다):

| 지표 | 얻는 법 | 경고 기준(초안) |
|---|---|---|
| 틱 소요 p50 / p95 / p99 / 최대 | 틱 루프에서 `performance.now()` 차이 | p99가 틱 간격의 1/4(25ms) 초과 |
| 틱 지각 p99 | 예정 시각 대비 실제 시작 시각 | 10ms 초과 |
| 이벤트 루프 지연 p99 / 최대 | `monitorEventLoopDelay({ resolution: 10 })` | p99 20ms 초과 |
| 이벤트 루프 사용률 | `performance.eventLoopUtilization()` 구간 차이 | 0.5 초과 |
| CPU(user / sys) | `process.cpuUsage()` 구간 차이 | — |
| RSS, heapUsed | `process.memoryUsage()` | 계속 증가하면 누수 |
| 접속자당 송신 바이트/초 | 프레임 길이 + 헤더 합산 | 설계값(약 2.5KB/s)의 1.5배 초과 |
| 접속자당 프레임/초 | 송신 프레임 수 / 접속 수 | 10 미만이면 틱이 밀리는 중 |
| 건너뛴 스냅샷, 느린 클라이언트 종료 수 | `send()`의 백프레셔 분기 | 급증 |
| 속도 제한으로 버린 메시지, 거절한 이동 | 각 분기 | 정직한 봇에서 0이어야 함 |
| 하트비트 종료 수, 접속 수, 방 수 | — | — |

`monitorEventLoopDelay` 주의: Node 문서는 "지연은 나노초로 보고"하고 타이머 방식 표본에는 "매 표본에 `resolution`이 포함된다"고 적는다. [확인] 실제로 `resolution: 10`일 때 모든 실행에서 최솟값이 약 9ms로 나왔다. [측정] **백분위 값에서 `resolution`(10ms)을 빼야** 실제 지연에 가깝다.

지표 수집 코드(검증함, 1.3절 어댑터에 이어 붙는다):

```ts
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const eld = monitorEventLoopDelay({ resolution: 10 })
eld.enable()
let elu0 = performance.eventLoopUtilization()
let cpu0 = process.cpuUsage()
let at0 = performance.now()
let bytes0 = 0

/** /healthz 본문. 조회할 때마다 구간을 넘긴다(다음 조회는 이번 조회 이후만) */
function health(): Record<string, number> {
  const now = performance.now()
  const wall = (now - at0) / 1000
  const elu = performance.eventLoopUtilization(elu0)
  const cpu = process.cpuUsage(cpu0)
  const mem = process.memoryUsage()
  const out = {
    conns: conns.size,
    tickMsP50: pct(tickDur, 50),
    tickMsP95: pct(tickDur, 95),
    tickMsP99: pct(tickDur, 99),
    tickLateMsP99: pct(tickLate, 99),
    // 타이머 방식 표본에는 resolution(10ms)이 포함돼 있으므로 뺀다
    loopDelayMsP99: Math.max(0, eld.percentile(99) / 1e6 - 10),
    loopDelayMsMax: Math.max(0, eld.max / 1e6 - 10),
    elu: elu.utilization,
    cpuPct: ((cpu.user + cpu.system) / 1e6 / wall) * 100,
    rssMB: mem.rss / 1048576,
    heapUsedMB: mem.heapUsed / 1048576,
    outBytesPerClientPerSec: conns.size > 0 ? (metrics.bytesOut - bytes0) / wall / conns.size : 0,
    snapSkipped: metrics.snapSkipped,
    slowKicks: metrics.slowKicks,
    rateDrops: metrics.rateDrops,
    heartbeatKills: metrics.heartbeatKills,
  }
  eld.reset()
  elu0 = performance.eventLoopUtilization()
  cpu0 = process.cpuUsage()
  at0 = now
  bytes0 = metrics.bytesOut
  tickDur.length = 0
  tickLate.length = 0
  return out
}

function pct(arr: readonly number[], p: number): number {
  if (arr.length === 0) return 0
  const s = Float64Array.from(arr).sort()
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
```

클라이언트(봇): 접속 성공률, `welcome`까지 걸린 시간, 왕복 시간 p50 / p95 / p99, **스냅샷 도착 간격 p95 / p99**(사용자가 느끼는 끊김에 가장 가깝다), 디코드 실패 수.

### 8.4 정직하지 않은 결과가 나오는 경로

- **봇과 서버가 CPU를 나눠 쓴다.** 다른 기기에서 돌리거나 최소한 코어를 고정한다. 이번 측정도 200방부터는 봇 쪽이 포화돼 클라이언트 수치를 믿기 어려웠다.
- **루프백에는 손실도 지연도 없다.** 가능하면 봇 쪽에 `tc netem`으로 지연 60±20ms, 손실 1%를 건다(이 환경은 커널에 netem이 없어 못 했다).
- **봇이 서버에 맞춰 느려진다.** 응답을 받고 나서 다음 요청을 보내는 봇은 서버가 느려지면 부하를 스스로 줄여 문제를 가린다. 고정 일정으로 보내고 밀린 양을 기록한다(위 뼈대가 그렇게 한다).
- **예열 구간을 포함한다.** 접속 폭주와 JIT 예열이 섞인다. 전원 접속 후 몇 초를 버린다.
- **개발 모드로 잰다.** `tsx watch`가 아니라 `npm run build && npm start`로 잰다.
- **평균만 본다.** 틱은 평균이 아니라 p99와 최대가 사용자 경험을 정한다.
- **짧게 잰다.** 20초로는 메모리 누수와 GC 주기를 못 본다. 최소 5~10분, 출시 전에는 1시간 이상.
- **조건을 안 적는다.** CPU 모델, 코어 수, Node 버전, TLS 유무, 움직이는 봇 비율, 방 수와 인원을 결과와 같이 적는다.

---

## 9. 우리 게임에 적용할 것

### 9.1 지금 바로 (방 3개 단계에서도 사용자에게 보이는 문제)

| # | 할 일 | 고칠 곳 | 근거 |
|---|---|---|---|
| 1 | **보간 시계를 도착 기준으로 바꾸고 지연을 200ms로.** 진짜 서버 시각은 타이머 UI에만 쓴다. | `client/src/net/client.ts`(렌더 시각 계산), `INTERP_DELAY_MS` | 3.3, 3.5절 |
| 2 | **이동 검증을 거리 예산 방식으로.** 여유 배수 1.5 → 1.15. | `server/core/room.ts`의 MOVE 처리, `SPEED_TOLERANCE` | 5.1절 |
| 3 | **속도 제한 초과 시 즉시 kick하지 말고 버린다.** 3초 지속 시에만 kick. 클라이언트는 `bufferedAmount > 0`이면 이동 패킷을 건너뛴다. | 코어 토큰 버킷, `net.sendMove` | 5.2, 1.6절 |
| 4 | **백프레셔 임계값을 낮춘다.** 스냅샷 16KB에서 건너뛰기, 256KB에서 `terminate()`. 설계 문서의 "1MB"는 사실상 안 걸린다. | `server/node/main.ts`의 `host.send` | 1.6절 |
| 5 | **재접속 보강.** 접속·welcome 타임아웃, 세대 번호, 침묵 감시, Full Jitter, 4004 추가 지연, 5초 안정 뒤 횟수 초기화, `visibilitychange`·`online`·`pagehide`·`pageshow` 처리. | `client/src/net/client.ts` | 6.1, 6.2, 6.4절 |
| 6 | **하트비트 정리.** 메시지와 pong을 모두 생존 신호로 치고 조용한 연결만 ping한다. 자리 비움(입력 없음 3~5분)은 별도 타이머로 분리한다. `IDLE_TIMEOUT_MS = 45초`를 그대로 두면 숨은 탭이 이유 없이 끊긴다. | 어댑터 하트비트, 코어의 idle 정리 | 1.5, 6.4절 |
| 7 | `ws` 8.23.0 고정 유지, `maxPayload: 4096`, `perMessageDeflate: false`, 모든 소켓에 `'error'` 리스너. `bufferutil`은 넣지 않는다. | `server/node/main.ts` | 1.1~1.3절 |

### 9.2 방 50개를 넘기기 전에

| # | 할 일 | 근거 |
|---|---|---|
| 8 | **틱을 10칸으로 분산.** "하나의 `setInterval`에서 사람이 있는 방 전부"는 100방에서 틱마다 14~27ms 루프를 막는다. | 7.2절 |
| 9 | `hold` 보정(직전 틱에서 출발했다고 가정)과 100ms 외삽 한도 추가. | 3.4, 3.5절 |
| 10 | **재개 유예 20초.** 짧은 끊김에 자리, 위치, 신도 행렬을 지킨다. | 6.3절 |
| 11 | `/healthz` 지표 확장(8.3절)과 `tools/loadtest.ts` 봇. 실제 `Room`으로 100방을 돌려 로직 CPU를 잰 뒤 프로세스당 방 수를 확정한다(`docs/LOADTEST.md`). | 8장 |
| 12 | pid가 다른 플레이어에게 가는 메시지에 실리지 않는지 점검. `dup`으로 쫓겨난 탭이 자동 재접속하지 않는지 확인. | 5.4절 |
| 13 | 서버에서도 `resolveCollision`으로 금지 구역(건물 안, 직급 미달 HQ) 진입을 막는다. | 5.1절 |

### 9.3 방 100개 이상으로 갈 때

| # | 할 일 | 근거 |
|---|---|---|
| 14 | **프로세스당 100방으로 샤딩.** 방 id → 샤드 결정적 매핑, 로비가 방마다 접속 주소를 내려 준다. `cluster` 모드는 쓰지 않는다. | 7.4절 |
| 15 | 대역폭이 비용 문제가 되면 배회 NPC만 5Hz(약 −21~28%). 그래도 부족하면 int8 델타. | 2.2, 2.4절 |
| 16 | 전송량 포함 요금제 선택. 계산 단위는 플레이어-시간당 약 11.7MB. | 2.4절 |
| 17 | Durable Objects 어댑터는 방이 비면 틱 타이머를 멈춘다. 상시 부하용으로는 쓰지 않는다. | 7.5절 |

### 9.4 하지 않을 것

- uWebSockets.js 도입(1.7절), permessage-deflate(1.2절), 스냅샷 버퍼 풀링(1.4절).
- 클라이언트별 관심 영역 스냅샷. 엔티티가 48개뿐이라, 방마다 한 번 인코딩해 같은 버퍼를 20명에게 보내는 지금 방식이 CPU로도 단순함으로도 낫다. [추론]
- 전송률을 15~20Hz로 올리기. 대역폭이 그만큼 늘고 사교형 게임에서 체감 이득이 작다. [추론]
- Artillery로 부하 테스트(8.1절).

---

## 10. 확인하지 못한 것

- Valve Source 엔진의 보간·외삽 기본값(위키가 봇 차단으로 열리지 않음).
- 현재 Chrome에서 WebSocket을 쓰는 페이지가 집중 타이머 스로틀(1분에 한 번)에서 면제되는지.
- Cloudflare 프록시의 WebSocket 유휴 타임아웃 초 수(문서에는 "일정 시간"으로만 적혀 있다).
- iOS Safari의 CONNECTING 멈춤 버그는 보고자 주장이고 WebKit 쪽 확인이 없다. 실제 기기에서 재현해 보지 않았다.
- AWS 글의 지터 수식 원문(그림이라 추출하지 못함). 본문의 Full Jitter 식은 일반적으로 알려진 형태다.
- 패킷 손실·지연이 있는 조건에서의 스냅샷 도착 간격(커널에 netem 없음). 3.2절의 지각 추정은 RFC 8985에서 끌어낸 계산이다.
- TLS를 Node가 직접 종단할 때의 CPU, 실제 `Room` 로직의 CPU(서버 코어가 아직 없었다).
- 벤치마크는 대부분 1회 측정이다. 200방 이상은 봇 쪽 CPU 경합으로 흔들린다.
- uWebSockets.js와 `ws`를 직접 비교한 최신 외부 벤치마크, 프로젝트의 "10~30배" 주장.
- k6의 정확한 최신 버전(릴리스 노트 목록에 2.3.0과 설명 없는 2.4.0 항목이 같이 있었다).
- VM 업체별 전송량 요금과 포트 속도.
- `BroadcastChannel`·Web Locks의 인앱 브라우저(인스타그램, 카카오톡) 지원 여부.
- NTP 시계 필터가 "최근 8개 중 최소 지연"을 쓴다는 것(RFC 5905를 읽지 않았다).
- 재접속 상태기계와 보간 코드는 Node에서만 검증했다. 실제 모바일 브라우저에서는 돌려 보지 않았다.

---

## 11. 출처

직접 읽은 것:

- ws 릴리스 노트: https://github.com/websockets/ws/releases
- ws API 문서: https://github.com/websockets/ws/blob/master/doc/ws.md
- ws 8.23.0 패키지 소스(`README.md`, `lib/websocket.js`, `lib/websocket-server.js`, `lib/receiver.js`, `lib/buffer-util.js`): `npm install ws@8.23.0`
- uWebSockets.js 릴리스: https://github.com/uNetworking/uWebSockets.js/releases (v20.52.0, v20.72.0 패키지를 설치해 내용 확인)
- Evil Martians, WebSocket 서버 5종 벤치마크(2026-06-24): https://evilmartians.com/chronicles/choose-your-fighter-benchmarking-5-websocket-servers-for-nodejs
- Gaffer on Games, Snapshot Interpolation: https://gafferongames.com/post/snapshot_interpolation/
- Gabriel Gambetta, Entity Interpolation: https://www.gabrielgambetta.com/entity-interpolation.html
- @geckos.io/snapshot-interpolation 1.1.1 패키지 소스: `npm pack @geckos.io/snapshot-interpolation`
- RFC 6455 (WebSocket): https://www.rfc-editor.org/rfc/rfc6455.html
- RFC 8985 (RACK-TLP): https://www.rfc-editor.org/rfc/rfc8985.html
- AWS, Exponential Backoff And Jitter: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- Chrome, 타이머 스로틀(Chrome 88): https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Chrome, Page Lifecycle API: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- MDN, Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN, WebSocket.bufferedAmount: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount
- web.dev, bfcache: https://web.dev/articles/bfcache
- WebKit 버그 308073: https://bugs.webkit.org/show_bug.cgi?id=308073
- Node.js perf_hooks: https://nodejs.org/api/perf_hooks.html
- nginx WebSocket 프록시: https://nginx.org/en/docs/http/websocket.html
- Cloudflare, Durable Objects WebSocket 모범 사례: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare, Durable Objects 요금: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare, Durable Objects 한도: https://developers.cloudflare.com/durable-objects/platform/limits/
- Cloudflare, WebSocket(프록시): https://developers.cloudflare.com/network/websockets/
- Colyseus 확장: https://docs.colyseus.io/scalability
- Colyseus SDK 연결 수명: https://docs.colyseus.io/sdk/connection
- Colyseus 재접속: https://docs.colyseus.io/room/reconnection
- Colyseus FAQ: https://docs.colyseus.io/faq
- Fly.io 동적 요청 라우팅: https://docs.fly.io/networking/dynamic-request-routing
- k6 `k6/websockets`: https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/
- k6 `WebSocket.send`: https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/websocket/websocket-send/
- k6 릴리스 노트 목록: https://grafana.com/docs/k6/latest/release-notes/
- Artillery WebSocket 엔진: https://www.artillery.io/docs/reference/engines/websocket

검색 결과 요약으로만 본 것:

- Apple 개발자 포럼, iOS 15 Safari WebSocket 문제: https://developer.apple.com/forums/thread/696310
- k6 v1.6.0 릴리스 노트(`k6/websockets` 안정화): https://grafana.com/docs/k6/v2.3.x/release-notes/v1.6.0/
- Colyseus 0.17 릴리스 글: https://colyseus.io/blog/colyseus-017-is-here/

열지 못한 것:

- Valve, Source Multiplayer Networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking (봇 차단)
