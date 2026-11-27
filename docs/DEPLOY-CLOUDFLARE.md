# Cloudflare 에 게임 서버 올리기 (단계별 안내)

"도를 아십니까? — 교주 시뮬레이터"의 실시간 서버를 **Cloudflare Workers + Durable Objects** 로 올리는 방법입니다.
서버를 직접 관리하지 않고, 명령 몇 줄로 HTTPS 주소 · WebSocket · 게임 화면(정적 파일)까지 한 번에 배포됩니다.

> **먼저 읽어 주세요 — 검증 범위**
> - 이 어댑터(`worker/`)는 로컬 `wrangler dev`(Cloudflare 런타임 workerd 를 내 컴퓨터에서 돌리는 것)에서
>   `tests/e2e/worker-smoke.cjs` 로 실제 동작을 확인했습니다: 방 목록, 두 사람 입장·서로 보기, 이동 스냅샷, 이모트,
>   퇴장, 같은 기기 재접속(같은 방은 이어 붙이기, 다른 방은 정리), 가득 참, 저장본 복원, 남의 출처(Origin) 거절,
>   인사 없이 버티는 연결 밀어내기, 보안 헤더(`_headers`), 실제 브라우저(데스크톱·모바일) 플레이. 세 번 연속 통과를 확인합니다.
> - 접속자 메모(쿨타임·입막음 등)를 DO 저장소에 남기고 되살리는 규칙은 `tests/unit/worker-memory.test.ts` 로 확인합니다
>   (`wrangler dev` 에서는 DO 를 강제로 재울 방법이 없어 '잠들었다 깨어나기' 자체는 단위 테스트로 흉내 냅니다).
> - **실제 Cloudflare 계정에 배포해 보지는 못했습니다**(작업 환경에 계정이 없음). 아래 배포 명령은 공식 문서 기준이고,
>   요금은 공식 요금표로 계산한 **추정**입니다. 조사 근거: `docs/research/06-cloudflare-durable-objects.md`.

---

## 0. 나에게 맞는 선택인가? (Node 서버와 비교)

이 게임은 서버 코드가 둘 있습니다. 게임 규칙(`server/core`)은 같고, 연결을 받는 부분만 다릅니다.

| | Node 서버 (`npm start`) | Cloudflare (`worker/`) |
|---|---|---|
| 필요한 것 | 리눅스 서버/VPS, 도메인, HTTPS 설정, 프로세스 관리 | Cloudflare 계정 하나 |
| 비용 구조 | 서버 월 고정비(사람이 없어도 듦) | 쓴 만큼(방이 깨어 있는 시간 + 받은 메시지). 소규모는 월 $5 수준 |
| 확장 | 사람이 늘면 서버를 키우거나 늘려야 함 | 방마다 자동으로 따로 돌아감 |
| 배포할 때 | 재시작하는 순간 끊김(수 초) | 배포 후 최대 5분 안에 방마다 끊김(자동 재접속, 진행도 유지) |
| 빈 방 | NPC 가 계속 돌아다님 | 사람이 없으면 방이 잠듦(돈이 안 나감), 다음 입장 때 새로 시작 |
| 교단 순위·이름 중복 | 즉시 반영 | 방 사이 반영이 최대 약 10초 늦음 |
| 남용 방지 기억(쿨타임·차단·신고 입막음·이름 고정) | 서버 전체에서 하나(방을 옮겨도 따라감) | **방마다 따로**(방을 옮기면 그 방의 기억만 적용). 방이 잠들어도 DO 저장소에 남아 이어짐 |
| 인사 없이 버티는 연결 · IP당 상한 | 서버 전체 기준 | 방 하나 기준 |
| 서버 지표 | `/healthz` 에 메모리·CPU·틱 시간 | 대시보드 그래프(요청 수·duration). `/healthz` 는 인원만 의미 있음 |
| 무료로 해 보기 | 내 PC 에서 | 무료 플랜 가능(일일 한도 있음, 아래 7장) |

