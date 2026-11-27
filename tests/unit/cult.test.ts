/**
 * 교단 시스템(server/core/systems/cult.ts) 단위 테스트.
 * 교단 시스템만 끼운 방에서 창설/초대/차단/신고/순위표/포교 링크를 본다.
 */
import { describe, expect, it } from 'vitest'
import { INVITE_COOLDOWN_MS, INVITE_GLOBAL_COOLDOWN_MS, INVITE_TTL_MS, PROTOCOL_VERSION, REPORT_COOLDOWN_MS } from '../../shared/constants'
import { CULT_MEMBER_TITLE, STAT } from '../../shared/content/core'
import type { CultScore } from '../../shared/types'
import type { CultRegistry } from '../../server/core/api'
import { CULT_CREATE_COOLDOWN_MS, MUTE_MS, RECRUIT_INF, createCultSystem } from '../../server/core/systems/cult'
import { LOOK0, setup } from './helpers'

type T = ReturnType<typeof setup>
type Who = { conn: number; id: number }

function memRegistry(): CultRegistry & { map: Map<string, CultScore> } {
  const map = new Map<string, CultScore>()
  const key = (n: string): string => n.toLowerCase().replace(/\s+/g, '')
  return {
    map,
    record(c, d) {
      const e = map.get(c.id) ?? { ...c, online: 0, fol: 0, inf: 0 }
      Object.assign(e, { name: c.name, color: c.color, emblem: c.emblem, leaderName: c.leaderName || e.leaderName, title: c.title || e.title })
      e.fol += d.fol
      e.inf += d.inf
      map.set(c.id, e)
    },
    nameTaken(name, exceptId) {
      for (const c of map.values()) if (c.id !== exceptId && key(c.name) === key(name)) return true
      return false
    },
    get: (id) => map.get(id),
    top: (n) => [...map.values()].sort((a, b) => b.inf - a.inf).slice(0, n),
    remove: (id) => void map.delete(id),
  }
}

function make(opts: { cults?: CultRegistry } = {}) {
  const t = setup({ systems: [createCultSystem], ...opts })
  /** 유휴 퇴장(45초)에 걸리지 않게 모두 ping 을 보내며 시간을 돌린다 */
  const wait = (ms: number, conns: number[]): void => {
    for (let left = ms; left > 0; left -= 5000) {
      t.advance(Math.min(5000, left))
      for (const c of conns) t.send(c, { t: 'ping', c: 1 })
    }
  }
  const create = (who: Who, name = '라면교', extra: Record<string, unknown> = {}): void =>
    t.send(who.conn, { t: 'cultCreate', name, color: 3, emblem: 0, title: '교주', ...extra })
  const lastRes = (who: Who) => t.host.of(who.conn, 'cultRes').at(-1)
  const lastInv = (who: Who) => t.host.of(who.conn, 'inviteRes').at(-1)
  return { ...t, wait, create, lastRes, lastInv }
}

/** A 가 교단을 만들고 B 가 옆에 있는 상태 */
function pair(opts: { cults?: CultRegistry } = {}) {
  const t = make(opts)
  const a = t.join({ name: '교주님' })
  const b = t.join({ name: '행인님' })
  t.create(a)
  return { t, a, b }
}

const cultOf = (t: T, who: Who) => t.player(who.id).prog.cult

