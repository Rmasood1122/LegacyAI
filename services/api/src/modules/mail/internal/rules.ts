// When an e-mail that could not be sent is tried again. Pure.

export const MAIL_LIMITS = {
  maxAttempts: 5,
  /** Messages one run sends per company. */
  perCompanyPerRun: 100,
  /** Notices one run turns into messages per company. */
  noticesPerRun: 200,
} as const;

/** After the n-th failed attempt: 5 min, 30 min, 2 h, 12 h; then given up. */
const RETRY_DELAYS_MS = [300_000, 1_800_000, 7_200_000, 43_200_000] as const;

export function nextMailAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAIL_LIMITS.maxAttempts) return null;
  const delay = RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] as number;
  return new Date(now.getTime() + delay);
}
