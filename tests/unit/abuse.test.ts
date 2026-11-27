/**
 * 악용·괴롭힘 회귀 테스트.
 * 독립 검수에서 실제로 재현됐던 우회 경로들(재접속으로 쿨타임/차단/입막음 지우기, 보상 찍어내기, 다중 계정 신고)이
 * 다시 열리지 않는지 확인한다.
 */
import { describe, expect, it } from 'vitest'
import {
  BATTLE_COOLDOWN_MS,
  INF_BATTLE_WIN,
  INVITE_COOLDOWN_MS,
  INVITE_GLOBAL_COOLDOWN_MS,
  NPC_REJECT_MEMORY_MS,
  PITCH_COOLDOWN_MS,
  PROTOCOL_VERSION,
} from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import type { PlayerMemory } from '../../server/core/api'
import { NAME_CHANGE_COOLDOWN_MS, Room } from '../../server/core/room'
import { createBattleSystem } from '../../server/core/systems/battle'
import {
  MUTE_MS,
  NAME_LOCK_MS,
  RECRUIT_INF,
  RECRUIT_REWARD_SLOTS,
  REPORT_MIN_INF,
  REPORT_MIN_SESSION_MS,
  createCultSystem,
} from '../../server/core/systems/cult'
import { FakeHost, R_JOIN, R_NO, TEST_WORLD, setup } from './helpers'

type T = ReturnType<typeof setup>
type Who = { conn: number; id: number }

function near(t: T, a: Who, b: Who): void {
  const pa = t.player(a.id)
  const pb = t.player(b.id)
  pb.x = pa.x + 1
  pb.z = pa.z
}
/** 같은 pid 로 다시 들어온다. takeover = 옛 연결을 끊지 않고 새 탭으로 덮어쓰기 */
function rejoin(t: T, who: Who, pid: string, extra: Record<string, unknown> = {}, takeover = false): Who {
  if (!takeover) t.room.disconnect(who.conn)
  const conn = t.nextConn()
  t.room.connect(conn)
  t.send(conn, { t: 'hello', v: PROTOCOL_VERSION, pid, name: `다시${conn}`, look: [0, 0, 0, 0, 0, 0, 0], save: null, ...extra })
  const w = t.host.of(conn, 'welcome')[0]
  if (!w) throw new Error('welcome 없음')
  return { conn, id: w.id }
}
function makeCult(t: T, who: Who, name = '퇴근교'): void {
  t.send(who.conn, { t: 'cultCreate', name, color: 0, emblem: 0, title: '교주' })
}
function keepAlive(t: T, ...who: Who[]): void {
  for (const w of who) t.send(w.conn, { t: 'ping', c: 1 })
}
/** 신고 자격(방에 머문 시간 + 영향력)을 갖춘 사람으로 만든다 */
function seasoned(t: T, ...who: Who[]): void {
  for (const w of who) {
    const p = t.player(w.id)
    p.prog.inf = Math.max(p.prog.inf, REPORT_MIN_INF)
    p.joinedAt = t.host.t - REPORT_MIN_SESSION_MS
  }
}