describe('교단 창설/수정/탈퇴', () => {
  it('창설: 교주가 되고 방 전체에 공개되며 통계/소식이 남는다', () => {
    const reg = memRegistry()
    const t = make({ cults: reg })
    const a = t.join({ name: '교주님' })
    const b = t.join()
    t.create(a, '퇴근을 믿는 사람들')
    expect(t.lastRes(a)).toEqual({ t: 'cultRes', ok: true })
    const c = cultOf(t, a)!
    expect(c).toMatchObject({ name: '퇴근을 믿는 사람들', color: 3, emblem: 0, role: 'leader', title: '교주', leaderName: '교주님' })
    expect(c.id).toMatch(/^c[0-9a-z]+$/)
    expect(t.host.of(b.conn, 'pu').some((m) => m.id === a.id && m.cult?.id === c.id)).toBe(true)
    expect(t.host.of(b.conn, 'feed').some((m) => m.k === 'cult')).toBe(true)
    expect(t.stat(a.id, STAT.cultsMade)).toBe(1)
    expect(reg.map.get(c.id)?.name).toBe('퇴근을 믿는 사람들')
    expect(t.player(a.id).saveDirty).toBe(true)
  })

  it('이름/칭호/색/엠블럼 검사: 욕설·실존 단체명·범위 밖은 거절', () => {
    const t = make()
    const a = t.join()
    t.create(a, '라면 교회')
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'name' })
    t.create(a, '통 일 교')
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'name' })
    t.create(a, '시발교')
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'name' })
    t.create(a, '가')
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'name' })
    t.create(a, '라면교', { title: '' })
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'title' })
    t.create(a, '라면교', { title: '성당지기' })
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'title' })
    t.create(a, '라면교', { color: 12 })
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'bad' })
    t.create(a, '라면교', { emblem: -1 })
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'bad' })
    t.create(a, '라면교', { emblem: 1.5 })
    expect(t.host.of(a.conn, 'err').at(-1)?.code).toBe('bad')
    expect(cultOf(t, a)).toBeNull()
    // 검사에서 막힌 시도는 쿨타임을 쓰지 않는다
    t.create(a, '라면교')
    expect(t.lastRes(a)).toEqual({ t: 'cultRes', ok: true })
  })

  it('쿨타임 8초, 같은 교주의 재요청은 같은 id 로 수정', () => {
    const t = make()
    const a = t.join()
    t.create(a, '라면교')
    const id = cultOf(t, a)!.id
    t.create(a, '만두교')
    expect(t.lastRes(a)).toMatchObject({ ok: false, why: 'rate' })
    t.wait(CULT_CREATE_COOLDOWN_MS, [a.conn])
    t.create(a, '만두교', { color: 5, emblem: 15, title: '큰형님' })
    expect(t.lastRes(a)).toEqual({ t: 'cultRes', ok: true })
    expect(cultOf(t, a)).toMatchObject({ id, name: '만두교', color: 5, emblem: 15, title: '큰형님' })
    expect(t.stat(a.id, STAT.cultsMade)).toBe(1)
  })

  it('다른 교단이 쓰는 이름은 dup (방 안 + 등록부), 띄어쓰기/대소문자 무시', () => {
    const reg = memRegistry()
    reg.record({ id: 'cold', name: 'Sleep Club', color: 0, emblem: 0, leaderName: 'x', title: 'y' }, { fol: 0, inf: 0 })
    const t = make({ cults: reg })
    const a = t.join()
    const b = t.join()
    t.create(a, '라면교')
    t.create(b, '라 면 교')
    expect(t.lastRes(b)).toMatchObject({ ok: false, why: 'dup' })
    t.create(b, 'sleepclub')
    expect(t.lastRes(b)).toMatchObject({ ok: false, why: 'dup' })
    // 내 교단 이름을 그대로 다시 쓰는 수정은 허용
    t.wait(CULT_CREATE_COOLDOWN_MS, [a.conn, b.conn])
    t.create(a, '라면교', { color: 7 })
    expect(t.lastRes(a)).toEqual({ t: 'cultRes', ok: true })
  })

  it('교주 탈퇴: 교단 정보/기록 삭제, 교단원 표시는 그대로', () => {
    const reg = memRegistry()
    const { t, a, b } = pair({ cults: reg })
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    const id = cultOf(t, a)!.id
    t.player(a.id).prog.cultInf = 50
    t.send(a.conn, { t: 'cultLeave' })
    expect(t.lastRes(a)).toEqual({ t: 'cultRes', ok: true })
    expect(cultOf(t, a)).toBeNull()
    expect(t.player(a.id).prog.cultInf).toBe(0)
    expect(reg.map.has(id)).toBe(false)
    expect(cultOf(t, b)?.id).toBe(id)
    expect(t.host.of(b.conn, 'pu').some((m) => m.id === a.id && m.cult === null)).toBe(true)
    // 교단 없이 탈퇴해도 문제 없음
    t.send(a.conn, { t: 'cultLeave' })
    expect(t.lastRes(a)).toEqual({ t: 'cultRes', ok: true })
  })

  it('교단원이 새 교단을 만들면 기존 교단을 떠나 교주가 된다', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    t.create(b, '만두교')
    expect(cultOf(t, b)).toMatchObject({ name: '만두교', role: 'leader' })
    expect(cultOf(t, b)!.id).not.toBe(cultOf(t, a)!.id)
  })

  it('교주가 정보를 고치면 접속 중인 교단원 표시도 바뀐다', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    t.wait(CULT_CREATE_COOLDOWN_MS, [a.conn, b.conn])
    t.create(a, '국수교', { color: 9 })
    expect(cultOf(t, b)).toMatchObject({ name: '국수교', color: 9, role: 'member', title: CULT_MEMBER_TITLE })
  })
})

