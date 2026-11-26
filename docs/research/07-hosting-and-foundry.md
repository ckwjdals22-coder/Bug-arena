# 07. 어디에 올릴 것인가 — 호스팅 선택지와 "파운더리"의 정체

- 조사일: 2026-11-26
- 대상: "도를 아십니까? — 교주 시뮬레이터"의 Node 실시간 서버(프로세스 하나가 정적 파일 + `/api/rooms` + `/ws` 를 같이 서빙)와 정적 클라이언트를 어디에 올릴지
- 방법: 각 서비스의 공식 요금·문서 페이지를 2026-11-26에 직접 읽었다. Vultr는 웹 페이지가 막혀(403) 공개 API(`api.vultr.com/v2/plans`, `/v2/regions`)로 확인했다. 지연 시간은 cloudping.co의 공개 데이터(AWS 리전 간 p50, 최근 1주)를 내려받아 서울 행만 뽑았다. 브라우저 동작 두 가지(교차 출처 접속, https 페이지의 `ws://`)는 임시 폴더에서 `ws@8.23.0` + Playwright Chromium으로 직접 돌렸다.
- **하지 못한 것: 실제 계정을 만들어 배포해 보는 것.** 이 환경에는 어느 호스팅의 계정도 없다. 배포 절차는 문서 근거이고, Dockerfile은 Docker 데몬이 없어 빌드해 보지 못했다.
- Cloudflare Workers + Durable Objects는 `06-cloudflare-durable-objects.md`가 다룬다. 이 문서는 겹치는 내용을 반복하지 않는다.

## 근거 등급 표기

| 표기 | 의미 |
|---|---|
| **[문서]** | 해당 서비스의 공식 문서·요금 페이지를 2026-11-26에 직접 읽음(§6에 URL) |
| **[API]** | 공급자의 공개 API 응답으로 확인 |
| **[실측-로컬]** | 이 환경에서 직접 돌려 확인(Node 22.23.5, `ws` 8.23.0, Playwright Chromium) |
| **[데이터]** | 제3자 공개 측정 데이터를 내려받아 계산 |
| **[검색요약]** | 검색 결과 요약으로만 봄. 원문을 직접 확인하지 못함 |
| **[추정]** | 위 근거에서 내가 계산·추론한 것 |
| **확인 못함** | 찾았지만 검증하지 못한 것(§5에 모음) |

---

## 0. 한눈에 보는 결론

1. **"파운더리"가 무엇인지 특정하지 못했다.** 한국어·영어로 여러 번 검색했지만 "AI로 웹게임을 만들고 자체 서버에 올리는 '파운더리'"라는 제품은 나오지 않았다. 이름이 같은 후보는 넷이고(Microsoft Foundry, Palantir Foundry, Cloud Foundry, Foundry VTT), **공개 웹게임의 방 서버를 그대로 올릴 수 있는 것은 Cloud Foundry뿐**이다. 사용자에게 한 줄로 물어야 한다(§1.4). [문서][검색요약]
2. **어떤 답이 와도 되도록 이미 설계돼 있다.** 클라이언트는 `client/public/config.js`의 `server` 한 줄로 외부 서버를 가리키고, 서버는 Node 프로세스 하나다. "파운더리"가 정적 호스팅만 되면 클라이언트만 올리고 서버는 아래 추천지에 둔다.
3. **가장 쉬운 곳: Render(싱가포르).** GitHub 저장소 연결 → 빌드/시작 명령 두 줄 → 끝. 카드 없이 무료로 시작한다. 무료 인스턴스는 15분 동안 들어오는 트래픽이 없으면 잠들고, 깨어나는 데 약 1분 걸린다. WebSocket 최대 연결 시간 제한은 없다. [문서]
4. **한국에서 가장 빠른 곳: 서울 VPS.** Vultr 서울 `vc2-1c-1gb` 월 $5(1 vCPU, 1GB, 전송량 1TB 포함) 또는 AWS Lightsail 서울 월 $5(512MB, 1TB 포함) / $7(1GB, 2TB). 서울 안에서는 왕복 1.5ms, 도쿄는 35ms, 싱가포르는 67ms, 미국 서부는 126ms다. [API][문서][데이터]
5. **쉽고 가까운 절충안: Fly.io 도쿄(`nrt`).** 카드를 등록하면 매달 $5어치가 무료다. Dockerfile과 CLI가 필요하다. [문서]
6. **비용을 정하는 것은 서버 크기가 아니라 전송량이다.** 접속자 1명이 1시간에 약 11.7MB를 받는다(05 문서 실측). 방 3개가 한 달 내내 꽉 차면 약 504GB다. Render는 5GB 초과분이 GB당 $0.15라 약 $75, Fly 아시아는 약 $20, 서울 VPS는 포함량 안이라 $0다. [문서][추정]
7. **인스턴스는 반드시 1개.** 방 상태가 프로세스 메모리에 있으므로, 자동 확장이 두 번째 인스턴스를 띄우면 "방 1"이 두 개가 된다. 모든 플랫폼에서 최대 인스턴스 수를 1로 고정한다. [추정]
8. **Cloud Run 서울은 되지만 권하지 않는다.** WebSocket이 요청 타임아웃(최대 60분)에 걸려 한 시간마다 끊기고, 상시 가동하면 1 vCPU + 512MiB가 월 약 $54다. [문서][추정]
9. **국내 서비스는 맞지 않는다.** 카페24 Node.js 호스팅은 Node v12/v14만 제공하고 인증서 설치를 지원하지 않는다. 클라우드타입은 WebSocket 연결 유지가 무료 1분, 하비 5분, 프로 30분으로 제한된다. NCP Micro 서버는 1년 무료지만 공인 IP가 유료다. [문서]
10. **서버가 디스크에 쓰는 파일이 둘 있다: `DATA_DIR/secret`(저장 서명 키)과 `DATA_DIR/cults.json`(교단 기록).** Render 무료처럼 디스크가 임시인 곳에서는 재배포·재시작·잠들기 때마다 둘 다 사라진다. 서명 키는 `SAVE_SECRET` 환경변수로 고정하면 되지만, 교단 기록은 영구 디스크가 있는 곳(VPS, Fly 볼륨, Render 유료 디스크)에서만 남는다. [실측-로컬: `server/node/main.ts` 확인]
11. **클라이언트를 따로 올릴 때 지켜야 할 것 셋.** (1) 서버 주소는 반드시 `https://`(→`wss://`). https 페이지에서 `new WebSocket('ws://…')`은 **예외를 던진다.** (2) 서버가 `upgrade` 단계에서 `Origin`을 허용 목록과 대조한다. WebSocket에는 CORS가 적용되지 않는다. (3) `/api/rooms`에는 `Access-Control-Allow-Origin`을 붙인다. 셋 다 로컬에서 확인했다. [실측-로컬]

---

## 1. Part A — "파운더리"는 무엇인가

### 1.1 원문

> 파운더리 자체 서버에서 WebSocket과 방별 상태 관리가 가능하다면 해당 기능을 이용하세요

이 문장이 전제하는 것은 "파운더리"가 (a) 게임을 올릴 **호스팅 기능이 있는 플랫폼**이고 (b) 그 서버가 WebSocket과 상태 유지를 지원할 수도, 안 할 수도 있다는 것이다. 한국어에서 반도체 위탁생산과 Microsoft/Palantir 제품은 보통 "파운**드**리"로 적는다. "파운**더**리"는 흔한 다른 표기이므로 철자만으로 후보를 좁힐 수 없다.

### 1.2 검색한 것과 결과

다음 검색에서 **해당하는 제품이 나오지 않았다.** [검색요약]

- "파운더리 AI 앱 빌더 웹게임 만들기 배포 서버"
- "파운더리 AI 웹앱 빌더 호스팅 바이브코딩 플랫폼 2026"
- "파운더리 바이브코딩 게임 만들기 Foundry 자체 서버 멀티플레이"
- "Foundry AI app builder hosting WebSocket server vibe coding deploy game 2026"
- "Foundry AI game builder platform multiplayer web game built-in server rooms publish"
- "Foundry vibe coding platform multiplayer game deploy/publish new startup 2026"
- "Claude Code Foundry hosting web app deploy (Anthropic/OpenAI/Google)"
- 확장 검색 1회("파운더리 OR 파운드리, AI로 웹게임 만들고 배포하는 플랫폼, 자체 서버, WebSocket")

검색에 걸린 "AI로 게임을 만들고 서버까지 띄워 주는" 서비스는 Google AI Studio(실시간 멀티플레이 지원 보도), Manus, Hostinger AI Builder, SEELE, Rosebud, Lovable 등이었고 이름이 Foundry인 것은 없었다. SEELE에 "Foundry Custom Game Builder"라는 페이지가 있지만 "Foundry 풍 게임을 참고해 원형을 만든다"는 랜딩 페이지이고 호스팅 플랫폼이 아니다. [검색요약]

