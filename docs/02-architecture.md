# 아키텍처와 개발 규약

이 문서는 남는자리 코드베이스의 **계약서**입니다. 구조·계층·보안 규칙·예약 엔진의 불변식을 정의하며, 모든 코드는 이 규약을 따릅니다.

## 1. 기술 스택

| 영역 | 선택 | 이유 |
| --- | --- | --- |
| 프레임워크 | Next.js 16 (App Router, React 19, Turbopack) | 서버 컴포넌트로 초기 로딩이 빠르고, 서버 액션으로 폼 처리가 단순함. 추후 앱·외부 연동용 API 도 같은 코드베이스에서 제공 |
| 언어 | TypeScript 6 (strict, `noUncheckedIndexedAccess`) | |
| DB | PostgreSQL 16 | 행 잠금·조건부 UPDATE·CHECK 제약·부분 유니크 인덱스로 중복 예약을 DB 수준에서 차단 |
| ORM | Prisma 7 (`@prisma/adapter-pg`) | 타입 안전한 쿼리. 재고 증감 등 핵심 구간은 원시 SQL 사용 |
| 스타일 | Tailwind CSS 4 (`@theme` 토큰) | 디자인 시스템 토큰을 CSS 변수로 단일 관리 |
| 검증 | zod 4 | 모든 외부 입력의 경계 검증 |
| 테스트 | Vitest(서비스 통합 테스트, 실제 Postgres) + Playwright(E2E) | |
| 인프라 의존 | **Postgres 하나만 필수** | Redis·큐 없이 동작(요청 제한·작업 큐를 DB 로 구현). 서버 1대 Docker 배포와 서버리스(Vercel 등) 모두 지원 |

## 2. 디렉터리

```
prisma/
  schema.prisma          데이터 모델(단일 진실 공급원)
  migrations/            마이그레이션(CHECK 제약·부분 유니크 인덱스는 SQL 로 추가)
  seed.ts                분류·지역·운영자·데모 데이터
src/
  proxy.ts               보안 헤더(CSP nonce)·Origin 검사·보호 경로 1차 관문
  app/
    (site)/              고객 화면 — 홈, 검색, 자리 상세, 예약, 마이, 로그인…
    seller/              사업자 센터
    admin/               운영자 콘솔
    api/                 라우트 핸들러(웹훅, 크론, 잔여석 폴링, 업로드 등)
  components/
    ui/                  디자인 시스템 프리미티브(Button, Input, Sheet…)
    shared/              영역 공통 도메인 컴포넌트(ListingCard, SeatMeter, StatusBadge…)
    site/ seller/ admin/ 영역 전용 컴포넌트
  lib/                   서버·클라이언트 공용 순수 함수(time, money, format, domain, cookies)
  server/                서버 전용("server-only")
    db.ts errors.ts audit.ts request.ts settings.ts storage.ts
    auth/                password, session, guards, totp, account
    security/            crypto, rate-limit
    services/            도메인 로직(예약·회차·대기·결제·알림·정산·CRM·분석·운영)
    jobs/                주기 작업(tick)
  generated/prisma/      Prisma 클라이언트(생성물, git 제외)
tests/                   Vitest 통합 테스트
e2e/                     Playwright 시나리오
docs/                    조사·계획·설계 문서
```

## 3. 계층 규칙

```
화면(Server Component) ──읽기──▶ services (조회 함수)
폼/버튼(Client) ─▶ Server Action ─▶ guard ─▶ zod 검증 ─▶ services (변경 함수) ─▶ revalidate
외부(PG 웹훅·크론) ─▶ Route Handler ─▶ 서명/비밀값 검증 ─▶ services
```

