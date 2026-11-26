/**
 * 월드 데이터. [월드 담당이 실제 거리 레이아웃으로 교체할 파일]
 * 지금은 서버/클라이언트가 돌아가기 위한 최소 자리표시 데이터다.
 */
import type { WorldDef } from './def'

export const WORLD: WorldDef = {
  bounds: { x0: -48, z0: -36, x1: 48, z1: 36 },
  boxes: [
    { x0: -48, z0: -36, x1: 48, z1: -33 },
    { x0: -48, z0: 33, x1: 48, z1: 36 },
  ],
  circles: [],
  podium: { x: 0, z: -21, r: 2.6, h: 0.5, ramp: 1.2 },
  plaza: { x: 0, z: -21, r: 11 },
  offeringBox: { x: 10, z: 15, r: 1.0 },
  tent: { x: 10, z: 16.5, r: 3.5 },
  subway: { x: -20, z: -12, r: 1.6, yaw: 0 },
  booths: [
    { x: 16, z: -14, yaw: Math.PI },
    { x: 20, z: -14, yaw: Math.PI },
  ],
  hq: {
    door: { x: 0, z: 26, r: 1.5 },
    gate: { x0: -1.5, z0: 25.5, x1: 1.5, z1: 26.5 },
    inside: { x0: -6, z0: 26.5, x1: 6, z1: 33 },
    minRank: 3,
  },
  spawns: [
    { x: -3, z: -12, yaw: 0 },
    { x: 3, z: -12, yaw: 0 },
    { x: 0, z: -10, yaw: 0 },
  ],
  nav: {
    nodes: [
      { x: -20, z: -12, kind: 'exit' },
      { x: -10, z: -8, kind: 'walk' },
      { x: 0, z: -8, kind: 'walk' },
      { x: 12, z: -8, kind: 'walk' },
      { x: 30, z: -8, kind: 'walk' },
      { x: 0, z: -14, kind: 'plaza' },
      { x: -8, z: -21, kind: 'plaza' },
      { x: 8, z: -21, kind: 'plaza' },
      { x: 0, z: -28, kind: 'rest' },
      { x: 0, z: 0, kind: 'cross' },
      { x: 0, z: 8, kind: 'walk' },
      { x: -14, z: 8, kind: 'shop' },
      { x: 14, z: 8, kind: 'shop' },
      { x: 30, z: 8, kind: 'walk' },
      { x: -30, z: 8, kind: 'walk' },
      { x: -30, z: -8, kind: 'walk' },
      { x: 46, z: -8, kind: 'exit' },
      { x: -46, z: 8, kind: 'exit' },
    ],
    edges: [
      [0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [5, 6], [5, 7], [6, 8], [7, 8],
      [2, 9], [9, 10], [10, 11], [10, 12], [12, 13], [11, 14], [1, 15], [14, 15], [4, 16], [14, 17], [4, 13],
    ],
  },
}
