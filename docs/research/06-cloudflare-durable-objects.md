# 06. Cloudflare Workers + Durable Objects로 방 서버 돌리기

- 조사일: 2026-11-26
- 대상: "도를 아십니까? — 교주 시뮬레이터"의 방 서버를 Node(`ws`) 대신 Cloudflare Workers + Durable Objects(이하 DO)에 올리는 어댑터(`worker/`)
- 방법: developers.cloudflare.com 문서를 2026-11-26에 직접 읽었고(대부분 2026-10~11월 수정본), `wrangler@4.168.0`을 임시 폴더에 설치해 **예제를 로컬 `workerd`에서 실제로 띄워 검증**했다.
- **하지 못한 것: 실제 Cloudflare 계정 배포.** 이 환경에는 Cloudflare 계정·토큰이 없다. 과금액, 프로덕션 지연, 프로덕션에서의 축출·종료 동작은 문서 근거이거나 로컬 실측이다. 문단마다 근거를 표시했다.

## 근거 등급 표기

| 표기 | 의미 |
|---|---|
| **[문서]** | developers.cloudflare.com 공식 문서·체인지로그를 직접 읽음(§17에 URL 목록) |
| **[npm]** | 2026-11-26에 `npm view …`로 조회 |
| **[스키마]** | 설치한 `wrangler@4.168.0`의 `config-schema.json`, `wrangler … --help`, 생성된 타입 파일에서 확인 |
| **[실측-로컬]** | `wrangler dev`(workerd 1.20261123.1, Linux, Node 22.23.5)에서 직접 돌려 확인. **프로덕션과 다를 수 있다** |
| **[추정]** | 위 근거에서 내가 계산·추론한 것 |
| **확인 못함** | 찾았지만 검증하지 못한 것(§16에 모음) |

---

## 1. 한눈에 보는 결론

1. **된다.** Worker(라우터) + `RoomDO`(방 하나 = DO 하나, 10Hz 틱) + `LobbyDO`(싱글턴) + 정적 클라이언트 서빙까지 한 Worker로 묶은 예제(§10)를 로컬에서 띄워, 58명이 각자 10Hz로 보내는 상태에서 스냅샷 간격 p50 100.0ms / p99 116ms / 최대 125ms를 확인했다. [실측-로컬]
2. **10Hz 틱이 도는 방은 동면(hibernation)하지 못한다.** `setTimeout`/`setInterval`이 하나라도 걸려 있으면 동면 조건에서 탈락하고, 그동안은 벽시계 시간 전부가 과금된다(128MB × 초). **방 하나가 1시간 깨어 있으면 약 $0.00576.** 사람이 없는 방은 타이머를 지워야 과금이 멈춘다. [문서][실측-로컬][추정]
3. **`RoomDO`는 표준 WebSocket API(`server.accept()` + `addEventListener`)를 권한다.** 공식 문서는 Hibernation API를 "권장"이라고 적지만, 그 이점(가만히 있을 때 과금 정지)은 틱이 계속 도는 방에서는 생기지 않는다. 반면 로컬 실측에서 Hibernation API는 **서버가 틱·`fetch` 문맥에서 `close()`한 소켓의 종료가 클라이언트에 늦게(10초 뒤) 또는 아예 도착하지 않았다.** 표준 API는 어느 문맥에서든 13~77ms 안에 끝났다. Hibernation API가 맞는 곳은 "붙어만 있고 조용한" DO다(§3). [문서][실측-로컬]
4. **틱은 "매번 다시 거는 `setTimeout`"으로.** 알람(`setAlarm`)으로 10Hz를 만들면 알람 한 번마다 요청 1건 + 행 쓰기 1건이 과금돼 방-시간당 약 $0.041, 그냥 깨어 있는 값의 7배다. [문서][추정]
5. **비용(§5).** 방 3개를 하루 4시간·방당 5명으로 쓰면 무료 플랜 일일 한도의 약 59%(요청)·43%(duration)이고, 유료 플랜이면 **월 $5.15**. 방 100개 × 20명 × 하루 8시간이면 **월 약 $212**(클라이언트 전송 빈도에 따라 $160~$277). 이 가운데 $137.50은 "방이 깨어 있는 시간" 값이라 전송을 줄여도 안 줄어든다. [문서][추정]
6. **무료 플랜으로 DO를 쓸 수 있다(SQLite 백엔드만).** 단, 일일 한도를 넘으면 그 종류의 동작이 **오류로 실패**하고 UTC 00:00(한국 09:00)에야 풀린다. 인스타그램에서 퍼질 것을 기대하는 게임이면 출시는 유료 플랜($5/월)으로 해야 한다. [문서]
7. **DO 클래스 선언 방식이 바뀌었다.** 2026-07부터 `wrangler` 설정의 선언형 **`exports`** 가 기본이고, `migrations` + `new_sqlite_classes`는 "legacy"로 내려갔다(계속 지원). 둘을 한 설정에 같이 쓰면 오류. 한번 `exports`로 배포하면 `migrations`로 돌아갈 수 없다(§6). [문서][스키마][실측-로컬]
8. **설정 파일은 `wrangler.jsonc`.** 문서가 새 프로젝트에 권장하고, 일부 새 기능은 JSON 설정에서만 된다고 적는다. `compatibility_date`는 "프로젝트를 만든 날짜"로 고정한다(§7). [문서]
9. **정적 클라이언트는 같은 Worker의 `assets.directory`로.** 에셋과 일치하는 요청은 Worker를 거치지 않고 **무료·무제한**으로 서빙된다. 에셋에 없는 경로만 Worker의 `fetch()`로 온다(§8). [문서][실측-로컬]
10. **라우팅은 `env.ROOM.getByName("room-3")`** (`get(idFromName(...))`의 축약형). DO 안에서는 `ctx.id.name`으로 그 이름을 읽을 수 있다. DO는 한번 만들어지면 위치가 바뀌지 않으므로 첫 호출에 `locationHint: "apac-ne"`(동북아: 한국·일본)를 준다(§9). [문서][스키마][실측-로컬]
11. **배포하면 방이 끊긴다.** 깨어 있는 DO는 배포 후 기본 최대 300초 안에 리셋되고, 붙어 있던 WebSocket은 끊긴다(로컬에서는 60/60이 즉시 `1006`). 종료 훅은 없다. `wrangler secret put`도 배포다(§13). [문서][실측-로컬]
12. **HMAC은 둘 다 된다.** WebCrypto(`crypto.subtle`)는 플래그 없이 항상, `node:crypto`(`createHmac`, 동기)는 `compatibility_date`가 2026-08-04 이상이면 플래그 없이. 두 방식이 같은 서명을 내는 것을 확인했다(§11). [문서][실측-로컬]
13. **로그 과금 함정.** Workers Logs를 켜면 WebSocket 이벤트도 "호출 로그" 대상이다. 방 서버는 `invocation_logs: false`로 꺼 둔다(§13-8). [문서]
14. **`wrangler` 4.168.0은 Node ≥ 22.12를 요구한다.** 저장소 `package.json`의 `engines`는 `>=20`이다. [npm]
15. 새 통합 CLI `cf`(npm `cf@1.0.0-rc.6`, 설정은 `cloudflare.config.ts`)가 릴리스 후보 단계로 나와 있다. 아직 RC이므로 이 문서는 `wrangler` 기준이다. [문서][npm]

---

## 2. 버전·도구 현황

| 항목 | 값 | 근거 |
|---|---|---|
| `npm view wrangler version` | **4.168.0** (2026-11-24 갱신, dist-tag `latest`; `legacy` 태그는 3.114.17) | [npm] |
| wrangler `engines.node` | `>=22.12.0` | [npm] |
| wrangler가 끌고 오는 런타임 | `workerd 1.20261123.1`, `miniflare 5.20261123.1-beta`, `esbuild 0.28.2` | [npm] |
| `workerd` 최신 | 1.20261125.1 | [npm] |
| `@cloudflare/workers-types` | 5.20261125.1 — v5부터 날짜별 엔트리포인트가 없어졌다. 문서는 이 패키지 대신 **`wrangler types`** 로 타입을 생성하라고 권한다 | [npm][문서] |
| `@cloudflare/vite-plugin` | 1.70.2 (이번 조사에서는 쓰지 않음) | [npm] |
| `@cloudflare/vitest-pool-workers` | 0.23.0 (DO 축출을 테스트하는 `cloudflare:test` 도우미가 2026-06에 추가됨. 써 보지는 않음) | [npm][문서] |
| `cf` (새 Cloudflare CLI) | 1.0.0-rc.6, "release candidate". Wrangler 프로젝트는 `cf migrate`로 `cloudflare.config.ts`로 옮긴 뒤에야 `cf dev/deploy`를 쓸 수 있다 | [npm][문서] |
| 로컬 검증 조합 | wrangler 4.168.0 + workerd 1.20261123.1 + TypeScript 7.0.2(`tsc --noEmit` 통과) + Node 22.23.5 | [실측-로컬] |

---

## 3. WebSocket: 표준 API vs Hibernation API — 10Hz 틱 방에는 무엇이 맞나

### 3.1 두 API

| | 표준 API | Hibernation API |
|---|---|---|
| 받는 법 | `server.accept()` | `this.ctx.acceptWebSocket(server, tags?)` |
| 메시지 | `server.addEventListener("message", …)` | 클래스 메서드 `webSocketMessage(ws, message)` |
| 종료 | `"close"` 이벤트. `compatibility_date` ≥ 2026-04-07이면 상대의 Close에 런타임이 자동 응답 | `webSocketClose(ws, code, reason, wasClean)`. **핸들러 안에서 `ws.close()`로 직접 응답해야 한다**(§3.4-C) |
| 이진 프레임 | `binaryType` 기본값이 **`"blob"`** (`compatibility_date` ≥ 2026-03-17). `accept()` 전에 `server.binaryType = "arraybuffer"` | 날짜와 무관하게 항상 `ArrayBuffer` |
| 연결별 상태 | 클로저·`Map`에 그대로 | `ws.serializeAttachment(v)`(직렬화 후 최대 16,384바이트), `ctx.getWebSockets(tag?)`, 태그 최대 10개 × 256자 |
| 동면 | **불가.** 소켓이 붙어 있는 내내 duration 과금 | 타이머·진행 중 I/O가 없고 10초간 이벤트가 없으면 메모리에서 내려가고, 소켓은 Cloudflare가 붙들고 있는다. 그동안 duration 과금 없음 |
| ping/pong | 앱 수준 ping은 직접 응답 | WebSocket 프로토콜 ping 프레임은 런타임이 자동 응답(깨우지 않음). 앱 수준 ping은 `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))`로 DO를 깨우지 않고 응답 가능 |
| DO당 연결 수 | 문서에 숫자 없음("thousands of clients per instance") | 최대 32,768 |
| 문서의 권장 | — | "recommended" |

모두 [문서]. 이진 타입과 종료 동작은 [실측-로컬]로도 확인(§3.4).

### 3.2 동면 조건과 타이머

문서(Lifecycle of a Durable Object)가 적는 동면 조건은 **넷 다** 참이어야 한다. [문서]

- `setTimeout`/`setInterval`로 예약된 콜백이 없다("동면 뒤에 콜백을 되살릴 방법이 없으므로").
- 끝나지 않은 I/O, `ctx.waitUntil()`에 넘긴 프라미스, 열려 있는 외부 연결이 없다.
- 표준 WebSocket API를 쓰지 않는다.
- 처리 중인 요청·이벤트가 없다.

