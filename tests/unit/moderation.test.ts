import { describe, expect, it } from 'vitest'
import { CULT_NAME_SUGGESTIONS, CULT_TITLE_SUGGESTIONS, OUTFITS, RANKS } from '../../shared/content/core'
import { ARCHETYPES } from '../../shared/content/archetypes'
import { NICK_ADJ, NICK_NOUN, allCultNameCandidates } from '../../shared/content/misc'
import { CULT_NAME_MAX } from '../../shared/constants'
import { NAME_MAX } from '../../shared/constants'
import {
  checkCultName,
  checkNickname,
  checkTitle,
  cleanText,
  findRealGroup,
  hasBadWord,
  looksLikeContact,
  looksLikeRealGroup,
} from '../../shared/rules/moderation'

/** 눈에 안 보이는 문자를 코드로 만들어 쓴다(소스에 직접 넣으면 번들러가 깨진다) */
const ZW = String.fromCharCode(0x200b)

describe('cleanText', () => {
  it('보이지 않는 문자·태그 문자·여분 공백을 지우고 길이를 자른다', () => {
    expect(cleanText(`  수상${ZW}한   행인  `, 10)).toBe('수상한 행인')
    expect(cleanText('<b>교주</b>', 10)).toBe('b교주/b')
    expect(cleanText('가나다라마바사아자차카타', 5)).toBe('가나다라마')
    expect(cleanText(123, 5)).toBe('')
    expect(cleanText('ＡＢＣ', 5)).toBe('ABC') // 전각 → 반각
  })
  it('낱자모는 깨뜨리지 않고 그대로 둔다', () => {
    expect(cleanText('ㅋㅋㅋ교주', 10)).toBe('ㅋㅋㅋ교주')
  })
})

describe('욕설·비하 차단', () => {
  const block = [
    '시발', '씨발놈', '시 발', '시.발', '시1발', '시ㅡ발', 'ㅅㅣ발', '시ㅂㅏㄹ', 'ㅅㅂ', 'ㅅ ㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅈㄴ웃김', '병신', '병1신', '븅신',
    '좆밥', '존나쎔', '지랄맞음', '개새끼', '개 새 끼', '미친놈', '씹덕', '썅', '창녀', '섹스', '야동왕', '강간', '김치녀', '맘충', '틀딱', '짱깨', '쪽바리',
    '일베충', '자살각', 'fuck', 'FUCK', 'f.u.c.k', 'fuuuck', 'sh1t', 'b1tch', 'pussy', 'n1gger', 'asshole', 'sex', 's3x', 'porn', 'sibal', 'ㅗ',
    `시${ZW}발`, '씨@발', '느금마', '엠창', '운영자', '운 영 자', '관리자', 'GM', 'gm1', '[GM]교주', 'admin', 'Adm1n', 'official',
  ]
  it.each(block)('막는다: %s', (s) => {
    expect(hasBadWord(s)).toBe(true)
  })

  const allow = [
    '수상한행인', '졸린도사', '배고픈비둘기', '시발점', '시발역 앞', '병신년생', '껌씹는교주', '곱씹는사람', '시바견', '가시바늘', '새우깡', '고양이집사',
    '라면교주', '퇴근요정', '월요병', '만성피로', '김밥천국팬', '교주님', '신도1호', '도사', '붕어빵', '세시반', '수박', '박수무당아님', '다시봄',
    'Essex', 'grape', 'class', 'assistant', 'hello', 'shiba', 'game', 'gamer', 'magma', 'ㅋㅋㅋ', 'ㅎㅎ', 'ㅇㅈ', '오소리', '소시지',
  ]
  it.each(allow)('허용한다: %s', (s) => {
    expect(hasBadWord(s)).toBe(false)
  })
})

