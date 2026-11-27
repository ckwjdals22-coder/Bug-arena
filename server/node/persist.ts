/**
 * Node 어댑터의 디스크 저장: DATA_DIR 점검·잠금, 저장 서명 비밀키, 교단 기록(cults.json).
 *
 * 원칙: 저장이 안 되는 상태로 '조용히' 돌지 않는다. 비밀키를 남기지 못하면 재시작마다 모든 이용자의 진행도가
 * 무효가 되고, 교단 기록을 쓰지 못하면 순위가 사라진다 → 부팅 때는 한 줄로 이유를 말하고 종료(PersistFatal),
 * 돌던 중에 실패하면 /healthz 가 503 으로 알린다(PersistStatus).
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CultScore } from '../../shared/types'
import type { CultRegistry } from '../core/api'
import type { LogLevel } from './ops'

type Log = (level: LogLevel, msg: string, extra?: unknown) => void

/** 부팅을 계속하면 안 되는 저장 문제. main 이 메시지 한 줄을 남기고 exit 1 한다 */
export class PersistFatal extends Error {
  override readonly name = 'PersistFatal'
}

/** /healthz 에 그대로 실리는 저장 상태 */
export interface PersistStatus {
  ok: boolean
  /** 교단 기록을 마지막으로 디스크에 쓴 시각(ms, 없으면 0) */
  lastCultSaveAt: number
  /** 마지막 실패 사유(성공하면 비운다) */
  lastError: string | null
}

export function newPersistStatus(): PersistStatus {
  return { ok: true, lastCultSaveAt: 0, lastError: null }
}

const errText = (err: unknown): string => {
  const e = err as NodeJS.ErrnoException
  if (!e || typeof e !== 'object' || !('message' in e)) return String(err)
  // fs 오류는 메시지가 이미 코드로 시작한다(ENOTDIR: not a directory, …)
  return e.code && !e.message.startsWith(e.code) ? `${e.code}: ${e.message}` : e.message
}

// ───────────────────────── DATA_DIR 점검 ─────────────────────────

/**
 * 폴더를 만들고 실제로 '임시 파일 쓰기 → 이름 바꾸기 → 지우기'가 되는지 확인한다(저장과 같은 동작).
 * 흔한 실패: Docker 볼륨이 root 소유인데 이미지가 node 사용자로 돈다, 읽기 전용 디스크, 경로 중간이 파일.
 */
export function probeDataDir(dir: string): void {
  const probe = path.join(dir, `.probe-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(`${probe}.tmp`, 'ok')
    fs.renameSync(`${probe}.tmp`, probe)
    fs.unlinkSync(probe)
  } catch (err) {
    try {
      fs.rmSync(`${probe}.tmp`, { force: true })
    } catch {
      /* 지울 수 없으면 그대로 둔다 */
    }
    throw new PersistFatal(`DATA_DIR(${dir})에 쓸 수 없습니다 — ${errText(err)}. 폴더 권한·볼륨 마운트를 확인하세요`)
  }
}

// ───────────────────────── 잠금 ─────────────────────────

/** 이만큼 갱신되지 않은 잠금은 주인이 죽은 것으로 본다(살아 있는 서버는 LOCK_REFRESH 마다 갱신한다) */
export const LOCK_STALE_MS = 90_000

interface LockInfo {
  pid: number
  host: string
  startedAt: number
}

export interface DataLock {
  readonly file: string
  /** 살아 있다는 표시(mtime 갱신). 실패하면 예외 */
  refresh(): void
  /** 내 잠금일 때만 지운다 */
  release(): void
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 살아 있지만 다른 사용자의 프로세스
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 같은 DATA_DIR 을 두 프로세스가 쓰면 서로의 교단 기록을 덮어쓴다(각자 자기 메모리 사본을 통째로 쓰므로).
 * 그래서 부팅 때 잠금 파일을 만든다. 이미 있으면 다음을 모두 만족할 때만 '다른 서버가 쓰는 중'으로 본다:
 *   - 최근 LOCK_STALE_MS 안에 갱신됐다(죽은 프로세스의 잠금은 갱신이 멈춘다),
 *   - 다른 기계(컨테이너)의 것이거나, 같은 기계에서 살아 있는 다른 pid 다.
 * Docker 컨테이너를 재시작하면 pid 가 또 1 이므로 '내 pid 와 같음'은 남은 잠금으로 본다.
 */
export function acquireDataLock(dir: string, now: () => number = Date.now): DataLock {
  const file = path.join(dir, 'server.lock')
  const me: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: now() }
  const body = `${JSON.stringify(me)}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o644 })
      return makeLock(file, me, body)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new PersistFatal(`잠금 파일 ${file} 을 만들 수 없습니다 — ${errText(err)}`)
      }
    }
    let other: Partial<LockInfo> = {}
    let mtime = 0
    try {
      other = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>
      mtime = fs.statSync(file).mtimeMs
    } catch {
      // 읽을 수 없거나 깨진 잠금(쓰는 도중 죽었다) → 남은 잠금으로 본다
    }
    const fresh = now() - mtime < LOCK_STALE_MS
    const sameHost = other.host === me.host
    const otherPid = Number(other.pid)
    const busy = fresh && (!sameHost || (otherPid !== process.pid && pidAlive(otherPid)))
    if (busy) {
      throw new PersistFatal(
        `다른 서버 프로세스가 DATA_DIR(${dir})를 쓰고 있습니다(pid ${other.pid ?? '?'}, ${other.host ?? '?'}). ` +
          '한 DATA_DIR 에는 서버 하나만 띄우세요. 그 프로세스가 이미 죽었다면 ' +
          `${Math.round(LOCK_STALE_MS / 1000)}초 뒤 다시 시도하거나 ${file} 을 지우세요`,
      )
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* 다른 프로세스가 먼저 지웠다: 다시 시도 */
    }
  }
  throw new PersistFatal(`잠금 파일 ${file} 을 차지하지 못했습니다(동시에 다른 서버가 뜨는 중일 수 있습니다)`)
}

