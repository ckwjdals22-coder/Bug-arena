/**
 * 효과음 그래프 모음. 이름마다 `SoundFn` 하나 — 전부 오실레이터/노이즈 합성이며 음원 파일은 없다.
 *
 * 톤: 귀엽고 우스꽝스럽게. 길이는 1.2초 이하(승급 팡파르 `rank` 만 2초 이하).
 * `SOUNDS` 가 `Record<SfxName, SoundFn>` 이라 `SfxName` 에 이름이 늘면 컴파일이 깨져서 빠뜨릴 수 없다.
 */
import type { SfxName } from '../core/contracts'
import { bell, hold, lfo, midi, mkFilter, mkGain, mkNoise, mkOsc, noiseHit, perc, tone, type Partials, type SoundFn } from './synth'

// ───────── 악기 조각 ─────────

/** 맑은 실로폰/글로켄슈필 */
const GLOCK: Partials = { r: [1, 2.76, 5.4], a: [1, 0.3, 0.12], d: [1, 0.5, 0.25], floor: 0.01 }
/** 초인종·안내 방송 차임 */
const CHIME: Partials = { r: [1, 2, 3, 4.2], a: [1, 0.35, 0.12, 0.06], d: [1, 0.7, 0.4, 0.25], floor: 0.02 }
/** 권투 링의 쨍한 종 */
const RING_BELL: Partials = { r: [1, 2, 2.76, 4.07, 5.43], a: [1, 0.55, 0.5, 0.28, 0.16], d: [1, 0.8, 0.6, 0.45, 0.3], floor: 0.03 }
/**
 * 징: 배음이 어긋나 있어 "웅—" 하고 퍼진다.
 * 휴대폰 스피커는 300 Hz 아래를 거의 못 내므로, 기음보다 위쪽 배음에 힘을 실어 작은 스피커에서도 울림이 들리게 한다.
 */
const GONG: Partials = { r: [1, 1.48, 2.02, 2.71, 3.56, 4.33], a: [1, 0.85, 0.75, 0.6, 0.42, 0.3], d: [1, 0.95, 0.85, 0.7, 0.55, 0.42], floor: 0.04 }

interface BrassOpts {
  /** 끝 음정(뒤쪽 3/4 구간에서 미끄러진다) */
  to?: number
  /** 비브라토 속도(Hz). 뒤로 갈수록 깊어진다 */
  vib?: number
  /** 필터가 열리는 정도(기음의 배수). 클수록 쨍하다 */
  bright?: number
}

/** 금관: 살짝 어긋난 톱니파 둘 + 음마다 열렸다 닫히는 로우패스("와" 하는 입 모양) */
function brass(ctx: BaseAudioContext, dest: AudioNode, t: number, dur: number, freq: number, gain: number, o?: BrassOpts): void {
  const out = mkGain(ctx, dest, 0)
  hold(out.gain, t, gain, 0.025, dur, Math.min(0.09, dur * 0.35))
  const bright = o?.bright ?? 4.5
  const lp = mkFilter(ctx, out, 'lowpass', freq * 1.5, 1.6)
  lp.frequency.setValueAtTime(freq * 1.5, t)
  lp.frequency.linearRampToValueAtTime(freq * bright, t + 0.05)
  lp.frequency.linearRampToValueAtTime(freq * bright * 0.6, t + dur)
  const stop = t + dur + 0.01
  const a = mkOsc(ctx, lp, 'sawtooth', freq, t, stop)
  const b = mkOsc(ctx, lp, 'sawtooth', freq * 1.006, t, stop)
  if (o?.to !== undefined) {
    const ratio = o.to / freq
    for (const osc of [a, b]) {
      const f = osc.frequency.value
      osc.frequency.setValueAtTime(f, t + dur * 0.25)
      osc.frequency.exponentialRampToValueAtTime(f * ratio, t + dur)
    }
  }
  if (o?.vib !== undefined) {
    const depth = lfo(ctx, a.frequency, t, stop, o.vib, 0)
    depth.connect(b.frequency)
    depth.gain.setValueAtTime(0, t + dur * 0.2)
    depth.gain.linearRampToValueAtTime(freq * 0.03, t + dur)
  }
}

