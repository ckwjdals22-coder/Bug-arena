/**
 * 네트워크 클라이언트: WebSocket 접속/재접속, 프로토콜 처리(store 반영 → bus 발행), 스냅샷 보간.
 *
 * 원칙
 *  - 서버 메시지를 받으면 store 를 먼저 고치고, 그 다음 bus.emitMsg(msg) 로 다른 모듈에 알린다.
 *  - 의도하지 않게 끊기면 지수 백오프로 같은 방에 다시 붙는다. kick/full 은 자동 재접속하지 않는다.
 *  - 실제 접속자(players)와 NPC(npcs)는 서로 다른 맵에 담는다(절대 섞지 않는다).
 */
import {
  INTERP_DELAY_MS,
  PING_INTERVAL_MS,
  PITCH_COOLDOWN_MS,
  PROTOCOL_VERSION,
} from '../../../shared/constants'
import {
  type ClientMsg,
  type ServerMsg,
  type SWelcome,
  decodeSnapshot,
  encodeMove,
  parseJsonMsg,
} from '../../../shared/protocol'
import { hashString } from '../../../shared/rng'
import type { NpcPublic, PlayerPublic, RoomInfo } from '../../../shared/types'
import { groundHeight } from '../../../shared/world'
import type { Bus } from '../core/bus'
import { apiUrl, wsUrl } from '../core/config'
import type { NetApi } from '../core/contracts'
import { type EntityView, type NpcView, type PlayerView, type Store, saveProfile } from '../core/store'
import { applyInterp, holdSample, pushSample } from './interp'

// 합계 약 70초: 서버 재배포(보통 수십 초) 동안은 버틴다
const BACKOFF_MS = [500, 1000, 2000, 4000, 6000, 8000, 8000, 8000, 10000, 10000, 12000]
/** 한 번도 입장하지 못한 채 이만큼 연달아 실패하면 '서버에 닿지 못함'으로 안내한다(약 4초) */
const UNREACHABLE_AFTER = 3
/** 게임 중 이 시간 동안 서버에서 아무것도 오지 않으면 연결이 죽은 것으로 본다(서버는 초당 여러 번 보낸다) */
const STALE_MS = 10_000
const CONNECT_TIMEOUT_MS = 9000

function makeView(x: number, z: number, yaw: number, st: number, emote: string | null, seed: number, time: number): EntityView {
  return {
    x,
    y: groundHeight(x, z),
    z,
    yaw,
    st,
    emote,
    emoteAt: performance.now(),
    phase: (hashString('p' + seed) % 1000) / 1000,
    bornAt: performance.now(),
    samples: [{ t: time, hold: time, x, z, yaw, st }],
  }
}

export interface Net extends NetApi {
  /** 테스트/디버그용: 망이 끊긴 것처럼 소켓을 닫는다(자동 재접속이 동작해야 한다) */
  debugDrop(): void
}

