/**
 * 렌더 엔진: WebGLRenderer/씬/카메라/조명/하늘, 품질 단계, 투영 유틸.
 * 그림자 맵은 쓰지 않는다(가짜 그림자). 저사양 폰에서도 돌도록 픽셀 비율을 단계별로 제한한다.
 */
import * as THREE from 'three'
import type { EngineApi, QualityTier } from '../core/contracts'

export interface SkySpec {
  top: number
  bottom: number
  fog: number
  fogNear: number
  fogFar: number
  sun: { color: number; intensity: number; dir: [number, number, number] }
  hemi: { sky: number; ground: number; intensity: number }
}

export const DEFAULT_SKY: SkySpec = {
  top: 0x8fd0f2,
  bottom: 0xffe2c4,
  fog: 0xffe2c4,
  fogNear: 55,
  fogFar: 150,
  sun: { color: 0xfff1d6, intensity: 2.1, dir: [0.5, 1, 0.35] },
  hemi: { sky: 0xdff1ff, ground: 0xb79a8a, intensity: 1.35 },
}

const PIXEL_RATIO_CAP: Record<QualityTier, number> = { low: 1, mid: 1.5, high: 2 }

export interface Engine extends EngineApi {
  applySky(spec: SkySpec): void
  /** 동적 해상도 배율(0.55~1). 프레임이 무거우면 품질 단계를 내리기 전에 먼저 해상도를 낮춘다 */
  resolutionScale: number
  /** WebGL 컨텍스트가 유실된 상태인가 */
  readonly contextLost: boolean
}

function makeSkyTexture(top: number, bottom: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#' + top.toString(16).padStart(6, '0'))
  grad.addColorStop(0.62, '#' + bottom.toString(16).padStart(6, '0'))
  grad.addColorStop(1, '#' + bottom.toString(16).padStart(6, '0'))
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function createEngine(canvas: HTMLCanvasElement, initialQuality: QualityTier): Engine {
  let quality = initialQuality
  const listeners: ((q: QualityTier) => void)[] = []
  let lost = false
  let resScale = 1

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: quality !== 'low',
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP[quality]))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 320)
  camera.position.set(0, 12, 14)
  camera.lookAt(0, 1, 0)

  const hemi = new THREE.HemisphereLight(DEFAULT_SKY.hemi.sky, DEFAULT_SKY.hemi.ground, DEFAULT_SKY.hemi.intensity)
  const sun = new THREE.DirectionalLight(DEFAULT_SKY.sun.color, DEFAULT_SKY.sun.intensity)
  scene.add(hemi, sun)
  let skyTex: THREE.CanvasTexture | null = null

  function applySky(spec: SkySpec): void {
    skyTex?.dispose()
    skyTex = makeSkyTexture(spec.top, spec.bottom)
    scene.background = skyTex
    scene.fog = new THREE.Fog(spec.fog, spec.fogNear, spec.fogFar)
    // 안개에 완전히 가려지는 거리 너머는 그릴 필요가 없다
    camera.far = spec.fogFar + 12
    camera.updateProjectionMatrix()
    hemi.color.setHex(spec.hemi.sky)
    hemi.groundColor.setHex(spec.hemi.ground)
    hemi.intensity = spec.hemi.intensity
    sun.color.setHex(spec.sun.color)
    sun.intensity = spec.sun.intensity
    sun.position.set(spec.sun.dir[0], spec.sun.dir[1], spec.sun.dir[2]).normalize().multiplyScalar(50)
  }
  applySky(DEFAULT_SKY)

  let cssW = 1
  let cssH = 1
  function resize(): void {
    // iOS 주소창 접힘/분할 화면에서는 window.inner* 와 캔버스 실제 크기가 어긋날 수 있어 캔버스 크기를 기준으로 한다
    cssW = Math.max(1, canvas.clientWidth || window.innerWidth)
    cssH = Math.max(1, canvas.clientHeight || window.innerHeight)
    renderer.setPixelRatio(Math.max(0.5, Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP[quality]) * resScale))
    renderer.setSize(cssW, cssH, false)
    camera.aspect = cssW / cssH
    // 세로 화면에서는 좌우가 너무 좁아지지 않게 세로 화각을 넓힌다
    camera.fov = camera.aspect < 0.8 ? 70 : camera.aspect < 1.2 ? 62 : 55
    camera.updateProjectionMatrix()
  }
  resize()
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => resize()).observe(canvas)

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    lost = true
    console.warn('[engine] WebGL 컨텍스트 유실')
  })
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false
    console.info('[engine] WebGL 컨텍스트 복구')
    resize()
  })

  const v = new THREE.Vector3()
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hit = new THREE.Vector3()

  const engine: Engine = {
    renderer,
    scene,
    camera,
    canvas,
    get quality() {
      return quality
    },
    get contextLost() {
      return lost
    },
    get resolutionScale() {
      return resScale
    },
    set resolutionScale(v: number) {
      const next = Math.min(1, Math.max(0.55, v))
      if (Math.abs(next - resScale) < 0.01) return
      resScale = next
      resize()
    },
    setQuality(q) {
      if (q === quality) return
      quality = q
      resize()
      for (const fn of listeners) {
        try {
          fn(q)
        } catch (err) {
          console.error('[engine] quality listener error', err)
        }
      }
    },
    onQuality(fn) {
      listeners.push(fn)
    },
    project(x, y, z, out) {
      v.set(x, y, z).project(camera)
      if (v.z > 1 || v.z < -1) return false
      if (v.x < -1.15 || v.x > 1.15 || v.y < -1.2 || v.y > 1.2) return false
      out.x = (v.x * 0.5 + 0.5) * cssW
      out.y = (-v.y * 0.5 + 0.5) * cssH
      return true
    },
    pickGround(clientX, clientY) {
      ndc.set((clientX / cssW) * 2 - 1, -(clientY / cssH) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      if (!raycaster.ray.intersectPlane(ground, hit)) return null
      return { x: hit.x, z: hit.z }
    },
    resize,
    render() {
      if (lost) return
      renderer.render(scene, camera)
    },
    applySky,
  }
  return engine
}

/** 기기 사양으로 초기 품질 단계를 추정한다 */
export function guessQuality(): QualityTier {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency || 4
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
  const ua = navigator.userAgent || ''
  // 아이폰/아이패드는 코어 수를 항상 4로 알려 주므로 코어 수로 저사양을 판단하면 전 기종이 뿌옇게 나온다
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
  if (apple) return 'mid'
  if (coarse) return cores <= 4 || mem <= 3 ? 'low' : 'mid'
  return cores <= 2 ? 'mid' : 'high'
}
