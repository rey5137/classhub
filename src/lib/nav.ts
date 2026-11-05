export type NavArea = 'home' | 'memories' | 'discussions' | 'chat' | 'members';

export type AppHref =
  | '/'
  | '/memories'
  | `/memories/${string}`
  | '/discussions'
  | `/discussions/${string}`
  | '/chat'
  | '/members'
  | `/members/${string}`
  | '/profile'
  | '/admin'
  | '/locked'
  | '/denied';

export interface NavItem {
  id: NavArea;
  href: AppHref;
}

export const navHref: Record<NavArea, AppHref> = {
  home: '/',
  memories: '/memories',
  discussions: '/discussions',
  chat: '/chat',
  members: '/members',
};
