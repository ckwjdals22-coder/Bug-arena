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

  const rig: CameraRig = {
    yaw: 0,
    pitch: 0.52,
    dist: 10.5,
    snapBehind(x, y, z, facingYaw) {
      rig.yaw = facingYaw + Math.PI
      tx = x
      ty = y + 1.2
      tz = z
      place()
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
      place()
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