### 1.3 이름이 같은 후보

| 후보 | 무엇인가 | 정적 호스팅 | 서버 코드 | WebSocket | 상시 프로세스 | 공개 게임 서버로 |
|---|---|---|---|---|---|---|
| **Microsoft Foundry** (옛 Azure AI Foundry) | AI 모델·에이전트 플랫폼 | 해당 기능 못 찾음 | "호스티드 에이전트"(컨테이너). **Python, C#만** | `invocations_ws` 프로토콜 있음. Entra ID 인증 필요 | 세션별 샌드박스. 유휴 2~240분(기본 15분) 뒤 내려감 | **부적합** |
| **Palantir Foundry** | 기업용 데이터 플랫폼 | 있음. 파일 1,000개·20MB, **보는 사람이 Foundry 로그인 필요** | 컴퓨트 모듈(컨테이너) | WebSocket 리스너(베타, Palantir 지원팀에 신청). Foundry 토큰 인증 | 컴퓨트 모듈 | **부적합** |
| **Cloud Foundry** (SAP BTP 등) | 오픈소스 PaaS (`cf push`) | 가능(staticfile 빌드팩) | Node 빌드팩 | 지원(Gorouter). 앞단 로드밸런서 설정에 달림 | 가능 | **가능** |
| **Foundry VTT** | TRPG용 가상 테이블탑(직접 호스팅하는 Node 앱) | — | 자체 앱 전용 | 자체 앱 전용 | — | 호스팅 플랫폼 아님 |
| Foundry (이더리움 개발 도구 forge/anvil) | 스마트 컨트랙트 툴체인 | — | — | — | — | 무관 |

근거:

- **Microsoft Foundry.** 공식 문서(2026-11-24 수정본)의 문장들: 호스티드 에이전트는 "Agent Service에서 실행되는 컨테이너화된 에이전트 애플리케이션"이고, "Hosted agents support **Python** and **C#**", 엔드포인트는 Entra ID로 인증하며, 세션마다 VM으로 격리된 샌드박스가 뜨고 유휴 타임아웃(2~240분, 기본 15분)이 지나면 컴퓨트를 내린다. WebSocket 프로토콜(`invocations_ws`)의 용도는 "실시간 음성 에이전트"다. 리전 목록에 Korea Central이 있다. [문서] → Node 서버를 올릴 수 없고, 인증 없는 브라우저 접속을 받는 구조가 아니다.
- **Palantir Foundry.** 웹 호스팅 문서: "only supports hosting static assets and does not support running a server", 파일 최대 1,000개, 총 20MB, 보는 사람에게 Foundry 로그인 권한이 필요. [문서] WebSocket 리스너 문서: 베타이며 "may not be available on your enrollment", 주 용도는 실시간 음성·전화(Twilio 등), "Foundry cannot guarantee high availability for WebSocket listener connections". [문서] → 인스타그램에서 누구나 눌러 들어오는 게임에는 쓸 수 없다.
- **Cloud Foundry.** 관리자 문서에 WebSocket 지원 설정이 있다. 앞단 로드밸런서가 업그레이드 요청을 라우터로 그대로 넘기도록 설정돼 있어야 하고, AWS ELB처럼 그게 안 되면 TCP 모드나 별도 포트(기본 8443)를 쓴다. [문서] 유휴 타임아웃은 이 문서에 없다(확인 못함). 사용자의 회사가 Cloud Foundry 기반 플랫폼(SAP BTP 등)을 쓴다면 `cf push`로 Node 서버를 인스턴스 1개로 올리면 된다. [추정]
- **Foundry VTT.** Node로 직접 호스팅하는 TRPG 도구다. Railway에 v14 템플릿이 있다. [검색요약] "자체 서버"라는 표현과 겉으로는 맞지만, 다른 게임을 올리는 플랫폼이 아니다.

### 1.4 판단과 권고

- **단정하지 않는다.** 가장 그럴듯한 해석은 "사용자가 쓰는(또는 쓰려는) 어떤 제작·배포 도구의 이름"이고, 그것이 위 후보 중 하나인지, 사내 플랫폼 이름인지, 다른 제품을 잘못 부른 것인지 알 수 없다.
- 저장소의 `client/public/config.js` 주석에는 이미 "정적 호스팅(파운더리 등)에 클라이언트만 올리고 실시간 서버를 따로 둘 때"라고 적혀 있다. 이 가정(파운더리 = 정적 호스팅만 될 수도 있는 곳)이 가장 안전하다.
- **사용자에게 물을 한 줄:** "말씀하신 '파운더리'의 주소(또는 회사명)를 알려 주세요. 그곳이 (1) 정적 파일만 올릴 수 있는지, (2) Node 프로세스를 계속 켜 둘 수 있는지 확인하겠습니다."
- **답에 따른 분기:**

| 답 | 할 일 |
|---|---|
| 정적 파일만 된다 | `dist/client`만 올리고 `config.js`의 `server`에 외부 서버 주소(§2.6 추천지)를 적는다. §3의 세 가지를 지킨다 |
| Node 프로세스가 계속 돈다(컨테이너, `cf push` 등) | `npm run build` 후 `node dist/server/main.js`. 인스턴스 1개 고정, `PORT`와 `SAVE_SECRET` 주입, WebSocket 유휴·최대 연결 시간을 문서에서 확인 |
| 요청마다 뜨는 함수만 된다(서버리스) | 방 서버를 올릴 수 없다. 정적 파일만 올리고 서버는 외부에 둔다 |
| Cloudflare 계열이다 | `worker/` 어댑터(06 문서) |
| 답이 없다 | Render에 서버+클라이언트를 한 번에 올려 주소를 먼저 준다(§2.7) |

### 1.5 이 절에서 확인 못한 것

- 사용자가 가리킨 "파운더리"의 실체.
- Microsoft Foundry에서 일반 웹앱(Azure App Service 등)으로 내보내는 경로의 현재 상태. Azure App Service가 WebSocket을 지원한다는 것은 일반 지식이고 이번에 다시 확인하지 않았다.
- Cloud Foundry 배포판별 WebSocket 유휴 타임아웃.

---

## 2. Part B — Node WebSocket 서버를 어디에 둘 것인가

### 2.1 우리 서버가 호스팅에 요구하는 것

| 요구 | 이유 | 호스팅에서 확인할 것 |
|---|---|---|
| 프로세스가 계속 살아 있어야 한다 | NPC 28명이 서버에서 10Hz로 움직인다 | 잠들기(sleep)와 콜드 스타트 |
| **인스턴스 1개** | 방 상태가 메모리에 있다. 2개가 뜨면 같은 번호의 방이 둘이 된다 | 자동 확장 끄기, 최대 1개 |
| WebSocket이 오래 열려 있어야 한다 | 한 판이 수십 분 | 최대 연결 시간, 유휴 타임아웃 |
| `wss://` | 클라이언트가 https로 서빙된다 | TLS 자동 발급 여부 |
| `SAVE_SECRET`은 고정 | 진행도는 서버가 서명해 클라이언트 localStorage에 둔다. 비밀값이 바뀌면 **모든 사용자의 저장이 무효**가 된다. 서버는 값이 없으면 `DATA_DIR/secret`에 만들어 쓰는데, 임시 디스크에서는 쓰기가 성공하므로 **경고 없이** 다음 재시작 때 새 키가 된다 | 대부분의 PaaS는 디스크가 임시다. **환경변수로 고정** |
| 교단 기록은 디스크에 남는다 | `DATA_DIR/cults.json`을 30초마다 저장한다(교단 이름·신도 수·영향력, 최대 5,000개) | 영구 디스크(볼륨)를 붙일 수 있는지. 없으면 재시작마다 교단 순위가 0에서 시작 |
| 프록시 뒤에서는 접속자 IP가 안 보인다 | PaaS는 전부 앞에 프록시가 있다. `socket.remoteAddress`는 프록시 주소다. 지금 서버는 IP별 제한 없이 전체 접속 수(`ROOMS × 정원 × 2 + 100`)만 제한하므로 당장은 문제없다 | IP별 제한을 넣을 때 `X-Forwarded-For` 등을 신뢰할지 정하는 설정이 필요 |
| 배포하면 연결이 끊긴다 | 어느 플랫폼이든 재시작 = 전원 재접속. 서버는 SIGTERM을 받으면 방마다 종료를 알리고 0.7초 뒤 끝낸다 | SIGTERM 유예 시간(Render 30초, 충분), 클라이언트 재접속 |

