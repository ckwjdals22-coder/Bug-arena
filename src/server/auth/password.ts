import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const N = 32768; // 2^15
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** 형식: scrypt$N$r$p$salt(base64)$hash(base64) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  const actual = await scrypt(password, salt, n, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 계정이 없을 때도 같은 시간이 걸리도록 하는 더미 검증(계정 존재 여부 추측 방지) */
const DUMMY_HASH_PROMISE = hashPassword("dummy-password-for-timing");
export async function verifyDummy(password: string): Promise<void> {
  await verifyPassword(password, await DUMMY_HASH_PROMISE);
}

const COMMON = new Set([
  "password", "password1", "12345678", "123456789", "1234567890", "qwer1234", "qwerty123", "asdf1234",
  "1q2w3e4r", "1q2w3e4r5t", "abcd1234", "iloveyou1", "11111111", "00000000", "a1234567", "p@ssw0rd",
]);

/** 비밀번호 정책 위반 사유를 돌려준다. 통과하면 null */
export function passwordPolicyError(password: string, context: { email?: string } = {}): string | null {
  if (password.length < 8) return "비밀번호는 8자 이상이어야 해요.";
  if (password.length > 72) return "비밀번호는 72자 이하여야 해요.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "영문과 숫자를 함께 넣어 주세요.";
  if (COMMON.has(password.toLowerCase())) return "너무 흔한 비밀번호예요. 다른 비밀번호를 써 주세요.";
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return "이메일과 비슷한 비밀번호는 쓸 수 없어요.";
  return null;
}
