# 04. Three.js 모바일 성능 · 최신 API 정리 (r187 / WebGLRenderer 기준)

- 조사일: 2026-11-26
- 대상: "도를 아십니까? — 교주 시뮬레이터" 클라이언트 (Three.js + TypeScript + Vite, 전부 절차 생성 그래픽, PC + 모바일)
- 목적: **지금 설치된 버전(three 0.187.0)에서 그대로 복붙해 쓸 수 있는** API 노트와, 모바일에서 드로콜·픽셀 수를 낮게 유지하는 구체 방법, 품질 티어 설계, 헤드리스 스크린샷 테스트 가능 여부 확인
- 이 문서의 코드 조각은 전부 우리 게임용으로 새로 쓴 것이고, **§5~§13의 TypeScript는 한 파일로 모아 `tsc 7.0.2 --strict` + `@types/three@0.187.0` 타입체크를 통과시키고, Vite 8.3.8로 번들해 헤드리스 Chromium 158에서 실제로 렌더링까지 확인**했다(스크린샷 육안 확인 포함).

## 근거 등급 표기

| 표기 | 의미 |
|---|---|
| **[npm]** | 2026-11-26에 `npm view …`로 직접 조회 |
| **[소스]** | 저장소 `node_modules/three`(0.187.0) 소스를 직접 읽어 확인 |
| **[실측]** | 직접 코드를 돌려 확인. 브라우저 실험은 Playwright 1.63.0 + Chromium 158.0.8127.36 헤드리스(SwiftShader), 번들 실험은 저장소의 Vite 8.3.8 |
| **[문서]** | three.js 공식 매뉴얼/위키 마이그레이션 가이드/릴리스 노트, Chromium·MDN·Apple·WebKit 공식 문서나 소스 |
| **[웹]** | 포럼·블로그·버그 리포트. 정황 증거 |
| **[추정]** | 위 근거에서 내가 추론한 것. 실기기 검증 필요 |
| **확인 못함** | 찾았지만 검증하지 못한 것 |

주의: 내 브라우저 실험은 전부 **CPU 소프트웨어 렌더러(SwiftShader)** 에서 돌았다. "된다/안 된다", 드로콜 수, 픽셀 색, 경고 메시지는 믿어도 되지만 **프레임 시간은 실제 폰과 무관**하다. 실기기(특히 구형 안드로이드, 아이폰 저전력 모드) 측정은 하지 못했다.

---

## 1. 한눈에 보는 결론

1. **현재 npm 최신은 `three@0.187.0`(r187, 2026-10-30 배포)** 이고 dist-tag는 `latest` 하나뿐이다. 저장소 `package.json`이 이미 `three 0.187.0` / `@types/three 0.187.0`으로 고정돼 있어 올릴 것이 없다. three는 **타입을 번들하지 않는다** → `@types/three`가 계속 필요하다. [npm][소스]
2. **WebGLRenderer 유지가 맞다.** 공식 매뉴얼이 지금도 WebGPURenderer를 "still in an experimental state", WebGLRenderer를 "still maintained and the recommended choice for pure WebGL 2 applications"라고 적는다. 지원 범위(WebGL2 97.3% vs WebGPU 86.8%)와 번들(gzip 134 kB vs 218 kB)도 WebGL 쪽이 유리하다. [문서][실측]
3. **드로콜은 인원수와 무관하게 만들 수 있다.** 정적 월드 1개(병합+버텍스 컬러) + 캐릭터 부위별 `InstancedMesh` 4개 + 블롭 그림자 1개 + 이름표 1개 = **캐릭터 120명에 드로콜 7개**를 실제로 확인했다. 실제 섀도맵을 켜면 11개(삼각형 수 2배)로 늘었다. [실측]
4. **색은 "hex → `Color` → 버퍼" 경로만 쓴다.** 버텍스 컬러에 sRGB 값을 날것으로 넣으면 0x808080이 화면에 188로 떠서 허옇게 뜬다(정상은 128). `CanvasTexture`는 기본 색공간이 비어 있어 `colorSpace = SRGBColorSpace`를 안 주면 똑같이 뜬다. [실측]
5. **움직이는 `InstancedMesh`는 `frustumCulled = false`** 로 둔다. 경계 구는 처음 한 번만 계산되고 자동 갱신되지 않아서, 인스턴스를 옮기면 화면 안에 있어도 통째로 사라진다(드로콜 0 확인). [소스][실측]
6. **`THREE.Clock`은 r183에서 deprecated**(생성만 해도 경고) → `THREE.Timer`. **`PCFSoftShadowMap`은 r182에서 deprecated**(경고 후 `PCFShadowMap`으로 강제 대체, 이제 PCF가 부드럽다). `useLegacyLights`는 완전히 사라졌다. [소스][실측]
7. **아이폰은 `navigator.hardwareConcurrency`가 항상 4** 다(WebKit이 "8코어 미만이면 4, 아니면 8"만 반환). 지금 `client/src/render/engine.ts`의 `guessQuality()`는 터치 기기에서 `cores <= 4`면 `low`를 주므로 **모든 아이폰이 low(픽셀 비율 1, AA 꺼짐)로 시작**한다. 고쳐야 한다(§13, §16). [문서: WebKit 소스]
8. **아이폰 저전력 모드는 rAF를 30fps로 묶는다**(WebKit이 의도한 동작). 움직임은 반드시 시간 기반으로, 자동 품질 조절은 "고르게 33ms"를 느린 것으로 오판하지 않게 만든다. [문서: WebKit 버그 215745]
9. **컨텍스트 유실 후 복구는 three가 알아서 한다.** 강제 유실→복구 실험에서 앱 코드 없이 인스턴스 메시와 `CanvasTexture`가 다시 그려졌다. 앱이 할 일은 "유실 중 렌더 중단 + 몇 초 안에 복구 안 되면 새로고침 안내"다. [실측]
10. **헤드리스 Chromium에서 WebGL2 스크린샷 테스트는 된다.** Playwright가 `--enable-unsafe-swiftshader`를 기본으로 넣어 주기 때문에 **추가 플래그 없이** 동작했다. three r187 + 인스턴싱 + BatchedMesh + 섀도맵까지 렌더링 확인. [실측][소스]
11. **번들 크기**: 렌더러 + 메시 하나만 써도 min 526 kB / gzip 129 kB / brotli 106 kB가 바닥이고, 우리가 쓸 기능을 전부 넣어도 gzip 134~139 kB다. `import * as THREE`와 이름 import의 결과물은 **바이트 단위로 동일**했다. [실측]

---

## 2. 버전 · 타이핑 현황

| 항목 | 값 | 근거 |
|---|---|---|
| `npm view three version` | `0.187.0` | [npm] |
| `npm view three dist-tags` | `{ latest: '0.187.0' }` (다른 태그 없음) | [npm] |
| r187 배포일 | 2026-10-30 | [npm] |
| 직전 릴리스 | 0.186.1 (2026-09-24), 0.186.0 (09-08), 0.185.1 (07-01), 0.185.0 (06-25), 0.184.0 (04-16), 0.183.2 (02-28), 0.182.0 (2025-12-10), 0.181.2 (2025-11-19), 0.180.0 (2025-09-03) … 0.173.0 (2025-01-31) | [npm] |
| three에 타입 번들? | **아니오.** `package.json`에 `types` 필드 없음, 패키지 안에 `.d.ts` 0개 | [소스] |
| `npm view @types/three version` | `0.187.0` (2026-10-30 배포, 최소 TypeScript 5.6, dist-tag `ts5.7`~`ts7.1`) | [npm] |
| `@types/three`의 의존성 | `fflate`, `meshoptimizer`, `@tweenjs/tween.js`, `@dimforge/rapier3d-compat`, `@types/webxr`, `@types/stats.js` — 타입 전용이라 번들에는 안 들어간다. `node_modules`에 rapier·tween이 보이는 이유가 이것 | [npm] |
| three `exports` | `.` → `build/three.module.js`, `./addons/*` = `./examples/jsm/*`, `./webgpu`, `./tsl`, `./src/*` | [소스] |
| three `sideEffects` | `["./src/nodes/**/*"]` → WebGL 빌드는 트리셰이킹 대상 | [소스] |
| CommonJS | `require('three')`는 deprecated 경고(`THREE_CJS_DEPRECATED`)를 낸다. ESM만 쓸 것 | [실측] |
| 저장소 현재 고정 버전 | `three 0.187.0`, `@types/three 0.187.0`, `typescript ^7.0.2`, `vite ^8.3.8` | 저장소 `package.json` |

버전 고정 권장: three는 한두 달에 한 번 나오고 **마이너마다 브레이킹 체인지가 있다**(SemVer 아님). 지금처럼 캐럿 없이 `0.187.0`으로 고정하고, `three`와 `@types/three`는 항상 같은 번호로 함께 올린다. 위키에는 벌써 "187 → 188" 항목이 있다(§3 끝).

---

## 3. 최근 릴리스의 브레이킹 체인지 중 우리에게 걸리는 것

출처는 three.js 위키 Migration Guide와 r186/r187 릴리스 노트 [문서], 그리고 r187 소스 대조 [소스]. 우리와 무관한 것(TSL, WebGPU 전용 노드, 로더, XR)은 뺐다.

### 3.1 r172 → r187 (최근 15개 릴리스)

| 릴리스 | 변경 | 우리 코드에 주는 영향 |
|---|---|---|
| r173 | `MeshGouraudMaterial` deprecated → `MeshLambertMaterial` | 로우폴리 기본 재질은 Lambert로 통일 |
| r174 | `Timer`가 Page Visibility API를 자동으로 쓰지 않음 → `timer.connect(document)` 직접 호출 | 안 부르면 탭 복귀 때 delta가 수 초로 튄다 |
| r176 | `CapsuleGeometry`의 `length` 인자 이름이 `height`로 | r187 시그니처: `CapsuleGeometry(radius = 1, height = 1, capSegments = 4, radialSegments = 8, heightSegments = 1)` [소스] |
| r177 | `ColorManagement.fromWorkingColorSpace()` → `workingToColorSpace()`, `toWorkingColorSpace()` → `colorSpaceToWorking()` | 옛 이름은 r187에서 삭제됨("Remove code deprecated in r177") |
| r178 | `MultiplyBlending`/`SubtractiveBlending`은 `material.premultipliedAlpha = true` 필요 | 곱셈 블렌딩 그림자·이펙트를 만들 때 주의 |
| r179 | `Timer`가 코어로 이동(`THREE.Timer`). `reverseDepthBuffer` → `reversedDepthBuffer` | 애드온 import 불필요 |
| r180 | 셰이더 define 이름 변경(`USE_LOGDEPTHBUF` → `USE_LOGARITHMIC_DEPTH_BUFFER` 등) | `onBeforeCompile`로 셰이더를 패치할 때만 해당 |
| r181 | PBR 간접광·에너지 보존 개선으로 `MeshStandardMaterial` 외형이 달라짐. API 문서가 JSDoc 기반으로 바뀌고 영어만 제공 | Lambert만 쓰면 무관 |
| r182 | **`PCFSoftShadowMap` deprecated** (WebGLRenderer). `PCFShadowMap`이 부드러운 그림자가 됨 | `renderer.shadowMap.type = THREE.PCFShadowMap` |
| r183 | **`Clock` deprecated → `Timer`** | 생성자에서 경고 출력 [실측] |
| r184 | 배경/환경맵 회전 방향 변경. `FileLoader.load()` 반환값 없음. 픽셀 스토어 설정은 `renderer.state.pixelStorei()` | 거의 무관 |
| r185 | **`Object3D.updateWorldMatrix()`가 `matrixWorldNeedsUpdate`를 따름**: `matrixAutoUpdate = false`인 오브젝트의 `matrix`를 직접 고치면 `matrixWorldNeedsUpdate = true`를 직접 켜야 함. `Matrix3.translate/scale/rotate` deprecated | `updateMatrix()`를 부르면 플래그가 자동으로 켜진다 [소스]. `matrix.copy()`/`compose()`로 직접 쓰는 코드만 주의 |
| r186 | `Object3D.dispose()` 추가(직접 만든 서브클래스의 `dispose()`는 `super.dispose()` 호출). `Source` → `TextureSource`. `BufferGeometryUtils.toTrianglesDrawMode()`가 제자리 수정. 캐스케이드 그림자용 `SunLight` 애드온 추가(`three/addons/lights/SunLight.js`) | 우리는 캐스케이드 불필요 |
| r187 | `WebGLRenderer.setViewport()`/`setScissor()`가 **렌더 타깃이 묶여 있을 때는 픽셀 비율을 곱하지 않음**. 렌더러가 내부적으로 `WeakRef`/`FinalizationRegistry` 사용. PMREM 구현 교체(`CubeUVReflectionMapping` 삭제). `ColorManagement` 변환 행렬 순서 버그 수정. `mergeGeometries()`가 모프 어트리뷰트 검증·`morphTargetsRelative` 보존 | 초상화를 렌더 타깃에 그릴 때 뷰포트를 픽셀 단위로 직접 지정 |

