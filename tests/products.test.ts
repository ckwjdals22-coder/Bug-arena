import { beforeEach, describe, expect, it } from "vitest";
import type { BookingStatus, MemberRole, Prisma } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { newBookingCode, newToken } from "@/lib/ids";
import { applyBps } from "@/lib/money";
import { BANNED_PHRASES } from "@/lib/policy";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  createProduct,
  duplicateProduct,
  estimatePayout,
  getProductForSeller,
  listProductsForSeller,
  setProductStatus,
  updateProduct,
  type ProductInput,
} from "@/server/services/products";
import { DEFAULT_SETTINGS, PLAN_FEATURES } from "@/server/settings";
import { createArea, createBusiness, createCategory, createProduct as insertProduct, createSlot, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

const image = (n: number) => `/uploads/product/2026/11/${String(n).padStart(32, "a")}.webp`;

/** 법정 표시에 필요한 판매자 정보를 갖춘 사업장 */
const SELLER_INFO = { representativeName: "김대표", businessRegNo: "1234567891", phone: "0421234567", address: "대전 서구 둔산로 123" };

async function setup(business: Partial<Prisma.BusinessUncheckedCreateInput> = {}) {
  const category = await createCategory();
  const created = await createBusiness({ categoryId: category.id, ...SELLER_INFO, ...business });
  return { ...created, category };
}

async function addMember(businessId: string, role: MemberRole) {
  const user = await createUser();
  await prisma.businessMember.create({ data: { businessId, userId: user.id, role } });
  return user;
}

const validInput = (categoryId: string, overrides: Partial<ProductInput> = {}): ProductInput => ({
  title: "금요 와인 소셜",
  categoryId,
  basePrice: 30_000,
  seatTemplates: [
    { label: "남성", gender: "MALE", capacity: 4, price: 35_000, minCount: 2 },
    { label: "여성", gender: "FEMALE", capacity: 4, price: 30_000, minCount: 2 },
  ],
  ...overrides,
});

const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
const seat = (overrides: Record<string, unknown> = {}) => ({ label: "일반", capacity: 4, price: 30_000, ...overrides });

// ───────────────────────── 등록 ─────────────────────────

describe("createProduct", () => {
  it("임시저장으로 만들고, 생략한 항목은 기본값으로 채운다", async () => {
    const { business, owner, category } = await setup();

    const product = await createProduct(owner.id, business.id, validInput(category.id));

    expect(product).toMatchObject({
      businessId: business.id,
      status: "DRAFT",
      title: "금요 와인 소셜",
      summary: null,
      description: null,
      images: [],
      durationMin: 120,
      basePrice: 30_000,
      category: { id: category.id },
      area: null,
      minAge: null,
      maxAge: null,
      requiresIdentity: false,
      requiresApproval: false,
      maxPerBooking: 4,
      resaleRefundRate: null,
      tags: [],
      paymentPolicy: "PREPAY",
      depositAmount: null,
      cancellationPreset: "STANDARD",
      cancellationTiers: [...CANCELLATION_PRESETS.STANDARD.tiers],
      seatTemplates: [
        { label: "남성", gender: "MALE", capacity: 4, price: 35_000, minCount: 2 },
        { label: "여성", gender: "FEMALE", capacity: 4, price: 30_000, minCount: 2 },
      ],
      upcomingSlotCount: 0,
      nextSlotAt: null,
    });
    const [log] = await audits("product.create");
    expect(log).toMatchObject({ actorId: owner.id, actorType: "SELLER", targetType: "Product", targetId: product.id });
  });

  it("모든 항목을 넣어 등록한다(글은 앞뒤 공백 정리, 태그는 # 제거·중복 제거, 구간은 큰 시간부터 정렬)", async () => {
    const { business, owner, category } = await setup();
    const area = await createArea();

    const product = await createProduct(
      owner.id,
      business.id,
      validInput(category.id, {
        title: "  보드게임 번개  ",
        summary: " 처음 와도 어색하지 않아요 ",
        description: "여러 줄\n설명",
        includes: "음료 1잔",
        notice: "10분 전 도착",
        images: [image(1), image(2)],
        durationMin: 90,
        basePrice: 20_000,
        areaId: area.id,
        placeName: "둔산 보드카페",
        address: "대전 서구 둔산로 1",
        lat: 36.35,
        lng: 127.38,
        minAge: 20,
        maxAge: 39,
        requiresIdentity: true,
        requiresApproval: true,
        maxPerBooking: 2,
        resaleRefundRate: 80,
        tags: ["#보드게임", "보드게임", " 번개 "],
        paymentPolicy: "DEPOSIT",
        depositAmount: 5_000,
        cancellationTiers: [
          { hoursBefore: 0, refundRate: 0 },
          { hoursBefore: 48, refundRate: 100 },
          { hoursBefore: 12, refundRate: 30 },
        ],
        seatTemplates: [{ label: " 일반 ", capacity: 8, price: 20_000 }],
      }),
    );

    expect(product).toMatchObject({
      title: "보드게임 번개",
      summary: "처음 와도 어색하지 않아요",
      description: "여러 줄\n설명",
      images: [image(1), image(2)],
      durationMin: 90,
      area: { id: area.id },
      placeName: "둔산 보드카페",
      lat: 36.35,
      lng: 127.38,
      minAge: 20,
      maxAge: 39,
      requiresIdentity: true,
      requiresApproval: true,
      maxPerBooking: 2,
      resaleRefundRate: 80,
      tags: ["보드게임", "번개"],
      paymentPolicy: "DEPOSIT",
      depositAmount: 5_000,
      cancellationPreset: null,
      cancellationTiers: [
        { hoursBefore: 48, refundRate: 100 },
        { hoursBefore: 12, refundRate: 30 },
        { hoursBefore: 0, refundRate: 0 },
      ],
      seatTemplates: [{ label: "일반", gender: "ANY", capacity: 8, price: 20_000, minCount: 0 }],
    });
  });

  it.each(Object.keys(CANCELLATION_PRESETS) as (keyof typeof CANCELLATION_PRESETS)[])("환불 기준 프리셋 %s", async (key) => {
    const { business, owner, category } = await setup();
    const product = await createProduct(owner.id, business.id, validInput(category.id, { cancellationTiers: key }));
    expect(product.cancellationPreset).toBe(key);
    expect(product.cancellationTiers).toEqual([...CANCELLATION_PRESETS[key].tiers]);
  });

  it("선택 항목의 빈 문자열은 '없음'으로, 예약금은 예약금 결제가 아닐 때 비운다", async () => {
    const { business, owner, category } = await setup();
    const product = await createProduct(
      owner.id,
      business.id,
      validInput(category.id, { summary: "   ", description: "", placeName: "", areaId: "", depositAmount: 5_000, paymentPolicy: "ONSITE" }),
    );
    expect(product).toMatchObject({ summary: null, description: null, placeName: null, area: null, depositAmount: null, paymentPolicy: "ONSITE" });
  });

  describe("검증 규칙", () => {
    const tiers = (...pairs: [number, number][]) => pairs.map(([hoursBefore, refundRate]) => ({ hoursBefore, refundRate }));

    const cases: [string, Record<string, unknown>, string][] = [
      ["이름 없음", { title: undefined }, "title"],
      ["이름 1자", { title: "가" }, "title"],
      ["이름 61자", { title: "가".repeat(61) }, "title"],
      ["이름에 줄바꿈", { title: "와인\n소셜" }, "title"],
      ["한 줄 소개 121자", { summary: "가".repeat(121) }, "summary"],
      ["상세 설명 5,001자", { description: "가".repeat(5001) }, "description"],
      ["포함 사항 1,001자", { includes: "가".repeat(1001) }, "includes"],
      ["유의 사항 1,001자", { notice: "가".repeat(1001) }, "notice"],
      ["사진 9장", { images: Array.from({ length: 9 }, (_, i) => image(i)) }, "images"],
      ["외부 사진 주소", { images: [image(1), "https://evil.example/a.webp"] }, "images.1"],
      ["경로를 벗어나는 사진 주소", { images: ["/uploads/../etc/passwd"] }, "images.0"],
      ["같은 사진 두 번", { images: [image(1), image(1)] }, "images"],
      ["진행 시간 9분", { durationMin: 9 }, "durationMin"],
      ["진행 시간 1,441분", { durationMin: 1441 }, "durationMin"],
      ["진행 시간 소수", { durationMin: 90.5 }, "durationMin"],
      ["가격 없음", { basePrice: undefined }, "basePrice"],
      ["가격 음수", { basePrice: -1 }, "basePrice"],
      ["가격 1,000만원 초과", { basePrice: 10_000_001 }, "basePrice"],
      ["가격 문자열", { basePrice: "30000" }, "basePrice"],
      ["최소 나이 13세", { minAge: 13 }, "minAge"],
      ["최대 나이 100세", { maxAge: 100 }, "maxAge"],
      ["최소 나이가 최대 나이보다 많음", { minAge: 40, maxAge: 30 }, "maxAge"],
      ["위도만 있음", { lat: 36.3 }, "lat"],
      ["경도 범위 밖", { lat: 36.3, lng: 181 }, "lng"],
      ["태그 9개", { tags: Array.from({ length: 9 }, (_, i) => `태그${i}`) }, "tags"],
      ["태그 16자", { tags: ["가".repeat(16)] }, "tags.0"],
      ["빈 태그", { tags: ["#"] }, "tags.0"],
      ["모르는 결제 방식", { paymentPolicy: "CRYPTO" }, "paymentPolicy"],
      ["예약금 결제인데 예약금 없음", { paymentPolicy: "DEPOSIT" }, "depositAmount"],
      ["예약금 0원", { paymentPolicy: "DEPOSIT", depositAmount: 0 }, "depositAmount"],
      ["예약금이 가격보다 큼", { paymentPolicy: "DEPOSIT", depositAmount: 30_001 }, "depositAmount"],
      ["한 번에 0명", { maxPerBooking: 0 }, "maxPerBooking"],
      ["한 번에 9명", { maxPerBooking: 9 }, "maxPerBooking"],
      ["재판매 연동 환불율 49%", { resaleRefundRate: 49 }, "resaleRefundRate"],
      ["재판매 연동 환불율 101%", { resaleRefundRate: 101 }, "resaleRefundRate"],
      ["현장 결제 상품의 재판매 연동 환불", { paymentPolicy: "ONSITE", resaleRefundRate: 80 }, "resaleRefundRate"],
      ["승인제 여부가 문자열", { requiresApproval: "yes" }, "requiresApproval"],
      ["본인인증 여부가 숫자", { requiresIdentity: 1 }, "requiresIdentity"],
      ["모르는 환불 프리셋", { cancellationTiers: "GENEROUS" }, "cancellationTiers"],
      ["환불 구간 0개", { cancellationTiers: [] }, "cancellationTiers"],
      ["환불 구간 6개", { cancellationTiers: tiers([120, 100], [96, 80], [72, 60], [48, 40], [24, 20], [0, 0]) }, "cancellationTiers"],
      ["기준 시간 721시간", { cancellationTiers: tiers([721, 100], [0, 0]) }, "cancellationTiers.0.hoursBefore"],
      ["기준 시간 음수", { cancellationTiers: tiers([24, 100], [-1, 0]) }, "cancellationTiers.1.hoursBefore"],
      ["기준 시간 중복", { cancellationTiers: tiers([24, 100], [24, 50], [0, 0]) }, "cancellationTiers"],
      ["마지막 구간이 0시간이 아님", { cancellationTiers: tiers([48, 100], [24, 50]) }, "cancellationTiers"],
      ["가까워질수록 환불율이 올라감", { cancellationTiers: tiers([48, 50], [24, 80], [0, 0]) }, "cancellationTiers"],
      ["환불율 101%", { cancellationTiers: tiers([24, 101], [0, 0]) }, "cancellationTiers.0.refundRate"],
      ["환불율 음수", { cancellationTiers: tiers([24, 100], [0, -1]) }, "cancellationTiers.1.refundRate"],
      ["좌석 구성 없음", { seatTemplates: undefined }, "seatTemplates"],
      ["좌석 구성 0개", { seatTemplates: [] }, "seatTemplates"],
      ["좌석 구성 7개", { seatTemplates: Array.from({ length: 7 }, (_, i) => seat({ label: `좌석${i}` })) }, "seatTemplates"],
      ["좌석 이름 없음", { seatTemplates: [seat({ label: " " })] }, "seatTemplates.0.label"],
      ["좌석 이름 13자", { seatTemplates: [seat({ label: "가".repeat(13) })] }, "seatTemplates.0.label"],
      ["좌석 이름 중복", { seatTemplates: [seat(), seat()] }, "seatTemplates.1.label"],
      ["모르는 성별 구분", { seatTemplates: [seat({ gender: "OTHER" })] }, "seatTemplates.0.gender"],
      ["정원 0명", { seatTemplates: [seat({ capacity: 0 })] }, "seatTemplates.0.capacity"],
      ["정원 501명", { seatTemplates: [seat({ capacity: 501 })] }, "seatTemplates.0.capacity"],
      ["좌석 가격 음수", { seatTemplates: [seat({ price: -1 })] }, "seatTemplates.0.price"],
      ["좌석 가격 1,000만원 초과", { seatTemplates: [seat({ price: 10_000_001 })] }, "seatTemplates.0.price"],
      ["최소 인원이 정원보다 많음", { seatTemplates: [seat({ capacity: 4, minCount: 5 })] }, "seatTemplates.0.minCount"],
      ["최소 인원 음수", { seatTemplates: [seat({ minCount: -1 })] }, "seatTemplates.0.minCount"],
      ["분류 없음", { categoryId: undefined }, "categoryId"],
      ["없는 분류", { categoryId: "no-such-category" }, "categoryId"],
      ["없는 지역", { areaId: "no-such-area" }, "areaId"],
    ];

    it.each(cases)("%s → VALIDATION", async (_name, overrides, field) => {
      const { business, owner, category } = await setup();

      const error = await failure(createProduct(owner.id, business.id, { ...validInput(category.id), ...overrides } as ProductInput));

      expect(error.code).toBe("VALIDATION");
      expect(error.fieldErrors).toHaveProperty([field]);
      expect(error.fieldErrors![field]!.length).toBeGreaterThan(0);
      expect(await prisma.product.count()).toBe(0);
    });

    it("경계값은 통과한다", async () => {
      const { business, owner, category } = await setup();
      const product = await createProduct(
        owner.id,
        business.id,
        validInput(category.id, {
          title: "가".repeat(60),
          summary: "가".repeat(120),
          description: "가".repeat(5000),
          includes: "가".repeat(1000),
          notice: "가".repeat(1000),
          images: Array.from({ length: 8 }, (_, i) => image(i)),
          durationMin: 1440,
          basePrice: 10_000_000,
          minAge: 14,
          maxAge: 99,
          tags: Array.from({ length: 8 }, (_, i) => `${"가".repeat(14)}${i}`),
          paymentPolicy: "DEPOSIT",
          depositAmount: 10_000_000,
          maxPerBooking: 8,
          resaleRefundRate: 50,
          cancellationTiers: [
            { hoursBefore: 720, refundRate: 100 },
            { hoursBefore: 72, refundRate: 100 },
            { hoursBefore: 24, refundRate: 50 },
            { hoursBefore: 1, refundRate: 50 },
            { hoursBefore: 0, refundRate: 0 },
          ],
          seatTemplates: Array.from({ length: 6 }, (_, i) => ({ label: `${"가".repeat(11)}${i}`, capacity: 500, price: 10_000_000, minCount: 500 })),
        }),
      );
      expect(product.seatTemplates).toHaveLength(6);
      expect(product.cancellationTiers).toHaveLength(5);

      const minimal = await createProduct(
        owner.id,
        business.id,
        validInput(category.id, {
          title: "가나",
          durationMin: 10,
          basePrice: 0,
          maxPerBooking: 1,
          resaleRefundRate: 100,
          minAge: 30,
          maxAge: 30,
          cancellationTiers: [{ hoursBefore: 0, refundRate: 0 }],
          seatTemplates: [{ label: "가", capacity: 1, price: 0 }],
        }),
      );
      expect(minimal).toMatchObject({ basePrice: 0, durationMin: 10, maxPerBooking: 1 });
    });

    it("꺼 둔 분류·지역은 고를 수 없다", async () => {
      const { business, owner, category } = await setup();
      const hiddenCategory = await createCategory({ isActive: false });
      const hiddenArea = await createArea({ isActive: false });

      expect((await failure(createProduct(owner.id, business.id, validInput(hiddenCategory.id)))).fieldErrors).toHaveProperty("categoryId");
      expect((await failure(createProduct(owner.id, business.id, validInput(category.id, { areaId: hiddenArea.id })))).fieldErrors).toHaveProperty("areaId");
    });
  });

  describe("금칙 표현", () => {
    const fields: [string, (phrase: string) => Partial<ProductInput>][] = [
      ["title", (p) => ({ title: `주말 ${p} 모임` })],
      ["summary", (p) => ({ summary: `오늘만 ${p}` })],
      ["description", (p) => ({ description: `첫 줄\n${p} 안내` })],
      ["includes", (p) => ({ includes: `${p}` })],
      ["notice", (p) => ({ notice: `참고: ${p}` })],
      ["tags", (p) => ({ tags: ["와인", p.slice(0, 15)] })],
    ];

    it.each(fields)("%s 에 금칙 표현이 있으면 그 항목에 사유를 알려 준다", async (field, build) => {
      const { business, owner, category } = await setup();
      const banned = BANNED_PHRASES[0]!;

      const error = await failure(createProduct(owner.id, business.id, validInput(category.id, build(banned.phrase))));

      expect(error.code).toBe("VALIDATION");
      expect(Object.keys(error.fieldErrors ?? {})).toEqual([field]);
      expect(error.fieldErrors![field]).toContain(banned.reason);
      expect(error.fieldErrors![field]).toContain(banned.phrase);
      expect(await prisma.product.count()).toBe(0);
    });

    it("목록에 있는 표현은 모두 막는다(대소문자·띄어쓰기 차이 포함)", async () => {
      const { business, owner, category } = await setup();
      for (const { phrase, reason } of BANNED_PHRASES) {
        const error = await failure(createProduct(owner.id, business.id, validInput(category.id, { description: `안내 ${phrase.replace(" ", "   ")} 드려요` })));
        expect(error.fieldErrors?.description).toContain(reason);
      }
      // 여러 항목에 있으면 항목마다 알려 준다.
      const both = await failure(
        createProduct(owner.id, business.id, validInput(category.id, { title: `${BANNED_PHRASES[0]!.phrase} 모임`, notice: BANNED_PHRASES[0]!.phrase })),
      );
      expect(Object.keys(both.fieldErrors ?? {}).sort()).toEqual(["notice", "title"]);
    });
  });

  it("매니저 이상만 등록할 수 있고, 다른 사업장에는 등록할 수 없다", async () => {
    const { business, category } = await setup();
    const outsider = await setup();
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");
    const stranger = await createUser();

    expect((await failure(createProduct(staff.id, business.id, validInput(category.id)))).code).toBe("FORBIDDEN");
    expect((await failure(createProduct(outsider.owner.id, business.id, validInput(category.id)))).code).toBe("FORBIDDEN");
    expect((await failure(createProduct(stranger.id, business.id, validInput(category.id)))).code).toBe("FORBIDDEN");
    expect(await prisma.product.count()).toBe(0);

    expect((await createProduct(manager.id, business.id, validInput(category.id))).status).toBe("DRAFT");
  });
});

// ───────────────────────── 수정 ─────────────────────────

describe("updateProduct", () => {
  it("넘긴 항목만 바꾸고, null 은 선택 항목을 비운다", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(owner.id, business.id, validInput(category.id, { summary: "원래 소개", tags: ["와인"], minAge: 20, maxAge: 39 }));

    const updated = await updateProduct(owner.id, created.id, { title: "토요 와인 소셜", basePrice: 33_000, summary: null, maxAge: null });

    expect(updated).toMatchObject({ id: created.id, title: "토요 와인 소셜", basePrice: 33_000, summary: null, minAge: 20, maxAge: null, tags: ["와인"], status: "DRAFT" });
    expect(updated.seatTemplates).toEqual(created.seatTemplates);
    const [log] = await audits("product.update");
    expect(log).toMatchObject({ actorId: owner.id, targetId: created.id });
    expect((log!.meta as { fields: string[] }).fields.sort()).toEqual(["basePrice", "maxAge", "summary", "title"]);

    // 빈 요청은 그대로 돌려주고 로그도 남기지 않는다.
    expect(await updateProduct(owner.id, created.id, {})).toMatchObject({ title: "토요 와인 소셜" });
    expect(await audits("product.update")).toHaveLength(1);
  });

  it("바꾼 뒤의 상품 전체가 규칙을 지켜야 한다", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(
      owner.id,
      business.id,
      validInput(category.id, { paymentPolicy: "DEPOSIT", depositAmount: 20_000, minAge: 25, maxAge: 35, resaleRefundRate: 80 }),
    );

    // 가격만 낮췄는데 저장된 예약금보다 작아지는 경우
    expect((await failure(updateProduct(owner.id, created.id, { basePrice: 10_000 }))).fieldErrors).toHaveProperty("depositAmount");
    // 최소 나이만 올렸는데 저장된 최대 나이를 넘는 경우
    expect((await failure(updateProduct(owner.id, created.id, { minAge: 40 }))).fieldErrors).toHaveProperty("maxAge");
    // 현장 결제로 바꾸면서 재판매 연동 환불을 켜 달라고 한 경우
    expect((await failure(updateProduct(owner.id, created.id, { paymentPolicy: "ONSITE", resaleRefundRate: 70 }))).fieldErrors).toHaveProperty("resaleRefundRate");
    expect((await failure(updateProduct(owner.id, created.id, { title: `${BANNED_PHRASES[0]!.phrase} 특가` }))).fieldErrors).toHaveProperty("title");
    expect((await failure(updateProduct(owner.id, created.id, { seatTemplates: [] }))).fieldErrors).toHaveProperty("seatTemplates");
    expect((await failure(updateProduct(owner.id, created.id, { maxPerBooking: 9 }))).fieldErrors).toHaveProperty("maxPerBooking");

    expect(await getProductForSeller(owner.id, created.id)).toMatchObject({ basePrice: 30_000, minAge: 25, paymentPolicy: "DEPOSIT", depositAmount: 20_000, resaleRefundRate: 80 });

    // 함께 바꾸면 통과한다.
    expect(await updateProduct(owner.id, created.id, { basePrice: 10_000, depositAmount: 3_000 })).toMatchObject({ basePrice: 10_000, depositAmount: 3_000 });
  });

  it("결제 방식을 바꾸면 쓸 수 없게 된 예약금·재판매 연동 환불 설정을 함께 정리한다", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(owner.id, business.id, validInput(category.id, { paymentPolicy: "DEPOSIT", depositAmount: 10_000, resaleRefundRate: 90 }));

    const prepay = await updateProduct(owner.id, created.id, { paymentPolicy: "PREPAY" });
    expect(prepay).toMatchObject({ paymentPolicy: "PREPAY", depositAmount: null, resaleRefundRate: 90 });

    const onsite = await updateProduct(owner.id, created.id, { paymentPolicy: "ONSITE" });
    expect(onsite).toMatchObject({ paymentPolicy: "ONSITE", depositAmount: null, resaleRefundRate: null });

    // 예약금 결제로 되돌리려면 예약금을 다시 넣어야 한다.
    expect((await failure(updateProduct(owner.id, created.id, { paymentPolicy: "DEPOSIT" }))).fieldErrors).toHaveProperty("depositAmount");
  });

  it("이미 저장돼 있던 사진은 다시 보낼 수 있지만, 새 사진은 남는자리에 올린 파일이어야 한다", async () => {
    const { business, owner, category } = await setup();
    const legacy = "https://legacy.example/old.jpg";
    const row = await insertProduct(business.id, category.id, { status: "DRAFT", images: [legacy] });

    const kept = await updateProduct(owner.id, row.id, { images: [legacy, image(1)] });
    expect(kept.images).toEqual([legacy, image(1)]);
    expect((await failure(updateProduct(owner.id, row.id, { images: [legacy, "https://other.example/new.jpg"] }))).fieldErrors).toHaveProperty(["images.1"]);

    // 뺀 사진은 다시 넣을 수 없다.
    await updateProduct(owner.id, row.id, { images: [image(1)] });
    expect((await failure(updateProduct(owner.id, row.id, { images: [legacy] }))).fieldErrors).toHaveProperty(["images.0"]);
  });

  it("분류·지역은 바꿀 때만 다시 확인한다", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(owner.id, business.id, validInput(category.id));
    const next = await createCategory();
    const hidden = await createCategory({ isActive: false });

    expect((await failure(updateProduct(owner.id, created.id, { categoryId: hidden.id }))).fieldErrors).toHaveProperty("categoryId");
    expect((await updateProduct(owner.id, created.id, { categoryId: next.id })).category.id).toBe(next.id);

    // 쓰던 분류가 나중에 꺼져도 다른 항목은 고칠 수 있다.
    await prisma.category.update({ where: { id: next.id }, data: { isActive: false } });
    expect((await updateProduct(owner.id, created.id, { notice: "주차 불가" })).notice).toBe("주차 불가");
  });

  it("보관된 상품은 고칠 수 없다", async () => {
    const { business, owner, category } = await setup();
    const row = await insertProduct(business.id, category.id, { status: "ARCHIVED" });
    expect((await failure(updateProduct(owner.id, row.id, { title: "새 이름" }))).code).toBe("CONFLICT");
  });

  it("동시에 서로 다른 항목을 고쳐도 서로의 변경을 덮어쓰지 않는다", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(owner.id, business.id, validInput(category.id));

    await Promise.all([
      updateProduct(owner.id, created.id, { title: "동시 수정 제목" }),
      updateProduct(owner.id, created.id, { summary: "동시 수정 소개" }),
      updateProduct(owner.id, created.id, { notice: "동시 수정 유의 사항" }),
      updateProduct(owner.id, created.id, { durationMin: 95 }),
      updateProduct(owner.id, created.id, { maxPerBooking: 6 }),
      updateProduct(owner.id, created.id, { tags: ["동시"] }),
      updateProduct(owner.id, created.id, { minAge: 21 }),
      updateProduct(owner.id, created.id, { requiresApproval: true }),
    ]);

    expect(await getProductForSeller(owner.id, created.id)).toMatchObject({
      title: "동시 수정 제목",
      summary: "동시 수정 소개",
      notice: "동시 수정 유의 사항",
      durationMin: 95,
      maxPerBooking: 6,
      tags: ["동시"],
      minAge: 21,
      requiresApproval: true,
    });
  });

  it("따로는 괜찮지만 함께 저장되면 규칙이 깨지는 동시 수정은 하나만 통과한다", async () => {
    const { business, owner, category } = await setup();

    for (let round = 0; round < 5; round++) {
      const created = await createProduct(owner.id, business.id, validInput(category.id, { paymentPolicy: "DEPOSIT", depositAmount: 10_000 }));

      // 가격을 15,000원으로 낮추는 요청과 예약금을 20,000원으로 올리는 요청
      const results = await Promise.allSettled([
        updateProduct(owner.id, created.id, { basePrice: 15_000 }),
        updateProduct(owner.id, created.id, { depositAmount: 20_000 }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "VALIDATION", fieldErrors: { depositAmount: expect.any(String) } });
      }
      const after = await getProductForSeller(owner.id, created.id);
      expect(after.depositAmount).toBeLessThanOrEqual(after.basePrice);
    }
  });

  it("이미 만든 회차의 좌석은 바뀌지 않는다", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(owner.id, business.id, validInput(category.id));
    const slot = await createSlot({ id: created.id, businessId: business.id }, [{ label: "남성", capacity: 4, price: 35_000 }]);

    await updateProduct(owner.id, created.id, { seatTemplates: [{ label: "일반", capacity: 10, price: 10_000 }] });

    expect(await prisma.slotSeat.findMany({ where: { slotId: slot.id } })).toMatchObject([{ label: "남성", capacity: 4, price: 35_000 }]);
  });

  it("권한: 스태프·다른 사업장은 고칠 수 없고, 없는 상품은 NOT_FOUND", async () => {
    const { business, owner, category } = await setup();
    const outsider = await setup();
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");
    const created = await createProduct(owner.id, business.id, validInput(category.id));

    expect((await failure(updateProduct(staff.id, created.id, { title: "스태프 수정" }))).code).toBe("FORBIDDEN");
    expect((await failure(updateProduct(outsider.owner.id, created.id, { title: "남의 수정" }))).code).toBe("FORBIDDEN");
    expect((await failure(updateProduct(owner.id, "no-such-product", { title: "없는 상품" }))).code).toBe("NOT_FOUND");
    expect((await getProductForSeller(owner.id, created.id)).title).toBe("금요 와인 소셜");

    expect((await updateProduct(manager.id, created.id, { title: "매니저 수정" })).title).toBe("매니저 수정");
  });
});

