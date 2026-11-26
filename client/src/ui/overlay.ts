/**
 * DOM 오버레이: 이름표 / 말풍선 / 떠오르는 글자. 3D 위에 engine.project() 로 자리를 잡는다.
 *
 * 성능 규칙(매 프레임 불린다)
 *  - 위치는 transform(translate3d) 으로만 옮긴다. update() 안에서는 레이아웃을 읽지 않는다.
 *    가운데·위 정렬은 translate(-50%, -100%) 로, 말풍선 높이는 고정 px 로 해결한다.
 *  - DOM 노드는 풀에서 꺼내 재사용한다. 값이 안 바뀌면 style 을 다시 쓰지 않는다.
 *  - "누구의 이름표를 보여 줄지 / 글자 내용 / 말풍선 우선순위"는 0.1초에 한 번만 다시 정한다.
 *
 * 가짜 멀티플레이 금지 원칙: NPC 이름표에는 항상 회색 'NPC' 표시가 붙고, 실제 접속자와 모양이 다르다.
 */
import './overlay.css'
import { NPC_KEY_BASE, isNpcKey, npcKey } from '../../../shared/constants'
import { CULT_COLORS, CULT_EMBLEMS } from '../../../shared/content/core'
import { PITCH_LINES } from '../../../shared/content/lines'
import { QUICK_CHATS } from '../../../shared/content/misc'
import { NpcModel } from '../../../shared/types'
import type { Bus } from '../core/bus'
import type { BubbleKind, EngineApi, OverlayApi } from '../core/contracts'
import type { EntityView, MeView, Store } from '../core/store'
import { ACHIEVEMENT_BY_ID } from '../../../shared/content/achievements'
import { inkOn, rankName } from './hud'
import { h, hex } from './kit'

/** 머리 위 높이(m) */
const HEAD_HUMAN = 1.75
const HEAD_CAT = 0.8
const HEAD_BIRD = 0.55

/** 접속자 이름표: 이 거리부터 흐려지고, 이 거리 밖은 숨긴다 */
const PLAYER_FADE_FROM = 16
const PLAYER_FAR = 40
/** NPC 이름표: 가까이 갔을 때만 */
const NPC_FADE_FROM = 7.2
const NPC_NEAR = 9
const MAX_NPC_TAGS = 10
/** 폰처럼 좁은 화면은 이름표끼리 겹치기 쉽다 → 더 가까운 것만 */
const MAX_NPC_TAGS_NARROW = 6
const NARROW_PX = 560
const MAX_BUBBLES = 8
const PICK_MS = 100

/** 이름표 높이(px) — CSS 의 고정 높이와 맞춘 값. 말풍선을 이름표 위에 얹을 때 쓴다(레이아웃을 읽지 않기 위해) */
const TAG_H1 = 27
const TAG_H2 = 48
const POP_RISE = 58
const POP_MS = 1400
/** 연달아 뜨는 글자 사이 간격(px) */
const POP_GAP = 34
/** 말풍선 한두 줄의 대략적인 높이(px) — 보상 글자를 내 말풍선 위에서 띄우기 위한 어림값 */
const BUBBLE_H = 58

interface Tag {
  key: number
  npc: boolean
  head: number
  el: HTMLDivElement
  cult: HTMLDivElement
  main: HTMLDivElement
  sig: string
  lines: 1 | 2
  x: number
  y: number
  op: number
  z: number
  shown: boolean
}

interface Bubble {
  key: number
  el: HTMLDivElement
  body: HTMLDivElement
  until: number
  /** 사라지는 중이면 풀로 돌려보낼 시각, 아니면 0 */
  dying: number
  ranked: boolean
  d2: number
  x: number
  y: number
  shown: boolean
}

