/**
 * 길거리 포교 대화: '말 걸기' 상황 버튼 → 멘트 카드 시트 → 결과 배너.
 *
 * 원칙
 *  - 플레이어를 재촉하지 않는다. 숫자 카운트다운은 없고, 서버 제한 시간만 얇은 막대로 보여 준다.
 *  - 시트는 엄지가 닿는 아래쪽에 붙는다. 카드는 크게, 한 번 누르면 끝.
 *  - 결과 배너는 시트와 따로 산다. 서버가 결과(pitchRes)와 대화 종료(talkEnd)를 어떤 순서로 보내든
 *    배너는 1.6초 동안 온전히 보인다.
 */
import './talk.css'
import { NPC_REJECT_MEMORY_MS, TALK_TIMEOUT_MS } from '../../../shared/constants'
import { ARCHETYPE_INFO_BY_ID } from '../../../shared/content/archetypeInfo'
import { PITCH_LINES } from '../../../shared/content/lines'
import type { PitchCategory } from '../../../shared/content/types'
import { NpcModel, type PitchOutcome } from '../../../shared/types'
import type { AppContext, FxKind, SfxName } from '../core/contracts'
import type { TalkState } from '../core/store'
import { isTyping, playSfx } from './hud'
import { holdStage } from './stage'
import { clear, h } from './kit'

/** 소재는 개그 분류일 뿐이다(실제 화법 분류가 아니다). 실존 종교 상징은 아이콘으로 쓰지 않는다 */
const CATEGORY: Record<PitchCategory, { icon: string; name: string }> = {
  dao: { icon: '🌀', name: '정통파' },
  face: { icon: '🙂', name: '인상' },
  past: { icon: '⏳', name: '전생' },
  ancestor: { icon: '💤', name: '꿈' },
  energy: { icon: '✨', name: '기운' },
  time: { icon: '⏱️', name: '1분만' },
  fate: { icon: '🎲', name: '인연' },
  cosmic: { icon: '🛸', name: '우주' },
}

const RESULT_MS = 1600
/** 멘트를 고른 뒤 이 시간 안에 서버 응답이 없으면 카드를 다시 풀어 준다(먹통 방지) */
const WAIT_GUARD_MS = 4000

interface ResultView {
  icon: string
  titles: string[]
  subs: string[]
  tone: 'good' | 'more' | 'bad'
  sfx: SfxName
  fx: FxKind | null
}

const RESULT: Record<PitchOutcome, ResultView> = {
  join: { icon: '🎉', titles: ['신도 +1!'], subs: ['{npc}님이 졸졸 따라오기 시작했어요'], tone: 'good', sfx: 'join', fx: 'join' },
  king: { icon: '👑', titles: ['신도 +1!'], subs: ['전생의 왕을 찾아냈어요. 감격하셨대요'], tone: 'good', sfx: 'join', fx: 'join' },
  more: { icon: '🤔', titles: ['더 들어볼게요…'], subs: ['솔깃해하는 중! 한마디만 더 해 보세요'], tone: 'more', sfx: 'more', fx: null },
  no: {
    icon: '🙅',
    titles: ['정중하게 거절당했어요', '오늘은 인연이 아닌가 봐요', '철벽이었어요'],
    subs: ['그래도 근성은 +1', '거절도 경력이에요', '다음 시민은 다를 거예요. 아마도요'],
    tone: 'bad',
    sfx: 'fail',
    fx: 'fail',
  },
  ignore: {
    icon: '🎧',
    titles: ['못 들은 척 당했어요', '투명 인간이 된 기분이에요'],
    subs: ['그래도 근성은 +1', '들었는데 안 들은 거예요'],
    tone: 'bad',
    sfx: 'ignore',
    fx: 'fail',
  },
  flee: {
    icon: '💨',
    titles: ['전력 질주로 도망갔어요!', '방금 그분, 육상부였나 봐요!'],
    subs: ['…그렇게까지 뛸 일인가요', '인상이 너무 좋았나 봐요'],
    tone: 'bad',
    sfx: 'flee',
    fx: 'flee',
  },
  rival: { icon: '😎', titles: ['저쪽도 교주였어요?!'], subs: ['포교하러 갔다가 포교당하는 중'], tone: 'bad', sfx: 'fail', fx: 'fail' },
}

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!

/** 시트가 뜬 뒤 이 시간 동안은 멘트 선택·그만두기를 받지 않는다(연타 방지) */
const OPEN_GUARD_MS = 380

