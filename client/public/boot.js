// 게임이 시작하다 멈추면(3D 를 켤 수 없는 기기, 아주 오래된 브라우저 등) 끝없이 도는 대신 이유를 알려 준다.
// 첫 화면(#boot)이 아직 떠 있는 동안에만 동작한다. 먼저 불린 안내가 남는다.
;(function () {
  window.__bootFail = function (msg) {
    var b = document.getElementById('boot')
    if (!b || b.className === 'fail') return
    b.className = 'fail'
    b.querySelector('span').textContent = msg || '게임을 불러오다 문제가 생겼어요. 새로고침하거나 크롬·사파리 최신 버전에서 열어 주세요.'
    b.querySelector('a').textContent = '다시 시도'
  }
  window.addEventListener('error', function () {
    window.__bootFail()
  })
  window.addEventListener('unhandledrejection', function () {
    window.__bootFail()
  })
  // <script type="module"> 을 모르는 아주 오래된 브라우저
  if (!('noModule' in document.createElement('script'))) {
    window.__bootFail('이 브라우저는 너무 오래돼서 게임을 열 수 없어요. 크롬·사파리 최신 버전에서 열어 주세요.')
  }
})()
