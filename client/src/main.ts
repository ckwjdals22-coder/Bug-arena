/**
 * 부팅과 게임 루프. 모듈을 조립해 AppContext 를 만들고, 매 프레임
 * 입력 → 내 이동 → 원격 보간 → 카메라 → 캐릭터/월드/이펙트 → 렌더 → 오버레이 순으로 돌린다.
 */
import './styles/base.css'
import { Anim, SPRINT_COOLDOWN_MS, SPRINT_MS, npcKey } from '../../shared/constants'
import { CULT_COLORS, EMOTE_BY_ID } from '../../shared/content/core'
import type { Look } from '../../shared/types'
import { WORLD } from '../../shared/world'
import { createSfx } from './audio/sfx'
import { Bus } from './core/bus'
import type { Actions, AppContext, CharVisual, QualityTier } from './core/contracts'
import { type EntityView, createStore, saveProfile } from './core/store'
import { createCameraRig } from './game/camera'
import { activeEmote, createPlayerController } from './game/player'
import { createInput } from './input/input'
import { createNet } from './net/client'
import { createCharacterRenderer } from './render/characters'
import { createEngine, guessQuality } from './render/engine'
import { createFx } from './render/fx'
import { createWorldRenderer } from './render/world'
import { mountUi } from './ui/index'
import { createUi } from './ui/kit'
import { createOverlay } from './ui/overlay'

const canvas = document.getElementById('game') as HTMLCanvasElement
const uiRoot = document.getElementById('ui') as HTMLElement

const store = createStore()
const bus = new Bus()

const setting = store.profile.settings.quality
const engine = createEngine(canvas, setting === 'auto' ? guessQuality() : setting)
const sfx = createSfx()
const ui = createUi(uiRoot, bus)
const net = createNet(store, bus)
const input = createInput(canvas, uiRoot)
const world = createWorldRenderer(engine)
const chars = createCharacterRenderer(engine)
const fx = createFx(engine)
const overlay = createOverlay(uiRoot, store, bus, engine)
const rig = createCameraRig(engine.camera)

const player = createPlayerController(store, bus, net, input, rig, (npcId) => actions.talk(npcId))

/** 신도 NPC 발밑 고리 색: 주인의 교단색, 없으면 주인 id 로 정한 색 */
const RING_PALETTE = [0xffd23f, 0x7b5cff, 0xff7eb6, 0x3ccb7f, 0x4f8fe6, 0xff8a3d]
function ownerColor(ownerId: number): number {
  const me = store.me
  const cult = me && me.id === ownerId ? me.prog.cult : store.players.get(ownerId)?.pub.cult
  if (cult) return CULT_COLORS[cult.color] ?? RING_PALETTE[0]!
  return RING_PALETTE[ownerId % RING_PALETTE.length]!
}

const actions: Actions = {
  enter(roomId) {
    net.connect(roomId)
  },
  switchRoom(roomId) {
    if (store.room?.id === roomId && store.phase === 'playing') return
    net.disconnect()
    net.connect(roomId)
  },
  exitToTitle() {
    net.disconnect()
    store.phase = 'title'
    store.phaseWhy = ''
    bus.emit('phase', 'title')
  },
  setName(name) {
    store.profile.name = name
    saveProfile(store.profile)
    net.send({ t: 'profile', name })
    bus.emit('profile')
  },
  setLook(look: Look) {
    store.profile.look = look
    saveProfile(store.profile)
    net.send({ t: 'profile', look })
    bus.emit('profile')
  },
  emote(id) {
    const me = store.me
    if (!me || store.phase !== 'playing') return
    if (id === 'flee') {
      actions.sprint()
      return
    }
    if (id !== '' && !EMOTE_BY_ID.has(id)) return
    me.emote = id || null
    me.emoteAt = performance.now()
    net.send({ t: 'emote', e: id })
    if (id) sfx.play('emote')
  },
  say(quickId) {
    net.send({ t: 'say', q: quickId })
  },
  talk(npcId) {
    if (store.talk || store.phase !== 'playing') return
    if (performance.now() < store.pitchReadyAt) return
    player.cancelMove()
    net.send({ t: 'talk', n: npcId })
  },
  pitch(lineId) {
    const talk = store.talk
    if (!talk || talk.waiting) return
    talk.waiting = true
    bus.emit('talk', talk)
    net.send({ t: 'pitch', n: talk.npc, l: lineId })
  },
  endTalk() {
    if (!store.talk) return
    net.send({ t: 'talkEnd' })
    store.talk = null
    bus.emit('talk', null)
  },
  sprint() {
    const me = store.me
    const now = performance.now()
    if (!me || store.phase !== 'playing' || now < me.sprintReadyAt || now < me.stunUntil || store.talk) return false
    me.sprintUntil = now + SPRINT_MS
    me.sprintReadyAt = now + SPRINT_COOLDOWN_MS
    me.emote = 'flee'
    me.emoteAt = now
    net.send({ t: 'emote', e: 'flee' })
    sfx.play('sprint')
    ui.refreshContext()
    return true
  },
  moveTo(x, z) {
    player.moveTo(x, z)
  },
}

