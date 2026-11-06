// The local hub's half of a dev-server upgrade (R-PLAT-10). Vite's upgrade listener
// (chat-upgrade.ts) and the SSR module graph load separate copies of the app's modules
// in one Node process, so the upgrades waiting for the route's answer live on
// `globalThis`. A ticket is random, single-use and set by the listener itself, so a
// browser cannot name one.

export const TICKET_HEADER = 'x-classhub-upgrade-ticket';

/** A socket as the dev server's `ws` upgrade hands it to the hub. */
export interface LocalSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  onMessage(listener: (data: string | ArrayBuffer) => void): void;
  onClose(listener: () => void): void;
}

/** Filled by the hub's `connect` once the route, behind the whole pipeline, accepted. */
export interface PendingUpgrade {
  accept?: (socket: LocalSocket) => void;
}

const REGISTRY = Symbol.for('classhub.chat.pendingUpgrades');

export function pendingUpgrades(): Map<string, PendingUpgrade> {
  const scope = globalThis as { [REGISTRY]?: Map<string, PendingUpgrade> };
  scope[REGISTRY] ??= new Map();
  return scope[REGISTRY];
}
