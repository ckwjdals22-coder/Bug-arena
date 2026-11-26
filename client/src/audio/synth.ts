/**
 * 합성 도우미: 오실레이터·노이즈·필터·엔벨로프를 짧게 쓰기 위한 얇은 층.
 *
 * 모든 함수는 `BaseAudioContext` 만 받는다 → 같은 그래프가 실시간(`AudioContext`)과
 * 오프라인 렌더(`OfflineAudioContext`, 스피커 없이 검증할 때) 양쪽에서 똑같이 돈다.
 */

/** 소리 하나를 그리는 함수: ctx 에 노드를 만들어 dest 로 잇고 t0 부터 울리게 예약한 뒤, 길이(초)를 돌려준다 */
export type SoundFn = (ctx: BaseAudioContext, dest: AudioNode, t0: number) => number

// ───────── 노드 추적(끝나면 끊기 위해) ─────────

/** 한 번의 발음(또는 배경음 한 스텝)이 만든 노드 묶음 */
export interface Capture {
  readonly sources: AudioScheduledSourceNode[]
  readonly nodes: AudioNode[]
  /** 가장 늦게 멈추는 소스 — 이 소스의 ended 가 곧 묶음 전체의 끝이다 */
  last: AudioScheduledSourceNode | null
  lastStop: number
}

// SoundFn 시그니처에 추적기를 끼워 넣을 자리가 없어서, 동기 실행 구간 동안만 모듈 변수로 둔다.
// (JS 는 단일 스레드이고 SoundFn 은 동기 함수라 서로 섞일 일이 없다)
let active: Capture | null = null

/**
 * fn 이 도우미로 만든 모든 노드를 기록해 fn 의 결과와 함께 돌려준다. 엔진은 이것으로
 * "오래된 발음 강제 종료"와 "끝난 노드 연결 끊기"를 처리한다.
 */
export function capture<T>(fn: () => T): [cap: Capture, value: T] {
  const cap: Capture = { sources: [], nodes: [], last: null, lastStop: -1 }
  const prev = active
  active = cap
  try {
    return [cap, fn()]
  } catch (e) {
    // 그리다 만 노드가 그래프에 남지 않게 정리하고 다시 던진다
    stopAll(cap, 0)
    release(cap)
    throw e
  } finally {
    active = prev
  }
}

/** 묶음의 모든 소스를 at 시각에 멈춘다(이미 끝났거나 멈춘 소스는 무시) */
export function stopAll(cap: Capture, at: number): void {
  for (const s of cap.sources) {
    try {
      s.stop(at)
    } catch {
      /* 구형 브라우저는 이미 끝난 소스의 stop() 에 예외를 던진다 */
    }
  }
}

/** 묶음의 모든 노드 연결을 끊어 GC 가 가져가게 한다 */
export function release(cap: Capture): void {
  for (const n of cap.nodes) {
    try {
      n.disconnect()
    } catch {
      /* 이미 끊긴 노드 */
    }
  }
  if (cap.last) cap.last.onended = null
  cap.nodes.length = 0
  cap.sources.length = 0
  cap.last = null
}

function reg<T extends AudioNode>(node: T): T {
  if (active) active.nodes.push(node)
  return node
}

function regSource<T extends AudioScheduledSourceNode>(src: T, stop: number): T {
  const cap = active
  if (cap) {
    cap.nodes.push(src)
    cap.sources.push(src)
    if (stop > cap.lastStop) {
      cap.lastStop = stop
      cap.last = src
    }
  }
  return src
}

// ───────── 노드 만들기 ─────────

export type Dest = AudioNode | AudioParam

function link(node: AudioNode, dest: Dest): void {
  // connect 의 오버로드가 갈려 있어 타입별로 나눠 부른다
  if (dest instanceof AudioParam) node.connect(dest)
  else node.connect(dest)
}

export function mkGain(ctx: BaseAudioContext, dest: Dest, value: number): GainNode {
  const g = ctx.createGain()
  g.gain.value = value
  link(g, dest)
  return reg(g)
}

