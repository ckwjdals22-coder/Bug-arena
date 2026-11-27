/**
 * 단상 — 오늘의 계시, 집단 설교, 정각 대집회.
 *
 * 설계 메모(왜 이렇게 했는가)
 *  - 서버가 전부 판정한다: 단상 위치, 쿨타임, 응답 창, 게이지 계산, 신도 합류. 클라이언트가 보내는 것은
 *    "누르고 싶다"는 의사(prophecy / sermon a=start|join|resp, r=라운드)뿐이다.
 *  - 시간은 room.now() 와 onTick 으로만 흐른다(코어는 전송 계층과 무관해야 하므로 타이머를 직접 만들지 않는다).
 *  - 설교에서 모은 구경꾼은 시뮬이 until 에 스스로 풀어 버린다. 시뮬 틱이 시스템 틱보다 먼저 돌기 때문에
 *    until = endsAt 이면 우리가 결과를 셀 때 이미 흩어져 있다 → 끝 시각보다 조금 늦게 잡고 직접 ungather 한다.
 *  - 정각 대집회는 "그 시각에 접속해 있던 사람들"끼리 잠깐 북적이게 만드는 장치다. 심야 전용 보상은 만들지 않는다.
 */
import {
  FOLLOW_DURATION_MS,
  INF_PROPHECY,
  INF_SERMON_JOIN,
  INF_SERMON_LEADER,
  INF_SERMON_SOLO,
  PROPHECY_COOLDOWN_MS,
  PROPHECY_PAY_SLOTS,
  PROPHECY_PAY_WINDOW_MS,
  SERMON_DURATION_MS,
  SERMON_ROOM_COOLDOWN_MS,
  SERMON_ROUNDS,
  SERMON_SOLO_CONVERTS,
  entourageCap,
  npcKey,
} from '../../../shared/constants'
import { STAT } from '../../../shared/content/core'
import { PROPHECIES, PROPHECY_REACTIONS, SERMON_CHANTS, SERMON_CHEERS } from '../../../shared/content/prophecies'
import type { ClientMsg, SermonState } from '../../../shared/protocol'
import type { NpcState, PlayerState, RoomApi, RoomSystem } from '../api'

/** 단상 판정 여유(클라이언트 예측 위치와 서버 위치의 차이) */
export const PODIUM_PAD = 0.4
/** 계시 반응을 보이는 NPC 거리 / 최대 수 */
export const PROPHECY_REACT_RANGE = 14
export const PROPHECY_REACT_MAX = 6
/** 계시를 말한 교주의 포교 버프 */
export const PROPHECY_BUFF = 0.08
export const PROPHECY_BUFF_MS = 30_000
/** 같은 방에서 최근 N개의 계시는 다시 뽑지 않는다 */
export const PROPHECY_RECENT = 5
/** 설교 참여 가능 거리: 광장 반지름 + 이만큼 */
export const SERMON_JOIN_PAD = 4
/** 교주가 단상에서 이만큼 넘게 벗어나면 설교 중단 */
export const SERMON_LEAVE_DIST = 6
/** 라운드 구호 시각(시작 기준) — 4초 / 11초 / 18초 … */
export const SERMON_FIRST_CALL_MS = 4000
export const SERMON_CALL_GAP_MS = 7000
/** 응답 창 */
export const SERMON_RESP_MS = 3500
/** 응답 창 마감 뒤에도 받아 주는 여유(왕복 지연으로 아깝게 놓치지 않게) */
export const SERMON_RESP_GRACE_MS = 400
/** 구호 뒤 구경꾼 환호까지 */
export const SERMON_CHEER_DELAY_MS = 1000
/** 구경꾼 모으기 최대 수 */
export const SERMON_GATHER_MAX = 12
/** 시뮬이 구경꾼을 먼저 풀어 버리지 않도록 끝 시각보다 늦게 잡는 여유 */
const GATHER_SLACK_MS = 3000
export const SERMON_MAX_CONVERTS = 5
/** 정각 대집회 */
export const HOUR_MS = 3_600_000
export const RALLY_MS = 180_000
export const RALLY_MULT = 2

interface Sermon {
  state: SermonState
  /** 구경하러 모인 NPC id */
  gathered: number[]
  /** 지금 열려 있는 라운드(1..), 0 = 없음 */
  round: number
  /** 다음에 부를 라운드 번호(1..SERMON_ROUNDS) */
  nextRound: number
  respUntil: number
  /** 쓴 구호 인덱스 */
  usedChants: number[]
  /** pid 가 아니라 방 안 id: 설교는 26초짜리라 재접속하면 새 사람으로 본다 */
  answered: Map<number, Set<number>>
  cheerAt: number
}

