/**
 * NPC 시뮬레이션. [NPC 담당이 전체를 다시 구현할 파일]
 * 지금은 Room 개발/테스트가 가능하도록 '서 있기만 하는' 최소 자리표시 구현이다.
 */
import { NPC_REJECT_MEMORY_MS, Anim } from '../../shared/constants'
import { ARCHETYPES } from '../../shared/content/archetypes'
import type { Archetype } from '../../shared/content/types'
import { type Rnd, pick, pickWeighted } from '../../shared/rng'
import type { Look, NpcPublic } from '../../shared/types'
import type { WorldDef } from '../../shared/world/def'
import type { NpcSimApi, NpcSimEvents, NpcState, OwnerChangeReason, PlayerState } from './api'

function makeLook(arch: Archetype, rnd: Rnd): Look {
  return [
    Math.floor(rnd() * 6),
    pick(arch.look.outfits, rnd),
    pick(arch.look.colors, rnd),
    pick(arch.look.hats, rnd),
    pick(arch.look.faces, rnd),
    pick(arch.look.accs, rnd),
    0,
  ]
}

export function createNpcSim(world: WorldDef, rnd: Rnd, events: NpcSimEvents, count: number): NpcSimApi {
  const list: NpcState[] = []
  const nodes = world.nav.nodes
  for (let i = 0; i < Math.min(count, 250); i++) {
    const arch = pickWeighted(ARCHETYPES, (a) => a.weight, rnd)
    const node = nodes[Math.floor(rnd() * nodes.length) % nodes.length]!
    list.push({
      id: i + 1,
      arch,
      name: pick(arch.names, rnd),
      look: makeLook(arch, rnd),
      model: arch.model ?? 0,
      role: arch.special === 'rival' ? 'rival' : '',
      x: node.x + (rnd() - 0.5) * 2,
      z: node.z + (rnd() - 0.5) * 2,
      yaw: rnd() * Math.PI * 2,
      st: Anim.Idle,
      mode: 'pause',
      owner: 0,
      talker: 0,
      until: 0,
      followSince: 0,
      offered: false,
      memo: new Map(),
      dirty: true,
    })
  }

  const api: NpcSimApi = {
    list,
    get: (id) => list[id - 1],
    tick(now, _dt, players: ReadonlyMap<number, PlayerState>) {
      for (const n of list) {
        if (n.mode === 'listen' && n.until && now > n.until) api.endListen(n)
        if (n.mode === 'follow') {
          const owner = players.get(n.owner)
          if (!owner || (n.until && now > n.until)) api.release(n, 'expire')
        }
      }
    },
    canTalk(npc, playerId, now) {
      if (npc.mode === 'leave' || npc.mode === 'enter' || npc.mode === 'flee' || npc.mode === 'script') return 'gone'
      if (npc.talker !== 0 && npc.talker !== playerId) return 'busy'
      if ((npc.memo.get(playerId) ?? 0) > now) return 'memo'
      return 'ok'
    },
    beginListen(npc, player, until) {
      npc.mode = 'listen'
      npc.talker = player.id
      npc.until = until
      npc.st = Anim.Listen
      npc.yaw = Math.atan2(player.x - npc.x, player.z - npc.z)
      npc.dirty = true
    },
    endListen(npc) {
      npc.talker = 0
      npc.mode = npc.owner ? 'follow' : 'pause'
      npc.st = Anim.Idle
      npc.dirty = true
    },
    startFollow(npc, playerId, until, now) {
      const prev = npc.owner
      npc.owner = playerId
      npc.talker = 0
      npc.mode = 'follow'
      npc.until = until
      npc.followSince = now
      npc.offered = false
      npc.st = Anim.Idle
      npc.dirty = true
      events.onOwnerChange(npc, prev, prev ? 'poach' : 'join')
    },
    release(npc, reason: OwnerChangeReason) {
      const prev = npc.owner
      if (!prev) return
      npc.owner = 0
      npc.mode = 'pause'
      npc.until = 0
      npc.dirty = true
      if (npc.arch.leave.length) events.onSay(npc, pick(npc.arch.leave, rnd))
      events.onOwnerChange(npc, prev, reason)
    },
    flee(npc, _fx, _fz, now) {
      npc.talker = 0
      npc.mode = 'pause'
      npc.st = Anim.Idle
      npc.until = now
      npc.dirty = true
    },
    walkOff(npc) {
      api.endListen(npc)
    },
    remember(npc, playerId, until) {
      npc.memo.set(playerId, until || NPC_REJECT_MEMORY_MS)
    },
    followersOf: (playerId) => list.filter((n) => n.owner === playerId),
    gather: () => [],
    ungather() {},
    onPlayerLeave(playerId) {
      for (const n of list) {
        if (n.talker === playerId) api.endListen(n)
        if (n.owner === playerId) api.release(n, 'leave')
        n.memo.delete(playerId)
      }
    },
    retire() {},
    addScripted: () => null,
    removeScripted() {},
    publicOf(npc): NpcPublic {
      return {
        id: npc.id,
        arch: npc.arch.id,
        name: npc.name,
        look: npc.look,
        model: npc.model,
        x: npc.x,
        z: npc.z,
        yaw: npc.yaw,
        st: npc.st,
        owner: npc.owner,
        role: npc.role,
      }
    },
  }
  return api
}
