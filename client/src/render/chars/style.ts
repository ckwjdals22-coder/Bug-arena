/**
 * Look(외형 튜플) → 실제로 그릴 부위 변형과 색. 카탈로그(shared/content/core.ts)의 각 항목이
 * 한눈에 구분되도록 여기서 색과 실루엣 조합을 정한다.
 */
import { ACCESSORIES, AURAS, FACES, HATS, OUTFITS, OUTFIT_COLORS, SKIN_COLORS } from '../../../../shared/content/core'
import type { Look } from '../../../../shared/types'
import { lin, mixRgb, tone } from './geo'
import type { RGB } from './geo'
import { ARM, HAIR, LEG, TORSO } from './parts'

export interface Style {
  skin: RGB
  hair: RGB
  hairVar: number
  torsoVar: number
  torsoA: RGB
  torsoB: RGB
  /** 몸통 위에 덧입는 조각(망토, 어깨 덮개). 없으면 -1 */
  addon: number
  addonA: RGB
  armVar: number
  sleeve: RGB
  hand: RGB
  legVar: number
  pants: RGB
  shoe: RGB
  hat: number
  hatA: RGB
  face: number
  acc: number
  aura: number
  blush: RGB
  /** 콧수염/수염/눈썹 색 */
  facial: RGB
  /** 고양이 털(주색/보조색) */
  fur: RGB
  fur2: RGB
}

export const C_EYE: RGB = lin(0x2a2433)
export const C_MOUTH: RGB = lin(0x4a2a30)
export const C_MOUTH_IN: RGB = lin(0x6e2233)
export const C_WHITE: RGB = lin(0xffffff)

const OFF_WHITE = 0xf6f4ee
const HAIR_BY_FACE = [HAIR.Short, HAIR.Part, HAIR.Messy, HAIR.Bob, HAIR.Slick, HAIR.Comb, HAIR.Knot]
const HAIR_COLOR = [0x35293c, 0x4a332a, 0x2b2c3b, 0x70452e, 0x282331, 0x443d45, 0xdedad2]

/** 고양이 털색: look[2](옷 색 번호)를 길고양이다운 색으로 옮긴다 [털, 가슴·발] */
const CAT_FUR: readonly (readonly [number, number])[] = [
  [0xf4f1ea, 0xffffff], // 0 흰둥이
  [0x2b2a30, 0xf4f1ea], // 1 턱시도
  [0xe8913a, 0xfff3e0], // 2 치즈
  [0xf2b25c, 0xfff3e0], // 3 연한 치즈
  [0xf3dfa8, 0xffffff], // 4 크림
  [0x8f8a80, 0xe9e4da], // 5 회색 줄무늬
  [0x6f7b8a, 0xdfe5ec], // 6 러시안블루 느낌
  [0x9aa3ad, 0xf4f1ea], // 7 은회색
  [0x4a4350, 0x8f8a80], // 8 고등어
  [0xd9a37a, 0x5a3a2a], // 9 샴(몸은 밝고 끝이 어둡다)
  [0x8a6b52, 0xf0e2cf], // 10 갈색
  [0xb9b2a6, 0xffffff], // 11 삼색이 대신 밝은 회갈색
]

function idx(n: number | undefined, len: number): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v >= 0 && v < len ? v : 0
}

/**
 * @param isNpc NPC 는 채도를 살짝 낮춰 실제 접속자가 아주 조금 더 눈에 띄게 한다(티 나지 않을 만큼만)
 */
