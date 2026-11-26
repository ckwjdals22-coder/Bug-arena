/**
 * 간판 아틀라스: 거리의 모든 글자 간판을 캔버스 한 장에 그려 CanvasTexture 하나로 쓴다.
 *
 * 왜 한 장인가: 간판마다 텍스처를 만들면 드로콜과 메모리가 간판 수만큼 늘어난다.
 * 한 장에 모으면 간판이 몇 개든 드로콜 1번이고, 낮은 품질에서는 해상도만 절반으로 줄이면 된다.
 *
 * 쓰는 순서: sign()/custom() 으로 칸을 예약(크기만 결정) → bake() 가 자리를 잡고 실제로 그린다.
 * UV 는 bake 뒤에야 정해지므로, 간판 사각형은 later() 로 미뤘다가 bake 다음에 만든다.
 */
import * as THREE from 'three'
import type { SignDef, SignIcon } from '../../../../shared/world/data'
import type { AtlasRect } from './geo'

/** 시스템 한글 글꼴(외부 폰트 파일 금지) */
const FONT = `'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif`
/** 칸 사이 여백(1024 기준 px). 밉맵에서 옆 간판 색이 번지지 않게 한다 */
const GUTTER = 3
/** 흰 점 구역 높이(1024 기준 px) */
const WHITE_BLOCK = 28

type Ctx2D = CanvasRenderingContext2D
type Painter = (g: Ctx2D, x: number, y: number, w: number, h: number) => void

interface Slot {
  /** 1024 기준 설계 크기 */
  w: number
  h: number
  paint: Painter
  rect: AtlasRect
  // 배치 결과(px)
  px: number
  py: number
  pw: number
  ph: number
}

