/**
 * 1대1 포교 배틀: 두 사람이 서로 동의하면 제한 시간 동안 NPC 신도를 더 많이 모은 쪽이 이긴다.
 *
 * 원칙
 *  - 양쪽이 명시적으로 동의해야만 시작한다(신청 → 상대가 수락). 누구도 강제로 배틀에 끌려가지 않는다.
 *  - 점수는 서버가 센다: 배틀 중인 사람의 포교 결과가 합류(join/king)일 때만 +1.
 *  - 나를 차단한 사람에게 보낸 신청은 전달하지 않고, 조금 뒤 '거절'로만 보이게 한다(차단 사실을 드러내지 않는다).
 */
import {
  BATTLE_COOLDOWN_MS,
  BATTLE_DURATION_MS,
  INF_BATTLE_LOSE,
  INF_BATTLE_WIN,
  INVITE_TTL_MS,
  PLAYER_INTERACT_RANGE,
} from '../../../shared/constants'
import { STAT } from '../../../shared/content/core'
import type { BattleState, CBattle } from '../../../shared/protocol'
import type { PlayerState, RoomApi, RoomSystem } from '../api'

interface Pending {
  from: number
  to: number
  until: number
}
interface FakeDecline {
  to: number
  at: number
}

export function createBattleSystem(): RoomSystem {
  let room: RoomApi
  const battles: BattleState[] = []
  /** 대상 플레이어 id → 대기 중인 신청 */
  const pending = new Map<number, Pending>()
  const fakeDeclines: FakeDecline[] = []

  const battleOf = (id: number): BattleState | undefined => battles.find((b) => b.a === id || b.b === id)
  const hasPending = (id: number): boolean => {
    if (pending.has(id)) return true
    for (const p of pending.values()) if (p.from === id) return true
    return false
  }
  const coolLeft = (p: PlayerState, now: number): number => (p.cd.get('battle') ?? 0) - now
  const setCool = (p: PlayerState | undefined, now: number): void => {
    p?.cd.set('battle', now + BATTLE_COOLDOWN_MS)
  }

  function finish(b: BattleState, why: 'time' | 'left', leftId = 0): void {
    const i = battles.indexOf(b)
    if (i < 0) return
    battles.splice(i, 1)
    const now = room.now()
    const pa = room.players.get(b.a)
    const pb = room.players.get(b.b)
    let winner = 0
    // 상대가 나갔을 때: 남은 사람이 실제로 앞서 있었을 때만 승리다.
    // 그렇지 않으면 무효(보상·전적 없음) — '수락하고 바로 나가 주기'로 승리를 찍어낼 수 없게.
    let voided = false
    if (why === 'left') {
      const stayIsA = leftId !== b.a
      if (stayIsA ? b.sa > b.sb : b.sb > b.sa) winner = stayIsA ? b.a : b.b
      else voided = true
    } else if (b.sa !== b.sb) winner = b.sa > b.sb ? b.a : b.b
    const tie = Math.round((INF_BATTLE_WIN + INF_BATTLE_LOSE) / 2)
    for (const [p, id] of [
      [pa, b.a],
      [pb, b.b],
    ] as const) {
      if (!p) continue
      setCool(p, now)
      if (voided) continue
      room.bump(p, STAT.battles)
      if (winner === id) room.bump(p, STAT.battleWins)
      room.grant(p, { why: 'battle', inf: winner === 0 ? tie : winner === id ? INF_BATTLE_WIN : INF_BATTLE_LOSE })
    }
    room.broadcast({ t: 'battle', ph: 'end', b, winner, ...(why === 'left' ? { why: 'left' as const } : {}) })
    const na = pa?.name ?? '상대'
    const nb = pb?.name ?? '상대'
    if (voided) room.feed('battle', 0, `포교 배틀 무효 — 한 분이 자리를 떴습니다. (${b.sa}:${b.sb})`)
    else if (winner === 0) room.feed('battle', 0, `${na} vs ${nb} — ${b.sa}:${b.sb} 무승부! 둘 다 말은 많았습니다.`)
    else {
      const w = winner === b.a ? na : nb
      room.feed('battle', winner, `포교 배틀 종료 — ${w} 승리! (${b.sa}:${b.sb})`)
    }
  }

  function request(p: PlayerState, toId: number, now: number): void {
    const no = (why: 'cool' | 'busy' | 'far' | 'no'): void => room.send(p, { t: 'battle', ph: 'no', why })
    const target = room.players.get(toId)
    if (!target || target === p) return no('far')
    if (p.mutedUntil > now) return no('cool')
    if (coolLeft(p, now) > 0) return no('cool')
    if (battleOf(p.id) || hasPending(p.id)) return no('busy')
    if (Math.hypot(target.x - p.x, target.z - p.z) > PLAYER_INTERACT_RANGE + 1) return no('far')
    // '바쁨'은 누구에게나 똑같이 먼저 알린다(차단 여부에 따라 응답이 달라지면 차단 사실이 드러난다)
    if (battleOf(target.id) || hasPending(target.id)) return no('busy')
    if (target.blocked.has(p.pid)) {
      // 차단당한 사실은 알려 주지 않는다: 2~4초 뒤 평범한 거절처럼 보인다
      p.cd.set('battle', now + 4000)
      fakeDeclines.push({ to: p.id, at: now + 2000 + Math.floor(room.rnd() * 2000) })
      return
    }
    const until = now + INVITE_TTL_MS
    pending.set(target.id, { from: p.id, to: target.id, until })
    room.send(target, { t: 'battle', ph: 'inv', from: p.id, until })
  }

  function answer(p: PlayerState, fromId: number, ok: boolean, now: number): void {
    const req = pending.get(p.id)
    if (!req || req.from !== fromId) return
    pending.delete(p.id)
    const from = room.players.get(fromId)
    if (!from) return
    if (!ok) {
      setCool(from, now)
      room.send(from, { t: 'battle', ph: 'no', why: 'no' })
      return
    }
    // 수락하는 사이에 한쪽이 다른 배틀에 들어갔을 수 있다
    if (battleOf(p.id) || battleOf(from.id)) {
      room.send(from, { t: 'battle', ph: 'no', why: 'busy' })
      room.send(p, { t: 'battle', ph: 'no', why: 'busy' })
      return
    }
    const b: BattleState = { a: from.id, b: p.id, sa: 0, sb: 0, endsAt: now + BATTLE_DURATION_MS }
    battles.push(b)
    room.broadcast({ t: 'battle', ph: 'start', b })
    room.feed('battle', from.id, `${from.name} vs ${p.name} 포교 배틀 시작! 60초 동안 누가 더 많이 모으나`)
  }

  return {
    name: 'battle',
    handles: ['battle'],
    init(r) {
      room = r
    },
    onMessage(p, msg) {
      if (msg.t !== 'battle') return
      const m = msg as CBattle
      const now = room.now()
      if (m.a === 'req') {
        if (typeof m.to !== 'number') return
        request(p, m.to, now)
      } else if (m.a === 'ans') {
        if (typeof m.from !== 'number') return
        answer(p, m.from, m.ok === true, now)
      }
    },
    onTick(now) {
      for (const [id, req] of pending) {
        if (now < req.until) continue
        pending.delete(id)
        const from = room.players.get(req.from)
        if (from) {
          setCool(from, now)
          room.send(from, { t: 'battle', ph: 'no', why: 'no' })
        }
      }
      for (let i = fakeDeclines.length - 1; i >= 0; i--) {
        const f = fakeDeclines[i]!
        if (now < f.at) continue
        fakeDeclines.splice(i, 1)
        const p = room.players.get(f.to)
        if (p) {
          setCool(p, now)
          room.send(p, { t: 'battle', ph: 'no', why: 'no' })
        }
      }
      for (const b of [...battles]) if (now >= b.endsAt) finish(b, 'time')
    },
    onPitch(p, _npc, _line, outcome) {
      if (outcome !== 'join' && outcome !== 'king') return
      const b = battleOf(p.id)
      if (!b) return
      if (b.a === p.id) b.sa++
      else b.sb++
      room.broadcast({ t: 'battle', ph: 'score', b })
    },
    onLeave(p) {
      // 내가 받은 신청/보낸 신청 정리
      const got = pending.get(p.id)
      if (got) {
        pending.delete(p.id)
        const from = room.players.get(got.from)
        if (from) room.send(from, { t: 'battle', ph: 'no', why: 'left' })
      }
      for (const [id, req] of pending) {
        if (req.from !== p.id) continue
        pending.delete(id)
        // 신청한 사람이 나갔으니 상대의 카드도 거둔다
        const target = room.players.get(id)
        if (target) room.send(target, { t: 'battle', ph: 'no', why: 'left' })
      }
      for (let i = fakeDeclines.length - 1; i >= 0; i--) if (fakeDeclines[i]!.to === p.id) fakeDeclines.splice(i, 1)
      const b = battleOf(p.id)
      if (b) {
        // 나간 사람에게도 쿨타임을 남긴다(쿨타임 표는 재접속해도 이어진다)
        setCool(p, room.now())
        finish(b, 'left', p.id)
      }
    },
    onWelcome(_p, w) {
      w.battles = battles.map((b) => ({ ...b }))
    },
  }
}
