/**
 * UI 하네스: 진짜 게임 루프·서버·3D 없이 UI 모듈(title/hud/talk/emotes/system/profile/overlay)만 띄워 본다.
 *
 *   /dev/ui.html?scenario=<이름>[&touch=1|0][&bar=0]
 *
 * - store / bus / createUi / mountUi / createOverlay 는 진짜를 쓴다.
 * - engine.project() 는 고정 3/4 시점의 간단한 변환이고, 캐릭터는 2D 캔버스에 동그란 덩어리로 그린다.
 * - net/actions 는 가짜: 호출을 콘솔에 남기고 "서버가 했을 법한" 결과를 store 에 반영한 뒤 bus 로 알린다.
 * - window.__ui 로 콘솔/스크린샷 스크립트에서 장면을 조종할 수 있다.
 * - WASD/방향키로 걸어 다닐 수 있다(가까운 NPC 판정 포함) — 손으로 만져 보는 용도.
 */
import '../src/styles/base.css'
import { Anim, NPCS_PER_ROOM, PITCH_COOLDOWN_MS, SPRINT_COOLDOWN_MS, SPRINT_MS, TALK_RANGE, npcKey } from '../../shared/constants'
import { ARCHETYPES } from '../../shared/content/archetypes'
import { OUTFIT_COLORS, SKIN_COLORS, rankForInfluence } from '../../shared/content/core'
import type { ServerMsg } from '../../shared/protocol'
import { newProgress } from '../../shared/rules/progress'
import type { CultRef, Look, NpcPublic, PitchOutcome, PlayerPublic, RoomInfo } from '../../shared/types'
import { Bus } from '../src/core/bus'
import type { Actions, AppContext, CharacterRendererApi, ContextAction, EngineApi, FxApi, InputApi, NetApi, SfxApi } from '../src/core/contracts'
import { createStore, type NpcView, type Phase, type PlayerView } from '../src/core/store'
import { mountUi } from '../src/ui/index'
import { createUi, hex } from '../src/ui/kit'
import { createOverlay } from '../src/ui/overlay'

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'playing'
const log = (...a: unknown[]): void => console.info('[harness]', ...a)

const canvas = document.getElementById('game') as HTMLCanvasElement
const root = document.getElementById('ui') as HTMLElement
const g = canvas.getContext('2d')!

const store = createStore()
const bus = new Bus()
const ui = createUi(root, bus)

// ───────────────────────── 가짜 엔진 ─────────────────────────
const view = { w: 1, h: 1, dpr: 1 }
function resize(): void {
  view.w = window.innerWidth
  view.h = window.innerHeight
  view.dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(view.w * view.dpr)
  canvas.height = Math.round(view.h * view.dpr)
  bus.emit('resize')
}
window.addEventListener('resize', resize)

/** 1m 가 몇 px 인지 */
const scale = (): number => Math.max(26, view.h / 13)
const camX = (): number => store.me?.x ?? 0
const camZ = (): number => store.me?.z ?? 0

function project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
  const s = scale()
  out.x = view.w / 2 + (x - camX()) * s
  out.y = view.h * 0.6 + (z - camZ()) * s * 0.55 - y * s * 0.92
  return out.x > -90 && out.x < view.w + 90 && out.y > -90 && out.y < view.h + 90
}

const engine: EngineApi = {
  renderer: null as never,
  scene: null as never,
  camera: null as never,
  canvas,
  quality: 'mid',
  setQuality() {},
  onQuality() {},
  project,
  pickGround() {
    return null
  },
  resize,
  render() {},
}

