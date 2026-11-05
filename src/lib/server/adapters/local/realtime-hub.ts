import type { RealtimeHub } from '../../ports/realtime';

/** The in-process hub (§2 adapters); slice 4a adds the `ws` sockets it closes. */
export function createLocalHub(): RealtimeHub {
  return {
    async connect() {
      return new Response(null, { status: 501 });
    },
    async disconnectMember() {},
    async notify() {},
  };
}
