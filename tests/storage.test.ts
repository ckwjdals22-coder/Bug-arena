import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/uploads/[...path]/route";
import { AppError } from "@/server/errors";
import { MAX_IMAGE_BYTES, deleteImage, isOwnImageUrl, resolveUploadPath, saveImage, uploadsRoot } from "@/server/storage";

const KEY_URL = /^\/uploads\/(product|business|review)\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{32}\.webp$/;
const OWNER = "owner_test_1";

type Format = "jpeg" | "png" | "webp";

/** 단색 테스트 이미지를 만든다. */
function makeImage(format: Format, width = 320, height = 200): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 210, g: 90, b: 40 } } });
  return (format === "jpeg" ? base.jpeg() : format === "png" ? base.png() : base.webp()).toBuffer();
}

const created: string[] = [];
const localPath = (url: string) => path.join(uploadsRoot(), url.replace(/^\/uploads\//, ""));

/** 저장한 뒤 정리 목록에 올린다. */
async function save(file: Parameters<typeof saveImage>[0], scope: Parameters<typeof saveImage>[1]["scope"] = "product") {
  const saved = await saveImage(file, { scope, ownerId: OWNER });
  created.push(saved.url);
  return saved;
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

afterEach(async () => {
  // 테스트가 만든 파일만 지운다(폴더는 같은 작업 폴더를 쓰는 다른 테스트와 겹칠 수 있어 그대로 둔다).
  for (const url of created.splice(0)) {
    await unlink(localPath(url)).catch(() => {});
  }
});

describe("saveImage — 로컬 드라이버", () => {
  it.each(["jpeg", "png", "webp"] as const)("%s 를 받아 WebP 로 다시 인코딩해 uploads/ 아래에 저장한다", async (format) => {
    const saved = await save({ buffer: await makeImage(format) }, "business");
    expect(saved).toMatchObject({ width: 320, height: 200 });
    expect(saved.url).toMatch(KEY_URL);
    expect(saved.url.startsWith("/uploads/business/")).toBe(true);

    const file = localPath(saved.url);
    expect(file.startsWith(uploadsRoot() + path.sep)).toBe(true);
    const meta = await sharp(await readFile(file)).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 320, height: 200 });
  });

  it("긴 변을 1600px 이하로 줄이고 작은 이미지는 키우지 않는다", async () => {
    const wide = await save({ buffer: await makeImage("jpeg", 3200, 1600) });
    expect(wide).toMatchObject({ width: 1600, height: 800 });
    const tall = await save({ buffer: await makeImage("png", 1000, 4000) });
    expect(tall).toMatchObject({ width: 400, height: 1600 });
    const small = await save({ buffer: await makeImage("webp", 64, 48) });
    expect(small).toMatchObject({ width: 64, height: 48 });

    const meta = await sharp(await readFile(localPath(wide.url))).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(1600);
  });

  it("EXIF(위치·저작자 등)를 지우고 촬영 방향을 반영해 바로 세운다", async () => {
    const input = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 20, g: 120, b: 200 } } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "secret-owner-name", Artist: "kim" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 21/1 0/1" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    expect(input.includes("secret-owner-name")).toBe(true);

    const saved = await save({ buffer: input });
    // 90도 돌려 찍은 사진이므로 가로·세로가 바뀐다.
    expect(saved).toMatchObject({ width: 200, height: 300 });
    const output = await readFile(localPath(saved.url));
    const after = await sharp(output).metadata();
    expect(after.format).toBe("webp");
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(output.includes("secret-owner-name")).toBe(false);
  });

  it("파일 이름과 MIME 이 아니라 내용으로 형식을 판단한다", async () => {
    // 이름·MIME 이 틀려도 내용이 PNG 면 받는다.
    const disguisedPng = new File([new Uint8Array(await makeImage("png"))], "notes.txt", { type: "text/plain" });
    expect((await save(disguisedPng, "review")).url).toMatch(KEY_URL);

    // 확장자만 .jpg 인 텍스트 파일
    const fakeJpg = new File(["이건 사진이 아니라 그냥 글자예요."], "photo.jpg", { type: "image/jpeg" });
    const text = await failure(saveImage(fakeJpg, { scope: "product", ownerId: OWNER }));
    expect(text.code).toBe("VALIDATION");
    expect(text.message).toMatch(/JPG, PNG, WebP 이미지만/);

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>';
    for (const file of [{ buffer: Buffer.from(svg) }, new File([svg], "logo.png", { type: "image/png" })]) {
      const error = await failure(saveImage(file, { scope: "business", ownerId: OWNER }));
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toMatch(/JPG, PNG, WebP 이미지만/);
    }

    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    expect((await failure(saveImage({ buffer: gif }, { scope: "product", ownerId: OWNER }))).message).toMatch(/JPG, PNG, WebP 이미지만/);
  });

  it("5MB 를 넘거나 비어 있거나 깨진 파일을 거절한다", async () => {
    const jpeg = await makeImage("jpeg");
    const oversize = Buffer.concat([jpeg, Buffer.alloc(MAX_IMAGE_BYTES + 1 - jpeg.length)]);
    expect(oversize.length).toBe(MAX_IMAGE_BYTES + 1);
    for (const file of [{ buffer: oversize }, new File([new Uint8Array(oversize)], "big.jpg", { type: "image/jpeg" })]) {
      const error = await failure(saveImage(file, { scope: "product", ownerId: OWNER }));
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toMatch(/5MB 이하/);
    }

    expect((await failure(saveImage({ buffer: Buffer.alloc(0) }, { scope: "product", ownerId: OWNER }))).message).toMatch(/빈 파일/);
    // JPEG 머리 부분만 있고 본문이 잘린 파일
    const truncated = jpeg.subarray(0, 200);
    expect((await failure(saveImage({ buffer: truncated }, { scope: "product", ownerId: OWNER }))).message).toMatch(/읽을 수 없어요/);
    expect((await failure(saveImage({ buffer: "not-a-buffer" as unknown as Buffer }, { scope: "product", ownerId: OWNER }))).code).toBe("VALIDATION");
  });

  it("파일은 작지만 펼치면 거대한 이미지(압축 폭탄)를 거절한다", async () => {
    const bomb = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: { r: 0, g: 0, b: 0 } }, limitInputPixels: false })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(MAX_IMAGE_BYTES);
    const error = await failure(saveImage({ buffer: bomb }, { scope: "product", ownerId: OWNER }));
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toMatch(/해상도가 너무 커요/);
  });

  it("용도와 올린 주체 값이 올바르지 않으면 저장하지 않는다", async () => {
    const buffer = await makeImage("png");
    expect((await failure(saveImage({ buffer }, { scope: "../etc" as "product", ownerId: OWNER }))).code).toBe("VALIDATION");
    expect((await failure(saveImage({ buffer }, { scope: "product", ownerId: "../../x" }))).code).toBe("VALIDATION");
  });

  it("같은 이미지를 올려도 매번 다른 무작위 키로 저장한다", async () => {
    const buffer = await makeImage("jpeg");
    const urls = new Set<string>();
    for (let i = 0; i < 5; i++) urls.add((await save({ buffer })).url);
    expect(urls.size).toBe(5);
    for (const url of urls) {
      expect(url).toMatch(KEY_URL);
      expect(isOwnImageUrl(url)).toBe(true);
      expect((await stat(localPath(url))).isFile()).toBe(true);
    }
  });
});

