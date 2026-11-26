# 아키텍처

## 1. 한눈에 보기

```
브라우저(클라이언트)                    실시간 서버
┌──────────────────────┐   HTTP  GET /api/rooms      ┌──────────────────────────────┐
│ Three.js 렌더        │ ───────────────────────────▶ │ 어댑터 (전송 계층)            │
│ 입력/카메라/예측 이동 │   WS    /ws?room=<id|auto>   │  · Node: http + ws (server/node)│
│ 보간(다른 사람/NPC)  │ ◀══════════════════════════▶ │  · Cloudflare: Worker + DO (worker/)│
│ UI(DOM)             │   JSON 이벤트 + 바이너리 위치  │ ───────────────────────────── │
└──────────────────────┘                              │ 코어 (server/core) — 전송 무관 │
        ▲                                             │  Lobby ─ Room×N ─ NpcSim      │
        └────────────── shared/ (프로토콜·상수·월드·콘텐츠·규칙) ──────────────┘
```

- **방(Room) = 독립된 시뮬레이션 단위.** 접속자 최대 20명 + 서버가 움직이는 NPC 28명. 방끼리는 상태를 공유하지 않는다 → 방 수를 늘리는 것이 곧 수평 확장(프로세스/DO 단위 분산).
- **서버 권위:** NPC 이동, 포교 판정, 진행도(영향력/신도/업적)는 서버가 정한다. 클라이언트는 자기 캐릭터 이동만 예측하고 서버가 속도/경계를 검증한다.
- **계정 없음:** 진행도는 서버가 HMAC 서명해 클라이언트 localStorage 에 맡긴다(`SignedSave`). 다음 접속 때 서명을 검증하고 이어서 쓴다.

## 2. 디렉터리와 소유

```
shared/                 클라·서버 공용(순수 TS, DOM/Node API 금지)
  constants.ts          전역 상수
  types.ts              공용 타입(Look, PlayerPublic, NpcPublic, Progress …)
  protocol.ts           메시지 타입 + 바이너리 코덱(MOVE/SNAPSHOT)
  rng.ts                난수 도우미
  content/              콘텐츠 데이터(멘트, 시민 유형, 계시, 업적, 헌납품 …) + 카탈로그(core.ts)
  world/                맵: def.ts(스키마) · data.ts(레이아웃) · index.ts(충돌/지면/이동망 질의)
  rules/                순수 규칙: pitch.ts(포교 판정) · progress.ts(진행도/해금) · moderation.ts(이름 필터)
server/
  core/                 전송 무관 코어 — Node API 금지(§4)
    api.ts              계약: RoomHost, RoomApi, RoomSystem, PlayerState, NpcState, NpcSimApi
    room.ts             Room: 세션/이동/스냅샷/이모트/대화·포교/보상/저장
    npcSim.ts           NPC 시뮬레이션
    lobby.ts            방 목록/자동 배정
    save.ts             HMAC-SHA256(순수 JS) 서명기
    systems/*.ts        기능 플러그인(교단, 단상, 배틀, 헌금함, 업적, 단속반, 기싸움)
  node/main.ts          Node 어댑터: HTTP(정적 파일, /api/rooms, /healthz) + WebSocket
worker/                 Cloudflare Workers + Durable Objects 어댑터(선택)
client/
  index.html, public/config.js
  src/main.ts           부팅/조립/게임 루프
  src/core/             contracts.ts(모듈 계약) · bus.ts(이벤트) · store.ts(상태) · config.ts(서버 주소)
  src/net/              WebSocket 클라이언트, 보간
  src/game/             내 캐릭터 이동, 카메라, near 판정, actions
  src/input/            키보드/마우스/터치
  src/render/           engine.ts · world.ts · characters.ts · fx.ts
  src/ui/               kit.ts(공용) · index.ts(등록부) · 모듈별 파일 + CSS
  src/audio/sfx.ts      합성 효과음
  dev/                  렌더러 미리보기용 개발 페이지(배포에는 포함되지 않아도 됨)
tests/unit/             vitest 단위 테스트
tests/e2e/              Playwright 스크립트(브라우저 2개 동기화 등)
tools/                  부하 테스트 봇 등
docs/                   설계/조사/배포 문서
```