describe('교단 초대', () => {
  it('수락해야만 가입: 카드 → 수락 → 같은 교단 + 보상', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)).toEqual({ t: 'inviteRes', to: b.id, r: 'sent' })
    const card = t.host.of(b.conn, 'invited')[0]!
    expect(card).toMatchObject({ from: a.id, cult: { name: '라면교', leaderName: '교주님' } })
    expect(card.until).toBe(t.host.t + INVITE_TTL_MS)
    // 초대만으로는 아무 일도 없다
    t.advance(1000)
    expect(cultOf(t, b)).toBeNull()
    const infBefore = t.player(a.id).prog.inf
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toMatchObject({ id: cultOf(t, a)!.id, role: 'member', title: CULT_MEMBER_TITLE, leaderName: '교주님' })
    expect(t.lastInv(a)).toEqual({ t: 'inviteRes', to: b.id, r: 'ok' })
    expect(t.player(a.id).prog.inf).toBe(infBefore + RECRUIT_INF)
    expect(t.stat(a.id, STAT.recruits)).toBe(1)
    expect(t.stat(a.id, STAT.invites)).toBe(1)
    expect(t.stat(b.id, STAT.joinedCults)).toBe(1)
    expect(t.host.of(a.conn, 'pu').some((m) => m.id === b.id && m.cult?.role === 'member')).toBe(true)
    // 같은 교단이면 same
    t.wait(INVITE_GLOBAL_COOLDOWN_MS, [a.conn, b.conn])
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('same')
  })

  it('아무도 초대하지 않았는데 수락을 보내도 가입되지 않는다(위조)', () => {
    const { t, a, b } = pair()
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toBeNull()
    // 다른 사람에게 온 초대를 대신 수락할 수도 없다
    const c = t.join()
    t.send(a.conn, { t: 'invite', to: c.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toBeNull()
    expect(t.lastInv(a)?.r).toBe('sent')
  })

  it('거절 → no + 같은 대상 60초 쿨타임, 다른 대상은 전체 쿨타임만', () => {
    const { t, a, b } = pair()
    const c = t.join()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: false })
    expect(t.lastInv(a)).toEqual({ t: 'inviteRes', to: b.id, r: 'no' })
    expect(cultOf(t, b)).toBeNull()
    t.send(a.conn, { t: 'invite', to: b.id })
    const cool = t.lastInv(a)!
    expect(cool.r).toBe('cool')
    expect(cool.ms).toBeGreaterThan(INVITE_COOLDOWN_MS - 1000)
    t.send(a.conn, { t: 'invite', to: c.id })
    expect(t.lastInv(a)?.r).toBe('cool')
    expect(t.lastInv(a)?.ms).toBeLessThanOrEqual(INVITE_GLOBAL_COOLDOWN_MS)
    t.wait(INVITE_GLOBAL_COOLDOWN_MS, [a.conn, b.conn, c.conn])
    t.send(a.conn, { t: 'invite', to: c.id })
    expect(t.lastInv(a)?.r).toBe('sent')
    t.wait(INVITE_COOLDOWN_MS, [a.conn, b.conn, c.conn])
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('sent')
  })

  it('검증: 교단 없음/없는 대상/자기 자신/멀리/이미 초대 받는 중', () => {
    const t = make()
    const a = t.join()
    const b = t.join()
    const c = t.join()
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('nocult')
    t.create(a)
    t.create(c, '만두교')
    t.send(a.conn, { t: 'invite', to: 999 })
    expect(t.lastInv(a)?.r).toBe('far')
    t.send(a.conn, { t: 'invite', to: a.id })
    expect(t.lastInv(a)?.r).toBe('far')
    t.player(b.id).x = 15
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('far')
    t.player(b.id).x = 4.5
    t.send(c.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(c)?.r).toBe('sent')
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('busy')
    // 형태가 틀린 메시지는 bad
    t.send(a.conn, { t: 'invite', to: 'x' })
    expect(t.host.of(a.conn, 'err').at(-1)?.code).toBe('bad')
    expect(t.host.errors()).toEqual([])
  })

  it('20초 안에 답이 없으면 expired, 그 뒤 수락은 무효', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.wait(INVITE_TTL_MS + 100, [a.conn, b.conn])
    expect(t.lastInv(a)).toEqual({ t: 'inviteRes', to: b.id, r: 'expired' })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toBeNull()
  })

  it('차단: 초대자는 sent → 2~4초 뒤 no, 대상에게는 카드가 가지 않는다', () => {
    const { t, a, b } = pair()
    t.send(b.conn, { t: 'block', id: a.id, on: true })
    expect(t.player(b.id).blocked.has(t.player(a.id).pid)).toBe(true)
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('sent')
    t.advance(1900)
    expect(t.lastInv(a)?.r).toBe('sent')
    t.advance(2200)
    expect(t.lastInv(a)).toEqual({ t: 'inviteRes', to: b.id, r: 'no' })
    expect(t.host.of(b.conn, 'invited')).toEqual([])
    // 진짜 거절과 똑같이 대상별 쿨타임도 남는다
    t.wait(INVITE_GLOBAL_COOLDOWN_MS, [a.conn, b.conn])
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('cool')
    // 차단 해제 후에는 다시 받을 수 있다
    t.send(b.conn, { t: 'block', id: a.id, on: false })
    t.wait(INVITE_COOLDOWN_MS, [a.conn, b.conn])
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.host.of(b.conn, 'invited').length).toBe(1)
  })

  it('카드의 [이 사람 차단] = 거절 + 차단', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: false, block: true })
    expect(t.lastInv(a)?.r).toBe('no')
    expect(t.player(b.id).blocked.has(t.player(a.id).pid)).toBe(true)
    expect(cultOf(t, b)).toBeNull()
    // ok:true 와 block:true 를 함께 보내도 차단이 우선(가입되지 않음)은 아니지만, 대상 아닌 사람은 막을 수 없다
    t.send(b.conn, { t: 'block', id: b.id, on: true })
    expect(t.player(b.id).blocked.size).toBe(1)
  })

  it('카드가 떠 있는 동안 차단하면 그 초대는 거절로 정리된다', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'block', id: a.id, on: true })
    expect(t.lastInv(a)?.r).toBe('no')
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toBeNull()
  })

  it('입막음 중인 초대자는 조용히 cool', () => {
    const { t, a, b } = pair()
    t.player(a.id).mutedUntil = t.host.t + 10_000
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.lastInv(a)?.r).toBe('cool')
    expect(t.host.of(b.conn, 'invited')).toEqual([])
  })

  it('수락 전에 초대자가 교단을 떠나면 가입되지 않는다', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(a.conn, { t: 'cultLeave' })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toBeNull()
    expect(t.lastInv(a)?.r).toBe('expired')
  })

  it('교주였던 사람이 다른 교단에 들어가면 자기 교단 기록은 지워진다', () => {
    const reg = memRegistry()
    const { t, a, b } = pair({ cults: reg })
    t.create(b, '만두교')
    const bid = cultOf(t, b)!.id
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)?.id).toBe(cultOf(t, a)!.id)
    expect(reg.map.has(bid)).toBe(false)
  })

  it('대상이 초대 중에 나가면 초대자에게 expired, 대상별 쿨타임도 정리', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.room.disconnect(b.conn)
    expect(t.lastInv(a)).toEqual({ t: 'inviteRes', to: b.id, r: 'expired' })
    expect(t.host.errors()).toEqual([])
  })

  it('초대자가 나가면 남은 수락은 무효이고 오류도 없다', () => {
    const { t, a, b } = pair()
    t.send(a.conn, { t: 'invite', to: b.id })
    t.room.disconnect(a.conn)
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, b)).toBeNull()
    t.advance(INVITE_TTL_MS + 100)
    expect(t.host.errors()).toEqual([])
  })

  it('차단당한 초대자가 기다리는 동안 대상이 나가면 expired', () => {
    const { t, a, b } = pair()
    t.send(b.conn, { t: 'block', id: a.id, on: true })
    t.send(a.conn, { t: 'invite', to: b.id })
    t.room.disconnect(b.conn)
    expect(t.lastInv(a)?.r).toBe('expired')
    t.advance(5000)
    expect(t.lastInv(a)?.r).toBe('expired')
  })
})