**권장:** 친구들끼리·시연·출시 초기에는 Cloudflare 가 가장 손이 덜 갑니다. 상시 수천 명이 붙는 규모가 되면 7장의 견적과
VPS 비용을 비교해 고르세요. 코드가 분리돼 있어 나중에 바꿔도 클라이언트는 주소(`config.js`)만 바꾸면 됩니다.

---

## 1. 준비물

1. **Cloudflare 계정** — https://dash.cloudflare.com 에서 가입(이메일만 있으면 됨). 가입하면 Workers **무료 플랜**이 바로 켜집니다.
   - 무료 플랜으로도 Durable Objects(SQLite 방식)를 쓸 수 있습니다. 단 일일 한도를 넘으면 그날 오전 9시(한국 시간)까지 접속이 실패합니다.
   - **공개 출시 전에는 Workers Paid(월 $5)로 바꾸세요**(5장).
2. **Node.js 22.12 이상** — 터미널에서 `node -v` 로 확인. 낮으면 https://nodejs.org 에서 LTS 를 설치합니다.
3. 이 저장소를 내려받은 폴더.

## 2. 설치

저장소 폴더에서:

```sh
npm ci                  # 게임 전체 의존성
npm run build:client    # 게임 화면을 dist/client 로 빌드(Cloudflare 가 이 폴더를 올립니다)
cd worker
npm install             # Cloudflare 도구(wrangler) 설치 — worker 폴더 안에만 깔립니다
```

## 3. 내 컴퓨터에서 먼저 돌려 보기(선택이지만 권장)

```sh
cp .dev.vars.example .dev.vars   # 로컬용 비밀값 파일. 그대로 써도 됩니다(git 에는 올라가지 않음)
npm run dev                      # http://localhost:8787 을 브라우저 두 개로 열어 같은 방에 들어가 보세요
```

끝낼 때는 터미널에서 `Ctrl + C`. 자동 점검을 돌리려면 저장소 루트에서 `npm run build && node tests/e2e/worker-smoke.cjs`.

## 4. 첫 배포

### 4-1. 로그인

```sh
npx wrangler login     # 브라우저가 열리면 '허용'
npx wrangler whoami    # 내 계정 이름이 보이면 성공
```

처음이라면 대시보드 **Workers & Pages** 화면에서 `workers.dev` 하위 도메인 이름을 정하라는 안내가 나옵니다. 정해 두세요
(게임 주소가 `https://doas-game.<내가 정한 이름>.workers.dev` 가 됩니다).

### 4-2. 저장 서명 비밀키 만들기

플레이어 진행도는 브라우저에 '서명된 저장본'으로 보관되고, 서버가 이 비밀키로 위조 여부를 확인합니다.
**이 값이 바뀌면 기존 플레이어의 진행도가 전부 무효**가 되므로 한 번 정하면 잘 보관하세요.

```sh
# 긴 무작위 문자열 만들기
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

저장소 루트(= `worker` 의 상위 폴더)에 `.env.production` 파일을 만들고 한 줄을 넣습니다(이 파일은 git 에도, Docker 빌드에도
올라가지 않게 `.gitignore`·`.dockerignore` 에서 이미 막혀 있습니다):

```
SAVE_SECRET=위에서_나온_문자열
```

> Node 서버를 이미 운영 중이었다면 그 서버의 `SAVE_SECRET`(또는 `.data/secret` 파일 내용)과 **같은 값**을 쓰세요.
> 그러면 플레이어 진행도가 두 서버 사이에서 그대로 이어집니다.

### 4-3. 배포

`worker` 폴더에서:

```sh
npm run deploy -- --secrets-file ../.env.production
```

- 이 명령은 게임 화면을 다시 빌드한 뒤 코드 + 화면 + 비밀키를 한 번에 올립니다.
- 처음 배포할 때 `RoomDO`, `LobbyDO` 두 종류의 Durable Object 가 만들어집니다.
- 마지막에 `https://doas-game.<이름>.workers.dev` 주소가 출력됩니다. 열어서 게임이 뜨면 성공입니다.
- 확인: `https://…workers.dev/api/rooms` 에 방 목록 JSON 이, `/healthz` 에 `"ok":true` 가 보여야 합니다.

