/**
 * 닉네임/교단 이름/칭호 검사. 클라이언트와 서버가 같은 코드를 쓴다(순수 함수, 의존성 없음).
 *
 * 막는 것
 *  1. 욕설·혐오·성적 표현 — 띄어쓰기/기호/숫자 끼워 넣기, 자모 풀어쓰기(ㅅㅣ발), 초성 줄임(ㅅㅂ), 영문 변형(f.u.c.k, sh1t)까지.
 *  2. 운영자 사칭.
 *  3. 연락처·주소로 보이는 것(전화번호, URL, 메신저 아이디) — 개인정보가 화면에 떠다니지 않게.
 *  4. 실존 종교·교단·정당·정치인·극단주의 단체, 실존 브랜드·유명인 이름 — 이 게임의 교단과 교주는 전부 허구여야 한다.
 *     닉네임도 막는다: 이름표는 '교주' 직급과 함께 3D 아바타 머리 위에 떠다니므로 '실존 인물이 포교하는' 그림이 된다.
 *
 * 목록은 완벽할 수 없다. 운영하면서 사람이 주기적으로 검토해 보강해야 한다.
 * 시그니처(cleanText, hasBadWord, looksLikeRealGroup, checkNickname, checkCultName, checkTitle, TextCheck)는 유지한다.
 */
import { CULT_NAME_MAX, CULT_NAME_MIN, NAME_MAX, NAME_MIN, TITLE_MAX } from '../constants'

/** why 가 'real' 일 때 hit 은 걸린 낱말(화면에서 무엇 때문인지 알려 주기 위해) */
export type TextCheck = { ok: true; text: string } | { ok: false; why: 'empty' | 'short' | 'long' | 'bad' | 'real'; hit?: string }

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g
const JAMO_RUN = /[\u3130-\u318f]+/g

/**
 * 보이지 않는 문자/제어문자 제거, 전각→반각 등 호환 정규화, 공백 정리, 길이 제한(코드 포인트 기준).
 * 한글 호환 자모(ㄱ, ㅏ …)는 NFKC 를 거치면 깨진 조합형 자모로 바뀌므로 그 구간만 건너뛴다.
 */
export function cleanText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return ''
  let s = ''
  let last = 0
  for (const m of input.matchAll(JAMO_RUN)) {
    s += input.slice(last, m.index).normalize('NFKC') + m[0]
    last = (m.index ?? 0) + m[0].length
  }
  s += input.slice(last).normalize('NFKC')
  s = s.replace(INVISIBLE, '')
  s = s.replace(/[<>&"'`\\]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  return Array.from(s).slice(0, maxLen).join('')
}

// ───────────────────────── 정규화 ─────────────────────────

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
/** 겹받침/쌍자음은 낱자로 풀어 비교한다(ㅄ → ㅂㅅ) */
const SPLIT: Record<string, string> = { ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ', ㄽ: 'ㄹㅅ', ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ' }
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i' }
/**
 * 라틴 글자와 똑같이 생긴 키릴·그리스 글자(nаzi 의 а 는 키릴 문자다). a-z 판정 전에 라틴 글자로 접는다.
 * 소문자로 바꾼 뒤에 보므로 소문자만 넣는다.
 */
const CONFUSABLE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ц: 'u',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
}
/** 숫자를 한자어 수사로 읽은 것(통1교 → 통일교). 실존 단체 대조에만 쓴다 */
const SINO_DIGIT: Record<string, string> = { '0': '영', '1': '일', '2': '이', '3': '삼', '4': '사', '5': '오', '6': '육', '7': '칠', '8': '팔', '9': '구' }

function isHangulSyllable(c: number): boolean {
  return c >= 0xac00 && c <= 0xd7a3
}
function isCompatJamo(c: number): boolean {
  return c >= 0x3131 && c <= 0x3163
}

