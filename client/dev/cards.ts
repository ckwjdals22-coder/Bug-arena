/**
 * 공유 카드 미리보기 하네스: 가짜 프로필 여러 개로 카드 3종을 그려 본다(서버 없이).
 *
 *   /dev/cards.html
 *   window.__cards.png('certificate' | 'summary' | 'meme', profileIndex) → Promise<dataURL>
 *
 * 초상은 진짜 캐릭터 렌더러로 그려 보고, WebGL 이 없으면 단순한 자리표시 그림을 쓴다.
 */
import { defaultLook } from '../../shared/rules/progress'
import type { CultRef, Look } from '../../shared/types'
import type { CharacterRendererApi } from '../src/core/contracts'
import { createCharacterRenderer } from '../src/render/characters'
import { createEngine } from '../src/render/engine'
import { sessionDiff, type SessionNumbers, type ShareProfile } from '../src/share/data'
import { renderCard, type CardType, type MemeInput } from '../src/share/index'
import { placeholderPortrait } from '../src/share/kit'

interface Fake {
  label: string
  profile: ShareProfile
  session: SessionNumbers
  meme: MemeInput
}

const cult = (over: Partial<CultRef>): CultRef => ({
  id: 'c1',
  name: '라면교',
  color: 1,
  emblem: 0,
  role: 'leader',
  title: '면발의 인도자',
  leaderName: '라면왕김씨',
  ...over,
})

const lookOf = (seed: number, over: Partial<Record<number, number>> = {}): Look => {
  const l = defaultLook(seed).slice() as Look
  for (const [k, v] of Object.entries(over)) l[Number(k)] = v as number
  return l
}

const S = (o: Partial<SessionNumbers>): SessionNumbers => ({ ...sessionDiff({}, {}, 0, 0), ...o })

const FAKES: Fake[] = [
  {
    label: '직급 0 · 신도 0 · 무소속',
    profile: { pid: 'p-zero', name: '수상한행인', look: lookOf(1), rank: 0, fol: 0, inf: 0, coins: 0, cult: null, stats: {}, tagName: '' },
    session: S({ minutes: 3 }),
    meme: { shot: null, line: '', who: '', kind: 'no' },
  },
  {
    label: '중간 직급 교주',
    profile: {
      pid: 'p-mid',
      name: '라면왕김씨',
      look: lookOf(7, { 1: 3, 3: 2 }),
      rank: 3,
      fol: 42,
      inf: 512,
      coins: 230,
      cult: cult({}),
      stats: { talks: 140, rejects: 96, flees: 21, ignores: 30, kings: 2, worstStreak: 6, joins: 42, dances: 12 },
      tagName: '거절 수집가',
    },
    session: S({ talks: 22, pitches: 24, joins: 1, rejects: 14, flees: 3, ignores: 4, worstFail: 6, minutes: 27 }),
    meme: { shot: null, line: '아 제가 지금 버스를 타야 돼서요…', who: '퇴근길 김대리', kind: 'no' },
  },
  {
    label: '직급 5 · 최대 길이 이름',
    profile: {
      pid: 'p-max',
      name: '우주최강절대교주님짱',
      look: lookOf(13, { 1: 9, 3: 10, 6: 4 }),
      rank: 5,
      fol: 12873,
      inf: 98765,
      coins: 54321,
      cult: cult({ name: '월요병완전정복구원회본부', color: 6, emblem: 6, title: '안드로메다총대사' }),
      stats: { talks: 30000, rejects: 9999, flees: 2400, kings: 88, catTalks: 120, caught: 30 },
      tagName: '숨만 쉬어도 신도',
    },
    session: S({ talks: 40, pitches: 45, joins: 31, rejects: 9, flees: 1, kings: 1, worstFail: 2, minutes: 95 }),
    meme: {
      shot: null,
      line: '죄송한데 저 지금 진짜 급해서 그런데 다음에 다시 얘기해 주시면 안 될까요 정말 죄송합니다',
      who: '헬스장 가는 근육맨 박씨',
      kind: 'flee',
    },
  },
  {
    label: '남의 교단 신도',
    profile: {
      pid: 'p-member',
      name: '졸린신도',
      look: lookOf(21),
      rank: 1,
      fol: 3,
      inf: 45,
      coins: 12,
      cult: cult({ role: 'member', title: '신도', color: 4, emblem: 3, name: '만성피로 구원단', leaderName: '잠만보교주' }),
      stats: { talks: 18, rejects: 15, flees: 9, dances: 40 },
      tagName: '',
    },
    session: S({ talks: 9, pitches: 9, joins: 1, rejects: 8, flees: 6, dances: 3, worstFail: 4, minutes: 12 }),
    meme: { shot: null, line: '…', who: '이어폰 낀 대학생', kind: 'ignore' },
  },
]

