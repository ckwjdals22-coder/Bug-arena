/**
 * 통신 프로토콜.
 *
 * - 이벤트성 메시지: JSON 텍스트 프레임. `t` 필드가 메시지 종류.
 * - 고빈도 위치 데이터: 바이너리 프레임.
 *     · 클라 → 서버  MOVE     (7 bytes)
 *     · 서버 → 클라  SNAPSHOT (가변)
 *
 * 모든 시각은 서버 epoch ms 기준(JSON 숫자 / 바이너리 float64).
 * 스냅샷에는 '직전 스냅샷 이후 변한 엔티티'만 들어간다. WebSocket 은 순서/전달이 보장되므로
 * 스냅샷에 없는 엔티티는 "그 시각까지 그대로 있었다"는 뜻이다(클라이언트 보간에서 hold 처리).
 */
import type {
  CultRef,
  CultScore,
  FeedKind,
  Look,
  NpcPublic,
  PitchOutcome,
  PlayerPublic,
  Progress,
  RoomInfo,
  SignedSave,
} from './types'

// ═════════════════ Client → Server (JSON) ═════════════════

/** 접속 직후 반드시 가장 먼저 보낸다 */
export interface CHello {
  t: 'hello'
  v: number
  /** 기기에 저장된 임의 id (개인정보 아님). 중복 접속 판별용 */
  pid: string
  name: string
  look: Look
  save?: SignedSave | null
  /** 초대 링크(?by=닉네임)로 들어온 경우 초대한 사람의 닉네임 */
  ref?: string
}
export interface CEmote {
  t: 'emote'
  /** EMOTES 의 id. 빈 문자열이면 반복 이모트 중지 */
  e: string
}
/** 미리 정해진 말풍선 */
export interface CSay {
  t: 'say'
  q: number
}
export interface CTalk {
  t: 'talk'
  n: number
}
export interface CPitch {
  t: 'pitch'
  n: number
  /** PitchLine.id — talkOk.lines 로 제시된 것 중 하나여야 한다 */
  l: number
}
export interface CTalkEnd {
  t: 'talkEnd'
}
/** 닉네임/외형 변경 */
export interface CProfile {
  t: 'profile'
  name?: string
  look?: Look
  /** 이름표에 붙일 칭호 = 달성한 업적 id. 빈 문자열이면 칭호 없음 */
  tag?: string
}
export interface CCultCreate {
  t: 'cultCreate'
  name: string
  color: number
  emblem: number
  title: string
}
export interface CCultLeave {
  t: 'cultLeave'
}
/** 다른 플레이어에게 교단 가입 제안 */
export interface CInvite {
  t: 'invite'
  to: number
}
export interface CInviteAns {
  t: 'inviteAns'
  from: number
  ok: boolean
  /** true 면 이 상대의 초대를 계속 차단 */
  block?: boolean
}
export interface CBlock {
  t: 'block'
  id: number
  on: boolean
}
export interface CReport {
  t: 'report'
  id: number
  why: 'name' | 'spam' | 'grief' | 'etc'
}
/** 단상 위에서 '오늘의 계시' */
export interface CProphecy {
  t: 'prophecy'
}
/** 집단 설교: start(단상에서 시작) / join(참여) / resp(구호 응답) */
export interface CSermon {
  t: 'sermon'
  a: 'start' | 'join' | 'resp'
  r?: number
}
/** 포교 배틀: req(신청) / ans(응답) */
export interface CBattle {
  t: 'battle'
  a: 'req' | 'ans'
  to?: number
  from?: number
  ok?: boolean
}
/** 헌금함 앞에서 '헌납 타임' */
export interface COffer {
  t: 'offer'
}
/** 가상 매점에서 칭호 바꾸기(가상 코인만 쓴다) */
export interface CBuy {
  t: 'buy'
  /** shared/content/shop.ts 의 id */
  id: string
}
/** 라이벌 교주 기싸움에서 선택지 고르기 */
export interface CDuel {
  t: 'duel'
  c: number
}
/** 일일 수행 보상 받기 */
export interface CDaily {
  t: 'daily'
  q: string
}
export interface CPing {
  t: 'ping'
  c: number
}
export interface CRooms {
  t: 'rooms'
}
export interface CCults {
  t: 'cults'
}

