# 도를 아십니까? — 교주 시뮬레이터
# 한 컨테이너가 게임 서버(WebSocket)와 클라이언트 정적 파일을 함께 제공한다.
#   docker build -t doas .
#   docker run -p 8787:8787 -e SAVE_SECRET=<바꾸지 않을 무작위 값> -v doas-data:/data doas
# 이름 있는 볼륨(-v doas-data:/data)을 쓰면 처음 만들 때 이 이미지의 /data 소유자(node)를 물려받는다.
# 호스트 폴더를 붙일 때(-v /srv/doas:/data)는 그 폴더를 uid 1000 이 쓸 수 있게 해 둔다(chown 1000:1000 /srv/doas).
# 쓸 수 없으면 서버는 조용히 돌지 않고 한 줄 이유를 남기고 끝난다(docs/DEPLOY.md §3.3).

# ── 1단계: 빌드 ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── 2단계: 실행(런타임 의존성 ws 만 설치) ──
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    CLIENT_DIR=/app/dist/client
# ALLOWED_ORIGINS 를 비워 두면 같은 주소에서 연 화면만 WebSocket 접속을 받는다(기본).
# 클라이언트를 다른 주소에 따로 올렸다면 docker run -e ALLOWED_ORIGINS=https://play.example.com
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY THIRD_PARTY_LICENSES.txt ./
# 저장 서명 키·교단 기록·잠금 파일이 여기에 남는다. 볼륨을 붙이지 않으면 컨테이너를 새로 만들 때마다 사라진다.
# 실행 사용자(node)가 /data 를 소유해야 한다. 앱 파일은 root 소유 그대로 둔다(실행 중에 고쳐 쓸 이유가 없다)
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8787
# /healthz 는 저장이 실패하는 동안 503 → wget 이 실패 코드로 끝나 컨테이너가 unhealthy 로 보인다
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
# node 를 직접(PID 1) 띄운다: SIGTERM 을 받아 접속자에게 알리고 마지막 기록을 저장한 뒤 끝난다
CMD ["node", "--enable-source-maps", "dist/server/main.js"]