/** 목소리 흉내: 톱니파를 두 개의 포먼트(밴드패스)에 통과시킨다. f0 는 f0 → f0End 로 흐른다 */
function vowel(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  dur: number,
  f0: number,
  f0End: number,
  formant1: number,
  formant2: number,
  gain: number,
): void {
  const out = mkGain(ctx, dest, 0)
  hold(out.gain, t, gain, 0.015, dur, Math.min(0.06, dur * 0.4))
  const b1 = mkFilter(ctx, out, 'bandpass', formant1, 4)
  const g2 = mkGain(ctx, out, 0.6)
  const b2 = mkFilter(ctx, g2, 'bandpass', formant2, 7)
  const osc = mkOsc(ctx, b1, 'sawtooth', f0, t, t + dur + 0.01)
  osc.connect(b2)
  osc.frequency.setValueAtTime(f0, t)
  osc.frequency.exponentialRampToValueAtTime(f0End, t + dur)
}

/** 호루라기 한 번: 가까운 두 음 + 구슬이 만드는 떨림 + 바람 소리 */
function whistleBlast(ctx: BaseAudioContext, dest: AudioNode, t: number, dur: number): void {
  const out = mkGain(ctx, dest, 0)
  hold(out.gain, t, 1, 0.008, dur, 0.035)
  const stop = t + dur + 0.01
  const trem = mkGain(ctx, out, 0.7)
  const o1 = mkOsc(ctx, trem, 'sine', 2950, t, stop)
  const o2 = mkOsc(ctx, trem, 'sine', 3090, t, stop)
  // 구슬이 구멍을 막았다 열었다 하므로 크기와 음정이 같은 박자로 흔들린다
  lfo(ctx, trem.gain, t, stop, 31, 0.28)
  const wobble = lfo(ctx, o1.frequency, t, stop, 31, 90)
  wobble.connect(o2.frequency)
  const breath = mkGain(ctx, out, 0.3)
  const bp = mkFilter(ctx, breath, 'bandpass', 3000, 3)
  mkNoise(ctx, bp, t, stop, 0.4)
}

