/**
 * 타입이 붙은 이벤트 버스. 모듈 간 결합을 줄이는 유일한 통로다.
 *  - bus.on('near', fn)      : 클라이언트 내부 이벤트
 *  - bus.onMsg('invited', fn): 서버가 보낸 JSON 메시지(종류별) — net 모듈이 수신 즉시 emitMsg 한다
 */
import type { ServerMsg, ServerMsgOf, ServerMsgType } from '../../../shared/protocol'
import type { Progress, RoomInfo } from '../../../shared/types'
import type { NearState, Phase, TalkState } from './store'

export interface BusEvents {
  /** 화면 단계 전환 */
  phase: Phase
  /** 방 입장 완료(welcome 처리 후, store 가 채워진 상태) */
  entered: void
  /**
   * 끊겼다가 다시 들어왔다(첫 입장이 아니다). same = 서버가 같은 번호·같은 자리로 이어 붙여 줬는가,
   * lost = 끊긴 사이 사라진 것(진행 중이던 배틀·설교·대화), idle = 자리를 오래 비워 내보내졌다 돌아온 것인가
   */
  resumed: { same: boolean; lost: ('battle' | 'sermon' | 'talk')[]; idle: boolean }
  /** 가려던 방이 가득 차서 서버가 다른 방으로 안내했다(from = 가려던 방 id, to = 들어온 방 id) */
  redirected: { from: string; to: string }
  /** 다른 플레이어 입장/퇴장/공개 정보 변경 (store 반영 후) */
  playerJoin: number
  playerLeave: number
  playerUpdate: number
  /** NPC 등장(교체)/공개 정보 변경 */
  npcSpawn: number
  npcUpdate: number
  /** 가까운 상호작용 대상이 바뀜 */
  near: NearState
  /** 대화 세션 시작/갱신/종료 */
  talk: TalkState | null
  /** 내 진행도가 바뀜(저장 포함) */
  progress: Progress
  /** 내 직급이 오름 */
  rankUp: number
  /** 방 목록 갱신 */
  rooms: RoomInfo[]
  /** 방 인원 변동(HUD 표시용) */
  population: { players: number; npcs: number }
  /** 네트워크 상태 */
  net: { rtt: number; connected: boolean }
  /** 설정 변경 */
  settings: void
  /** 내 프로필(닉네임/외형) 변경 */
  profile: void
  /** 화면 크기/방향 변경 */
  resize: void
}

type Handler<T> = (payload: T) => void

export class Bus {
  private handlers = new Map<string, Set<Handler<never>>>()

  on<K extends keyof BusEvents>(type: K, fn: Handler<BusEvents[K]>): () => void {
    return this.add(type, fn as Handler<never>)
  }

  emit<K extends keyof BusEvents>(type: K, ...payload: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
    this.fire(type, payload[0])
  }

  /** 서버 메시지 구독 */
  onMsg<T extends ServerMsgType>(type: T, fn: Handler<ServerMsgOf<T>>): () => void {
    return this.add('msg:' + type, fn as Handler<never>)
  }

  /** net 모듈이 서버 메시지를 받을 때마다 호출(자체 store 반영을 끝낸 뒤) */
  emitMsg(msg: ServerMsg): void {
    this.fire('msg:' + msg.t, msg)
  }

  private add(key: string, fn: Handler<never>): () => void {
    let set = this.handlers.get(key)
    if (!set) {
      set = new Set()
      this.handlers.set(key, set)
    }
    set.add(fn)
    return () => set!.delete(fn)
  }

  private fire(key: string, payload: unknown): void {
    const set = this.handlers.get(key)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as Handler<unknown>)(payload)
      } catch (err) {
        console.error(`[bus] handler error for "${key}"`, err)
      }
    }
  }
}
