import "server-only";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { Prisma, type BusinessStatus, type MemberRole, type PlanTier } from "@/generated/prisma/client";
import { MEMBER_ROLE_LABEL } from "@/lib/domain";
import { isValidBusinessRegNo, maskEmail, slugify } from "@/lib/format";
import { DAY } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { decrypt, encrypt } from "@/server/security/crypto";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { notify } from "@/server/services/notifications";
import { notificationLinks } from "@/server/services/notifications/events";
import { PLAN_FEATURES } from "@/server/settings";
import { isOwnImageUrl } from "@/server/storage";

/**
 * 사업자(사업장) 서비스 — 입점 신청, 프로필·운영 설정, 정산 계좌, 구성원 관리, 조회.
 * 모든 변경 함수는 행위자가 그 사업장의 구성원인지, 필요한 역할 이상인지 먼저 확인한다.
 * 자동 문자 기본 문구는 저장된 행이 없어도 알림 모듈이 제공하므로, 신청 때 템플릿 행을 미리 만들지 않는다.
 */

export const MAX_OWNED_BUSINESSES = 3;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,29}$/;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLUG_ATTEMPTS = 5;
/** 서비스 경로·운영 주체로 오해할 수 있는 주소는 사업장이 쓸 수 없다. */
const RESERVED_SLUGS = new Set([
  "admin", "administrator", "api", "app", "auth", "b", "book", "booking", "bookings", "business", "cs", "help", "home",
  "login", "logout", "my", "namneun", "namneunjari", "new", "notice", "null", "official", "operator", "privacy", "root",
  "search", "seller", "settings", "signup", "slots", "staff", "static", "support", "system", "terms", "undefined", "uploads", "www",
]);

// ── 공통 ──────────────────────────────────────────────

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** 같은 키의 작업을 트랜잭션 단위로 줄 세운다(개수 제한을 동시 요청이 함께 통과하지 못하게). */
const lockKey = (tx: Prisma.TransactionClient, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

const SINGLE_LINE = /^[^\p{Cc}]*$/u;

/** 사업장 대표 전화: 휴대전화·지역번호·070·대표번호(15xx~18xx)를 숫자만 남긴다. 형식이 아니면 null */
function normalizeBusinessPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (/^0\d{8,10}$/.test(digits) || /^1[5-8]\d{6}$/.test(digits)) return digits;
  return null;
}

/** https 주소만 받는다. 계정 정보가 든 주소(https://a@b)는 다른 사이트로 속일 수 있어 거절한다. */
function normalizeHttpsUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  return url.toString();
}

// ── 입력 스키마 ───────────────────────────────────────

const nameSchema = z
  .string("상호를 입력해 주세요.")
  .trim()
  .min(2, "상호는 2자 이상이어야 해요.")
  .max(40, "상호는 40자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "상호에 쓸 수 없는 문자가 있어요.");

/** 선택 항목 공통: 빈 문자열은 "없음"(null)으로 저장한다. */
const emptyToNull = (value: string) => value || null;

const taglineSchema = z
  .string()
  .trim()
  .max(60, "한 줄 소개는 60자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "한 줄 소개에 쓸 수 없는 문자가 있어요.")
  .transform(emptyToNull);

const descriptionSchema = z.string().trim().max(2000, "소개는 2,000자까지 쓸 수 있어요.").transform(emptyToNull);

const phoneSchema = z
  .string("대표 전화번호를 입력해 주세요.")
  .trim()
  .max(20, "전화번호를 확인해 주세요.")
  .transform((value, ctx) => {
    const phone = normalizeBusinessPhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "전화번호를 확인해 주세요." });
      return z.NEVER;
    }
    return phone;
  });

const addressSchema = z
  .string("주소를 입력해 주세요.")
  .trim()
  .min(5, "주소를 입력해 주세요.")
  .max(200, "주소는 200자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "주소에 쓸 수 없는 문자가 있어요.");

const addressDetailSchema = z
  .string()
  .trim()
  .max(100, "상세 주소는 100자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "상세 주소에 쓸 수 없는 문자가 있어요.")
  .transform(emptyToNull);

const idSchema = z.string().min(1).max(64);
const areaIdSchema = z.string().max(64).transform(emptyToNull);

const regNoSchema = z
  .string("사업자등록번호를 입력해 주세요.")
  .trim()
  .max(20, "사업자등록번호를 확인해 주세요.")
  .transform((value) => value.replace(/\D/g, ""))
  .refine(isValidBusinessRegNo, "사업자등록번호를 확인해 주세요.");

const representativeSchema = z
  .string("대표자 이름을 입력해 주세요.")
  .trim()
  .min(2, "대표자 이름을 입력해 주세요.")
  .max(30, "대표자 이름은 30자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "대표자 이름에 쓸 수 없는 문자가 있어요.");

/** 인스타그램은 아이디만 저장한다(앞의 @ 는 떼어 낸다). */
const instagramSchema = z
  .string()
  .trim()
  .max(40, "인스타그램 아이디를 확인해 주세요.")
  .transform((value, ctx) => {
    const handle = value.replace(/^@/, "");
    if (handle === "") return null;
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
      ctx.addIssue({ code: "custom", message: "인스타그램은 주소가 아닌 아이디만 입력해 주세요. (예: namneunjari)" });
      return z.NEVER;
    }
    return handle;
  });

const websiteSchema = z
  .string()
  .trim()
  .max(200, "홈페이지 주소는 200자까지 쓸 수 있어요.")
  .transform((value, ctx) => {
    if (value === "") return null;
    const url = normalizeHttpsUrl(value);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "홈페이지는 https:// 로 시작하는 주소만 쓸 수 있어요." });
      return z.NEVER;
    }
    return url;
  });

