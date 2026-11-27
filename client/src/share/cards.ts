/**
 * 공유 카드 3종 그리기: 교주 임명장(1080×1920) · 오늘의 포교 결산(1080×1920) · 거절 짤(1080×1080).
 *
 * 디자인 원칙(조사 02 §5, 03 §2.15·§5):
 * - 인스타 스토리 안전 영역: 핵심 내용은 y 250~1670(가운데 1080×1420) 안. 아래쪽은 작은 푸터와 여백(링크 스티커 자리).
 * - 한눈에 농담: 꾸밈은 화려하지만 우스꽝스럽게(라면 면발 물결 테두리, 이모지 구석 장식, 삐뚤어진 "허구" 도장).
 *   관공서·실존 단체 문서로 보일 문양(국가 상징, 정형 직인, 봉황 등)은 쓰지 않는다.
 * - 놀림은 플레이어 본인만. 시민은 늘 옳다.
 */
import { RANKS } from '../../../shared/content/core'
import { certTitle, issueNo, judge, selfRoast, successRate, type SessionNumbers, type ShareProfile } from './data'
import {
  CARD_SIZE,
  FOOTER_TEXT,
  INK,
  INK_SOFT,
  PAPER,
  SANS,
  SERIF,
  cultColors,
  cultEmblem,
  drawLines,
  emoji,
  fitText,
  font,
  footer,
  getCardCanvas,
  hash32,
  hexColor,
  josa,
  num,
  shade,
  stamp,
  sticker,
  tint,
  wrapLines,
  ymd,
} from './kit'

export interface CardEnv {
  /** 카드에 찍을 주소(location.host) */
  host: string
  /** 발급일 */
  date: Date
}

function rankName(rank: number): string {
  return RANKS[Math.max(0, Math.min(RANKS.length - 1, rank))]?.name ?? RANKS[0]!.name
}

/** 라면 면발 같은 물결 테두리(장식이 엄숙해 보이지 않게 일부러 꼬불꼬불) */
function wavyBorder(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, amp: number, step: number, color: string, lw: number): void {
  g.save()
  g.strokeStyle = color
  g.lineWidth = lw
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const edge = (x0: number, y0: number, x1: number, y1: number): void => {
    const len = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.max(2, Math.round(len / step))
    const nx = -(y1 - y0) / len
    const ny = (x1 - x0) / len
    g.beginPath()
    g.moveTo(x0, y0)
    for (let i = 1; i <= n * 6; i++) {
      const t = i / (n * 6)
      const off = Math.sin(t * n * Math.PI * 2) * amp
      g.lineTo(x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off)
    }
    g.stroke()
  }
  edge(x, y, x + w, y)
  edge(x + w, y, x + w, y + h)
  edge(x + w, y + h, x, y + h)
  edge(x, y + h, x, y)
  g.restore()
}

/** 종이 배경 + 은은한 줄무늬 */
function paperBg(g: CanvasRenderingContext2D, w: number, h: number, base: string, stripe: string): void {
  g.fillStyle = base
  g.fillRect(0, 0, w, h)
  g.save()
  g.globalAlpha = 0.35
  g.strokeStyle = stripe
  g.lineWidth = 2
  for (let i = -h; i < w + h; i += 46) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i + h * 0.35, h)
    g.stroke()
  }
  g.restore()
}

// ───────────────────────── 1. 교주 임명장 ─────────────────────────

function certBody(p: ShareProfile): string {
  const r = rankName(p.rank)
  const talks = Math.floor(p.stats['talks'] ?? 0)
  const rejects = Math.floor(p.stats['rejects'] ?? 0)
  const role = josa(r, '으로', '로')
  if (talks === 0) return `위 사람은 아직 아무에게도 말을 걸지 않았으나 표정만은 매우 수상하였으므로 이에 ${r}${role} 확인함.`
  if (p.fol === 0)
    return `위 사람은 ${num(talks)}명에게 말을 걸어 신도 0명이라는 깨끗한 기록을 세웠으므로 이를 딱하게 여겨 ${r}${role} 임명함.`
  if (rejects >= p.fol * 2)
    return `위 사람은 길에서 ${num(talks)}명에게 말을 걸어 ${num(rejects)}번 거절당하고도 굴하지 않았으므로 이에 ${r}${role} 임명함.`
  return `위 사람은 시민 ${num(p.fol)}명을 영문도 모른 채 따라오게 만든 공(?)이 있으므로 이에 ${r}${role} 임명함.`
}

