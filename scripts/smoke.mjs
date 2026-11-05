import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { devMemberEnv } from './lib/dev-member.mjs';

const ROOT = process.cwd();
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173';
const WATCHDOG_MS = 2 * 60 * 1000;

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {import('@playwright/test').Browser | undefined} */
let browser;

async function isUp() {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(deadline = Date.now() + 60_000) {
  while (Date.now() < deadline) {
    if (await isUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not become ready');
}

/** @param {number} code */
async function shutdown(code) {
  clearTimeout(watchdog);
  // Cleanup must not prevent a timed-out run from returning its failure status.
  setTimeout(() => process.exit(code), 5000).unref();
  await browser?.close().catch(() => {});
  if (server) {
    const pid = server.pid;
    try {
      if (pid) process.kill(-pid, 'SIGTERM');
      else server.kill('SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  process.exit(code);
}

const watchdog = setTimeout(() => {
  console.error('smoke: timed out');
  void shutdown(1);
}, WATCHDOG_MS);

async function run() {
  if (!(await isUp())) {
    server = spawn('npm', ['run', 'dev:offline'], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
      env: devMemberEnv(ROOT),
    });
  }
  await waitForServer();

  const launchOptions =
    !existsSync(chromium.executablePath()) && process.platform === 'darwin'
      ? { channel: 'chrome' }
      : {};
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const errors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });

  const response = await page.goto(`${BASE}/`, { waitUntil: 'load' });
  if (!response || response.status() !== 200) {
    errors.push(`page returned ${response?.status()}`);
  }

  await page.waitForFunction(
    () => ['vi', 'en'].includes(document.documentElement.dataset.locale ?? ''),
    undefined,
    { timeout: 15_000 },
  );
  await page.getByRole('heading', { level: 1 }).waitFor({ state: 'visible', timeout: 15_000 });

  if (errors.length > 0) {
    console.error(`smoke: ${errors.join('\n')}`);
    await shutdown(1);
  }

  console.log('smoke: / loaded with no console errors');
  await shutdown(0);
}

run().catch(async (error) => {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
});
