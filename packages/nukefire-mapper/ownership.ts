export interface SessionIdentity {
  readonly id: number;
}

/** Shared mapper state has one writer: the oldest live same-server session. */
export function ownsSharedMapping(
  sessionId: number,
  sessions: readonly SessionIdentity[],
): boolean {
  return sessions[0]?.id === sessionId;
}
