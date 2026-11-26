/**
 * 배경음: 절차 생성 루프(음원 파일 없음).
 *
 * 느리고 살짝 수상한 단조 5음계 뜯는 소리 + 낮게 깔리는 패드. 8마디(64스텝 × 0.4초 = 25.6초)가 돈다.
 * 음은 미리 내다보는 타이머(look-ahead)로 오디오 시계에 예약한다 — ScriptProcessor/워크릿을 쓰지 않아
 * 메인 스레드가 하는 일은 0.25초마다 "곧 울릴 음 몇 개 예약"뿐이고, 동시에 살아 있는 노드는 많아야 50개 안팎이다
 * (같은 방식으로 예약하며 오프라인 렌더해 잰 부하: 코어 하나의 1~1.5%).
 *
 * 그래프 만들기/스텝 예약은 `BaseAudioContext` 만 쓰는 순수 함수라 오프라인 렌더로도 그대로 검증할 수 있다.
 */
import { capture, midi, mkGain, mkOsc, release, stopAll, tone, type Capture } from './synth'

/** 8분음표 한 스텝의 길이(초). 75 BPM */
export const MUSIC_STEP_S = 0.4
/** 한 바퀴의 스텝 수(8마디) */
export const MUSIC_STEPS = 64

/** 마스터 출력에서의 목표 피크(dBFS). 효과음(−19…−10) 밑에 깔리도록 낮게 */
const MUSIC_TARGET_DB = -18
/** 출력 게인 1 로 한 바퀴를 오프라인 렌더했을 때의 피크. 패턴/음색을 고치면 개발 페이지에서 다시 잰다 */
export const MUSIC_DRY_PEAK = 0.6696
/** 다 켜졌을 때의 배경음 출력 게인 */
export const MUSIC_LEVEL = Math.pow(10, MUSIC_TARGET_DB / 20) / MUSIC_DRY_PEAK

// ───────── 악보 ─────────
// D 단조 5음계(레 파 솔 라 도)만 쓴다: 어느 음이 겹쳐도 어울리고, 반음이 없어 떠 있는 듯한 느낌이 난다.

/** [스텝, MIDI 음, 세기 0..1, 길이(초), 긴 음을 흔들지(1)] */
type Note = readonly [step: number, note: number, vel: number, len: number, bend?: 1]

const MELODY: readonly Note[] = [
  // 1–2마디
  [0, 62, 0.9, 2.0],
  [3, 69, 0.6, 1.2],
  [4, 72, 0.75, 1.6],
  [6, 69, 0.5, 1.2],
  [8, 67, 0.8, 1.6],
  [11, 65, 0.55, 1.2],
  [12, 62, 0.7, 2.4, 1],
  // 3–4마디
  [16, 65, 0.8, 1.6],
  [19, 67, 0.55, 1.2],
  [20, 69, 0.7, 1.4],
  [22, 72, 0.55, 1.2],
  [24, 74, 0.85, 2.6, 1],
  [28, 72, 0.5, 1.2],
  [30, 69, 0.5, 1.4],
  // 5–6마디
  [32, 69, 0.8, 1.6],
  [35, 72, 0.55, 1.2],
  [36, 77, 0.8, 2.0, 1],
  [38, 74, 0.5, 1.2],
  [40, 72, 0.75, 1.6],
  [43, 69, 0.5, 1.2],
  [44, 67, 0.7, 2.4, 1],
  // 7–8마디: 낮은 레로 가라앉으며 처음으로 돌아간다
  [48, 65, 0.75, 1.4],
  [50, 67, 0.55, 1.2],
  [51, 69, 0.6, 1.4],
  [54, 67, 0.5, 1.2],
  [56, 65, 0.7, 1.4],
  [59, 62, 0.6, 1.6],
  [60, 50, 0.8, 2.8],
  [62, 57, 0.45, 1.6],
]

/** 멀리서 "띵" 하고 울리는 높은 음: [스텝, MIDI 음] */
const PINGS: readonly (readonly [number, number])[] = [
  [14, 86],
  [30, 93],
  [46, 89],
]

/** 패드 화음 하나가 깔리는 스텝 수(2마디) */
const PAD_STEPS = 16
/** 패드가 들어오고 나가는 시간(초). 앞뒤 화음이 이만큼 겹치며 바뀐다 */
const PAD_FADE_S = 2.4
/** 2마디마다 바뀌는 패드 화음(근음, 5도, 색채음) */
const PAD_CHORDS: readonly (readonly number[])[] = [
  [50, 57, 65],
  [55, 62, 60],
  [53, 60, 69],
  [48, 55, 62],
]

// ───────── 그래프 ─────────

