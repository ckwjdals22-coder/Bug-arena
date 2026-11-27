/** 39000 → "39,000원" */
export function formatKRW(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

/** 39000 → "39,000" */
export function formatNumber(n: number): string {
  return n.toLocaleString("ko-KR");
}

/** 1250000 → "125만원", 3400 → "3,400원" — 통계 타일용 축약 */
export function formatKRWCompact(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 100_000_000) return `${(amount / 100_000_000).toFixed(abs % 100_000_000 === 0 ? 0 : 1)}억원`;
  if (abs >= 10_000) return `${(amount / 10_000).toFixed(abs % 10_000 === 0 || abs >= 1_000_000 ? 0 : 1)}만원`;
  return formatKRW(amount);
}

/** bps(1/100 %) 적용 금액. 원 단위 미만은 버림 */
export function applyBps(amount: number, bps: number): number {
  return Math.floor((amount * bps) / 10_000);
}

/** 550 → "5.5%", 374 → "3.74%", 1000 → "10%" (소수 둘째 자리까지, 끝의 0 은 뗀다) */
export function formatBps(bps: number): string {
  const pct = (bps / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${pct}%`;
}

/** 할인율(%) — 정가가 없거나 할인 아님이면 null */
export function discountPercent(price: number, originalPrice?: number | null): number | null {
  if (!originalPrice || originalPrice <= price) return null;
  return Math.round(((originalPrice - price) / originalPrice) * 100);
}
