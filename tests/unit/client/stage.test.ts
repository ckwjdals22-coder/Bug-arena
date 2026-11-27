import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { holdStage, resetStage, stageBusy, stagePlay } from '../../../client/src/ui/stage'

describe('무대 감독(큰 알림 차례)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    resetStage()
  })
  afterEach(() => {
    resetStage()
    vi.useRealTimers()
  })

  it('결과 배너가 무대를 잡고 있으면 그 뒤에, 순서(pri)대로 하나씩, 각자 시간만큼 띄운다', () => {
    const log: string[] = []
    const at = (name: string) => (): void => {
      log.push(`${name}@${Math.round(performance.now())}`)
    }
    holdStage(2600) // 결과 배너
    // 메시지 처리기가 불리는 순서와 무관하게 pri 로 정렬된다
    stagePlay(3, 4800, at('rank'))
    stagePlay(2, 3000, at('ach'))
    stagePlay(1.5, 3900, at('offer'))
    expect(stageBusy()).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(log).toEqual(['offer@2600', 'ach@6500', 'rank@9500'])
  })

  it('done() 을 부르면 남은 시간을 돌려주고 다음 차례가 바로 이어진다', () => {
    const log: string[] = []
    let release: (() => void) | undefined
    stagePlay(1.5, 3900, (done) => {
      log.push(`offer@${Math.round(performance.now())}`)
      release = done
    })
    stagePlay(2, 3000, () => {
      log.push(`ach@${Math.round(performance.now())}`)
    })
    vi.advanceTimersByTime(1000)
    expect(log).toEqual(['offer@40'])
    release!() // 1초 만에 눌러서 닫음
    vi.advanceTimersByTime(100)
    expect(log).toEqual(['offer@40', 'ach@1040'])
  })

  it('늦게 불린 done() 은 이미 무대에 오른 다음 알림의 시간을 지우지 않는다', () => {
    const log: string[] = []
    let release: (() => void) | undefined
    stagePlay(1, 1000, (done) => {
      release = done
      log.push('a')
    })
    stagePlay(2, 3000, () => {
      log.push(`b@${Math.round(performance.now())}`)
    })
    stagePlay(3, 1000, () => {
      log.push(`c@${Math.round(performance.now())}`)
    })
    vi.advanceTimersByTime(1100) // a 는 제 시간을 다 쓰고 b 가 올라왔다
    expect(log).toEqual(['a', 'b@1040'])
    release!() // 시간이 다 된 뒤에 a 가 닫힘 → b 의 3초는 그대로여야 한다
    vi.advanceTimersByTime(1500)
    expect(log).toEqual(['a', 'b@1040'])
    vi.advanceTimersByTime(2000)
    expect(log).toEqual(['a', 'b@1040', 'c@4040'])
  })

  it('카드가 떠 있는 동안 결과 배너가 무대를 잡으면 카드가 비켜 주고, 덜 보였으면 배너 뒤에 처음부터 다시 나온다', () => {
    const log: string[] = []
    const now = (): number => Math.round(performance.now())
    stagePlay(1.5, 4000, () => {
      log.push(`offer@${now()}`)
      return () => log.push(`offer-hide@${now()}`)
    })
    stagePlay(2, 2000, () => {
      log.push(`ach@${now()}`)
    })
    vi.advanceTimersByTime(1040) // 카드가 1초 보였다(4초의 60% 미만)
    holdStage(1600) // 다음 멘트의 결과 배너
    expect(log).toEqual(['offer@40', 'offer-hide@1040'])
    vi.advanceTimersByTime(1600)
    expect(log).toEqual(['offer@40', 'offer-hide@1040', 'offer@2640'])
    vi.advanceTimersByTime(3000) // 충분히(60% 이상) 보인 뒤에 결과 배너가 오면 다시 나오지 않는다
    holdStage(1600)
    expect(log.slice(-1)).toEqual(['offer-hide@5640'])
    vi.advanceTimersByTime(1600)
    expect(log.slice(-1)).toEqual(['ach@7240'])
  })
})