**규칙**
- 각 담당은 **자기 소유 파일만** 고친다. 계약 파일(`shared/protocol.ts`, `shared/types.ts`, `shared/constants.ts`, `shared/content/types.ts`, `shared/content/core.ts`, `server/core/api.ts`, `client/src/core/*`, `client/src/ui/kit.ts`, `client/src/ui/index.ts`, `client/src/styles/base.css`)을 바꿔야 한다면 **뒤에 추가만** 하고 결과 보고에 명시한다(기존 필드/시그니처 변경 금지).
- 의존성 추가 금지(`three`, `ws`만 런타임 의존성). 외부 에셋 파일(모델/이미지/음원/폰트) 금지 — 전부 코드로 생성.
- import 는 상대 경로, 확장자 없이. TypeScript strict. `any` 지양.
- 사용자에게 보이는 문자열은 한국어. 사용자 입력 문자열은 `textContent` 로만 DOM 에 넣는다(`innerHTML` 금지).
- 주석은 한국어로 "왜"를 적는다.

## 3. 실행/검증

```
npm run dev            # 서버(8787) + Vite(5173, /ws·/api 프록시)
npm run build          # dist/client + dist/server/main.js
npm start              # 빌드 결과 실행(서버가 정적 파일도 제공), PORT 환경변수
npm run typecheck      # tsc (client, server)
npm test               # vitest (tests/unit)
npm run test:e2e       # Playwright 스크립트
```

서버 환경변수: `PORT`(8787) · `ROOMS`(3) · `ROOM_CAPACITY`(20) · `NPCS`(28) · `SAVE_SECRET`(없으면 `.data/secret` 에 생성) · `CLIENT_DIR`(정적 파일 위치) · `ALLOWED_ORIGINS`(쉼표 구분, 비우면 전부 허용) · `DATA_DIR`(.data).

헤드리스 검증: Playwright Chromium 은 SwiftShader 로 WebGL2 가 동작한다. `require('playwright')` 는 어디서나 된다(전역 설치). **`playwright install` 을 실행하지 말 것.**

## 4. 서버 코어

### 4.1 전송 무관 원칙
`server/core/**` 와 `shared/**` 는 Node 와 Cloudflare Workers 양쪽에서 돌아야 한다.
- 금지: `node:*` import, `Buffer`, `process`, `fs`, `setInterval/setTimeout` 로 자체 루프 만들기, `Date.now()` 직접 호출(→ `host.now()`), `Math.random()` 직접 호출(→ `room.rnd`).
- 어댑터가 `room.tick()` 을 `TICK_HZ`(10Hz)로 불러 준다.

### 4.2 Room (server/core/room.ts)

```ts
export class Room implements RoomApi {
  constructor(host: RoomHost, opts: RoomOptions)
  // 어댑터가 호출
  connect(conn: ConnId): void                       // 새 연결(아직 hello 전)
  message(conn: ConnId, data: string | ArrayBuffer | Uint8Array): void
  disconnect(conn: ConnId): void                    // 연결 종료(정리 + leave 방송)
  tick(): void                                      // 10Hz
  info(): RoomInfo                                  // {id,name,players,cap,npcs}
  kickPid(pid: string, why: SKick['why']): boolean  // 다른 방에서 같은 pid 가 들어왔을 때 어댑터가 호출
  shutdown(): void                                  // 전원에게 kick(shutdown)
}
```

