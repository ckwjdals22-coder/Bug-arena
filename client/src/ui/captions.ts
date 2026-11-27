/**
 * 예능 자막 — 내 일에만 붙는 '제작진 자막' 한 줄.
 *
 * 새 프로토콜 없이 클라이언트가 이미 받는 메시지(pitchRes, rankUp, patrol, duel, nu)에서 상황을 읽어 낸다.
 * 자막은 플레이어 자신만 놀린다(시민·다른 플레이어 대상 자막 없음, 남의 화면에도 안 뜬다).
 *
 * 연출 규칙
 *  - 한 줄만. 지금 뜬 것 + 대기 1개(새것이 대기 자리를 덮어쓴다) → 자막이 밀려서 줄줄이 늦게 뜨지 않는다.
 *  - 사건 직후 0.35초 늦게 띄운다(예능의 '한 박자 쉬고 자막' 리듬. 결과 배너와 겹쳐 읽히지 않게).
 *  - aria-live 는 끈다: 장식용 농담이라 화면 낭독기가 매번 읽어 주면 방해만 된다.
 */
import { pickCaption, type CaptionKey } from '../../../shared/content/captions'
import { MAX_ENTOURAGE } from '../../../shared/constants'
import type { PitchOutcome } from '../../../shared/types'
import type { AppContext } from '../core/contracts'
import { h } from './kit'
import { stagePlay } from './stage'
import './captions.css'

/** 사건 → 자막까지의 박자 */
const BEAT_MS = 350
/** 표시 시간: 짧은 자막 1.4초 ~ 긴 자막 1.9초 */
const SHOW_MIN_MS = 1400
const SHOW_MAX_MS = 1900
/** 가만히 서 있으면 자막 */
const IDLE_MS = 40_000

export interface CaptionsApi {
  /** 다른 모듈(events)이 직접 자막을 요청한다 */
  show(key: CaptionKey, n?: number): void
  /** 이 시각(performance.now)까지 '신도가 떠났다' 자막을 띄우지 않는다(단속·기싸움처럼 이유가 이미 화면에 있을 때) */
  muteFollowerLeft(ms: number): void
}