function makeLock(file: string, me: LockInfo, body: string): DataLock {
  let released = false
  const mine = (cur: Partial<LockInfo>): boolean => cur.pid === me.pid && cur.host === me.host && cur.startedAt === me.startedAt
  return {
    file,
    refresh() {
      if (released) return
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        // 잠금 파일이 사라졌다(디스크가 잠깐 빠졌다 돌아왔거나 누가 지웠다): 다시 만든다.
        // 예전에는 여기서 영영 실패해 디스크가 돌아온 뒤에도 /healthz 가 503 에 머물렀다.
        // wx: 그 찰나에 다른 서버가 차지했다면 덮어쓰지 않고 실패한다(다음 확인에서 '남의 잠금'으로 드러난다)
        fs.writeFileSync(file, body, { flag: 'wx', mode: 0o644 })
        return
      }
      let cur: Partial<LockInfo> | null = null
      try {
        cur = JSON.parse(text) as Partial<LockInfo>
      } catch {
        cur = null
      }
      if (cur === null || typeof cur !== 'object') {
        // 깨진 잠금(쓰다 만 파일): 내 것으로 다시 쓴다
        fs.writeFileSync(file, body, { mode: 0o644 })
        return
      }
      if (!mine(cur)) {
        // 내 잠금이 사라진 사이 다른 서버가 이 DATA_DIR 을 차지했다: 남의 잠금을 갱신해 주면 안 된다
        throw new Error(
          `DATA_DIR 잠금(${file})을 다른 서버 프로세스가 차지했습니다(pid ${cur.pid ?? '?'}, ${cur.host ?? '?'}). ` +
            '한 DATA_DIR 에는 서버 하나만 띄우세요',
        )
      }
      const t = new Date()
      fs.utimesSync(file, t, t)
    },
    release() {
      if (released) return
      released = true
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>
        if (mine(cur)) fs.unlinkSync(file)
      } catch {
        /* 이미 없다 */
      }
    },
  }
}

// ───────────────────────── 저장 서명 비밀키 ─────────────────────────

const MIN_SECRET = 16

/**
 * SAVE_SECRET 이 없으면 DATA_DIR/secret 에 만들어 두고 재사용한다(재시작해도 플레이어 저장본이 유효하도록).
 * 읽지도 만들지도 못하면 예외: 메모리 안의 임시 키로 돌면 다음 재시작에 모든 진행도가 무효가 된다.
 */
export function loadSecret(dir: string, fromEnv: string | undefined, log?: Log): string {
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const s = fromEnv.trim()
    // 이미 이 값으로 서명된 저장본이 있을 수 있어 막지는 않는다(바꾸면 전부 무효). 알리기만 한다
    if (s.length < MIN_SECRET) log?.('warn', `SAVE_SECRET 이 짧습니다(${s.length}자). 새로 정한다면 ${MIN_SECRET}자 이상의 무작위 문자열을 쓰세요`)
    return s
  }
  const file = path.join(dir, 'secret')
  const read = (): string | null => {
    let s: string
    try {
      s = fs.readFileSync(file, 'utf8').trim()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new PersistFatal(`비밀키 파일 ${file} 을 읽을 수 없습니다 — ${errText(err)}. 권한을 고치거나 SAVE_SECRET 을 지정하세요`)
    }
    if (s.length < MIN_SECRET) {
      throw new PersistFatal(
        `비밀키 파일 ${file} 이 너무 짧습니다(${s.length}자, ${MIN_SECRET}자 이상 필요). 파일을 지우면 새로 만들고(기존 저장본은 무효), 아니면 SAVE_SECRET 을 지정하세요`,
      )
    }
    return s
  }
  const existing = read()
  if (existing) return existing
  const secret = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(dir, { recursive: true })
    // wx: 동시에 뜬 다른 프로세스가 먼저 만들었다면 덮어쓰지 않고 그쪽 것을 쓴다
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
    return secret
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const other = read()
      if (other) return other
    }
    throw new PersistFatal(`비밀키를 ${file} 에 저장하지 못했습니다 — ${errText(err)}. DATA_DIR 권한을 고치거나 SAVE_SECRET 을 지정하세요`)
  }
}