/** 박수 소리의 크기 곡선: 불규칙한 간격으로 "짝" 하고 솟았다 꺼지는 뾰족한 산들 */
function clapTrain(p: AudioParam, t: number, dur: number, seed: number): void {
  // 고정 시드 난수: 들을 때마다 같은 박수(오프라인 측정도 재현 가능)
  let s = seed
  const rnd = (): number => {
    // 32비트 정수 곱(Math.imul)이라야 자릿수가 넘쳐도 뭉개지지 않는 온전한 LCG 가 된다
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  p.setValueAtTime(0.0001, t)
  let tc = t + rnd() * 0.03
  const end = t + dur - 0.04
  while (tc < end) {
    p.setValueAtTime(0.02, tc)
    p.linearRampToValueAtTime(0.45 + rnd() * 0.55, tc + 0.002)
    p.exponentialRampToValueAtTime(0.03, tc + 0.028)
    tc += 0.034 + rnd() * 0.04
  }
}

// ───────── UI 소리(아주 짧게) ─────────

/** 버튼: 떨어지는 '톡' */
const click: SoundFn = (ctx, dest, t) => {
  tone(ctx, dest, t, 0.045, 1500, 0.5, { type: 'triangle', to: 950 })
  noiseHit(ctx, dest, t, 0.01, 0.1, 'bandpass', 3500, { q: 1.2 })
  return 0.05
}

/** 패널 열기: 올라가는 '뽀록' 두 방울 */
const open: SoundFn = (ctx, dest, t) => {
  tone(ctx, dest, t, 0.09, 520, 0.45, { to: 780 })
  tone(ctx, dest, t + 0.075, 0.12, 780, 0.45, { to: 1175 })
  return 0.2
}

/** 패널 닫기: 내려앉는 '뚭' */
const close: SoundFn = (ctx, dest, t) => {
  tone(ctx, dest, t, 0.12, 620, 0.5, { to: 330, glide: 0.08 })
  noiseHit(ctx, dest, t + 0.045, 0.05, 0.3, 'lowpass', 600)
  return 0.13
}

/** 작은 알림/말풍선: 물방울 '뽁' — 빠르게 치솟는 사인 하나면 충분하다 */
const pop: SoundFn = (ctx, dest, t) => {
  tone(ctx, dest, t, 0.06, 320, 0.6, { to: 1200, glide: 0.035, attack: 0.002 })
  return 0.07
}

/** 이모트: 올라갔다 살짝 내려오는 '뾱' */
const emote: SoundFn = (ctx, dest, t) => {
  const osc = tone(ctx, dest, t, 0.11, 740, 0.45, { type: 'triangle', to: 1480, glide: 0.045, attack: 0.005 })
  osc.frequency.exponentialRampToValueAtTime(1100, t + 0.1)
  return 0.12
}

/** 오류: 부드러운 버저 '뿝뿝' */
const error: SoundFn = (ctx, dest, t) => {
  // 기음(150 Hz 언저리)은 휴대폰 스피커에서 안 들리므로 배음이 1 kHz 까지는 남게 둔다
  const lp = mkFilter(ctx, dest, 'lowpass', 1100, 0.8)
  for (const dt of [0, 0.14]) {
    tone(ctx, lp, t + dt, 0.1, 146, 0.4, { type: 'square', attack: 0.006, release: 0.02 })
    tone(ctx, lp, t + dt, 0.1, 155, 0.3, { type: 'sawtooth', attack: 0.006, release: 0.02 })
  }
  return 0.26
}

// ───────── 포교 ─────────

/** 말 걸기: 헛기침 '어흠' */
const talk: SoundFn = (ctx, dest, t) => {
  vowel(ctx, dest, t, 0.09, 185, 165, 620, 1050, 0.6)
  noiseHit(ctx, dest, t + 0.115, 0.04, 0.12, 'bandpass', 1600, { q: 1.2 })
  vowel(ctx, dest, t + 0.13, 0.17, 150, 122, 330, 950, 0.7)
  return 0.31
}

/** 멘트 고르기: 카드를 '착' 튕기는 소리 */
const pick: SoundFn = (ctx, dest, t) => {
  noiseHit(ctx, dest, t, 0.055, 0.5, 'bandpass', 2200, { to: 7000, q: 1.6, attack: 0.003 })
  tone(ctx, dest, t + 0.004, 0.03, 1900, 0.18, { type: 'triangle', to: 2700 })
  return 0.065
}

/** 합류: 우스꽝스럽게 치솟는 아르페지오 + 반짝이 '뾰로롱' */
const join: SoundFn = (ctx, dest, t) => {
  const lp = mkFilter(ctx, dest, 'lowpass', 4200)
  const notes = [72, 76, 79, 84, 88]
  for (let i = 0; i < notes.length; i++) {
    const f = midi(notes[i])
    const at = t + i * 0.065
    const last = i === notes.length - 1
    // 음마다 아래에서 휙 끌어올려 '뾰' 하는 느낌을 낸다
    const osc = tone(ctx, lp, at, last ? 0.26 : 0.1, f * 0.84, 0.22, { type: 'square', to: f, glide: 0.03 })
    if (last) lfo(ctx, osc.frequency, at + 0.05, at + 0.27, 14, f * 0.02)
  }
  const sparkle = [103, 100, 107, 105]
  for (let i = 0; i < sparkle.length; i++) {
    tone(ctx, dest, t + 0.36 + i * 0.055, 0.16, midi(sparkle[i]), 0.12)
  }
  return 0.72
}

/** '더 들어볼게요': 갸웃하며 올라가는 두 음 '흠?' */
const more: SoundFn = (ctx, dest, t) => {
  const lp = mkFilter(ctx, dest, 'lowpass', 1100, 1.2)
  tone(ctx, lp, t, 0.11, 294, 0.5, { type: 'triangle', attack: 0.012, release: 0.04 })
  tone(ctx, lp, t, 0.11, 294, 0.1, { type: 'sawtooth', attack: 0.012, release: 0.04 })
  tone(ctx, lp, t + 0.15, 0.25, 330, 0.5, { type: 'triangle', to: 494, glide: 0.2, attack: 0.012, release: 0.07 })
  tone(ctx, lp, t + 0.15, 0.25, 330, 0.1, { type: 'sawtooth', to: 494, glide: 0.2, attack: 0.012, release: 0.07 })
  return 0.42
}

/** 거절: 슬픈 트롬본 '뿌 뿌 뿌우…' */
const fail: SoundFn = (ctx, dest, t) => {
  brass(ctx, dest, t, 0.2, 233.1, 0.5)
  brass(ctx, dest, t + 0.22, 0.2, 220, 0.5)
  brass(ctx, dest, t + 0.44, 0.68, 207.7, 0.55, { to: 164.8, vib: 5.5 })
  return 1.14
}

/** 도망: 슬라이드 휘슬 + 점점 빨라지는 발소리 */
const flee: SoundFn = (ctx, dest, t) => {
  const osc = tone(ctx, dest, t, 0.42, 560, 0.4, { to: 2500, glide: 0.38, attack: 0.02, release: 0.06 })
  lfo(ctx, osc.frequency, t, t + 0.43, 7, 18)
  tone(ctx, dest, t, 0.42, 1120, 0.07, { to: 5000, glide: 0.38, attack: 0.02, release: 0.06 })
  noiseHit(ctx, dest, t, 0.42, 0.05, 'bandpass', 1500, { to: 5000, q: 2, attack: 0.03, release: 0.08 })
  let at = t + 0.04
  let gap = 0.075
  for (let i = 0; i < 7; i++) {
    noiseHit(ctx, dest, at, 0.022, 0.3, 'bandpass', i % 2 ? 1300 : 1900, { q: 2.5, offset: i * 0.11 })
    at += gap
    gap *= 0.88
  }
  return 0.5
}

/** 무시: 어색한 침묵 속 귀뚜라미 '찌륵 찌륵' */
const ignore: SoundFn = (ctx, dest, t) => {
  const g = mkGain(ctx, dest, 0)
  const stop = t + 0.36
  mkOsc(ctx, g, 'sine', 4300, t, stop)
  mkOsc(ctx, mkGain(ctx, g, 0.6), 'sine', 4480, t, stop)
  g.gain.setValueAtTime(0, t)
  // 한 번 울 때 날개를 네 번 비빈다 × 두 번
  for (let chirp = 0; chirp < 2; chirp++) {
    for (let i = 0; i < 4; i++) {
      const at = t + chirp * 0.2 + i * 0.034
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(chirp ? 0.3 : 0.4, at + 0.005)
      g.gain.linearRampToValueAtTime(0, at + 0.024)
    }
  }
  return 0.36
}

// ───────── 성장/보상 ─────────

/** 승급: 팡파르 '따 따 따 단— 따 단——' */
const rank: SoundFn = (ctx, dest, t) => {
  for (let i = 0; i < 3; i++) {
    brass(ctx, dest, t + i * 0.13, 0.1, midi(67), 0.4, { bright: 6 })
    brass(ctx, dest, t + i * 0.13, 0.1, midi(64), 0.25)
  }
  brass(ctx, dest, t + 0.39, 0.28, midi(72), 0.45, { bright: 6 })
  brass(ctx, dest, t + 0.39, 0.28, midi(67), 0.28)
  brass(ctx, dest, t + 0.7, 0.13, midi(76), 0.42, { bright: 6 })
  const tf = t + 0.85
  const df = 0.95
  brass(ctx, dest, tf, df, midi(79), 0.42, { bright: 6, vib: 6 })
  brass(ctx, dest, tf, df, midi(76), 0.3)
  brass(ctx, dest, tf, df, midi(72), 0.3)
  brass(ctx, dest, tf, df, midi(48), 0.3)
  // 마지막 화음에 심벌과 반짝이를 얹는다
  noiseHit(ctx, dest, tf, 0.7, 0.18, 'highpass', 6000, { attack: 0.004 })
  const sparkle = [96, 100, 103, 108]
  for (let i = 0; i < sparkle.length; i++) {
    tone(ctx, dest, tf + 0.1 + i * 0.07, 0.25, midi(sparkle[i]), 0.06)
  }
  return 1.85
}

/** 업적: 글로켄슈필이 또르르 올라가 '팅!' */
const ach: SoundFn = (ctx, dest, t) => {
  const roll = [83, 88, 92, 95]
  for (let i = 0; i < roll.length; i++) {
    bell(ctx, dest, t + i * 0.055, midi(roll[i]), 0.5, 0.3, GLOCK)
  }
  bell(ctx, dest, t + 0.27, midi(100), 0.62, 0.35, GLOCK)
  return 0.9
}

/** 가상 코인: 두 음 '띠링' */
const coin: SoundFn = (ctx, dest, t) => {
  const lp = mkFilter(ctx, dest, 'lowpass', 6500)
  tone(ctx, lp, t, 0.075, 987.8, 0.3, { type: 'square', release: 0.01 })
  tone(ctx, lp, t + 0.075, 0.38, 1318.5, 0.3, { type: 'square' })
  tone(ctx, dest, t + 0.075, 0.3, 2637, 0.08)
  return 0.46
}

/** 헌납품: '뽁' 튀어나와 '뿅' 떠오른다 */
const item: SoundFn = (ctx, dest, t) => {
  tone(ctx, dest, t, 0.05, 260, 0.55, { to: 1000, glide: 0.03 })
  tone(ctx, dest, t + 0.06, 0.17, 700, 0.35, { type: 'triangle', to: 1500, glide: 0.11 })
  tone(ctx, dest, t + 0.17, 0.11, 3136, 0.12)
  return 0.28
}

// ───────── 사람 사이 ─────────

/** 초대 도착: 초인종 '딩—동' */
const invite: SoundFn = (ctx, dest, t) => {
  bell(ctx, dest, t, 659.3, 0.6, 0.4, CHIME)
  bell(ctx, dest, t + 0.34, 523.3, 0.64, 0.4, CHIME)
  return 0.98
}

/** 수락: 가볍게 올라가는 '도미솔' */
const accept: SoundFn = (ctx, dest, t) => {
  tone(ctx, dest, t, 0.08, 523.3, 0.4, { type: 'triangle' })
  tone(ctx, dest, t + 0.07, 0.08, 659.3, 0.4, { type: 'triangle' })
  tone(ctx, dest, t + 0.14, 0.2, 784, 0.45, { type: 'triangle' })
  tone(ctx, dest, t + 0.14, 0.2, 1568, 0.12)
  return 0.34
}

/** 거절: 삐딱하게 떨어지는 두 음 '뚜—둥' */
const decline: SoundFn = (ctx, dest, t) => {
  const lp = mkFilter(ctx, dest, 'lowpass', 1300, 0.8)
  tone(ctx, lp, t, 0.13, 440, 0.4, { type: 'square', attack: 0.008, release: 0.03 })
  tone(ctx, lp, t + 0.15, 0.22, 311.1, 0.4, { type: 'square', attack: 0.008, release: 0.08 })
  return 0.37
}

/** 방 입장: 문 열림 차임(올라감) */
const joinRoom: SoundFn = (ctx, dest, t) => {
  const notes = [79, 83, 86]
  for (let i = 0; i < notes.length; i++) {
    bell(ctx, dest, t + i * 0.14, midi(notes[i]), i === 2 ? 0.5 : 0.36, 0.35, CHIME)
  }
  return 0.8
}

/** 방 퇴장: 문 닫힘 차임(내려감) */
const leaveRoom: SoundFn = (ctx, dest, t) => {
  bell(ctx, dest, t, midi(86), 0.32, 0.35, CHIME)
  bell(ctx, dest, t + 0.18, midi(79), 0.45, 0.35, CHIME)
  return 0.65
}

// ───────── 단상/설교/배틀 ─────────

/** 오늘의 계시: 징 + 일렁이는 고음 */
const prophecy: SoundFn = (ctx, dest, t) => {
  // 징은 친 직후 음이 살짝 부풀어 오른다 → 배음마다 아래에서 올라오게 한다
  for (let i = 0; i < GONG.r.length; i++) {
    const f = 185 * GONG.r[i]
    tone(ctx, dest, t, 1.15 * GONG.d[i], f * 0.985, 0.5 * GONG.a[i], { attack: 0.006, to: f, glide: 0.25, floor: GONG.floor })
  }
  // 채가 닿는 순간: 둔탁한 '둥' + 금속판이 떠는 '촤아'
  noiseHit(ctx, dest, t, 0.09, 0.4, 'lowpass', 450)
  noiseHit(ctx, dest, t, 0.4, 0.14, 'bandpass', 2800, { to: 1300, q: 0.8, offset: 0.5 })
  // 살짝 어긋난 사인 쌍이 맥놀이로 일렁인다
  const shimmer = [2093, 2637, 3136]
  for (let i = 0; i < shimmer.length; i++) {
    const at = t + 0.12 + i * 0.09
    const dur = 0.95 - i * 0.09
    tone(ctx, dest, at, dur, shimmer[i], 0.035, { attack: 0.18 })
    tone(ctx, dest, at, dur, shimmer[i] + 7 + i * 2, 0.035, { attack: 0.18 })
  }
  return 1.18
}

/** 구호 응답: 여럿이 외치는 '헤이!' — 톱니파 여러 개와 노이즈를 모음 포먼트에 통과시킨다 */
const chant: SoundFn = (ctx, dest, t) => {
  const dur = 0.34
  const stop = t + dur + 0.01
  const out = mkGain(ctx, dest, 0)
  hold(out.gain, t, 1, 0.02, dur, 0.14)
  // '에' → '이' 로 입 모양이 바뀐다
  const f1 = mkFilter(ctx, out, 'bandpass', 620, 4)
  f1.frequency.setValueAtTime(620, t + 0.08)
  f1.frequency.linearRampToValueAtTime(420, t + dur)
  const f2 = mkFilter(ctx, mkGain(ctx, out, 0.7), 'bandpass', 1850, 6)
  f2.frequency.setValueAtTime(1850, t + 0.08)
  f2.frequency.linearRampToValueAtTime(2250, t + dur)
  // 음높이가 제각각인 목소리들. 외칠 때처럼 높게 시작해 떨어진다
  for (const f of [139, 185, 233, 277]) {
    const osc = mkOsc(ctx, f1, 'sawtooth', f * 1.06, t, stop)
    osc.connect(f2)
    osc.frequency.setValueAtTime(f * 1.06, t)
    osc.frequency.exponentialRampToValueAtTime(f * 0.94, t + dur)
  }
  const breath = mkGain(ctx, f2, 0.6)
  breath.connect(f1)
  mkNoise(ctx, breath, t, stop, 0.7)
  // 발 구르기
  noiseHit(ctx, dest, t, 0.06, 0.5, 'lowpass', 260)
  return 0.38
}

/** 설교 끝: 박수갈채 + 휘파람 */
const sermonEnd: SoundFn = (ctx, dest, t) => {
  const dur = 1.12
  const stop = t + dur + 0.01
  // 넓은 밴드패스만으로는 고음 잡음이 많이 남아 "치익" 소리가 된다 → 위를 덜어 손바닥 소리의 몸통을 살린다
  const out = mkGain(ctx, mkFilter(ctx, dest, 'lowpass', 6500), 0)
  out.gain.setValueAtTime(0, t)
  out.gain.linearRampToValueAtTime(1, t + 0.1)
  out.gain.setValueAtTime(1, t + 0.55)
  out.gain.linearRampToValueAtTime(0, t + dur)
  // 노이즈 하나를 세 대역으로 갈라 대역마다 다른 박자로 "짝짝" 연다 → 여러 사람이 치는 것처럼 들린다
  const bands: readonly (readonly [number, number, number])[] = [
    [1000, 0.9, 0x51ab],
    [2100, 1.1, 0x9e37],
    [3400, 1.3, 0x17c5],
  ]
  const filters: BiquadFilterNode[] = []
  for (const [freq, q, seed] of bands) {
    const g = mkGain(ctx, out, 0)
    filters.push(mkFilter(ctx, g, 'bandpass', freq, q))
    clapTrain(g.gain, t, dur, seed)
  }
  const src = mkNoise(ctx, filters[0], t, stop)
  for (let i = 1; i < filters.length; i++) src.connect(filters[i])
  tone(ctx, dest, t + 0.28, 0.3, 1700, 0.06, { to: 2900, glide: 0.2, attack: 0.03, release: 0.08 })
  return 1.15
}

/** 배틀 시작: 권투 종 '땡땡!' */
const battleStart: SoundFn = (ctx, dest, t) => {
  const strikes: readonly (readonly [number, number, number])[] = [
    [0, 0.5, 0.8],
    [0.17, 0.82, 1],
  ]
  for (const [dt, dur, g] of strikes) {
    bell(ctx, dest, t + dt, 835, dur, 0.3 * g, RING_BELL)
    noiseHit(ctx, dest, t + dt, 0.012, 0.3, 'bandpass', 3200, { q: 1 })
  }
  return 1.0
}

/** 배틀 승리: '따라라라 단!' */
const win: SoundFn = (ctx, dest, t) => {
  const lp = mkFilter(ctx, dest, 'lowpass', 5000)
  const run = [76, 79, 84, 88]
  for (let i = 0; i < run.length; i++) {
    tone(ctx, lp, t + i * 0.09, 0.085, midi(run[i]), 0.22, { type: 'square', release: 0.015 })
    tone(ctx, dest, t + i * 0.09, 0.085, midi(run[i] - 12), 0.2, { type: 'triangle', release: 0.015 })
  }
  const tf = t + 0.44
  for (const n of [84, 88, 91]) {
    const osc = tone(ctx, lp, tf, 0.5, midi(n), 0.16, { type: 'square', attack: 0.008, release: 0.22 })
    lfo(ctx, osc.frequency, tf + 0.12, tf + 0.51, 7, midi(n) * 0.008)
  }
  tone(ctx, dest, tf, 0.5, midi(60), 0.22, { type: 'triangle', release: 0.22 })
  tone(ctx, dest, tf + 0.05, 0.3, midi(103), 0.07)
  return 0.96
}

/** 배틀 패배: 단조로 또박또박 내려와 '뿜' 하고 주저앉는다 */
const lose: SoundFn = (ctx, dest, t) => {
  const steps = [79, 75, 72, 67]
  for (let i = 0; i < steps.length; i++) {
    tone(ctx, dest, t + i * 0.17, 0.2, midi(steps[i]), 0.4, { type: 'triangle' })
  }
  // 낮은 사인/삼각파는 휴대폰 스피커에서 안 들린다 → 배음이 있는 금관으로 마무리
  brass(ctx, dest, t + 0.68, 0.3, 131, 0.5, { to: 98, bright: 5 })
  return 1.0
}

// ───────── 단속반/이동 ─────────

/** 단속반 호루라기: '삑! 삐익—' */
const whistle: SoundFn = (ctx, dest, t) => {
  whistleBlast(ctx, dest, t, 0.11)
  whistleBlast(ctx, dest, t + 0.16, 0.44)
  return 0.62
}

/** 잡힘: 용수철 '띠요옹' */
const caught: SoundFn = (ctx, dest, t) => {
  const dur = 0.78
  const stop = t + dur + 0.01
  const out = mkGain(ctx, dest, 0)
  perc(out.gain, t, 0.6, 0.006, dur, 0.03)
  const body = mkOsc(ctx, out, 'triangle', 900, t, stop)
  // 삼각파만으로는 작은 스피커에서 묻힌다 → 로우패스를 건 사각파를 겹쳐 배음을 준다
  const buzz = mkOsc(ctx, mkFilter(ctx, mkGain(ctx, out, 0.35), 'lowpass', 2200, 2), 'square', 900, t, stop)
  // 용수철 떨림: 처음엔 크고 빠르게, 갈수록 잦아든다
  const depth = mkGain(ctx, body.frequency, 0)
  depth.connect(buzz.frequency)
  depth.gain.setValueAtTime(0, t)
  depth.gain.linearRampToValueAtTime(110, t + 0.1)
  depth.gain.exponentialRampToValueAtTime(4, t + dur)
  const wobble = mkOsc(ctx, depth, 'sine', 13, t, stop)
  wobble.frequency.setValueAtTime(13, t)
  wobble.frequency.linearRampToValueAtTime(7, t + dur)
  for (const osc of [body, buzz]) {
    // 튕겨 나가며 음이 뚝 떨어진 뒤 천천히 가라앉는다
    osc.frequency.setValueAtTime(900, t)
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.09)
    osc.frequency.exponentialRampToValueAtTime(215, t + dur)
  }
  noiseHit(ctx, dest, t, 0.03, 0.3, 'bandpass', 900, { q: 1 })
  return 0.8
}