조건을 만족한 채 10초가 지나면 동면한다. 조건을 만족하지 못하면 "idle, in-memory, non-hibernateable" 상태로 남아 **계속 duration이 과금**되고, 들어오는 요청·이벤트가 70~140초 동안 없으면 통째로 축출된다. [문서]

과금 문장(Pricing): "Durable Objects are billed for compute duration (wall-clock time) while the Durable Object is actively running or is idle in memory but unable to hibernate." 동면 자격이 있으면 실제로 내려가기 전의 짧은 구간도 과금하지 않는다. [문서]

따라서 **10Hz 틱이 도는 동안은 어느 API를 쓰든 과금이 같다.** Hibernation API가 돈을 아껴 주는 것은 "소켓은 붙어 있지만 틱을 멈춘" 시간뿐이다.

**타이머와 축출(2026-10-01 변경).** `compatibility_date` ≥ 2026-10-01부터 대기 중인 `setTimeout`/`setInterval`도 "축출을 막는 작업"으로 취급된다. 단 **작업 하나당 시작 시점부터 최대 15분**이고, 나중에 새 작업을 시작하면 다시 연장된다. [문서]
- `setInterval`은 한 번 건 작업이고, 매번 다시 거는 `setTimeout`은 틱마다 새 작업이다. 그래서 예제는 `setTimeout` 체인을 쓴다. [추정]
- 우리 프로토콜은 클라이언트가 4초마다 ping을 보내므로(`PING_INTERVAL_MS = 4000`), 사람이 한 명이라도 붙어 있으면 "70~140초 무이벤트"에 걸릴 일이 없다. 타이머 보호는 2차 안전장치다. [추정]
- 로컬에서는 결과가 둘로 갈렸다(§3.4-M). **소켓이 붙어 있으면** 들어오는 메시지가 0건이어도 타이머가 도는 DO는 21분 뒤까지 같은 인스턴스였다. **소켓이 하나도 없으면** 타이머가 돌고 있어도 60~120초 사이에 축출됐다(메모리 상태 소실, 타이머도 함께 사라짐). 즉 로컬 workerd에서는 타이머가 축출을 막아 주지 않았다. 프로덕션이 어느 쪽인지는 확인 못함. 어느 쪽이든 "사람이 없는 방을 타이머로 계속 돌린다"는 설계는 하지 않는다. [실측-로컬]

### 3.3 알람으로 틱을 만들면?

- 알람은 DO당 하나, ms 단위 타임스탬프로 건다. 최소 간격·정밀도는 문서에 없다. 최소 1회 실행 보장, 실패 시 2초부터 지수 백오프로 최대 6회 재시도, 핸들러 벽시계 한도 15분. [문서]
- 로컬에서 100ms 뒤 알람을 30번 연달아 걸었더니 간격이 100~102ms였다. [실측-로컬]
- **비용이 맞지 않는다.** 알람 호출은 요청 1건으로, `setAlarm()`은 행 쓰기 1건으로 과금된다. 10Hz면 방-시간당 36,000건씩 → 요청 $0.0054 + 행 쓰기 $0.036 = **$0.041/방-시간**. 깨어 있는 값($0.00576)의 약 7배이고, 100ms마다 깨어나므로 동면 이득도 없다. [문서][추정]
- 알람이 맞는 곳: "방이 빈 지 N분 뒤 저장소 정리", "자정에 오늘의 계시 초기화"처럼 드문 예약 작업.

### 3.4 로컬 실측 요약

조건: wrangler 4.168.0 `wrangler dev`, workerd 1.20261123.1, `compatibility_date` 2026-11-23, 클라이언트는 Node 22의 전역 `WebSocket`(undici)과 `ws` 8.23.0. 전부 [실측-로컬].

| # | 실험 | 결과 |
|---|---|---|
| A | Hibernation API, 타이머 없음, 16초간 메시지 없음 | 다음 메시지에서 **생성자가 다시 실행**(동면했다 깸). 소켓·attachment·태그는 그대로. `ctx.id.name`도 유지 |
| B | Hibernation API + `setInterval(100ms)` | 동면하지 않음. 16.3초 동안 164틱, 같은 인스턴스 |
| C | Hibernation API, 클라이언트가 `close(1000)` | `webSocketClose` 안에서 `readyState`는 2(CLOSING). `ws.close(code, reason)`을 부르면 3이 되고 클라이언트는 즉시 clean close. **부르지 않으면 클라이언트 close 이벤트가 10초 뒤 `1006`(비정상)으로 온다** |
| C' | 클라이언트가 비정상 종료(프로세스 kill) | `webSocketClose(code=1006)`. 이때 `ws.close(1006, …)`은 `InvalidAccessError` → 코드 필터 + `try/catch` 필요 |
| D | 표준 API로 이진 프레임 수신 | 기본은 `Blob`. `server.binaryType = "arraybuffer"` 뒤에는 `ArrayBuffer` |
| E | Hibernation API로 이진 프레임 수신 | `ArrayBuffer` |
| F | `close(4000, "가" × 42)` (126바이트) | `SyntaxError: WebSocket close reason must not be longer than 123 bytes when UTF-8 encoded.` 한글은 41자까지 |
| G | 100ms 알람 30회 연쇄 | 간격 100~102ms |
| H | 동기 루프(약 0.45초) 앞뒤의 `Date.now()` | 로컬에서는 445ms 흐름. **프로덕션은 문서상 "마지막 I/O 시각에 고정"** 이므로 다르다 |
| I | **서버가 먼저 `close()`** (아래 표) | Hibernation API는 호출 문맥에 따라 종료가 늦거나 오지 않음 |
| J | 실행 중 코드 교체(`wrangler dev` 리로드) | 연결 60/60이 0.1초 안에 `1006`으로 끊김. 방 DO는 "0명" 보고 없이 사라져 로비에 20/20이 남음 |
| K | 방 3개 × 20명, 각자 10Hz로 9바이트 전송, 10초 | 스냅샷 100개/명 수신, 간격 p50 100.0 / p99 111~116 / 최대 120~125ms |
| L | 설정에 `exports`와 `migrations`를 함께 | `` `migrations` and `exports` are mutually exclusive `` 오류 |
| M | 100ms 타이머만 돌고 들어오는 메시지는 0건 | **(Hibernation API로 받은) 소켓 1개가 붙어 있는 경우**: `setInterval` 판·`setTimeout` 체인 판 모두 21분(1,260초) 뒤에도 같은 인스턴스(생성자 재실행 없음), 틱 12,422회 실행(보정 없는 100ms 타이머가 평균 101.4ms로 돈 셈 → 예제처럼 밀림 보정이 필요). **소켓이 없는 경우**(클라이언트가 바로 정상 종료): 두 판 모두 60초 시점의 로그를 끝으로 멈췄고, 18분 뒤 다시 불렀을 때 생성자가 새로 돌았다(60~120초 사이에 축출) |
| N | 예제의 방이 빈 뒤(타이머 해제) 약 8분 뒤 재접속 | `welcome`의 `conn: 1, tick: 0` → 인스턴스가 내려갔다가 새로 만들어짐 |
| O | Hibernation API + 100ms 타이머, 클라이언트가 떠남(정상 종료 / 프로세스 kill 각각) | `webSocketClose`에서 `ws.close()`로 응답한 DO는 120~150초 사이에 축출. **응답하지 않은 DO는 7분 30초 뒤(관찰을 멈춘 시점)에도 계속 실행 중**이었다. `ctx.getWebSockets()`는 0개인데도 그랬다. 닫기 응답이 안 된 소켓이 DO를 붙잡아 두는 것으로 보인다[추정] |

**I. 서버가 먼저 닫을 때 클라이언트의 `close` 이벤트가 오기까지** (undici·`ws` 두 클라이언트에서 같은 결과)

| API | `close()`를 부른 곳 | 그 뒤 DO가 조용해지는 경우 | 100ms 타이머가 계속 도는 경우(= 틱 중인 방) |
|---|---|---|---|
| 표준 | `fetch` 안(101 응답 전) | 77ms(연결 시작부터) | 17ms(연결 시작부터) |
| 표준 | 타이머 콜백 | 17ms(호출부터) | 15ms(호출부터) |
| Hibernation | `webSocketMessage` 핸들러 안 | 16ms(연결 시작부터) | 12ms(연결 시작부터) |
| Hibernation | `fetch` 안(101 응답 전) | **10.0초**(DO가 동면하는 시점) | **오지 않음**(25~45초 관찰. `ws` 클라이언트는 자체 종료 타임아웃 30초에 스스로 끊음) |
| Hibernation | 타이머 콜백 | **10.0초**(호출부터) | **오지 않음**(25초 관찰) |

서버 쪽 `webSocketClose`는 `wasClean=true`로 불리고 `ctx.getWebSockets()`에서도 빠진다. 즉 서버는 닫혔다고 보는데 TCP 연결이 정리되지 않아 브라우저는 `CLOSING`에 머문다. 앞서 보낸 데이터 메시지(`{"t":"full"}`)는 정상 도착한다. **프로덕션에서도 같은지는 확인 못함.**

우리 코어는 "정원 초과", "hello 시간 초과", "중복 접속", "무응답" 같은 종료를 `fetch`·틱 문맥에서 `host.close()`로 한다. 이 표의 아래 두 줄에 정확히 해당한다.

### 3.5 결정

**`RoomDO`: 표준 API.** 근거:
1. 틱이 도는 동안 과금은 두 API가 같다(§3.2).
2. 서버 주도 종료가 어느 문맥에서든 바로 끝난다(§3.4-I). `RoomHost.close(conn, code, reason)`을 Node 어댑터와 같은 의미로 구현할 수 있다.
3. 연결 상태를 `Map<ConnId, WebSocket>` 하나로 들고 있으면 되고, "소켓은 살아 있는데 방 메모리는 비어 있는" 동면 복귀 경로를 처리할 필요가 없다.

치르는 값: `binaryType`을 직접 바꿔야 하고, 틱을 멈춰도 소켓이 붙어 있으면 과금이 계속된다(우리 설계에서는 소켓이 있으면 틱도 돌므로 차이 없음).

**Hibernation API로 바꿔야 할 때**: "모두 자리 비움이면 시뮬레이션을 멈추고 재운다" 같은 절전 모드를 넣을 때, 또는 관전·대기실처럼 붙어만 있고 조용한 DO를 만들 때. 그때는 §10.4의 변형을 쓰고 다음을 지킨다.
- `webSocketClose`에서 반드시 `ws.close()`로 응답(코드 필터 + `try/catch`).
- 서버가 끊고 싶으면 **`kick`/`full` 메시지를 먼저 보내고, 클라이언트가 그 메시지를 받는 즉시 스스로 `close()`** 한다. 서버는 몇 초 뒤에도 남아 있으면 `close()`를 부른다. 클라이언트는 `onclose`를 기다리지 않는다.
- 생성자에서 `ctx.getWebSockets()`로 연결 표를 되살리고, 방 상태를 복원할 수 없으면 전원에게 재접속을 시킨다.

---

## 4. 방 하나의 생애와 과금 상태

```
[없음] ──첫 접속(/ws?room=3)──▶ 생성자 → fetch → accept → 틱 루프 시작
                                   │  플레이어 ≥ 1: 10Hz 틱, 동면 불가, duration 과금
                                   ▼
                           마지막 플레이어 퇴장 → clearTimeout → 로비에 0명 보고
                                   │  타이머·소켓 없음 → 과금 정지 → 잠시 뒤 메모리에서 내려감
                                   ▼
[없음] ◀── 다음 접속 때 생성자부터 다시(메모리 상태는 사라져 있다)
```