const ctx: AppContext = { store, bus, net, engine, chars, fx, overlay, sfx, input, actions, ui }
mountUi(ctx)

// ───────── 소리: 첫 입력에서 오디오를 깨우고 설정을 반영 ─────────
function applySettings(): void {
  const s = store.profile.settings
  sfx.setEnabled(s.sfx)
  sfx.setMusic(s.music)
  if (s.quality !== 'auto') engine.setQuality(s.quality)
}
applySettings()
bus.on('settings', applySettings)
const unlockAudio = (): void => {
  sfx.unlock()
  applySettings()
}
window.addEventListener('pointerdown', unlockAudio, { once: true })
window.addEventListener('keydown', unlockAudio, { once: true })

bus.on('entered', () => {
  const me = store.me
  if (!me) return
  // 막 나온 출구에서 광장 쪽을 바라보게 하고, 카메라를 등 뒤에 둔다
  me.yaw = Math.atan2(WORLD.plaza.x - me.x, WORLD.plaza.z - me.z)
  rig.snapBehind(me.x, me.y, me.z, me.yaw)
  sfx.play('joinRoom')
})
bus.onMsg('pitchRes', (m) => {
  if (store.me && m.p === store.me.id && (m.o === 'join' || m.o === 'king')) rig.punch(0.12, 0.45)
})

window.addEventListener('resize', () => {
  engine.resize()
  bus.emit('resize')
})
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    engine.resize()
    bus.emit('resize')
  }, 250)
})

// ───────── 탭/클릭: 캐릭터를 누르면 다가가서 말 걸기, 땅을 누르면 그곳으로 이동 ─────────
const scr = { x: 0, y: 0 }
function handleTap(clientX: number, clientY: number): void {
  const me = store.me
  if (!me || store.phase !== 'playing' || store.talk || ui.openPanelId) return
  let bestNpc = 0
  let best = 46 * 46
  for (const v of store.npcs.values()) {
    if (v.pub.owner === me.id || v.pub.role === 'patrol') continue
    if (!engine.project(v.x, v.y + 0.9, v.z, scr)) continue
    const d = (scr.x - clientX) * (scr.x - clientX) + (scr.y - clientY) * (scr.y - clientY)
    if (d < best) {
      best = d
      bestNpc = v.pub.id
    }
  }
  if (bestNpc) {
    const v = store.npcs.get(bestNpc)!
    player.moveTo(v.x, v.z, bestNpc)
    return
  }
  const p = engine.pickGround(clientX, clientY)
  if (p) player.moveTo(p.x, p.z)
}

