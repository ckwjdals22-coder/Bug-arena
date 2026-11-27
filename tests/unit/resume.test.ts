/**
 * 끊김에 강한 접속: 짧은 끊김은 같은 번호·자리·상태로 이어 붙이고(resume),
 * 오래 자리를 비웠다 돌아와도 서 있던 자리와 따라오던 신도를 되찾는다(seat recall).
 */
import { describe, expect, it } from 'vitest'
import { BATTLE_DURATION_MS, FOLLOW_DURATION_MS, IDLE_TIMEOUT_MS, INF_BATTLE_WIN, PROTOCOL_VERSION } from '../../shared/constants'
import { STAT } from '../../shared/content/core'
import { REJOIN_MEMORY_MS, RESUME_GRACE_MS } from '../../server/core/room'
import { createBattleSystem } from '../../server/core/systems/battle'
import { R_JOIN, setup } from './helpers'

type T = ReturnType<typeof setup>
type Who = { conn: number; id: number }

/** 같은 pid 로 새 연결을 연다(옛 연결은 건드리지 않는다) */
function reopen(t: T, pid: string, name = '돌아온사람') {
  const conn = t.nextConn()
  t.room.connect(conn)
  t.send(conn, { t: 'hello', v: PROTOCOL_VERSION, pid, name, look: [0, 0, 0, 0, 0, 0, 0], save: null })
  const w = t.host.of(conn, 'welcome')[0]
  if (!w) throw new Error(`welcome 없음: ${JSON.stringify(t.host.json(conn))}`)
  return { conn, id: w.id, w }
}
const keepAlive = (t: T, ...who: Who[]): void => {
  for (const w of who) t.send(w.conn, { t: 'ping', c: 1 })
}
const near = (t: T, a: Who, b: Who): void => {
  t.player(b.id).x = t.player(a.id).x + 1
  t.player(b.id).z = t.player(a.id).z
}
const seen = (t: T, conn: number, ...types: string[]) => t.host.json(conn).filter((m) => types.includes(m.t))

describe('짧은 끊김: 방에 그대로 서서 기다린다', () => {
  it('비정상 끊김은 다른 사람에게 퇴장으로 보이지 않고, 기다리는 시간이 지나야 퇴장한다', () => {
    const t = setup()
    const a = t.join({ pid: 'blip-aaaaaaaaaa' })
    const b = t.join()
    t.host.clear()
    t.room.disconnect(a.conn, false)
    expect(t.room.players.has(a.id)).toBe(true)
    expect(seen(t, b.conn, 'leave')).toEqual([])
    keepAlive(t, b)
    t.advance(RESUME_GRACE_MS - 1000)
    expect(t.room.players.has(a.id)).toBe(true)
    keepAlive(t, b)
    t.advance(2000)
    expect(t.room.players.has(a.id)).toBe(false)
    expect(seen(t, b.conn, 'leave')).toEqual([{ t: 'leave', id: a.id }])
  })

  it('정상 종료(탭 닫기·나가기)는 바로 퇴장한다', () => {
    const t = setup()
    const a = t.join()
    const b = t.join()
    t.host.clear()
    t.room.disconnect(a.conn)
    expect(t.room.players.has(a.id)).toBe(false)
    expect(seen(t, b.conn, 'leave')).toEqual([{ t: 'leave', id: a.id }])
  })

  it('기다리는 동안 다시 붙으면 같은 번호·같은 자리로 이어지고, 남들에게는 아무 일도 없었던 것처럼 보인다', () => {
    const t = setup()
    const a = t.join({ pid: 'blip-aaaaaaaaaa', name: '깜빡이' })
    const b = t.join()
    t.room.grant(t.player(a.id), { why: 'test', inf: 40, fol: 2 })
    const pa = t.player(a.id)
    pa.x += 3
    const { x, z } = pa
    t.host.clear()
    t.room.disconnect(a.conn, false)
    keepAlive(t, b)
    t.advance(3000)
    const a2 = reopen(t, 'blip-aaaaaaaaaa')
    expect(a2.id).toBe(a.id)
    expect(a2.w).toMatchObject({ x, z, name: '깜빡이' })
    expect(a2.w.me).toMatchObject({ inf: 40, fol: 2 })
    expect(a2.w.players.map((p) => p.id)).toEqual([b.id])
    expect(seen(t, b.conn, 'leave', 'join')).toEqual([])
    // 이어 붙은 뒤에는 기다림이 끝난다: 한참 지나도 퇴장하지 않는다
    for (let i = 0; i < 6; i++) {
      keepAlive(t, a2, b)
      t.advance(5000)
    }
    expect(t.room.players.has(a.id)).toBe(true)
    // 새 연결로 보낸 것이 실제로 처리된다
    t.host.clear()
    t.send(a2.conn, { t: 'emote', e: 'wave' })
    expect(t.host.of(b.conn, 'emote')).toEqual([{ t: 'emote', id: a.id, e: 'wave' }])
  })

  it('끊기는 순간 열려 있던 대화는 접히고 시민은 풀려난다', () => {
    const t = setup()
    const a = t.join({ pid: 'blip-aaaaaaaaaa' })
    t.talk(a, 1)
    expect(t.npc(1).talker).toBe(a.id)
    t.room.disconnect(a.conn, false)
    expect(t.npc(1).talker).toBe(0)
    expect(t.player(a.id).talk).toBeNull()
  })

  it('따라오던 신도는 기다리는 동안 그대로 있고, 돌아오면 welcome 에도 내 신도로 실린다', () => {
    const t = setup()
    const a = t.join({ pid: 'blip-aaaaaaaaaa' })
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    expect(t.npc(1).owner).toBe(a.id)
    t.room.disconnect(a.conn, false)
    t.advance(2000)
    expect(t.npc(1).owner).toBe(a.id)
    const a2 = reopen(t, 'blip-aaaaaaaaaa')
    expect(a2.w.npcs.find((n) => n.id === 1)?.owner).toBe(a.id)
  })

  it('기다리는 사람도 자리를 차지한다(정원 계산), 다른 방에서 같은 pid 가 들어오면 바로 내보낸다', () => {
    const t = setup({ capacity: 2 })
    const a = t.join({ pid: 'blip-aaaaaaaaaa' })
    t.join()
    t.room.disconnect(a.conn, false)
    const c = t.nextConn()
    t.hello(c)
    expect(t.host.of(c, 'full')).toHaveLength(1)
    expect(t.room.kickPid('blip-aaaaaaaaaa', 'dup')).toBe(true)
    expect(t.room.players.has(a.id)).toBe(false)
    // 기다림 목록에서도 빠졌다: 시간이 지나도 두 번 퇴장 처리되지 않는다
    t.advance(RESUME_GRACE_MS + 1000)
    expect(t.host.errors()).toEqual([])
  })
})