describe('보상 찍어내기 방지', () => {
  it('가입 → 탈퇴 → 재가입을 반복해도 영입 보상·전적은 한 번뿐이다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'farmer-aaaaaaaa' })
    const b = t.join({ pid: 'helper-bbbbbbbb' })
    near(t, a, b)
    makeCult(t, a)
    const inf0 = t.player(a.id).prog.inf
    for (let i = 0; i < 10; i++) {
      t.send(a.conn, { t: 'invite', to: b.id })
      t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
      expect(t.player(b.id).prog.cult?.role).toBe('member') // 가입 자체는 매번 성립한다
      t.send(b.conn, { t: 'cultLeave' })
      keepAlive(t, a, b)
      t.advance(INVITE_GLOBAL_COOLDOWN_MS)
    }
    expect(t.stat(a.id, STAT.recruits)).toBe(1)
    expect(t.player(a.id).prog.inf - inf0).toBe(RECRUIT_INF)
    expect(t.stat(b.id, STAT.joinedCults)).toBe(1)
  })

  it('도우미가 재접속해서 다시 가입해도 보상은 늘지 않는다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'farmer-aaaaaaaa' })
    let b: Who = t.join({ pid: 'helper-bbbbbbbb' })
    makeCult(t, a)
    for (let i = 0; i < 4; i++) {
      near(t, a, b)
      t.send(a.conn, { t: 'invite', to: b.id })
      t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
      b = rejoin(t, b, 'helper-bbbbbbbb')
      keepAlive(t, a, b)
      t.advance(INVITE_GLOBAL_COOLDOWN_MS)
    }
    expect(t.stat(a.id, STAT.recruits)).toBe(1)
  })

  it('매번 새 계정을 데려와도 영입 보상은 10분에 정해진 횟수까지만 나온다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'farmer-aaaaaaaa' })
    makeCult(t, a)
    const inf0 = t.player(a.id).prog.inf
    for (let i = 0; i < RECRUIT_REWARD_SLOTS + 4; i++) {
      const b = t.join({ pid: `fresh-helper-${String(i).padStart(4, '0')}` })
      near(t, a, b)
      t.send(a.conn, { t: 'invite', to: b.id })
      t.send(b.conn, { t: 'inviteAns', from: a.id, ok: true })
      t.room.disconnect(b.conn)
      keepAlive(t, a)
      t.advance(INVITE_GLOBAL_COOLDOWN_MS)
    }
    expect(t.stat(a.id, STAT.recruits)).toBe(RECRUIT_REWARD_SLOTS)
    expect(t.player(a.id).prog.inf - inf0).toBe(RECRUIT_REWARD_SLOTS * RECRUIT_INF)
  })

  it('배틀을 수락하고 바로 나가 줘도 승리·보상이 생기지 않는다(무효)', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join({ pid: 'winner-aaaaaaaa' })
    let b: Who = t.join({ pid: 'loser-bbbbbbbbb' })
    const inf0 = t.player(a.id).prog.inf
    for (let i = 0; i < 3; i++) {
      near(t, a, b)
      t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
      t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
      b = rejoin(t, b, 'loser-bbbbbbbbb')
      keepAlive(t, a, b)
      t.advance(BATTLE_COOLDOWN_MS)
    }
    expect(t.stat(a.id, STAT.battleWins)).toBe(0)
    expect(t.stat(a.id, STAT.battles)).toBe(0)
    expect(t.player(a.id).prog.inf - inf0).toBe(0)
    const ends = t.host.of(a.conn, 'battle').filter((m) => m.ph === 'end')
    expect(ends.length).toBeGreaterThan(0)
    for (const e of ends) expect(e).toMatchObject({ winner: 0, why: 'left' })
  })

  it('앞서고 있을 때 상대가 나가면 승리로 인정된다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    const b = t.join()
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
    const npcId = t.room.npcs.list[0]!.id
    t.talk(a, npcId)
    t.pitch(a, npcId, R_JOIN)
    const inf0 = t.player(a.id).prog.inf
    t.room.disconnect(b.conn)
    expect(t.stat(a.id, STAT.battleWins)).toBe(1)
    expect(t.player(a.id).prog.inf - inf0).toBe(INF_BATTLE_WIN)
  })

  it('배틀 도중 나간 사람의 쿨타임은 재접속해도 남아 있다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const a = t.join()
    let b: Who = t.join({ pid: 'leaver-bbbbbbbb' })
    const c = t.join()
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
    b = rejoin(t, b, 'leaver-bbbbbbbb')
    near(t, c, b)
    t.host.clear()
    t.send(b.conn, { t: 'battle', a: 'req', to: c.id })
    expect(t.host.of(b.conn, 'battle').map((m) => (m.ph === 'no' ? m.why : m.ph))).toEqual(['cool'])
    expect(t.host.of(c.conn, 'battle')).toHaveLength(0)
  })

  it('포교 링크(?by=)로 여러 번 다시 들어와도 자동 초대·소식은 한 번이고, 초대자의 전적은 오르지 않는다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'victim-aaaaaaaa', name: '교주님' })
    makeCult(t, a)
    const c = t.join({ pid: 'onlooker-cccccccc' })
    let b: Who = t.join({ pid: 'spammer-bbbbbbbb' })
    t.host.clear()
    let cards = 0
    for (let i = 0; i < 5; i++) {
      b = rejoin(t, b, 'spammer-bbbbbbbb', { ref: '교주님' })
      keepAlive(t, a, c)
      t.advance(2100)
      cards += t.host.of(b.conn, 'invited').length
    }
    expect(cards).toBe(1)
    expect(t.host.of(c.conn, 'feed').filter((f) => f.k === 'cult')).toHaveLength(1)
    expect(t.stat(a.id, STAT.invites)).toBe(0)
  })

  it('서로 다른 새 계정이 링크로 줄줄이 들어와도 방 전체 소식은 초대자당 1분에 한 번이다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'victim-aaaaaaaa', name: '교주님' })
    makeCult(t, a)
    const c = t.join({ pid: 'onlooker-cccccccc' })
    t.host.clear()
    for (let i = 0; i < 5; i++) {
      const conn = t.nextConn()
      t.room.connect(conn)
      t.send(conn, { t: 'hello', v: PROTOCOL_VERSION, pid: `sock-puppet-${String(i).padStart(4, '0')}`, name: `손${i}`, look: [0, 0, 0, 0, 0, 0, 0], save: null, ref: '교주님' })
      keepAlive(t, a, c)
      t.advance(2100)
      t.room.disconnect(conn)
    }
    expect(t.host.of(c.conn, 'feed').filter((f) => f.k === 'cult')).toHaveLength(1)
  })
})

