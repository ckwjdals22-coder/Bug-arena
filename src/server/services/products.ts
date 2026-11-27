import "server-only";
import { z } from "zod";
import type { PaymentPolicy, PlanTier, Prisma, ProductStatus } from "@/generated/prisma/client";
import {
  ACTIVE_BOOKING_STATUSES,
  CANCELLATION_PRESETS,
  parseCancellationTiers,
  parseSeatTemplates,
  type CancellationPresetKey,
  type CancellationTier,
  type SeatTemplate,
} from "@/lib/domain";
import { formatBps, formatKRW, formatNumber } from "@/lib/money";
import { findBannedPhrases } from "@/lib/policy";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { marketRate, recalcCommissionForRetained, type CommissionRule, type CommissionSettings } from "@/server/services/commission";
import { PLAN_FEATURES } from "@/server/settings";
import { isOwnImageUrl } from "@/server/storage";

/**
 * 사업자 상품 관리 — 등록·수정·상태 변경·복제·조회, 그리고 등록 화면의 실수령액 계산.
 * 조회는 스태프 이상, 변경은 매니저 이상. 모든 함수는 상품의 businessId 로 권한을 다시 확인한다.
 * 상품은 항상 임시저장(DRAFT)으로 만들어지고, setProductStatus 로 판매를 시작한다.
 */

const MAX_PRICE = 10_000_000;
const MAX_IMAGES = 8;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 15;
const MAX_TIERS = 5;
const MAX_SEAT_TEMPLATES = 6;
const MAX_TITLE_LENGTH = 60;
const COPY_SUFFIX = " (복사본)";

const SINGLE_LINE = /^[^\p{Cc}]*$/u;
const PRESET_KEYS = Object.keys(CANCELLATION_PRESETS) as CancellationPresetKey[];

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

