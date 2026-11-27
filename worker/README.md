# worker/ — Cloudflare Workers + Durable Objects 어댑터

Node 서버(`server/node/main.ts`) 대신 Cloudflare 에서 **같은 `server/core` 코드**를 돌리는 실시간 백엔드입니다.
게임 규칙은 한 줄도 다르지 않고, 연결을 받아 `Room` 에 넘기는 부분만 다릅니다.
처음 배포하는 분은 단계별 안내서 [`docs/DEPLOY-CLOUDFLARE.md`](../docs/DEPLOY-CLOUDFLARE.md) 를 보세요.

> 검증 상태: 로컬 `wrangler dev`(workerd)에서 `tests/e2e/worker-smoke.cjs` 로 실제 동작을 확인했습니다
> (프로토콜 점검 17항목 + 브라우저 2대). **실제 Cloudflare 계정 배포는 이 저장소 작업 환경에서 해 보지 못했습니다**
> (계정·토큰 없음). 과금·프로덕션 지연은 문서 근거의 추정입니다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/index.ts` | Worker 라우터. `/api/rooms`, `/healthz`, `/ws?room=<id\|auto>`, 그 밖은 정적 에셋(`dist/client`) |
| `src/room.ts` | `RoomDO` — 방 하나 = DO 하나. `Room` + `RoomHost` 구현, 사람이 있을 때만 10Hz 틱 |
| `src/lobby.ts` | `LobbyDO` — 싱글턴. 방 인원표, 자동 배정, 다른 방의 중복 pid 정리, 교단 기록 원본(SQLite) |
| `src/policy.ts` | 배정 규칙(순수 로직): Node `server/core/lobby.ts` 와 같은 정책(가장 붐비는 빈자리 방, 80% 차면 증설, 빈 증설 방 5분 뒤 정리) |
| `src/cults.ts` | 교단 기록: 방 DO 의 동기 사본(`CultCache`) ↔ 로비의 원본(`CultStore`), seq 기반 변경분 동기화 |
| `src/env.ts` | 바인딩 타입(`Env`)과 `vars` 해석(Node 의 환경변수와 같은 이름·범위) |
| `wrangler.jsonc` | 설정: `compatibility_date`, DO 바인딩 + `exports`(SQLite), `vars`, `assets`, 필수 비밀 |

흐름: 브라우저 → Worker `/ws?room=auto` → `LobbyDO.pick()` 이 방 번호를 고름 → `env.ROOM.getByName("room-<id>")` 로 업그레이드를 넘김
→ `RoomDO.fetch()` 가 `WebSocketPair` 를 받아 `room.connect()`. 게임 메시지는 로비를 거치지 않고 방 DO 로 바로 갑니다.
전부 가득이면 Worker 가 직접 연결을 받아 `{t:'full', rooms}` 를 보내고 4001 로 닫습니다(Node 와 같은 동작).

## 설계 결정

- **표준 WebSocket API (Hibernation API 아님).** 10Hz `setTimeout` 틱이 걸려 있는 동안은 어느 쪽이든 동면하지 못해 과금이 같고,
  Hibernation API 는 서버가 틱·fetch 문맥에서 `close()` 한 소켓의 종료가 클라이언트에 늦게(10초) 또는 아예 가지 않는 현상이
  로컬에서 관찰됐습니다. 코어는 가득 참·중복·무응답 종료를 바로 그 문맥에서 하므로 표준 API 가 맞습니다
  (`docs/research/06-cloudflare-durable-objects.md` §3).
- **빈 방은 틱을 멈춥니다.** 마지막 소켓이 나가면 `clearTimeout` → DO 가 메모리에서 내려가고 과금이 멈춥니다.
  Node 판은 빈 방도 1초에 한 번 NPC 를 움직이지만, 여기서는 다음 입장 때 다시 움직입니다(방 상태는 그때 새로 시작될 수 있음).
- **틱은 매번 다시 거는 `setTimeout` + 밀림 보정.** 알람(`setAlarm`)으로 10Hz 를 만들면 요청·행 쓰기 과금으로 약 7배 비쌉니다.
- **`RoomHost` 구현**: `send/close` 는 연결 표 조회(+예외 무시), `now = Date.now`, `random = Math.random`,
  `signer = createSigner(SAVE_SECRET)`(코어의 순수 JS HMAC — Node 서버와 같은 비밀이면 저장본이 양쪽에서 통함),
  `listRooms` = 로비 보고 응답으로 받은 사본(+내 방은 지금 값), `claimPid` = 로비 RPC → 로비가 이전 방 DO 에 `kickPid` RPC.
- **로비 보고**: 인원(players/pending)이 바뀔 때마다 즉시 + 10초마다. 보고가 35초 넘게 끊긴 방(배포·리셋으로 '0명' 보고 없이 사라진 방)은 0명으로 봅니다.
  배정 직후 아직 접속이 도착하지 않은 자리는 10초 동안 예약으로 잡아 둡니다(몰릴 때 정원 초과 배정 방지).
- **교단 기록(`host.cults`)**: 구현되어 있습니다. 방 DO 가 사본을 들고 코어에 동기로 답하고, 변경은 로비 보고에 실어 보냅니다.
  로비는 SQLite 에 저장하고 행마다 seq 를 매겨 변경분만 돌려줍니다.
  **한계:** 다른 방에서 방금 만든 교단 이름은 다음 동기화(최대 약 10초) 전까지 `nameTaken()` 에 잡히지 않을 수 있습니다.

## 로컬 개발

Node 22.12 이상이 필요합니다(wrangler 4 요구사항).

```sh
npm ci && npm run build:client      # 저장소 루트: dist/client 생성(assets 가 이 폴더를 가리킴)
cd worker
npm install
cp .dev.vars.example .dev.vars      # 로컬 비밀(SAVE_SECRET). git 에 올리지 않음
npm run dev                         # = wrangler dev → http://localhost:8787 (게임 + API + WS)
```

- 기본 포트 8787 은 Node 서버와 같아서, Node 서버 대신 이것을 띄우면 루트의 `npm run dev:client`(Vite 5173, `/ws`·`/api` 프록시)가 붙도록 포트·경로가 맞춰져 있습니다(이 조합 자체는 직접 돌려 보지 않았습니다. 확인된 경로는 Worker 가 `dist/client` 를 서빙하는 방식과 `?server=` 방식).
- 설정값을 바꿔 띄우기: `npx wrangler dev --port 8840 --var ROOMS:2 --var ROOM_CAPACITY:5`
- 소스를 고치면 자동으로 다시 올라가고 **모든 방이 리셋되어 연결이 끊깁니다**(배포 때 벌어질 일과 같음. 클라이언트는 자동 재접속).
- 타입 검사: `npm run typecheck` (루트에서는 `npx tsc -p worker/tsconfig.json --noEmit`). 루트 tsconfig 에는 넣지 않았습니다(Workers 전역 타입이 Node·DOM 과 충돌).
- 배포 전 점검: `npm run check` (= tsc + `wrangler deploy --dry-run`, 번들 약 430KiB).
- 연기 시험(저장소 루트): `npm run build && node tests/e2e/worker-smoke.cjs` — 8840(Worker)·8841(정적 서버) 포트를 씁니다.

## 배포

```sh
npx wrangler login
# 첫 배포: 코드와 비밀을 한 번에(비밀 파일은 git 에 올리지 않음. 내용: SAVE_SECRET=...)
npm run deploy -- --secrets-file ../.env.production
# 이후 배포
npm run deploy
# 비밀만 바꾸기(새 버전이 즉시 배포됨 = 방이 끊김)
npx wrangler secret put SAVE_SECRET
# 로그
npx wrangler tail
```

## 설정(`wrangler.jsonc` 의 `vars`)

| 이름 | 기본 | 의미 (Node 서버의 같은 이름 환경변수와 같음) |
|---|---|---|
| `ROOMS` | 3 | 처음부터 있는 방 수(비어도 목록에 남음) |
| `MAX_ROOMS` | 3 | 자동 증설 상한. `ROOMS` 보다 크면 모든 방이 80% 찼을 때 다음 방을 엽니다 |
| `ROOM_CAPACITY` | 20 | 방 정원(1~100) |
| `NPCS` | 28 | 방마다 NPC 수(0~200) |
| `ALLOWED_ORIGINS` | "" | 쉼표 구분. 비우면 전부 허용. Origin 헤더 없는 비브라우저 도구는 항상 통과 |
| 비밀 `SAVE_SECRET` | (필수) | 저장본 서명 키. 없으면 `/ws` 가 503 |

## Node 서버와 다른 점(알고 쓰기)

- 배포·`secret put`·Cloudflare 런타임 업데이트 때마다 깨어 있는 방이 최대 5분 안에 리셋됩니다. 진행도는 클라이언트의 서명 저장본에 있어서 재접속하면 이어집니다.
- 빈 방의 NPC 가 멈춰 있고, 방이 비어 DO 가 내려가면 방 상태(NPC 위치 등)가 새로 시작됩니다.
- `/healthz` 의 `tickMsP95` 는 로컬에서만 의미가 있습니다(프로덕션 `Date.now()`/`performance.now()` 는 실행 중 멈춰 있음). `rssMb`, `cpuMs` 등 프로세스 지표는 없습니다.
- 송신 버퍼 감시(Node 의 `bufferedAmount` 1MB 초과 시 끊기)는 Workers 에 해당 값이 없어 하지 않습니다. 무응답 연결은 코어의 45초 무메시지 타임아웃이 정리합니다.
- 교단 이름 중복 검사는 방 사이에 최대 약 10초 늦을 수 있습니다(위 설계 결정 참고).