자원은 작다. 05 문서의 실측으로 100방 2,000접속이 코어 1개의 32%, RSS 94MB였다(최소 로직 기준). 방 3개는 코어의 몇 %와 100MB 안팎이면 된다. 0.1 vCPU / 256~512MB 인스턴스로 충분하다. [추정]

### 2.2 지연 — 서울에서 각 리전까지

cloudping.co 데이터(AWS 리전 간 왕복 p50, 최근 1주, 2026-11-26 조회)에서 `ap-northeast-2`(서울) 행만 뽑았다. 데이터센터 사이의 값이므로 실제 사용자는 여기에 집·모바일 구간이 더해진다. [데이터]

| 서울 → | 왕복(ms) | 그 리전에 있는 선택지 |
|---|---|---|
| 서울 | 1.5 | Vultr 서울, Lightsail 서울, NCP, Oracle 서울·춘천, Cloud Run 서울 |
| 오사카 | 20.8 | Vultr 오사카 |
| 도쿄 | 35.2 | **Fly.io `nrt`**, Koyeb `TYO`, Vultr 도쿄, Lightsail 도쿄 |
| 홍콩 | 41.5 | — |
| 싱가포르 | 66.7 | **Render**, Railway, Fly `sin`, Koyeb `SIN`, Hetzner |
| 오리건(미 서부) | 125.6 | Render·Railway 기본 리전 |
| 버지니아(미 동부) | 177.9 | 대부분의 무료 인스턴스 기본값 |
| 프랑크푸르트 | 227.0 | Koyeb 무료 인스턴스 |

05 문서에 따르면 지금 클라이언트는 `서버 시각 − 190ms`를 렌더 시각으로 써서, 편도 지연이 90ms(왕복 180ms)를 넘으면 매 틱 끊긴다. 싱가포르까지는 여유가 있고, 미 서부는 모바일 구간이 더해지면 빠듯하며, 미 동부와 유럽은 안 된다. **리전 선택에서 기본값(오리건, 버지니아)을 그대로 두면 안 된다.** [추정]

### 2.3 전송량이 비용을 정한다

05 문서 실측: 접속자당 약 3.24KB/s(TLS·TCP·IP 포함) = 시간당 약 11.7MB.

| 상황 | 접속자·시간/월 | 전송량/월 |
|---|---|---|
| 친구끼리 시험(평균 2명 상시) | 1,440 | 약 17GB |
| 작게 퍼짐(평균 20명 상시) | 14,400 | 약 168GB |
| 방 3개가 한 달 내내 가득(60명) | 43,200 | 약 504GB |

| 호스팅 | 포함 전송량 | 초과 단가 | 17GB | 168GB | 504GB |
|---|---|---|---|---|---|
| Render (Hobby 워크스페이스) | 5GB | $0.15/GB | $1.8 | $24.5 | $74.9 |
| Railway | 없음(사용량 과금) | $0.05/GB | $0.8 | $8.4 | $25.2 |
| Fly.io 아시아 | 없음(무료 $5에 포함) | $0.04/GB | $0.7 | $6.7 | $20.2 |
| Northflank | 없음 | $0.06/GB | $1.0 | $10.1 | $30.2 |
| Vultr 서울 $5 | 1,024GB | 확인 못함 | $0 | $0 | $0 |
| Lightsail 서울 $5 | 1TB | 확인 못함 | $0 | $0 | $0 |
| Oracle Always Free | 10TB | — | $0 | $0 | $0 |
| 클라우드타입 무료 / 하비 | 10GB / 100GB | 100GB당 ₩13,200 | 무료는 초과 시 1Mbps 이하로 제한 | ₩13,200 추가 | ₩66,000 추가 |

단가는 [문서][API], 금액은 [추정]. Cloud Run의 인터넷 송신 단가는 확인하지 못했다.

정적 파일은 상대적으로 작다. 현재 빌드는 JS 564KB(gzip 144KB) + CSS 9KB다. 방문 10만 번이면 gzip 기준 약 15GB, 압축 없이 보내면 약 57GB다. `server/node/main.ts`는 이미 `Accept-Encoding`에 맞춰 br/gzip으로 압축해 보내고 `/assets/*`에 `immutable`, `config.js`와 HTML에 `no-cache`를 붙인다. 그래도 방문자가 몰릴 때는 정적 파일을 CDN으로 빼는 편이 서버 전송량을 아낀다(§3). [실측-로컬][추정]

### 2.4 비교표

| 호스팅 | 무료 / 가격 | WebSocket·타임아웃 | 잠들기 | 한국 근처 리전 | GitHub 배포 |
|---|---|---|---|---|---|
| **Render** | 무료 웹 서비스(0.1 CPU, 512MB, 월 750시간, 카드 불필요). 상시 가동은 $7/월(0.5 CPU, 512MB) | 지원. "최대 연결 시간을 두지 않는다". `ws://`는 301로 거절되므로 `wss://`만 | 무료는 15분 무트래픽이면 잠듦, 깨는 데 약 1분. WebSocket 메시지는 트래픽으로 침 | 싱가포르 | 저장소 연결, 빌드/시작 명령 또는 Dockerfile, `render.yaml` |
| **Railway** | Free: 월 $1 크레딧(0.5GB/1 vCPU 한도). Trial: $5 1회(30일). Hobby: $5/월($5 사용량 포함). RAM $10/GB·월, vCPU $20/월 | 지원. WebSocket은 시간·유휴 제한 **면제** | 기본은 안 잠듦. "Serverless"를 켜면 마지막 송신 뒤 5~10분에 잠듦 | 싱가포르 | 저장소 연결, Railpack 자동 감지 또는 Dockerfile |
| **Fly.io** | Free 플랜: 카드 없이 $1(7일), 카드 등록 시 **매달 $5 사용량**. 머신 3대까지. `shared-cpu-1x` 256MB $2.19/월(미 동부 기준, 아시아는 더 비쌈) | 지원. `idle_timeout` 설정 가능(기본값 확인 못함) | `auto_stop_machines`가 켜져 있으면 트래픽 0일 때 멈춤. `"off"`로 상시 가동 | **도쿄 `nrt`**, 싱가포르 `sin`. 서울 없음 | `fly launch` + Dockerfile, GitHub Actions |
| **Koyeb** | 요금 페이지에 무료 플랜 없음: Pro $29/월(+컴퓨트, $10 포함)부터. 문서에는 Free 인스턴스(0.1 vCPU, 512MB, **프랑크푸르트·워싱턴만**, 1시간 무트래픽이면 0으로) 설명이 남아 있음 | 지원 | Free 인스턴스는 1시간 뒤 0으로 | 도쿄 `TYO`, 싱가포르 `SIN` | 저장소 연결, 빌드팩 또는 Dockerfile |
| **Northflank** | Free Sandbox: 서비스 2개, 카드 불필요, "Always on, no sleeping". 종량제 최소 `nf-compute-50`(0.5 vCPU, 1GB) $12/월 | 지원(세부 확인 못함) | 안 잠듦 | `asia-northeast`, `asia-east`, `asia-southeast`(도시명 확인 못함) | 저장소 연결, 빌드팩 또는 Dockerfile |
| **Cloud Run** | 무료 구간(인스턴스 과금 기준 월 240,000 vCPU-초, 450,000 GiB-초). 서울은 Tier 2 | 지원. **요청 타임아웃에 걸림: 기본 5분, 최대 60분.** 넘으면 끊김 | 최소 인스턴스 0이면 연결이 없을 때 0으로. 연결이 하나라도 열려 있으면 과금 | **서울 `asia-northeast3`**, 도쿄, 오사카 | `gcloud run deploy --source .`(Dockerfile 있으면 사용, 없으면 빌드팩) |
| **Oracle Cloud Always Free** | AMD Micro 2대(각 1/8 OCPU, 1GB) + Arm A1 **2 OCPU·12GB**(월 1,500 OCPU-시간, 9,000 GB-시간). 송신 10TB/월 | 직접 구성(VPS) | 없음. 단 **유휴 인스턴스 회수 정책** 있음 | 서울, 춘천(A1은 춘천에서 불가로 적혀 있음) | 직접(SSH, git pull) |
| **Hetzner Cloud** | 싱가포르 CPX12(1 vCPU, 2GB) €15.99/월, 전송 0.5TB 포함. 유럽은 CPX02 €5.49~ | 직접 구성 | 없음 | 싱가포르만. 한국·일본 없음 | 직접 |
| **Vultr** | 서울 `vc2-1c-1gb` **$5/월**(1 vCPU, 1GB, 25GB, 1,024GB). 고성능 `vhp-1c-1gb` $6/월(2,048GB) | 직접 구성 | 없음 | **서울 `icn`**, 도쿄, 오사카 | 직접 |
| **AWS Lightsail** | 서울 $5/월(512MB, 2 vCPU, 20GB, 1TB), $7/월(1GB, 40GB, 2TB), $12/월(2GB, 3TB). IPv6 전용은 $3.50~ | 직접 구성 | 없음 | **서울 `ap-northeast-2`**, 도쿄 | 직접 |
| **카페24 Node.js 호스팅** | 월 500~22,000원. 메모리 300~700MB | 확인 못함. **Node v12/v14만**, 인증서 설치 미지원, SSH·FTP 미지원(git 업로드) | — | 국내 | git push |
| **카페24 개발언어 VPS** | 월 33,000원부터(기사) / 49,500원~(카페24 페이지 문구). 2026-08 출시 | Ubuntu 24.04 + Nginx + 무료 SSL + root SSH | 없음 | 국내 | 직접 |
| **NCP** | Micro 서버 1년 무료(서버 요금만. **공인 IP 등은 과금**). 이후 요금 확인 못함 | 직접 구성 | 없음 | 국내 | 직접 |
| **클라우드타입** | 무료(카드 필요, 메모리 1GB, **하루 1회 자동 중지**, 5Mbps, 월 10GB). 하비 ₩6,600/0.5GB. 프로 ₩22,000~ | **연결 유지 최대 1분(무료) / 5분(하비) / 30분(프로)** | 무료는 매일 1회 중지 | 확인 못함 | 저장소 연결, Dockerfile·빌드팩 |

