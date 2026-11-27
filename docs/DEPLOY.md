# 배포 안내서

> 이 문서의 절차 가운데 **이 저장소 안에서 직접 확인한 것**은 로컬 실행(`npm run build && npm start`)과 그 위에서의 접속·동기화 검증,
> 서버 수명 시험(`tests/e2e/ops.cjs`: SIGTERM 뒤 자동 재접속·진행도 유지, `kill -9` 뒤 재시작, 쓸 수 없는 `DATA_DIR`·두 번째 프로세스 → exit 1,
> 깨진 교단 기록 보존), 보안 헤더 아래 PC·휴대폰 전체 플레이(`tests/e2e/csp.cjs`)입니다. Render·Fly.io·VPS 에 실제로 올려 보지는 못했습니다(호스팅 계정이 없었습니다). 호스팅별 요금·제한은 `docs/research/07-hosting.md` 의 조사(2026-11 기준)를 따랐으니, 올리기 전에 각 서비스의 현재 안내를 한 번 확인하세요.

## 0. 구조 한눈에

게임은 두 부분입니다.

| 부분 | 내용 | 필요한 것 |
|---|---|---|
| 클라이언트 | `dist/client` 의 정적 파일(HTML/JS/CSS). 이미지·모델·음원 파일 없음 | 아무 정적 호스팅 |
| 실시간 서버 | 방 상태를 메모리에 들고 WebSocket 으로 동기화하는 **계속 켜져 있는 프로세스** | Node 를 계속 돌릴 수 있는 곳(또는 Cloudflare Workers + Durable Objects) |

**Node 버전:** 빌드(`npm ci && npm run build`)에는 **Node 22.12 이상**이 필요합니다(Vite·Vitest 등 빌드 도구의 요구). 빌드된 서버(`dist/server/main.js`)를 실행만 하는 것은 Node 20 이상이면 됩니다.

그래서 배포 모양은 둘 중 하나입니다.

- **A. 한 서버에 전부** — Node 서버가 클라이언트 파일도 함께 내줍니다. 가장 간단합니다.
- **B. 클라이언트와 서버를 따로** — 클라이언트는 아무 정적 호스팅에 올리고, 실시간 서버는 다른 곳에 둡니다. 클라이언트의 `config.js` 한 줄로 서버 주소를 가리킵니다.

특별한 이유가 없으면 **A** 를 쓰세요. 이 게임은 다른 플랫폼에 기대지 않고 Node 서버 하나로 완결됩니다. B 는 이미 쓰는 홈페이지에 화면만 붙이고 싶거나, 정적 파일 전송량을 서버에서 빼고 싶을 때만 필요합니다.

## 1. 로컬에서 실행(확인된 절차)

```bash
npm ci
npm run build          # dist/client + dist/server/main.js
npm start              # http://localhost:8787  (= node --enable-source-maps dist/server/main.js)
```

- 개발 모드: `npm run dev` (서버 8787 + Vite 5173, 저장하면 자동 반영)
- 확인: 브라우저 두 개(또는 일반 창 + 시크릿 창)로 접속하면 서로의 캐릭터가 보여야 합니다. `http://localhost:8787/healthz` 는 서버 상태를, `/api/rooms` 는 방별 **실제 접속자 수와 NPC 수**를 따로 알려 줍니다.

