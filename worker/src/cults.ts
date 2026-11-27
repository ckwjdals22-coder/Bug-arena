/**
 * 교단 기록(CultRegistry)을 여러 방 DO 사이에서 나눠 쓰기.
 *
 * 문제: 코어의 CultRegistry 는 동기 인터페이스인데, 방(DO)끼리 공유하는 기록은 로비 DO 에 있고 RPC 는 비동기다.
 * 해법: 방 DO 마다 '사본(CultCache)'을 들고 동기로 답한다.
 *   - record/remove 는 사본에 바로 반영하고 작업(op)으로 쌓아 둔다 → 다음 로비 보고에 실어 보낸다.
 *   - 로비는 op 를 적용하고 행마다 증가하는 seq 를 매긴다. 방은 마지막으로 받은 seq 이후의 변경분만 받는다
 *     (교단이 수천 개여도 보고마다 전체를 주고받지 않게).
 * 한계(문서에 적음): 다른 방에서 막 만든 교단 이름은 다음 동기화(최대 ~10초) 전까지 nameTaken 에 안 잡힐 수 있다.
 *
 * 기록 규칙은 Node 어댑터(server/node/main.ts 의 createCultRegistry)와 같다.
 */
import type { CultScore } from '../../shared/types'
import type { CultRegistry } from '../../server/core/api'

export const MAX_CULTS = 5000

/** online 은 방마다 다르고 저장하지 않는 값이라 빼고 다룬다 */
export type CultRow = Omit<CultScore, 'online'>
export type CultInfo = Omit<CultScore, 'online' | 'fol' | 'inf'>

export type CultOp = { k: 'rec'; cult: CultInfo; fol: number; inf: number } | { k: 'del'; id: string }

export interface CultSync {
  /** true 면 받는 쪽은 사본을 비우고 rows 로 새로 채운다 */
  full: boolean
  rows: CultRow[]
  removed: string[]
  seq: number
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1e12, Math.floor(v))) : 0)
/** 띄어쓰기·대소문자만 다른 이름은 같은 이름으로 본다 */
const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, '')

/** RPC 로 들어온 값을 믿지 않고 다듬는다(방 DO 도 우리 코드지만, 버전이 잠깐 어긋날 수 있다) */
export function cleanRow(r: unknown): CultRow | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const id = str(o.id, 80)
  const name = str(o.name, 40)
  if (!id || !name) return null
  return {
    id,
    name,
    color: int(o.color),
    emblem: int(o.emblem),
    leaderName: str(o.leaderName, 40),
    title: str(o.title, 40),
    fol: int(o.fol),
    inf: int(o.inf),
  }
}

/**
 * op 하나를 표에 적용한다. 바뀐 id 와 (자리가 없어) 밀려난 id 를 돌려준다.
 * Node 판과 같은 규칙: 없으면 만들고, 가득이면 영향력이 가장 낮은 기록을 내보낸다. 칭호·교주 이름이 비어 오면 기존 값 유지.
 */
export function applyOp(map: Map<string, CultRow>, op: CultOp): { changed: string | null; evicted: string | null } {
  if (op.k === 'del') {
    const id = str(op.id, 80)
    return { changed: null, evicted: id && map.delete(id) ? id : null }
  }
  const c = op.cult
  const id = str(c?.id, 80)
  const name = str(c?.name, 40)
  if (!id || !name) return { changed: null, evicted: null }
  let evicted: string | null = null
  let entry = map.get(id)
  if (!entry) {
    if (map.size >= MAX_CULTS) {
      let lowest: CultRow | undefined
      for (const e of map.values()) if (!lowest || e.inf < lowest.inf) lowest = e
      if (lowest) {
        map.delete(lowest.id)
        evicted = lowest.id
      }
    }
    entry = { id, name, color: 0, emblem: 0, leaderName: '', title: '', fol: 0, inf: 0 }
    map.set(id, entry)
  }
  entry.name = name
  entry.color = int(c.color)
  entry.emblem = int(c.emblem)
  entry.leaderName = str(c.leaderName, 40) || entry.leaderName
  entry.title = str(c.title, 40) || entry.title
  entry.fol = int(entry.fol + int(op.fol))
  entry.inf = int(entry.inf + int(op.inf))
  return { changed: id, evicted }
}

