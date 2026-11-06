import { randomUUID } from 'node:crypto';
import { ServerResponse, STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { CHAT_WS_PATH } from '../../../contracts/chat';
import { pendingUpgrades, TICKET_HEADER, type LocalSocket } from './upgrade-registry';

// R-PLAT-10: how `dev:offline` reaches the local hub. Vite hands every upgrade to its
// `upgrade` listeners and never to SvelteKit, so this listener runs the upgrade request
// through the dev server's own middleware (the full pipeline: Origin, identity,
// membership, lock, chat flag, then the route) with a fresh ticket. Only when the route
// accepted does it complete the WebSocket handshake; otherwise it writes the pipeline's
// refusal and closes. Dev-only: imported from vite.config.ts, never by the app.

/** A route that never answers frees its ticket and the socket. */
const RESPOND_TIMEOUT_MS = 10_000;
/** Workers' own frame limit; the room refuses anything past 4 KB itself (R-AUTH-22). */
const MAX_PAYLOAD = 1024 * 1024;

export type Respond = (request: IncomingMessage, response: ServerResponse) => void;

function adapt(socket: WebSocket): LocalSocket {
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) =>
      socket.on('message', (data: RawData, binary: boolean) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        listener(binary ? new Uint8Array(buffer).buffer : buffer.toString('utf8'));
      }),
    onClose: (listener) => socket.on('close', listener),
  };
}

function refuse(socket: Duplex, status: number, headers: Record<string, string>, body: Buffer) {
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    `content-length: ${body.byteLength}`,
    'connection: close',
  ];
  socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
}

/** An `upgrade` listener for the dev server; other paths (Vite's HMR) are left alone. */
export function createChatUpgrade(respond: Respond) {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== CHAT_WS_PATH) return;
    const pending = pendingUpgrades();
    const ticket = randomUUID();
    pending.set(ticket, {});
    // Overwrites anything the client sent under this name.
    request.headers[TICKET_HEADER] = ticket;

    const chunks: Buffer[] = [];
    const response = new ServerResponse(request);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const accept = pending.get(ticket)?.accept;
      pending.delete(ticket);
      if (accept && response.statusCode < 300) {
        server.handleUpgrade(request, socket, head, (ws) => accept(adapt(ws)));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.getHeaders())) {
        if (name !== 'content-length' && value !== undefined) headers[name] = String(value);
      }
      refuse(socket, response.statusCode, headers, Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      settled = true;
      pending.delete(ticket);
      socket.destroy();
    }, RESPOND_TIMEOUT_MS);

    // Capture what the pipeline answers instead of writing it to the socket.
    response.writeHead = ((status: number, ...rest: unknown[]) => {
      response.statusCode = status;
      const headers = rest.find((value) => value && typeof value === 'object');
      if (headers && !Array.isArray(headers)) {
        for (const [name, value] of Object.entries(headers as Record<string, string>)) {
          response.setHeader(name, value);
        }
      }
      return response;
    }) as ServerResponse['writeHead'];
    response.write = ((chunk: unknown) => {
      if (chunk) chunks.push(Buffer.from(chunk as Buffer));
      return true;
    }) as ServerResponse['write'];
    response.end = ((chunk?: unknown) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as Buffer));
      finish();
      return response;
    }) as ServerResponse['end'];
    socket.on('error', () => socket.destroy());
    respond(request, response);
  };
}
