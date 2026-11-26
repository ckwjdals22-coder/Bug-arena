/**
 * 프로필 패널: 닉네임 수정 · 꾸미기(초상 미리보기) · 통계 · 직급 진행도.
 * 입장할 때는 아무것도 묻지 않고, 바꾸고 싶은 사람만 나중에 여기서 바꾼다(조사 01 §4-2 "결정을 뒤로 미룬다").
 */
import './profile.css'
import { NAME_MAX, NAME_MIN } from '../../../shared/constants'
import { ACCESSORIES, AURAS, FACES, HATS, OUTFITS, OUTFIT_COLORS, RANKS, SKIN_COLORS } from '../../../shared/content/core'
import type { CosmeticDef } from '../../../shared/content/types'
import { checkNickname } from '../../../shared/rules/moderation'
import { isCosmeticUnlocked } from '../../../shared/rules/progress'
import type { Look } from '../../../shared/types'
import type { AppContext } from '../core/contracts'
import { randomNickname } from '../core/store'
import { playSfx, rankName, rankProgress } from './hud'
import { clear, fmt, h, hex } from './kit'

interface LookTab {
  label: string
  /** Look 튜플에서 이 탭이 바꾸는 칸 */
  slot: number
  colors?: readonly number[]
  items?: readonly CosmeticDef[]
  /** 카탈로그 순서에 맞춘 그림 글자(에셋 없이 종류를 구분하기 위한 표시일 뿐) */
  icons?: readonly string[]
}

const TABS: readonly LookTab[] = [
  { label: '피부', slot: 0, colors: SKIN_COLORS },
  { label: '복장', slot: 1, items: OUTFITS, icons: ['👕', '🧥', '👔', '🥋', '🦺', '👘', '🧙', '🌟', '🦸', '🚀'] },
  { label: '색', slot: 2, colors: OUTFIT_COLORS },
  { label: '모자', slot: 3, items: HATS, icons: ['➖', '🧢', '👒', '🎩', '⛱️', '💿', '🔺', '👑', '📡', '😇', '🛸'] },
  { label: '얼굴', slot: 4, items: FACES, icons: ['🙂', '😏', '😪', '🥺', '😎', '🥸', '🧙'] },
  { label: '소품', slot: 5, items: ACCESSORIES, icons: ['➖', '🎗️', '🔮', '🎒', '📢', '🥇'] },
  { label: '오라', slot: 6, items: AURAS, icons: ['➖', '✨', '🌟', '🌈', '🌌'] },
]

const NAME_HINT = `${NAME_MIN}~${NAME_MAX}자까지 쓸 수 있어요.`

const sameLook = (a: Look, b: Look): boolean => a.every((v, i) => v === b[i])

