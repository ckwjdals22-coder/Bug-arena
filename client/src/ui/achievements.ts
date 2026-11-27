/**
 * 업적 · 일일 수행 · 칭호 패널과 달성 알림.
 *
 * - 진행도는 서버 저장본(save → bus 'progress')에서 읽는다. 이 모듈은 상태를 따로 들지 않는다
 *   (보상 받기만 눌린 즉시 화면에 반영해 두고, 1초 안에 오는 저장본이 최종 상태를 덮어쓴다).
 * - 업적 달성 알림은 한꺼번에 여러 개 올 수 있어 줄을 세워 하나씩(≈2.2초) 보여 준다.
 * - 운세 카드는 '계시'라는 이름의 농담이다. 근거 없는 당연한 말만 나오고, 바닥에 "재미로만 보세요"를 박는다.
 */
import './achievements.css'
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID, DAILY_QUEST_BY_ID } from '../../../shared/content/achievements'
import { PROPHECIES } from '../../../shared/content/prophecies'
import type { AchievementDef } from '../../../shared/content/types'
import type { DailyState, Progress } from '../../../shared/types'
import type { AppContext } from '../core/contracts'
import { playSfx, rankName } from './hud'
import { clear, fmt, h } from './kit'

type Tab = 'daily' | 'ach' | 'title'
const TABS: readonly [Tab, string][] = [
  ['daily', '오늘의 수행'],
  ['ach', '업적'],
  ['title', '칭호'],
]

/** 서버 systems/achievements.ts 의 DAILY_BONUS 와 같은 값(표시용) */
const BONUS_INF = 20
const BONUS_COINS = 5
const BANNER_MS = 2200