interface Pop {
  el: HTMLDivElement
  body: HTMLSpanElement
  x: number
  y: number
  z: number
  born: number
  start: number
  stack: number
  /** 기준점에서 위로 띄우는 고정 px(이름표·말풍선을 피해 올린다) */
  lift: number
  px: number
  py: number
  shown: boolean
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function createOverlay(root: HTMLElement, store: Store, bus: Bus, engine: EngineApi): OverlayApi {
  const layer = h('div.overlay-layer', { 'aria-hidden': 'true' })
  root.append(layer)

  const pt = { x: 0, y: 0 }
  /** true 면 다음 프레임에 "누구를 보여 줄지"를 바로 다시 정한다 */
  let dirty = true

  function entity(key: number): EntityView | null {
    const me = store.me
    if (me && key === me.id) return me
    if (isNpcKey(key)) return store.npcs.get(key - NPC_KEY_BASE) ?? null
    return store.players.get(key) ?? null
  }

  function headOf(key: number): number {
    if (!isNpcKey(key)) return HEAD_HUMAN
    const model = store.npcs.get(key - NPC_KEY_BASE)?.pub.model
    return model === NpcModel.Cat ? HEAD_CAT : model === NpcModel.Pigeon ? HEAD_BIRD : HEAD_HUMAN
  }

  // ═════════════ 이름표 ═════════════
  const tags = new Map<number, Tag>()
  const tagList: Tag[] = []
  const freeTags: Tag[] = []

  function acquireTag(key: number): Tag {
    let tag = freeTags.pop()
    if (!tag) {
      const cult = h('div.overlay-cult')
      const main = h('div.overlay-main')
      const el = h('div.overlay-tag.off', cult, main)
      layer.append(el)
      tag = { key: 0, npc: false, head: HEAD_HUMAN, el, cult, main, sig: '', lines: 1, x: NaN, y: NaN, op: -1, z: -1, shown: false }
    }
    tag.key = key
    tag.npc = isNpcKey(key)
    tag.head = headOf(key)
    tag.sig = ''
    tag.x = NaN
    tag.y = NaN
    tags.set(key, tag)
    tagList.push(tag)
    return tag
  }

  function hideTag(tag: Tag): void {
    if (!tag.shown) return
    tag.shown = false
    tag.el.classList.add('off')
  }

  function releaseTag(tag: Tag): void {
    hideTag(tag)
    tags.delete(tag.key)
    const i = tagList.indexOf(tag)
    if (i >= 0) tagList.splice(i, 1)
    tag.key = 0
    freeTags.push(tag)
  }

  function fillPlayerTag(tag: Tag, me: MeView): void {
    const isMe = tag.key === me.id
    const pub = isMe ? null : store.players.get(tag.key)?.pub
    const name = isMe ? store.profile.name : (pub?.name ?? '')
    const rank = isMe ? me.prog.rank : (pub?.rank ?? 0)
    const cult = isMe ? me.prog.cult : (pub?.cult ?? null)
    // 칭호 = 본인이 고른 업적 이름("철벽 앞의 수행자 · 길거리 전도사"). 없는 id 는 무시한다
    const tagId = isMe ? (me.prog.tag ?? '') : (pub?.tag ?? '')
    const title = tagId ? (ACHIEVEMENT_BY_ID.get(tagId)?.name ?? '') : ''
    const sig = `p${isMe ? 1 : 0}|${name}|${rank}|${title}|${cult ? `${cult.id}|${cult.name}|${cult.color}|${cult.emblem}|${cult.title}` : ''}`
    if (sig === tag.sig) return
    tag.sig = sig
    tag.lines = cult ? 2 : 1
    tag.el.className = 'overlay-tag' + (isMe ? ' me' : '') + (tag.shown ? '' : ' off')
    if (cult) {
      const color = CULT_COLORS[cult.color] ?? 0x7b5cff
      tag.cult.style.background = hex(color)
      tag.cult.style.color = inkOn(color)
      // 교단 이름·칭호는 다른 사람이 지은 글자다 → textContent 로만 넣는다
      tag.cult.textContent = `${CULT_EMBLEMS[cult.emblem] ?? '🚩'} ${cult.name} · ${cult.title}`
    }
    tag.cult.classList.toggle('hidden', !cult)
    tag.main.replaceChildren(...(isMe ? [h('span.overlay-me', '나')] : []), h('span.overlay-name', name), h('span.overlay-rank', title ? `${title} · ${rankName(rank)}` : rankName(rank)))
  }

  function fillNpcTag(tag: Tag, me: MeView): void {
    const pub = store.npcs.get(tag.key - NPC_KEY_BASE)?.pub
    if (!pub) return
    const owner = pub.owner
    const ownerName = owner ? (owner === me.id ? '' : store.nameOf(owner)) : ''
    const sig = `n|${pub.name}|${owner}|${ownerName}|${pub.role}|${pub.model}`
    if (sig === tag.sig) return
    tag.sig = sig
    tag.lines = 1
    tag.head = headOf(tag.key)
    tag.el.className = 'overlay-tag npc' + (owner ? ' follower' : '') + (owner === me.id ? ' mine' : '') + (tag.shown ? '' : ' off')
    tag.cult.classList.add('hidden')
    // 신도가 된 NPC 는 누구를 따르는지 보여 준다. 그 밖에는 언제나 'NPC' 표시
    const badge = owner ? (owner === me.id ? '내 신도' : `${ownerName}의 신도`) : 'NPC'
    tag.main.replaceChildren(h('span.overlay-name', pub.name), h('span.overlay-npc', badge))
  }

  // 가까운 NPC 고르기용 작업 배열(매번 새로 만들지 않는다)
  const nearIds: number[] = []
  const nearD2: number[] = []
  const want = new Set<number>()
  // 화면 폭은 크기가 바뀔 때만 읽는다(update 안에서는 레이아웃/창 크기를 읽지 않는다)
  let npcCap = MAX_NPC_TAGS
  const measure = (): void => {
    npcCap = Math.min(window.innerWidth, window.innerHeight) < NARROW_PX ? MAX_NPC_TAGS_NARROW : MAX_NPC_TAGS
    dirty = true
  }
  window.addEventListener('resize', measure)

  function pickVisible(me: MeView): void {
    want.clear()
    want.add(me.id)
    const showAll = store.profile.settings.showNames !== false
    const maxP2 = showAll ? PLAYER_FAR * PLAYER_FAR : NPC_NEAR * NPC_NEAR
    store.players.forEach((p, id) => {
      const dx = p.x - me.x
      const dz = p.z - me.z
      if (dx * dx + dz * dz <= maxP2) want.add(id)
    })

    nearIds.length = 0
    nearD2.length = 0
    store.npcs.forEach((n, id) => {
      const dx = n.x - me.x
      const dz = n.z - me.z
      const d2 = dx * dx + dz * dz
      if (d2 > NPC_NEAR * NPC_NEAR) return
      // 거리순 삽입(최대 10개만 유지)
      let i = nearIds.length
      while (i > 0 && nearD2[i - 1]! > d2) i--
      if (i >= npcCap) return
      nearIds.splice(i, 0, id)
      nearD2.splice(i, 0, d2)
      if (nearIds.length > npcCap) {
        nearIds.length = npcCap
        nearD2.length = npcCap
      }
    })
    for (let i = 0; i < nearIds.length; i++) want.add(npcKey(nearIds[i]!))

    for (let i = tagList.length - 1; i >= 0; i--) {
      const tag = tagList[i]!
      if (!want.has(tag.key)) releaseTag(tag)
    }
    want.forEach((key) => {
      const tag = tags.get(key) ?? acquireTag(key)
      if (tag.npc) fillNpcTag(tag, me)
      else fillPlayerTag(tag, me)
      // 겹칠 때는 화면 아래쪽(= 카메라에 가까운 쪽)이 위에 온다. 내 이름표는 항상 맨 위
      const z = key === me.id ? 9000 : clamp(Math.round(tag.y) || 0, 0, 8000)
      if (z !== tag.z) {
        tag.z = z
        tag.el.style.zIndex = String(z)
      }
    })

    rankBubbles(me)
  }

  function placeTag(tag: Tag, me: MeView): void {
    const e = entity(tag.key)
    if (!e) {
      hideTag(tag)
      return
    }
    const dx = e.x - me.x
    const dz = e.z - me.z
    const d = Math.sqrt(dx * dx + dz * dz)
    let op: number
    if (tag.npc) op = d >= NPC_NEAR ? 0 : d <= NPC_FADE_FROM ? 1 : (NPC_NEAR - d) / (NPC_NEAR - NPC_FADE_FROM)
    else op = d >= PLAYER_FAR ? 0 : d <= PLAYER_FADE_FROM ? 1 : 1 - ((d - PLAYER_FADE_FROM) / (PLAYER_FAR - PLAYER_FADE_FROM)) * 0.6
    if (op < 0.05 || !engine.project(e.x, e.y + tag.head, e.z, pt)) {
      hideTag(tag)
      return
    }
    // 정수 px 로 맞춘다: 소수 위치의 글자는 흐릿하게 그려진다
    const x = Math.round(pt.x)
    const y = Math.round(pt.y)
    if (x !== tag.x || y !== tag.y) {
      tag.x = x
      tag.y = y
      tag.el.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`
    }
    const q = Math.round(op * 20) / 20
    if (q !== tag.op) {
      tag.op = q
      tag.el.style.opacity = String(q)
    }
    if (!tag.shown) {
      tag.shown = true
      tag.el.classList.remove('off')
    }
  }

  // ═════════════ 말풍선 ═════════════
  const bubbles = new Map<number, Bubble>()
  const bubbleList: Bubble[] = []
  const freeBubbles: Bubble[] = []
  const rankBuf: Bubble[] = []
  let rankDirty = false

  function hideBubble(b: Bubble): void {
    if (!b.shown) return
    b.shown = false
    b.el.classList.add('off')
  }

  function releaseBubble(b: Bubble): void {
    hideBubble(b)
    if (bubbles.get(b.key) === b) bubbles.delete(b.key)
    const i = bubbleList.indexOf(b)
    if (i >= 0) bubbleList.splice(i, 1)
    b.key = 0
    freeBubbles.push(b)
  }

  function bubble(key: number, text: string, ms?: number, kind: BubbleKind = 'say'): void {
    if (typeof text !== 'string' || !text) return
    const chars = Array.from(text)
    const str = chars.length > 70 ? chars.slice(0, 69).join('') + '…' : text
    let b = bubbles.get(key)
    if (!b) {
      b = freeBubbles.pop()
      if (!b) {
        const body = h('div.overlay-bubble-body')
        const el = h('div.overlay-bubble.off', body)
        layer.append(el)
        b = { key: 0, el, body, until: 0, dying: 0, ranked: false, d2: 0, x: NaN, y: NaN, shown: false }
      }
      b.key = key
      b.x = NaN
      b.y = NaN
      b.ranked = false
      bubbles.set(key, b)
      bubbleList.push(b)
    }
    b.body.textContent = str
    b.body.className = 'overlay-bubble-body ' + kind
    // 글이 길수록 조금 더 오래(읽을 시간)
    b.until = performance.now() + (ms && ms > 0 ? ms : clamp(1600 + chars.length * 75, 2200, 5200))
    b.dying = 0
    b.el.classList.remove('out')
    if (typeof b.body.animate === 'function') {
      b.body.animate(
        [
          { transform: 'scale(0.55)', opacity: 0 },
          { transform: 'scale(1.06)', opacity: 1, offset: 0.7 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 190, easing: 'ease-out' },
      )
    }
    rankDirty = true
  }

  /** 동시에 보이는 말풍선은 가까운 순서로 MAX_BUBBLES 개까지 */
  function rankBubbles(me: MeView): void {
    rankDirty = false
    rankBuf.length = 0
    for (let i = 0; i < bubbleList.length; i++) {
      const b = bubbleList[i]!
      const e = entity(b.key)
      if (!e) {
        b.d2 = Infinity
        b.ranked = false
        continue
      }
      const dx = e.x - me.x
      const dz = e.z - me.z
      b.d2 = b.key === me.id ? -1 : dx * dx + dz * dz
      rankBuf.push(b)
    }
    if (rankBuf.length > MAX_BUBBLES) rankBuf.sort((a, b) => a.d2 - b.d2)
    for (let i = 0; i < rankBuf.length; i++) rankBuf[i]!.ranked = i < MAX_BUBBLES
  }

  function updateBubbles(now: number): void {
    for (let i = bubbleList.length - 1; i >= 0; i--) {
      const b = bubbleList[i]!
      if (b.dying) {
        if (now >= b.dying) {
          releaseBubble(b)
          continue
        }
      } else if (now >= b.until) {
        b.dying = now + 200
        b.el.classList.add('out')
      }
      const e = entity(b.key)
      if (!e) {
        // 말하던 캐릭터가 나갔다
        releaseBubble(b)
        rankDirty = true
        continue
      }
      if (!b.ranked || !engine.project(e.x, e.y + headOf(b.key), e.z, pt)) {
        hideBubble(b)
        continue
      }
      const tag = tags.get(b.key)
      const lift = tag && tag.shown ? (tag.lines === 2 ? TAG_H2 : TAG_H1) : 6
      const x = Math.round(pt.x)
      const y = Math.round(pt.y) - lift
      if (x !== b.x || y !== b.y) {
        b.x = x
        b.y = y
        b.el.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`
      }
      if (!b.shown) {
        b.shown = true
        b.el.classList.remove('off')
      }
    }
  }