interface Views {
  /** 한글 음절·자모만 남긴 것(사이에 낀 숫자/기호/영문 제거) */
  ko: string
  /** 음절을 낱자모로 푼 것 */
  jamo: string
  /** 영문만 남긴 것(leet 치환 후, 소문자) */
  en: string
  /** 한글·영문·숫자만 남긴 것(실존 단체명 대조용, 비슷하게 생긴 키릴·그리스 글자는 라틴 글자로 접은 뒤) */
  flat: string
  /** 숫자만 */
  digits: string
}

function views(text: string): Views {
  const s = text.normalize('NFKC').replace(INVISIBLE, '').toLowerCase()
  let ko = ''
  let jamo = ''
  let en = ''
  let flat = ''
  let digits = ''
  for (const raw of s) {
    const ch = CONFUSABLE[raw] ?? raw
    const c = ch.codePointAt(0) ?? 0
    if (isHangulSyllable(c)) {
      const i = c - 0xac00
      const jong = JONG[i % 28] ?? ''
      ko += ch
      flat += ch
      jamo += (CHO[Math.floor(i / 588)] ?? '') + (JUNG[Math.floor(i / 28) % 21] ?? '') + (SPLIT[jong] ?? jong)
    } else if (isCompatJamo(c)) {
      ko += ch
      flat += ch
      jamo += SPLIT[ch] ?? ch
    } else if (c >= 0x1100 && c <= 0x1112) {
      // 조합형 초성(NFKC 가 호환 자모를 이쪽으로 바꿔 놓은 경우)
      const j = CHO[c - 0x1100] ?? ''
      ko += j
      flat += j
      jamo += j
    } else if (c >= 0x1161 && c <= 0x1175) {
      const j = JUNG[c - 0x1161] ?? ''
      ko += j
      flat += j
      jamo += j
    } else if (ch >= 'a' && ch <= 'z') {
      en += ch
      flat += ch
    } else if (ch >= '0' && ch <= '9') {
      digits += ch
      flat += ch
      en += LEET[ch] ?? ''
    } else if (LEET[ch]) {
      en += LEET[ch]
    }
  }
  return { ko, jamo, en: en.replace(/(.)\1{2,}/g, '$1$1'), flat, digits }
}

function toJamo(word: string): string {
  return views(word).jamo
}

// ───────────────────────── 목록 (주기적으로 사람이 검토할 것) ─────────────────────────

/** 한글 욕설·비하·성적 표현의 뿌리(음절 표기). 자모로 풀어서도 대조한다 */
const BAD_KO: readonly string[] = [
  '시발', '씨발', '씨바', '씨팔', '시팔', '쓰발', '시벌', '쉬발', '쒸발', '씌발', '시이발', '씹', '썅', '좆', '좃', '존나', '졸라게', '지랄', '염병',
  '병신', '븅신', '빙신', '벙신', '븅딱',
  '개새끼', '개새', '개색', '개쌔끼', '개년', '개놈', '쌍놈', '쌍년', '미친놈', '미친년', '또라이', '닥쳐', '꺼져', '죽어라', '뒤져',
  // 패드립(부모 욕)
  '느금', '니애미', '니미럴', '엠창', '느개비', '애미없', '애비없',
  '창녀', '걸레년', '보빨', '섹스', '섹파', '야동', '야사', '강간', '성폭', '몰카', '후장', '딸딸이', '자위행위', '젖꼭지',
  // 혐오·비하(성별·지역·국적·장애·외모)
  '한남충', '김치녀', '된장녀', '맘충', '틀딱', '급식충', '짱깨', '짱개', '쪽바리', '쪽발이', '깜둥이', '흑형', '전라디언', '홍어족', '전라도놈', '경상도놈',
  '찐따', '정신병자', '일베', '메갈',
  // 자해
  '자살', '죽고싶',
]
/**
 * 음절 표기로만 대조하는 뿌리. 자모로 풀어 대조하면 받침 있는 다음 글자와 겹쳐 오탐이 난다
 * ('애자' 의 자모 ㅇㅐㅈㅏ 는 '애장품' 에도, 'ㅅ발' 의 ㅅㅂㅏㄹ 은 '옷발' 에도 들어 있다).
 */
