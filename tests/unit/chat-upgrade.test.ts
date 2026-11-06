import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createChatUpgrade, type Respond } from '../../src/lib/server/adapters/local/chat-upgrade';
import { createLocalHub } from '../../src/lib/server/adapters/local/realtime-hub';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import {
  pendingUpgrades,
  TICKET_HEADER,
} from '../../src/lib/server/adapters/local/upgrade-registry';
import { PEOPLE, seedMembership } from '../fixtures/membership';

// R-PLAT-10: the dev server's upgrade listener. Only an upgrade the app (pipeline and
// route) accepted becomes a socket; any other answer is written back as it is.

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function listen(respond: Respond): Promise<number> {
  server = createServer();
  server.on('upgrade', createChatUpgrade(respond));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function upgrade(port: number, path = '/api/v1/chat/ws', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string } | 'open' | 'no answer'>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    socket.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    socket.on('open', () => {
      socket.close();
      resolve('open');
    });
    socket.on('error', () => resolve('no answer'));
    setTimeout(() => resolve('no answer'), 1_500);
  });
}

describe('dev chat upgrade (R-PLAT-10)', () => {
  it('R-PLAT-10 writes the pipeline’s refusal back and opens no socket', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"forbidden"}}');
    });
    expect(await upgrade(port)).toEqual({ status: 403, body: '{"error":{"code":"forbidden"}}' });
    expect(pendingUpgrades().size).toBe(0);
  });

  it('R-PLAT-10 a 2xx without the hub accepting is still refused', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    expect(await upgrade(port)).toEqual({ status: 204, body: '' });
  });

  it('R-PLAT-10 replaces a ticket the client sent with its own', async () => {
    const seen: (string | undefined)[] = [];
    const port = await listen((request, response) => {
      const ticket = request.headers[TICKET_HEADER] as string | undefined;
      seen.push(ticket, String(pendingUpgrades().has(ticket ?? '')));
      response.writeHead(403);
      response.end();
    });
    await upgrade(port, '/api/v1/chat/ws', { [TICKET_HEADER]: 'guessed-ticket' });
    expect(seen[0]).not.toBe('guessed-ticket');
    expect(seen[1]).toBe('true');
  });

  it('R-PLAT-10 leaves other upgrade paths (Vite’s HMR) alone', async () => {
    let called = false;
    const port = await listen(() => {
      called = true;
    });
    // Stands in for Vite's own listener, which would answer this one.
    server!.on('upgrade', (_request, socket) => setTimeout(() => socket.destroy(), 100));
    expect(await upgrade(port, '/@vite/client')).toBe('no answer');
    expect(called).toBe(false);
  });

  it('R-PLAT-10 the local hub refuses a request that carries no live ticket', async () => {
    const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
    const hub = createLocalHub({ database });
    const member = { id: 'm', role: 'member' as const, displayName: 'M', authUntil: 9e12 };
    for (const headers of [{}, { [TICKET_HEADER]: crypto.randomUUID() }] as Record<
      string,
      string
    >[]) {
      const response = await hub.connect(new Request('http://localhost/', { headers }), member);
      expect(response.status).toBe(426);
    }
    database.close();
  });

  it('R-PLAT-10 the local hub hears a frame or a close that comes before the context is verified', async () => {
    const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
    await seedMembership(database);
    const hub = createLocalHub({ database });
    const member = {
      id: PEOPLE.active.id,
      role: 'member' as const,
      displayName: 'Active Member',
      authUntil: Date.now() + 3_600_000,
    };
    const accepted = async () => {
      const ticket = crypto.randomUUID();
      pendingUpgrades().set(ticket, {});
      const request = new Request('http://localhost/', { headers: { [TICKET_HEADER]: ticket } });
      expect((await hub.connect(request, member)).status).toBe(204);
      const accept = pendingUpgrades().get(ticket)!.accept!;
      pendingUpgrades().delete(ticket);
      return accept;
    };
    const fake = () => {
      const sent: string[] = [];
      const listeners: { message?: (data: string) => void; close?: () => void } = {};
      const socket = {
        send: (text: string) => {
          const frame = JSON.parse(text) as { type: string; online?: number };
          sent.push(`${frame.type}${frame.online ?? ''}`);
        },
        close: () => {},
        onMessage: (listener: (data: string | ArrayBuffer) => void) => {
          listeners.message = listener;
        },
        onClose: (listener: () => void) => {
          listeners.close = listener;
        },
      };
      return { sent, listeners, socket };
    };

    // A frame in the same tick as the accept is answered, after the hello.
    const early = fake();
    (await accepted())(early.socket);
    early.listeners.message!(
      JSON.stringify({ type: 'send', clientNonce: crypto.randomUUID(), body: 'first!' }),
    );
    await vi.waitFor(() => expect(early.sent).toEqual(['hello1', 'ack', 'message']));

    // A socket gone before its context was verified never joins the room.
    const gone = fake();
    (await accepted())(gone.socket);
    gone.listeners.close!();
    const watcher = fake();
    (await accepted())(watcher.socket);
    await vi.waitFor(() => expect(watcher.sent).toEqual(['hello2']));
    expect(gone.sent).toEqual([]);
    // The count is the early socket and the watcher only.
    expect(early.sent).toEqual(['hello1', 'ack', 'message', 'online2']);
    database.close();
  });
});
