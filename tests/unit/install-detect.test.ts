import { describe, expect, it } from 'vitest';
import { detectInstall, type InstallKind } from '../../src/lib/install/detect';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  zaloIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo/24.6.1 Safari/604.1',
  zaloAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Zalo/24.6.1',
  messengerIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/460.0.0.0;FBBV/1;FBDV/iPhone15,2]',
  messengerAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/460.0.0.0;]',
  facebookIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.0;FBBV/1;FBDV/iPhone15,2]',
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.0;]',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktopFirefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  line: 'Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36 Line/14.9.0',
  instagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0',
};

const detect = (
  userAgent: string,
  extra: { maxTouchPoints?: number; standalone?: boolean; promptCaptured?: boolean } = {},
) =>
  detectInstall({
    userAgent,
    maxTouchPoints: 0,
    standalone: false,
    promptCaptured: false,
    ...extra,
  });

describe('install detection', () => {
  const table: [string, string, Parameters<typeof detect>[1], InstallKind][] = [
    ['iPhone Safari', UA.iphoneSafari, { maxTouchPoints: 5 }, 'ios'],
    ['iPhone Chrome', UA.iphoneChrome, { maxTouchPoints: 5 }, 'ios'],
    ['iPad with a desktop UA', UA.ipadDesktop, { maxTouchPoints: 5 }, 'ios'],
    ['Android Chrome before the event', UA.androidChrome, { maxTouchPoints: 5 }, 'android-menu'],
    ['Android Chrome with the event', UA.androidChrome, { promptCaptured: true }, 'prompt'],
    ['Android Firefox', UA.androidFirefox, {}, 'android-menu'],
    ['Samsung Internet', UA.samsung, {}, 'android-menu'],
    ['Zalo on iOS', UA.zaloIos, {}, 'in-app'],
    ['Zalo on Android', UA.zaloAndroid, {}, 'in-app'],
    ['Messenger on iOS', UA.messengerIos, {}, 'in-app'],
    ['Messenger on Android', UA.messengerAndroid, {}, 'in-app'],
    ['Facebook on iOS', UA.facebookIos, {}, 'in-app'],
    ['Facebook on Android', UA.facebookAndroid, {}, 'in-app'],
    ['LINE', UA.line, {}, 'in-app'],
    ['Instagram', UA.instagram, {}, 'in-app'],
    [
      'an in-app browser that also captured the event',
      UA.facebookAndroid,
      { promptCaptured: true },
      'in-app',
    ],
    ['desktop Chrome without the event', UA.desktopChrome, {}, 'desktop-menu'],
    ['desktop Chrome with the event', UA.desktopChrome, { promptCaptured: true }, 'prompt'],
    ['desktop Safari', UA.desktopSafari, {}, 'desktop-menu'],
    ['desktop Firefox', UA.desktopFirefox, {}, 'unsupported'],
    ['standalone iPhone', UA.iphoneSafari, { standalone: true, maxTouchPoints: 5 }, 'installed'],
    ['standalone in-app UA', UA.zaloIos, { standalone: true }, 'installed'],
    [
      'standalone Android with the event',
      UA.androidChrome,
      { standalone: true, promptCaptured: true },
      'installed',
    ],
  ];

  it.each(table)('AC-NAV-08 %s → %s', (_name, ua, extra, kind) => {
    expect(detect(ua, extra)).toBe(kind);
  });

  it('AC-NAV-08 a Mac user agent without touch points is a Mac, not an iPad', () => {
    expect(detect(UA.ipadDesktop, { maxTouchPoints: 0 })).toBe('desktop-menu');
  });
});
