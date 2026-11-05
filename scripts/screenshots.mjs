import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { devMemberEnv } from './lib/dev-member.mjs';

const ROOT = process.cwd();
const BASE = 'http://127.0.0.1:5173';
const OUT = path.join(ROOT, '.screenshots');
const WATCHDOG_MS = 5 * 60 * 1000;

const routes = [
  '/',
  '/memories',
  '/memories/photo-demo',
  '/discussions',
  '/discussions/thread-demo',
  '/chat',
  '/members',
  '/members/member-demo',
  '/profile',
  '/admin',
  '/admin/setup',
  '/locked',
  '/denied',
];

const combos = [
  { theme: 'yearbook', mode: 'light' },
  { theme: 'yearbook', mode: 'dark' },
  { theme: 'minimal', mode: 'light' },
  { theme: 'minimal', mode: 'dark' },
  { theme: 'night', mode: 'dark' },
];

const sizes = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

// The copy into .claude-out/<slice>/screens/ happens only when a slice id is given.
const sliceArgIndex = process.argv.indexOf('--slice');
const slice =
  (sliceArgIndex === -1 ? process.env.SCREENSHOTS_SLICE : process.argv[sliceArgIndex + 1]) ?? '';
if (slice && !/^[a-z0-9][a-z0-9-]*$/i.test(slice)) {
  console.error(`screenshots: invalid slice id ${slice}`);
  process.exit(1);
}
const COPY_DIR = path.join(ROOT, '.claude-out', slice || 'none', 'screens');

const routeArgIndex = process.argv.indexOf('--route');
const onlyRoute = routeArgIndex === -1 ? null : process.argv[routeArgIndex + 1];

if (onlyRoute && !routes.includes(onlyRoute)) {
  console.error(`screenshots: unknown route ${onlyRoute}`);
  process.exit(1);
}

const selectedRoutes = onlyRoute ? [onlyRoute] : routes;

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {import('@playwright/test').Browser | undefined} */
let browser;

/** @param {string} route */
function slug(route) {
  return route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-');
}

/**
 * @param {string} route
 * @param {string} theme
 * @param {string} mode
 */
function url(route, theme, mode) {
  const separator = route.includes('?') ? '&' : '?';
  return `${BASE}${route}${separator}theme=${theme}&mode=${mode}`;
}

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
  console.error('screenshots: timed out');
  void shutdown(1);
}, WATCHDOG_MS);

/** The seed draws ids at random, so the demo classmate's page is looked up (dev identity). */
async function demoMemberPath() {
  const response = await fetch(`${BASE}/api/v1/members?q=mai`, {
    signal: AbortSignal.timeout(10_000),
  });
  /** @type {{ items: { id: string; displayName: string }[] }} */
  const body = await response.json();
  const mai = body.items.find((item) => item.displayName === 'Mai Nguyen');
  if (!mai) throw new Error('screenshots: the demo seed has no Mai Nguyen');
  return `/members/${mai.id}`;
}

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

  for (const route of selectedRoutes) {
    const target = route === '/members/member-demo' ? await demoMemberPath() : route;
    for (const { theme, mode } of combos) {
      for (const { width, height } of sizes) {
        await page.setViewportSize({ width, height });
        const response = await page.goto(url(target, theme, mode), { waitUntil: 'load' });
        if (!response || response.status() !== 200) {
          throw new Error(`${route} ${theme}/${mode} ${width} returned ${response?.status()}`);
        }
        await page.waitForFunction(
          () => ['vi', 'en'].includes(document.documentElement.dataset.locale ?? ''),
          undefined,
          { timeout: 15_000 },
        );
        await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15_000 });
        await page.evaluate(async () => {
          await Promise.all([
            document.fonts.load('400 34px "Patrick Hand"'),
            ...[400, 500, 600, 700].map((weight) =>
              document.fonts.load(`${weight} 16px "Be Vietnam Pro"`),
            ),
          ]);
          await document.fonts.ready;
        });
        await page.waitForTimeout(80);

        const folder = path.join(OUT, `${theme}-${mode}`, `${width}`);
        await mkdir(folder, { recursive: true });
        const file = path.join(folder, `${slug(route)}.png`);
        await page.screenshot({ path: file, fullPage: true });

        if (slice) {
          await mkdir(COPY_DIR, { recursive: true });
          await copyFile(file, path.join(COPY_DIR, `${slug(route)}-${theme}-${mode}-${width}.png`));
        }
      }
    }
  }

  console.log(
    `screenshots: ${selectedRoutes.length * combos.length * sizes.length} images in ${OUT}`,
  );
  await shutdown(0);
}

run().catch(async (error) => {
  console.error(`screenshots: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
});
