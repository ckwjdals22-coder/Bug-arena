/**
 * 바이너리 코덱(MOVE / SNAPSHOT)과 JSON 파서 테스트.
 * 양자화 오차 한계와 경계값, 잘못된 패킷 거부를 본다.
 */
import { describe, expect, it } from 'vitest'
import { Anim } from '../../shared/constants'
import {
  BIN_MOVE,
  BIN_SNAPSHOT,
  MOVE_BYTES,
  type SnapEnt,
  decodeMove,
  decodeSnapshot,
  dequantPos,
  dequantYaw,
  encodeMove,
  encodeSnapshot,
  parseJsonMsg,
  quantPos,
  quantYaw,
} from '../../shared/protocol'
import { mulberry32 } from '../../shared/rng'

const TWO_PI = Math.PI * 2
/** 두 각도의 최단 차이(절댓값) */
const angleDiff = (a: number, b: number): number => {
  let d = (a - b) % TWO_PI
  if (d > Math.PI) d -= TWO_PI
  if (d < -Math.PI) d += TWO_PI
  return Math.abs(d)
}

describe('양자화', () => {
  it('위치는 cm 단위로 반올림되고 ±327.67m 에서 잘린다', () => {
    expect(quantPos(0)).toBe(0)
    expect(quantPos(1.234)).toBe(123)
    expect(quantPos(-1.236)).toBe(-124)
    expect(quantPos(327.67)).toBe(32767)
    expect(quantPos(327.68)).toBe(32767)
    expect(quantPos(1e9)).toBe(32767)
    expect(quantPos(-327.68)).toBe(-32768)
    expect(quantPos(-1e9)).toBe(-32768)
    expect(dequantPos(32767)).toBe(327.67)
    expect(dequantPos(-32768)).toBe(-327.68)
    // 맵 범위 안에서는 오차가 0.5cm 이하
    const rnd = mulberry32(1)
    for (let i = 0; i < 2000; i++) {
      const v = (rnd() - 0.5) * 200
      expect(Math.abs(dequantPos(quantPos(v)) - v)).toBeLessThanOrEqual(0.005 + 1e-9)
    }
  })

  it('방향은 256 단계로 접히고 음수·한 바퀴 넘는 값도 받는다', () => {
    expect(quantYaw(0)).toBe(0)
    expect(quantYaw(Math.PI)).toBe(128)
    expect(quantYaw(Math.PI / 2)).toBe(64)
    expect(quantYaw(-Math.PI / 2)).toBe(192)
    expect(quantYaw(TWO_PI)).toBe(0)
    expect(quantYaw(TWO_PI * 5 + Math.PI)).toBe(128)
    // 한 바퀴 직전은 반올림되어 0 으로 돌아온다(256 이 되어 넘치면 안 된다)
    expect(quantYaw(TWO_PI - 1e-6)).toBe(0)
    expect(quantYaw(-1e-6)).toBe(0)
    const rnd = mulberry32(2)
    for (let i = 0; i < 2000; i++) {
      const yaw = (rnd() - 0.5) * 40
      const q = quantYaw(yaw)
      expect(Number.isInteger(q) && q >= 0 && q <= 255).toBe(true)
      // 오차는 반 단계(π/256) 이하
      expect(angleDiff(dequantYaw(q), yaw)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9)
    }
  })
})

