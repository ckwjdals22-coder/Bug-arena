/**
 * 구청 단속반 — 순찰하다가 근처에서 포교하는 플레이어를 보면 쫓아온다.
 *
 * 쫓기는 쪽은 '플레이어(교주 지망생)'다. 시민은 아무 피해도 입지 않고, 단속반도 화내지 않는다(훈방만 한다).
 * 너무 가혹하지 않게:
 *  - 추격은 최대 9초. 비밀 교단 건물 안으로 숨거나 24m 이상 벌어지면 놓친다.
 *  - 잡혀도 3초 얼어붙고 지금 따라다니던 신도만 흩어진다. 누적 신도 수(prog.fol)는 줄지 않는다.
 *  - 한 번 추격이 끝나면 30초 동안은 아무도 쫓지 않는다(같은 사람을 연달아 괴롭히지 않게).
 *
 * 단속반 NPC 는 시뮬이 건드리지 않는 'script' 모드 NPC 다. 위치/상태를 이 시스템이 매 틱 직접 움직인다.
 */
import { Anim, NPC_RADIUS } from '../../../shared/constants'
import { STAT } from '../../../shared/content/core'
import type { Archetype } from '../../../shared/content/types'
import type { Look } from '../../../shared/types'
import { findNavPath, insideHq, navNodesOfKind, nearestNavNode, resolveCollision } from '../../../shared/world'
import type { NpcState, PlayerState, RoomApi, RoomSystem } from '../api'

/** 순찰 걸음 속도 */
export const PATROL_WALK_SPEED = 1.8
/** 추격 속도 — 달리기(5.6)보다 조금 빠르고 도망가기(8.4)보다 느리다 */
export const PATROL_CHASE_SPEED = 6.3
/** 이 거리 안에서 포교하면 들킨다 */
export const PATROL_SEE_RANGE = 12
/** 호루라기 → 추격 시작까지 */
export const PATROL_ALERT_MS = 800
/** 추격 최대 시간 */
export const PATROL_CHASE_MS = 9000
/** 이 거리 안으로 붙으면 잡힘 */
export const PATROL_CATCH_RANGE = 1.3
/** 이만큼 벌어지면 놓침 */
export const PATROL_LOSE_RANGE = 24
/** 얼어붙는 시간 */
export const PATROL_STUN_MS = 3000
/** 추격이 끝난 뒤 다음 추격까지 */
export const PATROL_COOLDOWN_MS = 30_000
/** 막혀서 이 시간 넘게 제자리면 이동망으로 돌아간다 */
const BLOCKED_MS = 1000
/** 우회 경로를 따르는 최대 시간(그 뒤엔 다시 직진 시도) */
const DETOUR_MS = 2500
const PAUSE_MIN_MS = 2000
const PAUSE_MAX_MS = 5000
/** 순찰 중 혼잣말 간격 */
const MUTTER_MIN_MS = 22_000
const MUTTER_MAX_MS = 40_000

export const PATROL_LINES = {
  alert: '거기! 무단 포교 금지!',
  caught: '훈방 조치합니다. 다음부턴 살살 하세요.',
  lost: '헉… 헉… 다음엔 꼭…',
} as const

const MUTTERS: readonly string[] = [
  '오늘도 이 구역 이상 무.',
  '전단지는 분리수거입니다.',
  '호루라기 새로 샀는데 소리 좋네.',
  '점심은 김밥이다.',
  '어디서 기운 얘기가 들리는데…',
  '인도에서 포교 금지, 차도에서는 더 금지.',
]

/** 단속반 전용 유형. ARCHETYPES 에 넣지 않는다(일반 시민으로 뽑히지 않게, 도감에도 안 뜨게) */
export const PATROL_ARCH: Archetype = {
  id: 'patrol',
  name: '구청 단속반',
  desc: '무단 포교를 단속한다. 잡아도 훈방만 한다. 달리기가 의외로 빠르다.',
  names: ['단속반'],
  weight: 0,
  base: 0,
  like: {},
  flee: 0,
  ignore: 1,
  curious: 0,
  speed: 1,
  look: { outfits: [4], hats: [1], colors: [4], faces: [0], accs: [4] },
  recruitable: false,
  greet: ['업무 중입니다.'],
  re: { join: ['업무 중입니다.'], more: ['업무 중입니다.'], no: ['업무 중입니다.'], flee: ['업무 중입니다.'], ignore: ['…'] },
  mutter: [...MUTTERS],
  follow: ['업무 중입니다.'],
  leave: ['퇴근합니다.'],
}
/** 노란 등산 조끼 + 야구모자 + 확성기 */
export const PATROL_LOOK: Look = [1, 4, 4, 1, 0, 4, 0]

type Phase = 'walk' | 'pause' | 'alert' | 'chase'

