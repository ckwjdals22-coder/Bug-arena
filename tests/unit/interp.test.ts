import { describe, expect, it } from 'vitest'
import { applyInterp, holdSample, lerpAngle, pushSample, resetSamples } from '../../client/src/net/interp'
import type { EntityView } from '../../client/src/core/store'

function view(x = 0, z = 0): EntityView {
  return { x, y: 0, z, yaw: 0, st: 0, emote: null, emoteAt: 0, phase: 0, bornAt: 0, samples: [] }
}
const ent = (x: number, z: number, st = 1, yaw = 0) => ({ id: 1, x, z, yaw, st })

describe('스냅샷 보간', () => {
  it('두 샘플 사이를 선형 보간한다', () => {
    const v = view()
    resetSamples(v, 1000)
    pushSample(v, 1100, ent(1, 0))
    applyInterp(v, 1050)
    expect(v.x).toBeCloseTo(0.5, 5)
    expect(v.st).toBe(1) // 이동 구간에서는 도착 샘플의 상태
    applyInterp(v, 1100)
    expect(v.x).toBeCloseTo(1, 5)
  })

  it('스냅샷에 없던 동안은 제자리에 머물고, 다시 움직일 때 미끄러지지 않는다', () => {
    const v = view()
    resetSamples(v, 1000)
    // 1100~1900: 스냅샷에 이 엔티티가 없었다(가만히 서 있음)
    for (let t = 1100; t <= 1900; t += 100) holdSample(v, t)
    // 2000: 움직이기 시작해 0.34m 이동
    pushSample(v, 2000, ent(0.34, 0))
    applyInterp(v, 1500)
    expect(v.x).toBe(0) // hold 구간: 아직 제자리
    expect(v.st).toBe(0)
    applyInterp(v, 1900)
    expect(v.x).toBe(0)
    applyInterp(v, 1950)
    expect(v.x).toBeCloseTo(0.17, 5) // 마지막 hold(1900)부터 2000 사이에서만 보간
    applyInterp(v, 2000)
    expect(v.x).toBeCloseTo(0.34, 5)
  })

  it('다음 샘플이 없으면 마지막 위치를 유지한다(외삽하지 않는다)', () => {
    const v = view()
    resetSamples(v, 1000)
    pushSample(v, 1100, ent(1, 0))
    applyInterp(v, 5000)
    expect(v.x).toBe(1)
  })

  it('순간이동은 보간하지 않고 딱 옮긴다', () => {
    const v = view()
    resetSamples(v, 1000)
    pushSample(v, 1100, ent(30, 0))
    applyInterp(v, 1040)
    expect(v.x).toBe(0)
    applyInterp(v, 1060)
    expect(v.x).toBe(30)
  })

  it('시간이 거꾸로 온 샘플은 버린다', () => {
    const v = view()
    resetSamples(v, 1000)
    pushSample(v, 1100, ent(1, 0))
    pushSample(v, 1050, ent(9, 9))
    expect(v.samples.length).toBe(2)
    applyInterp(v, 1100)
    expect(v.x).toBe(1)
  })

  it('오래된 샘플을 정리하며 연속 구간을 따라간다', () => {
    const v = view()
    resetSamples(v, 0)
    for (let i = 1; i <= 50; i++) pushSample(v, i * 100, ent(i, 0))
    expect(v.samples.length).toBeLessThanOrEqual(24)
    applyInterp(v, 4950)
    expect(v.x).toBeCloseTo(49.5, 5)
    expect(v.samples.length).toBeLessThanOrEqual(3)
  })

  it('각도는 가까운 쪽으로 돈다', () => {
    const a = (350 * Math.PI) / 180
    const b = (10 * Math.PI) / 180
    const mid = lerpAngle(a, b, 0.5)
    const deg = ((mid * 180) / Math.PI + 360) % 360
    expect(Math.min(deg, 360 - deg)).toBeLessThan(1)
  })
})
