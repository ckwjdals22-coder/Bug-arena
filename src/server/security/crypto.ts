import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const DEV_KEY_SEED = "namneun-dev-only-key-do-not-use-in-production";

function encryptionKey(): Buffer {
  const raw = env().APP_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY 는 base64 로 인코딩한 32바이트여야 합니다.");
    return key;
  }
  if (env().NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY 가 설정되지 않았습니다.");
  return createHash("sha256").update(DEV_KEY_SEED).digest();
}

/** AES-256-GCM 암호화. 결과 형식: v1.<iv>.<tag>.<ciphertext> (base64url) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("암호문 형식이 올바르지 않습니다.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(key: string | Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

/** URL 에 넣어도 안전한 무작위 토큰 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