1. **DB 접근은 `src/server/services/**` 안에서만** 한다. 페이지·컴포넌트·액션에서 `prisma` 를 직접 쓰지 않는다.
2. **서비스 함수는 쿠키·헤더를 읽지 않는다.** 행위자(`userId`, `businessId`, 운영자 ID)를 인자로 받는다. → 테스트 가능하고 권한 검사가 명시적이다.
3. **권한은 서비스 안에서 리소스 기준으로 다시 확인한다.** 사업자 기능은 리소스의 `businessId` 가 행위자의 사업장과 같은지, 고객 기능은 리소스의 `userId` 가 본인인지 검사한다(IDOR 방지). 화면의 가드는 편의일 뿐 방어선이 아니다.
4. **서버 액션**은 라우트 폴더의 `actions.ts`("use server")에 두고 항상 `runAction()` 으로 감싸 `ActionResult` 를 돌려준다.
   ```ts
   export async function cancelBookingAction(input: unknown): Promise<ActionResult<{ refundAmount: number }>> {
     return runAction(async () => {
       const user = await requireUserOrThrow();
       const { bookingId, reason } = schema.parse(input);
       const result = await cancelBookingByCustomer({ userId: user.id, bookingId, reason });
       revalidatePath("/my/bookings");
       return result;
     });
   }
   ```
5. 금액·가격·수수료·환불액은 **항상 서버가 DB 값으로 계산**한다. 클라이언트가 보낸 금액은 검증용으로만 쓴다.
6. 시각은 `src/lib/time.ts`(KST), 금액은 `src/lib/money.ts`, 라벨·상태는 `src/lib/domain.ts` 만 사용한다. `toLocaleString`·`new Date().getHours()` 직접 사용 금지.
7. 사용자에게 보이는 오류는 `AppError`(한국어 메시지)로 던진다. 예상하지 못한 예외는 로그에 남기고 일반 문구만 노출한다.

## 4. 인증·권한

- **회원 세션**: 무작위 토큰을 `HttpOnly; SameSite=Lax; Secure` 쿠키에 담고 DB 에는 SHA-256 해시만 저장(30일). 비밀번호는 scrypt(N=2^15).
- **운영자 세션**: 회원 세션과 **별도 쿠키**(`SameSite=Strict`, 8시간, 60분 무활동 만료). 비밀번호 + TOTP 2단계 인증을 통과해야 발급. 운영자 역할: `SUPER / OPS / CS / FINANCE`.
- **사업자**: 회원이 `BusinessMember`(대표/매니저/스태프)로 사업장에 소속. 한 회원이 여러 사업장을 가질 수 있음.
- 가드: `requireUser / requireSeller / requireAdmin`(화면용, redirect) · `…OrThrow`(액션용) · `assertBusinessAccess(userId, businessId, minRole)`(리소스 단위).
- 로그인 실패 10회 → 15분 잠금, IP·계정 단위 요청 제한, 계정 존재 여부를 드러내지 않는 동일 응답·동일 소요 시간.

## 5. 보안 규칙(모든 코드 공통)

| 항목 | 규칙 |
| --- | --- |
| 입력 검증 | 모든 액션·핸들러 입력을 zod 로 검증. 문자열은 최대 길이, 숫자는 범위 지정 |
| 출력 | 사용자 입력은 텍스트로만 렌더링. `dangerouslySetInnerHTML` 금지(JSON-LD 는 `<` 이스케이프 후 예외) |
| 링크 | 사용자가 넣은 URL 은 `https://` 만 허용, `rel="noopener noreferrer nofollow"` |
| CSRF | 서버 액션은 Next.js Origin 검사, `/api/**` 변경 요청은 프록시에서 Origin 검사. 쿠키 SameSite |
| 리다이렉트 | 로그인 후 복귀 경로는 `safeNextPath()` 로 같은 사이트 상대 경로만 허용 |
| 요청 제한 | 로그인·가입·예약·대기·후기·신고·업로드·인증번호에 `enforceRateLimit()` |
| 개인정보 | 목록에서는 `maskPhone/maskName/maskEmail`. 운영자가 원문을 볼 때는 감사 로그 기록. 로그·감사 메타에 비밀번호·토큰·계좌번호 금지 |
| 암호화 | 계좌번호·TOTP 비밀키는 AES-256-GCM(`encrypt/decrypt`) |
| 업로드 | 5MB 이하 JPEG/PNG/WebP 만. 매직 바이트 확인 후 재인코딩(EXIF 제거), 파일명은 서버가 무작위 생성 |
| 결제 | 주문 금액은 서버 계산값과 PG 승인값을 대조. 웹훅은 PG 조회 API 로 재확인. 멱등 처리 |
| 감사 | 승인·정지·환불·정산·설정·권한 변경 등 민감 작업은 `audit()` 기록 |
| 헤더 | CSP(nonce + strict-dynamic), HSTS, X-Frame-Options: DENY, nosniff, Referrer-Policy, Permissions-Policy |

