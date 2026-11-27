/**
 * 서버 코어 계약(인터페이스).
 *
 * server/core/** 는 '전송 계층과 무관'해야 한다: Node(ws)와 Cloudflare Durable Object 양쪽에서 같은 코드를 쓴다.
 *   - Node 전용 API(fs, http, process, Buffer, node:crypto) 사용 금지. 타이머도 직접 만들지 않는다(어댑터가 tick() 호출).
 *   - 쓸 수 있는 전역: 표준 JS, TextEncoder/TextDecoder, console.
 * 방 하나 = Room 인스턴스 하나. 어댑터는 연결/메시지/종료/틱을 Room 에 전달하고, Room 은 RoomHost 로 송신한다.
 */
import type { Archetype, PitchLine } from '../../shared/content/types'
import type { ClientMsg, ClientMsgType, ServerMsg, SWelcome } from '../../shared/protocol'
import type { PitchResult } from '../../shared/rules/pitch'
import type { Rnd } from '../../shared/rng'
import type { CultScore, FeedKind, Look, NpcPublic, PitchOutcome, PlayerPublic, Progress, RoomInfo } from '../../shared/types'
import type { WorldDef } from '../../shared/world/def'

export type ConnId = number

/** 저장본 서명기(HMAC-SHA256). 순수 JS 동기 구현을 쓴다 → Node/Workers 공통 */
export interface SaveSigner {
  sign(data: string): string
  verify(data: string, sig: string): boolean
}

/** 교단 기록 저장소(선택). Node: 메모리+파일, Workers: DO storage */
export interface CultRegistry {
  /** 교단 기록 갱신(없으면 생성). delta 는 더할 값 */
  record(cult: Omit<CultScore, 'online' | 'fol' | 'inf'>, delta: { fol: number; inf: number }): void
  /** 같은 이름의 다른 교단이 이미 있는가 */
  nameTaken(name: string, exceptId: string): boolean
  get(id: string): CultScore | undefined
  top(n: number): CultScore[]
  remove(id: string): void
}

/** 어댑터(Node/Workers)가 Room 에 제공하는 것 */
export interface RoomHost {
  /** 문자열 = 텍스트(JSON) 프레임, Uint8Array = 바이너리 프레임. 닫힌 연결이면 조용히 무시 */
  send(conn: ConnId, data: string | Uint8Array): void
  close(conn: ConnId, code: number, reason: string): void
  now(): number
  random(): number
  readonly signer: SaveSigner
  /** 전체 방 현황(가득 참 안내, 방 목록 응답) */
  listRooms(): RoomInfo[]
  /**
   * 같은 pid 가 이 방에 새로 들어왔음을 알린다. 어댑터는 다른 방에 같은 pid 가 있으면 내보낸다.
   * (같은 방 안의 중복은 Room 이 직접 처리)
   */
  claimPid(pid: string, roomId: string): void
  log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void
  readonly cults?: CultRegistry
}

/** 대화(포교) 세션 */
export interface TalkSession {
  npc: number
  round: number
  /** 이번 라운드에 제시한 멘트 id */
  lines: number[]
  /** 이미 쓴 멘트 id */
  used: number[]
  until: number
}