describe('신고', () => {
  it('닉네임 신고 2명 → 중립 닉네임으로 강제 변경(한 사람은 한 번만 셈)', () => {
    const t = make()
    const bad = t.join({ name: '수상한이름' })
    const r1 = t.join()
    const r2 = t.join()
    t.send(r1.conn, { t: 'report', id: bad.id, why: 'name' })
    t.wait(REPORT_COOLDOWN_MS, [bad.conn, r1.conn, r2.conn])
    t.send(r1.conn, { t: 'report', id: bad.id, why: 'name' })
    expect(t.player(bad.id).name).toBe('수상한이름')
    expect(t.host.logs.filter((l) => l.msg === 'report').length).toBe(2)
    t.send(r2.conn, { t: 'report', id: bad.id, why: 'name' })
    const name = t.player(bad.id).name
    expect(name).toMatch(/^행인\d{4}$/)
    expect(t.host.of(bad.conn, 'err').at(-1)?.code).toBe('renamed')
    expect(t.host.of(r1.conn, 'pu').some((m) => m.id === bad.id && m.name === name)).toBe(true)
  })

  it('도배 신고 3명 → 5분 입막음, 신고 쿨타임/잘못된 사유/자기 신고는 무시', () => {
    const t = make()
    const bad = t.join()
    const rs = [t.join(), t.join(), t.join()]
    t.send(rs[0]!.conn, { t: 'report', id: bad.id, why: 'spam' })
    t.send(rs[0]!.conn, { t: 'report', id: bad.id, why: 'grief' }) // 쿨타임
    t.send(rs[1]!.conn, { t: 'report', id: bad.id, why: 'nope' })
    t.send(rs[1]!.conn, { t: 'report', id: rs[1]!.id, why: 'spam' })
    t.send(rs[1]!.conn, { t: 'report', id: 777, why: 'spam' })
    expect(t.host.logs.filter((l) => l.msg === 'report').length).toBe(1)
    t.send(rs[1]!.conn, { t: 'report', id: bad.id, why: 'spam' })
    expect(t.player(bad.id).mutedUntil).toBe(0)
    t.send(rs[2]!.conn, { t: 'report', id: bad.id, why: 'spam' })
    expect(t.player(bad.id).mutedUntil).toBe(t.host.t + MUTE_MS)
    expect(t.host.of(bad.conn, 'err').at(-1)?.code).toBe('muted')
  })

  it('기타 신고는 기록만 한다', () => {
    const t = make()
    const x = t.join()
    const rs = [t.join(), t.join(), t.join()]
    for (const r of rs) t.send(r.conn, { t: 'report', id: x.id, why: 'etc' })
    expect(t.player(x.id).mutedUntil).toBe(0)
    expect(t.host.logs.filter((l) => l.msg === 'report' && l.level === 'warn').length).toBe(3)
  })
})

