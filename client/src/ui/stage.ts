/**
 * 화면 가운데의 '큰 알림'들이 한꺼번에 겹치지 않게 차례를 정해 주는 작은 무대 감독.
 *
 * 포교에 성공하는 순간에는 결과 배너("신도 +1!"), 예능 자막, 헌납 카드, 업적 배너, 승급 카드가 같은 0.1초 안에 몰려온다.
 * 전부 한꺼번에 띄우면 게임에서 가장 기쁜 순간이 가장 읽기 어려운 순간이 된다.
 *  - 결과 배너처럼 바로 떠야 하는 것은 holdStage(ms) 로 "이만큼은 내가 쓴다"고만 알린다.
 *  - 나머지는 stagePlay(순서, 시간, 띄우는 함수) 로 줄을 선다. 무대가 비면 순서(pri)가 낮은 것부터 하나씩 나간다.
 * → 결과 배너 → 자막 → 헌납 카드 → 업적 배너 → 승급 카드 순서로 이어서 보인다. 어느 모듈의 메시지 처리기가 먼저 불렸는지와 무관하다.
 *
 * ms 는 반드시 그 알림이 "실제로 화면에 떠 있는 시간"이어야 한다. 짧게 적으면 다음 알림이 아직 떠 있는 카드 위에 겹친다.
 * 대신 눌러서 일찍 닫을 수 있는 카드는 run 이 받는 done() 을 불러 남은 시간을 돌려준다(빈 무대를 멍하니 기다리지 않게).
 *
 * 카드가 떠 있는 동안 플레이어가 다음 멘트를 던지면 결과 배너가 곧바로 떠야 한다(holdStage). 이때 run 이 숨기는 함수를
 * 돌려준 카드는 비켜 준다: 숨기고, 아직 충분히 보여 주지 못했으면(시간의 60% 미만) 같은 순서 맨 앞에 다시 서서
 * 결과 배너가 지나간 뒤 처음부터 다시 보인다. 결과 배너와 카드가 같은 자리에 포개지지 않게 하려는 것이다.
 *
 * 무대를 오래 쥐는 알림이 뒤에 오는 카드를 굶기지 않게 하는 두 가지 선택지(StageOpts):
 *  - soft: 뒤에 다른 알림이 줄을 서면 곧바로 비켜 준다(승급 토스트처럼 7초 동안 떠 있지만, 그 7초 내내 헌납 카드·업적 배너를
 *    기다리게 할 만큼 급하지는 않은 것). 비켜 준 뒤에는 위와 같은 규칙으로 다시 줄을 선다.
 *  - urgent: 플레이어가 방금 직접 누른 버튼의 응답(헌금함 [헌납 타임])처럼 기다리게 하면 "눌렀는데 아무 일도 없다"가 되는 것.
 *    줄 맨 앞에 서고, 지금 떠 있는 카드가 비켜 줄 수 있으면(숨기는 함수를 돌려줬으면) 비키게 한다.
 *    결과 배너(holdStage)는 기다린다: 결과 배너는 길어야 2.6초이고, 막 끝난 대화의 결과다.
 *
 * 패널(교단·설정·업적·매점 …)이 열려 있는 동안에는 무대를 멈춘다(pauseStage). 업적 배너·승급 카드·헌납 카드는 화면 위쪽 가운데에
 * 뜨는데, 그 자리가 바로 패널의 제목·닫기 버튼·탭 줄이다. 떠 있던 카드는 비켜 주고(덜 보였으면 다시 줄을 선다) 패널이 닫히면 이어서 나온다.
 */
type StageRun = (done: () => void) => (() => void) | void

export interface StageOpts {
  soft?: boolean
  urgent?: boolean
}

interface StageItem {
  pri: number
  ms: number
  run: StageRun
  soft: boolean
}

const queue: StageItem[] = []
/** holdStage 로 잡힌 시간(결과 배너 등) */
let holdUntil = 0
/** 지금 무대에 올라 있는 알림이 끝나는 시각 */
let itemUntil = 0
/** 지금 무대에 올라 있는 알림의 번호(done() 이 늦게 불려도 다음 알림의 시간을 지우지 않게) */
let currentSeq = 0
/** 지금 무대에 올라 있는 알림(비켜 줄 수 있는 것만) */
let current: { item: StageItem; seq: number; at: number; hide: () => void } | null = null
/** 이만큼 보여 주지 못한 채 비켜 준 카드는 다시 줄을 선다 */
const REPLAY_BELOW = 0.6
let timer: ReturnType<typeof setTimeout> | undefined
/** 패널이 열려 있어 무대를 멈췄는가 */
let paused = false
/** 같은 순간에 몰려온 알림을 모아 순서를 정하기 위한 짧은 틈 */
const GATHER_MS = 40

const busyUntil = (): number => Math.max(holdUntil, itemUntil)

