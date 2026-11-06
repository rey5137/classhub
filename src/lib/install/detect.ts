// R-NAV-09: which install steps this device needs. Pure: the page reads the browser, this decides.

export type InstallKind =
  'installed' | 'in-app' | 'prompt' | 'ios' | 'android-menu' | 'desktop-menu' | 'unsupported';

export interface InstallEnv {
  userAgent: string;
  maxTouchPoints: number;
  /** `display-mode` standalone, fullscreen or minimal-ui, or `navigator.standalone`. */
  standalone: boolean;
  /** A `beforeinstallprompt` event has been captured. */
  promptCaptured: boolean;
}

const IN_APP = /Zalo|FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|\bLine\//i;
const IOS = /iPhone|iPod|iPad/;

export function detectInstall(env: InstallEnv): InstallKind {
  const ua = env.userAgent;
  if (env.standalone) return 'installed';
  if (IN_APP.test(ua)) return 'in-app';
  if (env.promptCaptured) return 'prompt';
  // iPadOS asks for the desktop site: a Mac user agent that has a touch screen.
  if (isIosAgent(env)) return 'ios';
  if (/Android/.test(ua)) return 'android-menu';
  const chromium = /(Chrome|Chromium|Edg|OPR)\//.test(ua);
  const safari = /Safari\//.test(ua) && /Macintosh/.test(ua) && !chromium && !/Firefox\//.test(ua);
  if (safari || chromium) return 'desktop-menu';
  return 'unsupported';
}

/** Whether the install guide, not just Chrome's own UI, is for iOS (the in-app steps differ). */
export const isIosAgent = (env: Pick<InstallEnv, 'userAgent' | 'maxTouchPoints'>) =>
  IOS.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