export interface MusicGraph {
  /** 전체 출력 게인(페이드 인/아웃) */
  readonly out: GainNode
  /** 뜯는 소리가 들어가는 곳(로우패스 + 메아리) */
  readonly pluck: AudioNode
  /** 패드가 들어가는 곳(어두운 로우패스) */
  readonly pad: AudioNode
  dispose(): void
}

export function buildMusicGraph(ctx: BaseAudioContext, dest: AudioNode): MusicGraph {
  const out = ctx.createGain()
  out.gain.value = 0
  out.connect(dest)

  const pluck = ctx.createBiquadFilter()
  pluck.type = 'lowpass'
  pluck.frequency.value = 2600
  pluck.Q.value = 0.5
  pluck.connect(out)

  // 점8분 메아리: 되돌아올 때마다 어두워지며 멀어진다 → 텅 빈 골목 같은 공간감
  const delay = ctx.createDelay(1)
  delay.delayTime.value = MUSIC_STEP_S * 1.5
  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 1500
  const feedback = ctx.createGain()
  feedback.gain.value = 0.36
  const wet = ctx.createGain()
  wet.gain.value = 0.45
  pluck.connect(delay)
  delay.connect(damp)
  damp.connect(feedback)
  feedback.connect(delay)
  damp.connect(wet)
  wet.connect(out)

  const pad = ctx.createBiquadFilter()
  pad.type = 'lowpass'
  pad.frequency.value = 800
  pad.Q.value = 0.5
  pad.connect(out)

  const nodes: AudioNode[] = [out, pluck, delay, damp, feedback, wet, pad]
  return {
    out,
    pluck,
    pad,
    dispose() {
      for (const n of nodes) {
        try {
          n.disconnect()
        } catch {
          /* 이미 끊긴 노드 */
        }
      }
    },
  }
}

// ───────── 음 하나하나 ─────────

function pluckNote(ctx: BaseAudioContext, g: MusicGraph, t: number, note: number, vel: number, len: number, bend: boolean): void {
  const f = midi(note)
  // 줄을 뜯은 직후에는 살짝 높았다가 제 음으로 내려앉는다
  const osc = tone(ctx, g.pluck, t, len, f * 1.012, 0.5 * vel, { type: 'triangle', to: f, glide: 0.07, attack: 0.005 })
  if (bend) {
    // 긴 음은 줄을 눌러 흔들듯 천천히 떤다. LFO 노드를 따로 두지 않고 램프 몇 개로 끝낸다
    const p = osc.frequency
    p.setValueAtTime(f, t + 0.35)
    p.linearRampToValueAtTime(f * 1.014, t + 0.5)
    p.linearRampToValueAtTime(f * 0.992, t + 0.7)
    p.linearRampToValueAtTime(f * 1.009, t + 0.9)
    p.linearRampToValueAtTime(f, t + 1.1)
  }
  // 뜯는 순간에만 스치는 밝은 배음
  tone(ctx, g.pluck, t, len * 0.25, f * 2, 0.16 * vel, { attack: 0.003 })
}

function padChord(ctx: BaseAudioContext, g: MusicGraph, t: number, chord: readonly number[]): void {
  const dur = PAD_STEPS * MUSIC_STEP_S + PAD_FADE_S
  const stop = t + dur + 0.02
  const env = mkGain(ctx, g.pad, 0)
  env.gain.setValueAtTime(0, t)
  env.gain.linearRampToValueAtTime(1, t + PAD_FADE_S)
  env.gain.setValueAtTime(1, t + dur - PAD_FADE_S)
  env.gain.linearRampToValueAtTime(0, t + dur)
  for (let i = 0; i < chord.length; i++) {
    const f = midi(chord[i])
    // 패드는 가락 밑에 깔리기만 한다(뜯는 소리보다 작게)
    const level = i === 2 ? 0.04 : 0.07
    mkOsc(ctx, mkGain(ctx, env, level), 'sine', f, t, stop)
    // 아주 조금 어긋난 한 겹을 더해 천천히 일렁이게 한다(색채음은 한 겹이면 충분)
    if (i < 2) mkOsc(ctx, mkGain(ctx, env, level * 0.7), 'triangle', f * 1.004, t, stop)
  }
}

/** step 번째 스텝의 뜯는 음/띵 소리를 t 에 예약 */
export function scheduleNotes(ctx: BaseAudioContext, g: MusicGraph, step: number, t: number): void {
  for (const n of MELODY) {
    if (n[0] === step) pluckNote(ctx, g, t, n[1], n[2], n[3], n[4] === 1)
  }
  for (const p of PINGS) {
    if (p[0] === step) tone(ctx, g.pluck, t, 1.6, midi(p[1]), 0.07, { attack: 0.01 })
  }
}