export function mountProfile(ctx: AppContext): void {
  const { store, bus, ui } = ctx
  const click = (): void => playSfx(ctx, 'click')

  ui.addMenuItem({
    id: 'profile',
    icon: '🪪',
    label: '내 프로필 · 꾸미기',
    order: 10,
    onClick: () => ui.openPanel('profile'),
  })

  ui.registerPanel({
    id: 'profile',
    title: '내 프로필',
    wide: true,
    render(body) {
      const myRank = (): number => store.me?.prog.rank ?? 0
      const myAch = (): readonly string[] => store.me?.prog.ach ?? []

      let baseline: Look = store.profile.look.slice() as Look
      let draft: Look = baseline.slice() as Look
      let tabIdx = 1

      // ───────── 초상 ─────────
      const portraitBox = h('div.profile-portrait')
      let portraitQueued = false
      const drawPortrait = (): void => {
        if (portraitQueued) return
        portraitQueued = true
        // 연달아 고르면 한 프레임에 한 번만 다시 그린다(초상 렌더는 가볍지 않다)
        requestAnimationFrame(() => {
          portraitQueued = false
          try {
            const canvas = ctx.chars.portrait(draft.slice() as Look, 160)
            canvas.classList.add('profile-portrait-canvas')
            portraitBox.replaceChildren(canvas)
          } catch (err) {
            console.error('[profile] portrait error', err)
            portraitBox.replaceChildren(h('span.profile-portrait-fallback', '🙂'))
          }
        })
      }

      // ───────── 닉네임 ─────────
      const nameInput = h('input.field.profile-name-input', {
        type: 'text',
        value: store.profile.name,
        maxLength: NAME_MAX,
        autocomplete: 'off',
        autocapitalize: 'off',
        enterKeyHint: 'done',
        'aria-label': '닉네임',
      })
      nameInput.spellcheck = false
      const nameMsg = h('p.profile-name-msg.small', NAME_HINT)
      const saveBtn = h('button.btn.primary.block.profile-save', { type: 'button', disabled: true }, '닉네임 저장')

      const validateName = (): string | null => {
        const res = checkNickname(nameInput.value)
        let msg = NAME_HINT
        let ok = false
        if (!res.ok) {
          if (res.why === 'empty') msg = '닉네임을 입력해 주세요.'
          else if (res.why === 'short') msg = `닉네임은 ${NAME_MIN}자 이상이어야 해요.`
          else if (res.why === 'long') msg = `닉네임은 ${NAME_MAX}자까지 쓸 수 있어요.`
          else msg = '쓸 수 없는 말이 들어 있어요. 다른 이름으로 지어 주세요.'
        } else if (res.text === store.profile.name) {
          msg = '지금 쓰고 있는 이름이에요.'
        } else {
          ok = true
          msg = `'${res.text}' — 쓸 수 있는 이름이에요!`
        }
        nameMsg.textContent = msg
        nameMsg.classList.toggle('bad', !res.ok)
        nameMsg.classList.toggle('good', ok)
        saveBtn.disabled = !ok
        return ok && res.ok ? res.text : null
      }
      const saveName = (): void => {
        const text = validateName()
        if (!text) return
        click()
        ctx.actions.setName(text)
        nameInput.value = text
        nameInput.blur()
        saveBtn.disabled = true
        nameMsg.textContent = '닉네임을 바꿨어요. 이름표에 바로 보여요.'
        nameMsg.classList.remove('bad')
        nameMsg.classList.add('good')
        ui.toast('닉네임을 바꿨어요!', 'good')
      }
      nameInput.addEventListener('input', validateName)
      nameInput.addEventListener('keydown', (e) => {
        // 이름을 치는 동안 게임 단축키(WASD, 숫자, E …)가 반응하지 않게 막는다. Esc 는 패널 닫기라 통과시킨다
        if (e.key !== 'Escape') e.stopPropagation()
        if (e.key === 'Enter' && !e.isComposing) saveName()
      })
      saveBtn.addEventListener('click', saveName)
      const diceBtn = h(
        'button.icon-btn.profile-dice',
        {
          type: 'button',
          title: '아무 이름이나 뽑기',
          'aria-label': '닉네임 무작위로 뽑기',
          onclick: () => {
            click()
            let next = randomNickname()
            // 지금 이름과 같은 게 뽑히면 한 번 더
            if (next === nameInput.value) next = randomNickname()
            nameInput.value = next
            validateName()
          },
        },
        '🎲',
      )

      // ───────── 꾸미기 ─────────
      const tabsEl = h('div.tabs.profile-tabs', { role: 'tablist' })
      const gridEl = h('div.profile-grid')
      const noteEl = h('p.profile-note.small.muted')
      const applyBtn = h('button.btn.purple.profile-apply', { type: 'button' }, '이 모습으로 변신!')
      const resetBtn = h('button.btn.ghost.profile-reset', { type: 'button' }, '되돌리기')

      const syncApply = (): void => {
        const changed = !sameLook(draft, baseline)
        applyBtn.disabled = !changed
        resetBtn.disabled = !changed
      }

      const lockText = (def: CosmeticDef): string => (def.ach ? '🔒 업적으로 열려요' : '🔒 ' + rankName(def.rank))

      const choose = (slot: number, value: number): void => {
        click()
        draft[slot] = value
        drawGrid()
        drawPortrait()
        syncApply()
      }

      function drawGrid(): void {
        const tab = TABS[tabIdx]!
        clear(gridEl)
        gridEl.classList.toggle('swatches', !!tab.colors)
        noteEl.textContent = ''
        if (tab.colors) {
          tab.colors.forEach((color, i) => {
            gridEl.append(
              h('button.swatch.profile-swatch', {
                type: 'button',
                class: draft[tab.slot] === i ? 'on' : '',
                style: { background: hex(color) },
                'aria-label': `${tab.label} ${i + 1}번`,
                'aria-pressed': draft[tab.slot] === i ? 'true' : 'false',
                onclick: () => choose(tab.slot, i),
              }),
            )
          })
          // 색이 고정된 복장을 입고 색을 바꾸면 "왜 안 변하지?" 가 된다 → 미리 알려 준다
          if (tab.slot === 2 && OUTFITS[draft[1]]?.tint === false) noteEl.textContent = `'${OUTFITS[draft[1]]!.name}' 복장은 색이 정해져 있어요. 다른 복장에서 색이 보여요.`
          return
        }
        const rank = myRank()
        const ach = myAch()
        ;(tab.items ?? []).forEach((def, i) => {
          const locked = !isCosmeticUnlocked(def, rank, ach)
          const on = draft[tab.slot] === def.id
          gridEl.append(
            h(
              'button.tile.profile-tile',
              {
                type: 'button',
                class: (locked ? 'locked ' : '') + (on ? 'on' : ''),
                'aria-disabled': locked ? 'true' : undefined,
                'aria-pressed': on ? 'true' : 'false',
                onclick: () => {
                  if (locked) {
                    click()
                    ui.toast(def.ach ? '특별한 업적을 달성하면 열려요.' : `'${rankName(def.rank)}' 직급이 되면 열려요.`, 'info')
                    return
                  }
                  choose(tab.slot, def.id)
                },
              },
              h('span.big', tab.icons?.[i] ?? '🎁'),
              h('span.profile-tile-name', def.name),
              locked ? h('span.profile-lock', lockText(def)) : null,
            ),
          )
        })
      }

      const tabBtns = TABS.map((tab, i) =>
        h(
          'button.tab.profile-tab',
          {
            type: 'button',
            role: 'tab',
            onclick: () => {
              click()
              tabIdx = i
              syncTabs()
              drawGrid()
            },
          },
          tab.label,
        ),
      )
      const syncTabs = (): void => {
        tabBtns.forEach((b, i) => {
          b.classList.toggle('on', i === tabIdx)
          b.setAttribute('aria-selected', i === tabIdx ? 'true' : 'false')
        })
      }
      tabsEl.append(...tabBtns)

      applyBtn.addEventListener('click', () => {
        if (sameLook(draft, baseline)) return
        click()
        const look = draft.slice() as Look
        ctx.actions.setLook(look)
        baseline = look
        syncApply()
        ui.toast('변신 완료! 다른 사람에게도 바로 보여요.', 'good')
      })
      resetBtn.addEventListener('click', () => {
        click()
        draft = baseline.slice() as Look
        drawGrid()
        drawPortrait()
        syncApply()
      })

      // ───────── 통계 / 직급 ─────────
      const statFol = h('b')
      const statInf = h('b')
      const statCoin = h('b')
      const stats = h(
        'div.profile-stats',
        h('div.profile-stat', h('span.profile-stat-icon', '🙏'), statFol, h('small', '누적 신도')),
        h('div.profile-stat', h('span.profile-stat-icon', '✨'), statInf, h('small', '영향력')),
        h('div.profile-stat', { title: '게임 안에서만 쓰는 가짜 코인이에요. 실제 돈과는 아무 상관이 없어요.' }, h('span.profile-stat-icon', '🪙'), statCoin, h('small', '가상 코인')),
      )

      const rankNow = h('b.profile-rank-now')
      const rankNums = h('span.profile-rank-nums')
      const rankFill = h('i')
      const rankHint = h('p.profile-rank-hint.small')
      const rankList = h('ol.profile-ranks')

      let lastRank = -1
      function drawProgress(): void {
        const prog = store.me?.prog
        const inf = prog?.inf ?? 0
        const rank = prog?.rank ?? 0
        statFol.textContent = fmt(prog?.fol ?? 0)
        statInf.textContent = fmt(inf)
        statCoin.textContent = fmt(prog?.coins ?? 0)

        const rp = rankProgress(inf, rank)
        rankNow.textContent = rp.cur.name
        rankNums.textContent = rp.next ? `영향력 ${fmt(inf)} / ${fmt(rp.next.inf)}` : `영향력 ${fmt(inf)}`
        rankFill.style.width = Math.round(rp.ratio * 100) + '%'
        rankHint.textContent = rp.next ? `다음 직급 '${rp.next.name}'까지 영향력 ${fmt(rp.left)} 남았어요.` : '최고 직급이에요. 이제 우주가 교주님을 따릅니다.'

        if (rank === lastRank) return
        // 직급이 바뀌었을 때만 목록과 잠금 상태를 다시 그린다
        const first = lastRank < 0
        lastRank = rank
        clear(rankList)
        for (const def of RANKS) {
          const state = def.id < rank ? 'done' : def.id === rank ? 'now' : 'locked'
          rankList.append(
            h(
              'li.profile-rank-row',
              { class: state },
              h('span.profile-rank-mark', { 'aria-hidden': 'true' }, state === 'done' ? '✅' : state === 'now' ? '👉' : '🔒'),
              h('div.grow', h('div.profile-rank-line', h('b', def.name), h('span.profile-rank-need', def.inf > 0 ? `영향력 ${fmt(def.inf)}` : '시작')), h('div.profile-rank-unlock', def.unlock)),
            ),
          )
        }
        if (!first) drawGrid()
      }

      body.append(
        h(
          'div.profile',
          h('div.profile-side', portraitBox, h('div.profile-name', h('label.label', '닉네임'), nameInput, nameMsg, h('div.profile-name-row', diceBtn, saveBtn))),
          h(
            'div.profile-main',
            h('section.profile-look', h('h3.profile-h', '꾸미기'), tabsEl, gridEl, noteEl, h('div.profile-look-actions', resetBtn, applyBtn)),
            stats,
            h(
              'section.profile-rank',
              h('h3.profile-h', '직급'),
              h('div.profile-rank-head', rankNow, rankNums),
              h('div.bar.gold.profile-rank-bar', rankFill),
              rankHint,
              rankList,
            ),
          ),
        ),
      )

      syncTabs()
      drawGrid()
      drawPortrait()
      syncApply()
      drawProgress()

      const offProgress = bus.on('progress', drawProgress)
      const offRank = bus.on('rankUp', drawProgress)
      const offProfile = bus.on('profile', () => {
        // 서버가 이름/외형을 다듬어 돌려줄 수 있다. 입력 중인 글자와 고르는 중인 옷은 덮어쓰지 않는다
        if (document.activeElement !== nameInput) {
          nameInput.value = store.profile.name
          saveBtn.disabled = true
        }
        if (sameLook(draft, baseline) && !sameLook(baseline, store.profile.look)) {
          baseline = store.profile.look.slice() as Look
          draft = baseline.slice() as Look
          drawGrid()
          drawPortrait()
        }
      })
      return () => {
        offProgress()
        offRank()
        offProfile()
      }
    },
  })
}
