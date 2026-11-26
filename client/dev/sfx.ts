/**
 * 효과음 실험실(개발용): 이름마다 버튼 하나 + 배경음 토글.
 *
 * 스피커 없이도 검증할 수 있게, 실제 엔진과 같은 그래프(sounds.ts + master.ts)를 `OfflineAudioContext` 로
 * 렌더해 피크·RMS·스펙트럼 중심·크기 곡선을 재고, 카드마다 스펙트로그램을 그린다.
 * `window.__sfx` 로 같은 기능을 자동 검증 스크립트(Playwright)에 내준다.
 */
import type { SfxName } from '../src/core/contracts'
import { createMaster } from '../src/audio/master'
import { buildMusicGraph, MUSIC_DRY_PEAK, MUSIC_LEVEL, MUSIC_STEP_S, MUSIC_STEPS, scheduleMusicStep } from '../src/audio/music'
import { createSfxEngine, type SfxDebug } from '../src/audio/sfx'
import { DRY_PEAK, maxDuration, renderSound, SFX_NAMES, SOUNDS, TARGET_DB } from '../src/audio/sounds'

const SR = 44100
/** 효과음 하나를 렌더하는 길이(초): 가장 긴 소리(2초) + 꼬리 확인 여유 */
const RENDER_S = 2.4
/**
 * 소리를 울리기 전에 비워 두는 시간(초). 컴프레서는 갓 만들어진 직후 0.1~0.3초 동안 이득이 눌려 있다가
 * 올라오는데(0초에 울리면 −13 dB), 실제 게임에서는 컨텍스트가 한참 전부터 돌고 있으므로 그 구간을 건너뛰고 재야 실제와 같다.
 */
const LEAD_S = 0.5
const BUCKETS = 16

/** 사람이 읽는 설명(카드에 표시) */
const LABELS: Record<SfxName, string> = {
  click: '버튼 · 톡',
  open: '패널 열기 · 뽀록',
  close: '패널 닫기 · 뚭',
  talk: '말 걸기 · 어흠',
  pick: '멘트 고르기 · 착',
  join: '합류 · 뾰로롱',
  more: '더 들어볼게요 · 흠?',
  fail: '거절 · 뿌우…',
  flee: '도망 · 휘익 다다다',
  ignore: '무시 · 귀뚜라미',
  rank: '승급 · 팡파르',
  ach: '업적 · 또르르 팅',
  coin: '가상 코인 · 띠링',
  item: '헌납품 · 뽁 뿅',
  invite: '초대 도착 · 딩동',
  accept: '수락 · 도미솔',
  decline: '거절 · 뚜둥',
  prophecy: '오늘의 계시 · 징',
  chant: '구호 · 헤이!',
  sermonEnd: '설교 끝 · 박수',
  battleStart: '배틀 시작 · 땡땡',
  win: '배틀 승리',
  lose: '배틀 패배',
  whistle: '단속반 · 호루라기',
  caught: '잡힘 · 띠요옹',
  sprint: '스프린트 · 슈욱',
  emote: '이모트 · 뾱',
  pop: '알림 · 뽁',
  error: '오류 · 뿝뿝',
  joinRoom: '방 입장 · 차임↑',
  leaveRoom: '방 퇴장 · 차임↓',
}

// ───────── 분석 ─────────

export interface Analysis {
  /** 마스터 출력 피크(선형, 1 = 0 dBFS) */
  peak: number
  /** 소리 길이 구간의 RMS */
  rms: number
  /** 소리 함수가 돌려준 길이(초) */
  duration: number
  /** 스펙트럼 중심(Hz) */
  centroid: number
  /** 길이를 16등분한 구간별 피크 */
  envelope: number[]
  /** 길이가 끝난 뒤에 남은 소리의 피크(0 에 가까워야 길이가 정직하다) */
  tail: number
  peakDb: number
}

export interface MusicAnalysis extends Analysis {
  /** 렌더에 걸린 시간(ms) — 음악 길이에 비해 얼마나 가벼운지 보는 용도 */
  renderMs: number
  /** 렌더 시간 / 음악 길이. 0.01 이면 한 코어의 1% */
  cpuRatio: number
}

function isName(name: string): name is SfxName {
  return Object.prototype.hasOwnProperty.call(SOUNDS, name)
}