**접속 절차**
1. `connect(conn)` → 대기 목록에 올림. `HELLO_TIMEOUT_MS` 안에 hello 가 없으면 `close(CLOSE_BAD)`.
2. `hello` 수신:
   - `v !== PROTOCOL_VERSION` → `kick{why:'ver'}` 후 close.
   - 방이 가득(`players.size >= capacity`) → `full{rooms: host.listRooms()}` 후 `close(CLOSE_FULL)`.
   - `pid` 검증(문자열 8~64자, `[\w-]`). 같은 pid 가 **이 방에** 이미 있으면 기존 연결에 `kick{why:'dup'}` + close 하고 새 연결을 받는다. 그 뒤 `host.claimPid(pid, roomId)`(다른 방 정리는 어댑터 몫).
   - 닉네임: `checkNickname` 실패 시 서버가 임의 닉네임을 붙인다. 같은 방에 같은 이름이 있으면 뒤에 숫자를 붙인다.
   - 저장본: `save` 가 있고 `signer.verify(d, s)` 가 참이고 `normalizeProgress(JSON.parse(d), pid, now)` 가 통과하면 그 진행도를, 아니면 `newProgress(pid, now)`.
   - `look` 은 `sanitizeLook(look, rank, ach)`.
   - 시작 위치: `world.spawns` 중 임의 + 약간의 흩뿌림.
   - `welcome`(전체 상태 + 서명 저장본) 전송 → 시스템 `onWelcome`/`onJoin` → 다른 사람에게 `join` 방송.
3. 이후 메시지는 종류별로 처리. `handles` 에 등록된 종류는 해당 시스템의 `onMessage` 로.

**메시지 처리(코어가 직접)**
- 바이너리 `MOVE`: `decodeMove`. 얼어붙은 상태(`stunUntil`)면 무시하고 `pos` 보정. 이전 위치에서의 이동 거리가 `허용 속도 × 경과 시간 × SPEED_TOLERANCE + 0.5m` 를 넘으면 이전 위치로 되돌리고 `pos` 전송(허용 속도 = `sprintUntil` 안이면 SPRINT, 아니면 RUN). 경계 밖은 `bounds` 로 자른다. 통과하면 x/z/yaw/st 갱신, `dirty = true`. 이동하면 반복 이모트 해제(`emote = null`, 방송).
- `ping` → `pong{c, s: now}`.
- `emote`: `EMOTE_BY_ID` 에 있고 직급 해금됐는지 확인, `EMOTE_COOLDOWN_MS`. `flee` 면 `SPRINT_COOLDOWN_MS` 쿨타임 검사 후 `sprintUntil = now + SPRINT_MS + 400`. 반복 이모트면 `p.emote` 에 기억(나중에 들어온 사람도 보이게). 방송 `emote{id,e}`(본인 포함 X — 본인은 이미 재생 중). `STAT.emotes`/`dances`/`sprints` 카운트. `e === ''` 는 반복 해제.
- `say`: `QUICK_CHATS[q]` 존재 + 직급, `SAY_COOLDOWN_MS`. 방송 `say{id,q}`.
- `profile`: 이름(`checkNickname`)·외형(`sanitizeLook`) 변경 → `publish`.
- `rooms` → `rooms{rooms: host.listRooms()}`.
- `talk{n}`:
  - 이미 대화 중이면 그 세션을 먼저 끝낸다.
  - 포교 쿨타임(`cd 'pitch'`)이면 `talkNo{why:'cool', ms}`.
  - NPC 없음/역할이 대화 불가(`role==='patrol'`) → `talkNo{why:'gone'}`. 거리 > `TALK_RANGE + 1.0` → `far`. `npcs.canTalk` 결과가 busy/memo/gone 이면 그대로. 이미 내 신도(`owner === p.id`) → `mine`.
  - 통과: `npcs.beginListen(npc, p, now + TALK_TIMEOUT_MS)`, `p.talk = {npc, round:1, lines: pickLines(rank, rnd), used:[], until}`, `talkOk{n, greet: pick(arch.greet), lines, round:1}`. `STAT.talks` +1, `prog.met` 에 유형 기록(처음이면 `markSave`).