/** 도망가기(스프린트): 바람 가르는 '슈욱' */
const sprint: SoundFn = (ctx, dest, t) => {
  const dur = 0.4
  const g = mkGain(ctx, dest, 0)
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.9, t + 0.15)
  g.gain.linearRampToValueAtTime(0, t + dur)
  const bp = mkFilter(ctx, g, 'bandpass', 450, 1.3)
  bp.frequency.setValueAtTime(450, t)
  bp.frequency.exponentialRampToValueAtTime(3200, t + 0.17)
  bp.frequency.exponentialRampToValueAtTime(1100, t + dur)
  mkNoise(ctx, bp, t, t + dur + 0.01, 0.2)
  return 0.42
}

// ───────── 등록부 ─────────

export const SOUNDS: Record<SfxName, SoundFn> = {
  click,
  open,
  close,
  talk,
  pick,
  join,
  more,
  fail,
  flee,
  ignore,
  rank,
  ach,
  coin,
  item,
  invite,
  accept,
  decline,
  prophecy,
  chant,
  sermonEnd,
  battleStart,
  win,
  lose,
  whistle,
  caught,
  sprint,
  emote,
  pop,
  error,
  joinRoom,
  leaveRoom,
}

export const SFX_NAMES = Object.keys(SOUNDS) as SfxName[]