const BAD_KO_SYL: readonly string[] = ['애자', '한녀', '개쌔', '니엄마', 'ㅅ발', 'ㅆ발']
/** 오탐 방지: 위 뿌리를 품고 있지만 무해한 낱말. 대조 전에 지운다 */
const SAFE_KO: readonly string[] = ['시발점', '시발역', '병신년', '씹어', '씹는', '씹던', '곱씹', '질겅질겅씹', '개새우', '졸라맨', '애자일', '한녀석', '한녀름']
/** 초성만으로 쓴 줄임 욕. 자모만으로 이루어진 구간에서만 대조한다 */
const BAD_CHO: readonly string[] = ['ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅈㄴ', 'ㅈㄹ', 'ㄱㅅㄲ', 'ㅅㄲ', 'ㄲㅈ', 'ㅁㅊㄴ', 'ㄴㄱㅁ']
/** 숫자를 섞은 욕(씨8, 18놈). 한글·숫자만 남긴 문자열에 대조한다 */
// '18' 단독은 나이·연도(2018년, 18세)라서 욕 접미사가 바로 붙을 때만 본다
const BAD_DIGIT: readonly RegExp[] = [/[씨쒸]8/, /^시8$|시8(놈|년|새)/, /(^|[^0-9])18(놈|새|섀|롬|련)/, /ㅅ[1li]발/]
const BAD_EN: readonly string[] = [
  'fuck', 'fuk', 'shit', 'bitch', 'cunt', 'pussy', 'nigger', 'nigga', 'faggot', 'asshole', 'whore', 'slut', 'porn', 'sex', 'rape', 'penis', 'vagina',
  'sibal', 'ssibal', 'shibal', 'byungsin', 'byeongsin', 'jonna', 'gaesaekki',
  // 한글 자판 그대로 영문으로 친 것(tlqkf = 시발, qudtls = 병신, whssk = 존나, wkwl = 자지)
  'tlqkf', 'tlqk', 'qudtls', 'whssk', 'wkwl',
]
const SAFE_EN: readonly string[] = ['essex', 'sussex', 'middlesex', 'sextant', 'grape', 'drape', 'scrape', 'therapist']
/** 운영자 사칭 */
const STAFF_KO: readonly string[] = ['운영자', '운영진', '관리자', '공식계정', '고객센터', '시스템관리']
const STAFF_EN: readonly string[] = ['admin', 'administrator', 'moderator', 'gamemaster', 'official', 'staff']

/**
 * 실존 종교·교파·교단·시설·직함·신앙 대상·교주, 종교 구호, 정당·정치인, 극단주의 단체.
 * '나쁜 단체 목록'이 아니다: 평가와 무관하게 실존하는 것은 전부 피한다는 뜻이다(우연히 겹쳐도 누군가 다친다).
 * 한 글자짜리('절', '도', '교')는 넣지 않는다. 게임이 쓰는 일반어(교주, 신도, 교단, 계시, 구원, 도사, 전도사)는 허용한다.
 * ('전도사' 는 직급 '길거리 전도사'와 복장 '수상한 전도사'로 게임이 직접 쓰고, 'OO 전도사'는 일상어로도 흔하다.
 *  실존 단체 '전도관'은 따로 막는다.)
 */