/** 같은 키의 작업을 트랜잭션 단위로 줄 세운다(개수 제한을 동시 요청이 함께 통과하지 못하게). */
const lockKey = (tx: Prisma.TransactionClient, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

// ── 입력 스키마 ───────────────────────────────────────

const emptyToNull = (value: string) => value || null;

/** 선택 입력 글: 빈 문자열과 null 은 "없음"으로 저장한다. */
const optionalText = (max: number, tooLong: string) => z.string().trim().max(max, tooLong).transform(emptyToNull).nullable();

/** 선택 입력 한 줄 글(줄바꿈·제어 문자 불가) */
const optionalLine = (max: number, tooLong: string, badChars: string) =>
  z.string().trim().max(max, tooLong).regex(SINGLE_LINE, badChars).transform(emptyToNull).nullable();

const priceSchema = (label: string) =>
  z
    .number(`${label}을 숫자로 입력해 주세요.`)
    .int(`${label}은 원 단위 정수로 입력해 주세요.`)
    .min(0, `${label}은 0원 이상이어야 해요.`)
    .max(MAX_PRICE, `${label}은 ${formatKRW(MAX_PRICE)}까지 입력할 수 있어요.`);

const ageSchema = z
  .number("나이를 숫자로 입력해 주세요.")
  .int("나이는 정수로 입력해 주세요.")
  .min(14, "참가 나이는 만 14세부터 정할 수 있어요.")
  .max(99, "참가 나이는 99세까지 정할 수 있어요.")
  .nullable();

const tierSchema = z.object({
  hoursBefore: z
    .number("취소 기준 시간을 숫자로 입력해 주세요.")
    .int("취소 기준 시간은 시간 단위 정수로 입력해 주세요.")
    .min(0, "취소 기준 시간은 0시간 이상이어야 해요.")
    .max(720, "취소 기준 시간은 시작 720시간(30일) 전까지 정할 수 있어요."),
  refundRate: z
    .number("환불율을 숫자로 입력해 주세요.")
    .int("환불율은 정수(%)로 입력해 주세요.")
    .min(0, "환불율은 0% 이상이어야 해요.")
    .max(100, "환불율은 100% 이하여야 해요."),
});

/** 프리셋 이름(FLEXIBLE·STANDARD·STRICT)을 주면 그 구간으로 바꿔서 검증한다. */
const tiersSchema = z.preprocess(
  (value) => (typeof value === "string" && (PRESET_KEYS as string[]).includes(value) ? [...CANCELLATION_PRESETS[value as CancellationPresetKey].tiers] : value),
  z
    .array(tierSchema, "환불 기준을 골라 주세요.")
    .min(1, "환불 기준을 한 구간 이상 넣어 주세요.")
    .max(MAX_TIERS, `환불 기준은 ${MAX_TIERS}구간까지 정할 수 있어요.`),
);

const seatSchema = z.object({
  label: z
    .string("좌석 이름을 입력해 주세요.")
    .trim()
    .min(1, "좌석 이름을 입력해 주세요.")
    .max(12, "좌석 이름은 12자까지 쓸 수 있어요.")
    .regex(SINGLE_LINE, "좌석 이름에 쓸 수 없는 문자가 있어요."),
  gender: z.enum(["ANY", "MALE", "FEMALE"], "좌석의 성별 구분을 골라 주세요.").default("ANY"),
  capacity: z
    .number("정원을 숫자로 입력해 주세요.")
    .int("정원은 정수로 입력해 주세요.")
    .min(1, "정원은 1명 이상이어야 해요.")
    .max(500, "정원은 500명까지 정할 수 있어요."),
  price: priceSchema("좌석 가격"),
  minCount: z
    .number("최소 인원을 숫자로 입력해 주세요.")
    .int("최소 인원은 정수로 입력해 주세요.")
    .min(0, "최소 인원은 0명 이상이어야 해요.")
    .default(0),
});

const tagSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^#+/, "").trim())
  .pipe(
    z
      .string()
      .min(1, "빈 태그는 넣을 수 없어요.")
      .max(MAX_TAG_LENGTH, `태그는 ${MAX_TAG_LENGTH}자까지 쓸 수 있어요.`)
      .regex(SINGLE_LINE, "태그에 쓸 수 없는 문자가 있어요."),
  );

const productSchema = z.object({
  title: z
    .string("상품 이름을 입력해 주세요.")
    .trim()
    .min(2, "상품 이름은 2자 이상이어야 해요.")
    .max(MAX_TITLE_LENGTH, `상품 이름은 ${MAX_TITLE_LENGTH}자까지 쓸 수 있어요.`)
    .regex(SINGLE_LINE, "상품 이름에 쓸 수 없는 문자가 있어요."),
  summary: optionalText(120, "한 줄 소개는 120자까지 쓸 수 있어요."),
  description: optionalText(5000, "상세 설명은 5,000자까지 쓸 수 있어요."),
  includes: optionalText(1000, "포함 사항은 1,000자까지 쓸 수 있어요."),
  notice: optionalText(1000, "유의 사항은 1,000자까지 쓸 수 있어요."),
  images: z.array(z.string("사진 주소를 확인해 주세요.").max(500, "사진 주소를 확인해 주세요."), "사진 목록을 확인해 주세요.").max(MAX_IMAGES, `사진은 ${MAX_IMAGES}장까지 올릴 수 있어요.`),
  durationMin: z
    .number("진행 시간을 숫자로 입력해 주세요.")
    .int("진행 시간은 분 단위 정수로 입력해 주세요.")
    .min(10, "진행 시간은 10분 이상이어야 해요.")
    .max(1440, "진행 시간은 24시간(1,440분)까지 정할 수 있어요."),
  basePrice: priceSchema("가격"),
  categoryId: z.string("분류를 골라 주세요.").min(1, "분류를 골라 주세요.").max(64, "분류를 다시 골라 주세요."),
  areaId: z.string().max(64, "지역을 다시 골라 주세요.").transform(emptyToNull).nullable(),
  placeName: optionalLine(40, "장소 이름은 40자까지 쓸 수 있어요.", "장소 이름에 쓸 수 없는 문자가 있어요."),
  address: optionalLine(200, "주소는 200자까지 쓸 수 있어요.", "주소에 쓸 수 없는 문자가 있어요."),
  lat: z.number("위치를 다시 지정해 주세요.").min(-90, "위치를 다시 지정해 주세요.").max(90, "위치를 다시 지정해 주세요.").nullable(),
  lng: z.number("위치를 다시 지정해 주세요.").min(-180, "위치를 다시 지정해 주세요.").max(180, "위치를 다시 지정해 주세요.").nullable(),
  minAge: ageSchema,
  maxAge: ageSchema,
  requiresIdentity: z.boolean("본인인증 필요 여부를 확인해 주세요."),
  requiresApproval: z.boolean("승인제 여부를 확인해 주세요."),
  maxPerBooking: z
    .number("한 번에 예약할 수 있는 인원을 숫자로 입력해 주세요.")
    .int("한 번에 예약할 수 있는 인원은 정수로 입력해 주세요.")
    .min(1, "한 번에 예약할 수 있는 인원은 1명 이상이어야 해요.")
    .max(8, "한 번에 예약할 수 있는 인원은 8명까지 정할 수 있어요."),
  resaleRefundRate: z
    .number("재판매 연동 환불율을 숫자로 입력해 주세요.")
    .int("재판매 연동 환불율은 정수(%)로 입력해 주세요.")
    .min(50, "재판매 연동 환불율은 50% 이상이어야 해요.")
    .max(100, "재판매 연동 환불율은 100% 이하여야 해요.")
    .nullable(),
  tags: z
    .array(tagSchema, "태그 목록을 확인해 주세요.")
    .max(MAX_TAGS, `태그는 ${MAX_TAGS}개까지 달 수 있어요.`)
    .transform((tags) => [...new Set(tags)]),
  paymentPolicy: z.enum(["PREPAY", "DEPOSIT", "ONSITE"], "결제 방식을 골라 주세요."),
  depositAmount: priceSchema("예약금").nullable(),
  cancellationTiers: tiersSchema,
  seatTemplates: z
    .array(seatSchema, "좌석 구성을 하나 이상 넣어 주세요.")
    .min(1, "좌석 구성을 하나 이상 넣어 주세요.")
    .max(MAX_SEAT_TEMPLATES, `좌석 구성은 ${MAX_SEAT_TEMPLATES}개까지 만들 수 있어요.`),
});

const patchSchema = productSchema.partial();

type ProductData = z.output<typeof productSchema>;
type ProductPatchData = z.output<typeof patchSchema>;

export interface SeatTemplateInput {
  /** 1~12자, 상품 안에서 겹칠 수 없다 */
  label: string;
  gender?: "ANY" | "MALE" | "FEMALE";
  /** 1~500 */
  capacity: number;
  /** 0~10,000,000 */
  price: number;
  /** 개최 확정 최소 인원(0~capacity). 0 = 조건 없음 */
  minCount?: number;
}

/** 수정할 수 있는 상품 항목. 선택 항목에 null·빈 문자열을 주면 비운다. */
export interface ProductFields {
  /** 2~60자 */
  title: string;
  /** ~120자 */
  summary: string | null;
  /** ~5,000자 */
  description: string | null;
  /** ~1,000자 */
  includes: string | null;
  /** ~1,000자 */
  notice: string | null;
  /** 최대 8장. uploadImageAction 이 돌려준 주소만 */
  images: string[];
  /** 10~1,440분 */
  durationMin: number;
  /** 정가 0~10,000,000원 */
  basePrice: number;
  categoryId: string;
  areaId: string | null;
  placeName: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  /** 14~99, minAge ≤ maxAge */
  minAge: number | null;
  maxAge: number | null;
  requiresIdentity: boolean;
  requiresApproval: boolean;
  /** 1~8 */
  maxPerBooking: number;
  /** null 또는 50~100. 선결제·예약금 상품에서만 쓸 수 있다 */
  resaleRefundRate: number | null;
  /** 최대 8개, 각 15자 이하 */
  tags: string[];
  paymentPolicy: PaymentPolicy;
  /** DEPOSIT 일 때 필수: 1인당 예약금(1원 이상, 정가 이하). 다른 결제 방식에서는 무시하고 비운다 */
  depositAmount: number | null;
  /** 프리셋 이름 또는 1~5개 구간(마지막 구간은 hoursBefore 0) */
  cancellationTiers: CancellationPresetKey | CancellationTier[];
  /** 1~6개 */
  seatTemplates: SeatTemplateInput[];
}

export type ProductInput = Pick<ProductFields, "title" | "categoryId" | "basePrice" | "seatTemplates"> &
  Partial<Omit<ProductFields, "title" | "categoryId" | "basePrice" | "seatTemplates">>;
export type ProductPatch = Partial<ProductFields>;

/** 등록할 때 생략한 항목의 기본값 */
const CREATE_DEFAULTS = {
  summary: null,
  description: null,
  includes: null,
  notice: null,
  images: [],
  durationMin: 120,
  areaId: null,
  placeName: null,
  address: null,
  lat: null,
  lng: null,
  minAge: null,
  maxAge: null,
  requiresIdentity: false,
  requiresApproval: false,
  maxPerBooking: 4,
  resaleRefundRate: null,
  tags: [],
  paymentPolicy: "PREPAY",
  depositAmount: null,
  cancellationTiers: "STANDARD",
} satisfies Partial<ProductFields>;

const asRecord = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});

