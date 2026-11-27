/**
 * 예능 자막 — 화면 아래쪽에 잠깐 뜨는 '제작진 자막'.
 *
 * 문법 3가지(조사 문서 03 §2.1):
 *  - 감정이입: 교주의 속마음을 대신 말해 준다 (whisper)
 *  - 과장 칭호: 사소한 일에 거창한 이름을 붙인다 (pop)
 *  - 건조한 사실 보도: 숫자만 담담하게 적는다 (gungseo)
 *
 * 규칙: 자막이 놀리는 대상은 언제나 '플레이어 자신(교주 지망생)'이다. 시민이나 다른 플레이어를 깎아내리지 않는다.
 * 자막은 당사자 화면에만 뜬다. '{n}' 은 숫자로 바뀌며, min 이 있는 항목(연속 기록, 행렬 인원)에서만 쓴다.
 */

export type CaptionStyle = 'gungseo' | 'pop' | 'whisper'

export interface CaptionDef {
  /** '{n}' 자리에 숫자가 들어간다 */
  text: string
  style: CaptionStyle
  /** n 이 이 값 이상일 때만 후보 */
  min?: number
}

export type CaptionKey =
  | 'join'
  | 'king'
  | 'more'
  | 'reject'
  | 'flee'
  | 'ignore'
  | 'failStreak'
  | 'winStreak'
  | 'rankUp'
  | 'patrolAlert'
  | 'patrolCaught'
  | 'patrolEscape'
  | 'duelWin'
  | 'duelLose'
  | 'followerLeft'
  | 'firstFollower'
  | 'bigEntourage'
  | 'idle'

export const CAPTION_KEYS: readonly CaptionKey[] = [
  'join',
  'king',
  'more',
  'reject',
  'flee',
  'ignore',
  'failStreak',
  'winStreak',
  'rankUp',
  'patrolAlert',
  'patrolCaught',
  'patrolEscape',
  'duelWin',
  'duelLose',
  'followerLeft',
  'firstFollower',
  'bigEntourage',
  'idle',
]

/** 자막 한 줄 최대 글자 수(모바일 세로 화면 한 줄) */
export const CAPTION_MAX_LEN = 28