function db(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : -Infinity
}

/** 제자리 복소 FFT(길이는 2의 거듭제곱) */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>()
function hann(size: number): Float64Array {
  let w = hannCache.get(size)
  if (!w) {
    w = new Float64Array(size)
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
    hannCache.set(size, w)
  }
  return w
}

/** data[start..] 에서 size 표본을 잘라(범위 밖은 0) 한 프레임의 크기 스펙트럼을 out 에 쓴다. 전체 크기 사인이 1 이 되게 정규화 */
function magnitude(data: Float32Array, limit: number, start: number, size: number, re: Float64Array, im: Float64Array, out: Float32Array): void {
  const w = hann(size)
  for (let i = 0; i < size; i++) {
    const k = start + i
    re[i] = k >= 0 && k < limit ? data[k] * w[i] : 0
    im[i] = 0
  }
  fft(re, im)
  const norm = 4 / size
  for (let i = 0; i < size / 2; i++) out[i] = Math.hypot(re[i], im[i]) * norm
}

/** 스펙트럼 중심: 2048 표본 창을 절반씩 겹쳐 평균 낸 크기 스펙트럼의 무게중심 */
function spectralCentroid(data: Float32Array, n: number): number {
  const size = 2048
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const mag = new Float32Array(size / 2)
  const acc = new Float64Array(size / 2)
  for (let start = 0; start < n; start += size / 2) {
    magnitude(data, n, start, size, re, im, mag)
    for (let i = 0; i < size / 2; i++) acc[i] += mag[i]
  }
  let num = 0
  let den = 0
  // 0번 빈(DC)은 음색 정보가 아니므로 뺀다
  for (let i = 1; i < size / 2; i++) {
    num += acc[i] * ((i * SR) / size)
    den += acc[i]
  }
  return den > 0 ? num / den : 0
}

function analyze(data: Float32Array, duration: number): Analysis {
  const n = Math.max(1, Math.min(data.length, Math.round(duration * SR)))
  let peak = 0
  let sum = 0
  const envelope = new Array<number>(BUCKETS).fill(0)
  for (let i = 0; i < n; i++) {
    const a = Math.abs(data[i])
    if (a > peak) peak = a
    sum += a * a
    const b = Math.min(BUCKETS - 1, Math.floor((i * BUCKETS) / n))
    if (a > envelope[b]) envelope[b] = a
  }
  // 컴프레서의 미리보기 지연(6ms)만큼 소리가 뒤로 밀리므로 그 뒤부터 본다
  let tail = 0
  for (let i = n + Math.round(0.03 * SR); i < data.length; i++) {
    const a = Math.abs(data[i])
    if (a > tail) tail = a
  }
  return {
    peak,
    rms: Math.sqrt(sum / n),
    duration,
    centroid: spectralCentroid(data, n),
    envelope: envelope.map((v) => Math.round(v * 1e4) / 1e4),
    tail,
    peakDb: db(peak),
  }
}

// ───────── 오프라인 렌더 ─────────

interface Rendered {
  data: Float32Array
  duration: number
}

/** 엔진과 같은 경로(발음 게인 → 마스터 체인)로 소리 하나를 렌더한다. lead 초 뒤에 울리고, 돌려주는 data 는 그 시점부터다 */
async function renderBuffer(name: SfxName, lead = LEAD_S): Promise<Rendered> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * (RENDER_S + lead)), SR)
  const { duration } = renderSound(ctx, createMaster(ctx).sfx, name, lead, 1)
  const buf = await ctx.startRendering()
  return { data: buf.getChannelData(0).subarray(Math.round(lead * SR)), duration }
}

async function renderOffline(name: string, lead = LEAD_S): Promise<Analysis> {
  if (!isName(name)) throw new Error(`모르는 효과음 이름: ${name}`)
  const r = await renderBuffer(name, lead)
  return analyze(r.data, r.duration)
}

/** 마스터 체인 없이 게인 1 로 그렸을 때의 피크(음량 보정표의 원본) */
async function dryPeak(name: SfxName): Promise<number> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * RENDER_S), SR)
  SOUNDS[name](ctx, ctx.destination, 0)
  const d = (await ctx.startRendering()).getChannelData(0)
  let peak = 0
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
  return peak
}

