/**
 * 클라이언트 모듈 계약(인터페이스). 각 모듈은 이 파일의 타입만 보고 서로 맞물린다.
 * 구현 파일 위치는 docs/ARCHITECTURE.md 참고.
 */
import type * as THREE from 'three'
import type { ClientMsg } from '../../../shared/protocol'
import type { Look } from '../../../shared/types'
import type { Bus } from './bus'
import type { Store } from './store'

export type QualityTier = 'low' | 'mid' | 'high'

// ───────── 렌더 엔진 (render/engine.ts) ─────────
export interface EngineApi {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly canvas: HTMLCanvasElement
  readonly quality: QualityTier
  setQuality(q: QualityTier): void
  /** 품질 단계가 바뀔 때 호출될 콜백 등록 */
  onQuality(fn: (q: QualityTier) => void): void
  /** 월드 좌표 → 화면 CSS px. 카메라 뒤거나 화면 밖(여유 포함)이면 false */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean
  /** 화면 좌표(clientX/Y)에서 쏜 광선이 지면(y=0)과 만나는 점 */
  pickGround(clientX: number, clientY: number): { x: number; z: number } | null
  resize(): void
  render(): void
}

// ───────── 캐릭터 렌더러 (render/characters.ts) ─────────
/** 한 프레임에 그릴 캐릭터 한 명의 시각 상태. 게임 루프가 매 프레임 채워서 넘긴다. */
export interface CharVisual {
  /** 플레이어 = id, NPC = npcKey(id) */
  key: number
  x: number
  y: number
  z: number
  yaw: number
  look: Look
  /** NpcModel (0 사람) */
  model: number
  /** Anim */
  anim: number
  /** 재생 중인 이모트 id (없으면 null) */
  emote: string | null
  /** 이모트 시작 후 경과 초 */
  emoteT: number
  /** 캐릭터별 고정 난수 0..1 (걸음 위상 등) */
  phase: number
  /** 1 = 보통. 등장/퇴장 연출용 */
  scale: number
  /** 발밑 고리 색(0xRRGGBB). 없으면 -1. 신도 NPC 는 주인의 교단색/기본색 */
  ring: number
  isNpc: boolean
  /** '말 걸기' 대상 강조 */
  highlight: boolean
}

export interface CharacterRendererApi {
  /** 매 프레임 호출. 넘겨받은 목록만 그린다(컬링/LOD/절차 애니메이션은 렌더러 책임). time 은 초 */
  update(dt: number, time: number, visuals: readonly CharVisual[]): void
  /** 캐릭터 초상(프로필/임명장)을 size×size 캔버스로 그려 돌려준다 */
  portrait(look: Look, size: number, emote?: string): HTMLCanvasElement
  dispose(): void
}

// ───────── 월드 렌더러 (render/world.ts) ─────────
export interface WorldRendererApi {
  /** 움직이는 장식(네온, 신호등, 깃발 등) 갱신. time 은 초 */
  update(dt: number, time: number): void
  dispose(): void
}

// ───────── 이펙트 (render/fx.ts) ─────────
export type FxKind =
  | 'join' // 합류: 하트+반짝이
  | 'fail' // 거절: 식은땀
  | 'flee' // 도망: 먼지
  | 'rank' // 승급: 색종이 분수
  | 'prophecy' // 계시: 빛기둥
  | 'coin' // 헌납: 동전
  | 'poof' // 등장/퇴장: 연기
  | 'cheer' // 환호: 작은 반짝이
  | 'alert' // 단속: 느낌표

export interface FxApi {
  burst(kind: FxKind, x: number, y: number, z: number, color?: number): void
  update(dt: number, time: number): void
  dispose(): void
}

// ───────── DOM 오버레이: 이름표/말풍선/뜨는 글자 (ui/overlay.ts) ─────────
export type BubbleKind = 'say' | 'npc' | 'shout' | 'think'
export interface OverlayApi {
  /** 매 프레임(렌더 뒤) 호출: 이름표/말풍선 위치 갱신 */
  update(): void
  /** 캐릭터 머리 위 말풍선 */
  bubble(key: number, text: string, ms?: number, kind?: BubbleKind): void
  /** 월드 좌표에서 떠오르는 글자("신도 +1") */
  pop(x: number, y: number, z: number, text: string, kind?: 'good' | 'bad' | 'gold' | 'info'): void
}

// ───────── 효과음 (audio/sfx.ts) ─────────
export type SfxName =
  | 'click'
  | 'open'
  | 'close'
  | 'talk'
  | 'pick'
  | 'join'
  | 'more'
  | 'fail'
  | 'flee'
  | 'ignore'
  | 'rank'
  | 'ach'
  | 'coin'
  | 'item'
  | 'invite'
  | 'accept'
  | 'decline'
  | 'prophecy'
  | 'chant'
  | 'sermonEnd'
  | 'battleStart'
  | 'win'
  | 'lose'
  | 'whistle'
  | 'caught'
  | 'sprint'
  | 'emote'
  | 'pop'
  | 'error'
  | 'joinRoom'
  | 'leaveRoom'

