/** [클라이언트 코어 담당이 구현할 파일] WebSocket 접속/재접속, 프로토콜 처리, 보간 */
import type { Bus } from '../core/bus'
import type { NetApi } from '../core/contracts'
import type { Store } from '../core/store'

export function createNet(_store: Store, _bus: Bus): NetApi {
  return {
    connect() {},
    disconnect() {},
    send: () => false,
    sendMove() {},
    update() {},
    refreshRooms: async () => {},
  }
}