export function createPodiumSystem(): RoomSystem {
  let room!: RoomApi
  let sermon: Sermon | null = null
  /** 마지막 설교가 끝난 시각(방 쿨타임 기준) */
  let lastEndAt = -Infinity
  const recent: number[] = []
  let lastHour = 0
  let rallyUntil = 0

  const onPodium = (p: PlayerState): boolean => {
    const w = room.world.podium
    return Math.hypot(p.x - w.x, p.z - w.z) <= w.r + PODIUM_PAD
  }
  const rallyMult = (): number => (room.now() < rallyUntil ? RALLY_MULT : 1)

  /** 계시 보상 칸(쿨타임 표에 둔다 → 재접속해도 유지). 남았으면 하나 쓰고 true */
  function takeProphecyPay(p: PlayerState, now: number): boolean {
    for (let i = 0; i < PROPHECY_PAY_SLOTS; i++) {
      const key = 'podium.pay' + String(i)
      if ((p.cd.get(key) ?? 0) > now) continue
      p.cd.set(key, now + PROPHECY_PAY_WINDOW_MS)
      return true
    }
    return false
  }

  // ───────── 오늘의 계시 ─────────
  function pickProphecy(): number {
    const n = PROPHECIES.length
    // 최근 것을 뺀 후보에서 고른다(후보가 없을 만큼 목록이 짧으면 그냥 아무거나)
    const pool: number[] = []
    for (let i = 0; i < n; i++) if (!recent.includes(i)) pool.push(i)
    const idx = pool.length > 0 ? pool[Math.floor(room.rnd() * pool.length) % pool.length]! : Math.floor(room.rnd() * n) % n
    recent.push(idx)
    while (recent.length > PROPHECY_RECENT) recent.shift()
    return idx
  }

  function onProphecy(p: PlayerState): void {
    if (!onPodium(p)) return
    if (room.cooldown(p, 'podium:prophecy', PROPHECY_COOLDOWN_MS) > 0) return
    const text = PROPHECIES[pickProphecy()] ?? PROPHECIES[0]!
    // 가까운 NPC 부터 반응한다. 퇴장/등장 중인 사람은 화면에서 사라지는 중이라 말풍선이 허공에 뜬다 → 뺀다
    const near: { n: NpcState; d: number }[] = []
    for (const n of room.npcs.list) {
      if (n.mode === 'leave' || n.mode === 'enter') continue
      const d = Math.hypot(n.x - p.x, n.z - p.z)
      if (d <= PROPHECY_REACT_RANGE) near.push({ n, d })
    }
    near.sort((a, b) => a.d - b.d || a.n.id - b.n.id)
    const re: [number, string][] = near.slice(0, PROPHECY_REACT_MAX).map(({ n }) => {
      const line = PROPHECY_REACTIONS[Math.floor(room.rnd() * PROPHECY_REACTIONS.length) % PROPHECY_REACTIONS.length]!
      return [npcKey(n.id), line]
    })
    room.broadcast({ t: 'prophecy', p: p.id, text, re })
    // 계시 자체(방송·버프·농담)는 언제나 되지만, 영향력은 10분에 정해진 횟수까지만(단상에 서서 계시만 반복하는 농사 방지)
    if (takeProphecyPay(p, room.now())) room.grant(p, { why: 'prophecy', inf: INF_PROPHECY * rallyMult() })
    room.bump(p, STAT.prophecies)
    p.buff = Math.max(p.buffUntil > room.now() ? p.buff : 0, PROPHECY_BUFF)
    p.buffUntil = Math.max(p.buffUntil, room.now() + PROPHECY_BUFF_MS)
  }

  // ───────── 집단 설교 ─────────
  const snapshot = (): SermonState | undefined => (sermon ? { ...sermon.state, joined: [...sermon.state.joined] } : undefined)

  function start(p: PlayerState): void {
    const now = room.now()
    if (sermon) return room.send(p, { t: 'sermon', ph: 'no', why: 'busy' })
    if (!onPodium(p)) return room.send(p, { t: 'sermon', ph: 'no', why: 'far' })
    const left = lastEndAt + SERMON_ROOM_COOLDOWN_MS - now
    if (left > 0) return room.send(p, { t: 'sermon', ph: 'no', why: 'cool', ms: Math.ceil(left) })
    const endsAt = now + SERMON_DURATION_MS
    const gathered = room.npcs.gather(room.world.podium, room.world.plaza.r, endsAt + GATHER_SLACK_MS, SERMON_GATHER_MAX)
    sermon = {
      state: { leader: p.id, startedAt: now, endsAt, joined: [p.id] },
      gathered: gathered.map((n) => n.id),
      round: 0,
      nextRound: 1,
      respUntil: 0,
      usedChants: [],
      answered: new Map(),
      cheerAt: 0,
    }
    room.broadcast({ t: 'sermon', ph: 'start', s: snapshot() })
    // 소식 피드가 종류별 아이콘(📣)을 앞에 붙이므로 문구에는 넣지 않는다
    room.feed('sermon', p.id, `${p.name}님이 단상에서 집단 설교를 시작했습니다! 광장으로 모이세요`)
  }

  function join(p: PlayerState): void {
    const s = sermon
    if (!s || s.state.joined.includes(p.id)) return
    const pl = room.world.plaza
    if (Math.hypot(p.x - pl.x, p.z - pl.z) > pl.r + SERMON_JOIN_PAD) return
    s.state.joined.push(p.id)
    room.broadcast({ t: 'sermon', ph: 'join', s: snapshot() })
  }

  function respond(p: PlayerState, r: unknown): void {
    const s = sermon
    if (!s || typeof r !== 'number' || r !== s.round || s.round === 0) return
    if (!s.state.joined.includes(p.id)) return
    if (room.now() > s.respUntil + SERMON_RESP_GRACE_MS) return
    let set = s.answered.get(r)
    if (!set) s.answered.set(r, (set = new Set()))
    set.add(p.id)
  }

  function callRound(now: number): void {
    const s = sermon!
    const free: number[] = []
    for (let i = 0; i < SERMON_CHANTS.length; i++) if (!s.usedChants.includes(i)) free.push(i)
    const idx = free.length > 0 ? free[Math.floor(room.rnd() * free.length) % free.length]! : 0
    s.usedChants.push(idx)
    const chant = SERMON_CHANTS[idx]!
    s.round = s.nextRound++
    s.respUntil = now + SERMON_RESP_MS
    s.cheerAt = now + SERMON_CHEER_DELAY_MS
    room.broadcast({ t: 'sermon', ph: 'call', s: snapshot(), round: s.round, call: chant.call, resp: chant.resp, until: s.respUntil })
  }

  function cheer(): void {
    const s = sermon!
    const crowd = s.gathered.map((id) => room.npcs.get(id)).filter((n): n is NpcState => !!n && n.mode === 'gather')
    // 3~5명이 외친다(구경꾼이 적으면 있는 만큼)
    const want = Math.min(crowd.length, 3 + (Math.floor(room.rnd() * 3) % 3))
    const lines: [number, string][] = []
    for (let i = 0; i < want; i++) {
      const k = i + (Math.floor(room.rnd() * (crowd.length - i)) % (crowd.length - i))
      ;[crowd[i], crowd[k]] = [crowd[k]!, crowd[i]!]
      lines.push([crowd[i]!.id, SERMON_CHEERS[Math.floor(room.rnd() * SERMON_CHEERS.length) % SERMON_CHEERS.length]!])
    }
    if (lines.length > 0) room.npcSay(lines)
  }

  /** 설교 끝. aborted 면 보상 없이 점수 0 */
  function finish(aborted: boolean): void {
    const s = sermon
    if (!s) return
    sermon = null
    const now = room.now()
    lastEndAt = now
    const leader = room.players.get(s.state.leader)
    const joined = s.state.joined.filter((id) => room.players.has(id))
    let score = 0
    let converts = 0
    if (!aborted && leader) {
      let total = 0
      const responders = new Set<number>()
      for (const set of s.answered.values()) {
        for (const id of set) {
          if (!room.players.has(id)) continue
          total++
          responders.add(id)
        }
      }
      // 분모는 실제로 끝까지 남은 참여자 수. 중간에 나간 사람 때문에 남은 사람의 게이지가 깎이지 않게 한다
      const denom = SERMON_ROUNDS * Math.max(1, joined.length)
      score = Math.max(0, Math.min(100, Math.round((100 * total) / denom)))
      // 교주 혼자 연 설교(참여자가 교주뿐)는 게이지가 차도 합류 1명·영향력 INF_SERMON_SOLO 까지만.
      // 집단 설교의 보상은 '사람이 모였을 때' 나와야 한다(혼자 단상에서 응답 버튼만 누르는 농사 방지)
      const solo = joined.length < 2
      const cap = solo ? SERMON_SOLO_CONVERTS : SERMON_MAX_CONVERTS
      const want = Math.min(cap, Math.floor(score / 34) + (joined.length >= 3 ? 1 : 0) + (joined.length >= 6 ? 1 : 0))
      const slots = Math.max(0, entourageCap(room.players.size) - room.npcs.followersOf(leader.id).length)
      // 구경은 누구나 하지만, 절대 넘어오지 않는 유형(recruitable === false)은 설교로도 신도가 되지 않는다
      const crowd = s.gathered
        .map((id) => room.npcs.get(id))
        .filter((n): n is NpcState => !!n && n.mode === 'gather' && n.owner === 0 && n.talker === 0 && n.arch.recruitable !== false)
      // 앞줄(단상에 가까운 사람)부터 감동한다
      const pd = room.world.podium
      crowd.sort((a, b) => Math.hypot(a.x - pd.x, a.z - pd.z) - Math.hypot(b.x - pd.x, b.z - pd.z) || a.id - b.id)
      converts = Math.max(0, Math.min(want, slots, crowd.length))
      for (let i = 0; i < converts; i++) room.npcs.startFollow(crowd[i]!, leader.id, now + FOLLOW_DURATION_MS, now)

      const mult = rallyMult()
      room.grant(leader, { why: 'sermon', inf: solo ? INF_SERMON_SOLO : INF_SERMON_LEADER * mult, fol: converts })
      room.bump(leader, STAT.sermonsLed)
      for (const id of responders) {
        if (id === leader.id) continue
        const p = room.players.get(id)
        if (!p) continue
        room.grant(p, { why: 'sermon', inf: INF_SERMON_JOIN * mult })
        room.bump(p, STAT.sermonsJoined)
      }
    }
    room.npcs.ungather()
    room.broadcast({ t: 'sermon', ph: 'end', s: { ...s.state, joined }, score, converts })
    const name = leader?.name ?? '교주'
    room.feed(
      'sermon',
      s.state.leader,
      aborted
        ? `${name}님의 설교가 흐지부지 끝났습니다`
        : `${name}님의 설교 종료 · 신앙 게이지 ${score}% · 신도 ${converts}명 합류`,
    )
  }

  function tickSermon(now: number): void {
    const s = sermon
    if (!s) return
    const leader = room.players.get(s.state.leader)
    if (!leader) return finish(true)
    const pd = room.world.podium
    if (Math.hypot(leader.x - pd.x, leader.z - pd.z) > pd.r + SERMON_LEAVE_DIST) return finish(true)
    if (s.cheerAt && now >= s.cheerAt) {
      s.cheerAt = 0
      cheer()
    }
    if (now >= s.state.endsAt) return finish(false)
    if (s.nextRound <= SERMON_ROUNDS && now >= s.state.startedAt + SERMON_FIRST_CALL_MS + (s.nextRound - 1) * SERMON_CALL_GAP_MS) {
      callRound(now)
    }
  }

  // ───────── 정각 대집회 ─────────
  function tickHour(now: number): void {
    const hour = Math.floor(now / HOUR_MS)
    if (hour === lastHour) return
    lastHour = hour
    // 빈 방에서 정각이 지나가면 아무도 모르니 조용히 넘긴다
    if (room.players.size === 0) return
    rallyUntil = now + RALLY_MS
    room.feed('info', 0, '🔔 정각 대집회! 3분 동안 단상 보상이 2배입니다')
  }

  return {
    name: 'podium',
    handles: ['prophecy', 'sermon'],
    init(r) {
      room = r
      lastHour = Math.floor(r.now() / HOUR_MS)
    },
    onMessage(p, msg: ClientMsg) {
      if (msg.t === 'prophecy') return onProphecy(p)
      if (msg.t !== 'sermon') return
      if (msg.a === 'start') start(p)
      else if (msg.a === 'join') join(p)
      else if (msg.a === 'resp') respond(p, msg.r)
    },
    onTick(now) {
      tickHour(now)
      tickSermon(now)
    },
    onLeave(p) {
      if (!sermon) return
      if (sermon.state.leader === p.id) finish(true)
      else sermon.state.joined = sermon.state.joined.filter((id) => id !== p.id)
    },
    onWelcome(_p, w) {
      w.sermon = snapshot() ?? null
    },
  }
}