/**
 * 컨텍스트가 낼 수 있는 가장 높은 주파수(나이퀴스트 바로 아래).
 * 블루투스 통화 모드처럼 표본화 주파수가 낮은 기기에서 그 위를 넣으면 브라우저가 경고를 찍고 값을 깎는다.
 */
function maxFreq(ctx: BaseAudioContext): number {
  return ctx.sampleRate * 0.45
}

export function mkFilter(ctx: BaseAudioContext, dest: AudioNode, type: BiquadFilterType, freq: number, q = 0.7071): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = Math.min(freq, maxFreq(ctx))
  f.Q.value = q
  f.connect(dest)
  return reg(f)
}

export function mkOsc(ctx: BaseAudioContext, dest: Dest, type: OscillatorType, freq: number, start: number, stop: number): OscillatorNode {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = Math.min(freq, maxFreq(ctx))
  link(o, dest)
  o.start(start)
  o.stop(stop)
  return regSource(o, stop)
}

// 노이즈 버퍼는 컨텍스트마다 하나만 만들어 돌려쓴다(발음마다 새로 채우면 GC 가 바빠진다).
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()
const NOISE_SECONDS = 1.5
/**
 * 노이즈 버퍼의 표본화 주파수는 컨텍스트와 무관하게 고정한다(재생할 때 브라우저가 알아서 맞춘다).
 * 컨텍스트 주파수(기기마다 44.1/48 kHz)를 따라가면 같은 난수열이 다른 소리가 되어, 박수·바람 소리의 피크가 기기마다 2~3 dB 씩 달라진다.
 */
const NOISE_RATE = 44100

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx)
  if (buf) return buf
  const len = Math.floor(NOISE_RATE * NOISE_SECONDS)
  buf = ctx.createBuffer(1, len, NOISE_RATE)
  const d = buf.getChannelData(0)
  // 고정 시드 xorshift32: Math.random 대신 써서 오프라인 측정값이 매번 같게 나온다
  let s = 0x9e3779b9 | 0
  for (let i = 0; i < len; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    d[i] = (s >>> 0) / 2147483648 - 1
  }
  noiseCache.set(ctx, buf)
  return buf
}

/** 백색 노이즈 소스. offset(초)을 달리 주면 한 소리 안의 여러 노이즈 층이 서로 다른 구간을 읽는다 */
export function mkNoise(ctx: BaseAudioContext, dest: AudioNode, start: number, stop: number, offset = 0): AudioBufferSourceNode {
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx)
  src.loop = true
  src.connect(dest)
  src.start(start, offset % NOISE_SECONDS)
  src.stop(stop)
  return regSource(src, stop)
}

// ───────── 엔벨로프 ─────────

/**
 * 타악기형: attack 동안 치고 올라가 dur 끝까지 지수 감쇠.
 * floor 는 끝에서의 크기 비(기본 0.001 = −60 dB, 딱 끊어지는 소리). 종·징처럼 길게 울려야 하면 크게 준다.
 */
export function perc(p: AudioParam, t: number, peak: number, attack: number, dur: number, floor = 0.001): void {
  // 지수 램프는 0 으로 갈 수 없어 floor 까지만 내리고, 마지막 짧은 구간에 선형으로 0 까지 닫는다(딱 소리 방지)
  const fade = Math.min(0.02, dur * 0.2)
  // 아주 짧은 소리에 긴 어택을 줘도 예약 순서가 뒤집히지 않게 한다
  const a = Math.min(attack, (dur - fade) * 0.5)
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + a)
  p.exponentialRampToValueAtTime(Math.max(peak * floor, 1e-5), t + dur - fade)
  p.linearRampToValueAtTime(0, t + dur)
}

/** 유지형: attack → 유지 → 끝에서 release 동안 선형 페이드 */
export function hold(p: AudioParam, t: number, peak: number, attack: number, dur: number, release: number): void {
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + attack)
  p.setValueAtTime(peak, Math.max(t + attack, t + dur - release))
  p.linearRampToValueAtTime(0, t + dur)
}

// ───────── 자주 쓰는 조합 ─────────