// ───────────────────────── 가짜 렌더/소리/입력 ─────────────────────────
const chars: CharacterRendererApi = {
  update() {},
  portrait(look: Look, size: number) {
    const c = document.createElement('canvas')
    const d = Math.min(window.devicePixelRatio || 1, 2)
    c.width = c.height = Math.round(size * d)
    const p = c.getContext('2d')!
    p.scale(d, d)
    const skin = hex(SKIN_COLORS[look[0]] ?? 0xffdfc4)
    const cloth = hex(OUTFIT_COLORS[look[2]] ?? 0xf2f2ef)
    p.lineWidth = 3
    p.strokeStyle = '#241b35'
    // 몸
    p.fillStyle = cloth
    p.beginPath()
    p.ellipse(size / 2, size * 0.86, size * 0.26, size * 0.24, 0, 0, Math.PI * 2)
    p.fill()
    p.stroke()
    // 머리
    p.fillStyle = skin
    p.beginPath()
    p.arc(size / 2, size * 0.46, size * 0.27, 0, Math.PI * 2)
    p.fill()
    p.stroke()
    // 눈
    p.fillStyle = '#241b35'
    p.beginPath()
    p.arc(size * 0.41, size * 0.46, 4, 0, Math.PI * 2)
    p.arc(size * 0.59, size * 0.46, 4, 0, Math.PI * 2)
    p.fill()
    p.font = `700 ${Math.round(size * 0.065)}px system-ui, sans-serif`
    p.textAlign = 'center'
    p.fillText(`복장 ${look[1]} · 모자 ${look[3]} · 얼굴 ${look[4]}`, size / 2, size * 0.09)
    p.fillText(`소품 ${look[5]} · 오라 ${look[6]}`, size / 2, size * 0.17)
    return c
  },
  dispose() {},
}
const fx: FxApi = {
  burst(kind, x, y, z) {
    log('fx.burst', kind, x.toFixed(1), y.toFixed(1), z.toFixed(1))
  },
  update() {},
  dispose() {},
}
const sfxLog: string[] = []
const sfx: SfxApi = {
  unlock() {},
  play(name) {
    sfxLog.push(name)
    if (sfxLog.length > 50) sfxLog.shift()
  },
  setEnabled() {},
  setMusic() {},
}
const keys = new Set<string>()
const input: InputApi = {
  get moveX() {
    return (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
  },
  get moveY() {
    return (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
  },
  get run() {
    return keys.has('ShiftLeft')
  },
  consumeCamera: () => ({ yaw: 0, pitch: 0, zoom: 0 }),
  consumeTap: () => null,
  update() {},
}
window.addEventListener('keydown', (e) => keys.add(e.code))
window.addEventListener('keyup', (e) => keys.delete(e.code))
window.addEventListener('blur', () => keys.clear())

// ───────────────────────── 가짜 세계 ─────────────────────────
const ROOMS: RoomInfo[] = [
  { id: '1', name: '수상역 1번 출구', players: 6, cap: 20, npcs: 12 },
  { id: '2', name: '수상역 2번 출구', players: 20, cap: 20, npcs: 28 },
  { id: '3', name: '수상역 3번 출구', players: 2, cap: 20, npcs: 28 },
]
const CULT_RAMEN: CultRef = { id: 'c1', name: '라면교', color: 0, emblem: 0, role: 'leader', title: '면장', leaderName: '배고픈교주' }
const CULT_MONDAY: CultRef = { id: 'c2', name: '월요병 구원회', color: 6, emblem: 3, role: 'leader', title: '수석 졸음이', leaderName: '은밀한도사' }

const PLAYERS: PlayerPublic[] = [
  { id: 2, name: '배고픈교주', look: [1, 3, 2, 3, 1, 2, 0], rank: 3, fol: 212, cult: CULT_RAMEN, x: -3.6, z: -2.4, yaw: 0, st: 0, emote: null },
  { id: 3, name: '졸린비둘기', look: [2, 1, 5, 1, 2, 0, 0], rank: 1, fol: 9, cult: { ...CULT_RAMEN, role: 'member', title: '신도' }, x: -5.6, z: -0.6, yaw: 0, st: 0, emote: null },
  { id: 4, name: '해맑은김밥', look: [0, 0, 7, 0, 3, 0, 0], rank: 0, fol: 1, cult: null, x: 4.6, z: -3.1, yaw: 0, st: 0, emote: null },
  { id: 5, name: '은밀한도사', look: [3, 9, 8, 10, 4, 5, 4], rank: 5, fol: 1840, cult: CULT_MONDAY, x: 7.4, z: 1.6, yaw: 0, st: 0, emote: null },
  { id: 6, name: '끈질긴행인', look: [4, 2, 1, 2, 0, 1, 0], rank: 2, fol: 37, cult: null, x: -9.5, z: 3.4, yaw: 0, st: 0, emote: null },
]

const NPC_SPOTS: [number, number, number][] = [
  // x, z, 주인(0 = 없음)
  [-1.3, 1.5, 1],
  [-2.4, 2.4, 1],
  [-3.5, 3.2, 1],
  [2.1, -0.9, 0],
  [3.4, 2.6, 0],
  [-2.2, -4.4, 2],
  [0.6, -5.6, 0],
  [6.2, -5.2, 0],
  [-7.4, -3.6, 0],
  [10.5, 4.8, 0],
  [-12.5, -1.5, 0],
  [1.8, 6.4, 0],
]

function makeNpc(id: number, x: number, z: number, owner: number): NpcPublic {
  const arch = ARCHETYPES[id % ARCHETYPES.length]!
  return {
    id,
    arch: arch.id,
    name: arch.names[id % arch.names.length] ?? '시민',
    look: [id % SKIN_COLORS.length, arch.look.outfits[0] ?? 0, arch.look.colors[id % arch.look.colors.length] ?? 0, 0, 0, 0, 0],
    model: 0,
    x,
    z,
    yaw: 0,
    st: Anim.Idle,
    owner,
    role: '',
  }
}

function playerView(pub: PlayerPublic): PlayerView {
  return { pub, x: pub.x, y: 0, z: pub.z, yaw: pub.yaw, st: pub.st, emote: null, emoteAt: 0, phase: (pub.id * 0.37) % 1, bornAt: performance.now(), samples: [] }
}
function npcView(pub: NpcPublic): NpcView {
  return { pub, x: pub.x, y: 0, z: pub.z, yaw: pub.yaw, st: pub.st, emote: null, emoteAt: 0, phase: (pub.id * 0.37) % 1, bornAt: performance.now(), samples: [] }
}

function recount(): void {
  const me = store.me
  if (!me) return
  let n = 0
  store.npcs.forEach((v) => {
    if (v.pub.owner === me.id) n++
  })
  me.entourage = n
  if (store.room) {
    store.room.players = store.players.size + 1
    store.room.npcs = store.npcs.size
  }
  bus.emit('population', { players: store.players.size + 1, npcs: store.npcs.size })
}

function setPhase(phase: Phase, why = ''): void {
  store.phase = phase
  store.phaseWhy = why
  bus.emit('phase', phase)
}

function welcome(roomId = '1', npcCount = NPC_SPOTS.length): void {
  const room = ROOMS.find((r) => r.id === roomId) ?? ROOMS[0]!
  store.room = { ...room }
  store.rooms = ROOMS.map((r) => ({ ...r }))
  store.profile.lastRoom = room.id
  const prog = newProgress(store.profile.pid, Date.now())
  prog.inf = 120
  prog.fol = 14
  prog.coins = 35
  prog.rank = rankForInfluence(prog.inf)
  store.me = {
    id: 1,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    st: Anim.Idle,
    emote: null,
    emoteAt: 0,
    phase: 0.2,
    bornAt: performance.now(),
    samples: [],
    prog,
    sprintUntil: 0,
    sprintReadyAt: 0,
    stunUntil: 0,
    entourage: 0,
  }
  store.players.clear()
  for (const p of PLAYERS) store.players.set(p.id, playerView({ ...p }))
  store.npcs.clear()
  for (let i = 0; i < npcCount; i++) {
    const spot = NPC_SPOTS[i]
    // 정해 둔 자리가 모자라면 주변에 흩뿌린다(말풍선 30개 같은 부하 장면용)
    const x = spot ? spot[0] : Math.cos(i * 2.4) * (4 + (i % 7) * 1.7)
    const z = spot ? spot[1] : Math.sin(i * 2.4) * (3 + (i % 5) * 1.6)
    store.npcs.set(i + 1, npcView(makeNpc(i + 1, x, z, spot ? spot[2] : 0)))
  }
  store.talk = null
  store.near = { npc: 0, player: 0, poi: null }
  store.rtt = 48
  store.phase = 'playing'
  store.phaseWhy = ''
  bus.emit('entered')
  bus.emit('phase', 'playing')
  bus.emit('progress', prog)
  recount()
}

// ───────────────────────── 가짜 네트워크 ─────────────────────────
type EnterMode = 'ok' | 'hang' | 'full' | 'error'
let enterMode: EnterMode = 'ok'
let roomsFail = false
let npcCountOnEnter = NPC_SPOTS.length
let forcedOutcome: PitchOutcome | null = null
/** true 면 멘트를 골라도 서버 응답이 오지 않는다(대기 화면 확인용) */
let holdPitch = false
/** 가짜 상황 버튼(다른 모듈 흉내) 개수와 쿨타임 */
let extraActions = 0
let cooldownBase = 0
/** 시나리오가 near 를 직접 정했으면 자동 판정이 덮어쓰지 않게 잠근다 */
let nearLock: number | null = null
const sent: unknown[] = []

const net: NetApi = {
  connect(roomId) {
    log('net.connect', roomId)
  },
  disconnect() {
    log('net.disconnect')
  },
  send(msg) {
    sent.push(msg)
    log('net.send', JSON.stringify(msg))
    return true
  },
  sendMove() {},
  update() {},
  refreshRooms() {
    return new Promise<void>((resolve, reject) => {
      window.setTimeout(() => {
        if (roomsFail) return reject(new Error('offline'))
        store.rooms = ROOMS.map((r) => ({ ...r }))
        bus.emit('rooms', store.rooms)
        resolve()
      }, 120)
    })
  },
}

/** 서버 메시지 주입: 진짜 net 이 하듯 store 를 먼저 고치고 emitMsg 한다 */
function inject(msg: ServerMsg): void {
  const me = store.me
  switch (msg.t) {
    case 'join':
      store.players.set(msg.p.id, playerView({ ...msg.p }))
      bus.emitMsg(msg)
      bus.emit('playerJoin', msg.p.id)
      recount()
      return
    case 'leave':
      store.players.delete(msg.id)
      bus.emitMsg(msg)
      bus.emit('playerLeave', msg.id)
      recount()
      return
    case 'pu': {
      const p = store.players.get(msg.id)
      if (p) {
        if (msg.name !== undefined) p.pub.name = msg.name
        if (msg.rank !== undefined) p.pub.rank = msg.rank
        if (msg.cult !== undefined) p.pub.cult = msg.cult
      }
      bus.emitMsg(msg)
      bus.emit('playerUpdate', msg.id)
      return
    }
    case 'nu': {
      const n = store.npcs.get(msg.n)
      if (n && msg.owner !== undefined) n.pub.owner = msg.owner
      bus.emitMsg(msg)
      bus.emit('npcUpdate', msg.n)
      recount()
      return
    }
    case 'reward':
      if (me) {
        me.prog.inf += msg.inf ?? 0
        me.prog.fol += msg.fol ?? 0
        me.prog.coins += msg.coins ?? 0
        if (msg.rankUp !== undefined) me.prog.rank = msg.rankUp
        bus.emit('progress', me.prog)
      }
      bus.emitMsg(msg)
      if (msg.rankUp !== undefined) bus.emit('rankUp', msg.rankUp)
      return
    case 'talkOk':
      store.talk = { npc: msg.n, greet: msg.greet, lines: msg.lines, round: msg.round, waiting: false }
      bus.emitMsg(msg)
      bus.emit('talk', store.talk)
      return
    case 'talkEnd':
      store.talk = null
      bus.emitMsg(msg)
      bus.emit('talk', null)
      return
    case 'kick':
      store.me = null
      bus.emitMsg(msg)
      setPhase('kicked', msg.why)
      return
    case 'full':
      store.rooms = msg.rooms
      bus.emitMsg(msg)
      setPhase('full')
      return
    default:
      bus.emitMsg(msg)
  }
}

const SAY: Record<PitchOutcome, string> = {
  join: '퇴근만 시켜 준다면 뭐든 믿겠습니다.',
  king: '혹시 전생에 제가 왕이었나요?',
  more: '흥미로운데요? 더 들어볼게요.',
  no: '저 지금 너무 바빠요!',
  flee: '으아아 막차!!',
  ignore: '(이어폰 볼륨을 올린다)',
  rival: '저도 사실 교주입니다.',
}

/** 서버가 포교를 판정한 것처럼 꾸민다 */
function resolvePitch(lineId: number, outcome: PitchOutcome): void {
  const me = store.me
  const talk = store.talk
  if (!me || !talk) return
  const npcId = talk.npc
  inject({ t: 'pitchRes', p: me.id, n: npcId, l: lineId, o: outcome, say: SAY[outcome] })
  store.pitchReadyAt = performance.now() + PITCH_COOLDOWN_MS
  if (outcome === 'more') {
    inject({ t: 'reward', why: 'more', inf: 2 })
    inject({ t: 'talkOk', n: npcId, greet: SAY.more, lines: [4, 5, 6, 7], round: 2 })
    return
  }
  if (outcome === 'rival') {
    // 기싸움 시스템 흉내: 대화 세션은 남겨 둔 채 duel 을 시작하고, 잠시 뒤 끝낸다
    inject({ t: 'duel', ph: 'start', n: npcId, say: '저는 숨만 쉬어도 기운이 모입니다. 그쪽은요?', choices: ['저도 숨은 쉽니다만…', '저는 숨을 안 쉬어도 모입니다.', '죄송합니다, 지나갈게요.'], until: Date.now() + 8000 })
    window.setTimeout(() => {
      inject({ t: 'duel', ph: 'end', n: npcId, win: true, text: '수… 숨을 안 쉬고도?! 제가 졌습니다, 형님!' })
      inject({ t: 'talkEnd', n: npcId, why: 'done' })
    }, 2500)
    return
  }
  if (outcome === 'join' || outcome === 'king') {
    inject({ t: 'nu', n: npcId, owner: me.id })
    inject({ t: 'reward', why: 'join', inf: 12, fol: 1, coins: outcome === 'king' ? 5 : 0, streak: 2 })
  } else {
    inject({ t: 'reward', why: 'fail', inf: 1 })
  }
  inject({ t: 'talkEnd', n: npcId, why: 'done' })
}

const actions: Actions = {
  enter(roomId) {
    log('actions.enter', roomId)
    setPhase('connecting')
    if (enterMode === 'hang') return
    window.setTimeout(() => {
      if (enterMode === 'full') inject({ t: 'full', rooms: ROOMS.map((r) => (scenario === 'full-all' ? { ...r, players: r.cap } : { ...r })) })
      else if (enterMode === 'error') setPhase('error', 'net')
      else welcome(roomId === 'auto' ? '1' : roomId, npcCountOnEnter)
    }, 250)
  },
  switchRoom(roomId) {
    log('actions.switchRoom', roomId)
    ui.toast(`(하네스) ${roomId}번 방으로 이동`, 'info')
    actions.enter(roomId)
  },
  exitToTitle() {
    store.me = null
    setPhase('title')
  },
  setName(name) {
    log('actions.setName', name)
    store.profile.name = name
    bus.emit('profile')
  },
  setLook(look) {
    log('actions.setLook', look.join(','))
    store.profile.look = look
    bus.emit('profile')
  },
  emote(id) {
    log('actions.emote', id)
    if (!store.me) return
    store.me.emote = id || null
    store.me.emoteAt = performance.now()
  },
  say(q) {
    log('actions.say', q)
    if (store.me) inject({ t: 'say', id: store.me.id, q })
  },
  talk(npcId) {
    log('actions.talk', npcId)
    if (performance.now() < store.pitchReadyAt) {
      inject({ t: 'talkNo', n: npcId, why: 'cool', ms: store.pitchReadyAt - performance.now() })
      return
    }
    const arch = ARCHETYPES.find((a) => a.id === store.npcs.get(npcId)?.pub.arch)
    inject({ t: 'talkOk', n: npcId, greet: arch?.greet[0] ?? '네? 저요?', lines: [0, 1, 3, 4], round: 1 })
  },
  pitch(lineId) {
    log('actions.pitch', lineId)
    if (!store.talk) return
    store.talk.waiting = true
    bus.emit('talk', store.talk)
    const pool: PitchOutcome[] = ['join', 'more', 'no', 'flee', 'ignore', 'king', 'rival']
    const outcome = forcedOutcome ?? pool[Math.floor(Math.random() * pool.length)]!
    if (holdPitch) return
    window.setTimeout(() => resolvePitch(lineId, outcome), 550)
  },
  endTalk() {
    log('actions.endTalk')
    if (store.talk) inject({ t: 'talkEnd', n: store.talk.npc, why: 'cancel' })
  },
  sprint() {
    const me = store.me
    if (!me || performance.now() < me.sprintReadyAt) return false
    me.sprintUntil = performance.now() + SPRINT_MS
    me.sprintReadyAt = performance.now() + SPRINT_COOLDOWN_MS
    log('actions.sprint')
    return true
  },
  moveTo(x, z) {
    log('actions.moveTo', x, z)
  },
}

// ───────────────────────── 조립 ─────────────────────────
const overlay = createOverlay(root, store, bus, engine)
const ctx: AppContext = { store, bus, net, engine, chars, fx, overlay, sfx, input, actions, ui }

// 다른 담당의 모듈이 넣을 메뉴 항목 흉내(메뉴 모양/배지 확인용)
ui.addMenuItem({ id: 'cult', icon: '🚩', label: '내 교단', order: 20, onClick: () => ui.toast('(하네스) 교단 패널', 'info') })
ui.addMenuItem({ id: 'ach', icon: '🏅', label: '업적 · 일일 수행', order: 30, badge: () => 2, onClick: () => ui.toast('(하네스) 업적 패널', 'info') })
ui.addMenuItem({ id: 'cert', icon: '📜', label: '교주 임명장', order: 40, badge: () => true, onClick: () => ui.toast('(하네스) 임명장', 'info') })
ui.addMenuItem({ id: 'settings', icon: '⚙️', label: '설정', order: 90, onClick: () => ui.toast('(하네스) 설정', 'info') })

/** 다른 모듈의 상황 버튼 흉내(단상/교단 초대 등) */
ui.addContextProvider(() => {
  if (extraActions <= 0) return null
  const list: ContextAction[] = [
    { id: 'prophecy', label: '오늘의 계시', icon: '🔮', readyAt: cooldownBase > performance.now() ? cooldownBase : undefined, onClick: () => ui.toast('(하네스) 오늘의 계시', 'gold') },
    { id: 'sermon', label: '집단 설교 시작', icon: '📣', onClick: () => ui.toast('(하네스) 집단 설교', 'info') },
    { id: 'invite', label: '교단 초대', icon: '🚩', onClick: () => ui.toast('(하네스) 초대', 'info') },
    { id: 'battle', label: '배틀 신청', icon: '⚔️', disabled: true, onClick: () => {} },
    { id: 'wave', label: '인사', icon: '👋', onClick: () => ui.toast('(하네스) 인사', 'info') },
    { id: 'block', label: '차단', icon: '🚫', onClick: () => ui.toast('(하네스) 차단', 'info') },
  ]
  return list.slice(0, extraActions)
})

// 시나리오별 접속 결과는 mountUi 가 자동 입장을 시작하기 전에 정해 둔다
if (scenario === 'boot' || scenario === 'connecting-slow') enterMode = 'hang'
if (scenario === 'full' || scenario === 'full-all') enterMode = 'full'
if (scenario === 'error') enterMode = 'error'
if (scenario === 'bubbles30') npcCountOnEnter = NPCS_PER_ROOM
if (scenario === 'connecting-slow') document.documentElement.style.setProperty('--title-slow-delay', '0.3s')

resize()
mountUi(ctx)

// 터치 배치 강제(스크린샷용). HUD 가 붙인 클래스를 덮어쓴다
const forceTouch = params.get('touch')
if (forceTouch !== null) root.classList.toggle('hud-touch', forceTouch === '1')

// ───────────────────────── 시뮬레이션 + 그리기 ─────────────────────────
function simulate(dt: number, t: number): void {
  const me = store.me
  if (!me || store.phase !== 'playing') return
  // NPC: 제자리에서 어슬렁 / 내 신도는 내 뒤를 따라온다
  let k = 0
  store.npcs.forEach((n, id) => {
    if (n.pub.owner === me.id) {
      k++
      const tx = me.x - 1.1 * k
      const tz = me.z + 0.95 * k + 0.5
      n.x += (tx - n.x) * Math.min(1, dt * 3)
      n.z += (tz - n.z) * Math.min(1, dt * 3)
    } else if (!store.talk || store.talk.npc !== id) {
      n.x = n.pub.x + Math.sin(t * 0.3 + id * 1.7) * 0.6
      n.z = n.pub.z + Math.cos(t * 0.24 + id * 2.3) * 0.5
    }
  })
  if (!store.talk) {
    const sprinting = performance.now() < me.sprintUntil
    const speed = sprinting ? 8.4 : input.run ? 5.6 : 3.4
    me.x += input.moveX * speed * dt
    me.z -= input.moveY * speed * dt
  }
  // 가까운 NPC 판정(내 신도 제외)
  let best = 0
  let bestD = TALK_RANGE * TALK_RANGE
  store.npcs.forEach((n, id) => {
    if (n.pub.owner === me.id) return
    const d = (n.x - me.x) ** 2 + (n.z - me.z) ** 2
    if (d < bestD) {
      bestD = d
      best = id
    }
  })
  if (nearLock === null && best !== store.near.npc) {
    store.near = { ...store.near, npc: best }
    bus.emit('near', store.near)
  }
}

function blob(x: number, y: number, z: number, body: string, skin: string, ring: string | null): void {
  const p = { x: 0, y: 0 }
  if (!project(x, y, z, p)) return
  const s = scale()
  g.fillStyle = 'rgba(36,27,53,0.18)'
  g.beginPath()
  g.ellipse(p.x, p.y, s * 0.42, s * 0.2, 0, 0, Math.PI * 2)
  g.fill()
  if (ring) {
    g.strokeStyle = ring
    g.lineWidth = 3
    g.beginPath()
    g.ellipse(p.x, p.y, s * 0.55, s * 0.27, 0, 0, Math.PI * 2)
    g.stroke()
  }
  g.strokeStyle = '#241b35'
  g.lineWidth = 2
  g.fillStyle = body
  g.beginPath()
  g.ellipse(p.x, p.y - s * 0.42, s * 0.3, s * 0.4, 0, 0, Math.PI * 2)
  g.fill()
  g.stroke()
  g.fillStyle = skin
  g.beginPath()
  g.arc(p.x, p.y - s * 1.08, s * 0.36, 0, Math.PI * 2)
  g.fill()
  g.stroke()
}

function draw(): void {
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
  const sky = g.createLinearGradient(0, 0, 0, view.h)
  sky.addColorStop(0, '#bfe3f2')
  sky.addColorStop(0.34, '#ffd9c2')
  sky.addColorStop(0.35, '#d9cfc0')
  sky.addColorStop(1, '#c3b8a6')
  g.fillStyle = sky
  g.fillRect(0, 0, view.w, view.h)
  // 바닥 격자: 움직임이 보이게
  const p = { x: 0, y: 0 }
  g.strokeStyle = 'rgba(36,27,53,0.08)'
  g.lineWidth = 1
  const cx = Math.round(camX())
  const cz = Math.round(camZ())
  for (let i = -24; i <= 24; i += 2) {
    project(cx + i, 0, cz - 8, p)
    const x0 = p.x
    const y0 = p.y
    project(cx + i, 0, cz + 14, p)
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(p.x, p.y)
    g.stroke()
  }
  for (let j = -8; j <= 14; j += 2) {
    project(cx - 24, 0, cz + j, p)
    const x0 = p.x
    const y0 = p.y
    project(cx + 24, 0, cz + j, p)
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(p.x, p.y)
    g.stroke()
  }
  const me = store.me
  if (!me) return
  // 멀리 있는 것부터(화면 위쪽) 그린다
  const list: { x: number; y: number; z: number; body: string; skin: string; ring: string | null }[] = []
  store.npcs.forEach((n, id) =>
    list.push({ x: n.x, y: n.y, z: n.z, body: hex(OUTFIT_COLORS[n.pub.look[2]] ?? 0x9aa3ad), skin: hex(SKIN_COLORS[n.pub.look[0]] ?? 0xffdfc4), ring: store.near.npc === id ? '#ffd23f' : n.pub.owner ? '#7b5cff' : null }),
  )
  store.players.forEach((q) => list.push({ x: q.x, y: q.y, z: q.z, body: hex(OUTFIT_COLORS[q.pub.look[2]] ?? 0x9aa3ad), skin: hex(SKIN_COLORS[q.pub.look[0]] ?? 0xffdfc4), ring: null }))
  list.push({ x: me.x, y: me.y, z: me.z, body: hex(OUTFIT_COLORS[store.profile.look[2]] ?? 0x6a55d8), skin: hex(SKIN_COLORS[store.profile.look[0]] ?? 0xffdfc4), ring: '#ffffff' })
  list.sort((a, b) => a.z - b.z)
  for (const e of list) blob(e.x, e.y, e.z, e.body, e.skin, e.ring)
}

let last = performance.now()
let frames = 0
let overlayMs = 0
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  simulate(dt, now / 1000)
  draw()
  const t0 = performance.now()
  overlay.update()
  overlayMs += performance.now() - t0
  frames++
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// ───────────────────────── 시나리오 ─────────────────────────
const wait = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms))
function untilPlaying(): Promise<void> {
  return new Promise((resolve) => {
    if (store.phase === 'playing') return resolve()
    const off = bus.on('entered', () => {
      off()
      resolve()
    })
  })
}
function setNear(npcId: number): void {
  nearLock = npcId
  store.near = { ...store.near, npc: npcId }
  bus.emit('near', store.near)
}
const NEAR_NPC = 4
function startTalk(): void {
  setNear(NEAR_NPC)
  actions.talk(NEAR_NPC)
}
function clickEl(sel: string): void {
  const el = root.querySelector<HTMLElement>(sel)
  if (el) el.click()
  else log('clickEl: not found', sel)
}