/** 여러 소리를 같은 순간에 겹쳐 울렸을 때의 마스터 출력(리미터 확인용). 엔진의 발음 수 제한은 일부러 무시한다 */
async function renderStack(names: readonly string[]): Promise<{ peak: number; peakDb: number }> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * RENDER_S), SR)
  const master = createMaster(ctx)
  for (const name of names) {
    if (!isName(name)) throw new Error(`모르는 효과음 이름: ${name}`)
    renderSound(ctx, master.sfx, name, 0.01, 1)
  }
  const d = (await ctx.startRendering()).getChannelData(0)
  let peak = 0
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
  return { peak, peakDb: db(peak) }
}

/** 배경음을 처음부터 seconds 초 렌더한다. fromS 이후 구간만 분석(둘째 바퀴 = 메아리·패드가 다 찬 정상 상태) */
async function renderMusicBuffer(seconds: number, level: number, throughMaster: boolean): Promise<{ data: Float32Array; renderMs: number }> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR)
  const graph = buildMusicGraph(ctx, throughMaster ? createMaster(ctx).music : ctx.destination)
  graph.out.gain.value = level
  const steps = Math.ceil(seconds / MUSIC_STEP_S)
  for (let s = 0; s < steps; s++) scheduleMusicStep(ctx, graph, s % MUSIC_STEPS, s * MUSIC_STEP_S)
  const t = performance.now()
  const buf = await ctx.startRendering()
  return { data: buf.getChannelData(0), renderMs: performance.now() - t }
}

interface MusicRender {
  /** fromS 이후 구간 */
  data: Float32Array
  analysis: MusicAnalysis
}

/** 엔진과 같은 경로(배경음 게인 → 마스터 체인)로 처음부터 seconds 초를 렌더하고 fromS 이후를 분석한다 */
async function renderMusicData(seconds: number, fromS: number): Promise<MusicRender> {
  const total = Math.max(0.5, seconds)
  const r = await renderMusicBuffer(total, MUSIC_LEVEL, true)
  const from = Math.min(Math.max(0, Math.round(fromS * SR)), r.data.length - 1)
  const data = r.data.subarray(from)
  const a = analyze(data, total - from / SR)
  return { data, analysis: { ...a, renderMs: r.renderMs, cpuRatio: r.renderMs / 1000 / total } }
}

async function renderMusic(seconds = 3, fromS = 0): Promise<MusicAnalysis> {
  return (await renderMusicData(seconds, fromS)).analysis
}

// ───────── 검증 ─────────

export interface Row extends Analysis {
  name: SfxName
  targetDb: number
  maxDuration: number
  /** 지문(중심 주파수 + 크기 곡선)이 가장 가까운 다른 소리 */
  nearest: string
  /** 1 미만이면 "거의 같은 소리"로 본다 */
  distance: number
  flags: string[]
}

export interface VerifyReport {
  ok: boolean
  rows: Row[]
  failures: string[]
  music3s: MusicAnalysis
  musicLoop: MusicAnalysis
  /** 가장 큰 8개를 동시에 */
  stack8: { peak: number; peakDb: number }
  /** 전부 동시에(발음 제한이 없다고 쳐도 클리핑이 없어야 한다) */
  stackAll: { peak: number; peakDb: number }
}

/** 중심 주파수가 이만큼(옥타브) 안이고 */
const NEAR_CENTROID_OCT = 0.12
/** 정규화한 크기 곡선의 평균 차이가 이만큼 안이면 "거의 같은 소리" */
const NEAR_ENVELOPE = 0.08

function normalized(env: readonly number[]): number[] {
  const max = Math.max(...env, 1e-9)
  return env.map((v) => v / max)
}

/** 두 지문 사이 거리: 두 기준을 각각 문턱으로 나눈 값 중 큰 쪽. 1 미만 = 둘 다 문턱 안 = 거의 같음 */
function fingerprintDistance(a: Analysis, b: Analysis): number {
  const cd = Math.abs(Math.log2(a.centroid / b.centroid))
  const ea = normalized(a.envelope)
  const eb = normalized(b.envelope)
  let ed = 0
  for (let i = 0; i < BUCKETS; i++) ed += Math.abs(ea[i] - eb[i])
  ed /= BUCKETS
  return Math.max(cd / NEAR_CENTROID_OCT, ed / NEAR_ENVELOPE)
}

