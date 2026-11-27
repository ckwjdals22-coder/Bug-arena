import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const SERVER = process.env.DEV_SERVER_ORIGIN || 'http://localhost:8787'

/**
 * 링크 미리보기(OGP)는 og:image·og:url 이 절대 주소여야 대부분의 메신저·SNS 가 읽는다.
 * 빌드할 때 PUBLIC_URL(예: https://game.example.com)을 주면 그 주소로 바꿔 넣고, 없으면 상대 주소 그대로 둔다
 * (어느 주소에 올릴지 모르는 빌드도 그대로 동작하게). docs/DEPLOY.md §2 참고.
 */
function publicUrlPlugin(): Plugin {
  const raw = (process.env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  let base = ''
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('http(s) 가 아님')
      base = u.toString().replace(/\/+$/, '')
    } catch (err) {
      throw new Error(`PUBLIC_URL="${raw}" 은 올바른 주소가 아닙니다: ${String(err)}`)
    }
  }
  const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return {
    name: 'doas-public-url',
    transformIndexHtml(html) {
      if (!base) return html
      return html
        .replace('<meta property="og:image" content="/og.jpg" />', `<meta property="og:image" content="${attr(base)}/og.jpg" />`)
        .replace('<meta property="og:type" content="website" />', `<meta property="og:type" content="website" />\n    <meta property="og:url" content="${attr(base)}/" />`)
    },
  }
}

/** 제3자 라이선스 고지(three.js·ws 의 MIT 원문)를 빌드 결과에 함께 싣는다(번들은 주석을 지우므로) */
function thirdPartyNoticesPlugin(): Plugin {
  return {
    name: 'doas-third-party-notices',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: fs.readFileSync(fileURLToPath(new URL('./THIRD_PARTY_LICENSES.txt', import.meta.url)), 'utf8'),
      })
    },
  }
}

// 클라이언트는 client/ 를 루트로 빌드되어 dist/client 로 나간다.
// 개발 중에는 /ws, /api 요청을 Node 게임 서버(기본 8787)로 프록시한다.
export default defineConfig({
  root: 'client',
  publicDir: 'public',
  plugins: [publicUrlPlugin(), thirdPartyNoticesPlugin()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // three.js 는 따로 묶는다: 게임 코드만 바뀐 배포에서 이 파일의 이름(해시)이 그대로라
        // 다시 찾아온 플레이어는 브라우저 캐시의 것을 쓰고 게임 코드만 새로 받는다.
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  server: {
    host: true,
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': {
        target: SERVER.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
        // 게임 서버는 기본적으로 같은 출처의 WebSocket 만 받는다. 프록시가 Host 를 서버 주소로 바꾸므로
        // Origin 도 서버 주소로 맞춰 준다(안 그러면 5173 에서 온 접속이 '남의 출처'로 거절된다)
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.setHeader('origin', SERVER)
          })
        },
      },
    },
  },
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // 확률 균형을 수십만 번 돌려 보는 테스트가 있어, 느린 CI/바쁜 기계에서도 시간 초과가 나지 않게 넉넉히 둔다
    testTimeout: 60_000,
  },
})