export const CAPTIONS: Record<CaptionKey, readonly CaptionDef[]> = {
  join: [
    { text: '…왜 따라오는 거지? (교주도 당황)', style: 'whisper' },
    { text: '예상 밖의 전개', style: 'pop' },
    { text: '말이 통했다. 본인이 제일 놀람', style: 'gungseo' },
    { text: '교주, 오늘 처음으로 쓸모 있었다', style: 'gungseo' },
    { text: '(이 멘트가 먹힌다고?)', style: 'whisper' },
    { text: '전설의 시작 (아마도)', style: 'pop' },
    { text: '행렬 한 칸 늘었습니다', style: 'gungseo' },
  ],
  king: [
    { text: '전생 감별사 교주, 왕을 찾아내다', style: 'pop' },
    { text: '(아무 말이나 했는데 왕이 나옴)', style: 'whisper' },
    { text: '오늘의 대발견: 전생에 왕', style: 'gungseo' },
    { text: '왕을 모시게 된 교주의 표정 관리', style: 'pop' },
    { text: '역사학계 긴장 (안 함)', style: 'whisper' },
    { text: '이 골목, 왕족 밀집 지역이었다', style: 'gungseo' },
  ],
  more: [
    { text: '…어? 들어 준다고?', style: 'whisper' },
    { text: '2라운드 진출', style: 'pop' },
    { text: '기회는 왔다. 멘트는 없다', style: 'gungseo' },
    { text: '(머릿속 대본 급하게 넘기는 중)', style: 'whisper' },
    { text: '교주 인생 최장 대화 기록 경신 중', style: 'pop' },
    { text: '심장 박동 상승 중', style: 'gungseo' },
  ],
  reject: [
    { text: '깔끔하게 거절당했다', style: 'gungseo' },
    { text: '교주는 오늘도 말을 걸었다', style: 'gungseo' },
    { text: '거절 장인의 길', style: 'pop' },
    { text: '(괜찮아… 원래 그런 거야…)', style: 'whisper' },
    { text: '교주, 표정은 아직 웃고 있다', style: 'pop' },
    { text: '멘트 회수 실패', style: 'gungseo' },
    { text: '(다음 사람은 다를 거야)', style: 'whisper' },
  ],
  flee: [
    { text: '교주, 의도치 않은 육상 코치 등극', style: 'pop' },
    { text: '한 문장으로 사람을 달리게 하는 재능', style: 'gungseo' },
    { text: '(내 멘트가 그렇게 무서웠나)', style: 'whisper' },
    { text: '오늘의 기록: 상대방 출발 0.2초', style: 'gungseo' },
    { text: '바람만 남았다', style: 'pop' },
    { text: '(뒤통수에 대고 마저 말해 본다)', style: 'whisper' },
  ],
  ignore: [
    { text: '투명 인간 체험 중', style: 'gungseo' },
    { text: '교주, 배경이 되다', style: 'pop' },
    { text: '(분명 소리 내서 말했는데…)', style: 'whisper' },
    { text: '존재감 절전 모드', style: 'pop' },
    { text: '들리지 않는 목소리의 주인공', style: 'gungseo' },
    { text: '(혹시 내가 유령인가)', style: 'whisper' },
  ],
  failStreak: [
    { text: '거절 {n}연속 | 리듬을 탔다', style: 'gungseo', min: 3 },
    { text: '{n}연속 거절. 아직 웃는 중', style: 'pop', min: 3 },
    { text: '(셋까지는 괜찮아… 괜찮아…)', style: 'whisper', min: 3 },
    { text: '거절 {n}연속 | 이쯤 되면 재능', style: 'gungseo', min: 5 },
    { text: '{n}연속 거절, 이제 즐기기 시작', style: 'pop', min: 5 },
    { text: '(전단지라도 돌려 볼까…)', style: 'whisper', min: 5 },
    { text: '거절 {n}연속 | 기록을 세우는 중', style: 'gungseo', min: 10 },
    { text: '{n}연속 거절의 주인공, 전설이 되다', style: 'pop', min: 10 },
    { text: '(이 정도면 거절이 나를 따라온다)', style: 'whisper', min: 10 },
  ],
  winStreak: [
    { text: '{n}연속 합류 | 교주 컨디션 최상', style: 'gungseo', min: 3 },
    { text: '{n}연속! 오늘 말발 무슨 일', style: 'pop', min: 3 },
    { text: '(이러다 진짜 교주 되는 거 아냐?)', style: 'whisper', min: 3 },
    { text: '{n}연속 합류 | 골목의 신흥 강자', style: 'gungseo', min: 5 },
    { text: '{n}연속, 교주 어깨 하늘 찌름', style: 'pop', min: 5 },
    { text: '(겸손… 겸손해야 해…)', style: 'whisper', min: 5 },
  ],
  rankUp: [
    { text: '속보) 수상한 행인, 조금 더 수상해져', style: 'pop' },
    { text: '승급했다. 달라진 건 명함뿐', style: 'gungseo' },
    { text: '(직함이 길어질수록 수상해진다)', style: 'whisper' },
    { text: '경축! 아무도 축하 안 함', style: 'pop' },
    { text: '교주 인생, 한 계단 올라가다', style: 'gungseo' },
    { text: '(엄마한테는 비밀로 하자)', style: 'whisper' },
  ],
  patrolAlert: [
    { text: '단속반 등장. 교주, 품위를 버리다', style: 'gungseo' },
    { text: '삐익—! 교주 심장도 삐익—!', style: 'pop' },
    { text: '(못 본 척… 못 본 척…)', style: 'whisper' },
    { text: '지금부터 육상 경기 시작', style: 'pop' },
    { text: '포교 활동, 급히 추격전으로 장르 변경', style: 'gungseo' },
    { text: '(나 아니고 저 사람이에요)', style: 'whisper' },
  ],
  patrolCaught: [
    { text: '교주, 훈방 조치되다', style: 'gungseo' },
    { text: '체포는 아니고 잔소리입니다', style: 'pop' },
    { text: '(신도들이 모르는 척 흩어진다)', style: 'whisper' },
    { text: '3초간 반성 중 (진심 아님)', style: 'pop' },
    { text: '오늘의 교훈: 살살 하자', style: 'gungseo' },
    { text: '(이 장면 아무도 못 봤기를)', style: 'whisper' },
  ],
  patrolEscape: [
    { text: '따돌렸다! 교주, 다리는 일류', style: 'pop' },
    { text: '포교 실력은 몰라도 도망은 장인', style: 'gungseo' },
    { text: '(헉… 헉… 운동 좀 해야겠다)', style: 'whisper' },
    { text: '골목의 바람, 교주', style: 'pop' },
    { text: '전력 질주 끝에 얻은 것: 자유와 땀', style: 'gungseo' },
    { text: '(지금이 인생 최고 속도였다)', style: 'whisper' },
  ],
  duelWin: [
    { text: '말로 이겼다. 논리로는 진 것 같지만', style: 'gungseo' },
    { text: '허세 대결 승리!', style: 'pop' },
    { text: '(내가 방금 뭐라고 한 거지)', style: 'whisper' },
    { text: '더 황당한 쪽이 이긴다. 교주, 해냈다', style: 'gungseo' },
    { text: '뻔뻔함 레벨 업', style: 'pop' },
    { text: '(이 승리, 자랑할 데가 없다)', style: 'whisper' },
  ],
  duelLose: [
    { text: '말로는 졌다. 표정은 이겼다', style: 'gungseo' },
    { text: '허세에서 밀렸다', style: 'pop' },
    { text: '(저 사람… 고수다…)', style: 'whisper' },
    { text: '오늘의 패배: 덜 황당했던 죄', style: 'gungseo' },
    { text: '교주, 수행이 더 필요하다', style: 'pop' },
    { text: '(다음엔 더 아무 말이나 하자)', style: 'whisper' },
  ],
  followerLeft: [
    { text: '신도 1명이 정신을 차렸습니다', style: 'gungseo' },
    { text: '행렬 한 칸 줄었습니다', style: 'pop' },
    { text: '(잘 가… 좋은 하루 보내…)', style: 'whisper' },
    { text: '교주, 뒤를 돌아봤다. 허전하다', style: 'gungseo' },
    { text: '이별도 포교의 일부', style: 'pop' },
    { text: '(사실 나도 이유를 모르겠어)', style: 'whisper' },
  ],
  firstFollower: [
    { text: '역사적인 첫 신도', style: 'pop' },
    { text: '교주 인생 첫 행렬, 길이 한 명', style: 'gungseo' },
    { text: '(뒤에 누가 있다… 진짜로…)', style: 'whisper' },
    { text: '오늘부터 1인 교단 탈출', style: 'pop' },
    { text: '이 순간을 기념하는 박수 (혼자)', style: 'gungseo' },
    { text: '(침착해. 당연하다는 듯이 걷자)', style: 'whisper' },
  ],
  bigEntourage: [
    { text: '행렬 {n}명 | 교주 어깨 각도 상승', style: 'gungseo', min: 4 },
    { text: '{n}명 대행렬! 골목이 좁아진다', style: 'pop', min: 4 },
    { text: '(뒤를 돌아보면 사람이 {n}명)', style: 'whisper', min: 4 },
    { text: '행렬 {n}명 | 교통 체증 유발 중', style: 'gungseo', min: 4 },
    { text: '{n}명이 줄줄이, 이거 실화냐', style: 'pop', min: 4 },
    { text: '(어디로 가는지는 나도 모른다)', style: 'whisper', min: 4 },
  ],
  idle: [
    { text: '교주가 가만히 있습니다. 불안합니다', style: 'whisper' },
    { text: '명상 중 (사실 멍 때리는 중)', style: 'gungseo' },
    { text: '교주, 잠시 인생을 돌아보다', style: 'gungseo' },
    { text: '정지 화면 아닙니다', style: 'pop' },
    { text: '(다음 멘트 고민 40초째)', style: 'whisper' },
    { text: '움직이지 않는 교주, 기운을 모으는 척', style: 'pop' },
  ],
}

/**
 * 키와 숫자로 자막 하나를 고른다. pool 은 min 조건을 만족하는 것 중
 * '가장 높은 단계(min)'만 남긴다 → 10연속이면 10단계 자막이 나온다.
 * 같은 상황이 반복돼도 계속 바뀌도록 (counter + n) 으로 돌려 가며 고른다.
 */
export function pickCaption(key: CaptionKey, n: number, counter: number): { text: string; style: CaptionStyle } | null {
  const all = CAPTIONS[key]
  let pool = all.filter((c) => (c.min ?? 0) <= n)
  if (pool.length === 0) return null
  const top = Math.max(...pool.map((c) => c.min ?? 0))
  pool = pool.filter((c) => (c.min ?? 0) === top)
  const c = pool[Math.abs(Math.floor(counter + n)) % pool.length]!
  return { text: c.text.split('{n}').join(String(n)), style: c.style }
}
