/**
 * 공유 카드(임명장·결산·거절 짤) 공용 캔버스 도구.
 * - 카드는 필요할 때만 그린다. 큰 캔버스(1080×1920 = 약 8MB)를 매번 만들면 모바일에서 메모리가 튀므로
 *   offscreen 캔버스 하나를 돌려 쓴다(getCardCanvas).
 * - 글꼴은 시스템 글꼴만 쓴다(에셋 없음). 궁서/명조가 없는 기기에서는 serif → 고딕으로 떨어져도 읽히게
 *   크기·굵기로 위계를 잡는다.
 */
import { CULT_COLORS, CULT_EMBLEMS } from '../../../shared/content/core'
import type { CultRef } from '../../../shared/types'

/** 엄숙한 척하는 명조/궁서 계열(장난스러운 공문서 말투용) */
export const SERIF = "'Gungsuh','GungSeo','Batang','AppleMyungjo','Nanum Myeongjo','Noto Serif KR','Noto Serif CJK KR',serif"
/** 본문/숫자용 고딕 */
export const SANS = "'Pretendard','Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic','WenQuanYi Zen Hei',system-ui,sans-serif"
/** 이모지는 컬러 이모지 글꼴을 먼저 찾게 한다 */
export const EMOJI = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif"

export const INK = '#241b35'
export const INK_SOFT = '#5b5170'
export const PAPER = '#fff8e7'
export const YELLOW = '#ffd23f'
export const PURPLE = '#7b5cff'
export const STAMP_RED = '#e0362c'

/** 모든 카드에 들어가는 고지 문구(디자인 요소로 크게 넣는다 — 조사 03 §2.15) */
export const FOOTER_TEXT = '이 문서는 아무 효력이 없습니다 · 모든 교단은 허구입니다'

export type CardType = 'certificate' | 'summary' | 'meme'
export const CARD_SIZE: Record<CardType, { w: number; h: number }> = {
  certificate: { w: 1080, h: 1920 },
  summary: { w: 1080, h: 1920 },
  meme: { w: 1080, h: 1080 },
}

let shared: HTMLCanvasElement | null = null
/** 카드용 offscreen 캔버스 하나를 돌려 쓴다(크기만 맞춰 준다) */
export function getCardCanvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  if (!shared) shared = document.createElement('canvas')
  if (shared.width !== w) shared.width = w
  if (shared.height !== h) shared.height = h
  const g = shared.getContext('2d')
  if (!g) throw new Error('2d context unavailable')
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'
  g.shadowColor = 'transparent'
  g.shadowBlur = 0
  g.textAlign = 'left'
  g.textBaseline = 'alphabetic'
  g.clearRect(0, 0, w, h)
  return { c: shared, g }
}

