import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStageLater, holdStage, pauseStage, resetStage, stageBusy, stagePlay } from '../../../client/src/ui/stage'

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

  it('soft 알림(승급 토스트)은 뒤에 다른 카드가 줄을 서면 곧바로 비켜 주고, 그 카드가 지나간 뒤 다시 나온다', () => {
    const log: string[] = []
    const now = (): number => Math.round(performance.now())
    stagePlay(
      3.5,
      7400,
      () => {
        log.push(`toast@${now()}`)
        return () => log.push(`toast-hide@${now()}`)
      },
      { soft: true },
    )
    vi.advanceTimersByTime(700) // 토스트가 0.66초 보였을 때 업적이 온다
    stagePlay(2, 2200, () => {
      log.push(`ach@${now()}`)
    })
    vi.advanceTimersByTime(100)
    // 예전에는 업적이 7.4초 뒤에야 나왔다
    expect(log).toEqual(['toast@40', 'toast-hide@700', 'ach@740'])
    vi.advanceTimersByTime(2300)
    expect(log).toEqual(['toast@40', 'toast-hide@700', 'ach@740', 'toast@2940'])
  })

  it('urgent 알림(직접 누른 [헌납 타임]의 응답)은 줄 맨 앞에 서고 떠 있는 카드를 비키게 한다', () => {
    const log: string[] = []
    const now = (): number => Math.round(performance.now())
    stagePlay(3, 4800, () => {
      log.push(`rank@${now()}`)
      return () => log.push(`rank-hide@${now()}`)
    })
    stagePlay(3.5, 7400, () => {
      log.push(`toast@${now()}`)
    })
    vi.advanceTimersByTime(500)
    stagePlay(
      1.5,
      3900,
      () => {
        log.push(`offer@${now()}`)
      },
      { urgent: true },
    )
    vi.advanceTimersByTime(100)
    // 예전에는 승급 카드(4.8초)와 토스트(7.4초)가 다 지나간 뒤에야 나왔다
    expect(log).toEqual(['rank@40', 'rank-hide@500', 'offer@540'])
    vi.advanceTimersByTime(20_000)
    // 덜 보인 승급 카드는 다시 나오고, 토스트는 그 뒤
    expect(log).toEqual(['rank@40', 'rank-hide@500', 'offer@540', 'rank@4440', 'toast@9240'])
  })

  it('urgent 라도 결과 배너(holdStage)는 기다린다', () => {
    const log: string[] = []
    holdStage(1000)
    stagePlay(1.5, 3900, () => {
      log.push(`offer@${Math.round(performance.now())}`)
    }, { urgent: true })
    vi.advanceTimersByTime(2000)
    expect(log).toEqual(['offer@1000'])
  })

  it('패널이 열려 있으면(pauseStage) 줄을 세워 두기만 하고, 떠 있던 카드는 비켜 준 뒤 패널이 닫히면 이어서 나온다', () => {
    const log: string[] = []
    const now = (): number => Math.round(performance.now())
    stagePlay(3, 4800, () => {
      log.push(`rank@${now()}`)
      return () => log.push(`rank-hide@${now()}`)
    })
    vi.advanceTimersByTime(1000)
    pauseStage(true)
    stagePlay(2, 2200, () => {
      log.push(`ach@${now()}`)
    })
    vi.advanceTimersByTime(10_000)
    expect(log).toEqual(['rank@40', 'rank-hide@1000'])
    pauseStage(false)
    vi.advanceTimersByTime(100)
    // 업적(순서 2)이 먼저, 덜 보인 승급 카드는 그 뒤에 처음부터
    expect(log).toEqual(['rank@40', 'rank-hide@1000', 'ach@11040'])
    vi.advanceTimersByTime(3000)
    expect(log).toEqual(['rank@40', 'rank-hide@1000', 'ach@11040', 'rank@13240'])
  })

  it('createStageLater: 맡긴 것은 flush 에 한 번만 돌고, drop 하면 버린다', () => {
    const later = createStageLater()
    const log: number[] = []
    later.keep(() => log.push(1))
    later.keep(() => log.push(2))
    later.flush()
    later.flush()
    expect(log).toEqual([1, 2])
    later.keep(() => log.push(3))
    later.drop()
    later.flush()
    expect(log).toEqual([1, 2])
  })

  it('재접속 중이라 done() 만 부르고 맡겨 둔 업적은 무대를 비워 두지 않고, 돌아오면 다시 나온다', () => {
    const log: string[] = []
    const now = (): number => Math.round(performance.now())
    let phase = 'reconnecting'
    const later = createStageLater()
    const play = (name: string): void => {
      stagePlay(2, 2200, (done) => {
        if (phase !== 'playing') {
          later.keep(() => play(name))
          done()
          return
        }
        log.push(`${name}@${now()}`)
      })
    }
    play('ach')
    stagePlay(3, 4800, () => {
      log.push(`rank@${now()}`)
    })
    vi.advanceTimersByTime(200)
    // 업적이 무대를 2.2초 비워 두지 않고 승급 카드가 바로 이어진다(재접속 중에는 승급 카드도 같은 방식으로 맡겨지지만 여기서는 그대로 둔다)
    expect(log).toEqual(['rank@80'])
    phase = 'playing'
    later.flush()
    vi.advanceTimersByTime(5000)
    expect(log).toEqual(['rank@80', 'ach@4880'])
  })
})