const SCENARIOS: Record<string, () => void | Promise<void>> = {
  boot() {},
  'connecting-slow'() {},
  async playing() {
    await untilPlaying()
  },
  async 'near-npc'() {
    await untilPlaying()
    setNear(NEAR_NPC)
  },
  async talk1() {
    await untilPlaying()
    startTalk()
  },
  async 'talk-wait'() {
    await untilPlaying()
    holdPitch = true
    startTalk()
    await wait(200)
    clickEl('.talk-line:nth-child(2)')
  },
  async 'res-join'() {
    await untilPlaying()
    forcedOutcome = 'join'
    startTalk()
    await wait(200)
    clickEl('.talk-line:nth-child(1)')
  },
  async 'res-more'() {
    await untilPlaying()
    forcedOutcome = 'more'
    startTalk()
    await wait(200)
    clickEl('.talk-line:nth-child(3)')
  },
  async 'res-flee'() {
    await untilPlaying()
    forcedOutcome = 'flee'
    startTalk()
    await wait(200)
    clickEl('.talk-line:nth-child(3)')
  },
  async 'res-rival'() {
    await untilPlaying()
    forcedOutcome = 'rival'
    startTalk()
    await wait(200)
    clickEl('.talk-line:nth-child(2)')
  },
  async 'res-king'() {
    await untilPlaying()
    forcedOutcome = 'king'
    startTalk()
    await wait(200)
    clickEl('.talk-line:nth-child(4)')
  },
  async rankup() {
    await untilPlaying()
    await wait(200)
    inject({ t: 'reward', why: 'join', inf: 25, fol: 1, rankUp: 2 })
    inject({ t: 'feed', k: 'rank', id: 1, text: `${store.profile.name}님이 열정적인 포교왕으로 승급!` })
  },
  async reconnecting() {
    await untilPlaying()
    await wait(150)
    setPhase('reconnecting')
  },
  async 'kicked-dup'() {
    await untilPlaying()
    await wait(150)
    inject({ t: 'kick', why: 'dup' })
  },
  async 'kicked-ver'() {
    await untilPlaying()
    await wait(150)
    inject({ t: 'kick', why: 'ver' })
  },
  full() {},
  'full-all'() {},
  error() {},
  async feed() {
    await untilPlaying()
    // 입장 직후의 join 은 "이미 있던 사람"으로 보고 알리지 않으므로 잠깐 기다린다
    await wait(900)
    inject({ t: 'feed', k: 'rank', id: 2, text: '배고픈교주님이 대교주로 승급!' })
    inject({ t: 'join', p: { id: 7, name: '배고픈비둘기', look: [0, 0, 4, 0, 0, 0, 0], rank: 0, fol: 0, cult: null, x: 2.5, z: 3.5, yaw: 0, st: 0, emote: null } })
    inject({ t: 'feed', k: 'cult', id: 5, text: "은밀한도사님이 '월요병 구원회'를 창설했습니다" })
    inject({ t: 'leave', id: 6 })
    ui.toast('아직 숨 고르는 중이에요. 2초만 기다려 주세요.', 'info', 60000)
  },
  async bubbles30() {
    await untilPlaying()
    await wait(150)
    const texts = ['도를 아십니까?', '저 지금 너무 바빠요!', '(못 들은 척 걸음이 빨라진다)', '오오…!', '…네?', '집에 가고 싶다…', '믿습니다!', '교주님, 칼퇴도 교리에 있나요?']
    let i = 0
    overlay.bubble(1, '여러분, 오늘 저녁은 라면입니다. 아닐 수도 있습니다.', 60000, 'shout')
    store.players.forEach((_p, id) => overlay.bubble(id, texts[i++ % texts.length]!, 60000, 'say'))
    store.npcs.forEach((_n, id) => {
      const text = texts[i++ % texts.length]!
      overlay.bubble(npcKey(id), text, 60000, text.startsWith('(') ? 'think' : 'npc')
    })
    log('bubbles fired', i + 1)
  },
  async profile() {
    await untilPlaying()
    ui.openPanel('profile')
  },
  async rooms() {
    await untilPlaying()
    ui.openPanel('rooms')
  },
  async menu() {
    await untilPlaying()
    await wait(100)
    clickEl('.hud-menu-btn')
  },
  async emotes() {
    await untilPlaying()
    await wait(100)
    store.me!.emote = 'pray'
    if (root.classList.contains('hud-touch')) clickEl('.emotes-tbtn[aria-label="이모트"]')
    else clickEl('.emotes-bar .emotes-wide')
  },
  async chat() {
    await untilPlaying()
    await wait(100)
    if (root.classList.contains('hud-touch')) clickEl('.emotes-tbtn[aria-label="말풍선"]')
    else clickEl('.emotes-bar .emotes-wide:last-child')
  },
  async 'actions-many'() {
    await untilPlaying()
    cooldownBase = performance.now() + 9000
    extraActions = 6
    setNear(NEAR_NPC)
  },
  async 'actions-more'() {
    await untilPlaying()
    cooldownBase = performance.now() + 9000
    extraActions = 6
    setNear(NEAR_NPC)
    await wait(200)
    clickEl('.hud-action:last-child')
  },
  async 'title-rest'() {
    await untilPlaying()
    await wait(150)
    actions.exitToTitle()
  },
  async 'max-rank'() {
    await untilPlaying()
    const me = store.me!
    me.prog.inf = 12840
    me.prog.fol = 23456
    me.prog.rank = 5
    me.prog.cult = { ...CULT_MONDAY, leaderName: store.profile.name }
    bus.emit('progress', me.prog)
  },
}

