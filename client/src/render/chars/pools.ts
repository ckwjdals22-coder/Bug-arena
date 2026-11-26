/**
 * 부위 풀: 한 종류의 부위(머리, 몸통, 팔 …)를 모든 캐릭터가 함께 쓰는 InstancedMesh.
 * 인스턴스마다 [행렬, 주색(instanceColor), 보조색 + 변형 번호(iB)] 를 매 프레임 채운다.
 *
 * 변형을 다루는 방식은 두 가지다.
 *  - PartPool: 드로콜 1개. 지오메트리 전체를 그리되 셰이더가 고른 변형만 남긴다.
 *    변형이 작고 거의 모든 캐릭터가 쓰는 부위(머리카락, 팔, 다리, 얼굴)에 쓴다.
 *  - SplitPool: 변형마다 드로콜 1개(쓰이는 변형만). 버려지는 정점이 없다.
 *    변형이 크고 가짓수가 많은 부위(몸통, 모자)에 쓴다.
 */
import * as THREE from 'three'
import { variantRanges } from './geo'
import type { IndexRange, RGB } from './geo'

/** 초상 렌더처럼 선형 렌더 타깃에 그릴 때 셰이더에서 직접 sRGB 로 바꾸기 위한 공용 유니폼 */
export const sharedUniforms = {
  uSrgbOut: { value: 0 },
}

/**
 * Lambert 재질에 두 가지를 덧붙인다.
 *  1) 정점 마스크에 따라 고정색 / 주색 / 보조색을 고른다.
 *  2) 인스턴스가 고른 변형이 아닌 정점은 원점으로 접어 그리지 않는다.
 * 버전이 고정(three 0.187)이라 청크 이름이 바뀔 걱정은 없지만, 치환이 실패하면 바로 알 수 있게 검사한다.
 */
export function makePartMaterial(translucent: boolean): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
  if (translucent) {
    mat.transparent = true
    // 초상(투명 배경)에서도 알파가 올바르게 쌓이도록 알파 채널은 따로 섞는다
    mat.blending = THREE.CustomBlending
    mat.blendSrc = THREE.SrcAlphaFactor
    mat.blendDst = THREE.OneMinusSrcAlphaFactor
    mat.blendSrcAlpha = THREE.OneFactor
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
    mat.depthWrite = true
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSrgbOut = sharedUniforms.uSrgbOut
    const must = (src: string, from: string, to: string): string => {
      if (!src.includes(from)) throw new Error(`캐릭터 셰이더 패치 실패: ${from}`)
      return src.replace(from, to)
    }
    let vs = shader.vertexShader
    vs = must(vs, '#include <common>', 'attribute vec2 aSel;\nattribute vec4 iB;\n#include <common>')
    vs = must(
      vs,
      '#include <color_vertex>',
      [
        'vec3 partTint = aSel.x < 0.5 ? vec3( 1.0 ) : ( aSel.x < 1.5 ? instanceColor.rgb : iB.rgb );',
        'vColor = vec4( color.rgb * partTint, color.a );',
      ].join('\n'),
    )
    vs = must(
      vs,
      '#include <begin_vertex>',
      ['#include <begin_vertex>', 'if ( aSel.y > -0.5 && abs( aSel.y - iB.w ) > 0.5 ) transformed = vec3( 0.0 );'].join('\n'),
    )
    shader.vertexShader = vs
    let fs = shader.fragmentShader
    fs = must(fs, '#include <common>', 'uniform float uSrgbOut;\n#include <common>')
    fs = must(
      fs,
      '#include <colorspace_fragment>',
      ['#include <colorspace_fragment>', 'if ( uSrgbOut > 0.5 ) gl_FragColor = sRGBTransferOETF( gl_FragColor );'].join('\n'),
    )
    shader.fragmentShader = fs
  }
  // 같은 Lambert 라도 패치된 프로그램은 따로 캐시되어야 한다
  mat.customProgramCacheKey = () => 'dao-char-part-v1'
  return mat
}