describe("isOwnImageUrl · deleteImage", () => {
  it("우리 저장소 안의 .webp 주소만 인정한다", async () => {
    const { url } = await save({ buffer: await makeImage("png") });
    expect(isOwnImageUrl(url)).toBe(true);
    // 업로드 폴더에 직접 넣어 둔 이미지(시연용 등)도 우리 저장소 주소다.
    expect(isOwnImageUrl("/uploads/demo/cover-1.webp")).toBe(true);
    for (const bad of [
      "https://evil.example/uploads/product/2026/11/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp",
      "//evil.example/uploads/x.webp",
      "/uploads/../etc/passwd",
      "/uploads/../secret.webp",
      "/uploads/product/2026/11/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
      "/uploads/product/.hidden.webp",
      "/uploads//x.webp",
      "/uploads/",
      "/images/cover.webp",
      "uploads/x.webp",
      `${url}?x=1`,
      `${url}#frag`,
      `${url}/../../secret.webp`,
      "javascript:alert(1)",
      "data:image/webp;base64,AAAA",
      `/uploads/${"a/".repeat(10)}x.webp`,
      "",
      null,
      undefined,
      42,
    ]) {
      expect(isOwnImageUrl(bad), String(bad)).toBe(false);
    }
  });

  it("saveImage 가 만든 파일만 지우고, 다른 주소나 경로는 건드리지 않는다", async () => {
    const { url } = await save({ buffer: await makeImage("png") });
    const outside = path.join(uploadsRoot(), "..", "package.json");
    // 무작위 키 모양이 아닌 파일은 업로드 폴더 안에 있어도 지우지 않는다.
    const manualName = `manual-${Date.now()}.webp`;
    const manual = path.join(uploadsRoot(), manualName);
    await writeFile(manual, await makeImage("webp"));

    try {
      expect(isOwnImageUrl(`/uploads/${manualName}`)).toBe(true);
      expect(await deleteImage(`/uploads/${manualName}`)).toBe(false);
      expect((await stat(manual)).isFile()).toBe(true);
    } finally {
      await unlink(manual);
    }
    expect(await deleteImage("/uploads/../package.json")).toBe(false);
    expect(await deleteImage("https://evil.example/x.webp")).toBe(false);
    expect((await stat(outside)).isFile()).toBe(true);

    expect(await deleteImage(url)).toBe(true);
    await expect(stat(localPath(url))).rejects.toMatchObject({ code: "ENOENT" });
    // 이미 없는 파일은 조용히 false
    expect(await deleteImage(url)).toBe(false);
  });
});

