/**
 * 화면 가운데의 '큰 알림'들이 한꺼번에 겹치지 않게 차례를 정해 주는 작은 무대 감독.
 *
 * 포교에 성공하는 순간에는 결과 배너("신도 +1!"), 예능 자막, 업적 배너가 같은 0.1초 안에 몰려온다.
 * 전부 한꺼번에 띄우면 게임에서 가장 기쁜 순간이 가장 읽기 어려운 순간이 된다.
 *  - 결과 배너처럼 바로 떠야 하는 것은 holdStage(ms) 로 "이만큼은 내가 쓴다"고만 알린다.
 *  - 자막·업적 배너는 stagePlay(순서, 시간, 띄우는 함수) 로 줄을 선다. 무대가 비면 순서(pri)가 낮은 것부터 하나씩 나간다.
 * → 결과 배너 → 자막 → 업적 배너 순서로 이어서 보인다. 어느 모듈의 메시지 처리기가 먼저 불렸는지와 무관하다.
 */
interface StageItem {
  pri: number
  ms: number
  run: () => void
}

const queue: StageItem[] = []
let busyUntil = 0
let timer: number | undefined
/** 같은 순간에 몰려온 알림을 모아 순서를 정하기 위한 짧은 틈 */
const GATHER_MS = 40

/** 지금부터 ms 동안 화면 가운데를 쓴다고 알린다(이미 잡혀 있으면 더 늦은 쪽이 남는다) */
export function holdStage(ms: number): void {
  busyUntil = Math.max(busyUntil, performance.now() + ms)
}

/** 지금 화면 가운데를 누가 쓰고 있거나 차례를 기다리는 알림이 있는가 */
export function stageBusy(): boolean {
  return queue.length > 0 || performance.now() < busyUntil
}

/** 무대가 비면 run 을 부른다. pri 가 낮을수록 먼저, 같으면 먼저 온 것이 먼저. ms = 그 알림이 화면을 쓰는 시간 */
export function stagePlay(pri: number, ms: number, run: () => void): void {
  let i = queue.length
  while (i > 0 && queue[i - 1]!.pri > pri) i--
  queue.splice(i, 0, { pri, ms, run })
  pump()
}

function pump(): void {
  if (timer !== undefined || queue.length === 0) return
  timer = window.setTimeout(
    () => {
      timer = undefined
      // 기다리는 사이에 누가 무대를 더 잡았으면(결과 배너가 뒤늦게 뜬 경우 등) 다시 기다린다
      if (performance.now() < busyUntil) {
        pump()
        return
      }
      const item = queue.shift()
      if (!item) return
      busyUntil = performance.now() + item.ms
      try {
        item.run()
      } catch (err) {
        console.error('[stage] 알림 표시 오류', err)
      }
      pump()
    },
    Math.max(GATHER_MS, busyUntil - performance.now()),
  )
}