export function createNet(store: Store, bus: Bus): Net {
  let ws: WebSocket | null = null
  /** 현재 붙으려는/붙어 있는 방 */
  let wantRoom = 'auto'
  /** 의도적 종료(재접속 금지) */
  let intentional = true
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let everPlayed = false
  let lastSnapTime = 0
  /** 서버가 마지막으로 확인해 준 내 이름(이름 변경이 거부되면 이것으로 되돌린다) */
  let confirmedName = ''
  let idleKicked = false
  /** 마지막으로 서버에서 무언가를 받은 시각(performance.now). 조용히 죽은 연결을 알아채는 데 쓴다 */
  let lastRecvAt = 0
  /** 끊기는 순간 하고 있던 것(다시 들어왔을 때 사라졌으면 알려 주기 위해) */
  let before: { id: number; room: string; battle: boolean; sermon: boolean; talk: boolean; idle: boolean } | null = null
  /** 지금 연결을 '있던 방으로 돌아가는 재접속'(resume=1)으로 열었는가 */
  let openedAsResume = false
  /** 있던 방이 나를 이어 붙여 주지 못했다(자리가 이미 넘어갔다): 다음 연결은 평소처럼 자리 있는 방을 찾는다 */
  let resumeDenied = false

  /** 게임 중 연결이 끊겼다: 그 순간의 상태를 적어 둔다(재접속 뒤 비교용). 이미 적어 뒀으면 그대로 둔다 */
  function noteInterrupted(idle = false): void {
    const me = store.me
    if (before || !me || !store.room) return
    before = {
      id: me.id,
      room: store.room.id,
      battle: store.battles.some((b) => b.a === me.id || b.b === me.id),
      sermon: store.sermon !== null,
      talk: store.talk !== null,
      idle,
    }
  }

  function setPhase(phase: Store['phase'], why = ''): void {
    if (store.phase === phase && store.phaseWhy === why) return
    store.phase = phase
    store.phaseWhy = why
    bus.emit('phase', phase)
  }

  function clearTimers(): void {
    clearTimeout(retryTimer)
    clearTimeout(connectTimer)
    clearInterval(pingTimer)
    retryTimer = connectTimer = pingTimer = undefined
  }

  function closeSocket(): void {
    if (!ws) return
    const old = ws
    ws = null
    old.onopen = old.onmessage = old.onclose = old.onerror = null
    try {
      old.close(1000)
    } catch {
      /* ignore */
    }
  }

  function clearRoomState(): void {
    store.players.clear()
    store.npcs.clear()
    store.talk = null
    store.sermon = null
    store.battles = []
    store.near = { npc: 0, player: 0, poi: null }
  }

  function countEntourage(): void {
    const me = store.me
    if (!me) return
    let n = 0
    for (const v of store.npcs.values()) if (v.pub.owner === me.id) n++
    me.entourage = n
  }

  function emitPopulation(): void {
    const players = store.players.size + (store.me ? 1 : 0)
    if (store.room) {
      store.room.players = players
      store.room.npcs = store.npcs.size
    }
    bus.emit('population', { players, npcs: store.npcs.size })
  }

  function open(): void {
    clearTimers()
    closeSocket()
    let sock: WebSocket
    try {
      // 게임 중 끊겼다가 있던 방으로 돌아가는 재접속임을 알린다: 방이 가득 차 보여도 그 방으로 보내 준다
      // (가득 찬 자리 하나가 잠깐 끊긴 나 자신일 수 있다). 누구인지는 hello 로 증명하므로 여기에는 신원을 싣지 않는다.
      const resuming = everPlayed && before !== null && before.room === wantRoom && !resumeDenied
      openedAsResume = resuming
      sock = new WebSocket(wsUrl('/ws?room=' + encodeURIComponent(wantRoom) + (resuming ? '&resume=1' : '')))
    } catch (err) {
      console.error('[net] WebSocket 생성 실패', err)
      scheduleRetry()
      return
    }
    sock.binaryType = 'arraybuffer'
    ws = sock
    connectTimer = setTimeout(() => {
      // 열리지도 닫히지도 않는 연결(모바일 망 전환 등)
      if (ws === sock && store.phase !== 'playing') {
        closeSocket()
        scheduleRetry()
      }
    }, CONNECT_TIMEOUT_MS)

    sock.onopen = () => {
      if (ws !== sock) return
      const p = store.profile
      // 포교 링크(?by=닉네임)로 들어왔다면 초대한 사람을 알린다(서버가 그 사람의 초대 카드를 보내 준다)
      let ref: string | undefined
      try {
        ref = new URLSearchParams(location.search).get('by')?.slice(0, 40) || undefined
      } catch {
        ref = undefined
      }
      sendRaw({ t: 'hello', v: PROTOCOL_VERSION, pid: p.pid, name: p.name, look: p.look, save: p.save, ...(ref ? { ref } : {}) })
    }
    sock.onmessage = (ev) => {
      if (ws !== sock) return
      lastRecvAt = performance.now()
      if (typeof ev.data === 'string') {
        const msg = parseJsonMsg<ServerMsg>(ev.data)
        if (msg) {
          try {
            onMessage(msg)
          } catch (err) {
            console.error('[net] 메시지 처리 오류', msg.t, err)
          }
        }
      } else if (ev.data instanceof ArrayBuffer) {
        onBinary(ev.data)
      }
    }
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      clearTimers()
      bus.emit('net', { rtt: store.rtt, connected: false })
      if (intentional) return
      if (store.phase === 'kicked' || store.phase === 'full') return
      scheduleRetry()
    }
    sock.onerror = () => {
      /* onclose 가 뒤따른다 */
    }
  }

  /**
   * 조용히 죽은 연결 알아채기: 휴대폰이 와이파이↔데이터로 넘어가면 소켓이 닫혔다는 신호 없이 그냥 멎는 일이 흔하다.
   * 게임 중에는 서버가 초당 여러 번 무언가를 보내므로, 한동안 아무것도 안 오면 끊긴 것으로 보고 바로 다시 붙는다.
   */
  function checkStale(): void {
    if (document.hidden || store.phase !== 'playing' || !ws) return
    if (performance.now() - lastRecvAt < STALE_MS) return
    const sock = ws
    ws = null
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
    try {
      // 1000 이 아닌 코드로 닫는다: 혹시 서버에 닿더라도 '정상 퇴장'이 아니라 끊김으로 다뤄져 자리가 유지된다
      sock.close(4001, 'stale')
    } catch {
      /* ignore */
    }
    clearTimers()
    bus.emit('net', { rtt: store.rtt, connected: false })
    scheduleRetry()
  }

  function scheduleRetry(): void {
    if (intentional) return
    if (everPlayed) noteInterrupted()
    if (attempts >= BACKOFF_MS.length) {
      setPhase('error', 'net')
      return
    }
    // 첫 접속부터 몇 번 연달아 실패했다면 '붐빈다'가 아니라 '서버에 닿지 못한다'고 말해 줘야 한다.
    // (다시 시도는 계속한다 — 잠들어 있던 서버가 깨어나면 저절로 들어간다)
    setPhase(everPlayed ? 'reconnecting' : 'connecting', !everPlayed && attempts >= UNREACHABLE_AFTER ? 'unreachable' : '')
    const base = BACKOFF_MS[attempts] ?? 8000
    attempts++
    const delay = base * (0.7 + Math.random() * 0.6)
    clearTimeout(retryTimer)
    retryTimer = setTimeout(open, delay)
  }

  function sendRaw(msg: ClientMsg): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  function addPlayer(pub: PlayerPublic, time: number): void {
    const v = makeView(pub.x, pub.z, pub.yaw, pub.st, pub.emote, pub.id, time) as PlayerView
    v.pub = pub
    store.players.set(pub.id, v)
  }

  function addNpc(pub: NpcPublic, time: number): void {
    const v = makeView(pub.x, pub.z, pub.yaw, pub.st, null, 7000 + pub.id * 31 + hashString(pub.name), time) as NpcView
    v.pub = pub
    store.npcs.set(pub.id, v)
  }

  function onWelcome(w: SWelcome): void {
    clearRoomState()
    store.clockOffset = w.now - Date.now()
    lastSnapTime = w.now
    store.room = { ...w.room }
    const p = store.profile
    p.name = w.name
    confirmedName = w.name
    p.look = w.look
    p.save = w.save
    p.lastRoom = w.room.id
    saveProfile(p)
    const prev = store.me
    const base = makeView(w.x, w.z, 0, 0, null, w.id, w.now)
    store.me = {
      ...base,
      id: w.id,
      prog: w.me,
      sprintUntil: 0,
      sprintReadyAt: prev?.sprintReadyAt ?? 0,
      stunUntil: 0,
      entourage: 0,
    }
    for (const pub of w.players) if (pub.id !== w.id) addPlayer(pub, w.now)
    for (const pub of w.npcs) addNpc(pub, w.now)
    store.sermon = w.sermon
    store.battles = w.battles.slice()
    countEntourage()
    attempts = 0
    everPlayed = true
    resumeDenied = false
    clearTimeout(connectTimer)
    clearInterval(pingTimer)
    lastRecvAt = performance.now()
    pingTimer = setInterval(() => {
      sendRaw({ t: 'ping', c: Date.now() })
      checkStale()
    }, PING_INTERVAL_MS)
    sendRaw({ t: 'ping', c: Date.now() })
    // 끊겼다 돌아온 것이라면: 서버가 같은 번호로 이어 붙여 줬는지, 그사이 사라진 것이 있는지 정리해 둔다
    const was = before
    before = null
    const same = !!was && was.id === w.id && was.room === w.room.id
    if (same && prev) {
      // 같은 자리로 이어졌다: 바라보던 방향을 그대로 둔다(화면이 휙 돌지 않게)
      store.me.yaw = prev.yaw
    }
    setPhase('playing')
    bus.emit('profile')
    bus.emit('progress', w.me)
    if (was) {
      const lost: ('battle' | 'sermon' | 'talk')[] = []
      if (was.battle && !store.battles.some((b) => b.a === w.id || b.b === w.id)) lost.push('battle')
      if (was.sermon && store.sermon === null) lost.push('sermon')
      if (was.talk) lost.push('talk')
      bus.emit('resumed', { same, lost, idle: was.idle })
    }
    // 콕 집어 가려던 방(친구 링크의 ?room= 등)이 아닌 곳에 들어왔다면 알려 준다.
    // 그 뒤로는 지금 있는 방을 기준으로 삼는다(재접속 때 조용히 방이 바뀌지 않게).
    const asked = wantRoom
    wantRoom = w.room.id
    if (asked !== 'auto' && asked !== w.room.id) bus.emit('redirected', { from: asked, to: w.room.id })
    bus.emit('entered')
    bus.emit('net', { rtt: store.rtt, connected: true })
    emitPopulation()
  }

  function onMessage(msg: ServerMsg): void {
    const me = store.me
    switch (msg.t) {
      case 'welcome':
        onWelcome(msg)
        break
      case 'full':
        if (openedAsResume) {
          // 있던 방으로 돌아가려 했는데 그사이 내 자리가 다른 사람에게 넘어갔다(오래 끊겨 있었다).
          // '가득 참' 화면에 세우지 않고, 평소 규칙대로 자리 있는 방을 바로 다시 찾는다(바뀌면 안내가 뜬다).
          resumeDenied = true
          open()
          break
        }
        store.rooms = msg.rooms
        intentional = true
        clearTimers()
        setPhase('full')
        bus.emit('rooms', msg.rooms)
        break
      case 'kick':
        if (msg.why === 'shutdown') {
          // 서버 점검/재시작: 내보내진 게 아니라 잠깐 끊기는 것이므로 자동으로 다시 붙는다
          noteInterrupted()
          setPhase('reconnecting', 'shutdown')
          break
        }
        intentional = true
        clearTimers()
        // 오래 자리를 비워 끊긴 경우(백그라운드 탭은 타이머가 느려져 응답을 못 보낸다): 돌아오면 자동으로 다시 들어간다
        idleKicked = msg.why === 'idle'
        if (idleKicked) noteInterrupted(true)
        setPhase('kicked', msg.why)
        if (idleKicked && document.visibilityState === 'visible') rejoinAfterIdle()
        break
      case 'join':
        if (me && msg.p.id === me.id) break
        addPlayer(msg.p, store.serverNow())
        bus.emit('playerJoin', msg.p.id)
        emitPopulation()
        break
      case 'leave':
        if (store.players.delete(msg.id)) {
          bus.emit('playerLeave', msg.id)
          emitPopulation()
        }
        break
      case 'err': {
        // 이름 변경이 거부됐다(쿨타임·신고로 인한 고정 등): 미리 바꿔 둔 화면의 이름을 서버 기준으로 되돌린다
        if (msg.code === 'name' && confirmedName && store.profile.name !== confirmedName) {
          store.profile.name = confirmedName
          saveProfile(store.profile)
          bus.emit('profile')
        }
        break
      }
      case 'pu': {
        if (me && msg.id === me.id) {
          if (msg.name !== undefined) {
            store.profile.name = msg.name
            confirmedName = msg.name
          }
          if (msg.look !== undefined) store.profile.look = msg.look
          if (msg.cult !== undefined) me.prog.cult = msg.cult
          if (msg.rank !== undefined) me.prog.rank = msg.rank
          if (msg.fol !== undefined) me.prog.fol = msg.fol
          if (msg.tag !== undefined) {
            if (msg.tag) me.prog.tag = msg.tag
            else delete me.prog.tag
          }
          saveProfile(store.profile)
          bus.emit('profile')
        } else {
          const v = store.players.get(msg.id)
          if (!v) break
          if (msg.name !== undefined) v.pub.name = msg.name
          if (msg.look !== undefined) v.pub.look = msg.look
          if (msg.rank !== undefined) v.pub.rank = msg.rank
          if (msg.fol !== undefined) v.pub.fol = msg.fol
          if (msg.cult !== undefined) v.pub.cult = msg.cult
          if (msg.tag !== undefined) v.pub.tag = msg.tag
        }
        bus.emit('playerUpdate', msg.id)
        break
      }
      case 'emote': {
        if (me && msg.id === me.id) break // 내 것은 이미 재생 중
        const v = store.players.get(msg.id)
        if (v) {
          v.emote = msg.e || null
          v.emoteAt = performance.now()
          v.pub.emote = msg.e || null
        }
        break
      }
      case 'npcSpawn':
        addNpc(msg.n, store.serverNow())
        countEntourage()
        bus.emit('npcSpawn', msg.n.id)
        emitPopulation()
        break
      case 'npcGone':
        // 출구로 나가 방에서 빠진 시민: 지우면 다음 프레임부터 그려지지 않고, 이름표·말풍선도 풀린다
        if (store.npcs.delete(msg.n)) {
          if (store.near.npc === msg.n) store.near.npc = 0
          countEntourage()
          bus.emit('npcUpdate', msg.n)
          emitPopulation()
        }
        break
      case 'nu': {
        const v = store.npcs.get(msg.n)
        if (!v) break
        if (msg.owner !== undefined) v.pub.owner = msg.owner
        if (msg.role !== undefined) v.pub.role = msg.role
        countEntourage()
        bus.emit('npcUpdate', msg.n)
        break
      }
      case 'talkOk':
        store.talk = { npc: msg.n, greet: msg.greet, lines: msg.lines, round: msg.round, waiting: false }
        bus.emit('talk', store.talk)
        break
      case 'talkNo':
        if (msg.why === 'cool' && msg.ms) store.pitchReadyAt = performance.now() + msg.ms
        if (store.talk) {
          store.talk = null
          bus.emit('talk', null)
        }
        break
      case 'talkEnd':
        if (store.talk && store.talk.npc === msg.n) {
          store.talk = null
          bus.emit('talk', null)
        }
        break
      case 'pitchRes':
        if (me && msg.p === me.id) {
          store.pitchReadyAt = performance.now() + PITCH_COOLDOWN_MS
          if (msg.o !== 'more' && msg.o !== 'rival' && store.talk) {
            store.talk = null
            // 결과 메시지를 먼저 알리고(연출 시작) 그 다음 대화 종료를 알린다
            bus.emitMsg(msg)
            bus.emit('talk', null)
            return
          }
        }
        break
      case 'reward':
        if (me) {
          // 저장본(save)은 최대 1초 늦게 오므로 화면 숫자는 먼저 올려 둔다
          if (msg.inf) me.prog.inf += msg.inf
          if (msg.fol) me.prog.fol += msg.fol
          if (msg.coins) me.prog.coins += msg.coins
          if (msg.rankUp !== undefined) me.prog.rank = msg.rankUp
          bus.emit('progress', me.prog)
          if (msg.rankUp !== undefined) bus.emit('rankUp', msg.rankUp)
        }
        break
      case 'save':
        if (me) {
          me.prog = msg.me
          store.profile.save = msg.save
          saveProfile(store.profile)
          bus.emit('progress', me.prog)
        }
        break
      case 'pos':
        if (me) {
          me.x = msg.x
          me.z = msg.z
        }
        break
      case 'pong': {
        const now = Date.now()
        const rtt = Math.max(0, now - msg.c)
        store.rtt = store.rtt ? store.rtt * 0.7 + rtt * 0.3 : rtt
        const offset = msg.s + rtt / 2 - now
        const diff = offset - store.clockOffset
        store.clockOffset = Math.abs(diff) > 400 ? offset : store.clockOffset + diff * 0.2
        bus.emit('net', { rtt: store.rtt, connected: true })
        break
      }
      case 'rooms':
        store.rooms = msg.rooms
        bus.emit('rooms', msg.rooms)
        break
      case 'sermon':
        if (msg.ph === 'start' || msg.ph === 'join' || msg.ph === 'call') {
          if (msg.s) store.sermon = msg.s
        } else if (msg.ph === 'end') {
          store.sermon = null
        }
        break
      case 'battle':
        if (msg.b) {
          const b = msg.b
          const i = store.battles.findIndex((x) => x.a === b.a && x.b === b.b)
          if (msg.ph === 'end') {
            if (i >= 0) store.battles.splice(i, 1)
          } else if (msg.ph === 'start' || msg.ph === 'score') {
            if (i >= 0) store.battles[i] = b
            else store.battles.push(b)
          }
        }
        break
      case 'patrol':
        if (me && msg.ph === 'caught' && msg.p === me.id) me.stunUntil = performance.now() + (msg.ms ?? 3000)
        break
      default:
        break
    }
    bus.emitMsg(msg)
  }

  function onBinary(data: ArrayBuffer): void {
    const snap = decodeSnapshot(data)
    if (!snap) return
    const me = store.me
    if (!me) return
    lastSnapTime = snap.time
    // 서버 시각이 내 추정보다 앞서 있으면(지연 변동) 시계를 살짝 당긴다
    const ahead = snap.time - store.serverNow()
    if (ahead > 0) store.clockOffset += ahead
    const seenP = new Set<number>()
    for (const e of snap.players) {
      if (e.id === me.id) continue
      const v = store.players.get(e.id)
      if (!v) continue
      seenP.add(e.id)
      pushSample(v, snap.time, e)
    }
    for (const [id, v] of store.players) if (!seenP.has(id)) holdSample(v, snap.time)
    const seenN = new Set<number>()
    for (const e of snap.npcs) {
      const v = store.npcs.get(e.id)
      if (!v) continue
      seenN.add(e.id)
      pushSample(v, snap.time, e)
    }
    for (const [id, v] of store.npcs) if (!seenN.has(id)) holdSample(v, snap.time)
  }

  function rejoinAfterIdle(): void {
    if (!idleKicked) return
    idleKicked = false
    intentional = false
    attempts = 0
    setPhase('reconnecting', 'idle')
    open()
  }

  // 탭이 다시 보이면: 끊겨 있었다면 바로 재접속, 아니면 시계부터 다시 맞춘다
  document.addEventListener('visibilitychange', () => {
    // 가려져 있던 동안에는 받은 것이 없어도 정상이다 → 돌아온 직후에 '죽은 연결'로 오해하지 않게 시계를 다시 맞춘다
    if (document.visibilityState === 'visible') lastRecvAt = performance.now()
    if (document.visibilityState === 'visible' && idleKicked) {
      rejoinAfterIdle()
      return
    }
    if (document.visibilityState !== 'visible' || intentional) return
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      attempts = 0
      clearTimeout(retryTimer)
      setPhase(everPlayed ? 'reconnecting' : 'connecting')
      open()
    } else {
      sendRaw({ t: 'ping', c: Date.now() })
    }
  })
  window.addEventListener('online', () => {
    if (intentional || (ws && ws.readyState === WebSocket.OPEN)) return
    attempts = 0
    clearTimeout(retryTimer)
    open()
  })

  const api: Net = {
    debugDrop() {
      try {
        ws?.close(4999, 'debug drop')
      } catch {
        /* ignore */
      }
    },
    connect(roomId) {
      wantRoom = roomId || 'auto'
      idleKicked = false
      before = null
      intentional = false
      attempts = 0
      everPlayed = false
      clearRoomState()
      store.me = null
      setPhase('connecting')
      open()
    },
    disconnect() {
      intentional = true
      clearTimers()
      closeSocket()
      clearRoomState()
      store.me = null
      bus.emit('net', { rtt: store.rtt, connected: false })
    },
    send(msg) {
      if (store.phase !== 'playing') return false
      return sendRaw(msg)
    },
    sendMove(x, z, yaw, st) {
      if (!ws || ws.readyState !== WebSocket.OPEN || store.phase !== 'playing') return
      try {
        ws.send(encodeMove(x, z, yaw, st))
      } catch {
        /* ignore */
      }
    },
    update() {
      if (!store.me) return
      // 스냅샷이 끊긴 동안(재접속 중 등)에는 마지막 스냅샷 시각을 넘어가지 않는다
      const rt = Math.min(store.serverNow() - INTERP_DELAY_MS, lastSnapTime)
      for (const v of store.players.values()) {
        applyInterp(v, rt)
        v.y = groundHeight(v.x, v.z)
      }
      for (const v of store.npcs.values()) {
        applyInterp(v, rt)
        v.y = groundHeight(v.x, v.z)
      }
    },
    async refreshRooms() {
      try {
        const res = await fetch(apiUrl('/api/rooms'), { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as { rooms?: RoomInfo[] }
        if (Array.isArray(data.rooms)) {
          store.rooms = data.rooms
          bus.emit('rooms', data.rooms)
        }
      } catch {
        /* 목록 실패는 조용히 무시(다음 갱신 때 다시 시도) */
      }
    },
  }
  return api
}
