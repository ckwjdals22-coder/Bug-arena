/**
 * 포교 멘트. id 는 배열 인덱스와 같아야 한다(순서 변경 금지, 뒤에 추가만).
 *
 * 작성 원칙 — 왜 이렇게 썼는가
 * - 웃음거리는 항상 교주(플레이어)다. 굳은 길거리 문장("도를 아십니까", "인상이 좋으세요",
 *   "기운이 맑으시네요", "조상님이…")은 앞 구절만 빌리고, 같은 문장 안에서 생활 소재로 꺾는다.
 *   그대로 길에서 써먹을 수 있는 문장이면 안 된다(현실 권유 화법을 가르치지 않는다).
 * - 불안을 건드리지 않는다(액운·건강·가족·돈·촉박함 금지). 신상 묻기, 연락처, 자리 옮기기,
 *   의식, 설문·심리 테스트 사칭 같은 '실제 수법의 다음 단계'도 멘트로 만들지 않는다.
 * - fleeBias 가 붙은 멘트는 "이러면 시민이 전력 질주한다"는 개그다: 질척임("1분만요"),
 *   부담스러운 응시·접근, 끝없는 장광설. 대체로 power 도 낮아서 게임이 끈질김에 벌점을 준다.
 * - 직급이 오를수록 허세가 커지되 반드시 하찮은 디테일로 무너진다(5직급 = 우주급 허세).
 *   능력이 아니라 민망함이 커지는 방향이다.
 * - 길이 34자 이하(버튼·말풍선에 그대로 들어간다). 소재(cat)마다 직급 0 멘트가 3개 이상이라
 *   처음 온 사람도 매번 다른 4지선다를 본다.
 *
 * id 0~7 은 제품 명세의 예시 멘트라 문구·id 를 그대로 둔다.
 */
import type { PitchLine } from './types'