### 3.2 그보다 오래됐지만 옛 예제 코드를 베낄 때 꼭 걸리는 것

| 릴리스 | 변경 |
|---|---|
| r152 | `outputEncoding` → `outputColorSpace`(기본 `SRGBColorSpace`), `texture.encoding` → `texture.colorSpace`(기본 `NoColorSpace`), `sRGBEncoding` → `SRGBColorSpace`, `ColorManagement.enabled` 기본 `true` |
| r155 | 물리 단위 조명이 기본. 옛 밝기를 되찾으려면 Ambient/Hemisphere/Directional은 **intensity × π**. Point/Spot은 칸델라 단위 + `decay = 2` 기본 |
| r159 | `BufferAttribute.updateRange` → **`updateRanges` + `addUpdateRange()`/`clearUpdateRanges()`**. `BatchedMesh.applyGeometry()` → `addGeometry()` |
| r160~r161 | `build/three.js`, `three.min.js` 삭제(ESM 전용) |
| r163 | **WebGL 1 지원 삭제**(WebGL2 필수), `stencil` 컨텍스트 속성 기본값 `false` |
| r165 | `useLegacyLights` 삭제 예고 버전. r187에서 `'useLegacyLights' in renderer === false` 확인 [실측] |
| r166 | `BatchedMesh`: `addGeometry()` 뒤에 **`addInstance()`를 불러야** 그려진다 |
| r170 | `generateMipmaps = true`면 필터 설정과 무관하게 항상 밉맵 생성 |
| r171 | WebGPU 쪽 import 경로가 `three/webgpu`, `three/tsl`로 분리 |

### 3.3 다음 버전(r188, 위키에 이미 올라온 항목) 예고

- `AmbientLight`/`HemisphereLight`가 `MeshStandardMaterial`/`MeshPhysicalMaterial`에 스페큘러도 더함(환경맵 없는 금속이 더는 까맣지 않음). `LightProbe` deprecated. 멀티바운스 AO.
- 전부 Standard/Physical 재질 얘기라 **Lambert + 버텍스 컬러를 쓰는 우리에게는 영향이 작다.** 그래도 버전을 올릴 때는 스크린샷 비교(§14)를 돌린다.

---

## 4. WebGLRenderer vs WebGPURenderer

**결론: WebGLRenderer 유지(계획 확인).**

| 판단 근거 | 내용 | 등급 |
|---|---|---|
| 공식 입장 | 매뉴얼 "WebGPURenderer" 문서의 문장 그대로: *"The renderer itself is still in an experimental state although its maturity level has been greatly improved in the last years. Still, depending on your application and scene setup, you will encounter missing features or a better performance with `WebGLRenderer`."* / *"`WebGLRenderer` is still maintained and the recommended choice for pure WebGL 2 applications."* 다만 큰 신기능은 WebGLRenderer에 더 들어오지 않는다고도 적혀 있다 | [문서] |
| 지원 범위 | caniuse 전세계 사용률: WebGL2 97.29%(Chrome 56+, Safari/iOS 15+, Firefox 51+, Samsung Internet 7.2+). WebGPU 86.83%(+부분 지원 1.8%). WebGPU는 Chrome 113+(안드로이드는 121부터, Android 12 이상 + Qualcomm/ARM GPU), Safari/iOS 26+. Firefox는 web.dev 기준 Windows 141·macOS(Apple Silicon) 145부터이고 리눅스·안드로이드는 진행 중(caniuse 표는 Firefox를 아직 "기본 비활성"으로 표기해 서로 다르다) | [문서: caniuse, web.dev 2025-11-25] |
| 번들 | 같은 장면 기준 `three` 엔트리 min 549 kB / gzip 134 kB, `three/webgpu` 엔트리 min 817 kB / gzip 218 kB (**+84 kB gzip**) | [실측] |
| 폴백 | WebGPURenderer는 WebGPU가 없으면 WebGL2 백엔드로 자동 폴백하지만(`forceWebGL: true`로 강제 가능), 그래도 무거운 번들은 그대로 받는다 | [문서] |
| 호환 비용 | WebGPURenderer에서는 `ShaderMaterial`/`RawShaderMaterial`/`onBeforeCompile`이 **동작하지 않는다**(TSL 노드 재질로 다시 써야 함). 우리 이름표 빌보드 셰이더(§9)가 여기에 걸린다. 초기화도 비동기(`await renderer.init()`)다 | [문서] |
| 얻는 것 | 컴퓨트 셰이더, 노드 포스트프로세싱 — 로우폴리 플랫 셰이딩 게임에는 필요 없다 | [추정] |

나중에 옮길 여지를 남기려면: 커스텀 GLSL을 한두 군데(이름표)로만 제한하고, `onBeforeCompile` 패치는 쓰지 않는다.

---

## 5. 현재 버전 기준 API 노트 (복붙용)

아래 §5~§13의 TypeScript 블록은 **한 모듈(예: `client/src/render/recipes.ts`)의 조각**이다. 맨 위 import는 아래 두 줄이고, 모듈 스코프 임시 객체 `_c`(§6.2), `_m`·`_local`(§6.3), `_p`·`_q`·`_s`(§7)를 서로 공유한다. 함수 간 참조(`startLoop` → `DynamicResolution`·`resizeRenderer`·`watchContext`)도 같은 모듈 안에서 해결된다.

```ts
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
```

### 5.1 렌더러 생성

r187 `WebGLRenderer` 생성자 인자와 기본값 [소스]:

| 인자 | 기본값 | 메모 |
|---|---|---|
| `canvas` | 새 캔버스 | 기존 `<canvas id="game">` 전달 |
| `antialias` | `false` | **컨텍스트 생성 때만 정해진다. 나중에 못 바꾼다** |
| `alpha` | `false` | three는 내부적으로 컨텍스트를 **항상 `alpha: true`로 만들고**, 이 값은 클리어 알파(0 또는 1)만 정한다. `false`면 불투명 |
| `depth` / `stencil` | `true` / `false` | 스텐실은 r163부터 기본 꺼짐 |
| `powerPreference` | `'default'` | 게임이면 `'high-performance'` |
| `preserveDrawingBuffer` | `false` | 켜면 프레임마다 버퍼를 보존하는 비용이 든다 [추정]. 켜지 않고도 이미지를 뽑을 수 있다(§14.3) |
| `failIfMajorPerformanceCaveat` | `false` | 켜지 말 것(소프트웨어 렌더러에서 생성 실패 → 헤드리스 테스트가 죽는다) [추정] |
| `precision` | `'highp'` | 기기가 못 받치면 자동으로 `mediump`로 내려감 |
| `premultipliedAlpha` | `true` | |
| `reversedDepthBuffer`, `logarithmicDepthBuffer` | `false` | 우리 규모(수백 m)에는 불필요 |
| `outputBufferType` | `UnsignedByteType` | `HalfFloatType`은 `renderer.setEffects()`(내장 포스트프로세싱)용. 모바일에서는 쓰지 않는다 |

생성 후 기본 상태: `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`, `shadowMap.enabled = false`, `shadowMap.type = PCFShadowMap`, `sortObjects = true`. WebGL1 컨텍스트를 넘기면 예외("WebGL 1 is not supported since r163").

```ts
export function createRenderer(canvas: HTMLCanvasElement, q: Quality): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: q.antialias,
    alpha: false,                 // 클리어 알파 1 → 불투명 캔버스 (컨텍스트 자체는 three 가 항상 alpha:true 로 만든다)
    stencil: false,               // r163+ 기본값도 false
    depth: true,
    powerPreference: 'high-performance',
    // failIfMajorPerformanceCaveat: false (기본) — true 로 하면 소프트웨어 GL(헤드리스 테스트 포함)에서 생성 실패
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;   // 기본값. 명시만.
  renderer.toneMapping = THREE.NoToneMapping;          // 기본값. 로우폴리 플랫 컬러는 톤매핑 불필요
  renderer.shadowMap.enabled = q.sunShadow;
  renderer.shadowMap.type = THREE.PCFShadowMap;        // PCFSoftShadowMap 은 r182 에서 deprecated → 경고 후 PCFShadowMap 으로 대체됨
  // 섀도 패스는 캐스터를 한 번 더 그린다(드로콜 ×2). 동적 캐스터가 있으면 autoUpdate=true,
  // 정적 월드만 굽는다면 autoUpdate=false 로 두고 필요할 때 renderer.shadowMap.needsUpdate = true.
  renderer.shadowMap.autoUpdate = q.sunShadow;
  renderer.info.autoReset = true;
  return renderer;
}

/** CSS 크기 기준 리사이즈. updateStyle=false 로 canvas 의 CSS 크기는 CSS(100dvh 등)에 맡긴다. */
export function resizeRenderer(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, pixelRatio: number): void {
  const canvas = renderer.domElement;
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
```

### 5.2 색 관리 (r152 이후 규칙, r187에서 실측)

`ColorManagement.enabled`는 기본 `true`, 작업 색공간은 Linear-sRGB다. 규칙은 하나다: **사람이 고른 색(hex, CSS 문자열)은 `Color`를 거치게 하고, 버퍼에는 `Color`의 `.r/.g/.b`(선형 값)를 넣는다.**

| 입력 방법 | 색공간 가정 | 0x808080을 그렸을 때 화면 픽셀 |
|---|---|---|
| `material.color.setHex(0x808080)` / `new Color(0x808080)` / `setStyle('#808080')` | sRGB 입력 → 선형으로 변환해 저장(`.r === 0.2159`) | **128** (정상) |
| `color.setRGB(r, g, b)` / `setHSL()` | 인자를 **작업 색공간(선형)** 으로 간주 | — |
| 버텍스 컬러 버퍼에 `128/255`를 날것으로 기록 | 선형으로 간주됨 | **188** (허옇게 뜸) |
| 버텍스 컬러 버퍼에 `Color(0x808080)`의 r/g/b 기록 | 선형 | **128** |
| 같은 값을 `Uint8Array` + `normalized = true`로 기록 | 선형 8비트(어두운 색에서 계조 손실 가능) | **128** |
| `CanvasTexture` 기본(`colorSpace === ''`) | 변환 없음 | **188** (허옇게 뜸) |
| `CanvasTexture` + `colorSpace = SRGBColorSpace` | sRGB → 선형 디코드 | **128** |

- `InstancedMesh.setColorAt(i, color)`도 `Color`의 선형 값을 그대로 복사한다 → `Color.setHex()`로 만든 색을 넘기면 된다. [소스]
- `ShaderMaterial`은 출력 변환이 자동으로 붙지 않는다. 프래그먼트 셰이더 끝에 `#include <colorspace_fragment>`(내용은 `gl_FragColor = linearToOutputTexel( gl_FragColor );` 한 줄)를 넣어야 sRGB로 나간다(§9 이름표 셰이더에서 이렇게 해서 정상 색 확인). [소스]
- 렌더 타깃에 그릴 때는 출력이 선형이다. 바이트로 읽어 PNG를 만들 거면 `renderTarget.texture.colorSpace = SRGBColorSpace`로 두면 읽은 값이 sRGB(0xff8800 → [255,136,0])가 된다. [실측]

### 5.3 조명 단위

- r155부터 물리 단위가 유일한 모드다. `DirectionalLight`/`AmbientLight`/`HemisphereLight`는 옛 코드 대비 **π배 어둡게** 보이므로 intensity를 1.5~3 정도로 넉넉히 잡는다(지금 `engine.ts`의 sun 2.1 / hemi 1.35가 이 범위). `PointLight`/`SpotLight`는 칸델라 단위 + `decay = 2`라 훨씬 큰 값이 필요하다. [문서]
- 생성자: `HemisphereLight(skyColor, groundColor, intensity)`, `DirectionalLight(color, intensity)`, `PointLight(color, intensity, distance = 0, decay = 2)`. [소스]
- 모바일 권장 구성: **Hemisphere 1 + Directional 1, 끝.** 가로등·네온 같은 "빛나는 것"은 조명이 아니라 밝은 버텍스 컬러나 `MeshBasicMaterial`(조명 계산 없음)로 표현한다. 조명 개수가 바뀌면 조명 받는 재질의 셰이더가 전부 다시 컴파일되므로, 켜고 끄는 연출은 `intensity`를 0으로 만드는 방식으로 한다. [웹: discoverthreejs][추정]
- 재질 비용 순서(싼 것부터): `MeshBasicMaterial` < `MeshLambertMaterial` < `MeshPhongMaterial` < `MeshStandardMaterial`. 로우폴리 플랫 컬러에는 `MeshLambertMaterial({ flatShading: true })`가 맞다. `flatShading`은 프래그먼트 셰이더에서 `dFdx/dFdy`로 면 법선을 구하므로 **정점을 쪼개 놓지 않아도 각진 면이 나온다.** [소스]