## 2. 환경변수

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `PORT` | 8787 | 서버 포트 |
| `HOST` | (전체) | 바인드 주소 |
| `ROOMS` | 3 | 처음 만들어 둘 방 수 |
| `MAX_ROOMS` | `ROOMS` 와 같음 | 자동 증설 상한. `ROOMS` 보다 크면 모든 방이 80% 이상 찼을 때 방을 하나씩 더 만든다 |
| `ROOM_CAPACITY` | 20 | 방 정원(실제 접속자) |
| `NPCS` | 28 | 방마다 NPC 시민 수 |
| `SAVE_SECRET` | 없으면 `DATA_DIR/secret` 에 자동 생성 | 진행도 서명 키. **한 번 정하면 바꾸지 마세요.** 바뀌면 모든 이용자의 진행도가 처음부터 다시 시작됩니다. 지정하지 않았는데 `secret` 파일을 읽거나 만들 수 없으면(또는 16자보다 짧으면) 서버는 한 줄 이유를 남기고 **시작하지 않습니다**(exit 1) — 재시작마다 진행도가 조용히 사라지는 것을 막기 위해서입니다 |
| `DATA_DIR` | `.data` | 서명 키(`secret`), 교단 기록(`cults.json`, 바로 전 것 `cults.json.bak`), 잠금(`server.lock`)이 저장되는 폴더. 부팅 때 실제로 써 보고, 쓸 수 없으면 exit 1. **한 폴더에는 서버 하나만**: 두 번째 프로세스는 잠금을 보고 exit 1 합니다(§8) |
| `CLIENT_DIR` | `dist/client` | 서버가 내줄 클라이언트 파일 위치. 클라이언트를 따로 올리면 없어도 됩니다 |
| `ALLOWED_ORIGINS` | (같은 출처만) | WebSocket 접속을 받을 화면 주소(Origin). **비우면 이 서버와 같은 주소에서 연 화면만** 받습니다(요청의 `Host`, `TRUST_PROXY` 가 1 이상이면 `X-Forwarded-Host` 와 비교). 화면을 다른 곳에 따로 올렸다면 그 주소를 쉼표로: `https://play.example.com,https://example.github.io`. `*` 는 모든 사이트 허용(예전 동작). Origin 헤더가 없는 도구(`tools/wsprobe.ts`, `tools/loadtest.ts`)는 어느 설정에서든 통과합니다 |
| `FRAME_ANCESTORS` | `'self'` | 이 게임을 `<iframe>` 으로 품을 수 있는 사이트(CSP `frame-ancestors`). 게임 포털에 올릴 때만 공백으로 더합니다. 예: `'self' https://portal.example`. 세미콜론 등 출처에 쓰지 않는 문자가 섞이면 무시하고 기본값을 씁니다 |
| `MAX_PRE_HELLO` | 64 | 접속만 하고 입장 인사를 보내지 않은 연결의 최대 수. 넘으면 가장 오래된 것부터 끊는다(빈 연결로 방을 '가득 참'으로 만드는 것 방지) |
| `MAX_CONNS_PER_IP` | 0 (끔) | 한 IP 가 동시에 열 수 있는 연결 수. 학교·회사처럼 여러 사람이 한 IP 를 쓰는 곳이 있으니 켠다면 넉넉하게(예: 30) |
| `TRUST_PROXY` | 0 | 서버 앞에 있는 리버스 프록시의 단계 수. 1 이상이면 `X-Forwarded-For` 에서 그만큼 거슬러 올라간 주소를 접속자 IP 로, `X-Forwarded-Host` 를 같은 출처 판단에 씁니다. **프록시가 없는데 켜면 IP 를 속일 수 있으니** 실제 구성과 맞게만 설정. 반대로 프록시 뒤에서 0 이면 모든 접속자가 `127.0.0.1` 로 보여 `MAX_CONNS_PER_IP` 가 모두를 막습니다 |

빌드할 때 쓰는 값(서버 실행 환경변수가 아님)

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `PUBLIC_URL` | (없음) | 게임이 열릴 주소. 예: `PUBLIC_URL=https://game.example.com npm run build`. 주면 링크 미리보기의 `og:image` 가 절대 주소(`…/og.jpg`)가 되고 `og:url` 이 붙습니다(카카오톡·페이스북·X·슬랙 등은 절대 주소만 읽습니다). 없으면 상대 주소로 빌드되어 어디에 올려도 동작하지만 일부 메신저에서 미리보기 그림이 빠집니다 |
| `VITE_SERVER_URL` | (없음) | 클라이언트를 따로 올릴 때 실시간 서버 주소(§4) |

재배포할 때마다 디스크가 비워지는 호스팅에서는 `SAVE_SECRET` 을 환경변수로 **반드시** 고정하세요. 교단 순위 기록(`cults.json`)은 영구 디스크가 있어야 남습니다.