- `pitch{n,l}`: 세션 검증(`p.talk.npc === n`, `lines.includes(l)`) 실패 시 `err`. 판정:
  ```ts
  const result = resolvePitch(npc.arch, PITCH_LINES[l], {rank, streak, failStreak, round, buff, poach: npc.owner !== 0 && npc.owner !== p.id}, rnd)
  ```
  - 시스템 `interceptPitch` 중 하나가 true 면 기본 처리 생략(그 시스템이 세션 정리까지 책임).
  - 방 전체에 `pitchRes{p,n,l,o,say}`.
  - `join`/`king`: `MAX_ENTOURAGE` 초과면 가장 오래된 신도를 `release(…,'expire')`. `npcs.startFollow(npc, p.id, now + FOLLOW_DURATION_MS, now)`. `grant{why:'join', inf: INF_JOIN + min(streak×INF_STREAK_BONUS, INF_STREAK_MAX), fol: 1, streak}`. 통계: joins+1, streak+1, bestStreak, failStreak=0, (king 이면 kings+1), (poach 면 poaches+1). 세션 종료.
  - `more`: `grant{why:'more', inf: INF_MORE}`. `round = 2`, 새 `lines = pickLines(rank, rnd, LINES_PER_TALK, used)`, `until` 연장, `talkOk{round:2, greet: say}` 재전송.
  - `no`/`ignore`: `npcs.remember(npc, p.id, now + NPC_REJECT_MEMORY_MS)`, `npcs.endListen`/`walkOff`. `grant{why:'fail', inf: INF_FAIL}`. 통계: rejects+1, (ignore 면 ignores+1), streak=0, failStreak+1, worstStreak.
  - `flee`: 위와 같고 `npcs.flee(npc, p.x, p.z, now)`, flees+1.
  - `rival`(가로채는 시스템이 없을 때): `no` 와 같이 처리.
  - 공통: pitches+1, `cd 'pitch' = PITCH_COOLDOWN_MS`, 시스템 `onPitch` 호출.
- `talkEnd` 또는 시간 초과: `npcs.endListen`, `talkEnd{n, why}`.

**틱(10Hz)**
1. `npcs.tick(now, dt, players)`.
2. 대화 세션 시간 초과, hello 시간 초과, 무응답(`IDLE_TIMEOUT_MS`) 연결 정리, 버프 만료.
3. 시스템 `onTick`.
4. **스냅샷:** `dirty` 인 플레이어/NPC 만 모아 `encodeSnapshot(now, players, npcs)` → 방 전원에게 전송 후 `dirty = false`. 둘 다 비어도 1초에 한 번은 빈 스냅샷을 보낸다(클라이언트 시계/hold 갱신용). 255개 초과는 없다(20 + 28).
5. `saveDirty` 인 플레이어는 최대 1초에 한 번 `save{me, save: {d, s}}` 전송.

**RoomApi 구현 메모**
- `grant`: prog.inf/fol/coins/items 반영, `rank = rankForInfluence(inf)`. 오르면 `rankUp` 을 reward 에 담고 `feed('rank', …)`, `publish(['rank'])`. fol 이 변하면 `publish(['fol'])`. 교단이 있으면 `prog.cultFol/cultInf`(교주일 때)와 `host.cults?.record(...)` 반영. `reward` 전송, `markSave`.
- `bump`/`setStat`: `prog.stats[k]` 갱신 후 모든 시스템 `onStat`. `markSave`.
- `unlockAchievement`: 중복이면 false. `prog.ach.push`, `grant{why:'ach', inf: def.inf}` + reward 의 `ach` 에 id, `feed('ach', …)`.
- `disconnect`: 대화 정리, `npcs.onPlayerLeave`, 시스템 `onLeave`, `leave` 방송.

**부정 방지/안정성:** 연결당 토큰 버킷(`RATE_LIMIT_PER_SEC`, 넘치면 `kick{why:'rate'}`), 메시지 크기 `MAX_MSG_BYTES`, 모든 필드 타입 검사(잘못되면 무시), 한 메시지 처리 중 예외는 잡아서 로그만 남기고 방은 계속 돈다.

### 4.3 NpcSim (server/core/npcSim.ts)

```ts
export function createNpcSim(world: WorldDef, rnd: Rnd, events: NpcSimEvents, count: number): NpcSimApi
```

