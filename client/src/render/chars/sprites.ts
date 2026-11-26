/**
 * 스프라이트 배치: 작은 그림(그림자, 발밑 고리, 오라, 파티클 …)을 인스턴스 사각형 한 번의 드로콜로 그린다.
 * 그림은 코드로 그린 캔버스 아틀라스 한 장에 모여 있다(에셋 파일 없음).
 * 캐릭터 렌더러와 이펙트(fx.ts)가 각자 하나씩 만들어 쓴다.
 */
import * as THREE from 'three'
import { sharedUniforms } from './pools'

/** 아틀라스 칸 번호 */
export const CELL = {
  Glow: 0,
  Ring: 1,
  Spark: 2,
  Star: 3,
  Heart: 4,
  Drop: 5,
  Puff: 6,
  Coin: 7,
  Rect: 8,
  Bang: 9,
  Arrow: 10,
  Halo: 11,
  Rainbow: 12,
  Beam: 13,
  Ray: 14,
  Planet: 15,
} as const

/** 사각형이 놓이는 방식 */
export const MODE = {
  /** 항상 카메라를 본다 */
  Billboard: 0,
  /** 바닥에 눕는다 */
  Ground: 1,
  /** 세로축은 고정하고 좌우로만 카메라를 본다(빛기둥) */
  Upright: 2,
} as const

const CELLS = 4
const CELL_PX = 128
const PAD = 10

let atlasCanvas: HTMLCanvasElement | null = null

