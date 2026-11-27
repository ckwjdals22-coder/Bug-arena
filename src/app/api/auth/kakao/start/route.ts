import "server-only";
import { cookies } from "next/headers";
import { safeNextPath } from "@/lib/cookies";
import { env } from "@/lib/env";
import { beginKakaoLogin, isKakaoEnabled, kakaoCookieNames, kakaoCookieOptions, kakaoFailureReason } from "@/server/auth/kakao";
import { getClientIp } from "@/server/request";
import { enforceRateLimit } from "@/server/security/rate-limit";

/**
 * 카카오 로그인 시작(GET /api/auth/kakao/start?next=…).
 * 무작위 state 와 로그인 뒤 돌아갈 경로를 HttpOnly·SameSite=Lax 쿠키(10분)에 심고 카카오 동의 화면으로 보낸다.
 * 연동 키가 없거나 요청이 너무 잦으면 로그인 화면으로 돌려보낸다(/login?error=kakao_{사유}).
 */

/** 쿠키에 담을 수 있는 길이의 복귀 경로만 받는다. */
const NEXT_MAX_LENGTH = 512;

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

const loginUrl = (reason: string) => `${env().APP_URL.replace(/\/+$/, "")}/login?error=kakao_${reason}`;

export async function GET(request: Request): Promise<Response> {
  if (!isKakaoEnabled()) return redirect(loginUrl("not_configured"));
  try {
    await enforceRateLimit(`kakao-start:ip:${(await getClientIp()).slice(0, 64)}`, 30, 600);
    const requested = new URL(request.url).searchParams.get("next");
    const next = safeNextPath(requested && requested.length <= NEXT_MAX_LENGTH ? requested : null);
    const { state, authorizeUrl } = beginKakaoLogin();

    const jar = await cookies();
    const names = kakaoCookieNames();
    jar.set(names.state, state, kakaoCookieOptions());
    jar.set(names.next, next, kakaoCookieOptions());
    // 이전 시도에서 남은 가입 대기 정보는 지운다.
    jar.set(names.pending, "", { ...kakaoCookieOptions(), maxAge: 0 });
    return redirect(authorizeUrl);
  } catch (e) {
    return redirect(loginUrl(kakaoFailureReason(e)));
  }
}
