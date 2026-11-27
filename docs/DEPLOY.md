# 배포 안내서

> 이 문서의 절차 가운데 **이 저장소 안에서 직접 확인한 것**은 로컬 실행(`npm run build && npm start`)과 그 위에서의 접속·동기화 검증입니다. Render·Fly.io·VPS 에 실제로 올려 보지는 못했습니다(호스팅 계정이 없었습니다). 호스팅별 요금·제한은 `docs/research/07-hosting-and-foundry.md` 의 조사(2026-11 기준)를 따랐으니, 올리기 전에 각 서비스의 현재 안내를 한 번 확인하세요.

## 0. 구조 한눈에

게임은 두 부분입니다.

| 부분 | 내용 | 필요한 것 |
|---|---|---|
| 클라이언트 | `dist/client` 의 정적 파일(HTML/JS/CSS). 이미지·모델·음원 파일 없음 | 아무 정적 호스팅 |
| 실시간 서버 | 방 상태를 메모리에 들고 WebSocket 으로 동기화하는 **계속 켜져 있는 프로세스** | Node 20+ 를 계속 돌릴 수 있는 곳(또는 Cloudflare Workers + Durable Objects) |

그래서 배포 모양은 둘 중 하나입니다.

- **A. 한 서버에 전부** — Node 서버가 클라이언트 파일도 함께 내줍니다. 가장 간단합니다.
- **B. 클라이언트와 서버를 따로** — 클라이언트는 정적 호스팅(말씀하신 "파운더리"가 정적 파일만 올릴 수 있는 곳이라면 여기에 해당)에 올리고, 실시간 서버는 다른 곳에 둡니다. 클라이언트의 `config.js` 한 줄로 서버 주소를 가리킵니다.

"파운더리"가 Node 프로세스를 계속 켜 둘 수 있고 WebSocket 을 지원한다면 A 를 그대로 쓰면 됩니다. 요청마다 잠깐 뜨는 함수(서버리스)만 된다면 방 서버를 올릴 수 없으므로 B 로 가야 합니다.

## 1. 로컬에서 실행(확인된 절차)

```bash
npm ci
npm run build          # dist/client + dist/server/main.js
npm start              # http://localhost:8787
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
| `SAVE_SECRET` | 없으면 `DATA_DIR/secret` 에 자동 생성 | 진행도 서명 키. **한 번 정하면 바꾸지 마세요.** 바뀌면 모든 이용자의 진행도가 처음부터 다시 시작됩니다 |
| `DATA_DIR` | `.data` | 서명 키(`secret`)와 교단 기록(`cults.json`)이 저장되는 폴더 |
| `CLIENT_DIR` | `dist/client` | 서버가 내줄 클라이언트 파일 위치. 클라이언트를 따로 올리면 없어도 됩니다 |
| `ALLOWED_ORIGINS` | (전부 허용) | WebSocket 접속을 허용할 출처, 쉼표로 구분. 예: `https://game.example.com` |
| `MAX_PRE_HELLO` | 64 | 접속만 하고 입장 인사를 보내지 않은 연결의 최대 수. 넘으면 가장 오래된 것부터 끊는다(빈 연결로 방을 '가득 참'으로 만드는 것 방지) |
| `MAX_CONNS_PER_IP` | 0 (끔) | 한 IP 가 동시에 열 수 있는 연결 수. 학교·회사처럼 여러 사람이 한 IP 를 쓰는 곳이 있으니 켠다면 넉넉하게(예: 30) |
| `TRUST_PROXY` | 0 | 서버 앞에 있는 리버스 프록시의 단계 수. 1 이상이면 `X-Forwarded-For` 에서 그만큼 거슬러 올라간 주소를 접속자 IP 로 본다. **프록시가 없는데 켜면 IP 를 속일 수 있으니** 실제 구성과 맞게만 설정 |

재배포할 때마다 디스크가 비워지는 호스팅에서는 `SAVE_SECRET` 을 환경변수로 **반드시** 고정하세요. 교단 순위 기록(`cults.json`)은 영구 디스크가 있어야 남습니다.

진행도는 서버 DB 가 아니라 **이용자 브라우저**에 서명된 채로 저장됩니다(회원가입 없음). 이용자가 브라우저 데이터를 지우거나 기기를 바꾸면 이어지지 않습니다.

## 3. 배포 모양 A — 한 서버에 전부

### 3.1 가장 쉬운 길: Render

1. render.com 에 GitHub 계정으로 가입합니다.
2. **New → Blueprint** 로 이 저장소를 고르면 루트의 `render.yaml` 을 읽습니다. (직접 만들려면 New → Web Service: Build `npm ci --include=dev && npm run build`, Start `npm start`, Health Check Path `/healthz`, Region Singapore)
3. `ALLOWED_ORIGINS` 에 발급된 주소(`https://<이름>.onrender.com`)를 넣습니다. `SAVE_SECRET` 은 자동 생성됩니다.
4. 배포가 끝나면 그 주소로 접속합니다.

