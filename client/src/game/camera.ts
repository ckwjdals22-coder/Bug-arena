/**
 * 3인칭 추적 카메라. 플레이어를 부드럽게 따라가고, 드래그로 돌리고, 휠/핀치로 당긴다.
 * yaw 규약: 카메라는 목표 지점에서 (sin(yaw), cos(yaw)) 방향으로 떨어져 있다.
 *           → 화면 '앞'(카메라가 보는 방향)의 지면 방향은 (-sin(yaw), -cos(yaw)).
 */
import type * as THREE from 'three'
import { WORLD } from '../../../shared/world'

const DIST_MIN = 4.5
const DIST_MAX = 19
const PITCH_MIN = 0.16
const PITCH_MAX = 1.15

/** 카메라와 캐릭터 사이에 끼면 캐릭터를 가리는 낮은 지붕(지하철 출입구 캐노피). h = 지붕 윗면 높이 */
interface Occluder {
  x0: number
  z0: number
  x1: number
  z1: number
  h: number
}
const CANOPY_TOP = 2.9
const CANOPY_EAVE = 0.2
/** 가림 회피로 올릴 수 있는 시선 각도의 한 단계와 반응 속도 */
const LIFT_STEP = 0.05
const LIFT_RATE = 7

function findOccluders(): Occluder[] {
  // 지하철 출입구의 충돌 상자 = 출구 지점(WORLD.subway) 바로 옆에 붙은 중간 크기 상자
  const s = WORLD.subway
  let best: Occluder | null = null
  let bestD = 4
  for (const b of WORLD.boxes) {
    const w = b.x1 - b.x0
    const d = b.z1 - b.z0
    if (Math.min(w, d) < 2.5 || Math.max(w, d) > 9) continue
    const dx = Math.max(b.x0 - s.x, 0, s.x - b.x1)
    const dz = Math.max(b.z0 - s.z, 0, s.z - b.z1)
    const dist = Math.hypot(dx, dz)
    if (dist < bestD) {
      bestD = dist
      best = { x0: b.x0 - CANOPY_EAVE, z0: b.z0 - CANOPY_EAVE, x1: b.x1 + CANOPY_EAVE, z1: b.z1 + CANOPY_EAVE, h: CANOPY_TOP }
    }
  }
  return best ? [best] : []
}

/**
 * 캐릭터 발치(ax, ay, az)에서 카메라(bx, by, bz)까지의 시선이 지붕 아래를 지나는가.
 * 평면에서 선분이 상자에 들어가는 지점의 시선 높이가 지붕보다 낮으면 가려진 것이다.
 */
function sightBlocked(o: Occluder, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  if (Math.abs(dx) < 1e-6) {
    if (ax < o.x0 || ax > o.x1) return false
  } else {
    const a = (o.x0 - ax) / dx
    const b = (o.x1 - ax) / dx
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
  }
  if (Math.abs(dz) < 1e-6) {
    if (az < o.z0 || az > o.z1) return false
  } else {
    const a = (o.z0 - az) / dz
    const b = (o.z1 - az) / dz
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
  }
  if (t0 >= t1) return false
  return ay + (by - ay) * t0 < o.h + 0.25
}

export interface CameraRig {
  yaw: number
  pitch: number
  dist: number
  /** 플레이어 뒤로 즉시 정렬(입장 직후) */
  snapBehind(x: number, y: number, z: number, facingYaw: number): void
  /** 입력 변화량 적용 */
  rotate(dYaw: number, dPitch: number, dZoom: number): void
  /** 게임 중: 목표(플레이어)를 따라간다 */
  follow(dt: number, x: number, y: number, z: number): void
  /** 타이틀/접속 중: 광장 주변을 천천히 돈다 */
  orbit(dt: number, time: number): void
  /** 포교 결과 연출용 살짝 당기기(초 단위 지속) */
  punch(amount: number, seconds: number): void
}