export const PITCH_LINES: readonly PitchLine[] = [
  // ───────── 명세 원본 (변경 금지) ─────────
  { id: 0, text: '도를 아십니까?', cat: 'dao', rank: 0, power: 0 },
  { id: 1, text: '혹시 인상이 좋다는 말 들어보셨어요?', cat: 'face', rank: 0, power: 0.02 },
  { id: 2, text: '제가 관상을 조금 볼 줄 아는데요.', cat: 'face', rank: 0, power: 0 },
  { id: 3, text: '잠깐이면 됩니다. 정말 1분만요.', cat: 'time', rank: 0, power: -0.03, fleeBias: 0.25 },
  { id: 4, text: '전생에 아주 귀한 분이셨습니다.', cat: 'past', rank: 0, power: 0.03 },
  { id: 5, text: '오늘 저를 만난 건 우연이 아닙니다.', cat: 'fate', rank: 0, power: 0 },
  { id: 6, text: '혹시 조상님께서 꿈에 나오신 적 있나요?', cat: 'ancestor', rank: 0, power: 0.02 },
  { id: 7, text: '오늘부터 좋은 기운을 받아 가세요.', cat: 'energy', rank: 0, power: 0.01 },

  // ───────── 직급 0 — 어설프고 자신 없는 멘트 ─────────
  { id: 8, text: '도를 아십니까? 레는요? 미는요?', cat: 'dao', rank: 0, power: 0.02 },
  { id: 9, text: '도를 아십니까? 모르셔도 됩니다. 저도 어제 알았어요.', cat: 'dao', rank: 0, power: 0.03 },
  { id: 10, text: '도를 아십… 아니, 혹시 이 근처 화장실 아십니까?', cat: 'dao', rank: 0, power: -0.02 },
  { id: 11, text: '도를… (말없이 5초간 쳐다본다)', cat: 'dao', rank: 0, power: -0.08, fleeBias: 0.3 },
  { id: 12, text: '인상이 참 좋으시네요. 특히 왼쪽 콧구멍이요.', cat: 'face', rank: 0, power: 0.02 },
  { id: 13, text: "얼굴에 '집에 가고 싶다'고 쓰여 있네요.", cat: 'face', rank: 0, power: 0.04 },
  { id: 14, text: '인상이 좋으세요. (얼굴 10cm 앞까지 다가간다)', cat: 'face', rank: 0, power: -0.08, fleeBias: 0.35 },
  { id: 15, text: '전생에 줄을 아주 잘 서던 분이셨어요.', cat: 'past', rank: 0, power: 0.02 },
  { id: 16, text: '전생에 저랑 같은 반이었어요. 3분단이요.', cat: 'past', rank: 0, power: 0.03 },
  { id: 17, text: '전생에 비둘기셨죠? 저는 그 옆 참새였고요.', cat: 'past', rank: 0, power: 0.01 },
  { id: 18, text: '전생 얘기, 3시간이면 다 해 드립니다.', cat: 'past', rank: 0, power: -0.06, fleeBias: 0.3 },
  { id: 19, text: "조상님이 전해 달래요. '이불 좀 개라'고요.", cat: 'ancestor', rank: 0, power: 0.03 },
  { id: 20, text: '조상님이 꿈에서 와이파이 비번 물으시던가요?', cat: 'ancestor', rank: 0, power: 0.03 },
  { id: 21, text: '조상님 말씀이, 냉장고 속 반찬 오늘 드시래요.', cat: 'ancestor', rank: 0, power: 0.02 },
  { id: 22, text: '조상님 얘기, 족보 32권부터 시작할게요.', cat: 'ancestor', rank: 0, power: -0.06, fleeBias: 0.3 },
  { id: 23, text: '기운이 참 맑으시네요. 배터리는 12%지만요.', cat: 'energy', rank: 0, power: 0.03 },
  { id: 24, text: '기운이 남다르세요. 어제 일찍 주무셨죠?', cat: 'energy', rank: 0, power: 0.03 },
  { id: 25, text: '기운을 나눠 드릴게요. 저도 얼마 없지만요.', cat: 'energy', rank: 0, power: 0.02 },
  { id: 26, text: '기운을 드릴게요. (양손을 뻗으며 다가간다)', cat: 'energy', rank: 0, power: -0.08, fleeBias: 0.35 },
  { id: 27, text: '1분이면 됩니다. 길어지면 제가 도망갈게요.', cat: 'time', rank: 0, power: 0.03 },
  { id: 28, text: '30초만요. 하나, 둘… 어디 가세요?', cat: 'time', rank: 0, power: -0.04, fleeBias: 0.3 },
  { id: 29, text: '딱 5분만요. 아까 그 1분은 맛보기였어요.', cat: 'time', rank: 0, power: -0.06, fleeBias: 0.35 },
  { id: 30, text: '시간 괜찮으세요? 저는 하루 종일 괜찮은데.', cat: 'time', rank: 0, power: 0, fleeBias: 0.15 },
  { id: 31, text: '바쁘시죠? 저도 바쁜 척하는 중입니다.', cat: 'time', rank: 0, power: 0.03 },
  { id: 32, text: '우연이 아닙니다. 제가 20분 기다렸거든요.', cat: 'fate', rank: 0, power: 0, fleeBias: 0.2 },
  { id: 33, text: '눈 마주쳤죠? 운명입니다. 아니면 신호 대기.', cat: 'fate', rank: 0, power: 0.03 },
  { id: 34, text: '우연이 아니죠. 벌써 세 번째 마주쳤습니다.', cat: 'fate', rank: 0, power: -0.04, fleeBias: 0.25 },
  { id: 35, text: '오늘 만날 운명이었어요. 일기예보에 나왔어요.', cat: 'fate', rank: 0, power: 0.02 },
  { id: 36, text: '안드로메다에서 부재중 전화가 와 있습니다.', cat: 'cosmic', rank: 0, power: 0.03 },
  { id: 37, text: '외계인이 팔로우했는데 맞팔을 안 하셨더라고요.', cat: 'cosmic', rank: 0, power: 0.03 },
  { id: 38, text: '우주의 기운이 당신을… 아, 옆 사람이네요.', cat: 'cosmic', rank: 0, power: 0 },
  { id: 39, text: '방금 우주에서 문자가 왔어요. 스팸이네요.', cat: 'cosmic', rank: 0, power: 0.02 },
  { id: 40, text: '지금 교신 중입니다. 삐— 삐리릭— (팔이 안테나)', cat: 'cosmic', rank: 0, power: -0.08, fleeBias: 0.4 },

  // ───────── 직급 1 — 말은 늘었는데 내용이 없다 ─────────
  { id: 41, text: '도를 아십니까? 태권도 말고요.', cat: 'dao', rank: 1, power: 0.03 },
  { id: 42, text: '도를 아십니까? 오늘은 영상 4도입니다.', cat: 'dao', rank: 1, power: 0.02 },
  { id: 43, text: '도를 아십니까? 도돌이표라 다시 묻습니다.', cat: 'dao', rank: 1, power: 0, fleeBias: 0.15 },
  { id: 44, text: '인상이 좋으세요. 저는 어떤가요? …네, 알겠습니다.', cat: 'face', rank: 1, power: 0.04 },
  { id: 45, text: "관상이 딱 '택배 기다리는 상'이시네요.", cat: 'face', rank: 1, power: 0.04 },
  { id: 46, text: '전생에 왕이셨어요. 저는 그 옆 화분이었고요.', cat: 'past', rank: 1, power: 0.06 },
  { id: 47, text: '전생에도 이 길을 걸으셨어요. 그때도 바쁘셨죠.', cat: 'past', rank: 1, power: 0.04 },
  { id: 48, text: '전생에도 도망가셨어요. 그때도 빠르셨죠.', cat: 'past', rank: 1, power: -0.04, fleeBias: 0.3 },
  { id: 49, text: "조상님이 꿈에서 '물 좀 마셔라' 하시던데요.", cat: 'ancestor', rank: 1, power: 0.04 },
  { id: 50, text: '조상님도 월요일은 싫어하셨답니다.', cat: 'ancestor', rank: 1, power: 0.05 },
  { id: 51, text: '조상님이 양말은 뒤집어 벗지 말라십니다.', cat: 'ancestor', rank: 1, power: 0.03 },
  { id: 52, text: '기운이 맑으시네요. 정수기 필터 갈았어요?', cat: 'energy', rank: 1, power: 0.04 },
  { id: 53, text: '좋은 기운이 느껴져요. 아, 붕어빵 냄새네요.', cat: 'energy', rank: 1, power: 0.04 },
  { id: 54, text: '기운 측정 중… 가만히 3분만 계세요.', cat: 'energy', rank: 1, power: -0.03, fleeBias: 0.25 },
  { id: 55, text: '1분만요. 제 시계는 좀 느리게 갑니다.', cat: 'time', rank: 1, power: 0, fleeBias: 0.2 },
  { id: 56, text: '본부가 바로 앞입니다. 저 돗자리요.', cat: 'time', rank: 1, power: -0.08, fleeBias: 0.4 },
  { id: 57, text: '우연도 세 번이면 운명이죠. 지금이 1회차고요.', cat: 'fate', rank: 1, power: 0.04 },
  { id: 58, text: "오늘 운세 보셨어요? '귀인'이 저예요.", cat: 'fate', rank: 1, power: 0.05 },
  { id: 59, text: '옷깃만 스쳐도 인연인데, 저는 반소매네요.', cat: 'fate', rank: 1, power: 0.04 },
  { id: 60, text: "외계인도 한국말을 배웁니다. '빨리빨리'부터요.", cat: 'cosmic', rank: 1, power: 0.04 },
  { id: 61, text: '달에서 보면 우리 다 점입니다. 점끼리 친해져요.', cat: 'cosmic', rank: 1, power: 0.05 },

  // ───────── 직급 2 — 장비와 자신감만 늘었다 ─────────
  { id: 62, text: '도를 아십니까? 도넛까지는 제가 압니다.', cat: 'dao', rank: 2, power: 0.05 },
  { id: 63, text: '도를 통달했습니다. 어제 영상으로 배웠어요.', cat: 'dao', rank: 2, power: 0.06 },
  { id: 64, text: '이마에서 빛이 납니다. 아, 가로등이네요.', cat: 'face', rank: 2, power: 0.05 },
  { id: 65, text: '제 관상은 반반 맞습니다. 무 많이요.', cat: 'face', rank: 2, power: 0.05 },
  { id: 66, text: '관상 좀 볼게요. (돋보기를 꺼낸다)', cat: 'face', rank: 2, power: 0, fleeBias: 0.25 },
  { id: 67, text: '전생에 제가 포교했던 분이네요. 그때도 실패했죠.', cat: 'past', rank: 2, power: 0.06 },
  { id: 68, text: '전생 기록을 봤습니다. 지각이 좀 많으시네요.', cat: 'past', rank: 2, power: 0.04 },
  { id: 69, text: '조상님이 제 꿈에 오셨는데 저를 못 알아보세요.', cat: 'ancestor', rank: 2, power: 0.05 },
  { id: 70, text: '조상님 단체방에 초대됐는데, 알림은 껐어요.', cat: 'ancestor', rank: 2, power: 0.05 },
  { id: 71, text: '조상님 성함을 가나다순으로 불러 드릴게요.', cat: 'ancestor', rank: 2, power: -0.05, fleeBias: 0.3 },
  { id: 72, text: '기운 충전해 드릴게요. 저는 C타입입니다.', cat: 'energy', rank: 2, power: 0.06 },
  { id: 73, text: '제 기운은 무료입니다. 유료였던 적도 없어요.', cat: 'energy', rank: 2, power: 0.05 },
  { id: 74, text: '오늘 기운은 칼퇴 쪽으로 흐릅니다.', cat: 'energy', rank: 2, power: 0.06 },
  { id: 75, text: '3초면 됩니다. 방금 지났네요. 연장할게요.', cat: 'time', rank: 2, power: 0.02, fleeBias: 0.25 },
  { id: 76, text: '설명은 짧습니다. 서론만 40분이에요.', cat: 'time', rank: 2, power: -0.08, fleeBias: 0.4 },
  { id: 77, text: '이건 운명입니다. 버스 놓친 것도 다 계획이었죠.', cat: 'fate', rank: 2, power: 0.05 },
  { id: 78, text: '우리가 만날 확률은 0.0001%. 제가 방금 지어냈어요.', cat: 'fate', rank: 2, power: 0.06 },
  { id: 79, text: '이 은박지 모자요? 수신용입니다. 라디오만 잡혀요.', cat: 'cosmic', rank: 2, power: 0.06 },
  { id: 80, text: "우주가 답장했습니다. '누구세요'라고요.", cat: 'cosmic', rank: 2, power: 0.06 },
  { id: 81, text: '외계어로 말씀드릴게요. 뀨릉 빠삐 뿌?', cat: 'cosmic', rank: 2, power: 0.02, fleeBias: 0.2 },

  // ───────── 직급 3 — 직함(교단장)을 자꾸 입에 올린다 ─────────
  { id: 82, text: '제가 바로 도입니다. 레는 공석입니다.', cat: 'dao', rank: 3, power: 0.08 },
  { id: 83, text: '도를 깨우쳤습니다. 알람이 깨워 줬어요.', cat: 'dao', rank: 3, power: 0.07 },
  { id: 84, text: '교단장급 관상입니다. 제 얘기예요.', cat: 'face', rank: 3, power: 0.07 },
  { id: 85, text: '귀한 상이시네요. 저 다음으로요.', cat: 'face', rank: 3, power: 0.08 },
  { id: 86, text: '제 전생은 교단장이었습니다. 3일 만에 망했지만.', cat: 'past', rank: 3, power: 0.08 },
  { id: 87, text: '조상님들이 저를 교단장으로 뽑으셨어요. 기권 다수로.', cat: 'ancestor', rank: 3, power: 0.08 },
  { id: 88, text: '교단장의 기운입니다. 살짝 정전기 같죠?', cat: 'energy', rank: 3, power: 0.08 },
  { id: 89, text: '교단장의 1분입니다. 귀한 1분이라 길어요.', cat: 'time', rank: 3, power: 0.05, fleeBias: 0.2 },
  { id: 90, text: '교단장을 만난 건 행운입니다. 제 입으로 말하긴 뭣하지만.', cat: 'fate', rank: 3, power: 0.08 },
  { id: 91, text: '안테나가 섰습니다. 근처에 공유기가 있나 봐요.', cat: 'cosmic', rank: 3, power: 0.08 },

  // ───────── 직급 4 — 허세가 일상을 침범한다 ─────────
  { id: 92, text: '도는 제가 만들었습니다. 특허는 반려됐어요.', cat: 'dao', rank: 4, power: 0.1 },
  { id: 93, text: '제 얼굴을 보세요. 이게 대교주상입니다.', cat: 'face', rank: 4, power: 0.1 },
  { id: 94, text: '전생에도 대교주였습니다. 신도는 저 혼자였어요.', cat: 'past', rank: 4, power: 0.1 },
  { id: 95, text: '조상님이 꿈에서 제 사인을 받아 가셨어요.', cat: 'ancestor', rank: 4, power: 0.1 },
  { id: 96, text: '제 기운이 세서 자동문이 먼저 열립니다.', cat: 'energy', rank: 4, power: 0.11 },
  { id: 97, text: '대교주의 1분은 영원입니다. 농담이고 2분요.', cat: 'time', rank: 4, power: 0.08, fleeBias: 0.15 },
  { id: 98, text: '운명이 저를 보냈습니다. 반품은 안 된대요.', cat: 'fate', rank: 4, power: 0.11 },
  { id: 99, text: '화성 지부에서 연락이 왔습니다. 수신자 부담으로.', cat: 'cosmic', rank: 4, power: 0.1 },

  // ───────── 직급 5 — 우주급 허세, 동네급 실체 ─────────
  { id: 100, text: '안드로메다에도 물어봤습니다. 도는 모른답니다.', cat: 'dao', rank: 5, power: 0.14 },
  { id: 101, text: '제 관상이 우주에서 보인답니다. 머리가 커서요.', cat: 'face', rank: 5, power: 0.14 },
  { id: 102, text: '제 얼굴이 별자리로 등록됐습니다. 신청은 제가 했어요.', cat: 'face', rank: 5, power: 0.15 },
  { id: 103, text: '저는 전생이 없습니다. 우주 개업 때부터 근속 중.', cat: 'past', rank: 5, power: 0.15 },
  { id: 104, text: '제 조상님은 북극성입니다. 외가 쪽으로요.', cat: 'ancestor', rank: 5, power: 0.14 },
  { id: 105, text: '제 기운으로 은하가 돕니다. 원래 돌긴 했지만.', cat: 'energy', rank: 5, power: 0.15 },
  { id: 106, text: '우주 나이에 비하면 3시간은 찰나입니다.', cat: 'time', rank: 5, power: 0.1, fleeBias: 0.3 },
  { id: 107, text: '별들이 우리 만남을 예고했습니다. 스포일러죠.', cat: 'fate', rank: 5, power: 0.14 },
  { id: 108, text: '안드로메다 가입 문의가 폭주 중입니다. 3건이요.', cat: 'cosmic', rank: 5, power: 0.15 },
  { id: 109, text: '저는 우주급 절대교주입니다. 지구 한정이지만요.', cat: 'cosmic', rank: 5, power: 0.16 },
]