// ───────────────────────── 상태 변경 ─────────────────────────

describe("setProductStatus", () => {
  it("임시저장 → 판매 중 → 판매 중지 → 판매 중 → 보관 → 임시저장", async () => {
    const { business, owner, category } = await setup();
    const created = await createProduct(owner.id, business.id, validInput(category.id));

    expect((await setProductStatus(owner.id, created.id, "ACTIVE")).status).toBe("ACTIVE");
    expect((await setProductStatus(owner.id, created.id, "PAUSED")).status).toBe("PAUSED");
    expect((await setProductStatus(owner.id, created.id, "ACTIVE")).status).toBe("ACTIVE");
    expect((await setProductStatus(owner.id, created.id, "ARCHIVED")).status).toBe("ARCHIVED");
    expect((await setProductStatus(owner.id, created.id, "DRAFT")).status).toBe("DRAFT");

    const logs = await audits("product.status_change");
    expect(logs.map((l) => l.meta)).toEqual([
      { from: "DRAFT", to: "ACTIVE" },
      { from: "ACTIVE", to: "PAUSED" },
      { from: "PAUSED", to: "ACTIVE" },
      { from: "ACTIVE", to: "ARCHIVED" },
      { from: "ARCHIVED", to: "DRAFT" },
    ]);

    // 같은 상태로 바꾸는 요청은 그대로 통과하고 로그를 남기지 않는다.
    expect((await setProductStatus(owner.id, created.id, "DRAFT")).status).toBe("DRAFT");
    expect(await audits("product.status_change")).toHaveLength(5);
  });

  it.each<[string, string]>([
    ["DRAFT", "PAUSED"],
    ["ACTIVE", "DRAFT"],
    ["PAUSED", "DRAFT"],
    ["ARCHIVED", "ACTIVE"],
    ["ARCHIVED", "PAUSED"],
  ])("허용하지 않는 전이 %s → %s 는 CONFLICT", async (from, to) => {
    const { business, owner, category } = await setup();
    const row = await insertProduct(business.id, category.id, { status: from as "DRAFT" });

    const error = await failure(setProductStatus(owner.id, row.id, to as "DRAFT"));

    expect(error.code).toBe("CONFLICT");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(from);
  });

  it("모르는 상태 값은 VALIDATION", async () => {
    const { business, owner, category } = await setup();
    const row = await insertProduct(business.id, category.id, { status: "DRAFT" });
    expect((await failure(setProductStatus(owner.id, row.id, "DELETED" as never))).code).toBe("VALIDATION");
  });

  describe("판매 시작 조건", () => {
    it.each<[keyof typeof SELLER_INFO, string]>([
      ["representativeName", "대표자 이름"],
      ["businessRegNo", "사업자등록번호"],
      ["phone", "대표 전화번호"],
      ["address", "사업장 주소"],
    ])("판매자 정보 %s 가 비어 있으면 무엇이 빠졌는지 알려 준다", async (field, label) => {
      const { business, owner, category } = await setup({ [field]: null });
      const created = await createProduct(owner.id, business.id, validInput(category.id));

      const error = await failure(setProductStatus(owner.id, created.id, "ACTIVE"));

      expect(error.code).toBe("VALIDATION");
      expect(error.message).toContain(label);
      for (const [other, otherLabel] of [
        ["representativeName", "대표자 이름"],
        ["businessRegNo", "사업자등록번호"],
        ["phone", "대표 전화번호"],
        ["address", "사업장 주소"],
      ]) {
        if (other !== field) expect(error.message).not.toContain(otherLabel);
      }
      expect((await getProductForSeller(owner.id, created.id)).status).toBe("DRAFT");

      // 채우고 나면 판매를 시작할 수 있다.
      await prisma.business.update({ where: { id: business.id }, data: { [field]: SELLER_INFO[field] } });
      expect((await setProductStatus(owner.id, created.id, "ACTIVE")).status).toBe("ACTIVE");
    });

    it("여러 항목이 비어 있으면 모두 알려 주고, 공백만 있는 값도 빈 것으로 본다", async () => {
      const { business, owner, category } = await setup({ representativeName: "  ", address: null });
      const created = await createProduct(owner.id, business.id, validInput(category.id));
      const error = await failure(setProductStatus(owner.id, created.id, "ACTIVE"));
      expect(error.message).toContain("대표자 이름");
      expect(error.message).toContain("사업장 주소");
    });

    it("좌석 구성이 없거나 금칙 표현이 든 상품(예전 데이터)은 판매를 시작할 수 없다", async () => {
      const { business, owner, category } = await setup();
      const noSeats = await insertProduct(business.id, category.id, { status: "DRAFT", seatTemplates: [] });
      const banned = await insertProduct(business.id, category.id, { status: "PAUSED", title: `주말 ${BANNED_PHRASES[0]!.phrase}` });
      const shortTitle = await insertProduct(business.id, category.id, { status: "DRAFT", title: " " });

      expect((await failure(setProductStatus(owner.id, noSeats.id, "ACTIVE"))).fieldErrors).toHaveProperty("seatTemplates");
      const error = await failure(setProductStatus(owner.id, banned.id, "ACTIVE"));
      expect(error.code).toBe("VALIDATION");
      expect(error.fieldErrors?.title).toContain(BANNED_PHRASES[0]!.reason);
      expect((await failure(setProductStatus(owner.id, shortTitle.id, "ACTIVE"))).fieldErrors).toHaveProperty("title");
    });

    it("무료 상품(가격 0원)도 판매할 수 있다", async () => {
      const { business, owner, category } = await setup();
      const free = await createProduct(owner.id, business.id, validInput(category.id, { basePrice: 0, seatTemplates: [{ label: "일반", capacity: 4, price: 0 }] }));
      expect((await setProductStatus(owner.id, free.id, "ACTIVE")).status).toBe("ACTIVE");
    });
  });

  describe("플랜별 판매 중 상품 수", () => {
    async function fillActive(businessId: string, categoryId: string, count: number) {
      await prisma.product.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          businessId,
          categoryId,
          title: `판매 중 ${i}`,
          basePrice: 10_000,
          status: "ACTIVE" as const,
          cancellationTiers: [...CANCELLATION_PRESETS.STANDARD.tiers],
          seatTemplates: [{ label: "일반", gender: "ANY", capacity: 4, price: 10_000 }],
        })),
      });
    }

    it("한도에 이르면 더 시작할 수 없고, 하나를 중지하면 다시 시작할 수 있다", async () => {
      const limit = PLAN_FEATURES.FREE.maxActiveProducts;
      const { business, owner, category } = await setup({ plan: "FREE" });
      await fillActive(business.id, category.id, limit);
      const draft = await createProduct(owner.id, business.id, validInput(category.id));

      const error = await failure(setProductStatus(owner.id, draft.id, "ACTIVE"));
      expect(error.code).toBe("CONFLICT");
      expect(error.message).toContain(PLAN_FEATURES.FREE.label);
      expect(error.message).toContain(String(limit));
      expect((await getProductForSeller(owner.id, draft.id)).status).toBe("DRAFT");

      const one = await prisma.product.findFirstOrThrow({ where: { businessId: business.id, status: "ACTIVE" } });
      await setProductStatus(owner.id, one.id, "PAUSED");
      expect((await setProductStatus(owner.id, draft.id, "ACTIVE")).status).toBe("ACTIVE");
      expect(await prisma.product.count({ where: { businessId: business.id, status: "ACTIVE" } })).toBe(limit);
    });

    it("플랜마다 자기 한도를 따른다", async () => {
      const freeLimit = PLAN_FEATURES.FREE.maxActiveProducts;
      const proLimit = PLAN_FEATURES.PRO.maxActiveProducts;
      expect(proLimit).toBeGreaterThan(freeLimit);
      const { business, owner, category } = await setup({ plan: "PRO" });
      await fillActive(business.id, category.id, freeLimit);
      const draft = await createProduct(owner.id, business.id, validInput(category.id));

      expect((await setProductStatus(owner.id, draft.id, "ACTIVE")).status).toBe("ACTIVE");

      await fillActive(business.id, category.id, proLimit - freeLimit - 1);
      const extra = await createProduct(owner.id, business.id, validInput(category.id));
      expect((await failure(setProductStatus(owner.id, extra.id, "ACTIVE"))).message).toContain(PLAN_FEATURES.PRO.label);
    });

    it("남은 한 자리를 두고 동시에 시작하면 하나만 성공한다", async () => {
      const limit = PLAN_FEATURES.FREE.maxActiveProducts;
      const { business, owner, category } = await setup({ plan: "FREE" });
      await fillActive(business.id, category.id, limit - 1);
      const drafts = [];
      for (let i = 0; i < 5; i++) drafts.push(await createProduct(owner.id, business.id, validInput(category.id, { title: `동시 시작 ${i}` })));

      const results = await Promise.allSettled(drafts.map((d) => setProductStatus(owner.id, d.id, "ACTIVE")));

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "CONFLICT" });
      }
      expect(await prisma.product.count({ where: { businessId: business.id, status: "ACTIVE" } })).toBe(limit);
    });

    it("다른 사업장의 상품은 세지 않는다", async () => {
      const limit = PLAN_FEATURES.FREE.maxActiveProducts;
      const other = await setup({ plan: "FREE" });
      await fillActive(other.business.id, other.category.id, limit);
      const { business, owner, category } = await setup({ plan: "FREE" });
      const draft = await createProduct(owner.id, business.id, validInput(category.id));
      expect((await setProductStatus(owner.id, draft.id, "ACTIVE")).status).toBe("ACTIVE");
    });
  });

  describe("보관", () => {
    async function withBooking(status: BookingStatus, slotOptions: Parameters<typeof createSlot>[2] = {}) {
      const { business, owner, category } = await setup();
      const product = await insertProduct(business.id, category.id, { status: "ACTIVE" });
      const slot = await createSlot(product, [{ capacity: 4 }], slotOptions);
      await prisma.booking.create({
        data: {
          code: newBookingCode(),
          businessId: business.id,
          productId: product.id,
          slotId: slot.id,
          slotSeatId: slot.seats[0]!.id,
          quantity: 1,
          unitPrice: 30_000,
          totalAmount: 30_000,
          payNowAmount: 30_000,
          status,
          paymentMethod: "ONLINE",
          guestName: "김손님",
          guestPhone: "01012345678",
          policySnapshot: [],
          checkinToken: newToken(),
        },
      });
      return { owner, product, slot };
    }

    it.each<BookingStatus>(["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"])("앞으로 열릴 회차에 %s 예약이 있으면 보관할 수 없다", async (status) => {
      const { owner, product } = await withBooking(status);

      const error = await failure(setProductStatus(owner.id, product.id, "ARCHIVED"));

      expect(error.code).toBe("CONFLICT");
      expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ACTIVE");
      // 판매 중지는 할 수 있다.
      expect((await setProductStatus(owner.id, product.id, "PAUSED")).status).toBe("PAUSED");
      expect((await failure(setProductStatus(owner.id, product.id, "ARCHIVED"))).code).toBe("CONFLICT");
    });

    it("판매를 마감한 회차라도 확정 예약이 남아 있으면 보관할 수 없다", async () => {
      const { owner, product } = await withBooking("CONFIRMED", { status: "CLOSED" });
      expect((await failure(setProductStatus(owner.id, product.id, "ARCHIVED"))).code).toBe("CONFLICT");
    });

    it.each<[string, BookingStatus, Parameters<typeof createSlot>[2]]>([
      ["취소된 예약만 있음", "CANCELLED", {}],
      ["만료된 예약만 있음", "EXPIRED", {}],
      ["이미 끝난 회차의 이용 완료 예약", "COMPLETED", { startsInHours: -48 }],
      ["지난 회차에 남은 확정 예약", "CONFIRMED", { startsInHours: -3 }],
      ["취소된 회차", "CONFIRMED", { status: "CANCELLED" }],
    ])("%s → 보관할 수 있다", async (_name, status, slotOptions) => {
      const { owner, product } = await withBooking(status, slotOptions);
      expect((await setProductStatus(owner.id, product.id, "ARCHIVED")).status).toBe("ARCHIVED");
    });

    it("예약이 없는 회차만 있으면 보관할 수 있다", async () => {
      const { business, owner, category } = await setup();
      const product = await insertProduct(business.id, category.id, { status: "ACTIVE" });
      await createSlot(product, [{ capacity: 4 }]);
      expect((await setProductStatus(owner.id, product.id, "ARCHIVED")).status).toBe("ARCHIVED");
    });
  });

  it("권한: 스태프·다른 사업장은 상태를 바꿀 수 없다", async () => {
    const { business, owner, category } = await setup();
    const outsider = await setup();
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");
    const created = await createProduct(owner.id, business.id, validInput(category.id));

    expect((await failure(setProductStatus(staff.id, created.id, "ACTIVE"))).code).toBe("FORBIDDEN");
    expect((await failure(setProductStatus(outsider.owner.id, created.id, "ACTIVE"))).code).toBe("FORBIDDEN");
    expect((await failure(setProductStatus(owner.id, "no-such-product", "ACTIVE"))).code).toBe("NOT_FOUND");
    expect((await getProductForSeller(owner.id, created.id)).status).toBe("DRAFT");

    expect((await setProductStatus(manager.id, created.id, "ACTIVE")).status).toBe("ACTIVE");
  });
});