/** 카카오톡 채널은 공개 ID(_로 시작)만 저장한다. 채널 주소를 붙여 넣어도 ID 만 뽑는다. */
const kakaoChannelSchema = z
  .string()
  .trim()
  .max(80, "카카오톡 채널 주소를 확인해 주세요.")
  .transform((value, ctx) => {
    if (value === "") return null;
    const id = value.replace(/^https:\/\/pf\.kakao\.com\//, "").replace(/\/(?:chat|friend)?$/, "");
    if (!/^_[A-Za-z0-9]{2,20}$/.test(id)) {
      ctx.addIssue({ code: "custom", message: "카카오톡 채널 주소(https://pf.kakao.com/_xxxx)를 입력해 주세요." });
      return z.NEVER;
    }
    return id;
  });

const imageSchema = z.string().max(500, "이미지 주소를 확인해 주세요.").transform(emptyToNull);

/** 통신판매업 신고번호(예: 2026-대전서구-0123, 제2026-대전서구-0123호). 지자체마다 표기가 달라 모양만 느슨하게 확인한다. */
const mailOrderRegNoSchema = z
  .string()
  .trim()
  .max(40, "통신판매업 신고번호는 40자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "통신판매업 신고번호에 쓸 수 없는 문자가 있어요.")
  .refine((value) => value === "" || /[0-9]{4}/.test(value), "통신판매업 신고번호를 확인해 주세요. (예: 2026-대전서구-0123)")
  .transform(emptyToNull);

const applySchema = z.object({
  name: nameSchema,
  categoryId: z.string("업종을 골라 주세요.").min(1, "업종을 골라 주세요.").max(64),
  areaId: areaIdSchema.nullish(),
  tagline: taglineSchema.nullish(),
  description: descriptionSchema.nullish(),
  phone: phoneSchema,
  address: addressSchema,
  addressDetail: addressDetailSchema.nullish(),
  businessRegNo: regNoSchema,
  representativeName: representativeSchema,
  instagram: instagramSchema.nullish(),
  website: websiteSchema.nullish(),
});

const profileSchema = z
  .object({
    name: nameSchema,
    tagline: taglineSchema.nullable(),
    description: descriptionSchema.nullable(),
    phone: phoneSchema,
    address: addressSchema,
    addressDetail: addressDetailSchema.nullable(),
    areaId: areaIdSchema.nullable(),
    instagram: instagramSchema.nullable(),
    kakaoChannel: kakaoChannelSchema.nullable(),
    website: websiteSchema.nullable(),
    coverImage: imageSchema.nullable(),
    logoImage: imageSchema.nullable(),
    // 판매자 신원정보(법정 표시 사항). 사업자등록번호는 심사 대상이라 여기서 바꿀 수 없다(반려 건 재신청으로만).
    representativeName: representativeSchema,
    mailOrderRegNo: mailOrderRegNoSchema.nullable(),
  })
  .partial();

export type BusinessApplicationInput = z.input<typeof applySchema>;
export type BusinessProfilePatch = z.input<typeof profileSchema>;

// ── 조회 형식 ─────────────────────────────────────────

export interface BankAccountMasked {
  bankName: string;
  /** 끝 4자리만 보이는 계좌번호: "****1234" */
  masked: string;
  holder: string;
}

/** 저장된 계좌 정보를 화면용으로 가린다. 계좌가 등록돼 있지 않으면 null */
export function getBankAccountMasked(business: {
  bankName: string | null;
  bankAccountLast4: string | null;
  bankHolder: string | null;
}): BankAccountMasked | null {
  if (!business.bankName || !business.bankAccountLast4 || !business.bankHolder) return null;
  return { bankName: business.bankName, masked: `****${business.bankAccountLast4}`, holder: business.bankHolder };
}

const businessInclude = {
  category: { select: { id: true, slug: true, name: true } },
  area: { select: { id: true, slug: true, name: true, district: true, city: true } },
} satisfies Prisma.BusinessInclude;

type BusinessRow = Prisma.BusinessGetPayload<{ include: typeof businessInclude }>;

/** 구성원이 보는 사업장 정보. 계좌번호 암호문 같은 내부 값은 담지 않는다. */
export interface MemberBusiness {
  id: string;
  slug: string;
  name: string;
  status: BusinessStatus;
  plan: PlanTier;
  /** 이 정보를 보는 회원의 역할 */
  role: MemberRole;
  category: { id: string; slug: string; name: string };
  area: { id: string; slug: string; name: string; district: string; city: string } | null;
  tagline: string | null;
  description: string | null;
  phone: string | null;
  address: string | null;
  addressDetail: string | null;
  coverImage: string | null;
  logoImage: string | null;
  instagram: string | null;
  kakaoChannel: string | null;
  website: string | null;
  businessRegNo: string | null;
  representativeName: string | null;
  mailOrderRegNo: string | null;
  reviewedAt: Date | null;
  rejectReason: string | null;
  suspendedReason: string | null;
  autoRelist: boolean;
  defaultDeadlineMin: number;
  ratingAvg: number;
  ratingCount: number;
  followerCount: number;
  /** 가려진 정산 계좌. 스태프에게는 보여 주지 않는다(null). */
  bankAccount: BankAccountMasked | null;
  createdAt: Date;
}

function toMemberBusiness(b: BusinessRow, role: MemberRole): MemberBusiness {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    status: b.status,
    plan: b.plan,
    role,
    category: b.category,
    area: b.area,
    tagline: b.tagline,
    description: b.description,
    phone: b.phone,
    address: b.address,
    addressDetail: b.addressDetail,
    coverImage: b.coverImage,
    logoImage: b.logoImage,
    instagram: b.instagram,
    kakaoChannel: b.kakaoChannel,
    website: b.website,
    businessRegNo: b.businessRegNo,
    representativeName: b.representativeName,
    mailOrderRegNo: b.mailOrderRegNo,
    reviewedAt: b.reviewedAt,
    rejectReason: b.rejectReason,
    suspendedReason: b.suspendedReason,
    autoRelist: b.autoRelist,
    defaultDeadlineMin: b.defaultDeadlineMin,
    ratingAvg: b.ratingAvg,
    ratingCount: b.ratingCount,
    followerCount: b.followerCount,
    bankAccount: role === "STAFF" ? null : getBankAccountMasked(b),
    createdAt: b.createdAt,
  };
}

/** 구성원용 사업장 정보. 구성원이 아니면(사업장이 없을 때도) 같은 권한 오류를 낸다. */
export async function getBusinessForMember(userId: string, businessId: string): Promise<MemberBusiness> {
  const member = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    select: { role: true, business: { include: businessInclude } },
  });
  if (!member) throw err.forbidden();
  return toMemberBusiness(member.business, member.role);
}

