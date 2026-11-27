// 런타임 설정. 클라이언트(이 폴더의 정적 파일)만 다른 곳에 올리고 실시간 서버를 따로 둘 때 여기만 고치면 된다.
//   server: 실시간 서버 주소. 빈 문자열이면 이 페이지와 같은 주소를 쓴다.
//           예) 'https://doas-server.example.com'  (https → wss 로 자동 변환)
window.DOAS_CONFIG = {
  server: '',
}