export interface Pool {
  begin(): void
  /** 인스턴스 하나 추가. a = 주색, b = 보조색(없으면 흰색), tint = 캐릭터 전체에 곱해지는 색(얼어붙음 등) */
  add(m: THREE.Matrix4, a: RGB | null, b: RGB | null, variant: number, tint?: RGB): void
  end(): void
  setGeometry(geo: THREE.BufferGeometry): void
  dispose(): void
  /** 이번 프레임에 채워진 인스턴스 수 */
  readonly count: number
}

const _white: RGB = [1, 1, 1]
const SHARED_ATTRS = ['position', 'normal', 'color', 'aSel']

/**
 * 얕은 복제 지오메트리를 정리한다. 공유 정점 버퍼까지 GPU 에서 지워지면 같은 버퍼를 쓰는
 * 다른 풀의 VAO 가 죽은 버퍼를 가리키게 되므로, 공유 속성을 먼저 떼어 낸 뒤 dispose 한다.
 */
function disposeClone(mesh: THREE.InstancedMesh): void {
  const g = mesh.geometry
  for (const name of SHARED_ATTRS) g.deleteAttribute(name)
  g.setIndex(null)
  g.dispose()
  mesh.dispose()
}

interface Buffers {
  mesh: THREE.InstancedMesh
  mat4: Float32Array
  colA: Float32Array
  colB: Float32Array
  attrB: THREE.InstancedBufferAttribute
}

export class PartPool implements Pool {
  mesh: THREE.InstancedMesh
  private n = 0
  private cap: number
  private mat4: Float32Array
  private colA: Float32Array
  private colB: Float32Array
  private attrB: THREE.InstancedBufferAttribute
  private baseGeo: THREE.BufferGeometry
  private range: IndexRange | null
  private readonly parent: THREE.Object3D
  private readonly material: THREE.Material
  private readonly order: number