/** 공개 사업장 페이지(/b/{slug})용 정보 */
export interface PublicBusiness {
  id: string;
  slug: string;
  name: string;
  category: { slug: string; name: string };
  area: { slug: string; name: string; district: string; city: string } | null;
  tagline: string | null;
  description: string | null;
  phone: string | null;
  address: string | null;
  addressDetail: string | null;
  lat: number | null;
  lng: number | null;
  coverImage: string | null;
  logoImage: string | null;
  instagram: string | null;
  kakaoChannel: string | null;
  website: string | null;
  ratingAvg: number;
  ratingCount: number;
  followerCount: number;
  isDemo: boolean;
  /** 전자상거래법에 따라 표시하는 사업자 정보 */
  legal: {
    name: string;
    representativeName: string | null;
    businessRegNo: string | null;
    mailOrderRegNo: string | null;
    address: string | null;
    phone: string | null;
  };
}

/** 승인된 사업장만 돌려준다. 심사 중·반려·정지 사업장과 없는 주소는 모두 null */
export async function getPublicBusiness(slug: string): Promise<PublicBusiness | null> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 60) return null;
  const b = await prisma.business.findFirst({
    where: { slug, status: "APPROVED" },
    select: {
      id: true,
      slug: true,
      name: true,
      category: { select: { slug: true, name: true } },
      area: { select: { slug: true, name: true, district: true, city: true } },
      tagline: true,
      description: true,
      phone: true,
      address: true,
      addressDetail: true,
      lat: true,
      lng: true,
      coverImage: true,
      logoImage: true,
      instagram: true,
      kakaoChannel: true,
      website: true,
      ratingAvg: true,
      ratingCount: true,
      followerCount: true,
      isDemo: true,
      representativeName: true,
      businessRegNo: true,
      mailOrderRegNo: true,
    },
  });
  if (!b) return null;
  const { representativeName, businessRegNo, mailOrderRegNo, ...profile } = b;
  return {
    ...profile,
    legal: {
      name: b.name,
      representativeName,
      businessRegNo,
      mailOrderRegNo,
      address: [b.address, b.addressDetail].filter(Boolean).join(" ") || null,
      phone: b.phone,
    },
  };
}

// ── 입점 신청 ─────────────────────────────────────────

async function loadActiveCategory(categoryId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true, slug: true, isActive: true } });
  if (!category || !category.isActive) throw err.validation("업종을 다시 골라 주세요.", { categoryId: "지금은 고를 수 없는 업종이에요." });
  return category;
}

async function assertActiveArea(areaId: string): Promise<void> {
  const area = await prisma.area.findUnique({ where: { id: areaId }, select: { isActive: true } });
  if (!area || !area.isActive) throw err.validation("지역을 다시 골라 주세요.", { areaId: "지금은 고를 수 없는 지역이에요." });
}

/** 공개 주소 기본값: 업종 슬러그 + 무작위 8자 (예: meet-k3x9a2bq). 나중에 대표가 바꿀 수 있다. */
function generateSlug(categorySlug: string): string {
  const prefix = slugify(categorySlug).slice(0, 20).replace(/-+$/, "") || "biz";
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return `${prefix}-${suffix}`;
}

const APPLY_RATE_MESSAGE = "입점 신청이 너무 잦아요. 잠시 후 다시 시도해 주세요.";
const DUPLICATE_REG_NO = "같은 사업자등록번호로 이미 신청한 사업장이 있어요.";

/**
 * 입점 신청: 심사 대기(PENDING) 사업장을 만들고 신청한 회원을 대표로 등록한다.
 * 한 회원이 대표로 가질 수 있는 사업장은 3곳까지다(반려된 신청 포함 — 반려 건은 reapplyForBusiness 로 고쳐 다시 낸다).
 */
