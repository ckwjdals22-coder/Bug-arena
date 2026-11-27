/**
 * 나만의 교단: 창설/수정 폼, 내 교단 정보 카드, 탈퇴, 포교 링크 복사, 방 안 교단 순위표.
 *
 * 원칙
 *  - 이름표 미리보기는 다른 사람 화면의 이름표와 같은 클래스(overlay-cult/overlay-main)로 그린다 → 보이는 그대로.
 *  - 이름 검사는 서버와 같은 함수(checkCultName/checkTitle)로 먼저 해서, 막힐 이름은 보내기 전에 친절하게 알려 준다.
 *  - 순위표에는 실제 접속자 수와 NPC 신도 수를 따로 보여 준다(가짜 멀티플레이처럼 보이지 않게).
 *  - 교단 변화 알림 토스트는 social 모듈이 한 곳에서 띄운다(여기서는 실패 사유만 알린다).
 */
import './cult.css'
import { CULT_NAME_MAX, CULT_NAME_MIN, TITLE_MAX } from '../../../shared/constants'
import { CULT_COLORS, CULT_EMBLEMS, CULT_NAME_SUGGESTIONS, CULT_TITLE_SUGGESTIONS } from '../../../shared/content/core'
import { CULT_NAME_PATTERNS, CULT_NAME_SUFFIXES, CULT_NAME_THEMES } from '../../../shared/content/misc'
import type { SCultRes } from '../../../shared/protocol'
import { type TextCheck, checkCultName, checkTitle } from '../../../shared/rules/moderation'
import type { CultRef, CultScore } from '../../../shared/types'
import type { AppContext } from '../core/contracts'
import { inkOn, playSfx, rankName } from './hud'
import { clear, fmt, h, hex } from './kit'

const SCORE_REFRESH_MS = 10_000

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!
}

export function randomCultName(): string {
  for (let i = 0; i < 30; i++) {
    const name = pick(CULT_NAME_PATTERNS)(pick(CULT_NAME_THEMES), pick(CULT_NAME_SUFFIXES))
    if (Array.from(name).length <= CULT_NAME_MAX && checkCultName(name).ok) return name
  }
  return pick(CULT_NAME_SUGGESTIONS)
}

export function textCheckMessage(c: TextCheck, what: '이름' | '칭호'): string {
  if (c.ok) return ''
  switch (c.why) {
    case 'empty':
      return what === '이름' ? '교단 이름을 지어 주세요.' : '교주 칭호를 적어 주세요.'
    case 'short':
      return `이름은 ${CULT_NAME_MIN}자 이상이어야 해요.`
    case 'long':
      return what === '이름' ? `이름은 ${CULT_NAME_MAX}자까지예요.` : `칭호는 ${TITLE_MAX}자까지예요.`
    case 'bad':
      return '그 단어는 쓸 수 없어요. 조금 더 순한 말로 지어 볼까요?'
    case 'real':
      // 무엇 때문인지 알려 준다(띄어쓰기를 무시하고 보기 때문에 뜻밖의 낱말이 걸릴 수 있다)
      return c.hit
        ? `'${c.hit}'처럼 실존 종교·단체·인물·브랜드로 보일 수 있는 말은 쓸 수 없어요. 전부 허구여야 하거든요.`
        : '실존 단체처럼 보이는 이름은 쓸 수 없어요. 전부 허구여야 하거든요.'
  }
}

const RES_MSG: Record<NonNullable<SCultRes['why']>, string> = {
  name: '그 교단 이름은 쓸 수 없어요.',
  title: '그 칭호는 쓸 수 없어요.',
  dup: '같은 이름의 교단이 이미 있어요. 다른 이름을 지어 주세요!',
  rate: '조금만 쉬었다가 다시 해 주세요(8초).',
  bad: '요청이 올바르지 않아요. 다시 골라 주세요.',
}

