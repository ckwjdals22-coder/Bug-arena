/**
 * 입력: 키보드(WASD/방향키/Shift), 마우스(드래그 = 시점, 휠 = 줌, 클릭 = 이동), 터치(왼쪽 절반 = 떠다니는 조이스틱,
 * 오른쪽 절반 드래그 = 시점, 짧은 탭 = 그곳으로 이동, 두 손가락 = 줌).
 * 캔버스 위에서 시작한 포인터만 다룬다(버튼 등 UI 위 입력은 DOM 이 먼저 가져간다).
 */
import type { InputApi } from '../core/contracts'
import './input.css'
import { classifyPinch, PINCH_FAR_MAX_PX } from './pinch'

const TAP_MAX_MOVE = 9
const TAP_MAX_MS = 280
/**
 * 핀치로 볼 조건: 두 번째 손가락이 이 시간 안에 닿는다.
 * 이 거리 안이면 곧바로 핀치, 더 멀면(축소 핀치는 손가락을 벌린 채 시작한다) 처음 움직임을 보고 정한다(pinch.ts)
 */
const PINCH_GRACE_MS = 250
const PINCH_NEAR_PX = 170
const JOY_RADIUS = 56
const JOY_DEADZONE = 0.14
const JOY_RUN = 0.86

interface PointerInfo {
  id: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  startAt: number
  moved: number
  role: 'joy' | 'look' | 'mouse'
  /** 핀치로 시작한 손가락: 떼어도 '짧은 탭 = 그곳으로 이동'으로 치지 않는다 */
  pinch?: boolean
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function createInput(canvas: HTMLCanvasElement, uiRoot: HTMLElement): InputApi {
  const keys = new Set<string>()
  const pointers = new Map<number, PointerInfo>()
  let joy: PointerInfo | null = null
  let joyX = 0
  let joyY = 0
  let camYaw = 0
  let camPitch = 0
  let camZoom = 0
  let tap: { clientX: number; clientY: number } | null = null
  let pinchDist = 0
  /**
   * 판단 대기 중인 두 손가락(하나는 조이스틱). 대기하는 동안은 걷지도, 시점을 돌리지도 않는다.
   * 핀치로 판명되면 조이스틱을 놓아 주고 줌으로, 아니면 원래대로 걷기+시점 돌리기로 돌아간다.
   */
  let pending: { a: PointerInfo; b: PointerInfo } | null = null
  let moveX = 0
  let moveY = 0
  let run = false

  const joyBase = document.createElement('div')
  joyBase.className = 'joy-base hidden'
  const joyKnob = document.createElement('div')
  joyKnob.className = 'joy-knob'
  joyBase.append(joyKnob)
  uiRoot.append(joyBase)

  // ───── 키보드 ─────
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    keys.add(e.code)
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
  })
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code)
  })
  const clearKeys = (): void => {
    keys.clear()
  }
  window.addEventListener('blur', clearKeys)
  document.addEventListener('visibilitychange', clearKeys)

  // ───── 포인터 ─────
  function lookPointers(): PointerInfo[] {
    const out: PointerInfo[] = []
    for (const p of pointers.values()) if (p.role === 'look') out.push(p)
    return out
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return
    canvas.setPointerCapture?.(e.pointerId)
    const info: PointerInfo = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      // 처리한 시각이 아니라 손가락이 닿은 시각: 무거운 프레임 뒤에 두 pointerdown 이 몰려 오면 처리 시각 차이가 실제보다 커져 핀치를 놓친다
      startAt: e.timeStamp,
      moved: 0,
      role: 'mouse',
    }
    // 두 손가락이 거의 동시에, 서로 가까이 닿았고 첫 손가락이 아직 움직이지 않았다 = 걷기가 아니라 확대/축소(핀치)다.
    // 두 손가락 모두 시점(look) 손가락으로 만든다: 첫 손가락이 조이스틱이었으면 놓아 주고(걷지 않게),
    // 두 번째 손가락도 왼쪽 절반에 닿았다고 새 조이스틱이 되면 안 된다(그러면 시점 손가락이 하나뿐이라 줌이 안 되고 캐릭터만 걷는다).
    // (양손 엄지로 이동+시점을 동시에 잡는 경우는 두 손가락이 멀리 떨어져 있거나 시간 차가 커서 여기에 걸리지 않는다.
    //  멀리 떨어져 거의 동시에 닿은 경우는 아래 pending 에서 처음 움직임을 보고 핀치인지 정한다)
    let pinchStart = false
    let maybePinch: PointerInfo | null = null
    if (e.pointerType !== 'mouse') {
      const now = e.timeStamp
      for (const p of pointers.values()) {
        if (p.role === 'mouse' || p.moved > TAP_MAX_MOVE || now - p.startAt >= PINCH_GRACE_MS) continue
        const sep = Math.hypot(e.clientX - p.startX, e.clientY - p.startY)
        if (sep >= PINCH_NEAR_PX) {
          // 멀리 떨어져 닿았다: 양손 엄지일 수도, 벌린 채 시작한 축소 핀치일 수도 있다 → 움직임을 보고 정한다
          if (!pending && sep < PINCH_FAR_MAX_PX) maybePinch = p
          continue
        }
        pinchStart = true
        p.pinch = true
        if (p === joy) {
          p.role = 'look'
          joy = null
          joyX = 0
          joyY = 0
          joyBase.classList.add('hidden')
        }
      }
    }
    if (e.pointerType === 'mouse') {
      info.role = 'mouse'
    } else if (pinchStart) {
      info.role = 'look'
      info.pinch = true
    } else if (!joy && e.clientX < window.innerWidth * 0.5) {
      info.role = 'joy'
      joy = info
      joyX = 0
      joyY = 0
      joyBase.style.transform = `translate3d(${e.clientX - JOY_RADIUS}px, ${e.clientY - JOY_RADIUS}px, 0)`
      joyKnob.style.transform = 'translate3d(0,0,0)'
    } else {
      info.role = 'look'
    }
    pointers.set(e.pointerId, info)
    if (lookPointers().length === 2) pinchDist = currentPinch()
    // 둘 다 시점 손가락이면 이미 줌으로 처리된다. 조이스틱이 끼어 있을 때만 판단을 미룬다
    if (maybePinch && !pinchStart && (maybePinch.role === 'joy' || info.role === 'joy')) {
      pending = { a: maybePinch, b: info }
    }
  })

  /** 대기 중이던 두 손가락이 핀치로 판명됐다: 둘 다 시점 손가락으로 바꾸고, 지금까지 벌어지거나 모인 만큼 줌을 바로 반영한다 */
  function becomePinch(pd: { a: PointerInfo; b: PointerInfo }): void {
    for (const p of [pd.a, pd.b]) {
      p.pinch = true
      if (p === joy) {
        p.role = 'look'
        joy = null
        joyX = 0
        joyY = 0
        joyBase.classList.add('hidden')
      }
    }
    pinchDist = Math.hypot(pd.a.startX - pd.b.startX, pd.a.startY - pd.b.startY)
  }

  function currentPinch(): number {
    const lp = lookPointers()
    if (lp.length < 2) return 0
    return Math.hypot(lp[0]!.lastX - lp[1]!.lastX, lp[0]!.lastY - lp[1]!.lastY)
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.lastX
    const dy = e.clientY - p.lastY
    p.lastX = e.clientX
    p.lastY = e.clientY
    p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.startX, e.clientY - p.startY))
    let waiting = false
    if (pending && (p === pending.a || p === pending.b)) {
      const v = classifyPinch(pending.a, pending.b)
      if (v === 'pinch') becomePinch(pending)
      if (v === 'wait') waiting = true
      else {
        if (v === 'not') {
          // 양손 엄지로 판명됐다: 기다리는 동안 시점 손가락이 움직인 만큼을 지금 한꺼번에 돌려준다(첫 드래그가 씹히지 않게).
          // 이 이벤트가 시점 손가락의 것이면 이번 이동분(dx, dy)은 아래에서 평소대로 더해지므로 여기서는 뺀다
          const look = pending.a.role === 'look' ? pending.a : pending.b.role === 'look' ? pending.b : null
          if (look && look.moved > TAP_MAX_MOVE) {
            camYaw -= (look.lastX - look.startX - (look === p ? dx : 0)) * 0.0055
            camPitch += (look.lastY - look.startY - (look === p ? dy : 0)) * 0.004
          }
        }
        pending = null
      }
    }
    if (p.role === 'joy') {
      let jx = (e.clientX - p.startX) / JOY_RADIUS
      let jy = (e.clientY - p.startY) / JOY_RADIUS
      const len = Math.hypot(jx, jy)
      if (len > 1) {
        jx /= len
        jy /= len
      }
      joyX = jx
      joyY = jy
      if (p.moved > TAP_MAX_MOVE && !waiting) joyBase.classList.remove('hidden')
      joyKnob.style.transform = `translate3d(${jx * JOY_RADIUS}px, ${jy * JOY_RADIUS}px, 0)`
      return
    }
    if (p.role === 'look') {
      const lp = lookPointers()
      if (lp.length >= 2) {
        const d = currentPinch()
        if (pinchDist > 0 && d > 0) camZoom += (pinchDist - d) * 0.02
        pinchDist = d
        return
      }
    }
    if (waiting) return
    if (p.moved > TAP_MAX_MOVE) {
      camYaw -= dx * 0.0055
      camPitch += dy * 0.004
    }
  })

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    const p = pointers.get(e.pointerId)
    if (!p) return
    pointers.delete(e.pointerId)
    if (pending && (p === pending.a || p === pending.b)) pending = null
    const quick = e.timeStamp - p.startAt < TAP_MAX_MS && p.moved < TAP_MAX_MOVE
    if (p.role === 'joy') {
      joy = null
      joyX = 0
      joyY = 0
      joyBase.classList.add('hidden')
    }
    if (p.role === 'look') pinchDist = 0
    if (!cancelled && quick && !p.pinch && (e.pointerType !== 'mouse' || e.button === 0)) {
      tap = { clientX: e.clientX, clientY: e.clientY }
    }
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false))
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true))
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      camZoom += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100) * 0.9
    },
    { passive: false },
  )
  // iOS 사파리의 제스처 확대 방지
  document.addEventListener('gesturestart', (e) => e.preventDefault())

  const api: InputApi = {
    get moveX() {
      return moveX
    },
    get moveY() {
      return moveY
    },
    get run() {
      return run
    },
    consumeCamera() {
      const out = { yaw: camYaw, pitch: camPitch, zoom: camZoom }
      camYaw = 0
      camPitch = 0
      camZoom = 0
      return out
    },
    consumeTap() {
      const t = tap
      tap = null
      return t
    },
    update() {
      let x = 0
      let y = 0
      if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1
      if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1
      if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1
      if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1
      let r = keys.has('ShiftLeft') || keys.has('ShiftRight')
      if (x !== 0 || y !== 0) {
        const len = Math.hypot(x, y)
        x /= len
        y /= len
      } else if (joy && !(pending && (joy === pending.a || joy === pending.b))) {
        const len = Math.hypot(joyX, joyY)
        if (len > JOY_DEADZONE) {
          // 조이스틱: 화면 아래(+y)가 뒤로 → 앞(+)이 되도록 뒤집는다
          x = joyX
          y = -joyY
          r = len > JOY_RUN
        }
      }
      // 키보드로 시점 돌리기(Q/E 는 E 가 상황 버튼이라 쓰지 않고 , . 키 사용)
      if (keys.has('Comma')) camYaw += 0.04
      if (keys.has('Period')) camYaw -= 0.04
      moveX = x
      moveY = y
      run = r
    },
  }
  return api
}
