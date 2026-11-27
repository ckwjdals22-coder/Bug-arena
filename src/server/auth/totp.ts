import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP (HMAC-SHA1, 30초, 6자리) — Google Authenticator·Authy 등과 호환
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpCode(secret: string, at: number = Date.now()): string {
  return hotp(secret, Math.floor(at / 30_000));
}

/** 앞뒤 1스텝(±30초)의 시계 오차를 허용한다. */
export function verifyTotp(secret: string, code: string, at: number = Date.now()): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(at / 30_000);
  for (const delta of [0, -1, 1]) {
    const expected = Buffer.from(hotp(secret, counter + delta));
    if (timingSafeEqual(expected, Buffer.from(normalized))) return true;
  }
  return false;
}

/** 인증 앱 등록용 otpauth URI (QR 로 표시) */
export function totpUri(secret: string, accountName: string, issuer = "남는자리 운영"): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