/** 서버 날짜 기준 오늘(KST) 키 */
function todayKey(serverNow: number): string {
  return new Date(serverNow + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 오늘 것인 daily 만 돌려준다(자정을 넘겨 저장본이 아직 안 왔으면 null) */
function todayDaily(prog: Progress | undefined, serverNow: number): DailyState | null {
  const d = prog?.daily
  if (!d || !Array.isArray(d.quests)) return null
  return d.day === todayKey(serverNow) ? d : null
}

function claimable(d: DailyState | null): string[] {
  if (!d) return []
  return d.quests.filter((id) => {
    const def = DAILY_QUEST_BY_ID.get(id)
    return !!def && !d.done.includes(id) && (d.prog[id] ?? 0) >= def.n
  })
}

function dateLabel(day: string): string {
  const [y, m, dd] = day.split('-')
  return `${y}. ${Number(m)}. ${Number(dd)}.`
}

export function mountAchievements(ctx: AppContext): void {
  const { store, bus, ui, net } = ctx

  // ───────── 달성 알림 배너(줄 세우기) ─────────
  const banner = h('div.ach-banner.hidden', { 'aria-live': 'polite' })
  ui.root.append(banner)
  const queue: AchievementDef[] = []
  let showing = false
  const showNext = (): void => {
    const def = queue.shift()
    if (!def) {
      showing = false
      banner.classList.add('hidden')
      return
    }
    showing = true
    banner.replaceChildren(
      h('span.ach-banner-icon', def.icon),
      h('span.ach-banner-text', h('small', '🏆 업적 달성'), h('b', def.name)),
      h('span.ach-banner-inf', `+${def.inf}`),
    )
    banner.classList.remove('hidden', 'pop')
    // 같은 요소로 애니메이션을 다시 돌리려면 한 번 레이아웃을 끊어야 한다
    void banner.offsetWidth
    banner.classList.add('pop')
    playSfx(ctx, 'ach')
    window.setTimeout(showNext, BANNER_MS)
  }

  // 새 업적이 왔는데 아직 패널을 안 열어 봤는가(메뉴 점 표시)
  let unseenAch = false

  bus.onMsg('reward', (m) => {
    if (Array.isArray(m.ach) && m.ach.length > 0) {
      for (const id of m.ach) {
        const def = ACHIEVEMENT_BY_ID.get(id)
        if (def) queue.push(def)
      }
      unseenAch = true
      if (!showing) showNext()
      if (ui.openPanelId === 'achievements') rerender()
    }
    if (m.why === 'daily' && m.coins) ui.toast(`🎉 오늘의 수행 올클리어! 보너스 +${m.inf ?? 0} · 🪙${m.coins}`, 'gold', 3200)
  })

  bus.onMsg('err', (m) => {
    if (m.code !== 'daily') return
    if (m.msg) ui.toast(m.msg, 'bad')
    pending.clear()
    if (ui.openPanelId === 'achievements') rerender()
  })

  // ───────── 수령 가능 알림(한 번만, 조용히) ─────────
  const notified = new Set<string>()
  let notifiedDay = ''
  let primed = false
  const checkClaimable = (): void => {
    const d = todayDaily(store.me?.prog, store.serverNow())
    if (!d) return
    if (d.day !== notifiedDay) {
      notifiedDay = d.day
      notified.clear()
    }
    for (const id of claimable(d)) {
      if (notified.has(id)) continue
      notified.add(id)
      // 입장 직후 이미 끝나 있던 것은 알리지 않는다(배지로 충분)
      if (!primed) continue
      const def = DAILY_QUEST_BY_ID.get(id)
      if (def) ui.toast(`📿 수행 완료: ${def.text} — 메뉴에서 보상 받기`, 'good', 2800)
    }
    primed = true
  }
  bus.on('entered', () => {
    primed = false
    checkClaimable()
  })

  // 눌렀지만 아직 저장본으로 확인되지 않은 수령(두 번 누름 방지)
  const pending = new Set<string>()
  bus.on('progress', () => {
    const d = store.me?.prog.daily
    if (d) for (const id of [...pending]) if (d.done.includes(id)) pending.delete(id)
    checkClaimable()
    if (ui.openPanelId === 'achievements') rerender()
  })

  ui.addMenuItem({
    id: 'achievements',
    icon: '🏆',
    label: '업적·수행',
    order: 30,
    badge: () => {
      const n = claimable(todayDaily(store.me?.prog, store.serverNow())).filter((id) => !pending.has(id)).length
      return n > 0 ? n : unseenAch
    },
    onClick: () => ui.openPanel('achievements'),
  })

  // ───────── 패널 ─────────
  let tab: Tab = 'daily'
  let rerender: () => void = () => {}

  ui.registerPanel({
    id: 'achievements',
    title: '업적 · 수행',
    wide: true,
    render(body) {
      unseenAch = false
      const tabsEl = h('div.tabs.ach-tabs', { role: 'tablist' })
      const content = h('div.ach-content')
      body.append(tabsEl, content)

      let queued = false
      const draw = (): void => {
        const prog = store.me?.prog
        tabsEl.replaceChildren(
          ...TABS.map(([id, label]) => {
            const n = id === 'daily' ? claimable(todayDaily(prog, store.serverNow())).length : 0
            return h(
              'button.tab',
              {
                type: 'button',
                role: 'tab',
                class: tab === id ? 'on' : '',
                'aria-selected': String(tab === id),
                dataset: { tab: id },
                onclick: () => {
                  if (tab === id) return
                  tab = id
                  playSfx(ctx, 'click')
                  content.scrollTop = 0
                  draw()
                },
              },
              label,
              n > 0 ? h('span.badge.ach-tab-badge', String(n)) : null,
            )
          }),
        )
        const scroll = content.scrollTop
        clear(content)
        if (!prog) {
          content.append(h('p.muted', '방에 들어가면 볼 수 있어요.'))
          return
        }
        if (tab === 'daily') renderDaily(content, prog)
        else if (tab === 'ach') renderAch(content, prog)
        else renderTitle(content, prog)
        content.scrollTop = scroll
      }
      rerender = () => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          if (ui.openPanelId === 'achievements' && body.isConnected) draw()
        })
      }
      draw()
      return () => {
        rerender = () => {}
      }
    },
  })

  // ───────── 탭: 오늘의 수행 ─────────
  function renderDaily(el: HTMLElement, prog: Progress): void {
    const d = todayDaily(prog, store.serverNow())
    if (!d) {
      el.append(h('p.muted', '오늘의 수행을 받아 오는 중…'))
      return
    }
    const allDone = d.quests.length > 0 && d.quests.every((id) => d.done.includes(id))
    el.append(
      h(
        'div.ach-streak',
        h('span.ach-streak-day', h('small', '수행'), h('b', `${d.streak}일차`)),
        h('span.ach-streak-msg', d.streak >= 7 ? '이 정도면 출근입니다.' : d.streak >= 2 ? '어제 그 수상한 사람, 또 왔습니다.' : '오늘부터 수행 시작. 일단 와 본 것이 중요합니다.'),
      ),
    )
    const list = h('div.ach-quests')
    for (const id of d.quests) {
      const def = DAILY_QUEST_BY_ID.get(id)
      if (!def) continue
      const cur = Math.min(def.n, d.prog[id] ?? 0)
      const done = d.done.includes(id) || pending.has(id)
      const ready = !done && cur >= def.n
      let action: HTMLElement
      if (done) action = h('span.ach-quest-done', '받음 ✓')
      else if (ready) {
        action = h(
          'button.btn.primary.sm.ach-claim',
          {
            type: 'button',
            dataset: { q: id },
            onclick: () => {
              if (pending.has(id)) return
              pending.add(id)
              net.send({ t: 'daily', q: id })
              playSfx(ctx, 'coin')
              rerender()
            },
          },
          '보상 받기',
        )
      } else action = h('span.ach-quest-count', `${cur} / ${def.n}`)
      list.append(
        h(
          'div.ach-quest',
          { class: done ? 'done' : ready ? 'ready' : '' },
          h('div.ach-quest-main', h('div.ach-quest-text', def.text), h('div.bar.ach-quest-bar', h('i', { style: { width: `${(cur / def.n) * 100}%` } })), h('div.ach-quest-reward.small', `+${def.inf} 영향력`)),
          action,
        ),
      )
    }
    el.append(list)
    el.append(
      h(
        'p.ach-bonus',
        { class: allDone ? 'done' : '' },
        allDone ? `🎉 오늘 수행 올클리어! 보너스 +${BONUS_INF} 영향력 · 🪙${BONUS_COINS} 받음` : `세 가지 모두 받으면 보너스 +${BONUS_INF} 영향력 · 🪙${BONUS_COINS}`,
      ),
    )

    // 오늘의 계시 — 수상한 노란 쪽지 모양의 농담 카드
    const text = PROPHECIES[d.fortune] ?? PROPHECIES[0] ?? ''
    el.append(
      h(
        'div.ach-fortune',
        h('div.ach-fortune-head', h('span', '오늘의 계시'), h('span.ach-fortune-date', dateLabel(d.day))),
        h('p.ach-fortune-text', text),
        h('div.ach-fortune-stamp', '효험\n없음'),
        h('div.ach-fortune-foot', '재미로만 보세요 · 아무 근거 없음 · 내일 또 바뀜'),
      ),
    )
  }

  // ───────── 탭: 업적 ─────────
  function renderAch(el: HTMLElement, prog: Progress): void {
    const have = new Set(prog.ach)
    const total = ACHIEVEMENTS.length
    const got = ACHIEVEMENTS.filter((a) => have.has(a.id)).length
    const pct = total > 0 ? Math.floor((got / total) * 100) : 0
    el.append(
      h(
        'div.ach-summary',
        h('div.ach-summary-num', h('b', `${got}`), ` / ${total}`, h('span.ach-summary-pct', `${pct}%`)),
        h('div.bar.gold', h('i', { style: { width: `${pct}%` } })),
      ),
    )
    const sorted = [...ACHIEVEMENTS].sort((a, b) => Number(have.has(b.id)) - Number(have.has(a.id)))
    const list = h('div.ach-list')
    for (const a of sorted) {
      const ok = have.has(a.id)
      const hidden = !ok && a.secret
      const v = Math.min(a.gte, prog.stats[a.stat] ?? 0)
      list.append(
        h(
          'div.ach-item',
          { class: ok ? 'got' : hidden ? 'secret' : '' },
          h('span.ach-item-icon', hidden ? '❔' : a.icon),
          h(
            'div.ach-item-main',
            h('div.ach-item-name', hidden ? '???' : a.name, ok ? h('span.ach-item-check', '달성') : null),
            h('div.ach-item-desc', hidden ? '숨겨진 업적. 하다 보면 언젠가 알게 됩니다.' : a.desc),
            hidden || ok ? null : h('div.ach-item-prog', h('div.bar', h('i', { style: { width: `${(v / a.gte) * 100}%` } })), h('span.small', `${fmt(v)} / ${fmt(a.gte)}`)),
          ),
          h('span.ach-item-inf', `+${a.inf}`),
        ),
      )
    }
    el.append(list)
  }

  // ───────── 탭: 칭호 ─────────
  function renderTitle(el: HTMLElement, prog: Progress): void {
    const cur = prog.tag && prog.ach.includes(prog.tag) ? prog.tag : ''
    const curDef = cur ? ACHIEVEMENT_BY_ID.get(cur) : undefined
    el.append(
      h(
        'div.ach-preview',
        h('div.label', '이름표 미리보기'),
        h(
          'div.ach-preview-tag',
          h('span.ach-preview-name', store.profile.name),
          h('span.ach-preview-rank', curDef ? `${curDef.name} · ${rankName(prog.rank)}` : rankName(prog.rank)),
        ),
      ),
    )
    const owned = ACHIEVEMENTS.filter((a) => prog.ach.includes(a.id))
    const pick = (id: string): void => {
      if (id === cur) return
      net.send({ t: 'profile', tag: id })
      // 저장본이 오기 전에 미리 반영(서버가 업적 보유 여부를 다시 검사한다)
      if (store.me) {
        if (id) store.me.prog.tag = id
        else delete store.me.prog.tag
        bus.emit('profile')
      }
      playSfx(ctx, 'pick')
      rerender()
    }
    const grid = h('div.ach-titles')
    grid.append(h('button.tile.ach-title-tile', { type: 'button', class: cur ? '' : 'on', dataset: { tag: '' }, onclick: () => pick('') }, h('span.big', '➖'), '칭호 없음'))
    for (const a of owned) {
      grid.append(h('button.tile.ach-title-tile', { type: 'button', class: cur === a.id ? 'on' : '', dataset: { tag: a.id }, onclick: () => pick(a.id) }, h('span.big', a.icon), a.name))
    }
    el.append(grid)
    if (owned.length === 0) el.append(h('p.muted.small.ach-title-empty', '아직 칭호가 없습니다. 업적을 달성하면 이름표에 달 수 있어요.'))
  }
}