describe('짧은 끊김과 포교 배틀', () => {
  function startBattle(t: T) {
    const a = t.join({ pid: 'duel-aaaaaaaaaa' })
    const b = t.join({ pid: 'duel-bbbbbbbbbb' })
    near(t, a, b)
    t.send(a.conn, { t: 'battle', a: 'req', to: b.id })
    t.send(b.conn, { t: 'battle', a: 'ans', from: a.id, ok: true })
    return { a, b }
  }

  it('1초 끊겼다 돌아와도 배틀은 무효가 되지 않고 이어진다', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = startBattle(t)
    t.host.clear()
    t.room.disconnect(a.conn, false)
    keepAlive(t, b)
    t.advance(1000)
    const a2 = reopen(t, 'duel-aaaaaaaaaa')
    expect(a2.id).toBe(a.id)
    expect(a2.w.battles).toHaveLength(1)
    expect(a2.w.battles[0]).toMatchObject({ a: a.id, b: b.id })
    expect(t.host.of(b.conn, 'battle').filter((m) => m.ph === 'end')).toEqual([])
    // 돌아온 사람의 점수가 계속 오른다 → 끝까지 가면 승리
    const npcId = t.room.npcs.list[0]!.id
    t.talk(a2, npcId)
    t.pitch(a2, npcId, R_JOIN)
    const inf0 = t.player(a.id).prog.inf
    for (let left = BATTLE_DURATION_MS; left > 0; left -= 5000) {
      keepAlive(t, a2, b)
      t.advance(5000)
    }
    expect(t.stat(a.id, STAT.battleWins)).toBe(1)
    expect(t.player(a.id).prog.inf - inf0).toBe(INF_BATTLE_WIN)
  })

  it('끝내 돌아오지 않으면 기다리는 시간이 지난 뒤 평소 규칙대로 끝난다(0:0 이면 무효)', () => {
    const t = setup({ systems: [createBattleSystem] })
    const { a, b } = startBattle(t)
    t.host.clear()
    t.room.disconnect(a.conn, false)
    keepAlive(t, b)
    t.advance(RESUME_GRACE_MS + 500)
    const ends = t.host.of(b.conn, 'battle').filter((m) => m.ph === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ winner: 0, why: 'left' })
    expect(t.stat(b.id, STAT.battleWins)).toBe(0)
  })
})

