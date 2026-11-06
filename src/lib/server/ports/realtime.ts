/** The member a socket is opened for, as the pipeline verified them (R-CHAT-04). */
export interface RealtimeMember {
  id: string;
  role: 'member' | 'admin';
  displayName: string;
  /** The verified Access JWT's `exp`, in ms (R-CHAT-16). */
  authUntil: number;
}

/** §9 / R-PLAT-06: the live chat room; history and authorization stay in D1 (INV-2). */
export interface RealtimeHub {
  /**
   * Opens a socket for an upgrade the pipeline already authorized. Throws when the hub
   * cannot accept one (no `INTERNAL_CONTEXT_KEY`, no room).
   */
  connect(request: Request, member: RealtimeMember): Promise<Response>;
  /** R-CHAT-09: closes that member's sockets with 4003; best effort. */
  disconnectMember(memberId: string): Promise<void>;
  /** R-CHAT-03: tells every socket a message became a tombstone. */
  notify(event: { type: 'message.deleted'; id: string }): Promise<void>;
}
