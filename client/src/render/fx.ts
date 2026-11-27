/**
 * 파티클 이펙트. 모든 이펙트가 스프라이트 배치 하나(드로콜 1개)를 나눠 쓴다.
 *
 * burst(kind, x, y, z, color?) 의 좌표는 "캐릭터 발밑(지면)" 이다. 머리 위로 띄우는 높이는 이펙트가 알아서 더한다.
 * color 는 선택 사항(0xRRGGBB): 하트·색종이·빛기둥·연기·반짝이의 주색을 바꾼다(교단색 등).
 *
 * 입자 수는 상한이 있다(high 400 / mid 300 / low 160). 가득 차면 가장 오래된 것부터 덮어쓴다.
 */
import { reducedMotion } from '../core/motion'
import type { EngineApi, FxApi, FxKind, QualityTier } from '../core/contracts'
import { lin } from './chars/geo'
import type { RGB } from './chars/geo'
import { CELL, MODE, SpriteBatch } from './chars/sprites'

const CAP = 400
const PI = Math.PI
const TAU = PI * 2

/** 입자 종류 */
const K_FREE = 0 // 속도·중력으로 움직인다
const K_RAY = 1 // 기준점에 붙어 화면 평면에서 부채꼴로 뻗는 빛살

const F_POP = 1 // 톡 튀어나오며 커진다
const F_FIXH = 2 // 폭만 변하고 높이는 고정(빛기둥: 밑동이 바닥에 붙어 있어야 한다)

const C_PINK = lin(0xff5c8a)
const C_GOLD = lin(0xffd84a)
const C_WHITE = lin(0xffffff)
const C_SWEAT = lin(0x7cc7ff)
const C_DUST = lin(0xd9c7a8)
const C_SMOKE = lin(0xf4f1f8)
const C_LIGHT = lin(0xfff2b0)
const C_RED = lin(0xff4a3d)
const CONFETTI: RGB[] = [0xff5c8a, 0xffd23f, 0x4fd1e6, 0x8be36a, 0xff9d3c, 0xa78bfa, 0xffffff].map((h) => lin(h))

interface Emitter {
  kind: 'confetti' | 'rise'
  x: number
  y: number
  z: number
  color: RGB | null
  age: number
  dur: number
  rate: number
  carry: number
}

function limitFor(q: QualityTier): number {
  return q === 'low' ? 160 : q === 'mid' ? 300 : CAP
}

class Fx implements FxApi {
  private readonly engine: EngineApi
  private readonly batch: SpriteBatch
  private limit: number
  /** 다음에 쓸 칸(원형 버퍼) */
  private head = 0
  private seed = 0x9e3779b9
  private readonly emitters: Emitter[] = []
  private disposed = false

  // 입자 상태(배열 묶음)
  private readonly px = new Float32Array(CAP)
  private readonly py = new Float32Array(CAP)
  private readonly pz = new Float32Array(CAP)
  private readonly vx = new Float32Array(CAP)
  private readonly vy = new Float32Array(CAP)
  private readonly vz = new Float32Array(CAP)
  private readonly age = new Float32Array(CAP)
  /** 수명(초). 0 이면 빈 칸 */
  private readonly life = new Float32Array(CAP)
  private readonly s0 = new Float32Array(CAP)
  private readonly s1 = new Float32Array(CAP)
  /** 세로/가로 비 */
  private readonly asp = new Float32Array(CAP)
  private readonly rot = new Float32Array(CAP)
  private readonly vrot = new Float32Array(CAP)
  private readonly cr = new Float32Array(CAP)
  private readonly cg = new Float32Array(CAP)
  private readonly cb = new Float32Array(CAP)
  private readonly ca = new Float32Array(CAP)
  private readonly grav = new Float32Array(CAP)
  private readonly drag = new Float32Array(CAP)
  /** 나타나는 구간 끝 / 사라지기 시작하는 지점 (수명 대비 0..1) */
  private readonly fin = new Float32Array(CAP)
  private readonly fout = new Float32Array(CAP)
  /** 좌우 살랑임 폭 / 빠르기 */
  private readonly sway = new Float32Array(CAP)
  private readonly swf = new Float32Array(CAP)
  /** 0 보다 크면 가로 폭이 이 빠르기로 뒤집힌다(동전·색종이의 팔랑임) */
  private readonly flip = new Float32Array(CAP)
  private readonly add = new Float32Array(CAP)
  private readonly cell = new Uint8Array(CAP)
  private readonly mode = new Uint8Array(CAP)
  private readonly kind = new Uint8Array(CAP)
  private readonly flag = new Uint8Array(CAP)

