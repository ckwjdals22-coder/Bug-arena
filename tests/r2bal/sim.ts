/**
 * r2-balance 시뮬레이터: 실제 Room + 실제 NPC 시뮬 + DEFAULT_SYSTEMS 위에서 "평범한 사람처럼" 노는 봇.
 *   npx tsx tests/r2bal/sim.ts <scenario> <seeds> <minutes>
 * scenario: soloRandom | soloBest | richBest | room20 | podium | battleTie | battleTrade
 * 단순화: 봇은 장애물을 무시하고 직선으로 RUN_SPEED 로 달린다(좌표를 직접 갱신 — 낙관적).
 */
import { PITCH_COOLDOWN_MS, PROTOCOL_VERSION, RUN_SPEED, TICK_MS } from '../../shared/constants'
import { RANKS } from '../../shared/content/core'
import { PITCH_LINES } from '../../shared/content/lines'
import { DAILY_QUEST_BY_ID, ACHIEVEMENTS } from '../../shared/content/achievements'
import { WORLD } from '../../shared/world'
import { Room } from '../../server/core/room'
import { createNpcSim } from '../../server/core/npcSim'
import { DEFAULT_SYSTEMS } from '../../server/core/systems'
import type { PlayerState, NpcState } from '../../server/core/api'
import { FakeHost, LOOK0 } from '../unit/helpers'

