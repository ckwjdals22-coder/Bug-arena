/**
 * 포교 멘트. id 는 배열 인덱스와 같아야 한다(순서 변경 금지, 뒤에 추가만).
 * [콘텐츠 작성자가 확장할 파일] 지금은 최소 예시만 들어 있다.
 */
import type { PitchLine } from './types'

export const PITCH_LINES: readonly PitchLine[] = [
  { id: 0, text: '도를 아십니까?', cat: 'dao', rank: 0, power: 0 },
  { id: 1, text: '혹시 인상이 좋다는 말 들어보셨어요?', cat: 'face', rank: 0, power: 0.02 },
  { id: 2, text: '제가 관상을 조금 볼 줄 아는데요.', cat: 'face', rank: 0, power: 0 },
  { id: 3, text: '잠깐이면 됩니다. 정말 1분만요.', cat: 'time', rank: 0, power: -0.03, fleeBias: 0.25 },
  { id: 4, text: '전생에 아주 귀한 분이셨습니다.', cat: 'past', rank: 0, power: 0.03 },
  { id: 5, text: '오늘 저를 만난 건 우연이 아닙니다.', cat: 'fate', rank: 0, power: 0 },
  { id: 6, text: '혹시 조상님께서 꿈에 나오신 적 있나요?', cat: 'ancestor', rank: 0, power: 0.02 },
  { id: 7, text: '오늘부터 좋은 기운을 받아 가세요.', cat: 'energy', rank: 0, power: 0.01 },
]
