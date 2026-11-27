# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 빌드 단계에서는 DB 에 접속하지 않는다(스키마 검증용 더미 주소).
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npx next build

# 마이그레이션·시드 실행용 이미지(개발 의존성 포함)
FROM builder AS tools
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
