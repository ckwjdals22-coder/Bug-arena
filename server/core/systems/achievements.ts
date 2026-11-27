/**
 * 황당한 업적 판정, 일일 수행/출석, 오늘의 계시(운세).
 *
 * - 업적: 통계가 바뀔 때(onStat) 그 통계를 보는 업적만 검사한다(통계별 색인). 입장 때(onJoin) 한 번 전부 다시 본다
 *   — 저장본이 쓰인 뒤에 콘텐츠에 새 업적이 생겼을 수 있어서다.
 * - 일일 수행: 서버 시각 기준 KST(UTC+9) 날짜. 퀘스트는 '오늘 생긴 통계 증가량'만 센다.
 *   통계 값 자체가 아니라 증가량을 세야 어제까지 쌓인 값이나 연속 기록 초기화(값이 내려감)에 휘둘리지 않는다.
 * - 연속 출석: 하루를 건너뛴 것까지는 봐준다(하루 유예). 끊겼다고 0으로 만드는 압박 장치는 피한다.
 * - 클라이언트는 진행도(daily)를 저장본(save, 최대 1초 간격)으로 받는다. 따로 메시지를 만들지 않는다.
 * - 전송 계층과 무관: Date.now()/Math.random()/타이머 없이 room.now() 와 onTick 만 쓴다.
 */
import { ACHIEVEMENTS, DAILY_QUESTS, DAILY_QUEST_BY_ID, DAILY_QUEST_COUNT } from '../../../shared/content/achievements'
import { STAT } from '../../../shared/content/core'
import { PROPHECIES } from '../../../shared/content/prophecies'
import type { AchievementDef } from '../../../shared/content/types'
import type { ClientMsg } from '../../../shared/protocol'
import type { DailyState } from '../../../shared/types'
import type { PlayerState, RoomApi, RoomSystem } from '../api'

export const KST_OFFSET_MS = 9 * 3600_000
export const DAY_MS = 86_400_000
/** 자정 넘김 검사 주기 */
const ROLL_CHECK_MS = 60_000
/** 모든 수행을 끝낸 날 한 번 더 주는 보너스 */
export const DAILY_BONUS = { inf: 20, coins: 5 } as const
/** 보상 받기 연타 방지 */
const CLAIM_COOLDOWN_MS = 250

/** p.ext 키(시스템 이름으로 시작) */
const EXT_SNAP = 'achievements.snap'
const EXT_DAYNUM = 'achievements.dayNum'
const EXT_PENDING_DAY = 'achievements.newDay'

/** epoch ms → KST 날짜 번호(1970-01-01 KST = 0) */
export function kstDayNumber(now: number): number {
  return Math.floor((now + KST_OFFSET_MS) / DAY_MS)
}

/** KST 날짜 번호 → 'YYYY-MM-DD' */
export function dayKeyOf(dayNum: number): string {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10)
}

/** epoch ms → KST 날짜 키 'YYYY-MM-DD' */
export function kstDayKey(now: number): string {
  return dayKeyOf(kstDayNumber(now))
}

/** 'YYYY-MM-DD' → 날짜 번호. 형식이 아니면 NaN */
export function dayNumberOfKey(key: unknown): number {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN
  const t = Date.parse(key + 'T00:00:00Z')
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : NaN
}

/** FNV-1a 32비트. 저장본에 남는 결정(퀘스트·운세)이라 플랫폼과 무관하게 같은 값이 나와야 한다 */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** pid+날짜로 정해지는 오늘의 수행(서로 다른 DAILY_QUEST_COUNT 개) */
export function pickDailyQuests(pid: string, day: string): string[] {
  const ids = DAILY_QUESTS.map((q) => q.id)
  // xorshift32 로 앞에서부터 부분 셔플 → 같은 입력이면 같은 결과, 중복 없음
  let s = hash32(pid + day) || 0x9e3779b9
  const n = Math.min(DAILY_QUEST_COUNT, ids.length)
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    const j = i + (s % (ids.length - i))
    const tmp = ids[i] as string
    ids[i] = ids[j] as string
    ids[j] = tmp
  }
  return ids.slice(0, n)
}

export function fortuneOf(pid: string, day: string): number {
  return PROPHECIES.length > 0 ? hash32(pid + ':f:' + day) % PROPHECIES.length : 0
}