/** undefined 인 항목을 뺀다("생략"과 "값 없음(null)"을 구분하기 위해). */
function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── 항목 사이의 규칙 ──────────────────────────────────

const BANNED_CHECK_FIELDS = ["title", "summary", "description", "includes", "notice"] as const;

/** 문구에 금칙 표현이 있으면 그 항목 이름으로 사유를 모은다. */
function collectBannedPhrases(data: Pick<ProductData, (typeof BANNED_CHECK_FIELDS)[number] | "tags">, errors: Map<string, string>): void {
  const check = (field: string, ...texts: (string | null)[]) => {
    const hit = findBannedPhrases(...texts)[0];
    if (hit && !errors.has(field)) errors.set(field, `${hit.reason} ('${hit.phrase}')`);
  };
  for (const field of BANNED_CHECK_FIELDS) check(field, data[field]);
  check("tags", ...data.tags);
}

function throwFieldErrors(errors: Map<string, string>): never {
  const [first] = errors.values();
  throw new AppError("VALIDATION", first ?? "입력값을 확인해 주세요.", Object.fromEntries(errors));
}

/**
 * 스키마를 통과한 값에 항목 사이의 규칙을 적용하고, 저장할 모양으로 정리해 돌려준다.
 * storedImages 는 이미 저장돼 있던 사진 주소로, 그대로 다시 보내는 것은 허용한다.
 */
