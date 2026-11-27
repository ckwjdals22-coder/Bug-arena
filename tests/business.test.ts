import { randomInt } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { isValidBusinessRegNo } from "@/lib/format";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { decrypt } from "@/server/security/crypto";
import {
  MAX_OWNED_BUSINESSES,
  SLUG_HOLD_DAYS,
  addMember,
  applyForBusiness,
  changeMemberRole,
  changeSlug,
  findSlugRedirect,
  getBankAccountMasked,
  getBusinessForMember,
  getPublicBusiness,
  listMembers,
  reapplyForBusiness,
  removeMember,
  revealBankAccount,
  setBankAccount,
  updateBusinessProfile,
  updateBusinessSettings,
  type BusinessApplicationInput,
} from "@/server/services/business";
import { createArea, createBusiness, createCategory, createUser, resetDb } from "./helpers";
import { PLAN_FEATURES } from "@/server/settings";

// 무작위 주소 충돌을 재현하기 위해 randomInt 만 가로챈다(평소에는 원래 구현 그대로 동작).
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});
const randomIntMock = randomInt as unknown as Mock<(max: number) => number>;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  randomIntMock.mockReset();
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

/** 앞 9자리로 검증 숫자가 맞는 사업자등록번호를 만든다. */
function regNo(base9: string): string {
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(base9[i]) * weights[i]!;
  sum += Math.floor((Number(base9[8]) * 5) / 10);
  return `${base9}${(10 - (sum % 10)) % 10}`;
}

const application = (categoryId: string, overrides: Partial<BusinessApplicationInput> = {}): BusinessApplicationInput => ({
  name: "둔산 소셜클럽",
  categoryId,
  phone: "042-123-4567",
  address: "대전 서구 둔산로 123",
  businessRegNo: regNo("123456789"),
  representativeName: "김대표",
  ...overrides,
});

const auditActions = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

async function addMemberRow(businessId: string, role: "MANAGER" | "STAFF") {
  const user = await createUser();
  const member = await prisma.businessMember.create({ data: { businessId, userId: user.id, role } });
  return { user, member };
}

const OWN_IMAGE = "/uploads/business/2026/11/AbCdEfGhIjKlMnOpQrStUvWxYz012345.webp";