/**
 * 돌던 중 DATA_DIR 이 비워졌다면(볼륨이 잠깐 빠졌다 돌아옴, 실수로 지움) 메모리에 있는 비밀키로 파일을 다시 만든다.
 * 그대로 두면 지금은 멀쩡해 보여도 다음 재시작 때 새 키가 만들어져 모든 플레이어 저장본이 무효가 된다.
 * 이미 파일이 있으면 건드리지 않는다(내용이 달라도 — 사람이 바꿔 둔 것일 수 있다). 다시 만들었으면 true.
 */
export function restoreSecretFile(dir: string, secret: string): boolean {
  const file = path.join(dir, 'secret')
  try {
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

// ───────────────────────── 교단 기록 저장소(메모리 + 파일) ─────────────────────────

export interface FileCultRegistry extends CultRegistry {
  /** sync = 종료 직전(끝날 때까지 기다린다). 비동기 쓰기가 이미 진행 중이면 sync 가 아닌 호출은 건너뛴다 */
  flush(sync: boolean): void
  /** 기록이 있는데 파일이 사라졌다면(DATA_DIR 이 비워졌다) 다음 flush 가 다시 쓰도록 표시한다. 표시했으면 true */
  ensureFile(): boolean
  readonly size: number
}

export interface CultRegistryOptions {
  file: string
  maxCults: number
  log: Log
  status: PersistStatus
  now?: () => number
}

/**
 * 파일 모양: cults.json(현재) + cults.json.bak(바로 전 것).
 * - 쓰기: 프로세스마다 다른 임시 파일에 쓰고 fsync → 현재 파일을 .bak 으로 → 임시 파일을 현재 파일로.
 *   어느 순간 죽어도 둘 중 하나는 온전하다(현재 파일이 없으면 다음 부팅이 .bak 을 읽는다).
 * - 읽기: 깨진 파일은 지우지도 덮어쓰지도 않고 cults.json.corrupt-<시각> 으로 옮겨 둔 뒤 .bak 에서 되살린다.
 */
export function createCultRegistry(opts: CultRegistryOptions): FileCultRegistry {
  const { file, maxCults, log, status } = opts
  const now = opts.now ?? Date.now
  const bak = `${file}.bak`
  const tmp = `${file}.${process.pid}.tmp`
  const map = new Map<string, CultScore>()
  let dirty = false
  let version = 0
  let sorted: CultScore[] = []
  let sortedVersion = -1
  let writing = false

  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1e12, Math.floor(v))) : 0)
  /** 띄어쓰기·대소문자만 다른 이름은 같은 이름으로 본다 */
  const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, '')

  /** 파일 하나를 읽어 채운다. 없으면 false, 깨졌으면 예외(SyntaxError 등) */
  const loadFrom = (f: string): boolean => {
    let text: string
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      // 읽을 수 없는(권한) 파일 위에 빈 기록을 덮어쓰면 순위가 사라진다 → 부팅을 멈춘다
      throw new PersistFatal(`교단 기록 ${f} 을 읽을 수 없습니다 — ${errText(err)}`)
    }
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) throw new SyntaxError('배열이 아닙니다')
    map.clear()
    for (const item of raw) {
      if (map.size >= maxCults) break
      if (!item || typeof item !== 'object') continue
      const r = item as Record<string, unknown>
      const id = str(r.id, 80)
      const name = str(r.name, 40)
      if (!id || !name) continue
      map.set(id, {
        id,
        name,
        color: int(r.color),
        emblem: int(r.emblem),
        leaderName: str(r.leaderName, 40),
        title: str(r.title, 40),
        online: 0,
        fol: int(r.fol),
        inf: int(r.inf),
      })
    }
    return true
  }

  const quarantine = (f: string, err: unknown): void => {
    const moved = `${f}.corrupt-${now()}`
    try {
      fs.renameSync(f, moved)
      log('warn', `교단 기록 ${f} 이 깨져 있어 ${moved} 로 옮겨 두었습니다(지우지 않음)`, err)
    } catch (e) {
      throw new PersistFatal(`깨진 교단 기록 ${f} 을 옮기지 못했습니다 — ${errText(e)}. 덮어쓰지 않으려고 시작을 멈춥니다`)
    }
  }

  let loaded = false
  try {
    loaded = loadFrom(file)
  } catch (err) {
    if (err instanceof PersistFatal) throw err
    quarantine(file, err)
  }
  if (!loaded) {
    // 현재 파일이 없거나(쓰기 도중 죽음) 깨졌다 → 바로 전 저장본으로 되살린다
    try {
      if (loadFrom(bak)) {
        log('warn', `교단 기록을 ${bak} 에서 되살렸습니다(${map.size}개)`)
        dirty = true
      }
    } catch (err) {
      if (err instanceof PersistFatal) throw err
      map.clear()
      quarantine(bak, err)
    }
  }

  const touch = (): void => {
    dirty = true
    version++
  }
  const serialize = (): string => JSON.stringify([...map.values()].map((c) => ({ ...c, online: 0 })))

  const ok = (): void => {
    status.ok = true
    status.lastError = null
    status.lastCultSaveAt = now()
  }
  const fail = (err: unknown): void => {
    status.ok = false
    status.lastError = `cults: ${errText(err)}`
  }
  /** 현재 파일을 .bak 으로 밀어 두고 새 파일을 그 자리에 놓는다(파일이 아직 없으면 그냥 놓는다) */
  const rotateSync = (): void => {
    try {
      fs.renameSync(file, bak)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    fs.renameSync(tmp, file)
  }

  return {
    get size() {
      return map.size
    },
    record(cult, delta) {
      const id = str(cult.id, 80)
      const name = str(cult.name, 40)
      if (!id || !name) return
      let entry = map.get(id)
      if (!entry) {
        if (map.size >= maxCults) {
          // 자리가 없으면 영향력이 가장 낮은 기록을 내보낸다
          let lowest: CultScore | undefined
          for (const c of map.values()) if (!lowest || c.inf < lowest.inf) lowest = c
          if (lowest) map.delete(lowest.id)
        }
        entry = { id, name, color: 0, emblem: 0, leaderName: '', title: '', online: 0, fol: 0, inf: 0 }
        map.set(id, entry)
      }
      entry.name = name
      entry.color = int(cult.color)
      entry.emblem = int(cult.emblem)
      entry.leaderName = str(cult.leaderName, 40) || entry.leaderName
      // 칭호가 비어 오면(교단원이 올린 기록) 기존 교주 칭호를 유지한다
      entry.title = str(cult.title, 40) || entry.title
      entry.fol = int(entry.fol + int(delta.fol))
      entry.inf = int(entry.inf + int(delta.inf))
      touch()
    },
    nameTaken(name, exceptId) {
      const key = nameKey(String(name))
      for (const c of map.values()) if (c.id !== exceptId && nameKey(c.name) === key) return true
      return false
    },
    get(id) {
      const c = map.get(id)
      // 복사본을 준다: 받는 쪽이 online 등을 채워도 원본이 바뀌지 않게
      return c ? { ...c } : undefined
    },
    top(n) {
      if (sortedVersion !== version) {
        sorted = [...map.values()].sort((a, b) => b.inf - a.inf || b.fol - a.fol || a.name.localeCompare(b.name, 'ko'))
        sortedVersion = version
      }
      return sorted.slice(0, Math.max(0, Math.floor(n))).map((c) => ({ ...c }))
    },
    remove(id) {
      if (map.delete(id)) touch()
    },
    ensureFile() {
      if (dirty || writing || map.size === 0 || fs.existsSync(file)) return false
      dirty = true
      return true
    },
    flush(sync) {
      if (!dirty || (writing && !sync)) return
      dirty = false
      const text = serialize()
      if (sync) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          const fd = fs.openSync(tmp, 'w')
          try {
            fs.writeSync(fd, text)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
          rotateSync()
          ok()
        } catch (err) {
          dirty = true
          fail(err)
          log('error', '교단 기록 저장 실패', err)
        }
        return
      }
      writing = true
      ;(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        const fh = await fs.promises.open(tmp, 'w')
        try {
          await fh.writeFile(text)
          // 이름을 바꾸기 전에 내용이 디스크에 닿게 한다(정전 뒤 '이름만 바뀐 빈 파일' 방지)
          await fh.sync()
        } finally {
          await fh.close()
        }
        await fs.promises.rename(file, bak).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        })
        await fs.promises.rename(tmp, file)
      })()
        .then(ok)
        .catch((err: unknown) => {
          dirty = true
          fail(err)
          log('error', '교단 기록 저장 실패(다음 주기에 다시 시도)', err)
        })
        .finally(() => {
          writing = false
        })
    },
  }
}