const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`

function mixHex(a: number, b: number, t: number): string {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `rgb(${r},${g},${bl})`
}

export class SignAtlas {
  private readonly slots: Slot[] = []
  private readonly byKey = new Map<string, AtlasRect>()
  private readonly deferred: (() => void)[] = []
  /**
   * 무늬 없는 발광 면(창문 불빛, 전구)이 쓰는 흰 점 = UV (0,0).
   * UV 를 주지 않은 정점은 전부 (0,0)이 되므로, 아틀라스의 그 구석을 흰색으로 칠해 두면
   * "글자 없는 조명 없는 면"을 같은 재질·같은 드로콜로 그릴 수 있다.
   */
  readonly white: AtlasRect = { u0: 0, v0: 0, u1: 0, v1: 0 }
  texture: THREE.CanvasTexture | null = null
  fit = 1

  /** bake() 다음에 실행할 일(아틀라스 UV 가 필요한 사각형 만들기) */
  later(fn: () => void): void {
    this.deferred.push(fn)
  }

  /** 직접 그리는 칸. w,h 는 1024 아틀라스 기준 px */
  custom(key: string, w: number, h: number, paint: Painter): AtlasRect {
    const hit = this.byKey.get(key)
    if (hit) return hit
    const rect: AtlasRect = { u0: 0, v0: 0, u1: 1, v1: 1 }
    this.slots.push({ w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)), paint, rect, px: 0, py: 0, pw: 0, ph: 0 })
    this.byKey.set(key, rect)
    return rect
  }

  /**
   * 간판 한 장 예약. worldW/H(m)에 맞는 비율로, 가까이서 볼 것일수록 density(px/m)를 높게 준다.
   * 같은 내용·비율의 간판은 한 칸을 같이 쓴다.
   */
  sign(s: SignDef, worldW: number, worldH: number, density = 48): AtlasRect {
    // 너무 큰 칸이 아틀라스를 독차지하지 않도록 긴 변을 제한한다
    const long = Math.max(worldW, worldH)
    const d = Math.min(density, 420 / long)
    const w = worldW * d
    const h = worldH * d
    const key = `${s.text}|${s.sub ?? ''}|${s.bg}|${s.fg}|${s.icon ?? ''}|${s.vertical ? 'v' : 'h'}|${s.neon ? 'n' : ''}|${Math.round(w)}x${Math.round(h)}`
    return this.custom(key, w, h, (g, x, y, pw, ph) => paintSign(g, x, y, pw, ph, s))
  }

  /** 자리를 잡고 그린 뒤 텍스처를 만든다. size: 1024(보통) 또는 512(낮은 품질) */
  bake(size: number, anisotropy: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const g = canvas.getContext('2d')
    if (!g) throw new Error('2D 캔버스를 만들 수 없습니다')

    // 맨 아래 줄은 흰 점(UV 0,0) 몫으로 비워 둔다
    const reserve = Math.round((WHITE_BLOCK * size) / 1024)
    // 칸이 넘치면 전체를 조금씩 줄여 다시 담는다(간판을 더 넣어도 깨지지 않게)
    let k = size / 1024
    for (let tries = 0; tries < 40 && !this.pack(size, size - reserve, k); tries++) k *= 0.95
    /** 설계 크기 대비 실제로 담긴 배율(1 = 줄이지 않음). 간판을 늘릴 때 해상도 여유를 가늠하는 값 */
    this.fit = k / (size / 1024)

    g.fillStyle = '#2a2433'
    g.fillRect(0, 0, size, size)
    for (const s of this.slots) {
      g.save()
      s.paint(g, s.px, s.py, s.pw, s.ph)
      g.restore()
      s.rect.u0 = s.px / size
      s.rect.u1 = (s.px + s.pw) / size
      // 캔버스는 위가 0, 텍스처(flipY)는 아래가 0
      s.rect.v1 = 1 - s.py / size
      s.rect.v0 = 1 - (s.py + s.ph) / size
    }
    // 캔버스 왼쪽 아래 = UV (0,0)
    g.fillStyle = '#fff'
    g.fillRect(0, size - reserve, reserve * 2, reserve)

    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = anisotropy
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.needsUpdate = true
    this.texture = tex

    for (const fn of this.deferred) fn()
    this.deferred.length = 0
    return tex
  }

  /** 선반 채우기: 키 큰 순서로 왼쪽부터 놓고, 줄이 차면 다음 줄로 */
  private pack(size: number, height: number, k: number): boolean {
    const gut = Math.max(1, Math.round(GUTTER * k))
    const order = [...this.slots].sort((a, b) => b.h - a.h || b.w - a.w)
    let x = gut
    let y = gut
    let rowH = 0
    for (const s of order) {
      const pw = Math.max(4, Math.round(s.w * k))
      const ph = Math.max(4, Math.round(s.h * k))
      if (pw + gut * 2 > size) return false
      if (x + pw + gut > size) {
        x = gut
        y += rowH + gut * 2
        rowH = 0
      }
      if (y + ph + gut > height) return false
      s.px = x
      s.py = y
      s.pw = pw
      s.ph = ph
      x += pw + gut * 2
      if (ph > rowH) rowH = ph
    }
    return true
  }

  dispose(): void {
    this.texture?.dispose()
    this.texture = null
  }
}

// ───────────────────────── 간판 그리기 ─────────────────────────

function setFont(g: Ctx2D, px: number): void {
  g.font = `bold ${Math.max(6, px).toFixed(1)}px ${FONT}`
}

/** 폭에 맞게 글자 크기를 줄여 가운데 정렬로 그린다 */
function fitText(g: Ctx2D, text: string, cx: number, cy: number, maxW: number, px: number): number {
  setFont(g, px)
  const w = g.measureText(text).width
  let size = px
  if (w > maxW && w > 0) {
    size = (px * maxW) / w
    setFont(g, size)
  }
  g.fillText(text, cx, cy)
  return size
}

function paintSign(g: Ctx2D, x: number, y: number, w: number, h: number, s: SignDef): void {
  // 판(여백까지 칠해 밉맵 번짐을 같은 색으로 만든다)
  g.fillStyle = css(s.bg)
  g.fillRect(x - GUTTER, y - GUTTER, w + GUTTER * 2, h + GUTTER * 2)
  const short = Math.min(w, h)
  // 테두리
  const bw = Math.max(1, short * 0.045)
  g.strokeStyle = s.neon ? css(s.fg) : mixHex(s.bg, s.fg, 0.4)
  g.lineWidth = bw
  g.strokeRect(x + bw * 1.2, y + bw * 1.2, w - bw * 2.4, h - bw * 2.4)

  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = css(s.fg)
  if (s.neon) {
    g.shadowColor = css(s.fg)
    g.shadowBlur = short * 0.22
  }

  if (s.vertical) {
    paintVertical(g, x, y, w, h, s)
    return
  }

  const pad = short * 0.14
  let tx0 = x + pad
  const tx1 = x + w - pad
  if (s.icon) {
    const icon = Math.min(h * 0.66, w * 0.3)
    if (!s.text) {
      // 글자 없는 그림 간판
      drawIcon(g, s.icon, x + w / 2, y + h / 2, Math.min(w, h) * 0.8, s)
      return
    }
    drawIcon(g, s.icon, tx0 + icon / 2, y + h / 2, icon, s)
    tx0 += icon + pad * 0.6
  }
  const cx = (tx0 + tx1) / 2
  const availW = tx1 - tx0
  if (s.sub) {
    // 큰 글자 + 아래 작은 글자
    const main = fitText(g, s.text, cx, y + h * 0.4, availW, h * 0.46)
    g.shadowBlur = 0
    g.globalAlpha = 0.9
    fitText(g, s.sub, cx, y + h * 0.4 + main * 0.5 + h * 0.17, availW, Math.min(h * 0.2, main * 0.5))
    g.globalAlpha = 1
  } else {
    fitText(g, s.text, cx, y + h * 0.52, availW, h * 0.6)
  }
  if (s.neon) {
    // 네온관 속심: 밝은 색으로 한 번 더
    g.shadowBlur = 0
    g.fillStyle = mixHex(s.fg, 0xffffff, 0.6)
    g.globalAlpha = 0.55
    if (!s.sub) fitText(g, s.text, cx, y + h * 0.52, availW, h * 0.6)
    g.globalAlpha = 1
  }
}

function paintVertical(g: Ctx2D, x: number, y: number, w: number, h: number, s: SignDef): void {
  const chars = [...s.text.replace(/\s+/g, '')]
  const pad = w * 0.12
  let top = y + pad
  if (s.icon) {
    const icon = w * 0.72
    drawIcon(g, s.icon, x + w / 2, top + icon / 2, icon, s)
    top += icon + pad * 0.5
  }
  const cell = (y + h - pad - top) / Math.max(1, chars.length)
  const px = Math.min(w * 0.74, cell * 0.92)
  setFont(g, px)
  chars.forEach((ch, i) => {
    g.fillText(ch, x + w / 2, top + cell * (i + 0.5))
  })
}

/** 간판 그림 문양. (cx,cy) 중심, 한 변 size 인 칸 안에 그린다 */
function drawIcon(g: Ctx2D, icon: SignIcon, cx: number, cy: number, size: number, s: SignDef): void {
  const r = size / 2
  const fg = css(s.fg)
  g.save()
  g.lineJoin = 'round'
  g.lineCap = 'round'
  switch (icon) {
    case 'eye': {
      // 아몬드 모양 눈 + 눈동자 + 속눈썹 세 가닥
      g.lineWidth = Math.max(1.5, size * 0.07)
      g.strokeStyle = fg
      g.beginPath()
      g.moveTo(cx - r, cy)
      g.quadraticCurveTo(cx, cy - r * 0.95, cx + r, cy)
      g.quadraticCurveTo(cx, cy + r * 0.95, cx - r, cy)
      g.closePath()
      g.stroke()
      g.fillStyle = fg
      g.beginPath()
      g.arc(cx, cy, r * 0.34, 0, Math.PI * 2)
      g.fill()
      g.shadowBlur = 0
      g.fillStyle = css(s.bg)
      g.beginPath()
      g.arc(cx, cy, r * 0.14, 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = fg
      for (const dx of [-0.45, 0, 0.45]) {
        g.beginPath()
        g.moveTo(cx + dx * r, cy - r * (0.62 - Math.abs(dx) * 0.35))
        g.lineTo(cx + dx * r * 1.25, cy - r * (0.98 - Math.abs(dx) * 0.4))
        g.stroke()
      }
      break
    }
    case 'eyes': {
      // 어두운 천막 안에서 빛나는 두 눈
      g.fillStyle = fg
      g.shadowColor = fg
      g.shadowBlur = size * 0.12
      for (const dx of [-0.42, 0.42]) {
        g.beginPath()
        g.ellipse(cx + dx * r, cy - r * 0.1, r * 0.26, r * 0.16, dx < 0 ? 0.18 : -0.18, 0, Math.PI * 2)
        g.fill()
      }
      g.shadowBlur = 0
      g.fillStyle = css(s.bg)
      for (const dx of [-0.42, 0.42]) {
        g.beginPath()
        g.ellipse(cx + dx * r, cy - r * 0.1, r * 0.05, r * 0.13, 0, 0, Math.PI * 2)
        g.fill()
      }
      break
    }
    case 'arrowL':
    case 'arrowR': {
      const d = icon === 'arrowL' ? -1 : 1
      g.fillStyle = fg
      g.beginPath()
      g.moveTo(cx + d * r * 0.95, cy)
      g.lineTo(cx + d * r * 0.1, cy - r * 0.75)
      g.lineTo(cx + d * r * 0.1, cy - r * 0.3)
      g.lineTo(cx - d * r * 0.9, cy - r * 0.3)
      g.lineTo(cx - d * r * 0.9, cy + r * 0.3)
      g.lineTo(cx + d * r * 0.1, cy + r * 0.3)
      g.lineTo(cx + d * r * 0.1, cy + r * 0.75)
      g.closePath()
      g.fill()
      break
    }
    case 'note': {
      g.fillStyle = fg
      g.strokeStyle = fg
      g.lineWidth = Math.max(1.5, size * 0.09)
      g.beginPath()
      g.ellipse(cx - r * 0.25, cy + r * 0.5, r * 0.34, r * 0.26, -0.4, 0, Math.PI * 2)
      g.fill()
      g.beginPath()
      g.moveTo(cx + r * 0.05, cy + r * 0.45)
      g.lineTo(cx + r * 0.05, cy - r * 0.75)
      g.lineTo(cx + r * 0.6, cy - r * 0.45)
      g.stroke()
      break
    }
    case 'fish': {
      // 붕어빵: 통통한 몸 + 꼬리 + 비늘 줄
      g.fillStyle = '#c9772b'
      g.beginPath()
      g.ellipse(cx - r * 0.12, cy, r * 0.7, r * 0.45, 0, 0, Math.PI * 2)
      g.fill()
      g.beginPath()
      g.moveTo(cx + r * 0.45, cy)
      g.lineTo(cx + r * 0.98, cy - r * 0.5)
      g.lineTo(cx + r * 0.98, cy + r * 0.5)
      g.closePath()
      g.fill()
      g.fillStyle = '#5a2d0c'
      g.beginPath()
      g.arc(cx - r * 0.5, cy - r * 0.1, r * 0.09, 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = '#8a4a16'
      g.lineWidth = Math.max(1, size * 0.04)
      for (const dx of [-0.15, 0.12]) {
        g.beginPath()
        g.arc(cx + dx * r, cy, r * 0.3, -0.9, 0.9)
        g.stroke()
      }
      break
    }
    case 'cross': {
      g.fillStyle = fg
      g.fillRect(cx - r * 0.28, cy - r * 0.85, r * 0.56, r * 1.7)
      g.fillRect(cx - r * 0.85, cy - r * 0.28, r * 1.7, r * 0.56)
      break
    }
    case 'star': {
      g.fillStyle = fg
      g.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const rr = i % 2 === 0 ? r * 0.95 : r * 0.42
        const px = cx + Math.cos(a) * rr
        const py = cy + Math.sin(a) * rr
        if (i === 0) g.moveTo(px, py)
        else g.lineTo(px, py)
      }
      g.closePath()
      g.fill()
      break
    }
    case 'num4': {
      // 지하철 출구 번호: 노란 원 안의 4
      g.shadowBlur = 0
      g.fillStyle = '#f2c230'
      g.beginPath()
      g.arc(cx, cy, r * 0.92, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#23262e'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      setFont(g, size * 0.78)
      g.fillText('4', cx, cy + size * 0.04)
      break
    }
    case 'ball': {
      g.fillStyle = '#f4f1e6'
      g.beginPath()
      g.arc(cx, cy, r * 0.9, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#d23c3c'
      g.beginPath()
      g.arc(cx, cy, r * 0.5, 0, Math.PI * 2)
      g.fill()
      break
    }
    case 'cans': {
      // 자판기 진열: 색색 캔 3줄
      const cols = ['#e2483a', '#3a8fd8', '#f2c230', '#5cb86a', '#f08a3c', '#8a6bd8']
      const n = 4
      const cw = (size * 0.9) / n
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < n; i++) {
          g.fillStyle = cols[(row * 2 + i) % cols.length]!
          g.fillRect(cx - size * 0.45 + i * cw + cw * 0.18, cy - size * 0.45 + row * size * 0.31 + size * 0.04, cw * 0.64, size * 0.22)
        }
      }
      break
    }
  }
  g.restore()
}