- 방의 메모리 상태(NPC 위치, 신도 줄, 진행 중인 배틀)는 **방이 비면 사라진다.** 배포·런타임 업데이트·호스트 이동 때도 사라진다. 문서는 종료 훅을 제공하지 않으며 "상태를 조금씩 저장하라"고 한다. [문서]
- 우리 구조에서는 플레이어 진행도가 서명 저장본으로 클라이언트에 있으므로, 방이 리셋돼도 재접속하면 진행도는 이어진다. 방 단위로 남겨야 하는 것(교단 기록 등)만 DO 저장소에 쓴다.

---

## 5. 과금 모델과 견적

### 5.1 요금표 (2026-11-13 수정본) [문서]

**Durable Objects 연산**

| | 무료 플랜 | 유료 플랜(Workers Paid, 계정당 최소 $5/월) |
|---|---|---|
| 요청 | 100,000 / 일 | 월 100만 포함, 초과 $0.15 / 100만 |
| Duration | 13,000 GB-s / 일 | 월 400,000 GB-s 포함, 초과 $12.50 / 100만 GB-s |

- 요청에 들어가는 것: HTTP 요청, RPC 세션(스텁에서 메서드를 한 번 부를 때마다 1건), **들어오는 WebSocket 메시지**, 알람 호출.
- **들어오는 WebSocket 메시지는 20:1**로 센다(100건 = 요청 5건). **나가는 메시지는 무료**, 프로토콜 ping도 무료. 연결을 만들 때 요청 1건.
- Duration은 실제 메모리 사용량과 무관하게 **128MB로 계산**한다. 1초 = 0.128 GB-s.
- 초과분은 **다음 과금 단위(100만)로 올림**한다. 50만 GB-s 초과도 100만 GB-s로 청구된다.
- DO는 CPU 시간으로는 과금하지 않는다(요청 + duration뿐).
- 데이터 전송(egress)·대역폭 요금은 없다.

**DO SQLite 저장소** (2026-01부터 과금)

| | 무료 | 유료 |
|---|---|---|
| 행 읽기 | 500만 / 일 | 월 250억 포함, 초과 $0.001 / 100만 |
| 행 쓰기 | 100,000 / 일 | 월 5,000만 포함, 초과 $1.00 / 100만 |
| 저장 용량 | 계정 합계 5GB | 5 GB-월 포함, 초과 $0.20 / GB-월 |

`setAlarm()` 1회 = 행 쓰기 1건. KV식 `get/put`도 숨은 SQLite 테이블에 대한 행 읽기·쓰기로 센다. 빈 SQLite DB도 약 12KB를 차지한다.

**Workers(라우터)**

| | 무료 | 유료(Standard) |
|---|---|---|
| 요청 | 100,000 / 일 | 월 1,000만 포함, 초과 $0.30 / 100만 |
| CPU | 호출당 10ms | 월 3,000만 CPU-ms 포함, 초과 $0.02 / 100만 CPU-ms |

- **정적 에셋 요청은 무료·무제한.** WebSocket은 업그레이드 요청 1건만 세고, Worker를 지나가는 메시지는 요청으로 세지 않는다.
- Workers Logs: 무료 20만 건/일(3일 보관), 유료 월 2,000만 건 포함 + $0.60/100만(7일 보관). **2026-12-01부터 "Cloudflare Observability pricing"(수집 GB 기준: 유료 50GB 포함, 초과 $0.25/GB)으로 바뀐다.**

### 5.2 단가로 환산 [추정]

| 항목 | 값 |
|---|---|
| 방 하나가 1시간 깨어 있는 값 | 3,600초 × 0.128 = 460.8 GB-s → **$0.00576** |
| 유료 플랜 포함 duration | 400,000 GB-s = 방-시간 868시간/월(하루 약 29시간) |
| 무료 플랜 duration | 13,000 GB-s/일 = **방-시간 28.2시간/일** |
| 플레이어 한 명이 1시간 내내 10Hz로 보내는 값 | 36,000건 ÷ 20 = 요청 1,800건 → $0.00027 |
| 유료 플랜 포함 요청 | 100만 건 = 수신 메시지 2,000만 건 |
| 무료 플랜 요청 | 10만 건/일 = 수신 메시지 200만 건/일(20:1이 무료 한도 계산에도 적용된다고 가정. 확인 못함) |

### 5.3 견적

가정: 틱은 플레이어가 한 명이라도 있을 때만 돈다. 클라이언트는 움직이는 동안 MOVE를 10Hz로(`CLIENT_SEND_HZ = 10`), 그 밖에 4초마다 ping. "이동 50%"면 1인당 평균 초당 5.25건. 한 달 30일. 방 → 로비 보고는 인원 변동 때 + 30초 하트비트. Worker 요청(WS 업그레이드, `/api/rooms`)은 전부 포함량 안이다. 계산 스크립트로 산출했고 문서의 올림 규칙을 적용했다. [추정]

| 시나리오 | 방-시간/일 | duration GB-s/월 | 수신 메시지/월 | DO 요청/월 | 요청 $ | duration $ | **월 합계(구독 $5 포함)** | 무료 플랜 일일 한도 대비 |
|---|---|---|---|---|---|---|---|---|
| **A1. 방 3개, 가볍게**: 방당 평균 5명, 하루 4시간 | 12 | 165,888 | 3,402만 | 177만 | 0.15 | 0 | **$5.15** | 요청 59% · duration 43% |
| A2. 방 3개에 24시간 내내 누군가 있음(방당 5명) | 72 | 995,328 | 2.04억 | 1,059만 | 1.50 | 12.50 | **$19.00** | 요청 353% · duration 255% (불가) |
| **B1. 방 100개 × 20명, 하루 8시간**, 10Hz·이동 50% | 800 | 11,059,200 | 90.7억 | 4.62억 | 69.30 | 137.50 | **$211.80** | — |
| B2. 같은 규모, 계속 이동(최악) | 800 | 11,059,200 | 177억 | 8.94억 | 134.10 | 137.50 | **$276.60** | — |
| B3. 같은 규모, 클라이언트 전송 5Hz·이동 50% | 800 | 11,059,200 | 47.5억 | 2.46억 | 36.90 | 137.50 | **$179.40** | — |
| B4. 같은 규모, 입력을 묶어 2Hz·이동 50% | 800 | 11,059,200 | 21.6억 | 1.17억 | 17.40 | 137.50 | **$159.90** | — |

- B의 duration $137.50은 Cloudflare 문서의 "Example 2"(DO 100개 × 하루 8시간)와 같은 값이다. [문서]
- A1은 숫자상 무료 플랜에 들어가지만 여유가 1.7배뿐이다. 한 번 공유돼 사람이 몰리면 그날 09:00(KST)까지 접속이 실패한다.
- 로비의 행 쓰기는 B에서도 월 480만 건으로 포함량(5,000만) 안이다.
- **Node 서버와의 비교**: 같은 B 규모(동시 2,000명)를 Node 프로세스로 돌릴 때의 비용은 이번에 재지 않았다(확인 못함). DO 쪽은 "방이 깨어 있는 시간"에 정비례하고 서버 관리·수평 확장이 필요 없다는 점, Node 쪽은 고정비라는 점이 구조적 차이다.

### 5.4 비용을 줄이는 손잡이 [추정]

1. **빈 방은 타이머를 지운다.** (예제에 들어 있음)
2. **자리 비움 정책.** 탭만 열어 둔 한 명이 방 하나를 한 달 내내 깨워 두면 $4.15다. N분간 입력이 없으면 내보내고 "다시 들어가기" 화면을 보여 준다.
3. **자동 배정은 붐비는 방부터 채운다.** 방-시간이 곧 비용이므로 사람을 흩뿌리지 않는다. (예제의 `pick()`)
4. **클라이언트 전송 빈도.** 10Hz → 5Hz면 B1에서 월 $32, 입력을 묶어 2Hz면 $52가 준다. 문서도 고빈도 데이터는 50~100ms 단위로 묶어 보내라고 권한다.
5. **한 DO에 방 여러 개.** duration은 DO 단위로 과금되므로 방 4개를 한 DO에 넣으면 그 값이 1/4이 된다. 대신 DO 하나의 권장 처리량(초당 요청 1,000건의 소프트 한도)에 가까워지고(방 4개 × 200건/초), 한 DO가 리셋되면 방 4개가 같이 끊긴다. 방 수가 수십 개를 넘을 때 검토한다.
6. **지출 한도·알림.** 2026-11-13부터 대시보드 Billing > Spend limits에서 Workers와 DO 각각 설정할 수 있다. 단 한도에 걸려도 **이미 열린 WebSocket의 메시지와 실행 중인 요청의 duration은 막지 못한다.** [문서]

---

## 6. SQLite 백엔드와 클래스 선언

- **무료 플랜은 SQLite 백엔드 DO만** 만들 수 있다. 유료 플랜도 2026-07-09부터, 기존에 KV 백엔드 네임스페이스가 없던 계정은 새 KV 백엔드를 만들 수 없다. 즉 새 프로젝트는 무조건 SQLite다. [문서]
- SQLite 백엔드에서 쓸 수 있는 저장소 API: `ctx.storage.sql.exec(query, ...bindings)`(동기), `ctx.storage.kv.get/put/delete/list`(동기 KV), 기존 비동기 KV, 알람, 30일 시점 복구(PITR). DO당 10GB(유료)/1GB(무료). [문서]