진행도는 서버 DB 가 아니라 **이용자 브라우저**에 서명된 채로 저장됩니다(회원가입 없음). 이용자가 브라우저 데이터를 지우거나 기기를 바꾸면 이어지지 않습니다.

## 3. 배포 모양 A — 한 서버에 전부

### 3.1 가장 쉬운 길: Render

1. render.com 에 GitHub 계정으로 가입합니다.
2. **New → Blueprint** 로 이 저장소를 고르면 루트의 `render.yaml` 을 읽습니다. (직접 만들려면 New → Web Service: Build `npm ci --include=dev && npm run build`, Start **`node --enable-source-maps dist/server/main.js`**, Health Check Path `/healthz`, Region Singapore)
   - Start 에 `npm start` 를 쓰지 마세요. 종료 신호(SIGTERM)가 npm 에서 멈춰 node 까지 가지 않아, 접속자 안내·마지막 저장 없이 끊기고 node 가 고아로 남을 수 있습니다.
3. `ALLOWED_ORIGINS` 는 비워 둡니다(같은 주소만 허용). 화면을 다른 곳에 따로 올렸을 때만 그 주소를 넣습니다. `SAVE_SECRET` 은 자동 생성됩니다.
   링크 미리보기를 완전하게 하려면 환경변수 `PUBLIC_URL=https://<이름>.onrender.com` 을 더합니다(빌드 때 읽힘).
4. 배포가 끝나면 그 주소로 접속합니다.

알아 둘 점(조사 기준): 무료 인스턴스는 일정 시간 접속이 없으면 잠들고 깨어나는 데 1분쯤 걸리며, 디스크가 임시라 교단 기록이 비워집니다. 시험·지인 공유용으로 적당합니다. **인스턴스 수는 1로 고정**해야 합니다.

### 3.2 한국에서 가장 빠른 길: 서울 리전 VPS

지연이 가장 짧습니다(서울 안에서 수 ms). 서버 관리를 직접 해야 합니다.

```bash
# Ubuntu 기준. Node 22.12 이상(빌드 도구 요구)과 git 설치 후
git clone <이 저장소 주소> doas && cd doas
npm ci && PUBLIC_URL=https://game.example.com npm run build
# 서비스 등록(systemd)
sudo tee /etc/systemd/system/doas.service >/dev/null <<'UNIT'
[Unit]
Description=DOAS game server
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/doas
ExecStart=/usr/bin/node --enable-source-maps dist/server/main.js
Environment=PORT=8787
# 프록시(Caddy)를 거쳐서만 들어오게 바깥에서 8787 을 막는다
Environment=HOST=127.0.0.1
Environment=DATA_DIR=/home/ubuntu/doas-data
Environment=SAVE_SECRET=여기에_바꾸지_않을_무작위_문자열
# 아래 Caddy 한 단계 뒤에 있다. 프록시 없이 바로 열 때는 이 줄을 지운다(켜 두면 IP 를 속일 수 있다)
Environment=TRUST_PROXY=1
Restart=always
# 종료 신호를 받으면 접속자에게 알리고 기록을 저장한 뒤 1초 안에 끝난다
KillSignal=SIGTERM
TimeoutStopSec=10
User=ubuntu
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now doas
```

HTTPS 는 Caddy 같은 리버스 프록시를 앞에 두면 인증서가 자동으로 발급됩니다(WebSocket 도 그대로 통과).
Caddy 는 원래 `Host` 를 그대로 넘기므로 `ALLOWED_ORIGINS` 를 비워 둬도 `https://game.example.com` 에서 연 화면이 접속됩니다.
**`TRUST_PROXY=1` 을 꼭 같이 두세요.** 없으면 서버에는 모든 접속자가 `127.0.0.1` 로 보이고, `MAX_CONNS_PER_IP` 를 켜는 순간 모두가 막힙니다.