export function hexColor(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

/** 0..1 밝기(글자색을 고르기 위한 대략치) */
export function luminance(n: number): number {
  const r = (n >> 16) & 255
  const gg = (n >> 8) & 255
  const b = n & 255
  return (0.299 * r + 0.587 * gg + 0.114 * b) / 255
}

/** 색을 흰색 쪽으로 섞는다(t=0 원색, 1 흰색) */
export function tint(n: number, t: number): string {
  const r = (n >> 16) & 255
  const gg = (n >> 8) & 255
  const b = n & 255
  const m = (v: number): number => Math.round(v + (255 - v) * t)
  return `rgb(${m(r)},${m(gg)},${m(b)})`
}

/** 색을 검정 쪽으로 섞는다 */
export function shade(n: number, t: number): string {
  const r = (n >> 16) & 255
  const gg = (n >> 8) & 255
  const b = n & 255
  const m = (v: number): number => Math.round(v * (1 - t))
  return `rgb(${m(r)},${m(gg)},${m(b)})`
}

/** 교단 색(없으면 기본 노랑/보라) */
export function cultColors(cult: CultRef | null): { main: number; accent: number } {
  if (!cult) return { main: 0xffd23f, accent: 0x7b5cff }
  const main = CULT_COLORS[cult.color] ?? 0xffd23f
  // 교단 색이 아주 밝으면 보라, 어두우면 노랑을 짝으로 쓴다
  return { main, accent: luminance(main) > 0.62 ? 0x7b5cff : 0xffd23f }
}

export function cultEmblem(cult: CultRef | null): string {
  if (!cult) return '🙏'
  return CULT_EMBLEMS[cult.emblem] ?? '🙏'
}

export function font(weight: number | string, size: number, family: string): string {
  return `${weight} ${Math.round(size)}px ${family}`
}

/**
 * 최대 폭 안에 들어가도록 글자 크기를 줄여서 한 줄로 그린다.
 * 닉네임 10자·교단명 12자 같은 최대 길이에서도 잘리지 않게 하기 위함.
 * 돌려주는 값은 실제로 쓴 글자 크기.
 */
export function fitText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  size: number,
  opts: { weight?: number | string; family?: string; min?: number; align?: CanvasTextAlign; fill?: string; stroke?: string; strokeW?: number; spacing?: number } = {},
): number {
  const family = opts.family ?? SANS
  const weight = opts.weight ?? 800
  const min = opts.min ?? Math.max(12, size * 0.4)
  let s = size
  const spacing = opts.spacing ?? 0
  const width = (sz: number): number => {
    g.font = font(weight, sz, family)
    return g.measureText(text).width + spacing * sz * Math.max(0, Array.from(text).length - 1)
  }
  while (s > min && width(s) > maxW) s -= Math.max(1, s * 0.04)
  g.font = font(weight, s, family)
  g.textAlign = opts.align ?? 'center'
  if (spacing > 0 && 'letterSpacing' in g) {
    ;(g as unknown as { letterSpacing: string }).letterSpacing = `${(spacing * s).toFixed(1)}px`
  }
  if (opts.stroke) {
    g.lineJoin = 'round'
    g.lineWidth = opts.strokeW ?? s * 0.16
    g.strokeStyle = opts.stroke
    g.strokeText(text, x, y, maxW)
  }
  g.fillStyle = opts.fill ?? INK
  g.fillText(text, x, y, maxW)
  if ('letterSpacing' in g) (g as unknown as { letterSpacing: string }).letterSpacing = '0px'
  return s
}

/** 글자 단위 줄바꿈(한국어는 어절 단위가 자연스럽지만, 긴 어절도 넘치지 않게 글자 단위로 쪼갠다) */
export function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/(\s+)/)
  const lines: string[] = []
  let cur = ''
  const push = (): void => {
    lines.push(cur.trim())
    cur = ''
  }
  for (const w of words) {
    const next = cur + w
    if (g.measureText(next).width <= maxW) {
      cur = next
      continue
    }
    if (cur.trim()) push()
    if (g.measureText(w).width <= maxW) {
      cur = w.trimStart()
      continue
    }
    // 한 어절이 한 줄보다 길면 글자 단위로 자른다
    for (const ch of Array.from(w)) {
      if (g.measureText(cur + ch).width > maxW && cur) push()
      cur += ch
    }
  }
  if (cur.trim()) push()
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    let last = kept[maxLines - 1] ?? ''
    while (last && g.measureText(last + '…').width > maxW) last = Array.from(last).slice(0, -1).join('')
    kept[maxLines - 1] = last + '…'
    return kept
  }
  return lines
}

/** 여러 줄 글을 가운데 정렬로 그리고 마지막 줄 아래 y 를 돌려준다 */
export function drawLines(g: CanvasRenderingContext2D, lines: string[], x: number, y: number, lh: number): number {
  for (const [i, l] of lines.entries()) g.fillText(l, x, y + i * lh)
  return y + lines.length * lh
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
}

/** "수상한 전단지 스티커" 상자: 굵은 먹색 테두리 + 딱딱한 그림자 */
export function sticker(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, shadow = 8): void {
  g.fillStyle = INK
  roundRect(g, x, y + shadow, w, h, r)
  g.fill()
  g.fillStyle = fill
  roundRect(g, x, y, w, h, r)
  g.fill()
  g.lineWidth = 6
  g.strokeStyle = INK
  g.stroke()
}