### 6.1 현재 방식: `exports` (2026-07-04 공개) [문서][스키마][실측-로컬]

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "ROOM", "class_name": "RoomDO" },
      { "name": "LOBBY", "class_name": "LobbyDO" }
    ]
  },
  "exports": {
    "RoomDO": { "type": "durable-object", "storage": "sqlite" },
    "LobbyDO": { "type": "durable-object", "storage": "sqlite" }
  }
}
```

- 태그(`v1`, `v2`…)가 없다. **현재의 `exports` 맵이 곧 진실**이고, 배포 때 Cloudflare가 "코드가 내보내는 클래스 / `exports` 선언 / 이미 만들어진 네임스페이스"를 비교한다.
- 코드에만 있고 `exports`에 없는 클래스는 무시된다(네임스페이스가 생기지 않는다).
- 삭제·이름 변경·이전은 `state`를 묘비 값으로 바꿔 선언한다: `"deleted"`, `"renamed"`(+`renamed_to`), `"transferred"`(+`transferred_to`), 받는 쪽은 `"expecting-transfer"`(+`transfer_from`). **`deleted`는 그 클래스의 모든 DO 데이터를 영구 삭제한다.**
- 저장소 종류는 한번 만들면 바꿀 수 없다.
- 클래스 수명 변경은 `wrangler deploy`로만 적용된다(`wrangler versions upload`는 실패). 점진 배포 불가. **수명 변경 이전 버전으로는 롤백할 수 없다.**

### 6.2 구 방식: `migrations` + `new_sqlite_classes` [문서][실측-로컬]

```jsonc
{ "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RoomDO", "LobbyDO"] }] }
```

- 문서 제목이 "Durable Object class migrations (legacy)"가 됐지만 "remains fully supported"라고 적혀 있고, WebSocket 문서의 예제는 아직 이 방식이다. 로컬에서도 그대로 동작했다.
- `new_classes`(KV 백엔드)는 쓰지 않는다.
- **한 설정에 `migrations`와 DO `exports`를 같이 두면 설정 오류**(§3.4-L). `exports`로 한 번 배포한 Worker는 `migrations`로 돌아갈 수 없다.
- `migrations` → `exports` 전환은 데이터 이전 없이 된다: `new_sqlite_classes`로 만든 클래스는 `"storage": "sqlite"`로 옮겨 적고 `migrations` 배열을 지운 뒤 배포.

**우리 선택: 새 프로젝트이므로 `exports`.**

---

## 7. wrangler 설정

- 파일 형식: `wrangler.jsonc`(권장), `wrangler.json`, `wrangler.toml` 모두 지원(Wrangler 3.91.0부터 JSON). 문서: "Cloudflare recommends using `wrangler.jsonc` for new projects, and some newer Wrangler features will only be available to projects using a JSON config file." [문서]
- `"$schema": "./node_modules/wrangler/config-schema.json"`을 넣으면 에디터 자동완성이 된다. [문서]
- **`compatibility_date`**: "프로젝트를 시작할 때 오늘 날짜로" 두고 가끔 올린다. 오래된 날짜도 계속 지원된다. 올릴 때는 compatibility flags 페이지에서 그 사이 기본값이 바뀐 플래그를 확인한다. [문서] 우리와 관련된 날짜:

| 날짜 | 바뀌는 것 |
|---|---|
| 2026-03-03 | `close()`의 reason이 UTF-8 123바이트를 넘으면 `SyntaxError` |
| 2026-03-17 | 표준 API `binaryType` 기본값 `"blob"` |
| 2026-04-07 | 표준 API에서 상대 Close에 자동 응답(`web_socket_auto_reply_to_close`) |
| 2026-08-04 | `nodejs_compat` 기본 활성(플래그 불필요) |
| 2026-10-01 | 대기 중 타이머·`waitUntil`·RPC가 DO 축출을 최대 15분 막음 |

- 설정 안의 경로(`main`, `assets.directory`)는 **설정 파일 위치 기준**이다. 저장소 루트에서 `wrangler -c worker/wrangler.jsonc deploy --dry-run`으로 확인. 다만 `wrangler types`의 출력 파일은 현재 작업 폴더 기준이라, 전부 `wrangler --cwd worker …`로 돌리는 편이 덜 헷갈린다. [실측-로컬]
- `vars`는 비밀이 아닌 값만. 비밀 이름은 `"secrets": { "required": ["SAVE_SECRET"] }`로 선언해 두면 누락 시 `wrangler deploy`가 실패하고, 로컬에서는 `.dev.vars`에서 그 키만 읽는다. [문서]
- 설정 파일이 "진실의 원천"이다. 대시보드에서 바꾼 `vars`는 다음 `wrangler deploy` 때 덮어써진다(`keep_vars: true`로 막을 수 있음). [스키마]
- `durable_objects.code_update_strategy`: `{ "mode": "deferred", "max_delay": 300 }`이 기본(§13-3). [문서][스키마]
- `limits.cpu_ms`: 호출당 CPU 한도(기본 30,000ms, 최대 300,000ms). 우리 틱은 건드릴 일이 없다. [문서]

---

## 8. 정적 클라이언트 서빙(Workers Static Assets)

- `"assets": { "directory": "../dist/client" }`만 넣으면 `wrangler deploy`가 그 폴더를 올린다. Worker 하나에 에셋 묶음 하나. [문서]
- **기본 라우팅: 에셋과 일치하면 에셋을 바로 서빙(Worker 호출 없음, 무료). 일치하지 않으면 Worker의 `fetch()` 호출.** 없는 에셋이 자동으로 404가 되는 것이 아니라 Worker가 응답을 정한다. [문서][실측-로컬]
- `run_worker_first`: `true`면 모든 요청이 Worker를 먼저 거친다. 배열이면 그 패턴만(`*` 글롭, `!` 부정 패턴, 최대 100개). 예제는 `["/ws", "/api/*"]`만 Worker 우선으로 둬서, 같은 이름의 파일이 생겨도 API가 가려지지 않게 했다. [문서]
  - 무료 플랜 주의: 이 패턴에 걸리는 요청은 항상 Worker를 호출하므로, 일일 요청 한도를 넘으면 에셋으로 넘어가지 않고 429가 난다. [문서]
- `not_found_handling`: `"none"`(기본) / `"404-page"` / `"single-page-application"`. SPA 모드는 일치하는 에셋이 없으면 `index.html`을 200으로 준다. **우리 게임은 클라이언트 라우팅이 없으므로 켜지 않는다.** 켜면 없는 JS 파일 요청에도 HTML이 200으로 나가 "MIME type text/html" 오류가 난다. [문서][실측-로컬]
- `html_handling`: 기본 `"auto-trailing-slash"`. `/` → `index.html`. [문서]
- 기본 응답 헤더: `Cache-Control: public, max-age=0, must-revalidate` + `ETag`. 해시가 붙은 파일을 오래 캐시하려면 에셋 폴더에 `_headers` 파일을 둔다(규칙 최대 100개). [문서][실측-로컬]

```
# client/public/_headers  (vite가 dist/client/_headers로 복사)
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

- `_headers`는 Worker가 만든 응답에는 적용되지 않는다. 반대로 `env.ASSETS.fetch()`가 돌려준 **404에는 위 규칙이 붙었다**(로컬). 그래서 예제는 없는 경로에 대해 Worker가 직접 `no-store` 404를 낸다. [문서][실측-로컬]
- 한도: 파일 수 20,000(무료)/100,000(유료), 파일당 25MiB. `.assetsignore`로 올리지 않을 파일 지정. [문서]
- Range 요청은 지원하지 않는다(206 대신 전체 200). 우리는 미디어 파일이 없어 무관. [문서]
- 배포 직후에는 HTML과 에셋이 서로 다른 버전에서 나올 수 있다(version skew). 구버전 HTML이 새 버전에 없는 해시 파일을 요청하면 404다. 클라이언트는 모듈 로드 실패 시 새로고침을 안내한다. [문서]

---

## 9. 라우팅: `/ws?room=N` → 방 DO, 싱글턴 로비 DO

- DO는 인터넷에서 직접 요청을 받지 못한다. Worker(또는 다른 DO)가 바인딩으로 스텁을 얻어 호출한다. [문서]
- **`env.ROOM.getByName("room-3")`** = `env.ROOM.get(env.ROOM.idFromName("room-3"))`. 같은 이름은 전 세계 어디서 불러도 같은 인스턴스다. 두 번째 인자로 `{ locationHint, retry }`를 받는다. [문서][스키마]
- 스텁의 `.fetch(request)`로 원래 요청을 넘기면 DO의 `fetch()`가 `101` + `webSocket`을 돌려주고, Worker는 그 응답을 그대로 반환한다. [문서][실측-로컬]
- **잘못된 요청은 Worker에서 거른다**(업그레이드 헤더, Origin, 방 번호). DO로 넘어간 요청은 과금된다. [문서]
- DO 안에서 **`this.ctx.id.name`** 이 `"room-3"`이다(`idFromName`/`getByName`으로 불렸을 때. `idFromString`이나 1,024바이트 넘는 이름은 `undefined`). 방 번호를 헤더로 따로 넘길 필요가 없다. 알람 핸들러 안에서는 2026-03-15 이후에 건 알람부터 값이 들어온다. [문서][실측-로컬]
- **위치.** DO는 첫 `get()`을 부른 곳 근처에 만들어지고 그 뒤로 옮겨지지 않는다(동적 재배치는 "계획"). 방 이름이 고정(`room-1`…)이라 처음 한 번 잘못 만들어지면 계속 그 자리다. CI나 해외 개발자가 먼저 건드릴 수 있으므로 `locationHint: "apac-ne"`를 준다. 힌트는 **첫 호출에만** 쓰이고 best effort다. 2026-06-19에 `apac-ne`(동북아: 일본·한국 등)와 `apac-se`가 추가됐다. 이미 엉뚱한 곳에 만들어졌다면 이름 체계를 바꿔(`room-v2-1`) 새로 만드는 수밖에 없다. [문서]
- **로비.** `env.LOBBY.getByName("lobby")` 하나. 메서드를 공개하면 그대로 RPC가 된다(`compatibility_date` ≥ 2024-04-03). RPC 호출 1번 = 요청 1건. [문서]
  - 방 → 로비: 인원이 바뀔 때 + 30초 하트비트로 `report(id, players, cap)`.
  - Worker → 로비: `/api/rooms`에서 `list()`, `room=auto`일 때 `pick()`.
  - 로비는 타이머·소켓이 없어 요청이 끊기면 곧 내려간다. 그래서 SQLite에 한 줄씩 저장하고 생성자에서 읽는다. 재시작 뒤에도 목록이 남는 것을 확인했다. [실측-로컬]
  - **방 DO가 리셋되면 "0명" 보고 없이 사라진다**(§3.4-J). 로비는 하트비트가 90초 넘게 끊긴 방을 0명으로 본다.
  - 문서의 아키텍처 지침은 "모든 요청이 한 DO를 지나가게 하지 말라"다. 예제에서 로비를 지나는 것은 자동 배정(`room=auto`) 1회·방 목록 조회·방의 보고뿐이고, 게임 메시지는 방 DO로 바로 간다. 방 목록 조회가 많아지면 Worker에서 1~2초 캐시한다. [문서][추정]
- 2026-11-05부터 DO 호출이 도달 전에 재시도 가능한 오류로 실패하면 런타임이 자동 재시도한다(기본 최대 4회, 10초 이내). 같은 메서드가 재시도로 두 번 실행되지는 않는다. [문서]

---

## 10. 예제 코드 (로컬 검증 완료)

아래 세 파일은 임시 폴더에 그대로 두고 `tsc --noEmit`(TypeScript 7.0.2) 통과, `wrangler --cwd worker deploy --dry-run`(번들 7.12 KiB, gzip 2.77 KiB) 통과, `wrangler --cwd worker dev`로 띄워 §3.4-K와 아래 항목을 확인한 것이다. [실측-로컬]

- `/` 200(`max-age=0`), `/assets/app-*.js` 200(`immutable`), 없는 파일 404(`no-store`), `/api/rooms` 200, 모르는 `/api/*` 404, 업그레이드 없는 `/ws` 426, `room=99` 거부
- `room=auto` 20명이 전부 1번 방으로, 21번째 `room=1`은 연결 24~28ms 만에 `{"t":"full"}` 수신과 `4001` clean close까지 완료, 그다음 `auto`는 2번 방으로
- 4,096바이트 초과 이진 프레임 → `1009` clean close(= 이진이 `ArrayBuffer`로 도착), 정상 종료 58/58 clean, 로비 인원 0으로 복귀

### 10.1 `worker/wrangler.jsonc`

```jsonc
{
	"$schema": "../node_modules/wrangler/config-schema.json",
	"name": "dowa-game",
	"main": "src/index.ts",
	// 관례: 프로젝트를 만든 날짜로 고정해 두고, 올릴 때는 compatibility flags 변경 내역을 읽고 테스트한다.
	"compatibility_date": "2026-11-23",
	"upload_source_maps": true,

	// 정적 클라이언트(vite build → dist/client). 경로는 이 설정 파일 기준.
	// 에셋과 일치하는 요청은 Worker 를 거치지 않고 무료로 서빙되고, 에셋에 없는 경로만 Worker 의 fetch() 로 온다.
	"assets": {
		"directory": "../dist/client",
		// 이 경로는 같은 이름의 파일이 있더라도 항상 Worker 가 먼저 받는다.
		"run_worker_first": ["/ws", "/api/*"]
	},

	"durable_objects": {
		"bindings": [
			{ "name": "ROOM", "class_name": "RoomDO" },
			{ "name": "LOBBY", "class_name": "LobbyDO" }
		]
		// 생략하면 { "mode": "deferred", "max_delay": 300 }: 배포 후 최대 5분 안에 깨어 있는 방이 재시작된다.
	},

	// 클래스 선언(2026-07~). SQLite 백엔드만 새로 만들 수 있다.
	// 구 방식으로 쓰려면 이 블록 대신: "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RoomDO", "LobbyDO"] }]
	"exports": {
		"RoomDO": { "type": "durable-object", "storage": "sqlite" },
		"LobbyDO": { "type": "durable-object", "storage": "sqlite" }
	},

	// 비밀이 아닌 설정만. 비밀은 wrangler secret put / --secrets-file 로.
	"vars": {
		"ROOM_COUNT": "3",
		"ROOM_CAPACITY": "20",
		"ALLOWED_ORIGINS": ""
	},
	"secrets": { "required": ["SAVE_SECRET"] },

	// WebSocket 메시지 하나하나가 '호출 로그'가 되지 않게 한다(로그 과금 방지). console.* 와 예외는 그대로 남는다.
	"observability": { "enabled": true, "logs": { "invocation_logs": false } }
}
```