환경변수는 모든 PaaS가 대시보드나 CLI로 넣는다. VPS는 systemd의 `EnvironmentFile`을 쓴다.

### 2.5 플랫폼별로 알아 둘 것

**Render** [문서]
- 무료 인스턴스의 제한: 0.1 CPU, 512MB, 워크스페이스당 월 750시간, 영구 디스크 없음, 인스턴스 1개, 셸 접속 없음, "언제든 재시작될 수 있음".
- 잠드는 기준은 "15분 동안 들어오는 트래픽이 없음"이고 WebSocket 메시지도 트래픽이다. 즉 **누가 접속해 있는 동안은 안 잠든다.** 마지막 사람이 나가고 15분 뒤 잠들면 방 상태(NPC 위치 등)와 **교단 기록 파일**이 사라진다. 개인 진행도는 클라이언트에 있으므로 남는다.
- 영구 디스크는 유료 인스턴스에만 붙일 수 있고 GB당 월 $0.25다. 디스크를 붙이면 `DATA_DIR`을 그 경로로 준다.
- 전송량은 Hobby 워크스페이스 5GB/월 포함, 초과 $0.15/GB. 결제 수단이 없으면 초과 시 **그달 남은 기간 동안 무료 서비스가 정지**된다.
- 배포·점검 때 SIGTERM을 보내고 30초(최대 300초로 늘릴 수 있음) 기다린다.
- Node 기본 버전은 2026-10-21 이후 만든 서비스 기준 `24.22.1`. 우선순위는 `NODE_VERSION` 환경변수 > `.node-version` > `.nvmrc` > `package.json`의 `engines`. 문서는 "범위에 상한을 꼭 두라"고 한다. 우리 `engines`는 `>=20`(상한 없음)이므로 최신 메이저로 풀릴 수 있다.
- `NODE_ENV=production`은 **실행 시점에만** 설정된다.

**Railway** [문서]
- WebSocket은 HTTP 요청의 시간 제한(최대 15분, 무전송 5분)과 유휴 제한(60초)에서 면제된다고 명시돼 있다.
- Free 플랜은 월 $1뿐이다. 서버가 100MB를 상시 쓰면 RAM만 약 $1/월이라 상시 가동은 Hobby($5)가 현실적이다. [추정]
- 프로젝트 1개·서비스 3개·커스텀 도메인 0개(Free).

**Fly.io** [문서]
- Free 플랜에서 $5를 넘기면 **자동으로 종량제로 넘어가고 그달 사용량 전체가 첫 1센트부터 과금**된다. 전송량이 늘면 갑자기 청구될 수 있다.
- `fly deploy`는 기본으로 머신 2대를 만든다. **`--ha=false`를 꼭 붙인다**(인스턴스 1개 요구).
- 머신이 1대일 때 자동 정지는 "트래픽이 0이면 멈춤"이다. 열린 WebSocket이 트래픽으로 계산되는지는 문서에 명시가 없다(확인 못함). 상시 가동하려면 `auto_stop_machines = "off"`, `auto_start_machines = false`.
- Free 플랜에서는 전용 IPv4를 쓸 수 없다(공유 IPv4는 무료). 웹 서비스에는 지장이 없다.
- 도쿄 머신의 정확한 단가는 계산기에만 있다(확인 못함). 문서 예시로 1GB 머신이 미 동부 $6.70, 싱가포르 $8.50(1.27배)이다.

**Koyeb** [문서][검색요약]
- 2026-02에 Mistral AI 인수가 발표됐고 요금 페이지에 그 배너가 있다. 요금 페이지의 플랜은 Pro $29 / Scale $299 / Enterprise뿐이다. 비교 사이트들은 2026-02 말에 신규 가입자 대상 무료 Starter 플랜이 없어졌다고 적는다. 문서의 Free 인스턴스 설명과 어긋나므로 **신규 가입자가 무료로 쓸 수 있는지는 확인 못함.** 무료가 되더라도 리전이 프랑크푸르트·워싱턴뿐이라(서울에서 227ms / 178ms) 이 게임에는 못 쓴다.

**Cloud Run** [문서][추정]
- 문서: "WebSockets 연결은 요청 타임아웃의 적용을 받는다. 현재 최대 60분, 기본 5분." 클라이언트가 재접속을 처리해야 한다.
- 인스턴스 사이에 상태를 공유하지 않으므로 여러 인스턴스를 쓰려면 Redis 등 외부 동기화가 필요하다고 안내한다. 우리는 `--max-instances=1`.
- 과금: 연결이 열려 있으면 인스턴스가 활성으로 계산된다. 인스턴스 과금(`--no-cpu-throttling`) 단가는 Tier 1 기준 vCPU-초 $0.000018, GiB-초 $0.000002. 서울은 Tier 2이고, 페이지 데이터에 $0.0000216 / $0.0000024 값이 들어 있다(서울을 고른 화면을 직접 보지는 못함).
- 계산: 1 vCPU + 512MiB를 30일 상시 = 2,592,000초 × ($0.0000216 + 0.5 × $0.0000024) ≈ $59.1, 무료 구간(약 $5.2)을 빼면 **약 $54/월.** 하루 4시간만 깨어 있으면 약 $4.6/월.
- vCPU를 1 미만으로 낮추면 동시 처리 수가 1로 묶인다는 제약은 일반 지식이고 이번에 다시 확인하지 않았다.

**Oracle Cloud Always Free** [문서]
- Arm A1 무료 한도가 문서상 **2 OCPU·12GB**다(월 1,500 OCPU-시간, 9,000 GB-시간). 예전에 널리 알려진 4 OCPU·24GB가 아니다.
- "유휴 인스턴스 회수": 7일 동안 CPU 95퍼센타일 20% 미만, 네트워크 20% 미만, (A1은) 메모리 20% 미만이면 회수될 수 있다. **우리 서버는 CPU를 몇 %만 쓰므로 이 조건에 그대로 해당한다.**
- 무료 인스턴스는 홈 리전에서만 만들 수 있고, "out of host capacity" 오류가 나면 기다리라고 문서가 직접 적고 있다.
- A1은 "South Korea North (Chuncheon)을 제외한" 가용 도메인에서 만들 수 있다고 적혀 있다.
- 결론: 무료라는 장점이 크지만 "언제 사라질지 모르는 서버"다. 출시용으로 권하지 않는다.

**국내** [문서]
- 카페24 Node.js 호스팅 페이지 원문: "node.js 버전 v12 / v14", "node.js 호스팅은 FTP나 SSH 접속을 지원하지 않습니다", "node.js 호스팅은 인증서 설치를 지원하지 않습니다". 우리 빌드 대상은 Node 20이다. 쓸 수 없다.
- 클라우드타입 요금 페이지: "HTTP 타임아웃 / 웹소켓·SSE 타임아웃 1분 / 5분 / 30분", 프로 플랜 설명에 "HTTP 연결유지 최대 30분 (웹소켓/SSE)". 이 값이 유휴 기준인지 절대 기준인지는 페이지에 없다(확인 못함). 절대 기준이면 무료에서는 1분마다 끊긴다.
- NCP 서버 페이지: Micro는 "신규 가입 후 결제 정보를 등록한 월부터 1년 간 무료", "서버 비용만 무료이며, 공인 IP 등의 유료 상품 이용 시 해당 비용은 과금". 요금표 숫자는 페이지가 동적으로 채워 읽지 못했다.