describe('실존 단체·인물 차단(교단 이름/칭호)', () => {
  const block = [
    '신천지', '신 천 지', '신.천.지', '통일교', '여호와의증인', '대순진리회', 'JMS', '구원파', '기독교', '불교', '천주교', '가톨릭', '이슬람', '순복음',
    '라면교회', '퇴근성당', '김밥사찰', '목사님', '스님', '교황', '예수', '부처님', '하나님', '메시아', 'church', 'Jesus',
    '국민의힘', '더불어민주당', '민주당', '정의당', '공산당', '대통령', '국회의원', '윤석열', '이재명', '문재인', '박근혜', '김정은', '트럼프', '나치', 'ISIS',
  ]
  it.each(block)('막는다: %s', (s) => {
    expect(looksLikeRealGroup(s)).toBe(true)
    expect(checkCultName(s).ok).toBe(false)
  })

  const allow = [
    '라면교', '퇴근을 믿는 사람들', '월요병 구원회', '배달의 성자들', '로또의 계시', '만성피로 구원단', '치킨 수호대', '낮잠 연구회', '대마법사단',
    '떡볶이 원리주의', '칼퇴 동호회', '야식 번영회', '이불 밖은 위험해', '붕어빵 교단', '우주 라면 본부',
  ]
  it.each(allow)('허용한다: %s', (s) => {
    const r = checkCultName(s)
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })

  it('사유를 구분해 돌려준다', () => {
    expect(checkCultName('신천지')).toEqual({ ok: false, why: 'real', hit: '신천지' })
    expect(checkCultName('시발교')).toEqual({ ok: false, why: 'bad' })
    expect(checkCultName('')).toEqual({ ok: false, why: 'empty' })
    expect(checkCultName('교')).toEqual({ ok: false, why: 'short' })
    expect(checkTitle('교황')).toEqual({ ok: false, why: 'real', hit: '교황' })
    expect(checkTitle('명예 과장')).toEqual({ ok: true, text: '명예 과장' })
  })
})

describe('연락처 유출 차단', () => {
  const block = ['01012345678', '010-1234-5678', '공일공 1234567', 'http://a.b', 'www.site.kr', 'abc.com', '카톡 abc12', '인스타 @abc', '@cult_id', '오픈채팅', '텔레 xx']
  it.each(block)('막는다: %s', (s) => {
    expect(looksLikeContact(s) || !checkNickname(s).ok).toBe(true)
  })
  it.each(['교주 1호', '신도 99명', '3번 출구', '7전8기'])('허용한다: %s', (s) => {
    expect(looksLikeContact(s)).toBe(false)
  })
})

