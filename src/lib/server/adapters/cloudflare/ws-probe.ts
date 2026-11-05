import type { DurableObjectNamespace } from '@cloudflare/workers-types';

/** The room path only the 1d probe uses (R-OPS-16); removed in slice 4a. */
export const PROBE_PATH = '/__probe';

/**
 * TEMPORARY (R-OPS-16, remove in slice 4a): forwards an upgrade to one `ChatRoom`
 * acting as an echo. Exists only while the Worker var `WS_PROBE` is `"1"`, so a
 * normal deploy has no probe at all.
 */
export function createWsProbe(
  env: Record<string, unknown>,
): ((request: Request) => Promise<Response>) | undefined {
  const rooms = env.CHAT_ROOM as DurableObjectNamespace | undefined;
  if (env.WS_PROBE !== '1' || !rooms) return undefined;
  return async (request) => {
    const room = rooms.get(rooms.idFromName('ws-probe'));
    const url = new URL(request.url);
    url.pathname = PROBE_PATH;
    url.search = '';
    // Only the upgrade header travels; the Access assertion and cookies stay in the Worker.
    return (await room.fetch(url.toString(), {
      headers: { upgrade: 'websocket' },
    })) as unknown as Response;
  };
}