/** 서버가 들고 있는 플레이어 상태 */
export interface PlayerState {
  /** 방 안 고유 id (1..65535) */
  id: number
  conn: ConnId
  pid: string
  name: string
  look: Look
  prog: Progress
  x: number
  z: number
  yaw: number
  /** Anim */
  st: number
  /** 반복 중인 이모트 */
  emote: string | null
  /** 직전 스냅샷 이후 위치/상태가 변했는가 */
  dirty: boolean
  joinedAt: number
  lastMsgAt: number
  lastMoveAt: number
  talk: TalkSession | null
  /** 쿨타임: 키 → 다시 가능한 시각 */
  cd: Map<string, number>
  /** 포교 확률 버프(단상 계시)와 만료 시각 */
  buff: number
  buffUntil: number
  /** 단속 등으로 얼어붙는 만료 시각 */
  stunUntil: number
  /** 스프린트(도망가기) 허용 만료 시각 — 이동 검증용 */
  sprintUntil: number
  /** 내가 초대를 차단한 상대 pid */
  blocked: Set<string>
  /** 신고 누적 등으로 말풍선/초대/배틀 신청이 막히는 만료 시각(0 = 없음) */
  mutedUntil: number
  /** 신고로 강제 개명된 뒤 이름을 바꿀 수 없는 만료 시각(0 = 없음) */
  nameLockUntil: number
  /** 저장본 재서명/전송이 필요한가 */
  saveDirty: boolean
  /** 기능 시스템이 자유롭게 쓰는 칸(키는 시스템 이름으로 시작) */
  ext: Record<string, unknown>
}

export type NpcMode =
  | 'wander' // 이동망을 따라 돌아다님
  | 'pause' // 잠깐 멈춰 서 있음(가게 앞, 벤치)
  | 'listen' // 플레이어와 대화 중
  | 'follow' // 플레이어를 따라다님(신도)
  | 'flee' // 전력 질주로 도망
  | 'leave' // 출구로 걸어가서 사라짐 → 새 시민으로 교체
  | 'enter' // 출구에서 막 등장
  | 'gather' // 설교 구경
  | 'script' // 기능 시스템이 직접 조종(단속반 등). 시뮬은 건드리지 않는다

export interface NpcState {
  /** 1..255 */
  id: number
  arch: Archetype
  name: string
  look: Look
  model: number
  /** 특수 역할 표시: '' | 'patrol' | 'rival' ... */
  role: string
  x: number
  z: number
  yaw: number
  /** Anim */
  st: number
  mode: NpcMode
  /** 따라다니는 플레이어 id (없으면 0) */
  owner: number
  /** 대화 중인 플레이어 id (없으면 0) */
  talker: number
  /** 현재 모드 만료 시각(0 = 없음) */
  until: number
  /** 신도가 된 시각 */
  followSince: number
  /** 이 신도가 이미 헌납했는가 */
  offered: boolean
  /** playerId → 다시 말 걸 수 있는 시각 */
  memo: Map<number, number>
  dirty: boolean
}

export type OwnerChangeReason = 'join' | 'expire' | 'leave' | 'poach' | 'scatter' | 'replace'

/** NpcSim → Room 알림 */
export interface NpcSimEvents {
  /** 새 시민으로 교체/등장(같은 id 재사용) */
  onSpawn(npc: NpcState): void
  /** 주인(따라다니는 대상)이 바뀜 */
  onOwnerChange(npc: NpcState, prevOwner: number, reason: OwnerChangeReason): void
  /** NPC 가 말풍선을 띄움(혼잣말, 떠나는 말 등) */
  onSay(npc: NpcState, text: string): void
  /**
   * 시민이 출구로 나가 방에서 아예 빠졌다(접속자가 줄어 목표 시민 수가 내려갔을 때). 이 id 는 목록에서 지워졌고
   * 나중에 다른 시민이 다시 쓸 수 있다
   */
  onGone?(npc: NpcState): void
}

/** 시민 수 현황 */
export interface NpcPopulation {
  /** 지금 방에 있는 일반 시민 수(특수 NPC 제외) */
  citizens: number
  /** 시뮬이 맞추려는 시민 수 */
  target: number
  /** 설정한 기본 수(접속자가 적어도 이 아래로는 줄지 않는다) */
  base: number
  /** 상한 */
  max: number
}

