// The rules of webhook delivery as pure functions: which events exist, which endpoint gets which event, what is
// sent, when a failed delivery is tried again and when an endpoint that keeps failing is paused.
// The same topic list is held by the database (CHECK on outbox_events and webhook_endpoints); a test keeps them equal.

export const TOPICS = ['knowledge.item_released', 'knowledge.item_changed', 'knowledge.item_withdrawn'] as const;
export type Topic = typeof TOPICS[number];
/** Sent by the Owner's "send a test message"; never in the outbox and never subscribed to. */
export const TEST_TOPIC = 'webhook.test';

export const TOPIC_TEXT: Readonly<Record<Topic, string>> = {
  'knowledge.item_released': 'A knowledge item became verified (it can now be used in answers)',
  'knowledge.item_changed': 'A verified knowledge item changed: its version, label, department or title',
  'knowledge.item_withdrawn': 'A verified knowledge item stopped being usable (back in review, stale, rejected or withdrawn)',
};

export const WEBHOOK_LIMITS = {
  /** Live (not removed) endpoints per company. */
  maxPerCompany: 10,
  /** Seconds to connect, send and get the status line - all of it. */
  timeoutMs: 5_000,
  /** Deliveries one run sends per company, so one company cannot hold up the others. */
  perCompanyPerRun: 50,
  /** Attempts before a delivery is given up. */
  maxAttempts: 8,
  /** Failed attempts in a row (across deliveries) and no success for this long: the endpoint is paused. */
  pauseAfterFailures: 15,
  pauseAfterHours: 24,
} as const;

/** Wait after the n-th failed attempt (n = 1..maxAttempts-1): 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h. ~45 h in all. */
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000] as const;

/** When to try again after `attempts` failed attempts, or null when the delivery is given up. */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= WEBHOOK_LIMITS.maxAttempts) return null;
  const delay = RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] as number;
  return new Date(now.getTime() + delay);
}

/** Pause an endpoint that keeps failing - but not because of one bad hour. */
export function shouldPause(p: { consecutiveFailures: number; lastSuccessAt: Date | null; createdAt: Date; now: Date }): boolean {
  const since = (p.lastSuccessAt ?? p.createdAt).getTime();
  return p.consecutiveFailures >= WEBHOOK_LIMITS.pauseAfterFailures && p.now.getTime() - since >= WEBHOOK_LIMITS.pauseAfterHours * 3_600_000;
}

export interface OutboxEvent {
  id: string;
  tenant_id: string;
  topic: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface EndpointFacts {
  topics: readonly string[];
  max_sensitivity: number;
  created_at: Date;
}

const level = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3 ? v : null);

/**
 * Does this endpoint get this event? It must have subscribed to the topic, have existed when the event happened
 * (an endpoint does not receive the past), and be allowed to know about the item: the item's label - before OR
 * after the change - must be within the endpoint's level. "Before or after" so that an endpoint also learns that
 * an item it knew about was relabelled out of its reach (it is told the new label, a number, nothing more).
 * An event whose label cannot be read goes nowhere.
 */
export function endpointGets(endpoint: EndpointFacts, event: OutboxEvent): boolean {
  if (!endpoint.topics.includes(event.topic)) return false;
  if (event.created_at.getTime() < endpoint.created_at.getTime()) return false;
  const now = level(event.payload.sensitivity);
  const before = level(event.payload.previous_sensitivity);
  if (now === null || before === null) return false;
  return Math.min(now, before) <= endpoint.max_sensitivity;
}

/** The JSON that is sent (and signed). Identifiers and labels only: what the outbox holds, nothing added. */
export function messageBody(event: { id: string; topic: string; tenant_id: string; created_at: Date; payload: Record<string, unknown> }): Record<string, unknown> {
  return { id: event.id, type: event.topic, created_at: event.created_at.toISOString(), company_id: event.tenant_id, data: event.payload };
}