/**
 * 이전 기록으로 오늘의 연속 출석 일수를 정한다.
 * 어제 왔으면 +1, 하루 건너뛰었으면 그대로(유예), 그보다 오래됐으면 1부터.
 */
export function nextStreak(prev: DailyState | null, todayNum: number): number {
  if (!prev) return 1
  const prevNum = dayNumberOfKey(prev.day)
  const streak = Math.max(1, Math.floor(prev.streak) || 1)
  if (!Number.isFinite(prevNum)) return 1
  const gap = todayNum - prevNum
  if (gap === 1) return streak + 1
  if (gap === 2) return streak
  // 시계가 거꾸로 간 경우(gap ≤ 0)는 손해 보지 않게 그대로 둔다
  if (gap <= 0) return streak
  return 1
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 저장본의 daily 는 normalizeProgress 가 모양을 보지 않고 넘긴다(서명은 있지만 옛 버전/콘텐츠 변경 대비).
 * 알 수 없는 퀘스트, 범위를 벗어난 숫자를 걸러 낸다. 날짜가 형식이 아니면 null.
 */
export function sanitizeDaily(raw: unknown): DailyState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Number.isFinite(dayNumberOfKey(r.day))) return null
  const quests: string[] = []
  if (Array.isArray(r.quests)) {
    for (const q of r.quests) {
      if (typeof q === 'string' && DAILY_QUEST_BY_ID.has(q) && !quests.includes(q)) quests.push(q)
    }
  }
  const prog: Record<string, number> = {}
  const rp = r.prog && typeof r.prog === 'object' ? (r.prog as Record<string, unknown>) : {}
  for (const q of quests) {
    const v = rp[q]
    const def = DAILY_QUEST_BY_ID.get(q)
    if (def && isNum(v) && v > 0) prog[q] = Math.min(def.n, Math.floor(v))
  }
  const done: string[] = []
  if (Array.isArray(r.done)) for (const q of r.done) if (typeof q === 'string' && quests.includes(q) && !done.includes(q)) done.push(q)
  const streak = isNum(r.streak) ? Math.max(1, Math.min(100_000, Math.floor(r.streak))) : 1
  const fortune = isNum(r.fortune) && r.fortune >= 0 && r.fortune < PROPHECIES.length ? Math.floor(r.fortune) : 0
  return { day: r.day as string, quests, prog, done, streak, fortune }
}