```
# /etc/caddy/Caddyfile
game.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### 3.3 Docker / Fly.io

- `Dockerfile` 이 들어 있습니다. `docker build -t doas . && docker run -p 8787:8787 -e SAVE_SECRET=... -v doas-data:/data doas`
  - **이 환경에는 Docker 데몬이 없어 이미지를 실제로 빌드해 보지 못했습니다.** 처음 빌드할 때 오류가 나면 알려 주세요.
  - 컨테이너는 `node` 사용자(uid 1000)로 돕니다. 이름 있는 볼륨(`-v doas-data:/data`)은 알아서 맞지만, 호스트 폴더를 붙일 때는(`-v /srv/doas:/data`) 먼저 `sudo chown 1000:1000 /srv/doas`. 쓸 수 없으면 서버가 시작하지 않고 로그에 한 줄 이유를 남깁니다.
  - `ALLOWED_ORIGINS` 는 비워 두면 같은 주소만 허용합니다. 다른 곳에 올린 화면이 있으면 `-e ALLOWED_ORIGINS=https://play.example.com`. 앞에 리버스 프록시가 있으면 `-e TRUST_PROXY=1`.
  - 헬스 체크는 `/healthz` 를 부르고, 저장이 실패하는 동안(503) 컨테이너가 unhealthy 로 표시됩니다.
  - `.env*`, `.dev.vars` 같은 비밀 파일은 `.dockerignore` 로 빌드 컨텍스트에서 빠집니다.
- Fly.io: `fly.toml` 참고(도쿄 리전, 볼륨 `/data`). `fly launch --copy-config --no-deploy` → `fly volumes create doas_data --region nrt --size 1` → `fly secrets set SAVE_SECRET=...` → **`fly deploy --ha=false`**.
  - 머신은 반드시 1대입니다. Fly 는 기본으로 머신 2대를 만들기 때문에 `--ha=false` 를 붙이고, 이미 2대라면 `fly scale count 1`. `fly scale count` 를 1보다 크게 하지 마세요(방이 둘로 갈라집니다). 볼륨을 하나만 만들어 두면 두 번째 머신이 뜰 수 없어 안전장치가 됩니다.

## 4. 배포 모양 B — 클라이언트 따로, 서버 따로

1. 실시간 서버를 §3 의 방법 중 하나(또는 Cloudflare, §5)로 올리고 주소를 확보합니다. 예: `https://doas-server.example.com`
2. 클라이언트를 빌드합니다: `npm run build:client` → `dist/client` 폴더 전체를 정적 호스팅에 올립니다.
3. 올린 파일 중 `config.js` 를 열어 서버 주소를 적습니다(다시 빌드할 필요 없음).

   ```js
   window.DOAS_CONFIG = {
     server: 'https://doas-server.example.com',
   }
   ```

   빌드할 때 정하고 싶으면 `VITE_SERVER_URL=https://doas-server.example.com npm run build:client`.
4. 서버의 `ALLOWED_ORIGINS` 에 클라이언트 주소(예: `https://내사이트.example.com`)를 넣습니다. **이 경우는 필수입니다**(기본값은 서버와 같은 주소만 허용).

꼭 지킬 것 세 가지

- 클라이언트가 `https` 로 열리면 서버 주소도 **반드시 `https`(→ 자동으로 `wss`)** 여야 합니다. `http` 서버에는 브라우저가 접속을 막습니다.
- WebSocket 에는 CORS 가 적용되지 않으므로 서버가 `Origin` 을 직접 검사합니다(`ALLOWED_ORIGINS`).
- 방 목록(`/api/rooms`)은 다른 출처에서 읽을 수 있게 열려 있습니다.

## 5. Cloudflare Workers + Durable Objects

Node 서버를 둘 곳이 마땅치 않을 때의 대안입니다. 같은 방 로직(`server/core`)을 Durable Object 위에서 돌리는 어댑터가 `worker/` 에 있습니다. 계정 준비·배포 명령·비밀 값 설정·요금 추정·제약은 **`docs/DEPLOY-CLOUDFLARE.md`** 에 따로 정리했습니다.

## 6. 올린 뒤 점검

