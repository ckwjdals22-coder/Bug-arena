/**
 * 오늘의 계시 / 집단 설교 구호 / 계시를 들은 주변 반응.
 * [콘텐츠 작성자가 확장할 파일] 지금은 최소 예시만 들어 있다.
 */
import type { SermonChant } from './types'

export const PROPHECIES: readonly string[] = [
  '내일은 오늘보다 하루 뒤입니다.',
  '배고픈 자에게 치킨이 찾아올지어다.',
  '월요일을 견딘 자, 화요일을 맞이하리라.',
  '신도들이여, 오늘 저녁 메뉴는 김치찌개다!',
]

export const SERMON_CHANTS: readonly SermonChant[] = [
  { call: '퇴근을 믿습니까?', resp: '믿습니다!' },
  { call: '야식은 죄가 아닙니다!', resp: '아닙니다!' },
  { call: '월요일은 물러가라!', resp: '물러가라!' },
]

/** 계시를 들은 주변 캐릭터의 반응 말풍선 */
export const PROPHECY_REACTIONS: readonly string[] = ['오오…!', '믿습니다!', '…네?', '역시 교주님!', '받아 적어야지.']

/** 설교를 구경하는 NPC 반응 */
export const SERMON_CHEERS: readonly string[] = ['믿습니다!', '오오오!', '말이 되는 것 같기도…', '박수 쳐야 하나?']
