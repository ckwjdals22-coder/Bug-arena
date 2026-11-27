import "server-only";
import { cookies } from "next/headers";
import { safeNextPath } from "@/lib/cookies";
import { env } from "@/lib/env";
import { finishKakaoLogin, isKakaoEnabled, kakaoCookieNames, kakaoCookieOptions, kakaoFailureReason } from "@/server/auth/kakao";
import { createSession, destroySession } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { getClientIp } from "@/server/request";
import { enforceRateLimit } from "@/server/security/rate-limit";

/**
 * 카카오에서 돌아오는 주소(GET /api/auth/kakao/callback?code=…&state=…).
 * - state 를 시작할 때 심은 쿠키와 비교하고(한 번 쓰면 지운다), 코드 교환·프로필 조회·로그인 판정은 kakao.ts 가 한다.
 * - 회원이 정해지면 세션을 새로 발급하고 원래 가려던 경로로 보낸다.
 * - 처음 온 카카오 계정이면 가입 대기 정보를 HttpOnly 쿠키(10분)에 담아 /signup/kakao 로 보낸다.
 * - 실패하면 /login?error=kakao_{사유} 로 보낸다. 토큰·코드는 어디에도 기록하지 않는다.
 */

/** 카카오 가입 화면 경로 */
const SIGNUP_PATH = "/signup/kakao";

const absolute = (path: string) => `${env().APP_URL.replace(/\/+$/, "")}${path}`;

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const jar = await cookies();
  const names = kakaoCookieNames();
  const expired = { ...kakaoCookieOptions(), maxAge: 0 };
  const expectedState = jar.get(names.state)?.value ?? null;
  const next = safeNextPath(jar.get(names.next)?.value);
  // state 는 한 번만 쓴다. 성공하든 실패하든 지운다.
  jar.set(names.state, "", expired);

  const fail = (e: unknown) => {
    if (!(e instanceof AppError)) console.error("[kakao] 콜백 처리 중 예기치 못한 오류", e instanceof Error ? e.name : "unknown");
    jar.set(names.next, "", expired);
    const query = next === "/" ? "" : `&next=${encodeURIComponent(next)}`;
    return redirect(absolute(`/login?error=kakao_${kakaoFailureReason(e)}${query}`));
  };

  if (!isKakaoEnabled()) return fail(new AppError("NOT_CONFIGURED", "카카오 로그인이 아직 연결되지 않았어요."));
  try {
    await enforceRateLimit(`kakao-callback:ip:${(await getClientIp()).slice(0, 64)}`, 30, 600);
    const params = new URL(request.url).searchParams;
    const result = await finishKakaoLogin({
      code: params.get("code"),
      state: params.get("state"),
      expectedState,
      error: params.get("error"),
    });

    if (result.needsSignup) {
      // 복귀 경로 쿠키는 가입을 마칠 때까지 남겨 둔다.
      jar.set(names.pending, result.pending, kakaoCookieOptions());
      return redirect(absolute(SIGNUP_PATH));
    }
    // 이전 세션을 끊고 새 토큰을 발급한다(세션 고정 방지).
    await destroySession("user");
    await createSession(result.userId, "user");
    jar.set(names.next, "", expired);
    jar.set(names.pending, "", expired);
    return redirect(absolute(next));
  } catch (e) {
    return fail(e);
  }
}
