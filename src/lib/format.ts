/** 전화번호에서 숫자만 남긴다. 010 휴대전화 형식이 아니면 null */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (/^01[016789]\d{7,8}$/.test(digits)) return digits;
  return null;
}

/** 01012345678 → 010-1234-5678 */
export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return phone;
}

/** 01012345678 → 010-****-5678 */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length < 8) return "****";
  return `${d.slice(0, 3)}-****-${d.slice(-4)}`;
}

/** hong@example.com → ho**@example.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${"*".repeat(Math.max(2, local.length - head.length))}@${domain}`;
}

/** 홍길동 → 홍*동, 김철 → 김* */
export function maskName(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length <= 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** 사업자등록번호 형식·검증 숫자 확인(국세청 진위 확인은 별도 연동) */
export function isValidBusinessRegNo(input: string): boolean {
  const d = input.replace(/\D/g, "");
  if (d.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

/** 1234567890 → 123-45-67890 */
export function formatBusinessRegNo(input: string): string {
  const d = input.replace(/\D/g, "");
  if (d.length !== 10) return input;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/** URL 슬러그: 영문 소문자·숫자·하이픈만 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