  /**
   * @param geo 변형이 구워진 공유 지오메트리. 풀마다 iB 속성이 따로 필요해서 얕게 복제해 쓴다(정점 버퍼는 공유)
   * @param range 지오메트리의 이 인덱스 범위만 그린다(SplitPool 용)
   */
  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material, capacity: number, renderOrder = 0, range: IndexRange | null = null) {
    this.parent = parent
    this.baseGeo = geo
    this.material = material
    this.order = renderOrder
    this.range = range
    this.cap = capacity
    const made = this.make(capacity)
    this.mesh = made.mesh
    this.mat4 = made.mat4
    this.colA = made.colA
    this.colB = made.colB
    this.attrB = made.attrB
  }

  get count(): number {
    return this.n
  }

  private link(g: THREE.BufferGeometry): void {
    for (const name of SHARED_ATTRS) g.setAttribute(name, this.baseGeo.getAttribute(name))
    g.setIndex(this.baseGeo.index)
    g.boundingSphere = this.baseGeo.boundingSphere
    if (this.range) g.setDrawRange(this.range.start, this.range.count)
    else g.setDrawRange(0, Infinity)
  }

  private make(capacity: number): Buffers {
    const g = new THREE.BufferGeometry()
    this.link(g)
    const attrB = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    attrB.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('iB', attrB)
    const mesh = new THREE.InstancedMesh(g, this.material, capacity)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    colorAttr.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = colorAttr
    // 컬링은 캐릭터 단위로 직접 한다. 풀 전체의 경계는 의미가 없다
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.renderOrder = this.order
    mesh.count = 0
    mesh.visible = false
    this.parent.add(mesh)
    return { mesh, mat4: mesh.instanceMatrix.array as Float32Array, colA: colorAttr.array as Float32Array, colB: attrB.array as Float32Array, attrB }
  }

  /** 가득 차면 두 배로 늘린다(80명 기준으로 잡았지만 그보다 많이 와도 깨지지 않게) */
  private grow(): void {
    const old = { mesh: this.mesh, mat4: this.mat4, colA: this.colA, colB: this.colB }
    this.cap *= 2
    const made = this.make(this.cap)
    made.mat4.set(old.mat4)
    made.colA.set(old.colA)
    made.colB.set(old.colB)
    this.parent.remove(old.mesh)
    disposeClone(old.mesh)
    this.mesh = made.mesh
    this.mat4 = made.mat4
    this.colA = made.colA
    this.colB = made.colB
    this.attrB = made.attrB
  }

  setGeometry(geo: THREE.BufferGeometry, range: IndexRange | null = null): void {
    this.baseGeo = geo
    this.range = range
    this.link(this.mesh.geometry)
  }

  begin(): void {
    this.n = 0
  }

  add(m: THREE.Matrix4, a: RGB | null, b: RGB | null, variant: number, tint: RGB = _white): void {
    if (this.n >= this.cap) this.grow()
    const i = this.n++
    this.mat4.set(m.elements, i * 16)
    const ca = a ?? _white
    const cb = b ?? _white
    let o = i * 3
    this.colA[o] = ca[0] * tint[0]
    this.colA[o + 1] = ca[1] * tint[1]
    this.colA[o + 2] = ca[2] * tint[2]
    o = i * 4
    this.colB[o] = cb[0] * tint[0]
    this.colB[o + 1] = cb[1] * tint[1]
    this.colB[o + 2] = cb[2] * tint[2]
    this.colB[o + 3] = variant
  }

  end(): void {
    const mesh = this.mesh
    const n = this.n
    mesh.count = n
    mesh.visible = n > 0
    if (n === 0) return
    // 쓴 만큼만 GPU 로 올린다
    const im = mesh.instanceMatrix
    im.clearUpdateRanges()
    im.addUpdateRange(0, n * 16)
    im.needsUpdate = true
    const ic = mesh.instanceColor
    if (ic) {
      ic.clearUpdateRanges()
      ic.addUpdateRange(0, n * 3)
      ic.needsUpdate = true
    }
    this.attrB.clearUpdateRanges()
    this.attrB.addUpdateRange(0, n * 4)
    this.attrB.needsUpdate = true
  }

  dispose(): void {
    this.parent.remove(this.mesh)
    disposeClone(this.mesh)
  }
}

/** 변형마다 따로 그리는 풀. 정점 버퍼는 하나를 공유하고 드로 범위만 다르다 */
export class SplitPool implements Pool {
  private readonly pools = new Map<number, PartPool>()
  private readonly list: PartPool[] = []
  private readonly parent: THREE.Object3D
  private readonly material: THREE.Material
  private readonly order: number

  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material, capacity: number, renderOrder = 0) {
    this.parent = parent
    this.material = material
    this.order = renderOrder
    for (const [variant, range] of variantRanges(geo)) {
      const p = new PartPool(parent, geo, material, capacity, renderOrder, range)
      this.pools.set(variant, p)
      this.list.push(p)
    }
  }

  get count(): number {
    let n = 0
    for (const p of this.list) n += p.count
    return n
  }

  begin(): void {
    for (const p of this.list) p.begin()
  }

  add(m: THREE.Matrix4, a: RGB | null, b: RGB | null, variant: number, tint?: RGB): void {
    this.pools.get(variant)?.add(m, a, b, variant, tint)
  }

  end(): void {
    for (const p of this.list) p.end()
  }

  setGeometry(geo: THREE.BufferGeometry): void {
    for (const [variant, range] of variantRanges(geo)) {
      const p = this.pools.get(variant)
      if (p) {
        p.setGeometry(geo, range)
      } else {
        const np = new PartPool(this.parent, geo, this.material, 8, this.order, range)
        this.pools.set(variant, np)
        this.list.push(np)
      }
    }
  }

  dispose(): void {
    for (const p of this.list) p.dispose()
    this.list.length = 0
    this.pools.clear()
  }
}