### 2.6 추천

| 목적 | 추천 | 이유 | 주의 |
|---|---|---|---|
| **가장 쉽게** | **Render, 싱가포르, 무료로 시작** | 카드·CLI·Dockerfile 없이 저장소 연결만으로 `https`/`wss` 주소가 나온다. WebSocket 시간 제한 없음 | 잠들면 첫 접속이 약 1분이고 교단 기록이 비워진다. 전송 5GB/월. 지연 약 67ms+ |
| **한국에서 가장 빠르게** | **서울 VPS — Vultr 서울 $5(1GB)**, 같은 급으로 Lightsail 서울 $5(512MB)/$7(1GB) | 서울 안 1.5ms. 전송 1TB 포함이라 504GB까지 추가 비용 0. 잠들지 않음 | 서버 관리(업데이트, 인증서, 재시작)를 직접 한다. 도메인이 필요하다 |
| 절충 | Fly.io 도쿄 | 약 35ms. 매달 $5 무료. 관리형 | CLI + Dockerfile. $5 초과 시 그달 전체 과금 |

출시 순서 제안: **시험과 지인 공유는 Render 무료 → 인스타그램에 올리기 전에 서울 VPS로 옮긴다.** 클라이언트는 주소만 바꾸면 된다.

### 2.7 배포 절차 ① Render (가장 쉬움)

사전 준비(저장소에 필요한 것):

- `package-lock.json`이 커밋돼 있어야 한다(`npm ci`가 요구).
- Node 버전을 고정한다. 저장소 루트에 `.node-version` 파일(내용 `24.22.3`)을 두거나 환경변수 `NODE_VERSION`을 넣는다. Render 문서의 예시는 `20.18.0` 같은 전체 버전이나 `lts` 같은 별칭이다. `24`처럼 메이저만 적어도 되는지는 확인하지 못했다.
- 서버가 `process.env.PORT`를 읽고 모든 인터페이스에 바인드해야 한다. 현재 `server/node/main.ts`는 `PORT`를 읽고 `HOST`가 비어 있으면 전체에 바인드하므로 그대로 된다.

절차 [문서]:

1. render.com에 GitHub 계정으로 가입한다(카드 불필요).
2. Dashboard → **New → Web Service** → 저장소를 고른다.
3. 설정:
   - Language: `Node`
   - Region: **`Singapore`** (만든 뒤에는 바꿀 수 없다)
   - Branch: `main`
   - Build Command: `npm ci --include=dev && npm run build`
   - Start Command: `npm start`
   - Instance Type: `Free` (상시 가동이 필요하면 `0.5 CPU / 512 MB`, $7/월)
4. Environment Variables:
   - `NODE_VERSION` = `24.22.3`
   - `PORT` = `10000` (Render 웹 서비스의 기본 포트. 명시해 두면 안전하다)
   - `SAVE_SECRET` = (Generate 버튼으로 만든 무작위 값. **한번 정하면 바꾸지 않는다**)
   - `ROOMS` = `3`, `ROOM_CAPACITY` = `20`, `NPCS` = `28`
   - `ALLOWED_ORIGINS` = `https://<서비스이름>.onrender.com` (클라이언트를 따로 올리면 그 주소를 쉼표로 추가)
5. Advanced → Health Check Path: `/healthz`
6. **Create Web Service**. 빌드 로그가 끝나면 `https://<서비스이름>.onrender.com`이 열린다.
7. 확인: 브라우저로 접속해 방에 들어간다. `https://…/healthz`가 200인지 본다. 탭 두 개로 서로 보이는지 본다.
8. 이후 `main`에 push할 때마다 자동 배포된다. 배포 순간 접속자는 끊기고 재접속한다.

같은 내용을 코드로 남기려면 저장소 루트에 `render.yaml`(Blueprint)을 둔다. 필드 이름과 허용값은 Blueprint 명세에서 확인했다. 실제 배포는 해 보지 못했다.

```yaml
services:
  - type: web
    name: doas-game
    runtime: node
    plan: free              # 상시 가동: 0.5c-512mb
    region: singapore       # oregon | ohio | virginia | frankfurt | singapore
    buildCommand: npm ci --include=dev && npm run build
    startCommand: npm start
    healthCheckPath: /healthz
    autoDeployTrigger: commit
    numInstances: 1         # 방 상태가 메모리에 있으므로 반드시 1
    maxShutdownDelaySeconds: 30
    envVars:
      - key: NODE_VERSION
        value: "24.22.3"
      - key: PORT
        value: "10000"
      - key: SAVE_SECRET
        generateValue: true
      - key: ROOMS
        value: "3"
      - key: ALLOWED_ORIGINS
        sync: false         # 처음 만들 때 대시보드에서 입력
```

무료 인스턴스의 한계 둘: (1) 잠들었다 깨면 교단 기록(`cults.json`)이 비어 있다. 시험용으로는 괜찮고, 순위를 남기려면 유료 인스턴스 + 디스크나 VPS로 간다. (2) 0.1 CPU다. 방 3개는 돌지만 여유는 없다. [추정]

무료 인스턴스를 쓸 때 클라이언트가 할 일: 첫 `/api/rooms` 요청이 오래 걸리면 "서버를 깨우는 중…(최대 1분)" 화면을 보여 주고 재시도한다. 깨어나는 동안 브라우저 요청에는 Render의 대기 페이지가 돌아온다. [문서]

### 2.8 배포 절차 ② 서울 VPS (가장 빠름)

Vultr 서울과 Lightsail 서울은 인스턴스를 만드는 화면만 다르고 그 뒤는 같다. 아래 명령은 Ubuntu 24.04 기준이다. Caddy 설치 명령은 공식 설치 문서에서 확인했고, 나머지는 실행해 보지 못했다.

1. **인스턴스 만들기**
   - Vultr: Deploy → Cloud Compute(Shared CPU) → 위치 **Seoul** → Ubuntu 24.04 → `vc2-1c-1gb`($5/월). SSH 키를 등록한다.
   - Lightsail: Create instance → 리전 **Seoul (ap-northeast-2)** → Linux/Ubuntu 24.04 → $5 또는 $7 플랜. **고정 IP를 만들어 붙이고**, 네트워킹 탭 방화벽에서 **443(HTTPS)** 을 연다.
   - 어느 쪽이든 서버 안의 방화벽(`ufw`)이 켜져 있으면 `sudo ufw allow 80,443/tcp`로 연다. 이미지별 기본 방화벽 상태는 확인하지 못했다.
2. **도메인.** `game.example.com`의 A 레코드를 서버 IP로 건다. 인증서 발급에 도메인이 필요하다.
3. **패키지 설치**

   ```bash
   # Node 24 LTS
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs git

   # Caddy (공식 저장소)
   sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy
   ```

4. **512MB 인스턴스라면 스왑을 먼저 만든다.** `npm ci`와 `vite build`가 메모리를 넘길 수 있다. [추정]

   ```bash
   sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

5. **코드 받아 빌드**

   ```bash
   sudo useradd --system --create-home --home-dir /opt/doas --shell /usr/sbin/nologin doas
   sudo -u doas git clone https://github.com/<계정>/<저장소>.git /opt/doas/app
   cd /opt/doas/app
   sudo -u doas npm ci
   sudo -u doas npm run build
   ```

6. **환경변수 파일** `/etc/doas.env` (권한 600)

   ```ini
   NODE_ENV=production
   PORT=8787
   ROOMS=3
   ROOM_CAPACITY=20
   NPCS=28
   SAVE_SECRET=<openssl rand -base64 32 로 만든 값>
   CLIENT_DIR=/opt/doas/app/dist/client
   DATA_DIR=/opt/doas/data
   ALLOWED_ORIGINS=https://game.example.com
   ```

7. **systemd 서비스** `/etc/systemd/system/doas.service`

   ```ini
   [Unit]
   Description=도를 아십니까 게임 서버
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=doas
   WorkingDirectory=/opt/doas/app
   EnvironmentFile=/etc/doas.env
   ExecStart=/usr/bin/node dist/server/main.js
   Restart=always
   RestartSec=2
   TimeoutStopSec=15
   NoNewPrivileges=true
   LimitNOFILE=65535

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo mkdir -p /opt/doas/data && sudo chown doas: /opt/doas/data
   sudo systemctl daemon-reload && sudo systemctl enable --now doas
   curl -s localhost:8787/healthz
   ```

8. **Caddy로 TLS와 프록시** `/etc/caddy/Caddyfile`

   ```caddy
   game.example.com {
   	encode zstd gzip
   	reverse_proxy 127.0.0.1:8787
   }
   ```

   ```bash
   sudo systemctl reload caddy
   ```

   Caddy는 Let's Encrypt 인증서를 자동으로 받아 갱신하고, `reverse_proxy`는 WebSocket 업그레이드를 별도 설정 없이 넘긴다(일반 지식, 이번에 실행 확인은 못함). 80·443 포트가 열려 있어야 한다.
9. **확인.** `https://game.example.com/healthz`, 브라우저 접속, 탭 두 개로 동기화.
10. **업데이트 스크립트** `/opt/doas/deploy.sh`

    ```bash
    #!/usr/bin/env bash
    set -euo pipefail
    cd /opt/doas/app
    sudo -u doas git pull --ff-only
    sudo -u doas npm ci
    sudo -u doas npm run build
    sudo systemctl restart doas
    curl -fsS localhost:8787/healthz
    ```

    GitHub에서 자동으로 돌리려면 GitHub Actions에서 SSH로 이 스크립트를 실행한다. 빌드를 Actions에서 하고 `dist/`만 `rsync`로 보내면 서버 메모리 걱정이 없어진다.