export interface NpcSimApi {
  readonly list: readonly NpcState[]
  get(id: number): NpcState | undefined
  /** 매 틱 호출. dt 는 초 */
  tick(now: number, dt: number, players: ReadonlyMap<number, PlayerState>): void
  /** 지금 이 플레이어가 말을 걸 수 있는가 */
  canTalk(npc: NpcState, playerId: number, now: number): 'ok' | 'busy' | 'memo' | 'gone'
  /** 멈춰서 플레이어를 바라보게 한다 */
  beginListen(npc: NpcState, player: PlayerState, until: number): void
  /** 대화 종료 → 원래 하던 일(배회 또는 따라다니기)로 */
  endListen(npc: NpcState): void
  /** 신도로 만들어 따라다니게 한다(이전 주인이 있으면 poach) */
  startFollow(npc: NpcState, playerId: number, until: number, now: number): void
  /** 신도를 풀어 준다: 떠나는 말을 하고 배회로 복귀 */
  release(npc: NpcState, reason: OwnerChangeReason): void
  /** (fromX,fromZ) 반대 방향으로 전력 질주 후 배회 복귀 */
  flee(npc: NpcState, fromX: number, fromZ: number, now: number): void
  /** 거절하고 제 갈 길 */
  walkOff(npc: NpcState): void
  /** 이 플레이어가 until 까지 다시 말 못 걸게 기억 */
  remember(npc: NpcState, playerId: number, until: number): void
  followersOf(playerId: number): NpcState[]
  /** center 주변 배회 중인 시민을 불러 모아 구경시킨다. 모인 NPC 목록 반환 */
  gather(center: { x: number; z: number }, radius: number, until: number, max: number): NpcState[]
  /** 구경 해제 */
  ungather(): void
  /** 플레이어 퇴장 시: 대화/추종 정리 */
  onPlayerLeave(playerId: number): void
  /** NPC 를 출구로 보내고 새 시민으로 교체 */
  retire(npc: NpcState): void
  /** 기능 시스템이 직접 조종할 특수 NPC 추가(mode='script'). 자리가 없으면 null */
  addScripted(arch: Archetype, role: string, name: string, look: Look, x: number, z: number): NpcState | null
  removeScripted(npc: NpcState): void
  publicOf(npc: NpcState): NpcPublic
  /** 시민 수 현황(진단·테스트용). 접속자 수에 따라 늘고 준다 */
  population?(): NpcPopulation
}

export interface Grant {
  /** 보상 사유 코드(SReward.why) */
  why: string
  inf?: number
  fol?: number
  coins?: number
  items?: string[]
  /** 표시용 현재 연속 성공 */
  streak?: number
}

/** 기능 시스템이 Room 을 다루는 창구 */
export interface RoomApi {
  readonly id: string
  readonly name: string
  readonly players: ReadonlyMap<number, PlayerState>
  readonly npcs: NpcSimApi
  readonly world: WorldDef
  readonly host: RoomHost
  readonly rnd: Rnd
  now(): number
  send(p: PlayerState, msg: ServerMsg): void
  broadcast(msg: ServerMsg, except?: PlayerState): void
  /** 영향력/신도/코인/헌납품 지급 → 직급 갱신, reward 전송, 공개 정보 방송, 저장 예약, 교단 기록 반영 */
  grant(p: PlayerState, g: Grant): void
  /** 통계 카운터 += n → onStat 훅 호출 */
  bump(p: PlayerState, stat: string, n?: number): number
  /** 통계 값을 직접 지정(연속 기록 등) → onStat 훅 호출 */
  setStat(p: PlayerState, stat: string, value: number): void
  feed(kind: FeedKind, playerId: number, text: string): void
  /** 공개 정보가 바뀌었음을 방 전체에 방송(pu) */
  publish(p: PlayerState, fields: readonly ('name' | 'look' | 'rank' | 'fol' | 'cult' | 'tag')[]): void
  /** 저장본 재서명/전송 예약 */
  markSave(p: PlayerState): void
  /** NPC 말풍선 방송 */
  npcSay(lines: [number, string][]): void
  /**
   * 쿨타임 검사+설정. 아직 쿨타임이면 남은 ms(>0)를 돌려주고 아무것도 바꾸지 않는다.
   * 가능하면 0 을 돌려주고 now+ms 로 쿨타임을 건다.
   */
  cooldown(p: PlayerState, key: string, ms: number): number
  playerPublic(p: PlayerState): PlayerPublic
  playerByPid(pid: string): PlayerState | undefined
  /** 업적 달성 처리(중복이면 false). 보상/알림까지 수행 */
  unlockAchievement(p: PlayerState, achId: string): boolean
}

