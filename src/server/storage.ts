import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { env } from "@/lib/env";
import { kstParts } from "@/lib/time";
import { AppError, err } from "@/server/errors";

/**
 * 이미지 저장소.
 * - 올라온 파일은 내용(매직 바이트 + 디코더 판독)으로 형식을 확인하고, 항상 WebP 로 다시 인코딩해 저장한다.
 *   원본 바이트는 어디에도 남기지 않으므로 EXIF(위치 정보 등)와 파일에 숨긴 데이터가 함께 사라진다.
 * - 저장 경로(키)는 서버가 무작위로 만든다. 사용자가 보낸 파일명·확장자·MIME 은 쓰지 않는다.
 * - 드라이버: local(서버 디스크 ./uploads, /uploads/** 라우트로 제공) | s3(S3 호환 스토리지, 공개 주소로 제공)
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_SCOPES = ["product", "business", "review"] as const;
export type ImageScope = (typeof IMAGE_SCOPES)[number];

const MAX_EDGE = 1600;
const WEBP_QUALITY = 82;
/** 압축 폭탄 방지: 디코딩할 수 있는 최대 픽셀 수(약 5천만 화소) */
const MAX_INPUT_PIXELS = 50_000_000;
const LOCAL_URL_PREFIX = "/uploads/";
/** 우리가 만든 키의 모양: {scope}/{yyyy}/{mm}/{무작위 24바이트 base64url}.webp */
const OBJECT_KEY = /^(?:product|business|review)\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{32}\.webp$/;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface SavedImage {
  /** local: "/uploads/<key>" · s3: "<S3_PUBLIC_BASE_URL>/<key>" */
  url: string;
  width: number;
  height: number;
}

export interface SaveImageOptions {
  scope: ImageScope;
  /** 올린 주체(회원 또는 사업장 ID). S3 객체 메타데이터에 남겨 운영 중 출처를 추적한다. */
  ownerId: string;
}

// ── 검증 · 재인코딩 ───────────────────────────────────

const unsupported = () => err.validation("JPG, PNG, WebP 이미지만 올릴 수 있어요.");
const tooLarge = () => err.validation("이미지는 5MB 이하로 올려 주세요.");

async function readInput(file: File | { buffer: Buffer }): Promise<Buffer> {
  if (typeof File !== "undefined" && file instanceof File) {
    // 메모리에 올리기 전에 크기부터 본다.
    if (file.size > MAX_IMAGE_BYTES) throw tooLarge();
    return Buffer.from(await file.arrayBuffer());
  }
  const buffer = (file as { buffer?: unknown } | null)?.buffer;
  if (!Buffer.isBuffer(buffer)) throw err.validation("이미지 파일을 골라 주세요.");
  return buffer;
}

/** 파일 앞부분의 매직 바이트로 형식을 가린다. 확장자·MIME 은 믿지 않는다. */
function sniffFormat(data: Buffer): "jpeg" | "png" | "webp" | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

async function reencode(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  // SVG·GIF·HEIF 등은 디코더에 넘기기 전에 걸러 낸다.
  const sniffed = sniffFormat(input);
  if (!sniffed) throw unsupported();
  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const meta = await image.metadata();
    // 디코더가 읽은 형식이 매직 바이트와 같아야 한다(둘 다 JPEG·PNG·WebP 중 하나).
    if (meta.format !== sniffed || !meta.width || !meta.height) throw unsupported();
    // 방향 보정 → 긴 변 1600px 이하로 축소 → WebP. 메타데이터(EXIF·ICC·XMP)는 기본값으로 모두 빠진다.
    const { data, info } = await image
      .autoOrient()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof AppError) throw e;
    // 픽셀 수 한도를 넘는 이미지는 디코더가 헤더만 보고 거절한다.
    if (e instanceof Error && /pixel limit/i.test(e.message)) {
      throw err.validation("이미지 해상도가 너무 커요. 더 작은 이미지로 올려 주세요.");
    }
    throw err.validation("이미지를 읽을 수 없어요. 다른 파일로 다시 시도해 주세요.");
  }
}

function newObjectKey(scope: ImageScope): string {
  const now = kstParts(new Date());
  return `${scope}/${now.year}/${String(now.month).padStart(2, "0")}/${randomBytes(24).toString("base64url")}.webp`;
}

// ── 드라이버 ──────────────────────────────────────────

/** 로컬 드라이버의 저장 위치: <프로젝트 루트>/uploads */
export function uploadsRoot(): string {
  return path.resolve(process.cwd(), "uploads");
}

async function putLocal(key: string, data: Buffer): Promise<string> {
  const target = path.join(uploadsRoot(), key);
  await mkdir(path.dirname(target), { recursive: true });
  // 같은 키가 이미 있으면 덮어쓰지 않고 실패한다.
  await writeFile(target, data, { flag: "wx", mode: 0o644 });
  return `${LOCAL_URL_PREFIX}${key}`;
}

