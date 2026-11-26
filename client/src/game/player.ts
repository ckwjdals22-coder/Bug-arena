/**
 * 내 캐릭터: 입력 → 예측 이동 → 충돌 → 서버로 위치 보고. 가까운 상호작용 대상(near) 판정.
 * 서버는 속도/경계만 검증하므로 여기의 속도 상수는 서버와 같은 값을 써야 한다.
 */
import {
  Anim,
  CLIENT_SEND_HZ,
  PLAYER_INTERACT_RANGE,
  PLAYER_RADIUS,
  POI_RANGE_PAD,
  RUN_SPEED,
  SPRINT_SPEED,
  TALK_RANGE,
  WALK_SPEED,
} from '../../../shared/constants'
import { EMOTE_BY_ID } from '../../../shared/content/core'
import { WORLD, groundHeight, inBox, resolveCollision } from '../../../shared/world'
import type { Bus } from '../core/bus'
import type { InputApi, NetApi } from '../core/contracts'
import type { EntityView, NearState, PoiKind, Store } from '../core/store'
import { lerpAngle } from '../net/interp'
import type { CameraRig } from './camera'

const SEND_INTERVAL_MS = 1000 / CLIENT_SEND_HZ
const NEAR_INTERVAL_MS = 100

export interface MoveTarget {
  x: number
  z: number
  /** 도착하면 이 NPC 에게 말을 건다(0 = 없음) */
  npc: number
  startedAt: number
  lastDist: number
  stuckSince: number
}

export interface PlayerController {
  update(dt: number, now: number): void
  moveTo(x: number, z: number, npc?: number): void
  cancelMove(): void
  /** 서버 보정/입장 직후: 속도와 전송 상태 초기화 */
  reset(): void
  readonly target: MoveTarget | null
}

/** 지금 화면에 보여야 할 이모트(1회성은 길이가 지나면 끝난 것으로 본다) */
export function activeEmote(view: EntityView, now: number): string | null {
  if (!view.emote) return null
  const def = EMOTE_BY_ID.get(view.emote)
  if (!def) return null
  if (def.loop) return view.emote
  return now - view.emoteAt < def.ms ? view.emote : null
}

