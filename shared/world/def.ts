/**
 * 월드(맵) 정의 스키마. 좌표계: X 동(+)/서(-), Z 남(+)/북(-), Y 위. 단위 m.
 * 충돌·POI·NPC 이동망은 서버(NPC 시뮬)와 클라이언트(이동/충돌/렌더)가 같은 데이터를 쓴다.
 */

/** 축 정렬 박스(충돌/영역) */
export interface Box {
  x0: number
  z0: number
  x1: number
  z1: number
}
export interface Circle {
  x: number
  z: number
  r: number
}
export interface Spot {
  x: number
  z: number
  /** 바라보는 방향(라디안, +Z 기준 시계 반대). 0 이면 +Z(남쪽)를 본다 */
  yaw: number
}

export type NavKind =
  | 'walk' // 인도
  | 'plaza' // 광장
  | 'cross' // 횡단보도
  | 'shop' // 가게 앞(잠깐 서성임)
  | 'rest' // 벤치 등(오래 쉼)
  | 'exit' // 맵 밖으로 나가는 지점(지하철 입구, 길 끝)

export interface NavNode {
  x: number
  z: number
  kind: NavKind
}

export interface WorldDef {
  /** 걸어 다닐 수 있는 전체 경계 */
  bounds: Box
  /** 정적 충돌체 */
  boxes: Box[]
  circles: Circle[]
  /** 광장 중앙 단상: 반지름 r 의 원형 무대, 높이 h, 바깥으로 ramp 만큼 경사 */
  podium: Circle & { h: number; ramp: number }
  /** 광장(설교 청중이 모이는 범위) */
  plaza: Circle
  /** 가상 헌금함 */
  offeringBox: Circle
  /** 수상한 천막(헌금함이 놓인 곳) */
  tent: Circle
  /** 지하철 출입구 — NPC가 여기로 드나든다 */
  subway: Circle & { yaw: number }
  /** 포교 부스 */
  booths: Spot[]
  /** 비밀 교단 건물: gate 는 직급 미달 플레이어를 막는 충돌 박스, inside 는 내부 영역 */
  hq: { door: Circle; gate: Box; inside: Box; minRank: number }
  /** 플레이어 시작 위치 후보 */
  spawns: Spot[]
  /** NPC 이동망 */
  nav: { nodes: NavNode[]; edges: [number, number][] }
}
