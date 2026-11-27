/** 쿠키 이름 — 프록시(src/proxy.ts)와 서버 코드가 함께 쓴다. */
const secure = () => (process.env.APP_URL ?? "").startsWith("https://");

/** HTTPS 운영 환경에서는 __Host- 접두사로 하위 도메인 쿠키 주입을 막는다. */
export const userCookieName = () => (secure() ? "__Host-nj_session" : "nj_session");
export const adminCookieName = () => (secure() ? "__Host-nj_admin" : "nj_admin");
/** 여러 사업장을 가진 회원이 현재 보고 있는 사업장 */
export const BUSINESS_COOKIE = "nj_biz";
/** 비로그인 방문자 익명 ID(분석용) */
export const VISITOR_COOKIE = "nj_vid";
export const cookieSecure = secure;

/** 로그인 후 돌아갈 경로 검증 — 같은 사이트의 상대 경로만 허용(오픈 리다이렉트 방지) */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}