export function createPlayerController(
  store: Store,
  bus: Bus,
  net: NetApi,
  input: InputApi,
  rig: CameraRig,
  onArriveNpc: (npcId: number) => void,
): PlayerController {
  let vx = 0
  let vz = 0
  let target: MoveTarget | null = null
  let lastSentAt = 0
  let sentX = NaN
  let sentZ = NaN
  let sentYaw = NaN
  let sentSt = -1
  let lastNearAt = 0
  const pos = { x: 0, z: 0 }

  function reset(): void {
    vx = 0
    vz = 0
    target = null
    sentX = NaN
  }
  bus.onMsg('pos', reset)
  bus.on('entered', reset)

  function updateNear(now: number): void {
    const me = store.me
    if (!me) return
    let npc = 0
    let best = TALK_RANGE * TALK_RANGE
    for (const v of store.npcs.values()) {
      if (v.pub.owner === me.id || v.pub.role === 'patrol' || v.st === Anim.Vanish) continue
      const d = (v.x - me.x) * (v.x - me.x) + (v.z - me.z) * (v.z - me.z)
      if (d < best) {
        best = d
        npc = v.pub.id
      }
    }
    let player = 0
    best = PLAYER_INTERACT_RANGE * PLAYER_INTERACT_RANGE
    for (const v of store.players.values()) {
      const d = (v.x - me.x) * (v.x - me.x) + (v.z - me.z) * (v.z - me.z)
      if (d < best) {
        best = d
        player = v.pub.id
      }
    }
    let poi: PoiKind = null
    const w = WORLD
    if (Math.hypot(me.x - w.podium.x, me.z - w.podium.z) <= w.podium.r) poi = 'podium'
    else if (Math.hypot(me.x - w.offeringBox.x, me.z - w.offeringBox.z) <= w.offeringBox.r + POI_RANGE_PAD + 1.2) poi = 'offering'
    else if (inBox(me.x, me.z, w.hq.inside)) poi = 'hq'
    else if (w.booths.some((b) => Math.hypot(me.x - b.x, me.z - b.z) <= 1.6)) poi = 'booth'
    const prev: NearState = store.near
    if (prev.npc !== npc || prev.player !== player || prev.poi !== poi) {
      store.near = { npc, player, poi }
      bus.emit('near', store.near)
    }
    lastNearAt = now
  }

  function update(dt: number, now: number): void {
    const me = store.me
    if (!me) return
    const stunned = now < me.stunUntil
    const locked = stunned || store.talk !== null
    const sprinting = now < me.sprintUntil && !locked

    // ── 원하는 이동 방향(월드) ──
    let dx = 0
    let dz = 0
    let mag = 0
    const ix = input.moveX
    const iy = input.moveY
    if (!locked && (ix !== 0 || iy !== 0)) {
      target = null
      const sin = Math.sin(rig.yaw)
      const cos = Math.cos(rig.yaw)
      // 화면 오른쪽 = (cos, -sin), 화면 앞 = (-sin, -cos)
      dx = cos * ix - sin * iy
      dz = -sin * ix - cos * iy
      mag = Math.min(1, Math.hypot(ix, iy))
    } else if (!locked && target) {
      let tx = target.x
      let tz = target.z
      let stop = 0.3
      if (target.npc) {
        const v = store.npcs.get(target.npc)
        if (!v || v.pub.owner === me.id) {
          target = null
        } else {
          tx = v.x
          tz = v.z
          stop = TALK_RANGE * 0.72
        }
      }
      if (target) {
        const ddx = tx - me.x
        const ddz = tz - me.z
        const d = Math.hypot(ddx, ddz)
        if (d <= stop) {
          const npc = target.npc
          target = null
          if (npc) onArriveNpc(npc)
        } else {
          dx = ddx / d
          dz = ddz / d
          mag = 1
          // 벽에 막혀 1초 넘게 가까워지지 못하면 포기
          if (d < target.lastDist - 0.02) {
            target.lastDist = d
            target.stuckSince = now
          } else if (now - target.stuckSince > 1000) {
            target = null
          }
        }
      }
    } else if (sprinting) {
      // 방향 입력 없이 '도망가기'만 누르면 보는 방향으로 냅다 달린다
      dx = Math.sin(me.yaw)
      dz = Math.cos(me.yaw)
      mag = 1
    }
    if (locked) target = null

    // ── 속도 ──
    let speed = 0
    if (mag > 0.01) {
      if (sprinting) speed = SPRINT_SPEED
      else if (input.run || (target !== null && target.npc === 0 && target.lastDist > 9)) speed = RUN_SPEED
      else speed = WALK_SPEED * Math.min(1, Math.max(0.45, mag / 0.8))
    }
    const k = 1 - Math.exp(-dt * 14)
    vx += (dx * speed - vx) * k
    vz += (dz * speed - vz) * k
    const v = Math.hypot(vx, vz)

    if (v > 0.02) {
      pos.x = me.x + vx * dt
      pos.z = me.z + vz * dt
      resolveCollision(pos, PLAYER_RADIUS, me.prog.rank >= WORLD.hq.minRank)
      me.x = pos.x
      me.z = pos.z
    }
    me.y = groundHeight(me.x, me.z)

    // ── 방향/상태 ──
    if (v > 0.4) me.yaw = lerpAngle(me.yaw, Math.atan2(vx, vz), 1 - Math.exp(-dt * 13))
    let st: number = Anim.Idle
    if (stunned) st = Anim.Stun
    else if (v > 0.5) st = sprinting ? Anim.Sprint : v > (WALK_SPEED + RUN_SPEED) / 2 ? Anim.Run : Anim.Walk
    me.st = st

    // 움직이면 반복 이모트는 풀린다(서버도 같은 규칙)
    if (v > 0.6 && me.emote && me.emote !== 'flee') {
      const def = EMOTE_BY_ID.get(me.emote)
      if (def?.loop) me.emote = null
    }
    if (me.emote && activeEmote(me, now) === null) me.emote = null

    // ── 서버로 보고: 움직이는 동안 10Hz, 멈추면 한 번 ──
    if (now - lastSentAt >= SEND_INTERVAL_MS) {
      const changed =
        Math.abs(me.x - sentX) > 0.01 || Math.abs(me.z - sentZ) > 0.01 || Math.abs(me.yaw - sentYaw) > 0.03 || st !== sentSt
      if (changed || Number.isNaN(sentX)) {
        net.sendMove(me.x, me.z, me.yaw, st)
        sentX = me.x
        sentZ = me.z
        sentYaw = me.yaw
        sentSt = st
        lastSentAt = now
      }
    }

    if (now - lastNearAt >= NEAR_INTERVAL_MS) updateNear(now)
  }

  return {
    update,
    moveTo(x, z, npc = 0) {
      const me = store.me
      if (!me) return
      target = { x, z, npc, startedAt: performance.now(), lastDist: Math.hypot(x - me.x, z - me.z), stuckSince: performance.now() }
    },
    cancelMove() {
      target = null
    },
    reset,
    get target() {
      return target
    },
  }
}
