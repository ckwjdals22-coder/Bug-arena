/**
 * 황당한 업적 / 일일 수행. stat 은 shared/content/core.ts 의 STAT 키만 쓴다(그 밖의 통계는 서버가 올리지 않는다).
 *
 * 작성 원칙(왜 이렇게 썼는가):
 * - 실패·무시·도망에도 업적을 준다. 못해도 수집할 거리가 생기고, 놀림의 대상은 언제나 교주 본인이다.
 * - desc 는 "조건 + 한 줄 농담" 순서. 조건이 먼저 와야 비밀이 아닌 업적의 달성 방법을 읽을 수 있다.
 * - streak / failStreak 는 '현재 값'이라 오르내린다. 업적은 최고 기록(bestStreak / worstStreak)만 본다.
 * - worstStreak 는 10까지만 둔다. 연속 실패마다 동정표(+3.5%)가 붙어 그 이상은 사실상 나오지 않는다.
 * - id 는 저장본(Progress.ach)에 남으므로 한번 내보낸 id 는 바꾸지 않는다. 새 업적은 뒤에 추가한다.
 * - 길이 제한: name 14자, desc 44자(알림 토스트와 업적 목록 한 줄에 들어가게).
 */
import type { AchievementDef, DailyQuestDef } from './types'

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // ── 신도 수(누적 합류) ──
  { id: 'first_join', name: '첫 신도', desc: '첫 번째 신도를 얻었다. 왜 따라오는지는 본인도 모른다.', icon: '🐣', stat: 'joins', gte: 1, inf: 5 },
  { id: 'fol10', name: '조별과제 조장', desc: '신도 10명. 조별과제 조원보다 말을 잘 듣는다.', icon: '👥', stat: 'joins', gte: 10, inf: 15 },
  { id: 'fol50', name: '중견 교단', desc: '신도 50명 확보. 단체 사진은 가로로 찍어야 한다.', icon: '🏛️', stat: 'joins', gte: 50, inf: 60 },
  { id: 'fol200', name: '대형 교단', desc: '신도 200명. 이제 이름은 못 외운다.', icon: '🏟️', stat: 'joins', gte: 200, inf: 100 },
  { id: 'fol1000', name: '천 명의 행렬', desc: '신도 1000명. 수상역 유동 인구를 넘어섰다.', icon: '🌏', stat: 'joins', gte: 1000, inf: 150, secret: true },

  // ── 거절 ──
  { id: 'reject10', name: '거절 입문', desc: '거절 10회. 아직은 얼굴이 화끈거린다.', icon: '🙈', stat: 'rejects', gte: 10, inf: 10 },
  { id: 'reject100', name: '거절 수집가', desc: '거절 100회. 거절 멘트만 모아 책을 낼 수 있다.', icon: '🙅', stat: 'rejects', gte: 100, inf: 50 },
  { id: 'reject500', name: '거절의 대가', desc: '거절 500회. 이제 거절을 들어야 하루가 시작된다.', icon: '🗿', stat: 'rejects', gte: 500, inf: 120, secret: true },

  // ── 연속 실패 / 연속 성공 ──
  { id: 'fail5', name: '오늘은 날이 아니다', desc: '포교 5번 연속 실패. 기운 탓으로 돌리기로 했다.', icon: '🌧️', stat: 'worstStreak', gte: 5, inf: 10 },
  { id: 'fail10', name: '철벽 앞의 수행자', desc: '포교 10번 연속 실패. 일부러 해도 어려운 기록이다.', icon: '🧱', stat: 'worstStreak', gte: 10, inf: 20 },
  { id: 'streak3', name: '삼연타', desc: '3번 연속 포교 성공. 본인이 제일 놀랐다.', icon: '🎯', stat: 'bestStreak', gte: 3, inf: 15 },
  { id: 'streak7', name: '말이 통하는 날', desc: '7번 연속 성공. 오늘따라 인상이 정말 좋은가 보다.', icon: '🔥', stat: 'bestStreak', gte: 7, inf: 40 },
  { id: 'streak12', name: '숨만 쉬어도 신도', desc: '12번 연속 성공. 시민들이 먼저 줄을 선다.', icon: '🌟', stat: 'bestStreak', gte: 12, inf: 100, secret: true },

  // ── 도망 / 무시 ──
  { id: 'flee1', name: '첫 번째 뒷모습', desc: '시민이 전력 질주로 도망쳤다. 출발 자세가 좋았다.', icon: '💨', stat: 'flees', gte: 1, inf: 5 },
  { id: 'flee30', name: '육상부 코치', desc: '시민 30명을 달리게 했다. 동네 평균 기록이 올랐다.', icon: '🏃', stat: 'flees', gte: 30, inf: 30 },
  { id: 'flee100', name: '인간 출발 신호', desc: '100명이 도망쳤다. 입만 열면 다들 뛴다.', icon: '🏁', stat: 'flees', gte: 100, inf: 60, secret: true },
  { id: 'ignore10', name: '투명 인간', desc: '10번 무시당했다. 혹시 내가 안 보이나?', icon: '👻', stat: 'ignores', gte: 10, inf: 10 },
  { id: 'ignore50', name: '공기 같은 존재', desc: '50번 무시당했다. 존재감이 0에 수렴한다.', icon: '🌫️', stat: 'ignores', gte: 50, inf: 40 },

  // ── 전생의 왕 ──
  { id: 'king1', name: '전하, 여기 계셨군요', desc: '전생의 왕을 처음 발견했다. 본인도 몰랐다고 한다.', icon: '🤴', stat: 'kings', gte: 1, inf: 10 },
  { id: 'king3', name: '왕실 전문가', desc: '전생의 왕 3명 발견. 왕이 생각보다 흔하다.', icon: '👑', stat: 'kings', gte: 3, inf: 30 },
  { id: 'king10', name: '왕이 너무 많다', desc: '전생의 왕 10명 발견. 그 나라는 누가 다스렸나.', icon: '🏰', stat: 'kings', gte: 10, inf: 80, secret: true },

  // ── 라이벌 교주 ──
  { id: 'rival1', name: '동종 업계 종사자', desc: '라이벌 교주를 처음 만났다. 서로 전단지를 교환했다.', icon: '🤝', stat: 'rivals', gte: 1, inf: 10 },
  { id: 'rival10', name: '업계 모임', desc: '라이벌 교주를 10번 만났다. 이 거리엔 교주가 너무 많다.', icon: '📇', stat: 'rivals', gte: 10, inf: 30 },
  { id: 'rivalwin1', name: '기싸움 첫 승', desc: '기싸움에서 처음 이겼다. 더 황당한 쪽이 이기는 법.', icon: '😤', stat: 'rivalWins', gte: 1, inf: 20 },
  { id: 'rivalwin5', name: '허세의 정점', desc: '기싸움 5승. 이제 상대가 먼저 눈을 피한다.', icon: '🦚', stat: 'rivalWins', gte: 5, inf: 60 },

  // ── 고양이 ──
  { id: 'cat1', name: '야옹?', desc: '고양이에게 포교를 시도했다. 대답은 야옹이었다.', icon: '🐈', stat: 'catTalks', gte: 1, inf: 5 },
  { id: 'cat20', name: '고양이 대화 전문가', desc: '고양이에게 20번 말을 걸었다. 대화가 성립한 적은 없다.', icon: '🐾', stat: 'catTalks', gte: 20, inf: 30, secret: true },
  { id: 'cat_join', name: '간택', desc: '고양이가 합류했다. 당신이 고른 게 아니다.', icon: '😼', stat: 'catJoins', gte: 1, inf: 150, secret: true },

  // ── 동작 / 춤 / 말풍선 ──
  { id: 'emote30', name: '몸이 먼저 말한다', desc: '동작 30번 사용. 말보다 손이 빠르다.', icon: '🙆', stat: 'emotes', gte: 30, inf: 10 },
  { id: 'emote300', name: '인간 풍선 인형', desc: '동작 300번. 가게 앞에 세워 두면 손님이 온다.', icon: '🎈', stat: 'emotes', gte: 300, inf: 50, secret: true },
  { id: 'dance10', name: '신비로운 몸짓', desc: '춤 10번. 신비롭다는 건 본인 생각이다.', icon: '💃', stat: 'dances', gte: 10, inf: 15 },
  { id: 'dance100', name: '춤신춤왕', desc: '춤 100번. 아무도 시키지 않았다.', icon: '🕺', stat: 'dances', gte: 100, inf: 60 },
  { id: 'say20', name: '말풍선 애호가', desc: '말풍선 20번. 정해진 말만으로도 할 말은 많다.', icon: '💬', stat: 'says', gte: 20, inf: 10 },
  { id: 'say200', name: '말이 많다', desc: '말풍선 200번. 듣는 사람은 없었다.', icon: '📢', stat: 'says', gte: 200, inf: 50, secret: true },

  // ── 단상: 계시 / 집단 설교 ──
  { id: 'prophecy1', name: '첫 계시', desc: '단상에서 첫 계시를 발표했다. 내용은 당연했다.', icon: '📜', stat: 'prophecies', gte: 1, inf: 10 },
  { id: 'prophecy10', name: '받아 적어', desc: '계시 10번 발표. 받아 적은 사람은 0명이다.', icon: '✍️', stat: 'prophecies', gte: 10, inf: 30 },
  { id: 'prophecy50', name: '걸어 다니는 달력', desc: '계시 50번. 내일이 오늘 다음 날인 걸 또 맞혔다.', icon: '📅', stat: 'prophecies', gte: 50, inf: 80, secret: true },
  { id: 'sermon1', name: '마이크 테스트', desc: '첫 집단 설교를 열었다. 하나 둘, 하나 둘.', icon: '🎤', stat: 'sermonsLed', gte: 1, inf: 15 },
  { id: 'sermon5', name: '떼창의 왕', desc: '설교 5번 주최. 후창이 선창보다 컸다.', icon: '🎶', stat: 'sermonsLed', gte: 5, inf: 50 },
  { id: 'sermonjoin1', name: '분위기에 휩쓸림', desc: '남의 설교에 참여했다. 정신 차려 보니 외치고 있었다.', icon: '🙌', stat: 'sermonsJoined', gte: 1, inf: 10 },
  { id: 'sermonjoin10', name: '프로 맞장구꾼', desc: '설교 10번 참여. "믿습니다"가 반사적으로 나온다.', icon: '👏', stat: 'sermonsJoined', gte: 10, inf: 40 },

  // ── 포교 배틀 ──
  { id: 'battle1', name: '이게 종목이 되네', desc: '포교 배틀 첫 참가. 누가 만든 종목인지는 모른다.', icon: '🥊', stat: 'battles', gte: 1, inf: 10 },
  { id: 'battlewin1', name: '첫 판정승', desc: '포교 배틀 첫 승리. 그 순간만큼은 제일 수상했다.', icon: '🏆', stat: 'battleWins', gte: 1, inf: 20 },
  { id: 'battlewin10', name: '입으로 이김', desc: '포교 배틀 10승. 논리는 없었다. 기세였다.', icon: '🥇', stat: 'battleWins', gte: 10, inf: 100 },

  // ── 헌납품 ──
  { id: 'offer1', name: '첫 헌납품', desc: '첫 헌납품을 받았다. 쓸모는 없지만 마음은 받았다.', icon: '🎁', stat: 'offerings', gte: 1, inf: 10 },
  { id: 'offer30', name: '잡동사니 박물관', desc: '헌납품 30개. 창고가 필요하다. 창고도 헌납받자.', icon: '📦', stat: 'offerings', gte: 30, inf: 40 },
  { id: 'offer100', name: '잡동사니 재벌', desc: '헌납품 100개. 전부 합쳐도 쓸모가 없다.', icon: '🧺', stat: 'offerings', gte: 100, inf: 100 },

  // ── 단속반 / 도망 ──
  { id: 'caught1', name: '거기 서!', desc: '단속반에게 처음 붙잡혔다. 얼어붙은 채로 잠깐 반성했다.', icon: '🚨', stat: 'caught', gte: 1, inf: 5 },
  { id: 'caught5', name: '단속반의 단골', desc: '5번 붙잡혔다. 단속반이 이름을 외웠다.', icon: '📝', stat: 'caught', gte: 5, inf: 30, secret: true },
  { id: 'escape1', name: '줄행랑', desc: '단속반을 처음 따돌렸다. 다리가 교리보다 빨랐다.', icon: '👟', stat: 'escapes', gte: 1, inf: 15 },
  { id: 'escape10', name: '도망도 실력', desc: '단속반을 10번 따돌렸다. 포교보다 달리기가 늘었다.', icon: '🌬️', stat: 'escapes', gte: 10, inf: 60 },
  { id: 'sprint20', name: '유산소 포교', desc: '도망가기 20번. 운동을 겸하는 건강한 교주.', icon: '🦵', stat: 'sprints', gte: 20, inf: 10 },
  { id: 'sprint200', name: '달리는 교단', desc: '도망가기 200번. 포교한 시간보다 달린 시간이 길다.', icon: '🌪️', stat: 'sprints', gte: 200, inf: 50, secret: true },

  // ── 교단(실제 접속자와의 상호작용) ──
  { id: 'cult_made', name: '창립 기념일', desc: '교단을 창설했다. 신도가 0명이어도 창립은 창립이다.', icon: '⛺', stat: 'cultsMade', gte: 1, inf: 20 },
  { id: 'invite5', name: '명함 돌리기', desc: '교단 가입 제안 5번. 거절당해도 명함은 남는다.', icon: '💌', stat: 'invites', gte: 5, inf: 10 },
  { id: 'recruit1', name: '1호 교단원', desc: '실제 접속자가 내 교단에 들어왔다. 진짜 사람이다!', icon: '🤗', stat: 'recruits', gte: 1, inf: 30 },
  { id: 'recruit5', name: '어엿한 조직', desc: '교단원 5명 영입. 이제 회식 장소를 정해야 한다.', icon: '🍽️', stat: 'recruits', gte: 5, inf: 80 },
  { id: 'joined1', name: '일단 가입', desc: '남의 교단에 가입했다. 탈퇴는 언제든 자유다.', icon: '🚪', stat: 'joinedCults', gte: 1, inf: 10 },
  { id: 'joined3', name: '철새', desc: '교단에 3번 가입했다. 믿음은 가볍게, 발걸음도 가볍게.', icon: '🐦', stat: 'joinedCults', gte: 3, inf: 30, secret: true },

  // ── 출석 ──
  { id: 'day2', name: '또 오셨네요', desc: '이틀째 접속. 어제 그 수상한 사람이 맞다.', icon: '👀', stat: 'days', gte: 2, inf: 10 },
  { id: 'day7', name: '출근 도장', desc: '7일 접속. 이 게임에는 개근했다. 회사는?', icon: '📆', stat: 'days', gte: 7, inf: 50 },
  { id: 'day30', name: '수상역 터줏대감', desc: '30일 접속. 역 앞 비둘기들이 먼저 인사한다.', icon: '🏠', stat: 'days', gte: 30, inf: 150, secret: true },

  // ── 신도 빼앗기 ──
  { id: 'poach1', name: '상도덕 실종', desc: '남의 신도를 데려왔다. 영업 구역이 겹쳤을 뿐이다.', icon: '😈', stat: 'poaches', gte: 1, inf: 15 },
  { id: 'poach10', name: '이적 시장의 큰손', desc: '남의 신도 10명 영입. 업계에 소문이 났다.', icon: '🧲', stat: 'poaches', gte: 10, inf: 60, secret: true },

  // ── 말 걸기 / 멘트 ──
  { id: 'talk100', name: '말 걸기 장인', desc: '100번 말을 걸었다. 낯가림은 전생에 두고 왔다.', icon: '🗣️', stat: 'talks', gte: 100, inf: 30 },
  { id: 'pitch500', name: '멘트 자판기', desc: '멘트 500번. 누르면 나온다. 품절은 없다.', icon: '📻', stat: 'pitches', gte: 500, inf: 80, secret: true },
]

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))