// 진짜 초상(가능하면)
let chars: CharacterRendererApi | null = null
try {
  const canvas = document.getElementById('engine') as HTMLCanvasElement
  const engine = createEngine(canvas, 'mid')
  chars = createCharacterRenderer(engine)
} catch (err) {
  console.warn('[cards] 캐릭터 렌더러 없음 → 자리표시 초상', err)
}
function portraitOf(look: Look): HTMLCanvasElement {
  try {
    if (chars) return chars.portrait(look, 640)
  } catch (err) {
    console.warn('[cards] portrait 실패', err)
  }
  return placeholderPortrait(640)
}

/** 게임 화면 대신 쓸 가짜 장면(16:9) */
function fakeShot(seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 1280
  c.height = 720
  const g = c.getContext('2d')!
  const grd = g.createLinearGradient(0, 0, 0, 720)
  grd.addColorStop(0, '#9fd3f0')
  grd.addColorStop(0.55, '#e8dcc0')
  grd.addColorStop(1, '#b9a98c')
  g.fillStyle = grd
  g.fillRect(0, 0, 1280, 720)
  g.fillStyle = '#7d8a99'
  for (let i = 0; i < 8; i++) g.fillRect(i * 170 + ((seed * 37) % 60), 120 + (i % 3) * 30, 120, 300)
  const p = placeholderPortrait(260, 0x7b5cff)
  g.drawImage(p, 420, 330)
  g.drawImage(placeholderPortrait(220, 0x6cc070), 700, 360)
  return c
}

const ENV = (): { host: string; date: Date } => ({ host: location.host || 'localhost', date: new Date(2026, 10, 26) })

function draw(type: CardType, i: number): HTMLCanvasElement {
  const f = FAKES[Math.max(0, Math.min(FAKES.length - 1, i))]!
  const t0 = performance.now()
  const c = renderCard({
    type,
    profile: f.profile,
    session: f.session,
    portrait: type === 'meme' ? null : portraitOf(f.profile.look),
    meme: { ...f.meme, shot: i === 0 ? null : fakeShot(i) },
    env: ENV(),
  })
  console.info(`[cards] ${type}#${i} ${(performance.now() - t0).toFixed(1)}ms`)
  return c
}

const api = {
  count: FAKES.length,
  labels: FAKES.map((f) => f.label),
  async png(type: CardType, i: number): Promise<string> {
    return draw(type, i).toDataURL('image/png')
  },
  /** 렌더 시간(ms) — 초상 캐시가 데워진 뒤 측정 */
  time(type: CardType, i: number): number {
    const t0 = performance.now()
    draw(type, i)
    return performance.now() - t0
  },
}
;(window as unknown as { __cards: typeof api }).__cards = api

const grid = document.getElementById('grid')!
for (const type of ['certificate', 'summary', 'meme'] as const) {
  for (const [i, f] of FAKES.entries()) {
    const fig = document.createElement('figure')
    const img = document.createElement('img')
    img.src = draw(type, i).toDataURL('image/png')
    const cap = document.createElement('figcaption')
    cap.textContent = `${type} · ${f.label}`
    fig.append(img, cap)
    grid.append(fig)
  }
}