function finalize(data: ProductData, storedImages: readonly string[] = []): ProductData {
  const errors = new Map<string, string>();
  const fail = (field: string, message: string) => {
    if (!errors.has(field)) errors.set(field, message);
  };

  collectBannedPhrases(data, errors);

  data.images.forEach((url, i) => {
    if (!storedImages.includes(url) && !isOwnImageUrl(url)) fail(`images.${i}`, "사진은 남는자리에 올린 파일만 쓸 수 있어요.");
  });
  if (new Set(data.images).size !== data.images.length) fail("images", "같은 사진이 두 번 들어 있어요.");

  if (data.minAge !== null && data.maxAge !== null && data.minAge > data.maxAge) {
    fail("maxAge", "최대 나이는 최소 나이보다 같거나 많아야 해요.");
  }
  if ((data.lat === null) !== (data.lng === null)) fail("lat", "위치를 다시 지정해 주세요.");

  let depositAmount: number | null = null;
  if (data.paymentPolicy === "DEPOSIT") {
    if (data.depositAmount === null) fail("depositAmount", "예약금 결제를 쓰려면 1인당 예약금을 입력해 주세요.");
    else if (data.depositAmount < 1) fail("depositAmount", "예약금은 1원 이상이어야 해요.");
    else if (data.depositAmount > data.basePrice) fail("depositAmount", `예약금은 가격(${formatKRW(data.basePrice)})보다 클 수 없어요.`);
    else depositAmount = data.depositAmount;
  }
  if (data.resaleRefundRate !== null && data.paymentPolicy === "ONSITE") {
    fail("resaleRefundRate", "재판매 연동 환불은 온라인으로 결제받는 상품(전액 선결제·예약금)에서만 쓸 수 있어요.");
  }

  // 환불 구간: 시작까지 남은 시간이 큰 구간부터 정렬하고, 시작에 가까워질수록 환불율이 올라가지 않아야 한다.
  const tiers = [...data.cancellationTiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
  if (new Set(tiers.map((t) => t.hoursBefore)).size !== tiers.length) {
    fail("cancellationTiers", "같은 기준 시간이 두 번 들어 있어요.");
  } else if (tiers[tiers.length - 1]?.hoursBefore !== 0) {
    fail("cancellationTiers", "마지막 구간은 '시작 0시간 전'이어야 해요. 그 이후의 환불율을 정해 주세요.");
  } else if (tiers.some((tier, i) => i > 0 && tier.refundRate > tiers[i - 1]!.refundRate)) {
    fail("cancellationTiers", "시작이 가까워질수록 환불율이 같거나 낮아져야 해요.");
  }

  const labels = new Set<string>();
  data.seatTemplates.forEach((seat, i) => {
    if (labels.has(seat.label)) fail(`seatTemplates.${i}.label`, "좌석 이름이 겹쳐요. 서로 다른 이름을 써 주세요.");
    labels.add(seat.label);
    if (seat.minCount > seat.capacity) fail(`seatTemplates.${i}.minCount`, "최소 인원은 정원보다 많을 수 없어요.");
  });

  if (errors.size > 0) throwFieldErrors(errors);
  return { ...data, depositAmount, cancellationTiers: tiers };
}

type Db = Prisma.TransactionClient | typeof prisma;

async function assertActiveCategory(categoryId: string, db: Db = prisma): Promise<void> {
  const category = await db.category.findUnique({ where: { id: categoryId }, select: { isActive: true } });
  if (!category?.isActive) {
    const message = "고를 수 없는 분류예요. 다시 골라 주세요.";
    throw err.validation(message, { categoryId: message });
  }
}

async function assertActiveArea(areaId: string, db: Db = prisma): Promise<void> {
  const area = await db.area.findUnique({ where: { id: areaId }, select: { isActive: true } });
  if (!area?.isActive) {
    const message = "아직 서비스하지 않는 지역이에요. 다시 골라 주세요.";
    throw err.validation(message, { areaId: message });
  }
}

const toJson = (value: CancellationTier[] | SeatTemplate[]) => value as unknown as Prisma.InputJsonValue;

function toWriteData(data: ProductData) {
  return {
    title: data.title,
    summary: data.summary,
    description: data.description,
    includes: data.includes,
    notice: data.notice,
    images: data.images,
    durationMin: data.durationMin,
    basePrice: data.basePrice,
    categoryId: data.categoryId,
    areaId: data.areaId,
    placeName: data.placeName,
    address: data.address,
    lat: data.lat,
    lng: data.lng,
    minAge: data.minAge,
    maxAge: data.maxAge,
    requiresIdentity: data.requiresIdentity,
    requiresApproval: data.requiresApproval,
    maxPerBooking: data.maxPerBooking,
    resaleRefundRate: data.resaleRefundRate,
    tags: data.tags,
    paymentPolicy: data.paymentPolicy,
    depositAmount: data.depositAmount,
    cancellationTiers: toJson(data.cancellationTiers),
    seatTemplates: toJson(data.seatTemplates),
  } satisfies Prisma.ProductUncheckedUpdateInput;
}

// ── 조회 형식 ─────────────────────────────────────────

const productInclude = {
  category: { select: { id: true, slug: true, name: true } },
  area: { select: { id: true, slug: true, name: true, district: true, city: true } },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export interface UpcomingSlots {
  /** 앞으로 열리는(취소되지 않은) 회차 수 */
  upcomingSlotCount: number;
  /** 가장 가까운 회차의 시작 시각. 없으면 null */
  nextSlotAt: Date | null;
}

export interface SellerProduct extends UpcomingSlots {
  id: string;
  businessId: string;
  status: ProductStatus;
  title: string;
  summary: string | null;
  description: string | null;
  includes: string | null;
  notice: string | null;
  images: string[];
  durationMin: number;
  basePrice: number;
  category: { id: string; slug: string; name: string };
  area: { id: string; slug: string; name: string; district: string; city: string } | null;
  placeName: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  minAge: number | null;
  maxAge: number | null;
  requiresIdentity: boolean;
  requiresApproval: boolean;
  maxPerBooking: number;
  resaleRefundRate: number | null;
  tags: string[];
  paymentPolicy: PaymentPolicy;
  depositAmount: number | null;
  /** 시작까지 남은 시간이 큰 구간부터 */
  cancellationTiers: CancellationTier[];
  /** 구간이 프리셋과 똑같으면 그 이름, 직접 정한 구간이면 null */
  cancellationPreset: CancellationPresetKey | null;
  seatTemplates: Required<SeatTemplate>[];
  ratingAvg: number;
  ratingCount: number;
  favoriteCount: number;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SellerProductListItem extends UpcomingSlots {
  id: string;
  status: ProductStatus;
  title: string;
  summary: string | null;
  /** 첫 번째 사진. 없으면 null(업종별 기본 커버 사용) */
  coverImage: string | null;
  categoryName: string;
  basePrice: number;
  durationMin: number;
  paymentPolicy: PaymentPolicy;
  requiresApproval: boolean;
  /** 좌석 구성의 정원 합 */
  totalCapacity: number;
  ratingAvg: number;
  ratingCount: number;
  favoriteCount: number;
  updatedAt: Date;
}

const readSeatTemplates = (value: unknown): Required<SeatTemplate>[] =>
  parseSeatTemplates(value).map((seat) => ({
    label: seat.label,
    gender: seat.gender,
    capacity: seat.capacity,
    price: seat.price,
    minCount: typeof seat.minCount === "number" ? seat.minCount : 0,
  }));

function matchPreset(tiers: CancellationTier[]): CancellationPresetKey | null {
  const same = (preset: readonly CancellationTier[]) =>
    preset.length === tiers.length && preset.every((t, i) => t.hoursBefore === tiers[i]?.hoursBefore && t.refundRate === tiers[i]?.refundRate);
  return PRESET_KEYS.find((key) => same(CANCELLATION_PRESETS[key].tiers)) ?? null;
}

async function upcomingSlotsByProduct(productIds: string[]): Promise<Map<string, UpcomingSlots>> {
  if (productIds.length === 0) return new Map();
  const groups = await prisma.slot.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, startAt: { gt: new Date() }, status: { not: "CANCELLED" } },
    _count: { _all: true },
    _min: { startAt: true },
  });
  return new Map(groups.map((g) => [g.productId, { upcomingSlotCount: g._count._all, nextSlotAt: g._min.startAt }]));
}