export function createAchievementsSystem(): RoomSystem {
  let room: RoomApi
  /** 마지막 자정 넘김 검사 시각. dt 는 상한이 걸려 있으므로(멈췄다 깬 프로세스) 시각으로 잰다 */
  let lastRollCheck = -Infinity

  /** 통계 키 → 그 통계를 보는 업적(문턱 오름차순) */
  const byStat = new Map<string, AchievementDef[]>()
  for (const a of ACHIEVEMENTS) {
    let list = byStat.get(a.stat)
    if (!list) byStat.set(a.stat, (list = []))
    list.push(a)
  }
  for (const list of byStat.values()) list.sort((a, b) => a.gte - b.gte)

  function checkStat(p: PlayerState, stat: string, value: number): void {
    const list = byStat.get(stat)
    if (!list) return
    for (const a of list) {
      if (value < a.gte) break
      if (!p.prog.ach.includes(a.id)) room.unlockAchievement(p, a.id)
    }
  }

  function snapOf(p: PlayerState): Record<string, number> {
    let snap = p.ext[EXT_SNAP] as Record<string, number> | undefined
    if (!snap) p.ext[EXT_SNAP] = snap = { ...p.prog.stats }
    return snap
  }

  /**
   * 오늘 날짜의 DailyState 를 보장한다. 날이 바뀌었으면 새로 만든다.
   * bumpDays=false 는 welcome 직전용: 그때 통계를 올리면 업적 보상이 welcome 보다 먼저 나가 버린다.
   * 새로 만들었으면 true.
   */
  function ensureDaily(p: PlayerState, now: number, bumpDays: boolean): boolean {
    const todayNum = kstDayNumber(now)
    if (p.ext[EXT_DAYNUM] === todayNum && p.prog.daily) return false
    p.ext[EXT_DAYNUM] = todayNum
    const today = dayKeyOf(todayNum)
    const prev = sanitizeDaily(p.prog.daily)
    if (prev && prev.day === today) {
      p.prog.daily = prev
      return false
    }
    p.prog.daily = {
      day: today,
      quests: pickDailyQuests(p.pid, today),
      prog: {},
      done: [],
      streak: nextStreak(prev, todayNum),
      fortune: fortuneOf(p.pid, today),
    }
    room.markSave(p)
    if (bumpDays) room.bump(p, STAT.days)
    else p.ext[EXT_PENDING_DAY] = true
    return true
  }

  function addProgress(p: PlayerState, stat: string, delta: number): void {
    const d = p.prog.daily
    if (!d) return
    let changed = false
    for (const id of d.quests) {
      const def = DAILY_QUEST_BY_ID.get(id)
      if (!def || def.stat !== stat || d.done.includes(id)) continue
      const cur = d.prog[id] ?? 0
      const next = Math.min(def.n, cur + delta)
      if (next !== cur) {
        d.prog[id] = next
        changed = true
      }
    }
    if (changed) room.markSave(p)
  }

  function claim(p: PlayerState, q: unknown): void {
    const fail = (msg: string): void => room.send(p, { t: 'err', code: 'daily', msg })
    if (typeof q !== 'string' || q.length === 0 || q.length > 32) return fail('알 수 없는 수행이에요.')
    if (room.cooldown(p, 'achievements.claim', CLAIM_COOLDOWN_MS) > 0) return
    ensureDaily(p, room.now(), true)
    const d = p.prog.daily
    const def = DAILY_QUEST_BY_ID.get(q)
    if (!d || !def || !d.quests.includes(q)) return fail('오늘의 수행이 아니에요.')
    if (d.done.includes(q)) return fail('이미 받은 보상이에요.')
    if ((d.prog[q] ?? 0) < def.n) return fail('아직 수행을 다 마치지 않았어요.')
    d.done.push(q)
    room.markSave(p)
    room.grant(p, { why: 'daily', inf: def.inf })
    // 퀘스트 목록이 비어 있는(콘텐츠가 바뀐) 날은 보너스도 없다
    if (d.quests.length > 0 && d.quests.every((id) => d.done.includes(id))) {
      room.grant(p, { why: 'daily', inf: DAILY_BONUS.inf, coins: DAILY_BONUS.coins })
    }
  }

  return {
    name: 'achievements',
    handles: ['daily'],

    init(r) {
      room = r
    },

    onWelcome(p) {
      // welcome 에 오늘의 수행이 실려 가도록 여기서 날짜를 맞춘다(통계 증가는 onJoin 에서)
      snapOf(p)
      ensureDaily(p, room.now(), false)
    },

    onJoin(p) {
      snapOf(p)
      ensureDaily(p, room.now(), true)
      if (p.ext[EXT_PENDING_DAY]) {
        delete p.ext[EXT_PENDING_DAY]
        room.bump(p, STAT.days)
      }
      // 저장 뒤 새로 생긴 업적(또는 문턱이 내려간 업적) 따라잡기
      for (const [stat, list] of byStat) {
        const v = p.prog.stats[stat] ?? 0
        if (list[0] && v >= list[0].gte) checkStat(p, stat, v)
      }
    },

    onStat(p, stat, value) {
      const snap = snapOf(p)
      const prev = snap[stat] ?? 0
      snap[stat] = value
      // 자정을 넘긴 직후의 증가는 새 날에 센다(분 단위 검사를 기다리지 않음)
      if (stat !== STAT.days) ensureDaily(p, room.now(), true)
      const delta = value - prev
      if (delta > 0) addProgress(p, stat, delta)
      checkStat(p, stat, value)
    },

    onMessage(p, msg: ClientMsg) {
      if (msg.t === 'daily') claim(p, (msg as { q?: unknown }).q)
    },

    onTick(now) {
      if (now - lastRollCheck < ROLL_CHECK_MS && now >= lastRollCheck) return
      lastRollCheck = now
      for (const p of room.players.values()) ensureDaily(p, now, true)
    },

    onLeave(p) {
      delete p.ext[EXT_SNAP]
      delete p.ext[EXT_DAYNUM]
      delete p.ext[EXT_PENDING_DAY]
    },
  }
}
