/**
 * 진행도 건네주기: 저장본은 1초에 한 번만 내려가므로, 나가기 직전에 받은 보상은 클라이언트 저장본에 없을 수 있다.
 * 나간 사람의 마지막 진행도를 접속자 메모에 PROG_HANDOVER_MS 동안 두었다가, 같은 pid 가 다시 들어오면
 * 저장본보다 새것일 때 그쪽을 쓴다(Node 어댑터에서는 메모 저장소를 방끼리 공유하므로 방을 옮겨도 이어진다).
 */
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../shared/constants'
import type { PlayerMemory } from '../../server/core/api'
import { PROG_HANDOVER_MS, Room } from '../../server/core/room'
import type { SignedSave } from '../../shared/types'
import { FakeSim, LOOK0, R_JOIN, TEST_WORLD, setup } from './helpers'

type T = ReturnType<typeof setup>

/** 지금 클라이언트가 들고 있을 가장 새 저장본(welcome 또는 마지막 save 메시지) */
function latestSave(t: T, conn: number): SignedSave {
  let save = t.host.of(conn, 'welcome')[0]!.save
  for (const m of t.host.of(conn, 'save')) save = m.save
  return save
}

/** 저장본이 나간 직후, 보상을 하나 더 받고 200ms 뒤 연결을 닫는 상황을 만든다 */
function rewardThenLeave(t: T, pid: string): { save: SignedSave; infLive: number; infSaved: number } {
  const a = t.join({ pid })
  t.advance(1500)
  t.talk(a, 1)
  t.pitch(a, 1, R_JOIN)
  t.advance(2200)
  t.send(a.conn, { t: 'emote', e: 'wave' }) // 통계가 바뀌어 다음 틱에 저장본이 나간다
  t.advance(100)
  t.talk(a, 2)
  t.pitch(a, 2, R_JOIN) // 저장본은 1초 간격이라 아직 안 나간다
  const infLive = t.player(a.id).prog.inf
  t.advance(200)
  const save = latestSave(t, a.conn)
  const infSaved = (JSON.parse(save.d) as { inf: number }).inf
  t.room.disconnect(a.conn) // 방 옮기기/탭 닫기: 정상 종료라 바로 퇴장
  return { save, infLive, infSaved }
}

describe('진행도 건네주기', () => {
  it('나가기 직전에 받은 보상이 저장본에 없어도, 곧 다시 들어오면 이어진다', () => {
    const t = setup()
    const pid = 'device-handover-0001'
    const { save, infLive, infSaved } = rewardThenLeave(t, pid)
    expect(infLive).toBeGreaterThan(infSaved)
    const b = t.join({ pid, save })
    expect(b.w.me.inf).toBe(infLive)
    expect(t.player(b.id).prog.stats['joins']).toBe(2)
  })

  it('다른 방으로 옮겨도 이어진다(메모 저장소를 공유하는 Node 어댑터)', () => {
    const t = setup()
    const memory = (t.room as unknown as { memory: Map<string, PlayerMemory> }).memory
    const sim = new FakeSim()
    const room2 = new Room(t.host, { id: '2', name: '둘째 방', capacity: 20, npcCount: 9, seed: 3, world: TEST_WORLD, systems: [], memory }, { createNpcSim: sim.factory })
    const pid = 'device-handover-0002'
    const { save, infLive } = rewardThenLeave(t, pid)
    const conn = 900
    room2.connect(conn)
    room2.message(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid, name: '옮긴사람', look: LOOK0, save }))
    const w = t.host.of(conn, 'welcome')[0]!
    expect(w.me.inf).toBe(infLive)
  })

  it('기억은 PROG_HANDOVER_MS 뒤에 사라지고, 저장본이 더 새것이면 저장본을 쓴다', () => {
    const t = setup()
    const pid = 'device-handover-0003'
    const { save, infSaved } = rewardThenLeave(t, pid)
    t.host.t += PROG_HANDOVER_MS + 1
    const b = t.join({ pid, save })
    expect(b.w.me.inf).toBe(infSaved)

    // 저장본이 더 새것(나간 뒤 다른 방에서 더 놀다 온 경우 등)이면 저장본
    const t2 = setup()
    const pid2 = 'device-handover-0004'
    const r = rewardThenLeave(t2, pid2)
    const d = JSON.parse(r.save.d) as { inf: number; ts: number }
    d.inf = 999
    d.ts = t2.host.t + 1
    const text = JSON.stringify(d)
    const c = t2.join({ pid: pid2, save: { d: text, s: t2.host.signer.sign(text) } })
    expect(c.w.me.inf).toBe(999)
  })

  it('다른 pid 의 기억은 쓰지 않고, 한 번 건넨 기억은 다시 쓰지 않는다', () => {
    const t = setup()
    const pid = 'device-handover-0005'
    const { save, infLive, infSaved } = rewardThenLeave(t, pid)
    const other = t.join({ pid: 'device-handover-other', save: null })
    expect(other.w.me.inf).toBe(0)
    const b = t.join({ pid, save })
    expect(b.w.me.inf).toBe(infLive)
    // 아무 변화 없이 나가면(클라이언트가 이미 welcome 의 최신 저장본을 가졌으므로) 기억하지 않는다.
    // 그때 옛 저장본을 내밀면 옛 저장본이 쓰인다 — 한 번 건넨 기억이 다시 끼어들지 않는다는 뜻
    t.room.disconnect(b.conn)
    const memory = (t.room as unknown as { memory: Map<string, PlayerMemory> }).memory
    expect(memory.get(pid)?.prog).toBeUndefined()
    const c = t.join({ pid, save })
    expect(c.w.me.inf).toBe(infSaved)
    // welcome 으로 받은 최신 저장본을 내밀면 최신 값
    t.room.disconnect(c.conn)
    const d = t.join({ pid, save: b.w.save })
    expect(d.w.me.inf).toBe(infLive)
  })
})