function cultLine(p: ShareProfile): { main: string; sub: string } {
  const c = p.cult
  if (!c) return { main: '무소속', sub: '교단 없음 · 자유로운 영혼' }
  if (c.role === 'leader') return { main: `「${c.name}」`, sub: `교주 · ${c.title || '교주'}` }
  return { main: `「${c.name}」`, sub: `${c.title || '신도'} · 교주 ${c.leaderName}` }
}

export function drawCertificate(p: ShareProfile, portrait: HTMLCanvasElement | null, env: CardEnv): HTMLCanvasElement {
  const { w, h } = CARD_SIZE.certificate
  const { c, g } = getCardCanvas(w, h)
  const col = cultColors(p.cult)
  const main = hexColor(col.main)
  const deep = shade(col.main, 0.35)
  const em = cultEmblem(p.cult)

  // 배경: 교단색이 아주 옅게 섞인 종이
  paperBg(g, w, h, tint(col.main, 0.86), tint(col.main, 0.55))

  // 바깥 띠(교단색) + 꼬불꼬불 면발 테두리 2겹
  g.fillStyle = main
  g.fillRect(0, 0, w, 26)
  g.fillRect(0, h - 26, w, 26)
  g.fillRect(0, 0, 26, h)
  g.fillRect(w - 26, 0, 26, h)
  wavyBorder(g, 52, 52, w - 104, h - 104, 9, 46, deep, 7)
  wavyBorder(g, 76, 76, w - 152, h - 152, 5, 30, hexColor(col.accent), 5)
  // 네 귀퉁이: 엠블럼 스티커
  for (const [cx, cy] of [
    [96, 96],
    [w - 96, 96],
    [96, h - 96],
    [w - 96, h - 96],
  ] as const) {
    g.fillStyle = PAPER
    g.strokeStyle = INK
    g.lineWidth = 5
    g.beginPath()
    g.arc(cx, cy, 52, 0, Math.PI * 2)
    g.fill()
    g.stroke()
    emoji(g, em, cx, cy + 3, 58)
  }

  // ── 위쪽 안전 영역 밖(0~250): 가벼운 장식만 ──
  fitText(g, '★ 비공식 · 무허가 · 셀프 발급 ★', w / 2, 200, 760, 34, { weight: 800, fill: deep, spacing: 0.12 })

  // ── 제목(280~420) ──
  fitText(g, certTitle(p.rank), w / 2, 345, 860, 92, { weight: 900, family: SERIF, fill: INK, spacing: 0.08, min: 54 })
  const d = ymd(env.date)
  const no = issueNo(hash32(p.pid + d.key), d)
  fitText(g, `제 ${no} 호`, w / 2, 412, 600, 32, { weight: 700, family: SERIF, fill: INK_SOFT, spacing: 0.1 })

  // ── 초상(450~1000): 뒤에 거대한 엠블럼 + 후광 ──
  const pcx = w / 2
  const pcy = 735
  g.save()
  g.fillStyle = tint(col.main, 0.45)
  g.strokeStyle = INK
  g.lineWidth = 8
  // 쓸데없이 화려한 후광(톱니)
  g.beginPath()
  const spikes = 28
  for (let i = 0; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2
    const rr = i % 2 === 0 ? 300 : 262
    const x = pcx + Math.cos(a) * rr
    const y = pcy + Math.sin(a) * rr
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
  g.fill()
  g.stroke()
  g.fillStyle = PAPER
  g.beginPath()
  g.arc(pcx, pcy, 238, 0, Math.PI * 2)
  g.fill()
  g.stroke()
  g.restore()
  emoji(g, em, pcx, pcy - 10, 380, 0.22)
  if (portrait) {
    g.save()
    g.beginPath()
    g.arc(pcx, pcy, 234, 0, Math.PI * 2)
    g.clip()
    g.drawImage(portrait, pcx - 260, pcy - 250, 520, 520)
    g.restore()
  }
  // 초상 아래 리본(직급)
  const rk = rankName(p.rank)
  g.font = font(900, 44, SANS)
  const rw = Math.min(760, g.measureText(rk).width + 140)
  sticker(g, pcx - rw / 2, 950, rw, 76, 38, main, 7)
  fitText(g, rk, pcx, 1003, rw - 60, 44, { weight: 900, fill: tintInk(col.main) })

  // ── 이름(1040~1130) ──
  fitText(g, p.name, w / 2, 1132, 880, 112, { weight: 900, fill: INK, min: 60, stroke: PAPER, strokeW: 14 })
  // ── 소속(1150~1230) ──
  const cl = cultLine(p)
  fitText(g, cl.main, w / 2, 1196, 860, 52, { weight: 900, family: SERIF, fill: deep, min: 30 })
  const sub = p.tagName ? `${cl.sub} · 칭호 「${p.tagName}」` : cl.sub
  fitText(g, sub, w / 2, 1246, 860, 34, { weight: 700, fill: INK_SOFT, min: 22 })

  // ── 본문(1280~1400): 공문서 말투 + 하찮은 내용 ──
  g.font = font(700, 38, SERIF)
  g.textAlign = 'center'
  g.fillStyle = INK
  const lines = wrapLines(g, certBody(p), 820, 3)
  drawLines(g, lines, w / 2, 1308, 52)

  // ── 기록(1440~1560): 숫자 3칸 ──
  const boxes: [string, string][] = [
    ['누적 신도', `${num(p.fol)}명`],
    ['영향력', num(p.inf)],
    ['가상 코인', num(p.coins)],
  ]
  // 숫자칸은 왼쪽으로 몰고 오른쪽 끝에 직인 자리를 둔다
  const bw = 222
  const gap = 18
  const bx0 = 96
  for (const [i, [label, val]] of boxes.entries()) {
    const bx = bx0 + i * (bw + gap)
    sticker(g, bx, 1462, bw, 118, 22, PAPER, 6)
    fitText(g, label, bx + bw / 2, 1502, bw - 30, 28, { weight: 800, fill: INK_SOFT })
    fitText(g, val, bx + bw / 2, 1556, bw - 30, 48, { weight: 900, fill: INK, min: 26 })
  }
  // 직인(오른쪽, 숫자칸 옆에 반쯤 걸치게 — 장난스럽게 삐뚤게)
  stamp(g, w - 168, 1515, 98, '허구', '효력 없음', -0.26)

  // ── 특이사항(1600~1660) ──
  fitText(g, `특이사항: ${selfRoast(p.stats)}`, w / 2, 1640, 880, 40, { weight: 900, fill: deep, min: 24 })
  fitText(g, `발급일 ${d.y}년 ${d.m}월 ${d.d}일 · 발급처: 길바닥 셀프 발급 창구`, w / 2, 1692, 880, 28, { weight: 700, fill: INK_SOFT, min: 18 })

  // ── 푸터(링크 스티커 자리 위) ──
  footer(g, w, 1772, env.host, INK, 30)
  return c
}

/** 교단색 위 글자색(먹색/흰색) */
function tintInk(n: number): string {
  const r = (n >> 16) & 255
  const gg = (n >> 8) & 255
  const b = n & 255
  return (0.299 * r + 0.587 * gg + 0.114 * b) / 255 > 0.58 ? INK : '#ffffff'
}

// ───────────────────────── 2. 오늘의 포교 결산 ─────────────────────────

export function drawSummary(p: ShareProfile, s: SessionNumbers, portrait: HTMLCanvasElement | null, env: CardEnv): HTMLCanvasElement {
  const { w, h } = CARD_SIZE.summary
  const { c, g } = getCardCanvas(w, h)
  const col = cultColors(p.cult)
  const verdict = judge(s)

  // 배경: 노란 전단지 + 보라 물방울 무늬
  g.fillStyle = '#ffd23f'
  g.fillRect(0, 0, w, h)
  g.save()
  g.fillStyle = 'rgba(123,92,255,0.13)'
  for (let y = 0; y < h; y += 64) {
    for (let x = (y / 64) % 2 ? 32 : 0; x < w; x += 64) {
      g.beginPath()
      g.arc(x, y, 9, 0, Math.PI * 2)
      g.fill()
    }
  }
  g.restore()

  // 제목(260~420)
  const d = ymd(env.date)
  sticker(g, 110, 240, w - 220, 190, 32, '#7b5cff', 10)
  fitText(g, '오늘의 포교 결산', w / 2, 345, w - 300, 96, { weight: 900, fill: '#ffffff', stroke: INK, strokeW: 12 })
  fitText(g, `${d.y}. ${d.m}. ${d.d}. · ${p.name} · 플레이 ${num(s.minutes)}분`, w / 2, 405, w - 300, 34, { weight: 800, fill: '#fff4c2' })

  // 숫자판(460~900): 2열 × 3행
  const rate = successRate(s)
  const cells: [string, string, string][] = [
    ['🗣️', '말 건 사람', `${num(s.talks)}명`],
    ['🙏', '합류', `${num(s.joins)}명`],
    ['🙅', '거절', `${num(s.rejects)}회`],
    ['💨', '도망', `${num(s.flees)}명`],
    ['🌧️', '최고 연속 실패', `${num(s.worstFail)}연패`],
    ['🎯', '성공률', s.joins + s.rejects > 0 ? `${Math.round(rate * 100)}%` : '측정 불가'],
  ]
  const cw = 400
  const ch = 132
  const cx0 = (w - cw * 2 - 30) / 2
  for (const [i, [ic, label, val]] of cells.entries()) {
    const x = cx0 + (i % 2) * (cw + 30)
    const y = 470 + Math.floor(i / 2) * (ch + 24)
    sticker(g, x, y, cw, ch, 26, PAPER, 7)
    emoji(g, ic, x + 62, y + ch / 2, 62)
    fitText(g, label, x + 118, y + 52, cw - 140, 30, { weight: 800, fill: INK_SOFT, align: 'left' })
    fitText(g, val, x + 118, y + 108, cw - 140, 54, { weight: 900, fill: INK, align: 'left', min: 28 })
  }

  // 판정(950~1560)
  const vy = 960
  sticker(g, 90, vy, w - 180, 600, 40, '#ffffff', 12)
  fitText(g, '오늘 당신의 교주 유형은…', w / 2, vy + 78, w - 280, 40, { weight: 800, fill: INK_SOFT })
  emoji(g, verdict.icon, w / 2, vy + 175, 124)
  fitText(g, verdict.name, w / 2, vy + 335, w - 260, 96, { weight: 900, fill: hexColor(0x5a3fe0), stroke: '#ffe066', strokeW: 16, min: 54 })
  g.font = font(800, 40, SANS)
  g.fillStyle = INK
  g.textAlign = 'center'
  let ty = drawLines(g, wrapLines(g, verdict.roast, w - 300, 2), w / 2, vy + 418, 52)
  g.font = font(700, 34, SANS)
  g.fillStyle = INK_SOFT
  ty = drawLines(g, wrapLines(g, `위로의 말: ${verdict.comfort}`, w - 300, 2), w / 2, ty + 16, 44)
  void ty

  // 작은 초상(판정 상자 왼쪽 위에 스티커처럼)
  if (portrait) {
    g.save()
    g.translate(150, vy + 40)
    g.rotate(-0.12)
    g.fillStyle = hexColor(col.main)
    g.strokeStyle = INK
    g.lineWidth = 6
    g.beginPath()
    g.arc(0, 0, 92, 0, Math.PI * 2)
    g.fill()
    g.stroke()
    g.beginPath()
    g.arc(0, 0, 88, 0, Math.PI * 2)
    g.clip()
    g.drawImage(portrait, -100, -96, 200, 200)
    g.restore()
  }
  stamp(g, w - 170, vy + 40, 86, '허구', '효력 없음', 0.2)

  // 한 줄 자랑(1600~1660)
  const rk = rankName(p.rank)
  const cultName = p.cult ? `「${p.cult.name}」 ` : ''
  fitText(g, `${cultName}${rk} · 누적 신도 ${num(p.fol)}명`, w / 2, 1630, w - 200, 38, { weight: 900, fill: INK, min: 22 })

  footer(g, w, 1760, env.host, INK, 30)
  return c
}

// ───────────────────────── 3. 거절 짤 ─────────────────────────

export interface MemeInput {
  /** 캡처해 둔 게임 화면(없으면 빈 거리 배경) */
  shot: HTMLCanvasElement | null
  /** 자막: 마지막으로 들은 거절 대사 */
  line: string
  /** 말한 시민 이름(없으면 '') */
  who: string
  /** 결과 종류(no/flee/ignore) */
  kind: string
}

const MEME_TAG: Record<string, string> = {
  no: '포교 실패 현장',
  flee: '시민 긴급 대피 현장',
  ignore: '투명인간 체험 현장',
}

export function drawMeme(m: MemeInput, playerName: string, env: CardEnv): HTMLCanvasElement {
  const { w, h } = CARD_SIZE.meme
  const { c, g } = getCardCanvas(w, h)
  if (m.shot && m.shot.width > 0 && m.shot.height > 0) {
    // 가운데를 정사각형으로 자른다
    const sw = m.shot.width
    const sh = m.shot.height
    const side = Math.min(sw, sh)
    g.imageSmoothingQuality = 'high'
    g.drawImage(m.shot, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, w, h)
  } else {
    const grd = g.createLinearGradient(0, 0, 0, h)
    grd.addColorStop(0, '#bfe3f2')
    grd.addColorStop(1, '#8fa3b8')
    g.fillStyle = grd
    g.fillRect(0, 0, w, h)
    emoji(g, '🚶', w / 2, h * 0.45, 260, 0.6)
  }
  // 자막이 잘 읽히게 아래쪽을 어둡게
  const fade = g.createLinearGradient(0, h * 0.5, 0, h)
  fade.addColorStop(0, 'rgba(0,0,0,0)')
  fade.addColorStop(1, 'rgba(0,0,0,0.62)')
  g.fillStyle = fade
  g.fillRect(0, h * 0.5, w, h * 0.5)

  // 왼쪽 위 예능 꼬리표
  const tag = MEME_TAG[m.kind] ?? '포교 실패 현장'
  g.font = font(900, 40, SANS)
  const tw = g.measureText(tag).width + 70
  g.save()
  g.translate(40, 44)
  g.rotate(-0.04)
  sticker(g, 0, 0, tw, 76, 18, '#ff5d5d', 6)
  fitText(g, tag, tw / 2, 52, tw - 40, 40, { weight: 900, fill: '#ffffff' })
  g.restore()
  // 오른쪽 위: 플레이어 이름 + 상황 설명(놀림은 플레이어에게)
  fitText(g, `교주 지망생 ${playerName}`, w - 44, 96, 520, 34, { weight: 900, fill: '#ffffff', align: 'right', stroke: INK, strokeW: 8, min: 20 })

  // 예능 자막: 노란 글씨 + 굵은 먹색 외곽선
  const said = m.line.trim()
  const who = m.who ? `${m.who}: ` : ''
  const text = said ? `${who}"${said}"` : '(아직 거절당하지 않았다. 곧 당할 예정)'
  g.font = font(900, 64, SANS)
  const lines = wrapLines(g, text, w - 120, 3)
  const lh = 80
  let y = h - 150 - (lines.length - 1) * lh
  for (const l of lines) {
    fitText(g, l, w / 2, y, w - 100, 64, { weight: 900, fill: '#ffe14d', stroke: INK, strokeW: 16, min: 36 })
    y += lh
  }
  // 작은 워터마크 + 고지
  g.save()
  g.globalAlpha = 0.9
  fitText(g, `🙏 ${env.host} · 도를 아십니까?`, w - 30, h - 58, 560, 26, { weight: 800, fill: '#ffffff', align: 'right', stroke: 'rgba(0,0,0,0.6)', strokeW: 6 })
  g.restore()
  fitText(g, FOOTER_TEXT, w / 2, h - 20, w - 60, 24, {
    weight: 700,
    fill: '#ffffff',
    stroke: 'rgba(0,0,0,0.6)',
    strokeW: 6,
  })
  return c
}

