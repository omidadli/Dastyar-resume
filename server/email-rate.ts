/**
 * One hourly sending budget per workspace, shared by every path that can send
 * mail on its own: a recruiter pressing «ارسال», an interview invitation, and
 * the automation engine. Keeping it in one module means the limit cannot be
 * bypassed by picking a different feature.
 */
export const EMAIL_HOURLY_LIMIT = 120;

const sent = new Map<string, number[]>();

/** True when one more message may be sent from this workspace right now. */
export function withinEmailLimit(orgId: string, limit = EMAIL_HOURLY_LIMIT): boolean {
  const now = Date.now();
  const recent = (sent.get(orgId) || []).filter((t) => now - t < 3600_000);
  sent.set(orgId, recent);
  return recent.length < limit;
}

export function noteEmailSend(orgId: string) {
  const list = sent.get(orgId) || [];
  list.push(Date.now());
  sent.set(orgId, list);
}

/** Used by tests to start from a clean budget. */
export function resetEmailBudget(orgId?: string) {
  if (orgId) sent.delete(orgId);
  else sent.clear();
}