const THINK_MIN = Number(process.env.THINK_MIN ?? 2500), THINK_SPAN = Number(process.env.THINK_SPAN ?? 1500), WATCH_MS = Number(process.env.WATCH_MS ?? 1500)
type Policy = 'random' | 'best' | 'none'
interface BotOpts {
  policy: Policy
  extras: boolean // 계시/설교/헌납/춤/일일수행
  podiumCamp?: boolean // 포교 안 하고 단상에서 계시+설교만
  battlePartner?: Bot
  battleMode?: 'normal' | 'tie' | 'trade'
  joinAt?: number // ms after start
}
class Bot {
  conn = 0
  id = 0
  read = 0
  phase: 'seek' | 'approach' | 'wait' | 'think' | 'duel' | 'task' | 'idle' = 'seek'
  target = 0
  since = 0
  thinkUntil = 0
  duelAt = 0
  duelN = 0
  localMemo = new Map<number, number>()
  freeSince = 0
  findTimes: number[] = []
  refused: Record<string, number> = {}
  talkReq = 0
  outcomes: Record<string, number> = {}
  byArch: Record<string, Record<string, number>> = {}
  byCat: Record<string, Record<string, number>> = {}
  rankAt: number[] = []
  folSamples: number[] = []
  lastPodium = -1e12
  lastProphecy = -1e12
  task: null | { kind: 'podium' | 'offer' | 'battle'; until: number; stage: number } = null
  sermonRound = 0
  danced = 0
  lastBattle = -1e12
  inBattle = false
  battleInv = 0
  infAt30 = 0
  joinedAt = 0
  fleeUntil = 0
  achSeen = 0
  achAt: Record<string, number> = {}
  fleeFrom = 0
  constructor(public o: BotOpts) {}
}

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function run(seed: number, minutes: number, bots: Bot[]) {
  const host = new FakeHost()
  ;(host as any).seed = seed * 7919 + 1
  const room = new Room(
    host,
    // NPC_MAX=28 이면 시민 수 고정(2차 수정 전과 같은 인구)
    { id: '1', name: 'sim', capacity: 20, npcCount: 28, ...(process.env.NPC_MAX ? { npcMax: Number(process.env.NPC_MAX) } : {}), seed, world: WORLD, systems: [...DEFAULT_SYSTEMS] },
    { createNpcSim },
  )
  const brnd = mulberry(seed ^ 0xabcdef)
  const t0 = host.t
  let nextConn = 1
  const send = (b: Bot, m: unknown) => room.message(b.conn, JSON.stringify(m))
  const P = (b: Bot): PlayerState | undefined => room.players.get(b.id)
  const join = (b: Bot) => {
    b.conn = nextConn++
    room.connect(b.conn)
    room.message(b.conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, pid: `simbot-${seed}-${b.conn}-xxxxxxxx`, name: `봇${b.conn}`, look: LOOK0, save: null }))
    const frames = host.frames.get(b.conn) ?? []
    for (const f of frames) if (typeof f === 'string') { const m = JSON.parse(f); if (m.t === 'welcome') b.id = m.id }
    b.joinedAt = host.t - t0
    b.freeSince = host.t
  }
  const drain = (b: Bot): any[] => {
    const fr = host.frames.get(b.conn)
    if (!fr) return []
    const out: any[] = []
    for (const f of fr) if (typeof f === 'string') out.push(JSON.parse(f))
    fr.length = 0
    return out
  }
  const moveToward = (p: PlayerState, x: number, z: number): number => {
    const dx = x - p.x, dz = z - p.z
    const d = Math.hypot(dx, dz)
    const step = (RUN_SPEED * TICK_MS) / 1000
    if (d > 1e-6) {
      const s = Math.min(step, d)
      p.x += (dx / d) * s
      p.z += (dz / d) * s
      p.dirty = true
      ;(p as any).lastMoveAt = host.t
    }
    return d
  }
  const lineFor = (b: Bot, npc: NpcState, lines: number[]): number => {
    if (b.o.policy === 'random') return lines[Math.floor(brnd() * lines.length)]!
    let best = lines[0]!, bs = -9
    for (const l of lines) {
      const L = PITCH_LINES[l]!
      const s = (npc.arch.like[L.cat] ?? 0) + L.power - 0.2 * (L.fleeBias ?? 0)
      if (s > bs) { bs = s; best = l }
    }
    return best
  }
  const totalMs = minutes * 60_000
  let lastPing = 0
  for (let ms = 0; ms < totalMs; ms += TICK_MS) {
    host.t += TICK_MS
    room.tick()
    const now = host.t
    const el = now - t0
    if (now - lastPing > 10_000) {
      lastPing = now
      for (const b of bots) if (b.id) send(b, { t: 'ping', c: 1 })
    }
    for (const b of bots) {
      if (!b.id) {
        if ((b.o.joinAt ?? 0) <= el) join(b)
        continue
      }
      const p = P(b)
      if (!p) continue
      const rank = p.prog.rank
      while (b.achSeen < p.prog.ach.length) { b.achAt[p.prog.ach[b.achSeen]!] = (el - b.joinedAt) / 60_000; b.achSeen++ }
      while (b.rankAt.length <= rank) b.rankAt.push(el - b.joinedAt)
      if (el - b.joinedAt <= 30 * 60_000) b.infAt30 = p.prog.inf
      if (Math.round(el) % 30_000 === 0) b.folSamples.push(room.npcs.followersOf(p.id).length)
      for (const m of drain(b)) {
        if (m.t === 'talkOk') {
          if (b.phase === 'wait' || b.phase === 'think') {
            if (m.round === 1) { b.findTimes.push((now - b.freeSince) / 1000) }
            b.phase = 'think'
            b.target = m.n
            b.thinkUntil = now + THINK_MIN + brnd() * THINK_SPAN
          }
        } else if (m.t === 'talkNo') {
          b.refused[m.why] = (b.refused[m.why] ?? 0) + 1
          if (m.why === 'memo') b.localMemo.set(m.n, now + (m.ms ?? 35_000))
          else if (m.why === 'busy' || m.why === 'gone' || m.why === 'mine') b.localMemo.set(m.n, now + 5000)
          if (m.why === 'cool') b.localMemo.set(m.n, 0)
          if (b.phase === 'wait') b.phase = 'seek'
        } else if (m.t === 'pitchRes' && m.p === b.id) {
          b.outcomes[m.o] = (b.outcomes[m.o] ?? 0) + 1
          const npc = room.npcs.get(m.n)
          const arch = npc?.arch.id ?? '?'
          ;(b.byArch[arch] ??= {})[m.o] = (b.byArch[arch]![m.o] ?? 0) + 1
          const cat = PITCH_LINES[m.l]!.cat
          ;(b.byCat[cat] ??= {})[m.o] = (b.byCat[cat]![m.o] ?? 0) + 1
          if (m.o !== 'join' && m.o !== 'king' && m.o !== 'more') b.localMemo.set(m.n, now + 35_000)
        } else if (m.t === 'talkEnd') {
          if (b.phase === 'think' || b.phase === 'wait') { b.phase = 'idle'; b.freeSince = now + WATCH_MS }
        } else if (m.t === 'duel' && m.ph === 'start') {
          b.phase = 'duel'; b.duelAt = now + 2000 + brnd() * 1500; b.duelN = m.n
        } else if (m.t === 'duel' && m.ph === 'end') {
          if (b.phase === 'duel') { b.phase = 'seek'; b.freeSince = now }
        } else if (m.t === 'battle' && m.ph === 'inv') {
          send(b, { t: 'battle', a: 'ans', from: m.from, ok: true })
        } else if (m.t === 'battle' && m.ph === 'start') {
          b.inBattle = true
        } else if (m.t === 'battle' && m.ph === 'end') {
          b.inBattle = false
          b.lastBattle = now
        } else if (m.t === 'patrol' && m.p === b.id && (m.ph === 'alert') && process.env.FLEE) {
          b.fleeUntil = now + 5200; b.fleeFrom = m.n; send(b, { t: 'emote', e: 'flee' })
          if (p.talk) send(b, { t: 'talkEnd', n: p.talk.npc }); b.phase = 'seek'
        } else if (m.t === 'sermon' && m.ph === 'call') {
          if (m.s?.joined?.includes(b.id)) b.sermonRound = m.round
        }
      }
      if (b.sermonRound) { send(b, { t: 'sermon', a: 'resp', r: b.sermonRound }); b.sermonRound = 0 }
      // daily claim
      const d = p.prog.daily
      if (d && b.o.extras) for (const q of d.quests) {
        const def = DAILY_QUEST_BY_ID.get(q)
        if (def && !d.done.includes(q) && (d.prog[q] ?? 0) >= def.n) send(b, { t: 'daily', q })
      }
      if (p.stunUntil > now) continue
      if (b.fleeUntil > now) {
        const pn = room.npcs.get(b.fleeFrom)
        if (pn) { const dx = p.x - pn.x, dz = p.z - pn.z, d = Math.hypot(dx, dz) || 1; const sp = p.sprintUntil > now ? 8.4 : 5.6; const st = sp * TICK_MS / 1000; p.x = Math.max(WORLD.bounds.x0 + 1, Math.min(WORLD.bounds.x1 - 1, p.x + dx / d * st)); p.z = Math.max(WORLD.bounds.z0 + 1, Math.min(WORLD.bounds.z1 - 1, p.z + dz / d * st)); p.dirty = true }
        continue
      }
      if (b.phase === 'duel') {
        if (now >= b.duelAt) { send(b, { t: 'duel', c: Math.floor(brnd() * 3) }); b.duelAt = Infinity }
        continue
      }
      if (b.phase === 'think') {
        if (now >= b.thinkUntil && p.talk) {
          const npc = room.npcs.get(p.talk.npc)
          if (npc) send(b, { t: 'pitch', n: npc.id, l: lineFor(b, npc, p.talk.lines) })
          b.thinkUntil = Infinity
        } else if (!p.talk && now >= b.thinkUntil) { b.phase = 'seek'; b.freeSince = now }
        continue
      }
      if (b.phase === 'wait') { if (now - b.since > 1000) b.phase = 'seek'; continue }
      if (b.phase === 'idle') { if (now >= b.freeSince) b.phase = 'seek'; else continue }

      // ── 과제(extras) ──
      if (b.phase === 'task' && b.task) {
        const t = b.task
        if (t.kind === 'podium') {
          const pd = WORLD.podium
          const d = moveToward(p, pd.x, pd.z)
          if (d < 0.5) {
            if (now - b.lastProphecy >= 20_100) { send(b, { t: 'prophecy' }); b.lastProphecy = now }
            if (t.stage === 0) { send(b, { t: 'sermon', a: 'start' }); t.stage = 1; t.until = now + 28_000 }
          }
          if (now > t.until || (t.stage === 1 && now > t.until)) {
            if (!b.o.podiumCamp) { b.task = null; b.phase = 'seek'; b.freeSince = now }
            else { t.stage = 0; t.until = now + 100_000 }
          }
          continue
        }
        if (t.kind === 'offer') {
          const bx = WORLD.offeringBox
          const d = moveToward(p, bx.x, bx.z + bx.r + 0.8)
          if (d < 0.4) { send(b, { t: 'offer' }); b.task = null; b.phase = 'seek'; b.freeSince = now }
          if (now > t.until) { b.task = null; b.phase = 'seek' }
          continue
        }
        if (t.kind === 'battle') {
          const q = b.o.battlePartner && P(b.o.battlePartner)
          if (!q) { b.task = null; b.phase = 'seek'; continue }
          const d = moveToward(p, q.x, q.z)
          if (d < 3) { send(b, { t: 'battle', a: 'req', to: q.id }); b.task = null; b.phase = 'seek'; b.lastBattle = now }
          if (now > t.until) { b.task = null; b.phase = 'seek' }
          continue
        }
      }
      if (b.o.podiumCamp) { b.phase = 'task'; b.task = { kind: 'podium', stage: 0, until: now + 100_000 }; continue }
      if (b.o.battleMode === 'tie' || b.o.battleMode === 'trade') {
        // 담합: 두 봇이 붙어 서서 배틀만 반복. trade 는 번갈아 1명씩만 포교해 승패를 주고받는다
        const q = b.o.battlePartner && P(b.o.battlePartner)
        if (q && !b.inBattle && now - b.lastBattle > 20_500 && b.conn < b.o.battlePartner!.conn) {
          p.x = q.x + 1; p.z = q.z
          send(b, { t: 'battle', a: 'req', to: q.id })
          b.lastBattle = now
        }
        if (b.o.battleMode === 'tie' || !b.inBattle) continue
      }
      if (b.o.extras && b.o.policy !== 'none') {
        if (b.danced < 3 && now - b.lastProphecy > 1000) { send(b, { t: 'emote', e: 'dance' }); b.danced++; continue }
        if (now - b.lastPodium > 150_000) { b.lastPodium = now; b.phase = 'task'; b.task = { kind: 'podium', stage: 0, until: now + 40_000 }; continue }
        const unoff = room.npcs.followersOf(p.id).filter((f) => !f.offered).length
        if (unoff >= 3) { b.phase = 'task'; b.task = { kind: 'offer', stage: 0, until: now + 30_000 }; continue }
        if (b.o.battlePartner && b.conn < b.o.battlePartner.conn && !b.inBattle && now - b.lastBattle > 180_000) {
          b.phase = 'task'; b.task = { kind: 'battle', stage: 0, until: now + 30_000 }; continue
        }
      }
      if (b.o.policy === 'none') continue
      // ── 포교: 가장 가까운 말 걸 수 있어 보이는 NPC ──
      if (b.phase === 'seek' || b.phase === 'approach') {
        let tgt: NpcState | undefined = b.phase === 'approach' ? room.npcs.get(b.target) : undefined
        const bad = (n: NpcState) => n.role === 'patrol' || n.mode === 'leave' || n.mode === 'enter' || n.mode === 'flee' || n.mode === 'script' || n.owner === p.id || (process.env.NOPOACH && n.owner !== 0) || (process.env.SEEBUSY && n.talker !== 0 && n.talker !== p.id) || (b.localMemo.get(n.id) ?? 0) > now
        if (!tgt || bad(tgt) || now - b.since > 20_000) {
          tgt = undefined
          let bd = Infinity
          for (const n of room.npcs.list) {
            if (bad(n)) continue
            const dd = Math.hypot(n.x - p.x, n.z - p.z)
            if (dd < bd) { bd = dd; tgt = n }
          }
          if (!tgt) continue
          b.target = tgt.id; b.phase = 'approach'; b.since = now
        }
        const d = moveToward(p, tgt.x, tgt.z)
        if (d <= 2.4 && (p.cd.get('pitch') ?? 0) <= now) {
          send(b, { t: 'talk', n: tgt.id }); b.talkReq++
          b.phase = 'wait'; b.since = now
        }
      }
    }
    if (process.env.MODES && el % 300_000 === 0) {
      const h: Record<string, number> = {}
      for (const n of room.npcs.list) { const k = n.mode + (n.owner ? '+own' : '') + (n.talker ? '+talk' : ''); h[k] = (h[k] ?? 0) + 1 }
      console.log(Math.round(el / 60000), JSON.stringify(h))
    }
    for (const fr of host.frames.values()) for (let i = fr.length - 1; i >= 0; i--) if (typeof fr[i] !== 'string') fr.splice(i, 1)
  }
  return { room, host, P: (b: Bot) => room.players.get(b.id) }
}