운영 메모:
- 서버가 프록시(Caddy) 뒤에 있으므로 서버가 보는 상대 주소는 전부 `127.0.0.1`이다. 지금은 IP별 제한이 없어 영향이 없다. IP별 접속 제한을 넣을 때는 "프록시를 신뢰한다"는 설정과 함께 `X-Forwarded-For`를 읽어야 한다.
- `systemctl restart`는 전원을 끊는다. 서버는 SIGTERM을 받으면 방마다 종료를 알리고 교단 기록을 저장한 뒤 0.7초 후 끝난다(`server/node/main.ts`). `TimeoutStopSec=15`면 충분하다.
- `DATA_DIR=/opt/doas/data`에 `secret`과 `cults.json`이 남는다. 이 폴더만 백업하면 된다.
- 보안 업데이트: `sudo apt install unattended-upgrades`.

### 2.9 그 밖의 절차

**Fly.io 도쿄** (실행해 보지 못함)

```toml
# fly.toml
app = "doas-game"
primary_region = "nrt"

[env]
  PORT = "8080"
  ROOMS = "3"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"      # 상시 가동. 비용을 줄이려면 "stop" + auto_start_machines = true
  auto_start_machines = false
  [http_service.concurrency]
    type = "connections"
    soft_limit = 200
    hard_limit = 250

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"

# 교단 기록(cults.json)을 남기려면 볼륨을 붙인다. GB당 월 $0.15
[mounts]
  source = "doas_data"
  destination = "/data"
```

```bash
fly launch --no-deploy            # 앱 생성. 리전은 nrt
fly volumes create doas_data --region nrt --size 1
fly secrets set SAVE_SECRET="$(openssl rand -base64 32)" ALLOWED_ORIGINS="https://doas-game.fly.dev" DATA_DIR=/data
fly deploy --ha=false             # 머신 1대만
fly scale count 1
```

볼륨 마운트 지점의 소유자가 root이면 §2.10 Dockerfile의 `USER node`로는 쓰지 못할 수 있다(확인 못함). 그 경우 `USER` 줄을 빼거나 시작 스크립트에서 권한을 맞춘다.

**Cloud Run 서울** (실행해 보지 못함)

```bash
gcloud run deploy doas-game --source . \
  --region asia-northeast3 --allow-unauthenticated \
  --timeout=3600 --max-instances=1 --min-instances=0 \
  --cpu=1 --memory=512Mi --concurrency=250 \
  --no-cpu-throttling --session-affinity \
  --set-env-vars ROOMS=3,ALLOWED_ORIGINS=https://<정적호스트> \
  --set-secrets SAVE_SECRET=doas-save-secret:latest
```

한 시간마다 연결이 끊기는 것을 클라이언트 재접속이 매끄럽게 덮지 못하면 쓰지 않는다.

### 2.10 공용 Dockerfile

Fly, Cloud Run, Northflank, Koyeb, Railway, 클라우드타입이 모두 Dockerfile을 받는다. **Docker 데몬이 없어 빌드해 보지 못한 예시다.** 서버 번들이 `--external:ws`이므로 실행 이미지에는 `ws`만 설치하면 된다.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8080 CLIENT_DIR=/app/dist/client DATA_DIR=/tmp/doas-data
USER node
EXPOSE 8080
CMD ["node", "dist/server/main.js"]
```

`.dockerignore`에 `node_modules`, `dist`, `.git`, `.data`, `tests/e2e/out`을 넣는다.

`DATA_DIR=/tmp/doas-data`는 "디스크가 임시인 플랫폼"용 기본값이다. 볼륨을 붙이는 곳에서는 환경변수로 마운트 경로를 준다. `SAVE_SECRET`은 이미지에 넣지 않고 플랫폼의 비밀값 기능으로 준다.

Node 버전(2026-11-26, nodejs.org 배포 목록과 릴리스 일정) [데이터]: v26 "Lithium"이 2026-10-28부터 Active LTS(최신 26.13.1), v24 "Krypton"은 Maintenance LTS(24.22.3, 2028-04까지), v22 "Jod"는 Maintenance(22.23.5, 2027-04까지), v20은 2026-04-30에 지원이 끝났다. 05 문서의 측정이 Node 22에서 이뤄졌고 Render 기본값이 24이므로 **24로 고정**하는 것이 무난하다. `package.json`의 `engines`는 `>=20`인데, 이미 지원이 끝난 20을 허용하고 상한이 없다.

---

## 3. Part C — 정적 클라이언트를 따로 올릴 때

### 3.1 언제 따로 올리나

- "파운더리"가 정적 파일만 받는 경우.
- 방문자가 몰릴 때 정적 파일 전송을 서버 전송량에서 빼고 싶은 경우(§2.3).
- 서버를 옮겨도 사용자가 아는 주소(`https://game…`)를 그대로 두고 싶은 경우.

그렇지 않다면 **Node 서버가 정적 파일까지 서빙하는 한 주소 구성이 가장 단순하다.** 같은 출처이므로 CORS도, `config.js` 수정도 필요 없다.

### 3.2 정적 호스트 비교

| 호스트 | 무료 한도 | 배포 | 알아 둘 것 |
|---|---|---|---|
| **Cloudflare Workers 정적 에셋** | "정적 에셋 요청은 무료이고 무제한". 파일 20,000개, 파일당 25MiB | `wrangler deploy`, Git 연동 | `_headers`, `_redirects` 지원. 나중에 `worker/` 어댑터(06 문서)와 한 Worker로 합칠 수 있다 |
| Cloudflare Pages | 빌드 월 500회, 파일 20,000개, 파일당 25MiB, `_headers` 규칙 100개 | Git 연동 | Workers 쪽이 기능이 더 넓다고 문서가 안내 |
| Vercel (Hobby) | Fast Data Transfer 월 100GB(가이드라인), 배포 하루 100회 | Git 연동 | Hobby의 상업적 이용 제한은 이번에 문장을 확인하지 못했다. Functions가 WebSocket을 지원하지만(문서: 모든 플랜), 함수 최대 실행 시간에 연결이 닫히고 "방·카운터 등은 외부 저장소에 두라"고 안내하므로 방 서버로는 맞지 않는다. 공개 베타 시작이 2026-06이라는 것은 검색 요약으로만 봤다 |
| Netlify (Free) | **월 300 크레딧.** 프로덕션 배포 1회 15크레딧, 전송 1GB당 20크레딧, 요청 1만 건당 2크레딧 | Git 연동 | 크레딧이 떨어지면 **모든 프로젝트가 일시 정지**되고 "Site not available"이 뜬다. 배포 20번이면 한 달 치가 끝난다 |
| GitHub Pages | 사이트 1GB, 전송 월 100GB(소프트), 빌드 시간당 10회(소프트) | Actions 또는 브랜치 | 상업 서비스 용도는 금지. **프로젝트 사이트는 `/저장소이름/` 아래에 서빙된다**(아래 함정 참고) |

[문서]

추천: **Cloudflare Workers 정적 에셋.** 전송량 걱정이 없고 한국 사용자에게 가깝다.

```toml
# wrangler.toml — 정적 파일만 올릴 때 (06 문서는 wrangler.jsonc를 권한다. 내용은 같다)
name = "doas-client"
compatibility_date = "2026-11-26"

[assets]
directory = "./dist/client/"
not_found_handling = "single-page-application"
```

캐시 헤더(`dist/client/_headers`로 들어가도록 `client/public/_headers`에 둔다):

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/config.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
```

`config.js`가 오래 캐시되면 서버를 옮겼을 때 옛 주소로 접속한다.

### 3.3 `wss://`가 아니면 접속 자체가 안 된다