### 10.2 `worker/src/index.ts`

`// this.room.…` 주석 자리에 `server/core`의 `Room`을 끼운다. 예제는 그 자리에 12바이트 가짜 스냅샷을 보낸다.

```ts
import { DurableObject } from "cloudflare:workers";

const TICK_MS = 100; // 10Hz
const LOBBY_HEARTBEAT_MS = 30_000;
const CLOSE_FULL = 4001;
/** DO 는 한번 만들어지면 위치가 바뀌지 않는다. 첫 get() 때만 쓰이는 힌트(best effort). "apac-ne" = 동북아(한국·일본). */
const LOCATION_HINT: DurableObjectLocationHint = "apac-ne";

export interface RoomInfo {
	id: string;
	players: number;
	cap: number;
	/** 마지막 보고 시각(ms) */
	at: number;
}

// ───────────────────────── Worker: 상태 없는 라우터 ─────────────────────────

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/rooms") {
			return Response.json({ rooms: await lobby(env).list() }, { headers: { "cache-control": "no-store" } });
		}

		if (url.pathname === "/ws") {
			// DO 로 넘긴 요청은 과금된다. 잘못된 요청은 여기서 걸러 낸다.
			if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}
			if (!originAllowed(request, env)) return new Response("Forbidden origin", { status: 403 });

			const roomCount = Number(env.ROOM_COUNT) || 3;
			let room = url.searchParams.get("room") ?? "auto";
			if (room === "auto") room = await lobby(env).pick(roomCount, Number(env.ROOM_CAPACITY) || 20);
			const n = Number(room);
			if (!Number.isInteger(n) || n < 1 || n > roomCount) return new Response("Bad room", { status: 400 });

			// 같은 이름 → 전 세계에서 항상 같은 DO 인스턴스. getByName(x) 는 get(idFromName(x)) 의 축약형.
			return env.ROOM.getByName(`room-${n}`, { locationHint: LOCATION_HINT }).fetch(request);
		}

		if (url.pathname.startsWith("/api/")) return Response.json({ error: "not_found" }, { status: 404 });

		// 에셋과 일치하는 요청은 Worker 까지 오지 않는다. 여기까지 왔으면 없는 경로다.
		// (env.ASSETS.fetch 로 넘기면 _headers 의 캐시 규칙이 404 응답에도 붙는다 → 직접 no-store 404 를 낸다)
		return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
	},
} satisfies ExportedHandler<Env>;

function lobby(env: Env) {
	return env.LOBBY.getByName("lobby", { locationHint: LOCATION_HINT });
}

function originAllowed(request: Request, env: Env): boolean {
	const allow = String(env.ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (allow.length === 0) return true;
	const origin = request.headers.get("Origin");
	return origin !== null && allow.includes(origin);
}

// ───────────────────────── RoomDO: 방 하나 = DO 하나 ─────────────────────────

export class RoomDO extends DurableObject<Env> {
	/** "room-3" 으로 불렸으면 "3" */
	private readonly roomId: string;
	private readonly cap: number;
	private conns = new Map<number, WebSocket>();
	private nextConn = 1;
	private tickNo = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nextTickAt = 0;
	private lastLobbyReport = 0;
	private lastReported = -1;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// 생성자는 인스턴스가 메모리에 올라올 때마다 다시 돈다(비워져서 내려간 뒤, 배포 뒤, 런타임 업데이트 뒤).
		this.roomId = (ctx.id.name ?? "").replace(/^room-/, "");
		this.cap = Number(env.ROOM_CAPACITY) || 20;
		// 여기서 코어를 만든다: this.room = new Room(host, { id: this.roomId, capacity: this.cap, ... })
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// compatibility_date >= 2026-03-17 부터 기본값이 "blob" 이다. accept() 전에 바꾼다.
		server.binaryType = "arraybuffer";
		server.accept();

		if (this.conns.size >= this.cap) {
			// 브라우저는 업그레이드 실패(HTTP 4xx)의 사유를 읽지 못한다 → 일단 받아 주고, 사유를 보낸 뒤 닫는다.
			server.send(JSON.stringify({ t: "full" }));
			server.close(CLOSE_FULL, "full");
			return new Response(null, { status: 101, webSocket: client });
		}

		const conn = this.nextConn++;
		this.conns.set(conn, server);
		server.addEventListener("message", (ev: MessageEvent) => {
			const data: unknown = ev.data;
			if (typeof data === "string") this.onMessage(conn, server, data);
			else if (data instanceof ArrayBuffer) this.onMessage(conn, server, new Uint8Array(data));
		});
		// compatibility_date >= 2026-04-07: 상대가 보낸 Close 에 런타임이 알아서 응답한다(여기서 close() 불필요).
		server.addEventListener("close", () => this.drop(conn));
		server.addEventListener("error", () => this.drop(conn));

		server.send(JSON.stringify({ t: "welcome", conn, room: this.roomId, tick: this.tickNo })); // this.room.connect(conn)
		this.startLoop();
		this.reportToLobby(true);
		return new Response(null, { status: 101, webSocket: client });
	}

	private onMessage(conn: number, ws: WebSocket, data: string | Uint8Array): void {
		if (data.length > 4096) return ws.close(1009, "too big");
		if (data === "ping") return ws.send("pong");
		// this.room.message(conn, data)
	}

	private drop(conn: number): void {
		if (!this.conns.delete(conn)) return;
		// this.room.disconnect(conn)
		this.reportToLobby(true);
		// 타이머가 하나라도 남아 있으면 DO 가 메모리에서 내려가지 못하고 계속 과금된다.
		if (this.conns.size === 0) this.stopLoop();
	}

	// ── 10Hz 루프: setTimeout 을 매번 다시 거는 방식 + 밀림 보정 ──
	private startLoop(): void {
		if (this.timer !== null) return;
		this.nextTickAt = Date.now() + TICK_MS;
		this.timer = setTimeout(this.onTimer, TICK_MS);
	}

	private stopLoop(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	private onTimer = (): void => {
		this.timer = null;
		if (this.conns.size === 0) return;
		const now = Date.now();
		let steps = 0;
		while (now >= this.nextTickAt && steps < 5) {
			try {
				this.tick(now);
			} catch (e) {
				console.error("tick failed", e); // 예외로 루프가 끊기면 방이 조용히 멈춘다 → 반드시 잡는다.
			}
			this.nextTickAt += TICK_MS;
			steps++;
		}
		if (now >= this.nextTickAt) this.nextTickAt = now + TICK_MS; // 5틱 넘게 밀렸으면 따라잡기를 포기
		this.timer = setTimeout(this.onTimer, Math.max(1, this.nextTickAt - Date.now()));
	};

	private tick(now: number): void {
		this.tickNo++;
		// this.room.tick() 이 host.send(conn, snapshot) 을 부른다. 아래는 그 자리의 흉내.
		const snap = new Uint8Array(12);
		const dv = new DataView(snap.buffer);
		dv.setUint32(0, this.tickNo);
		dv.setFloat64(4, now);
		for (const [conn, ws] of this.conns) {
			try {
				ws.send(snap); // 나가는 메시지는 과금되지 않는다.
			} catch {
				this.drop(conn); // Close 를 이미 보낸 소켓에 send() 하면 TypeError
			}
		}
		if (now - this.lastLobbyReport > LOBBY_HEARTBEAT_MS) this.reportToLobby(false);
	}

	private reportToLobby(onlyIfChanged: boolean): void {
		if (!this.roomId) return;
		const players = this.conns.size;
		if (onlyIfChanged && players === this.lastReported) return;
		this.lastReported = players;
		this.lastLobbyReport = Date.now();
		// RPC 호출 1번 = DO 요청 1건. 인원이 바뀔 때와 30초 하트비트만 보낸다.
		this.ctx.waitUntil(
			lobby(this.env)
				.report(this.roomId, players, this.cap)
				.catch((e: unknown) => console.warn("lobby report failed", e)),
		);
	}
}

// ───────────────────────── LobbyDO: 싱글턴(이름 "lobby") ─────────────────────────

export class LobbyDO extends DurableObject<Env> {
	private rooms = new Map<string, RoomInfo>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// 타이머도 소켓도 없어서 요청이 끊기면 곧 메모리에서 내려간다 → 다음 요청 때 SQLite 에서 복원(동기 API).
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, players INTEGER NOT NULL, cap INTEGER NOT NULL, at INTEGER NOT NULL)",
		);
		const rows = ctx.storage.sql.exec<{ id: string; players: number; cap: number; at: number }>(
			"SELECT id, players, cap, at FROM rooms",
		);
		for (const r of rows) this.rooms.set(r.id, { id: r.id, players: r.players, cap: r.cap, at: r.at });
	}

	/** RoomDO → Lobby. 공개 메서드는 그대로 RPC 로 노출된다. */
	report(id: string, players: number, cap: number): void {
		const info: RoomInfo = { id, players, cap, at: Date.now() };
		this.rooms.set(id, info);
		this.ctx.storage.sql.exec(
			"INSERT INTO rooms (id, players, cap, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET players = excluded.players, cap = excluded.cap, at = excluded.at",
			id,
			players,
			cap,
			info.at,
		);
	}

	/** Worker → Lobby */
	list(): RoomInfo[] {
		const now = Date.now();
		return [...this.rooms.values()]
			// 방 DO 가 배포·재시작으로 통째로 리셋되면 "0명" 보고 없이 사라진다 → 하트비트가 3번 넘게 끊긴 방은 0명으로 본다.
			.map((r) => (now - r.at > LOBBY_HEARTBEAT_MS * 3 ? { ...r, players: 0 } : r))
			.sort((a, b) => Number(a.id) - Number(b.id));
	}

	/** 자동 배정: 가득 차지 않은 방 중 가장 붐비는 방. 전부 비었으면 1번. */
	pick(roomCount: number, cap: number): string {
		const live = new Map(this.list().map((r) => [r.id, r.players]));
		let best = "1";
		let bestN = -1;
		for (let i = 1; i <= roomCount; i++) {
			const n = live.get(String(i)) ?? 0;
			if (n < cap && n > bestN) {
				best = String(i);
				bestN = n;
			}
		}
		return best;
	}
}
```

### 10.3 `worker/tsconfig.json`, `.dev.vars`, 스크립트

```jsonc
// worker/tsconfig.json
{
	"compilerOptions": {
		"target": "es2022",
		"module": "es2022",
		"moduleResolution": "bundler",
		"lib": ["es2022"],
		// worker-configuration.d.ts 는 `wrangler types` 가 만든다(Env + 런타임 타입, 약 640KB). node 는 node:crypto 를 쓸 때만.
		"types": ["./worker-configuration.d.ts", "node"],
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true,
		"isolatedModules": true
	},
	"include": ["src/**/*.ts", "worker-configuration.d.ts"]
}
```