describe('자리 기억: 나갔다가 곧 돌아오면 서 있던 자리와 신도를 되찾는다', () => {
  /** 한동안 논 사람: 신도 둘을 달고 움직여 있다 */
  function settled(t: T) {
    const a = t.join({ pid: 'away-aaaaaaaaaa' })
    t.talk(a, 1)
    t.pitch(a, 1, R_JOIN)
    t.advance(4000)
    keepAlive(t, a)
    t.talk(a, 2)
    t.pitch(a, 2, R_JOIN)
    const p = t.player(a.id)
    return { a, x: p.x, z: p.z }
  }

  it('자리 비움으로 내보내진 뒤 다시 들어오면 그 자리에서, 임자 없는 옛 신도와 함께 시작한다', () => {
    const t = setup()
    const { a, x, z } = settled(t)
    t.npc(1).offered = true
    const until1 = t.npc(1).until
    // 아무것도 보내지 않으면(휴대폰에서 다른 앱으로 간 상황) 자리 비움으로 내보내진다
    t.advance(IDLE_TIMEOUT_MS + 2000)
    expect(t.room.players.has(a.id)).toBe(false)
    expect(t.npc(1).owner).toBe(0)
    const a2 = reopen(t, 'away-aaaaaaaaaa')
    expect(a2.id).not.toBe(a.id)
    expect(a2.w.x).toBeCloseTo(x, 1)
    expect(a2.w.z).toBeCloseTo(z, 1)
    expect(t.npc(1).owner).toBe(a2.id)
    expect(t.npc(2).owner).toBe(a2.id)
    // 남은 시간과 '이미 헌납함' 표시는 그대로다(나갔다 들어오기로 헌납을 되풀이하지 못한다)
    expect(t.npc(1).until).toBe(until1)
    expect(t.npc(1).offered).toBe(true)
    expect(t.npc(2).offered).toBe(false)
    // 돌아온 본인에게도 신도 주인 소식이 간다
    expect(
      t.host
        .of(a2.conn, 'nu')
        .filter((m) => m.owner === a2.id)
        .map((m) => m.n)
        .sort(),
    ).toEqual([1, 2])
  })

  it('그사이 다른 사람이 데려간 시민, 바뀐 시민, 시간이 다 된 신도는 되찾지 않는다', () => {
    const t = setup()
    const { a } = settled(t)
    const b = t.join()
    t.room.disconnect(a.conn)
    // 1번은 다른 사람이 데려갔다
    t.room.npcs.startFollow(t.npc(1), b.id, t.host.t + FOLLOW_DURATION_MS, t.host.t)
    // 2번 자리는 새 시민으로 바뀌었다
    t.npc(2).name = '새로 온 시민'
    const a2 = reopen(t, 'away-aaaaaaaaaa')
    expect(t.npc(1).owner).toBe(b.id)
    expect(t.npc(2).owner).toBe(0)
    expect(t.room.npcs.followersOf(a2.id)).toHaveLength(0)
  })

  it('기억하는 시간(5분)이 지나면 평소처럼 출구에서 시작한다', () => {
    const t = setup()
    const { a, x, z } = settled(t)
    const b = t.join()
    t.player(a.id).x = x + 6
    t.room.disconnect(a.conn)
    for (let left = REJOIN_MEMORY_MS + 5000; left > 0; left -= 5000) {
      keepAlive(t, b)
      t.advance(5000)
    }
    const a2 = reopen(t, 'away-aaaaaaaaaa')
    const spawns = t.room.world.spawns
    const nearSpawn = spawns.some((s) => Math.hypot(s.x - a2.w.x, s.z - a2.w.z) < 3)
    expect(nearSpawn).toBe(true)
    expect(Math.hypot(a2.w.x - (x + 6), a2.w.z - z)).toBeGreaterThan(1)
    expect(t.room.npcs.followersOf(a2.id)).toHaveLength(0)
  })

  it('스쳐 지나간 접속(신도 없음, 20초 미만)은 자리를 기억하지 않는다', () => {
    const t = setup()
    const memory = (t.room as unknown as { memory: Map<string, unknown> }).memory
    const a = t.join({ pid: 'passer-aaaaaaaa' })
    t.advance(3000)
    t.room.disconnect(a.conn)
    expect(memory.has('passer-aaaaaaaa')).toBe(false)
  })
})
