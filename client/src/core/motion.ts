/**
 * '움직임 줄이기'(prefers-reduced-motion) 설정을 자바스크립트로 움직이는 연출에도 적용하기 위한 창구.
 * CSS 애니메이션은 각 스타일시트의 @media 규칙이 맡고, 여기서는 카메라 흔들기·말풍선 튀어나오기 같은 코드 연출을 줄인다.
 */
let reduced = false
try {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  reduced = mq.matches
  mq.addEventListener('change', (e) => {
    reduced = e.matches
  })
} catch {
  /* matchMedia 가 없는 환경: 줄이지 않는다 */
}

export function reducedMotion(): boolean {
  return reduced
}
