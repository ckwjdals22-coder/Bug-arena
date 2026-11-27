/**
 * 실제 접속자끼리의 상호작용: 가까운 사람에게 손 흔들기 / 교단 초대 / 따라 하기 / 더보기(차단·신고),
 * 초대 카드(수락·거절·차단), 초대 결과 토스트, 신고 결과 안내, 내 교단 변화 알림.
 *
 * 원칙
 *  - 초대 카드는 화면을 막지 않는다(패널이 아니라 떠 있는 카드). 조이스틱 자리(왼쪽 아래)는 피한다.
 *  - 가입은 내가 [따라간다]를 눌렀을 때만. '초대 받지 않기' 설정이면 카드 없이 조용히 거절한다.
 *  - 차단은 상대에게 드러나지 않는다(서버가 '거절'로만 보낸다). 여기서는 내 화면에서만 차단 표시를 한다.
 *  - 다른 사람 닉네임/교단 이름은 전부 textContent 로만 넣는다(kit.h 의 문자열 자식).
 */
import './social.css'
import { INVITE_COOLDOWN_MS, INVITE_GLOBAL_COOLDOWN_MS, INVITE_TTL_MS, REPORT_COOLDOWN_MS } from '../../../shared/constants'
import { CULT_COLORS, EMOTES } from '../../../shared/content/core'
import type { SInvited } from '../../../shared/protocol'
import type { CultRef } from '../../../shared/types'
import type { AppContext, ContextAction } from '../core/contracts'
import { saveProfile } from '../core/store'
import { cultTagEl, emblemBadge } from './cult'
import { inkOn, makePopup, playSfx, rankName } from './hud'
import { h, hex } from './kit'

/** 거절당했을 때 초대한 사람에게 보이는 대사 — 거절은 언제나 정상이고, 웃음거리는 초대한 쪽이다 */
const DECLINE_LINES: readonly string[] = [
  '아, 저 오늘 라면 물 올려놨어요.',
  '괜찮아요, 저는 이미 퇴근을 믿어요.',
  '다음 생에 한번 생각해 볼게요.',
  '제 슬리퍼가 반대해서요…',
  '지금 택배 기다리는 중이라서요!',
  '마음만 받을게요. 진짜 마음만요.',
  '저희 집 고양이한테 먼저 물어볼게요.',
]

const REPORT_REASONS: readonly { why: 'name' | 'spam' | 'grief' | 'etc'; label: string }[] = [
  { why: 'name', label: '🏷️ 닉네임' },
  { why: 'spam', label: '📢 도배' },
  { why: 'grief', label: '🚧 방해' },
  { why: 'etc', label: '💬 기타' },
]

function shortName(name: string, max = 5): string {
  const chars = Array.from(name)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : name
}