function checkRows(analyses: Map<SfxName, Analysis>): Row[] {
  const rows: Row[] = []
  for (const name of SFX_NAMES) {
    const a = analyses.get(name)
    if (!a) continue
    let nearest = ''
    let distance = Infinity
    for (const other of SFX_NAMES) {
      const b = analyses.get(other)
      if (other === name || !b) continue
      const d = fingerprintDistance(a, b)
      if (d < distance) {
        distance = d
        nearest = other
      }
    }
    const flags: string[] = []
    if (!(a.rms > 0.01)) flags.push(`너무 조용함(rms ${a.rms.toFixed(4)})`)
    if (!(a.peak <= 1)) flags.push(`클리핑(peak ${a.peak.toFixed(3)})`)
    if (Math.abs(a.peakDb - TARGET_DB[name]) > 1) flags.push(`목표 음량과 다름(${a.peakDb.toFixed(1)} dBFS, 목표 ${TARGET_DB[name]})`)
    if (!(a.duration > 0.03 && a.duration <= maxDuration(name))) flags.push(`길이 초과(${a.duration.toFixed(2)}s > ${maxDuration(name)}s)`)
    if (a.tail > 0.003) flags.push(`길이 뒤에 소리가 남음(${a.tail.toFixed(4)})`)
    if (distance < 1) flags.push(`${nearest} 와 거의 같은 소리(거리 ${distance.toFixed(2)})`)
    rows.push({ ...a, name, targetDb: TARGET_DB[name], maxDuration: maxDuration(name), nearest, distance, flags })
  }
  return rows
}

interface Collected {
  report: VerifyReport
  /** 카드에 그릴 렌더 결과 */
  buffers: Map<SfxName, Rendered>
  musicLoop: Float32Array
}

async function collect(): Promise<Collected> {
  const analyses = new Map<SfxName, Analysis>()
  const buffers = new Map<SfxName, Rendered>()
  for (const name of SFX_NAMES) {
    const r = await renderBuffer(name)
    buffers.set(name, r)
    analyses.set(name, analyze(r.data, r.duration))
  }
  const rows = checkRows(analyses)
  const failures: string[] = []
  for (const r of rows) for (const f of r.flags) failures.push(`${r.name}: ${f}`)

  const music3s = await renderMusic(3)
  // 둘째 바퀴만 본다: 첫 바퀴는 메아리와 패드가 덜 차서 실제보다 작게 나온다
  const loopS = MUSIC_STEPS * MUSIC_STEP_S
  const loop = await renderMusicData(loopS * 2, loopS)
  const musicLoop = loop.analysis
  for (const [label, m] of [
    ['배경음 3초', music3s],
    ['배경음 한 바퀴', musicLoop],
  ] as const) {
    if (!(m.rms > 0.01)) failures.push(`${label}: 너무 조용함(rms ${m.rms.toFixed(4)})`)
    if (!(m.peak < 0.5)) failures.push(`${label}: 너무 큼(peak ${m.peak.toFixed(3)})`)
  }

  const loudest = [...SFX_NAMES].sort((a, b) => TARGET_DB[b] - TARGET_DB[a]).slice(0, 8)
  const stack8 = await renderStack(loudest)
  const stackAll = await renderStack(SFX_NAMES)
  if (!(stack8.peak < 1)) failures.push(`8개 동시: 클리핑(peak ${stack8.peak.toFixed(3)})`)
  if (!(stackAll.peak < 1)) failures.push(`전부 동시: 클리핑(peak ${stackAll.peak.toFixed(3)})`)

  return { report: { ok: failures.length === 0, rows, failures, music3s, musicLoop, stack8, stackAll }, buffers, musicLoop: loop.data }
}

async function verify(): Promise<VerifyReport> {
  return (await collect()).report
}

