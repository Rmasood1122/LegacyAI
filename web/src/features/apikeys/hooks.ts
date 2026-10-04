// API keys for machines: reading and changing them, and the words the screen uses. No markup here.
import { useApiMutation, useApiQuery, useRefresh } from '../../api/context.tsx';
import type { ApiKey, ApiKeyOptions, ApiKeyPermission, NewApiKeyRequest } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

const KEYS_CHANGED = ['listApiKeys'] as const;
/** The newest keys in one request. A company has at most 50 live keys; older, revoked ones may lie beyond. */
export const KEYS_SHOWN = 100;

export const useApiKeys = () => useApiQuery('listApiKeys', { query: { limit: KEYS_SHOWN } });
/** What THIS card could put into a key, and the limits the API applies. Asked separately from the list of keys. */
export const useApiKeyOptions = ({ enabled }: { enabled: boolean }) => useApiQuery('getApiKeyOptions', undefined, { enabled });
/**
 * Making a key does NOT wait for the list to be read again: the answer holds the key, which is shown once, and it
 * must reach the screen at once. The caller shows it first and then calls `refreshKeys()`.
 */
export const useCreateApiKey = () => useApiMutation('createApiKey');
export function useRefreshKeys(): () => void {
  const refresh = useRefresh();
  return () => void refresh(KEYS_CHANGED);
}
export const useRevokeApiKey = () => useApiMutation('revokeApiKey', KEYS_CHANGED);

/** What each permission lets a machine do, in plain words. A key can read and ask; it cannot add or change anything. */
export const PERMISSION_TEXT: Readonly<Record<ApiKeyPermission, string>> = {
  'knowledge:read': 'Read knowledge items and the knowledge map',
  'knowledge:ask': 'Ask questions (answers come from verified knowledge; uses the AI budget)',
  'topic:read': 'Read topics and job roles',
  'gap:read': 'Read the gap report',
  'source:read': 'Read the list of documents',
};

export const STATUS_TEXT: Readonly<Record<ApiKey['status'], { tone: BadgeTone; text: string }>> = {
  active: { tone: 'success', text: 'Working' },
  expired: { tone: 'neutral', text: 'Expired' },
  revoked: { tone: 'neutral', text: 'Revoked' },
  suspended: { tone: 'danger', text: 'Suspended after too many refused requests' },
};

/** Why a key was revoked, for the list. A key ends with every change of its maker's sign-in or rights. */
export const REVOKED_TEXT: Readonly<Record<NonNullable<ApiKey['revoked_reason']>, string>> = {
  by_owner: 'revoked by an owner',
  maker_code_rotated: 'its maker’s 3-digit code was changed',
  maker_credentials_reset: 'its maker’s sign-in was reset, or a sign-in factor was removed',
  maker_privilege_change: 'its maker’s roles changed',
  maker_card_replaced: 'its maker’s card was replaced',
  maker_card_revoked: 'its maker’s card was revoked',
  maker_card_suspended: 'its maker’s card was suspended',
  maker_card_locked: 'its maker’s card was locked',
};

export interface KeyForm {
  name: string;
  scope: ReadonlySet<ApiKeyPermission>;
  level: string;
  days: string;
  asks: string;
  networks: string;
}
export const emptyForm = (limits: ApiKeyOptions['limits']): KeyForm =>
  ({ name: '', scope: new Set(), level: '0', days: '90', asks: String(limits.default_asks_per_hour), networks: '' });

export type Grantable = ApiKeyOptions['grantable'][number];

/** The highest level a key with this scope may have: the lowest of its maker's levels for what it names. */
export function highestLevel(scope: ReadonlySet<ApiKeyPermission>, grantable: readonly Grantable[]): number {
  const levels = grantable.filter((g) => scope.has(g.permission)).map((g) => g.max_sensitivity);
  return levels.length === 0 ? 0 : Math.min(...levels);
}

type Field = 'name' | 'scope' | 'level' | 'days' | 'asks' | 'networks';
export type ParsedForm = { ok: true; body: NewApiKeyRequest } | { ok: false; problems: Partial<Record<Field, string>> };

const wholeNumber = (text: string): number => (/^[0-9]{1,6}$/.test(text.trim()) ? Number(text.trim()) : -1);

/** Turns the form into a request, or says what is wrong with it. The limits come from the API, which checks all of it again. */
export function parseKeyForm(form: KeyForm, options: ApiKeyOptions): ParsedForm {
  const { grantable, limits } = options;
  const problems: Partial<Record<Field, string>> = {};
  const name = form.name.trim();
  if (name.length < 1 || name.length > 100) problems.name = 'Give the key a name of at most 100 characters.';
  const allowed = new Set(grantable.map((g) => g.permission));
  const scope = [...form.scope].filter((p) => allowed.has(p)).sort();
  if (scope.length === 0) problems.scope = 'Choose at least one thing the key may do.';
  const level = /^[0-3]$/.test(form.level) ? Number(form.level) : -1;
  if (level < 0) problems.level = 'Choose a level.';
  else if (level > highestLevel(new Set(scope), grantable)) problems.level = 'The key cannot reach a level above your own.';
  const days = wholeNumber(form.days);
  if (days < 1 || days > limits.max_expires_in_days) problems.days = `Use a whole number of days from 1 to ${limits.max_expires_in_days}.`;
  const asks = wholeNumber(form.asks);
  if (asks < 1 || asks > limits.max_asks_per_hour) problems.asks = `Use a whole number from 1 to ${limits.max_asks_per_hour}.`;
  const networks = form.networks.split(/[\s,]+/).filter((n) => n !== '');
  if (networks.length > 20 || networks.some((n) => n.length > 50)) problems.networks = 'At most 20 networks.';
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    body: { name, scope, max_sensitivity: level, expires_in_days: days, asks_per_hour: asks, ...(networks.length > 0 ? { allowed_cidrs: networks } : {}) },
  };
}