// ───────────────────────── 복제 · 조회 ─────────────────────────

describe("duplicateProduct", () => {
  it("내용을 옮긴 임시저장 상품을 만든다(집계·회차는 옮기지 않는다)", async () => {
    const { business, owner, category } = await setup();
    const source = await createProduct(
      owner.id,
      business.id,
      validInput(category.id, { images: [image(1)], tags: ["와인"], paymentPolicy: "DEPOSIT", depositAmount: 5_000, resaleRefundRate: 80, cancellationTiers: "STRICT" }),
    );
    await setProductStatus(owner.id, source.id, "ACTIVE");
    await prisma.product.update({ where: { id: source.id }, data: { ratingAvg: 4.8, ratingCount: 12, favoriteCount: 30, viewCount: 900 } });
    await createSlot({ id: source.id, businessId: business.id });

    const copy = await duplicateProduct(owner.id, source.id);

    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      businessId: business.id,
      status: "DRAFT",
      title: "금요 와인 소셜 (복사본)",
      images: [image(1)],
      tags: ["와인"],
      paymentPolicy: "DEPOSIT",
      depositAmount: 5_000,
      resaleRefundRate: 80,
      cancellationPreset: "STRICT",
      seatTemplates: source.seatTemplates,
      ratingAvg: 0,
      ratingCount: 0,
      favoriteCount: 0,
      viewCount: 0,
      upcomingSlotCount: 0,
    });
    expect((await getProductForSeller(owner.id, source.id)).status).toBe("ACTIVE");
    expect((await audits("product.duplicate"))[0]).toMatchObject({ targetId: copy.id, meta: { sourceId: source.id } });
  });

  it("긴 이름은 60자 안에서 잘라 붙인다", async () => {
    const { business, owner, category } = await setup();
    const source = await createProduct(owner.id, business.id, validInput(category.id, { title: "가".repeat(60) }));
    const copy = await duplicateProduct(owner.id, source.id);
    expect(copy.title).toHaveLength(60);
    expect(copy.title.endsWith("(복사본)")).toBe(true);
  });

  it("권한: 매니저 이상, 자기 사업장 상품만", async () => {
    const { business, owner, category } = await setup();
    const outsider = await setup();
    const staff = await addMember(business.id, "STAFF");
    const source = await createProduct(owner.id, business.id, validInput(category.id));

    expect((await failure(duplicateProduct(staff.id, source.id))).code).toBe("FORBIDDEN");
    expect((await failure(duplicateProduct(outsider.owner.id, source.id))).code).toBe("FORBIDDEN");
    expect(await prisma.product.count()).toBe(1);
  });
});

