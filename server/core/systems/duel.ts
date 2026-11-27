/**
 * 라이벌 교주 기싸움 — 포교하려던 상대가 "저도 사실 교주입니다"(outcome 'rival')라며 역포교를 걸어오면
 * 3지선다로 허세 대결을 한다. 정답은 늘 '더 황당한 쪽'이다(누가 더 뻔뻔한가의 개그 대결).
 *
 *  - 이기면 라이벌이 신도로 합류(+신도 2, 영향력 20).
 *  - 지거나 시간이 지나면 지금 따라다니던 가장 오래된 신도 한 명이 라이벌 쪽으로 넘어가 버린다(누적 신도 수는 그대로).
 *
 * 코어는 interceptPitch 를 부르기 전에 이미 pitchRes 를 방송했다 → 여기서는 다시 보내지 않는다.
 * 가로챈 뒤의 대화 세션 정리(p.talk, talkEnd)는 이 시스템 몫이다.
 */
import { FOLLOW_DURATION_MS, NPC_REJECT_MEMORY_MS, PITCH_COOLDOWN_MS, entourageCap } from '../../../shared/constants'
import { STAT } from '../../../shared/content/core'
import { DUELS } from '../../../shared/content/misc'
import type { DuelDef } from '../../../shared/content/types'
import { DETACHED_CONN, type NpcState, type PlayerState, type RoomApi, type RoomSystem } from '../api'

/** 고를 시간 */
export const DUEL_MS = 12_000
/** 라이벌이 멈춰서 기다려 주는 시간(고를 시간 + 여유) */
export const DUEL_LISTEN_MS = 14_000
/** 마감 직전에 누른 선택이 망 지연으로 늦게 도착해도 받아 준다 */
const DUEL_GRACE_MS = 400
/** 끊겼다 돌아온 화면에 문제를 다시 보여 줄 때 보장하는 최소 시간(읽고 고를 틈) */
export const DUEL_RESUME_MIN_MS = 5000
export const INF_DUEL_WIN = 20
export const FOL_DUEL_WIN = 2
export const INF_DUEL_LOSE = 3
export const POACHED_LINE = '저쪽 교주님이 더 그럴듯해서요…'
export const DUEL_VOID_GONE = '라이벌이 홀연히 사라졌습니다. 기싸움 무효.'
export const DUEL_VOID_DROPPED = '접속이 잠깐 끊긴 사이 라이벌이 가 버렸습니다. 기싸움 무효.'

const KEY = 'duel'
const LAST_KEY = 'duelLast'

interface Duel {
  n: number
  def: number
  until: number
}

const duelOf = (p: PlayerState): Duel | undefined => p.ext[KEY] as Duel | undefined

