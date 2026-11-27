import { NextResponse, type NextRequest } from "next/server";
import { adminCookieName, userCookieName, VISITOR_COOKIE } from "@/lib/cookies";

/**
 * 모든 요청 앞단에서 실행된다.
 * 1) 상태를 바꾸는 API 요청의 Origin 검사(CSRF 방어 — 서버 액션은 Next.js 가 자체 검사)
 * 2) 로그인 쿠키가 아예 없는 보호 경로 접근을 로그인 화면으로 돌려보냄(실제 권한 확인은 서버 가드가 다시 수행)
 * 3) nonce 기반 CSP 와 보안 헤더 부착
 */

const isDev = process.env.NODE_ENV !== "production";
const isHttps = (process.env.APP_URL ?? "").startsWith("https://");

function buildCsp(nonce: string): string {
  const storageOrigin = (() => {
    try {
      return process.env.S3_PUBLIC_BASE_URL ? new URL(process.env.S3_PUBLIC_BASE_URL).origin : "";
    } catch {
      return "";
    }
  })();
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: ${storageOrigin}`.trim(),
    `font-src 'self' data:`,
    `connect-src 'self' https://*.tosspayments.com${isDev ? " ws: wss:" : ""}`,
    `frame-src 'self' https://*.tosspayments.com https://*.toss.im`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (isHttps) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

function applySecurityHeaders(res: NextResponse, csp: string): NextResponse {
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(self), geolocation=(self), microphone=(), payment=(self)");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (isHttps) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  return res;
}

/** Origin 헤더가 이 사이트와 같은 출처인지 */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // 브라우저는 교차 출처 POST 에 항상 Origin 을 붙인다. 없으면 Sec-Fetch-Site 로 한 번 더 확인한다.
    const site = request.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) allowed.add(host);
  try {
    if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).host);
  } catch {
    // APP_URL 형식 오류는 env 검증에서 잡힌다.
  }
  return allowed.has(originHost);
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildCsp(nonce);

  // 1) API 변경 요청 Origin 검사 — 서명·비밀값으로 따로 인증하는 웹훅·크론은 제외
  if (pathname.startsWith("/api/") && MUTATING.has(request.method)) {
    const exempt = pathname.startsWith("/api/webhooks/") || pathname.startsWith("/api/cron/");
    if (!exempt && !sameOrigin(request)) {
      return applySecurityHeaders(
        NextResponse.json({ error: { code: "FORBIDDEN", message: "허용되지 않은 요청이에요." } }, { status: 403 }),
        csp,
      );
    }
  }

  // 2) 보호 경로의 1차 관문
  const hasUser = request.cookies.has(userCookieName());
  const hasAdmin = request.cookies.has(adminCookieName());
  const needsUser =
    pathname.startsWith("/my") ||
    pathname.startsWith("/book/") ||
    (pathname.startsWith("/seller") && !pathname.startsWith("/seller/intro"));
  if (needsUser && !hasUser) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return applySecurityHeaders(NextResponse.redirect(url), csp);
  }
  if (pathname.startsWith("/admin") && pathname !== "/admin/login" && !hasAdmin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return applySecurityHeaders(NextResponse.redirect(url), csp);
  }
  if (pathname.startsWith("/api/admin/") && !hasAdmin) {
    return applySecurityHeaders(
      NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "운영자 로그인이 필요해요." } }, { status: 401 }),
      csp,
    );
  }

  // 3) 요청 헤더로 nonce·현재 경로 전달 후 응답에 보안 헤더 부착
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-pathname", pathname + search);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  if (!request.cookies.has(VISITOR_COOKIE)) {
    res.cookies.set(VISITOR_COOKIE, crypto.randomUUID(), {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return applySecurityHeaders(res, csp);
}

export const config = {
  matcher: [
    // 정적 자산과 업로드 이미지를 제외한 모든 경로
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|robots.txt|sitemap.xml|fonts/).*)",
  ],
};
