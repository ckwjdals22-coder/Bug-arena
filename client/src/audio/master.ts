/**
 * 마스터 체인: (효과음 버스 + 배경음 버스) → 컴프레서 → 보정 게인 → 소프트 클리퍼 → 출력.
 *
 * 소리 하나는 최대 −10 dBFS 로 맞춰져 있어 컴프레서 문턱 아래를 그대로 지나가고(음색 변화 없음),
 * 여러 소리가 겹쳐 커질 때만 컴프레서가 눌러 준다. 마지막 소프트 클리퍼는 컴프레서의
 * 어택 구간에 새어 나오는 순간 피크까지 막는 안전망이다 → 어떤 경우에도 출력이 ±1 을 넘지 않는다.
 *
 * 실시간 컨텍스트와 오프라인 렌더가 같은 체인을 쓰므로, 개발 페이지의 측정값이 곧 실제 출력이다.
 */

export interface Master {
  /** 효과음이 들어가는 버스 */
  readonly sfx: GainNode
  /** 배경음이 들어가는 버스 */
  readonly music: GainNode
}

const COMP_THRESHOLD_DB = -10
const COMP_KNEE_DB = 6
const COMP_RATIO = 12
/**
 * DynamicsCompressorNode 는 설정값에 따라 정해지는 메이크업 게인을 스스로 곱한다(표준에 정의된 공식).
 * 위 설정에서 문턱 아래 신호가 받는 배율을 오프라인 렌더로 잰 값(1.6468)이며, 이를 되돌려 단위 이득으로 맞춘다.
 */
const COMP_MAKEUP = 1.6468

/** 이 값까지는 완전히 선형(왜곡 없음), 그 위로만 부드럽게 눌린다 */
const CLIP_KNEE = 0.5
/** 눌리는 구간의 폭: 입력이 아무리 커도 출력은 CLIP_KNEE + CLIP_SPAN 미만 */
const CLIP_SPAN = 0.35
const CURVE_POINTS = 1025

let curve: Float32Array<ArrayBuffer> | null = null

function softClipCurve(): Float32Array<ArrayBuffer> {
  if (curve) return curve
  const c = new Float32Array(CURVE_POINTS)
  const half = (CURVE_POINTS - 1) / 2
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (i - half) / half
    const ax = Math.abs(x)
    // 1025 점이면 ±0.5 가 정확히 표본점에 놓여, 선형 구간은 보간 오차 없이 원음 그대로다
    const y = ax <= CLIP_KNEE ? ax : CLIP_KNEE + CLIP_SPAN * Math.tanh((ax - CLIP_KNEE) / CLIP_SPAN)
    c[i] = x < 0 ? -y : y
  }
  curve = c
  return c
}

export function createMaster(ctx: BaseAudioContext): Master {
  const clip = ctx.createWaveShaper()
  clip.curve = softClipCurve()
  clip.connect(ctx.destination)

  const trim = ctx.createGain()
  trim.gain.value = 1 / COMP_MAKEUP
  trim.connect(clip)

  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = COMP_THRESHOLD_DB
  comp.knee.value = COMP_KNEE_DB
  comp.ratio.value = COMP_RATIO
  comp.attack.value = 0.003
  comp.release.value = 0.12
  comp.connect(trim)

  const sfx = ctx.createGain()
  sfx.connect(comp)
  const music = ctx.createGain()
  music.connect(comp)
  return { sfx, music }
}