### 5.4 Fog

- `new THREE.Fog(color, near = 1, far = 1000)`(선형), `new THREE.FogExp2(color, density = 0.00025)`. 내장 재질은 `material.fog` 기본 `true`. `ShaderMaterial`은 직접 fog 청크를 넣지 않으면 안개를 안 받는다. [소스]
- 성능 용도: **`camera.far`를 `fog.far` 바로 뒤로 당겨** 먼 오브젝트를 절두체 컬링으로 잘라내고, 잘리는 경계를 안개가 가리게 한다. 안개 색은 지평선 쪽 하늘색과 같게 맞춘다(다르면 먼 건물이 하늘과 다른 색 띠로 보인다).

### 5.5 Timer / 메인 루프

`Timer`는 `update(timestamp)`를 프레임당 한 번 부르고 `getDelta()`/`getElapsed()`(초)를 읽는 구조다. `connect(document)`를 부르면 탭이 숨겨진 동안 delta가 0이 되고 복귀 시 리셋된다. [소스]

```ts
export function startLoop(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: Quality, update: (dt: number, elapsed: number) => void): () => void {
  const timer = new THREE.Timer();          // Clock 은 r183 에서 deprecated
  timer.connect(document);                  // 탭 복귀 시 거대한 delta 방지 (r174+ 는 수동 connect 필요)
  let contextLost = false, skip = false;
  const stopWatch = watchContext(renderer, () => { contextLost = true; }, () => { contextLost = false; renderer.shadowMap.needsUpdate = true; });
  const dyn = new DynamicResolution(q, (pr) => resizeRenderer(renderer, camera, pr));
  resizeRenderer(renderer, camera, dyn.current);
  const ro = new ResizeObserver(() => resizeRenderer(renderer, camera, dyn.current));
  ro.observe(renderer.domElement);
  renderer.setAnimationLoop((time: number) => {
    timer.update(time);
    const rawDt = timer.getDelta();
    const dt = Math.min(rawDt, 0.1);                   // iOS 저전력 모드(30fps)·탭 전환 대비: 반드시 시간 기반 + 클램프
    update(dt, timer.getElapsed());                    // 시뮬레이션/네트워크 보간은 항상 수행
    if (contextLost || document.hidden) return;
    if (q.targetFps === 30 && rawDt < 0.025) { skip = !skip; if (skip) return; }   // 60Hz 이상일 때만 격프레임 렌더 (이미 30Hz 로 묶였으면 건너뛰지 않음)
    renderer.render(scene, camera);
    dyn.update(q.targetFps === 30 && rawDt < 0.025 ? rawDt * 2 : rawDt);
  });
  return () => { renderer.setAnimationLoop(null); ro.disconnect(); stopWatch(); timer.dispose(); };
}
```

```ts
export function setupScene(q: Quality): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; sun: THREE.DirectionalLight } {
  const scene = new THREE.Scene();
  const sky = 0x9fd3ff;
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.Fog(sky, q.viewDistance * 0.45, q.viewDistance);  // far 클립을 안개로 가림 → camera.far 를 줄여도 팝인이 안 보임
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, q.viewDistance + 5);
  // r155+ 물리 단위 조명: 예전(legacy) 대비 Lambert/Standard 에서 π 배 어둡게 보이므로 intensity 를 넉넉히
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(20, 40, 15);
  if (q.sunShadow) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    const cam = sun.shadow.camera; cam.left = -30; cam.right = 30; cam.top = 30; cam.bottom = -30; cam.near = 1; cam.far = 100;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
  }
  scene.add(sun);
  return { scene, camera, sun };
}
```

---

## 6. 드로콜을 낮게 유지하기

### 6.1 우리 장면의 드로콜 예산

three는 렌더 가능한 오브젝트 하나(재질 하나)당 드로콜 하나를 낸다. 자동 배칭은 없다. `Sprite` 100개는 드로콜 100개다. [소스: 렌더 루프 구조] 그래서 "오브젝트 수"가 아니라 "메시 종류 수"로 설계한다.

| 묶음 | 방법 | 드로콜 |
|---|---|---|
| 정적 월드(도로, 건물, 횡단보도, 지하철 출구, 광장, 연단, 천막, 부스, 본부) | 지오메트리 병합 + 버텍스 컬러, 재질 1개 | 1 |
| 유리·현수막 같은 반투명 정적 요소 | 별도 병합 메시 1개(`transparent`) | 0~1 |
| 발광 간판/네온 | `MeshBasicMaterial` 병합 메시 1개 | 0~1 |
| 반복 소품(가로수, 가로등, 볼라드, 화분) | 종류별 `InstancedMesh` 또는 월드에 병합 | 0~5 |
| 캐릭터(플레이어 + NPC 전원) | **부위별 `InstancedMesh`** (몸통, 머리, 손×2, 발×2, 모자/머리카락, 눈) | 6~8 |
| 블롭 그림자 | `InstancedMesh` 쿼드 1개 | 1 |
| 이름표 | 아틀라스 + 인스턴스 빌보드 | 1 |
| 파티클(하트, 물음표, 땀, 헌금 아이템) | 인스턴스 쿼드 1~2개 | 1~2 |
| 하늘 | `scene.background`가 `Color`면 클리어만(0), 그라디언트 텍스처면 풀스크린 1회 | 0~1 |
| **합계** | | **약 11~22, 인원수와 무관** |

실측: 정적 월드 1 + 캐릭터 4부위 + 블롭 1 + 이름표 1 구성에서 캐릭터 120명 = **드로콜 7, 삼각형 약 25,000** (`renderer.info.render`). [실측]

목표치(경험칙, 실기기 튜닝 필요): low 30 이하 / medium 50 이하 / high 100 이하 드로콜, 삼각형은 low 6만 / medium 15만 / high 30만 이하. [추정]

개발 중에는 HUD에 `renderer.info.render.calls`, `.triangles`, `renderer.info.memory.geometries/textures`, `renderer.info.programs.length`를 띄워 회귀를 바로 본다. [소스]

### 6.2 정적 월드: 병합 + 버텍스 컬러

- import 경로: **`import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'`** (`three/examples/jsm/…`와 같은 파일). 옛 이름 `mergeBufferGeometries`는 없다. 시그니처 `mergeGeometries(geometries, useGroups = false)`, **실패하면 `null`을 반환**하고 `console.error`만 찍는다. [소스]
- 병합 조건: 모든 지오메트리가 **전부 인덱스 있음 또는 전부 없음**, 어트리뷰트 이름 집합과 itemSize가 같아야 한다. three 내장 지오메트리는 섞여 있다 [실측]:

| 인덱스 있음 | 인덱스 없음 |
|---|---|
| Box(24정점/12삼각형), Plane, Cylinder, Cone, Sphere, Capsule, Torus, Lathe | Icosahedron(detail 1 = 240정점/80삼각형), Octahedron, Tetrahedron, Dodecahedron, Extrude |

  → 병합 전에 `toNonIndexed()`로 통일하고, 안 쓰는 `uv`는 지워서 구성도 통일한다(아래 `paint()`).
- 텍스처를 쓰지 않으면 텍스처 메모리·샘플링·아틀라스 관리가 통째로 사라진다. 색은 정점에 굽는다.
- 병합 메시는 통째로 컬링된다(일부만 보여도 전체를 그린다). 맵이 크면 구역(예: 40 m 격자)별로 4~9개 덩어리로 나눠 병합하면 컬링이 다시 먹는다. [추정]
- 병합에 쓴 원본 지오메트리는 `dispose()`한다. 정적 메시는 `matrixAutoUpdate = false`.

```ts
const _c = new THREE.Color();
/** hex(sRGB) → 작업 색공간(linear)으로 변환해 color 어트리뷰트에 기록. uv 는 버려서 메모리 절약. */
export function paint(geo: THREE.BufferGeometry, hex: number, matrix?: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();   // flatShading 로우폴리: non-indexed 로 통일
  if (matrix) g.applyMatrix4(matrix);
  _c.setHex(hex);                                            // setHex 는 sRGB 입력 → linear 로 변환해 저장
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}
export function buildStaticWorld(parts: THREE.BufferGeometry[]): THREE.Mesh {
  const merged = mergeGeometries(parts, false);              // 실패 시 null (어트리뷰트 구성이 서로 다르면)
  if (!merged) throw new Error('mergeGeometries failed: attribute sets differ');
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;                             // 정적: 매 프레임 행렬 재계산 생략
  mesh.updateMatrix();
  mesh.receiveShadow = true;
  return mesh;
}
```

### 6.3 캐릭터: 부위별 InstancedMesh

r187 `InstancedMesh` 사실 정리 [소스][실측]:

- 생성자 `new InstancedMesh(geometry, material, count)`. `count`만큼 `instanceMatrix`(16 float × count)가 잡히고 이것이 **용량**이다. 용량은 나중에 못 늘린다(새로 만들어야 함). `mesh.count`를 0~용량 사이로 바꾸면 그만큼만 그린다. `count = 0`이면 드로콜 자체가 없다.
- 인스턴스별 컬링·정렬은 없다. **보이는 것만 앞쪽 슬롯에 채우고 `count`로 자른다.**
- `instanceColor`는 기본 `null`. 첫 `setColorAt()`에서 용량 크기 버퍼가 만들어지고 **1(흰색)로 채워진다.** 최종 색 = `material.color × instanceColor`이므로 재질 색은 흰색으로 둔다. `material.vertexColors`는 켤 필요 없다.
- 첫 렌더 뒤에 `setColorAt()`을 처음 불러도 프로그램이 자동으로 바뀐다(실측: 정상 반영). 다만 그 순간 셰이더 컴파일이 한 번 끼므로 **생성 직후 한 번 불러 두는 것**이 낫다.
- 변경 후에는 `instanceMatrix.needsUpdate = true` / `instanceColor.needsUpdate = true`. 업로드는 프레임당 1회, **`count`가 아니라 용량 전체**가 올라간다(`bufferSubData(…, 0, array)`). 용량 320 × 64 B = 20 KB/부위라 문제없다. 용량이 수천 이상이면 `instanceMatrix.addUpdateRange(start, count)`를 쓰되 **단위가 "인스턴스 수"가 아니라 "배열 성분 수"**(인스턴스 i 하나 = `addUpdateRange(i * 16, 16)`)임에 주의.
- `setUsage(THREE.DynamicDrawUsage)`는 **첫 렌더 전에** 불러야 적용된다(버퍼 생성 때만 읽는다).
- **경계 구 함정**: 절두체 컬링과 레이캐스트는 `mesh.boundingSphere`를 쓰는데, `null`일 때 한 번 계산된 뒤 **자동으로 다시 계산되지 않는다.** 실측: 원점에 있던 인스턴스 4개를 화면 안으로 옮기고 `needsUpdate`만 켰더니 드로콜 0(안 보임), `computeBoundingSphere()`를 부르거나 `frustumCulled = false`로 두자 드로콜 1. → 움직이는 인스턴스 메시는 `frustumCulled = false`(거리 컬링은 우리가 슬롯을 채울 때 직접 한다).
- `Raycaster`로 `InstancedMesh`를 찍으면 인스턴스 수만큼 삼각형 검사를 돈다. 캐릭터 선택은 "바닥 평면 교차점에서 가장 가까운 캐릭터"나 광선-구 계산으로 직접 한다(`engine.ts`의 `pickGround()` 활용).
- CPU 비용: 320명 × 5부위 = 행렬 1,600개 합성·기록이 데스크톱급 코어에서 프레임당 0.12 ms(Node 22). 폰이 5~10배 느려도 1 ms 안팎이라 셰이더 애니메이션으로 옮길 이유가 없다. [실측][추정]
- 메모리: 용량 320 × 8부위 × (행렬 64 B + 색 12 B) ≈ 195 KB.

표정·의상 변형: 얼굴은 "눈" 부위 인스턴스 메시(작은 검은 구 2개를 하나로 병합)를 두고 행렬 스케일로 깜빡임/놀람을 표현하면 텍스처 없이 드로콜 1개로 끝난다. 모자·후광 같은 계급 장식은 부위를 하나 더 두고 안 쓰는 캐릭터는 스케일 0 행렬을 넣는다. [추정]

