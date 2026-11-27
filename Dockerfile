# 도를 아십니까? — 교주 시뮬레이터
# 한 컨테이너가 게임 서버(WebSocket)와 클라이언트 정적 파일을 함께 제공한다.
#   docker build -t doas .
#   docker run -p 8787:8787 -e SAVE_SECRET=<바꾸지 않을 무작위 값> -v doas-data:/data doas

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
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# 저장 서명 키와 교단 기록이 여기에 남는다. 볼륨을 붙이지 않으면 컨테이너를 새로 만들 때마다 사라진다
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "dist/server/main.js"]