describe("resolveUploadPath", () => {
  const root = "/srv/app/uploads";

  it("업로드 폴더 안의 .webp 경로만 돌려준다", () => {
    const key = ["product", "2026", "11", "-AbC_dEf0123456789abcdefABCDEF01.webp"];
    expect(resolveUploadPath(key, root)).toBe(`${root}/${key.join("/")}`);
    expect(resolveUploadPath(["demo.webp"], root)).toBe(`${root}/demo.webp`);
    expect(resolveUploadPath(key)).toBe(path.join(uploadsRoot(), ...key));
  });

  it("상위 폴더 이동·절대 경로·구분자·숨김 파일·다른 확장자를 모두 거절한다", () => {
    const attempts: unknown[] = [
      [],
      [".."],
      ["..", "..", "etc", "passwd"],
      ["product", "..", "..", "secret.webp"],
      ["product", "..", "x.webp"],
      ["..", "uploads", "x.webp"],
      ["/etc/passwd"],
      ["/etc", "x.webp"],
      ["product", "../../x.webp"],
      ["product", "a/b.webp"],
      ["product", "a\\b.webp"],
      ["product", "..\\..\\x.webp"],
      ["%2e%2e", "x.webp"],
      ["..%2f..%2fx.webp"],
      ["product", "x.webp\0.png"],
      ["product", "\0", "x.webp"],
      [".env"],
      [".hidden.webp"],
      ["product", ".", "x.webp"],
      ["product", "", "x.webp"],
      ["product", "x..webp"],
      ["product", "x.png"],
      ["product", "x.WEBP"],
      ["product", "x.webp "],
      ["product", "x.webp/"],
      ["product", "사진.webp"],
      ["a", "b", "c", "d", "e", "f", "x.webp"],
      ["x".repeat(200) + ".webp"],
      [42, "x.webp"],
      "product/x.webp",
      null,
    ];
    for (const attempt of attempts) {
      expect(resolveUploadPath(attempt as string[], root), JSON.stringify(attempt)).toBeNull();
    }
  });
});