describe('닉네임', () => {
  it('글자가 없는 이름은 받지 않는다', () => {
    expect(checkNickname('1234').ok).toBe(false)
    expect(checkNickname('!!!').ok).toBe(false)
    expect(checkNickname('ㅋㅋㅋ').ok).toBe(false)
    expect(checkNickname('ㅋㅋ교주').ok).toBe(true)
  })
  it('길이 규칙', () => {
    expect(checkNickname('가')).toEqual({ ok: false, why: 'short' })
    const long = checkNickname('가나다라마바사아자차카타파하')
    expect(long.ok && Array.from(long.text).length).toBe(NAME_MAX)
  })
  it('기본 제공 닉네임 조합은 전부 통과한다', () => {
    const bad: string[] = []
    for (const a of NICK_ADJ) for (const n of NICK_NOUN) if (!checkNickname(a + n).ok) bad.push(a + n)
    expect(bad).toEqual([])
  })
  it('기본 제공 교단 이름·칭호·직급명·복장명·조합기 출력은 전부 통과한다', () => {
    for (const s of CULT_NAME_SUGGESTIONS) expect(checkCultName(s).ok, s).toBe(true)
    for (const s of CULT_TITLE_SUGGESTIONS) expect(checkTitle(s).ok, s).toBe(true)
    // 직급명·복장명은 게임이 직접 쓰는 말이다: 플레이어가 그대로 칭호나 교단 이름으로 써도 막히면 안 된다
    // ('길거리 전도사'가 '실존 종교로 보인다'며 거절당하던 문제)
    for (const r of RANKS) {
      expect(hasBadWord(r.name), r.name).toBe(false)
      expect(checkTitle(r.name), r.name).toMatchObject({ ok: true })
      expect(checkCultName(r.name), r.name).toMatchObject({ ok: true })
    }
    for (const o of OUTFITS) {
      expect(checkTitle(o.name), o.name).toMatchObject({ ok: true })
      expect(checkCultName(o.name), o.name).toMatchObject({ ok: true })
    }
    // 추천 조합기가 만드는 이름 전부: 막히는 이름은 조용히 다시 뽑혀 '이불교' 같은 자연스러운 농담이 사라졌었다
    const bad = allCultNameCandidates().filter((n) => Array.from(n).length <= CULT_NAME_MAX && !checkCultName(n).ok)
    expect(bad).toEqual([])
    // 한 글자 접미사 앞에는 띄어쓰기가 없다('라면 교'는 틀린 띄어쓰기)
    expect(allCultNameCandidates().filter((n) => / [교회]$/.test(n))).toEqual([])
  })
  it('NPC 이름표(시민 이름)도 닉네임 검사를 통과한다', () => {
    const bad = ARCHETYPES.flatMap((a) => a.names).filter((n) => {
      const r = checkNickname(n)
      return !r.ok && r.why !== 'long'
    })
    expect(bad).toEqual([])
  })
  it('실존 인물·단체·브랜드 이름은 닉네임으로도 쓸 수 없고, 무엇이 걸렸는지 알려 준다', () => {
    expect(checkNickname('정명석')).toEqual({ ok: false, why: 'real', hit: '정명석' })
    expect(checkNickname('윤석열')).toEqual({ ok: false, why: 'real', hit: '윤석열' })
    expect(checkNickname('하나님')).toEqual({ ok: false, why: 'real', hit: '하나님' })
    expect(checkNickname('스타벅스교주')).toEqual({ ok: false, why: 'real', hit: '스타벅스' })
    // 게임의 일반어 '교주'는 계속 쓸 수 있다
    expect(checkNickname('라면교주')).toMatchObject({ ok: true })
  })
})