describe('교단 순위표', () => {
  it('방 안 교단을 접속자 수와 기록으로 묶어 영향력 순으로', () => {
    const { t, a, b } = pair()
    const c = t.join()
    t.create(c, '만두교')
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
    t.player(c.id).prog.cultInf = 999
    t.player(a.id).prog.cultInf = 20
    t.send(b.conn, { t: 'cults' })
    const list = t.host.of(b.conn, 'cults')[0]!.list
    expect(list.map((s) => [s.name, s.online, s.inf])).toEqual([
      ['만두교', 1, 999],
      ['라면교', 2, 20],
    ])
    expect(list[1]).toMatchObject({ leaderName: '교주님', title: '교주' })
    // 너무 잦은 요청은 무시
    t.send(b.conn, { t: 'cults' })
    expect(t.host.of(b.conn, 'cults').length).toBe(1)
  })

  it('등록부가 있으면 기록값과 전체 상위 교단을 합친다', () => {
    const reg = memRegistry()
    reg.record({ id: 'cfar', name: '먼 교단', color: 1, emblem: 2, leaderName: '누군가', title: '총무' }, { fol: 5, inf: 500 })
    const { t, a } = pair({ cults: reg })
    const id = cultOf(t, a)!.id
    reg.record({ ...reg.map.get(id)! }, { fol: 3, inf: 40 })
    t.send(a.conn, { t: 'cults' })
    const list = t.host.of(a.conn, 'cults')[0]!.list
    expect(list.map((s) => [s.id, s.online, s.inf])).toEqual([
      ['cfar', 0, 500],
      [id, 1, 40],
    ])
  })
})