export function mountTalk(ctx: AppContext): void {
  const { store, bus, ui } = ctx

  // ───────── 상황 버튼: 말 걸기 ─────────
  /** 서버가 알려 준 포교 쿨타임(talkNo cool) — store.pitchReadyAt 가 아직 반영되지 않았을 때의 보조값 */
  let coolUntil = 0
  /**
   * 방금 나를 거절한 NPC 는 한동안 말을 듣지 않는다(서버 규칙). 눌러 보고 나서야 "방금 거절하신 분"이라고
   * 알게 되는 것보다, 버튼에 남은 시간을 미리 보여 주는 편이 친절하다. npcId → 다시 말 걸 수 있는 시각(performance.now)
   */
  const refusedUntil = new Map<number, number>()

  ui.addContextProvider(() => {
    if (store.phase !== 'playing' || store.talk) return null
    const id = store.near.npc
    if (!id) return null
    const npc = store.npcs.get(id)
    const ready = Math.max(store.pitchReadyAt, coolUntil, refusedUntil.get(id) ?? 0)
    return {
      id: 'talk',
      label: '말 걸기',
      icon: npc?.pub.model === NpcModel.Cat ? '🐈' : '🗣️',
      primary: true,
      readyAt: ready > performance.now() ? ready : undefined,
      onClick: () => ctx.actions.talk(id),
    }
  })
  // 같은 id 로 새 시민이 올라오면(교체) 거절 기억도 지운다
  bus.on('npcSpawn', (id) => void refusedUntil.delete(id))
  bus.on('entered', () => {
    refusedUntil.clear()
    coolUntil = 0
  })

  // ───────── 시트 DOM ─────────
  const timer = h('div.talk-timer', { 'aria-hidden': 'true' })
  const nameEl = h('b.talk-name')
  const archEl = h('span.tag.npc.talk-arch')
  const roundEl = h('span.tag.talk-round.hidden', '한 번 더!')
  const greetEl = h('p.talk-greet')
  const promptEl = h('p.talk-prompt')
  const linesEl = h('div.talk-lines')
  const quitBtn = h(
    'button.btn.sm.ghost.talk-quit',
    {
      type: 'button',
      onclick: () => {
        if (performance.now() - openedAt < OPEN_GUARD_MS) return
        playSfx(ctx, 'close')
        ctx.actions.endTalk()
      },
    },
    '그만두기',
  )
  const sheet = h(
    'div.talk-sheet.interactive.hidden',
    { role: 'dialog', 'aria-label': '포교 멘트 고르기' },
    timer,
    h('div.talk-head', h('div.talk-who', nameEl, archEl, roundEl), greetEl),
    linesEl,
    h('div.talk-foot', promptEl, quitBtn),
  )

  const resIcon = h('span.talk-result-icon')
  const resTitle = h('b.talk-result-title')
  const resSub = h('span.talk-result-sub')
  const result = h('div.talk-result.hidden', { role: 'status' }, resIcon, h('span.talk-result-text', resTitle, resSub))

  ui.root.append(sheet, result)

  // ───────── 상태 ─────────
  let open = false
  let shownKey = ''
  let lineIds: number[] = []
  let lineBtns: HTMLButtonElement[] = []
  let pickedAt = 0
  let picked = -1
  let guardTimer = 0
  let resultTimer = 0
  /** 기싸움 화면에 자리를 내준 대화의 키. 같은 대화가 이어지는 동안에는 시트를 다시 띄우지 않는다 */
  let yieldedKey = ''

  function npcLabel(npcId: number): { name: string; arch: string } {
    const pub = store.npcs.get(npcId)?.pub
    if (!pub) return { name: '지나가던 시민', arch: '' }
    return { name: pub.name, arch: ARCHETYPE_INFO_BY_ID.get(pub.arch)?.name ?? '' }
  }

  function isWaiting(t: TalkState): boolean {
    return t.waiting || (picked >= 0 && performance.now() - pickedAt < WAIT_GUARD_MS)
  }

  function applyWaiting(waiting: boolean): void {
    sheet.classList.toggle('waiting', waiting)
    lineBtns.forEach((btn, i) => {
      btn.disabled = waiting
      btn.classList.toggle('picked', waiting && lineIds[i] === picked)
    })
    promptEl.textContent = waiting ? '반응을 기다리는 중…' : '어떤 말로 포교할까요? 천천히 골라도 돼요.'
  }

  function choose(lineId: number): void {
    const t = store.talk
    if (!t || !open || isWaiting(t) || !lineIds.includes(lineId)) return
    // [말 걸기]를 두 번 톡톡 누르면 두 번째 누름이 막 올라온 시트(멘트 카드·그만두기)에 떨어진다 → 뜬 직후에는 받지 않는다
    if (performance.now() - openedAt < OPEN_GUARD_MS) return
    picked = lineId
    pickedAt = performance.now()
    playSfx(ctx, 'pick')
    applyWaiting(true)
    ctx.actions.pitch(lineId)
    clearTimeout(guardTimer)
    guardTimer = window.setTimeout(() => {
      // 응답이 끝내 안 오면(연결 불안정) 다시 고를 수 있게 풀어 준다
      const cur = store.talk
      if (cur && open && !cur.waiting) {
        picked = -1
        applyWaiting(false)
      }
    }, WAIT_GUARD_MS + 50)
  }

  function renderRound(t: TalkState): void {
    const who = npcLabel(t.npc)
    nameEl.textContent = who.name
    archEl.textContent = who.arch
    archEl.classList.toggle('hidden', !who.arch)
    roundEl.classList.toggle('hidden', t.round < 2)
    greetEl.textContent = t.greet

    clear(linesEl)
    lineIds = t.lines.slice()
    lineBtns = lineIds.map((id, i) => {
      const line = PITCH_LINES[id]
      const cat = line ? CATEGORY[line.cat] : undefined
      return h(
        'button.talk-line',
        { type: 'button', onclick: () => choose(id) },
        h('kbd.talk-key', { 'aria-hidden': 'true' }, String(i + 1)),
        h('span.talk-line-text', line?.text ?? '…'),
        cat ? h('span.talk-cat', h('span', { 'aria-hidden': 'true' }, cat.icon), cat.name) : null,
      )
    })
    linesEl.append(...lineBtns)

    // 제한 시간 막대: 라운드마다 처음부터 다시(노드를 새로 넣어 애니메이션을 재시작)
    const fill = h('i')
    fill.style.animationDuration = TALK_TIMEOUT_MS + 'ms'
    timer.replaceChildren(fill)
  }

  const keyOf = (t: TalkState): string => `${t.npc}:${t.round}:${t.lines.join(',')}`
  /** 시트가 뜬 시각 — 뜬 직후의 누름(연타의 두 번째)을 걸러 내는 데 쓴다 */
  let openedAt = -1e9

  function onTalk(t: TalkState | null): void {
    if (!t) {
      yieldedKey = ''
      closeSheet()
      return
    }
    const key = keyOf(t)
    if (key === yieldedKey) return
    yieldedKey = ''
    if (key !== shownKey) {
      shownKey = key
      picked = -1
      clearTimeout(guardTimer)
      renderRound(t)
    } else if (!t.waiting && picked >= 0 && performance.now() - pickedAt > 250) {
      // 같은 라운드인데 서버가 대기 상태를 풀었다(잘못된 선택 등) → 다시 고를 수 있게
      picked = -1
    }
    if (!open) {
      open = true
      openedAt = performance.now()
      sheet.classList.remove('hidden')
      playSfx(ctx, 'talk')
    }
    applyWaiting(isWaiting(t))
    placeResult()
  }

  function closeSheet(): void {
    if (!open) return
    open = false
    shownKey = ''
    picked = -1
    lineIds = []
    lineBtns = []
    clearTimeout(guardTimer)
    sheet.classList.add('hidden')
    timer.replaceChildren()
    placeResult()
  }

  /**
   * 배너 자리. 프레임 루프가 아니라 상태가 바뀔 때만 잰다.
   *  - 시트가 열려 있으면(한 번 더!) 시트 바로 위: 새 멘트 카드를 가리지 않는다.
   *  - 시트가 닫혔으면 내 캐릭터 발밑: 머리 위의 말풍선·이름표와 아래쪽 버튼 사이의 빈 곳이다.
   */
  function placeResult(): void {
    if (open) {
      result.style.top = 'auto'
      result.style.bottom = sheet.offsetHeight + 22 + 'px'
      return
    }
    const me = store.me
    const vh = window.innerHeight
    if (me && ctx.engine.project(me.x, me.y, me.z, feet)) {
      result.style.top = Math.round(Math.max(vh * 0.3, Math.min(vh * 0.7, feet.y + 18))) + 'px'
      result.style.bottom = 'auto'
    } else {
      result.style.top = ''
      result.style.bottom = ''
    }
  }
  const feet = { x: 0, y: 0 }

  function showResult(o: PitchOutcome, npcId: number): void {
    const view = RESULT[o] ?? RESULT.no
    resIcon.textContent = view.icon
    resTitle.textContent = pick(view.titles)
    resSub.textContent = pick(view.subs).replace('{npc}', npcLabel(npcId).name)
    result.className = 'talk-result ' + view.tone
    placeResult()
    // 결과 배너가 보이는 동안에는 자막·업적 배너가 그 위에 겹쳐 뜨지 않게 차례를 잡아 둔다
    holdStage(RESULT_MS - 150)
    clearTimeout(resultTimer)
    resultTimer = window.setTimeout(() => {
      result.classList.add('out')
      resultTimer = window.setTimeout(() => result.classList.add('hidden'), 220)
    }, RESULT_MS)
  }

  // ───────── 서버 이벤트 ─────────
  bus.on('talk', onTalk)

  bus.onMsg('pitchRes', (msg) => {
    const view = RESULT[msg.o] ?? RESULT.no
    // 이펙트는 누구의 포교든 모두가 본다
    const npc = store.npcs.get(msg.n)
    if (npc && view.fx) {
      try {
        ctx.fx.burst(view.fx, npc.x, npc.y, npc.z)
      } catch {
        /* 이펙트 실패는 무시 */
      }
    }
    if (!store.me || msg.p !== store.me.id) return
    playSfx(ctx, view.sfx)
    picked = -1
    clearTimeout(guardTimer)
    // 라이벌(기싸움)은 다른 시스템이 이어받으므로 여기서 단정하지 않는다
    if (msg.o === 'no' || msg.o === 'ignore' || msg.o === 'flee') refusedUntil.set(msg.n, performance.now() + NPC_REJECT_MEMORY_MS)
    showResult(msg.o, msg.n)
    ui.refreshContext()
  })

  bus.onMsg('talkNo', (msg) => {
    const sec = Math.max(1, Math.ceil((msg.ms ?? 0) / 1000))
    // 남은 시간을 버튼에도 바로 보여 준다(다음 0.5초 갱신을 기다리지 않는다)
    if (msg.why === 'cool' && msg.ms) coolUntil = performance.now() + msg.ms
    if (msg.why === 'memo') refusedUntil.set(msg.n, performance.now() + (msg.ms || NPC_REJECT_MEMORY_MS))
    ui.refreshContext()
    switch (msg.why) {
      case 'cool':
        ui.toast(msg.ms ? `아직 숨 고르는 중이에요. ${sec}초만 기다려 주세요.` : '아직 숨 고르는 중이에요. 잠깐만 기다려 주세요.', 'info')
        break
      case 'busy':
        ui.toast('지금은 다른 분과 이야기 중이에요. 다른 시민을 찾아보세요.', 'info')
        break
      case 'far':
        ui.toast('너무 멀어요. 조금 더 가까이 가서 말을 걸어 보세요.', 'info')
        break
      case 'memo':
        ui.toast(msg.ms ? `방금 거절하신 분이에요. ${sec}초 뒤에 다시 도전해 보세요.` : '방금 거절하신 분이에요. 다른 시민부터 만나 보세요.', 'info')
        break
      case 'mine':
        ui.toast('이미 교주님의 신도예요. 다른 시민에게 말을 걸어 보세요.', 'info')
        break
      default:
        ui.toast('어라, 벌써 가 버렸어요. 다른 시민을 찾아보세요.', 'info')
    }
  })

  bus.onMsg('talkEnd', (msg) => {
    if (msg.why === 'timeout') ui.toast('시민이 기다리다 가 버렸어요. 다음엔 한마디 건네 보세요.', 'info')
    else if (msg.why === 'gone') ui.toast('시민이 자리를 떠났어요. 다른 분을 찾아보세요.', 'info')
  })

  // 숫자키 1~4 = 멘트 선택, Esc = 그만두기 (패널이 열려 있으면 패널이 먼저 닫힌다)
  window.addEventListener('keydown', (e) => {
    if (!open || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping() || ui.openPanelId) return
    if (e.key === 'Escape') {
      playSfx(ctx, 'close')
      ctx.actions.endTalk()
      return
    }
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
    if (!m) return
    const id = lineIds[Number(m[1]) - 1]
    if (id === undefined) return
    e.preventDefault()
    choose(id)
  })

  bus.on('phase', () => {
    // 끊기거나 내보내지면 대화도 끝난 것이다(net 이 talk 를 비우지 못했더라도 시트는 닫는다)
    if (store.phase !== 'playing' && store.phase !== 'reconnecting') closeSheet()
  })
  window.addEventListener('resize', () => {
    if (!result.classList.contains('hidden')) placeResult()
  })

  // 안전망: 'talk' 이벤트를 놓쳐도(다른 모듈이 store 만 바꾼 경우) 시트가 store 와 어긋난 채로 남지 않게 한다.
  // 대화 중에는 이동이 막히므로, 시트가 안 뜨면 플레이어가 그대로 갇힌다.
  window.setInterval(() => {
    const t = store.talk
    if (store.phase !== 'playing' && store.phase !== 'reconnecting') return
    if (!t) {
      yieldedKey = ''
      if (open) closeSheet()
    } else if (keyOf(t) !== yieldedKey && (!open || shownKey !== keyOf(t))) {
      onTalk(t)
    }
  }, 400)

  // "저도 사실 교주입니다" → 기싸움은 다른 모듈의 화면이다. 대화 세션이 서버에 남아 있더라도 멘트 시트는 비켜 준다
  bus.onMsg('duel', (msg) => {
    if (msg.ph !== 'start' || !open) return
    if (store.talk) yieldedKey = keyOf(store.talk)
    closeSheet()
  })

  if (store.talk) onTalk(store.talk)
}