const NO_UPCOMING: UpcomingSlots = { upcomingSlotCount: 0, nextSlotAt: null };

function toSellerProduct(p: ProductRow, upcoming: UpcomingSlots): SellerProduct {
  const cancellationTiers = parseCancellationTiers(p.cancellationTiers);
  return {
    id: p.id,
    businessId: p.businessId,
    status: p.status,
    title: p.title,
    summary: p.summary,
    description: p.description,
    includes: p.includes,
    notice: p.notice,
    images: p.images,
    durationMin: p.durationMin,
    basePrice: p.basePrice,
    category: p.category,
    area: p.area,
    placeName: p.placeName,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    minAge: p.minAge,
    maxAge: p.maxAge,
    requiresIdentity: p.requiresIdentity,
    requiresApproval: p.requiresApproval,
    maxPerBooking: p.maxPerBooking,
    resaleRefundRate: p.resaleRefundRate,
    tags: p.tags,
    paymentPolicy: p.paymentPolicy,
    depositAmount: p.depositAmount,
    cancellationTiers,
    cancellationPreset: matchPreset(cancellationTiers),
    seatTemplates: readSeatTemplates(p.seatTemplates),
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    favoriteCount: p.favoriteCount,
    viewCount: p.viewCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...upcoming,
  };
}

async function withUpcoming(p: ProductRow): Promise<SellerProduct> {
  return toSellerProduct(p, (await upcomingSlotsByProduct([p.id])).get(p.id) ?? NO_UPCOMING);
}

const idSchema = z.string().min(1).max(64);

/** 상품을 읽고, 행위자가 그 상품의 사업장 구성원인지 확인한다(IDOR 방지). */
async function loadProduct(actorUserId: string, productId: string, minRole: "STAFF" | "MANAGER"): Promise<ProductRow> {
  const id = parseInput(idSchema, productId);
  const product = await prisma.product.findUnique({ where: { id }, include: productInclude });
  if (!product) throw err.notFound("상품을 찾을 수 없어요.");
  await assertBusinessAccess(actorUserId, product.businessId, minRole);
  return product;
}

// ── 조회 ──────────────────────────────────────────────

/** 상품 상세(스태프 이상) */
export async function getProductForSeller(actorUserId: string, productId: string): Promise<SellerProduct> {
  return withUpcoming(await loadProduct(actorUserId, productId, "STAFF"));
}

const listSchema = z.object({ status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]).optional() });