- 시작 시 `count` 명을 이동망 위 임의 지점에 배치(유형은 `weight` 가중 추첨, 이름은 `arch.names`, 외형은 `arch.look` 풀에서).
- **wander:** 임의 목적지 노드까지 `findNavPath` 로 걷는다(속도 `NPC_WALK_SPEED × arch.speed`, 노드 위치에서 ±1m 흩뿌림으로 줄 맞춰 걷지 않게). 도착하면 노드 종류에 따라 `pause`(shop 2~5초, rest 5~12초, 그 외 0.5~2초) 후 새 목적지. 목적지가 `exit` 면 도착 후 `Vanish` 로 1초 뒤 새 시민으로 교체(`onSpawn`) — 약 15% 확률로 exit 를 목적지로 고른다.
- **교체(retire/replace):** 같은 id 를 재사용해 유형·이름·외형을 새로 뽑고 `subway`(또는 임의 exit)에서 `enter` 로 등장 → `onSpawn`.
- **listen:** 멈춰서 플레이어 쪽으로 yaw. `until` 이 지나면 자동 `endListen`.
- **follow:** 주인 뒤를 줄지어 따른다. i번째 신도의 목표 = 주인 위치에서 주인 진행 반대 방향으로 `1.1 + 0.95×i` m (주인이 서 있으면 주인 뒤쪽 반원에 부채꼴). 목표와 멀면 `NPC_FOLLOW_SPEED` 까지 빨라지고 가까우면 멈춘다. 주인과 25m 이상 벌어지면 주인 뒤로 순간이동하지 말고 달려서 따라온다(그래도 40m 이상이면 `release`). `until` 이 지나면 `release(npc,'expire')`. 따라다니는 동안 20~40초에 한 번 `arch.follow` 혼잣말(`onSay`).
- **release:** `arch.leave` 한마디(`onSay`), `owner = 0`, `onOwnerChange`, 배회 복귀(가까운 이동망 노드로).
- **flee:** 플레이어 반대 방향의 먼 노드를 골라 `NPC_FLEE_SPEED` 로 2.5~4초 달린 뒤 배회 복귀. st = `Anim.Sprint`.
- **gather:** 지정 중심 주변 반지름 `r+2 ~ r+6` 고리의 빈자리로 걸어가 중심을 바라보며 `Anim.Cheer`/Idle. `until` 또는 `ungather()` 로 해제.
- **script:** 시뮬이 건드리지 않는다(시스템이 x/z/yaw/st/dirty 를 직접 쓴다).
- 이동 후 `resolveCollision` 으로 벽에 끼지 않게. NPC 끼리는 가까우면 약하게 밀어낸다(선택).
- 위치/yaw/st 가 변하면 `dirty = true`. 혼잣말: 배회 중 25~60초에 한 번 `arch.mutter`(방 전체로 보면 너무 잦지 않게).
- `canTalk`: `mode` 가 leave/enter/flee/script 면 'gone', `talker !== 0 && talker !== playerId` 면 'busy', `memo.get(playerId) > now` 면 'memo', 그 외 'ok'.
- 성능: 방당 28명 × 10Hz. 틱당 할당을 최소화한다(경로는 목적지 정할 때만 계산).

### 4.4 Lobby (server/core/lobby.ts)

```ts
export class Lobby {
  constructor(makeRoom: (id: string, name: string) => Room, roomCount: number)
  rooms(): RoomInfo[]
  get(id: string): Room | undefined
  /** 'auto' 또는 가득 찬 방 요청 시: 가득 차지 않은 방 중 사람이 가장 많은 방(함께 놀 수 있게), 전부 비었으면 1번 방. 전부 가득이면 undefined */
  pick(requested: string | null): Room | undefined
}
```
방 id 는 '1','2','3'…, 이름은 '수상역 1번 출구' 식. `ROOMS` 환경변수로 개수 조절(최대 `MAX_ROOM_COUNT`).

### 4.5 저장 서명 (server/core/save.ts)
순수 JS 동기 HMAC-SHA256(`createSigner(secret: string): SaveSigner`). 서명은 base64url. 검증은 상수 시간 비교. Node `crypto` 와 결과가 같은지 단위 테스트.

