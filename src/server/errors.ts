import { ZodError } from "zod";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SOLD_OUT"
  | "CLOSED"
  | "PAYMENT_FAILED"
  | "NOT_CONFIGURED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SOLD_OUT: 409,
  CLOSED: 409,
  PAYMENT_FAILED: 402,
  NOT_CONFIGURED: 503,
  INTERNAL: 500,
};

/** 사용자에게 그대로 보여 줘도 되는 메시지를 담는 업무 오류 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: Record<string, string>;

  constructor(code: ErrorCode, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.fieldErrors = fieldErrors;
  }
}

export const err = {
  unauthenticated: (m = "로그인이 필요해요.") => new AppError("UNAUTHENTICATED", m),
  forbidden: (m = "이 작업을 할 권한이 없어요.") => new AppError("FORBIDDEN", m),
  notFound: (m = "찾을 수 없어요.") => new AppError("NOT_FOUND", m),
  validation: (m: string, fieldErrors?: Record<string, string>) => new AppError("VALIDATION", m, fieldErrors),
  conflict: (m: string) => new AppError("CONFLICT", m),
  rateLimited: (m = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.") => new AppError("RATE_LIMITED", m),
  soldOut: (m = "방금 자리가 마감됐어요.") => new AppError("SOLD_OUT", m),
  closed: (m = "예약이 마감된 자리예요.") => new AppError("CLOSED", m),
  payment: (m: string) => new AppError("PAYMENT_FAILED", m),
  notConfigured: (m: string) => new AppError("NOT_CONFIGURED", m),
};

/** 서버 액션의 표준 반환 형식 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; fieldErrors?: Record<string, string> } };

export function toActionError(e: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (e instanceof AppError) {
    return { ok: false, error: { code: e.code, message: e.message, fieldErrors: e.fieldErrors } };
  }
  if (e instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of e.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    const first = e.issues[0]?.message ?? "입력값을 확인해 주세요.";
    return { ok: false, error: { code: "VALIDATION", message: first, fieldErrors } };
  }
  console.error("[unexpected]", e);
  return { ok: false, error: { code: "INTERNAL", message: "일시적인 오류가 생겼어요. 잠시 후 다시 시도해 주세요." } };
}

/** Next.js 의 redirect()/notFound() 가 던지는 제어용 예외인지 */
export function isNextControlFlow(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("digest" in e)) return false;
  const digest = String((e as { digest?: unknown }).digest ?? "");
  return digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") || digest === "NEXT_NOT_FOUND";
}

/**
 * 서버 액션 본문을 감싸 AppError·검증 오류를 ActionResult 로 바꾼다.
 * redirect()/notFound() 는 그대로 통과시킨다.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    return toActionError(e);
  }
}