https로 받은 페이지에서 `ws://` 주소로 접속을 시도했다. 호스트 이름을 Chromium 옵션으로 127.0.0.1에 매핑해 실제 사이트와 같은 조건을 만들었다. [실측-로컬]

```
plain: THROW SecurityError: Failed to construct 'WebSocket': An insecure WebSocket connection
       may not be initiated from a page loaded over HTTPS.
tls  : open | msg hi-tls | close 1005
콘솔 : Mixed Content: The page at 'https://app.example.test:18443/' was loaded over HTTPS, but attempted
       to connect to the insecure WebSocket endpoint 'ws://game.example.test:18080/ws'.
       This request has been blocked; this endpoint must be available over WSS.
```

- `error` 이벤트가 아니라 **생성자가 예외를 던진다.** `new WebSocket()`을 `try/catch`로 감싸지 않으면 재접속 루프가 통째로 죽는다.
- `client/src/core/config.ts`의 `wsUrl()`은 `http`→`ws`, `https`→`wss`로 바꾼다. 따라서 `config.js`의 `server`는 **반드시 `https://`로 시작**해야 한다.
- `localhost`와 `127.0.0.1`은 예외로 허용되므로 개발 환경에서는 이 문제가 드러나지 않는다(MDN: 로컬 주소는 보안 출처로 취급).
- PaaS는 `https` 주소를 자동으로 준다. VPS는 도메인 + Caddy가 필요하다(§2.8).

### 3.4 CORS와 Origin 심사

정적 호스트 둘(허용 목록에 있는 출처와 없는 출처)을 흉내 내고 게임 서버 하나에 접속시켰다. [실측-로컬]

```
허용 출처   : fetch ok {"rooms":[…]}   | ws: open | msg {"t":"welcome","origin":"http://127.0.0.1:18001"} | close 1005
비허용 출처 : fetch FAILED Failed to fetch | ws: error | close 1006 clean=false
Node, Origin 없음 : HTTP 403
Node, Origin 위조 : open
```

읽는 법:

- **WebSocket에는 CORS가 적용되지 않는다.** 브라우저는 어느 출처의 페이지에서든 접속을 시도하고 `Origin` 헤더만 붙인다. 막는 것은 서버의 일이다. 서버가 403으로 거절하면 브라우저에는 `error` → `close 1006`만 보이고 이유는 알 수 없다.
- **`fetch('/api/rooms')`에는 CORS가 적용된다.** 서버가 `Access-Control-Allow-Origin`을 안 붙이면 요청은 서버에 도달하지만 브라우저가 응답을 버린다.
- **Origin 심사는 사람을 인증하지 않는다.** 브라우저가 아닌 프로그램은 `Origin`을 마음대로 적는다(마지막 줄). 이 심사의 목적은 "다른 웹사이트가 방문자의 브라우저로 우리 서버에 붙는 것"을 막는 것뿐이다. 봇은 속도 제한·IP 제한·서버 권위 판정으로 막는다.

실험에 쓴 서버 코드(그대로 동작 확인):

```ts
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)

function originAllowed(origin: string | undefined): boolean {
  if (ALLOWED.length === 0) return true // 개발: 전부 허용
  if (!origin) return false             // 운영: Origin 없는(브라우저가 아닌) 접속은 거절
  return ALLOWED.includes(origin)
}

const http = createServer((req, res) => {
  const origin = req.headers.origin
  if (req.url?.startsWith('/api/')) {
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin) // '*' 대신 요청 출처를 그대로
      res.setHeader('Vary', 'Origin')                      // 캐시가 출처별로 갈리도록
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' })
      res.end(); return
    }
    // … /api/rooms 응답
  }
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false })
http.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://x')
  if (pathname !== '/ws' || !originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})
```

`ALLOWED_ORIGINS`에는 스킴과 호스트(와 포트)만 적는다. 끝의 `/`와 경로는 넣지 않는다. 브라우저가 보내는 `Origin` 값이 그 형태다(실험 로그의 `http://127.0.0.1:18001`).

**현재 `server/node/main.ts`와 다른 점 두 가지(둘 다 지금 구현이 틀린 것은 아니다).**

- 현재 구현은 `Origin`이 없는 접속을 통과시킨다(부하 테스트·점검 도구용, 주석에 이유가 적혀 있다). 위 실험 코드는 거절한다. 어차피 위조할 수 있으므로 보안상 차이는 없고, 통과시키는 쪽이 운영이 편하다.
- 현재 구현은 `/api/rooms`에 `Access-Control-Allow-Origin: *`를 붙인다. 쿠키를 쓰지 않고 방 목록은 공개 정보이므로 문제없다. 나중에 인증 쿠키나 개인 정보가 실리는 API가 생기면 위 코드처럼 "허용 목록에 있는 출처만 그대로 돌려주는" 방식으로 바꾼다.

### 3.5 체크리스트와 함정

1. `config.js`: `server: 'https://<서버 주소>'`. 끝에 `/` 없이.
2. 서버 환경변수: `ALLOWED_ORIGINS=https://<정적 호스트 주소>`. 미리보기 주소(`*.pages.dev`, `*.vercel.app`의 브랜치별 주소)는 정확히 일치하는 값만 통과하므로 따로 넣어야 한다.
3. **`ALLOWED_ORIGINS`를 비워 두면 "전부 허용"이다**(ARCHITECTURE.md). 운영에서 빠뜨리면 조용히 열려 있다. 운영 환경에서 비어 있으면 시작할 때 경고를 찍는 것이 좋다.
4. 정적 호스트가 CSP를 건다면 `connect-src`에 `https://<서버>`와 `wss://<서버>`를 둘 다 넣는다.
5. **GitHub Pages 프로젝트 사이트에서는 지금 빌드가 깨진다.** `dist/client/index.html`이 `/config.js`, `/assets/…`를 절대 경로로 부른다. `https://<계정>.github.io/<저장소>/` 아래에서는 404다. 커스텀 도메인(루트 서빙)을 쓰거나, Vite `base: './'`로 바꾸고 `index.html`의 `/config.js`를 상대 경로로 고쳐야 한다. Cloudflare, Vercel, Netlify는 루트에 서빙하므로 문제없다. [실측-로컬: 빌드 결과 확인]
6. Render 무료처럼 잠드는 서버라면 클라이언트가 첫 화면에서 `/api/rooms` 실패를 "깨우는 중"으로 처리한다.
7. 쿠키를 쓰지 않으므로 `Access-Control-Allow-Credentials`는 필요 없다. 넣지 않는다.
8. Cloudflare를 서버 앞단 프록시로 쓰는 경우: WebSocket은 모든 플랜에서 지원되고, "일정 시간 양방향 데이터가 없으면" 닫으며, Cloudflare가 자체 코드를 배포할 때 서버 재시작으로 연결이 끊길 수 있다. 우리 서버는 조용한 방에도 1초에 한 번 스냅샷을 보내므로 유휴에는 걸리지 않는다. [문서]

---

## 4. 우리 게임에 적용할 것

**지금 할 것**

1. **사용자에게 "파운더리"의 주소를 묻는다**(§1.4의 한 줄). 답을 기다리는 동안 Render 무료에 올려 공유 가능한 주소를 먼저 만든다.
2. **`SAVE_SECRET`을 환경변수로 고정한다.** 값이 없으면 서버가 `DATA_DIR/secret`에 만들어 쓰는데, PaaS의 임시 디스크에서는 쓰기가 성공해 경고가 안 뜨고, 다음 재시작 때 새 키가 만들어져 전 사용자의 진행도 서명이 깨진다. `NODE_ENV=production`인데 `SAVE_SECRET`이 없으면 시작할 때 경고를 찍는다.
3. **인스턴스 1개를 설정에 못 박는다.** Render `numInstances: 1`, Fly `--ha=false` + `fly scale count 1`, Cloud Run `--max-instances=1`.
4. **Node 버전을 고정한다.** `.node-version`에 `24.22.3`. `engines`는 `>=22 <27`처럼 상한을 둔다(06 문서에 따르면 `wrangler` 4.168.0도 Node 22.12 이상을 요구한다).
5. **교단 기록(`cults.json`)을 어디에 둘지 정한다.** 디스크가 임시인 곳(Render 무료, Cloud Run, 볼륨 없는 Fly)에서는 재시작마다 순위가 사라진다. 선택지: (a) 시험 단계에서는 사라져도 된다고 정하고 화면에 "시험 운영 중"을 적는다, (b) 영구 디스크가 있는 곳에 둔다(VPS, Fly 볼륨, Render 유료 디스크).
6. **클라이언트: `new WebSocket()`을 `try/catch`로 감싼다**(§3.3). 재접속은 지수 백오프(1초 → 최대 30~60초). `close 1006`은 "서버 거절, 잠든 서버, 네트워크 끊김"을 구분할 수 없으므로 `/healthz`를 한 번 찔러 문구를 고른다.
7. **운영에서 `ALLOWED_ORIGINS`가 비어 있으면 경고를 찍는다.** 지금은 시작 로그에 "허용 출처: 전부 허용"이라고만 나온다.
8. **`docs/DEPLOY.md`를 만든다.** `client/index.html`의 주석이 이미 이 파일을 가리킨다. §2.7, §2.8, §3.5를 옮기면 된다.

