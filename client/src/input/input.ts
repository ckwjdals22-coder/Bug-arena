/**
 * 입력: 키보드(WASD/방향키/Shift), 마우스(드래그 = 시점, 휠 = 줌, 클릭 = 이동), 터치(왼쪽 절반 = 떠다니는 조이스틱,
 * 오른쪽 절반 드래그 = 시점, 짧은 탭 = 그곳으로 이동, 두 손가락 = 줌).
 * 캔버스 위에서 시작한 포인터만 다룬다(버튼 등 UI 위 입력은 DOM 이 먼저 가져간다).
 */
import type { InputApi } from '../core/contracts'
import './input.css'

const TAP_MAX_MOVE = 9
const TAP_MAX_MS = 280
/** 핀치로 볼 조건: 두 번째 손가락이 이 시간 안에, 이 거리 안에 닿는다 */
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
      startAt: performance.now(),
      moved: 0,
      role: 'mouse',
    }
    if (
      e.pointerType !== 'mouse' &&
      joy &&
      joy.moved <= TAP_MAX_MOVE &&
      performance.now() - joy.startAt < PINCH_GRACE_MS &&
      Math.hypot(e.clientX - joy.startX, e.clientY - joy.startY) < PINCH_NEAR_PX
    ) {
      // 두 손가락이 거의 동시에, 서로 가까이 닿았고 첫 손가락이 아직 움직이지 않았다 = 걷기가 아니라 확대/축소(핀치)다.
      // 화면 왼쪽 절반에서 시작한 핀치가 캐릭터를 걷게 만들지 않도록, 조이스틱이 되려던 첫 손가락을 시점 조작으로 돌린다.
      // (양손 엄지로 이동+시점을 동시에 잡는 경우는 두 손가락이 멀리 떨어져 있어 여기에 걸리지 않는다)
      joy.role = 'look'
      joy = null
      joyX = 0
      joyY = 0
      joyBase.classList.add('hidden')
    }
    if (e.pointerType === 'mouse') {
      info.role = 'mouse'
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
  })

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
      if (p.moved > TAP_MAX_MOVE) joyBase.classList.remove('hidden')
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
    if (p.moved > TAP_MAX_MOVE) {
      camYaw -= dx * 0.0055
      camPitch += dy * 0.004
    }
  })

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    const p = pointers.get(e.pointerId)
    if (!p) return
    pointers.delete(e.pointerId)
    const quick = performance.now() - p.startAt < TAP_MAX_MS && p.moved < TAP_MAX_MOVE
    if (p.role === 'joy') {
      joy = null
      joyX = 0
      joyY = 0
      joyBase.classList.add('hidden')
    }
    if (p.role === 'look') pinchDist = 0
    if (!cancelled && quick && (e.pointerType !== 'mouse' || e.button === 0)) {
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
      } else if (joy) {
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