describe('재접속으로 제재·거절·차단을 지울 수 없다', () => {
  it('입막음은 같은 pid 로 다시 들어와도 유지된다', () => {
    const t = setup({ systems: [createCultSystem] })
    const v = t.join({ pid: 'muted-vvvvvvvv' })
    const rs = [t.join(), t.join(), t.join()]
    seasoned(t, ...rs)
    for (const r of rs) t.send(r.conn, { t: 'report', id: v.id, why: 'spam' })
    expect(t.player(v.id).mutedUntil).toBe(t.host.t + MUTE_MS)
    const v2 = rejoin(t, v, 'muted-vvvvvvvv')
    expect(t.player(v2.id).mutedUntil).toBeGreaterThan(t.host.t)
    t.host.clear()
    t.send(v2.conn, { t: 'say', q: 0 })
    expect(t.host.of(rs[0]!.conn, 'say')).toHaveLength(0)
    // 새 탭으로 덮어써도 마찬가지
    const v3 = rejoin(t, v2, 'muted-vvvvvvvv', {}, true)
    t.send(v3.conn, { t: 'say', q: 0 })
    expect(t.host.of(rs[0]!.conn, 'say')).toHaveLength(0)
  })

  it('입막음 시간이 지나면 다시 말할 수 있다', () => {
    const t = setup({ systems: [createCultSystem] })
    const v = t.join({ pid: 'muted-vvvvvvvv' })
    const rs = [t.join(), t.join(), t.join()]
    seasoned(t, ...rs)
    for (const r of rs) t.send(r.conn, { t: 'report', id: v.id, why: 'spam' })
    t.room.disconnect(v.conn)
    for (let left = MUTE_MS + 1000; left > 0; left -= 5000) {
      keepAlive(t, ...rs)
      t.advance(5000)
    }
    const v2 = rejoin(t, v, 'muted-vvvvvvvv', {}, true)
    t.host.clear()
    t.send(v2.conn, { t: 'say', q: 0 })
    expect(t.host.of(rs[0]!.conn, 'say')).toHaveLength(1)
  })

  it('신고로 바뀐 이름은 profile 로도, 재접속으로도 한동안 되돌릴 수 없다', () => {
    const t = setup({ systems: [createCultSystem] })
    const v = t.join({ pid: 'badname-vvvvvvvv', name: '교주킹' })
    const r1 = t.join()
    const r2 = t.join()
    seasoned(t, r1, r2)
    t.send(r1.conn, { t: 'report', id: v.id, why: 'name' })
    t.send(r2.conn, { t: 'report', id: v.id, why: 'name' })
    const forced = t.player(v.id).name
    expect(forced).not.toBe('교주킹')
    t.send(v.conn, { t: 'profile', name: '교주킹' })
    t.advance(100)
    expect(t.player(v.id).name).toBe(forced)
    expect(t.host.of(v.conn, 'err').some((e) => e.code === 'name')).toBe(true)
    // hello 에 옛 이름을 실어 다시 들어와도 고정된 이름으로 들어온다
    t.room.disconnect(v.conn)
    const conn = t.nextConn()
    t.room.connect(conn)
    t.send(conn, { t: 'hello', v: PROTOCOL_VERSION, pid: 'badname-vvvvvvvv', name: '교주킹', look: [0, 0, 0, 0, 0, 0, 0], save: null })
    const w = t.host.of(conn, 'welcome')[0]!
    expect(w.name).toBe(forced)
    // 고정 시간이 지나면 바꿀 수 있다
    for (let left = NAME_LOCK_MS + 1000; left > 0; left -= 5000) {
      keepAlive(t, r1, r2, { conn, id: w.id })
      t.advance(5000)
    }
    t.send(conn, { t: 'profile', name: '새사람' })
    t.advance(100)
    expect(t.player(w.id).name).toBe('새사람')
  })

  it('이름은 연달아 바꿀 수 없다(쿨타임)', () => {
    const t = setup()
    const a = t.join({ name: '처음이름' })
    t.send(a.conn, { t: 'profile', name: '둘째이름' })
    t.send(a.conn, { t: 'profile', name: '셋째이름' })
    t.advance(100)
    expect(t.player(a.id).name).toBe('둘째이름')
    expect(t.host.of(a.conn, 'err').filter((e) => e.code === 'name')).toHaveLength(1)
    t.advance(NAME_CHANGE_COOLDOWN_MS)
    t.send(a.conn, { t: 'profile', name: '셋째이름' })
    t.advance(100)
    expect(t.player(a.id).name).toBe('셋째이름')
  })

  it('막 들어온 계정 여러 개의 신고로는 남의 이름을 바꾸거나 입을 막을 수 없다', () => {
    const t = setup({ systems: [createCultSystem] })
    const v = t.join({ pid: 'innocent-vvvvvvvv', name: '평범한사람' })
    const socks = [t.join({ pid: 'sock-one-11111111' }), t.join({ pid: 'sock-two-22222222' }), t.join({ pid: 'sock-three-333333' })]
    for (const s of socks) t.send(s.conn, { t: 'report', id: v.id, why: 'name' })
    expect(t.player(v.id).name).toBe('평범한사람')
    t.advance(11_000)
    for (const s of socks) t.send(s.conn, { t: 'report', id: v.id, why: 'spam' })
    expect(t.player(v.id).mutedUntil).toBe(0)
    // 오래 머물기만 하고 한 번도 놀지 않은 계정도 자격이 없다
    for (const s of socks) t.player(s.id).joinedAt = t.host.t - REPORT_MIN_SESSION_MS
    t.advance(11_000)
    for (const s of socks) t.send(s.conn, { t: 'report', id: v.id, why: 'name' })
    expect(t.player(v.id).name).toBe('평범한사람')
  })

  it('거절당한 초대자는 재접속·새 탭으로도 바로 다시 초대할 수 없다', () => {
    const t = setup({ systems: [createCultSystem] })
    let a: Who = t.join({ pid: 'stalker-aaaaaaaa' })
    const b = t.join({ pid: 'target-bbbbbbbb' })
    near(t, a, b)
    makeCult(t, a)
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: false })
    a = rejoin(t, a, 'stalker-aaaaaaaa', {}, true)
    near(t, b, a)
    t.host.clear()
    t.advance(INVITE_GLOBAL_COOLDOWN_MS)
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.host.of(b.conn, 'invited')).toHaveLength(0)
    expect(t.host.of(a.conn, 'inviteRes').at(-1)).toMatchObject({ r: 'cool' })
  })

  it('거절한 사람이 잠깐 끊겼다 돌아와도 거절 쿨타임은 유지된다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'stalker-aaaaaaaa' })
    let b: Who = t.join({ pid: 'target-bbbbbbbb' })
    near(t, a, b)
    makeCult(t, a)
    t.send(a.conn, { t: 'invite', to: b.id })
    t.send(b.conn, { t: 'inviteAns', from: a.id, ok: false })
    b = rejoin(t, b, 'target-bbbbbbbb')
    near(t, a, b)
    keepAlive(t, a)
    t.advance(INVITE_GLOBAL_COOLDOWN_MS)
    t.host.clear()
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.host.of(b.conn, 'invited')).toHaveLength(0)
    // 쿨타임이 끝나면 다시 보낼 수 있다
    for (let left = INVITE_COOLDOWN_MS; left > 0; left -= 5000) {
      keepAlive(t, a, b)
      t.advance(5000)
    }
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.host.of(b.conn, 'invited')).toHaveLength(1)
  })

  it('배틀 거절 쿨타임도 재접속으로 지워지지 않는다', () => {
    const t = setup({ systems: [createBattleSystem] })
    let a: Who = t.join({ pid: 'stalker-aaaaaaaa' })
    const b = t.join({ pid: 'target-bbbbbbbb' })
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: false })
    a = rejoin(t, a, 'stalker-aaaaaaaa')
    near(t, b, a)
    t.host.clear()
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    expect(t.host.of(b.conn, 'battle').filter((m) => m.ph === 'inv')).toHaveLength(0)
  })

  it('차단은 차단한 사람이 재접속해도, 상대가 이름을 바꿔도 유지된다', () => {
    const t = setup({ systems: [createCultSystem] })
    const a = t.join({ pid: 'stalker-aaaaaaaa', name: '스토커' })
    let b: Who = t.join({ pid: 'target-bbbbbbbb' })
    makeCult(t, a)
    t.send(b.conn, { t: 'block', id: a.id, on: true })
    t.send(a.conn, { t: 'profile', name: '새이름' })
    t.advance(100)
    b = rejoin(t, b, 'target-bbbbbbbb')
    near(t, a, b)
    t.host.clear()
    t.send(a.conn, { t: 'invite', to: b.id })
    expect(t.host.of(b.conn, 'invited')).toHaveLength(0)
    // 차단 사실은 드러나지 않는다: 보낸 사람에게는 '보냄'으로 보인다
    expect(t.host.of(a.conn, 'inviteRes').at(-1)).toMatchObject({ r: 'sent' })
  })

  it('배틀 중인 사람에게 신청하면 차단 여부와 무관하게 똑같이 "바쁨"이 온다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const x = t.join()
    const y = t.join()
    near(t, x, y)
    t.send(x.conn, { t: 'battle', a: 'req', to: y.id })
    t.send(y.conn, { t: 'battle', a: 'ans', from: x.id, ok: true })
    const blocked = t.join()
    const free = t.join()
    t.player(blocked.id).x = t.player(x.id).x + 1
    t.player(free.id).x = t.player(x.id).x - 1
    t.player(blocked.id).z = t.player(free.id).z = t.player(x.id).z
    t.player(x.id).blocked.add(t.player(blocked.id).pid)
    t.host.clear()
    t.send(free.conn, { t: 'battle', a: 'req', to: x.id })
    t.send(blocked.conn, { t: 'battle', a: 'req', to: x.id })
    expect(t.host.of(free.conn, 'battle').map((m) => (m.ph === 'no' ? m.why : m.ph))).toEqual(['busy'])
    expect(t.host.of(blocked.conn, 'battle').map((m) => (m.ph === 'no' ? m.why : m.ph))).toEqual(['busy'])
  })
})