export async function applyForBusiness(userId: string, input: BusinessApplicationInput): Promise<MemberBusiness> {
  const data = parseInput(applySchema, input);
  await enforceRateLimit(`business-apply:user:${userId}`, 5, 3600, APPLY_RATE_MESSAGE);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user || user.status !== "ACTIVE") throw err.forbidden();
  const category = await loadActiveCategory(data.categoryId);
  if (data.areaId) await assertActiveArea(data.areaId);

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug(category.slug);
    try {
      const business = await prisma.$transaction(async (tx) => {
        await lockKey(tx, `business-owner:${userId}`);
        const owned = await tx.businessMember.findMany({
          where: { userId, role: "OWNER" },
          select: { business: { select: { businessRegNo: true, status: true } } },
        });
        if (owned.length >= MAX_OWNED_BUSINESSES) {
          throw err.conflict(`사업장은 한 계정에 ${MAX_OWNED_BUSINESSES}곳까지 등록할 수 있어요. 반려된 신청은 내용을 고쳐 다시 낼 수 있어요.`);
        }
        if (owned.some((m) => m.business.businessRegNo === data.businessRegNo && m.business.status !== "REJECTED")) {
          throw err.conflict(DUPLICATE_REG_NO);
        }
        return tx.business.create({
          data: {
            slug,
            name: data.name,
            categoryId: category.id,
            areaId: data.areaId ?? null,
            tagline: data.tagline ?? null,
            description: data.description ?? null,
            phone: data.phone,
            address: data.address,
            addressDetail: data.addressDetail ?? null,
            businessRegNo: data.businessRegNo,
            representativeName: data.representativeName,
            instagram: data.instagram ?? null,
            website: data.website ?? null,
            status: "PENDING",
            members: { create: { userId, role: "OWNER" } },
          },
          include: businessInclude,
        });
      });
      await audit({
        actorId: userId,
        actorType: "SELLER",
        action: "business.apply",
        targetType: "Business",
        targetId: business.id,
        meta: { name: business.name, categoryId: business.categoryId },
      });
      return toMemberBusiness(business, "OWNER");
    } catch (e) {
      // 무작위 주소가 이미 쓰이고 있으면 새로 만들어 다시 시도한다.
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new AppError("INTERNAL", "사업장 주소를 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
}

/** 반려된 신청을 고쳐 다시 낸다(대표만). 공개 주소는 그대로 두고 심사 대기로 되돌린다. */
export async function reapplyForBusiness(actorUserId: string, businessId: string, input: BusinessApplicationInput): Promise<MemberBusiness> {
  await assertBusinessAccess(actorUserId, businessId, "OWNER");
  const data = parseInput(applySchema, input);
  await enforceRateLimit(`business-apply:user:${actorUserId}`, 5, 3600, APPLY_RATE_MESSAGE);
  const category = await loadActiveCategory(data.categoryId);
  if (data.areaId) await assertActiveArea(data.areaId);

  const duplicate = await prisma.businessMember.findFirst({
    where: {
      userId: actorUserId,
      role: "OWNER",
      businessId: { not: businessId },
      business: { businessRegNo: data.businessRegNo, status: { not: "REJECTED" } },
    },
    select: { id: true },
  });
  if (duplicate) throw err.conflict(DUPLICATE_REG_NO);

  // 반려 상태일 때만 바뀐다(동시에 두 번 내도 한 번만 반영).
  const updated = await prisma.business.updateMany({
    where: { id: businessId, status: "REJECTED" },
    data: {
      name: data.name,
      categoryId: category.id,
      areaId: data.areaId ?? null,
      tagline: data.tagline ?? null,
      description: data.description ?? null,
      phone: data.phone,
      address: data.address,
      addressDetail: data.addressDetail ?? null,
      businessRegNo: data.businessRegNo,
      representativeName: data.representativeName,
      instagram: data.instagram ?? null,
      website: data.website ?? null,
      status: "PENDING",
      rejectReason: null,
    },
  });
  if (updated.count === 0) throw err.conflict("반려된 신청만 다시 낼 수 있어요.");
  await audit({ actorId: actorUserId, actorType: "SELLER", action: "business.reapply", targetType: "Business", targetId: businessId });
  return getBusinessForMember(actorUserId, businessId);
}

// ── 프로필 · 운영 설정 ────────────────────────────────

const MAIL_ORDER_LOCKED = "승인된 사업장은 통신판매업 신고번호를 지울 수 없어요. 번호가 바뀌었다면 새 번호를 입력해 주세요.";

/**
 * 사업장 프로필 수정(매니저 이상). 넘어온 항목만 바꾸고, null·빈 문자열은 선택 항목을 지운다.
 *
 * 판매자 신원정보(상호·대표자·사업자등록번호·통신판매업 신고번호·연락처·주소)는 전자상거래법상 공개해야 하는 정보다.
 * - 상호·대표자·연락처·주소는 값을 바꿀 수는 있어도 비울 수는 없다(빈 값은 검증에서 거절).
 * - 대표자 이름과 통신판매업 신고번호는 대표만 바꿀 수 있다.
 * - 승인을 받은 사업장(승인·이용 정지 상태)은 등록해 둔 통신판매업 신고번호를 지울 수 없다(새 번호로 바꾸는 것은 가능).
 * - 사업자등록번호는 여기서 바꿀 수 없다.
 */
export async function updateBusinessProfile(actorUserId: string, businessId: string, patch: BusinessProfilePatch): Promise<MemberBusiness> {
  const role = await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  const data = parseInput(profileSchema, patch);
  if (data.areaId) await assertActiveArea(data.areaId);
  if ((data.representativeName !== undefined || data.mailOrderRegNo !== undefined) && role !== "OWNER") {
    throw err.forbidden("대표자 이름과 통신판매업 신고번호는 대표만 바꿀 수 있어요.");
  }
  if (data.coverImage || data.logoImage) {
    // 새로 넣는 이미지는 우리 저장소 주소여야 한다. 이미 저장돼 있던 값을 그대로 다시 보내는 것은 허용한다.
    const current = await prisma.business.findUnique({ where: { id: businessId }, select: { coverImage: true, logoImage: true } });
    for (const field of ["coverImage", "logoImage"] as const) {
      const value = data[field];
      if (value && value !== current?.[field] && !isOwnImageUrl(value)) {
        const message = "이미지는 남는자리에 올린 파일만 쓸 수 있어요.";
        throw err.validation(message, { [field]: message });
      }
    }
  }

  const update: Prisma.BusinessUncheckedUpdateManyInput = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.tagline !== undefined) update.tagline = data.tagline;
  if (data.description !== undefined) update.description = data.description;
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.address !== undefined) update.address = data.address;
  if (data.addressDetail !== undefined) update.addressDetail = data.addressDetail;
  if (data.areaId !== undefined) update.areaId = data.areaId;
  if (data.instagram !== undefined) update.instagram = data.instagram;
  if (data.kakaoChannel !== undefined) update.kakaoChannel = data.kakaoChannel;
  if (data.website !== undefined) update.website = data.website;
  if (data.coverImage !== undefined) update.coverImage = data.coverImage;
  if (data.logoImage !== undefined) update.logoImage = data.logoImage;
  if (data.representativeName !== undefined) update.representativeName = data.representativeName;
  if (data.mailOrderRegNo !== undefined) update.mailOrderRegNo = data.mailOrderRegNo;
  const fields = Object.keys(update);
  if (fields.length === 0) return getBusinessForMember(actorUserId, businessId);

  // 신고번호를 지우는 요청은 아직 승인 전이거나 원래 번호가 없을 때만 반영한다.
  // 조건을 UPDATE 문에 넣어, 확인과 저장 사이에 승인이 끝나더라도 표시 의무가 있는 번호가 지워지지 않게 한다.
  const clearsMailOrder = data.mailOrderRegNo === null;
  const updated = await prisma.business.updateMany({
    where: clearsMailOrder
      ? { id: businessId, OR: [{ mailOrderRegNo: null }, { status: { in: ["PENDING", "REJECTED"] } }] }
      : { id: businessId },
    data: update,
  });
  if (updated.count === 0) {
    if (clearsMailOrder) throw err.validation(MAIL_ORDER_LOCKED, { mailOrderRegNo: MAIL_ORDER_LOCKED });
    throw err.notFound("사업장을 찾을 수 없어요.");
  }
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: businessInclude });
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.profile_update",
    targetType: "Business",
    targetId: businessId,
    meta: { fields },
  });
  return toMemberBusiness(business, role);
}