### 4.6 Node 어댑터 (server/node/main.ts)
- `http.createServer` + `ws`(`noServer: true`, `perMessageDeflate: false`, `maxPayload: MAX_MSG_BYTES`).
- `GET /api/rooms` → `{rooms: RoomInfo[]}` (CORS 허용), `GET /healthz` → `{ok, rooms, players, uptime, tickMsP95}`, 그 외는 `CLIENT_DIR`(기본 `dist/client`) 정적 파일(경로 탈출 방지, 올바른 Content-Type, 해시 붙은 `/assets/*` 는 장기 캐시, `index.html`·`config.js` 는 no-cache, 없는 경로는 index.html).
- `GET /ws?room=<id|auto>` 업그레이드: `ALLOWED_ORIGINS` 검사 → `lobby.pick` → 방이 없으면(전부 가득) 연결을 받은 뒤 `full` 메시지를 보내고 `CLOSE_FULL` 로 닫는다(클라이언트가 안내를 띄울 수 있게).
- 연결마다 `connId` 발급, `room.connect/message/disconnect` 연결. `host.send` 는 `ws.bufferedAmount` 가 과하면(예: 1MB) 느린 클라이언트로 보고 스냅샷을 건너뛰거나 연결을 끊는다.
- 하트비트: 20초마다 ws ping, 응답 없으면 terminate.
- 틱: 방마다 따로 타이머를 두지 말고 **하나의 `setInterval(TICK_MS)` 에서 사람이 있는 방만** `tick()`(빈 방은 1초에 한 번만 — NPC 는 가볍게 유지). 틱 소요 시간을 측정해 `/healthz` 에 p95 를 노출.
- `claimPid`: 전역 `pid → roomId` 맵으로 다른 방의 같은 pid 를 `kickPid(pid,'dup')`.
- `SIGTERM`/`SIGINT`: 모든 방 `shutdown()` 후 종료.
- `SAVE_SECRET` 이 없으면 `DATA_DIR/secret` 파일에 임의 값을 만들어 재사용(재시작해도 저장본이 유효하게).

## 5. 클라이언트

### 5.1 조립과 프레임 루프 (main.ts)
```
store = createStore(); bus = new Bus()
engine = createEngine(canvas, 품질)        sfx = createSfx()
ui = createUi(#ui, bus)                    net = createNet(store, bus)
input = createInput(canvas, #ui)           world = createWorldRenderer(engine)
chars = createCharacterRenderer(engine)    fx = createFx(engine)
overlay = createOverlay(#ui, store, bus, engine)
actions = createActions(...)               ctx: AppContext = {...}
mountUi(ctx)
```
매 프레임(requestAnimationFrame, dt 는 0.1초로 상한):
1. `input.update(dt)`
2. (playing 일 때) 내 캐릭터 이동 → `store.me` 갱신 → 10Hz 로 `net.sendMove`
3. `net.update()` — 원격 플레이어/NPC 보간값을 view 에 기록, `y = groundHeight(x,z)`
4. near 판정(0.1초마다) → 바뀌면 `store.near` 갱신 + `bus.emit('near')`
5. 카메라 갱신
6. `CharVisual[]` 구성(나 + players + npcs) → `chars.update` · `world.update` · `fx.update`
7. `engine.render()` → `overlay.update()`

타이틀 화면에서도 3D 거리는 뒤에서 천천히 도는 카메라로 보인다(접속 전이라 캐릭터는 없음). 탭이 숨겨지면(`visibilitychange`) 루프는 쉬고, 돌아오면 dt 를 초기화한다.