이미 돼 있어서 손댈 필요가 없는 것(`server/node/main.ts`에서 확인): `PORT` 읽기와 전체 인터페이스 바인드, `/healthz`, `upgrade` 단계의 Origin 심사, `/api/rooms`의 CORS 헤더, 정적 파일 br/gzip 압축과 캐시 헤더, SIGTERM 종료 처리, 20초 간격 하트비트.

**출시 전에 할 것**

9. **서울 VPS로 옮긴다**(§2.8). 지연 1.5ms, 전송 1TB 포함. 인스타그램에 올린 뒤 전송량이 늘어도 요금이 고정이고, 교단 기록이 디스크에 남는다.
10. **정적 클라이언트를 Cloudflare Workers 정적 에셋으로 뺀다**(§3.2). 방문자 폭주를 서버가 안 받는다. 이때 §3.5의 1~3번을 적용한다.
11. **배포 = 전원 재접속**임을 받아들이고 클라이언트 쪽을 다듬는다. 서버의 종료 알림을 받으면 "서버를 새로 고치는 중" 문구 → 자동 재접속 → 서명된 저장으로 진행도 복구.
12. **IP별 접속 제한을 넣는다면** `TRUST_PROXY` 같은 환경변수를 추가해(뒤에 추가만) 켜져 있을 때만 `X-Forwarded-For`를 IP로 쓴다. 프록시 뒤에서 이 설정 없이 IP 제한을 켜면 전원이 한 IP로 묶인다.

**하지 않을 것**

- Cloud Run을 주 서버로 쓰기(60분 끊김, 상시 가동 시 비쌈).
- Oracle 무료 인스턴스를 출시 서버로 쓰기(유휴 회수 조건에 해당).
- 카페24 Node.js 호스팅, 클라우드타입 무료·하비.
- 여러 인스턴스로 늘리기. 방이 100개를 넘어 프로세스를 나눠야 할 때는 05 문서 7.4절(방 id로 프로세스 분할)과 06 문서(DO)를 따른다.

---

## 5. 확인 못한 것

| 항목 | 상태 |
|---|---|
| 사용자가 말한 "파운더리"의 실체 | 검색으로 특정 실패. 사용자 확인 필요 |
| 실제 배포 | 어느 플랫폼에도 계정이 없어 배포해 보지 못함. 절차는 문서 근거 |
| Dockerfile, `fly.toml`, `gcloud` 명령, systemd·Caddy 설정 | 작성만 하고 실행하지 못함(Docker 데몬 없음) |
| Fly.io 도쿄 머신 단가, `idle_timeout` 기본값, 열린 WebSocket이 자동 정지를 막는지 | 문서에 수치·명시 없음 |
| Koyeb 신규 가입자의 무료 사용 가능 여부 | 요금 페이지(무료 플랜 없음)와 문서(Free 인스턴스 설명)가 어긋남. 2026-02 폐지설은 제3자 글 |
| Northflank `asia-northeast` 등의 실제 도시, 무료 Sandbox의 리전·컴퓨트 제한 | 문서에 도시명 없음 |
| Railway Free 플랜에서 리전 선택 가능 여부 | 문서에 없음 |
| Cloud Run 서울의 인스턴스 과금 단가가 정확히 Tier 2 값인지, 인터넷 송신 단가 | 페이지 데이터에서 값만 확인. 서울을 고른 화면은 못 봄 |
| Vultr·Lightsail의 전송량 초과 단가 | Vultr 웹 페이지 403. Lightsail 페이지에는 오브젝트 스토리지 단가($0.126/GB, 서울)만 있음 |
| Lightsail 무료 체험 | 요금 페이지는 "프리 티어로 무료 시작"이라고만 적음. 3개월 무료가 2025-07-15 이후 가입 계정에 없다는 것은 커뮤니티 글 |
| Oracle A1 인스턴스를 서울 리전에서 실제로 만들 수 있는지(용량) | 문서는 "용량 부족 오류가 날 수 있다"고만 함 |
| NCP 서버·공인 IP·트래픽 요금 숫자 | 요금표가 동적으로 채워져 읽지 못함. 제3자 글은 Micro 월 약 10,850원 |
| 카페24 Node.js 호스팅의 WebSocket 지원, 트래픽 용량의 단위(일/월) | 페이지에 없음 |
| 카페24 개발언어 VPS 최저가 | 기사는 33,000원, 카페24 페이지 문구는 49,500원~. 어긋남 |
| 클라우드타입의 WebSocket 1/5/30분이 유휴 기준인지 절대 기준인지, 리전 | 요금 페이지에 없음 |
| Vercel Hobby의 상업적 이용 금지 문장 | 읽은 페이지에 해당 절이 비어 있었음 |
| Cloudflare 프록시의 WebSocket 유휴 타임아웃 초 수 | 문서에 "일정 시간"이라고만 있음 |
| Caddy 최신 버전 | 검색으로 2.11.1까지 확인. 그 뒤 릴리스는 확인 못함 |
| 실제 한국 가정·모바일망에서 각 리전까지의 지연 | 표는 데이터센터 간 값. 실제 측정 필요 |

---

## 6. 출처 (직접 읽은 것)

Part A
- https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents
- https://palantir.com/docs/foundry/developer-console/deploy-custom-application-on-foundry/
- https://palantir.com/docs/foundry/data-connection/listeners-websocket/
- https://docs.cloudfoundry.org/adminguide/supporting-websockets.html

Part B
- Render: https://render.com/pricing · https://render.com/docs/free · https://render.com/docs/websocket · https://render.com/docs/regions · https://render.com/docs/node-version · https://render.com/docs/environment-variables · https://render.com/docs/blueprint-spec
- Railway: https://railway.com/pricing · https://docs.railway.com/reference/pricing/plans · https://docs.railway.com/reference/regions · https://docs.railway.com/networking/public-networking/specs-and-limits · https://docs.railway.com/reference/app-sleeping · https://docs.railway.com/reference/railpack
- Fly.io: https://docs.fly.io/about/pricing · https://docs.fly.io/about/free-plan · https://docs.fly.io/reference/regions · https://docs.fly.io/launch/autostop-autostart · https://docs.fly.io/reference/fly-proxy-autostop-autostart · https://docs.fly.io/reference/configuration
- Koyeb: https://www.koyeb.com/pricing · https://www.koyeb.com/docs/reference/instances · https://www.koyeb.com/docs/reference/regions
- Northflank: https://northflank.com/pricing · https://northflank.com/cloud/northflank/regions · https://northflank.com/docs/v1/application/run/deploy-to-a-region
- Cloud Run: https://docs.cloud.google.com/run/docs/triggering/websockets · https://cloud.google.com/run/pricing · https://docs.cloud.google.com/run/docs/deploying-source-code
- Oracle: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Hetzner: https://www.hetzner.com/cloud/ · https://www.hetzner.com/cloud/regular-performance/
- Vultr: https://api.vultr.com/v2/plans · https://api.vultr.com/v2/regions
- Lightsail: https://aws.amazon.com/lightsail/pricing/ · https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html
- 카페24: https://hosting.cafe24.com/?controller=new_product_page&page=nodejs · https://magazine.hankyung.com/business/article/202608264607b
- NCP: https://www.ncloud.com/product/compute/server
- 클라우드타입: https://cloudtype.io/pricing
- 지연: https://www.cloudping.co/api/latencies?percentile=p_50&timeframe=1W
- Node: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json · https://nodejs.org/dist/index.json
- Caddy: https://caddyserver.com/docs/install

Part C
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ · https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ · https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/network/websockets/ · https://developers.cloudflare.com/fundamentals/reference/connection-limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/reference/data-location/
- https://vercel.com/docs/limits · https://vercel.com/docs/limits/fair-use-guidelines · https://vercel.com/docs/functions/websockets
- https://www.netlify.com/pricing/ · https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content

로컬 실험 파일(임시 폴더, 저장소 밖): `/tmp/claude-0/-home-user-Bug-arena/5d9aed2a-d9b6-565c-8ef8-6ff87e511c45/scratchpad/research-hosting-foundry/exp/` 의 `server.mjs`, `test.mjs`, `mixed.mjs`