/** sounds.ts / music.ts 에 붙여 넣을 음량 보정값을 다시 잰다 */
async function calibrate(): Promise<string> {
  const lines: string[] = ['// sounds.ts — DRY_PEAK', 'export const DRY_PEAK: Record<SfxName, number> = {']
  const round = (x: number): number => Math.round(x * 1e4) / 1e4
  for (const name of SFX_NAMES) lines.push(`  ${name}: ${round(await dryPeak(name))},`)
  lines.push('}', '')
  const loopS = MUSIC_STEPS * MUSIC_STEP_S
  const m = await renderMusicBuffer(loopS * 2, 1, false)
  let peak = 0
  for (let i = Math.round(loopS * SR); i < m.data.length; i++) peak = Math.max(peak, Math.abs(m.data[i]))
  lines.push('// music.ts', `export const MUSIC_DRY_PEAK = ${round(peak)}`)
  return lines.join('\n')
}

// ───────── 그림 ─────────

const CANVAS_W = 220
const CANVAS_H = 72
/** 캔버스 아래쪽, 크기 곡선 막대가 차지하는 높이 */
const ENV_H = 18
const MUSIC_CANVAS_W = 1100
const MUSIC_CANVAS_H = 110
const SPEC_FMIN = 80
const SPEC_FMAX = 12000

/** 세기(0..1) → 먹색 → 보라 → 분홍 → 노랑 */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0, 36, 27, 53],
  [0.45, 123, 92, 255],
  [0.75, 255, 126, 182],
  [1, 255, 210, 63],
]

function heat(v: number, out: Uint8ClampedArray, at: number): void {
  const x = Math.min(1, Math.max(0, v))
  let i = 1
  while (i < STOPS.length - 1 && x > STOPS[i][0]) i++
  const a = STOPS[i - 1]
  const b = STOPS[i]
  const k = (x - a[0]) / (b[0] - a[0])
  out[at] = a[1] + (b[1] - a[1]) * k
  out[at + 1] = a[2] + (b[2] - a[2]) * k
  out[at + 2] = a[3] + (b[3] - a[3]) * k
  out[at + 3] = 255
}

/**
 * 위: 스펙트로그램(가로 = 소리 길이 전체, 세로 = 80 Hz…12 kHz 로그), 아래: 16칸 크기 곡선.
 * 캔버스 크기에 맞춰 그리며, size 는 FFT 창 길이(길수록 낮은 음의 음정이 또렷하고 시간은 뭉개진다).
 */
function draw(canvas: HTMLCanvasElement, data: Float32Array, a: Analysis, size = 1024): void {
  const g = canvas.getContext('2d')
  if (!g) return
  const w = canvas.width
  const h = canvas.height
  const specH = h - ENV_H
  const n = Math.max(1, Math.min(data.length, Math.round(a.duration * SR)))
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const mag = new Float32Array(size / 2)
  const img = g.createImageData(w, specH)
  const ref = Math.max(a.peak, 1e-6)
  for (let x = 0; x < w; x++) {
    const center = Math.round(((x + 0.5) / w) * n)
    magnitude(data, n, center - size / 2, size, re, im, mag)
    for (let y = 0; y < specH; y++) {
      const f = SPEC_FMIN * Math.pow(SPEC_FMAX / SPEC_FMIN, 1 - (y + 0.5) / specH)
      const bin = Math.min(size / 2 - 1, Math.max(1, Math.round((f * size) / SR)))
      // 소리마다 자기 피크 기준으로 −50 dB 까지 보여 준다(작은 소리도 모양이 보이게)
      const level = db(mag[bin] / ref)
      heat((level + 50) / 50, img.data, (y * w + x) * 4)
    }
  }
  g.fillStyle = '#241b35'
  g.fillRect(0, 0, w, h)
  g.putImageData(img, 0, 0)
  const env = normalized(a.envelope)
  const bw = w / BUCKETS
  const eh = ENV_H - 3
  g.fillStyle = '#ffd23f'
  for (let i = 0; i < BUCKETS; i++) {
    const bh = Math.max(1, env[i] * eh)
    g.fillRect(i * bw + 1, h - bh, bw - 2, bh)
  }
}

// ───────── 화면 ─────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

interface Card {
  root: HTMLElement
  canvas: HTMLCanvasElement
  stats: HTMLElement
  flags: HTMLElement
}

const engine = createSfxEngine()
const cards = new Map<SfxName, Card>()
let musicCard: { canvas: HTMLCanvasElement; stats: HTMLElement } | null = null

