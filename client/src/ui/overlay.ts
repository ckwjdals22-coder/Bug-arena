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
import { reducedMotion } from '../core/motion'
import type { BubbleKind, EngineApi, OverlayApi } from '../core/contracts'
import type { EntityView, MeView, Store } from '../core/store'
import { titleNameOf } from '../../../shared/content/shop'
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
/** 교단 줄의 최대 폭(px) — overlay.css 의 .overlay-cult max-width 와 같은 값 */
const CULT_TAG_MAX = 240
/** 폰처럼 좁은 화면은 이름표끼리 겹치기 쉽다 → 더 가까운 것만 */
const MAX_NPC_TAGS_NARROW = 6
const NARROW_PX = 560
const MAX_BUBBLES = 8
/** 좁은 화면에서는 말풍선이 금방 화면을 덮는다 → 가까운 몇 개만 */
const MAX_BUBBLES_NARROW = 4
const PICK_MS = 100

/** 이름표 높이(px) — CSS 의 고정 높이와 맞춘 값. 말풍선을 이름표 위에 얹을 때 쓴다(레이아웃을 읽지 않기 위해) */
const TAG_H1 = 27
const TAG_H2 = 48
/** NPC 이름표 높이(px) */
const TAG_HN = 26
/** 겹친 이름표를 위로 쌓는 최대 단수 */
const STACK_MAX = 3
/** 글자 폭 어림(px): 한글·한자·가나·이모지는 넓게, 나머지는 좁게 */
function textWidth(text: string, px: number): number {
  let w = 0
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? px : px * 0.58
  return w
}
const POP_RISE = 58
const POP_MS = 1400
/** 연달아 뜨는 글자 사이 간격(px) */
const POP_GAP = 34
/** 떠오르는 글자 한 줄의 높이 어림(px): 글자 크기(19~23px) + 외곽선 */
const POP_H = 28
/** 연달아 오는 보상 메시지를 모으는 시간 */
const REWARD_GATHER_MS = 220
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
  /** 이번 프레임에 화면에 있어야 하는가(투영 결과) + 투영된 위치·투명도 */
  vis: boolean
  px: number
  py: number
  opq: number
  /** 어림한 폭(px). 겹침 계산용 — 레이아웃을 읽지 않으려고 글자 수로 어림한다 */
  w: number
  /** 겹침을 피해 위로 밀어 올린 양(px, 0 이하) */
  dy: number
  /** 다른 이름표에 가려져 잠시 숨긴 NPC 이름표인가 */
  culled: boolean
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
  /** 이번 프레임의 투영 위치(꼬리가 가리킬 곳)와 화면에 있어야 하는지 */
  vis: boolean
  px: number
  py: number
  /** 어림한 폭·높이(px) — 화면 안에 가두고 서로 겹치지 않게 놓는 데 쓴다(레이아웃을 읽지 않는다) */
  w: number
  h: number
  /** 화면 안으로 밀어 넣느라 생긴 가로 어긋남(px). 꼬리를 그만큼 옮겨 말하는 사람을 계속 가리키게 한다 */
  tail: number
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
  /** 같은 자리에서 연달아 뜬 글자 묶음: 함께 오르고 함께 비켜서 줄 간격이 늘 그대로다 */
  group: PopGroup
  /** 어림한 폭(px) — 말풍선과 겹치는지 볼 때 쓴다(레이아웃을 읽지 않는다) */
  w: number
  /** 이번 프레임에 비키기 전의 위치(투영 결과), 화면에 있어야 하는가 */
  vis: boolean
  bx: number
  by: number
  px: number
  py: number
  shown: boolean
}

