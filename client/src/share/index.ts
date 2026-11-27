/**
 * 공유 카드 진입점: 종류별로 그려서 PNG Blob 으로 만든다.
 * UI(ui/certificate.ts)와 미리보기 하네스(dev/cards.ts)가 같은 함수를 쓴다.
 */
import { drawCertificate, drawMeme, drawSummary, type CardEnv, type MemeInput } from './cards'
import type { SessionNumbers, ShareProfile } from './data'
import type { CardType } from './kit'

export type { CardType } from './kit'
export { CARD_SIZE } from './kit'
export type { CardEnv, MemeInput } from './cards'

export interface CardRequest {
  type: CardType
  profile: ShareProfile
  session: SessionNumbers
  portrait: HTMLCanvasElement | null
  meme: MemeInput
  env: CardEnv
}

/** 카드 한 장을 공용 offscreen 캔버스에 그린다(돌려받은 캔버스는 다음 호출 때 덮어쓰인다) */
export function renderCard(req: CardRequest): HTMLCanvasElement {
  if (req.type === 'certificate') return drawCertificate(req.profile, req.portrait, req.env)
  if (req.type === 'summary') return drawSummary(req.profile, req.session, req.portrait, req.env)
  return drawMeme(req.meme, req.profile.name, req.env)
}

export function canvasToBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      c.toBlob((b) => resolve(b), 'image/png')
    } catch {
      // 오염된(tainted) 캔버스 등: 저장 불가
      resolve(null)
    }
  })
}

/** 파일 이름: doas-<type>-<yyyymmdd>.png */
export function cardFileName(type: CardType, d: Date): string {
  const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `doas-${type}-${key}.png`
}