/**
 * 기능 시스템(플러그인). server/core/systems/*.ts 가 구현하고 systems/index.ts 에서 등록한다.
 * Room 은 handles 에 적힌 종류의 메시지를 해당 시스템에 넘긴다.
 */
export interface RoomSystem {
  readonly name: string
  readonly handles: readonly ClientMsgType[]
  init?(room: RoomApi): void
  onMessage?(p: PlayerState, msg: ClientMsg): void
  onTick?(now: number, dt: number): void
  onJoin?(p: PlayerState): void
  onLeave?(p: PlayerState): void
  /**
   * 포교 판정 직후, 기본 처리 전에 호출. true 를 돌려주면 Room 의 기본 처리(합류/도망 등)를 건너뛴다.
   * (예: outcome 'rival' → 기싸움 시스템이 가로챔)
   */
  interceptPitch?(p: PlayerState, npc: NpcState, line: PitchLine, result: PitchResult): boolean
  /** 포교 결과 기본 처리가 끝난 뒤 */
  onPitch?(p: PlayerState, npc: NpcState, line: PitchLine, outcome: PitchOutcome): void
  /** 통계 값이 변한 직후 */
  onStat?(p: PlayerState, stat: string, value: number): void
  /** welcome 메시지를 보내기 직전(상태 채워 넣기) */
  onWelcome?(p: PlayerState, w: SWelcome): void
}

export type RoomSystemFactory = () => RoomSystem

/**
 * 접속이 끊긴 뒤에도 잠깐 기억해 두는 접속자별 메모.
 * 재접속(또는 같은 pid 로 새 탭 열기)으로 쿨타임·차단·입막음·이름 고정을 지우지 못하게 한다.
 * 진행도가 아니라 '제재와 예의'에 관한 짧은 기억이며, 서버 메모리에만 있고 저장하지 않는다.
 */
export interface PlayerMemory {
  cd: Map<string, number>
  blocked: Set<string>
  mutedUntil: number
  nameLockUntil: number
  /** 이름 고정 중에 써야 하는 이름 */
  lockedName: string
  /** 지금 접속 중인가 */
  live: boolean
  /** 접속이 끊긴 뒤 이 시각까지만 기억한다 */
  keepUntil: number
  /** 마지막으로 서 있던 자리와 따라오던 신도(잠깐 자리를 비웠다 돌아오면 되찾는다) */
  last?: LastSeat
  /**
   * 나갈 때의 진행도와 그 유효 시각. 저장본은 1초에 한 번만 내려가므로, 나가기 직전에 받은 보상이
   * 클라이언트 저장본에 없을 수 있다 → 곧(같은 pid 로) 다시 들어오면 이쪽이 더 새것일 때 이것을 쓴다.
   */
  prog?: Progress
  progUntil?: number
}

export interface LastSeat {
  room: string
  x: number
  z: number
  yaw: number
  at: number
  followers: { id: number; key: string; until: number; offered: boolean }[]
}

export interface RoomOptions {
  id: string
  name: string
  capacity?: number
  /** 기본 시민 수(접속자가 적을 때의 수이자 하한) */
  npcCount?: number
  /** 접속자가 늘 때 시민을 몇 명까지 늘릴 수 있는가(기본 NPC_MAX_PER_ROOM). npcCount 이하면 늘리지 않는다 */
  npcMax?: number
  /** 접속자별 메모 저장소. 여러 방이 같은 것을 쓰면 방을 옮겨도 기억이 따라간다(없으면 방마다 따로) */
  memory?: Map<string, PlayerMemory>
  /** 테스트용 난수 시드 */
  seed?: number
  world?: WorldDef
  systems?: RoomSystemFactory[]
}