export function mountCaptions(ctx: AppContext): CaptionsApi {
  const { store, bus, ui } = ctx
  const el = h('div.cap', { 'aria-live': 'off', 'aria-hidden': 'true' })
  const text = h('span.cap-text')
  el.append(text)
  ui.root.append(el)

  let counter = 0
  let pending: { key: CaptionKey; n: number } | null = null
  let showing = false
  let beatTimer: number | undefined
  let hideTimer: number | undefined
  let followerMuteUntil = 0
  /** 무대(stage.ts)에 차례를 걸어 둔 상태인가 */
  let queued = false

  function place(): void {
    // 대화 시트/기싸움 시트가 열려 있으면 그 위(화면 위쪽)로 올린다 — 시트의 버튼을 가리지 않게
    const sheet = ui.root.classList.contains('hud-talking') || ui.root.classList.contains('events-duel')
    el.classList.toggle('cap-top', sheet)
  }
  // 자막이 떠 있는 사이에 시트가 열리고 닫혀도 바로 자리를 옮긴다
  new MutationObserver(() => {
    if (showing) place()
  }).observe(ui.root, { attributes: true, attributeFilter: ['class'] })

  function next(): void {
    beatTimer = undefined
    const item = pending
    pending = null
    if (!item || store.phase !== 'playing') {
      showing = false
      el.classList.remove('show')
      return
    }
    const c = pickCaption(item.key, item.n, counter++)
    if (!c) {
      next()
      return
    }
    showing = true
    place()
    text.textContent = c.text
    el.dataset.style = c.style
    // 같은 노드에 애니메이션을 다시 걸기 위해 클래스를 뗐다 붙인다
    el.classList.remove('show')
    void el.offsetWidth
    el.classList.add('show')
    const len = Array.from(c.text).length
    const ms = Math.round(SHOW_MIN_MS + Math.min(1, len / 24) * (SHOW_MAX_MS - SHOW_MIN_MS))
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      el.classList.remove('show')
      // 사라지는 애니메이션이 끝난 뒤, 기다리던 자막이 있으면 다시 차례를 잡는다(그사이 결과 배너가 떴다면 그 뒤로 간다)
      hideTimer = window.setTimeout(() => {
        showing = false
        if (pending) schedule()
      }, 180)
    }, ms)
  }

  /** 무대(stage.ts)에 차례를 건다: 결과 배너 같은 큰 알림이 지나간 뒤에 뜨고, 자막이 떠 있는 동안에는 업적 배너가 기다린다 */
  function schedule(): void {
    if (showing || beatTimer !== undefined || queued) return
    queued = true
    stagePlay(1, BEAT_MS + SHOW_MAX_MS, () => {
      queued = false
      if (!showing && beatTimer === undefined) beatTimer = window.setTimeout(next, BEAT_MS)
    })
  }

  function show(key: CaptionKey, n = 0): void {
    if (store.phase !== 'playing') return
    pending = { key, n }
    schedule()
  }

  function reset(): void {
    pending = null
    showing = false
    window.clearTimeout(beatTimer)
    window.clearTimeout(hideTimer)
    beatTimer = undefined
    el.classList.remove('show')
  }
  bus.on('phase', (ph) => {
    if (ph !== 'playing') reset()
  })

  // ───────── 포교 결과 ─────────
  const REJECT: Partial<Record<PitchOutcome, CaptionKey>> = { no: 'reject', ignore: 'ignore', flee: 'flee' }
  bus.onMsg('pitchRes', (m) => {
    const me = store.me
    if (!me || m.p !== me.id) return
    // 이 메시지가 올 때 내 통계는 아직 '이번 포교 전' 값이다(저장본은 1초마다 온다) → 이번 결과를 더해 계산
    const stats = me.prog.stats
    if (m.o === 'join' || m.o === 'king') {
      const streak = (stats['streak'] ?? 0) + 1
      const crew = Math.min(MAX_ENTOURAGE, me.entourage + 1)
      // 신도가 들어오면서 정원이 차 가장 오래된 신도가 떠나는 것은 '떠남' 자막감이 아니다
      followerMuteUntil = Math.max(followerMuteUntil, performance.now() + 1500)
      if (m.o === 'king') show('king')
      else if (me.prog.fol === 0) show('firstFollower')
      else if (streak >= 3) show('winStreak', streak)
      else if (crew >= 4) show('bigEntourage', crew)
      else show('join')
      return
    }
    if (m.o === 'more') {
      show('more')
      return
    }
    const key = REJECT[m.o]
    if (!key) return
    const fails = (stats['failStreak'] ?? 0) + 1
    if (fails >= 3) show('failStreak', fails)
    else show(key)
  })

  bus.on('rankUp', () => show('rankUp'))

  // ───────── 신도가 떠남(내 신도였던 NPC 의 주인이 바뀜) ─────────
  const mine = new Set<number>()
  const resync = (): void => {
    mine.clear()
    const me = store.me
    if (!me) return
    for (const [id, v] of store.npcs) if (v.pub.owner === me.id) mine.add(id)
  }
  bus.on('entered', resync)
  bus.onMsg('npcSpawn', (m) => {
    // 같은 id 에 새 시민이 올라오면 그 자리는 더 이상 내 신도가 아니다(떠남 자막은 nu 에서 이미 처리)
    mine.delete(m.n.id)
  })
  bus.onMsg('nu', (m) => {
    const me = store.me
    if (!me || m.owner === undefined) return
    if (m.owner === me.id) {
      mine.add(m.n)
      return
    }
    if (!mine.delete(m.n)) return
    if (performance.now() < followerMuteUntil) return
    show('followerLeft')
  })

  // ───────── 가만히 서 있기 ─────────
  let lastX = NaN
  let lastZ = NaN
  let stillSince = performance.now()
  let idleShown = false
  window.setInterval(() => {
    const me = store.me
    const now = performance.now()
    if (!me || store.phase !== 'playing') {
      stillSince = now
      return
    }
    if (Math.abs(me.x - lastX) > 0.05 || Math.abs(me.z - lastZ) > 0.05 || store.talk || ui.openPanelId) {
      lastX = me.x
      lastZ = me.z
      stillSince = now
      idleShown = false
      return
    }
    if (!idleShown && now - stillSince >= IDLE_MS) {
      idleShown = true
      show('idle')
    }
  }, 1000)

  return {
    show,
    muteFollowerLeft(ms) {
      followerMuteUntil = Math.max(followerMuteUntil, performance.now() + ms)
    },
  }
}
