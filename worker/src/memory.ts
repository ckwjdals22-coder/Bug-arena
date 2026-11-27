/**
 * 접속자 메모(PlayerMemory: 쿨타임·차단·입막음·이름 고정·마지막 자리)를 Durable Object 저장소에 남기고 되살리는 규칙.
 *
 * 왜 필요한가: Node 판은 프로세스 하나가 모든 방의 메모를 들고 있다. Workers 판은 방마다 DO 가 따로이고,
 * 사람이 없으면 DO 가 메모리에서 내려간다(수십 초~수 분 뒤). 메모를 저장하지 않으면 '나갔다가 조금 뒤 다시 들어오기'로
 * 신고 입막음·이름 고정·초대/배틀 쿨타임·시민 거절 기억이 모두 풀린다.
 *
 * 한계(문서에도 적는다): 이 어댑터의 메모는 '방 단위'다. 다른 방으로 옮기면 그 방의 메모가 따로 적용된다.
 *
 * 이 파일은 Workers 전용 API 를 쓰지 않는다(루트의 vitest 로 단위 테스트한다).
 */
import type { LastSeat, PlayerMemory } from '../../server/core/api'
import type { Progress } from '../../shared/types'

/** DO storage 키 */
export const MEMORY_KEY = 'playerMemory.v1'
/** 한 방에서 저장해 둘 메모 수 상한(가장 오래 남는 것부터 남긴다). 값 하나 2MB 제한 안에 넉넉히 든다 */
export const MEMORY_SAVE_MAX = 3000
/** 직렬화 결과가 이보다 크면 뒤쪽(곧 만료될 것)부터 잘라 낸다 */
export const MEMORY_SAVE_MAX_BYTES = 1_500_000
/** 접속 중인 사람의 메모를 저장할 때, 나갈 때 남기는 것과 같은 정도로 둔다(자리·신도 복귀 시간) */
const LIVE_KEEP_MS = 5 * 60_000
const BLOCK_KEEP_MS = 6 * 60 * 60_000

interface StoredMemory {
  cd: [string, number][]
  blocked: string[]
  mutedUntil: number
  nameLockUntil: number
  lockedName: string
  keepUntil: number
  last?: LastSeat
  /** 나가는 순간 아직 클라이언트에 못 내려보낸 진행도(60초 인계). DO 가 그사이 내려가도 마지막 보상을 잃지 않게 같이 남긴다 */
  prog?: Progress
  progUntil?: number
}

export type StoredMemoryMap = Record<string, StoredMemory>

/** 지금 방에 있는 사람의 최신 값(입막음·이름 고정은 나갈 때에야 메모에 옮겨 적히므로 사람에게서 직접 읽는다) */
export interface LiveView {
  mutedUntil: number
  nameLockUntil: number
  name: string
}

/**
 * 메모 표 → 저장할 모양. 이미 끝난 쿨타임·만료된 메모는 버린다.
 * live(pid) 가 값을 주면 그 사람은 지금 접속 중이므로 그 값을 쓴다.
 */
export function serializeMemory(map: Map<string, PlayerMemory>, now: number, live: (pid: string) => LiveView | undefined): StoredMemoryMap {
  const rows: [string, StoredMemory][] = []
  for (const [pid, mem] of map) {
    const cur = mem.live ? live(pid) : undefined
    const mutedUntil = cur ? cur.mutedUntil : mem.mutedUntil
    const nameLockUntil = cur ? cur.nameLockUntil : mem.nameLockUntil
    const lockedName = cur ? (cur.nameLockUntil > now ? cur.name : '') : mem.lockedName
    const cd: [string, number][] = []
    let keep = Math.max(mutedUntil, nameLockUntil)
    for (const [k, until] of mem.cd) {
      if (until > now) {
        cd.push([k, until])
        if (until > keep) keep = until
      }
    }
    if (mem.live) {
      // 접속 중: 나갈 때 코어(stash)가 정할 보관 기한을 미리 어림한다(그 전에 DO 가 내려가도 잃지 않게)
      keep = Math.max(keep, now + LIVE_KEEP_MS)
      if (mem.blocked.size > 0) keep = Math.max(keep, now + BLOCK_KEEP_MS)
    } else {
      // 나간 사람: 코어가 이미 계산해 둔 기한(차단·자리 기억 포함)
      keep = Math.max(keep, mem.keepUntil)
    }
    if (keep <= now) continue
    const row: StoredMemory = { cd, blocked: [...mem.blocked], mutedUntil, nameLockUntil, lockedName, keepUntil: keep }
    if (mem.last) row.last = mem.last
    if (mem.prog && (mem.progUntil ?? 0) > now) {
      row.prog = mem.prog
      row.progUntil = mem.progUntil
    }
    rows.push([pid, row])
  }
  // 오래 남을 것부터: 상한에 걸리면 곧 만료될 메모를 버린다
  rows.sort((a, b) => b[1].keepUntil - a[1].keepUntil)
  const out: StoredMemoryMap = {}
  let bytes = 2
  let n = 0
  for (const [pid, row] of rows) {
    if (n >= MEMORY_SAVE_MAX) break
    const size = pid.length + JSON.stringify(row).length + 4
    if (bytes + size > MEMORY_SAVE_MAX_BYTES) break
    out[pid] = row
    bytes += size
    n++
  }
  return out
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strv = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * 저장본 → 메모 표에 채운다(DO 가 깨어날 때). 이미 있는 pid(깨어난 뒤 먼저 들어온 사람)는 건드리지 않는다.
 * 저장본은 우리가 쓴 것이지만, 모양이 이상하면 그 항목만 버린다(방이 열리지 않는 것보다 낫다).
 */
export function restoreMemory(map: Map<string, PlayerMemory>, stored: unknown, now: number): number {
  if (!stored || typeof stored !== 'object') return 0
  let n = 0
  for (const [pid, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (map.has(pid) || !raw || typeof raw !== 'object') continue
    const r = raw as Partial<StoredMemory>
    const keepUntil = num(r.keepUntil)
    if (keepUntil <= now) continue
    const cd = new Map<string, number>()
    if (Array.isArray(r.cd)) {
      for (const pair of r.cd) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
        const until = num(pair[1])
        if (until > now) cd.set(pair[0], until)
      }
    }
    const blocked = new Set<string>(Array.isArray(r.blocked) ? r.blocked.filter((x): x is string => typeof x === 'string') : [])
    const mem: PlayerMemory = {
      cd,
      blocked,
      mutedUntil: num(r.mutedUntil),
      nameLockUntil: num(r.nameLockUntil),
      lockedName: strv(r.lockedName, 40),
      // 깨어난 직후에는 아무도 접속해 있지 않다
      live: false,
      keepUntil,
    }
    if (r.last && typeof r.last === 'object') mem.last = r.last as LastSeat
    // 인계할 진행도: 주인이 맞고 아직 기한 안일 때만(코어가 꺼내 쓸 때 normalizeProgress 로 값 범위를 다시 거른다)
    const progUntil = num(r.progUntil)
    if (progUntil > now && r.prog && typeof r.prog === 'object' && (r.prog as { pid?: unknown }).pid === pid) {
      mem.prog = r.prog
      mem.progUntil = progUntil
    }
    map.set(pid, mem)
    n++
  }
  return n
}