const toScore = (c: CultRow): CultScore => ({ ...c, online: 0 })

/** 방 DO 가 들고 있는 사본. RoomHost.cults 로 코어에 넘긴다 */
export class CultCache implements CultRegistry {
  private readonly map = new Map<string, CultRow>()
  /** 아직 로비에 보내지 않은 작업 */
  private queue: CultOp[] = []
  /** 보냈지만 응답을 못 받은 작업(실패하면 다시 보낸다) */
  private inflight: CultOp[] = []
  /** 마지막으로 받은 로비 seq */
  seq = 0
  private sorted: CultRow[] = []
  private sortedDirty = true

  record(cult: CultInfo, delta: { fol: number; inf: number }): void {
    const op: CultOp = { k: 'rec', cult: { ...cult }, fol: int(delta.fol), inf: int(delta.inf) }
    if (applyOp(this.map, op).changed) {
      this.sortedDirty = true
      this.enqueue(op)
    }
  }

  nameTaken(name: string, exceptId: string): boolean {
    const key = nameKey(String(name))
    for (const c of this.map.values()) if (c.id !== exceptId && nameKey(c.name) === key) return true
    return false
  }

  get(id: string): CultScore | undefined {
    const c = this.map.get(id)
    return c ? toScore(c) : undefined
  }

  top(n: number): CultScore[] {
    if (this.sortedDirty) {
      this.sorted = [...this.map.values()].sort((a, b) => b.inf - a.inf || b.fol - a.fol || a.name.localeCompare(b.name, 'ko'))
      this.sortedDirty = false
    }
    return this.sorted.slice(0, Math.max(0, Math.floor(n))).map(toScore)
  }

  remove(id: string): void {
    if (this.map.delete(id)) this.sortedDirty = true
    this.enqueue({ k: 'del', id })
  }

  get pendingOps(): number {
    return this.queue.length
  }

  /** 로비 보고에 실을 작업을 꺼낸다 */
  take(): CultOp[] {
    this.inflight = this.queue
    this.queue = []
    return this.inflight
  }

  /** 보고가 실패했으면 보냈던 작업을 다시 앞에 붙인다 */
  failed(): void {
    this.queue = [...this.inflight, ...this.queue]
    this.inflight = []
    if (this.queue.length > 2000) this.queue = this.queue.slice(-2000)
  }

  /** 로비 응답 반영. 로비는 보낸 작업을 먼저 적용한 뒤 변경분을 주므로, 그 뒤에 새로 쌓인 작업만 다시 얹으면 된다 */
  applySync(sync: CultSync): void {
    this.inflight = []
    if (sync.full) this.map.clear()
    for (const id of sync.removed) this.map.delete(id)
    for (const raw of sync.rows) {
      const row = cleanRow(raw)
      if (row) this.map.set(row.id, row)
    }
    for (const op of this.queue) applyOp(this.map, op)
    this.seq = sync.seq
    this.sortedDirty = true
  }

  private enqueue(op: CultOp): void {
    // 같은 교단의 기록은 하나로 합친다(포교 한 번마다 op 가 쌓이지 않게)
    if (op.k === 'rec') {
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const q = this.queue[i]!
        if (q.k === 'del' && q.id === op.cult.id) break
        if (q.k === 'rec' && q.cult.id === op.cult.id) {
          q.cult = op.cult
          q.fol = int(q.fol + op.fol)
          q.inf = int(q.inf + op.inf)
          return
        }
      }
    }
    this.queue.push(op)
    if (this.queue.length > 2000) this.queue.shift()
  }
}