### 4-4. 그 다음 배포부터

```sh
npm run deploy
```

비밀키는 이전 값이 유지됩니다. 비밀키만 바꾸려면 `npx wrangler secret put SAVE_SECRET`(입력 프롬프트에 붙여 넣기).
**주의:** 이것도 새 버전 배포라서 접속 중인 방이 끊깁니다(자동 재접속).

> 배포하면 깨어 있는 방은 최대 5분 안에 재시작되며 접속이 한 번 끊깁니다. 진행도는 유지됩니다. 사람이 적은 시간에 배포하세요.
> 급한 수정을 바로 반영하려면 `npx wrangler deploy --durable-objects-code-update-mode immediate`.

## 5. 출시 전 안전장치(꼭)

1. 대시보드 → **Workers & Pages → Plans** 에서 **Workers Paid($5/월)** 로 바꿉니다. 무료 플랜은 한도를 넘는 순간 접속이 실패합니다.
2. 대시보드 → **Billing → Spend limits** 에서 Workers 와 Durable Objects 각각 알림 이메일과 한도를 겁니다.
   (한도에 걸려도 이미 열린 WebSocket 메시지는 막지 못하므로 '브레이크'가 아니라 '경보'로 생각하세요.)
3. **접속 출처(`ALLOWED_ORIGINS`)** — 기본값(빈 값)은 '같은 주소에서 연 화면만' 받습니다. Worker 가 게임 화면까지 서빙하는
   기본 구성이면 아무것도 바꿀 필요가 없고, 남의 웹페이지가 내 서버를 끌어다 쓰는 것도 이미 막힙니다.
   화면을 다른 곳에 따로 올렸거나 `workers.dev` 와 내 도메인을 섞어 쓴다면 그 주소들을 쉼표로 적습니다:
   `"ALLOWED_ORIGINS": "https://doas-game.myname.workers.dev,https://play.example.com"` → 다시 `npm run deploy`.
   `"*"` 는 모든 사이트 허용(권하지 않음). Origin 헤더가 없는 점검 도구(`tools/wsprobe.ts` 등)는 어느 설정에서든 통과합니다.
4. **남용 방지 값** — `vars` 의 `MAX_PRE_HELLO`(방 하나에서 인사 전 연결 상한, 기본 8)와 `MAX_CONNS_PER_IP`(IP 하나가 방 하나에
   동시에 여는 연결 수, 기본 0 = 끔). IP 상한은 `CF-Connecting-IP`(Cloudflare 가 붙이는 진짜 접속 주소)로 셉니다.
   학교·회사처럼 여러 명이 한 IP 를 쓰는 곳이 있으니 켠다면 넉넉하게(예: 10).
5. **보안 헤더** — 게임 화면에는 `client/public/_headers` 의 CSP·Referrer-Policy·Permissions-Policy 가 붙습니다(Node 서버와 같은 값).
   게임 포털에 iframe 으로 올려야 한다면 그 파일의 `frame-ancestors 'self'` 뒤에 포털 주소를 더하고 다시 배포합니다.

## 6. 운영

### 화면(클라이언트)을 다른 곳에 따로 올린 경우

게임 화면을 GitHub Pages 같은 정적 호스팅에 올리고, Cloudflare 는 실시간 서버로만 쓸 수 있습니다.

1. 빌드된 `dist/client/config.js`(원본은 `client/public/config.js`)를 열어 서버 주소를 적습니다:
   ```js
   window.DOAS_CONFIG = {
     server: 'https://doas-game.myname.workers.dev',   // https → wss 는 자동
   }
   ```
2. `dist/client` 폴더를 정적 호스팅에 올립니다.
3. `wrangler.jsonc` 의 `ALLOWED_ORIGINS` 에 그 정적 호스팅 주소를 넣고 배포합니다.
4. (선택) Cloudflare 쪽에서 화면을 서빙하지 않으려면 `wrangler.jsonc` 의 `"assets"` 블록을 통째로 지웁니다.
   그러면 `npm run build:client` 없이 `npx wrangler deploy` 만으로 배포됩니다.

