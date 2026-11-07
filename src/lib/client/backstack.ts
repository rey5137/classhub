// R-NAV-12: a native app's back stack inside the browser's history.
//
// The browser only knows a flat list of entries. This module mirrors the in-app part of that list
// (oldest first) so the shell can decide, per tap, whether to push, replace or step back:
//   - in the installed app, the tab bar never stacks: Home sits at the bottom and one tab above it;
//   - a page's own Back link steps back when the page under it is its parent, so the list keeps
//     its filter and scroll position, and otherwise replaces (a deep link never leaves a stray entry).
// Entries are keyed by SvelteKit's history index, which grows by one per push and survives a reload.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { AfterNavigate, OnNavigate } from '@sveltejs/kit';
import { STANDALONE_QUERY } from '$lib/install/state.svelte';
import type { AppHref } from '$lib/nav';

const STORE_KEY = 'classhub:backstack';
const HISTORY_INDEX = 'sveltekit:history';

interface Entry {
  index: number;
  path: string;
}

let stack: Entry[] = [];
let landed: (() => void) | null = null;
/** Set while a tab tap runs two history steps, so only the last one animates. */
let jumping = false;

function historyIndex(): number | null {
  const value = (history.state as Record<string, unknown> | null)?.[HISTORY_INDEX];
  return typeof value === 'number' ? value : null;
}

function load(): Entry[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(stack.slice(-50)));
  } catch {
    // Private mode or a full quota: the stack still works for this page's life.
  }
}

/** True in the installed app (standalone, fullscreen or minimal-ui; `navigator.standalone` on iOS). */
export function isApp(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia(STANDALONE_QUERY).matches || nav.standalone === true;
}

/** Call from `afterNavigate` in the shell: records where the history now stands. */
export function track(navigation: AfterNavigate) {
  const index = historyIndex();
  const path = navigation.to?.url.pathname;
  if (index === null || !path) return;
  if (navigation.type === 'enter') stack = load();
  stack = stack.filter((entry) => entry.index < index);
  stack.push({ index, path });
  save();
  const done = landed;
  landed = null;
  done?.();
}

function current(): Entry | undefined {
  return stack.at(-1);
}

/** History steps from the current entry down to the nearest Home below it, or 0 if none. */
function stepsToHome(): number {
  const top = current();
  if (!top) return 0;
  for (let i = stack.length - 2; i >= 0; i -= 1) {
    if (stack[i]!.path === '/') return top.index - stack[i]!.index;
  }
  return 0;
}

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function stepBack(steps: number): Promise<void> {
  return new Promise((done) => {
    landed = done;
    history.go(-steps);
    // A step that never lands in the app (the entry left with a reload) must not stall the tap.
    setTimeout(() => {
      if (landed === done) landed = null;
      done();
    }, 1500);
  });
}

/**
 * The tab bar and top area links. In the installed app a tab replaces the tab above Home, and Home
 * steps back to Home, so the system Back goes tab → Home → leaves the app. On the website the links
 * keep the browser's usual history.
 */
export async function openTab(event: MouseEvent, route: AppHref) {
  const href = resolve(route);
  if (!isApp() || !plainClick(event)) return;
  const here = current()?.path;
  if (here === undefined) return;
  event.preventDefault();
  if (here === href) return;

  const toHome = stepsToHome();
  if (route === '/') {
    if (toHome > 0) await stepBack(toHome);
    else await goto(resolve(route), { replaceState: true });
    return;
  }
  if (here === '/') {
    await goto(resolve(route));
  } else if (toHome > 1) {
    // Deep inside a tab: return to the entry just above Home, then swap it for the new tab.
    jumping = true;
    try {
      await stepBack(toHome - 1);
    } finally {
      jumping = false;
    }
    await goto(resolve(route), { replaceState: true });
  } else {
    await goto(resolve(route), { replaceState: true });
  }
}

/**
 * A page's own Back link to its parent list. Steps back when the entry below is that list (any
 * filter), so the list comes back as it was; otherwise opens the list in place of this page.
 */
export function goBack(event: MouseEvent, route: AppHref) {
  if (!plainClick(event)) return;
  event.preventDefault();
  const below = stack.at(-2);
  const target = resolve(route);
  if (below && below.path === target && current()?.index === below.index + 1) history.back();
  else void goto(resolve(route), { replaceState: true });
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/**
 * Call from `onNavigate` in the shell: the installed app slides pages like a native stack
 * (forward from the right, back to the right) and cross-fades between tabs. The website, browsers
 * without view transitions and reduced motion get no animation.
 */
export function transition(navigation: OnNavigate): Promise<void> | void {
  if (jumping || !isApp() || !document.startViewTransition) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const from = navigation.from?.url.pathname;
  const to = navigation.to?.url.pathname;
  if (!from || !to || from === to) return;

  let direction: 'forward' | 'back' | 'tab';
  if (depth(from) <= 1 && depth(to) <= 1) direction = 'tab';
  else if (navigation.type === 'popstate')
    direction = (navigation.delta ?? -1) < 0 ? 'back' : 'forward';
  else direction = depth(to) < depth(from) ? 'back' : 'forward';

  const root = document.documentElement;
  return new Promise((done) => {
    root.dataset.navTransition = direction;
    const view = document.startViewTransition(async () => {
      done();
      await navigation.complete;
    });
    void view.finished.finally(() => delete root.dataset.navTransition);
  });
}