describe("applyForBusiness", () => {
  it("심사 대기 사업장을 만들고 신청한 회원을 대표로 등록한다", async () => {
    const user = await createUser();
    const category = await createCategory({ slug: "meet" });
    const area = await createArea();
    const reg = regNo("123456789");
    expect(isValidBusinessRegNo(reg)).toBe(true);

    const business = await applyForBusiness(
      user.id,
      application(category.id, {
        name: "  둔산 소셜클럽 ",
        areaId: area.id,
        tagline: "금요일 저녁의 새로운 만남",
        businessRegNo: `${reg.slice(0, 3)}-${reg.slice(3, 5)}-${reg.slice(5)}`,
        instagram: "@dunsan.social",
        website: "https://dunsan.example.com",
      }),
    );

    expect(business).toMatchObject({
      name: "둔산 소셜클럽",
      status: "PENDING",
      plan: "FREE",
      role: "OWNER",
      phone: "0421234567",
      businessRegNo: reg,
      representativeName: "김대표",
      instagram: "dunsan.social",
      website: "https://dunsan.example.com/",
      bankAccount: null,
    });
    expect(business.slug).toMatch(/^meet-[a-z0-9]{8}$/);
    expect(business.category).toMatchObject({ id: category.id, slug: "meet" });
    expect(business.area).toMatchObject({ id: area.id });
    expect(business).not.toHaveProperty("bankAccountEnc");

    const members = await prisma.businessMember.findMany({ where: { businessId: business.id } });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: user.id, role: "OWNER" });
    expect(await prisma.subscription.count()).toBe(0);
    expect(await prisma.messageTemplate.count()).toBe(0);
    const [log] = await auditActions("business.apply");
    expect(log).toMatchObject({ actorId: user.id, actorType: "SELLER", targetType: "Business", targetId: business.id });
  });

  it("사업자등록번호·주소 형식·분류를 검증한다", async () => {
    const user = await createUser();
    const category = await createCategory();
    const inactiveCategory = await createCategory({ isActive: false });
    const inactiveArea = await createArea({ isActive: false });
    const valid = regNo("123456789");
    const wrongCheckDigit = `${valid.slice(0, 9)}${(Number(valid[9]) + 1) % 10}`;

    const cases: [Partial<BusinessApplicationInput>, string, RegExp][] = [
      [{ businessRegNo: wrongCheckDigit }, "businessRegNo", /사업자등록번호/],
      [{ businessRegNo: "12345" }, "businessRegNo", /사업자등록번호/],
      [{ name: "가" }, "name", /2자 이상/],
      [{ name: "가".repeat(41) }, "name", /40자/],
      [{ phone: "1234" }, "phone", /전화번호/],
      [{ address: "대전" }, "address", /주소/],
      [{ representativeName: "" }, "representativeName", /대표자/],
      [{ website: "http://dunsan.example.com" }, "website", /https:\/\//],
      [{ website: "javascript:alert(1)" }, "website", /https:\/\//],
      [{ website: "https://naver.com@evil.example" }, "website", /https:\/\//],
      [{ instagram: "https://instagram.com/dunsan" }, "instagram", /아이디만/],
      [{ categoryId: inactiveCategory.id }, "categoryId", /업종/],
      [{ categoryId: "missing" }, "categoryId", /업종/],
      [{ areaId: inactiveArea.id }, "areaId", /지역/],
    ];
    for (const [overrides, field, message] of cases) {
      const error = await failure(applyForBusiness(user.id, application(category.id, overrides)));
      expect(error.code, field).toBe("VALIDATION");
      expect(error.fieldErrors?.[field], field).toMatch(message);
    }
    expect(await prisma.business.count()).toBe(0);
  });

  it("무작위 주소가 이미 쓰이고 있으면 새로 만들어 다시 시도한다", async () => {
    const category = await createCategory({ slug: "class" });
    const [first, second] = [await createUser(), await createUser()];

    for (let i = 0; i < 8; i++) randomIntMock.mockReturnValueOnce(0);
    const a = await applyForBusiness(first.id, application(category.id));
    expect(a.slug).toBe("class-aaaaaaaa");

    // 두 번째 신청: 처음 만든 주소가 겹치고, 다시 만든 주소로 저장된다.
    for (let i = 0; i < 8; i++) randomIntMock.mockReturnValueOnce(0);
    for (let i = 0; i < 8; i++) randomIntMock.mockReturnValueOnce(1);
    const b = await applyForBusiness(second.id, application(category.id));
    expect(b.slug).toBe("class-bbbbbbbb");
    expect(randomIntMock).toHaveBeenCalledTimes(24);

    const slugs = (await prisma.business.findMany({ select: { slug: true } })).map((x) => x.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(await prisma.businessMember.count()).toBe(2);
  });

  it("여러 번 신청해도 주소가 겹치지 않는다", async () => {
    const category = await createCategory({ slug: "meet" });
    const slugs = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const user = await createUser();
      slugs.add((await applyForBusiness(user.id, application(category.id))).slug);
    }
    expect(slugs.size).toBe(6);
  });

  it("한 회원은 사업장을 3곳까지만 가질 수 있고, 같은 등록번호로 두 번 신청할 수 없다", async () => {
    const user = await createUser();
    const category = await createCategory();

    await applyForBusiness(user.id, application(category.id));
    const duplicate = await failure(applyForBusiness(user.id, application(category.id, { name: "둔산 소셜클럽 2호점" })));
    expect(duplicate.code).toBe("CONFLICT");
    expect(duplicate.message).toMatch(/같은 사업자등록번호/);

    await applyForBusiness(user.id, application(category.id, { businessRegNo: regNo("222222222") }));
    await applyForBusiness(user.id, application(category.id, { businessRegNo: regNo("333333333") }));
    expect(await prisma.businessMember.count({ where: { userId: user.id, role: "OWNER" } })).toBe(MAX_OWNED_BUSINESSES);

    const fourth = await failure(applyForBusiness(user.id, application(category.id, { businessRegNo: regNo("444444444") })));
    expect(fourth.code).toBe("CONFLICT");
    expect(fourth.message).toMatch(/3곳까지/);
    expect(await prisma.business.count()).toBe(3);

    // 다른 회원은 영향을 받지 않는다.
    const other = await createUser();
    await expect(applyForBusiness(other.id, application(category.id))).resolves.toMatchObject({ status: "PENDING" });
  });

  it("정지된 회원은 신청할 수 없다", async () => {
    const user = await createUser({ status: "SUSPENDED" });
    const category = await createCategory();
    expect((await failure(applyForBusiness(user.id, application(category.id)))).code).toBe("FORBIDDEN");
  });

  it("반려된 신청은 대표가 고쳐서 다시 낼 수 있다", async () => {
    const user = await createUser();
    const category = await createCategory();
    const applied = await applyForBusiness(user.id, application(category.id));

    // 심사 중인 신청은 다시 낼 수 없다.
    expect((await failure(reapplyForBusiness(user.id, applied.id, application(category.id)))).code).toBe("CONFLICT");

    await prisma.business.update({ where: { id: applied.id }, data: { status: "REJECTED", rejectReason: "등록번호 확인 불가" } });
    const { user: manager } = await addMemberRow(applied.id, "MANAGER");
    expect((await failure(reapplyForBusiness(manager.id, applied.id, application(category.id)))).code).toBe("FORBIDDEN");

    const again = await reapplyForBusiness(user.id, applied.id, application(category.id, { name: "둔산 소셜클럽 본점", businessRegNo: regNo("987654321") }));
    expect(again).toMatchObject({ id: applied.id, slug: applied.slug, status: "PENDING", rejectReason: null, name: "둔산 소셜클럽 본점", businessRegNo: regNo("987654321") });
    expect(await auditActions("business.reapply")).toHaveLength(1);
  });
});

describe("updateBusinessProfile", () => {
  it("매니저 이상만 바꿀 수 있고, 다른 사업장 구성원과 스태프는 거절한다", async () => {
    const { business, owner } = await createBusiness();
    const { user: manager } = await addMemberRow(business.id, "MANAGER");
    const { user: staff } = await addMemberRow(business.id, "STAFF");
    const { owner: otherOwner } = await createBusiness();
    const stranger = await createUser();

    for (const actor of [staff, otherOwner, stranger]) {
      const error = await failure(updateBusinessProfile(actor.id, business.id, { tagline: "남의 가게 소개 바꾸기" }));
      expect(error.code).toBe("FORBIDDEN");
    }
    expect((await prisma.business.findUniqueOrThrow({ where: { id: business.id } })).tagline).toBeNull();

    const byManager = await updateBusinessProfile(manager.id, business.id, { tagline: " 주말 원데이 클래스 ", description: "첫 줄\n둘째 줄" });
    expect(byManager).toMatchObject({ tagline: "주말 원데이 클래스", description: "첫 줄\n둘째 줄", role: "MANAGER" });
    const byOwner = await updateBusinessProfile(owner.id, business.id, { name: "새 이름", phone: "010-2222-3333" });
    expect(byOwner).toMatchObject({ name: "새 이름", phone: "01022223333", tagline: "주말 원데이 클래스" });

    const [log] = await auditActions("business.profile_update");
    expect(log).toMatchObject({ actorId: manager.id, targetId: business.id });
    expect(log!.meta).toEqual({ fields: ["tagline", "description"] });
  });

  it("홈페이지는 https 주소만, 인스타그램·카카오 채널은 아이디만 저장한다", async () => {
    const { business, owner } = await createBusiness();

    for (const website of ["http://shop.example.com", "ftp://shop.example.com", "javascript:alert(1)", "//shop.example.com", "https://id:pw@shop.example.com", "shop.example.com"]) {
      const error = await failure(updateBusinessProfile(owner.id, business.id, { website }));
      expect(error.fieldErrors?.website, website).toMatch(/https:\/\//);
    }
    expect((await failure(updateBusinessProfile(owner.id, business.id, { instagram: "나쁜 아이디!" }))).fieldErrors?.instagram).toMatch(/아이디만/);
    expect((await failure(updateBusinessProfile(owner.id, business.id, { kakaoChannel: "https://evil.example/_abc" }))).fieldErrors?.kakaoChannel).toMatch(/카카오톡 채널/);

    const updated = await updateBusinessProfile(owner.id, business.id, {
      website: " https://shop.example.com/about ",
      instagram: "@namneun_jari",
      kakaoChannel: "https://pf.kakao.com/_xkAbCd/chat",
    });
    expect(updated).toMatchObject({ website: "https://shop.example.com/about", instagram: "namneun_jari", kakaoChannel: "_xkAbCd" });

    // null·빈 문자열은 선택 항목을 지운다.
    const cleared = await updateBusinessProfile(owner.id, business.id, { website: null, instagram: "", kakaoChannel: null });
    expect(cleared).toMatchObject({ website: null, instagram: null, kakaoChannel: null });
  });

  it("이미지는 우리 저장소가 돌려준 주소만, 지역은 활성 지역만 받는다", async () => {
    const { business, owner } = await createBusiness();
    const area = await createArea();
    const inactiveArea = await createArea({ isActive: false });

    for (const coverImage of ["https://evil.example/cover.webp", "/uploads/../../etc/passwd", "/images/cover.webp", "data:image/png;base64,AAAA"]) {
      const error = await failure(updateBusinessProfile(owner.id, business.id, { coverImage }));
      expect(error.fieldErrors?.coverImage, coverImage).toMatch(/남는자리에 올린 파일만/);
    }
    expect((await failure(updateBusinessProfile(owner.id, business.id, { areaId: inactiveArea.id }))).fieldErrors?.areaId).toMatch(/지역/);

    const updated = await updateBusinessProfile(owner.id, business.id, { coverImage: OWN_IMAGE, logoImage: OWN_IMAGE, areaId: area.id });
    expect(updated).toMatchObject({ coverImage: OWN_IMAGE, logoImage: OWN_IMAGE, area: { id: area.id } });
    const cleared = await updateBusinessProfile(owner.id, business.id, { logoImage: null, areaId: null });
    expect(cleared).toMatchObject({ coverImage: OWN_IMAGE, logoImage: null, area: null });

    // 이미 저장돼 있던 값(시드로 넣은 정적 이미지 등)을 폼이 그대로 다시 보내는 것은 막지 않는다.
    await prisma.business.update({ where: { id: business.id }, data: { coverImage: "/demo/cover-1.jpg" } });
    const resent = await updateBusinessProfile(owner.id, business.id, { coverImage: "/demo/cover-1.jpg", tagline: "새 소개" });
    expect(resent).toMatchObject({ coverImage: "/demo/cover-1.jpg", tagline: "새 소개" });
    expect((await failure(updateBusinessProfile(owner.id, business.id, { logoImage: "/demo/cover-1.jpg" }))).fieldErrors?.logoImage).toMatch(/남는자리에 올린 파일만/);
  });

  it("판매자 신원정보(상호·대표자·연락처·주소)는 바꿀 수는 있어도 비울 수는 없다", async () => {
    const { business, owner } = await createBusiness({
      phone: "0421234567",
      address: "대전 서구 둔산로 123",
      representativeName: "김대표",
      businessRegNo: regNo("123456789"),
    });
    expect(business.status).toBe("APPROVED");

    const blanks: [Record<string, string | null>, string][] = [
      [{ name: "" }, "name"],
      [{ phone: "" }, "phone"],
      [{ phone: null }, "phone"],
      [{ address: "  " }, "address"],
      [{ address: null }, "address"],
      [{ representativeName: "" }, "representativeName"],
      [{ representativeName: null }, "representativeName"],
    ];
    for (const [patch, field] of blanks) {
      const error = await failure(updateBusinessProfile(owner.id, business.id, patch as Parameters<typeof updateBusinessProfile>[2]));
      expect(error.code, field).toBe("VALIDATION");
      expect(error.fieldErrors?.[field], field).toBeTruthy();
    }
    // 사업자등록번호는 프로필 수정으로 바꾸거나 지울 수 없다(넘겨도 무시된다).
    await updateBusinessProfile(owner.id, business.id, { businessRegNo: "", tagline: "소개" } as Parameters<typeof updateBusinessProfile>[2]);
    expect(await prisma.business.findUniqueOrThrow({ where: { id: business.id } })).toMatchObject({
      name: business.name,
      phone: "0421234567",
      address: "대전 서구 둔산로 123",
      representativeName: "김대표",
      businessRegNo: regNo("123456789"),
      tagline: "소개",
    });

    const updated = await updateBusinessProfile(owner.id, business.id, { representativeName: " 이대표 ", phone: "042-987-6543", address: "대전 유성구 대학로 99" });
    expect(updated).toMatchObject({ representativeName: "이대표", phone: "0429876543", address: "대전 유성구 대학로 99" });
    expect((await getPublicBusiness(business.slug))?.legal).toMatchObject({ representativeName: "이대표", phone: "0429876543" });
  });

  it("대표자 이름과 통신판매업 신고번호는 대표만 바꿀 수 있고, 승인된 뒤에는 신고번호를 지울 수 없다", async () => {
    const { business, owner } = await createBusiness({ status: "PENDING", representativeName: "김대표" });
    const { user: manager } = await addMemberRow(business.id, "MANAGER");

    for (const patch of [{ representativeName: "박매니저" }, { mailOrderRegNo: "2026-대전서구-0123" }]) {
      const error = await failure(updateBusinessProfile(manager.id, business.id, patch));
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/대표만/);
    }
    expect((await failure(updateBusinessProfile(owner.id, business.id, { mailOrderRegNo: "신고 예정" }))).fieldErrors?.mailOrderRegNo).toMatch(/통신판매업 신고번호/);

    // 심사 전에는 넣었다가 지울 수 있다.
    expect(await updateBusinessProfile(owner.id, business.id, { mailOrderRegNo: " 제2026-대전서구-0123호 " })).toMatchObject({ mailOrderRegNo: "제2026-대전서구-0123호" });
    expect(await updateBusinessProfile(owner.id, business.id, { mailOrderRegNo: "" })).toMatchObject({ mailOrderRegNo: null });

    await updateBusinessProfile(owner.id, business.id, { mailOrderRegNo: "2026-대전서구-0123" });
    for (const status of ["APPROVED", "SUSPENDED"] as const) {
      await prisma.business.update({ where: { id: business.id }, data: { status } });
      for (const cleared of [null, ""]) {
        const error = await failure(updateBusinessProfile(owner.id, business.id, { mailOrderRegNo: cleared, tagline: "함께 보낸 다른 항목" }));
        expect(error.code, status).toBe("VALIDATION");
        expect(error.fieldErrors?.mailOrderRegNo, status).toMatch(/지울 수 없어요/);
      }
    }
    // 거절된 요청과 함께 온 다른 항목도 반영되지 않는다.
    expect(await prisma.business.findUniqueOrThrow({ where: { id: business.id } })).toMatchObject({ mailOrderRegNo: "2026-대전서구-0123", tagline: null });

    // 새 번호로 바꾸는 것은 승인 뒤에도 된다. 번호가 없던 승인 사업장은 빈 값을 다시 보내도 된다.
    await prisma.business.update({ where: { id: business.id }, data: { status: "APPROVED" } });
    expect(await updateBusinessProfile(owner.id, business.id, { mailOrderRegNo: "2027-대전유성-0045" })).toMatchObject({ mailOrderRegNo: "2027-대전유성-0045" });
    expect((await getPublicBusiness(business.slug))?.legal.mailOrderRegNo).toBe("2027-대전유성-0045");
    const { business: noNumber, owner: noNumberOwner } = await createBusiness();
    expect(await updateBusinessProfile(noNumberOwner.id, noNumber.id, { mailOrderRegNo: null, tagline: "소개" })).toMatchObject({ mailOrderRegNo: null, tagline: "소개" });
  });
});

describe("changeSlug · updateBusinessSettings", () => {
  it("대표만 공개 주소를 바꿀 수 있고, 형식·예약어·중복을 확인한다", async () => {
    const { business, owner } = await createBusiness();
    const { user: manager } = await addMemberRow(business.id, "MANAGER");
    const { business: other } = await createBusiness({ slug: "taken-slug" });

    expect((await failure(changeSlug(manager.id, business.id, "dunsan-social"))).code).toBe("FORBIDDEN");
    for (const slug of ["ab", "-abc", "abc_def", "abc def", "abc--def", "abc-", "한글주소", "a".repeat(31)]) {
      const error = await failure(changeSlug(owner.id, business.id, slug));
      expect(error.code, slug).toBe("VALIDATION");
    }
    for (const slug of ["admin", "seller", "namneunjari", "API"]) {
      expect((await failure(changeSlug(owner.id, business.id, slug))).message, slug).toMatch(/쓸 수 없는 주소/);
    }
    const taken = await failure(changeSlug(owner.id, business.id, other.slug));
    expect(taken.code).toBe("CONFLICT");
    expect(taken.fieldErrors?.slug).toMatch(/이미 쓰이고 있는 주소/);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: business.id } })).slug).toBe(business.slug);

    await expect(changeSlug(owner.id, business.id, " Dunsan-Social ")).resolves.toEqual({ slug: "dunsan-social" });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: business.id } })).slug).toBe("dunsan-social");
    const [log] = await auditActions("business.slug_change");
    expect(log!.meta).toEqual({ from: business.slug, to: "dunsan-social" });

    // 같은 주소로 다시 저장하는 것은 변경으로 세지 않고, 하루 3번까지만 바꿀 수 있다.
    await changeSlug(owner.id, business.id, "dunsan-social");
    await changeSlug(owner.id, business.id, "dunsan-social-2");
    await changeSlug(owner.id, business.id, "dunsan-social-3");
    expect((await failure(changeSlug(owner.id, business.id, "dunsan-social-4"))).code).toBe("RATE_LIMITED");
  });

  it("바꾸기 전 주소는 30일 동안 다른 사업장이 쓸 수 없고, 원래 사업장은 되돌아갈 수 있다", async () => {
    const { business, owner } = await createBusiness({ slug: "old-home" });
    const { business: rival, owner: rivalOwner } = await createBusiness({ slug: "rival-shop" });

    await changeSlug(owner.id, business.id, "new-home");
    const hold = await prisma.rateLimit.findFirstOrThrow({ where: { key: `slug-hold:old-home:${business.id}` } });
    const days = (hold.windowStart.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(SLUG_HOLD_DAYS - 0.01);
    expect(days).toBeLessThanOrEqual(SLUG_HOLD_DAYS);

    // 다른 사업장은 방금 비워진 주소를 가져갈 수 없다(변경 횟수도 쓰지 않는다).
    const held = await failure(changeSlug(rivalOwner.id, rival.id, "old-home"));
    expect(held.code).toBe("CONFLICT");
    expect(held.fieldErrors?.slug).toMatch(/얼마 전까지 다른 사업장이 쓰던 주소/);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: rival.id } })).slug).toBe("rival-shop");
    expect(await prisma.rateLimit.count({ where: { key: `business-slug:${rival.id}` } })).toBe(0);
    // 이름이 비슷한 다른 주소는 막지 않는다.
    await expect(changeSlug(rivalOwner.id, rival.id, "old-home-2")).resolves.toEqual({ slug: "old-home-2" });

    // 예전 주소로 들어온 방문은 새 주소로 보낼 수 있다.
    expect(await findSlugRedirect("old-home")).toBe("new-home");
    expect(await findSlugRedirect("new-home")).toBeNull();
    expect(await findSlugRedirect("never-used")).toBeNull();
    expect(await findSlugRedirect("Not A Slug")).toBeNull();
    await prisma.business.update({ where: { id: business.id }, data: { status: "SUSPENDED" } });
    expect(await findSlugRedirect("old-home")).toBeNull();
    await prisma.business.update({ where: { id: business.id }, data: { status: "APPROVED" } });

    // 원래 사업장은 예전 주소로 되돌아갈 수 있고, 그러면 방금 떠난 주소가 대신 보류된다.
    await expect(changeSlug(owner.id, business.id, "old-home")).resolves.toEqual({ slug: "old-home" });
    expect(await prisma.rateLimit.count({ where: { key: `slug-hold:old-home:${business.id}` } })).toBe(0);
    expect(await prisma.rateLimit.count({ where: { key: `slug-hold:new-home:${business.id}` } })).toBe(1);
    expect(await findSlugRedirect("new-home")).toBe("old-home");

    // 보류 기간이 지나면 누구나 쓸 수 있다.
    await prisma.rateLimit.updateMany({ where: { key: `slug-hold:new-home:${business.id}` }, data: { windowStart: new Date(Date.now() - 1000) } });
    expect(await findSlugRedirect("new-home")).toBeNull();
    await expect(changeSlug(rivalOwner.id, rival.id, "new-home")).resolves.toEqual({ slug: "new-home" });
  });

  it("같은 주소를 동시에 차지하려는 변경은 하나만 성공한다", async () => {
    const shops = await Promise.all(Array.from({ length: 5 }, () => createBusiness()));
    const settled = await Promise.allSettled(shops.map(({ business, owner }) => changeSlug(owner.id, business.id, "hot-spot")));

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ code: "CONFLICT" });
    }
    const slugs = (await prisma.business.findMany({ where: { id: { in: shops.map((s) => s.business.id) } }, select: { slug: true } })).map((b) => b.slug);
    expect(slugs.filter((slug) => slug === "hot-spot")).toHaveLength(1);
    // 성공한 한 곳의 예전 주소만 보류된다.
    expect(await prisma.rateLimit.count({ where: { key: { startsWith: "slug-hold:" } } })).toBe(1);
  });

  it("주소를 비우는 변경과 그 주소를 가져가려는 변경이 겹쳐도 보류가 지켜진다", async () => {
    for (let round = 0; round < 5; round++) {
      const from = `leaving-${round}`;
      const { business, owner } = await createBusiness({ slug: from });
      const { business: taker, owner: takerOwner } = await createBusiness();
      const [leave, take] = await Promise.allSettled([
        changeSlug(owner.id, business.id, `moved-${round}`),
        changeSlug(takerOwner.id, taker.id, from),
      ]);

      expect(leave.status).toBe("fulfilled");
      // 가져가려던 쪽은 "아직 쓰이는 주소" 또는 "얼마 전까지 쓰이던 주소"로 거절된다.
      expect(take.status).toBe("rejected");
      expect((take as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
      expect((await prisma.business.findUniqueOrThrow({ where: { id: taker.id } })).slug).toBe(taker.slug);
      expect(await findSlugRedirect(from)).toBe(`moved-${round}`);
    }
  });

  it("운영 설정은 매니저 이상이 범위 안에서만 바꿀 수 있다", async () => {
    const { business, owner } = await createBusiness();
    const { user: manager } = await addMemberRow(business.id, "MANAGER");
    const { user: staff } = await addMemberRow(business.id, "STAFF");

    expect((await failure(updateBusinessSettings(staff.id, business.id, { autoRelist: false }))).code).toBe("FORBIDDEN");
    for (const defaultDeadlineMin of [-1, 1441, 30.5]) {
      const error = await failure(updateBusinessSettings(owner.id, business.id, { defaultDeadlineMin }));
      expect(error.fieldErrors?.defaultDeadlineMin, String(defaultDeadlineMin)).toMatch(/예약 마감 시간/);
    }

    await expect(updateBusinessSettings(manager.id, business.id, { autoRelist: false })).resolves.toEqual({ autoRelist: false, defaultDeadlineMin: 60 });
    await expect(updateBusinessSettings(owner.id, business.id, { defaultDeadlineMin: 0 })).resolves.toEqual({ autoRelist: false, defaultDeadlineMin: 0 });
    await expect(updateBusinessSettings(owner.id, business.id, { defaultDeadlineMin: 1440, autoRelist: true })).resolves.toEqual({
      autoRelist: true,
      defaultDeadlineMin: 1440,
    });
    await expect(updateBusinessSettings(owner.id, business.id, {})).resolves.toEqual({ autoRelist: true, defaultDeadlineMin: 1440 });
    expect(await auditActions("business.settings_update")).toHaveLength(3);
  });
});