const slugSchema = z
  .string("주소를 입력해 주세요.")
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, "주소는 영문 소문자·숫자·하이픈(-)으로 3~30자여야 하고, 영문이나 숫자로 시작해야 해요.")
  .refine((slug) => !slug.endsWith("-") && !slug.includes("--"), "하이픈(-)은 끝에 두거나 이어서 쓸 수 없어요.")
  .refine((slug) => !RESERVED_SLUGS.has(slug), "쓸 수 없는 주소예요. 다른 주소를 골라 주세요.");

const SLUG_TAKEN = "이미 쓰이고 있는 주소예요. 다른 주소를 골라 주세요.";
const SLUG_HELD = "얼마 전까지 다른 사업장이 쓰던 주소라 지금은 쓸 수 없어요. 다른 주소를 골라 주세요.";

/** 주소를 바꾼 뒤 예전 주소를 다른 사업장이 쓰지 못하게 잡아 두는 기간(일) */
export const SLUG_HOLD_DAYS = 30;

/**
 * 예전 주소 보류 기록.
 * 따로 테이블을 두지 않고 범용 키 저장소인 RateLimit 행 하나로 남긴다:
 *   key = "slug-hold:{예전 주소}:{사업장 ID}", windowStart = 보류가 끝나는 시각.
 * 주소 변경과 같은 트랜잭션에서 쓰므로 변경과 보류가 함께 반영되고, 끝난 기록은 요청 제한 정리 작업(purgeRateLimits)이 지운다.
 * 주소에는 영문 소문자·숫자·하이픈만 들어가므로 ":" 로 나눈 키가 다른 주소와 겹치지 않는다.
 */
const slugHoldPrefix = (slug: string) => `slug-hold:${slug}:`;
const slugHoldKey = (slug: string, businessId: string) => `${slugHoldPrefix(slug)}${businessId}`;

/** 지금 이 주소를 잡아 두고 있는 사업장의 ID(보류 중이 아니면 null) */
async function findSlugHolder(db: Prisma.TransactionClient | typeof prisma, slug: string, now: Date): Promise<string | null> {
  const hold = await db.rateLimit.findFirst({
    where: { key: { startsWith: slugHoldPrefix(slug) }, windowStart: { gt: now } },
    orderBy: { windowStart: "desc" },
    select: { key: true },
  });
  return hold ? hold.key.slice(slugHoldPrefix(slug).length) : null;
}

/**
 * 주소를 바꾼 사업장의 예전 주소로 들어온 방문을 새 주소로 보내기 위한 조회.
 * 보류 기간(30일) 안의 예전 주소이고 그 사업장이 지금 공개(승인) 상태면 현재 주소를, 아니면 null 을 돌려준다.
 */
