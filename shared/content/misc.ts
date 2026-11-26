/**
 * 말풍선(퀵챗), 닉네임 생성 재료, 로딩 팁, 라이벌 기싸움, 안내 문구.
 * [콘텐츠 작성자가 확장할 파일] 지금은 최소 예시만 들어 있다.
 */
import type { DuelDef, QuickChat } from './types'

/** id 는 배열 인덱스와 같아야 한다 */
export const QUICK_CHATS: readonly QuickChat[] = [
  { id: 0, text: '도를 아십니까?', icon: '🙏', rank: 0 },
  { id: 1, text: '인상이 참 좋으시네요!', icon: '😊', rank: 0 },
  { id: 2, text: '저 지금 바빠요!', icon: '🏃', rank: 0 },
  { id: 3, text: '믿습니다!', icon: '🙌', rank: 0 },
  { id: 4, text: '저희 교단으로 오세요~', icon: '📣', rank: 0 },
  { id: 5, text: 'ㅋㅋㅋㅋㅋ', icon: '🤣', rank: 0 },
]

/** 임의 닉네임 = 형용사 + 명사 (합쳐서 NAME_MAX 이하가 되도록 짧게) */
export const NICK_ADJ: readonly string[] = ['수상한', '졸린', '배고픈', '해맑은', '끈질긴', '은밀한']
export const NICK_NOUN: readonly string[] = ['행인', '도사', '전도사', '비둘기', '김밥', '교주']

export const LOADING_TIPS: readonly string[] = [
  '시민에게 다가가 "말 걸기"를 눌러 보세요.',
  '직장인에게 "1분만요"는 금기어입니다.',
  '이 게임의 모든 교단은 허구입니다. 현실 포교는 정중히 사양하세요.',
]

export const DUELS: readonly DuelDef[] = [
  {
    say: '저는 숨만 쉬어도 기운이 모입니다. 그쪽은요?',
    choices: ['저도 숨은 쉽니다만…', '저는 숨을 안 쉬어도 모입니다.', '죄송합니다, 지나갈게요.'],
    win: [1],
    winText: '수… 숨을 안 쉬고도?! 제가 졌습니다, 형님!',
    loseText: '허허, 아직 수행이 부족하시군요.',
  },
]

/** 타이틀 화면 하단 고지 */
export const DISCLAIMER =
  '이 게임의 모든 교단·인물·교리는 허구이며 풍자 코미디입니다. 실존 종교·단체·인물과 무관하고, 실제 포교·금전 요구·개인정보 수집을 하지 않습니다.'
