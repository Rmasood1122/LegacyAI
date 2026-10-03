// The web application's files are the one thing the API sends without a policy check.
// These tests pin down how narrow that exception is. No database is needed.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHttpServer, createLogger, loadConfig, StaticSite, StaticSiteError, WEB_APP_CSP,
  type AuthPort, type Database, type HttpServer, type IdempotencyStore, type RateLimiter,
} from '../../src/modules/platform/index.ts';
import { systemClock } from '../../src/shared/clock.ts';
import { testEnv } from '../helpers/env.ts';

const FILES = {
  '/index.html': '<!doctype html><title>LegacyAI</title><div id="root"></div>',
  '/assets/app-abc123.js': 'console.log("app")',
  '/assets/app-abc123.css': 'body{margin:0}',
  '/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
};

describe('StaticSite.resolve', () => {
  const site = StaticSite.fromFiles(FILES);

  it('sends a file that exists, with its type', () => {
    expect(site.resolve('GET', '/assets/app-abc123.js')?.contentType).toBe('text/javascript; charset=utf-8');
    expect(site.resolve('GET', '/assets/app-abc123.js?v=1')?.body.toString()).toBe('console.log("app")');
    expect(site.resolve('HEAD', '/favicon.svg')?.contentType).toBe('image/svg+xml');
  });

  it('sends the application page for a screen address, so a reload works on any screen', () => {
    for (const url of ['/', '/ask', '/knowledge/01a10174-626c-7139-b859-d268a55b8205', '/sign-in?next=%2Fask']) {
      expect(site.resolve('GET', url)?.body.toString(), url).toBe(FILES['/index.html']);
    }
  });

  it('never answers under /v1: the API keeps its own "not found" there', () => {
    for (const url of ['/v1', '/v1/', '/v1/nope', '/v1/auth/session', '/v1/index.html']) expect(site.resolve('GET', url), url).toBeNull();
  });

  it('answers only GET and HEAD', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) expect(site.resolve(method, '/'), method).toBeNull();
  });

  it('has nothing to give to path tricks: the path is only a key into the list read at start-up', () => {
    for (const url of [
      '/../package.json', '/assets/../../.env', '/..%2f..%2f.env', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..\\..\\.env', '//etc/passwd.txt',
      '/assets/missing.js', '/.env', '/index.html.bak', 'index.html', '',
    ]) {
      const got = site.resolve('GET', url);
      expect(got === null || Object.values(FILES).includes(got.body.toString()), url).toBe(true);
      if (url.includes('.')) expect(got, url).toBeNull();
    }
  });

  it('hashed files may be cached for long; the page itself is re-checked every time', () => {
    expect(site.resolve('GET', '/assets/app-abc123.css')?.cacheControl).toContain('immutable');
    expect(site.resolve('GET', '/')?.cacheControl).toBe('no-cache');
  });
});

describe('configuration', () => {
  it('serves no files unless WEB_DIST_DIR is set', () => {
    expect(loadConfig(testEnv()).webDistDir).toBeNull();
    expect(loadConfig(testEnv({ WEB_DIST_DIR: '  ' })).webDistDir).toBeNull();
    expect(loadConfig(testEnv({ WEB_DIST_DIR: '/srv/web' })).webDistDir).toBe('/srv/web');
  });
});

describe('StaticSite.load', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'legacyai-web-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const build = (name: string, files: Record<string, string>): string => {
    const root = path.join(dir, name);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    return root;
  };

  it('reads a build folder', () => {
    const site = StaticSite.load(build('ok', { 'index.html': '<p>hi</p>', 'assets/a.js': '1' }));
    expect(site.fileCount).toBe(2);
    expect(site.resolve('GET', '/assets/a.js')?.body.toString()).toBe('1');
  });

  it('stops start-up when the folder is missing, has no index.html, or holds a file type that is not served', () => {
    expect(() => StaticSite.load(path.join(dir, 'does-not-exist'))).toThrow(StaticSiteError);
    expect(() => StaticSite.load(build('no-index', { 'assets/a.js': '1' }))).toThrow(/index\.html/);
    expect(() => StaticSite.load(build('odd', { 'index.html': 'x', 'notes.env': 'x' }))).toThrow(/not served/);
    expect(() => StaticSite.load(build('map', { 'index.html': 'x', 'assets/a.js.map': '{}' }))).toThrow(/not served/);
  });

  it('refuses symbolic links (a link could point outside the folder)', () => {
    const root = build('links', { 'index.html': 'x' });
    try {
      symlinkSync(path.join(dir, 'ok', 'index.html'), path.join(root, 'link.html'));
    } catch {
      return; // this machine does not allow creating links; CI (Linux) does
    }
    expect(() => StaticSite.load(root)).toThrow(/symbolic/);
  });
});

describe('the HTTP server with and without the web application', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const servers: HttpServer[] = [];
  const start = async (staticSite?: StaticSite, beforeReady?: (http: HttpServer) => void): Promise<HttpServer> => {
    const never = (): never => {
      throw new Error('not used by these tests');
    };
    const http = await createHttpServer({
      config: loadConfig(testEnv()), db: {} as Database, log: createLogger('silent'), clock: systemClock,
      auth: { resolveSession: never } as unknown as AuthPort, rateLimiter: { hit: never } as unknown as RateLimiter,
      idempotency: {} as IdempotencyStore, contractPath: path.resolve(here, '..', '..', 'openapi.yaml'), staticSite,
    });
    beforeReady?.(http);
    await http.app.ready();
    servers.push(http);
    return http;
  };
  afterAll(async () => {
    for (const s of servers) await s.app.close();
  });

  it('without WEB_DIST_DIR nothing is served: every unknown address is the API\'s "not found"', async () => {
    const http = await start();
    for (const url of ['/', '/ask', '/index.html']) {
      const res = await http.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('with it, the page is served with the strict browser policy and the API keeps its own answers', async () => {
    const http = await start(StaticSite.fromFiles(FILES));

    const page = await http.app.inject({ method: 'GET', url: '/ask' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toBe(WEB_APP_CSP);
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.body).toBe(FILES['/index.html']);

    const script = await http.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(script.headers['cache-control']).toContain('immutable');

    const head = await http.app.inject({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');

    for (const [method, url] of [['GET', '/v1/nope'], ['GET', '/v1'], ['POST', '/'], ['DELETE', '/ask'], ['GET', '/assets/missing.js'], ['GET', '/..%2f.env']] as const) {
      const res = await http.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.headers['content-type'], `${method} ${url}`).toContain('application/problem+json');
      expect(res.headers['cache-control'], `${method} ${url}`).toBe('no-store');
      expect(res.headers['content-security-policy'], `${method} ${url}`).toContain("default-src 'none'");
      expect(res.headers['content-security-policy'], `${method} ${url}`).not.toBe(WEB_APP_CSP);
    }
  });

  it('an API answer is never cacheable, even if something set another value on it', async () => {
    const http = await start(StaticSite.fromFiles(FILES), (h) => {
      h.app.addHook('onRequest', async (_req, reply) => {
        reply.header('cache-control', 'public, max-age=600');
      });
    });
    const api = await http.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(api.headers['cache-control']).toBe('no-store');
    const page = await http.app.inject({ method: 'GET', url: '/ask' });   // the static handler's own value still wins for files
    expect(page.headers['cache-control']).toBe('no-cache');
  });

  it('the browser policy allows no inline script, no other site and no framing', () => {
    expect(WEB_APP_CSP).toContain("default-src 'none'");
    expect(WEB_APP_CSP).toContain("script-src 'self'");
    expect(WEB_APP_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_APP_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
  });
});
