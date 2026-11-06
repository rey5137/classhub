import { spawn, type ChildProcess } from 'node:child_process';

// Dev servers a spec starts for itself over a scratch database (board.spec.ts, chat.spec.ts),
// so no other spec sees what it writes. Each runs detached, in its own process group.

const START_DEADLINE_MS = 90_000;
const servers: ChildProcess[] = [];

/** Starts one dev server and waits for /health; a server that exits or stalls fails the run. */
export async function startDevServer(port: number, env: NodeJS.ProcessEnv): Promise<void> {
  // A server already on the port (a stale run, or `npm run dev`) would answer /health for us.
  const busy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);
  if (busy) throw new Error(`port ${port} busy: stop whatever answers /health there first`);
  const server = spawn(
    'node_modules/.bin/vite',
    ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  servers.push(server);
  let output = '';
  server.stdout?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000)));
  server.stderr?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000)));
  let exited: number | null = null;
  server.once('exit', (code) => (exited = code ?? -1));
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`dev server on ${port} exited (${exited}):\n${output}`);
    const up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dev server on ${port} did not answer /health in time:\n${output}`);
}

export function stopDevServers(): void {
  for (const server of servers.splice(0)) {
    try {
      if (server.pid) process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
}

// A worker that dies or is interrupted before afterAll must not leave servers running.
process.once('exit', stopDevServers);
process.once('SIGINT', () => {
  stopDevServers();
  process.exit(130);
});

/** How long startDevServer may wait, so a spec's beforeAll can budget for it. */
export const DEV_SERVER_START_MS = START_DEADLINE_MS;