```ts
export interface PartDef { name: string; geometry: THREE.BufferGeometry; }
const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
export class InstancedParts {
  readonly meshes: THREE.InstancedMesh[] = [];
  constructor(parts: PartDef[], readonly capacity: number, castShadow: boolean) {
    const material = new THREE.MeshLambertMaterial({ flatShading: true }); // 흰색 × instanceColor
    for (const p of parts) {
      const mesh = new THREE.InstancedMesh(p.geometry, material, capacity);
      mesh.name = p.name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);  // 첫 렌더 "전에" 지정해야 적용됨
      mesh.setColorAt(0, _c.setHex(0xffffff));               // instanceColor 버퍼를 미리 생성(전부 1 로 채워짐)
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;                                        // 그릴 개수. capacity 를 넘기면 안 됨
      mesh.frustumCulled = false;                            // 움직이는 인스턴스: stale boundingSphere 로 사라지는 문제 회피
      mesh.castShadow = castShadow;
      mesh.matrixAutoUpdate = false;
      this.meshes.push(mesh);
    }
  }
  setCount(n: number): void { for (const m of this.meshes) m.count = Math.min(n, this.capacity); }
  /** root: 캐릭터 월드 행렬, locals[partIndex]: 부위 로컬 행렬(애니메이션 포함) */
  setInstance(i: number, root: THREE.Matrix4, locals: THREE.Matrix4[]): void {
    for (let p = 0; p < this.meshes.length; p++) {
      _m.multiplyMatrices(root, locals[p] ?? _local.identity());
      this.meshes[p].setMatrixAt(i, _m);
    }
  }
  setColor(partIndex: number, i: number, hex: number): void {
    const mesh = this.meshes[partIndex];
    mesh.setColorAt(i, _c.setHex(hex));
    mesh.instanceColor!.needsUpdate = true;
  }
  /** 프레임 끝에서 1회. */
  commit(): void { for (const m of this.meshes) m.instanceMatrix.needsUpdate = true; }
  dispose(): void { for (const m of this.meshes) { m.geometry.dispose(); m.dispose(); } (this.meshes[0]?.material as THREE.Material | undefined)?.dispose(); }
}
```

### 6.4 BatchedMesh는 언제?

r187 API [소스]: `new BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount = maxVertexCount * 2, material)` → `addGeometry(geo, reservedVertexCount?, reservedIndexCount?)` → `addInstance(geometryId)` → `setMatrixAt(instanceId, m)` / `setColorAt(instanceId, colorOrVector4)` / `setVisibleAt(instanceId, bool)` / `deleteInstance()` / `optimize()` / `setInstanceCount()` / `setGeometrySize()`. 속성 `perObjectFrustumCulled = true`, `sortObjects = true`. 첫 지오메트리가 어트리뷰트 구성을 정하고 나머지는 거기에 맞아야 한다.

- 장점: **서로 다른 지오메트리**를 재질 하나로 드로콜 1개에 묶고, 인스턴스별 컬링·가시성 토글이 된다. 헤드리스 실험에서 정상 렌더 확인. [실측]
- 단점: 매 프레임 CPU에서 인스턴스별 컬링/정렬을 돌고, 행렬·색을 **데이터 텍스처**로 올린다. 그리고 `WEBGL_multi_draw` 확장이 없으면 **인스턴스마다 드로콜을 따로 내는 루프로 폴백**한다. [소스] 이 확장은 Chrome·Safari 15+에는 있고 Firefox에는 없다. [웹: caniuse]
- 판단: 정적 월드는 `mergeGeometries`(프레임당 CPU 0), 캐릭터는 부위별 `InstancedMesh`로 충분하다. **BatchedMesh는 쓰지 않는다.** 나중에 "종류가 수십 가지인 소품을 개별로 켜고 꺼야 하는" 요구가 생기면 그때 검토한다.

---

## 7. 그림자: 블롭 vs 섀도맵

| 방식 | 비용 | 판단 |
|---|---|---|
| 블롭 그림자(바닥에 붙는 반투명 원 쿼드, 인스턴싱) | 드로콜 1, 텍스처 64×64 한 장, 오버드로 약간 | **모든 티어 기본** |
| 실제 섀도맵(방향광 1개) | 그림자를 드리우는 모든 것을 **한 번 더** 그림 + 받는 쪽 셰이더에 PCF 샘플링 추가 + 깊이 텍스처 메모리 | high(데스크톱)에서만 |

실측: 같은 장면에서 섀도맵(1024², `PCFShadowMap`)을 켜자 드로콜 7 → 11, 삼각형 25,036 → 49,592, 셰이더 프로그램 4 → 7. [실측]

섀도맵을 쓸 때의 설정 [소스]:
- `renderer.shadowMap.enabled = true`, `type = THREE.PCFShadowMap`(`PCFSoftShadowMap`은 쓰지 말 것), 종류는 `BasicShadowMap`/`PCFShadowMap`/`VSMShadowMap`.
- 갱신 게이트가 두 겹이다: 렌더러(`renderer.shadowMap.autoUpdate`/`needsUpdate`)와 조명별(`light.shadow.autoUpdate`/`needsUpdate`). **`renderer.shadowMap.autoUpdate = false`인데 `needsUpdate`를 안 켜면 그림자가 영영 안 그려진다**(실제로 한 번 겪음). 정적 월드만 굽는다면 `autoUpdate = false` + 필요할 때 `renderer.shadowMap.needsUpdate = true`.
- `light.shadow.mapSize`(기본 512²), `bias`, `normalBias`, `radius`, `blurSamples`, `intensity`. 그림자 카메라 절두체(`left/right/top/bottom/near/far`)는 플레이어 주변 ±30 m 정도로 좁게 잡고 플레이어를 따라 옮긴다.
- 블롭과 섀도맵을 같이 켜면 이중으로 어두워진다. high에서는 블롭을 끈다.

블롭 그림자 만들 때 주의: `depthWrite: false` + `polygonOffset`(또는 바닥에서 2 cm 띄움)으로 Z-파이팅 방지, 캐릭터가 점프하면 반지름을 줄여 높이감을 준다, 텍스처는 `generateMipmaps = false`.

```ts
export function makeBlobTexture(size = 64): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;   // 색 데이터 텍스처는 반드시 지정 (기본 NoColorSpace)
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  return tex;
}
export function makeBlobShadows(capacity: number): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: makeBlobTexture(), transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 1; mesh.matrixAutoUpdate = false;
  return mesh;
}
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
export function setBlob(mesh: THREE.InstancedMesh, i: number, x: number, z: number, radius: number, groundY = 0.02): void {
  _m.compose(_p.set(x, groundY, z), _q.identity(), _s.set(radius * 2, 1, radius * 2));
  mesh.setMatrixAt(i, _m);
}
```

---

## 8. 해상도 · 안티에일리어싱 · 전원

### 8.1 픽셀 비율 상한

모바일 3D의 가장 큰 비용은 대개 픽셀 수(필레이트)다. CSS 430×932 화면 기준:

| 픽셀 비율 | 드로잉 버퍼 | 픽셀 수 | DPR 3 대비 |
|---|---|---|---|
| 3.0 (기기 기본) | 1290×2796 | 361만 | 100% |
| 2.0 | 860×1864 | 160만 | 44% |
| 1.5 | 645×1398 | 90만 | 25% |
| 1.0 | 430×932 | 40만 | 11% |

- `renderer.setPixelRatio(Math.min(devicePixelRatio, cap))` 후 `renderer.setSize(cssW, cssH, false)`. 세 번째 인자 `false`는 캔버스의 CSS 크기를 건드리지 않게 한다(레이아웃은 CSS가 담당). [소스]
- 크기는 `window.innerWidth/innerHeight`보다 **캔버스의 `clientWidth/clientHeight`를 `ResizeObserver`로** 읽는 편이 안전하다(iOS 주소창 접힘, 화면 회전, 키보드에 모두 반응). MDN은 정확한 기기 픽셀이 필요하면 `ResizeObserver`의 `device-pixel-content-box`를 권한다. 우리는 어차피 비율을 깎으므로 CSS 크기 × 비율이면 충분하다. [문서: MDN]
- 캔버스 크기를 바꾸면 버퍼가 지워지고 다시 할당된다. 매 프레임 바꾸지 말 것.

### 8.2 동적 해상도

1초 평균 프레임 간격으로 픽셀 비율을 0.25씩 내리고 0.125씩 올린다. 쿨다운 2초, 탭 전환 스파이크(250 ms 초과) 제외. **"33.3 ms에 고르게 고정"은 아이폰 저전력 모드의 30 Hz 상한이므로 느린 것으로 치지 않는다.** 시뮬레이션 결과: 16.7 ms 고정 → 변화 없음, 33.3±0.5 ms 고정 → 변화 없음, 22~50 ms로 출렁임 → 1.5 → 1.0으로 하강, GPU 부하가 비율²에 비례하는 모델 → 2.0 → 1.5에서 안정. [실측: 로직 시뮬레이션]

```ts
export class DynamicResolution {
  private acc = 0; private frames = 0; private cooldown = 0; private min = Infinity; private max = 0;
  current: number;
  constructor(private q: Quality, private apply: (pr: number) => void, private dpr: () => number = () => window.devicePixelRatio || 1) {
    this.current = Math.min(this.dpr(), q.maxPixelRatio);
  }
  /** rawDt: 클램프하지 않은 프레임 간격(초). 렌더한 프레임마다 호출. 1초 창 평균 + 히스테리시스 + 쿨다운. */
  update(rawDt: number): void {
    const ms = rawDt * 1000;
    if (ms > 250) return;                                   // 탭 전환/GC 스파이크는 표본에서 제외
    this.acc += ms; this.frames++; this.min = Math.min(this.min, ms); this.max = Math.max(this.max, ms);
    if (this.acc < 1000) return;
    const avg = this.acc / this.frames, spread = this.max - this.min;
    this.acc = 0; this.frames = 0; this.min = Infinity; this.max = 0;
    if (this.cooldown > 0) { this.cooldown--; return; }
    const budget = 1000 / this.q.targetFps;
    const cap = Math.min(this.dpr(), this.q.maxPixelRatio);
    // iOS 저전력 모드 등: rAF 가 30Hz 로 "고르게" 고정되면(33.3ms ± 작은 편차) 느린 게 아니라 상한에 걸린 것 → 해상도를 깎지 않는다
    const cappedAt30 = this.q.targetFps === 60 && avg > 31 && avg < 35.5 && spread < 6;
    let next = this.current;
    if (!cappedAt30 && avg > budget * 1.25) next = Math.max(this.q.minPixelRatio, this.current - 0.25);
    else if (avg < budget * 1.08) next = Math.min(cap, this.current + 0.125);
    if (next !== this.current) { this.current = next; this.apply(next); this.cooldown = 2; }
  }
}
```

### 8.3 안티에일리어싱

- `antialias: true`는 기본 프레임버퍼 MSAA(Chromium SwiftShader에서 `maxSamples = 4` 확인)다. **생성 후에는 못 바꾼다** → 티어를 런타임에 내려도 AA는 그대로다. 바꾸려면 렌더러(=캔버스 컨텍스트)를 새로 만들어야 한다. [소스][실측]
- 타일 기반 모바일 GPU에서 MSAA는 비교적 싸다는 보고가 있다(discoverthreejs: "built-in MSAA seems to be extremely cheap even on low-power mobile devices", 후처리 FXAA/SMAA보다 낫다고 함). [웹]
- 로우폴리는 실루엣이 직선이라 계단이 잘 보인다. "비율 1.5 + MSAA"(90만 픽셀)가 "비율 2 + AA 없음"(160만 픽셀)보다 싸면서 비슷하거나 낫다. → **medium/high는 AA 켬, low는 끔.** [추정: 실기기 비교 필요]
- 메모리 어림: 160만 픽셀 × (색 4 B + 깊이 4 B) × 4샘플 ≈ 51 MB + 리졸브 버퍼. 비율 상한이 곧 메모리 상한이다. [추정]

### 8.4 powerPreference · 기타

- `powerPreference: 'high-performance'`: 듀얼 GPU 노트북에서 외장 GPU를 고르게 하는 힌트다. 폰에서의 효과는 확인 못함. 게임이므로 켜 둔다(`engine.ts`에 이미 있음). [웹]
- 화면이 숨겨지면 렌더를 멈춘다(`document.hidden`). 타이틀/메뉴처럼 정지 화면이면 30 fps로 낮춰도 된다.
- 첫 프레임 끊김 줄이기: 로딩 화면에서 `await renderer.compileAsync(scene, camera)`로 셰이더를 미리 컴파일한다(가능하면 `KHR_parallel_shader_compile` 사용). [소스]
- 프레임마다 `gl.getError()`, `readPixels()`, `getParameter()`를 부르지 말 것(동기 대기 발생). [문서: MDN]

---

## 9. 이름표: DOM vs 스프라이트 vs 아틀라스 인스턴싱

