/**
 * 실시간 서버 주소 결정.
 * 우선순위: URL ?server= (개발용) → window.DOAS_CONFIG.server (public/config.js) → 빌드 시 VITE_SERVER_URL → 같은 출처
 */
declare global {
  interface Window {
    DOAS_CONFIG?: { server?: string }
  }
}

function baseOrigin(): string {
  let s = ''
  try {
    s = new URLSearchParams(location.search).get('server') ?? ''
  } catch {
    s = ''
  }
  if (!s) s = window.DOAS_CONFIG?.server ?? ''
  if (!s) s = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? ''
  if (!s) s = location.origin
  return s.replace(/\/+$/, '')
}

/** HTTP API 주소 (예: apiUrl('/api/rooms')) */
export function apiUrl(path: string): string {
  return baseOrigin() + path
}

/** WebSocket 주소 (예: wsUrl('/ws?room=auto')) */
export function wsUrl(path: string): string {
  return baseOrigin().replace(/^http/i, 'ws') + path
}

/** URL 로 지정된 방(?room=2) — 친구 초대 링크용 */
export function roomFromUrl(): string | null {
  try {
    const r = new URLSearchParams(location.search).get('room')
    return r && /^[\w-]{1,16}$/.test(r) ? r : null
  } catch {
    return null
  }
}