/**
 * 지금 떠 있는 카드를 비키게 한다(숨기는 함수를 돌려준 카드만). 덜 보였으면 같은 순서 맨 앞에 다시 줄을 세운다.
 * 비킨 카드가 있었으면 true
 */
function yieldCurrent(now: number): boolean {
  const cur = current
  if (!cur || cur.seq !== currentSeq || now >= itemUntil) return false
  current = null
  currentSeq++
  itemUntil = now
  if (now - cur.at < cur.item.ms * REPLAY_BELOW) {
    let i = 0
    while (i < queue.length && queue[i]!.pri < cur.item.pri) i++
    queue.splice(i, 0, cur.item)
  }
  try {
    cur.hide()
  } catch (err) {
    console.error('[stage] 알림 숨기기 오류', err)
  }
  // 기다리던 타이머는 새 시간에 맞춰 다시 잰다
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  return true
}

/** 지금부터 ms 동안 화면 가운데를 쓴다고 알린다(이미 잡혀 있으면 더 늦은 쪽이 남는다) */
export function holdStage(ms: number): void {
  const now = performance.now()
  holdUntil = Math.max(holdUntil, now + ms)
  if (yieldCurrent(now)) pump()
}

/** 지금 화면 가운데를 누가 쓰고 있거나 차례를 기다리는 알림이 있는가 */
export function stageBusy(): boolean {
  return queue.length > 0 || performance.now() < busyUntil()
}

/**
 * 무대가 비면 run 을 부른다. pri 가 낮을수록 먼저, 같으면 먼저 온 것이 먼저. ms = 그 알림이 화면을 쓰는 시간.
 * run 에 넘어오는 done() 을 부르면 그 알림이 일찍 내려간 것으로 보고 다음 차례를 바로 부른다.
 */
export function stagePlay(pri: number, ms: number, run: StageRun, opts: StageOpts = {}): void {
  const item: StageItem = { pri, ms, run, soft: !!opts.soft }
  if (opts.urgent) {
    queue.unshift(item)
    yieldCurrent(performance.now())
  } else {
    let i = queue.length
    while (i > 0 && queue[i - 1]!.pri > pri) i--
    queue.splice(i, 0, item)
    // 비켜 주기로 한 알림(soft)이 무대에 있으면 새로 온 것에 자리를 내준다
    if (current?.item.soft) yieldCurrent(performance.now())
  }
  pump()
}

/**
 * 재접속 중처럼 지금은 띄울 수 없는 알림을 맡아 두는 곳. 조용히 버리면 업적 배너 같은 것이 영영 안 보인다.
 * 모듈이 'phase' 를 보고 다시 게임 중이 되면 flush(), 게임을 아예 떠나면(첫 화면·추방 등) drop() 한다.
 */
export function createStageLater(): { keep: (fn: () => void) => void; flush: () => void; drop: () => void } {
  let list: (() => void)[] = []
  return {
    keep(fn) {
      list.push(fn)
    },
    flush() {
      const l = list
      list = []
      for (const fn of l) fn()
    },
    drop() {
      list = []
    },
  }
}

/** 무대를 멈추거나(패널이 열림) 다시 돌린다(패널이 닫힘). 멈출 때 떠 있던 카드는 비켜 준다 */
export function pauseStage(on: boolean): void {
  if (paused === on) return
  paused = on
  if (on) {
    yieldCurrent(performance.now())
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  } else pump()
}

/** 줄과 시간을 처음 상태로(테스트용) */
export function resetStage(): void {
  queue.length = 0
  holdUntil = 0
  itemUntil = 0
  paused = false
  current = null
  currentSeq++
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

function pump(): void {
  if (paused || timer !== undefined || queue.length === 0) return
  timer = setTimeout(
    () => {
      timer = undefined
      if (paused) return
      // 기다리는 사이에 누가 무대를 더 잡았으면(결과 배너가 뒤늦게 뜬 경우 등) 다시 기다린다
      if (performance.now() < busyUntil()) {
        pump()
        return
      }
      const item = queue.shift()
      if (!item) return
      const seq = ++currentSeq
      itemUntil = performance.now() + item.ms
      const done = (): void => {
        if (seq !== currentSeq) return
        currentSeq++
        itemUntil = Math.min(itemUntil, performance.now())
        // 남은 시간을 기다리던 타이머를 지우고 다시 잰다(GATHER_MS 뒤에 다음 차례)
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        pump()
      }
      current = null
      try {
        const hide = item.run(done)
        if (typeof hide === 'function' && seq === currentSeq) current = { item, seq, at: performance.now(), hide }
      } catch (err) {
        console.error('[stage] 알림 표시 오류', err)
      }
      pump()
    },
    Math.max(GATHER_MS, busyUntil() - performance.now()),
  )
}