export type ClientMsg =
  | CHello
  | CEmote
  | CSay
  | CTalk
  | CPitch
  | CTalkEnd
  | CProfile
  | CCultCreate
  | CCultLeave
  | CInvite
  | CInviteAns
  | CBlock
  | CReport
  | CProphecy
  | CSermon
  | CBattle
  | COffer
  | CBuy
  | CDuel
  | CDaily
  | CPing
  | CRooms
  | CCults

export type ClientMsgType = ClientMsg['t']

// ═════════════════ Server → Client (JSON) ═════════════════

export interface SermonState {
  leader: number
  startedAt: number
  endsAt: number
  /** 참여 중인 플레이어 id (교주 포함) */
  joined: number[]
}
export interface BattleState {
  a: number
  b: number
  sa: number
  sb: number
  endsAt: number
}

export interface SWelcome {
  t: 'welcome'
  /** 내 플레이어 id */
  id: number
  room: RoomInfo
  now: number
  players: PlayerPublic[]
  npcs: NpcPublic[]
  me: Progress
  save: SignedSave
  sermon: SermonState | null
  battles: BattleState[]
  /** 서버가 보정한 닉네임(필터에 걸렸을 수 있음) */
  name: string
  look: Look
  x: number
  z: number
}
/** 방이 가득 참. 이 메시지 후 서버가 연결을 닫는다 */
export interface SFull {
  t: 'full'
  rooms: RoomInfo[]
}
export interface SKick {
  t: 'kick'
  /** dup: 같은 기기 id로 다른 곳에서 접속 / idle: 장시간 무응답 / rate: 과도한 요청 / ver: 버전 불일치 / bad: 잘못된 요청 */
  why: 'dup' | 'idle' | 'rate' | 'ver' | 'bad' | 'shutdown'
}
export interface SJoin {
  t: 'join'
  p: PlayerPublic
}
export interface SLeave {
  t: 'leave'
  id: number
}
/** 플레이어 공개 정보 일부 변경 */
export interface SPlayerUpdate {
  t: 'pu'
  id: number
  name?: string
  look?: Look
  rank?: number
  fol?: number
  cult?: CultRef | null
  tag?: string
}
export interface SEmote {
  t: 'emote'
  id: number
  e: string
}
export interface SSay {
  t: 'say'
  id: number
  q: number
}
/** NPC 등장 또는 교체(같은 id) */
export interface SNpcSpawn {
  t: 'npcSpawn'
  n: NpcPublic
}
/**
 * 시민이 출구로 나가 방에서 빠졌다(접속자가 줄어 시민 수를 줄일 때). 클라이언트는 그 id 를 지운다.
 * 같은 id 는 나중에 npcSpawn 으로 다른 시민이 다시 쓸 수 있다
 */