/** 길이 상한(초). 승급 팡파르만 길게 허용한다 */
export function maxDuration(name: SfxName): number {
  return name === 'rank' ? 2 : 1.2
}

// ───────── 음량 ─────────

/**
 * 마스터 출력에서의 목표 피크(dBFS). 가장 큰 소리가 −10 dBFS.
 * 자주 나는 UI 소리는 작게, 드물고 기쁜 순간은 크게 — 피크가 같아도 길고 꽉 찬 소리가 더 크게 들리므로 그만큼 낮춘다.
 * 귀가 가장 예민한 3~4 kHz 대의 소리(귀뚜라미, 호루라기)도 같은 이유로 낮게 잡았다.
 */
export const TARGET_DB: Record<SfxName, number> = {
  click: -19,
  open: -18,
  close: -18,
  pop: -18,
  emote: -18,
  pick: -17,
  error: -17,
  talk: -15,
  more: -17,
  ignore: -19,
  decline: -17,
  sprint: -15,
  join: -11,
  fail: -12,
  flee: -15,
  ach: -11,
  coin: -12,
  item: -13,
  invite: -12,
  accept: -13,
  chant: -12,
  sermonEnd: -13,
  whistle: -16,
  caught: -12,
  joinRoom: -13,
  leaveRoom: -14,
  lose: -12,
  win: -11,
  rank: -10,
  prophecy: -10,
  battleStart: -10,
}