// ───────── 시나리오 ─────────
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : NaN }
const q = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))]! : NaN }
const fmt = (a: number[], dp = 1) => `${med(a).toFixed(dp)} [${q(a, 0.1).toFixed(dp)}–${q(a, 0.9).toFixed(dp)}]`
const gini = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; const sum = s.reduce((a, b) => a + b, 0); let g = 0; s.forEach((x, i) => (g += (2 * (i + 1) - n - 1) * x)); return g / (n * sum) }

function main() {
  const [scenario = 'soloRandom', seedsS = '12', minS = '60'] = process.argv.slice(2)
  const seeds = Number(seedsS), minutes = Number(minS)
  const agg: Record<string, number[]> = {}
  const add = (k: string, v: number) => (agg[k] ??= []).push(v)
  const arch: Record<string, Record<string, number>> = {}
  const cats: Record<string, Record<string, number>> = {}
  const achT: Record<string, number[]> = {}
  let nb = 0
  const mergeInto = (dst: Record<string, Record<string, number>>, src: Record<string, Record<string, number>>) => { for (const [k, v] of Object.entries(src)) for (const [o, n] of Object.entries(v)) (dst[k] ??= {})[o] = (dst[k]![o] ?? 0) + n }
  for (let s = 1; s <= seeds; s++) {
    let bots: Bot[] = []
    if (scenario === 'soloRandom') bots = [new Bot({ policy: 'random', extras: false })]
    else if (scenario === 'soloBest') bots = [new Bot({ policy: 'best', extras: false })]
    else if (scenario === 'richBest' || scenario === 'richRandom') {
      const pol = scenario === 'richBest' ? 'best' : 'random'
      const a = new Bot({ policy: pol, extras: true }), b = new Bot({ policy: pol, extras: true })
      a.o.battlePartner = b; b.o.battlePartner = a; bots = [a, b]
    } else if (scenario === 'room20') {
      for (let i = 0; i < 20; i++) bots.push(new Bot({ policy: i % 2 ? 'best' : 'random', extras: false, joinAt: i < 15 ? 0 : 30 * 60_000 }))
    } else if (scenario === 'podium') bots = [new Bot({ policy: 'none', extras: true, podiumCamp: true })]
    else if (scenario === 'battleTie' || scenario === 'battleTrade') {
      const mode = scenario === 'battleTie' ? 'tie' : 'trade'
      const a = new Bot({ policy: 'random', extras: false, battleMode: mode }), b = new Bot({ policy: 'random', extras: false, battleMode: mode })
      a.o.battlePartner = b; b.o.battlePartner = a; bots = [a, b]
    }
    const r = run(1000 + (s + Number(process.env.SEED_OFFSET ?? 0)) * 17, minutes, bots)
    const infs: number[] = []
    nb += bots.length
    bots.forEach((b, i) => {
      const p = r.P(b)!
      const mins = (minutes * 60_000 - b.joinedAt) / 60_000
      const st = p.prog.stats
      infs.push(p.prog.inf)
      const tag = scenario === 'room20' ? (i < 15 ? 'early' : 'late') : 'all'
      add(`${tag}.inf/min`, p.prog.inf / mins)
      add(`${tag}.inf_total`, p.prog.inf)
      add(`${tag}.pitches/min`, (st.pitches ?? 0) / mins)
      add(`${tag}.talks/min`, (st.talks ?? 0) / mins)
      add(`${tag}.joins/min`, (st.joins ?? 0) / mins)
      add(`${tag}.fol_total`, p.prog.fol)
      add(`${tag}.joins/pitch`, (st.joins ?? 0) / Math.max(1, st.pitches ?? 0))
      add(`${tag}.ach_count`, p.prog.ach.length)
      add(`${tag}.offer_items`, Object.keys(p.prog.items).length)
      add(`${tag}.steals/hour`, ((st.poaches ?? 0) / mins) * 60)
      add(`${tag}.joins/hour`, ((st.joins ?? 0) / mins) * 60)
      add(`${tag}.caught`, st.caught ?? 0); add(`${tag}.offerings`, st.offerings ?? 0); add(`${tag}.escapes`, st.escapes ?? 0); add(`${tag}.poaches`, st.poaches ?? 0)
      add(`${tag}.prophecies`, st.prophecies ?? 0)
      add(`${tag}.sermonsLed`, st.sermonsLed ?? 0)
      add(`${tag}.battles`, st.battles ?? 0)
      add(`${tag}.rank_final`, p.prog.rank)
      add(`${tag}.infFirst30`, b.infAt30)
      add(`${tag}.find_s`, med(b.findTimes)); if (process.env.DBG) console.log(b.findTimes.slice(0,30).map(x=>x.toFixed(1)).join(" "))
      add(`${tag}.fol_avg`, b.folSamples.reduce((x, y) => x + y, 0) / Math.max(1, b.folSamples.length))
      const refusedTotal = Object.values(b.refused).reduce((x, y) => x + y, 0)
      add(`${tag}.talkRefused%`, (100 * refusedTotal) / Math.max(1, b.talkReq))
      for (const k of ['busy', 'memo', 'cool', 'gone', 'far']) add(`${tag}.refused_${k}%`, (100 * (b.refused[k] ?? 0)) / Math.max(1, b.talkReq))
      for (let rk = 1; rk <= 5; rk++) add(`${tag}.t_rank${rk}_min`, b.rankAt[rk] !== undefined ? b.rankAt[rk]! / 60_000 : Infinity)
      for (const o of ['join', 'king', 'more', 'no', 'flee', 'ignore', 'rival']) add(`${tag}.out_${o}%`, (100 * (b.outcomes[o] ?? 0)) / Math.max(1, Object.values(b.outcomes).reduce((x, y) => x + y, 0)))
      mergeInto(arch, b.byArch); mergeInto(cats, b.byCat)
      for (const [k, v] of Object.entries(b.achAt)) (achT[k] ??= []).push(v)
      add(`${tag}.ach_in_first_2min`, Object.values(b.achAt).filter((v) => v <= 2).length)
      if (scenario === 'podium' || scenario.startsWith('battle')) add(`${tag}.achs`, p.prog.ach.length)
    })
    if (scenario === 'room20') add('gini_early_inf', gini(infs.slice(0, 15)))
    add('npcs_end', r.room.npcs.list.length)
  }
  console.log(`# ${scenario} seeds=${seeds} minutes=${minutes}  (median [p10–p90])`)
  for (const [k, v] of Object.entries(agg)) console.log(k.padEnd(28), fmt(v, 2), `n=${v.length}`)
  const pr = (title: string, t: Record<string, Record<string, number>>) => {
    console.log(`## ${title}: n, join%, more%(of outcomes), flee%, ignore%, no%, rival%`)
    for (const [k, v] of Object.entries(t).sort()) {
      const n = Object.values(v).reduce((x, y) => x + y, 0)
      const pc = (o: string) => ((100 * (v[o] ?? 0)) / n).toFixed(0)
      console.log(`${k.padEnd(10)} n=${String(n).padStart(5)} join=${pc('join')}+king${pc('king')} more=${pc('more')} flee=${pc('flee')} ign=${pc('ignore')} no=${pc('no')} rival=${pc('rival')}`)
    }
  }
  if (process.env.ACH) { console.log(`## achievements: id, fraction of bots, median minute`); for (const a of ACHIEVEMENTS) { const v = achT[a.id] ?? []; console.log(a.id.padEnd(14), (v.length / nb).toFixed(2), v.length ? med(v).toFixed(1) : '-') } }
  if (process.env.DETAIL) { pr('per archetype', arch); pr('per line cat', cats) }
}
main()