  constructor(engine: EngineApi) {
    this.engine = engine
    this.limit = limitFor(engine.quality)
    // 캐릭터와 캐릭터의 스프라이트보다 나중에 그린다
    this.batch = new SpriteBatch(engine.scene, CAP, { renderOrder: 3 })
    this.batch.growable = false
    engine.onQuality((q) => {
      if (this.disposed) return
      this.limit = limitFor(q)
      // 상한이 줄면 그 밖의 칸은 더 이상 돌지 않는다. 나중에 다시 늘었을 때 옛 입자가 되살아나지 않게 비운다
      this.life.fill(0, this.limit)
      this.head %= this.limit
    })
  }

  /** 결정적 난수 0..1 (같은 순서로 터뜨리면 같은 모양 — 스크린샷 비교가 쉽다) */
  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }
  private range(a: number, b: number): number {
    return a + (b - a) * this.rnd()
  }
  /** 품질이 낮으면 개수를 줄인다(최소 1개). 움직임 줄이기 설정에서는 절반만 쓴다 */
  private count(n: number): number {
    const k = reducedMotion() ? 0.5 : 1
    return Math.max(1, Math.round((n * k * this.limit) / CAP))
  }

  /** 빈 입자 하나를 기본값으로 만들고 그 번호를 돌려준다 */
  private spawn(x: number, y: number, z: number, cell: number, size: number, life: number, c: RGB): number {
    const i = this.head
    this.head = (this.head + 1) % this.limit
    this.px[i] = x
    this.py[i] = y
    this.pz[i] = z
    this.vx[i] = this.vy[i] = this.vz[i] = 0
    this.age[i] = 0
    this.life[i] = life
    this.s0[i] = this.s1[i] = size
    this.asp[i] = 1
    this.rot[i] = 0
    this.vrot[i] = 0
    this.cr[i] = c[0]
    this.cg[i] = c[1]
    this.cb[i] = c[2]
    this.ca[i] = 1
    this.grav[i] = 0
    this.drag[i] = 0
    this.fin[i] = 0.08
    this.fout[i] = 0.6
    this.sway[i] = 0
    this.swf[i] = 0
    this.flip[i] = 0
    this.add[i] = 0
    this.cell[i] = cell
    this.mode[i] = MODE.Billboard
    this.kind[i] = K_FREE
    this.flag[i] = 0
    return i
  }

  private sparkle(x: number, y: number, z: number, speed: number, c: RGB, size: number, life: number): void {
    const i = this.spawn(x, y, z, CELL.Spark, size, life, c)
    const a = this.rnd() * TAU
    const up = this.range(0.2, 1)
    const h = Math.sqrt(1 - up * up * 0.6)
    this.vx[i] = Math.cos(a) * h * speed
    this.vz[i] = Math.sin(a) * h * speed
    this.vy[i] = up * speed
    this.grav[i] = -1.5
    this.drag[i] = 1.6
    this.s1[i] = size * 0.35
    this.rot[i] = this.rnd() * TAU
    this.vrot[i] = this.range(-4, 4)
    // 완전 가산이면 밝은 바닥·하늘 위에서 사라진다 → 절반쯤만 더한다
    this.add[i] = 0.5
    this.flag[i] = F_POP
    this.fout[i] = 0.5
  }

  private groundRing(x: number, y: number, z: number, from: number, to: number, life: number, c: RGB, additive: number): void {
    const i = this.spawn(x, y + 0.05, z, CELL.Ring, from, life, c)
    this.s1[i] = to
    this.mode[i] = MODE.Ground
    this.add[i] = additive
    this.fin[i] = 0.05
    this.fout[i] = 0.25
  }

  burst(kind: FxKind, x: number, y: number, z: number, color?: number): void {
    if (this.disposed) return
    const tint = typeof color === 'number' && color >= 0 ? lin(color) : null
    switch (kind) {
      case 'join': {
        // 합류: 머리 위로 퐁퐁 솟는 하트 + 사방으로 튀는 반짝이
        const hc = tint ?? C_PINK
        for (let k = this.count(7); k > 0; k--) {
          const i = this.spawn(x + this.range(-0.38, 0.38), y + this.range(1.15, 1.7), z + this.range(-0.38, 0.38), CELL.Heart, 0.12, this.range(1.05, 1.5), hc)
          this.age[i] = -this.rnd() * 0.25
          this.vy[i] = this.range(0.9, 1.5)
          this.vx[i] = this.range(-0.3, 0.3)
          this.vz[i] = this.range(-0.3, 0.3)
          this.drag[i] = 0.6
          this.s1[i] = this.range(0.42, 0.58)
          this.sway[i] = this.range(0.1, 0.22)
          this.swf[i] = this.range(4, 7)
          this.rot[i] = this.range(-0.3, 0.3)
          this.flag[i] = F_POP
          this.fout[i] = 0.7
        }
        for (let k = this.count(10); k > 0; k--) this.sparkle(x, y + 1.35, z, this.range(1.6, 2.8), k % 3 === 0 ? C_WHITE : C_GOLD, this.range(0.4, 0.6), this.range(0.6, 0.95))
        this.groundRing(x, y, z, 0.6, 2.4, 0.55, hc, 0.5)
        break
      }
      case 'fail': {
        // 거절: 머리에서 양옆으로 튀는 식은땀 방울
        const n = this.count(6)
        for (let k = 0; k < n; k++) {
          const side = k % 2 === 0 ? 1 : -1
          const a = this.range(-0.9, 0.9) + (side > 0 ? 0 : PI)
          const i = this.spawn(x + Math.cos(a) * 0.3, y + this.range(1.3, 1.6), z + Math.sin(a) * 0.3, CELL.Drop, this.range(0.26, 0.36), this.range(0.6, 0.85), C_SWEAT)
          const sp = this.range(1.1, 2.0)
          this.vx[i] = Math.cos(a) * sp
          this.vz[i] = Math.sin(a) * sp
          this.vy[i] = this.range(1.6, 2.8)
          this.grav[i] = -9
          this.asp[i] = 1.25
          this.rot[i] = this.range(-0.5, 0.5)
          this.s1[i] = this.s0[i]! * 0.7
          this.fout[i] = 0.75
        }
        // 풀 죽은 작은 한숨 구름
        const i = this.spawn(x, y + 1.75, z, CELL.Puff, 0.25, 0.7, lin(0xb9c4d6))
        this.vy[i] = 0.5
        this.s1[i] = 0.6
        this.ca[i] = 0.7
        this.fout[i] = 0.3
        break
      }
      case 'flee': {
        // 도망: 발밑에서 피어오르는 흙먼지(달리는 동안 여러 번 불러 꼬리를 만든다)
        for (let k = this.count(5); k > 0; k--) {
          const a = this.rnd() * TAU
          const i = this.spawn(x + Math.cos(a) * 0.15, y + this.range(0.1, 0.25), z + Math.sin(a) * 0.15, CELL.Puff, this.range(0.4, 0.55), this.range(0.55, 0.9), C_DUST)
          const sp = this.range(0.5, 1.3)
          this.vx[i] = Math.cos(a) * sp
          this.vz[i] = Math.sin(a) * sp
          this.vy[i] = this.range(0.3, 0.9)
          this.drag[i] = 2.6
          this.s1[i] = this.range(1.0, 1.35)
          this.rot[i] = this.rnd() * TAU
          this.vrot[i] = this.range(-1.5, 1.5)
          this.ca[i] = 0.85
          this.fout[i] = 0.25
        }
        break
      }
      case 'rank': {
        // 승급: 약 2초 동안 솟구치는 색종이 분수 + 별
        this.emitters.push({ kind: 'confetti', x, y: y + 0.4, z, color: tint, age: 0, dur: 1.25, rate: (100 * this.limit) / CAP, carry: 0 })
        for (let k = this.count(6); k > 0; k--) {
          const i = this.spawn(x, y + 1.2, z, CELL.Star, 0.25, this.range(1.0, 1.4), C_GOLD)
          const a = this.rnd() * TAU
          const sp = this.range(1.5, 2.6)
          this.vx[i] = Math.cos(a) * sp
          this.vz[i] = Math.sin(a) * sp
          this.vy[i] = this.range(3, 5)
          this.grav[i] = -7
          this.drag[i] = 0.8
          this.s1[i] = 0.55
          this.vrot[i] = this.range(-6, 6)
          this.flag[i] = F_POP
          this.add[i] = 0.2
        }
        this.groundRing(x, y, z, 0.6, 3.4, 0.7, C_GOLD, 0.6)
        break
      }
      case 'prophecy': {
        // 계시: 하늘에서 내리꽂히는 빛기둥 + 부채꼴 빛살 + 솟는 반짝이
        const lc = tint ?? C_LIGHT
        for (let k = 0; k < 2; k++) {
          const wide = k === 0
          const i = this.spawn(x, y + 3.3, z, CELL.Beam, wide ? 1.5 : 0.7, 1.75, wide ? lc : C_WHITE)
          this.mode[i] = MODE.Upright
          this.flag[i] = F_FIXH
          this.s1[i] = wide ? 2.3 : 0.9
          this.asp[i] = wide ? 6.6 / 2.3 : 6.6 / 0.9
          this.add[i] = 1
          this.ca[i] = wide ? 0.7 : 0.85
          this.fin[i] = 0.1
          this.fout[i] = 0.55
        }
        const rays = this.count(9)
        for (let k = 0; k < rays; k++) {
          const i = this.spawn(x, y + 0.2, z, CELL.Ray, 0.55, this.range(1.2, 1.6), lc)
          this.kind[i] = K_RAY
          // 위쪽 부채꼴(−80°..+80°)로 고르게
          this.rot[i] = ((k + 0.5) / rays - 0.5) * 2.8
          this.vrot[i] = this.range(-0.25, 0.25)
          this.asp[i] = this.range(4.5, 7)
          this.s1[i] = 0.75
          this.add[i] = 1
          this.ca[i] = 0.55
          this.fin[i] = 0.15
          this.fout[i] = 0.45
        }
        this.emitters.push({ kind: 'rise', x, y, z, color: lc, age: 0, dur: 1.2, rate: (26 * this.limit) / CAP, carry: 0 })
        this.groundRing(x, y, z, 0.8, 4.2, 0.9, lc, 0.8)
        break
      }
      case 'coin': {
        // 헌납: 엽전이 솟았다가 포물선으로 떨어진다
        for (let k = this.count(8); k > 0; k--) {
          const a = this.rnd() * TAU
          const i = this.spawn(x, y + 0.9, z, CELL.Coin, this.range(0.3, 0.4), this.range(0.95, 1.25), C_WHITE)
          this.age[i] = -this.rnd() * 0.18
          const sp = this.range(0.6, 1.9)
          this.vx[i] = Math.cos(a) * sp
          this.vz[i] = Math.sin(a) * sp
          this.vy[i] = this.range(3.6, 5.6)
          this.grav[i] = -11
          this.flip[i] = this.range(11, 17)
          this.rot[i] = this.range(-0.4, 0.4)
          this.fout[i] = 0.85
          this.fin[i] = 0.03
        }
        for (let k = this.count(5); k > 0; k--) this.sparkle(x, y + 1.3, z, this.range(1.2, 2.2), C_GOLD, this.range(0.34, 0.5), this.range(0.5, 0.8))
        break
      }
      case 'poof': {
        // 등장/퇴장: 옆으로 퍼지는 연기 고리 + 가운데서 피어오르는 연기
        const sc = tint ?? C_SMOKE
        const n = this.count(12)
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU + this.range(-0.15, 0.15)
          const i = this.spawn(x + Math.cos(a) * 0.2, y + this.range(0.4, 0.7), z + Math.sin(a) * 0.2, CELL.Puff, this.range(0.4, 0.55), this.range(0.5, 0.75), sc)
          const sp = this.range(2.2, 3.0)
          this.vx[i] = Math.cos(a) * sp
          this.vz[i] = Math.sin(a) * sp
          this.vy[i] = this.range(0.1, 0.5)
          this.drag[i] = 4
          this.s1[i] = this.range(0.9, 1.2)
          this.rot[i] = this.rnd() * TAU
          this.vrot[i] = this.range(-2, 2)
          this.ca[i] = 0.9
          this.fout[i] = 0.3
        }
        for (let k = this.count(4); k > 0; k--) {
          const i = this.spawn(x + this.range(-0.2, 0.2), y + this.range(0.5, 1.1), z + this.range(-0.2, 0.2), CELL.Puff, 0.5, this.range(0.6, 0.9), sc)
          this.vy[i] = this.range(0.8, 1.6)
          this.drag[i] = 1.5
          this.s1[i] = this.range(1.0, 1.4)
          this.rot[i] = this.rnd() * TAU
          this.ca[i] = 0.85
          this.fout[i] = 0.25
        }
        break
      }
      case 'cheer': {
        // 환호: 머리 위에서 톡톡 튀는 작은 반짝이
        for (let k = this.count(7); k > 0; k--) {
          this.sparkle(x + this.range(-0.35, 0.35), y + this.range(1.35, 1.8), z + this.range(-0.35, 0.35), this.range(1.0, 2.0), tint ?? (k % 3 === 0 ? C_WHITE : C_GOLD), this.range(0.36, 0.52), this.range(0.5, 0.8))
        }
        break
      }
      case 'alert': {
        // 단속: 머리 위에 빨간 느낌표가 "뿅!" + 만화식 놀람 선
        const i = this.spawn(x, y + 2.15, z, CELL.Bang, 0.8, 1.15, C_WHITE)
        this.flag[i] = F_POP
        this.vy[i] = 0.12
        this.fin[i] = 0.02
        this.fout[i] = 0.85
        const n = this.count(7)
        for (let k = 0; k < n; k++) {
          const j = this.spawn(x, y + 2.15, z, CELL.Ray, 0.16, 0.45, C_RED)
          this.kind[j] = K_RAY
          this.rot[j] = (k / n) * TAU + 0.3
          this.asp[j] = 2.6
          // 느낌표 바깥에서 시작해 밖으로 밀려난다(vx 를 반지름 속도로 쓴다)
          this.px[j] = x
          this.vx[j] = 1.6
          this.sway[j] = 0.55
          this.s1[j] = 0.2
          this.add[j] = 0
          this.fin[j] = 0.05
          this.fout[j] = 0.4
        }
        this.groundRing(x, y, z, 0.5, 1.8, 0.4, C_RED, 0.3)
        break
      }
    }
  }

  private runEmitters(dt: number): void {
    for (let e = this.emitters.length - 1; e >= 0; e--) {
      const em = this.emitters[e]!
      let n = em.rate * dt + em.carry
      const whole = Math.floor(n)
      em.carry = n - whole
      n = whole
      for (let k = 0; k < n; k++) {
        if (em.kind === 'confetti') {
          const pick = em.color && this.rnd() < 0.35 ? em.color : CONFETTI[Math.floor(this.rnd() * CONFETTI.length)]!
          const i = this.spawn(em.x, em.y, em.z, CELL.Rect, this.range(0.14, 0.2), this.range(1.3, 2.0), pick)
          const a = this.rnd() * TAU
          const sp = this.range(0.3, 2.4)
          this.vx[i] = Math.cos(a) * sp
          this.vz[i] = Math.sin(a) * sp
          this.vy[i] = this.range(5, 8)
          this.grav[i] = -9.5
          this.drag[i] = 1.3
          this.asp[i] = 0.55
          this.rot[i] = this.rnd() * TAU
          this.vrot[i] = this.range(-10, 10)
          this.flip[i] = this.range(6, 14)
          this.fin[i] = 0.02
          this.fout[i] = 0.8
        } else {
          const a = this.rnd() * TAU
          const r = this.range(0.1, 0.75)
          const i = this.spawn(em.x + Math.cos(a) * r, em.y + this.range(0.1, 0.6), em.z + Math.sin(a) * r, CELL.Spark, this.range(0.28, 0.44), this.range(0.6, 0.95), this.rnd() < 0.5 && em.color ? em.color : C_WHITE)
          this.vy[i] = this.range(1.6, 3.4)
          this.s1[i] = 0.08
          this.rot[i] = this.rnd() * TAU
          this.vrot[i] = this.range(-3, 3)
          this.add[i] = 0.9
          this.fout[i] = 0.4
        }
      }
      em.age += dt
      if (em.age >= em.dur) this.emitters.splice(e, 1)
    }
  }

  update(dt: number, _time: number): void {
    if (this.disposed) return
    const step = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0
    if (step > 0) this.runEmitters(step)

    // 빛살은 화면 평면에서 뻗으므로 카메라의 오른쪽/위 방향이 필요하다
    const ce = this.engine.camera.matrixWorld.elements
    const rx = ce[0]!
    const ry = ce[1]!
    const rz = ce[2]!
    const ux = ce[4]!
    const uy = ce[5]!
    const uz = ce[6]!

    const b = this.batch
    b.begin()
    for (let i = 0; i < this.limit; i++) {
      const life = this.life[i]!
      if (life <= 0) continue
      let age = this.age[i]! + step
      this.age[i] = age
      // 음수 나이 = 아직 대기 중(조금씩 시차를 두고 나타난다)
      if (age < 0) continue
      if (age >= life) {
        this.life[i] = 0
        continue
      }
      const u = age / life
      const kind = this.kind[i]!
      if (kind === K_FREE && step > 0) {
        const k = Math.exp(-this.drag[i]! * step)
        this.vx[i] = this.vx[i]! * k
        this.vz[i] = this.vz[i]! * k
        this.vy[i] = this.vy[i]! * k + this.grav[i]! * step
        this.px[i] = this.px[i]! + this.vx[i]! * step
        this.py[i] = this.py[i]! + this.vy[i]! * step
        this.pz[i] = this.pz[i]! + this.vz[i]! * step
      }
      this.rot[i] = this.rot[i]! + this.vrot[i]! * step

      // 크기: 수명에 걸쳐 s0 → s1 (처음에 빠르게 변하고 천천히 멎는다)
      const e = 1 - (1 - u) * (1 - u)
      let size = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * e
      if (this.flag[i]! & F_POP) {
        // 살짝 넘쳤다가 제 크기로
        const p = Math.min(1, age / 0.22)
        const q = p - 1
        size *= 1 + 2.4 * q * q * q + 1.4 * q * q
      }
      // 투명도: 나타남 → 유지 → 사라짐
      const fi = this.fin[i]!
      const fo = this.fout[i]!
      let alpha = this.ca[i]!
      if (u < fi) alpha *= u / fi
      else if (u > fo) alpha *= 1 - (u - fo) / (1 - fo)
      if (alpha <= 0.003 || size <= 0.003) continue

      let x = this.px[i]!
      let y = this.py[i]!
      let z = this.pz[i]!
      let w = size
      const h = (this.flag[i]! & F_FIXH ? this.s1[i]! : size) * this.asp[i]!
      const rot = this.rot[i]!
      if (kind === K_RAY) {
        // 기준점에서 rot 방향으로 뻗는 빛살: 사각형 중심을 길이의 절반만큼 밀어 놓는다
        const out = this.sway[i]! + this.vx[i]! * age + h * 0.5
        const dx = -Math.sin(rot)
        const dy = Math.cos(rot)
        x += (rx * dx + ux * dy) * out
        y += (ry * dx + uy * dy) * out
        z += (rz * dx + uz * dy) * out
      } else {
        const sw = this.sway[i]!
        if (sw > 0) {
          const s = Math.sin(age * this.swf[i]! + i) * sw
          x += rx * s
          z += rz * s
        }
        const fl = this.flip[i]!
        if (fl > 0) w *= 0.12 + 0.88 * Math.abs(Math.cos(age * fl + i))
      }
      b.push(x, y, z, w, h, rot, this.mode[i]!, this.add[i]!, this.cr[i]!, this.cg[i]!, this.cb[i]!, alpha, this.cell[i]!)
    }
    b.end()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.emitters.length = 0
    this.life.fill(0)
    this.batch.dispose()
  }
}

export function createFx(engine: EngineApi): FxApi {
  return new Fx(engine)
}