export function createDuelSystem(): RoomSystem {
  let room: RoomApi

  function pickDef(p: PlayerState): number {
    const len = DUELS.length
    const last = typeof p.ext[LAST_KEY] === 'number' ? (p.ext[LAST_KEY] as number) : -1
    let i = Math.floor(room.rnd() * len) % len
    if (i === last && len > 1) i = (i + 1) % len
    return i
  }

  function finish(p: PlayerState, d: Duel, win: boolean): void {
    delete p.ext[KEY]
    const now = room.now()
    const def = DUELS[d.def] as DuelDef
    const rival = room.npcs.get(d.n)
    // 상대가 그사이 사라졌거나(교체) 다른 일로 대화가 풀렸다면 벌칙 없이 조용히 끝낸다
    const present = !!rival && rival.talker === p.id
    p.cd.set('pitch', now + PITCH_COOLDOWN_MS)
    if (!present || !rival) {
      room.send(p, { t: 'duel', ph: 'end', n: d.n, win: false, void: true, text: DUEL_VOID_GONE })
      return
    }
    if (win) {
      // 정원이 찼으면 가장 오래 따라다닌 신도부터 보내 준다(코어의 합류 처리와 같은 규칙)
      const mine = room.npcs.followersOf(p.id).filter((f) => f !== rival)
      mine.sort((a, b) => a.followSince - b.followSince)
      // 붐비는 방에서는 정원이 줄어든다(코어의 합류 처리와 같은 기준)
      while (mine.length >= entourageCap(room.players.size)) {
        const oldest = mine.shift()
        if (oldest) room.npcs.release(oldest, 'expire')
      }
      const poach = rival.owner !== 0 && rival.owner !== p.id
      room.npcs.startFollow(rival, p.id, now + FOLLOW_DURATION_MS, now)
      if (rival.talker === p.id) rival.talker = 0
      room.grant(p, { why: 'duel', inf: INF_DUEL_WIN, fol: FOL_DUEL_WIN })
      room.bump(p, STAT.rivalWins)
      if (poach) room.bump(p, STAT.poaches)
      room.npcSay([[rival.id, def.winText]])
      room.send(p, { t: 'duel', ph: 'end', n: rival.id, win: true, text: def.winText })
      return
    }
    // 패배/시간 초과: 가장 오래된 신도 하나가 라이벌 쪽 교리에 넘어간다
    const says: [number, string][] = [[rival.id, def.loseText]]
    const mine = room.npcs.followersOf(p.id).filter((f) => f !== rival)
    mine.sort((a, b) => a.followSince - b.followSince)
    const oldest = mine[0]
    if (oldest) {
      room.npcs.release(oldest, 'poach')
      says.push([oldest.id, POACHED_LINE])
    }
    room.npcs.remember(rival, p.id, now + NPC_REJECT_MEMORY_MS)
    if (rival.owner !== 0) {
      // 남의 신도였던 라이벌은 원래 주인 곁으로 돌아간다
      room.npcs.endListen(rival)
    } else {
      room.npcs.walkOff(rival)
      if (rival.talker === p.id) room.npcs.endListen(rival)
    }
    if (rival.talker === p.id) rival.talker = 0
    room.grant(p, { why: 'duel', inf: INF_DUEL_LOSE })
    room.npcSay(says)
    room.send(p, { t: 'duel', ph: 'end', n: rival.id, win: false, text: def.loseText })
  }

  /** 벌칙도 보상도 없이 접는다(끊겼다 돌아온 사람: 선택지를 본 적 없는 화면에서 신도를 잃으면 안 된다) */
  function cancel(p: PlayerState, d: Duel, text: string): void {
    delete p.ext[KEY]
    const rival = room.npcs.get(d.n)
    if (rival && rival.talker === p.id) {
      room.npcs.endListen(rival)
      if (rival.talker === p.id) rival.talker = 0
    }
    p.cd.set('pitch', room.now() + PITCH_COOLDOWN_MS)
    room.send(p, { t: 'duel', ph: 'end', n: d.n, win: false, void: true, text })
  }

  return {
    name: 'duel',
    handles: ['duel'],
    init(r) {
      room = r
    },
    interceptPitch(p, npc: NpcState, _line, result) {
      if (result.outcome !== 'rival' || duelOf(p)) return false
      const now = room.now()
      const talk = p.talk
      const i = pickDef(p)
      const def = DUELS[i] as DuelDef
      p.ext[LAST_KEY] = i
      const until = now + DUEL_MS
      p.ext[KEY] = { n: npc.id, def: i, until } satisfies Duel
      // 일반 멘트 고르기는 끝났다: 대화 세션을 닫고, 라이벌은 기싸움 동안 멈춰서 기다린다
      p.talk = null
      room.npcs.beginListen(npc, p, now + DUEL_LISTEN_MS)
      if (talk) room.send(p, { t: 'talkEnd', n: talk.npc, why: 'done' })
      room.bump(p, STAT.rivals)
      room.send(p, { t: 'duel', ph: 'start', n: npc.id, say: def.say, choices: [...def.choices], until })
      return true
    },
    onMessage(p, msg) {
      if (msg.t !== 'duel') return
      const d = duelOf(p)
      if (!d) return
      const c = (msg as { c?: unknown }).c
      const def = DUELS[d.def] as DuelDef
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c >= def.choices.length) {
        room.send(p, { t: 'err', code: 'duel' })
        return
      }
      if (room.now() > d.until + DUEL_GRACE_MS) {
        finish(p, d, false)
        return
      }
      finish(p, d, def.win.includes(c))
    },
    onTick(now) {
      for (const p of room.players.values()) {
        const d = duelOf(p)
        if (!d || now <= d.until + DUEL_GRACE_MS) continue
        // 연결이 끊긴 채 서 있는 사람은 고를 수가 없었다: 시간 초과 패배로 치지 않고 둔다(돌아오면 onResume 이 무효로 접는다)
        if (p.conn === DETACHED_CONN) continue
        finish(p, d, false)
      }
    },
    onResume(p) {
      const d = duelOf(p)
      if (!d) return
      const now = room.now()
      const rival = room.npcs.get(d.n)
      // 끊긴 사이에 고를 시간이 지나갔거나 라이벌이 가 버렸다: 벌칙 없이 무효
      if (!rival || rival.talker !== p.id || now > d.until + DUEL_GRACE_MS) {
        cancel(p, d, DUEL_VOID_DROPPED)
        return
      }
      // 아직 고를 수 있다: 새 화면에 문제를 다시 보여 준다. 여기서 무효로 접어 주면 '새 탭 열기'가
      // 질 것 같은 기싸움을 언제든 물리는 버튼이 된다. 읽을 틈은 보장하고, 라이벌도 그만큼 더 기다린다
      d.until = Math.max(d.until, now + DUEL_RESUME_MIN_MS)
      room.npcs.beginListen(rival, p, d.until + (DUEL_LISTEN_MS - DUEL_MS))
      const def = DUELS[d.def] as DuelDef
      room.send(p, { t: 'duel', ph: 'start', n: d.n, say: def.say, choices: [...def.choices], until: d.until })
    },
    onLeave(p) {
      // 코어가 NPC 쪽 정리(onPlayerLeave)를 이미 했다. 기싸움 기록만 지운다
      delete p.ext[KEY]
    },
  }
}
