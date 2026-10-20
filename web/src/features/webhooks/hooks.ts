// Outgoing webhooks: reading and changing endpoints, and the words the screen uses. No markup here.
import { useApiMutation, useApiQuery, useRefresh } from '../../api/context.tsx';
import type { NewWebhookEndpointRequest, WebhookDelivery, WebhookEndpoint, WebhookTopic } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

const ENDPOINTS_CHANGED = ['listWebhookEndpoints', 'listWebhookDeliveries'] as const;
/** A company has at most 10 live endpoints; one page holds them all. */
export const ENDPOINTS_SHOWN = 20;
export const DELIVERIES_SHOWN = 20;

export const useWebhookEndpoints = () => useApiQuery('listWebhookEndpoints', { query: { limit: ENDPOINTS_SHOWN } });
export const useWebhookOptions = () => useApiQuery('getWebhookOptions', undefined);
export const useWebhookDeliveries = (id: string) => useApiQuery('listWebhookDeliveries', { path: { webhook_id: id }, query: { limit: DELIVERIES_SHOWN } });
/**
 * Making an endpoint or a new secret does NOT wait for the list to be read again: the answer holds the secret, which
 * is shown once, and it must reach the screen at once. The caller shows it first and then calls `refresh()`.
 */
export const useCreateWebhook = () => useApiMutation('createWebhookEndpoint');
export const useRotateWebhookSecret = () => useApiMutation('rotateWebhookSecret');
export function useRefreshWebhooks(): () => void {
  const refresh = useRefresh();
  return () => void refresh(ENDPOINTS_CHANGED);
}
export const useUpdateWebhook = () => useApiMutation('updateWebhookEndpoint', ENDPOINTS_CHANGED);
export const useRemoveWebhook = () => useApiMutation('removeWebhookEndpoint', ENDPOINTS_CHANGED);
export const useSendWebhookTest = () => useApiMutation('sendWebhookTest', ENDPOINTS_CHANGED);

export const STATUS_TEXT: Readonly<Record<WebhookEndpoint['status'], { tone: BadgeTone; text: string }>> = {
  active: { tone: 'success', text: 'Sending' },
  disabled: { tone: 'neutral', text: 'Switched off' },
  paused: { tone: 'danger', text: 'Paused: deliveries kept failing' },
  removed: { tone: 'neutral', text: 'Removed' },
};

export const DELIVERY_TEXT: Readonly<Record<WebhookDelivery['status'], string>> = {
  pending: 'Waiting to be sent', sending: 'Being sent', delivered: 'Delivered', failed: 'Given up', cancelled: 'Cancelled',
};

export const ERROR_TEXT: Readonly<Record<NonNullable<WebhookDelivery['last_error']>, string>> = {
  address_refused: 'the address points inside a private network',
  dns: 'the host name could not be found',
  connect: 'no connection could be made',
  tls: 'the receiver’s certificate was not accepted',
  timeout: 'the receiver did not answer in time',
  http_status: 'the receiver answered with an error',
  secret_unreadable: 'the server could not read the signing secret - make a new one',
};

export interface EndpointForm {
  name: string;
  url: string;
  topics: ReadonlySet<WebhookTopic>;
  level: string;
}
export const emptyEndpointForm = (): EndpointForm => ({ name: '', url: 'https://', topics: new Set(), level: '0' });

type Field = 'name' | 'url' | 'topics' | 'level';
export type ParsedEndpointForm = { ok: true; body: NewWebhookEndpointRequest } | { ok: false; problems: Partial<Record<Field, string>> };

/** Turns the form into a request, or says what is wrong with it. The API checks the address again (and at every delivery). */
export function parseEndpointForm(form: EndpointForm): ParsedEndpointForm {
  const problems: Partial<Record<Field, string>> = {};
  const name = form.name.trim();
  if (name.length < 1 || name.length > 100) problems.name = 'Give the endpoint a name of at most 100 characters.';
  const url = form.url.trim();
  if (!/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(url) || url.length > 2048) problems.url = 'Use an address that starts with https:// and names a host on the internet.';
  const topics = [...form.topics].sort();
  if (topics.length === 0) problems.topics = 'Choose at least one event.';
  const level = /^[0-3]$/.test(form.level) ? Number(form.level) : -1;
  if (level < 0) problems.level = 'Choose a level.';
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return { ok: true, body: { name, url, topics, max_sensitivity: level } };
}