### 5.2 내 캐릭터 (game/)
- 입력 벡터(화면 기준)를 카메라 yaw 로 돌려 월드 방향으로. 속도: 걷기 `WALK_SPEED`, 달리기 `RUN_SPEED`, 스프린트 중 `SPRINT_SPEED`. 가속/감속은 짧게(0.1초 정도) 보간.
- 이동 후 `resolveCollision(pos, PLAYER_RADIUS, hqOpen)` (`hqOpen = rank >= world.hq.minRank`).
- 대화창이 열려 있거나(`store.talk`) 얼어붙은 동안(`stunUntil`)은 이동 불가. 패널이 열려 있어도 이동은 가능.
- 탭 이동: `actions.moveTo(x,z)` → 목표 0.3m 안에 들거나 수동 입력이 오면 해제. 단순 직선 이동(막히면 1초 뒤 포기).
- 전송: 움직이는 동안 10Hz, 멈추면 Idle 패킷 한 번. 서버 `pos` 보정이 오면 그 위치로 스냅.
- near: `TALK_RANGE` 안의 말 걸 수 있는 가장 가까운 NPC(내 신도·patrol 제외), `PLAYER_INTERACT_RANGE` 안의 가장 가까운 플레이어, POI(단상 위, 헌금함 `r + POI_RANGE_PAD + 1.2` 안, HQ 내부).
- `actions.sprint()`: 쿨타임 확인 → `net.send({t:'emote', e:'flee'})`, `me.sprintUntil/sprintReadyAt` 설정.

### 5.3 네트워크 (net/client.ts)
- 접속: `new WebSocket(wsUrl('/ws?room=' + id))`, `binaryType = 'arraybuffer'`. open 되면 `hello` 전송.
- 상태기계: `connecting → playing`. 끊기면(의도적 종료/kick/full 제외) `reconnecting` 으로 바꾸고 지수 백오프(0.5s, 1s, 2s, 4s, 최대 8s, ±30% 지터)로 같은 방에 재접속. 8회 실패하면 `error`. 재접속에 성공하면 새 `welcome` 으로 상태를 통째로 다시 채운다.
- `kick` → `phase='kicked'`, `phaseWhy=why`, 자동 재접속 안 함. `full` → `phase='full'`, `store.rooms` 갱신.
- 수신 처리 후 **항상 `bus.emitMsg(msg)`** (store 반영을 먼저 끝낸 뒤). 다른 모듈은 `bus.onMsg('종류', fn)` 로 구독.
- `welcome`: store.room/me/players/npcs/sermon/battles 채움, `profile.save/name/look` 갱신·저장, `clockOffset = welcome.now - Date.now()`, `phase='playing'`, `bus.emit('entered')`.
- `join/leave/pu/npcSpawn/nu/emote/save/talkOk/talkNo/talkEnd/pitchRes/reward/pos/pong/rooms` 를 store 에 반영하고 해당 bus 이벤트 발행. `save` 는 localStorage 에도 저장. `reward.rankUp` → `bus.emit('rankUp')`. 내 신도 수(`me.entourage`)는 `owner === me.id` 인 NPC 수로 계산.
- 시계: 4초마다 `ping`. `pong` 으로 `rtt` 와 `clockOffset`(부드럽게 보정) 갱신.
- **보간:** 스냅샷 `{time, players, npcs}` 를 받으면 포함된 엔티티는 샘플 추가(`hold = t`), **포함되지 않은 엔티티는 마지막 샘플의 `hold = time`** 으로 늘린다. 렌더 시각 `rt = serverNow() - INTERP_DELAY_MS`. 샘플 a(가장 최근의 `t <= rt`)와 다음 샘플 b 사이: `rt <= a.hold` 면 a 위치, 아니면 `(rt - a.hold)/(b.t - a.hold)` 로 선형 보간(yaw 는 최단 각도). b 가 없으면 a 위치(외삽은 하지 않거나 100ms 이내로만). 오래된 샘플은 버린다. 순간이동(4m 이상 차이)은 보간하지 않고 스냅.
- 내 캐릭터는 스냅샷에서 무시한다(예측값 사용).

### 5.4 렌더