```bash
# worker/.dev.vars  (로컬 전용. git 에 올리지 않는다. 설정 파일과 같은 폴더)
SAVE_SECRET="dev-only-secret-0123456789"
```

```jsonc
// package.json 에 더할 스크립트(제안)
"cf:types":  "wrangler --cwd worker types",
"cf:dev":    "npm run build:client && wrangler --cwd worker dev",
"cf:check":  "wrangler --cwd worker types && tsc -p worker/tsconfig.json && wrangler --cwd worker deploy --dry-run",
"cf:deploy": "npm run build:client && wrangler --cwd worker deploy"
```

- `wrangler types`는 `Env`를 설정에서 만들어 준다(`ROOM: DurableObjectNamespace<import("./src/index").RoomDO>` 등). 설정을 바꾸면 다시 돌린다. `@cloudflare/workers-types`는 필요 없다. [문서][실측-로컬]
- wrangler가 esbuild로 번들하므로 `../../server/core/...`, `../../shared/...` 상대 import를 그대로 쓸 수 있다(`tsconfig`의 `include`에 그 경로를 더한다). 이 조합 자체는 이번에 돌려 보지 않았다.

### 10.4 Hibernation API 변형(대안, 로컬 검증 완료)

달라지는 부분만 발췌했다. 검증할 때는 두 방식을 한 Worker에 나란히 올리려고 §10.2 `RoomDO`의 `conns`·`drop()`·틱 루프·로비 보고를 공통 부모 `RoomBase`로 뽑았고, `onText`/`onBinary`는 §10.2의 `onMessage`에 해당한다. 이 변형으로 정원 초과·1009·정상 종료·프로세스 kill을 확인했다(§3.4의 A~I는 같은 API를 쓰는 별도 실험 코드의 결과).

```ts
/** 연결마다 붙여 두는 값(직렬화 후 최대 16,384바이트). 동면에서 깨어나도 소켓과 함께 남아 있다. */
interface Attachment {
	conn: number;
}

export class RoomHibDO extends RoomBase /* 틱 루프·로비 보고는 RoomDO 와 같음 */ {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// 동면에서 깨어났다면 소켓은 붙어 있는데 메모리(방 상태)는 비어 있다 → 연결 표를 다시 만든다.
		for (const ws of this.ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as Attachment | null;
			if (!att) continue;
			this.conns.set(att.conn, ws);
			this.nextConn = Math.max(this.nextConn, att.conn + 1);
		}
		if (this.conns.size > 0) this.startLoop();
	}

	async fetch(request: Request): Promise<Response> {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// accept() 대신 ctx.acceptWebSocket(). 메시지는 아래 webSocketMessage() 로 온다.
		this.ctx.acceptWebSocket(server);

		if (this.conns.size >= this.cap) {
			server.send(JSON.stringify({ t: "full" }));
			// 주의(로컬 실측): 핸들러 밖(fetch·타이머)에서 close() 하면 클라이언트의 close 이벤트가 한참 늦게 온다.
			// → 클라이언트는 "full"/"kick" 메시지를 받는 즉시 스스로 닫아야 한다.
			server.close(CLOSE_FULL, "full");
			return new Response(null, { status: 101, webSocket: client });
		}

		const conn = this.nextConn++;
		server.serializeAttachment({ conn } satisfies Attachment);
		this.conns.set(conn, server);
		this.startLoop();
		this.reportToLobby(true);
		return new Response(null, { status: 101, webSocket: client });
	}

	// 이진 프레임은 compatibility_date 와 무관하게 항상 ArrayBuffer 로 온다.
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const att = ws.deserializeAttachment() as Attachment | null;
		if (!att) return;
		if (typeof message === "string") this.onText(att.conn, ws, message);
		else this.onBinary(att.conn, ws, message);
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		// Hibernation API 에서는 닫기 핸드셰이크에 "직접" 응답해야 한다(안 하면 클라이언트 close 가 10초 뒤 1006 으로 온다).
		// 1005/1006 같은 코드는 보낼 수 없으므로(InvalidAccessError) 걸러 낸다.
		try {
			if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason);
			else ws.close();
		} catch {
			/* 이미 닫힘 */
		}
		const att = ws.deserializeAttachment() as Attachment | null;
		if (att) this.drop(att.conn);
	}

	webSocketError(ws: WebSocket): void {
		const att = ws.deserializeAttachment() as Attachment | null;
		if (att) this.drop(att.conn);
	}
}
```

---

## 11. HMAC: `node:crypto`와 WebCrypto

- **WebCrypto(`crypto.subtle`)는 플래그 없이 항상 쓸 수 있다.** 비동기다. [문서]
- **`node:crypto`는 `nodejs_compat`이 켜져 있어야 하는데, `compatibility_date` ≥ 2026-08-04이면 기본으로 켜진다**(그 전 날짜는 `"compatibility_flags": ["nodejs_compat"]`). 문서상 `node:crypto` API는 "fully supported"이고 예외는 DSA/DH 키쌍 생성, `argon2`, `randomUUIDv7`, `ed448`/`x448`, FIPS 전환뿐이다. [문서]
- `compatibility_date` 2026-11-23에서 플래그 없이 두 방식을 같은 키·데이터로 돌려 **같은 값**(`6WfwvUkQPe_TtUAm13or3VRKBn1UL9V7tp-pthR8sXA`)을 얻었고, 실제 Node 22의 `node:crypto` 결과와도 같았다. Node 서버에서 서명한 저장본을 Workers에서 검증할 수 있다는 뜻이다(비밀 값과 인코딩이 같다면). 아래 `verify()`(`timingSafeEqual` + `Buffer`)도 workerd에서 실행해 맞는 서명은 `true`, 틀린 서명은 `false`를 확인했다. `node:crypto`를 import해도 번들은 9.36 KiB였다(런타임 내장이라 폴리필이 붙지 않음). 타입은 `@types/node`가 필요하다. [실측-로컬]

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

// 동기. Node 어댑터와 Workers 어댑터가 같은 코드를 쓸 수 있다.
export function sign(secret: string, data: string): string {
	return createHmac("sha256", secret).update(data).digest("base64url");
}
export function verify(secret: string, data: string, sig: string): boolean {
	const a = Buffer.from(sign(secret, data));
	const b = Buffer.from(sig);
	return a.length === b.length && timingSafeEqual(a, b);
}