function build(): void {
  const app = document.getElementById('app')
  if (!app) return

  const h1 = el('h1', '', '효과음 실험실')
  h1.append(el('small', '', '도를 아십니까? · 개발용'))
  app.append(h1, el('p', 'lead', '모든 소리는 WebAudio 합성입니다(음원 파일 없음). 카드의 그림은 실제 엔진과 같은 그래프를 오프라인으로 렌더한 결과입니다.'))

  const bar = el('div', 'bar')
  const status = el('span', 'chip', '오디오: 대기 중')
  const sfxBtn = el('button', 'btn', '효과음 켜짐')
  sfxBtn.setAttribute('aria-pressed', 'true')
  const musicBtn = el('button', 'btn', '배경음 꺼짐')
  musicBtn.setAttribute('aria-pressed', 'false')
  const allBtn = el('button', 'btn', '전부 차례로 듣기')
  const calibBtn = el('button', 'btn', '음량 보정값 재기')
  bar.append(sfxBtn, musicBtn, allBtn, calibBtn, status)
  app.append(bar)

  const verdict = el('div', 'verdict', '오프라인 분석 중…')
  app.append(verdict)

  const grid = el('div', 'grid')
  for (const name of SFX_NAMES) {
    const root = el('div', 'card')
    const play = el('button', 'play')
    play.append(el('b', '', name), el('span', '', LABELS[name]))
    // 좁은 카드에서는 설명이 말줄임되므로 툴팁으로도 보여 준다
    play.title = LABELS[name]
    play.addEventListener('click', () => {
      engine.unlock()
      engine.play(name)
    })
    const canvas = el('canvas')
    canvas.width = CANVAS_W
    canvas.height = CANVAS_H
    const stats = el('div', 'stats', '…')
    const flags = el('div', 'flags')
    root.append(play, canvas, stats, flags)
    grid.append(root)
    cards.set(name, { root, canvas, stats, flags })
  }
  app.append(grid)

  const music = el('div', 'card music')
  const musicCanvas = el('canvas')
  musicCanvas.width = MUSIC_CANVAS_W
  musicCanvas.height = MUSIC_CANVAS_H
  const musicStats = el('div', 'stats', '…')
  music.append(el('b', '', '배경음 한 바퀴 (8마디)'), musicCanvas, musicStats)
  app.append(music)
  musicCard = { canvas: musicCanvas, stats: musicStats }

  const calibOut = el('pre', 'calib')
  app.append(calibOut)
  app.append(
    el(
      'p',
      'legend',
      '그림: 위는 스펙트로그램(가로 = 소리 길이 전체, 세로 = 80 Hz…12 kHz 로그 눈금), 아래 노란 막대는 길이를 16등분한 크기 곡선. ' +
        '"닮은 소리"의 거리는 1 미만이면 서로 구분이 안 되는 것으로 봅니다.',
    ),
  )

  let sfxOn = true
  sfxBtn.addEventListener('click', () => {
    sfxOn = !sfxOn
    engine.setEnabled(sfxOn)
    sfxBtn.textContent = sfxOn ? '효과음 켜짐' : '효과음 꺼짐'
    sfxBtn.setAttribute('aria-pressed', String(sfxOn))
  })

  let musicOn = false
  musicBtn.addEventListener('click', () => {
    musicOn = !musicOn
    engine.unlock()
    engine.setMusic(musicOn)
    musicBtn.textContent = musicOn ? '배경음 켜짐' : '배경음 꺼짐'
    musicBtn.setAttribute('aria-pressed', String(musicOn))
  })

  let touring = false
  allBtn.addEventListener('click', () => {
    if (touring) return
    touring = true
    allBtn.disabled = true
    engine.unlock()
    void (async () => {
      for (const name of SFX_NAMES) {
        const card = cards.get(name)
        card?.root.classList.add('playing')
        engine.play(name)
        // 소리 길이를 미리 알 수 없으니(그래프를 그려 봐야 안다) 상한 + 숨 고를 틈만큼 기다린다
        await new Promise((r) => setTimeout(r, Math.min(maxDuration(name), 1.3) * 1000 * 0.6 + 350))
        card?.root.classList.remove('playing')
      }
      touring = false
      allBtn.disabled = false
    })()
  })

  calibBtn.addEventListener('click', () => {
    calibOut.textContent = '재는 중…'
    void calibrate().then(
      (text) => (calibOut.textContent = text),
      (e: unknown) => (calibOut.textContent = `실패: ${String(e)}`),
    )
  })

  window.setInterval(() => {
    const d: SfxDebug = engine.debug()
    const state = d.state === 'none' ? '대기 중(아무 곳이나 누르면 켜짐)' : d.state
    status.textContent = `오디오: ${state} · 발음 ${d.voices} · 시작 ${d.started} · 끊김 ${d.dropped} · 건너뜀 ${d.limited}`
  }, 200)

  void runAnalysis(verdict)
}