export interface ToneOpts {
  type?: OscillatorType
  /** 끝 주파수(지수 글라이드). 없으면 고정 음정 */
  to?: number
  /** 글라이드에 걸리는 시간(기본: dur 전체) */
  glide?: number
  attack?: number
  /** 주면 유지형 엔벨로프(끝에서 release 초 페이드), 없으면 타악기형 */
  release?: number
  /** 타악기형일 때 끝에서의 크기 비(기본 0.001). 클수록 오래 울린다 */
  floor?: number
}

/** 오실레이터 하나 + 엔벨로프. 음정에 손을 더 대고 싶을 때를 위해 오실레이터를 돌려준다 */
export function tone(ctx: BaseAudioContext, dest: AudioNode, t: number, dur: number, freq: number, gain: number, o?: ToneOpts): OscillatorNode {
  const g = mkGain(ctx, dest, 0)
  const attack = o?.attack ?? 0.004
  if (o?.release !== undefined) hold(g.gain, t, gain, attack, dur, o.release)
  else perc(g.gain, t, gain, attack, dur, o?.floor)
  const osc = mkOsc(ctx, g, o?.type ?? 'sine', freq, t, t + dur + 0.01)
  if (o?.to !== undefined) {
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide ?? dur))
  }
  return osc
}

export interface NoiseOpts {
  /** 끝 필터 주파수(지수 스윕) */
  to?: number
  q?: number
  attack?: number
  /** 주면 유지형 엔벨로프 */
  release?: number
  /** 노이즈 버퍼를 읽기 시작할 위치(초) */
  offset?: number
}

/** 필터를 거친 노이즈 한 덩이(딸깍, 쉭, 박수 한 번 …) */
export function noiseHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  dur: number,
  gain: number,
  type: BiquadFilterType,
  freq: number,
  o?: NoiseOpts,
): BiquadFilterNode {
  const g = mkGain(ctx, dest, 0)
  const attack = o?.attack ?? 0.002
  if (o?.release !== undefined) hold(g.gain, t, gain, attack, dur, o.release)
  else perc(g.gain, t, gain, attack, dur)
  const f = mkFilter(ctx, g, type, freq, o?.q ?? 0.7071)
  if (o?.to !== undefined) {
    f.frequency.setValueAtTime(freq, t)
    f.frequency.exponentialRampToValueAtTime(o.to, t + dur)
  }
  mkNoise(ctx, f, t, t + dur + 0.01, o?.offset ?? 0)
  return f
}

/** 저주파 오실레이터로 target 을 흔든다(비브라토/트레몰로). 깊이를 움직일 수 있게 깊이 게인을 돌려준다 */
export function lfo(ctx: BaseAudioContext, target: AudioParam, start: number, stop: number, rate: number, depth: number): GainNode {
  const d = mkGain(ctx, target, depth)
  mkOsc(ctx, d, 'sine', rate, start, stop)
  return d
}

export interface Partials {
  /** 기음 대비 주파수 비 */
  readonly r: readonly number[]
  /** 배음별 크기 */
  readonly a: readonly number[]
  /** 배음별 길이 비(높은 배음일수록 빨리 사라져야 종처럼 들린다) */
  readonly d: readonly number[]
  /** 끝에서의 크기 비: 클수록 "댕—" 하고 오래 남는다 */
  readonly floor: number
}

/** 사인 배음 묶음으로 만드는 종/차임/글로켄슈필 계열 */
export function bell(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number, dur: number, gain: number, p: Partials): void {
  for (let i = 0; i < p.r.length; i++) {
    const f = freq * p.r[i]
    // 이 컨텍스트가 낼 수 없는 높은 배음은 만들지 않는다(엉뚱한 음으로 접혀 들리는 것 방지)
    if (f > maxFreq(ctx)) continue
    tone(ctx, dest, t, dur * p.d[i], f, gain * p.a[i], { attack: 0.003, floor: p.floor })
  }
}

/** MIDI 음 번호 → Hz (69 = A4 = 440) */
export function midi(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12)
}
