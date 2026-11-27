import { randomBytes, randomInt } from "node:crypto";

// 헷갈리는 글자(0/O, 1/I/L)를 뺀 문자 집합
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** 예약번호: NJ-XXXXXX (31^6 ≈ 8.9억 조합) */
export function newBookingCode(): string {
  return `NJ-${randomCode(6)}`;
}

/** PG 주문번호: 영문·숫자·-_ 6~64자 규격 */
export function newOrderId(): string {
  return `nj_${Date.now().toString(36)}_${randomBytes(9).toString("base64url")}`;
}

/** 6자리 숫자 인증번호 */
export function newOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