- `https://<주소>/healthz` → `{"ok":true, "persist":{"ok":true,"lastCultSaveAt":…,"lastError":null}, "rooms":3, "players":0, ...}`
  - `persist.ok` 가 false 이면(디스크가 가득 찼거나 권한이 바뀌어 저장이 안 됨) 응답이 **503** 이 되고 `lastError` 에 이유가 나옵니다. 호스팅의 헬스 체크가 이것으로 알립니다.
- `https://<주소>/api/rooms` → 방 3개, 각 방의 `players`(실제 접속자)와 `npcs` 가 따로 나옴
- 휴대폰과 PC 로 같은 방에 들어가 서로 보이는지, 한쪽이 움직이면 다른 쪽에 보이는지 확인
- 서버를 재시작해도 열려 있던 브라우저가 자동으로 다시 붙고 신도 수가 유지되는지 확인(`SAVE_SECRET` 고정 여부 점검)

## 7. 규모를 키울 때

`docs/LOADTEST.md` 에 이 저장소의 서버를 실제로 부하 측정한 결과가 있습니다. 요약: 프로세스 1개로 방 100개 × 20명(봇 2,000명)까지 무탈락으로 돌았고, 150방 근처에서 CPU 코어 하나가 가득 찹니다. 그 이상은 프로세스·서버를 늘리고 방 번호로 나눠야 하며, 그 분배기는 아직 구현돼 있지 않습니다. 실제 인터넷과 실제 휴대폰에서의 수치는 올린 뒤 직접 재야 합니다.

## 8. 로그·데이터 파일·보안 헤더

### 로그

서버 로그는 **한 줄에 JSON 하나**입니다(표준 출력: info, 표준 오류: warn·error). 호스팅의 로그 검색, `grep`, `jq`, 로그 수집기가 항목을 쪼개지 않습니다.

```json
{"ts":"2026-11-27T04:49:18.322Z","level":"info","msg":"listening on http://localhost:8787","data":{"port":8787,"rooms":3,…}}
{"ts":"…","level":"warn","msg":"report","data":{"room":"1","why":"abuse","target":"p_3f9a…","targetName":"수상한교주123","by":"p_aa11…"}}
{"ts":"…","level":"error","msg":"[방 1] 틱 예외","err":"…","stack":"…(원본 .ts 파일 위치)"}
```

- **담기는 개인 정보:** 신고 줄(`"msg":"report"`)에만 기기 id(`target`, `by` — 브라우저에 저장된 무작위 값)와 닉네임(`targetName`)이 들어갑니다. **IP 주소는 어떤 줄에도 남기지 않습니다.** 그 밖의 줄은 방 번호·연결 번호·오류 내용뿐입니다.
- **신고 모아 보기:** systemd 는 `journalctl -u doas | grep '"msg":"report"'`, jq 가 있으면 `journalctl -u doas -o cat | jq -c 'select(.msg=="report") | .data'`. Docker 는 `docker logs <컨테이너> 2>&1 | grep '"msg":"report"'`. 신고 줄은 양 제한에 걸리지 않습니다.
- **양 제한:** 오류는 10초에 50줄, 경고는 100줄까지 쓰고 나머지는 `"같은 기간 … 생략"` 한 줄로 셉니다. 잘못된 프레임·상한을 넘는 프레임 같은 소켓 오류는 연결마다 쓰지 않고 10초마다 `"소켓 오류(10초 요약)"` 한 줄에 종류별 건수로 묶습니다(누구나 일으킬 수 있어서).
- 오류 위치(`stack`)가 번들이 아니라 원본 파일로 나오도록 `--enable-source-maps` 로 실행합니다(`npm start`, Dockerfile, `render.yaml`, 위 systemd 예시 모두 그렇게 되어 있습니다).

### `DATA_DIR` 안의 파일