interface PopGroup {
  /** 묶음이 오르기 시작한 시각: 늦게 합류한 줄도 같은 높이만큼 올라야 서로 겹치지 않는다 */
  born: number
  /** 말풍선·다른 글자를 피해 옮긴 양(px, +면 위로). 갑자기 튀지 않게 목표값으로 서서히 다가간다 */
  dodge: number
  /** 이번 프레임에 계산을 마쳤는가(같은 묶음을 한 번만 계산) */
  frame: number
  fresh: boolean
  /** 함께 피할 큰 카드(결과 배너)의 상자. 아래로 비킬 때 이 위에서 멈춘다 */
  avoid: number[] | null
  /** 비킬 곳이 없어 일찍 물러났다(서서히 투명해진다) */
  gone: boolean
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
      tag = { key: 0, npc: false, head: HEAD_HUMAN, el, cult, main, sig: '', lines: 1, x: NaN, y: NaN, op: -1, z: -1, shown: false, vis: false, px: 0, py: 0, opq: 0, w: 80, dy: 0, culled: false }
    }
    tag.key = key
    tag.npc = isNpcKey(key)
    tag.head = headOf(key)
    tag.sig = ''
    tag.x = NaN
    tag.y = NaN
    tag.vis = false
    tag.dy = 0
    tag.culled = false
    tags.set(key, tag)
    tagList.push(tag)
    orderDirty = true
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
    orderDirty = true
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
    const title = titleNameOf(tagId)
    const sig = `p${isMe ? 1 : 0}|${name}|${rank}|${title}|${cult ? `${cult.id}|${cult.name}|${cult.color}|${cult.emblem}|${cult.title}` : ''}`
    if (sig === tag.sig) return
    tag.sig = sig
    tag.lines = cult ? 2 : 1
    tag.el.className = 'overlay-tag' + (isMe ? ' me' : '') + (tag.shown ? '' : ' off')
    if (cult) {
      const color = CULT_COLORS[cult.color] ?? 0x7b5cff
      tag.cult.style.background = hex(color)
      tag.cult.style.color = inkOn(color)
      // 교단 이름·칭호는 다른 사람이 지은 글자다 → 글자로만 넣는다(h 는 textContent 를 쓴다).
      // 이름이 길면 이름 쪽이 줄어들고 칭호는 언제나 다 보인다
      tag.cult.replaceChildren(h('span.overlay-cult-name', `${CULT_EMBLEMS[cult.emblem] ?? '🚩'} ${cult.name}`), h('span.overlay-cult-title', `· ${cult.title}`))
    }
    tag.cult.classList.toggle('hidden', !cult)
    const rankText = title ? `${title} · ${rankName(rank)}` : rankName(rank)
    tag.main.replaceChildren(...(isMe ? [h('span.overlay-me', '나')] : []), h('span.overlay-name', name), h('span.overlay-rank', rankText))
    const mainW = Math.min(150, textWidth(name, 12.5)) + textWidth(rankText, 10.5) + 27 + (isMe ? 24 : 0)
    const cultW = cult ? Math.min(CULT_TAG_MAX, textWidth(cult.name, 11) + textWidth(cult.title, 11) + 46) : 0
    tag.w = Math.max(mainW, cultW)
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
    tag.w = Math.min(150, textWidth(pub.name, 11.5)) + textWidth(badge, 9.5) + 30
  }

  // 가까운 NPC 고르기용 작업 배열(매번 새로 만들지 않는다)
  const nearIds: number[] = []
  const nearD2: number[] = []
  const want = new Set<number>()
  // 화면 폭은 크기가 바뀔 때만 읽는다(update 안에서는 레이아웃/창 크기를 읽지 않는다)
  let npcCap = MAX_NPC_TAGS
  let narrow = false
  let bubbleCap = MAX_BUBBLES
  let viewW = window.innerWidth
  let viewH = window.innerHeight
  const measure = (): void => {
    viewW = window.innerWidth
    viewH = window.innerHeight
    narrow = Math.min(window.innerWidth, window.innerHeight) < NARROW_PX
    npcCap = narrow ? MAX_NPC_TAGS_NARROW : MAX_NPC_TAGS
    bubbleCap = narrow ? MAX_BUBBLES_NARROW : MAX_BUBBLES
    dirty = true
  }
  measure()
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
      tag.vis = false
      return
    }
    const dx = e.x - me.x
    const dz = e.z - me.z
    const d = Math.sqrt(dx * dx + dz * dz)
    let op: number
    if (tag.npc) op = d >= NPC_NEAR ? 0 : d <= NPC_FADE_FROM ? 1 : (NPC_NEAR - d) / (NPC_NEAR - NPC_FADE_FROM)
    else op = d >= PLAYER_FAR ? 0 : d <= PLAYER_FADE_FROM ? 1 : 1 - ((d - PLAYER_FADE_FROM) / (PLAYER_FAR - PLAYER_FADE_FROM)) * 0.6
    if (op < 0.05 || !engine.project(e.x, e.y + tag.head, e.z, pt)) {
      tag.vis = false
      return
    }
    // 정수 px 로 맞춘다: 소수 위치의 글자는 흐릿하게 그려진다
    tag.vis = true
    tag.px = Math.round(pt.x)
    tag.py = Math.round(pt.y)
    tag.opq = Math.round(op * 20) / 20
  }

  // ───────── 겹침 정리 ─────────
  // 우선순위: 나 → 다른 접속자(id 순) → NPC(지금 말을 걸 수 있는 시민 먼저, 그다음 id 순).
  //  · 접속자 이름표가 앞선 이름표와 겹치면 그 위로 쌓아 올린다(최대 STACK_MAX 단).
  //  · NPC 이름표가 앞선 이름표와 겹치면 잠시 숨긴다(광장에 몰려 있을 때 글자 더미가 되지 않게).
  // 순서를 거리로 정하지 않는 것은 걸어 다닐 때 이름표가 위아래로 자리바꿈하며 깜빡이지 않게 하기 위해서다.
  let order: Tag[] = []
  let orderDirty = true
  let orderNear = 0
  /** 이미 자리 잡은 이름표의 상자들 [x0, y0, x1, y1, …] */
  const placed: number[] = []

  function sortOrder(me: MeView): void {
    orderDirty = false
    orderNear = store.near.npc
    const nearKey = orderNear ? npcKey(orderNear) : 0
    const rank = (t: Tag): number => (t.key === me.id ? 0 : !t.npc ? 1 : t.key === nearKey ? 2 : 3)
    order = tagList.slice().sort((a, b) => rank(a) - rank(b) || a.key - b.key)
  }

  /** 겹치는 상자가 있으면 그중 가장 높이 있는 것의 윗변 y, 없으면 NaN. pad 만큼 넉넉히 본다 */
  function hitTop(x0: number, y0: number, x1: number, y1: number, pad: number, boxes: number[] = placed): number {
    const placed = boxes
    let top = NaN
    for (let i = 0; i < placed.length; i += 4) {
      // 폭은 어림값이라 가로로 살짝(4px) 겹치는 것은 봐준다
      if (x1 - 4 + pad <= placed[i]! || x0 + 4 - pad >= placed[i + 2]! || y1 + pad <= placed[i + 1]! || y0 - pad >= placed[i + 3]!) continue
      const t = placed[i + 1]!
      if (!(top <= t)) top = t
    }
    return top
  }

  function layoutTags(me: MeView): void {
    if (orderDirty || orderNear !== store.near.npc) sortOrder(me)
    placed.length = 0
    for (let i = 0; i < order.length; i++) {
      const tag = order[i]!
      if (!tag.vis) {
        tag.culled = false
        hideTag(tag)
        continue
      }
      const hgt = tag.npc ? TAG_HN : tag.lines === 2 ? TAG_H2 : TAG_H1
      const hw = tag.w / 2
      const x = tag.px
      let dy = 0
      if (tag.npc) {
        // 한 번 숨긴 것은 틈이 넉넉히 생겨야 다시 보인다(경계에서 깜빡이지 않게)
        const hit = hitTop(x - hw, tag.py - hgt, x + hw, tag.py, tag.culled ? 8 : 0)
        tag.culled = hit === hit
        if (tag.culled) {
          hideTag(tag)
          continue
        }
      } else if (tag.key !== me.id) {
        for (let k = 0; k < STACK_MAX; k++) {
          const top = hitTop(x - hw, tag.py + dy - hgt, x + hw, tag.py + dy, 0)
          if (top !== top) break
          dy = top - 1 - tag.py
        }
      }
      tag.dy = dy
      const y = tag.py + dy
      placed.push(x - hw, y - hgt, x + hw, y)
      if (x !== tag.x || y !== tag.y) {
        tag.x = x
        tag.y = y
        tag.el.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`
      }
      if (tag.opq !== tag.op) {
        tag.op = tag.opq
        tag.el.style.opacity = String(tag.opq)
      }
      if (!tag.shown) {
        tag.shown = true
        tag.el.classList.remove('off')
      }
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
        b = { key: 0, el, body, until: 0, dying: 0, ranked: false, d2: 0, x: NaN, y: NaN, shown: false, vis: false, px: 0, py: 0, w: 120, h: 40, tail: 0 }
      }
      b.key = key
      b.x = NaN
      b.y = NaN
      b.ranked = false
      b.vis = false
      bubbles.set(key, b)
      bubbleList.push(b)
    }
    b.body.textContent = str
    b.body.className = 'overlay-bubble-body ' + kind
    // 크기 어림: overlay.css 의 글자 크기·최대 폭과 맞춘 값
    const shout = kind === 'shout'
    const maxW = shout ? (narrow ? 230 : 270) : narrow ? 180 : 210
    const tw = textWidth(str, shout ? (narrow ? 15 : 16.5) : narrow ? 13 : 13.5)
    const padX = shout ? 36 : 28
    b.w = Math.min(maxW, tw + padX)
    b.h = Math.max(1, Math.ceil(tw / (maxW - padX))) * (shout ? 21 : 18) + (shout ? 34 : 26)
    // 글이 길수록 조금 더 오래(읽을 시간)
    b.until = performance.now() + (ms && ms > 0 ? ms : clamp(1600 + chars.length * 75, 2200, 5200))
    b.dying = 0
    b.el.classList.remove('out')
    if (typeof b.body.animate === 'function' && !reducedMotion()) {
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
    // 가까운 순서(내 말풍선이 맨 앞). 이 순서는 겹침을 풀 때의 우선순위이기도 하다
    rankBuf.sort((a, b) => a.d2 - b.d2)
    for (let i = 0; i < rankBuf.length; i++) rankBuf[i]!.ranked = i < bubbleCap
    // HUD 아래쪽 경계: HUD 가 #ui 에 적어 둔 CSS 변수에서 읽는다(레이아웃 계산 없음)
    hudBottom = parseFloat(root.style.getPropertyValue('--hud-bottom')) || 60
  }
  let hudBottom = 60
  /** 이미 자리 잡은 말풍선 상자들 */
  const placedBubbles: number[] = []

  /**
   * 말풍선을 화면 안에 가두고(좌우·HUD 아래) 서로 겹치면 위로 쌓는다. 우선순위는 가까운 순서.
   * 밀어 넣느라 옆으로 어긋난 만큼 꼬리를 옮겨, 누가 한 말인지는 계속 보이게 한다.
   */
  function layoutBubbles(): void {
    placedBubbles.length = 0
    for (let i = 0; i < rankBuf.length; i++) {
      const b = rankBuf[i]!
      if (b.key === 0 || !b.vis || bubbles.get(b.key) !== b) continue
      const hw = b.w / 2
      const x = hw * 2 + 12 >= viewW ? Math.round(viewW / 2) : Math.round(clamp(b.px, hw + 6, viewW - hw - 6))
      const floor = hudBottom + b.h + 4
      let y = Math.max(floor, b.py)
      for (let k = 0; k < 3; k++) {
        const top = hitTop(x - hw, y - b.h, x + hw, y, 0, placedBubbles)
        if (top !== top) break
        y = top - 3
      }
      // 위로 쌓다가 HUD 를 침범하게 되면 쌓기를 포기하고 제자리에 둔다
      if (y < floor) y = Math.max(floor, b.py)
      placedBubbles.push(x - hw, y - b.h, x + hw, y)
      if (x !== b.x || y !== b.y) {
        b.x = x
        b.y = y
        b.el.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`
      }
      const tail = Math.round(clamp(b.px - x, -hw + 16, hw - 16))
      if (tail !== b.tail) {
        b.tail = tail
        b.body.style.setProperty('--tail', `${tail}px`)
      }
      if (!b.shown) {
        b.shown = true
        b.el.classList.remove('off')
      }
    }
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
        b.vis = false
        hideBubble(b)
        continue
      }
      const tag = tags.get(b.key)
      // 이름표가 겹침을 피해 위로 올라가 있으면 말풍선도 그만큼 따라 올라간다
      const lift = tag && tag.shown ? (tag.lines === 2 ? TAG_H2 : TAG_H1) - tag.dy : 6
      b.vis = true
      b.px = Math.round(pt.x)
      b.py = Math.round(pt.y) - lift
    }
    layoutBubbles()
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
    // 같은 자리에서 연달아 뜨면(신도 +1, +10 영향력 …) 한 묶음으로 위로 쌓고 살짝 시차를 둔다
    let stack = 0
    let group: PopGroup | null = null
    for (let i = 0; i < pops.length; i++) {
      const q = pops[i]!
      if (now - q.born < 700 && Math.abs(q.x - x) < 0.8 && Math.abs(q.z - z) < 0.8 && q.stack + 1 > stack) {
        stack = q.stack + 1
        group = q.group
      }
    }
    if (!group) {
      // 포교 결과 배너(화면 가운데 큰 카드)가 떠 있으면 그 자리도 피한다. 묶음이 생길 때 한 번만 읽는다(매 프레임 레이아웃을 읽지 않는다)
      let avoid: number[] | null = null
      const banner = root.querySelector('.talk-result:not(.hidden)')
      if (banner) {
        const r = banner.getBoundingClientRect()
        if (r.height > 0) avoid = [r.left, r.top, r.right, r.bottom]
      }
      group = { born: now, dodge: 0, frame: -1, fresh: true, avoid, gone: false }
    }
    let p = freePops.pop()
    if (!p) {
      const body = h('span.overlay-pop-body')
      const el = h('div.overlay-pop.off', body)
      layer.append(el)
      p = { el, body, x: 0, y: 0, z: 0, born: 0, start: 0, stack: 0, lift: 0, group, w: 0, vis: false, bx: 0, by: 0, px: NaN, py: NaN, shown: false }
    }
    p.x = x
    p.y = y
    p.z = z
    p.born = now
    p.stack = stack
    p.lift = lift
    p.group = group
    p.w = textWidth(text, kind === 'good' ? 23 : 19) + 8
    p.vis = false
    p.start = now + stack * 110
    p.px = NaN
    p.py = NaN
    p.el.style.opacity = ''
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

  /** 글자가 피해야 할 상자들: 말풍선, 내 이름표, 먼저 자리 잡은 글자 묶음 */
  const popBoxes: number[] = []
  let popFrame = 0

  /** 상자들과 겹치는 것 중 가장 아래쪽 끝(y). 없으면 NaN */
  function hitBottom(x0: number, y0: number, x1: number, y1: number, boxes: number[]): number {
    let bottom = NaN
    for (let i = 0; i < boxes.length; i += 4) {
      if (x1 - 4 <= boxes[i]! || x0 + 4 >= boxes[i + 2]! || y1 <= boxes[i + 1]! || y0 >= boxes[i + 3]!) continue
      const b = boxes[i + 3]!
      if (!(bottom >= b)) bottom = b
    }
    return bottom
  }

  /**
   * 한 묶음이 비켜야 할 양(+면 위로, -면 아래로).
   * 포교 성공 순간에는 "신도 +1 / +10 영향력 / 🪙" 묶음, 헌납품 이름, 내 말풍선, 0.6초 뒤 NPC 의 대답 말풍선이 같은 자리에 몰린다.
   * 글자끼리 포개지면 아무것도 읽을 수 없으므로, 먼저 위로 비켜 보고 HUD 에 닿으면 아래로 비킨다.
   */
  function groupDodge(g: PopGroup): number {
    let up = 0
    for (let k = 0; k < 5; k++) {
      let moved = false
      for (let i = 0; i < pops.length; i++) {
        const m = pops[i]!
        if (m.group !== g || !m.vis) continue
        const hw = m.w / 2
        const top = hitTop(m.bx - hw, m.by - up - POP_H, m.bx + hw, m.by - up, 0, popBoxes)
        if (top === top) {
          up = m.by - top + 3
          moved = true
        }
      }
      if (!moved) break
    }
    let minTop = Infinity
    for (let i = 0; i < pops.length; i++) {
      const m = pops[i]!
      if (m.group === g && m.vis) minTop = Math.min(minTop, m.by - POP_H)
    }
    if (minTop - up >= hudBottom + 4) return up
    // 위로는 HUD 에 닿는다 → 아래로 비킨다(글자가 캐릭터 몸 위에 오는 편이 글자 위에 글자가 오는 것보다 읽힌다)
    let down = 0
    for (let k = 0; k < 5; k++) {
      let moved = false
      for (let i = 0; i < pops.length; i++) {
        const m = pops[i]!
        if (m.group !== g || !m.vis) continue
        const hw = m.w / 2
        const bottom = hitBottom(m.bx - hw, m.by + down - POP_H, m.bx + hw, m.by + down, popBoxes)
        if (bottom === bottom) {
          down = bottom - (m.by - POP_H) + 3
          moved = true
        }
      }
      if (!moved) break
    }
    // 아래로도 결과 배너나 화면 아래쪽에 닿으면 비키기를 포기한다(HUD 를 덮지 않는 선까지만 위로)
    let maxBottom = -Infinity
    let floor = viewH - 120
    for (let i = 0; i < pops.length; i++) {
      const m = pops[i]!
      if (m.group !== g || !m.vis) continue
      maxBottom = Math.max(maxBottom, m.by)
      const a = m.group.avoid
      if (a && m.bx + m.w / 2 > a[0]! && m.bx - m.w / 2 < a[2]! && a[1]! > m.by - POP_H) floor = Math.min(floor, a[1]!)
    }
    if (down > 0 && maxBottom + down <= floor) return -down
    // 위(HUD)도 아래(결과 배너)도 막혔다: 글자 위에 글자를 겹쳐 두느니 일찍 물러난다(같은 내용을 결과 배너와 HUD 숫자가 이미 보여 준다)
    return NaN
  }

  function updatePops(now: number): void {
    // 1) 비키기 전 위치
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i]!
      const t = (now - p.start) / POP_MS
      if (t >= 1) {
        releasePop(i)
        continue
      }
      // 아직 차례가 안 된 줄(시차 110ms)도 자리는 미리 계산한다: 묶음이 비킬 양이 줄이 하나씩 나올 때마다 바뀌어 흔들리지 않게
      p.vis = engine.project(p.x, p.y, p.z, pt)
      if (!p.vis || t < 0) {
        if (p.shown) {
          p.shown = false
          p.el.classList.add('off')
        }
        if (!p.vis) continue
      }
      // 오르는 높이는 묶음이 시작한 시각 기준: 늦게 나온 줄도 앞줄과 같은 만큼 올라 줄 간격(POP_GAP)이 그대로다
      const tr = clamp((now - p.group.born) / POP_MS, 0, 1)
      const ease = 1 - (1 - tr) * (1 - tr) * (1 - tr)
      p.bx = Math.round(clamp(pt.x, p.w / 2 + 4, viewW - p.w / 2 - 4))
      p.by = Math.round(pt.y - p.lift - p.stack * POP_GAP - ease * POP_RISE)
    }
    // 2) 묶음별로 말풍선·내 이름표·앞서 놓인 글자를 피한다(먼저 뜬 묶음이 먼저 자리 잡는다)
    popFrame++
    popBoxes.length = 0
    for (let i = 0; i < placedBubbles.length; i++) popBoxes.push(placedBubbles[i]!)
    const me = store.me
    const myTag = me ? tags.get(me.id) : undefined
    if (myTag && myTag.shown) {
      const hw = myTag.w / 2
      popBoxes.push(myTag.x - hw, myTag.y - (myTag.lines === 2 ? TAG_H2 : TAG_H1), myTag.x + hw, myTag.y)
    }
    for (let i = 0; i < pops.length; i++) {
      const g = pops[i]!.group
      if (!pops[i]!.vis || g.frame === popFrame) continue
      g.frame = popFrame
      const target = groupDodge(g)
      if (target !== target) {
        // 한 번 물러나기로 한 묶음은 다시 나타나지 않는다(깜빡이지 않게)
        g.gone = true
      } else if (!g.gone) {
        g.dodge = g.fresh ? target : g.dodge + (target - g.dodge) * 0.5
      }
      g.fresh = false
      for (let j = i; j < pops.length; j++) {
        const m = pops[j]!
        if (m.group !== g || !m.vis) continue
        const hw = m.w / 2
        const y = Math.round(m.by - g.dodge)
        if (g.gone) {
          if (m.el.style.opacity !== '0') m.el.style.opacity = '0'
          continue
        }
        popBoxes.push(m.bx - hw, y - POP_H, m.bx + hw, y)
        if (now < m.start) continue
        if (m.bx !== m.px || y !== m.py) {
          m.px = m.bx
          m.py = y
          m.el.style.transform = `translate3d(${m.bx}px,${y}px,0) translate(-50%,-100%)`
        }
        if (!m.shown) {
          m.shown = true
          m.el.classList.remove('off')
        }
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
    layoutTags(me)
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
  // 보상 글자("신도 +1", "+10 영향력", "🪙 +4").
  // 한 번의 포교 성공에 보상 메시지가 여러 개 연달아 온다(합류, 연속 보너스, 업적, 즉석 헌납 …).
  // 오는 족족 띄우면 글자가 네댓 줄 쌓여 HUD 까지 덮으므로, 잠깐 모았다가 종류별로 합쳐 한 줄씩만 띄운다.
  let accFol = 0
  let accInf = 0
  let accCoins = 0
  let accTimer = 0
  const flushRewards = (): void => {
    accTimer = 0
    const fol = accFol
    const inf = accInf
    const coins = accCoins
    accFol = accInf = accCoins = 0
    const me = store.me
    if (!me) return
    // 내 이름표와 (방금 띄운) 내 말풍선을 가리지 않게 그 위에서 시작한다
    const tag = tags.get(me.id)
    const y = me.y + HEAD_HUMAN
    let lift = (tag && tag.shown ? (tag.lines === 2 ? TAG_H2 : TAG_H1) : 6) + 4
    const lines = (fol > 0 ? 1 : 0) + (inf > 0 ? 1 : 0) + (coins > 0 ? 1 : 0)
    if (engine.project(me.x, y, me.z, pt)) {
      // HUD 아래쪽 위치는 HUD 가 #ui 에 적어 둔 CSS 변수에서 읽는다(레이아웃 계산 없음, 보상이 올 때 한 번)
      const hb = parseFloat(root.style.getPropertyValue('--hud-bottom')) || 60
      const need = POP_RISE + POP_GAP * lines
      if (bubbles.has(me.id) && pt.y - lift - BUBBLE_H - need > hb) lift += BUBBLE_H
      // 그래도 HUD 까지 올라가게 되면(가로 폰처럼 위쪽이 좁을 때) 내려서 띄운다: 이름표와 겹치는 편이 HUD 를 덮는 것보다 낫다
      lift = Math.max(0, Math.min(lift, pt.y - hb - need - 4))
    }
    if (fol > 0) spawnPop(me.x, y, me.z, `신도 +${fol}`, 'good', lift)
    if (inf > 0) spawnPop(me.x, y, me.z, `+${inf} 영향력`, 'info', lift)
    if (coins > 0) spawnPop(me.x, y, me.z, `🪙 +${coins}`, 'gold', lift)
  }
  bus.onMsg('reward', (m) => {
    if (!store.me) return
    if (m.fol && m.fol > 0) accFol += m.fol
    if (m.inf && m.inf > 0) accInf += m.inf
    if (m.coins && m.coins > 0) accCoins += m.coins
    if (!accTimer && (accFol > 0 || accInf > 0 || accCoins > 0)) accTimer = window.setTimeout(flushRewards, REWARD_GATHER_MS)
  })

  return { update, bubble, pop }
}