async function runAnalysis(verdict: HTMLElement): Promise<void> {
  try {
    const { report, buffers, musicLoop } = await collect()
    for (const row of report.rows) {
      const card = cards.get(row.name)
      const r = buffers.get(row.name)
      if (!card || !r) continue
      draw(card.canvas, r.data, row)
      card.stats.textContent = ''
      card.stats.append(
        el('b', '', `${row.duration.toFixed(2)}s`),
        ` · ${row.peakDb.toFixed(1)} dBFS`,
        el('br'),
        `rms ${row.rms.toFixed(3)} · 중심 ${Math.round(row.centroid)} Hz`,
        el('br'),
        `닮은 소리 ${row.nearest} (${row.distance.toFixed(1)})`,
      )
      card.flags.textContent = row.flags.join(' / ')
      card.root.classList.toggle('bad', row.flags.length > 0)
    }
    const m = report.musicLoop
    if (musicCard) {
      // 패드가 100~300 Hz 에 깔리므로 긴 창(4096)으로 낮은 음을 또렷하게 본다
      draw(musicCard.canvas, musicLoop, m, 4096)
      musicCard.stats.textContent = `${m.duration.toFixed(1)}s · 피크 ${m.peakDb.toFixed(1)} dBFS · rms ${m.rms.toFixed(3)} · 중심 ${Math.round(m.centroid)} Hz (둘째 바퀴 = 메아리와 패드가 다 찬 상태)`
    }
    const lines = [
      report.ok ? `검증 통과: 효과음 ${report.rows.length}개 모두 기준 안` : `검증 실패 ${report.failures.length}건`,
      ...report.failures.map((f) => `  · ${f}`),
      // 오프라인 렌더는 두 바퀴 치 노드를 전부 미리 만들어 두고 돌리므로 실시간(1초 앞까지만 예약)보다 무겁게 나온다 → 상한으로 읽는다
      `배경음 한 바퀴(${(MUSIC_STEPS * MUSIC_STEP_S).toFixed(1)}s): 피크 ${m.peakDb.toFixed(1)} dBFS · rms ${m.rms.toFixed(3)} · 오프라인 렌더 시간 = 음악 길이의 ${(m.cpuRatio * 100).toFixed(1)}% (실시간 부하의 상한)`,
      `겹침: 큰 소리 8개 동시 ${report.stack8.peakDb.toFixed(1)} dBFS · 31개 전부 동시 ${report.stackAll.peakDb.toFixed(1)} dBFS (클리핑 없음 = 0 dBFS 미만)`,
    ]
    verdict.textContent = lines.join('\n')
    verdict.classList.add(report.ok ? 'ok' : 'bad')
  } catch (e) {
    verdict.textContent = `분석 실패: ${String(e)}`
    verdict.classList.add('bad')
  }
}

// ───────── 자동 검증용 창구 ─────────

const api = {
  names: SFX_NAMES as string[],
  play(name: string, volume?: number): void {
    engine.play(name as SfxName, volume)
  },
  renderOffline,
  renderMusic,
  renderStack,
  verify,
  calibrate,
  unlock: (): void => engine.unlock(),
  setEnabled: (on: boolean): void => engine.setEnabled(on),
  setMusic: (on: boolean): void => engine.setMusic(on),
  debug: (): SfxDebug => engine.debug(),
  /** 현재 음량표(목표 dBFS / 잰 원본 피크) */
  levels: { TARGET_DB, DRY_PEAK, MUSIC_DRY_PEAK, MUSIC_LEVEL },
}

declare global {
  interface Window {
    __sfx: typeof api
  }
}
window.__sfx = api

build()
