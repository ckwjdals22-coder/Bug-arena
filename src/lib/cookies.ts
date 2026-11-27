/** 쿠키 이름 — 프록시(src/proxy.ts)와 서버 코드가 함께 쓴다. */
const secure = () => (process.env.APP_URL ?? "").startsWith("https://");

/** HTTPS 운영 환경에서는 __Host- 접두사로 하위 도메인 쿠키 주입을 막는다. */
export const userCookieName = () => (secure() ? "__Host-nj_session" : "nj_session");
export const adminCookieName = () => (secure() ? "__Host-nj_admin" : "nj_admin");
/** 여러 사업장을 가진 회원이 현재 보고 있는 사업장 */
export const BUSINESS_COOKIE = "nj_biz";
/** 비로그인 방문자 익명 ID(분석용) */
/**
 * 사업자 자체 링크(?via=slug, 외부에서 바로 연 /b/slug)로 들어온 방문의 사업자 slug.
 * 7일간 유지하며, 그 사업자의 자리를 예약하면 채널을 DIRECT(중개 수수료 0%)로 판정한다.
 */
export const REF_COOKIE = "nj_ref";
export const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export const VISITOR_COOKIE = "nj_vid";
export const cookieSecure = secure;

/** 로그인 후 돌아갈 경로 검증 — 같은 사이트의 상대 경로만 허용(오픈 리다이렉트 방지) */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}
