/**
 * 효과음 엔진: WebAudio 합성(음원 파일 없음).
 *
 * - `AudioContext` 는 첫 사용자 입력 때 비로소 만든다(자동재생 정책 + 소리를 끈 사람에게는 비용 0).
 * - `play()` 는 어떤 경우에도 예외를 던지지 않고, 소리가 흐를 수 없는 상태(입력 전, 꺼짐, 탭 숨김,
 *   WebAudio 없음)에서는 아무 일도 하지 않는다 — 밀린 소리가 나중에 한꺼번에 터지지 않게 쌓아 두지도 않는다.
 *   (유일한 예외: 입력으로 컨텍스트를 깨우는 0.4초 동안의 소리는 받아 두었다가 켜지는 순간 울린다.)
 * - 동시 발음은 8개까지(넘치면 가장 오래된 것을 짧게 페이드해 끊는다), 같은 이름은 60ms 에 한 번만.
 * - `setEnabled` 는 효과음만, `setMusic` 은 배경음만 끄고 켠다(설정의 두 스위치와 1:1). 둘 다 꺼지면 컨텍스트를 재운다.
 * - 탭이 숨겨지면 컨텍스트를 멈추고, 돌아오면 다시 깨운다. iOS 의 'interrupted' 상태도 다음 입력에서 풀린다.
 * - 소리 그래프는 sounds.ts, 마스터 체인은 master.ts, 배경음은 music.ts.
 */
import type { SfxApi, SfxName } from '../core/contracts'
import { createMaster, type Master } from './master'
import { createMusic, type Music } from './music'
import { renderSound, SOUNDS } from './sounds'
import { capture, release, stopAll, type Capture } from './synth'

/** 동시에 울릴 수 있는 발음 수 */
const MAX_VOICES = 8
/** 같은 이름의 소리 사이 최소 간격(ms): 한 프레임에 같은 이벤트가 몰려도 한 번만 울린다 */
const RATE_LIMIT_MS = 60
/** 예약 여유(초): 지금 시각에 딱 맞추면 어택 앞머리가 잘릴 수 있다 */
const START_DELAY_S = 0.005
/**
 * 컨텍스트가 생긴 직후 비워 두는 시간(초). 컴프레서는 막 만들어졌을 때 이득이 눌려 있다가 올라오므로
 * (0초에 울리면 −13 dB, 0.1초면 −0.5 dB) 맨 앞은 피한다. 길게 잡으면 첫 '톡' 이 늦게 들려서 조금만 둔다.
 */
const WARMUP_S = 0.03
/** 발음을 끊을 때의 페이드(초): 뚝 끊기는 소리 방지 */
const KILL_FADE_S = 0.015
/**
 * 입력으로 컨텍스트를 깨운 직후, 아직 'running' 이 아니어도 소리를 받아 두는 시간(ms).
 * 컨텍스트는 입력 뒤 수십 ms 가 지나야 돌기 시작하는데, 그 사이에 난 "첫 버튼의 톡" 을 버리면 첫인상이 먹먹하다.
 */
const WAKE_GRACE_MS = 400
/** 받아 둔 소리가 이보다 오래 기다렸으면(컨텍스트가 끝내 안 켜졌던 경우) 뒤늦게 울리지 않고 버린다 */
const STALE_MS = 600
/** 효과음·배경음이 모두 꺼진 뒤 컨텍스트를 재울 때까지의 여유(ms): 배경음 페이드 아웃이 끝나도록 */
const SLEEP_AFTER_MS = 2000

interface Voice {
  readonly gain: GainNode
  readonly cap: Capture
  readonly level: number
  /** 만들어진 시각(performance.now) */
  readonly born: number
  /** 컨텍스트가 돌기 전에 받아 둔 소리(아직 한 표본도 나가지 않았다) */
  queued: boolean
  /** 이 오디오 시각이 지나면 ended 이벤트가 없었어도 치운다 */
  end: number
  /** 강제 종료 중(자리 계산에서 빠진다) */
  dying: boolean
  done: boolean
}