function star(ctx: CanvasRenderingContext2D, points: number, rOuter: number, rInner: number, rot = -Math.PI / 2): void {
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = rot + (i * Math.PI) / points
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function drawAtlas(): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = CELLS * CELL_PX
  const ctx = cv.getContext('2d')
  if (!ctx) return cv
  const R = CELL_PX / 2 - PAD
  /** 칸 중심을 원점, 반지름 1 = 칸 안쪽 가장자리, y 는 화면 아래 방향 */
  const cell = (i: number, draw: () => void): void => {
    ctx.save()
    ctx.beginPath()
    ctx.rect((i % CELLS) * CELL_PX, Math.floor(i / CELLS) * CELL_PX, CELL_PX, CELL_PX)
    ctx.clip()
    ctx.translate((i % CELLS) * CELL_PX + CELL_PX / 2, Math.floor(i / CELLS) * CELL_PX + CELL_PX / 2)
    ctx.scale(R, R)
    draw()
    ctx.restore()
  }
  const radial = (stops: [number, string][], r = 1): CanvasGradient => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
    for (const [o, c] of stops) g.addColorStop(o, c)
    return g
  }

  cell(CELL.Glow, () => {
    ctx.fillStyle = radial([
      [0, 'rgba(255,255,255,1)'],
      [0.3, 'rgba(255,255,255,0.72)'],
      [0.65, 'rgba(255,255,255,0.22)'],
      [1, 'rgba(255,255,255,0)'],
    ])
    ctx.fillRect(-1, -1, 2, 2)
  })

  cell(CELL.Ring, () => {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 0.3
    ctx.beginPath()
    ctx.arc(0, 0, 0.8, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 0.17
    ctx.beginPath()
    ctx.arc(0, 0, 0.8, 0, Math.PI * 2)
    ctx.stroke()
  })

  cell(CELL.Spark, () => {
    ctx.fillStyle = radial([
      [0, 'rgba(255,255,255,0.9)'],
      [0.5, 'rgba(255,255,255,0.12)'],
      [1, 'rgba(255,255,255,0)'],
    ], 0.7)
    ctx.fillRect(-1, -1, 2, 2)
    ctx.fillStyle = '#fff'
    star(ctx, 4, 1, 0.16)
    ctx.fill()
  })

  cell(CELL.Star, () => {
    const g = ctx.createLinearGradient(0, -1, 0, 1)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(1, '#d9d9d9')
    ctx.fillStyle = g
    ctx.lineJoin = 'round'
    star(ctx, 5, 0.9, 0.42)
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 0.14
    ctx.stroke()
  })

  cell(CELL.Heart, () => {
    const g = ctx.createLinearGradient(0, -0.8, 0, 0.9)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(1, '#cfcfcf')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(0, 0.88)
    ctx.bezierCurveTo(-1.25, 0.05, -0.85, -0.95, 0, -0.38)
    ctx.bezierCurveTo(0.85, -0.95, 1.25, 0.05, 0, 0.88)
    ctx.closePath()
    ctx.fill()
    // 반짝 하이라이트(색이 곱해져도 밝게 남는다)
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.beginPath()
    ctx.ellipse(-0.42, -0.32, 0.17, 0.11, -0.6, 0, Math.PI * 2)
    ctx.fill()
  })

  cell(CELL.Drop, () => {
    const g = ctx.createLinearGradient(0, -1, 0, 1)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(1, '#c4c4c4')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(0, -0.95)
    ctx.bezierCurveTo(0.2, -0.4, 0.62, 0.0, 0.62, 0.38)
    ctx.arc(0, 0.38, 0.62, 0, Math.PI)
    ctx.bezierCurveTo(-0.62, 0.0, -0.2, -0.4, 0, -0.95)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.beginPath()
    ctx.ellipse(-0.22, 0.3, 0.12, 0.2, 0.3, 0, Math.PI * 2)
    ctx.fill()
  })

  cell(CELL.Puff, () => {
    const blob = (x: number, y: number, r: number): void => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(255,255,255,0.95)')
      g.addColorStop(0.6, 'rgba(255,255,255,0.8)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    blob(-0.34, 0.14, 0.56)
    blob(0.36, 0.2, 0.52)
    blob(0.04, -0.28, 0.6)
    blob(0.02, 0.3, 0.5)
  })

  cell(CELL.Coin, () => {
    // 가운데 네모 구멍이 뚫린 옛날 엽전 — 한눈에 "가짜 돈"으로 읽힌다
    ctx.fillStyle = '#b8860b'
    ctx.beginPath()
    ctx.arc(0, 0, 0.92, 0, Math.PI * 2)
    ctx.fill()
    const g = ctx.createLinearGradient(-0.6, -0.8, 0.6, 0.8)
    g.addColorStop(0, '#ffe98a')
    g.addColorStop(0.5, '#f7c531')
    g.addColorStop(1, '#e0a312')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, 0.78, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#b8860b'
    ctx.fillRect(-0.3, -0.3, 0.6, 0.6)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillRect(-0.2, -0.2, 0.4, 0.4)
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 0.09
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(0, 0, 0.58, Math.PI * 1.08, Math.PI * 1.42)
    ctx.stroke()
  })

  cell(CELL.Rect, () => {
    ctx.fillStyle = '#fff'
    ctx.fillRect(-0.92, -0.92, 1.84, 1.84)
  })

  cell(CELL.Bang, () => {
    const body = (): void => {
      ctx.beginPath()
      ctx.moveTo(-0.3, -0.92)
      ctx.lineTo(0.3, -0.92)
      ctx.lineTo(0.17, 0.3)
      ctx.lineTo(-0.17, 0.3)
      ctx.closePath()
    }
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 0.3
    body()
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0.68, 0.2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ff3b30'
    body()
    ctx.fill()
    ctx.beginPath()
    ctx.arc(0, 0.68, 0.2, 0, Math.PI * 2)
    ctx.fill()
  })

  cell(CELL.Arrow, () => {
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(-0.34, -0.85)
    ctx.lineTo(0.34, -0.85)
    ctx.lineTo(0.34, -0.05)
    ctx.lineTo(0.8, -0.05)
    ctx.lineTo(0, 0.85)
    ctx.lineTo(-0.8, -0.05)
    ctx.lineTo(-0.34, -0.05)
    ctx.closePath()
    ctx.strokeStyle = '#3a2f4a'
    ctx.lineWidth = 0.26
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fill()
  })

  cell(CELL.Halo, () => {
    ctx.fillStyle = radial([
      [0, 'rgba(255,255,255,0.3)'],
      [0.5, 'rgba(255,255,255,0.3)'],
      [0.66, 'rgba(255,255,255,0.55)'],
      [0.76, 'rgba(255,255,255,1)'],
      [0.86, 'rgba(255,255,255,0.5)'],
      [1, 'rgba(255,255,255,0)'],
    ])
    ctx.fillRect(-1, -1, 2, 2)
  })

  cell(CELL.Rainbow, () => {
    const bands = ['#b06bff', '#5b8cff', '#39d39b', '#ffe45c', '#ff9d3c', '#ff5b6e']
    const r0 = 0.5
    const w = 0.075
    bands.forEach((c, i) => {
      ctx.strokeStyle = c
      ctx.lineWidth = w + 0.012
      ctx.beginPath()
      ctx.arc(0, 0, r0 + w * (i + 0.5), 0, Math.PI * 2)
      ctx.stroke()
    })
    // 안팎 가장자리를 부드럽게 지운다
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = radial([
      [0, 'rgba(0,0,0,0)'],
      [0.46, 'rgba(0,0,0,0)'],
      [0.58, 'rgba(0,0,0,1)'],
      [0.88, 'rgba(0,0,0,1)'],
      [0.98, 'rgba(0,0,0,0)'],
      [1, 'rgba(0,0,0,0)'],
    ])
    ctx.fillRect(-1, -1, 2, 2)
    ctx.globalCompositeOperation = 'source-over'
  })

  cell(CELL.Beam, () => {
    // 가로로는 가운데가 밝고, 세로로는 위로 갈수록 옅어지는 빛기둥
    const g = ctx.createLinearGradient(-1, 0, 1, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.3, 'rgba(255,255,255,0.45)')
    g.addColorStop(0.5, 'rgba(255,255,255,1)')
    g.addColorStop(0.7, 'rgba(255,255,255,0.45)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(-1, -1, 2, 2)
    ctx.globalCompositeOperation = 'destination-in'
    const v = ctx.createLinearGradient(0, -1, 0, 1)
    v.addColorStop(0, 'rgba(0,0,0,0)')
    v.addColorStop(0.55, 'rgba(0,0,0,0.75)')
    v.addColorStop(0.93, 'rgba(0,0,0,1)')
    v.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = v
    ctx.fillRect(-1, -1, 2, 2)
    ctx.globalCompositeOperation = 'source-over'
  })

  cell(CELL.Ray, () => {
    const g = ctx.createLinearGradient(0, 1, 0, -1)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(-0.05, 1)
    ctx.lineTo(0.05, 1)
    ctx.lineTo(0.4, -1)
    ctx.lineTo(-0.4, -1)
    ctx.closePath()
    ctx.fill()
  })

  cell(CELL.Planet, () => {
    ctx.save()
    ctx.rotate(-0.4)
    ctx.strokeStyle = '#ffe9a8'
    ctx.lineWidth = 0.1
    ctx.beginPath()
    ctx.ellipse(0, 0, 0.92, 0.3, 0, Math.PI, Math.PI * 2)
    ctx.stroke()
    const g = ctx.createLinearGradient(-0.4, -0.5, 0.4, 0.5)
    g.addColorStop(0, '#ffc46b')
    g.addColorStop(1, '#e8743b')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, 0.52, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffe9a8'
    ctx.beginPath()
    ctx.ellipse(0, 0, 0.92, 0.3, 0, 0, Math.PI)
    ctx.stroke()
    ctx.restore()
  })

  return cv
}

/** 아틀라스 텍스처를 새로 만든다(캔버스는 한 번만 그려 재사용). 받은 쪽이 dispose 한다 */
export function makeAtlasTexture(): THREE.CanvasTexture {
  if (!atlasCanvas) atlasCanvas = drawAtlas()
  const tex = new THREE.CanvasTexture(atlasCanvas)
  // 미리 곱한 알파로 올려야 가장자리에 검은 테가 생기지 않는다. 색 변환은 셰이더에서 직접 한다
  tex.premultiplyAlpha = true
  tex.colorSpace = THREE.NoColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec4 iCol;
attribute vec4 iMisc;
uniform float uCells;
varying vec2 vUv;
varying vec4 vCol;
varying float vAdd;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec2 q = position.xy * iSize;
  float s = sin( iMisc.x );
  float c = cos( iMisc.x );
  q = vec2( q.x * c - q.y * s, q.x * s + q.y * c );
  vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 up = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vec3 wp;
  if ( iMisc.y < 0.5 ) {
    wp = iPos + right * q.x + up * q.y;
  } else if ( iMisc.y < 1.5 ) {
    wp = iPos + vec3( q.x, 0.0, - q.y );
  } else {
    vec3 rightXZ = normalize( vec3( right.x, 0.0, right.z ) + vec3( 0.00001, 0.0, 0.0 ) );
    wp = iPos + rightXZ * q.x + vec3( 0.0, q.y, 0.0 );
  }
  vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  float cx = mod( iMisc.w, uCells );
  float cy = floor( iMisc.w / uCells + 0.001 );
  vUv = vec2( ( cx + uv.x ) / uCells, 1.0 - ( cy + 1.0 - uv.y ) / uCells );
  vCol = iCol;
  vAdd = iMisc.z;
  #include <fog_vertex>
}
`

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uAddScale;
uniform float uSrgbOut;
varying vec2 vUv;
varying vec4 vCol;
varying float vAdd;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D( map, vUv );
  float a = t.a * vCol.a;
  if ( a < 0.003 ) discard;
  // 텍스처는 미리 곱한 알파 + sRGB 값 그대로다. 풀어서 선형으로 바꾼 뒤 인스턴스 색을 곱한다
  vec3 col = pow( t.rgb / max( t.a, 0.0001 ), vec3( 2.2 ) ) * vCol.rgb;
  gl_FragColor = vec4( col, a );
  #include <colorspace_fragment>
  if ( uSrgbOut > 0.5 ) gl_FragColor = sRGBTransferOETF( gl_FragColor );
  float add = vAdd * uAddScale;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    // 보통 스프라이트는 안개색으로 물들고, 빛(가산)은 그냥 옅어진다
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * ( 1.0 - add ) );
    gl_FragColor.a *= 1.0 - fogFactor * add;
  #endif
  // 미리 곱한 알파로 내보내면 한 드로콜 안에서 보통 섞기와 가산 섞기를 함께 쓸 수 있다
  gl_FragColor.rgb *= gl_FragColor.a;
  gl_FragColor.a *= 1.0 - add;
}
`

export interface SpriteBatchOpts {
  /** 초상용: 가산 섞기를 끄고(투명 배경에서도 보이게) 보통 섞기로만 그린다 */
  noAdditive?: boolean
  renderOrder?: number
}

export class SpriteBatch {
  readonly mesh: THREE.Mesh
  /** 채워진 개수 */
  n = 0
  private cap: number
  private geo: THREE.InstancedBufferGeometry
  private readonly mat: THREE.ShaderMaterial
  private readonly tex: THREE.CanvasTexture
  private aPos!: THREE.InstancedBufferAttribute
  private aSize!: THREE.InstancedBufferAttribute
  private aCol!: THREE.InstancedBufferAttribute
  private aMisc!: THREE.InstancedBufferAttribute
  private pos!: Float32Array
  private size!: Float32Array
  private col!: Float32Array
  private misc!: Float32Array
  private readonly parent: THREE.Object3D
  /** false 면 가득 찼을 때 늘리지 않고 버린다(파티클처럼 상한이 곧 규칙인 경우) */
  growable = true

  constructor(parent: THREE.Object3D, capacity: number, opts: SpriteBatchOpts = {}) {
    this.parent = parent
    this.cap = capacity
    this.tex = makeAtlasTexture()
    this.geo = this.alloc(capacity)
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        map: { value: this.tex },
        uCells: { value: CELLS },
        uAddScale: { value: opts.noAdditive ? 0 : 1 },
        uSrgbOut: sharedUniforms.uSrgbOut,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    })
    this.mesh = new THREE.Mesh(this.geo, this.mat)
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.renderOrder = opts.renderOrder ?? 0
    this.mesh.visible = false
    parent.add(this.mesh)
  }

  /**
   * 인스턴스 버퍼를 capacity 크기로 (다시) 만든다. 지오메트리째 새로 만드는 이유:
   * three 가 인스턴스 최대 개수를 지오메트리에 한 번만 기록해서, 속성만 바꾸면 예전 상한에 묶인다.
   */
  private alloc(capacity: number): THREE.InstancedBufferGeometry {
    const plane = new THREE.PlaneGeometry(1, 1)
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', plane.getAttribute('position'))
    geo.setAttribute('uv', plane.getAttribute('uv'))
    geo.setIndex(plane.index)
    const mk = (size: number, old?: Float32Array): [THREE.InstancedBufferAttribute, Float32Array] => {
      const arr = new Float32Array(capacity * size)
      if (old) arr.set(old)
      const attr = new THREE.InstancedBufferAttribute(arr, size)
      attr.setUsage(THREE.DynamicDrawUsage)
      return [attr, arr]
    }
    ;[this.aPos, this.pos] = mk(3, this.pos)
    ;[this.aSize, this.size] = mk(2, this.size)
    ;[this.aCol, this.col] = mk(4, this.col)
    ;[this.aMisc, this.misc] = mk(4, this.misc)
    geo.setAttribute('iPos', this.aPos)
    geo.setAttribute('iSize', this.aSize)
    geo.setAttribute('iCol', this.aCol)
    geo.setAttribute('iMisc', this.aMisc)
    return geo
  }

  private grow(): void {
    this.cap *= 2
    const old = this.geo
    this.geo = this.alloc(this.cap)
    this.mesh.geometry = this.geo
    old.dispose()
  }

  get capacity(): number {
    return this.cap
  }

  begin(): void {
    this.n = 0
  }

  /**
   * 스프라이트 하나. 색은 선형 RGB, add 는 0(보통)~1(빛처럼 더하기), cell 은 CELL 번호.
   * rot 은 화면(또는 바닥) 평면 안에서의 회전(라디안).
   */
  push(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    rot: number,
    mode: number,
    add: number,
    r: number,
    g: number,
    b: number,
    a: number,
    cell: number,
  ): void {
    if (this.n >= this.cap) {
      if (!this.growable) return
      this.grow()
    }
    const i = this.n++
    let o = i * 3
    this.pos[o] = x
    this.pos[o + 1] = y
    this.pos[o + 2] = z
    o = i * 2
    this.size[o] = w
    this.size[o + 1] = h
    o = i * 4
    this.col[o] = r
    this.col[o + 1] = g
    this.col[o + 2] = b
    this.col[o + 3] = a
    this.misc[o] = rot
    this.misc[o + 1] = mode
    this.misc[o + 2] = add
    this.misc[o + 3] = cell
  }

  end(): void {
    const n = this.n
    this.geo.instanceCount = n
    this.mesh.visible = n > 0
    if (n === 0) return
    const up = (attr: THREE.InstancedBufferAttribute, size: number): void => {
      attr.clearUpdateRanges()
      attr.addUpdateRange(0, n * size)
      attr.needsUpdate = true
    }
    up(this.aPos, 3)
    up(this.aSize, 2)
    up(this.aCol, 4)
    up(this.aMisc, 4)
  }

  dispose(): void {
    this.parent.remove(this.mesh)
    this.geo.dispose()
    this.mat.dispose()
    this.tex.dispose()
  }
}