## 6. 예약 엔진

### 6.1 재고 모델

- 회차(`Slot`)는 좌석 유형(`SlotSeat`: 예 "남성 4석 / 여성 4석", "일반 8석")을 가진다.
- `SlotSeat.reserved` = 확정 예약 + 결제 대기 홀드 + 승인 대기 + 대기자 제안 홀드의 합.
- **남은 자리 = capacity − reserved.** 화면의 모든 잔여석 숫자는 이 값이다(허위 재고 표시 금지).

### 6.2 중복 예약 방지(3중 방어)

1. **조건부 원자 UPDATE** — 좌석 확보는 아래 한 문장으로만 한다. 영향 행이 0이면 매진이다.
   ```sql
   UPDATE "SlotSeat" SET "reserved" = "reserved" + $qty
   WHERE "id" = $id AND "reserved" + $qty <= "capacity"
   ```
2. **DB CHECK 제약** — `reserved >= 0 AND reserved <= capacity`. 코드에 버그가 있어도 초과 예약은 저장되지 않는다.
3. **부분 유니크 인덱스** — 한 회원은 한 회차에 진행 중 예약을 하나만 가질 수 있다. 여기에 `idempotencyKey` 로 이중 제출을 막는다.

좌석 확보·예약 생성·결제 레코드 생성은 하나의 트랜잭션이다. 좌석 반환(`reserved − qty`)도 상태 전이와 같은 트랜잭션에서 수행한다.

### 6.3 예약 상태 전이

```
(생성) ─ 무료·현장결제 ───────────────▶ CONFIRMED
(생성) ─ 온라인 결제 ─▶ PENDING_PAYMENT ─ 결제 승인 ─▶ CONFIRMED
                              └ 홀드 만료 ─▶ EXPIRED (좌석 반환)
(생성) ─ 승인제 ─▶ PENDING_APPROVAL ─ 사업자 승인 ─▶ CONFIRMED / 거절 ─▶ REJECTED (좌석 반환·환불)
CONFIRMED ─ 고객/사업자/운영자 취소 ─▶ CANCELLED (좌석 반환·정책 환불)
CONFIRMED ─ 체크인 또는 종료 후 자동 ─▶ COMPLETED
CONFIRMED ─ 사업자 노쇼 처리 ─▶ NO_SHOW (환불 없음, 고객 노쇼 횟수 +1)
```

- 상태 전이는 `updateMany({ where: { id, status: 기대상태 } })` 로 수행해 동시 요청 중 하나만 성공하게 한다.
- 홀드 만료는 크론이 정리하지만, **정합성은 크론에 의존하지 않는다**: 결제 승인 시점에 `holdExpiresAt` 을 다시 확인하고, 만료된 홀드는 조회·예약 시점에도 즉시 회수한다.

### 6.4 취소·환불

- 고객 취소 환불율 = 예약 시점에 저장한 정책 스냅샷(`policySnapshot`) + 남은 시간. 예약 직후 일정 시간(기본 10분)은 전액 환불.
- 사업자·운영자 취소, 회차 취소, 승인 거절은 항상 전액 환불.
- 온라인 결제분은 PG 부분취소 API 로 환불하고 `Refund` 에 기록한다. 환불 실패는 `FAILED` 로 남겨 운영자 콘솔에서 재시도한다.

### 6.5 좌석이 다시 생겼을 때(취소석 흐름)

```
좌석 반환 ─▶ 사업자 설정 autoRelist?
   ├ 예 ─▶ 대기자 있음? ─ 예 ─▶ 제안(좌석 홀드 유지) ─ 수락 ─▶ 예약(채널 WAITLIST)
   │                     │                         └ 시간 초과 ─▶ 다음 대기자 / 없으면 공개
   │                     └ 아니오 ─▶ 공개 + 회차 origin=취소석, vacancyPostedAt 갱신
   │                                 └ 팔로워·맞춤 알림 조건 일치 회원에게 알림
   └ 아니오 ─▶ 사업자에게 "취소 1석 — 다시 올리기" 알림, 좌석은 닫힌 상태로 대기
```

