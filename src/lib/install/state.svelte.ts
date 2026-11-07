import { detectInstall, isIosAgent, type InstallKind } from './detect';

// R-NAV-11: nothing about installing leaves the browser.
export const DISMISSED_KEY = 'classhub:install-card-dismissed';
export const ACCEPTED_KEY = 'classhub:install-accepted';
export const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const STANDALONE_QUERY =
  '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether a stored dismissal is still within its 30 days. A damaged value counts as none. */
export function dismissalActive(stored: string | null, now: number): boolean {
  const at = Number(stored);
  return stored !== null && Number.isFinite(at) && now - at < DISMISS_MS && now >= at;
}

class InstallState {
  /** False until `start()` ran in the browser: server markup and first paint show nothing. */
  ready = $state(false);
  kind = $state<InstallKind>('unsupported');
  ios = $state(false);
  coarse = $state(false);
  hidden = $state(false);
  #event: InstallPromptEvent | null = null;
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.#event = event as InstallPromptEvent;
      this.refresh();
    });
    window.addEventListener('appinstalled', () => this.accepted());
    this.refresh();
    this.ready = true;
  }

  refresh(): void {
    const nav = navigator as Navigator & { standalone?: boolean };
    const env = {
      userAgent: nav.userAgent,
      maxTouchPoints: nav.maxTouchPoints,
      standalone: window.matchMedia(STANDALONE_QUERY).matches || nav.standalone === true,
      promptCaptured: this.#event !== null,
    };
    this.kind = detectInstall(env);
    this.ios = isIosAgent(env);
    this.coarse = window.matchMedia('(pointer: coarse)').matches;
    this.hidden = read(ACCEPTED_KEY) !== null || dismissalActive(read(DISMISSED_KEY), Date.now());
  }

  /** R-NAV-11: the card is for these kinds only, and the other three only on a touch screen. */
  get cardVisible(): boolean {
    if (!this.ready || this.hidden) return false;
    if (this.kind === 'prompt') return true;
    return (
      (this.kind === 'ios' || this.kind === 'android-menu' || this.kind === 'in-app') && this.coarse
    );
  }

  dismiss(): void {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      /* private mode: the card returns next visit */
    }
    this.hidden = true;
  }

  accepted(): void {
    try {
      localStorage.setItem(ACCEPTED_KEY, '1');
    } catch {
      /* private mode */
    }
    this.hidden = true;
  }

  /** Calls the captured event's `prompt()`; resolves true when the member accepted. */
  async install(): Promise<boolean> {
    const event = this.#event;
    if (!event) return false;
    await event.prompt();
    const { outcome } = await event.userChoice;
    this.#event = null;
    if (outcome === 'accepted') this.accepted();
    this.refresh();
    return outcome === 'accepted';
  }
}

export const installState = new InstallState();