const REAL_RELIGION: readonly string[] = [
  '기독교', '개신교', '천주교', '가톨릭', '카톨릭', '정교회', '성공회', '불교', '원불교', '천도교', '대종교', '이슬람', '무슬림', '힌두', '유대교',
  '장로교', '감리교', '침례', '성결교', '순복음', '구세군', '조계종', '천태종', '태고종',
  '신천지', '증거장막', '통일교', '가정연합', '여호와', '대순진리', '진리회', '증산도', 'jms', '제이엠에스', '복음선교회', '구원파', '기쁜소식',
  '만민중앙', '하나님의교회', '안상홍', '아가동산', '영생교', '천부교', '전도관', '오대양', '다미선교', '파룬궁',
  '사이언톨로지', 'scientology', '옴진리', '라엘리안', '인민사원', '헤븐스게이트',
  // 실존 교주·창시자
  '이만희', '정명석', '문선명', '한학자', '유병언', '박옥수', '이재록', '조희성',
  '교회', '성당', '사찰', '법당', '모스크', '선교회', '수련원', '포덕',
  '목사', '장로님', '신부님', '수녀', '스님', '추기경', '교황', '메시아', '재림주', '구세주',
  '예수', '그리스도', '하나님', '하느님', '부처님', '석가모니', '미륵', '알라신', '무함마드', '성모마리아', '옥황상제',
  // 기도·염불 구호
  '할렐루야', '아멘', '나무아미타불', '관세음보살', '알라후',
  'jesus', 'christ', 'church', 'buddha', 'allah', 'islam', 'catholic',
]
const REAL_POLITICS: readonly string[] = [
  '국민의힘', '국힘', '더불어민주당', '민주당', '정의당', '개혁신당', '조국혁신당', '진보당', '새누리', '한나라당', '자유한국당', '미래통합당', '국민의당',
  '바른미래당', '통합진보당', '민주노동당', '열린우리당', '공화당', '노동당', '공산당', '대통령', '국회의원', '국무총리',
  '이승만', '박정희', '전두환', '노태우', '김영삼', '김대중', '노무현', '이명박', '박근혜', '문재인', '윤석열', '이재명',
  '한동훈', '이준석', '안철수', '김건희', '홍준표',
  '김일성', '김정일', '김정은', '트럼프', '바이든', '푸틴', '시진핑', '히틀러', '나치', '탈레반', '알카에다', '하마스', 'isis', 'nazi', 'kkk', 'trump',
]
/** 실존 회사·브랜드·캐릭터·유명인. 교단 이름·칭호·닉네임 모두에 적용한다 */
const REAL_BRAND: readonly string[] = [
  '삼성', '카카오', '쿠팡', '배민', '배달의민족', '스타벅스', '맥도날드', '포켓몬', '피카츄', '디즈니',
  '방탄소년', 'bts', '뉴진스', '블랙핑크', '아이유', '페이커', '손흥민',
]
/**
 * 다른 뜻으로 흔히 쓰이는 낱말이라 '이름 전체'가 그 낱말일 때만 막는 것(뒤에 교·회 같은 한 글자 접미사는 붙어도 막는다).
 * '조국'은 '조국 사랑'처럼, '방탄'은 '방탄조끼'처럼 무해하게 쓰인다.
 */
const REAL_EXACT: readonly string[] = ['조국', '방탄']
const EXACT_SUFFIX = /^(교|회|당|단|파|님|씨|팬)?$/
/**
 * 실존 단체명과 글자가 우연히 겹칠 뿐인 무해한 표현. 판정 전에 걷어 낸다.
 * (띄어쓰기를 지우고 비교하기 때문에 '명예 수석'의 '예수', '학교 회장'의 '교회' 같은 겹침이 생긴다.)
 */