interface S3Config {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

/** S3 설정이 모두 채워져 있을 때만 값을 돌려준다. 하나라도 빠지면 null */
function s3Config(): S3Config | null {
  const e = env();
  const endpoint = e.S3_ENDPOINT?.trim() || undefined;
  // AWS S3 는 리전이 필수다. 엔드포인트를 따로 주는 호환 스토리지(R2 등)는 "auto" 로 둔다.
  const region = e.S3_REGION?.trim() || (endpoint ? "auto" : "");
  const publicBaseUrl = e.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  if (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY || !region || !/^https?:\/\//.test(publicBaseUrl)) return null;
  return {
    bucket: e.S3_BUCKET,
    region,
    endpoint,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    publicBaseUrl,
  };
}

let s3Client: S3Client | undefined;

function getS3Client(config: S3Config): S3Client {
  s3Client ??= new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    // 호환 스토리지는 버킷을 경로에 두는 방식이 가장 널리 통한다.
    forcePathStyle: Boolean(config.endpoint),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // 추가 체크섬 헤더를 받지 않는 호환 스토리지가 있어 필수일 때만 붙인다.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return s3Client;
}

const describeError = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : "unknown");

async function putS3(key: string, data: Buffer, options: SaveImageOptions): Promise<string> {
  const config = s3Config();
  if (!config) {
    throw err.notConfigured("이미지 저장소(S3) 설정이 끝나지 않아 올릴 수 없어요. 관리자에게 문의해 주세요.");
  }
  try {
    await getS3Client(config).send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: data,
        ContentType: "image/webp",
        CacheControl: CACHE_CONTROL,
        Metadata: { scope: options.scope, owner: options.ownerId },
      }),
    );
  } catch (e) {
    console.error(`[storage] S3 업로드 실패 key=${key} — ${describeError(e)}`);
    throw new AppError("INTERNAL", "이미지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  return `${config.publicBaseUrl}/${key}`;
}

// ── 공개 함수 ─────────────────────────────────────────

/**
 * 이미지를 검증·재인코딩해 저장하고 공개 주소와 크기를 돌려준다.
 * 5MB 초과, JPEG/PNG/WebP 가 아닌 내용, 읽을 수 없는 파일, 지나치게 큰 해상도는 VALIDATION 오류로 거절한다.
 */
export async function saveImage(file: File | { buffer: Buffer }, opts: SaveImageOptions): Promise<SavedImage> {
  if (!IMAGE_SCOPES.includes(opts.scope)) throw err.validation("이미지 용도를 확인해 주세요.");
  if (typeof opts.ownerId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(opts.ownerId)) {
    throw err.validation("이미지를 올릴 수 없어요. 다시 로그인한 뒤 시도해 주세요.");
  }
  const input = await readInput(file);
  if (input.length === 0) throw err.validation("빈 파일이에요. 다른 이미지를 골라 주세요.");
  if (input.length > MAX_IMAGE_BYTES) throw tooLarge();

  const encoded = await reencode(input);
  const key = newObjectKey(opts.scope);
  const url = env().STORAGE_DRIVER === "s3" ? await putS3(key, encoded.data, opts) : await putLocal(key, encoded.data);
  return { url, width: encoded.width, height: encoded.height };
}

interface OwnImageRef {
  driver: "local" | "s3";
  /** 저장소 안의 상대 경로 */
  key: string;
}

/** 우리 저장소 주소에서 키를 뽑는다. 다른 사이트 주소이거나 경로가 안전하지 않으면 null */
function parseOwnUrl(url: string): OwnImageRef | null {
  let ref: OwnImageRef;
  if (url.startsWith(LOCAL_URL_PREFIX)) {
    ref = { driver: "local", key: url.slice(LOCAL_URL_PREFIX.length) };
  } else {
    const config = s3Config();
    if (!config || !url.startsWith(`${config.publicBaseUrl}/`)) return null;
    ref = { driver: "s3", key: url.slice(config.publicBaseUrl.length + 1) };
  }
  return isSafeImagePath(ref.key.split("/")) ? ref : null;
}

/**
 * 저장된 이미지 참조(상품 사진·사업장 로고 등)가 우리 저장소 안의 .webp 주소인지 확인한다.
 * 외부 주소·임의 경로를 이미지로 저장하지 못하게 서비스에서 검증용으로 쓴다.
 * 이미 저장된 참조를 다시 저장할 때 막히지 않도록, 지금 드라이버와 관계없이 로컬 주소와 S3 공개 주소를 모두 인정한다.
 */
export function isOwnImageUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 500 && parseOwnUrl(url) !== null;
}

/**
 * 이미지 삭제(최선 노력). saveImage 가 만든 키 모양의 주소만 지우고, 실패해도 예외를 던지지 않는다.
 * 키에는 소유자 정보가 없으므로, 호출부는 그 이미지가 행위자의 리소스에만 쓰이고 있었는지 먼저 확인해야 한다.
 */
export async function deleteImage(url: string): Promise<boolean> {
  const ref = typeof url === "string" && url.length <= 500 ? parseOwnUrl(url) : null;
  if (!ref || !OBJECT_KEY.test(ref.key)) return false;
  try {
    if (ref.driver === "local") {
      await unlink(path.join(uploadsRoot(), ref.key));
      return true;
    }
    const config = s3Config();
    if (!config) return false;
    await getS3Client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: ref.key }));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      console.error(`[storage] 이미지 삭제 실패 key=${ref.key} — ${describeError(e)}`);
    }
    return false;
  }
}

// ── /uploads/** 경로 해석 ─────────────────────────────

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/**
 * 경로 조각이 업로드 폴더 안의 .webp 파일을 가리키는 안전한 모양인지.
 * 조각마다 영문·숫자·._- 만 허용하고 ".."·숨김 파일·구분자·제어 문자를 거절한다.
 */
function isSafeImagePath(segments: readonly unknown[]): segments is readonly string[] {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 6) return false;
  for (const segment of segments) {
    if (typeof segment !== "string" || !SAFE_SEGMENT.test(segment) || segment.includes("..")) return false;
  }
  return (segments[segments.length - 1] as string).endsWith(".webp");
}

/**
 * /uploads/[...path] 의 경로 조각을 업로드 폴더 안의 실제 파일 경로로 바꾼다. 안전하지 않으면 null.
 * .webp 파일만 허용하며, 해석한 경로가 업로드 폴더를 벗어나면 거절한다.
 */
export function resolveUploadPath(segments: readonly string[], root: string = uploadsRoot()): string | null {
  if (!isSafeImagePath(segments)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}