describe('MOVE', () => {
  it('7바이트로 인코딩되고 왕복해도 값이 유지된다', () => {
    const buf = encodeMove(12.34, -5.67, Math.PI / 2, Anim.Run)
    expect(buf.byteLength).toBe(MOVE_BYTES)
    expect(new Uint8Array(buf)[0]).toBe(BIN_MOVE)
    expect(decodeMove(buf)).toEqual({ x: 12.34, z: -5.67, yaw: Math.PI / 2, st: Anim.Run })

    const rnd = mulberry32(3)
    for (let i = 0; i < 500; i++) {
      const x = (rnd() - 0.5) * 96
      const z = (rnd() - 0.5) * 72
      const yaw = rnd() * TWO_PI
      const st = Math.floor(rnd() * 8)
      const m = decodeMove(encodeMove(x, z, yaw, st))
      expect(m).not.toBeNull()
      expect(Math.abs(m!.x - x)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(Math.abs(m!.z - z)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(angleDiff(m!.yaw, yaw)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9)
      expect(m!.st).toBe(st)
    }
  })

  it('한 번 양자화된 값은 다시 인코딩해도 변하지 않는다(서버가 받은 값을 그대로 되돌려줘도 어긋나지 않게)', () => {
    const rnd = mulberry32(4)
    for (let i = 0; i < 500; i++) {
      const first = decodeMove(encodeMove((rnd() - 0.5) * 96, (rnd() - 0.5) * 72, rnd() * 20 - 10, 1))!
      const second = decodeMove(encodeMove(first.x, first.z, first.yaw, first.st))!
      expect(second).toEqual(first)
    }
  })

  it('범위 밖 좌표는 한계값으로 잘리고, 상태는 1바이트로 잘린다', () => {
    expect(decodeMove(encodeMove(5000, -5000, 0, 0))).toMatchObject({ x: 327.67, z: -327.68 })
    expect(decodeMove(encodeMove(0, 0, 0, 256 + 3))?.st).toBe(3)
    // NaN 좌표는 0 으로 떨어진다(예외 없음)
    expect(decodeMove(encodeMove(Number.NaN, Number.NaN, Number.NaN, 0))).toEqual({ x: 0, z: 0, yaw: 0, st: 0 })
  })

  it('길이·종류가 틀린 패킷은 null', () => {
    expect(decodeMove(new ArrayBuffer(0))).toBeNull()
    expect(decodeMove(new ArrayBuffer(MOVE_BYTES - 1))).toBeNull()
    expect(decodeMove(new ArrayBuffer(MOVE_BYTES + 1))).toBeNull()
    expect(decodeMove(new ArrayBuffer(MOVE_BYTES))).toBeNull() // 종류 바이트 0
    const snap = new Uint8Array(MOVE_BYTES)
    snap[0] = BIN_SNAPSHOT
    expect(decodeMove(snap)).toBeNull()
  })

  it('큰 버퍼의 일부를 가리키는 Uint8Array 도 읽는다', () => {
    const big = new Uint8Array(64)
    big.set(new Uint8Array(encodeMove(-7.5, 3.25, 1, Anim.Walk)), 20)
    const m = decodeMove(big.subarray(20, 20 + MOVE_BYTES))
    expect(m).toMatchObject({ x: -7.5, z: 3.25, st: Anim.Walk })
    // 뷰가 아니라 버퍼 전체를 넘기면 길이가 달라 거부된다
    expect(decodeMove(big)).toBeNull()
  })
})

describe('SNAPSHOT', () => {
  const ent = (id: number, x: number, z: number, yaw: number, st: number): SnapEnt => ({ id, x, z, yaw, st })

  it('빈 스냅샷은 헤더 11바이트이고 시각이 정확히 보존된다', () => {
    const time = 1_795_000_123_456.75
    const bytes = encodeSnapshot(time, [], [])
    expect(bytes.byteLength).toBe(11)
    expect(bytes[0]).toBe(BIN_SNAPSHOT)
    expect(decodeSnapshot(bytes)).toEqual({ time, players: [], npcs: [] })
  })

  it('플레이어 8바이트·NPC 7바이트씩 붙고 왕복해도 값이 유지된다', () => {
    const players = [ent(1, 1.5, -2.5, 0, Anim.Idle), ent(65535, -48, 36, Math.PI, Anim.Sprint), ent(300, 0.01, -0.01, 3, Anim.Stun)]
    const npcs = [ent(1, 10, 10, 1, Anim.Walk), ent(255, -46, 8, 5, Anim.Vanish)]
    const bytes = encodeSnapshot(123456789, players, npcs)
    expect(bytes.byteLength).toBe(11 + 3 * 8 + 2 * 7)
    const snap = decodeSnapshot(bytes)
    expect(snap).not.toBeNull()
    expect(snap!.time).toBe(123456789)
    expect(snap!.players.map((e) => e.id)).toEqual([1, 65535, 300])
    expect(snap!.npcs.map((e) => e.id)).toEqual([1, 255])
    expect(snap!.players[1]).toMatchObject({ x: -48, z: 36, st: Anim.Sprint })
    expect(snap!.players[2]).toMatchObject({ x: 0.01, z: -0.01, st: Anim.Stun })
    expect(snap!.npcs[1]).toMatchObject({ x: -46, z: 8, st: Anim.Vanish })
    for (const [got, want] of [...snap!.players.map((e, i) => [e, players[i]!] as const), ...snap!.npcs.map((e, i) => [e, npcs[i]!] as const)]) {
      expect(angleDiff(got.yaw, want.yaw)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9)
    }
    // ArrayBuffer 로 받아도(브라우저 binaryType='arraybuffer') 같은 결과
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    expect(decodeSnapshot(copy as ArrayBuffer)).toEqual(snap)
  })

  it('방 최대 구성(20명 + NPC 28명)의 크기와 내용', () => {
    const rnd = mulberry32(5)
    const players: SnapEnt[] = []
    const npcs: SnapEnt[] = []
    for (let i = 0; i < 20; i++) players.push(ent(i + 1, (rnd() - 0.5) * 96, (rnd() - 0.5) * 72, rnd() * TWO_PI, i % 4))
    for (let i = 0; i < 28; i++) npcs.push(ent(i + 1, (rnd() - 0.5) * 96, (rnd() - 0.5) * 72, rnd() * TWO_PI, i % 8))
    const bytes = encodeSnapshot(42, players, npcs)
    expect(bytes.byteLength).toBe(11 + 20 * 8 + 28 * 7) // 367바이트
    const snap = decodeSnapshot(bytes)!
    expect(snap.players).toHaveLength(20)
    expect(snap.npcs).toHaveLength(28)
    snap.players.forEach((e, i) => {
      expect(e.id).toBe(players[i]!.id)
      expect(Math.abs(e.x - players[i]!.x)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(Math.abs(e.z - players[i]!.z)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(e.st).toBe(players[i]!.st)
    })
    snap.npcs.forEach((e, i) => {
      expect(e.id).toBe(npcs[i]!.id)
      expect(Math.abs(e.x - npcs[i]!.x)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(e.st).toBe(npcs[i]!.st)
    })
  })

  it('한 번에 255개까지만 싣는다', () => {
    const many: SnapEnt[] = []
    for (let i = 0; i < 300; i++) many.push(ent(i + 1, i, -i, 0, 0))
    const snap = decodeSnapshot(encodeSnapshot(1, many, many))!
    expect(snap.players).toHaveLength(255)
    expect(snap.npcs).toHaveLength(255)
    expect(snap.players[254]?.id).toBe(255)
  })

  it('잘리거나 길이가 맞지 않는 패킷은 null', () => {
    const bytes = encodeSnapshot(1, [ent(1, 0, 0, 0, 0)], [ent(2, 0, 0, 0, 0)])
    expect(decodeSnapshot(bytes)).not.toBeNull()
    expect(decodeSnapshot(bytes.subarray(0, bytes.length - 1))).toBeNull()
    expect(decodeSnapshot(bytes.subarray(0, 5))).toBeNull()
    expect(decodeSnapshot(new Uint8Array(0))).toBeNull()
    const longer = new Uint8Array(bytes.length + 1)
    longer.set(bytes)
    expect(decodeSnapshot(longer)).toBeNull()
    const wrongType = bytes.slice()
    wrongType[0] = BIN_MOVE
    expect(decodeSnapshot(wrongType)).toBeNull()
    // 개수 바이트를 부풀린 패킷(선언한 것보다 본문이 짧음)
    const lying = bytes.slice()
    lying[9] = 200
    expect(decodeSnapshot(lying)).toBeNull()
    // MOVE 패킷을 스냅샷으로 읽으려 해도 null
    expect(decodeSnapshot(encodeMove(1, 2, 3, 0))).toBeNull()
  })
})

describe('parseJsonMsg', () => {
  it('t 가 문자열인 객체만 통과시킨다', () => {
    expect(parseJsonMsg('{"t":"ping","c":1}')).toEqual({ t: 'ping', c: 1 })
    expect(parseJsonMsg('{"t":"emote","e":"wave","extra":[1,2]}')).toEqual({ t: 'emote', e: 'wave', extra: [1, 2] })
    for (const bad of ['', '{', 'null', '[]', '[{"t":"x"}]', '42', '"t"', 'true', '{"t":1}', '{"t":null}', '{"x":"y"}', '{"t":["a"]}']) {
      expect(parseJsonMsg(bad), bad).toBeNull()
    }
  })
})