/**
 * 사업장의 상품 목록(스태프 이상), 최근에 고친 순.
 * status 를 생략하면 보관된 상품을 뺀 전부를, 주면 그 상태만 돌려준다.
 */
export async function listProductsForSeller(
  actorUserId: string,
  businessId: string,
  filter: { status?: ProductStatus } = {},
): Promise<SellerProductListItem[]> {
  await assertBusinessAccess(actorUserId, businessId, "STAFF");
  const { status } = parseInput(listSchema, filter);
  const products = await prisma.product.findMany({
    where: { businessId, status: status ?? { not: "ARCHIVED" } },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    include: { category: { select: { name: true } } },
  });
  const upcoming = await upcomingSlotsByProduct(products.map((p) => p.id));
  return products.map((p) => ({
    id: p.id,
    status: p.status,
    title: p.title,
    summary: p.summary,
    coverImage: p.images[0] ?? null,
    categoryName: p.category.name,
    basePrice: p.basePrice,
    durationMin: p.durationMin,
    paymentPolicy: p.paymentPolicy,
    requiresApproval: p.requiresApproval,
    totalCapacity: readSeatTemplates(p.seatTemplates).reduce((sum, seat) => sum + seat.capacity, 0),
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    favoriteCount: p.favoriteCount,
    updatedAt: p.updatedAt,
    ...(upcoming.get(p.id) ?? NO_UPCOMING),
  }));
}

// ── 등록 · 수정 · 복제 ────────────────────────────────

/** 상품 등록(매니저 이상). 임시저장(DRAFT)으로 만든다. */
export async function createProduct(actorUserId: string, businessId: string, input: ProductInput): Promise<SellerProduct> {
  await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  const data = finalize(parseInput(productSchema, { ...CREATE_DEFAULTS, ...definedOnly(asRecord(input)) }));
  await assertActiveCategory(data.categoryId);
  if (data.areaId) await assertActiveArea(data.areaId);

  const product = await prisma.product.create({
    data: { ...toWriteData(data), businessId, status: "DRAFT" },
    include: productInclude,
  });
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "product.create",
    targetType: "Product",
    targetId: product.id,
    meta: { businessId, title: product.title },
  });
  return toSellerProduct(product, NO_UPCOMING);
}

/** 저장된 상품을 입력과 같은 모양으로 읽는다(수정할 때 넘어온 항목과 합쳐 다시 검증하기 위해). */
function storedData(p: ProductRow): ProductData {
  return {
    title: p.title,
    summary: p.summary,
    description: p.description,
    includes: p.includes,
    notice: p.notice,
    images: p.images,
    durationMin: p.durationMin,
    basePrice: p.basePrice,
    categoryId: p.categoryId,
    areaId: p.areaId,
    placeName: p.placeName,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    minAge: p.minAge,
    maxAge: p.maxAge,
    requiresIdentity: p.requiresIdentity,
    requiresApproval: p.requiresApproval,
    maxPerBooking: p.maxPerBooking,
    resaleRefundRate: p.resaleRefundRate,
    tags: p.tags,
    paymentPolicy: p.paymentPolicy,
    depositAmount: p.depositAmount,
    cancellationTiers: parseCancellationTiers(p.cancellationTiers),
    seatTemplates: readSeatTemplates(p.seatTemplates),
  };
}

const ARCHIVED_LOCKED = "보관된 상품은 고칠 수 없어요. 먼저 보관을 풀어 주세요.";

/**
 * 상품 수정(매니저 이상). 넘어온 항목만 바꾸되, 바꾼 뒤의 상품 전체가 규칙을 지키는지 다시 확인한다.
 * 이미 만든 회차의 좌석·가격은 바뀌지 않는다(회차는 만들 때의 구성을 따로 갖는다).
 */
export async function updateProduct(actorUserId: string, productId: string, patch: ProductPatch): Promise<SellerProduct> {
  const loaded = await loadProduct(actorUserId, productId, "MANAGER");
  if (loaded.status === "ARCHIVED") throw err.conflict(ARCHIVED_LOCKED);
  const changes: ProductPatchData = definedOnly(parseInput(patchSchema, definedOnly(asRecord(patch))));
  const fields = Object.keys(changes);
  if (fields.length === 0) return withUpcoming(loaded);

  await prisma.$transaction(async (tx) => {
    // 같은 상품을 동시에 고치는 요청을 줄 세운다. 저장된 값과 합쳐서 검증하므로, 줄을 세우지 않으면
    // 서로의 변경을 덮어쓰거나(가격과 예약금을 따로 고칠 때처럼) 항목 사이의 규칙이 깨진 채 저장될 수 있다.
    // 예약·회차 생성(외래 키 확인)은 막지 않도록 NO KEY UPDATE 로 잠근다.
    await tx.$queryRaw`SELECT 1 FROM "Product" WHERE "id" = ${loaded.id} FOR NO KEY UPDATE`;
    const current = await tx.product.findUnique({ where: { id: loaded.id }, include: productInclude });
    if (!current) throw err.notFound("상품을 찾을 수 없어요.");
    // 보관 처리와 겹치면 고치지 않는다.
    if (current.status === "ARCHIVED") throw err.conflict(ARCHIVED_LOCKED);

    const merged: ProductData = { ...storedData(current), ...changes };
    // 현장 결제로 바꾸면서 재판매 연동 환불을 따로 건드리지 않았으면, 쓸 수 없게 된 설정을 함께 끈다.
    if (merged.paymentPolicy === "ONSITE" && changes.resaleRefundRate === undefined) merged.resaleRefundRate = null;
    const data = finalize(merged, current.images);
    if (data.categoryId !== current.categoryId) await assertActiveCategory(data.categoryId, tx);
    if (data.areaId && data.areaId !== current.areaId) await assertActiveArea(data.areaId, tx);
    await tx.product.update({ where: { id: current.id }, data: toWriteData(data) });
  });

  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "product.update",
    targetType: "Product",
    targetId: loaded.id,
    meta: { fields },
  });
  return getProductForSeller(actorUserId, loaded.id);
}