describe('시민의 거절 기억도 재접속으로 지울 수 없다', () => {
  it('방금 거절한 시민에게는 다시 들어와도 바로 말을 걸 수 없다(같은 시민 다시 뽑기 방지)', () => {
    const t = setup()
    let a: Who = t.join({ pid: 'reroller-aaaaaaa' })
    t.talk(a, 1)
    t.pitch(a, 1, R_NO)
    a = rejoin(t, a, 'reroller-aaaaaaa')
    t.advance(PITCH_COOLDOWN_MS + 500)
    t.host.clear()
    t.talk(a, 1)
    expect(t.host.of(a.conn, 'talkOk')).toHaveLength(0)
    expect(t.host.of(a.conn, 'talkNo').at(-1)).toMatchObject({ n: 1, why: 'memo' })
    // 다른 시민에게는 말을 걸 수 있다
    t.talk(a, 2)
    expect(t.host.of(a.conn, 'talkOk')).toHaveLength(1)
  })

  it('기억 시간이 지나면 다시 말을 걸 수 있고, 그 자리의 시민이 바뀌었으면 적용되지 않는다', () => {
    const t = setup()
    let a: Who = t.join({ pid: 'reroller-aaaaaaa' })
    t.talk(a, 1)
    t.pitch(a, 1, R_NO)
    t.advance(PITCH_COOLDOWN_MS + 200)
    t.talk(a, 2)
    t.pitch(a, 2, R_NO)
    // 2번 자리의 시민이 떠나고 새 시민이 왔다
    t.npc(2).name = '새로 온 시민'
    t.npc(2).memo.clear()
    a = rejoin(t, a, 'reroller-aaaaaaa')
    t.advance(PITCH_COOLDOWN_MS + 500)
    t.host.clear()
    t.talk(a, 2)
    expect(t.host.of(a.conn, 'talkOk')).toHaveLength(1)
    t.send(a.conn, { t: 'talkEnd' })
    for (let left = NPC_REJECT_MEMORY_MS; left > 0; left -= 5000) {
      keepAlive(t, a)
      t.advance(5000)
    }
    t.host.clear()
    t.talk(a, 1)
    expect(t.host.of(a.conn, 'talkOk')).toHaveLength(1)
  })
})

