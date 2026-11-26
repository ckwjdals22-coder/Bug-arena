/**
 * 스냅샷 보간.
 * 서버는 '변한 엔티티만' 보낸다. 스냅샷에 없는 엔티티는 "그 시각까지 그대로 있었다"는 뜻이므로
 * 마지막 샘플의 hold 를 늘려 둔다. 그렇게 하지 않으면 오래 서 있다가 움직인 캐릭터가
 * 멈춰 있던 시간 전체에 걸쳐 느릿느릿 미끄러져 보인다.
 */
import type { SnapEnt } from '../../../shared/protocol'
import type { EntityView, Sample } from '../core/store'

const TELEPORT_DIST = 4
const MAX_SAMPLES = 24

export function pushSample(view: EntityView, time: number, e: SnapEnt): void {
  const s = view.samples
  const last = s[s.length - 1]
  if (last && time <= last.t) return // 순서가 뒤집힌 오래된 데이터는 버린다
  s.push({ t: time, hold: time, x: e.x, z: e.z, yaw: e.yaw, st: e.st })
  if (s.length > MAX_SAMPLES) s.splice(0, s.length - MAX_SAMPLES)
}

/** 이번 스냅샷에 나오지 않은 엔티티: 마지막 위치를 time 까지 유지 */
export function holdSample(view: EntityView, time: number): void {
  const last = view.samples[view.samples.length - 1]
  if (last && time > last.hold) last.hold = time
}

export function resetSamples(view: EntityView, time: number): void {
  view.samples.length = 0
  view.samples.push({ t: time, hold: time, x: view.x, z: view.z, yaw: view.yaw, st: view.st })
}

export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * k
}

/** 렌더 시각 rt(서버 시각 기준)의 위치를 view 에 써 넣는다 */
export function applyInterp(view: EntityView, rt: number): void {
  const s = view.samples
  if (s.length === 0) return
  while (s.length >= 2 && (s[1] as Sample).t <= rt) s.shift()
  const a = s[0] as Sample
  const b = s[1]
  if (!b || rt <= a.hold) {
    view.x = a.x
    view.z = a.z
    view.yaw = a.yaw
    view.st = a.st
    return
  }
  const span = b.t - a.hold
  const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.hold) / span)) : 1
  const dx = b.x - a.x
  const dz = b.z - a.z
  if (dx * dx + dz * dz > TELEPORT_DIST * TELEPORT_DIST) {
    // 순간이동(보정/재배치)은 미끄러지지 않게 딱 옮긴다
    const src = k < 0.5 ? a : b
    view.x = src.x
    view.z = src.z
    view.yaw = src.yaw
    view.st = src.st
    return
  }
  view.x = a.x + dx * k
  view.z = a.z + dz * k
  view.yaw = lerpAngle(a.yaw, b.yaw, k)
  // a→b 구간을 이동 중이므로 도착 샘플의 상태(걷기/달리기)를 쓴다
  view.st = b.st
}