describe("GET /uploads/[...path]", () => {
  const call = (segments: string[]) =>
    GET(new Request(`http://localhost:3000/uploads/${segments.join("/")}`), { params: Promise.resolve({ path: segments }) });

  it("저장한 이미지를 WebP 로, 오래 캐시되게 내보낸다", async () => {
    const { url } = await save({ buffer: await makeImage("jpeg") });
    const res = await call(url.replace(/^\/uploads\//, "").split("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(await readFile(localPath(url)))).toBe(true);
    expect(res.headers.get("content-length")).toBe(String(body.length));
  });

  it("없는 파일과 폴더 밖을 가리키는 요청은 404 다", async () => {
    for (const segments of [
      ["product", "2026", "11", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp"],
      ["..", "package.json"],
      ["..", "..", "etc", "passwd"],
      ["product"],
      ["product", "..", "..", ".env"],
    ]) {
      const res = await call(segments);
      expect(res.status, segments.join("/")).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("업로드 폴더 안의 심볼릭 링크가 폴더 밖을 가리키면 내보내지 않는다", async () => {
    const { url } = await save({ buffer: await makeImage("png") });
    const outsideDir = await mkdtemp(path.join(tmpdir(), "nj-storage-"));
    const secret = path.join(outsideDir, "secret.webp");
    await writeFile(secret, await makeImage("webp"));
    const linkName = `link-${Date.now()}.webp`;
    const link = path.join(path.dirname(localPath(url)), linkName);
    await symlink(secret, link);
    try {
      const segments = [...url.replace(/^\/uploads\//, "").split("/").slice(0, -1), linkName];
      expect(resolveUploadPath(segments)).toBe(link);
      expect((await call(segments)).status).toBe(404);
    } finally {
      await unlink(link);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("S3 드라이버", () => {
  const S3_KEYS = [
    "STORAGE_DRIVER",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_PUBLIC_BASE_URL",
  ] as const;
  const original = Object.fromEntries(S3_KEYS.map((key) => [key, process.env[key]]));
  let server: Server | undefined;

  /** 환경 변수를 바꾼 뒤 모듈을 새로 불러와 설정 캐시가 없는 저장소를 얻는다. */
  async function loadStorageWith(vars: Partial<Record<(typeof S3_KEYS)[number], string>>) {
    for (const key of S3_KEYS) delete process.env[key];
    Object.assign(process.env, vars);
    vi.resetModules();
    return import("@/server/storage");
  }

  afterEach(async () => {
    for (const key of S3_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    vi.resetModules();
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("S3 설정이 덜 됐으면 성공한 척하지 않고 NOT_CONFIGURED 로 실패한다", async () => {
    const storage = await loadStorageWith({ STORAGE_DRIVER: "s3", S3_BUCKET: "namneun-images" });
    await expect(storage.saveImage({ buffer: await makeImage("png") }, { scope: "product", ownerId: OWNER })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      status: 503,
    });
    // 설정되지 않은 저장소의 주소는 우리 것으로 인정하지 않는다.
    expect(storage.isOwnImageUrl("https://cdn.example.com/product/2026/11/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp")).toBe(false);
  });

  it("PutObject 로 WebP 를 올리고 공개 주소를 돌려주며, 삭제는 DeleteObject 로 보낸다", async () => {
    const requests: { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(req.method === "DELETE" ? 204 : 200, { ETag: '"test-etag"' });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const storage = await loadStorageWith({
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      S3_REGION: "auto",
      S3_BUCKET: "namneun-images",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      S3_PUBLIC_BASE_URL: "https://cdn.example.com/",
    });

    const saved = await storage.saveImage({ buffer: await makeImage("jpeg", 2000, 1000) }, { scope: "review", ownerId: OWNER });
    expect(saved).toMatchObject({ width: 1600, height: 800 });
    expect(saved.url).toMatch(/^https:\/\/cdn\.example\.com\/review\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{32}\.webp$/);
    const key = saved.url.replace("https://cdn.example.com/", "");

    expect(requests).toHaveLength(1);
    const put = requests[0]!;
    expect(put.method).toBe("PUT");
    expect(put.url.split("?")[0]).toBe(`/namneun-images/${key}`);
    expect(put.headers["content-type"]).toBe("image/webp");
    expect(put.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(put.headers["x-amz-meta-scope"]).toBe("review");
    expect(put.headers["x-amz-meta-owner"]).toBe(OWNER);
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    expect(put.headers.authorization).not.toContain("test-secret-key");
    expect((await sharp(put.body).metadata()).format).toBe("webp");

    expect(storage.isOwnImageUrl(saved.url)).toBe(true);
    expect(storage.isOwnImageUrl(`https://cdn.example.com.evil.example/${key}`)).toBe(false);
    expect(storage.isOwnImageUrl(`https://cdn.example.com/../${key}`)).toBe(false);
    // 로컬 드라이버 시절에 저장한 주소도 계속 인정한다.
    expect(storage.isOwnImageUrl("/uploads/product/2026/11/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp")).toBe(true);

    expect(await storage.deleteImage(saved.url)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ method: "DELETE" });
    expect(requests[1]!.url.split("?")[0]).toBe(`/namneun-images/${key}`);
    expect(await storage.deleteImage("https://other.example.com/review/2026/11/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp")).toBe(false);
    expect(requests).toHaveLength(2);
  });
});
