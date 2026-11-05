export interface RealtimeHub {
  connect(
    request: Request,
    member: { id: string; role: 'member' | 'admin'; displayName: string },
  ): Promise<Response>;
  disconnectMember(memberId: string): Promise<void>;
  notify(event: { type: 'message.deleted'; id: string }): Promise<void>;
}