// ───────── 캐릭터 시각 상태 목록(매 프레임 재사용) ─────────
const visuals: CharVisual[] = []
let visualCount = 0
function nextVisual(): CharVisual {
  let v = visuals[visualCount]
  if (!v) {
    v = {
      key: 0, x: 0, y: 0, z: 0, yaw: 0, look: [0, 0, 0, 0, 0, 0, 0], model: 0, anim: 0, emote: null, emoteT: 0,
      phase: 0, scale: 1, ring: -1, isNpc: false, highlight: false,
    }
    visuals[visualCount] = v
  }
  visualCount++
  return v
}
function fillVisual(v: CharVisual, e: EntityView, now: number): void {
  v.x = e.x
  v.y = e.y
  v.z = e.z
  v.yaw = e.yaw
  v.anim = e.st
  v.emote = activeEmote(e, now)
  v.emoteT = v.emote ? (now - e.emoteAt) / 1000 : 0
  v.phase = e.phase
  const age = now - e.bornAt
  v.scale = age < 320 ? 0.2 + 0.8 * (1 - (1 - age / 320) * (1 - age / 320)) : 1
  v.ring = -1
  v.highlight = false
}
const visualView: CharVisual[] = []
const slotCount = new Map<number, number>()
function buildVisuals(now: number): readonly CharVisual[] {
  visualCount = 0
  const me = store.me
  if (me) {
    const v = nextVisual()
    fillVisual(v, me, now)
    v.key = me.id
    v.look = store.profile.look
    v.model = 0
    v.isNpc = false
  }
  for (const p of store.players.values()) {
    const v = nextVisual()
    fillVisual(v, p, now)
    v.key = p.pub.id
    v.look = p.pub.look
    v.model = 0
    v.isNpc = false
  }
  const nearNpc = store.talk ? store.talk.npc : store.near.npc
  slotCount.clear()
  for (const n of store.npcs.values()) {
    const v = nextVisual()
    fillVisual(v, n, now)
    v.key = npcKey(n.pub.id)
    v.look = n.pub.look
    v.model = n.pub.model
    v.isNpc = true
    if (n.pub.owner) {
      v.ring = ownerColor(n.pub.owner)
      // 군무: 서 있는 신도는 교주의 동작을 줄 순서대로 조금씩 늦게 따라 한다(클라이언트 연출, 통신 없음)
      const owner = me && me.id === n.pub.owner ? me : store.players.get(n.pub.owner)
      const slot = slotCount.get(n.pub.owner) ?? 0
      slotCount.set(n.pub.owner, slot + 1)
      if (owner && n.st === Anim.Idle) {
        const oe = activeEmote(owner, now)
        const t = (now - owner.emoteAt) / 1000 - 0.16 * (slot + 1)
        if (oe && oe !== 'flee' && t >= 0) {
          v.emote = oe
          v.emoteT = t
        }
      }
    }
    v.highlight = n.pub.id === nearNpc
  }
  visualView.length = visualCount
  for (let i = 0; i < visualCount; i++) visualView[i] = visuals[i]!
  return visualView
}

// ───────── 자동 품질 조절: 무거우면 먼저 해상도를 낮추고, 그래도 안 되면 품질 단계를 내린다 ─────────
let accMs = 0
let accFrames = 0
let goodWindows = 0
function watchPerformance(frameMs: number): void {
  if (store.profile.settings.quality !== 'auto') return
  accMs += frameMs
  accFrames++
  if (accMs < 2000) return
  const avg = accMs / accFrames
  accMs = 0
  accFrames = 0
  if (avg > 34) {
    goodWindows = 0
    if (engine.resolutionScale > 0.56) {
      engine.resolutionScale = engine.resolutionScale - 0.15
    } else {
      const order: QualityTier[] = ['high', 'mid', 'low']
      const i = order.indexOf(engine.quality)
      if (i >= 0 && i < order.length - 1) {
        engine.setQuality(order[i + 1]!)
        engine.resolutionScale = 0.85
      }
    }
  } else if (avg < 19) {
    // 여유가 꽤 이어질 때만 조금씩 되돌린다(오르내림 반복 방지)
    goodWindows++
    if (goodWindows >= 4 && engine.resolutionScale < 1) {
      goodWindows = 0
      engine.resolutionScale = engine.resolutionScale + 0.1
    }
  } else {
    goodWindows = 0
  }
}

// ───────── 게임 루프 ─────────
let last = performance.now()
function frame(now: number): void {
  requestAnimationFrame(frame)
  const rawDt = (now - last) / 1000
  last = now
  if (document.hidden) return
  const dt = Math.min(0.1, Math.max(0, rawDt))
  const time = now / 1000

  input.update(dt)
  const cam = input.consumeCamera()
  const tap = input.consumeTap()
  const playing = store.phase === 'playing' || store.phase === 'reconnecting'

  if (playing && store.me) {
    if (store.phase === 'playing') {
      if (tap) handleTap(tap.clientX, tap.clientY)
      player.update(dt, now)
    }
    net.update()
    rig.rotate(cam.yaw, cam.pitch, cam.zoom)
    rig.follow(dt, store.me.x, store.me.y, store.me.z)
    chars.update(dt, time, buildVisuals(now))
  } else {
    rig.orbit(dt, time)
    chars.update(dt, time, [])
  }
  world.update(dt, time)
  fx.update(dt, time)
  engine.render()
  overlay.update()
  if (playing) watchPerformance(rawDt * 1000)
}
document.addEventListener('visibilitychange', () => {
  last = performance.now()
})
requestAnimationFrame(frame)

// 디버그/자동 테스트용 창구(서버 권위 구조라 노출해도 치트 이득이 없다)
declare global {
  interface Window {
    __doas?: { store: typeof store; bus: Bus; net: typeof net; actions: Actions; engine: typeof engine; player: typeof player; rig: typeof rig }
  }
}
window.__doas = { store, bus, net, actions, engine, player, rig }