| 방식 | 드로콜/비용 | 장점 | 한계 |
|---|---|---|---|
| DOM 오버레이(직접 `transform` 갱신 또는 `CSS2DRenderer`) | GPU 드로콜 0, 대신 라벨마다 매 프레임 스타일 변경 → 스타일/합성 비용 | 글자가 선명, 이모지·CSS 그대로, 접근성 | 수십 개부터 급격히 느려진다는 보고(drei `Html` 50개 초과 시 Chrome 5 fps 미만). 3D 물체 뒤로 가려지지 않음 |
| `Sprite` + 라벨별 `CanvasTexture` | **라벨 N개 = 드로콜 N + 텍스처 N** | 구현 단순 | 20개 넘기면 낭비 |
| **아틀라스 `CanvasTexture` 1장 + `InstancedMesh` 빌보드** | **드로콜 1, 텍스처 1** | 인원수와 무관, 깊이 테스트 됨 | 글자가 바뀔 때 아틀라스 재업로드, 커스텀 셰이더 필요 |
| troika-three-text 0.54.0 (SDF) | 텍스트 오브젝트당 드로콜 1 + 워커/번들 추가 | 확대해도 선명 | 우리에겐 과함 |

포럼 보고는 정황 증거이고 모바일 100개 기준의 공개 벤치마크는 찾지 못했다. [웹]

**권장**: 캐릭터 이름표·계급 칭호는 아틀라스 인스턴싱(아래 코드, r187에서 한글 렌더링 확인 [실측]). **DOM은 동시에 3~5개 이하인 것만**: 말풍선(대사·거절 멘트, 이모지 포함), 상호작용 프롬프트, 초대 카드. DOM 라벨은 `transform: translate3d(x, y, 0)`만 바꾸고(`left/top` 금지), 위치가 0.5 px 이상 변했을 때만 쓴다.

`CanvasTexture` 주의점 [소스][실측]:
- `needsUpdate = true`는 **텍스처 전체를 다시 올린다**(1024×512 RGBA = 2 MB). 글자가 바뀐 프레임에만, 프레임당 한 번.
- 기본값이 `generateMipmaps = true`, `minFilter = LinearMipmapLinearFilter`다. 자주 갱신하는 캔버스는 `generateMipmaps = false; minFilter = LinearFilter`.
- `colorSpace = SRGBColorSpace` 필수(§5.2). `flipY`는 기본 `true`라 아틀라스 UV의 v는 아래에서 위로 센다.
- 크기는 2의 거듭제곱이 아니어도 되지만(WebGL2) 2048 이하로 유지한다.
- 2D 캔버스 글꼴은 시스템 글꼴을 쓴다(`system-ui, "Apple SD Gothic Neo", "Noto Sans KR"`). 웹폰트를 쓸 거면 `await document.fonts.ready` 뒤에 그려야 대체 글꼴이 구워지지 않는다.

```ts
export class LabelAtlas {
  readonly mesh: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement; private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly uvRect: THREE.InstancedBufferAttribute;
  private readonly cols: number; private readonly rows: number;
  private readonly texts: string[] = [];
  private dirty = false;
  constructor(readonly slots: number, private readonly cellW = 256, private readonly cellH = 64, atlasSize = 1024) {
    this.cols = Math.floor(atlasSize / cellW); this.rows = Math.ceil(slots / this.cols);
    this.canvas = document.createElement('canvas');
    this.canvas.width = atlasSize; this.canvas.height = THREE.MathUtils.ceilPowerOfTwo(this.rows * cellH);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false; this.texture.minFilter = THREE.LinearFilter;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.uvRect = new THREE.InstancedBufferAttribute(new Float32Array(slots * 4), 4);
    geo.setAttribute('uvRect', this.uvRect);
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.texture }, worldSize: { value: new THREE.Vector2(2.4, 0.6) } },
      vertexShader: /* glsl */`
        attribute vec4 uvRect;            // xy = offset, zw = scale (아틀라스 UV)
        uniform vec2 worldSize;
        varying vec2 vUv;
        void main() {
          vUv = uvRect.xy + uv * uvRect.zw;
          // instanceMatrix 의 translation 만 사용해 카메라를 향하는 빌보드 구성
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mvPosition.xy += position.xy * worldSize;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(map, vUv);
          if (texel.a < 0.05) discard;
          gl_FragColor = texel;
          #include <colorspace_fragment>   // ShaderMaterial 은 이걸 넣어야 출력이 sRGB 로 변환됨
        }`,
      transparent: true, depthWrite: false, depthTest: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, material, slots);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 10; this.mesh.matrixAutoUpdate = false;
  }
  /** 텍스트가 바뀐 슬롯만 2D 캔버스에 다시 그림. 업로드는 flush() 에서 프레임당 최대 1회. */
  setText(slot: number, text: string, color = '#ffffff'): void {
    if (this.texts[slot] === text) return;
    this.texts[slot] = text;
    const cx = (slot % this.cols) * this.cellW, cy = Math.floor(slot / this.cols) * this.cellH;
    const ctx = this.ctx;
    ctx.clearRect(cx, cy, this.cellW, this.cellH);
    ctx.font = '700 34px system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, cx + this.cellW / 2, cy + this.cellH / 2, this.cellW - 12);
    ctx.fillStyle = color; ctx.fillText(text, cx + this.cellW / 2, cy + this.cellH / 2, this.cellW - 12);
    const W = this.canvas.width, H = this.canvas.height;
    // flipY=true(기본) 이므로 v 는 아래에서 위로: 셀의 아래쪽 모서리 = 1 - (cy + cellH)/H
    this.uvRect.setXYZW(slot, cx / W, 1 - (cy + this.cellH) / H, this.cellW / W, this.cellH / H);
    this.uvRect.needsUpdate = true;
    this.dirty = true;
  }
  setPosition(slot: number, x: number, y: number, z: number): void {
    _m.makeTranslation(x, y, z); this.mesh.setMatrixAt(slot, _m);
  }
  flush(count: number): void {
    this.mesh.count = Math.min(count, this.slots);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.dirty) { this.texture.needsUpdate = true; this.dirty = false; }   // 전체 아틀라스 재업로드(32슬롯 1024×512 ≈ 2MB, 64슬롯 1024×1024 ≈ 4MB) → 텍스트 변경 시에만
  }
}
```

---

## 10. WebGL 컨텍스트 유실

- 원인: 메모리 압박, 백그라운드 전환, GPU 프로세스 재시작, 컨텍스트 개수 초과. iOS 17 계열에서 사파리를 백그라운드로 보냈다 오면 유실되는 보고가 많았고(Safari 17.1에서 일부 수정), 이후 버전에서도 간헐 보고가 있다. Safari 27 릴리스 노트에는 "Fixed some WebGL context state properties not being correctly reset on context loss"가 있다. [웹][문서]
- three의 동작 [소스]: 캔버스의 `webglcontextlost`에서 `preventDefault()`를 호출하고(복구 허용), `webglcontextrestored`에서 GL 상태를 전부 다시 초기화한다. 지오메트리·텍스처는 JS 쪽 데이터가 남아 있으므로 다음 렌더 때 다시 올라간다.
- 실측(`renderer.forceContextLoss()` → `forceContextRestore()`): 유실 중 `render()`를 불러도 예외 없음, 복구 후 앱 코드 없이 `InstancedMesh`와 `CanvasTexture` 메시가 정상 픽셀로 다시 그려짐, `pixelRatio`·`outputColorSpace` 유지. [실측]
- 복구되지 않는 것: `WebGLRenderTarget`에 구워 둔 내용(초상화 캐시, 정적 섀도맵). 복구 콜백에서 다시 굽는다(`renderer.shadowMap.needsUpdate = true`).
- 앱이 할 일: ① 유실 중에는 렌더를 건너뛰되 네트워크·시뮬레이션은 계속 ② 복구 이벤트에서 리사이즈 한 번 ③ **3~5초 안에 복구되지 않으면 "화면을 다시 불러올게요" 버튼**(iOS에서는 복구 이벤트가 끝내 안 오는 경우가 보고됨) ④ WebGL 컨텍스트는 페이지당 **하나만** 만든다(초상화·임명장용으로 두 번째 `WebGLRenderer`를 만들지 않는다, §14.3).

```ts
export function watchContext(renderer: THREE.WebGLRenderer, onLost: () => void, onRestored: () => void): () => void {
  const canvas = renderer.domElement;
  // three 가 내부적으로 webglcontextlost 에 preventDefault() 를 호출하고, restored 에서 GL 상태를 재초기화한다.
  const lost = (): void => { onLost(); };
  const restored = (): void => { onRestored(); };
  canvas.addEventListener('webglcontextlost', lost, false);
  canvas.addEventListener('webglcontextrestored', restored, false);
  return () => { canvas.removeEventListener('webglcontextlost', lost, false); canvas.removeEventListener('webglcontextrestored', restored, false); };
}
```

---

## 11. iOS Safari 특이사항

### 11.1 뷰포트 · 안전 영역

- `100vh`는 주소창이 접힌 상태(큰 뷰포트) 기준이라 주소창이 펴져 있으면 아래가 잘린다. `100dvh`가 실제 보이는 높이다(Safari 15.4+). `height: 100vh; height: 100dvh;` 순서로 폴백을 둔다. `position: fixed; inset: 0`인 캔버스(현재 `base.css`)는 이 문제를 대부분 피한다. [웹: 널리 알려진 내용, 이번에 1차 출처 재확인은 안 함]
- **iOS 26**(떠 있는 하단 컨트롤): 뷰포트 크기의 fixed 컨테이너 아래에 틈이 생기는 버그가 있었고 **Safari 26.1에서 수정**("Fixed a bottom gap appearing on layouts with viewport-sized fixed containers on iOS", 158055568). 하단 컨트롤 아래로 내려간 fixed/sticky 콘텐츠가 그려지지 않는다는 보고도 있다(2025-09, 애플 답변 없음). → 중요한 버튼은 화면 맨 아래에 붙이지 말고 `env(safe-area-inset-bottom)` + 여유 12~16 px 위에 둔다. [문서: Safari 26.1 릴리스 노트][웹: Apple 개발자 포럼]
- `viewport-fit=cover` + `env(safe-area-inset-*)`로 노치/홈 인디케이터를 피한다(현재 `index.html`, `base.css`에 이미 반영).
- 입력창 글자 크기가 16 px 미만이면 포커스 때 화면이 자동 확대된다 → 닉네임·교단명 입력은 16 px 이상. [웹: 이번에 재확인 안 함]
- 화면 방향 잠금(`screen.orientation.lock`)은 iOS 사파리에서 기대할 수 없다 → 세로·가로 둘 다 동작하게 만든다(현재 `engine.ts`가 종횡비로 fov를 바꾸는 방식 유지). [웹: 이번에 재확인 안 함]

### 11.2 터치

- iOS 10부터 사파리는 `user-scalable=no`를 무시하고 핀치 줌을 허용한다. 막는 방법은 CSS다: 캔버스에 `touch-action: none`, 버튼에 `touch-action: manipulation`(더블탭 줌만 차단). 보조로 `gesturestart`에 `preventDefault()`(현재 `input.ts`에 있음). 절대 위치 요소에서 `touch-action: none`이 더블탭 줌을 못 막는다는 WebKit 버그(218015) 보고가 있으니 HUD 버튼에도 `manipulation`을 직접 준다. [웹]
- Pointer Events를 쓰고 `setPointerCapture()`로 조이스틱 포인터를 붙잡는다. **`pointercancel`을 반드시 처리**한다(시스템 제스처가 가로채면 `pointerup` 없이 끝난다 → 조이스틱이 눌린 채 남는 버그).
- 길게 누르기 메뉴·선택·탭 하이라이트 끄기: `-webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;`
- 페이지 스크롤·당겨서 새로고침 방지: `html, body { overflow: hidden; overscroll-behavior: none; }`(현재 반영됨).

```css
html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; }
#game { position: fixed; inset: 0; width: 100%; height: 100%; display: block;
        touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; outline: none; }
#ui button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.hud-bottom { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 14px); }
input, textarea { font-size: 16px; }   /* 포커스 자동 확대 방지 */
```

### 11.3 프레임 레이트

- **저전력 모드에서는 rAF가 30 fps**다. WebKit 엔지니어 답변: "This is intentional. In fact the behavior in iOS 13 was a bug." (버그 215745, RESOLVED INVALID). 2025-12 WebKit 커밋도 저전력 모드에서 약 30 fps로 도는 것을 전제로 한다. [문서: WebKit Bugzilla][웹]
- 대응: 이동·애니메이션·보간은 전부 delta 시간 기반(프레임 수 기반 금지), delta는 0.1초로 클램프, 자동 품질 조절이 30 Hz 고정을 "느림"으로 오판하지 않게 한다(§8.2).
- `navigator.hardwareConcurrency`는 WebKit에서 `코어 수 < 8 ? 4 : 8`이다(지문 방지). 아이폰은 6코어라 **항상 4**. `navigator.deviceMemory`는 Chromium 전용이라 사파리에서는 `undefined`. → 애플 기기는 이 두 값으로 사양을 판정하면 안 된다. [문서: WebKit `NavigatorBase.cpp` main 브랜치]