export function createPatrolSystem(): RoomSystem {
  let room: RoomApi
  let npc: NpcState | null = null
  let phase: Phase = 'pause'
  /** 순찰: 남은 경로(노드 인덱스). 추격: 우회 경로 */
  let path: number[] = []
  let phaseUntil = 0
  /** 쫓는 플레이어 id */
  let target = 0
  let chaseStart = 0
  let cooldownUntil = 0
  let blockedMs = 0
  let detourUntil = 0
  let nextMutterAt = 0
  let patrolNodes: number[] = []
  const pos = { x: 0, z: 0 }

  const rndInt = (a: number, b: number): number => a + Math.floor(room.rnd() * (b - a + 1))

  /** 한 틱 이동. 실제로 움직인 거리를 돌려준다 */
  function step(n: NpcState, tx: number, tz: number, speed: number, dt: number): number {
    const dx = tx - n.x
    const dz = tz - n.z
    const d = Math.hypot(dx, dz)
    if (d < 1e-4) return 0
    const s = Math.min(d, speed * dt)
    pos.x = n.x + (dx / d) * s
    pos.z = n.z + (dz / d) * s
    // 단속반은 비밀 교단 건물에 못 들어간다(그래서 거기가 은신처다)
    resolveCollision(pos, NPC_RADIUS, false, room.world)
    const moved = Math.hypot(pos.x - n.x, pos.z - n.z)
    n.x = Math.round(pos.x * 100) / 100
    n.z = Math.round(pos.z * 100) / 100
    n.yaw = Math.atan2(dx, dz)
    n.dirty = true
    return moved
  }

  function setSt(n: NpcState, st: number): void {
    if (n.st !== st) {
      n.st = st
      n.dirty = true
    }
  }

  function planPatrol(n: NpcState): void {
    const from = nearestNavNode(n.x, n.z, room.world)
    if (patrolNodes.length === 0) {
      path = []
      return
    }
    let to = patrolNodes[Math.floor(room.rnd() * patrolNodes.length) % patrolNodes.length]!
    if (to === from && patrolNodes.length > 1) to = patrolNodes[(patrolNodes.indexOf(to) + 1) % patrolNodes.length]!
    path = findNavPath(from, to, room.world)
    phase = 'walk'
  }

  function startPause(n: NpcState, now: number): void {
    phase = 'pause'
    path = []
    phaseUntil = now + rndInt(PAUSE_MIN_MS, PAUSE_MAX_MS)
    setSt(n, Anim.Idle)
  }

  /** 추격 종료(잡았든 놓쳤든) → 쿨타임 후 순찰 복귀 */
  function finishChase(n: NpcState, now: number): void {
    target = 0
    cooldownUntil = now + PATROL_COOLDOWN_MS
    blockedMs = 0
    detourUntil = 0
    startPause(n, now)
    // 숨 고르기는 조금 더 길게
    phaseUntil = now + PAUSE_MAX_MS
  }

  function lose(n: NpcState, p: PlayerState | undefined, now: number): void {
    const pid = target
    room.broadcast({ t: 'patrol', ph: 'lost', n: n.id, p: pid })
    room.npcSay([[n.id, PATROL_LINES.lost]])
    if (p) {
      room.bump(p, STAT.escapes)
      room.feed('patrol', p.id, `${p.name}님이 단속반을 따돌렸습니다. 다리는 교주급!`)
    }
    finishChase(n, now)
  }

  function catchPlayer(n: NpcState, p: PlayerState, now: number): void {
    p.stunUntil = now + PATROL_STUN_MS
    // 지금 따라다니던 신도만 흩어진다(누적 신도 수 prog.fol 은 그대로)
    for (const f of room.npcs.followersOf(p.id)) {
      room.npcs.release(f, 'scatter')
      room.npcs.flee(f, n.x, n.z, now)
    }
    room.bump(p, STAT.caught)
    room.broadcast({ t: 'patrol', ph: 'caught', n: n.id, p: p.id, ms: PATROL_STUN_MS })
    room.npcSay([[n.id, PATROL_LINES.caught]])
    room.feed('patrol', p.id, `${p.name}님이 단속반에게 훈방 조치되었습니다`)
    finishChase(n, now)
  }

  function tickChase(n: NpcState, now: number, dt: number): void {
    const p = room.players.get(target)
    if (!p) {
      lose(n, undefined, now)
      return
    }
    const d = Math.hypot(p.x - n.x, p.z - n.z)
    if (insideHq(p.x, p.z, room.world) || d > PATROL_LOSE_RANGE || now - chaseStart >= PATROL_CHASE_MS) {
      lose(n, p, now)
      return
    }
    if (d < PATROL_CATCH_RANGE) {
      catchPlayer(n, p, now)
      return
    }
    setSt(n, Anim.Run)
    let tx = p.x
    let tz = p.z
    if (path.length > 0 && now < detourUntil) {
      const node = room.world.nav.nodes[path[0]!]!
      if (Math.hypot(node.x - n.x, node.z - n.z) < 0.6) path.shift()
      const next = path.length > 0 ? room.world.nav.nodes[path[0]!] : undefined
      if (next) {
        tx = next.x
        tz = next.z
      }
    } else {
      path = []
    }
    const want = Math.min(Math.hypot(tx - n.x, tz - n.z), PATROL_CHASE_SPEED * dt)
    const moved = step(n, tx, tz, PATROL_CHASE_SPEED, dt)
    // 벽에 막혀 거의 못 움직이면(원하는 거리의 30% 미만) 잠시 이동망을 따라 돌아간다
    if (want > 0.05 && moved < want * 0.3) blockedMs += dt * 1000
    else blockedMs = 0
    if (blockedMs > BLOCKED_MS) {
      blockedMs = 0
      const from = nearestNavNode(n.x, n.z, room.world)
      const to = nearestNavNode(p.x, p.z, room.world)
      path = findNavPath(from, to, room.world)
      detourUntil = now + DETOUR_MS
    }
  }

  function tickWalk(n: NpcState, now: number, dt: number): void {
    const nodes = room.world.nav.nodes
    const next = path.length > 0 ? nodes[path[0]!] : undefined
    if (!next) {
      startPause(n, now)
      return
    }
    setSt(n, Anim.Walk)
    const moved = step(n, next.x, next.z, PATROL_WALK_SPEED, dt)
    if (Math.hypot(next.x - n.x, next.z - n.z) < 0.3) path.shift()
    else if (moved < 0.01) path.shift() // 노드가 충돌체에 걸쳐 있으면 건너뛴다(제자리걸음 방지)
  }

  return {
    name: 'patrol',
    handles: [],
    init(r) {
      room = r
      patrolNodes = navNodesOfKind(['walk', 'cross', 'plaza'], room.world)
      const startNode = patrolNodes.length > 0 ? room.world.nav.nodes[patrolNodes[Math.floor(room.rnd() * patrolNodes.length) % patrolNodes.length]!] : undefined
      const start = startNode ?? room.world.spawns[0] ?? { x: 0, z: 0 }
      npc = room.npcs.addScripted(PATROL_ARCH, 'patrol', '구청 단속반', PATROL_LOOK, start.x, start.z)
      if (npc) {
        npc.st = Anim.Idle
        phase = 'pause'
        phaseUntil = room.now() + PAUSE_MIN_MS
        nextMutterAt = room.now() + MUTTER_MIN_MS
      }
    },
    onTick(now, dt) {
      const n = npc
      if (!n || n.mode !== 'script') return
      switch (phase) {
        case 'pause':
          setSt(n, Anim.Idle)
          if (now >= phaseUntil) planPatrol(n)
          break
        case 'walk':
          tickWalk(n, now, dt)
          break
        case 'alert': {
          const p = room.players.get(target)
          if (!p) {
            lose(n, undefined, now)
            break
          }
          // 호루라기 부는 동안 플레이어 쪽을 노려본다
          const yaw = Math.atan2(p.x - n.x, p.z - n.z)
          if (Math.abs(yaw - n.yaw) > 0.01) {
            n.yaw = yaw
            n.dirty = true
          }
          if (now >= phaseUntil) {
            phase = 'chase'
            chaseStart = now
            blockedMs = 0
            path = []
            room.broadcast({ t: 'patrol', ph: 'chase', n: n.id, p: p.id })
          }
          break
        }
        case 'chase':
          tickChase(n, now, dt)
          break
      }
      if ((phase === 'walk' || phase === 'pause') && now >= nextMutterAt && room.players.size > 0) {
        nextMutterAt = now + rndInt(MUTTER_MIN_MS, MUTTER_MAX_MS)
        room.npcSay([[n.id, MUTTERS[Math.floor(room.rnd() * MUTTERS.length) % MUTTERS.length]!]])
      }
    },
    onPitch(p, _npc, _line, _outcome) {
      const n = npc
      if (!n || n.mode !== 'script') return
      const now = room.now()
      // 한 번에 한 명만, 쉬는 시간(쿨타임)에는 못 본 척
      if (phase === 'alert' || phase === 'chase' || now < cooldownUntil) return
      if (Math.hypot(p.x - n.x, p.z - n.z) > PATROL_SEE_RANGE) return
      if (insideHq(p.x, p.z, room.world)) return
      target = p.id
      phase = 'alert'
      phaseUntil = now + PATROL_ALERT_MS
      path = []
      setSt(n, Anim.Idle)
      room.broadcast({ t: 'patrol', ph: 'alert', n: n.id, p: p.id })
      room.npcSay([[n.id, PATROL_LINES.alert]])
    },
    onLeave(p) {
      const n = npc
      if (!n || p.id !== target || (phase !== 'alert' && phase !== 'chase')) return
      lose(n, undefined, room.now())
    },
  }
}
