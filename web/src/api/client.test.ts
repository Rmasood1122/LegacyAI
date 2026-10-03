import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type FetchLike } from './client.ts';
import { operations } from './generated.ts';

const SESSION = { card_id: 'c1', csrf_token: 'token-1', permissions: [] };
const json = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': type } });
const problemJson = (status: number, code: string, title: string): Response =>
  json(status, { type: `urn:legacyai:problem:${code}`, title, status, request_id: 'req-9' }, 'application/problem+json');

function setup(responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchMock = vi.fn<FetchLike>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  let n = 0;
  const onSessionLost = vi.fn();
  const client = new ApiClient({ fetch: fetchMock, newIdempotencyKey: () => `key-${++n}`, onSessionLost });
  const request = (i: number) => {
    const [url, init] = fetchMock.mock.calls[i] ?? ['', {}];
    return { url, init, headers: (init.headers ?? {}) as Record<string, string> };
  };
  return { client, fetchMock, onSessionLost, request };
}

describe('ApiClient', () => {
  it('reads: same-origin, never cached, no anti-forgery token and no idempotency key', async () => {
    const { client, request } = setup([json(200, { items: [], next_cursor: null })]);
    await client.call('listSources', { query: { limit: 50, status: undefined } });
    const { url, init, headers } = request(0);
    expect(url).toBe('/v1/sources?limit=50');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(headers['x-csrf-token']).toBeUndefined();
    expect(headers['idempotency-key']).toBeUndefined();
  });

  it('remembers the anti-forgery token from the session and sends it, with a fresh key, on a change', async () => {
    const { client, request } = setup([json(200, SESSION), json(201, { id: 'i1', status: 'candidate' }), json(201, { id: 'i2', status: 'candidate' })]);
    await client.call('getSession');
    await client.call('createKnowledgeItem', { body: { title: 'Valve', body: 'Closes at 6 bar' } });
    await client.call('createKnowledgeItem', { body: { title: 'Valve', body: 'Closes at 6 bar' } });
    expect(request(1).headers).toMatchObject({ 'x-csrf-token': 'token-1', 'idempotency-key': 'key-1', 'content-type': 'application/json' });
    expect(request(1).init.body).toBe(JSON.stringify({ title: 'Valve', body: 'Closes at 6 bar' }));
    expect(request(2).headers['idempotency-key']).toBe('key-2');
  });

  it('sends an idempotency key exactly on the operations the contract marks', () => {
    expect(operations.createSource.idempotent).toBe(true);
    expect(operations.listSources.idempotent).toBe(false);
    expect(Object.values(operations).filter((o) => o.idempotent).every((o) => (o.method as string) !== 'GET')).toBe(true);
  });

  it('puts ids into the address safely', async () => {
    const { client, request } = setup([json(200, { id: 'x', status: 'verified' })]);
    await client.call('verifyKnowledgeItem', { path: { item_id: 'a/b?c' } });
    expect(request(0).url).toBe('/v1/knowledge/items/a%2Fb%3Fc/verify');
    await expect(client.call('verifyKnowledgeItem', { path: { item_id: '' } })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('uploads a file with its type, and refuses a type the contract does not list', async () => {
    const { client, request, fetchMock } = setup([json(200, SESSION), json(200, { status: 'ready', failure_code: null, chunk_count: 2, pending_chunks: 0, duplicate_of: null })]);
    await client.call('getSession');
    const file = new Blob(['synthetic notes'], { type: 'text/plain' });
    await client.call('uploadSourceContent', { path: { source_id: 's1' }, body: file, contentType: 'text/plain' });
    expect(request(1).url).toBe('/v1/sources/s1/content');
    expect(request(1).headers['content-type']).toBe('text/plain');
    expect(request(1).init.body).toBe(file);
    await expect(client.call('uploadSourceContent', { path: { source_id: 's1' }, body: file, contentType: 'image/png' })).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('turns a problem response into an ApiError with the API\'s words, code and reference', async () => {
    const { client } = setup([problemJson(409, 'consent-required', 'Consent is needed first')]);
    const err = await client.call('listSources').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'conflict', status: 409, message: 'Consent is needed first', code: 'consent-required', requestId: 'req-9' });
  });

  it('a 204 gives nothing back; logging out forgets the token', async () => {
    const { client, request } = setup([json(200, SESSION), new Response(null, { status: 204 }), json(201, { id: 'i', status: 'candidate' })]);
    await client.call('getSession');
    await expect(client.call('logout')).resolves.toBeUndefined();
    await client.call('createKnowledgeItem', { body: { title: 't', body: 'b' } });
    expect(request(2).headers['x-csrf-token']).toBeUndefined();
  });

  it('tells the application when the session is gone - but not for a failed sign-in', async () => {
    const { client, onSessionLost } = setup([problemJson(401, 'unauthenticated', 'Sign in again'), problemJson(401, 'unauthenticated', 'Not signed in')]);
    await expect(client.call('listSources')).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    await expect(client.call('loginVerify', { body: { login_txn: 'x'.repeat(20), sc: '123', factor: { type: 'totp', code: '123456' } } })).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('after a refused change it fetches the new token once and repeats the request with the SAME key', async () => {
    const { client, request, fetchMock } = setup([
      json(200, SESSION), problemJson(403, 'forbidden', 'Not allowed'), json(200, { ...SESSION, csrf_token: 'token-2' }), json(200, { id: 'i', status: 'verified' }),
    ]);
    await client.call('getSession');
    await expect(client.call('verifyKnowledgeItem', { path: { item_id: 'i' } })).resolves.toEqual({ id: 'i', status: 'verified' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(request(2).url).toBe('/v1/auth/session');
    expect(request(3).headers).toMatchObject({ 'x-csrf-token': 'token-2', 'idempotency-key': request(1).headers['idempotency-key'] });
  });

  it('a real "not allowed" is not repeated', async () => {
    const { client, fetchMock } = setup([json(200, SESSION), problemJson(403, 'forbidden', 'Not allowed'), json(200, SESSION)]);
    await client.call('getSession');
    await expect(client.call('verifyKnowledgeItem', { path: { item_id: 'i' } })).rejects.toMatchObject({ kind: 'forbidden', message: 'Not allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a network failure becomes a plain message, and a non-JSON error body is not shown', async () => {
    const { client } = setup([new TypeError('failed to fetch'), new Response('<html>stack trace</html>', { status: 500, headers: { 'content-type': 'text/html' } })]);
    await expect(client.call('listSources')).rejects.toMatchObject({ kind: 'network' });
    const err = await client.call('listSources').catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ kind: 'unavailable', status: 500 });
    expect((err as ApiError).message).not.toContain('stack');
  });
});
