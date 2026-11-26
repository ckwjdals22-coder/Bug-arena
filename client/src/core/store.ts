/**
 * 클라이언트 상태 저장소. 단순한 가변 객체이며, 바뀔 때는 bus 이벤트로 알린다.
 * - net 모듈: 서버 메시지를 받아 players/npcs/me/talk/… 를 갱신
 * - game 모듈: me 의 위치·near 를 갱신
 * - render/ui 모듈: 읽기만 한다(변경은 actions / net.send 로)
 */
import type { BattleState, SermonState } from '../../../shared/protocol'
import type { CultRef, Look, NpcPublic, PlayerPublic, Progress, RoomInfo, SignedSave } from '../../../shared/types'
import { defaultLook } from '../../../shared/rules/progress'
import { NICK_ADJ, NICK_NOUN } from '../../../shared/content/misc'
import { NAME_MAX } from '../../../shared/constants'
import type { QualityTier } from './contracts'

export type Phase =
  | 'title' // 첫 화면(닉네임/방 선택)
  | 'connecting' // 접속 중
  | 'playing' // 게임 중
  | 'reconnecting' // 끊겨서 자동 재접속 시도 중
  | 'kicked' // 서버가 내보냄(중복 접속 등) — 자동 재접속 안 함
  | 'full' // 방이 가득 참 — 다른 방 안내
  | 'error' // 접속 실패(재접속 버튼 표시)

export interface Settings {
  sfx: boolean
  music: boolean
  quality: 'auto' | QualityTier
  /** 다른 사람의 교단 초대를 아예 받지 않기 */
  noInvites: boolean
  /** 이름표 항상 표시 */
  showNames: boolean
}

/** 이 기기에만 저장되는 정보(localStorage). 개인정보를 담지 않는다. */
export interface LocalProfile {
  /** 임의 생성 기기 id */
  pid: string
  name: string
  look: Look
  /** 서버가 서명해 준 진행도 */
  save: SignedSave | null
  settings: Settings
  /** 차단한 상대의 표시 이름 목록(안내용) */
  blocked: string[]
  lastRoom: string | null
  tutorialDone: boolean
}

/** 보간용 샘플(net 모듈 전용) */
export interface Sample {
  /** 서버 시각 */
  t: number
  /** 이 시각까지 같은 자리에 있었음(스냅샷에 안 나온 동안) */
  hold: number
  x: number
  z: number
  yaw: number
  st: number
}

/** 화면에 보이는 캐릭터 공통 상태(보간된 값) */
export interface EntityView {
  x: number
  y: number
  z: number
  yaw: number
  /** Anim */
  st: number
  /** 현재 이모트와 시작 시각(performance.now ms) */
  emote: string | null
  emoteAt: number
  /** 캐릭터별 고정 난수 0..1 */
  phase: number
  /** 등장 시각(performance.now ms) — 등장 연출용 */
  bornAt: number
  samples: Sample[]
}

export interface PlayerView extends EntityView {
  pub: PlayerPublic
}

export interface NpcView extends EntityView {
  pub: NpcPublic
}

export interface MeView extends EntityView {
  id: number
  prog: Progress
  /** 스프린트(도망가기) 종료/재사용 가능 시각(performance.now ms) */
  sprintUntil: number
  sprintReadyAt: number
  /** 얼어붙음 종료 시각(performance.now ms) */
  stunUntil: number
  /** 현재 따라다니는 NPC 신도 수 */
  entourage: number
}

export interface TalkState {
  npc: number
  greet: string
  lines: number[]
  round: number
  /** 멘트를 골라 서버 응답을 기다리는 중 */
  waiting: boolean
}

export type PoiKind = 'podium' | 'offering' | 'hq' | 'booth' | null

export interface NearState {
  /** 말 걸 수 있는 가장 가까운 NPC id (없으면 0) */
  npc: number
  /** 상호작용 가능한 가장 가까운 플레이어 id (없으면 0) */
  player: number
  poi: PoiKind
}

export interface Store {
  phase: Phase
  /** kicked/error 일 때 사유 코드 */
  phaseWhy: string
  profile: LocalProfile
  rooms: RoomInfo[]
  room: RoomInfo | null
  me: MeView | null
  /** 나를 제외한 실제 접속자 */
  players: Map<number, PlayerView>
  npcs: Map<number, NpcView>
  talk: TalkState | null
  near: NearState
  sermon: SermonState | null
  battles: BattleState[]
  /** 추정 서버 시각 = Date.now() + clockOffset */
  clockOffset: number
  rtt: number
  /** 포교 쿨타임 종료(performance.now ms) */
  pitchReadyAt: number
  serverNow(): number
  /** 내 교단(없으면 null) */
  myCult(): CultRef | null
  /** id 로 이름 찾기(나 포함) */
  nameOf(playerId: number): string
}

const PROFILE_KEY = 'doas.profile.v1'

export function randomNickname(rnd: () => number = Math.random): string {
  for (let i = 0; i < 20; i++) {
    const adj = NICK_ADJ[Math.floor(rnd() * NICK_ADJ.length)] ?? '수상한'
    const noun = NICK_NOUN[Math.floor(rnd() * NICK_NOUN.length)] ?? '행인'
    const name = adj + noun
    if (Array.from(name).length <= NAME_MAX) return name
  }
  return '수상한행인'
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  let s = ''
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

export function defaultSettings(): Settings {
  return { sfx: true, music: false, quality: 'auto', noInvites: false, showNames: true }
}

export function loadProfile(): LocalProfile {
  let raw: Partial<LocalProfile> = {}
  try {
    const text = localStorage.getItem(PROFILE_KEY)
    if (text) raw = JSON.parse(text) as Partial<LocalProfile>
  } catch {
    raw = {}
  }
  const seed = Math.floor(Math.random() * 1e9)
  const profile: LocalProfile = {
    pid: typeof raw.pid === 'string' && raw.pid.length >= 8 ? raw.pid : randomId(),
    name: typeof raw.name === 'string' && raw.name ? raw.name : randomNickname(),
    look: Array.isArray(raw.look) && raw.look.length === 7 ? (raw.look as Look) : defaultLook(seed),
    save: raw.save && typeof raw.save.d === 'string' && typeof raw.save.s === 'string' ? raw.save : null,
    settings: { ...defaultSettings(), ...(raw.settings ?? {}) },
    blocked: Array.isArray(raw.blocked) ? raw.blocked.slice(0, 100) : [],
    lastRoom: typeof raw.lastRoom === 'string' ? raw.lastRoom : null,
    tutorialDone: raw.tutorialDone === true,
  }
  return profile
}

export function saveProfile(profile: LocalProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {
    /* 사파리 사생활 보호 모드 등: 저장 실패는 무시(게임은 계속) */
  }
}

export function createStore(): Store {
  const store: Store = {
    phase: 'title',
    phaseWhy: '',
    profile: loadProfile(),
    rooms: [],
    room: null,
    me: null,
    players: new Map(),
    npcs: new Map(),
    talk: null,
    near: { npc: 0, player: 0, poi: null },
    sermon: null,
    battles: [],
    clockOffset: 0,
    rtt: 0,
    pitchReadyAt: 0,
    serverNow() {
      return Date.now() + store.clockOffset
    },
    myCult() {
      return store.me?.prog.cult ?? null
    },
    nameOf(playerId: number) {
      if (store.me && store.me.id === playerId) return store.profile.name
      return store.players.get(playerId)?.pub.name ?? '누군가'
    },
  }
  return store
}