export interface SNpcGone {
  t: 'npcGone'
  n: number
}
/** NPC 공개 정보 일부 변경(주인/역할) */
export interface SNpcUpdate {
  t: 'nu'
  n: number
  owner?: number
  role?: string
}
/** NPC 혼잣말/반응 말풍선 묶음 */
export interface SNpcSay {
  t: 'npcSay'
  /** [npcId, text] */
  l: [number, string][]
}
export interface STalkOk {
  t: 'talkOk'
  n: number
  greet: string
  lines: number[]
  round: number
}
export interface STalkNo {
  t: 'talkNo'
  n: number
  /** busy: 다른 사람과 대화 중 / cool: 쿨타임 / far: 너무 멂 / memo: 방금 거절한 사람 / mine: 이미 내 신도 / gone: 사라짐 / loyal: 갓 남의 신도가 되어 한눈팔지 않는 중 */
  why: 'busy' | 'cool' | 'far' | 'memo' | 'mine' | 'gone' | 'loyal'
  /** 쿨타임 남은 ms (why=cool|memo|loyal) */
  ms?: number
}
/** 포교 결과. 방 전체에 방송된다(말풍선/연출용) */
export interface SPitchRes {
  t: 'pitchRes'
  p: number
  n: number
  l: number
  o: PitchOutcome
  /** NPC 대사 */
  say: string
  /** 연속 실패 끝에 '동정표'로 넘어온 합류일 때만 실린다(화면에 "(동정표 획득)" 표시) */
  sym?: true
}
/** 대화 종료(시간 초과 등) — 당사자에게만 */
export interface STalkEnd {
  t: 'talkEnd'
  n: number
  why: 'timeout' | 'done' | 'cancel' | 'gone'
}
/** 보상 알림 — 당사자에게만 */
export interface SReward {
  t: 'reward'
  /** 보상 사유 코드: join, more, fail, prophecy, sermon, battle, offer, ach, daily, duel ... */
  why: string
  inf?: number
  fol?: number
  coins?: number
  /** 현재 연속 성공 수 */
  streak?: number
  /** 새로 달성한 업적 id */
  ach?: string[]
  /** 새 직급(승급 시) */
  rankUp?: number
  /** 획득한 헌납품 id */
  items?: string[]
}
/** 내 진행도 전체 + 서명 저장본 */
export interface SSave {
  t: 'save'
  me: Progress
  save: SignedSave
}
/** 방 전체 소식 피드 */
export interface SFeed {
  t: 'feed'
  k: FeedKind
  /** 관련 플레이어 id (없으면 0) */
  id: number
  text: string
}
export interface SInvited {
  t: 'invited'
  from: number
  cult: CultRef
  /** 만료 시각 */
  until: number
}
/** 초대 결과 — 초대한 사람에게 */
export interface SInviteRes {
  t: 'inviteRes'
  to: number
  /** ok: 수락 / no: 거절 / cool: 쿨타임 / blocked: 차단됨(상대에게는 거절로 보임) / busy / far / nocult: 내가 교단이 없음 / same: 이미 같은 교단 */
  r: 'sent' | 'ok' | 'no' | 'cool' | 'busy' | 'far' | 'nocult' | 'same' | 'expired'
  ms?: number
}
export interface SCults {
  t: 'cults'
  list: CultScore[]
}
/** 교단 관련 요청 결과 — 당사자에게 */
export interface SCultRes {
  t: 'cultRes'
  ok: boolean
  /** name: 부적절/금지된 이름 / title / dup: 같은 이름 존재 / rate */
  why?: 'name' | 'title' | 'dup' | 'rate' | 'bad'
}
export interface SProphecy {
  t: 'prophecy'
  p: number
  text: string
  /** 주변 반응 말풍선 [entityKey, text] (NPC는 npcKey) */
  re: [number, string][]
}
export interface SSermon {
  t: 'sermon'
  ph: 'start' | 'join' | 'call' | 'end' | 'no'
  s?: SermonState
  /** call: 라운드/구호 */
  round?: number
  call?: string
  resp?: string
  /** call: 응답 마감 시각 */
  until?: number
  /** end: 결과 */
  score?: number
  converts?: number
  /** no: 시작 거절 사유 */
  why?: 'cool' | 'far' | 'busy'
  ms?: number
}
export interface SBattle {
  t: 'battle'
  ph: 'inv' | 'start' | 'score' | 'end' | 'no'
  b?: BattleState
  /** inv: 신청자 */
  from?: number
  until?: number
  /** end: 승자 id (무승부 0) */
  winner?: number
  why?: 'cool' | 'busy' | 'far' | 'no' | 'left'
}
export interface SOffered {
  t: 'offered'
  p: number
  /** [npcId, itemId] */
  items: [number, string][]
  coins: number
}
/** 가상 매점 결과. coins = 처리 뒤 남은 가상 코인 */
export interface SShopRes {
  t: 'shopRes'
  ok: boolean
  id: string
  coins: number
  /** 실패 사유: 없는 물건 / 천막에서 멂 / 이미 있음 / 코인 부족 */
  why?: 'bad' | 'far' | 'owned' | 'poor'
}
/** 라이벌 교주 기싸움 */
export interface SDuel {
  t: 'duel'
  ph: 'start' | 'end'
  n: number
  /** start: 상대의 멘트와 내 선택지 */
  say?: string
  choices?: string[]
  until?: number
  /** end */
  win?: boolean
  text?: string
}
/** 단속반 이벤트 */
export interface SPatrol {
  t: 'patrol'
  ph: 'alert' | 'chase' | 'caught' | 'lost'
  n: number
  p: number
  /** caught: 얼어붙는 시간 ms */
  ms?: number
}
/** 서버 위치 보정 */
export interface SPos {
  t: 'pos'
  x: number
  z: number
}
export interface SPong {
  t: 'pong'
  c: number
  s: number
}
export interface SRooms {
  t: 'rooms'
  rooms: RoomInfo[]
}
export interface SErr {
  t: 'err'
  code: string
  msg?: string
}