// WebCrypto 판(비동기)
export async function signWeb(secret: string, data: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
	let s = "";
	for (const b of sig) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

우리 코어의 `SaveSigner`는 동기 인터페이스이고 `server/core`는 `node:*`를 import할 수 없다. 지금의 순수 JS 구현을 그대로 둬도 되고, 어댑터 쪽에서 위 `node:crypto` 판을 `RoomHost.signer`로 넘겨도 된다. 어느 쪽이든 출력 인코딩(hex/base64url)은 기존 저장본과 맞춘다.

---

## 12. 로컬 개발

- `wrangler dev`는 기본이 **로컬 실행**(Miniflare + `workerd`)이고 `localhost:8787`에서 듣는다. DO, 정적 에셋, SQLite 저장소, RPC, 알람이 로컬에서 동작한다. [문서][실측-로컬]
- 저장소의 Vite 설정은 `/ws`와 `/api`를 `localhost:8787`로 프록시한다. 따라서 **Node 서버 대신 `wrangler --cwd worker dev`를 띄우면 `npm run dev:client`가 그대로 붙는다.** (이 조합은 직접 돌려 보지 않았다. 포트와 경로가 같다는 것만 확인.)
- 소스·설정을 고치면 자동으로 다시 올라가고, **그때 DO가 전부 리셋되어 연결이 `1006`으로 끊긴다**(§3.4-J). 배포 때 벌어질 일을 로컬에서 흉내 낼 수 있다. [실측-로컬]
- 로컬 저장소는 `.wrangler/state`(바꾸려면 `--persist-to`). `.gitignore`에 `.wrangler/`와 `.dev.vars*`를 넣는다. [스키마][문서]
- 비밀은 설정 파일과 같은 폴더의 `.dev.vars`(또는 `.env`, 둘 중 하나만). [문서]
- Hibernation도 로컬에서 실제로 일어난다(§3.4-A). [실측-로컬]
- **로컬과 프로덕션이 다른 점**
  - `Date.now()`/`performance.now()`: 프로덕션은 Spectre 대응으로 "마지막 I/O 시각"에 고정되고 코드 실행 중에는 흐르지 않는다. 로컬에서는 흘렀다(§3.4-H). **틱 한 번의 CPU 시간을 `Date.now()` 차이로 재는 코드는 프로덕션에서 0이 나온다.** [문서][실측-로컬]
  - 모듈 최상위(전역 스코프)에서 부른 `Date.now()`는 로컬에서 `0`이었다. 시각·난수는 핸들러 안에서 얻는다. [실측-로컬]
  - 위치 힌트, 축출 정책, 과금, 다른 DO와의 isolate 공유는 로컬에서 재현되지 않는다. [추정]
- `wrangler dev --remote`는 "Legacy"로 표시돼 있다. 쓰지 않는다. [문서]
- 번들 크기·시작 시간 확인: `wrangler deploy --dry-run --outdir <폴더>`. [문서][실측-로컬]

---

## 13. 함정 목록

**과금·수명**

1. **타이머가 남아 있으면 동면도 과금 정지도 없다.** 방이 비면 반드시 `clearTimeout`. 문서대로라면(2026-10-01 이후) 남은 타이머는 DO 축출을 작업당 최대 15분 막고, 타이머를 계속 다시 걸면 그 시간이 계속 늘어난다. 그동안은 전부 청구된다. 로컬에서는 소켓 없는 DO가 타이머와 함께 1~2분 만에 사라졌지만(§3.4-M) 그것에 기대지 않는다. [문서][실측-로컬]
2. **자리 비운 한 명이 방 하나를 깨워 둔다.** 4초 ping이 계속 오므로 서버의 무응답 타임아웃에도 걸리지 않는다. 입력 기준의 자리 비움 정책이 따로 필요하다. [추정]
3. **배포 = 방 리셋.** 깨어 있는 DO는 기본 `deferred` 전략으로 최대 300초(설정 0~86,400초) 기다렸다가 리셋되고 WebSocket이 끊긴다. 틱이 도는 방은 동면하지 않으므로 항상 `max_delay`에 걸린다. `--durable-objects-code-update-mode immediate`면 즉시. 한 번의 배포에만 적용할 수도 있다. `wrangler secret put`도 새 버전을 만들어 바로 배포한다. Cloudflare 런타임 업데이트 때도 끊긴다(문서: "clients should continue to reconnect"). 종료 훅은 없다. [문서]
4. **방이 리셋되면 로비에 유령 인원이 남는다.** 하트비트 TTL로 처리(예제). [실측-로컬]
5. **알람으로 틱을 만들지 않는다**(§3.3).
6. **무료 플랜 한도 초과 = 오류.** UTC 00:00에 리셋. `run_worker_first` 경로는 Worker 일일 한도를 넘으면 429. [문서]
7. **지출 한도는 이미 열린 WebSocket의 메시지를 막지 못한다.** 상한이 아니라 알림·브레이크로 쓴다. [문서]
8. **로그 과금.** Workers Logs는 호출마다 "invocation log"를 남기고, 그 대상 목록에 WebSocket 이벤트가 있다. 월 수십억 메시지가 로그가 되지 않게 `observability.logs.invocation_logs: false`(또는 `head_sampling_rate`)를 건다. 틱 안에서 `console.log`를 찍지 않는다. WebSocket 메시지 하나가 실제로 로그 한 건이 되는지는 배포해서 확인해야 한다(확인 못함). [문서]

**WebSocket**

9. **(Hibernation) `webSocketClose`에서 `ws.close()`를 불러야 한다.** DO base class 문서는 "2026-04-07 이후에는 부를 필요 없다"고 적지만, Workers WebSockets 문서는 "hibernatable WebSocket은 플래그가 켜져 있어도 응답해야 한다"고 적는다. 로컬 실측은 후자와 일치했다(안 부르면 10초 뒤 `1006`). 타이머가 도는 DO에서는 응답하지 않은 소켓이 남아 DO가 축출되지 않았다(§3.4-O) = 과금이 이어진다. [문서][실측-로컬]
10. **(Hibernation) 핸들러 밖에서 서버가 `close()`하면 클라이언트 종료가 늦거나 오지 않는다**(§3.4-I). [실측-로컬]
11. **받은 종료 코드를 그대로 `close()`에 넘기지 않는다.** `1005`, `1006`, `1015`, `1004`는 보낼 수 없어 `InvalidAccessError`. reason을 주려면 code도 줘야 한다. 앱 코드는 4000~4999. [문서][실측-로컬]
12. **종료 사유는 UTF-8 123바이트까지.** 한글 41자. 넘으면 예외다. 사유는 짧은 영문 코드로 보내고 문구는 클라이언트가 고른다. [문서][실측-로컬]
13. **(표준) 이진 프레임 기본이 `Blob`.** `accept()` 전에 `binaryType = "arraybuffer"`. [문서][실측-로컬]
14. **Close를 보낸 소켓에 `send()`하면 `TypeError`.** 방송 루프는 `try/catch`. 연결이 끊긴 뒤의 `send()`는 예외 없이 버려질 수도 있다(성공 ≠ 전달). [문서]
15. **수신 메시지 최대 32MiB.** 그보다 훨씬 작은 앱 한도(4,096바이트)는 직접 검사한다. [문서]
16. **업그레이드 실패 사유는 브라우저가 읽지 못한다.** "가득 참"은 연결을 받아 준 뒤 메시지로 알리고 닫는다. [추정]
17. **`wrangler tail`은 WebSocket으로 업그레이드된 요청의 로그를 소켓이 닫힐 때까지 미룬다.** 트래픽이 많은 Worker에는 붙이지 말라고 문서가 적는다. [문서]

**DO 일반**

18. **메모리 상태는 언제든 사라진다.** 방이 비었을 때, 배포, 런타임 업데이트, 호스트 이동, 예외. 생성자는 그때마다 다시 돈다. [문서]
19. **128MB는 isolate 단위이고, 같은 클래스의 여러 DO가 한 isolate를 나눠 쓸 수 있다.** 과금은 각자 128MB로 한다. 한 방의 긴 동기 작업이 같은 isolate의 다른 방을 늦춘다. 틱은 짧게, `await` 없이. [문서]
20. **DO 하나의 소프트 한도는 초당 요청 1,000건.** 방 하나는 20명 × 10Hz = 200건/초. 넘치면 호출자에게 "overloaded" 오류가 간다. 팬아웃(나가는 메시지)은 따로 부하 테스트하라고 문서가 적는다. [문서]
21. **DO 위치는 고정.** 첫 호출에 `locationHint`. 잘못 만들어지면 이름을 바꿔 새로 만든다(§9). [문서]
22. **`exports`와 `migrations` 혼용 불가, `exports`에서 되돌아갈 수 없음, `deleted`는 데이터 영구 삭제, 수명 변경 전 버전으로 롤백 불가**(§6). [문서]
23. **Worker와 DO의 코드 버전이 잠깐 어긋날 수 있다.** 배포는 전 세계에 점진적으로 퍼지고, 깨어 있는 DO는 이전 코드로 남는다. Worker ↔ DO, 방 ↔ 로비 사이 RPC 시그니처는 앞뒤 호환되게 바꾼다. [문서]
24. **DO 버전 URL이 없다.** DO를 구현한 Worker에는 Version URL이 생성되지 않는다. [문서]

**설정·도구**

25. **wrangler 4.168.0은 Node ≥ 22.12.** CI 이미지와 `engines`를 맞춘다. [npm]
26. **`workers.dev` 주소는 Browser Integrity Check 대상이고 끌 수 없다.** 기본 라이브러리 User-Agent를 쓰는 자동 클라이언트는 Worker에 닿기 전에 오류 1010을 받을 수 있다. 부하 테스트 봇은 User-Agent를 명시한다. 문서는 프로덕션을 `workers.dev`가 아닌 커스텀 도메인에 두라고 권한다. [문서]
27. **`_headers` 규칙이 에셋 바인딩의 404에도 붙었다**(§8). [실측-로컬]
28. **SPA 모드를 켜지 않는다**(§8).
29. **`wrangler types`의 출력 위치는 현재 폴더 기준**, 나머지 경로는 설정 파일 기준. `--cwd worker`로 통일. [실측-로컬]
30. **대시보드에서 고친 `vars`는 다음 배포 때 덮어써진다.** [스키마]
31. **`Date.now()`는 프로덕션에서 코드 실행 중 흐르지 않는다**(§12).

---

## 14. 한도 정리

| 항목 | 값 | 근거 |
|---|---|---|
| DO당 WebSocket 연결 | Hibernation API 32,768. 표준 API는 숫자 없음(CPU·메모리가 실질 한도) | [문서] |
| DO당 처리량 | 초당 요청 1,000건 소프트 한도 | [문서] |
| 호출당 CPU | 기본 30초(HTTP 요청·WebSocket 메시지·알람 각각), `limits.cpu_ms`로 최대 5분. 들어오는 요청·메시지마다 30초로 다시 채워지고, 그 사이(타이머 콜백 포함)에 쓴 CPU가 30초를 넘으면 DO가 리셋될 가능성이 커진다 | [문서] |
| 메모리 | isolate당 128MB(JS 힙 + Wasm) | [문서] |
| WebSocket 수신 메시지 | 32MiB. 넘으면 `1009`로 닫힘 | [문서] |
| attachment | 직렬화 후 16,384바이트 | [문서] |
| 태그 | 소켓당 10개, 각 256자 | [문서] |
| auto-response 문자열 | 요청·응답 각 2,048자 | [문서] |
| 알람 | DO당 1개, 핸들러 벽시계 15분 | [문서] |
| DO 저장소 | DO당 10GB(유료)/1GB(무료), 계정 합계 무제한(유료)/5GB(무료) | [문서] |
| DO 클래스 수 | 계정당 500(유료)/100(무료) | [문서] |
| DO 개수 | 무제한 | [문서] |
| 동시 외부 연결 | 호출당 6개(응답 헤더 대기 중인 것) | [문서] |
| Worker 요청 | 무료 100,000/일 | [문서] |
| Worker CPU | 무료 10ms/호출, 유료 기본 30초·최대 5분 | [문서] |
| 서브요청 | 무료 50/호출, 유료 10,000/호출 | [문서] |
| Worker 크기 | 64MiB(비압축), 시작 시간 1초 | [문서] |
| 정적 에셋 | 20,000개(무료)/100,000개(유료), 파일당 25MiB | [문서] |
| 환경 변수 | 64개(무료)/128개(유료), 값 5KB | [문서] |

무료 플랜에서 DO 호출의 CPU 한도가 10ms인지 30초인지는 문서가 엇갈린다(§16).

---

## 15. 배포 가이드 개요

**계정 배포는 이번에 해 보지 못했다.** 명령과 순서는 문서 기준이고, 로컬에서 실제로 돌려 본 것은 4~8단계다.

### 15.1 준비

1. Cloudflare 계정을 만든다(가입만으로 Workers 무료 플랜).
2. Node 22.12 이상.
3. 저장소에 wrangler를 개발 의존성으로 넣는다: `npm i -D wrangler@4.168.0`. 전역 설치는 문서가 권하지 않는다.
4. `worker/wrangler.jsonc`, `worker/src/index.ts`, `worker/tsconfig.json`, `worker/.dev.vars`를 만든다(§10). `.gitignore`에 `.wrangler/`, `.dev.vars*`, `worker/worker-configuration.d.ts`(생성물로 둘 경우)를 넣는다.

### 15.2 로컬 확인

5. `npm run build:client` → `dist/client` 생성.
6. `npx wrangler --cwd worker types` → `worker/worker-configuration.d.ts` 생성. `npx tsc -p worker/tsconfig.json`.
7. `npx wrangler --cwd worker dev` → `http://localhost:8787`. 브라우저 두 개로 같은 방에 들어가 본다.
8. `npx wrangler --cwd worker deploy --dry-run` → 번들 크기와 바인딩 목록 확인.

### 15.3 첫 배포

9. `npx wrangler login` → 브라우저에서 승인. `npx wrangler whoami`로 계정 확인.
10. 대시보드 **Workers & Pages**에서 `workers.dev` 서브도메인을 정한다(주소는 `<worker 이름>.<서브도메인>.workers.dev`).
11. 첫 배포는 코드와 비밀을 한 번에 올린다(문서의 "Upload secrets alongside code"). 비밀 파일은 JSON 또는 `.env` 형식이고 git에 올리지 않는다.
    ```sh
    npm run build:client
    npx wrangler --cwd worker deploy --secrets-file ../.env.production   # 안에 SAVE_SECRET=...
    ```
    처음 배포할 때 `exports`에 적은 두 클래스의 네임스페이스가 만들어지고, 문서대로라면 출력에 `Durable Object exports reconciliation: Created: …`가 나온다.
12. 그 뒤의 배포는 `npm run build:client && npx wrangler --cwd worker deploy`. 파일에 없는 비밀은 이전 버전 값이 유지된다. 비밀만 바꾸려면 `npx wrangler --cwd worker secret put SAVE_SECRET`(새 버전을 만들어 바로 배포한다 = 방이 끊긴다).
    - `secrets.required`를 선언한 채로 "Worker가 아직 없을 때 `secret put`부터 하는" 순서가 되는지는 확인 못함. 그래서 11단계를 `--secrets-file`로 적었다.
13. 확인: `https://<이름>.<서브도메인>.workers.dev/` 접속, `/api/rooms` 응답, 브라우저 두 개로 같은 방.
14. 한국에서 어느 데이터센터에 붙는지 본다. Worker에서 `request.cf.colo`(요청이 닿은 데이터센터의 IATA 코드)와 `request.cf.clientTcpRtt`를 읽어 돌려주는 디버그 엔드포인트를 하나 두고, 통신사별(KT·SKT·LG U+)로 한 번씩 열어 본다. 방 DO까지의 왕복은 게임의 ping/pong 지연으로 본다.

### 15.4 유료 전환과 안전장치

15. 대시보드에서 **Workers Paid**($5/월)를 켠다. 출시 전에 한다.
16. **Billing > Spend limits**에서 Durable Objects와 Workers 각각 알림 이메일과 한도를 건다.
17. 커스텀 도메인: 도메인을 Cloudflare에 올린 뒤 설정에 추가하고 다시 배포.
    ```jsonc
    "routes": [{ "pattern": "play.example.com", "custom_domain": true }]
    ```
    클라이언트의 서버 주소와 `ALLOWED_ORIGINS`를 그 도메인으로 맞춘다.

### 15.5 운영

18. 로그: 대시보드의 Workers Logs, 또는 `npx wrangler --cwd worker tail`(WebSocket 요청 로그는 소켓이 닫힌 뒤에 나온다).
19. **배포하면 5분 안에 모든 방이 끊긴다.** 한가한 시간에 배포하고, 클라이언트는 `1006`을 "서버 점검 중, 다시 연결"로 처리한다. 급한 수정은 `npx wrangler --cwd worker deploy --durable-objects-code-update-mode immediate`.
20. 롤백: `npx wrangler --cwd worker rollback`. `exports`를 바꾼 배포 이전으로는 못 돌아간다.
21. 방 수 늘리기: `vars.ROOM_COUNT`를 올리고 배포. DO는 처음 접속될 때 만들어진다.
22. CI: GitHub Actions는 공식 `cloudflare/wrangler-action`. 저장소 시크릿에 `CLOUDFLARE_API_TOKEN`(대시보드 Account API tokens에서 "Edit Cloudflare Workers" 템플릿으로 생성)과 `CLOUDFLARE_ACCOUNT_ID`. 또는 대시보드의 Workers Builds로 GitHub 저장소를 연결한다.
23. 배포 뒤 부하 테스트: `tools/loadtest.ts`를 배포 주소에 대고 돌린다(User-Agent 명시). 방 하나 20명 기준 스냅샷 간격과 대시보드의 DO 요청·duration 그래프를 본다.

---

## 16. 확인 못한 것

- **실제 계정 배포 전체.** 과금액, 프로덕션 지연, `wrangler deploy`의 실제 출력.
- **Hibernation API에서 서버 주도 종료가 늦는 현상(§3.4-I)이 프로덕션에서도 같은지.** 로컬 workerd 1.20261123.1에서만 봤다.
- **타이머만 있고 들어오는 이벤트가 없는 DO를 프로덕션이 언제 축출하는지.** 문서는 "타이머는 축출을 작업당 최대 15분 막는다" + "그 밖에는 70~140초 무이벤트 시 축출"이라고 적는다. 로컬에서는 소켓이 붙어 있으면 21분 넘게 살았고, 소켓이 없으면 타이머가 있어도 1~2분에 축출됐다.
- **무료 플랜에서 DO 호출의 CPU 한도.** DO limits 페이지는 플랜 구분 없이 "30초"라고 적고, FAQ는 "Workers와 같은 호출당 CPU 한도"라고 적으며, Workers 무료 플랜은 10ms다.
- **무료 플랜의 일일 요청 한도에도 WebSocket 20:1 환산이 적용되는지.** 문서는 "for compute requests billing-only"라고만 적는다.
- **`setWebSocketAutoResponse`로 자동 응답된 메시지가 요청으로 과금되는지.** 문서는 "추가 벽시계 시간이 들지 않으므로 과금되지 않는다"고 duration 각주에 적어 두었을 뿐이다.
- **WebSocket 메시지마다 invocation log가 한 건씩 생기는지**, 그리고 2026-12-01 이후 GB 기준 요금에서 그 크기.
- **한국 통신사에서 Cloudflare 서울 데이터센터로 붙는지.** 검색으로 근거를 찾지 못했다. 배포 뒤 `request.cf.colo`로 잰다(§15-14).
- **프로덕션의 알람 지터.** 로컬 100~102ms.
- **`secrets.required` 선언 + Worker가 없는 상태에서 `wrangler secret put`의 동작.**
- **`server/core`를 실제로 import한 번들**과 Vite 개발 서버 ↔ `wrangler dev` 조합. 포트·경로가 맞는다는 것까지만 확인.
- **같은 규모를 Node 서버로 돌릴 때의 비용.**

---

## 17. 출처 (2026-11-26에 직접 읽은 것)

Durable Objects
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (수정 2026-11-18)
- https://developers.cloudflare.com/durable-objects/platform/pricing/ (2026-11-13)
- https://developers.cloudflare.com/durable-objects/platform/limits/ (2026-11-13)
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (2026-10-30)
- https://developers.cloudflare.com/durable-objects/api/alarms/ (2026-11-18)
- https://developers.cloudflare.com/durable-objects/api/state/ (2026-09-30)
- https://developers.cloudflare.com/durable-objects/api/base/ (2026-11-19)
- https://developers.cloudflare.com/durable-objects/api/namespace/ (2026-11-05)
- https://developers.cloudflare.com/durable-objects/api/id/ (2026-05-27)
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ("Durable Object class exports", 2026-09-28)
- https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/
- https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/ (2026-10-30)
- https://developers.cloudflare.com/durable-objects/reference/data-location/ (2026-06-26)
- https://developers.cloudflare.com/durable-objects/best-practices/architecture-guidance/
- https://developers.cloudflare.com/durable-objects/platform/known-issues/ (2026-10-30)
- https://developers.cloudflare.com/durable-objects/platform/spend-management/ (2026-11-13)
- https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ (2026-11-13)
- https://developers.cloudflare.com/durable-objects/reference/faq/
- https://developers.cloudflare.com/durable-objects/get-started/ (2026-11-13)

Workers
- https://developers.cloudflare.com/workers/runtime-apis/websockets/ (2026-11-18)
- https://developers.cloudflare.com/workers/platform/pricing/ (2026-11-18)
- https://developers.cloudflare.com/workers/platform/limits/ (2026-11-25)
- https://developers.cloudflare.com/workers/wrangler/configuration/ (2026-11-12)
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/wrangler/install-and-update/
- https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- https://developers.cloudflare.com/workers/configuration/secrets/ (2026-11-21)
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/static-assets/binding/ (2026-11-12)
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/static-assets/headers/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
- https://developers.cloudflare.com/workers/runtime-apis/performance/
- https://developers.cloudflare.com/workers/runtime-apis/request/ (`request.cf.colo`)
- https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
- https://developers.cloudflare.com/workers/reference/security-model/
- https://developers.cloudflare.com/workers/languages/typescript/
- https://developers.cloudflare.com/workers/local-development/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developers.cloudflare.com/workers/ci-cd/builds/
- https://developers.cloudflare.com/observability/pricing/

체인지로그
- https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/
- https://developers.cloudflare.com/changelog/post/2026-06-19-apac-ne-apac-se-location-hints/
- https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/
- https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/
- https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/
- https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/
- https://developers.cloudflare.com/changelog/post/2026-11-05-durable-objects-automatic-retries/
- https://developers.cloudflare.com/changelog/post/2026-11-13-spend-management/
- https://developers.cloudflare.com/changelog/post/2026-11-19-durable-objects-runtime-update-reliability/

`cf` CLI
- https://developers.cloudflare.com/cf/
- https://developers.cloudflare.com/cf/wrangler/migrate/

npm 조회: `wrangler`, `workerd`, `miniflare`, `@cloudflare/workers-types`, `@cloudflare/vite-plugin`, `@cloudflare/vitest-pool-workers`, `cf`

---

## 18. 우리 게임에 적용할 것

1. **`worker/` 어댑터는 §10의 구조로 만든다.** `RoomDO`가 `server/core`의 `Room` 하나를 들고, `fetch`에서 `room.connect`, `message` 이벤트에서 `room.message`, `close`/`error`에서 `room.disconnect`, `setTimeout` 체인에서 `room.tick()`을 부른다. `RoomHost.send/close`는 `Map<ConnId, WebSocket>` 조회로 구현한다(`send`는 `try/catch`).
2. **표준 WebSocket API를 쓴다.** `server.binaryType = "arraybuffer"`를 `accept()` 전에. 틱이 도는 방에서 Hibernation API는 이득이 없고 종료 동작에 함정이 있다(§3).
3. **방이 비면 타이머를 지운다.** DO 어댑터에서 가장 중요한 한 줄이다. 틱은 `try/catch`로 감싸 예외로 루프가 죽지 않게 한다.
4. **`RoomHost.listRooms()`와 `claimPid()`는 로비 RPC로.** `listRooms()`는 동기 인터페이스이므로 방 DO가 로비 목록 사본을 들고 있다가(하트비트 응답으로 갱신) 돌려준다. `claimPid`는 로비가 pid → 방을 기억하고 이전 방 DO에 `kickPid`를 RPC로 부르게 한다. 이 두 가지는 이번 예제에 넣지 않았다.
5. **종료 사유는 짧은 영문 코드**(`"full"`, `"dup"`, `"idle"`). 한글 문구는 클라이언트가 고른다(123바이트 제한).
6. **클라이언트 재접속.** `1006`과 예고 없는 끊김을 정상 경로로 다룬다: 지수 백오프로 재접속, 서명 저장본으로 진행도 복원, "서버가 잠깐 쉬었습니다" 같은 안내. 배포·런타임 업데이트마다 일어난다.
7. **자리 비움 정책을 넣는다.** 입력이 N분 없으면 `kick{why:'idle'}`. 방-시간을 줄이는 가장 싼 방법이다.
8. **자동 배정은 붐비는 방부터.** 지금의 `pick()` 방식 유지.
9. **클라이언트 전송을 줄일 여지를 남긴다.** `CLIENT_SEND_HZ`를 10 → 5로 내리면 B 규모에서 월 $32가 준다. §5의 견적은 "멈춰 있을 때는 MOVE를 보내지 않는다"를 전제로 했다. 멈춰 있어도 10Hz로 보내는 구현이면 B2(최악) 줄을 본다.
10. **설정**: `wrangler.jsonc`, `exports`(SQLite), `compatibility_date` 고정, `run_worker_first: ["/ws", "/api/*"]`, SPA 모드 끔, `invocation_logs: false`, `locationHint: "apac-ne"`.
11. **`client/public/_headers`** 에 `/assets/*` 장기 캐시 규칙을 넣는다. Node 서버에서는 무시되는 파일이다.
12. **`SAVE_SECRET`은 wrangler 시크릿으로.** Node 서버와 같은 값을 써야 두 서버 사이에서 저장본이 통한다. 서명기는 지금의 순수 JS 구현을 그대로 써도 되고 `node:crypto`로 바꿔도 된다(§11).
13. **교단 기록(`CultRegistry`)은 설계를 정해야 한다.** 이 인터페이스는 동기다. DO의 SQLite API(`ctx.storage.sql.exec`, `ctx.storage.kv`)도 동기라서 **방 DO 자신의 저장소**에는 그대로 맞는다(방마다 따로 기록). 방 사이에 공유하는 전역 순위·이름 중복 검사는 다른 DO를 불러야 하고 RPC는 비동기라 그대로는 맞지 않는다. 방 DO가 사본을 들고 `record()`는 `ctx.waitUntil(stub.record(...))`로 뒤에서 반영, 사본은 하트비트 응답으로 갱신하는 식이 된다. 메모리에만 두면 방이 빌 때 사라진다.
14. **출시는 Workers Paid + 지출 알림.** 무료 플랜은 개발·시연용으로만.
15. **어댑터 둘(Node, DO)을 유지하는 지금 구조 그대로 간다.** DO 쪽은 방 3개 규모에서 월 $5~19이고 서버 운영이 없다(HTTPS·정적 호스팅·WebSocket이 배포 한 번에 끝난다). 방 100개 규모에서는 월 $160~280이고 대부분이 "방이 깨어 있는 시간" 값이다. Node 쪽 비용은 이번에 재지 않았으므로 어느 쪽이 싼지는 여기서 말하지 못한다. 코어가 전송 계층과 분리돼 있어 나중에 바꿀 수 있다.
16. **배포 전 체크**: `wrangler types` → `tsc` → `deploy --dry-run`을 CI에 넣는다(`cf:check` 스크립트).
17. **배포 후 가장 먼저 확인할 것**: §16의 항목 중 Hibernation 종료 지연(쓴다면), invocation log 건수, 한국 통신사의 `colo`, 방 하나 20명일 때 대시보드의 DO duration·요청 수가 §5의 계산과 맞는지.