### 11.4 오디오

- `AudioContext`는 사용자 제스처 핸들러 **안에서** 만들거나 `resume()`해야 소리가 난다. 첫 `pointerup`/`touchend`/`keydown`에서 처리하고, 무음 버퍼를 한 번 재생해 확실히 연다. [웹]
- 앱 전환 후 돌아오면 컨텍스트가 `suspended`(또는 WebKit 고유의 `interrupted`)로 남는 보고가 있다 → `visibilitychange`에서 `resume()` 재시도 + 다음 제스처에서도 재시도(그래서 리스너를 `once`로 걸지 않는다). [웹: WebKit 버그 263627 등]
- 하드웨어 무음 스위치가 켜져 있으면 Web Audio가 안 들린다는 보고가 다수다(버전별 보고가 엇갈림). `navigator.audioSession.type = 'playback'`으로 바꿀 수 있다는 보고도 있으나 검증하지 못했다. 효과음 위주인 우리 게임은 **무음 스위치를 존중하는 기본 동작을 유지**하고, 설정 화면에 "소리가 안 나면 무음 모드를 확인하세요" 한 줄을 둔다. [웹][확인 못함]

```ts
export function installAudioUnlock(getCtx: () => AudioContext): void {
  const unlock = (): void => {
    const ctx = getCtx();                               // 반드시 제스처 핸들러 "안에서" 생성/resume
    if (ctx.state !== 'running') void ctx.resume();
    const src = ctx.createBufferSource(); src.buffer = ctx.createBuffer(1, 1, 22050); src.connect(ctx.destination); src.start(0);
  };
  for (const ev of ['pointerup', 'touchend', 'keydown'] as const) window.addEventListener(ev, unlock, { once: false, passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { const c = getCtx(); if (c.state !== 'running') void c.resume().catch(() => {}); } });
}
```

### 11.5 메모리

- iOS는 탭 메모리가 넘치면 페이지를 통째로 다시 로드한다. 가장 큰 덩어리는 드로잉 버퍼(§8.3 어림)이므로 **픽셀 비율 상한이 첫 번째 방어선**이다. 그다음이 캔버스 텍스처(아틀라스 ≤ 2048), WebGL 컨텍스트 1개 유지. [추정]

---

## 12. 안드로이드 저사양 GPU

- 안드로이드 저가 폰(Mali-G52 이하, Adreno 5xx/6xx 초반, PowerVR)은 전부 타일 기반 렌더러다. 병목은 대개 **픽셀 수와 오버드로**다. Qualcomm 2025-08 가이드도 중저가 Adreno에서 오버드로를 줄이고 셰이더를 단순화하면 전력·발열·프레임 페이싱이 좋아진다고 적는다. [웹]
  - 큰 반투명 면(안개 판, 화면을 덮는 파티클, 겹치는 블롭)을 피한다. 블롭은 캐릭터 발밑 크기로만.
  - 불투명 물체는 three가 재질별로 묶은 뒤 앞→뒤로 정렬해 그리므로(`sortObjects = true`, [소스]) 그대로 둔다. 인스턴스 메시 안의 인스턴스끼리는 정렬되지 않는다.
  - 프래그먼트 셰이더는 Lambert 수준 유지. 조명 2개(반구광 + 방향광).
- 정밀도: three는 `highp`를 기본으로 쓰고 기기가 지원하지 않으면 자동으로 내린다. MDN은 `mediump`가 모바일에서 렌더링 깨짐을 자주 일으킨다고 경고한다 → `precision: 'mediump'`를 일부러 주지 않는다. [소스][문서: MDN]
- three는 r157에서 Adreno 호환성 때문에 GLSL 구조체 `GeometricContext`를 제거했다. 구형 드라이버는 구조체·복잡한 제어 흐름에 약하다 → 커스텀 셰이더는 단순하게, three는 최신으로. [문서]
- 셰이더 컴파일이 느리다 → 재질 종류를 5개 안팎으로 유지(프로그램 수 = `renderer.info.programs.length`), 로딩 중 `compileAsync()`.
- 발열 스로틀링: 처음엔 60 fps가 나오다 몇 분 뒤 떨어진다. 자동 품질 조절은 시작 때 한 번이 아니라 **플레이 내내** 돌아야 한다. [추정]
- `navigator.deviceMemory`(Chromium 전용, GiB 단위의 거친 단계값)와 GPU 문자열(`WEBGL_debug_renderer_info`)로 초기 티어를 잡되, 8코어 저가 폰이 많아 코어 수는 약한 신호다. 최종 판정은 런타임 측정이다. [추정]
- 안드로이드 Firefox는 `WEBGL_multi_draw`가 없어 `BatchedMesh`가 인스턴스별 드로콜로 폴백한다(§6.4). [웹]
- 인앱 브라우저(카카오톡·인스타그램)는 안드로이드에서 시스템 WebView(Chromium), iOS에서 WKWebView를 쓴다. WebGL2 자체는 동작할 것으로 보지만 실기기 확인은 못 했다. [확인 못함]

---

## 13. 품질 티어 (low / medium / high)

출발값이다. 실기기 측정으로 조정해야 한다. [추정]

| 손잡이 | low | medium | high |
|---|---|---|---|
| 대상 | 구형·저가 안드로이드, 소프트웨어 렌더러 | 아이폰/중급 이상 폰 기본 | 데스크톱, 최상급 폰(수동 선택) |
| 픽셀 비율 상한 | 1.0 | 1.5 | 2.0 |
| 동적 해상도 하한 | 0.75 | 1.0 | 1.25 |
| `antialias`(생성 시 고정) | 끔 | 켬 | 켬 |
| 그림자 | 블롭 | 블롭 | 섀도맵 1024² `PCFShadowMap`(블롭 끔) |
| 목표 fps | 30(60 Hz에서 격프레임 렌더) | 60 | 60 |
| 가시 거리(`camera.far` = `fog.far`) | 45 m | 70 m | 110 m |
| 캐릭터 인스턴스 용량 | 80 | 160 | 320 |
| 이름표 슬롯 | 16(가까운 순) | 32 | 64 |
| DOM 말풍선 동시 표시 | 2 | 3 | 5 |
| 장식 소품 밀도 | 35% | 70% | 100% |
| 파티클 상한 | 64 | 192 | 512 |
| 먼 NPC 애니메이션 갱신 | 3프레임에 1번 | 2프레임에 1번 | 매 프레임 |

전환 규칙:
1. **시작 티어**: URL `?q=`(테스트용) → 저장된 사용자 설정 → 기기 추정(`guessTier()`), 렌더러 생성 후 GPU 문자열로 보정(`refineTier()`).
2. **런타임 1단계**: 동적 해상도가 티어 안에서 픽셀 비율을 조정(§8.2).
3. **런타임 2단계**: 하한에 붙은 채 5초 이상 예산을 넘기면 티어를 한 단계 내린다(가시 거리, 인스턴스 수, 소품 밀도 같은 "내용" 손잡이). `antialias`와 섀도맵 셰이더는 생성 시 고정이므로 high → medium 전환은 "섀도 끄기 + 블롭 켜기"로 처리하고 AA는 그대로 둔다.
4. 자동으로는 **내리기만** 하고, 올리기는 사용자가 설정에서 고른다(오르내림 반복 방지). 픽셀 비율만 자동으로 다시 올라간다.

```ts
export type Tier = 'low' | 'medium' | 'high';
export interface Quality {
  maxPixelRatio: number;      // DPR 상한
  minPixelRatio: number;      // 동적 해상도 하한
  antialias: boolean;         // 컨텍스트 생성 시에만 결정 가능 (런타임 변경 불가)
  sunShadow: boolean;         // 실제 섀도맵(방향광 1개) 사용 여부
  shadowMapSize: number;
  blobShadows: boolean;
  maxCharacters: number;      // 인스턴스 용량(플레이어+NPC)
  labelSlots: number;         // 아틀라스 라벨 수
  viewDistance: number;       // camera.far == fog.far
  targetFps: 30 | 60;
  propDensity: number;        // 0..1 장식 소품 밀도
}
export const QUALITY: Record<Tier, Quality> = {
  low:    { maxPixelRatio: 1.0, minPixelRatio: 0.75, antialias: false, sunShadow: false, shadowMapSize: 0,    blobShadows: true, maxCharacters: 80,  labelSlots: 16, viewDistance: 45,  targetFps: 30, propDensity: 0.35 },
  medium: { maxPixelRatio: 1.5, minPixelRatio: 1.0,  antialias: true,  sunShadow: false, shadowMapSize: 0,    blobShadows: true, maxCharacters: 160, labelSlots: 32, viewDistance: 70,  targetFps: 60, propDensity: 0.7 },
  high:   { maxPixelRatio: 2.0, minPixelRatio: 1.25, antialias: true,  sunShadow: true,  shadowMapSize: 1024, blobShadows: false, maxCharacters: 320, labelSlots: 64, viewDistance: 110, targetFps: 60, propDensity: 1.0 },
};

/** 렌더러를 만들기 "전에" 호출 (antialias 는 컨텍스트 생성 옵션이라 나중에 못 바꾼다). */
export function guessTier(): Tier {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const ua = navigator.userAgent;
  // iPadOS 는 데스크톱 UA(Macintosh)로 위장하므로 maxTouchPoints 로 구분
  const isApple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // WebKit 의 hardwareConcurrency 는 "코어 8개 미만이면 4, 아니면 8" 만 돌려준다(아이폰=6코어 → 항상 4).
  // deviceMemory 는 Chromium 전용. → 애플 기기는 코어/메모리로 판정하지 말고 medium 에서 시작해 런타임 측정으로 조정.
  if (isApple) return 'medium';
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (!coarse) return cores >= 8 ? 'high' : 'medium';
  if ((mem !== undefined && mem <= 3) || cores <= 4) return 'low';
  return 'medium';
}

/** 렌더러 생성 후 GPU 문자열로 보정 (소프트웨어 렌더러/구형 GPU → low). */
export function refineTier(renderer: THREE.WebGLRenderer, tier: Tier): Tier {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
  if (/Mali-(4|T[6-8])|Adreno \(TM\) [3-5]\d\d|PowerVR (SGX|Rogue G6)/i.test(name)) return 'low';
  if (renderer.capabilities.maxTextureSize < 4096) return 'low';
  return tier;
}
```

---

## 14. 헤드리스 Chromium으로 WebGL2 스크린샷 테스트

### 14.1 되는가 → 된다

환경: Playwright 1.63.0(npm 최신은 1.65.1) + 번들 Chromium 158.0.8127.36, 리눅스 x64, GPU 없음. [실측]