export type ServerMsg =
  | SWelcome
  | SFull
  | SKick
  | SJoin
  | SLeave
  | SPlayerUpdate
  | SEmote
  | SSay
  | SNpcSpawn
  | SNpcGone
  | SNpcUpdate
  | SNpcSay
  | STalkOk
  | STalkNo
  | SPitchRes
  | STalkEnd
  | SReward
  | SSave
  | SFeed
  | SInvited
  | SInviteRes
  | SCults
  | SCultRes
  | SProphecy
  | SSermon
  | SBattle
  | SOffered
  | SShopRes
  | SDuel
  | SPatrol
  | SPos
  | SPong
  | SRooms
  | SErr

export type ServerMsgType = ServerMsg['t']
export type ServerMsgOf<T extends ServerMsgType> = Extract<ServerMsg, { t: T }>
export type ClientMsgOf<T extends ClientMsgType> = Extract<ClientMsg, { t: T }>

// ═════════════════ WebSocket close codes ═════════════════
export const CLOSE_FULL = 4001
export const CLOSE_KICK = 4002
export const CLOSE_BAD = 4003
export const CLOSE_SHUTDOWN = 4004

// ═════════════════ 바이너리 코덱 ═════════════════

export const BIN_MOVE = 1
export const BIN_SNAPSHOT = 2

export const MOVE_BYTES = 7
const SNAP_HEADER = 1 + 8 + 1 + 1
const SNAP_PLAYER_BYTES = 8
const SNAP_NPC_BYTES = 7

const TWO_PI = Math.PI * 2

/** 미터 → int16(cm). 범위 ±327.67m */
export function quantPos(v: number): number {
  const q = Math.round(v * 100)
  return q > 32767 ? 32767 : q < -32768 ? -32768 : q
}
export function dequantPos(q: number): number {
  return q / 100
}
/** 라디안 → uint8 */
export function quantYaw(yaw: number): number {
  let y = yaw % TWO_PI
  if (y < 0) y += TWO_PI
  return Math.round((y / TWO_PI) * 256) & 255
}
export function dequantYaw(q: number): number {
  return (q / 256) * TWO_PI
}

export interface MoveMsg {
  x: number
  z: number
  yaw: number
  st: number
}

/** 클라 → 서버 이동 패킷 */
export function encodeMove(x: number, z: number, yaw: number, st: number): ArrayBuffer {
  const buf = new ArrayBuffer(MOVE_BYTES)
  const dv = new DataView(buf)
  dv.setUint8(0, BIN_MOVE)
  dv.setInt16(1, quantPos(x), true)
  dv.setInt16(3, quantPos(z), true)
  dv.setUint8(5, quantYaw(yaw))
  dv.setUint8(6, st & 255)
  return buf
}

function toView(data: ArrayBuffer | Uint8Array): DataView {
  return data instanceof ArrayBuffer
    ? new DataView(data)
    : new DataView(data.buffer, data.byteOffset, data.byteLength)
}

/** 잘못된 패킷이면 null */
export function decodeMove(data: ArrayBuffer | Uint8Array): MoveMsg | null {
  const dv = toView(data)
  if (dv.byteLength !== MOVE_BYTES || dv.getUint8(0) !== BIN_MOVE) return null
  return {
    x: dequantPos(dv.getInt16(1, true)),
    z: dequantPos(dv.getInt16(3, true)),
    yaw: dequantYaw(dv.getUint8(5)),
    st: dv.getUint8(6),
  }
}