const SAFE_REAL: readonly (string | RegExp)[] = [
  '마법사',
  // …예 + 수… : 명예수석, 노예수준, 공예수업, 무예수련 (단, '…예수님/예수교'처럼 뒤가 호칭이면 걷어 내지 않는다)
  /(명|노|기|공|서|도|무|곡|연|문|학|원)예수(?=[가-힣])(?!님|교|쟁|께|여|야)/g,
  '예수금',
  // 학교/고교 + 회… : 학교회장, 학교회의, 고교회식
  /(학|고)교회(?=장|의|식|계|비|관|견)/g,
  // 나 + 치킨/치과/치즈 …
  /나치(?=킨|과|즈|료|약|아)/g,
  // 외래어 + 님 : 보스님, 버스님, 에이스님 (큰스님·주지스님 같은 말은 여기 없다)
  /(보|버|가|예|미|뉴|주|쥬|소|코|포|토|박|믹|댄|키|찬|센|렉|맥|폭|에이|베이|케이|페이|레이|서비|보너|마우|하우|클래|스트레|프린세|루카|토마|클로|지니어|바이러|캠퍼|오피|포커|코러|보이|초이|나이|아이|스페이|유니버|피닉|알렉)스님/g,
  // 덕후 계열: 스포덕후, 대포덕후
  /포덕(?=후|질|력)/g,
  // 이불 + 교 : 추천 이름 조합기가 만드는 '이불교'(뒤에 '회'가 붙어 '교회'가 되면 걷어 내지 않는다)
  /이불교(?!회)/g,
  '통일교육',
  'thisis',
  'crisis',
  'christmas',
  'christopher',
  'christine',
  'christina',
  'trumpet',
  'churchill',
]

const squeeze = (w: string): string => w.replace(/(.)\1+/g, '$1')
const BAD_EN_SQUEEZED: readonly string[] = BAD_EN.map(squeeze)
const SAFE_EN_SQUEEZED: readonly string[] = SAFE_EN.map(squeeze)
const BAD_KO_JAMO: readonly string[] = BAD_KO.map(toJamo)
const SAFE_KO_JAMO: readonly string[] = SAFE_KO.map(toJamo)
const STAFF_KO_FLAT: readonly string[] = STAFF_KO
const REAL_ALL: readonly string[] = [...REAL_RELIGION, ...REAL_POLITICS, ...REAL_BRAND]
const REAL_EN: readonly string[] = REAL_ALL.filter((w) => /^[a-z]+$/.test(w))