export async function findSlugRedirect(slug: string): Promise<string | null> {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return null;
  const holderId = await findSlugHolder(prisma, slug, new Date());
  if (!holderId) return null;
  const business = await prisma.business.findFirst({ where: { id: holderId, status: "APPROVED" }, select: { slug: true } });
  return business && business.slug !== slug ? business.slug : null;
}

/**
 * 공개 주소(/b/{slug}) 변경(대표만). 하루 3번까지만 바꿀 수 있다.
 * 예전 주소는 30일 동안 다른 사업장이 쓸 수 없고(사칭·잘못된 유입 방지), 그동안 원래 사업장은 그 주소로 되돌아갈 수 있다.
 * 예전 주소로 들어온 방문은 findSlugRedirect 로 새 주소를 찾아 보낼 수 있다.
 */
export async function changeSlug(actorUserId: string, businessId: string, slug: string): Promise<{ slug: string }> {
  await assertBusinessAccess(actorUserId, businessId, "OWNER");
  const next = parseInput(slugSchema, slug);
  const current = await prisma.business.findUnique({ where: { id: businessId }, select: { slug: true } });
  if (!current) throw err.notFound("사업장을 찾을 수 없어요.");
  if (current.slug === next) return { slug: next };

  const slugTaken = () => new AppError("CONFLICT", SLUG_TAKEN, { slug: SLUG_TAKEN });
  const slugHeld = () => new AppError("CONFLICT", SLUG_HELD, { slug: SLUG_HELD });
  // 쓸 수 없는 주소는 변경 횟수를 쓰기 전에 알려 준다(아래 트랜잭션에서 한 번 더 확인한다).
  const taken = await prisma.business.findUnique({ where: { slug: next }, select: { id: true } });
  if (taken) throw slugTaken();
  const holder = await findSlugHolder(prisma, next, new Date());
  if (holder && holder !== businessId) throw slugHeld();
  await enforceRateLimit(`business-slug:${businessId}`, 3, 86_400, "주소는 하루에 3번까지 바꿀 수 있어요.");

  try {
    await prisma.$transaction(async (tx) => {
      // 같은 주소를 두고 겨루는 변경(내 예전 주소를 남이 가져가려는 경우 포함)을 주소 단위로 줄 세운다.
      for (const key of [current.slug, next].sort()) await lockKey(tx, `business-slug-change:${key}`);
      const now = new Date();
      const holderNow = await findSlugHolder(tx, next, now);
      if (holderNow && holderNow !== businessId) throw slugHeld();
      const updated = await tx.business.updateMany({ where: { id: businessId, slug: current.slug }, data: { slug: next } });
      if (updated.count === 0) throw err.conflict("주소가 방금 바뀌었어요. 화면을 새로 고친 뒤 다시 시도해 주세요.");
      // 되돌아온 주소의 보류는 풀고, 방금 떠난 주소를 새로 잡아 둔다.
      await tx.rateLimit.deleteMany({ where: { key: { in: [slugHoldKey(next, businessId), slugHoldKey(current.slug, businessId)] } } });
      await tx.rateLimit.create({
        data: { key: slugHoldKey(current.slug, businessId), windowStart: new Date(now.getTime() + SLUG_HOLD_DAYS * DAY), count: 1 },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw slugTaken();
    throw e;
  }
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.slug_change",
    targetType: "Business",
    targetId: businessId,
    meta: { from: current.slug, to: next },
  });
  return { slug: next };
}

const settingsSchema = z
  .object({
    autoRelist: z.boolean("자동 재등록 설정을 확인해 주세요."),
    defaultDeadlineMin: z
      .number("예약 마감 시간을 확인해 주세요.")
      .int("예약 마감 시간은 분 단위 정수로 입력해 주세요.")
      .min(0, "예약 마감 시간은 0분 이상이어야 해요.")
      .max(1440, "예약 마감 시간은 시작 24시간 전(1,440분)까지 정할 수 있어요."),
  })
  .partial();

/** 운영 설정 변경(매니저 이상): 취소석 자동 재등록, 예약 마감 기본값(시작 N분 전) */
export async function updateBusinessSettings(
  actorUserId: string,
  businessId: string,
  input: { autoRelist?: boolean; defaultDeadlineMin?: number },
): Promise<{ autoRelist: boolean; defaultDeadlineMin: number }> {
  await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  const data = parseInput(settingsSchema, input);
  const update: Prisma.BusinessUncheckedUpdateInput = {};
  if (data.autoRelist !== undefined) update.autoRelist = data.autoRelist;
  if (data.defaultDeadlineMin !== undefined) update.defaultDeadlineMin = data.defaultDeadlineMin;

  const select = { autoRelist: true, defaultDeadlineMin: true } as const;
  if (Object.keys(update).length === 0) {
    const current = await prisma.business.findUnique({ where: { id: businessId }, select });
    if (!current) throw err.notFound("사업장을 찾을 수 없어요.");
    return current;
  }

  const business = await prisma.business.update({ where: { id: businessId }, data: update, select });
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.settings_update",
    targetType: "Business",
    targetId: businessId,
    meta: { autoRelist: business.autoRelist, defaultDeadlineMin: business.defaultDeadlineMin },
  });
  return business;
}

// ── 정산 계좌 ─────────────────────────────────────────

