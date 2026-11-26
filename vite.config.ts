import { defineConfig } from 'vite'

const SERVER = process.env.DEV_SERVER_ORIGIN || 'http://localhost:8787'

// 클라이언트는 client/ 를 루트로 빌드되어 dist/client 로 나간다.
// 개발 중에는 /ws, /api 요청을 Node 게임 서버(기본 8787)로 프록시한다.
export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