// ── 오타·변형 대조용 '느슨한' 한글 ──
// 씬천지·신쳔지·윤석렬·이재멍·박근헤처럼 발음은 같고 글자만 살짝 바꾼 변형을 잡는다.
// 된소리 → 예사소리, ㅕ→ㅓ ㅖ·ㅐ·ㅒ→ㅔ 같은 비슷한 모음, 첫소리 ㄹ·ㄴ → ㅇ(두음법칙)으로 접는다.
// 오탐을 줄이려고 세 글자 이상의 한글 낱말에만 쓴다.
const LOOSE_CHO: Record<string, string> = { ㄲ: 'ㄱ', ㄸ: 'ㄷ', ㅃ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ', ㄹ: 'ㅇ', ㄴ: 'ㅇ' }
const LOOSE_JUNG: Record<string, string> = { ㅕ: 'ㅓ', ㅖ: 'ㅔ', ㅐ: 'ㅔ', ㅒ: 'ㅔ', ㅑ: 'ㅏ', ㅛ: 'ㅗ', ㅠ: 'ㅜ', ㅢ: 'ㅣ', ㅟ: 'ㅣ' }
function loose(ko: string): string {
  let out = ''
  for (const ch of ko) {
    const c = ch.codePointAt(0) ?? 0
    if (!isHangulSyllable(c)) continue
    const i = c - 0xac00
    const cho = CHO[Math.floor(i / 588)] ?? ''
    const jung = JUNG[Math.floor(i / 28) % 21] ?? ''
    const jong = JONG[i % 28] ?? ''
    out += (LOOSE_CHO[cho] ?? cho) + (LOOSE_JUNG[jung] ?? jung) + (jong === 'ㅆ' ? 'ㅅ' : jong === 'ㄲ' ? 'ㄱ' : jong) + '.'
  }
  return out
}
const REAL_LOOSE: readonly [string, string][] = REAL_ALL.filter((w) => /^[가-힣]{3,}$/.test(w)).map((w) => [loose(w), w])
/** 거꾸로 쓴 변형(지천신)을 잡을 세 글자 한글 낱말 */
const REAL_REVERSIBLE: readonly string[] = REAL_ALL.filter((w) => /^[가-힣]{3}$/.test(w))

function stripAll(s: string, words: readonly (string | RegExp)[]): string {
  let out = s
  for (const w of words) {
    if (typeof w === 'string') {
      if (out.includes(w)) out = out.split(w).join(' ')
    } else {
      out = out.replace(w, ' ')
    }
  }
  return out
}

// ───────────────────────── 판정 ─────────────────────────

export function hasBadWord(text: string): boolean {
  const v = views(text)
  // 1) 음절 표기 그대로
  const ko = stripAll(v.ko, SAFE_KO)
  for (const w of BAD_KO) if (ko.includes(w)) return true
  for (const w of BAD_KO_SYL) if (ko.includes(w)) return true
  // 1-a) 숫자를 섞은 욕(씨8, 18놈, ㅅ1발)
  const flatKo = stripAll(v.flat, SAFE_KO)
  for (const re of BAD_DIGIT) if (re.test(flatKo)) return true
  // 1-b) 음절 사이에 낱자모를 끼워 넣은 변형(시ㅡ발): 낱자모를 걷어 내고 다시 본다
  const syl = stripAll(v.ko.replace(/[ㄱ-ㅣ]/g, ''), SAFE_KO)
  for (const w of BAD_KO) if (syl.includes(w)) return true
  for (const w of BAD_KO_SYL) if (/^[가-힣]+$/.test(w) && syl.includes(w)) return true
  // 2) 자모로 풀어쓴 변형(ㅅㅣ발, 시ㅂㅏㄹ)
  const jamo = stripAll(v.jamo, SAFE_KO_JAMO)
  for (const w of BAD_KO_JAMO) if (w.length >= 4 && jamo.includes(w)) return true
  // 3) 초성 줄임: 낱자모만으로 된 구간에서만 본다(일반 낱말의 초성과 헷갈리지 않게)
  for (const m of v.ko.matchAll(/[ㄱ-ㅎ]+/g)) {
    const run = m[0].replace(/[ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ]/g, (c) => SPLIT[c] ?? c)
    for (const w of BAD_CHO) if (run.includes(w)) return true
  }
  // 3-b) 손가락 욕을 뜻하는 모음 낱자
  if (v.ko === 'ㅗ' || /ㅗ{2,}/.test(v.ko)) return true
  // 4) 영문(leet 치환 포함)
  const en = stripAll(v.en, SAFE_EN)
  for (const w of BAD_EN) if (en.includes(w)) return true
  // 4-b) 글자를 늘여 쓴 변형(fuuuck): 양쪽 다 연속 글자를 하나로 줄여 비교한다
  const en1 = stripAll(squeeze(v.en), SAFE_EN_SQUEEZED)
  for (const w of BAD_EN_SQUEEZED) if (en1.includes(w)) return true
  // 5) 운영자 사칭
  for (const w of STAFF_KO_FLAT) if (v.ko.includes(w)) return true
  for (const w of STAFF_EN) if (v.en.includes(w)) return true
  if (/^gm\d*$/.test(v.flat) || /^\[?gm\]/i.test(text.trim())) return true
  return false
}

/** 실존 종교·단체·인물·브랜드로 보이는 낱말이 들어 있으면 그 낱말, 없으면 null */
export function findRealGroup(text: string): string | null {
  const v = views(text)
  const flat = stripAll(v.flat, SAFE_REAL)
  for (const w of REAL_ALL) if (flat.includes(w)) return w
  // 숫자를 한자어로 읽은 변형: 통1교 → 통일교
  if (v.digits) {
    const sino = flat.replace(/[0-9]/g, (d) => SINO_DIGIT[d] ?? d)
    for (const w of REAL_ALL) if (sino.includes(w)) return w
  }
  // 영문(leet·닮은꼴 글자 치환 후): n4zi, nаzi
  if (v.en) {
    const en = stripAll(v.en, SAFE_REAL)
    for (const w of REAL_EN) if (en.includes(w)) return w
  }
  const hangul = flat.replace(/[^가-힣]/g, '')
  if (hangul.length >= 2) {
    // 이름 전체가 다른 뜻으로도 흔한 낱말(+한 글자 접미사)이면: 조국, 조국교, 방탄회
    for (const w of REAL_EXACT) if (hangul.startsWith(w) && EXACT_SUFFIX.test(hangul.slice(w.length))) return w
    // 거꾸로 쓴 세 글자 이름: 지천신
    const rev = Array.from(hangul).reverse().join('')
    for (const w of REAL_REVERSIBLE) if (rev.includes(w)) return w
    // 글자만 살짝 바꾼 변형: 씬천지, 신쳔지, 윤석렬, 이재멍, 박근헤
    if (hangul.length >= 3) {
      const l = loose(hangul)
      for (const [lw, w] of REAL_LOOSE) if (l.includes(lw)) return w
    }
  }
  return null
}

export function looksLikeRealGroup(text: string): boolean {
  return findRealGroup(text) !== null
}

/** 전화번호·URL·메신저 아이디처럼 보이는가(개인 연락처가 이름표에 떠다니지 않게) */
export function looksLikeContact(text: string): boolean {
  const v = views(text)
  if (v.digits.length >= 7) return true
  if (/^01[016789]/.test(v.digits) && v.digits.length >= 6) return true
  const low = text.toLowerCase()
  if (/https?:|www\.|\.(com|net|kr|io|gg|me|co)\b/.test(low)) return true
  if (/@[a-z0-9_.]{2,}/.test(low)) return true
  if (/(카톡|카카오톡|kakao|오픈채팅|오픈톡|인스타|insta|텔레|telegram|디스코드|discord|라인아이디|line\s*id|트위터|twitter)/.test(low)) return true
  return false
}

/** 글자가 하나도 없는 이름(기호/숫자/낱자모뿐)은 이름표로 쓰기 어렵다 */
function hasRealLetters(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (isHangulSyllable(c) || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) return true
    if (c >= 0x3040 && c <= 0x30ff) return true // 가나
    if (c >= 0x4e00 && c <= 0x9fff) return true // 한자
  }
  return false
}