/** 로비 DO 쪽 원본. SQLite 에 한 줄씩 저장하고, 행마다 seq 를 매겨 변경분 동기화를 한다 */
export class CultStore {
  private readonly map = new Map<string, CultRow>()
  private readonly rowSeq = new Map<string, number>()
  /** 지워진 교단: id → seq (변경분으로 알려 주려고 잠깐 기억) */
  private readonly tomb = new Map<string, number>()
  private seq = 0
  /** 이 seq 보다 오래된 사본은 지운 기록을 놓쳤을 수 있으므로 전체를 다시 준다 */
  private minSeq = 0

  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS cults (id TEXT PRIMARY KEY, name TEXT NOT NULL, color INTEGER, emblem INTEGER, leader TEXT, title TEXT, fol INTEGER, inf INTEGER, seq INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0)',
    )
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)')
    for (const m of sql.exec<{ k: string; v: number }>('SELECT k, v FROM meta')) {
      if (m.k === 'minSeq') this.minSeq = m.v
    }
    type Db = { id: string; name: string; color: number; emblem: number; leader: string; title: string; fol: number; inf: number; seq: number; del: number }
    for (const r of sql.exec<Db>('SELECT id, name, color, emblem, leader, title, fol, inf, seq, del FROM cults')) {
      if (r.seq > this.seq) this.seq = r.seq
      if (r.del) {
        this.tomb.set(r.id, r.seq)
        continue
      }
      const row = cleanRow({ ...r, leaderName: r.leader })
      if (!row) continue
      this.map.set(row.id, row)
      this.rowSeq.set(row.id, r.seq)
    }
    if (this.minSeq > this.seq) this.seq = this.minSeq
  }

  get size(): number {
    return this.map.size
  }

  apply(ops: readonly CultOp[]): void {
    let n = 0
    for (const raw of ops) {
      // 한 번의 보고에 실을 수 있는 양에 상한(망가진 방이 로비를 붙잡지 않게)
      if (++n > 2000) break
      const op = cleanOp(raw)
      if (!op) continue
      // del 작업도 applyOp 가 evicted 로 돌려주므로 같은 길로 묘비를 남긴다
      const { changed, evicted } = applyOp(this.map, op)
      if (evicted) this.markDeleted(evicted)
      if (changed) this.write(changed)
    }
    this.purgeTombs()
  }

  /** since 이후의 변경분 */
  since(since: number): CultSync {
    if (!(since >= this.minSeq) || since > this.seq) {
      return { full: true, rows: [...this.map.values()], removed: [], seq: this.seq }
    }
    const rows: CultRow[] = []
    for (const [id, s] of this.rowSeq) {
      if (s > since) {
        const r = this.map.get(id)
        if (r) rows.push(r)
      }
    }
    const removed: string[] = []
    for (const [id, s] of this.tomb) if (s > since) removed.push(id)
    return { full: false, rows, removed, seq: this.seq }
  }

  top(n: number): CultRow[] {
    return [...this.map.values()].sort((a, b) => b.inf - a.inf || b.fol - a.fol).slice(0, n)
  }

  private write(id: string): void {
    const r = this.map.get(id)
    if (!r) return
    const s = ++this.seq
    this.rowSeq.set(id, s)
    this.tomb.delete(id)
    this.sql.exec(
      'INSERT INTO cults (id, name, color, emblem, leader, title, fol, inf, seq, del) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, emblem = excluded.emblem, leader = excluded.leader, title = excluded.title, fol = excluded.fol, inf = excluded.inf, seq = excluded.seq, del = 0',
      r.id,
      r.name,
      r.color,
      r.emblem,
      r.leaderName,
      r.title,
      r.fol,
      r.inf,
      s,
    )
  }

  private markDeleted(id: string): void {
    this.map.delete(id)
    this.rowSeq.delete(id)
    const s = ++this.seq
    this.tomb.set(id, s)
    this.sql.exec('UPDATE cults SET del = 1, seq = ? WHERE id = ?', s, id)
  }

  /** 묘비가 너무 쌓이면 지우고, 그보다 오래된 사본에게는 전체를 다시 주게 한다 */
  private purgeTombs(): void {
    if (this.tomb.size <= 1000) return
    this.tomb.clear()
    this.minSeq = this.seq
    this.sql.exec('DELETE FROM cults WHERE del = 1')
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('minSeq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", this.minSeq)
  }
}

function cleanOp(raw: unknown): CultOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.k === 'del') {
    const id = str(o.id, 80)
    return id ? { k: 'del', id } : null
  }
  if (o.k !== 'rec') return null
  const row = cleanRow({ ...(o.cult as object), fol: 0, inf: 0 })
  if (!row) return null
  const { fol: _f, inf: _i, ...cult } = row
  return { k: 'rec', cult, fol: int(o.fol), inf: int(o.inf) }
}