빠른 확인: 정적 페이지 주소 뒤에 `?server=https://doas-game.myname.workers.dev` 를 붙여 열면 `config.js` 를 고치지 않고도 연결해 볼 수 있습니다.

### 내 도메인 연결

1. 도메인을 Cloudflare 에 추가합니다(대시보드 → **Add a domain**, 안내대로 네임서버 변경).
2. `wrangler.jsonc` 에 추가하고 배포:
   ```jsonc
   "routes": [{ "pattern": "play.example.com", "custom_domain": true }]
   ```
3. 화면도 이 Worker 가 서빙한다면 그대로 됩니다(같은 주소). `workers.dev` 주소로도 계속 열게 하려면 두 주소를 `ALLOWED_ORIGINS` 에 적고,
   화면을 따로 올렸다면 클라이언트의 서버 주소(`config.js`)와 `ALLOWED_ORIGINS` 를 새 도메인으로 맞춥니다.
   (Cloudflare 문서는 프로덕션을 `workers.dev` 대신 내 도메인에 두라고 권합니다. `workers.dev` 는 자동 봇 검사를 끌 수 없습니다.)

### 로그 보기

- 실시간: `worker` 폴더에서 `npx wrangler tail` (WebSocket 요청의 로그는 그 연결이 끊긴 뒤에 표시됩니다).
- 대시보드 → **Workers & Pages → doas-game → Logs**. 설정에서 WebSocket 메시지마다 로그가 쌓이지 않게(`invocation_logs: false`) 해 두었습니다 — 로그도 과금 대상입니다.
- 사용량: 대시보드 → **Workers & Pages → Durable Objects** 에서 요청 수와 duration(GB-s) 그래프를 봅니다.

### 방 늘리기

`wrangler.jsonc` 의 `vars` 에서 `ROOMS`(기본 방 수)나 `MAX_ROOMS`(붐빌 때 자동으로 늘어날 상한)를 올리고 `npm run deploy`.
방은 사람이 처음 들어올 때 만들어지고, 비면 잠들어 돈이 들지 않습니다.

### 되돌리기

`npx wrangler rollback` — 직전 버전으로 돌아갑니다. (Durable Object 종류를 바꾼 배포보다 이전으로는 못 돌아갑니다.)

---

## 7. 한도와 비용(추정)

> 아래 숫자는 2026-11 시점 공식 요금표로 계산한 **추정**입니다. 실제 청구액은 대시보드에서 확인하세요.
> 요금표가 바뀔 수 있으니 https://developers.cloudflare.com/durable-objects/platform/pricing/ 를 함께 보세요.

### 무엇에 돈이 드나

| 항목 | 무료 플랜 | 유료 플랜(월 $5 기본) |
|---|---|---|
| DO 요청 (접속 1회, **받은** 메시지 20개당 1건, 로비 호출) | 하루 10만 건 | 월 100만 건 포함, 초과 100만 건당 $0.15 |
| DO duration (방이 깨어 있는 시간 × 128MB) | 하루 13,000 GB-s (= 방 약 28시간/일) | 월 40만 GB-s 포함(= 방 약 868시간/월), 초과 100만 GB-s 당 $12.50 |
| 정적 파일(게임 화면) | 무료·무제한 | 무료·무제한 |
| 보내는 메시지·데이터 전송량 | 무료 | 무료 |

- 방 하나가 1시간 깨어 있으면 약 **$0.00576**(3,600초 × 0.128GB = 460.8 GB-s).
- 플레이어 한 명이 1시간 내내 초당 10번 위치를 보내면 요청 1,800건 ≈ **$0.00027**.
- 사람이 없는 방은 잠들어 duration 이 0 입니다(이 어댑터는 마지막 연결이 끊기고, 잠깐 끊긴 채 자리를 지키던 사람(최대 15초)까지 정리되면 틱 타이머를 지웁니다).

