import "server-only";
import { z } from "zod";

/**
 * 서버 환경 변수. 값이 없을 때의 동작(개발 기본값 / 운영 필수)을 한곳에서 정한다.
 * 외부 연동 키가 비어 있으면 해당 기능은 "미연동" 상태로 동작하며 UI·문서에 그 사실을 표시한다.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  /** 서비스 공개 주소 (예: https://namneunjari.kr). Origin 검사·링크 생성에 사용 */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** 32바이트 키(base64). 계좌번호·TOTP 비밀키 암호화에 사용. 운영 필수 */
  APP_ENCRYPTION_KEY: z.string().optional(),
  /** 크론 엔드포인트 보호용 비밀값. 운영 필수 */
  CRON_SECRET: z.string().optional(),
  /** 1 이면 서버 프로세스 안에서 주기 작업을 직접 실행(단일 서버 배포용) */
  ENABLE_INTERNAL_CRON: z.string().optional(),

  /** 결제: mock(테스트 결제, 실제 청구 없음) | toss(토스페이먼츠) */
  PAYMENT_PROVIDER: z.enum(["mock", "toss"]).default("mock"),
  TOSS_CLIENT_KEY: z.string().optional(),
  TOSS_SECRET_KEY: z.string().optional(),

  /** 문자·알림톡: none(기록만 남김) | solapi */
  SMS_PROVIDER: z.enum(["none", "solapi"]).default("none"),
  SOLAPI_API_KEY: z.string().optional(),
  SOLAPI_API_SECRET: z.string().optional(),
  SOLAPI_SENDER: z.string().optional(),
  /** 카카오 알림톡 발신 프로필 ID(pfId). 없으면 문자로 발송 */
  SOLAPI_KAKAO_PFID: z.string().optional(),

  /** 이메일: 값이 없으면 기록만 남김 */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("남는자리 <no-reply@localhost>"),

  /** 이미지 저장: local(서버 디스크 ./uploads) | s3(S3 호환 스토리지) */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),

  /** 1 이면 데모 계정 빠른 로그인 등 시연용 기능을 노출. 운영에서는 반드시 비움 */
  DEMO_MODE: z.string().optional(),
  /**
   * 앱 앞단의 신뢰할 수 있는 리버스 프록시 수. X-Forwarded-For 의 오른쪽에서 이 순서에 있는 값을 클라이언트 IP 로 쓴다.
   * (프록시 1대 = 1. 0 이면 X-Forwarded-For 를 믿지 않는다.)
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /** 카카오 로그인(REST API 키). 값이 없으면 카카오 로그인 버튼을 숨긴다 */
  KAKAO_CLIENT_ID: z.string().optional(),
  KAKAO_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`환경 변수 설정 오류 — ${detail}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!value.APP_ENCRYPTION_KEY) missing.push("APP_ENCRYPTION_KEY");
    if (!value.CRON_SECRET) missing.push("CRON_SECRET");
    if (value.PAYMENT_PROVIDER === "toss" && (!value.TOSS_CLIENT_KEY || !value.TOSS_SECRET_KEY)) {
      missing.push("TOSS_CLIENT_KEY/TOSS_SECRET_KEY");
    }
    // 테스트 결제(mock)는 실제 청구 없이 예약을 확정한다. 운영에서는 시연 배포(DEMO_MODE=1)일 때만 허용한다.
    if (value.PAYMENT_PROVIDER === "mock" && value.DEMO_MODE !== "1") {
      missing.push("PAYMENT_PROVIDER=toss (테스트 결제는 DEMO_MODE=1 인 시연 배포에서만 쓸 수 있어요)");
    }
    // 빌드 단계(next build)에서는 비밀값 없이도 통과시키고, 실제 실행 시에만 강제한다.
    if (missing.length > 0 && process.env.NEXT_PHASE !== "phase-production-build") {
      throw new Error(`운영 환경 필수 환경 변수가 없습니다: ${missing.join(", ")}`);
    }
  }
  cached = value;
  return value;
}

export const isProd = () => env().NODE_ENV === "production";
export const isDemoMode = () => env().DEMO_MODE === "1";
