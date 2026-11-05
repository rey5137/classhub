import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeApi } from './fake-cloudflare.mjs';

// The Cloudflare API reads `cf.mjs api` makes, answered by `fakeApi` from the fake
// CLI's state on a loopback port, the only base cf.mjs accepts.

export interface FakeApi {
  base: string;
  /** `METHOD path authorization` of every request, in order. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeApi(
  stateDir: string,
  account: string,
  token: string,
): Promise<FakeApi> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const auth = request.headers.authorization ?? '';
    requests.push(
      `${request.method} ${request.url} ${auth === `Bearer ${token}` ? 'token' : auth}`,
    );
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (auth !== `Bearer ${token}`) return send(403, { success: false, errors: [{ code: 10000 }] });
    if (request.method !== 'GET') return send(405, { success: false, errors: [{ code: 1 }] });
    const prefix = `/client/v4/accounts/${account}`;
    const path = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : '';
    const { status, body } = fakeApi(path, stateDir);
    return send(status, body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