describe('접속자별 메모는 쌓이지 않는다', () => {
  it('기억할 것이 없는 사람은 나가는 즉시 잊고, 쿨타임이 끝난 사람도 청소된다', () => {
    const t = setup({ systems: [createCultSystem] })
    const memory = (t.room as unknown as { memory: Map<string, unknown> }).memory
    const stay = t.join({ pid: 'stays-aaaaaaaaaa' })
    for (let i = 0; i < 50; i++) {
      const p = t.join({ pid: `passer-by-${String(i).padStart(6, '0')}` })
      t.room.disconnect(p.conn)
    }
    expect(memory.size).toBe(1)
    // 쿨타임을 남기고 나간 사람은 그 쿨타임 동안만 기억된다
    const b = t.join({ pid: 'emoter-bbbbbbbbb' })
    t.send(b.conn, { t: 'profile', name: '바꾼이름' })
    t.advance(100)
    t.room.disconnect(b.conn)
    expect(memory.has('emoter-bbbbbbbbb')).toBe(true)
    for (let left = 70_000; left > 0; left -= 5000) {
      keepAlive(t, stay)
      t.advance(5000)
    }
    expect(memory.has('emoter-bbbbbbbbb')).toBe(false)
    expect(memory.size).toBe(1)
  })
})

describe('방을 옮겨도 제재는 따라간다(방들이 메모 저장소를 함께 쓸 때)', () => {
  it('1번 방에서 입막음된 사람이 2번 방으로 옮겨도 말풍선이 나가지 않는다', () => {
    const host = new FakeHost()
    const memory = new Map<string, PlayerMemory>()
    const rooms = ['1', '2'].map((id) => new Room(host, { id, name: `방 ${id}`, npcCount: 0, seed: 3, world: TEST_WORLD, systems: [createCultSystem], memory }))
    // 실제 서버처럼: 같은 pid 는 한 방에만 있게 한다
    host.claimPid = (pid: string, roomId: string): void => {
      for (const r of rooms) if (r.id !== roomId) r.kickPid(pid, 'dup')
    }
    let nextConn = 1
    const join = (room: Room, pid: string): { conn: number; id: number } => {
      const conn = nextConn++
      room.connect(conn)
      room.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid, name: `손님${conn}`, look: [0, 0, 0, 0, 0, 0, 0], save: null }))
      const w = host.of(conn, 'welcome')[0]
      if (!w) throw new Error('welcome 없음')
      return { conn, id: w.id }
    }
    const [r1, r2] = rooms as [Room, Room]
    const v = join(r1, 'muted-vvvvvvvv')
    const reporters = [join(r1, 'reporter-0000001'), join(r1, 'reporter-0000002'), join(r1, 'reporter-0000003')]
    for (const r of reporters) {
      const p = r1.players.get(r.id)!
      p.prog.inf = REPORT_MIN_INF
      p.joinedAt = host.t - REPORT_MIN_SESSION_MS
      r1.message(r.conn, JSON.stringify({ t: 'report', id: v.id, why: 'spam' }))
    }
    expect(r1.players.get(v.id)!.mutedUntil).toBeGreaterThan(host.t)
    const listener = join(r2, 'listener-0000001')
    const v2 = join(r2, 'muted-vvvvvvvv')
    expect(r1.players.has(v.id)).toBe(false)
    expect(r2.players.get(v2.id)!.mutedUntil).toBeGreaterThan(host.t)
    r2.message(v2.conn, JSON.stringify({ t: 'say', q: 0 }))
    expect(host.of(listener.conn, 'say')).toHaveLength(0)
  })
})