describe('성능', () => {
  it('검사 1만 번이 충분히 빠르다', () => {
    const samples = ['수상한행인', '라면교', '퇴근을 믿는 사람들', 'ㅅㅣ발', 'f.u.c.k', '졸린도사12', '국민의힘', '배고픈비둘기']
    const t0 = performance.now()
    for (let i = 0; i < 10_000; i++) {
      const s = samples[i % samples.length] as string
      checkNickname(s)
      checkCultName(s)
    }
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})

describe('실존 단체 필터의 오탐(띄어쓰기를 지우며 생기는 우연한 겹침)', () => {
  it('무해한 칭호·교단 이름은 통과한다', () => {
    const fine = [
      '명예수석부장',
      '명예 수석 과장',
      '노예수준신도',
      '무예수련생',
      '학교회장',
      '고교 회식 담당',
      '나치킨먹을래',
      '하나치과옆',
      '보스님',
      '버스님',
      '에이스님',
      '스포덕후',
      '예수금관리',
    ]
    for (const t of fine) {
      expect(checkTitle(t), t).toMatchObject({ ok: true })
      expect(checkCultName(t), t).toMatchObject({ ok: true })
    }
  })

  it('그래도 실존 종교·단체·인물을 가리키는 말은 막고, 무엇이 걸렸는지 알려 준다', () => {
    const cases: [string, string][] = [
      ['명예수님', '예수'],
      ['예수', '예수'],
      ['우리 교회', '교회'],
      ['학교회', '교회'],
      ['큰스님', '스님'],
      ['주지스님', '스님'],
      ['나치', '나치'],
      ['나치당', '나치'],
      ['포덕천하', '포덕'],
      ['통일교', '통일교'],
    ]
    for (const [text, hit] of cases) {
      expect(checkTitle(text), text).toEqual({ ok: false, why: 'real', hit })
      expect(findRealGroup(text), text).toBe(hit)
    }
  })
})


/**
 * 2차 검수에서 뚫린 문자열 전부. 막혀야 할 것과 통과해야 할 것을 한 표로 지킨다.
 * 눈에 안 보이는·닮은꼴 글자는 코드로 만든다(소스에 직접 넣지 않는다).
 */
describe('2차 검수 표: 실존 인물·단체·브랜드, 변형 욕설, 오탐', () => {
  const cyrA = String.fromCharCode(0x430) // 키릴 а
  const greekMu = String.fromCharCode(0x3bc) // 그리스 μ
  const cyrTse = String.fromCharCode(0x446) // 키릴 ц

  const realBlock = [
    // 정치인·독재자·실존 교주가 닉네임으로 통과하던 것
    '윤석열', '이재명', '문재인', '트럼프', '김정은', '히틀러', '이만희', '정명석', '예수', '교황', '부처님', '하나님', '신천지교주',
    // 실존 교주·창시자
    '이만희교', '정명석 모임', '문선명교', '유병언회', '이재록교',
    // 정치인
    '한동훈교', '조국교', '조국', '이준석회', '안철수교', '김건희교', '국힘당',
    // 종교 구호
    '할렐루야교', '아멘교', '나무아미타불', '관세음보살', '알라후아크바르',
    // 브랜드·캐릭터·유명인
    '스타벅스교', '삼성교', '카카오교', '쿠팡교', '배민교', '포켓몬교', '피카츄회', 'BTS교', '방탄교', '뉴진스회', '아이유교', '페이커교', '손흥민교',
    // 우회 표기
    '통1교', '지천신', '씬천지', '신쳔지', `n${cyrA}zi교`, 'n4zi', '제이엠에스', '윤석렬교', '이재멍', '박근헤',
  ]
  it.each(realBlock)('실존 이름 차단(닉네임·교단 이름·칭호): %s', (s) => {
    for (const r of [checkNickname(s), checkCultName(s), checkTitle(s)]) {
      expect(r.ok, `${s} ${JSON.stringify(r)}`).toBe(false)
      if (!r.ok) expect(r.why).toBe('real')
    }
  })

  const badBlock = [
    'tlqkf', 'qudtls', 'whssk', '시벌', '쉬발', '쒸발', '씌발', '시이발', 'ㅅ1발', '씨8', '18놈', '개쌔끼', '벙신', '븅딱',
    `f${greekMu}ck`, `f${cyrTse}ck`, '니엄마', '애미없는', '애비없는', '느개비', '짱개', '쪽발이', '전라도놈', '경상도놈', '한녀', '애자', '찐따',
    '정신병자', '죽고싶다',
  ]
  it.each(badBlock)('욕설·비하 차단: %s', (s) => {
    expect(hasBadWord(s)).toBe(true)
    expect(checkNickname(s)).toMatchObject({ ok: false, why: 'bad' })
  })

  const pass = [
    '길거리 전도사', '수상한 전도사', '라면 전도사', '이불교', '이불 교', '조국 사랑', '방탄조끼', '착한녀석', '애자일', '애장품', '옷발',
    '2018년생', '18세 교주', '배달의 성자들', '로또의 계시', '라면교', '명예 과장', '도시 8번 출구',
  ]
  it.each(pass)('오탐 없음(닉네임·교단 이름·칭호): %s', (s) => {
    expect(checkTitle(s), s).toMatchObject({ ok: true })
    expect(checkCultName(s), s).toMatchObject({ ok: true })
    expect(checkNickname(s), s).toMatchObject({ ok: true })
  })

  it('이불교회처럼 진짜 낱말이 이어지면 다시 걸린다', () => {
    expect(findRealGroup('이불교회')).not.toBeNull()
  })
})