describe("정산 계좌", () => {
  const ACCOUNT = "110123456789";

  it("계좌번호는 암호문으로만 저장하고 어디에도 원문을 남기지 않는다", async () => {
    const { business, owner } = await createBusiness();

    const masked = await setBankAccount(owner.id, business.id, { bankName: "신한은행", accountNumber: "110-123-456789", holder: "김대표" });
    expect(masked).toEqual({ bankName: "신한은행", masked: "****6789", holder: "김대표" });

    const row = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(row.bankAccountEnc).toMatch(/^v1\./);
    expect(row.bankAccountLast4).toBe("6789");
    expect(decrypt(row.bankAccountEnc!)).toBe(ACCOUNT);
    expect(getBankAccountMasked(row)).toEqual(masked);

    // 사업장 행·감사 기록·알림·발송 대기열 어디에도 계좌번호 원문이 없다.
    const stored = JSON.stringify([
      row,
      await prisma.auditLog.findMany(),
      await prisma.notification.findMany(),
      await prisma.messageOutbox.findMany(),
    ]);
    expect(stored).not.toContain(ACCOUNT);
    expect(stored).not.toContain("110-123-456789");

    const [log] = await auditActions("business.bank_update");
    expect(log).toMatchObject({ actorId: owner.id, targetId: business.id });
    expect(log!.meta).toEqual({ bankName: "신한은행", replaced: false });

    // 계좌가 바뀌면 대표에게 앱 알림과 메일로 알린다.
    expect(await prisma.notification.count({ where: { userId: owner.id, title: "정산 계좌가 바뀌었어요" } })).toBe(1);
    expect(await prisma.messageOutbox.count({ where: { channel: "EMAIL", recipient: owner.email, templateKey: "PLATFORM_BANK_ACCOUNT_CHANGED" } })).toBe(1);

    // 같은 번호를 다시 저장해도 암호문은 매번 달라진다.
    await setBankAccount(owner.id, business.id, { bankName: "신한은행", accountNumber: ACCOUNT, holder: "김대표" });
    const again = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(again.bankAccountEnc).not.toBe(row.bankAccountEnc);
    expect((await auditActions("business.bank_update"))[1]!.meta).toEqual({ bankName: "신한은행", replaced: true });
  });

  it("대표만 계좌를 등록할 수 있고 형식이 틀린 번호는 거절한다", async () => {
    const { business, owner } = await createBusiness();
    const { user: manager } = await addMemberRow(business.id, "MANAGER");
    const { owner: otherOwner } = await createBusiness();
    const input = { bankName: "국민은행", accountNumber: ACCOUNT, holder: "김대표" };

    expect((await failure(setBankAccount(manager.id, business.id, input))).code).toBe("FORBIDDEN");
    expect((await failure(setBankAccount(otherOwner.id, business.id, input))).code).toBe("FORBIDDEN");
    for (const accountNumber of ["1234567", "1".repeat(17), "110-ABC-456789", ""]) {
      const error = await failure(setBankAccount(owner.id, business.id, { ...input, accountNumber }));
      expect(error.fieldErrors?.accountNumber, accountNumber).toMatch(/숫자 8~16자리/);
    }
    expect((await failure(setBankAccount(owner.id, business.id, { ...input, holder: "" }))).fieldErrors?.holder).toMatch(/예금주/);
    const row = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(row.bankAccountEnc).toBeNull();
    expect(getBankAccountMasked(row)).toBeNull();
  });

  it("구성원 화면에는 가린 계좌만, 스태프에게는 아예 보여 주지 않는다", async () => {
    const { business, owner } = await createBusiness();
    const { user: staff } = await addMemberRow(business.id, "STAFF");
    await setBankAccount(owner.id, business.id, { bankName: "하나은행", accountNumber: ACCOUNT, holder: "김대표" });

    const forOwner = await getBusinessForMember(owner.id, business.id);
    expect(forOwner.bankAccount).toEqual({ bankName: "하나은행", masked: "****6789", holder: "김대표" });
    expect(JSON.stringify(forOwner)).not.toContain(ACCOUNT);
    expect(forOwner).not.toHaveProperty("bankAccountEnc");
    expect((await getBusinessForMember(staff.id, business.id)).bankAccount).toBeNull();

    const stranger = await createUser();
    expect((await failure(getBusinessForMember(stranger.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(getBusinessForMember(owner.id, "missing"))).code).toBe("FORBIDDEN");
  });

  it("계좌번호 원문은 최고 관리자·정산 담당만 볼 수 있고 볼 때마다 기록된다", async () => {
    const { business, owner } = await createBusiness();
    const finance = await createUser({ adminRole: "FINANCE" });
    const cs = await createUser({ adminRole: "CS" });

    await expect(revealBankAccount(finance.id, business.id)).resolves.toBeNull();
    await setBankAccount(owner.id, business.id, { bankName: "우리은행", accountNumber: ACCOUNT, holder: "김대표" });

    expect((await failure(revealBankAccount(cs.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(revealBankAccount(owner.id, business.id))).code).toBe("FORBIDDEN");
    await expect(revealBankAccount(finance.id, business.id)).resolves.toEqual({ bankName: "우리은행", accountNumber: ACCOUNT, holder: "김대표" });

    const logs = await auditActions("business.bank_reveal");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorId: finance.id, actorType: "ADMIN", targetId: business.id });
    expect(JSON.stringify(logs)).not.toContain(ACCOUNT);
  });
});

describe("구성원 관리", () => {
  it("베이직 플랜은 대표만 쓸 수 있고, 프로 플랜은 대표 포함 정해진 인원까지 둘 수 있다", async () => {
    const { business, owner } = await createBusiness();
    const first = await createUser();

    const free = await failure(addMember(owner.id, business.id, { email: first.email, role: "MANAGER" }));
    expect(free.code).toBe("FORBIDDEN");
    expect(free.message).toMatch(/베이직 플랜은 대표 계정만/);

    await prisma.business.update({ where: { id: business.id }, data: { plan: "PRO" } });
    const added = await addMember(owner.id, business.id, { email: ` ${first.email.toUpperCase()} `, role: "MANAGER" });
    expect(added).toMatchObject({ name: first.name, email: first.email, role: "MANAGER", isMe: false });
    expect(await prisma.notification.count({ where: { userId: first.id, type: "SYSTEM" } })).toBe(1);
    const [log] = await auditActions("business.member_add");
    expect(log).toMatchObject({ actorId: owner.id, targetId: business.id });
    expect(log!.meta).toMatchObject({ role: "MANAGER", userId: first.id });

    const max = PLAN_FEATURES.PRO.maxTeamMembers;
    for (let i = 0; i < max - 2; i++) {
      const user = await createUser();
      await addMember(owner.id, business.id, { email: user.email, role: "STAFF" });
    }
    expect(await prisma.businessMember.count({ where: { businessId: business.id } })).toBe(max);
    const extra = await createUser();
    const full = await failure(addMember(owner.id, business.id, { email: extra.email, role: "STAFF" }));
    expect(full.code).toBe("FORBIDDEN");
    expect(full.message).toContain(`${max}명까지`);
  });

  it("가입한 정상 회원만, 대표만 추가할 수 있다", async () => {
    const { business, owner } = await createBusiness({ plan: "PRO" });
    const { user: manager } = await addMemberRow(business.id, "MANAGER");
    const candidate = await createUser();
    const suspended = await createUser({ status: "SUSPENDED" });

    expect((await failure(addMember(manager.id, business.id, { email: candidate.email, role: "STAFF" }))).code).toBe("FORBIDDEN");

    for (const email of ["nobody@example.com", suspended.email]) {
      const error = await failure(addMember(owner.id, business.id, { email, role: "STAFF" }));
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toBe("가입된 회원의 이메일만 추가할 수 있어요.");
    }
    expect((await failure(addMember(owner.id, business.id, { email: "not-an-email", role: "STAFF" }))).fieldErrors?.email).toMatch(/이메일/);
    expect((await failure(addMember(owner.id, business.id, { email: candidate.email, role: "OWNER" as "STAFF" }))).fieldErrors?.role).toMatch(/역할/);

    await addMember(owner.id, business.id, { email: candidate.email, role: "STAFF" });
    const duplicate = await failure(addMember(owner.id, business.id, { email: candidate.email, role: "MANAGER" }));
    expect(duplicate.code).toBe("CONFLICT");
    expect((await failure(addMember(owner.id, business.id, { email: owner.email, role: "MANAGER" }))).code).toBe("CONFLICT");
    expect(await prisma.businessMember.count({ where: { businessId: business.id } })).toBe(3);
  });

  it("목록은 매니저 이상만 보고, 대표가 아니면 다른 사람의 이메일을 가려서 본다", async () => {
    const { business, owner } = await createBusiness();
    const { user: staff } = await addMemberRow(business.id, "STAFF");
    const { user: manager } = await addMemberRow(business.id, "MANAGER");
    const { owner: otherOwner } = await createBusiness();

    expect((await failure(listMembers(staff.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(listMembers(otherOwner.id, business.id))).code).toBe("FORBIDDEN");

    const forOwner = await listMembers(owner.id, business.id);
    expect(forOwner.map((m) => m.role)).toEqual(["OWNER", "MANAGER", "STAFF"]);
    expect(forOwner.map((m) => m.email)).toEqual([owner.email, manager.email, staff.email]);
    expect(forOwner.map((m) => m.isMe)).toEqual([true, false, false]);

    const forManager = await listMembers(manager.id, business.id);
    expect(forManager[1]).toMatchObject({ email: manager.email, isMe: true });
    for (const row of [forManager[0]!, forManager[2]!]) {
      expect(row.email).toMatch(/^.{1,2}\*+@example\.com$/);
    }
    expect(JSON.stringify(forManager)).not.toContain(owner.email);
    expect(JSON.stringify(forManager)).not.toContain(staff.email);
  });

  it("대표의 역할은 바꾸거나 뺄 수 없고, 다른 사업장의 구성원은 건드릴 수 없다", async () => {
    const { business, owner } = await createBusiness();
    const { user: manager, member: managerRow } = await addMemberRow(business.id, "MANAGER");
    const { user: staff, member: staffRow } = await addMemberRow(business.id, "STAFF");
    const ownerRow = await prisma.businessMember.findFirstOrThrow({ where: { businessId: business.id, role: "OWNER" } });
    const { business: other, owner: otherOwner } = await createBusiness();
    const { member: otherStaffRow } = await addMemberRow(other.id, "STAFF");

    // 대표 보호
    expect((await failure(changeMemberRole(owner.id, business.id, ownerRow.id, "STAFF"))).code).toBe("FORBIDDEN");
    expect((await failure(removeMember(owner.id, business.id, ownerRow.id))).code).toBe("FORBIDDEN");
    expect((await failure(changeMemberRole(owner.id, business.id, staffRow.id, "OWNER" as "STAFF"))).code).toBe("VALIDATION");

    // 대표가 아닌 구성원은 역할을 바꾸거나 남을 뺄 수 없다.
    expect((await failure(changeMemberRole(manager.id, business.id, staffRow.id, "MANAGER"))).code).toBe("FORBIDDEN");
    expect((await failure(removeMember(manager.id, business.id, staffRow.id))).code).toBe("FORBIDDEN");
    expect((await failure(removeMember(manager.id, business.id, ownerRow.id))).code).toBe("FORBIDDEN");

    // 내 사업장 ID 로 다른 사업장의 구성원을 가리킬 수 없다(IDOR).
    expect((await failure(changeMemberRole(owner.id, business.id, otherStaffRow.id, "MANAGER"))).code).toBe("NOT_FOUND");
    expect((await failure(removeMember(owner.id, business.id, otherStaffRow.id))).code).toBe("NOT_FOUND");
    expect((await failure(removeMember(otherOwner.id, business.id, staffRow.id))).code).toBe("FORBIDDEN");
    expect((await prisma.businessMember.findUniqueOrThrow({ where: { id: otherStaffRow.id } })).role).toBe("STAFF");

    await expect(changeMemberRole(owner.id, business.id, staffRow.id, "MANAGER")).resolves.toEqual({ memberId: staffRow.id, role: "MANAGER" });
    await expect(changeMemberRole(owner.id, business.id, managerRow.id, "STAFF")).resolves.toEqual({ memberId: managerRow.id, role: "STAFF" });
    expect((await auditActions("business.member_role")).map((l) => l.meta)).toEqual([
      { memberId: staffRow.id, userId: staff.id, from: "STAFF", to: "MANAGER" },
      { memberId: managerRow.id, userId: manager.id, from: "MANAGER", to: "STAFF" },
    ]);

    // 스태프가 된 구성원은 스스로 나갈 수 있고, 대표는 다른 구성원을 뺄 수 있다.
    await removeMember(manager.id, business.id, managerRow.id);
    await removeMember(owner.id, business.id, staffRow.id);
    const left = await prisma.businessMember.findMany({ where: { businessId: business.id } });
    expect(left.map((m) => m.id)).toEqual([ownerRow.id]);
    expect(await auditActions("business.member_remove")).toHaveLength(2);
  });
});

describe("getPublicBusiness", () => {
  it("승인된 사업장의 공개 정보와 법정 표시 정보만 돌려준다", async () => {
    const reg = regNo("123456789");
    const { business, owner } = await createBusiness({
      slug: "dunsan-social",
      name: "둔산 소셜클럽",
      phone: "0421234567",
      address: "대전 서구 둔산로 123",
      addressDetail: "2층",
      businessRegNo: reg,
      representativeName: "김대표",
      commissionBps: 700,
    });
    await setBankAccount(owner.id, business.id, { bankName: "신한은행", accountNumber: "110999988887", holder: "김대표" });

    const found = await getPublicBusiness("dunsan-social");
    expect(found).toMatchObject({
      id: business.id,
      slug: "dunsan-social",
      name: "둔산 소셜클럽",
      legal: { name: "둔산 소셜클럽", representativeName: "김대표", businessRegNo: reg, address: "대전 서구 둔산로 123 2층", phone: "0421234567" },
    });
    const json = JSON.stringify(found);
    for (const secret of ["bank", "8887", "신한은행", "commissionBps", "plan", "status"]) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it("심사 중·반려·정지 사업장과 없는 주소는 보여 주지 않는다", async () => {
    for (const status of ["PENDING", "REJECTED", "SUSPENDED"] as const) {
      const { business } = await createBusiness({ status });
      expect(await getPublicBusiness(business.slug), status).toBeNull();
    }
    expect(await getPublicBusiness("no-such-business")).toBeNull();
    expect(await getPublicBusiness("")).toBeNull();
    expect(await getPublicBusiness("x".repeat(200))).toBeNull();
  });
});