  // ═════════════ 떠오르는 글자 ═════════════
  const pops: Pop[] = []
  const freePops: Pop[] = []

  function pop(x: number, y: number, z: number, text: string, kind: 'good' | 'bad' | 'gold' | 'info' = 'info'): void {
    spawnPop(x, y, z, text, kind, 0)
  }

  function spawnPop(x: number, y: number, z: number, text: string, kind: 'good' | 'bad' | 'gold' | 'info', lift: number): void {
    if (!text) return
    const now = performance.now()
    // 같은 자리에서 연달아 뜨면(신도 +1, +10 영향력 …) 위로 쌓고 살짝 시차를 둔다
    let stack = 0
    for (let i = 0; i < pops.length; i++) {
      const q = pops[i]!
      if (now - q.born < 700 && Math.abs(q.x - x) < 0.8 && Math.abs(q.z - z) < 0.8) stack = Math.max(stack, q.stack + 1)
    }
    let p = freePops.pop()
    if (!p) {
      const body = h('span.overlay-pop-body')
      const el = h('div.overlay-pop.off', body)
      layer.append(el)
      p = { el, body, x: 0, y: 0, z: 0, born: 0, start: 0, stack: 0, lift: 0, px: NaN, py: NaN, shown: false }
    }
    p.x = x
    p.y = y
    p.z = z
    p.born = now
    p.stack = stack
    p.lift = lift
    p.start = now + stack * 110
    p.px = NaN
    p.py = NaN
    p.body.textContent = text
    p.body.className = 'overlay-pop-body ' + kind
    if (typeof p.body.animate === 'function') {
      p.body.animate(
        [
          { opacity: 0, transform: 'scale(0.5)' },
          { opacity: 1, transform: 'scale(1.2)', offset: 0.14 },
          { opacity: 1, transform: 'scale(1)', offset: 0.26 },
          { opacity: 1, transform: 'scale(1)', offset: 0.72 },
          { opacity: 0, transform: 'scale(0.96)' },
        ],
        { duration: POP_MS, delay: stack * 110, fill: 'both', easing: 'linear' },
      )
    }
    pops.push(p)
  }