**엔진(render/engine.ts):** `WebGLRenderer({canvas, antialias: 품질≠low, powerPreference:'high-performance'})`, 픽셀 비율 상한(low 1, mid 1.5, high 2), `outputColorSpace = SRGBColorSpace`, 그림자 맵 없음(가짜 그림자), 하늘 그라데이션 배경 + 옅은 안개, 반구광 + 방향광. 품질 'auto' 는 기기(모바일/코어 수/메모리)와 초반 프레임 시간을 보고 결정하며, 평균 프레임이 계속 나쁘면 한 단계 낮춘다. WebGL 컨텍스트 손실 시 안내 후 복구 시도.

**캐릭터(render/characters.ts):** 드로콜을 줄이기 위해 **부위별 `InstancedMesh`**(머리, 몸통 종류별, 팔, 다리, 눈, 입, 모자 종류별, 소품, 그림자 원반, 발밑 고리 …)를 쓰고 매 프레임 인스턴스 행렬/색을 채운다. 절차 애니메이션(뼈대 없음): 걷기 주기에 맞춘 팔다리 흔들기, 몸 들썩임, 이모트별 포즈. 화면 밖(절두체) 캐릭터는 인스턴스에 넣지 않고, 멀리 있으면 얼굴/소품을 생략(LOD). 60명이 한 화면에 있어도 드로콜이 수십 개 수준이어야 한다. `portrait()` 는 별도 작은 씬/렌더 타깃(또는 같은 렌더러의 임시 렌더)으로 캔버스를 만든다.

**월드(render/world.ts):** `shared/world/data.ts` 의 수치와 정확히 맞는 지형/건물/소품을 생성한다. 정적 메시는 재질별로 병합(`mergeGeometries`, 버텍스 컬러)해 드로콜 최소화. 간판 글자는 `CanvasTexture`(작은 해상도, 개수 최소). 네온/신호등/깃발 정도만 `update` 에서 움직인다.

**이펙트(render/fx.ts):** 하나의 인스턴스/포인트 풀로 모든 파티클 처리.

### 5.5 UI
- `ui/kit.ts` 의 `h()`·패널·토스트·등록부 사용. 모듈은 `mountXxx(ctx)` 하나를 내보내고, 자기 DOM 과 CSS(`ui/xxx.css`, 클래스 접두사 `xxx-`)를 가진다.
- **상황 버튼:** 모듈이 `ctx.ui.addContextProvider(() => 조건 ? {id,label,icon,onClick,…} : null)` 로 등록 → HUD 가 `near` 변경/`refreshContext()` 때 모아 그린다. E/Space 는 첫 번째 `primary` 동작.
- **메뉴:** `ctx.ui.addMenuItem({id, icon, label, order, onClick})`. **패널:** `ctx.ui.registerPanel({id, title, render})` + `openPanel(id)`.
- 서버 이벤트 구독: `ctx.bus.onMsg('invited', fn)`. 서버로 보내기: `ctx.net.send({t:'invite', to})`.
- 이름표/말풍선은 `ui/overlay.ts` 가 `engine.project()` 로 위치를 잡는 DOM(transform) 방식. 실제 접속자 이름표는 항상, NPC 는 가까울 때만. 화면 밖/멀리 있는 것은 숨긴다. 말풍선 동시 표시 상한.
- 모바일 우선: 터치 대상 최소 42px, safe-area 반영, 가로/세로 모두 대응, 입력 필드 글자 16px(iOS 확대 방지).

### 5.6 소리
`audio/sfx.ts`: `AudioContext` 하나, 첫 입력에서 `unlock()`. 오실레이터/노이즈 합성으로 `SfxName` 전부 구현. 동시 발음 수 제한. 설정에 따라 음소거.

## 6. 확장(방 100개 이상)
- 방은 서로 독립 → **Node:** 한 프로세스가 수십~수백 방을 틱(측정치는 `docs/LOADTEST.md`), 그 이상은 프로세스/서버를 늘리고 방 id 로 라우팅(로비가 `방 id → 서버 주소`를 알려 주는 구조로 확장). **Cloudflare:** 방 하나 = Durable Object 하나, 로비 = 싱글턴 DO.
- 위치는 바이너리(플레이어 8B, NPC 7B)·변한 것만·같은 방에만 보낸다.
