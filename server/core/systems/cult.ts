/**
 * 교단 창설/탈퇴, 플레이어 초대(수락·거절·쿨타임·차단), 신고, 교단 순위표, 포교 링크(?by=닉네임).
 *
 * 원칙
 *  - 가입은 오직 '초대받은 사람이 직접 수락'했을 때만 일어난다(서버가 대신 가입시키는 경로는 없다).
 *  - 차단 사실은 드러내지 않는다: 차단당한 사람의 초대는 '보냄' → 잠시 뒤 '거절'로만 보인다.
 *  - 모든 시간은 room.now(), 모든 난수는 room.rnd. 타이머 없이 onTick 에서 만료/지연 처리를 한다.
 */
import {
  INVITE_COOLDOWN_MS,
  INVITE_GLOBAL_COOLDOWN_MS,
  INVITE_TTL_MS,
  PLAYER_INTERACT_RANGE,
  REPORT_COOLDOWN_MS,
} from '../../../shared/constants'
import { CULT_COLORS, CULT_EMBLEMS, CULT_MEMBER_TITLE, STAT } from '../../../shared/content/core'
import type { ClientMsg, ClientMsgOf } from '../../../shared/protocol'
import { hashString } from '../../../shared/rng'
import { josaOf } from '../../../shared/rules/josa'
import { checkCultName, checkTitle } from '../../../shared/rules/moderation'
import type { CultRef, CultScore } from '../../../shared/types'
import type { PlayerState, RoomApi, RoomSystem } from '../api'

/** 교단 창설/수정 쿨타임 — 이름을 바꿔 가며 방 전체에 소식을 도배하지 못하게 */
export const CULT_CREATE_COOLDOWN_MS = 8000
/** 순위표 요청 최소 간격(패널이 10초마다 요청한다) */
export const CULTS_LIST_COOLDOWN_MS = 1500
/** 초대 수락 시 초대한 사람이 받는 영향력 */
export const RECRUIT_INF = 15
/** 같은 사람을 다시 영입해도 보상·전적은 하루에 한 번만(가입 → 탈퇴 → 재가입 반복으로 찍어내지 못하게) */
export const RECRUIT_PAIR_MS = 24 * 60 * 60_000
/** 영입 보상 상한: RECRUIT_REWARD_WINDOW_MS 동안 RECRUIT_REWARD_SLOTS 번(새 pid 를 계속 만들어 오는 도우미 계정 대비) */
export const RECRUIT_REWARD_SLOTS = 5
export const RECRUIT_REWARD_WINDOW_MS = 10 * 60_000
/** 신고 누적 기준: 닉네임 신고 2명 → 강제 개명, 도배/방해 3명 → 5분 입막음 */
export const REPORT_NAME_THRESHOLD = 2
export const REPORT_MUTE_THRESHOLD = 3
export const MUTE_MS = 5 * 60_000
/** 이보다 오래된 신고는 자동 조치에 세지 않는다(몇 시간 전 신고 하나와 오늘 신고 하나가 합쳐져 개명되지 않게) */
export const REPORT_WINDOW_MS = 30 * 60_000
/** 오래된 신고 기록을 지우는 주기 */
const REPORT_PRUNE_MS = 60_000
/**
 * 자동 조치에 세는 신고의 자격: 이 방에 REPORT_MIN_SESSION_MS 이상 머물렀고 영향력이 REPORT_MIN_INF 이상인 사람.
 * (신고자 구분은 클라이언트가 고른 pid 뿐이라, 소켓을 여러 개 열어 막 들어온 계정으로 남을 개명·입막음시키는 것을 어렵게 한다.
 *  자격이 안 되는 신고도 운영 로그에는 남는다.)
 */
export const REPORT_MIN_SESSION_MS = 120_000
export const REPORT_MIN_INF = 30
/** 강제 개명 뒤 이름을 다시 바꿀 수 없는 시간 */
export const NAME_LOCK_MS = 10 * 60_000
/** 포교 링크(?by=)로 같은 사람이 같은 초대자에게 자동 초대를 받는 간격 */
export const REF_ONCE_MS = 24 * 60 * 60_000
/** 포교 링크 소식을 방 전체에 알리는 최소 간격(초대자 한 명당) */
export const REF_FEED_COOLDOWN_MS = 60_000
/** 포교 링크로 들어온 사람에게 초대 카드를 보내기까지의 지연(입장 연출이 끝난 뒤 보이게) */
export const REF_INVITE_DELAY_MS = 2000
/** 차단당한 초대자가 받는 가짜 거절의 지연 범위 */
export const FAKE_NO_MIN_MS = 2000
export const FAKE_NO_SPAN_MS = 2000