export function checkNickname(input: unknown): TextCheck {
  const text = cleanText(input, NAME_MAX)
  if (!text) return { ok: false, why: 'empty' }
  if (Array.from(text).length < NAME_MIN) return { ok: false, why: 'short' }
  if (!hasRealLetters(text)) return { ok: false, why: 'bad' }
  if (hasBadWord(text) || looksLikeContact(text)) return { ok: false, why: 'bad' }
  // 이름표는 '교주' 직급과 함께 아바타 머리 위에 뜬다: 실존 인물·단체·브랜드 이름으로 포교하는 그림을 만들지 않는다
  const real = findRealGroup(text)
  if (real !== null) return { ok: false, why: 'real', hit: real }
  return { ok: true, text }
}

export function checkCultName(input: unknown): TextCheck {
  const text = cleanText(input, CULT_NAME_MAX)
  if (!text) return { ok: false, why: 'empty' }
  if (Array.from(text).length < CULT_NAME_MIN) return { ok: false, why: 'short' }
  if (!hasRealLetters(text)) return { ok: false, why: 'bad' }
  if (hasBadWord(text) || looksLikeContact(text)) return { ok: false, why: 'bad' }
  const real = findRealGroup(text)
  if (real !== null) return { ok: false, why: 'real', hit: real }
  return { ok: true, text }
}

export function checkTitle(input: unknown): TextCheck {
  const text = cleanText(input, TITLE_MAX)
  if (!text) return { ok: false, why: 'empty' }
  if (!hasRealLetters(text)) return { ok: false, why: 'bad' }
  if (hasBadWord(text) || looksLikeContact(text)) return { ok: false, why: 'bad' }
  const real = findRealGroup(text)
  if (real !== null) return { ok: false, why: 'real', hit: real }
  return { ok: true, text }
}