### 견적 예시

가정: 사람이 있는 방만 깨어 있음, 클라이언트는 움직이는 동안 초당 10번 + 4초마다 ping 전송, 플레이 시간의 절반은 움직임, 한 달 30일.

| 시나리오 | 월 예상 비용 |
|---|---|
| **A1.** 방 3개, 방마다 평균 5명, 하루 4시간 | **약 $5.15** (기본료 $5 포함). 무료 플랜이라면 일일 한도의 약 59%(요청)·43%(duration) — 한 번 공유돼 몰리면 넘칩니다 |
| A2. 방 3개에 하루 종일 누군가 있음(방마다 5명) | **약 $19** (무료 플랜으로는 불가) |
| **B1.** 방 100개 × 20명, 하루 8시간 | **약 $212** (이 중 $137.50 은 '방이 깨어 있는 시간' 값) |
| B2. B1 과 같은데 모두가 계속 움직임(최악) | 약 $277 |
| B3. B1 에서 클라이언트 전송을 초당 5번으로 줄임 | 약 $179 |

### 비용을 줄이는 방법

1. **빈 방 재우기** — 이미 들어 있습니다.
2. **붐비는 방부터 채우기** — 자동 배정(`room=auto`)이 이미 그렇게 합니다. 사람을 흩어 놓을수록 깨어 있는 방이 늘어납니다.
3. **자리 비움 내보내기** — 탭만 열어 둔 한 명이 방 하나를 한 달 내내 깨워 두면 약 $4.15 입니다.
4. **Spend limits 알림** — 5장 참고.

### 그 밖의 한도(문서 기준)

- 방(DO) 하나가 처리하는 요청은 초당 약 1,000건이 권장 상한입니다. 20명 × 10Hz = 200건이라 여유가 있습니다.
- WebSocket 닫기 사유 문자열은 123바이트까지(코드에서 처리함).
- 방의 메모리 상태(NPC 위치, 진행 중인 배틀 등)는 방이 비거나 배포·런타임 업데이트 때 사라집니다. 플레이어 진행도와 교단 기록은 남습니다.
- 접속자 메모(쿨타임·차단·입막음·이름 고정·마지막 자리·나가기 직전 60초의 진행도)는 방 DO 의 저장소에 5초마다(바뀐 것이 있을 때만)와 마지막 사람이 나갈 때 쓰고,
  방이 깨어날 때 읽습니다. 방 하나에 최대 3,000명분, 기한이 지난 것은 저장하지 않습니다. 저장 1회 = DO 저장소 쓰기 1건(요금표의 storage 항목).

---

## 8. 자주 겪는 문제

| 증상 | 원인과 해결 |
|---|---|
| `npm install` 이 Node 버전 오류 | Node 22.12 이상으로 올리세요 |
| 배포가 `SAVE_SECRET` 이 없다며 실패 | 4-2, 4-3 을 따라 `--secrets-file` 로 첫 배포를 하거나 `npx wrangler secret put SAVE_SECRET` |
| 접속하면 "서버 설정 오류"(503) | 비밀키가 비어 있습니다. 위와 같음 |
| `assets directory ... does not exist` | 먼저 저장소 루트에서 `npm run build:client` (또는 화면을 따로 호스팅한다면 `assets` 블록 삭제) |
| 다른 사이트에 올린 화면에서 접속이 거부(403) | 기본값은 같은 주소만 받습니다. `ALLOWED_ORIGINS` 에 그 사이트 주소(https://… , 끝에 / 없이)를 넣고 재배포 |
| 같은 IP 의 여러 명이 접속 실패(429) | `MAX_CONNS_PER_IP` 가 너무 낮습니다. 올리거나 0(끔)으로 |
| 배포 직후 모두 한 번 끊김 | 정상 동작입니다(4-4 참고). 클라이언트가 자동으로 다시 들어옵니다 |
| 무료 플랜에서 갑자기 접속 실패 | 일일 한도 초과. 한국 시간 오전 9시에 풀립니다. 유료 플랜으로 바꾸세요 |
