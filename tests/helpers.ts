import { randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { prisma } from "@/server/db";
import { resetSettingsCache } from "@/server/settings";

/** 모든 테이블을 비운다. 각 테스트 파일의 beforeEach 에서 호출한다. */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  resetSettingsCache();
}

const uid = () => randomBytes(4).toString("hex");

export async function createUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const id = uid();
  return prisma.user.create({
    data: {
      email: `user-${id}@example.com`,
      // 테스트에서는 비밀번호 검증을 거치지 않는 한 실제 해시가 필요 없다.
      passwordHash: "scrypt$1$1$1$AAAA$AAAA",
      name: `고객${id}`,
      phone: `010${Math.floor(10000000 + Math.random() * 89999999)}`,
      termsAgreedAt: new Date(),
      privacyAgreedAt: new Date(),
      ...overrides,
    },
  });
}

export async function createCategory(overrides: Partial<Prisma.CategoryUncheckedCreateInput> = {}) {
  const id = uid();
  return prisma.category.create({
    data: { slug: `cat-${id}`, name: `분류${id}`, icon: "sparkles", ...overrides },
  });
}

export async function createArea(overrides: Partial<Prisma.AreaUncheckedCreateInput> = {}) {
  const id = uid();
  return prisma.area.create({
    data: { slug: `area-${id}`, name: "둔산동", district: "서구", city: "대전", ...overrides },
  });
}

/** 승인된 사업장 + 대표 회원 */
export async function createBusiness(overrides: Partial<Prisma.BusinessUncheckedCreateInput> = {}) {
  const id = uid();
  const owner = await createUser({ name: `사장${id}` });
  const category = overrides.categoryId ? null : await createCategory();
  const business = await prisma.business.create({
    data: {
      slug: `biz-${id}`,
      name: `가게${id}`,
      categoryId: overrides.categoryId ?? category!.id,
      status: "APPROVED",
      ...overrides,
      members: { create: { userId: owner.id, role: "OWNER" } },
    },
  });
  return { business, owner };
}

export async function createProduct(
  businessId: string,
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
) {
  return prisma.product.create({
    data: {
      businessId,
      categoryId,
      title: `상품 ${uid()}`,
      basePrice: 30000,
      durationMin: 120,
      status: "ACTIVE",
      paymentPolicy: "PREPAY",
      cancellationTiers: [...CANCELLATION_PRESETS.STANDARD.tiers],
      seatTemplates: [{ label: "일반", gender: "ANY", capacity: 4, price: 30000 }],
      images: [],
      tags: [],
      ...overrides,
    },
  });
}

export interface SeatSpec {
  label?: string;
  gender?: "ANY" | "MALE" | "FEMALE";
  capacity: number;
  price?: number;
  originalPrice?: number | null;
}

/** 지금부터 startsInHours 시간 뒤에 시작하는 회차(기본: 48시간 뒤, 2시간짜리, 마감 1시간 전) */
export async function createSlot(
  product: { id: string; businessId: string },
  seats: SeatSpec[] = [{ capacity: 4 }],
  options: { startsInHours?: number; durationMin?: number; deadlineMinBefore?: number } & Partial<Prisma.SlotUncheckedCreateInput> = {},
) {
  const { startsInHours = 48, durationMin = 120, deadlineMinBefore = 60, ...overrides } = options;
  const startAt = new Date(Date.now() + startsInHours * 3_600_000);
  return prisma.slot.create({
    data: {
      productId: product.id,
      businessId: product.businessId,
      startAt,
      endAt: new Date(startAt.getTime() + durationMin * 60_000),
      bookingDeadlineAt: new Date(startAt.getTime() - deadlineMinBefore * 60_000),
      ...overrides,
      seats: {
        create: seats.map((s, i) => ({
          label: s.label ?? "일반",
          gender: s.gender ?? "ANY",
          capacity: s.capacity,
          price: s.price ?? 30000,
          originalPrice: s.originalPrice ?? null,
          sort: i,
        })),
      },
    },
    include: { seats: { orderBy: { sort: "asc" } } },
  });
}

/** 사업장·상품·회차를 한 번에 만든다. */
export async function createListing(
  seats: SeatSpec[] = [{ capacity: 4 }],
  options: Parameters<typeof createSlot>[2] & { product?: Partial<Prisma.ProductUncheckedCreateInput> } = {},
) {
  const { product: productOverrides, ...slotOptions } = options;
  const { business, owner } = await createBusiness();
  const product = await createProduct(business.id, business.categoryId, productOverrides);
  const slot = await createSlot(product, seats, slotOptions);
  return { business, owner, product, slot, seat: slot.seats[0]! };
}