  function releasePop(i: number): void {
    const p = pops[i]!
    pops.splice(i, 1)
    if (p.shown) {
      p.shown = false
      p.el.classList.add('off')
    }
    freePops.push(p)
  }

  function updatePops(now: number): void {
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i]!
      const t = (now - p.start) / POP_MS
      if (t >= 1) {
        releasePop(i)
        continue
      }
      if (t < 0 || !engine.project(p.x, p.y, p.z, pt)) {
        if (p.shown) {
          p.shown = false
          p.el.classList.add('off')
        }
        continue
      }
      const ease = 1 - (1 - t) * (1 - t) * (1 - t)
      const x = Math.round(pt.x)
      const y = Math.round(pt.y - p.lift - p.stack * POP_GAP - ease * POP_RISE)
      if (x !== p.px || y !== p.py) {
        p.px = x
        p.py = y
        p.el.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`
      }
      if (!p.shown) {
        p.shown = true
        p.el.classList.remove('off')
      }
    }
  }

  // ═════════════ 프레임 갱신 ═════════════
  let live = false
  let lastPick = 0
  measure()

  function clearAll(): void {
    for (let i = tagList.length - 1; i >= 0; i--) releaseTag(tagList[i]!)
    for (let i = bubbleList.length - 1; i >= 0; i--) releaseBubble(bubbleList[i]!)
    for (let i = pops.length - 1; i >= 0; i--) releasePop(i)
  }

  function update(): void {
    const me = store.me
    if (!me || (store.phase !== 'playing' && store.phase !== 'reconnecting')) {
      if (live) {
        live = false
        clearAll()
      }
      return
    }
    live = true
    const now = performance.now()
    if (dirty || rankDirty || now - lastPick >= PICK_MS) {
      dirty = false
      lastPick = now
      pickVisible(me)
    }
    for (let i = 0; i < tagList.length; i++) placeTag(tagList[i]!, me)
    updateBubbles(now)
    updatePops(now)
  }

  // 이름·직급·교단·신도 주인이 바뀌면 다음 프레임에 바로 다시 고른다(0.1초 주기를 기다리지 않는다)
  const markDirty = (): void => {
    dirty = true
  }
  bus.on('entered', markDirty)
  bus.on('phase', markDirty)
  bus.on('playerJoin', markDirty)
  bus.on('playerLeave', markDirty)
  bus.on('playerUpdate', markDirty)
  bus.on('npcSpawn', markDirty)
  bus.on('npcUpdate', markDirty)
  bus.on('profile', markDirty)
  bus.on('progress', markDirty)
  bus.on('settings', markDirty)

  // ═════════════ 서버 이벤트 → 말풍선/글자 ═════════════
  /** "(이어폰 볼륨을 올린다)" 처럼 괄호로 싼 대사는 말이 아니라 행동이다 */
  const npcKind = (text: string): BubbleKind => (/^\s*\(.*\)\s*$/.test(text) ? 'think' : 'npc')

  bus.onMsg('pitchRes', (m) => {
    const line = PITCH_LINES[m.l]
    if (line) bubble(m.p, line.text, undefined, 'say')
    // 멘트를 읽을 틈을 준 뒤 NPC 가 반응한다
    if (m.say) window.setTimeout(() => bubble(npcKey(m.n), m.say, undefined, npcKind(m.say)), 600)
  })
  bus.onMsg('say', (m) => {
    const q = QUICK_CHATS[m.q]
    if (q) bubble(m.id, q.text, undefined, 'say')
  })
  bus.onMsg('npcSay', (m) => {
    for (const row of m.l ?? []) {
      if (Array.isArray(row) && typeof row[1] === 'string') bubble(npcKey(row[0]), row[1], undefined, npcKind(row[1]))
    }
  })
  bus.onMsg('prophecy', (m) => {
    bubble(m.p, m.text, 5200, 'shout')
    ;(m.re ?? []).forEach((row, i) => {
      if (!Array.isArray(row) || typeof row[1] !== 'string') return
      const [key, text] = row
      // 한꺼번에 터지면 읽을 수 없다 → 조금씩 엇갈려 웅성웅성
      window.setTimeout(() => bubble(key, text, 2600, isNpcKey(key) ? npcKind(text) : 'say'), 500 + i * 230)
    })
  })
  bus.onMsg('reward', (m) => {
    const me = store.me
    if (!me) return
    // 내 이름표와 (방금 띄운) 내 말풍선을 가리지 않게 그 위에서 시작한다
    const tag = tags.get(me.id)
    const y = me.y + HEAD_HUMAN
    let lift = (tag && tag.shown ? (tag.lines === 2 ? TAG_H2 : TAG_H1) : 6) + 4
    if (bubbles.has(me.id)) {
      // 단, 가로 폰처럼 위쪽이 좁아 HUD 까지 올라가 버릴 때는 말풍선 위를 포기하고 겹쳐서 띄운다.
      // HUD 아래쪽 위치는 HUD 가 #ui 에 적어 둔 CSS 변수에서 읽는다(레이아웃 계산 없음, 보상이 올 때 한 번)
      const hudBottom = parseFloat(root.style.getPropertyValue('--hud-bottom')) || 60
      const fits = engine.project(me.x, y, me.z, pt) && pt.y - lift - BUBBLE_H - POP_RISE - POP_GAP * 2 > hudBottom
      if (fits) lift += BUBBLE_H
    }
    if (m.fol && m.fol > 0) spawnPop(me.x, y, me.z, `신도 +${m.fol}`, 'good', lift)
    if (m.inf && m.inf > 0) spawnPop(me.x, y, me.z, `+${m.inf} 영향력`, 'info', lift)
    if (m.coins && m.coins > 0) spawnPop(me.x, y, me.z, `🪙 +${m.coins}`, 'gold', lift)
  })

  return { update, bubble, pop }
}