export interface SfxApi {
  /** 첫 사용자 입력에서 호출해 오디오를 깨운다(iOS) */
  unlock(): void
  play(name: SfxName, volume?: number): void
  setEnabled(on: boolean): void
  /** 배경음(절차 생성 루프) 켜기/끄기 */
  setMusic(on: boolean): void
}

// ───────── 입력 (input/*.ts) ─────────
export interface InputApi {
  /** 이동 입력. 화면 기준: x = 오른쪽(+), y = 앞(화면 위쪽, +). 길이 0..1 */
  readonly moveX: number
  readonly moveY: number
  /** 달리기(Shift / 조이스틱 끝까지 / 달리기 토글) */
  readonly run: boolean
  /** 누적된 카메라 회전(라디안)·줌 변화량을 읽고 0으로 되돌린다 */
  consumeCamera(): { yaw: number; pitch: number; zoom: number }
  /** 지면 탭(클릭) 좌표를 읽고 비운다. 없으면 null */
  consumeTap(): { clientX: number; clientY: number } | null
  update(dt: number): void
}

// ───────── 네트워크 (net/client.ts) ─────────
export interface NetApi {
  /** 방에 접속. 'auto' 면 서버가 여유 있는 방을 고른다 */
  connect(roomId: string): void
  /** 의도적 종료(자동 재접속 안 함) */
  disconnect(): void
  /** JSON 메시지 전송(연결 안 됐으면 버림). 보냈으면 true */
  send(msg: ClientMsg): boolean
  /** 내 위치 전송(빈도 제한은 호출하는 쪽 책임) */
  sendMove(x: number, z: number, yaw: number, st: number): void
  /** 매 프레임: 원격 플레이어/NPC 보간 위치를 store 의 view 에 써 넣는다 */
  update(): void
  /** 방 목록을 HTTP 로 새로 받아 store.rooms 갱신 */
  refreshRooms(): Promise<void>
}

// ───────── UI 도구 (ui/kit.ts) ─────────
export interface ContextAction {
  id: string
  label: string
  icon: string
  /** 가장 눈에 띄게 표시 */
  primary?: boolean
  /** 쿨타임 종료 시각(performance.now 기준 ms). 지나기 전에는 비활성 */
  readyAt?: number
  disabled?: boolean
  onClick(): void
}
export type ContextProvider = () => ContextAction | ContextAction[] | null | undefined

export interface MenuItem {
  id: string
  icon: string
  label: string
  /** 정렬 순서(작을수록 앞) */
  order?: number
  /** 알림 배지 숫자/점 */
  badge?: () => number | boolean
  onClick(): void
}

export interface PanelDef {
  id: string
  title: string
  /** 패널이 열릴 때 내용 DOM 을 만든다. 닫힐 때 호출될 정리 함수를 돌려줄 수 있다 */
  render(body: HTMLElement, close: () => void): void | (() => void)
  /** 넓은 패널 */
  wide?: boolean
}

export interface UiApi {
  /** UI 최상위 레이어(#ui) */
  readonly root: HTMLElement
  toast(text: string, kind?: 'info' | 'good' | 'bad' | 'gold', ms?: number): void
  registerPanel(def: PanelDef): void
  openPanel(id: string): void
  closePanel(): void
  readonly openPanelId: string | null
  /** 메뉴(☰)에 항목 추가 */
  addMenuItem(item: MenuItem): void
  readonly menuItems: readonly MenuItem[]
  /** 상황 버튼 제공자 등록. store.near 가 바뀌거나 refreshContext() 호출 시 다시 평가된다 */
  addContextProvider(p: ContextProvider): void
  readonly contextProviders: readonly ContextProvider[]
  refreshContext(): void
  /** 확인 대화상자 */
  confirm(text: string, okLabel?: string, cancelLabel?: string): Promise<boolean>
}

// ───────── 게임 동작 (game/actions.ts) ─────────
export interface Actions {
  /** 타이틀에서 입장 */
  enter(roomId: string): void
  /** 방 옮기기 */
  switchRoom(roomId: string): void
  /** 타이틀로 나가기 */
  exitToTitle(): void
  setName(name: string): void
  setLook(look: Look): void
  emote(id: string): void
  say(quickId: number): void
  talk(npcId: number): void
  pitch(lineId: number): void
  endTalk(): void
  /** 도망가기(스프린트). 쿨타임이면 false */
  sprint(): boolean
  /** 지정한 지점으로 자동 이동(탭 이동) */
  moveTo(x: number, z: number): void
}

/** 모든 모듈에 주입되는 앱 컨텍스트 */
export interface AppContext {
  readonly store: Store
  readonly bus: Bus
  readonly net: NetApi
  readonly engine: EngineApi
  readonly chars: CharacterRendererApi
  readonly fx: FxApi
  readonly overlay: OverlayApi
  readonly sfx: SfxApi
  readonly input: InputApi
  readonly actions: Actions
  readonly ui: UiApi
}