알아 둘 점(조사 기준): 무료 인스턴스는 일정 시간 접속이 없으면 잠들고 깨어나는 데 1분쯤 걸리며, 디스크가 임시라 교단 기록이 비워집니다. 시험·지인 공유용으로 적당합니다. **인스턴스 수는 1로 고정**해야 합니다.

### 3.2 한국에서 가장 빠른 길: 서울 리전 VPS

지연이 가장 짧습니다(서울 안에서 수 ms). 서버 관리를 직접 해야 합니다.

```bash
# Ubuntu 기준. Node 20 이상과 git 설치 후
git clone <이 저장소 주소> doas && cd doas
npm ci && npm run build
# 서비스 등록(systemd)
sudo tee /etc/systemd/system/doas.service >/dev/null <<'UNIT'
[Unit]
Description=DOAS game server
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/doas
ExecStart=/usr/bin/node dist/server/main.js
Environment=PORT=8787
Environment=DATA_DIR=/home/ubuntu/doas-data
Environment=SAVE_SECRET=여기에_바꾸지_않을_무작위_문자열
Environment=ALLOWED_ORIGINS=https://game.example.com
Restart=always
User=ubuntu
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now doas
```

HTTPS 는 Caddy 같은 리버스 프록시를 앞에 두면 인증서가 자동으로 발급됩니다(WebSocket 도 그대로 통과).

```
# /etc/caddy/Caddyfile
game.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### 3.3 Docker / Fly.io

- `Dockerfile` 이 들어 있습니다. `docker build -t doas . && docker run -p 8787:8787 -e SAVE_SECRET=... -v doas-data:/data doas`
  - **이 환경에는 Docker 데몬이 없어 이미지를 실제로 빌드해 보지 못했습니다.** 처음 빌드할 때 오류가 나면 알려 주세요.
- Fly.io: `fly.toml` 참고(도쿄 리전, 볼륨 `/data`, 머신 1대 고정). `fly launch --copy-config --no-deploy` → `fly volumes create doas_data --region nrt --size 1` → `fly secrets set SAVE_SECRET=...` → `fly deploy`.

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
4. 서버의 `ALLOWED_ORIGINS` 에 클라이언트 주소(예: `https://내사이트.example.com`)를 넣습니다.

꼭 지킬 것 세 가지

- 클라이언트가 `https` 로 열리면 서버 주소도 **반드시 `https`(→ 자동으로 `wss`)** 여야 합니다. `http` 서버에는 브라우저가 접속을 막습니다.
- WebSocket 에는 CORS 가 적용되지 않으므로 서버가 `Origin` 을 직접 검사합니다(`ALLOWED_ORIGINS`).
- 방 목록(`/api/rooms`)은 다른 출처에서 읽을 수 있게 열려 있습니다.

## 5. Cloudflare Workers + Durable Objects

Node 서버를 둘 곳이 마땅치 않을 때의 대안입니다. 같은 방 로직(`server/core`)을 Durable Object 위에서 돌리는 어댑터가 `worker/` 에 있습니다. 계정 준비·배포 명령·비밀 값 설정·요금 추정·제약은 **`docs/DEPLOY-CLOUDFLARE.md`** 에 따로 정리했습니다.

## 6. 올린 뒤 점검

- `https://<주소>/healthz` → `{"ok":true, "rooms":3, "players":0, ...}`
- `https://<주소>/api/rooms` → 방 3개, 각 방의 `players`(실제 접속자)와 `npcs` 가 따로 나옴
- 휴대폰과 PC 로 같은 방에 들어가 서로 보이는지, 한쪽이 움직이면 다른 쪽에 보이는지 확인
- 서버를 재시작해도 열려 있던 브라우저가 자동으로 다시 붙고 신도 수가 유지되는지 확인(`SAVE_SECRET` 고정 여부 점검)

## 7. 규모를 키울 때

`docs/LOADTEST.md` 에 이 저장소의 서버를 실제로 부하 측정한 결과가 있습니다. 요약: 프로세스 1개로 방 100개 × 20명(봇 2,000명)까지 무탈락으로 돌았고, 150방 근처에서 CPU 코어 하나가 가득 찹니다. 그 이상은 프로세스·서버를 늘리고 방 번호로 나눠야 하며, 그 분배기는 아직 구현돼 있지 않습니다. 실제 인터넷과 실제 휴대폰에서의 수치는 올린 뒤 직접 재야 합니다.