const bankSchema = z.object({
  bankName: z
    .string("은행을 골라 주세요.")
    .trim()
    .min(2, "은행을 골라 주세요.")
    .max(20, "은행 이름은 20자까지 쓸 수 있어요.")
    .regex(SINGLE_LINE, "은행 이름에 쓸 수 없는 문자가 있어요."),
  accountNumber: z
    .string("계좌번호를 입력해 주세요.")
    .max(40, "계좌번호는 숫자 8~16자리로 입력해 주세요.")
    .transform((value) => value.replace(/[\s-]/g, ""))
    .refine((value) => /^\d{8,16}$/.test(value), "계좌번호는 숫자 8~16자리로 입력해 주세요."),
  holder: z
    .string("예금주를 입력해 주세요.")
    .trim()
    .min(2, "예금주를 입력해 주세요.")
    .max(30, "예금주는 30자까지 쓸 수 있어요.")
    .regex(SINGLE_LINE, "예금주에 쓸 수 없는 문자가 있어요."),
});

/**
 * 정산 계좌 등록·변경(대표만). 계좌번호는 암호문으로만 저장하고 화면용으로 끝 4자리를 따로 둔다.
 * 계좌가 바뀌면 대표에게 앱 알림과 메일로 알려, 본인이 바꾼 것이 아닐 때 바로 알아챌 수 있게 한다.
 */
export async function setBankAccount(
  actorUserId: string,
  businessId: string,
  input: { bankName: string; accountNumber: string; holder: string },
): Promise<BankAccountMasked> {
  await assertBusinessAccess(actorUserId, businessId, "OWNER");
  const data = parseInput(bankSchema, input);
  await enforceRateLimit(`business-bank:${businessId}`, 5, 3600, "계좌를 너무 자주 바꾸고 있어요. 잠시 후 다시 시도해 주세요.");

  const before = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true, bankAccountEnc: true } });
  if (!before) throw err.notFound("사업장을 찾을 수 없어요.");
  const last4 = data.accountNumber.slice(-4);
  await prisma.business.update({
    where: { id: businessId },
    data: { bankName: data.bankName, bankAccountEnc: encrypt(data.accountNumber), bankAccountLast4: last4, bankHolder: data.holder },
  });

  // 계좌번호는 끝자리도 감사 기록에 남기지 않는다.
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.bank_update",
    targetType: "Business",
    targetId: businessId,
    meta: { bankName: data.bankName, replaced: before.bankAccountEnc !== null },
  });
  await notify({
    userId: actorUserId,
    type: "SYSTEM",
    title: "정산 계좌가 바뀌었어요",
    body: `${before.name}의 정산 계좌가 ${data.bankName} ****${last4} 계좌로 바뀌었어요. 직접 바꾼 것이 아니라면 바로 비밀번호를 바꾸고 고객센터로 알려 주세요.`,
    linkUrl: notificationLinks.sellerHome(),
    external: { channel: "EMAIL", templateKey: "PLATFORM_BANK_ACCOUNT_CHANGED", essential: true, businessId },
  });
  return { bankName: data.bankName, masked: `****${last4}`, holder: data.holder };
}

/**
 * 정산 지급을 위한 계좌번호 원문 조회 — 최고 관리자·정산 담당만 가능하며, 볼 때마다 감사 기록을 남긴다.
 * 계좌가 등록돼 있지 않으면 null
 */
export async function revealBankAccount(
  adminId: string,
  businessId: string,
): Promise<{ bankName: string; accountNumber: string; holder: string } | null> {
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { status: true, adminRole: true } });
  if (!admin || admin.status !== "ACTIVE" || (admin.adminRole !== "SUPER" && admin.adminRole !== "FINANCE")) throw err.forbidden();
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { bankName: true, bankAccountEnc: true, bankHolder: true },
  });
  if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
  if (!business.bankName || !business.bankAccountEnc || !business.bankHolder) return null;

  const accountNumber = decrypt(business.bankAccountEnc);
  await audit({ actorId: adminId, actorType: "ADMIN", action: "business.bank_reveal", targetType: "Business", targetId: businessId });
  return { bankName: business.bankName, accountNumber, holder: business.bankHolder };
}

// ── 구성원 ────────────────────────────────────────────

export interface TeamMember {
  /** 구성원 행 ID — 역할 변경·삭제에 쓴다. */
  memberId: string;
  name: string;
  /** 대표가 아닌 사람이 볼 때는 본인 것을 빼고 가려서 준다(ho**@example.com). */
  email: string;
  role: MemberRole;
  joinedAt: Date;
  isMe: boolean;
}

const ROLE_ORDER: Record<MemberRole, number> = { OWNER: 0, MANAGER: 1, STAFF: 2 };
const assignableRoleSchema = z.enum(["MANAGER", "STAFF"], "역할을 다시 골라 주세요.");

