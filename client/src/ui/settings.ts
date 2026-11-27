/**
 * 설정 · 도움말 · 고지. 메뉴의 [설정·도움말] 패널.
 * 설정을 바꾸면 기기에 저장하고 bus 'settings' 를 발행한다(main 이 소리/화질에 반영).
 */
import { RANKS } from '../../../shared/content/core'
import { DISCLAIMER } from '../../../shared/content/misc'
import type { AppContext, QualityTier } from '../core/contracts'
import { type Settings, saveProfile } from '../core/store'
import { playSfx } from './hud'
import { clear, h } from './kit'
import './settings.css'

const PROFILE_KEY = 'doas.profile.v1'
const VERSION = '0.9'

type ToggleKey = 'sfx' | 'music' | 'showNames' | 'noInvites'
const TOGGLES: { key: ToggleKey; label: string; hint: string }[] = [
  { key: 'sfx', label: '효과음', hint: '포교 성공의 뾰로롱, 실패의 뿌우…' },
  { key: 'music', label: '배경음', hint: '잔잔하고 살짝 수상한 반복 음악 (기본 꺼짐)' },
  { key: 'showNames', label: '이름표 항상 표시', hint: '끄면 가까이 있는 사람의 이름만 보여요' },
  { key: 'noInvites', label: '교단 초대·배틀 신청 받지 않기', hint: '조용히 구경만 하고 싶을 때' },
]
const QUALITIES: { id: Settings['quality']; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'low', label: '낮음' },
  { id: 'mid', label: '보통' },
  { id: 'high', label: '높음' },
]