/** step 이 화음이 바뀌는 자리면 패드를 t 에 예약 */
export function schedulePad(ctx: BaseAudioContext, g: MusicGraph, step: number, t: number): void {
  if (step % PAD_STEPS === 0) padChord(ctx, g, t, PAD_CHORDS[(step / PAD_STEPS) % PAD_CHORDS.length])
}

/** 한 스텝 전체(오프라인 렌더용) */
export function scheduleMusicStep(ctx: BaseAudioContext, g: MusicGraph, step: number, t: number): void {
  scheduleNotes(ctx, g, step, t)
  schedulePad(ctx, g, step, t)
}

// ───────── 실시간 재생기 ─────────

export interface Music {
  /** 켜면 처음부터 페이드 인, 끄면 페이드 아웃 후 그래프를 치운다 */
  setOn(on: boolean): void
  /** 오디오가 실제로 흐르는 동안만 true(탭 숨김/컨텍스트 정지 중에는 예약을 쉰다) */
  setRunning(run: boolean): void
  /** 살아 있는 음원 노드 묶음 수(개발용) */
  readonly active: number
}

/** 예약 타이머 주기(ms) */
const TICK_MS = 250
/** 이만큼 앞까지 미리 예약한다. 타이머가 조금 밀려도 음이 끊기지 않게 주기보다 넉넉히 */
const LOOKAHEAD_S = 1.0
/** 페이드 인 시정수(초): 2.4초쯤에 95% */
const FADE_IN_TC = 0.8
/** 페이드 아웃 시정수(초): 1.5초쯤이면 −60 dB */
const FADE_OUT_TC = 0.22
/** 끈 뒤 남은 음원을 멈추는 시점(초) */
const STOP_AFTER_S = 1.6

interface Session {
  readonly graph: MusicGraph
  readonly caps: Set<Capture>
  step: number
  /** 다음 스텝이 울릴 오디오 시각 */
  next: number
}

export function createMusic(ctx: AudioContext, dest: AudioNode): Music {
  let session: Session | null = null
  let timer = 0

  function track(s: Session, cap: Capture): void {
    const last = cap.last
    if (!last) return
    s.caps.add(cap)
    last.onended = () => {
      s.caps.delete(cap)
      release(cap)
    }
  }

  function tick(): void {
    const s = session
    if (!s) return
    try {
      const now = ctx.currentTime
      // 타이머가 오래 멈췄다 돌아오면(탭 전환, 긴 프레임) 밀린 음을 한꺼번에 쏟지 않고 지금부터 다시 센다
      if (s.next < now) s.next = now + 0.05
      while (s.next < now + LOOKAHEAD_S) {
        const { step, next } = s
        track(s, capture(() => scheduleNotes(ctx, s.graph, step, next))[0])
        // 패드는 9초 가까이 살아 있으므로 따로 묶는다(짧은 음의 노드가 그때까지 붙들려 있지 않게)
        track(s, capture(() => schedulePad(ctx, s.graph, step, next))[0])
        s.step = (step + 1) % MUSIC_STEPS
        s.next = next + MUSIC_STEP_S
      }
    } catch {
      /* 예약 실패는 다음 주기에 다시 시도한다 — 배경음 때문에 게임이 멈추면 안 된다 */
    }
  }

  function begin(): void {
    const graph = buildMusicGraph(ctx, dest)
    const now = ctx.currentTime
    graph.out.gain.setValueAtTime(0, now)
    graph.out.gain.setTargetAtTime(MUSIC_LEVEL, now, FADE_IN_TC)
    session = { graph, caps: new Set(), step: 0, next: now + 0.15 }
  }

  function end(s: Session): void {
    const now = ctx.currentTime
    // 페이드 인 도중에 꺼도 지금 값에서 이어서 내려간다(딱 끊기는 소리 없음)
    s.graph.out.gain.setTargetAtTime(0, now, FADE_OUT_TC)
    for (const cap of s.caps) stopAll(cap, now + STOP_AFTER_S)
    // 컨텍스트가 멈춰 있어도(탭 숨김) 타이머는 도니까 그래프는 반드시 치워진다
    window.setTimeout(
      () => {
        for (const cap of s.caps) release(cap)
        s.caps.clear()
        s.graph.dispose()
      },
      (STOP_AFTER_S + 0.2) * 1000,
    )
  }

  function stopTimer(): void {
    if (timer) {
      window.clearInterval(timer)
      timer = 0
    }
  }

  return {
    setOn(on) {
      if (on) {
        if (!session) begin()
      } else if (session) {
        stopTimer()
        const s = session
        session = null
        end(s)
      }
    },
    setRunning(run) {
      if (run && session) {
        if (!timer) {
          timer = window.setInterval(tick, TICK_MS)
          tick()
        }
      } else {
        stopTimer()
      }
    },
    get active() {
      return session ? session.caps.size : 0
    },
  }
}