/** 구성원 목록(매니저 이상). 대표 → 매니저 → 스태프, 같은 역할 안에서는 먼저 들어온 순서 */
export async function listMembers(actorUserId: string, businessId: string): Promise<TeamMember[]> {
  const viewerRole = await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  const members = await prisma.businessMember.findMany({
    where: { businessId },
    select: { id: true, userId: true, role: true, createdAt: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return members
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
    .map((m) => ({
      memberId: m.id,
      name: m.user.name,
      email: viewerRole === "OWNER" || m.userId === actorUserId ? m.user.email : maskEmail(m.user.email),
      role: m.role,
      joinedAt: m.createdAt,
      isMe: m.userId === actorUserId,
    }));
}

const addMemberSchema = z.object({
  email: z
    .string("이메일을 입력해 주세요.")
    .trim()
    .toLowerCase()
    .min(1, "이메일을 입력해 주세요.")
    .max(254, "이메일 주소가 너무 길어요.")
    .pipe(z.email("이메일 주소를 확인해 주세요.")),
  role: assignableRoleSchema,
});

/**
 * 구성원 추가(대표만). 이미 가입한 정상 회원의 이메일만 추가할 수 있고,
 * 대표를 포함한 전체 인원이 플랜의 구성원 수(베이직 1명 · 프로 10명)를 넘을 수 없다.
 */
export async function addMember(
  actorUserId: string,
  businessId: string,
  input: { email: string; role: "MANAGER" | "STAFF" },
): Promise<TeamMember> {
  await assertBusinessAccess(actorUserId, businessId, "OWNER");
  const data = parseInput(addMemberSchema, input);
  // 이메일을 넣어 가입 여부를 알아보는 데 쓰이지 않게 횟수를 제한한다.
  await enforceRateLimit(`business-member-add:${businessId}`, 20, 3600);

  const target = await prisma.user.findUnique({ where: { email: data.email }, select: { id: true, name: true, email: true, status: true } });
  if (!target || target.status !== "ACTIVE") {
    const message = "가입된 회원의 이메일만 추가할 수 있어요.";
    throw err.validation(message, { email: message });
  }

  const { member, businessName } = await prisma.$transaction(async (tx) => {
    await lockKey(tx, `business-team:${businessId}`);
    const business = await tx.business.findUnique({
      where: { id: businessId },
      select: { name: true, plan: true, members: { select: { userId: true } } },
    });
    if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
    if (business.members.some((m) => m.userId === target.id)) throw err.conflict("이미 함께하고 있는 구성원이에요.");
    const limit = PLAN_FEATURES[business.plan].maxTeamMembers;
    if (business.members.length >= limit) {
      throw err.forbidden(
        business.plan === "FREE"
          ? `베이직 플랜은 대표 계정만 쓸 수 있어요. 프로 플랜에서는 구성원을 ${PLAN_FEATURES.PRO.maxTeamMembers}명까지 둘 수 있어요.`
          : `구성원은 대표를 포함해 ${limit}명까지 둘 수 있어요.`,
      );
    }
    const created = await tx.businessMember.create({
      data: { businessId, userId: target.id, role: data.role },
      select: { id: true, role: true, createdAt: true },
    });
    return { member: created, businessName: business.name };
  });

  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.member_add",
    targetType: "Business",
    targetId: businessId,
    meta: { memberId: member.id, userId: target.id, role: member.role },
  });
  await notify({
    userId: target.id,
    type: "SYSTEM",
    title: `${businessName} 구성원으로 추가됐어요`,
    body: `${MEMBER_ROLE_LABEL[member.role]} 권한으로 사업자 센터를 이용할 수 있어요.`,
    linkUrl: notificationLinks.sellerHome(),
  });
  return { memberId: member.id, name: target.name, email: target.email, role: member.role, joinedAt: member.createdAt, isMe: false };
}

async function loadMember(businessId: string, memberId: string) {
  const parsedId = idSchema.safeParse(memberId);
  // 다른 사업장의 구성원 ID 를 넣어도 찾지 못한다.
  const member = parsedId.success
    ? await prisma.businessMember.findFirst({ where: { id: parsedId.data, businessId }, select: { id: true, userId: true, role: true } })
    : null;
  if (!member) throw err.notFound("구성원을 찾을 수 없어요.");
  return member;
}

/** 구성원 역할 변경(대표만). 대표의 역할은 바꿀 수 없고, 누구도 대표로 올릴 수 없다. */
export async function changeMemberRole(
  actorUserId: string,
  businessId: string,
  memberId: string,
  role: "MANAGER" | "STAFF",
): Promise<{ memberId: string; role: MemberRole }> {
  await assertBusinessAccess(actorUserId, businessId, "OWNER");
  const nextRole = parseInput(assignableRoleSchema, role);
  const member = await loadMember(businessId, memberId);
  if (member.role === "OWNER") throw err.forbidden("대표의 역할은 바꿀 수 없어요.");
  if (member.role === nextRole) return { memberId: member.id, role: member.role };

  // 그사이 대표가 된 행은 건드리지 않는다.
  const updated = await prisma.businessMember.updateMany({
    where: { id: member.id, businessId, role: { not: "OWNER" } },
    data: { role: nextRole },
  });
  if (updated.count === 0) throw err.notFound("구성원을 찾을 수 없어요.");
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.member_role",
    targetType: "Business",
    targetId: businessId,
    meta: { memberId: member.id, userId: member.userId, from: member.role, to: nextRole },
  });
  return { memberId: member.id, role: nextRole };
}

/** 구성원 삭제. 대표는 다른 구성원을 뺄 수 있고, 매니저·스태프는 본인만 나갈 수 있다. 대표는 뺄 수 없다. */
export async function removeMember(actorUserId: string, businessId: string, memberId: string): Promise<void> {
  const actorRole = await assertBusinessAccess(actorUserId, businessId, "STAFF");
  const member = await loadMember(businessId, memberId);
  if (actorRole !== "OWNER" && member.userId !== actorUserId) throw err.forbidden();
  if (member.role === "OWNER") throw err.forbidden("대표는 구성원에서 뺄 수 없어요.");

  const removed = await prisma.businessMember.deleteMany({ where: { id: member.id, businessId, role: { not: "OWNER" } } });
  if (removed.count === 0) throw err.notFound("구성원을 찾을 수 없어요.");
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "business.member_remove",
    targetType: "Business",
    targetId: businessId,
    meta: { memberId: member.id, userId: member.userId, role: member.role, self: member.userId === actorUserId },
  });
}