/** 상품 복제(매니저 이상). 내용을 그대로 옮긴 임시저장 상품을 만든다. 회차·후기·찜은 옮기지 않는다. */
export async function duplicateProduct(actorUserId: string, productId: string): Promise<SellerProduct> {
  const source = await loadProduct(actorUserId, productId, "MANAGER");
  const data = storedData(source);
  const title = `${data.title.slice(0, MAX_TITLE_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  const product = await prisma.product.create({
    data: { ...toWriteData({ ...data, title }), businessId: source.businessId, status: "DRAFT" },
    include: productInclude,
  });
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "product.duplicate",
    targetType: "Product",
    targetId: product.id,
    meta: { businessId: source.businessId, sourceId: source.id },
  });
  return toSellerProduct(product, NO_UPCOMING);
}

// ── 상태 변경 ─────────────────────────────────────────

/** 허용하는 상태 전이. 판매한 적 있는 상품은 임시저장으로 되돌릴 수 없고, 보관을 풀면 임시저장이 된다. */
const STATUS_TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: ["DRAFT"],
};

const STATUS_RACE = "상품 상태가 방금 바뀌었어요. 새로 고친 뒤 다시 시도해 주세요.";

function transitionRefusal(from: ProductStatus, to: ProductStatus): string {
  if (from === "ARCHIVED") return "보관된 상품은 먼저 보관을 풀어 임시저장으로 되돌린 뒤 판매를 시작해 주세요.";
  if (to === "DRAFT") return "판매한 적이 있는 상품은 임시저장으로 되돌릴 수 없어요. 판매 중지나 보관을 써 주세요.";
  return "아직 판매를 시작하지 않은 상품이에요. 판매를 시작한 뒤에 중지할 수 있어요.";
}

const SELLER_INFO_FIELDS = [
  ["representativeName", "대표자 이름"],
  ["businessRegNo", "사업자등록번호"],
  ["phone", "대표 전화번호"],
  ["address", "사업장 주소"],
] as const;

/** 판매 시작 조건: 상품 내용, 금칙 표현, 법정 표시에 필요한 판매자 정보 */
async function assertCanActivate(product: ProductRow): Promise<void> {
  const errors = new Map<string, string>();
  if (product.title.trim().length < 2) errors.set("title", "상품 이름을 입력해 주세요.");
  if (!Number.isInteger(product.basePrice) || product.basePrice < 0) errors.set("basePrice", "가격을 입력해 주세요.");
  if (readSeatTemplates(product.seatTemplates).length === 0) errors.set("seatTemplates", "좌석 구성을 하나 이상 넣어 주세요.");
  collectBannedPhrases(product, errors);
  if (errors.size > 0) throwFieldErrors(errors);

  const business = await prisma.business.findUnique({
    where: { id: product.businessId },
    select: { representativeName: true, businessRegNo: true, phone: true, address: true },
  });
  if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
  const missing = SELLER_INFO_FIELDS.filter(([field]) => !business[field]?.trim()).map(([, label]) => label);
  if (missing.length > 0) {
    throw err.validation(`판매를 시작하려면 판매자 정보가 필요해요. 사업장 정보에서 ${missing.join(", ")}을(를) 채워 주세요.`);
  }
}

/** 예약이 남아 있는(취소되지 않은) 앞으로의 회차가 있으면 보관할 수 없다. */
async function assertCanArchive(productId: string): Promise<void> {
  const busy = await prisma.slot.count({
    where: {
      productId,
      status: { not: "CANCELLED" },
      startAt: { gt: new Date() },
      bookings: { some: { status: { in: ACTIVE_BOOKING_STATUSES } } },
    },
  });
  if (busy > 0) {
    throw err.conflict(`예약이 남아 있는 회차가 ${formatNumber(busy)}개 있어 보관할 수 없어요. 회차가 끝난 뒤에 보관하거나, 먼저 판매를 중지해 주세요.`);
  }
}

/**
 * 상품 상태 변경(매니저 이상).
 * - ACTIVE: 상품 내용·판매자 정보가 갖춰져 있고, 플랜의 판매 중 상품 수 한도 안이어야 한다.
 * - ARCHIVED: 예약이 남아 있는 앞으로의 회차가 없어야 한다.
 * 같은 상태로 바꾸는 요청은 그대로 통과시킨다.
 */
export async function setProductStatus(actorUserId: string, productId: string, status: ProductStatus): Promise<SellerProduct> {
  const next = parseInput(z.enum(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"], "상품 상태를 확인해 주세요."), status);
  const product = await loadProduct(actorUserId, productId, "MANAGER");
  const from = product.status;
  if (from === next) return withUpcoming(product);
  if (!STATUS_TRANSITIONS[from].includes(next)) throw err.conflict(transitionRefusal(from, next));

  if (next === "ACTIVE") {
    await assertCanActivate(product);
    await prisma.$transaction(async (tx) => {
      await lockKey(tx, `product-active:${product.businessId}`);
      const business = await tx.business.findUnique({ where: { id: product.businessId }, select: { plan: true } });
      if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
      const plan = PLAN_FEATURES[business.plan];
      const active = await tx.product.count({ where: { businessId: product.businessId, status: "ACTIVE" } });
      if (active >= plan.maxActiveProducts) {
        throw err.conflict(
          `${plan.label} 플랜에서는 상품을 ${formatNumber(plan.maxActiveProducts)}개까지 판매할 수 있어요. 다른 상품의 판매를 중지한 뒤 다시 시도해 주세요.`,
        );
      }
      const updated = await tx.product.updateMany({ where: { id: product.id, status: from }, data: { status: next } });
      if (updated.count !== 1) throw err.conflict(STATUS_RACE);
    });
  } else {
    if (next === "ARCHIVED") await assertCanArchive(product.id);
    const updated = await prisma.product.updateMany({ where: { id: product.id, status: from }, data: { status: next } });
    if (updated.count !== 1) throw err.conflict(STATUS_RACE);
  }

  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "product.status_change",
    targetType: "Product",
    targetId: product.id,
    meta: { from, to: next },
  });
  return getProductForSeller(actorUserId, product.id);
}

// ── 실수령액 계산 ─────────────────────────────────────

const payoutSchema = z.object({
  price: priceSchema("가격"),
  quantity: z.number("인원을 숫자로 입력해 주세요.").int("인원은 정수로 입력해 주세요.").min(1, "인원은 1명 이상이어야 해요.").max(500, "인원은 500명까지 계산할 수 있어요."),
  onlinePerSeat: priceSchema("온라인 결제액").optional(),
  overrideBps: z.number().int().min(0).max(10_000).nullish(),
});

export interface PayoutLine {
  rule: CommissionRule;
  /** 중개 수수료율(bps) */
  bps: number;
  /** "9.9%" / "0% + 결제 실비" */
  rateText: string;
  commissionAmount: number;
  pgFeeAmount: number;
  /** 사업자가 받는 금액 = 고객 결제 금액 − 중개 수수료 − 결제 실비 */
  payout: number;
}

export interface PayoutEstimate {
  /** 고객 결제 금액(가격 × 인원) */
  total: number;
  /** 남는자리로 처음 온 고객 */
  marketNew: PayoutLine;
  /** 남는자리로 다시 온 고객 */
  marketReturning: PayoutLine;
  /** 내 예약 링크·QR 로 온 고객 */
  ownLink: PayoutLine;
}

/**
 * 등록 화면의 수수료 계산기: 한 건이 예약됐을 때 유입 경로별로 사업자가 받는 금액.
 * 실제 정산과 같은 계산식(요율·좌석당 상한·결제 실비)을 쓴다.
 * onlinePerSeat 는 1인당 온라인 결제액(예약금 상품이면 예약금, 현장 결제면 0). 생략하면 전액 선결제로 본다.
 * overrideBps 는 사업자 개별 요율 또는 업종 요율이 있을 때 넘긴다.
 */
export function estimatePayout(input: {
  price: number;
  quantity: number;
  plan: PlanTier;
  settings: CommissionSettings;
  onlinePerSeat?: number;
  overrideBps?: number | null;
}): PayoutEstimate {
  const { price, quantity, onlinePerSeat, overrideBps } = parseInput(payoutSchema, {
    price: input.price,
    quantity: input.quantity,
    onlinePerSeat: input.onlinePerSeat,
    overrideBps: input.overrideBps,
  });
  const { plan, settings } = input;
  const total = price * quantity;
  const online = Math.min(price, onlinePerSeat ?? price) * quantity;

  const line = (rule: CommissionRule, bps: number): PayoutLine => {
    const amounts = recalcCommissionForRetained({ rule, bps, quantity, retainedTotal: total, retainedOnline: online, settings });
    return {
      rule,
      bps,
      rateText: rule === "DIRECT" ? `${formatBps(bps)} + 결제 실비` : formatBps(bps),
      ...amounts,
      payout: total - amounts.commissionAmount - amounts.pgFeeAmount,
    };
  };
  const fresh = marketRate({ plan, overrideBps: overrideBps ?? null, isReturning: false, settings });
  const returning = marketRate({ plan, overrideBps: overrideBps ?? null, isReturning: true, settings });
  return {
    total,
    marketNew: line(fresh.rule, fresh.bps),
    marketReturning: line(returning.rule, returning.bps),
    ownLink: line("DIRECT", settings.commissionDirectBps),
  };
}