- 시작까지 시간이 넉넉하면 **순차 제안**(먼저 신청한 사람에게 일정 시간 독점권), 임박하면 **동시 알림 선착순**으로 전환한다(기준 시간은 운영 설정).
- 제안 중인 좌석은 `reserved` 에 포함되어 일반 고객에게는 보이지 않는다.

### 6.6 수수료

- 확정 시점에 `Booking` 에 스냅샷(`commissionBps`, `commissionAmount`, `pgFeeAmount`, `isNewCustomer`).
- 요율 결정 순서: 사업자 개별 요율 → 업종 요율 → 플랫폼 기본값. 채널이 `DIRECT/MANUAL` 이면 직접 채널 요율, 탐색 유입 재방문 고객이면 재방문 요율.
- 정산은 기간별로 `Settlement`/`SettlementItem` 을 만든다. 온라인 결제분은 (결제액 − 수수료 − PG 수수료)를 지급하고, 현장 결제분은 수수료만 차감(음수면 청구)한다.

## 7. 알림

- 앱 내 알림(`Notification`)은 항상 기록한다.
- 문자·알림톡·이메일은 `MessageOutbox` 에 쌓고 발송기가 처리한다. 발송 사업자 미연동 상태에서는 `SIMULATED` 로 기록만 남긴다(화면에 "미연동" 표시).
- 광고성 메시지(빈자리 알림·팔로우 알림 등)는 수신 동의 회원에게만, 야간(21~08시)에는 별도 동의가 없으면 다음 날 08시로 예약한다. 거래 관련 정보성 메시지(예약 확정·취소·리마인드·자리 제안)는 동의와 무관하게 발송한다.
- `dedupeKey` 로 같은 알림의 중복 발송을 막는다.

## 8. 주기 작업

`POST /api/cron/tick` (헤더 `Authorization: Bearer $CRON_SECRET`) 을 1분마다 호출한다. 단일 서버 배포는 `ENABLE_INTERNAL_CRON=1` 로 프로세스 내 타이머를 쓴다.

| 작업 | 내용 |
| --- | --- |
| 홀드 만료 | 결제 대기 시간이 지난 예약을 EXPIRED 로 바꾸고 좌석 반환 |
| 제안 만료 | 시간 초과된 대기 제안을 넘기고 다음 대기자에게 제안 또는 공개 |
| 리마인드 | 시작 전날·N시간 전 알림 |
| 자동 완료 | 종료 후 일정 시간이 지난 확정 예약을 이용 완료 처리, 후기 요청 |
| 발송 | MessageOutbox 대기 건 발송 |
| 정리 | 만료 세션·요청 제한 카운터·종료된 대기 정리 |

모든 작업은 여러 번 실행돼도 결과가 같도록(멱등) 작성하며, 동시에 두 번 호출돼도 안전하도록 조건부 UPDATE 로 "점유"한 건만 처리한다.

## 9. 화면 구현 규칙

- 기본은 Server Component. 상호작용이 필요한 부분만 Client Component 로 분리한다.
- 폼은 서버 액션 + `ActionResult`. 필드 오류는 필드 아래, 그 밖의 오류는 토스트로 보여 준다. 제출 중 버튼 비활성화·로딩 표시는 필수.
- 모든 목록은 **로딩(스켈레톤) · 비어 있음 · 오류** 상태를 가진다.
- 모바일(360px~)을 먼저 만들고 `md`(768px)·`lg`(1024px)에서 레이아웃을 재배치한다. 터치 영역 44px 이상.
- 디자인 토큰·컴포넌트 규격은 `docs/03-design-system.md` 를 따른다. 임의의 색·그림자·둥글기 값을 새로 만들지 않는다.
- 문구는 해요체. 잔여석·마감 시각 등 긴급성 표시는 실제 데이터에 근거한 것만 쓴다.