export function mountSocial(ctx: AppContext): void {
  const { store, bus, ui, net, actions } = ctx

  // ───────── 초대 쿨타임(서버 응답으로만 갱신, performance.now 기준) ─────────
  let globalReadyAt = 0
  /** 대상 id → 다시 초대 가능한 시각 */
  const targetReadyAt = new Map<number, number>()
  /** 대상 id → 답을 기다리는 중(만료 시각) */
  const waiting = new Map<number, number>()
  let reportReadyAt = 0
  /** 이번 접속에서 내가 차단한 사람(플레이어 id). 서버 차단은 접속 단위라 재입장 시 이름으로 다시 건다 */
  const blockedIds = new Set<number>()

  const myCult = (): CultRef | null => store.me?.prog.cult ?? null
  const nameOf = (id: number): string => store.nameOf(id) || '누군가'

  // ───────── 상황 버튼 ─────────

  ui.addContextProvider(() => {
    if (store.phase !== 'playing' || store.talk) return null
    const id = store.near.player
    if (!id) return null
    const target = store.players.get(id)
    if (!target) return null
    // 다른 기능(단상, 배틀, 말 걸기)의 버튼과 자리를 다투지 않도록 여기서는 두 개만 내놓는다:
    // 핵심 행동인 [교단 초대]와, 나머지(인사·따라 하기·차단·신고)를 담은 [상대 이름] 버튼
    const out: ContextAction[] = []
    const cult = myCult()
    if (cult && target.pub.cult?.id !== cult.id) {
      const now = performance.now()
      const ready = Math.max(globalReadyAt, targetReadyAt.get(id) ?? 0)
      const wait = waiting.get(id) ?? 0
      out.push({
        id: 'social.invite',
        label: wait > now ? '답 기다리는 중' : '교단 초대',
        icon: '📨',
        disabled: wait > now,
        readyAt: ready > now ? ready : undefined,
        onClick: () => invite(id),
      })
    }
    // 버튼에 상대 이름을 붙여 누구에게 하는 행동인지 보이게 한다
    out.push({ id: 'social.more', label: shortName(target.pub.name), icon: '👤', onClick: () => openSheet(id) })
    return out
  })

  let lastNear = 0
  bus.on('near', (n) => {
    if (n.player !== lastNear) {
      lastNear = n.player
      if (sheet.open && sheetTarget !== n.player) sheet.hide()
    }
  })

  function wave(): void {
    actions.emote('wave')
  }

  function invite(id: number): void {
    if (!store.players.has(id)) return
    if (!myCult()) {
      ui.toast('먼저 교단을 만들어야 초대할 수 있어요!', 'info')
      ui.openPanel('cult')
      return
    }
    net.send({ t: 'invite', to: id })
  }

  // ───────── 더보기 시트(차단/신고) ─────────

  const sheetEl = h('div.social-sheet.interactive', { role: 'dialog', 'aria-label': '상대에게 하기' })
  ui.root.append(sheetEl)
  let sheetTarget = 0
  let reportMode = false
  const sheet = makePopup(ctx, sheetEl, {
    onHide: () => {
      sheetTarget = 0
      reportMode = false
    },
  })

  function openSheet(id: number): void {
    sheetTarget = id
    reportMode = false
    renderSheet()
    sheet.show()
  }

  function renderSheet(): void {
    const p = store.players.get(sheetTarget)
    if (!p) {
      sheet.hide(true)
      return
    }
    const blocked = blockedIds.has(p.pub.id)
    const head = h(
      'div.social-head',
      h('div.social-who', h('span.tag.real', '접속자'), h('b.social-name', p.pub.name), h('span.small.muted', rankName(p.pub.rank))),
      p.pub.cult ? cultTagEl(p.pub.cult) : null,
    )
    const body = reportMode
      ? h(
          'div.col',
          h('p.small.muted.social-note', '무엇이 불편했나요? 신고는 익명으로 처리돼요.'),
          h(
            'div.social-reasons',
            REPORT_REASONS.map((r) => h('button.btn.social-reason', { type: 'button', onclick: () => report(p.pub.id, r.why) }, r.label)),
          ),
          h('button.btn.ghost.sm', { type: 'button', onclick: () => { reportMode = false; renderSheet() } }, '← 돌아가기'),
        )
      : h(
          'div.social-buttons',
          h('button.btn.social-wave', { type: 'button', onclick: () => { wave(); sheet.hide(true) } }, '👋 손 흔들기'),
          h('button.btn.social-bow', { type: 'button', onclick: () => { actions.emote('bow'); sheet.hide(true) } }, '🙇 인사하기'),
          mimicButton(p.pub.emote),
          h('button.btn.social-block', { type: 'button', onclick: () => setBlock(p.pub.id, !blocked) }, blocked ? '🔓 차단 해제' : '🚫 차단'),
          h('button.btn.social-report', { type: 'button', onclick: () => { reportMode = true; renderSheet() } }, '🚩 신고'),
        )
    sheetEl.replaceChildren(head, body)
    if (!reportMode)
      sheetEl.append(
        h('p.small.muted.social-note', blocked ? '차단 중: 이 사람의 교단 초대가 오지 않아요.' : '차단하면 이 사람의 초대가 더는 오지 않아요. 상대에게는 알리지 않아요.'),
      )
  }

  /** 상대가 반복 동작(춤 등)을 하고 있으면 같은 동작을 따라 하는 버튼 */
  function mimicButton(emote: string | null): HTMLElement | null {
    const loop = emote ? EMOTES.find((e) => e.id === emote && e.loop) : undefined
    if (!loop || (store.me?.prog.rank ?? 0) < loop.rank || store.me?.emote === loop.id) return null
    return h('button.btn.social-mimic', { type: 'button', onclick: () => { actions.emote(loop.id); sheet.hide(true) } }, `🪩 ${loop.name} 따라 하기`)
  }

  function setBlock(id: number, on: boolean): void {
    const p = store.players.get(id)
    if (!p) return
    net.send({ t: 'block', id, on })
    const list = store.profile.blocked.filter((n) => n !== p.pub.name)
    if (on) {
      blockedIds.add(id)
      list.push(p.pub.name)
      if (card && card.from === id) answer(false, false, true)
    } else {
      blockedIds.delete(id)
    }
    // 기기에만 남기는 안내용 목록(최근 50명)
    store.profile.blocked = list.slice(-50)
    saveProfile(store.profile)
    playSfx(ctx, 'click')
    ui.toast(on ? `${p.pub.name}님을 차단했어요.` : `${p.pub.name}님 차단을 풀었어요.`, 'info')
    renderSheet()
  }

  function report(id: number, why: 'name' | 'spam' | 'grief' | 'etc'): void {
    const p = store.players.get(id)
    if (!p) return
    const now = performance.now()
    if (reportReadyAt > now) {
      ui.toast(`신고는 ${Math.ceil((reportReadyAt - now) / 1000)}초 뒤에 다시 할 수 있어요.`, 'info')
      return
    }
    reportReadyAt = now + REPORT_COOLDOWN_MS
    net.send({ t: 'report', id, why })
    playSfx(ctx, 'click')
    ui.toast('신고가 접수됐어요. 알려 줘서 고마워요!', 'good')
    sheet.hide(true)
  }

  // 재입장(새 접속) 때 서버는 차단 목록을 잊는다 → 같은 이름의 사람에게 다시 건다
  function reapplyBlocks(id: number): void {
    const p = store.players.get(id)
    if (!p || blockedIds.has(id)) return
    if (store.profile.blocked.includes(p.pub.name)) {
      blockedIds.add(id)
      net.send({ t: 'block', id, on: true })
    }
  }

  // ───────── 초대 카드 ─────────

  interface Card {
    from: number
    el: HTMLElement
    timer: number
  }
  let card: Card | null = null

  function showCard(m: SInvited): void {
    hideCard()
    const cult = m.cult
    const color = CULT_COLORS[cult.color] ?? 0x7b5cff
    const ms = Math.max(1000, Math.min(INVITE_TTL_MS, m.until - store.serverNow()))
    const fill = h('i')
    fill.style.animationDuration = `${ms}ms`
    const inviter = nameOf(m.from)
    const el = h(
      'div.invite-card.interactive',
      { role: 'alertdialog', 'aria-label': '교단 초대' },
      h('div.invite-ttl', fill),
      h(
        'div.invite-head',
        { style: { background: hex(color), color: inkOn(color) } },
        emblemBadge(cult, 'invite-emblem'),
        h('div.grow', h('div.invite-cult', cult.name), h('div.invite-leader', `교주 ${cult.leaderName}`)),
      ),
      h('p.invite-text', h('b', inviter), '님이 당신을 포교 중입니다'),
      h('p.invite-fine', '전부 게임 속 허구의 교단이에요. 거절해도 아무 일 없어요.'),
      h(
        'div.invite-btns',
        h('button.btn.primary.invite-yes', { type: 'button', onclick: () => answer(true) }, '🙌 따라간다'),
        h('button.btn.invite-no', { type: 'button', onclick: () => answer(false) }, '🙇 정중히 거절'),
      ),
      h('button.btn.ghost.sm.invite-block', { type: 'button', onclick: () => answer(false, true) }, '🚫 이 사람 차단'),
    )
    ui.root.append(el)
    const timer = window.setTimeout(() => {
      if (card && card.el === el) hideCard()
    }, ms)
    card = { from: m.from, el, timer }
    playSfx(ctx, 'invite')
  }

  function hideCard(): void {
    if (!card) return
    window.clearTimeout(card.timer)
    const el = card.el
    el.classList.add('out')
    window.setTimeout(() => el.remove(), 220)
    card = null
  }

  /** silent: 이미 서버에 차단을 보냈을 때(시트의 차단 버튼) — 답만 정리 */
  function answer(ok: boolean, block = false, silent = false): void {
    if (!card) return
    const from = card.from
    hideCard()
    if (!silent) net.send(block ? { t: 'inviteAns', from, ok, block: true } : { t: 'inviteAns', from, ok })
    if (ok) {
      playSfx(ctx, 'accept')
    } else {
      playSfx(ctx, 'decline')
      if (block) {
        const p = store.players.get(from)
        blockedIds.add(from)
        if (p) {
          store.profile.blocked = [...store.profile.blocked.filter((n) => n !== p.pub.name), p.pub.name].slice(-50)
          saveProfile(store.profile)
        }
        ui.toast(`${nameOf(from)}님을 차단했어요. 상대에게는 거절로만 보여요.`, 'info')
      } else if (!silent) {
        ui.toast('정중히 거절했어요. 🙇', 'info')
      }
    }
  }

  bus.onMsg('invited', (m) => {
    if (!m || !m.cult) return
    // '초대 받지 않기' 또는 내가 차단한 사람 → 카드 없이 조용히 거절
    if (store.profile.settings.noInvites || blockedIds.has(m.from)) {
      net.send({ t: 'inviteAns', from: m.from, ok: false })
      return
    }
    showCard(m)
  })

  // ───────── 초대 결과(초대한 사람) ─────────

  bus.onMsg('inviteRes', (m) => {
    const now = performance.now()
    const who = nameOf(m.to)
    if (m.r !== 'sent') waiting.delete(m.to)
    switch (m.r) {
      case 'sent':
        globalReadyAt = now + INVITE_GLOBAL_COOLDOWN_MS
        waiting.set(m.to, now + INVITE_TTL_MS + 5000)
        playSfx(ctx, 'invite')
        ui.toast(`📨 ${who}님에게 교단을 권했어요…`, 'info')
        break
      case 'ok':
        playSfx(ctx, 'accept')
        ui.toast(`🎉 ${who}님이 교단에 들어왔어요! 영향력 +15`, 'gold', 3200)
        break
      case 'no': {
        targetReadyAt.set(m.to, now + INVITE_COOLDOWN_MS)
        playSfx(ctx, 'decline')
        const line = DECLINE_LINES[Math.floor(Math.random() * DECLINE_LINES.length)] ?? DECLINE_LINES[0]!
        ui.toast(`${who}: "${line}"`, 'info', 3400)
        break
      }
      case 'cool': {
        const ms = typeof m.ms === 'number' && m.ms > 0 ? m.ms : INVITE_GLOBAL_COOLDOWN_MS
        if (ms > INVITE_GLOBAL_COOLDOWN_MS) targetReadyAt.set(m.to, now + ms)
        else globalReadyAt = Math.max(globalReadyAt, now + ms)
        ui.toast(`⏳ ${Math.ceil(ms / 1000)}초 뒤에 다시 권할 수 있어요.`, 'info')
        break
      }
      case 'far':
        ui.toast('조금 더 가까이 가서 권해 보세요.', 'info')
        break
      case 'nocult':
        ui.toast('먼저 교단을 만들어야 초대할 수 있어요!', 'info')
        ui.openPanel('cult')
        break
      case 'same':
        ui.toast(`${who}님은 이미 같은 교단이에요.`, 'info')
        break
      case 'busy':
        ui.toast(`${who}님은 다른 초대를 보는 중이에요. 잠시 뒤에 다시!`, 'info')
        break
      case 'expired':
        ui.toast(`${who}님이 대답 없이 지나갔어요…`, 'info')
        break
    }
    ui.refreshContext()
  })

  // ───────── 신고 결과(당사자) ─────────

  bus.onMsg('err', (m) => {
    if (m.code === 'renamed') {
      ui.toast(`닉네임 신고가 여러 번 들어와 이름이 「${m.msg ?? store.profile.name}」(으)로 바뀌었어요. 프로필에서 다른 이름으로 바꿀 수 있어요.`, 'bad', 6000)
    } else if (m.code === 'muted') {
      ui.toast('신고가 여러 번 들어와 5분 동안 말풍선과 초대를 쉬어 갑니다. 잠시 산책하고 와요!', 'bad', 6000)
    }
  })

  // ───────── 내 교단 변화 알림 ─────────

  let lastCult: CultRef | null = null
  let ready = false
  const sameCult = (a: CultRef | null, b: CultRef | null): boolean =>
    a === b || (!!a && !!b && a.id === b.id && a.name === b.name && a.color === b.color && a.emblem === b.emblem && a.title === b.title && a.role === b.role)

  function checkMyCult(): void {
    const cur = myCult()
    if (!ready) return
    if (sameCult(cur, lastCult)) return
    const prev = lastCult
    lastCult = cur ? { ...cur } : null
    if (!cur) {
      if (prev) ui.toast(`「${prev.name}」에서 탈퇴했어요.`, 'info')
      return
    }
    if (prev && prev.id === cur.id) {
      ui.toast(`🏛️ 교단 정보가 바뀌었어요: 「${cur.name}」`, 'info')
    } else if (cur.role === 'leader') {
      playSfx(ctx, 'ach')
      ui.toast(`🏛️ 「${cur.name}」 창설! 가까운 사람에게 📨 교단 초대를 권해 보세요.`, 'gold', 3600)
    } else {
      ui.toast(`🏛️ 「${cur.name}」의 교단원이 되었어요!`, 'gold', 3200)
    }
  }

  bus.on('profile', checkMyCult)
  bus.on('progress', checkMyCult)
  bus.on('playerUpdate', (id) => {
    if (store.me && id === store.me.id) checkMyCult()
    else if (sheet.open && id === sheetTarget) renderSheet()
    ui.refreshContext()
  })
  bus.on('playerJoin', reapplyBlocks)
  bus.on('playerLeave', (id) => {
    if (card && card.from === id) hideCard()
    if (sheet.open && sheetTarget === id) sheet.hide(true)
    waiting.delete(id)
    targetReadyAt.delete(id)
    blockedIds.delete(id)
  })
  bus.on('entered', () => {
    lastCult = myCult() ? { ...myCult()! } : null
    ready = true
    blockedIds.clear()
    waiting.clear()
    targetReadyAt.clear()
    hideCard()
    for (const id of store.players.keys()) reapplyBlocks(id)
    // 포교 링크(?by=)는 첫 입장에만 쓴다: 재접속할 때마다 초대 카드가 다시 뜨지 않게 주소에서 지운다
    try {
      const url = new URL(location.href)
      if (url.searchParams.has('by')) {
        url.searchParams.delete('by')
        history.replaceState(history.state, '', url.pathname + url.search + url.hash)
      }
    } catch {
      /* 주소 정리는 실패해도 무방 */
    }
  })
  bus.on('phase', (p) => {
    if (p !== 'playing') {
      hideCard()
      if (sheet.open) sheet.hide(true)
    }
  })
}