const run = SCENARIOS[scenario]
if (run) void Promise.resolve(run()).catch((err) => console.error('[harness] scenario error', err))
else console.error('[harness] unknown scenario', scenario)

// ───────────────────────── 디버그 바 ─────────────────────────
const bar = document.getElementById('devbar') as HTMLDetailsElement
if (params.get('bar') === '0') bar.remove()
else {
  const summary = document.createElement('summary')
  summary.textContent = '🧪'
  summary.title = '시나리오'
  const list = document.createElement('div')
  list.className = 'dev-list'
  const link = (label: string, patch: Record<string, string>, cls = ''): void => {
    const q = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(patch)) q.set(k, v)
    const a = document.createElement('a')
    a.href = '?' + q.toString()
    a.textContent = label
    a.className = cls
    list.append(a)
  }
  for (const name of Object.keys(SCENARIOS)) link(name, { scenario: name }, name === scenario ? 'on' : '')
  link('터치 배치', { touch: '1' }, 'opt')
  link('PC 배치', { touch: '0' }, 'opt')
  bar.append(summary, list)
}

declare global {
  interface Window {
    __ui: {
      ctx: AppContext
      inject: typeof inject
      setPhase: typeof setPhase
      setNear: typeof setNear
      welcome: typeof welcome
      scenarios: string[]
      sent: unknown[]
      sfxLog: string[]
      /** overlay.update() 평균 소요 시간(ms) */
      perf(): { frames: number; overlayAvgMs: number }
      set(opts: { outcome?: PitchOutcome | null; roomsFail?: boolean; actions?: number }): void
    }
  }
}
window.__ui = {
  ctx,
  inject,
  setPhase,
  setNear,
  welcome,
  scenarios: Object.keys(SCENARIOS),
  sent,
  sfxLog,
  perf: () => ({ frames, overlayAvgMs: frames ? overlayMs / frames : 0 }),
  set(opts) {
    if (opts.outcome !== undefined) forcedOutcome = opts.outcome
    if (opts.roomsFail !== undefined) roomsFail = opts.roomsFail
    if (opts.actions !== undefined) {
      extraActions = opts.actions
      cooldownBase = performance.now() + 9000
      ui.refreshContext()
    }
  },
}
