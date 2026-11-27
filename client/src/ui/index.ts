/**
 * UI 모듈 등록부. main 이 AppContext 를 만든 뒤 mountUi(ctx) 를 한 번 호출한다.
 * 각 모듈은 자기 DOM 을 ctx.ui.root 아래에 만들고, bus/store 를 구독한다.
 */
import type { AppContext } from '../core/contracts'
import { mountAchievements } from './achievements'
import { mountBattle } from './battle'
import { mountCertificate } from './certificate'
import { mountCult } from './cult'
import { mountEmotes } from './emotes'
import { mountEvents } from './events'
import { mountHud } from './hud'
import { mountOffering } from './offering'
import { mountPodium } from './podium'
import { mountProfile } from './profile'
import { mountSettings } from './settings'
import { mountShop } from './shop'
import { mountSocial } from './social'
import { mountSystem } from './system'
import { mountTalk } from './talk'
import { mountTitle } from './title'
import { mountTutorial } from './tutorial'

export function mountUi(ctx: AppContext): void {
  const mounts: [string, (ctx: AppContext) => void][] = [
    ['hud', mountHud],
    ['title', mountTitle],
    ['system', mountSystem],
    ['talk', mountTalk],
    ['emotes', mountEmotes],
    ['profile', mountProfile],
    ['cult', mountCult],
    ['social', mountSocial],
    ['podium', mountPodium],
    ['battle', mountBattle],
    ['offering', mountOffering],
    ['shop', mountShop],
    ['achievements', mountAchievements],
    ['certificate', mountCertificate],
    ['settings', mountSettings],
    ['tutorial', mountTutorial],
    ['events', mountEvents],
  ]
  for (const [name, mount] of mounts) {
    try {
      mount(ctx)
    } catch (err) {
      // UI 모듈 하나가 실패해도 게임은 계속 돌아가야 한다
      console.error(`[ui] mount failed: ${name}`, err)
    }
  }
}