/** 교단 이름표 한 줄(이름표와 같은 모양) */
export function cultTagEl(cult: Pick<CultRef, 'name' | 'color' | 'emblem' | 'title'>): HTMLElement {
  const color = CULT_COLORS[cult.color] ?? 0x7b5cff
  const el = h('div.overlay-cult.cult-tagline')
  el.style.background = hex(color)
  el.style.color = inkOn(color)
  // 이름표와 같은 구조: 이름이 길면 이름이 줄어들고 칭호는 끝까지 보인다
  el.append(h('span.overlay-cult-name', `${CULT_EMBLEMS[cult.emblem] ?? '🚩'} ${cult.name}`), h('span.overlay-cult-title', `· ${cult.title}`))
  return el
}

export function emblemBadge(cult: { color: number; emblem: number }, cls = ''): HTMLElement {
  const color = CULT_COLORS[cult.color] ?? 0x7b5cff
  const el = h('span.cult-emblem', { class: cls }, CULT_EMBLEMS[cult.emblem] ?? '🚩')
  el.style.background = hex(color)
  return el
}

/** 포교 링크: 같은 방 + 초대한 사람 닉네임 */
export function inviteLink(roomId: string, nickname: string): string {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}&by=${encodeURIComponent(nickname)}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 아래 예전 방식으로 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export function mountCult(ctx: AppContext): void {
  const { store, bus, ui, net } = ctx

  let tab: 'mine' | 'rank' = 'mine'
  /** 교주가 [정보 수정]을 누른 상태 */
  let editing = false
  /** 내가 보낸 창설/수정 요청의 결과를 기다리는 중 */
  let submitting = false
  let body: HTMLElement | null = null
  let scoreTimer = 0
  let scores: CultScore[] | null = null
  let lastSig = ''

  // 폼 입력값은 패널을 닫았다 열어도 남겨 둔다(실수로 닫아도 다시 쓰지 않게)
  const draft = { name: '', color: Math.floor(Math.random() * CULT_COLORS.length), emblem: Math.floor(Math.random() * CULT_EMBLEMS.length), title: CULT_TITLE_SUGGESTIONS[0] ?? '교주' }
  let suggestIdx = Math.floor(Math.random() * CULT_NAME_SUGGESTIONS.length)
  let suggestFlip = false

  const myCult = (): CultRef | null => store.me?.prog.cult ?? null
  const cultSig = (): string => {
    const c = myCult()
    if (!c) return ''
    const members = [...store.players.values()].filter((p) => p.pub.cult?.id === c.id).map((p) => `${p.pub.id}:${p.pub.name}:${p.pub.cult?.role}`)
    return `${c.id}|${c.name}|${c.color}|${c.emblem}|${c.title}|${c.role}|${store.me?.prog.cultFol}|${store.me?.prog.cultInf}|${members.join(',')}`
  }

  ui.addMenuItem({ id: 'cult', icon: '🏛️', label: '교단', order: 20, onClick: () => ui.openPanel('cult') })

  ui.registerPanel({
    id: 'cult',
    title: '나만의 교단',
    render(el) {
      body = el
      editing = false
      lastSig = cultSig()
      render()
      return () => {
        body = null
        stopScores()
      }
    },
  })

  function stopScores(): void {
    if (scoreTimer) window.clearInterval(scoreTimer)
    scoreTimer = 0
  }

  function requestScores(): void {
    net.send({ t: 'cults' })
  }

  function render(): void {
    if (!body) return
    clear(body)
    const tabs = h(
      'div.tabs.cult-tabs',
      h('button.tab', { class: tab === 'mine' ? 'on' : '', type: 'button', onclick: () => switchTab('mine') }, '🏛️ 내 교단'),
      h('button.tab', { class: tab === 'rank' ? 'on' : '', type: 'button', onclick: () => switchTab('rank') }, '🏆 교단 순위'),
    )
    body.append(tabs)
    if (tab === 'rank') {
      body.append(renderScores())
      if (!scoreTimer) {
        requestScores()
        scoreTimer = window.setInterval(requestScores, SCORE_REFRESH_MS)
      }
      return
    }
    stopScores()
    const cult = myCult()
    body.append(cult && !editing ? renderInfo(cult) : renderForm(cult))
  }

  function switchTab(t: 'mine' | 'rank'): void {
    if (tab === t) return
    playSfx(ctx, 'click')
    tab = t
    render()
  }

  // ───────── 창설 / 수정 폼 ─────────

  function renderForm(cult: CultRef | null): HTMLElement {
    if (cult && editing) {
      draft.name = cult.name
      draft.color = cult.color
      draft.emblem = cult.emblem
      draft.title = cult.title
    }
    const nameInput = h('input.field.cult-name-input', {
      type: 'text',
      value: draft.name,
      maxLength: CULT_NAME_MAX,
      placeholder: '예) 퇴근을 믿는 사람들',
      autocomplete: 'off',
      enterKeyHint: 'done',
      'aria-label': '교단 이름',
    })
    const titleInput = h('input.field.cult-title-input', {
      type: 'text',
      value: draft.title,
      maxLength: TITLE_MAX,
      placeholder: '예) 명예 과장',
      autocomplete: 'off',
      'aria-label': '교주 칭호',
    })
    const nameMsg = h('div.cult-msg')
    const titleMsg = h('div.cult-msg')
    const preview = h('div.cult-preview')
    const submit = h('button.btn.primary.big.block.cult-submit', { type: 'button' }, editing ? '💾 수정 저장' : '🏛️ 창설하기')

    const swatches = CULT_COLORS.map((c, i) =>
      h('button.swatch', {
        type: 'button',
        style: { background: hex(c) },
        'aria-label': `색 ${i + 1}`,
        onclick: () => {
          draft.color = i
          playSfx(ctx, 'pick')
          paint()
        },
      }),
    )
    const tiles = CULT_EMBLEMS.map((e, i) =>
      h('button.tile.cult-emblem-tile', {
        type: 'button',
        'aria-label': `엠블럼 ${e}`,
        onclick: () => {
          draft.emblem = i
          playSfx(ctx, 'pick')
          paint()
        },
      }, h('span.big', e)),
    )
    const chips = CULT_TITLE_SUGGESTIONS.map((t) =>
      h('button.chip.cult-chip', {
        type: 'button',
        onclick: () => {
          titleInput.value = t
          draft.title = t
          playSfx(ctx, 'pick')
          paint()
        },
      }, t),
    )

    const suggest = h('button.btn.sm.cult-dice', {
      type: 'button',
      title: '추천 이름',
      onclick: () => {
        // 준비된 추천 이름과 일상 단어 조합을 번갈아 보여 준다
        let next: string
        if (!suggestFlip) {
          next = CULT_NAME_SUGGESTIONS[suggestIdx % CULT_NAME_SUGGESTIONS.length] ?? '라면교'
          suggestIdx++
        } else {
          next = randomCultName()
        }
        suggestFlip = !suggestFlip
        if (next === nameInput.value) next = randomCultName()
        nameInput.value = next
        draft.name = next
        playSfx(ctx, 'pop')
        paint()
      },
    }, '🎲 추천')

    function checks(): { name: TextCheck; title: TextCheck } {
      return { name: checkCultName(nameInput.value), title: checkTitle(titleInput.value) }
    }

    let touched = { name: false, title: false }
    function paint(): void {
      swatches.forEach((s, i) => s.classList.toggle('on', i === draft.color))
      tiles.forEach((t, i) => t.classList.toggle('on', i === draft.emblem))
      const c = checks()
      const name = c.name.ok ? c.name.text : nameInput.value.trim() || '교단 이름'
      const title = c.title.ok ? c.title.text : titleInput.value.trim() || '칭호'
      const me = store.profile.name
      clear(preview)
      preview.append(
        h('div.cult-preview-label', '다른 사람에게 이렇게 보여요'),
        h(
          'div.cult-preview-tag',
          cultTagEl({ name, color: draft.color, emblem: draft.emblem, title }),
          h('div.overlay-main', h('span.overlay-name', me), h('span.overlay-rank', rankName(store.me?.prog.rank ?? 0))),
        ),
      )
      nameMsg.textContent = touched.name || nameInput.value ? textCheckMessage(c.name, '이름') : ''
      titleMsg.textContent = touched.title || !c.title.ok ? textCheckMessage(c.title, '칭호') : ''
      submit.disabled = !c.name.ok || !c.title.ok || submitting
    }

    nameInput.addEventListener('input', () => {
      draft.name = nameInput.value
      touched.name = true
      paint()
    })
    titleInput.addEventListener('input', () => {
      draft.title = titleInput.value
      touched.title = true
      paint()
    })
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur()
    })

    submit.addEventListener('click', () => {
      const c = checks()
      touched = { name: true, title: true }
      if (!c.name.ok || !c.title.ok) {
        paint()
        playSfx(ctx, 'error')
        return
      }
      submitting = true
      paint()
      net.send({ t: 'cultCreate', name: c.name.text, color: draft.color, emblem: draft.emblem, title: c.title.text })
      // 응답이 끝내 오지 않아도(끊김 등) 버튼이 영영 잠기지 않게
      window.setTimeout(() => {
        if (!submitting) return
        submitting = false
        if (body) paint()
      }, 4000)
    })

    const wrap = h(
      'div.cult-form',
      h('p.cult-lead.muted.small', editing ? '교단 정보를 고칩니다. 교단 기록은 그대로 남아요.' : '누구나 교단을 만들 수 있어요. 모든 교단은 이 게임 속 허구랍니다.'),
      preview,
      h('label.label', '교단 이름'),
      h('div.row', nameInput, suggest),
      nameMsg,
      h('label.label', '대표 색'),
      h('div.cult-swatches', swatches),
      h('label.label', '엠블럼'),
      h('div.cult-emblems', tiles),
      h('label.label', '교주 칭호'),
      titleInput,
      h('div.row.wrap.cult-chips', chips),
      titleMsg,
      submit,
      editing ? h('button.btn.ghost.block', { type: 'button', onclick: () => { editing = false; render() } }, '취소') : null,
    )
    paint()
    return wrap
  }

  // ───────── 정보 카드 ─────────

  function renderInfo(cult: CultRef): HTMLElement {
    const me = store.me
    const leader = cult.role === 'leader'
    const members = [...store.players.values()].filter((p) => p.pub.cult?.id === cult.id)
    const color = CULT_COLORS[cult.color] ?? 0x7b5cff

    const head = h(
      'div.cult-card-head',
      { style: { background: hex(color), color: inkOn(color) } },
      emblemBadge(cult, 'big'),
      h('div.grow', h('div.cult-card-name', cult.name), h('div.cult-card-sub', leader ? `교주 · ${cult.title}` : `교단원 · 교주 ${cult.leaderName}`)),
    )

    const stats = leader
      ? h(
          'div.cult-stats',
          h('div.cult-stat', h('b', fmt(me?.prog.cultFol ?? 0)), h('small', '교단이 모은 NPC 신도')),
          h('div.cult-stat', h('b', fmt(me?.prog.cultInf ?? 0)), h('small', '교단 누적 영향력')),
        )
      : h('p.small.muted', '교단원이 번 영향력도 교단 기록에 함께 쌓여요.')

    const memberRow = (name: string, role: string, isMe: boolean): HTMLElement =>
      h('li.cult-member', { class: isMe ? 'me' : '' }, h('span.tag.real', '접속'), h('span.grow.cult-member-name', name), h('span.small.muted', role))
    const list = h(
      'ul.cult-members',
      memberRow(store.profile.name, leader ? '교주' : '교단원', true),
      members.map((p) => memberRow(p.pub.name, p.pub.cult?.role === 'leader' ? '교주' : '교단원', false)),
    )

    const linkBtn = h('button.btn.purple.block.cult-link', { type: 'button', onclick: () => void copyLink(cult) }, '🔗 포교 링크 복사')
    const editBtn = leader
      ? h('button.btn.block.cult-edit', { type: 'button', onclick: () => { editing = true; playSfx(ctx, 'click'); render() } }, '✏️ 정보 수정')
      : null
    const leaveBtn = h('button.btn.danger.block.cult-leave', { type: 'button', onclick: () => void leave(cult) }, '🚪 탈퇴하기')

    return h(
      'div.cult-info',
      h('div.card.cult-card', head, stats),
      h('div.label', `이 방에 접속 중인 교단원 ${members.length + 1}명`),
      list,
      h('p.small.muted.cult-hint', '가까이 있는 사람 옆에서 📨 교단 초대를 누르면 권할 수 있어요. 상대가 수락해야만 들어와요.'),
      h('div.col', linkBtn, editBtn, leaveBtn),
    )
  }

  async function copyLink(cult: CultRef): Promise<void> {
    const roomId = store.room?.id ?? '1'
    const url = inviteLink(roomId, store.profile.name)
    const text = `🏛️ 게임 속 교단 「${cult.name}」에서 기다릴게요! (전부 허구) ${url}`
    const ok = await copyText(text)
    if (ok) {
      playSfx(ctx, 'pick')
      ui.toast('🔗 포교 링크를 복사했어요! 친구에게 보내 보세요', 'good')
    } else {
      ui.toast('복사하지 못했어요. 주소를 길게 눌러 복사해 주세요', 'bad', 4000)
      if (body) body.append(h('input.field.cult-link-field', { value: url, readOnly: true, onfocus: (e: Event) => (e.target as HTMLInputElement).select() }))
    }
  }

  async function leave(cult: CultRef): Promise<void> {
    playSfx(ctx, 'click')
    const text =
      cult.role === 'leader'
        ? `「${cult.name}」에서 탈퇴할까요?\n교주가 탈퇴하면 교단 정보와 교단 기록이 지워져요. 이미 들어온 교단원의 표시는 그대로 남아요.`
        : `「${cult.name}」에서 탈퇴할까요?\n언제든 다시 초대받을 수 있어요.`
    const ok = await ui.confirm(text, '탈퇴하기', '그대로 있기')
    if (!ok) return
    net.send({ t: 'cultLeave' })
  }

  // ───────── 순위표 ─────────

  function renderScores(): HTMLElement {
    const mine = myCult()?.id
    const note = h('p.small.muted.cult-rank-note', '👤 = 지금 이 방에 접속한 실제 사람, 🙏 = 교단이 모은 NPC 신도. 둘은 따로 셉니다.')
    if (!scores) return h('div.cult-rank', note, h('p.muted.center', '순위를 불러오는 중…'))
    if (scores.length === 0) return h('div.cult-rank', note, h('p.muted.center.cult-empty', '아직 교단이 없어요. 첫 교단을 만들어 보세요!'))
    return h(
      'div.cult-rank',
      note,
      h(
        'ol.cult-rank-list',
        scores.map((s, i) =>
          h(
            'li.cult-rank-row',
            { class: s.id === mine ? 'mine' : '' },
            h('span.cult-rank-no', String(i + 1)),
            emblemBadge(s),
            h('div.grow.cult-rank-main', h('div.cult-rank-name', s.name), h('div.small.muted', `교주 ${s.leaderName || '알 수 없음'}${s.title ? ` · ${s.title}` : ''}`)),
            h(
              'div.cult-rank-nums',
              h('span.cult-online', { class: s.online > 0 ? 'on' : '' }, `👤 ${s.online}명 접속`),
              h('span.small', `🙏 NPC ${fmt(s.fol)} · ✨ ${fmt(s.inf)}`),
            ),
          ),
        ),
      ),
    )
  }

  bus.onMsg('cults', (m) => {
    scores = Array.isArray(m.list) ? m.list : []
    if (body && tab === 'rank') render()
  })

  bus.onMsg('cultRes', (m) => {
    if (!submitting) return
    submitting = false
    if (m.ok) {
      editing = false
      if (body && tab === 'mine') render()
    } else {
      playSfx(ctx, 'error')
      ui.toast(RES_MSG[m.why ?? 'bad'] ?? RES_MSG.bad, 'bad', 3200)
      if (body && tab === 'mine') render()
    }
  })

  // 내 교단이나 같은 교단 사람이 바뀌면 정보 카드를 다시 그린다(폼을 쓰는 중이면 건드리지 않는다)
  const maybeRefresh = (): void => {
    if (!body || tab !== 'mine') return
    const sig = cultSig()
    if (sig === lastSig) return
    const hadCult = lastSig !== ''
    lastSig = sig
    if (editing && myCult()) return
    if (!myCult() && !hadCult) return
    editing = false
    render()
  }
  bus.on('profile', maybeRefresh)
  bus.on('progress', maybeRefresh)
  bus.on('playerUpdate', maybeRefresh)
  bus.on('playerJoin', maybeRefresh)
  bus.on('playerLeave', maybeRefresh)
  bus.on('phase', (p) => {
    if (p !== 'playing' && ui.openPanelId === 'cult') ui.closePanel()
  })
}