export function createCameraRig(camera: THREE.PerspectiveCamera): CameraRig {
  let tx = 0
  let ty = 1.2
  let tz = 0
  let punchAmt = 0
  let punchLeft = 0
  let punchDur = 1
  const occluders = findOccluders()
  /** 가림을 피하려고 지금 더 올려 보고 있는 각도(사용자가 정한 pitch 는 건드리지 않는다) */
  let lift = 0

  /** 이 각도·거리에서 캐릭터가 지붕에 가려지는가 */
  function blockedAt(pitch: number, dist: number): boolean {
    if (occluders.length === 0) return false
    const flat = Math.cos(pitch) * dist
    const cx = tx + Math.sin(rig.yaw) * flat
    const cz = tz + Math.cos(rig.yaw) * flat
    const cy = ty + Math.sin(pitch) * dist
    for (const o of occluders) if (sightBlocked(o, tx, ty - 1.0, tz, cx, cy, cz)) return true
    return false
  }
  /** 가리지 않게 되는 가장 작은 추가 각도 */
  function wantedLift(): number {
    const room = PITCH_MAX - rig.pitch
    for (let extra = 0; extra < room; extra += LIFT_STEP) if (!blockedAt(rig.pitch + extra, rig.dist)) return extra
    return Math.max(0, room)
  }

  const rig: CameraRig = {
    yaw: 0,
    pitch: 0.52,
    dist: 10.5,
    snapBehind(x, y, z, facingYaw) {
      rig.yaw = facingYaw + Math.PI
      tx = x
      ty = y + 1.2
      tz = z
      lift = wantedLift()
      place(undefined, Math.min(PITCH_MAX, rig.pitch + lift))
    },
    rotate(dYaw, dPitch, dZoom) {
      rig.yaw += dYaw
      rig.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, rig.pitch + dPitch))
      if (dZoom !== 0) rig.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, rig.dist * Math.exp(dZoom * 0.1)))
    },
    follow(dt, x, y, z) {
      const k = 1 - Math.exp(-dt * 9)
      tx += (x - tx) * k
      ty += (y + 1.2 - ty) * k
      tz += (z - tz) * k
      if (punchLeft > 0) punchLeft = Math.max(0, punchLeft - dt)
      // 지붕이 캐릭터를 가리면 시선을 부드럽게 들어 올리고, 벗어나면 원래 각도로 돌아온다
      lift += (wantedLift() - lift) * (1 - Math.exp(-dt * LIFT_RATE))
      if (lift < 0.002) lift = 0
      place(undefined, Math.min(PITCH_MAX, rig.pitch + lift))
    },
    orbit(dt, time) {
      const p = WORLD.plaza
      rig.yaw = Math.PI + Math.sin(time * 0.07) * 0.9
      const k = 1 - Math.exp(-dt * 2)
      tx += (p.x - tx) * k
      ty += (1.5 - ty) * k
      tz += (p.z + 6 - tz) * k
      place(17, 0.42)
    },
    punch(amount, seconds) {
      punchAmt = amount
      punchLeft = seconds
      punchDur = Math.max(0.01, seconds)
    },
  }

  function place(distOverride?: number, pitchOverride?: number): void {
    const pitch = pitchOverride ?? rig.pitch
    let dist = distOverride ?? rig.dist
    if (punchLeft > 0) {
      // 0→1→0 으로 부드럽게 당겼다가 놓는다
      const t = 1 - punchLeft / punchDur
      dist *= 1 - punchAmt * Math.sin(t * Math.PI)
    }
    const flat = Math.cos(pitch) * dist
    let cx = tx + Math.sin(rig.yaw) * flat
    let cz = tz + Math.cos(rig.yaw) * flat
    const cy = ty + Math.sin(pitch) * dist
    // 카메라가 맵 경계 벽 너머로 너무 나가지 않게
    const b = WORLD.bounds
    cx = Math.min(b.x1 + 14, Math.max(b.x0 - 14, cx))
    cz = Math.min(b.z1 + 14, Math.max(b.z0 - 14, cz))
    camera.position.set(cx, Math.max(1.2, cy), cz)
    camera.lookAt(tx, ty, tz)
  }

  return rig
}