describe("getProductForSeller · listProductsForSeller", () => {
  it("앞으로 열릴 회차 수와 가장 가까운 회차를 함께 준다", async () => {
    const { business, owner, category } = await setup();
    const withSlots = await insertProduct(business.id, category.id, { title: "회차 있는 상품", images: [image(1), image(2)] });
    const empty = await insertProduct(business.id, category.id, {
      title: "회차 없는 상품",
      status: "DRAFT",
      seatTemplates: [
        { label: "남성", gender: "MALE", capacity: 4, price: 30_000 },
        { label: "여성", gender: "FEMALE", capacity: 6, price: 30_000 },
      ],
    });
    const soon = await createSlot(withSlots, [{ capacity: 4 }], { startsInHours: 5 });
    await createSlot(withSlots, [{ capacity: 4 }], { startsInHours: 30, status: "CLOSED" });
    await createSlot(withSlots, [{ capacity: 4 }], { startsInHours: 2, status: "CANCELLED" });
    await createSlot(withSlots, [{ capacity: 4 }], { startsInHours: -5 });

    const detail = await getProductForSeller(owner.id, withSlots.id);
    expect(detail).toMatchObject({ upcomingSlotCount: 2, nextSlotAt: soon.startAt });

    const list = await listProductsForSeller(owner.id, business.id);
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.id === withSlots.id)).toMatchObject({
      title: "회차 있는 상품",
      status: "ACTIVE",
      coverImage: image(1),
      categoryName: category.name,
      upcomingSlotCount: 2,
      nextSlotAt: soon.startAt,
      totalCapacity: 4,
    });
    expect(list.find((p) => p.id === empty.id)).toMatchObject({ status: "DRAFT", coverImage: null, upcomingSlotCount: 0, nextSlotAt: null, totalCapacity: 10 });
  });

  it("상태를 생략하면 보관된 상품을 빼고, 주면 그 상태만 준다(다른 사업장 상품은 섞이지 않는다)", async () => {
    const { business, owner, category } = await setup();
    const other = await setup();
    await insertProduct(business.id, category.id, { title: "판매 중", status: "ACTIVE" });
    await insertProduct(business.id, category.id, { title: "임시", status: "DRAFT" });
    await insertProduct(business.id, category.id, { title: "중지", status: "PAUSED" });
    await insertProduct(business.id, category.id, { title: "보관", status: "ARCHIVED" });
    await insertProduct(other.business.id, other.category.id, { title: "남의 상품" });

    const titles = async (status?: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED") =>
      (await listProductsForSeller(owner.id, business.id, { status })).map((p) => p.title).sort();

    expect(await titles()).toEqual(["임시", "중지", "판매 중"]);
    expect(await titles("ACTIVE")).toEqual(["판매 중"]);
    expect(await titles("ARCHIVED")).toEqual(["보관"]);
    expect((await failure(listProductsForSeller(owner.id, business.id, { status: "DELETED" as never }))).code).toBe("VALIDATION");
  });

  it("스태프도 볼 수 있지만, 다른 사업장 상품은 볼 수 없다", async () => {
    const { business, owner, category } = await setup();
    const outsider = await setup();
    const staff = await addMember(business.id, "STAFF");
    const stranger = await createUser();
    const created = await createProduct(owner.id, business.id, validInput(category.id));

    expect((await getProductForSeller(staff.id, created.id)).id).toBe(created.id);
    expect(await listProductsForSeller(staff.id, business.id)).toHaveLength(1);

    expect((await failure(getProductForSeller(outsider.owner.id, created.id))).code).toBe("FORBIDDEN");
    expect((await failure(getProductForSeller(stranger.id, created.id))).code).toBe("FORBIDDEN");
    expect((await failure(listProductsForSeller(outsider.owner.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(getProductForSeller(owner.id, "no-such-product"))).code).toBe("NOT_FOUND");
  });
});

// ───────────────────────── 실수령액 계산 ─────────────────────────

describe("estimatePayout", () => {
  const settings = DEFAULT_SETTINGS;
  const capped = (amount: number, quantity: number) =>
    settings.commissionCapPerSeat > 0 ? Math.min(amount, settings.commissionCapPerSeat * quantity) : amount;

  it("유입 경로별로 수수료와 받는 금액을 계산한다", () => {
    const result = estimatePayout({ price: 30_000, quantity: 2, plan: "FREE", settings });
    const total = 60_000;
    const newFee = capped(applyBps(total, settings.commissionNewCustomerBps), 2);
    const returningFee = capped(applyBps(total, settings.commissionReturningBps), 2);
    const directFee = capped(applyBps(total, settings.commissionDirectBps), 2);
    const pgFee = applyBps(total, settings.pgFeeBps);

    expect(result.total).toBe(total);
    expect(result.marketNew).toMatchObject({ rule: "MARKET_NEW", bps: settings.commissionNewCustomerBps, commissionAmount: newFee, pgFeeAmount: 0, payout: total - newFee });
    expect(result.marketReturning).toMatchObject({ rule: "MARKET_RETURNING", bps: settings.commissionReturningBps, commissionAmount: returningFee, pgFeeAmount: 0, payout: total - returningFee });
    expect(result.ownLink).toMatchObject({ rule: "DIRECT", bps: settings.commissionDirectBps, commissionAmount: directFee, pgFeeAmount: pgFee, payout: total - directFee - pgFee });
    expect(result.ownLink.rateText).toContain("결제 실비");
  });

  it("프로 플랜은 신규 고객 요율이 다르고, 재방문·자체 링크는 같다", () => {
    const free = estimatePayout({ price: 30_000, quantity: 1, plan: "FREE", settings });
    const pro = estimatePayout({ price: 30_000, quantity: 1, plan: "PRO", settings });
    expect(pro.marketNew.bps).toBe(settings.proCommissionNewCustomerBps);
    expect(pro.marketNew.commissionAmount).toBe(capped(applyBps(30_000, settings.proCommissionNewCustomerBps), 1));
    expect(pro.marketReturning).toEqual(free.marketReturning);
    expect(pro.ownLink).toEqual(free.ownLink);
  });

  it("좌석당 상한을 적용한다", () => {
    const withCap = { ...settings, commissionNewCustomerBps: 1000, commissionCapPerSeat: 5_000 };
    const result = estimatePayout({ price: 200_000, quantity: 3, plan: "FREE", settings: withCap });
    expect(result.marketNew.commissionAmount).toBe(15_000);
    expect(result.marketNew.payout).toBe(600_000 - 15_000);

    const noCap = estimatePayout({ price: 200_000, quantity: 3, plan: "FREE", settings: { ...withCap, commissionCapPerSeat: 0 } });
    expect(noCap.marketNew.commissionAmount).toBe(applyBps(600_000, 1000));
  });

  it("예약금·현장 결제 상품은 온라인 결제액에만 결제 실비가 붙는다", () => {
    const deposit = estimatePayout({ price: 30_000, quantity: 2, plan: "FREE", settings, onlinePerSeat: 5_000 });
    expect(deposit.ownLink.pgFeeAmount).toBe(applyBps(10_000, settings.pgFeeBps));
    const onsite = estimatePayout({ price: 30_000, quantity: 2, plan: "FREE", settings, onlinePerSeat: 0 });
    expect(onsite.ownLink.pgFeeAmount).toBe(0);
    // 온라인 결제액은 가격을 넘을 수 없다.
    const over = estimatePayout({ price: 30_000, quantity: 1, plan: "FREE", settings, onlinePerSeat: 99_000 });
    expect(over.ownLink.pgFeeAmount).toBe(applyBps(30_000, settings.pgFeeBps));
  });

  it("개별·업종 요율이 있으면 그 요율로 계산한다(재방문은 낮은 쪽)", () => {
    const uncapped = { ...settings, commissionReturningBps: 500, commissionCapPerSeat: 0 };
    const result = estimatePayout({ price: 30_000, quantity: 1, plan: "PRO", settings: uncapped, overrideBps: 800 });
    expect(result.marketNew).toMatchObject({ rule: "OVERRIDE", bps: 800, commissionAmount: applyBps(30_000, 800) });
    expect(result.marketReturning).toMatchObject({ rule: "OVERRIDE", bps: 500 });
  });

  it("무료 상품은 수수료가 없고, 범위를 벗어난 값은 VALIDATION", () => {
    const free = estimatePayout({ price: 0, quantity: 4, plan: "FREE", settings });
    expect(free).toMatchObject({ total: 0, marketNew: { commissionAmount: 0, payout: 0 }, ownLink: { pgFeeAmount: 0, payout: 0 } });

    for (const bad of [{ price: -1 }, { price: 10_000_001 }, { price: 1.5 }, { quantity: 0 }, { quantity: 501 }]) {
      expect(() => estimatePayout({ price: 30_000, quantity: 1, plan: "FREE", settings, ...bad })).toThrow(AppError);
    }
  });
});