export function emoji(g: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number, alpha = 1): void {
  g.save()
  g.globalAlpha = alpha
  g.font = `${Math.round(size)}px ${EMOJI}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = INK
  g.fillText(ch, x, y)
  g.restore()
}

/**
 * 붉은 동그라미 "직인". 관공서 직인처럼 보이지 않게 일부러 삐뚤고 번진 고무도장 느낌 + "허구" 글자.
 */
export function stamp(g: CanvasRenderingContext2D, x: number, y: number, r: number, big: string, small: string, rot = -0.22): void {
  // 번짐 자국(destination-out)이 카드 배경까지 뚫지 않도록 작은 캔버스에 따로 그린 뒤 붙인다
  const size = Math.ceil(r * 2.3)
  const sc = document.createElement('canvas')
  sc.width = sc.height = size
  const s = sc.getContext('2d')
  if (!s) return
  s.translate(size / 2, size / 2)
  s.rotate(rot)
  s.strokeStyle = STAMP_RED
  s.fillStyle = STAMP_RED
  s.lineWidth = r * 0.09
  s.beginPath()
  s.arc(0, 0, r, 0, Math.PI * 2)
  s.stroke()
  s.lineWidth = r * 0.035
  s.beginPath()
  s.arc(0, 0, r * 0.82, 0, Math.PI * 2)
  s.stroke()
  s.textAlign = 'center'
  s.textBaseline = 'middle'
  s.font = font(900, r * 0.62, SERIF)
  s.fillText(big, 0, -r * 0.12, r * 1.3)
  s.font = font(800, r * 0.2, SANS)
  s.fillText(small, 0, r * 0.42, r * 1.1)
  // 잉크가 덜 묻은 자국(결정적 난수라 매번 같은 모양)
  s.globalCompositeOperation = 'destination-out'
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2
    const d = rnd() * r * 1.05
    s.globalAlpha = 0.25 + rnd() * 0.5
    s.beginPath()
    s.arc(Math.cos(a) * d, Math.sin(a) * d, 1.5 + rnd() * r * 0.05, 0, Math.PI * 2)
    s.fill()
  }
  g.save()
  g.globalAlpha = 0.88
  g.drawImage(sc, x - size / 2, y - size / 2)
  g.restore()
}

/** 고지 + 주소 푸터. 모든 카드 공통 */
export function footer(g: CanvasRenderingContext2D, w: number, y: number, host: string, color = INK_SOFT, size = 30): void {
  g.save()
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  fitText(g, FOOTER_TEXT, w / 2, y, w - 120, size, { weight: 800, fill: color })
  fitText(g, `도를 아십니까? — 교주 시뮬레이터 · ${host}`, w / 2, y + size * 1.45, w - 160, size * 0.9, { weight: 700, fill: color })
  g.restore()
}

/** FNV-1a 32비트(발급번호용. 같은 사람·같은 날이면 같은 번호) */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function ymd(d: Date): { y: number; m: number; d: number; key: string } {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const dd = d.getDate()
  return { y, m, d: dd, key: `${y}${String(m).padStart(2, '0')}${String(dd).padStart(2, '0')}` }
}

/** 받침 유무로 조사 고르기: josa('교단장', '으로', '로') */
export function josa(word: string, withFinal: string, without: string): string {
  const ch = word.charCodeAt(word.length - 1)
  if (ch < 0xac00 || ch > 0xd7a3) return without
  const fin = (ch - 0xac00) % 28
  if (fin === 0) return without
  // '(으)로' 는 ㄹ 받침이면 '로'
  if (withFinal === '으로' && fin === 8) return without
  return withFinal
}

/** 숫자를 1,234 꼴로 */
export function num(n: number): string {
  return Math.max(0, Math.floor(n || 0)).toLocaleString('ko-KR')
}

/** 간단한 자리표시 초상(chars 가 없을 때: 하네스/WebGL 실패) */
export function placeholderPortrait(size: number, color = 0xffd23f): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  if (!g) return c
  const s = size
  g.fillStyle = hexColor(color)
  g.strokeStyle = INK
  g.lineWidth = s * 0.02
  g.beginPath()
  g.ellipse(s / 2, s * 0.98, s * 0.34, s * 0.3, 0, Math.PI, 0)
  g.fill()
  g.stroke()
  g.fillStyle = '#ffd9b3'
  g.beginPath()
  g.arc(s / 2, s * 0.45, s * 0.26, 0, Math.PI * 2)
  g.fill()
  g.stroke()
  g.fillStyle = INK
  g.beginPath()
  g.arc(s * 0.41, s * 0.44, s * 0.025, 0, Math.PI * 2)
  g.arc(s * 0.59, s * 0.44, s * 0.025, 0, Math.PI * 2)
  g.fill()
  g.lineWidth = s * 0.015
  g.beginPath()
  g.arc(s / 2, s * 0.5, s * 0.08, 0.2, Math.PI - 0.2)
  g.stroke()
  return c
}