function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export function mountSettings(ctx: AppContext): void {
  const { store, bus, ui } = ctx

  ui.addMenuItem({ id: 'settings', icon: '⚙️', label: '설정·도움말', order: 90, onClick: () => ui.openPanel('settings') })

  function change(): void {
    saveProfile(store.profile)
    bus.emit('settings')
  }

  ui.registerPanel({
    id: 'settings',
    title: '⚙️ 설정 · 도움말',
    render(body) {
      const s = store.profile.settings
      let helpTouch = isTouch()

      // ── 설정 ──
      const toggles = h('div.settings-list')
      for (const t of TOGGLES) {
        const btn = h('button.settings-switch', { type: 'button', role: 'switch', 'aria-checked': String(s[t.key]), 'aria-label': t.label })
        btn.classList.toggle('on', s[t.key])
        btn.addEventListener('click', () => {
          s[t.key] = !s[t.key]
          btn.classList.toggle('on', s[t.key])
          btn.setAttribute('aria-checked', String(s[t.key]))
          change()
          // 소리를 방금 켰다면 바로 들려준다
          if (t.key !== 'sfx' || s.sfx) playSfx(ctx, 'click')
        })
        toggles.append(h('div.settings-row', h('div.grow', h('div.settings-label', t.label), h('div.muted.small', t.hint)), btn))
      }

      const qualityBtns = h('div.settings-seg', { role: 'radiogroup', 'aria-label': '화질' })
      const drawQuality = (): void => {
        clear(qualityBtns)
        for (const q of QUALITIES) {
          qualityBtns.append(
            h(
              'button.settings-seg-btn',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String(s.quality === q.id),
                class: s.quality === q.id ? 'on' : '',
                onclick: () => {
                  s.quality = q.id
                  change()
                  playSfx(ctx, 'click')
                  drawQuality()
                },
              },
              q.label,
            ),
          )
        }
      }
      drawQuality()

      // ── 도움말 ──
      const help = h('div.settings-help')
      const kbd = (k: string): HTMLElement => h('kbd.settings-kbd', k)
      const drawHelp = (): void => {
        clear(help)
        const rows: (string | Node)[][] = helpTouch
          ? [
              ['화면 왼쪽을 누른 채 밀기', '이동 (끝까지 밀면 달리기)'],
              ['화면 오른쪽 드래그', '시점 돌리기'],
              ['두 손가락 벌리기', '확대/축소'],
              ['바닥 톡', '그곳으로 이동'],
              ['시민 톡', '다가가서 말 걸기'],
              ['오른쪽 아래 큰 버튼', '지금 할 수 있는 행동 (말 걸기 등)'],
            ]
          : [
              [h('span', kbd('W'), kbd('A'), kbd('S'), kbd('D'), ' / 방향키'), '이동'],
              [kbd('Shift'), '달리기'],
              ['마우스 드래그 / 휠', '시점 돌리기 / 확대'],
              [h('span', kbd('E'), ' 또는 ', kbd('Space')), '지금 할 수 있는 행동 (말 걸기 등)'],
              [h('span', kbd('1'), '~', kbd('8')), '동작 (8번은 도망가기)'],
              ['바닥 클릭 / 시민 클릭', '그곳으로 이동 / 다가가서 말 걸기'],
              [kbd('Esc'), '창 닫기'],
            ]
        for (const [k, v] of rows) help.append(h('div.settings-help-row', h('div.settings-help-key', k as Node | string), h('div', v as Node | string)))
        help.append(
          h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: () => {
                helpTouch = !helpTouch
                drawHelp()
              },
            },
            helpTouch ? '키보드·마우스 조작 보기' : '터치 조작 보기',
          ),
        )
      }
      drawHelp()

      // ── 방 / 초대 ──
      const room = store.room
      const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(room?.id ?? '1')}`
      const linkField = h('input.field.settings-link', { readOnly: true, value: link, 'aria-label': '초대 링크' })
      const copyBtn = h(
        'button.btn.sm.primary',
        {
          type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(link)
              ui.toast('초대 링크를 복사했어요. 친구에게 보내 보세요!', 'good')
            } catch {
              linkField.select()
              ui.toast('링크를 길게 눌러 복사해 주세요.', 'info')
            }
          },
        },
        '링크 복사',
      )

      // ── 데이터 초기화 ──
      const resetBtn = h(
        'button.btn.sm.danger',
        {
          type: 'button',
          onclick: async () => {
            if (!(await ui.confirm('이 기기에 저장된 닉네임·신도·업적·교단이 모두 사라집니다.\n정말 처음부터 다시 시작할까요?\n(서버 순위표에 남은 교단 기록은 지워지지 않아요.)', '초기화', '취소'))) return
            if (!(await ui.confirm('되돌릴 수 없습니다. 진짜로요?', '네, 지웁니다', '아니요'))) return
            ctx.net.disconnect()
            try {
              localStorage.removeItem(PROFILE_KEY)
            } catch {
              /* 저장소를 못 쓰는 환경이면 지울 것도 없다 */
            }
            location.reload()
          },
        },
        '데이터 초기화',
      )

      body.append(
        h('h3.settings-h', '설정'),
        toggles,
        h('div.settings-row', h('div.grow', h('div.settings-label', '화질'), h('div.muted.small', '자동: 기기에 맞춰 조절합니다')), qualityBtns),
        h('h3.settings-h', '조작법'),
        help,
        h('h3.settings-h', '친구 부르기'),
        h(
          'div.card.flat.col',
          h('div', h('b', room?.name ?? '수상역'), ' · ', `👤 ${room?.players ?? 1}/${room?.cap ?? 20} · 🤖 ${room?.npcs ?? 0}`),
          h('div.muted.small', '👤 는 지금 접속해 있는 진짜 사람, 🤖 는 서버가 움직이는 가상 시민(NPC)입니다. 둘은 절대 섞어 세지 않습니다.'),
          h('div.row', linkField, copyBtn),
        ),
        h('h3.settings-h', '알아 두세요'),
        h(
          'div.card.flat.col.settings-notice',
          h('p', DISCLAIMER),
          // 실제 코드와 맞춰 쓴다: 브라우저 저장(store.ts LocalProfile), hello 로 보내는 것(기기 번호·닉네임·꾸미기·진행도),
          // 서버에 남는 것(교단 등록부 cults.json, 신고 로그), IP 사용처(IP당 동시 접속 상한)
          h(
            'p',
            '회원가입이 없습니다. 이 브라우저에는 임의로 만든 기기 번호, 닉네임, 꾸미기, 설정, 차단 목록, 게임 진행도만 저장됩니다. ' +
              '서버는 기기 번호·닉네임·게임 속 행동을 받아 게임을 진행하고, 교단 이름·칭호와 교주 닉네임은 순위표를 위해 서버에 남습니다. ' +
              '신고가 들어오면 신고 내용(기기 번호·닉네임)이 운영 기록에 남고, 접속 주소(IP)는 과다 접속 제한에만 씁니다. 광고·추적 도구는 쓰지 않습니다.',
          ),
          h('p', '헌금함·코인·헌납품은 전부 가상입니다. 이 게임에는 결제가 없고, 누구도 실제 돈이나 연락처를 요구하지 않습니다.'),
          h('p.settings-real', '현실에서 불쾌한 길거리 권유를 받으면 대꾸하지 않고 지나가도 됩니다. 계속 따라오면 112.'),
        ),
        h('div.row.between.settings-foot', h('span.muted.small', `버전 ${VERSION} · 직급 ${RANKS.length}단계 · ${import.meta.env.MODE}`), resetBtn),
      )
    },
  })

  // 화질을 수동으로 고른 경우 바로 반영(자동으로 되돌리면 다음 접속부터 추정값을 쓴다)
  bus.on('settings', () => {
    const q = store.profile.settings.quality
    if (q !== 'auto') ctx.engine.setQuality(q as QualityTier)
  })
}
