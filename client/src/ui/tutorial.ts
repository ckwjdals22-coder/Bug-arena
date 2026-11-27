/**
 * 첫 접속 안내(가볍게), 장소 표지, 만석 대기 놀이, 복귀 인사.
 *  - 안내는 게임을 멈추지 않는 작은 말풍선 하나씩. 실제로 해 보면 다음으로 넘어간다.
 *  - 장소 표지는 조금 떨어진 주요 장소(단상, 헌금함, 4번 출구, 교단 건물)를 은은하게 알려 준다.
 *  - 방이 가득 차 기다릴 때는 전단지를 접으며 놀게 하고, 자리가 나면 자동으로 들어간다.
 */
import { RANKS } from '../../../shared/content/core'
import { WORLD } from '../../../shared/world'
import type { AppContext } from '../core/contracts'
import { saveProfile } from '../core/store'
import { clear, h } from './kit'
import './tutorial.css'

type Step = 'move' | 'talk' | 'pick' | 'done'

interface Pin {
  icon: string
  label: string
  x: number
  z: number
  el: HTMLElement
  locked?: () => boolean
}

function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export function mountTutorial(ctx: AppContext): void {
  const { store, bus, ui, engine } = ctx

  // ═════════ 첫 접속 안내 ═════════
  const hint = h('div.tutorial-hint.hidden', { role: 'status' })
  const hintText = h('span.tutorial-hint-text')
  const hintSkip = h('button.tutorial-skip', { type: 'button', 'aria-label': '안내 끄기' }, '안내 끄기')
  hint.append(hintText, hintSkip)
  ui.root.append(hint)

  let step: Step = store.profile.tutorialDone ? 'done' : 'move'
  let startX = 0
  let startZ = 0
  let fails = 0
  let lingerTimer: ReturnType<typeof setTimeout> | undefined

  function finish(): void {
    step = 'done'
    hint.classList.add('hidden')
    if (!store.profile.tutorialDone) {
      store.profile.tutorialDone = true
      saveProfile(store.profile)
    }
  }
  hintSkip.addEventListener('click', finish)

  function show(text: string): void {
    hintText.textContent = text
    hint.classList.remove('hidden')
    hint.classList.remove('pop')
    void hint.offsetWidth
    hint.classList.add('pop')
  }
  function showStep(): void {
    if (step === 'done' || store.phase !== 'playing') {
      hint.classList.add('hidden')
      return
    }
    if (step === 'move') show(isTouch() ? '👆 화면 왼쪽을 누른 채 밀어서 움직여 보세요' : '⌨️ WASD 또는 방향키로 움직여 보세요')
    else if (step === 'talk') show(isTouch() ? '🗣️ 시민에게 다가가 [말 걸기]를 눌러 보세요' : '🗣️ 시민에게 다가가 [말 걸기](E)를 눌러 보세요')
    else if (step === 'pick') show('🎲 멘트를 골라 보세요 — 통할지는 운과 상성!')
  }

  bus.on('entered', () => {
    const me = store.me
    if (!me) return
    startX = me.x
    startZ = me.z
    showStep()
  })
  bus.on('phase', (p) => {
    if (p !== 'playing') hint.classList.add('hidden')
    else showStep()
  })
  bus.on('talk', (t) => {
    if (step === 'done') return
    if (t && (step === 'move' || step === 'talk')) {
      step = 'pick'
      showStep()
    }
  })
  bus.onMsg('pitchRes', (m) => {
    if (step === 'done' || !store.me || m.p !== store.me.id || m.o === 'more') return
    clearTimeout(lingerTimer)
    if (m.o === 'join' || m.o === 'king') {
      // 결과 배너·업적 카드가 한꺼번에 뜨는 순간에는 잠깐 비켜 있다가, 그것들이 지나간 뒤에 다음 안내를 띄운다
      hint.classList.add('hidden')
      step = 'talk' // 표시만 유지하고 곧 끝낸다
      lingerTimer = setTimeout(() => {
        if (step === 'done' || store.phase !== 'playing') return
        show('🎉 신도가 따라옵니다! 단상 📜 과 헌금함 🎁 에도 데려가 보세요')
        lingerTimer = setTimeout(finish, 6000)
      }, 2800)
    } else if (++fails >= 3) {
      show('😌 괜찮아요, 거절도 수집됩니다. 다른 시민에게도 말을 걸어 보세요')
      lingerTimer = setTimeout(finish, 6000)
    } else {
      step = 'talk'
      showStep()
    }
  })

  // ═════════ 장소 표지 ═════════
  const pinLayer = h('div.tutorial-pins')
  ui.root.append(pinLayer)
  const mkPin = (icon: string, label: string, x: number, z: number, locked?: () => boolean): Pin => {
    const el = h('div.tutorial-pin', h('span.tutorial-pin-icon', icon), h('span.tutorial-pin-label', label))
    pinLayer.append(el)
    return { icon, label, x, z, el, locked }
  }
  const hqRank = RANKS[WORLD.hq.minRank]?.name ?? ''
  const pins: Pin[] = [
    mkPin('📜', '단상', WORLD.podium.x, WORLD.podium.z),
    mkPin('🎁', '헌금함', WORLD.offeringBox.x, WORLD.offeringBox.z),
    mkPin('🚇', '4번 출구', WORLD.subway.x, WORLD.subway.z),
    mkPin('👁️', '교단 건물', WORLD.hq.door.x, WORLD.hq.door.z, () => (store.me?.prog.rank ?? 0) < WORLD.hq.minRank),
  ]
  for (const b of WORLD.booths.slice(0, 1)) pins.push(mkPin('⛱️', '포교 부스', b.x, b.z))
  const scr = { x: 0, y: 0 }

  function updatePins(): void {
    const me = store.me
    const playing = store.phase === 'playing' && !!me
    let shown = 0
    for (const pin of pins) {
      let visible = false
      if (playing && me && shown < 4) {
        const d = Math.hypot(pin.x - me.x, pin.z - me.z)
        const locked = pin.locked?.() ?? false
        // 잠긴 곳의 표지는 문 앞까지 가도 남겨 둔다(왜 못 들어가는지 그 자리에서 보이게)
        if (d > (locked ? 1.2 : 8) && d < 60 && engine.project(pin.x, 3.2, pin.z, scr)) {
          visible = true
          shown++
          const fade = d > 40 ? Math.max(0.25, 1 - (d - 40) / 20) : 0.9
          pin.el.style.transform = `translate3d(${Math.round(scr.x)}px, ${Math.round(scr.y)}px, 0) translate(-50%, -100%)`
          pin.el.style.opacity = String(fade)
          const label = pin.el.lastElementChild as HTMLElement
          const text = locked ? `🔒 ${hqRank}부터` : pin.label
          if (label.textContent !== text) label.textContent = text
        }
      }
      pin.el.classList.toggle('hidden', !visible)
    }
  }

  // ═════════ 교단 건물 문 앞: 직급이 모자라면 이유를 알려 준다 ═════════
  let gateToastAt = 0
  function checkHqGate(): void {
    const me = store.me
    if (!me || store.phase !== 'playing' || me.prog.rank >= WORLD.hq.minRank) return
    const door = WORLD.hq.door
    if (Math.hypot(me.x - door.x, me.z - door.z) > door.r + 0.6) return
    const now = performance.now()
    if (now - gateToastAt < 9000) return
    gateToastAt = now
    const need = RANKS[WORLD.hq.minRank]
    ui.toast(`🔒 교단 건물은 ${hqRank}(영향력 ${need?.inf ?? 0})부터 들어갈 수 있어요. 지금은 ${RANKS[me.prog.rank]?.name ?? ''}.`, 'info', 4200)
  }

  // ═════════ 프레임 루프(가벼움: 표지 5개 + 이동 거리 확인) ═════════
  function frame(): void {
    requestAnimationFrame(frame)
    if (document.hidden) return
    updatePins()
    checkHqGate()
    const me = store.me
    if (step === 'move' && me && store.phase === 'playing' && Math.hypot(me.x - startX, me.z - startZ) > 3) {
      step = 'talk'
      showStep()
    }
  }
  requestAnimationFrame(frame)

  // ═════════ 만석 대기: 전단지 접기 + 자동 재시도 ═════════
  const wait = h('div.tutorial-wait.hidden')
  ui.root.append(wait)
  let folded = 0
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let retryIn = 5

  function drawWait(): void {
    clear(wait)
    wait.append(
      h('div.tutorial-wait-title', '🧾 기다리는 동안 전단지나 접으실래요?'),
      h(
        'button.btn.primary.big.tutorial-fold',
        {
          type: 'button',
          onclick: () => {
            folded++
            ctx.sfx.play('pop')
            drawWait()
          },
        },
        folded === 0 ? '전단지 접기' : `전단지 ${folded}장 접음`,
      ),
      h('div.muted.small', folded >= 30 ? '이쯤 되면 접기의 달인. 자리는 곧 납니다.' : `자리가 나면 바로 들어갑니다 · ${retryIn}초 뒤 다시 확인`),
    )
  }
  function setWaiting(on: boolean): void {
    wait.classList.toggle('hidden', !on)
    clearInterval(retryTimer)
    retryTimer = undefined
    if (!on) return
    retryIn = 5
    drawWait()
    retryTimer = setInterval(() => {
      if (store.phase !== 'full') return setWaiting(false)
      retryIn--
      if (retryIn <= 0) {
        // 여유 있는 방으로 자동 입장 시도. 여전히 가득이면 다시 'full' 로 돌아와 이어서 기다린다
        ctx.actions.enter('auto')
        return
      }
      drawWait()
    }, 1000)
  }
  bus.on('phase', (p) => setWaiting(p === 'full'))

  // ═════════ 오래 자리를 비웠다 돌아왔을 때 ═════════
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now()
    } else if (hiddenAt && Date.now() - hiddenAt > 3 * 60_000) {
      hiddenAt = 0
      setTimeout(() => ui.toast('다시 오셨군요. 포교는 계속됩니다.', 'info'), 800)
    }
  })
}