const REPORT_WHY = new Set(['name', 'spam', 'grief', 'etc'])

interface Pending {
  from: PlayerState
  to: PlayerState
  /** 초대 당시의 교단(수락 시 초대자가 아직 같은 교단인지 확인) */
  cult: CultRef
  until: number
}

interface FakeNo {
  from: PlayerState
  toId: number
  at: number
}

interface RefInvite {
  newcomer: PlayerState
  refName: string
  at: number
}

/** 띄어쓰기·대소문자만 다른 이름은 같은 이름으로 본다(등록부와 같은 기준) */
const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, '')
const declineKey = (targetPid: string): string => 'cult.dec:' + targetPid
/** 가입한 사람 쪽에 남기는 표시: 이 초대자의 영입 보상은 이미 한 번 나갔다 */
const pairKey = (inviterPid: string): string => 'cult.rw:' + inviterPid
const refKey = (inviterPid: string): string => 'cult.ref:' + inviterPid

export function createCultSystem(): RoomSystem {
  let room: RoomApi
  /** 받는 사람 id → 대기 중인 초대(한 사람에게는 한 번에 하나만) */
  const pending = new Map<number, Pending>()
  let fakes: FakeNo[] = []
  let refs: RefInvite[] = []
  /** 신고 사유 → 대상 pid → 신고한 사람 pid → 마지막 신고 시각(같은 사람은 한 번만 센다) */
  const reports = new Map<string, Map<string, Map<string, number>>>()
  let lastPruneAt = 0

  const alive = (p: PlayerState): boolean => room.players.get(p.id) === p

  function registry() {
    return room.host.cults
  }

  /** 등록부 호출은 실패해도 방을 멈추지 않게 감싼다(파일/스토리지 오류 등) */
  function safeReg<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch (err) {
      room.host.log('error', `[방 ${room.id}] 교단 등록부 오류`, err)
      return fallback
    }
  }

  function recordCult(cult: CultRef): void {
    const reg = registry()
    if (!reg) return
    safeReg(() => {
      reg.record({ id: cult.id, name: cult.name, color: cult.color, emblem: cult.emblem, leaderName: cult.leaderName, title: cult.title }, { fol: 0, inf: 0 })
    }, undefined)
  }

  /** 내 교단 정보를 비운다. 교주였다면 교단 기록도 지운다(디자인 7.1: 교주 탈퇴 = 내 교단 정보 삭제) */
  function dropCult(p: PlayerState): void {
    const cult = p.prog.cult
    if (!cult) return
    if (cult.role === 'leader') {
      p.prog.cultFol = 0
      p.prog.cultInf = 0
      const reg = registry()
      if (reg) safeReg(() => reg.remove(cult.id), undefined)
    }
    p.prog.cult = null
  }

  function nameTaken(name: string, exceptId: string): boolean {
    const key = nameKey(name)
    for (const other of room.players.values()) {
      const c = other.prog.cult
      if (c && c.id !== exceptId && nameKey(c.name) === key) return true
    }
    const reg = registry()
    return reg ? safeReg(() => reg.nameTaken(name, exceptId), false) : false
  }

  // ───────── 교단 창설 / 수정 / 탈퇴 ─────────

  function onCreate(p: PlayerState, msg: ClientMsgOf<'cultCreate'>): void {
    const name = checkCultName(msg.name)
    if (!name.ok) return void room.send(p, { t: 'cultRes', ok: false, why: 'name' })
    const title = checkTitle(msg.title)
    if (!title.ok) return void room.send(p, { t: 'cultRes', ok: false, why: 'title' })
    const { color, emblem } = msg
    if (color < 0 || color >= CULT_COLORS.length || emblem < 0 || emblem >= CULT_EMBLEMS.length) {
      return void room.send(p, { t: 'cultRes', ok: false, why: 'bad' })
    }
    const old = p.prog.cult
    const editing = old?.role === 'leader'
    const now = room.now()
    const id = editing ? old.id : 'c' + hashString(p.pid + ':' + now).toString(36)
    if (nameTaken(name.text, id)) return void room.send(p, { t: 'cultRes', ok: false, why: 'dup' })
    // 검사를 다 통과한 뒤에만 쿨타임을 건다: 오타로 막힌 사람이 8초씩 기다리지 않게
    if (room.cooldown(p, 'cult.create', CULT_CREATE_COOLDOWN_MS) > 0) return void room.send(p, { t: 'cultRes', ok: false, why: 'rate' })

    const cult: CultRef = { id, name: name.text, color, emblem, role: 'leader', title: title.text, leaderName: p.name }
    if (!editing) {
      // 다른 교단의 교단원이었다면 먼저 떠난다
      dropCult(p)
      p.prog.cultFol = 0
      p.prog.cultInf = 0
    }
    p.prog.cult = cult
    recordCult(cult)
    room.publish(p, ['cult'])
    room.markSave(p)
    if (editing) {
      // 접속 중인 교단원의 표시(이름/색/엠블럼)도 함께 고쳐 준다. 오프라인 교단원은 다음에 다시 초대받을 때 갱신된다
      for (const m of room.players.values()) {
        const c = m.prog.cult
        if (m === p || !c || c.id !== id || c.role !== 'member') continue
        m.prog.cult = { ...c, name: cult.name, color, emblem, leaderName: p.name }
        room.publish(m, ['cult'])
        room.markSave(m)
      }
    } else {
      room.bump(p, STAT.cultsMade)
      room.feed('cult', p.id, `${p.name}님이 새 교단 「${cult.name}」${josaOf(cult.name, '을')} 창설했습니다!`)
    }
    room.send(p, { t: 'cultRes', ok: true })
  }

  function onLeaveCult(p: PlayerState): void {
    dropCult(p)
    room.publish(p, ['cult'])
    room.markSave(p)
    room.send(p, { t: 'cultRes', ok: true })
  }

  // ───────── 초대 ─────────

  function onInvite(p: PlayerState, to: number): void {
    const res = (r: 'sent' | 'cool' | 'busy' | 'far' | 'nocult' | 'same', ms?: number): void =>
      room.send(p, ms === undefined ? { t: 'inviteRes', to, r } : { t: 'inviteRes', to, r, ms: Math.ceil(ms) })
    const cult = p.prog.cult
    if (!cult) return res('nocult')
    const target = room.players.get(to)
    if (!target || target === p) return res('far')
    const range = PLAYER_INTERACT_RANGE + 1
    const dx = target.x - p.x
    const dz = target.z - p.z
    if (dx * dx + dz * dz > range * range) return res('far')
    if (target.prog.cult?.id === cult.id) return res('same')
    const now = room.now()
    // 입막음 중이라는 사실은 알리지 않는다: 그냥 쿨타임처럼 보이게
    if (p.mutedUntil > now) return res('cool', INVITE_GLOBAL_COOLDOWN_MS)
    const decLeft = (p.cd.get(declineKey(target.pid)) ?? 0) - now
    if (decLeft > 0) return res('cool', decLeft)
    if (pending.has(target.id) || fakes.some((f) => f.toId === target.id && f.from === p)) return res('busy')
    const globalLeft = room.cooldown(p, 'cult.invite', INVITE_GLOBAL_COOLDOWN_MS)
    if (globalLeft > 0) return res('cool', globalLeft)
    room.bump(p, STAT.invites)
    if (target.blocked.has(p.pid)) {
      // 차단당했다: 상대에게 아무것도 보내지 않고, 잠시 뒤 평범한 거절처럼 알린다
      fakes.push({ from: p, toId: target.id, at: now + FAKE_NO_MIN_MS + Math.floor(room.rnd() * FAKE_NO_SPAN_MS) })
      return res('sent')
    }
    sendInvite(p, target, cult, now)
    res('sent')
  }

  function sendInvite(from: PlayerState, to: PlayerState, cult: CultRef, now: number): void {
    const until = now + INVITE_TTL_MS
    pending.set(to.id, { from, to, cult: { ...cult }, until })
    room.send(to, { t: 'invited', from: from.id, cult: { ...cult }, until })
  }

  function onAnswer(p: PlayerState, msg: ClientMsgOf<'inviteAns'>): void {
    const inv = pending.get(p.id)
    const matches = inv !== undefined && inv.from.id === msg.from
    // 카드가 이미 사라진 뒤에 [차단]을 눌러도 차단은 해 준다(차단은 언제나 본인 권리)
    if (msg.block === true) {
      const who = matches ? inv.from : room.players.get(msg.from)
      if (who && who !== p) p.blocked.add(who.pid)
    }
    if (!matches) return
    pending.delete(p.id)
    const from = inv.from
    if (!alive(from)) return
    if (!msg.ok) {
      decline(from, p)
      return
    }
    const cult = from.prog.cult
    // 초대한 사람이 그사이 교단을 떠났거나 바꿨다면 성립하지 않는다
    if (!cult || cult.id !== inv.cult.id) {
      room.send(from, { t: 'inviteRes', to: p.id, r: 'expired' })
      room.send(p, { t: 'cultRes', ok: false, why: 'bad' })
      return
    }
    if (p.prog.cult?.id !== cult.id) dropCult(p)
    p.prog.cult = { ...cult, role: 'member', title: CULT_MEMBER_TITLE }
    room.publish(p, ['cult'])
    room.markSave(p)
    room.send(p, { t: 'cultRes', ok: true })
    room.send(from, { t: 'inviteRes', to: p.id, r: 'ok' })
    // 가입 자체는 언제나 성립한다. 다만 같은 두 사람 사이의 보상·전적·소식은 하루에 한 번만.
    const now = room.now()
    const pk = pairKey(from.pid)
    if ((p.cd.get(pk) ?? 0) > now) return
    p.cd.set(pk, now + RECRUIT_PAIR_MS)
    room.bump(p, STAT.joinedCults)
    room.feed('cult', from.id, `${p.name}님이 ${from.name}님의 권유로 「${cult.name}」에 들어갔습니다!`)
    if (!takeRewardSlot(from, now)) return
    room.bump(from, STAT.recruits)
    room.grant(from, { why: 'recruit', inf: RECRUIT_INF })
  }

  /** 영입 보상은 일정 시간에 정해진 횟수까지만(쿨타임 표를 칸으로 쓴다 → 재접속해도 유지) */
  function takeRewardSlot(from: PlayerState, now: number): boolean {
    for (let i = 0; i < RECRUIT_REWARD_SLOTS; i++) {
      const key = 'cult.rws' + String(i)
      if ((from.cd.get(key) ?? 0) > now) continue
      from.cd.set(key, now + RECRUIT_REWARD_WINDOW_MS)
      return true
    }
    return false
  }

  function decline(from: PlayerState, to: PlayerState): void {
    from.cd.set(declineKey(to.pid), room.now() + INVITE_COOLDOWN_MS)
    room.send(from, { t: 'inviteRes', to: to.id, r: 'no' })
  }

  function onBlock(p: PlayerState, msg: ClientMsgOf<'block'>): void {
    const target = room.players.get(msg.id)
    if (!target || target === p) return
    if (msg.on) {
      p.blocked.add(target.pid)
      // 이미 와 있던 그 사람의 초대는 평범한 거절로 정리한다
      const inv = pending.get(p.id)
      if (inv && inv.from === target) {
        pending.delete(p.id)
        decline(target, p)
      }
    } else {
      p.blocked.delete(target.pid)
    }
  }

  // ───────── 신고 ─────────

  function onReport(p: PlayerState, msg: ClientMsgOf<'report'>): void {
    const why = msg.why
    if (!REPORT_WHY.has(why)) return
    const target = room.players.get(msg.id)
    if (!target || target === p) return
    if (room.cooldown(p, 'cult.report', REPORT_COOLDOWN_MS) > 0) return
    room.host.log('warn', 'report', { room: room.id, why, target: target.pid, targetName: target.name, by: p.pid })
    let byTarget = reports.get(why)
    if (!byTarget) reports.set(why, (byTarget = new Map()))
    // 자동 조치에는 '이 방에서 어느 정도 놀던 사람'의 신고만 센다(막 만든 계정 여러 개로 남을 제재하지 못하게)
    const now = room.now()
    if (now - p.joinedAt < REPORT_MIN_SESSION_MS || p.prog.inf < REPORT_MIN_INF) return
    let byReporter = byTarget.get(target.pid)
    if (!byReporter) byTarget.set(target.pid, (byReporter = new Map()))
    byReporter.set(p.pid, now)
    // 최근 REPORT_WINDOW_MS 안의 신고만 센다
    for (const [pid, at] of byReporter) if (now - at > REPORT_WINDOW_MS) byReporter.delete(pid)
    const count = byReporter.size
    if (why === 'name' && count >= REPORT_NAME_THRESHOLD) {
      byTarget.delete(target.pid)
      target.name = neutralName()
      // 바로 되돌리지 못하게 한동안 이름을 고정한다(재접속해도 유지)
      target.nameLockUntil = now + NAME_LOCK_MS
      room.publish(target, ['name'])
      room.markSave(target)
      room.send(target, { t: 'err', code: 'renamed', msg: target.name })
    } else if ((why === 'spam' || why === 'grief') && count >= REPORT_MUTE_THRESHOLD) {
      byTarget.delete(target.pid)
      target.mutedUntil = now + MUTE_MS
      room.send(target, { t: 'err', code: 'muted', msg: String(MUTE_MS) })
    }
  }

  /** 기한이 지난 신고를 지운다. 기준에 못 미친 채 남은 대상이 방이 사는 동안 계속 쌓이지 않게 */
  function pruneReports(now: number): void {
    for (const [why, byTarget] of reports) {
      for (const [target, byReporter] of byTarget) {
        for (const [pid, at] of byReporter) if (now - at > REPORT_WINDOW_MS) byReporter.delete(pid)
        if (byReporter.size === 0) byTarget.delete(target)
      }
      if (byTarget.size === 0) reports.delete(why)
    }
  }

  function neutralName(): string {
    const taken = new Set<string>()
    for (const q of room.players.values()) taken.add(q.name)
    for (let i = 0; i < 50; i++) {
      const name = '행인' + String(1000 + Math.floor(room.rnd() * 9000))
      if (!taken.has(name)) return name
    }
    return '행인' + String(room.now() % 10000).padStart(4, '0')
  }

  // ───────── 순위표 ─────────

  function scoreboard(): CultScore[] {
    const reg = registry()
    const byId = new Map<string, CultScore>()
    const leaders = new Map<string, PlayerState>()
    for (const q of room.players.values()) {
      const c = q.prog.cult
      if (!c) continue
      let s = byId.get(c.id)
      if (!s) {
        s = { id: c.id, name: c.name, color: c.color, emblem: c.emblem, leaderName: c.leaderName, title: '', online: 0, fol: 0, inf: 0 }
        byId.set(c.id, s)
      }
      s.online++
      if (c.role === 'leader') {
        leaders.set(c.id, q)
        // 교주의 정보가 가장 최신이다(교단원은 가입 당시의 사본을 들고 있다)
        s.name = c.name
        s.color = c.color
        s.emblem = c.emblem
        s.leaderName = c.leaderName
        s.title = c.title
      }
    }
    for (const s of byId.values()) {
      const rec = reg ? safeReg(() => reg.get(s.id), undefined) : undefined
      const leader = leaders.get(s.id)
      if (rec) {
        s.fol = rec.fol
        s.inf = rec.inf
        if (!s.title) s.title = rec.title
      } else if (leader) {
        s.fol = leader.prog.cultFol
        s.inf = leader.prog.cultInf
      }
    }
    const list = [...byId.values()].sort((a, b) => b.inf - a.inf).slice(0, 20)
    if (reg) {
      const top = safeReg(() => reg.top(10), [] as CultScore[])
      for (const t of top) {
        if (byId.has(t.id)) continue
        list.push({ id: t.id, name: t.name, color: t.color, emblem: t.emblem, leaderName: t.leaderName, title: t.title, online: 0, fol: t.fol, inf: t.inf })
      }
      list.sort((a, b) => b.inf - a.inf)
    }
    return list
  }

  // ───────── 포교 링크 ─────────

  function resolveRef(r: RefInvite, now: number): void {
    const p = r.newcomer
    if (!alive(p)) return
    let inviter: PlayerState | undefined
    for (const q of room.players.values()) if (q !== p && q.name === r.refName) inviter = q
    const cult = inviter?.prog.cult
    if (!inviter || !cult) return
    if (p.prog.cult?.id === cult.id) return
    if (pending.has(p.id) || p.blocked.has(inviter.pid) || inviter.mutedUntil > now) return
    if ((inviter.cd.get(declineKey(p.pid)) ?? 0) > now) return
    // 같은 사람이 링크로 다시 들어와도 자동 초대는 초대자 한 명당 하루에 한 번만(재접속으로 카드·소식을 되풀이하지 못하게)
    const rk = refKey(inviter.pid)
    if ((p.cd.get(rk) ?? 0) > now) return
    p.cd.set(rk, now + REF_ONCE_MS)
    sendInvite(inviter, p, cult, now)
    // 초대자가 직접 누른 것이 아니므로 '초대 횟수' 전적은 올리지 않는다
    if (room.cooldown(inviter, 'cult.reffeed', REF_FEED_COOLDOWN_MS) === 0) {
      room.feed('cult', inviter.id, `${p.name}님이 ${inviter.name}님의 포교 링크를 보고 찾아왔습니다!`)
    }
  }

  return {
    name: 'cult',
    handles: ['cultCreate', 'cultLeave', 'invite', 'inviteAns', 'block', 'report', 'cults'],
    init(r) {
      room = r
    },
    onMessage(p: PlayerState, msg: ClientMsg) {
      switch (msg.t) {
        case 'cultCreate':
          return onCreate(p, msg)
        case 'cultLeave':
          return onLeaveCult(p)
        case 'invite':
          return onInvite(p, msg.to)
        case 'inviteAns':
          return onAnswer(p, msg)
        case 'block':
          return onBlock(p, msg)
        case 'report':
          return onReport(p, msg)
        case 'cults':
          if (room.cooldown(p, 'cult.list', CULTS_LIST_COOLDOWN_MS) > 0) return
          room.send(p, { t: 'cults', list: scoreboard() })
          return
        default:
          return
      }
    },
    onJoin(p) {
      const ref = p.ext['ref']
      if (typeof ref === 'string' && ref && ref !== p.name) {
        refs.push({ newcomer: p, refName: ref, at: room.now() + REF_INVITE_DELAY_MS })
      }
    },
    onTick(now) {
      if (now - lastPruneAt >= REPORT_PRUNE_MS || now < lastPruneAt) {
        lastPruneAt = now
        pruneReports(now)
      }
      for (const [id, inv] of pending) {
        if (inv.until > now) continue
        pending.delete(id)
        if (alive(inv.from)) room.send(inv.from, { t: 'inviteRes', to: inv.to.id, r: 'expired' })
      }
      if (fakes.length > 0) {
        const due = fakes.filter((f) => f.at <= now)
        if (due.length > 0) {
          fakes = fakes.filter((f) => f.at > now)
          for (const f of due) {
            if (!alive(f.from)) continue
            const target = room.players.get(f.toId)
            // 가짜 거절도 진짜 거절과 똑같이 대상별 쿨타임을 남긴다(차이로 차단 여부를 알아채지 못하게)
            if (target) f.from.cd.set(declineKey(target.pid), now + INVITE_COOLDOWN_MS)
            room.send(f.from, { t: 'inviteRes', to: f.toId, r: 'no' })
          }
        }
      }
      if (refs.length > 0) {
        const due = refs.filter((r) => r.at <= now)
        if (due.length > 0) {
          refs = refs.filter((r) => r.at > now)
          for (const r of due) resolveRef(r, now)
        }
      }
    },
    onLeave(p) {
      // 내가 받은 초대: 보낸 사람에게는 '시간 초과'로 알린다
      const mine = pending.get(p.id)
      if (mine) {
        pending.delete(p.id)
        if (alive(mine.from)) room.send(mine.from, { t: 'inviteRes', to: p.id, r: 'expired' })
      }
      // 내가 보낸 초대: 조용히 거둔다(받는 쪽 카드는 클라이언트가 퇴장 소식을 보고 닫는다)
      for (const [id, inv] of pending) if (inv.from === p) pending.delete(id)
      // 차단으로 막힌 초대도 진짜 초대와 똑같이 '시간 초과'로 끝낸다
      for (const f of fakes) if (f.toId === p.id && f.from !== p && alive(f.from)) room.send(f.from, { t: 'inviteRes', to: p.id, r: 'expired' })
      fakes = fakes.filter((f) => f.from !== p && f.toId !== p.id)
      refs = refs.filter((r) => r.newcomer !== p)
      // 거절 쿨타임(cult.dec:<pid>)은 지우지 않는다: 거절한 사람이 잠깐 끊겼다 돌아와도 유지돼야 한다(만료되면 방이 청소한다)
    },
  }
}