describe('포교 링크', () => {
  const helloRef = (t: ReturnType<typeof make>, ref: string, name = '새손님') => {
    const conn = t.nextConn()
    t.room.connect(conn)
    t.send(conn, { t: 'hello', v: PROTOCOL_VERSION, pid: `device-${conn}-refrefref`, name, look: LOOK0, save: null, ref })
    const w = t.host.of(conn, 'welcome')[0]!
    return { conn, id: w.id }
  }

  it('?by=교주 로 들어오면 2초 뒤 거리와 상관없이 초대 카드, 수락하면 가입', () => {
    const t = make()
    const a = t.join({ name: '교주님' })
    t.create(a)
    const n = helloRef(t, '교주님')
    t.player(n.id).x = 18
    t.advance(1500)
    expect(t.host.of(n.conn, 'invited')).toEqual([])
    t.advance(700)
    expect(t.host.of(n.conn, 'invited')[0]).toMatchObject({ from: a.id, cult: { name: '라면교' } })
    expect(t.host.of(a.conn, 'feed').some((m) => m.k === 'cult' && m.text.includes('포교 링크'))).toBe(true)
    t.send(n.conn, { t: 'inviteAns', from: a.id, ok: true })
    expect(cultOf(t, n)?.id).toBe(cultOf(t, a)!.id)
  })

  it('초대한 사람이 없거나 교단이 없거나 이미 나갔으면 아무 일도 없다', () => {
    const t = make()
    const a = t.join({ name: '교주님' })
    const n1 = helloRef(t, '없는사람')
    const n2 = helloRef(t, '교주님', '둘째손님')
    t.advance(3000)
    expect(t.host.of(n1.conn, 'invited')).toEqual([])
    expect(t.host.of(n2.conn, 'invited')).toEqual([])
    t.create(a)
    const n3 = helloRef(t, '교주님', '셋째손님')
    t.room.disconnect(a.conn)
    t.advance(3000)
    expect(t.host.of(n3.conn, 'invited')).toEqual([])
    // 링크를 타고 온 사람이 바로 나가도 오류 없음
    const b = t.join({ name: '새교주' })
    t.create(b, '만두교')
    const n4 = helloRef(t, '새교주', '넷째손님')
    t.room.disconnect(n4.conn)
    t.advance(3000)
    expect(t.host.errors()).toEqual([])
  })
})