| 파일 | 내용 | 지워도 되나 |
|---|---|---|
| `secret` | 저장본 서명 키(`SAVE_SECRET` 을 안 줬을 때) | **안 됨** — 모든 이용자의 진행도가 무효가 됩니다. 백업 대상 |
| `cults.json` | 교단 순위 기록. 30초마다, 그리고 종료 때 저장 | 지우면 순위가 비워집니다 |
| `cults.json.bak` | 바로 전 저장본. `cults.json` 이 없거나 깨졌으면 부팅 때 이것을 읽습니다 | 됨 |
| `cults.json.corrupt-<시각>` | 부팅 때 읽을 수 없던(깨진) 기록을 지우지 않고 옮겨 둔 것. 로그에 `corrupt-` 가 찍힙니다 | 살펴본 뒤 됨 |
| `server.lock` | 이 폴더를 쓰는 서버의 pid·호스트 이름. 30초마다 갱신, 정상 종료 때 지움 | 서버가 꺼져 있을 때만 |

- 같은 `DATA_DIR` 에 서버가 둘 뜨면 두 번째는 `다른 서버 프로세스가 DATA_DIR(…)를 쓰고 있습니다` 한 줄을 남기고 exit 1 합니다(서로의 기록을 덮어쓰지 않게). `kill -9`·정전으로 잠금이 남아도, 같은 기계에서 그 pid 가 죽었거나 90초 넘게 갱신되지 않았으면 다음 부팅이 알아서 가져갑니다(Docker 컨테이너를 새로 만들어 호스트 이름이 바뀐 경우는 최대 90초 기다린 뒤 재시작 정책으로 뜹니다).
- 기록은 '프로세스별 임시 파일에 쓰고 디스크에 확정(fsync) → 이전 파일을 `.bak` 으로 → 새 파일로 이름 바꾸기' 순서라, 어느 순간 꺼져도 둘 중 하나는 온전합니다.
- 돌던 중 저장이 실패하면(디스크 가득 참, 권한 변경) 오류 줄을 남기고 `/healthz` 가 503 이 됩니다. 다음 주기에 다시 시도하고, 성공하면 저절로 200 으로 돌아옵니다.

### 보안 헤더

HTML 응답에는 다음이 붙습니다(Cloudflare 정적 자산은 `client/public/_headers` 로 같은 값).

- `Content-Security-Policy`: 스크립트는 같은 출처 파일만(인라인 스크립트 없음), 스타일은 인라인 허용, 이미지는 `data:`·`blob:`(공유 카드), 접속은 같은 출처·`ws:`·`wss:`·`https:`(실시간 서버를 따로 둘 수 있게), `frame-ancestors` 는 `FRAME_ANCESTORS`(기본 `'self'`).
- `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`(카메라·마이크·위치 등 끔).
- `/assets/` 아래의 없는 파일은 404 입니다(게임 화면을 대신 내주지 않으므로 낡은 탭이 HTML 을 영구 캐시하지 않습니다).
- 압축은 브라우저가 받겠다고 한 것만 보냅니다(`Accept-Encoding` 의 `q=0` 은 거절로 봅니다).

## 9. 라이선스 고지

함께 배포되는 three.js·ws 의 MIT 고지는 저장소 루트의 `THIRD_PARTY_LICENSES.txt` 에 있고, 빌드 때 `dist/client/THIRD_PARTY_LICENSES.txt` 로 복사되어 `https://<주소>/THIRD_PARTY_LICENSES.txt` 로 열립니다. 의존성을 올리면 이 파일의 버전·고지문을 `node_modules/<이름>/LICENSE` 와 맞춰 주세요. 이 게임 자체의 라이선스는 저장소 주인이 정합니다.

## 10. 홈 화면에 추가 · 링크 미리보기

- `manifest.webmanifest` 와 아이콘(`client/public/icons/`)이 들어 있어 휴대폰의 '홈 화면에 추가'가 게임 아이콘과 전체 화면으로 동작합니다. 아이콘은 `node tools/make-media.cjs --icons` 로 다시 그립니다(외부 그림 없이 SVG 로 그림).
- 링크 미리보기 그림은 `client/public/og.jpg`(1200×630). 메신저가 그림을 읽게 하려면 빌드 때 `PUBLIC_URL` 을 주세요(§2).
- three.js 는 별도 파일(`assets/three-<해시>.js`)로 나갑니다. 게임 코드만 바뀐 배포에서는 이 파일 이름이 그대로라, 다시 찾아온 플레이어는 게임 코드(약 180KB gzip)만 새로 받습니다.