/**
 * 일일 수행. 혼자서 5~10분 안에 끝낼 수 있는 것만 둔다.
 * - 다른 접속자가 있어야 하는 통계(배틀, 초대, 남의 설교 참여)나 운에 크게 좌우되는 통계
 *   (전생의 왕, 라이벌, 고양이·단속반 등장)는 넣지 않는다. 못 끝내는 숙제는 스트레스일 뿐이다.
 * - '현재 값' 통계(streak 류)와 접속 일수(days)는 하루 동안의 증가량으로 셀 수 없어 쓰지 않는다.
 * - id 는 DailyState 에 저장되므로 바꾸지 않는다.
 */
export const DAILY_QUESTS: readonly DailyQuestDef[] = [
  { id: 'd_pitch5', text: '시민 5명에게 말 걸기', stat: 'talks', n: 5, inf: 15 },
  { id: 'd_join2', text: '신도 2명 모으기', stat: 'joins', n: 2, inf: 20 },
  { id: 'd_dance3', text: '신비로운 춤 3번 추기', stat: 'dances', n: 3, inf: 10 },
  { id: 'd_talk12', text: '시민 12명에게 말 걸기', stat: 'talks', n: 12, inf: 25 },
  { id: 'd_join5', text: '신도 5명 모으기', stat: 'joins', n: 5, inf: 30 },
  { id: 'd_pitch10', text: '멘트 10번 날리기', stat: 'pitches', n: 10, inf: 20 },
  { id: 'd_reject5', text: '당당하게 5번 거절당하기', stat: 'rejects', n: 5, inf: 15 },
  { id: 'd_reject10', text: '거절 10번 꿋꿋하게 견디기', stat: 'rejects', n: 10, inf: 25 },
  { id: 'd_flee1', text: '시민 1명 달리게 만들기', stat: 'flees', n: 1, inf: 15 },
  { id: 'd_ignore1', text: '한 번 시원하게 무시당하기', stat: 'ignores', n: 1, inf: 10 },
  { id: 'd_emote10', text: '동작 10번 해 보이기', stat: 'emotes', n: 10, inf: 10 },
  { id: 'd_say5', text: '말풍선 5번 띄우기', stat: 'says', n: 5, inf: 10 },
  { id: 'd_prophecy2', text: '단상에서 계시 2번 발표', stat: 'prophecies', n: 2, inf: 15 },
  { id: 'd_sermon1', text: '집단 설교 1번 열기', stat: 'sermonsLed', n: 1, inf: 25 },
  { id: 'd_offer3', text: '헌납품 3개 받기', stat: 'offerings', n: 3, inf: 20 },
  { id: 'd_sprint3', text: '도망가기 3번 쓰기', stat: 'sprints', n: 3, inf: 10 },
]

export const DAILY_QUEST_BY_ID: ReadonlyMap<string, DailyQuestDef> = new Map(DAILY_QUESTS.map((q) => [q.id, q]))

/** 하루에 뽑히는 수행 개수 */
export const DAILY_QUEST_COUNT = 3