/** 스냅샷에 들어가는 엔티티 한 줄 */
export interface SnapEnt {
  id: number
  x: number
  z: number
  yaw: number
  st: number
}

export interface Snapshot {
  /** 서버 epoch ms */
  time: number
  players: SnapEnt[]
  npcs: SnapEnt[]
}

/**
 * 서버 → 클라 스냅샷.
 * [u8 type][f64 time][u8 nPlayers][u8 nNpcs]
 *   players: [u16 id][i16 x][i16 z][u8 yaw][u8 st]
 *   npcs:    [u8 id][i16 x][i16 z][u8 yaw][u8 st]
 */
export function encodeSnapshot(time: number, players: readonly SnapEnt[], npcs: readonly SnapEnt[]): Uint8Array {
  const np = Math.min(players.length, 255)
  const nn = Math.min(npcs.length, 255)
  const out = new Uint8Array(SNAP_HEADER + np * SNAP_PLAYER_BYTES + nn * SNAP_NPC_BYTES)
  const dv = new DataView(out.buffer)
  let o = 0
  dv.setUint8(o, BIN_SNAPSHOT)
  o += 1
  dv.setFloat64(o, time, true)
  o += 8
  dv.setUint8(o++, np)
  dv.setUint8(o++, nn)
  for (let i = 0; i < np; i++) {
    const e = players[i]!
    dv.setUint16(o, e.id & 0xffff, true)
    dv.setInt16(o + 2, quantPos(e.x), true)
    dv.setInt16(o + 4, quantPos(e.z), true)
    dv.setUint8(o + 6, quantYaw(e.yaw))
    dv.setUint8(o + 7, e.st & 255)
    o += SNAP_PLAYER_BYTES
  }
  for (let i = 0; i < nn; i++) {
    const e = npcs[i]!
    dv.setUint8(o, e.id & 255)
    dv.setInt16(o + 1, quantPos(e.x), true)
    dv.setInt16(o + 3, quantPos(e.z), true)
    dv.setUint8(o + 5, quantYaw(e.yaw))
    dv.setUint8(o + 6, e.st & 255)
    o += SNAP_NPC_BYTES
  }
  return out
}

/** 잘못된 패킷이면 null */
export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot | null {
  const dv = toView(data)
  if (dv.byteLength < SNAP_HEADER || dv.getUint8(0) !== BIN_SNAPSHOT) return null
  let o = 1
  const time = dv.getFloat64(o, true)
  o += 8
  const np = dv.getUint8(o++)
  const nn = dv.getUint8(o++)
  if (dv.byteLength !== SNAP_HEADER + np * SNAP_PLAYER_BYTES + nn * SNAP_NPC_BYTES) return null
  const players: SnapEnt[] = new Array(np)
  for (let i = 0; i < np; i++) {
    players[i] = {
      id: dv.getUint16(o, true),
      x: dequantPos(dv.getInt16(o + 2, true)),
      z: dequantPos(dv.getInt16(o + 4, true)),
      yaw: dequantYaw(dv.getUint8(o + 6)),
      st: dv.getUint8(o + 7),
    }
    o += SNAP_PLAYER_BYTES
  }
  const npcs: SnapEnt[] = new Array(nn)
  for (let i = 0; i < nn; i++) {
    npcs[i] = {
      id: dv.getUint8(o),
      x: dequantPos(dv.getInt16(o + 1, true)),
      z: dequantPos(dv.getInt16(o + 3, true)),
      yaw: dequantYaw(dv.getUint8(o + 5)),
      st: dv.getUint8(o + 6),
    }
    o += SNAP_NPC_BYTES
  }
  return { time, players, npcs }
}

/** JSON 메시지 파싱. 형식이 틀리면 null (필드 검증은 받는 쪽 책임) */
export function parseJsonMsg<T extends { t: string }>(text: string): T | null {
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string') return v as T
  } catch {
    /* ignore */
  }
  return null
}