| 실행 방식 | 플래그 | WebGL2 | 렌더러 문자열 |
|---|---|---|---|
| headless shell(기본) | 없음 | 됨 | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` |
| headless shell | `--use-angle=swiftshader` | 됨 | 같음 |
| headless shell | `--enable-unsafe-swiftshader` | 됨 | 같음 |
| headless shell | `--use-gl=angle --use-angle=swiftshader --ignore-gpu-blocklist` | 됨 | 같음 |
| headless shell | `--ignore-gpu-blocklist` | 됨 | 같음 |
| headless shell | `--disable-gpu` | 됨 | 같음 |
| 풀 Chromium 새 헤드리스(`channel: 'chromium'`) | 위 조합 전부 | 됨 | 같음 |

- 모든 조합에서 `gl.getParameter(VERSION)` = `WebGL 2.0 (OpenGL ES 3.0 Chromium)`, `WEBGL_multi_draw` 지원, `maxTextureSize` 8192, MSAA `maxSamples` 4, `highp`.
- three r187로 병합 월드(버텍스 컬러) + `InstancedMesh`(`instanceColor`) + `BatchedMesh` + `Fog` + 섀도맵 + 커스텀 `ShaderMaterial` 빌보드 + 한글 `CanvasTexture`가 전부 정상 렌더링됐고 `gl.getError()`는 0이었다. 스크린샷을 눈으로 확인했다.
- **왜 플래그 없이 되나**: Playwright가 Chromium 실행 인자에 **`--enable-unsafe-swiftshader`를 기본으로 넣는다**(playwright-core 1.63 소스에서 확인). `--force-color-profile=srgb`도 기본 인자라 색이 실행 환경에 따라 흔들리지 않는다. [소스]
- 그 기본 인자를 `ignoreDefaultArgs`로 빼도 Chromium 158에서는 아직 SwiftShader로 폴백하지만 콘솔에 경고가 뜬다: *"Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader flag to opt in to lower security guarantees for trusted content."* [실측]
- Chromium 공식 문서(`docs/gpu/swiftshader.md`): 자동 폴백은 deprecated이고 "WebGL context creation will soon fail instead of falling back to SwiftShader". 옵트인 플래그가 `--enable-unsafe-swiftshader`. 문서에 적힌 조합은 ① 전체 GL 드라이버로: `--use-gl=angle --use-angle=swiftshader` ② WebGL 폴백으로만: `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`. 완전 제거 시점은 확인 못함. [문서]
- `--ignore-gpu-blocklist`는 GPU가 없는 환경에서는 결과에 차이가 없었다(실제 GPU가 있는데 차단 목록에 걸린 CI 러너용).

**권장 실행 인자**: Playwright를 쓰면 추가 플래그 없이 시작하고, Playwright 없이 Chrome을 직접 띄우는 스크립트(Puppeteer, `chrome --headless`)라면 `--enable-unsafe-swiftshader`를 명시한다. `--use-angle=swiftshader`를 주면 WebGL뿐 아니라 페이지 전체 그리기가 SwiftShader로 넘어가 CPU를 더 쓴다. 풀 Chromium(새 헤드리스) 실험에서 이 플래그가 있을 때 첫 프레임이 43~54 ms → 121~139 ms로 느려졌다(headless shell에서는 차이가 없었다). [실측]

참고(이 개발 샌드박스 한정): 여기 설치된 Chromium은 래퍼 스크립트가 `--use-angle=swiftshader*`, `--use-gl=angle` 인자를 기본으로 걸러낸다(`CHROMIUM_KEEP_GL_SWITCHES=1`로 해제). 그래서 위 표는 래퍼를 우회한 원본 바이너리로도 다시 돌려 같은 결과를 확인했다. [실측]

### 14.2 테스트를 흔들리지 않게 만드는 법

- 소프트웨어 렌더러에서는 GPU 문자열 보정(`refineTier`)이 `low`를 고른다 → 테스트는 **`?q=high`처럼 티어를 강제**한다.
- 난수는 시드 고정, 애니메이션 시간은 디버그 훅으로 고정(예: `?freeze=1.25`), 네트워크는 로컬 방 서버나 목으로.
- "N프레임 렌더 후 `window.__ready = true`"를 세우고 `page.waitForFunction`으로 기다린다. 첫 프레임은 셰이더 컴파일 때문에 45~75 ms 걸렸다.
- `viewport`와 `deviceScaleFactor`를 고정한다(Playwright의 `devices['iPhone 13']` = 뷰포트 390×664 @3x).
- 픽셀 완전 일치 대신 허용 오차(`maxDiffPixelRatio` 0.01~0.02)를 둔다. Chromium/SwiftShader 버전이 바뀌면 AA 경계 픽셀이 달라진다. [추정]
- 소프트웨어 렌더링 fps는 성능 지표가 아니다. 성능 회귀는 `renderer.info.render.calls/triangles`와 `renderer.info.programs.length`를 `window.__stats`로 내보내 **숫자로** 단언한다(예: 드로콜 ≤ 25).
- 실행 시간 참고: 시나리오당 페이지 열기~준비 완료 0.7~3초(섀도맵 high가 가장 느림). [실측]

```js
// tests/e2e 에서 쓸 수 있는 최소 형태 (실제로 돌려 본 스크립트를 줄인 것)
const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });          // 추가 GL 플래그 불필요
  const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5173/?q=high');
  await page.waitForFunction('window.__ready === true', null, { timeout: 60_000 });
  const stats = await page.evaluate('window.__stats');                // { calls, triangles, programs, tier, ... }
  if (stats.calls > 25) throw new Error('draw calls regressed: ' + stats.calls);
  await page.screenshot({ path: 'shot-iphone-high.png' });            // preserveDrawingBuffer 없이도 캔버스가 찍힌다
  if (errors.length) throw new Error(errors.join('\n'));
  await browser.close();
})();
```

### 14.3 캔버스 내용을 이미지로 뽑을 때 (`preserveDrawingBuffer` 없이)

임명장·초상화처럼 3D 결과를 2D 캔버스로 가져올 때 [실측]:

| 방법 | 결과 |
|---|---|
| `renderer.render()` 직후 **같은 태스크 안에서** `ctx2d.drawImage(glCanvas, …)` | 정상 픽셀 |
| 두 프레임 뒤에 `drawImage` | 투명(0,0,0,0) — 합성 후 버퍼가 비워진다 |
| `WebGLRenderTarget`(`samples: 4`, `texture.colorSpace = SRGBColorSpace`)에 렌더 → `readRenderTargetPixels()` 또는 `readRenderTargetPixelsAsync()` | 정상 sRGB 바이트. 화면 캔버스를 건드리지 않는다 |

→ **메인 렌더러 하나를 재사용**하고 `preserveDrawingBuffer`는 켜지 않는다. `engine.ts` 계약의 `portrait(look, size)`는 렌더 타깃 경로로 구현하는 것을 권한다(읽은 픽셀은 아래에서 위 순서이므로 `ImageData`에 넣을 때 행을 뒤집는다).

---

## 15. Vite 번들 · 트리셰이킹

저장소의 Vite 8.3.8(Rolldown)로 실측 [실측]:

| 빌드 | min | gzip -9 | brotli |
|---|---|---|---|
| 최소(`WebGLRenderer` + `Scene` + 카메라 + 박스 1개) | 525,679 B | 128,751 B | 105,761 B |
| 게임 전형(Fog, 조명 2종, Lambert, `InstancedMesh`, `CanvasTexture`, `Sprite`, `Timer`, `mergeGeometries`) — **`import * as THREE`** | 549,395 B | 134,271 B | 110,015 B |
| 같은 코드 — **이름 import** | 549,395 B (동일 해시) | 134,271 B | 110,015 B |
| 같은 코드, `build.target: 'es2020'` | 549,426 B | 134,321 B | 110,089 B |
| 이 문서의 레시피 전체(§5~§13) + 데모 | 557,061 B | 138,856 B | 113,759 B |
| 비교: `three/webgpu` 엔트리(더 적은 기능) | 817,019 B | 218,284 B | 177,001 B |

- `import * as THREE from 'three'`로 써도 손해가 없다(결과물이 바이트 단위로 같다). 편한 쪽을 쓴다.
- 바닥이 높은 이유: `WebGLRenderer`가 모든 내장 재질의 셰이더 청크를 끌고 온다. 우리 기능을 다 넣어도 바닥에서 gzip +5~10 kB뿐이다. **three 크기를 줄이려 애쓸 필요가 없고, 줄일 수도 없다.**
- 애드온은 `three/addons/…`에서 필요한 파일만 import한다. `three/addons`(배럴 `Addons.js`) 전체 import는 피한다. `three/src/…` 경로를 `three`와 섞어 쓰면 모듈이 두 벌 들어가 `instanceof`가 깨진다. [추정]
- three를 별도 청크로 떼면 게임 코드만 바뀐 배포에서 캐시가 유지된다. Vite 8에서는 `rolldownOptions.output.codeSplitting.groups`가 동작했고(`three-*.js` 547,948 B + 앱 1.4 kB로 분리 확인), `advancedChunks`는 "deprecated, please use codeSplitting" 경고가 나왔다. [실측]

```ts
// vite.config.ts 에 더할 부분 (Vite 8.3.8 에서 동작 확인)
build: {
  target: 'es2020',
  chunkSizeWarningLimit: 900,
  rolldownOptions: {
    output: { codeSplitting: { groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }] } },
  },
},
```

- 임명장 생성기처럼 가끔 쓰는 모듈은 `import()`로 지연 로드한다.
- 호스팅이 brotli를 주는지 확인한다(Cloudflare는 기본 제공). 첫 로드 JS는 three 110 kB + 게임 코드다.

---

## 16. 우리 게임에 적용할 것

### 16.1 지금 있는 코드에서 고칠 것 (`client/src/render/engine.ts`, `client/src/main.ts` 읽고 확인)

| # | 위치 | 문제 | 제안 |
|---|---|---|---|
| 1 | `guessQuality()` | 터치 기기에서 `cores <= 4`면 `low`. **아이폰은 WebKit이 항상 4를 돌려주므로 전 기종이 low**(픽셀 비율 1, AA 끔)로 시작해 레티나에서 뿌옇다 | 애플 기기(UA에 `iPhone`/`iPad`/`iPod`가 있거나, `Macintosh`이면서 `maxTouchPoints > 1`)는 `mid`에서 시작하고 런타임 측정에 맡긴다(§13 `guessTier`) |
| 2 | `watchPerformance()` | 평균 42 ms 초과가 두 번이면 티어를 내리기만 한다. 티어를 내려도 `antialias`는 생성 시 값 그대로다 | 먼저 동적 해상도(§8.2)로 픽셀 비율을 조정하고, 하한에서도 못 버틸 때만 티어를 내린다. 42 ms 기준은 저전력 모드 30 Hz(33.3 ms)를 오판하지 않으므로 유지해도 된다 |
| 3 | 카메라 `far = 320`, 안개 `fogFar = 150` | 안개로 안 보이는 150~320 m 구간도 절두체 컬링을 통과한다 | `camera.far = fogFar + 5~10`으로, 티어별 가시 거리와 연동 |
| 4 | `DEFAULT_SKY.fog = 0xf3d9d0`, 하늘 그라디언트 아래쪽 `0xffe2c4` | 먼 건물이 하늘과 다른 색으로 사라져 지평선에 띠가 보일 수 있다 | 안개 색을 그라디언트의 지평선 색과 맞춘다 |
| 5 | `resize()`가 `window.innerWidth/innerHeight` 사용 | iOS 주소창 접힘·키보드·분할 화면에서 캔버스 실제 크기와 어긋날 수 있다 | 캔버스 `clientWidth/clientHeight`를 `ResizeObserver`로 읽는다(§5.5 `startLoop`) |
| 6 | 컨텍스트 유실 처리 | 유실 중 렌더 중단 + 복구 시 리사이즈까지는 돼 있다 | 3~5초 안에 복구 안 되면 새로고침 안내 UI 추가. 렌더 타깃에 구운 것(초상화 캐시)이 생기면 복구 때 다시 굽는다 |
| 7 | `portrait(look, size)`(아직 스텁) | 두 번째 `WebGLRenderer`를 만들면 컨텍스트가 2개가 된다 | 메인 렌더러 + `WebGLRenderTarget`(sRGB) + `readRenderTargetPixels` (§14.3) |

이미 잘 돼 있는 것: 버전 고정(0.187.0), `outputColorSpace` 명시, 하늘 `CanvasTexture`에 `colorSpace = SRGBColorSpace`, `stencil: false`, `alpha: false`, 조명 2개와 π 보정된 밝기, `Clock` 미사용(rAF 타임스탬프 직접 사용), delta 0.1초 클램프, `document.hidden`일 때 프레임 건너뜀, `touch-action: none`·`overscroll-behavior: none`·안전 영역 변수·`gesturestart` 차단.

### 16.2 캐릭터 렌더러(`characters.ts`) 구현 지침

1. 부위별 `InstancedMesh`(§6.3 `InstancedParts`). 재질은 흰색 `MeshLambertMaterial({ flatShading: true })` 하나를 모든 부위가 공유, 색은 `setColorAt`.
2. 용량은 티어의 `maxCharacters`로 생성 시 고정. 매 프레임 "카메라 거리순으로 가까운 캐릭터부터" 슬롯 0..n-1에 채우고 `count = n`.
3. `frustumCulled = false`, `instanceMatrix.setUsage(DynamicDrawUsage)`를 첫 렌더 전에, 색은 스폰/의상 변경 때만 갱신.
4. 추종자 행렬(콩가 라인)도 같은 인스턴스 풀을 쓴다. 추종자 수가 늘어도 드로콜은 그대로다.
5. 애니메이션은 CPU에서 부위 로컬 행렬(걷기 흔들림, 팔 흔들기, 절하기)을 합성한다. 뼈대·스키닝·`AnimationMixer`는 쓰지 않는다.
6. 블롭 그림자(§7)와 이름표 아틀라스(§9)를 캐릭터 렌더러가 같이 소유해 같은 슬롯 번호를 쓴다.
7. 선택/탭 판정은 `pickGround()` 결과에서 반경 내 가장 가까운 캐릭터를 찾는다. `Raycaster`를 인스턴스 메시에 쓰지 않는다.

### 16.3 월드 렌더러(`world.ts`) 구현 지침

1. 모든 정적 지오메트리를 `paint()`로 색칠한 뒤 `mergeGeometries()`로 1~3개 메시로 병합(불투명 / 반투명 / 발광). 색은 반드시 `Color.setHex()`를 거친다.
2. 내장 지오메트리의 인덱스 유무가 섞여 있으므로 `toNonIndexed()`로 통일, `uv` 삭제.
3. 맵이 커지면 구역별로 나눠 병합(구역당 메시 1개)해 컬링을 살린다.
4. 간판 글자·현수막은 `CanvasTexture` 한 장(아틀라스)에 모아 재질 1개로 처리. `colorSpace = SRGBColorSpace`.
5. 텐트 깜빡임, 신호등 같은 "움직이는 정적 요소"는 병합에서 빼고 소수의 개별 메시로 둔다(재질 색/`visible` 토글).

### 16.4 엔진 공통

1. 렌더러 설정은 §5.1, 루프는 §5.5 형태. 조명은 반구광 + 방향광 고정.
2. 품질 티어는 §13 표를 `QualityTier` 계약에 맞춰 옮긴다(현 코드의 `mid` ↔ 이 문서의 `medium`).
3. 개발용 HUD에 드로콜·삼각형·프로그램 수·현재 픽셀 비율·티어 표시. `window.__stats`로도 내보내 e2e에서 단언.
4. `tests/e2e`에 §14.2 형태의 스크린샷 + 드로콜 단언을 넣는다(티어는 `?q=`로 강제).
5. three를 올릴 때는 `three`와 `@types/three`를 같은 번호로, 위키 Migration Guide를 읽고, e2e 스크린샷을 비교한다.

---

## 17. 함정 목록

1. 버텍스 컬러·인스턴스 컬러에 sRGB 수치를 직접 쓰면 허옇게 뜬다(128 → 188). 항상 `Color.setHex()`/`set()`을 거친 `.r/.g/.b`를 쓴다. [실측]
2. `CanvasTexture`(및 색을 담는 모든 텍스처)에 `colorSpace = SRGBColorSpace`를 빼먹으면 같은 증상. [실측]
3. `ShaderMaterial`에 `#include <colorspace_fragment>`를 안 넣으면 선형 값이 그대로 나가 어둡다. 안개도 직접 넣어야 받는다. [소스]
4. 움직이는 `InstancedMesh`가 화면에서 통째로 사라진다 → 경계 구가 낡았다. `frustumCulled = false` 또는 이동 후 `computeBoundingSphere()`. [실측]
5. `InstancedMesh`는 용량을 못 늘린다. `mesh.count`를 용량보다 크게 주면 안 된다(three는 검사하지 않는다). [소스]
6. `setUsage(DynamicDrawUsage)`를 첫 렌더 뒤에 부르면 효과가 없다. [소스]
7. `addUpdateRange(start, count)`의 단위는 배열 성분 수다(행렬은 인스턴스당 16). 옛 `updateRange` 객체는 r159에서 사라졌다. [소스][문서]
8. `mergeGeometries()`는 실패 시 예외가 아니라 `null`. 인덱스 유무 혼합(Box + Icosahedron), 어트리뷰트 불일치(한쪽에만 `uv`/`color`)가 원인. [소스]
9. `new THREE.Clock()` → r183부터 경고. `THREE.Timer` + `timer.connect(document)` + 프레임마다 `timer.update(time)`. [실측]
10. `THREE.PCFSoftShadowMap` → 경고 후 `PCFShadowMap`으로 바뀜. [실측]
11. `renderer.shadowMap.autoUpdate = false`만 해 두고 `needsUpdate = true`를 안 주면 그림자가 한 번도 안 그려진다. [소스]
12. 섀도맵은 드로콜과 삼각형을 대략 2배로 만든다. [실측]
13. `antialias`는 런타임에 못 바꾼다. 티어 전환 설계에 반영. [소스]
14. `Sprite`·`Mesh`는 개수만큼 드로콜이다. 이름표 100개를 `Sprite`로 만들지 않는다. [소스]
15. `CanvasTexture.needsUpdate = true`는 전체 재업로드. 매 프레임 켜지 않는다. [소스]
16. `matrixAutoUpdate = false`인 오브젝트의 `matrix`를 직접 고쳤다면 `matrixWorldNeedsUpdate = true`(r185). `updateMatrix()`를 쓰면 자동. [문서][소스]
17. `BatchedMesh`는 `WEBGL_multi_draw`가 없는 브라우저(Firefox)에서 인스턴스별 드로콜로 폴백한다. [소스][웹]
18. 아이폰의 `hardwareConcurrency`는 항상 4, `deviceMemory`는 없다. 사양 판정에 쓰지 않는다. [문서]
19. 아이폰 저전력 모드 = rAF 30 fps. 프레임 수 기반 애니메이션 금지, 자동 품질 조절의 오판 방지. [문서]
20. `user-scalable=no`는 iOS에서 무시된다. `touch-action`으로 막는다. `pointercancel` 처리를 빼먹으면 조이스틱이 눌린 채 남는다. [웹]
21. 오디오는 첫 제스처 안에서 `resume()`. 앱 전환 뒤 다시 막힐 수 있으니 리스너를 한 번만 걸지 않는다. [웹]
22. `preserveDrawingBuffer` 없이 캔버스를 이미지로 뽑으려면 렌더와 같은 태스크에서 복사하거나 렌더 타깃을 쓴다. [실측]
23. 렌더 타깃에 그린 결과를 바이트로 읽을 때 `texture.colorSpace = SRGBColorSpace`를 안 주면 선형 값이 나온다. r187부터 렌더 타깃이 묶인 상태의 `setViewport()`는 픽셀 비율을 곱하지 않는다. [실측][문서]
24. `failIfMajorPerformanceCaveat: true`, 프레임마다 `gl.getError()`/`readPixels()` 호출은 피한다. [문서: MDN][추정]
25. 헤드리스 테스트에서 GPU 문자열 기반 티어 보정이 `low`로 떨어진다. 테스트는 티어를 URL로 강제한다. [실측]
26. three는 SemVer가 아니다. `^0.187.0` 같은 캐럿 범위는 다음 마이너의 브레이킹 체인지를 그대로 받는다. [문서]

