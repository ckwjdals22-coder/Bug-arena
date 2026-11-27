/**
 * 시간 유틸 — 서비스의 모든 표시는 한국 표준시(KST, UTC+9, 서머타임 없음) 기준.
 * DB 에는 UTC 로 저장하고, 화면·날짜 경계 계산은 여기 함수만 사용한다.
 */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export interface KstParts {
  year: number;
  month: number; // 1~12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0(일)~6(토)
}

export function kstParts(date: Date): KstParts {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** KST 날짜·시각으로 Date 를 만든다. */
export function kstDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS);
}

/** "2026-11-27" + "19:30" (KST) → Date. 형식이 틀리면 null */
export function parseKst(dateStr: string, timeStr = "00:00"): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) return null;
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const result = kstDate(y, mo, d, h, mi);
  const check = kstParts(result);
  if (check.year !== y || check.month !== mo || check.day !== d) return null;
  return result;
}

/** KST 기준 그날 0시 */
export function startOfKstDay(date: Date): Date {
  const p = kstParts(date);
  return kstDate(p.year, p.month, p.day);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE);
}

/** "2026-11-27" */
export function kstDateKey(date: Date): string {
  const p = kstParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "19:30" */
export function fmtTime(date: Date): string {
  const p = kstParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** KST 기준 달력상 날짜 차이(오늘=0, 내일=1, 어제=-1) */
export function kstDayDiff(date: Date, now: Date = new Date()): number {
  return Math.round((startOfKstDay(date).getTime() - startOfKstDay(now).getTime()) / DAY);
}

/** "오늘" / "내일" / "모레" / "토요일" (7일 이내) / "12월 5일 (금)" */
export function fmtDayLabel(date: Date, now: Date = new Date()): string {
  const diff = kstDayDiff(date, now);
  const p = kstParts(date);
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff === 2) return "모레";
  if (diff > 2 && diff < 7) return `${WEEKDAYS[p.weekday]}요일`;
  return `${p.month}월 ${p.day}일 (${WEEKDAYS[p.weekday]})`;
}

/** "11월 27일 (금)" */
export function fmtDate(date: Date): string {
  const p = kstParts(date);
  return `${p.month}월 ${p.day}일 (${WEEKDAYS[p.weekday]})`;
}

/** "2026. 11. 27." */
export function fmtDateNumeric(date: Date): string {
  const p = kstParts(date);
  return `${p.year}. ${p.month}. ${p.day}.`;
}

/** "11월 27일 (금) 19:30" */
export function fmtDateTime(date: Date): string {
  return `${fmtDate(date)} ${fmtTime(date)}`;
}

/** "2026. 11. 27. 19:30" — 운영 화면용 */
export function fmtDateTimeNumeric(date: Date): string {
  return `${fmtDateNumeric(date)} ${fmtTime(date)}`;
}

/** "오늘 19:30" / "내일 14:00" / "12월 5일 (금) 18:00" */
export function fmtWhen(date: Date, now: Date = new Date()): string {
  return `${fmtDayLabel(date, now)} ${fmtTime(date)}`;
}

/** 90 → "1시간 30분", 120 → "2시간", 45 → "45분" */
export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/** 남은 시간: "3일", "5시간 20분", "42분", "곧 마감" (1분 미만), 지났으면 null */
export function fmtRemaining(target: Date, now: Date = new Date()): string | null {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return null;
  if (ms < MINUTE) return "곧 마감";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}분`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
  }
  return `${Math.floor(ms / DAY)}일`;
}

/** "방금 전" / "5분 전" / "3시간 전" / "2일 전" / 날짜 */
export function fmtAgo(date: Date, now: Date = new Date()): string {
  const ms = now.getTime() - date.getTime();
  if (ms < MINUTE) return "방금 전";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}분 전`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}시간 전`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}일 전`;
  return fmtDate(date);
}

/** KST 기준 하루 중 분(0~1439) */
export function kstMinuteOfDay(date: Date): number {
  const p = kstParts(date);
  return p.hour * 60 + p.minute;
}

/** 야간(21:00~08:00 KST) 여부 — 광고성 정보 전송 제한 시간대 */
export function isNightKst(date: Date = new Date()): boolean {
  const h = kstParts(date).hour;
  return h >= 21 || h < 8;
}

/** 이번 주말(토·일) 범위. 이미 주말이면 남은 주말 */
export function kstWeekendRange(now: Date = new Date()): { from: Date; to: Date } {
  const today = startOfKstDay(now);
  const wd = kstParts(now).weekday;
  if (wd === 0) return { from: today, to: addDays(today, 1) };
  const saturday = addDays(today, 6 - wd);
  return { from: wd === 6 ? today : saturday, to: addDays(saturday, 2) };
}

export function weekdayLabel(weekday: number): string {
  return WEEKDAYS[weekday] ?? "";
}