export function resolveStyle(look: Look, isNpc: boolean): Style {
  const skinI = idx(look[0], SKIN_COLORS.length)
  const outfitI = idx(look[1], OUTFITS.length)
  const colorI = idx(look[2], OUTFIT_COLORS.length)
  const hat = idx(look[3], HATS.length)
  const face = idx(look[4], FACES.length)
  const acc = idx(look[5], ACCESSORIES.length)
  const aura = idx(look[6], AURAS.length)

  const calm = (c: RGB): RGB => (isNpc ? tone(c, 0.86, 0.97) : c)
  const skin = lin(SKIN_COLORS[skinI]!)
  const tintHex = OUTFIT_COLORS[colorI]!
  const tint = calm(lin(tintHex))
  const hex = (h: number): RGB => calm(lin(h))

  let torsoVar: number = TORSO.Shirt
  let torsoA = tint
  let torsoB = hex(0x46526e)
  let addon = -1
  let addonA = tint
  let armVar: number = ARM.Long
  let sleeve = tint
  let hand = skin
  let legVar: number = LEG.Pants
  let pants = hex(0x46526e)
  let shoe = hex(0xf2efe6)

  switch (outfitI) {
    case 0: // 평범한 시민: 반소매 셔츠 + 청바지
      armVar = ARM.Short
      break
    case 1: // 후드티 대학생
      torsoVar = TORSO.Hoodie
      torsoB = pants = hex(0x3b3f52)
      break
    case 2: // 수상한 전도사: 흰 반소매 셔츠 + 검은 넥타이 + 어두운 바지 + 검은 구두
      torsoVar = TORSO.Suit
      torsoA = sleeve = hex(0xf7f6f1)
      torsoB = pants = hex(0x262735)
      shoe = hex(0x17151c)
      armVar = ARM.Short
      break
    case 3: // 초보 교주 도복: 주색 도복 + 흰 띠(초보니까)
      torsoVar = TORSO.Robe
      torsoB = hex(colorI === 0 ? 0x9aa3ad : OFF_WHITE)
      armVar = ARM.Wide
      legVar = LEG.Feet
      break
    case 4: // 등산복 포교단
      torsoVar = TORSO.Vest
      torsoB = pants = hex(0x23232b)
      shoe = hex(0x6b4a33)
      legVar = LEG.Boots
      break
    case 5: // 개량한복 도인
      torsoVar = TORSO.Hanbok
      torsoB = pants = hex(0xdcd5c5)
      shoe = hex(0xf7f6f1)
      armVar = ARM.Wide
      legVar = LEG.Baggy
      break
    case 6: // 흰 도복 도사: 흰 도복 + 검은 띠
      torsoVar = TORSO.Robe
      torsoA = sleeve = hex(0xf5f3ec)
      torsoB = shoe = hex(0x25232b)
      armVar = ARM.Wide
      legVar = LEG.Feet
      break
    case 7: // 황금 교주 로브: 금색 로브 + 붉은 띠 + 털 달린 어깨 덮개
      torsoVar = TORSO.Robe
      torsoA = sleeve = hex(0xf2c230)
      torsoB = shoe = hex(0xb3262e)
      addon = TORSO.Mantle
      addonA = hex(0xb3262e)
      armVar = ARM.Wide
      legVar = LEG.Feet
      break
    case 8: // 반짝이 망토 대교주: 흰 슈트 + 금 벨트 + 주색 반짝이 망토
      torsoVar = TORSO.Slim
      torsoA = sleeve = pants = hex(0xf5f3ec)
      torsoB = shoe = hex(0xf2c230)
      addon = TORSO.Cape
      addonA = tint
      legVar = LEG.Boots
      break
    case 9: // 우주 절대교주 슈트: 남색 슈트 + 빛나는 별 + 은색 장갑·부츠 + 보라 망토
      torsoVar = TORSO.Slim
      torsoA = sleeve = pants = hex(0x1d2054)
      torsoB = hex(0x6fe7ff)
      hand = shoe = hex(0xcfd6e2)
      addon = TORSO.Cape
      addonA = hex(0x6a3fd8)
      legVar = LEG.Boots
      break
  }

  // 머리 모양은 얼굴 종류에 묶인다(외형 튜플에 머리카락 칸이 없어서). 모자를 쓰면 삐져나오지 않는 평범한 캡으로.
  let hairVar: number = HAIR_BY_FACE[face] ?? HAIR.Short
  if (hat >= 1 && hat <= 8) {
    // 갓은 비쳐 보이므로 상투를 그대로 둔다
    if (!(hat === 3 && hairVar === HAIR.Knot)) hairVar = hairVar === HAIR.Comb ? HAIR.Comb : HAIR.Cap
  }
  const hair = lin(HAIR_COLOR[face] ?? HAIR_COLOR[0]!)

  const furDef = CAT_FUR[colorI % CAT_FUR.length]!

  return {
    skin,
    hair,
    hairVar,
    torsoVar,
    torsoA,
    torsoB,
    addon,
    addonA,
    armVar,
    sleeve,
    hand,
    legVar,
    pants,
    shoe,
    hat,
    // 야구모자만 옷 색을 따라간다. 나머지 모자는 고유색
    hatA: hat === 1 ? tint : C_WHITE,
    face,
    acc,
    aura,
    blush: mixRgb(skin, lin(0xff5f78), 0.36),
    facial: face === 6 ? lin(0xf2efe8) : hair,
    fur: lin(furDef[0]),
    fur2: lin(furDef[1]),
  }
}

/** 강조 화살표 등을 띄울 높이: 모자까지 포함한 머리 위(캐릭터 크기 1 기준, 바닥에서) */
export const HAT_TOP = [1.5, 1.56, 1.58, 1.68, 1.8, 1.86, 1.9, 1.68, 1.75, 1.84, 1.9]