/** 개발 페이지/검증 스크립트용 내부 상태 */
export interface SfxDebug {
  /** 'none' = 아직 컨텍스트를 만들지 않음 */
  state: string
  /** 지금 울리는 발음 수 */
  voices: number
  /** 지금까지 시작한 발음 수 */
  started: number
  /** 자리가 없어 끊긴 발음 수 */
  dropped: number
  /** 간격 제한에 걸려 건너뛴 횟수 */
  limited: number
  enabled: boolean
  music: boolean
  /** 배경음이 붙들고 있는 음원 묶음 수 */
  musicActive: number
  sampleRate: number
}

export interface SfxEngine extends SfxApi {
  debug(): SfxDebug
}

type ContextCtor = typeof AudioContext

function contextCtor(): ContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

function noop(): void {}

export function createSfx(): SfxApi {
  return createSfxEngine()
}

export function createSfxEngine(): SfxEngine {
  const Ctor = contextCtor()

  let ctx: AudioContext | null = null
  let master: Master | null = null
  let music: Music | null = null
  let enabled = true
  let musicOn = false
  /** 사용자 입력을 한 번이라도 봤는가(그 전에는 컨텍스트를 만들지 않는다) */
  let gesture = false
  /** 무음 버퍼를 한 번 틀어 두었는가(구형 iOS 잠금 해제) */
  let primed = false
  /** 컨텍스트 생성 실패 횟수: 몇 번 해 보고 안 되면 조용히 포기한다 */
  let failures = 0
  /** 마지막으로 입력 안에서 깨우기를 요청한 시각(performance.now) */
  let wakeAt = -Infinity
  let sleepTimer = 0

  const voices: Voice[] = []
  const lastAt = new Map<SfxName, number>()
  let started = 0
  let dropped = 0
  let limited = 0

  function hidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  /** 효과음이든 배경음이든 하나라도 켜져 있어야 오디오 장치를 붙든다 */
  function wanted(): boolean {
    return enabled || musicOn
  }

  function ensure(): AudioContext | null {
    if (ctx) {
      if (ctx.state !== 'closed') return ctx
      // 브라우저가 컨텍스트를 닫아 버렸다(오디오 장치 소실 등): 버리고 새로 만든다
      ctx.removeEventListener('statechange', onState)
      try {
        music?.setOn(false)
      } catch {
        /* 닫힌 컨텍스트에는 예약이 안 될 수 있다 — 어차피 버릴 그래프다 */
      }
      voices.length = 0
      ctx = null
      master = null
      music = null
      primed = false
    }
    if (!Ctor || failures >= 3) return null
    try {
      const c = new Ctor({ latencyHint: 'interactive' })
      master = createMaster(c)
      c.addEventListener('statechange', onState)
      ctx = c
    } catch {
      failures++
      ctx = null
      master = null
    }
    return ctx
  }

  function resume(c: AudioContext): void {
    try {
      // 입력 밖에서 부르면 거절되거나 영영 대기할 수 있다 → 결과에 기대지 않고, 다음 입력 때 다시 시도한다
      void c.resume().then(syncMusic, noop)
    } catch {
      /* 구형 구현 */
    }
  }

  /** iOS 구형 사파리는 입력 안에서 소스를 한 번 start 해야 소리가 풀린다 */
  function prime(c: AudioContext): void {
    try {
      const src = c.createBufferSource()
      src.buffer = c.createBuffer(1, 1, c.sampleRate)
      src.connect(c.destination)
      src.onended = () => src.disconnect()
      src.start(0)
      primed = true
    } catch {
      /* 못 풀어도 다음 입력에서 다시 시도 */
    }
  }

  /** 소리가 흘러야 하는 상황이면 컨텍스트를 만들고/깨운다 */
  function wake(): void {
    if (!gesture || !wanted() || hidden()) return
    const c = ensure()
    if (!c) return
    if (sleepTimer) {
      window.clearTimeout(sleepTimer)
      sleepTimer = 0
    }
    // 'suspended' 뿐 아니라 iOS 의 'interrupted'(전화·시리·다른 앱 소리) 에서도 다시 깨운다
    if (c.state !== 'running' && c.state !== 'closed') resume(c)
    if (!primed) prime(c)
    syncMusic()
  }

  function suspend(c: AudioContext): void {
    try {
      void c.suspend().catch(noop)
    } catch {
      /* 구형 구현 */
    }
  }

  /** 둘 다 꺼졌으면 잠시 뒤 컨텍스트를 재워 배터리를 아낀다 */
  function sleepSoon(): void {
    if (sleepTimer || !ctx) return
    sleepTimer = window.setTimeout(() => {
      sleepTimer = 0
      const c = ctx
      if (c && !wanted() && c.state === 'running') suspend(c)
    }, SLEEP_AFTER_MS)
  }

  function syncMusic(): void {
    const c = ctx
    if (!c || !master) return
    if (!music) {
      if (!musicOn) return
      music = createMusic(c, master.music)
    }
    music.setOn(musicOn)
    music.setRunning(musicOn && c.state === 'running' && !hidden())
  }

  function onState(): void {
    const c = ctx
    if (!c) return
    syncMusic()
    if (c.state === 'running') {
      settleQueued()
      if (!wanted()) sleepSoon()
    } else if (c.state !== 'closed' && gesture && wanted() && !hidden()) {
      // 우리가 재운 게 아닌데 멈췄다(iOS 인터럽트 등): 일단 깨워 보고, 입력이 필요하면 다음 입력에서 풀린다
      resume(c)
    }
  }

  function onVisibility(): void {
    if (hidden()) {
      const c = ctx
      syncMusic()
      if (c && c.state === 'running') {
        // 돌아왔을 때 끊겼던 효과음 꼬리가 뒤늦게 들리지 않게 먼저 정리한다
        killAll(c.currentTime)
        suspend(c)
      }
    } else {
      wake()
    }
  }

  function onGesture(e: Event): void {
    // 터치의 pointerdown 과 Esc 는 브라우저가 '사용자 활성화'로 쳐주지 않는다.
    // 거기서 컨텍스트를 만들면 경고만 남고 어차피 다음 입력(pointerup)에서 풀린다
    if (e.type === 'pointerdown' && (e as PointerEvent).pointerType !== 'mouse') return
    if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') return
    unlock()
  }

  // ───────── 발음 관리 ─────────

  function finish(v: Voice): void {
    if (v.done) return
    v.done = true
    const i = voices.indexOf(v)
    if (i >= 0) voices.splice(i, 1)
    try {
      v.gain.disconnect()
    } catch {
      /* 이미 끊김 */
    }
    release(v.cap)
  }

  /** 발음 하나를 끊는다. voices 배열에서 빠질 수 있으므로, 배열을 도는 중이라면 뒤에서부터 돌 것 */
  function kill(v: Voice, now: number): void {
    if (v.dying || v.done) return
    if (v.queued) {
      // 아직 한 표본도 나가지 않았으니 페이드할 것 없이 바로 치운다
      stopAll(v.cap, 0)
      finish(v)
      return
    }
    v.dying = true
    try {
      const g = v.gain.gain
      g.setValueAtTime(v.level, now)
      g.linearRampToValueAtTime(0, now + KILL_FADE_S)
    } catch {
      /* 페이드를 못 걸어도 아래에서 소스는 멈춘다 */
    }
    stopAll(v.cap, now + KILL_FADE_S + 0.005)
    v.end = now + KILL_FADE_S + 0.1
  }

  function killAll(now: number): void {
    for (let i = voices.length - 1; i >= 0; i--) kill(voices[i], now)
  }

  /** ended 이벤트를 못 받은 발음(컨텍스트 중단 등)도 시간이 지나면 치운다 */
  function reap(now: number): void {
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].end <= now) finish(voices[i])
    }
  }

  /** 컨텍스트가 돌기 시작했다: 받아 둔 소리 중 너무 오래 기다린 것은 버리고 나머지는 보통 발음으로 돌린다 */
  function settleQueued(): void {
    const nowMs = performance.now()
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i]
      if (!v.queued) continue
      if (nowMs - v.born > STALE_MS) kill(v, 0)
      else v.queued = false
    }
  }

  function liveCount(): number {
    let n = 0
    for (const v of voices) if (!v.dying) n++
    return n
  }

  function oldestLive(): Voice | null {
    for (const v of voices) if (!v.dying) return v
    return null
  }

  // ───────── 공개 API ─────────

  function unlock(): void {
    gesture = true
    const c = ctx
    if (c && c.state === 'running' && primed) return
    wakeAt = performance.now()
    wake()
  }

  function play(name: SfxName, volume = 1): void {
    try {
      const c = ctx
      const m = master
      if (!enabled || !c || !m) return
      const nowMs = performance.now()
      const running = c.state === 'running'
      // 돌고 있지 않으면 원칙적으로 버린다. 단, 방금 입력으로 깨우는 중이라면 받아 둔다:
      // 멈춘 컨텍스트는 시계도 멈춰 있어서, 예약해 두면 켜지는 순간 바로 울린다.
      if (!running && !(c.state === 'suspended' && nowMs - wakeAt < WAKE_GRACE_MS && !hidden())) return
      // 타입 밖의 이름이 넘어와도(구버전 서버 메시지 등) 조용히 무시한다
      if (!Object.prototype.hasOwnProperty.call(SOUNDS, name)) return
      const vol = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 1) : 1
      if (vol <= 0) return

      const last = lastAt.get(name)
      if (last !== undefined && nowMs - last < RATE_LIMIT_MS) {
        limited++
        return
      }
      lastAt.set(name, nowMs)

      const now = c.currentTime
      reap(now)
      while (liveCount() >= MAX_VOICES) {
        const old = oldestLive()
        if (!old) break
        kill(old, now)
        dropped++
      }

      const t0 = Math.max(now + START_DELAY_S, WARMUP_S)
      const [cap, r] = capture(() => renderSound(c, m.sfx, name, t0, vol))
      const v: Voice = { gain: r.gain, cap, level: r.level, born: nowMs, queued: !running, end: t0 + r.duration + 0.1, dying: false, done: false }
      voices.push(v)
      started++
      if (cap.last) cap.last.onended = () => finish(v)
    } catch {
      /* 소리 때문에 게임이 멈추면 안 된다 */
    }
  }

  function setEnabled(on: boolean): void {
    enabled = !!on
    if (enabled) {
      wake()
    } else {
      const c = ctx
      if (c) killAll(c.currentTime)
      if (!wanted()) sleepSoon()
    }
  }

  function setMusic(on: boolean): void {
    musicOn = !!on
    // 설정을 켜는 순간이 곧 사용자 입력이므로 여기서 바로 깨울 수 있다(입력 전이라면 첫 입력 때 시작된다)
    if (musicOn) wake()
    syncMusic()
    if (!wanted()) sleepSoon()
  }

  function debug(): SfxDebug {
    return {
      state: ctx ? ctx.state : 'none',
      voices: liveCount(),
      started,
      dropped,
      limited,
      enabled,
      music: musicOn,
      musicActive: music ? music.active : 0,
      sampleRate: ctx ? ctx.sampleRate : 0,
    }
  }

  if (Ctor && typeof window !== 'undefined' && typeof document !== 'undefined') {
    // main 이 unlock() 을 한 번만 부르더라도, iOS 에서 인터럽트 뒤에는 "새 입력 안에서" 다시 resume 해야
    // 소리가 돌아온다 → 엔진이 직접 입력을 지켜본다. 컨텍스트가 이미 돌고 있으면 비교 두 번으로 끝나는 가벼운 핸들러다.
    const opts: AddEventListenerOptions = { capture: true, passive: true }
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click']) {
      window.addEventListener(type, onGesture, opts)
    }
    document.addEventListener('visibilitychange', onVisibility)
  }

  return { unlock, play, setEnabled, setMusic, debug }
}