---

## 18. 확인하지 못한 것

- **실기기 성능 전부.** 프레임 시간, MSAA 실제 비용, 티어별 수치(가시 거리·인스턴스 용량·드로콜 예산)는 추정 출발값이다. 구형 안드로이드(Mali-G5x, Adreno 5xx/6xx)와 아이폰(일반/저전력 모드)에서 측정해야 한다.
- iOS 사파리에서 `powerPreference`가 실제로 무엇을 바꾸는지.
- iOS의 페이지당 WebGL 컨텍스트 개수 상한, 탭 메모리 상한의 구체 수치.
- 하드웨어 무음 스위치와 Web Audio의 현재(iOS 26/27) 동작, `navigator.audioSession.type = 'playback'`의 효과 — 보고가 서로 엇갈린다.
- iOS 26 "하단 컨트롤 아래 fixed 콘텐츠가 안 그려짐" 보고가 26.1 이후 해결됐는지(26.1 릴리스 노트의 "bottom gap" 수정과 같은 건인지 불명).
- 아이폰 ProMotion(120 Hz) 기기에서 사파리 rAF가 60으로 제한되는지 여부와 현재 기본값.
- 입력창 16 px 미만 자동 확대, `screen.orientation.lock` 미지원, `dvh` 지원 시작 버전(Safari 15.4)은 널리 알려진 내용이지만 이번 조사에서 1차 출처로 다시 확인하지는 않았다.
- 인스타그램·카카오톡 인앱 브라우저(WKWebView/Android WebView)에서의 WebGL2 동작과 성능 — 바이럴 유입 경로이므로 **출시 전 실기기 확인 필수**.
- Chromium이 SwiftShader 자동 폴백을 완전히 제거하는 버전(158에서는 아직 경고만).
- WebGPU 지원 현황의 Firefox 부분: web.dev(2025-11-25)는 Windows 141·macOS 145부터 지원이라고 쓰고, caniuse 표는 아직 "기본 비활성"으로 표기해 서로 다르다.
- DOM 라벨과 아틀라스 라벨의 모바일 정량 비교(공개 벤치마크 없음, 직접 측정 안 함).
- r186 릴리스 노트의 "WebGLRenderer: Support Node Materials in `compile()`"가 예고하는 WebGLRenderer의 제한적 노드 재질 지원 범위.

---

## 19. 출처

직접 실행·조회:
- `npm view three version` / `dist-tags` / `time`, `npm view @types/three …`, `npm view playwright version` (2026-11-26)
- 저장소 `node_modules/three@0.187.0` 소스: `src/renderers/WebGLRenderer.js`, `src/renderers/webgl/{WebGLCapabilities,WebGLProgram,WebGLPrograms,WebGLObjects,WebGLAttributes,WebGLShadowMap,WebGLBackground,WebGLRenderLists,WebGLBufferRenderer}.js`, `src/objects/{InstancedMesh,BatchedMesh}.js`, `src/core/{Timer,Clock,BufferAttribute,InstancedBufferAttribute,Object3D}.js`, `src/math/{Color,ColorManagement,Frustum}.js`, `src/textures/{Texture,CanvasTexture}.js`, `src/scenes/{Fog,FogExp2}.js`, `src/lights/*`, `examples/jsm/utils/BufferGeometryUtils.js`
- `playwright-core@1.63.0` 소스(Chromium 기본 실행 인자)
- 실험 스크립트와 스크린샷: 세션 임시 폴더 `/tmp/claude-0/-home-user-Bug-arena/5d9aed2a-d9b6-565c-8ef8-6ff87e511c45/scratchpad/research-threejs-mobile/` (`exp/` 플래그 매트릭스·함정 검증, `ts/` 레시피 타입체크·데모, `bundle/` 번들 크기). 임시 폴더라 지워질 수 있다. 필요한 코드는 이 문서에 전부 실었다.

읽은 웹 문서:
- three.js Migration Guide (위키): https://github.com/mrdoob/three.js/wiki/Migration-Guide (원문: https://raw.githubusercontent.com/wiki/mrdoob/three.js/Migration-Guide.md)
- three.js r187 릴리스 노트: https://github.com/mrdoob/three.js/releases/tag/r187
- three.js r186 릴리스 노트: https://github.com/mrdoob/three.js/releases/tag/r186
- three.js 매뉴얼 "WebGPURenderer": https://threejs.org/manual/pages/webgpurenderer.html
- three.js 포럼 "Updates to lighting in three.js r155": https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733
- Chromium "Using Chromium with SwiftShader": https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
- Playwright "Browsers"(헤드리스 셸과 새 헤드리스 모드): https://playwright.dev/docs/browsers
- MDN "WebGL best practices": https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- MDN "WEBGL_multi_draw": https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_multi_draw
- caniuse WebGL 2: https://caniuse.com/webgl2 · WebGPU: https://caniuse.com/webgpu
- web.dev "WebGPU is now supported in major browsers"(2025-11-25): https://web.dev/blog/webgpu-supported-major-browsers
- WebKit 버그 215745 "Throttling requestAnimationFrame to 30 FPS in low power mode": https://bugs.webkit.org/show_bug.cgi?id=215745
- WebKit 소스 `NavigatorBase.cpp`(`hardwareConcurrency`): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/NavigatorBase.cpp
- Safari 26.0 / 26.1 / 26.2 / 26.4 / 27 릴리스 노트: https://developer.apple.com/documentation/safari-release-notes/safari-26_1-release-notes (같은 경로의 `safari-26-…`, `safari-26_2-…`, `safari-26_4-…`, `safari-27-…`)
- Apple 개발자 포럼 "iOS 26 Safari will not render position: fixed content below the browser controls": https://developer.apple.com/forums/thread/800798
- Apple 개발자 포럼 "New IOS Safari CSS Issue with DVH & VH": https://developer.apple.com/forums/thread/803987
- Discover three.js "Tips and Tricks": https://discoverthreejs.com/tips-and-tricks/

검색 결과 요약으로만 본 것(본문 정독 안 함, 정황 근거로만 사용):
- three.js 포럼의 이름표 성능 스레드들: https://discourse.threejs.org/t/how-to-create-lots-of-optimized-2d-text-labels/66927 , https://discourse.threejs.org/t/many-html-elements-from-three-js-fiber-drei-causes-low-framerate-in-chrome/28540
- iOS 컨텍스트 유실 보고: https://discourse.threejs.org/t/context-lost-when-backgrounding-safari-on-ios-17-developer-beta-8/55772 , https://bugs.webkit.org/show_bug.cgi?id=261331
- iOS 오디오 관련 WebKit 버그: https://bugs.webkit.org/show_bug.cgi?id=263627 , https://bugs.webkit.org/show_bug.cgi?id=237322
- iOS 줌 방지 관련: https://bugs.webkit.org/show_bug.cgi?id=218015 , https://webkit.org/?p=7367
- caniuse `WEBGL_multi_draw`: https://caniuse.com/mdn-api_webgl_multi_draw
- Blink "Intent to Remove: SwiftShader Fallback": https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM
- Qualcomm "Optimize performance and graphics for Adreno GPU low-power gaming"(2025-08): https://www.qualcomm.com/developer/blog/2025/08/optimize-performance-and-graphics-for-adreno-gpu-low-power-gaming