/**
 * 게인 1 로 그렸을 때의 피크(마스터 체인 없이 오프라인 렌더로 잰 값).
 * 소리 그래프를 고치면 개발 페이지(/dev/sfx.html)의 [음량 보정값 재기] 로 다시 재서 붙여 넣는다.
 * 같은 페이지의 자동 검증이 "실제 피크 = 목표 ±1 dB" 를 확인하므로 낡은 값은 카드가 빨갛게 되어 바로 드러난다.
 */
export const DRY_PEAK: Record<SfxName, number> = {
  click: 0.4634,
  open: 0.445,
  close: 0.4819,
  talk: 0.2673,
  pick: 0.2393,
  join: 0.2618,
  more: 0.541,
  fail: 1.1096,
  flee: 0.4903,
  ignore: 0.6253,
  rank: 1.7613,
  ach: 0.5982,
  coin: 0.4362,
  item: 0.5162,
  invite: 0.5175,
  accept: 0.4462,
  decline: 0.4753,
  prophecy: 1.3755,
  chant: 0.7867,
  sermonEnd: 0.7644,
  battleStart: 0.6953,
  win: 0.7555,
  lose: 1.0482,
  whistle: 1.9836,
  caught: 0.8608,
  sprint: 0.6181,
  emote: 0.4295,
  pop: 0.5795,
  error: 0.7057,
  joinRoom: 0.4979,
  leaveRoom: 0.4572,
}

/** 발음 게인: 소리를 목표 피크에 맞춘다 */
export function soundGain(name: SfxName): number {
  return Math.pow(10, TARGET_DB[name] / 20) / DRY_PEAK[name]
}

/**
 * 소리 하나를 발음 게인까지 포함해 그린다(실시간 엔진과 오프라인 렌더가 함께 쓴다).
 * 돌려주는 게인 노드는 호출한 쪽이 끊어야 한다.
 */
export function renderSound(ctx: BaseAudioContext, dest: AudioNode, name: SfxName, t0: number, volume: number): { gain: GainNode; level: number; duration: number } {
  const level = soundGain(name) * volume
  const gain = ctx.createGain()
  gain.gain.value = level
  gain.connect(dest)
  try {
    return { gain, level, duration: SOUNDS[name](ctx, gain, t0) }
  } catch (e) {
    // 그리다 실패하면 빈 게인이 버스에 매달려 남지 않게 한다
    gain.disconnect()
    throw e
  }
}
