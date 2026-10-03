// The web application's files (HTML, JavaScript, CSS), served by the API from the same address.
//
// This is the ONE exception to "no route without a policy check", and it is narrow on purpose:
//   - it is not a route at all: it only answers requests that matched NO API route;
//   - only GET and HEAD, and never anything under /v1 (the API keeps its own 404 there);
//   - only files that were read into memory at start-up are ever sent. The request path is a key
//     into that list and never touches the file system, so "../" tricks have nothing to act on;
//   - the files are public by nature (the sign-in screen must load before anyone is signed in) and
//     contain no data: every piece of data still comes from a /v1 route with its policy check.
// Off unless WEB_DIST_DIR is configured.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface StaticAsset {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

/**
 * The browser may load scripts, styles, images and fonts from this address only, talk to this
 * address only, and may not be framed. No inline script and no inline style are allowed.
 */
export const WEB_APP_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const INDEX = '/index.html';
// Build tools put a content hash in the names under /assets/, so those files never change.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

export class StaticSiteError extends Error {}

/** One served file, from its address and content. Throws for a file type that is not served. */
function toAsset(urlPath: string, body: Buffer): StaticAsset {
  const contentType = CONTENT_TYPES[path.posix.extname(urlPath).toLowerCase()];
  if (contentType === undefined) throw new StaticSiteError(`a file type that is not served: ${urlPath}`);
  return { body, contentType, cacheControl: urlPath.startsWith('/assets/') ? IMMUTABLE : REVALIDATE };
}

export class StaticSite {
  readonly #assets: ReadonlyMap<string, StaticAsset>;

  private constructor(assets: Map<string, StaticAsset>) {
    this.#assets = assets;
  }

  /** Reads every file under `dir` once. Fails (and so stops start-up) if the folder is not a usable build. */
  static load(dir: string): StaticSite {
    const root = path.resolve(dir);
    const assets = new Map<string, StaticAsset>();
    let total = 0;
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new StaticSiteError(`WEB_DIST_DIR (${root}) must not contain symbolic links: ${full}`);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const urlPath = `/${path.relative(root, full).split(path.sep).join('/')}`;
        if (CONTENT_TYPES[path.posix.extname(urlPath).toLowerCase()] === undefined) {
          throw new StaticSiteError(`WEB_DIST_DIR (${root}) contains a file type that is not served: ${full}`);
        }
        total += statSync(full).size;
        if (assets.size + 1 > MAX_FILES || total > MAX_TOTAL_BYTES) throw new StaticSiteError(`WEB_DIST_DIR (${root}) is larger than a web build should be`);
        assets.set(urlPath, toAsset(urlPath, readFileSync(full)));
      }
    };
    try {
      walk(root);
    } catch (err) {
      if (err instanceof StaticSiteError) throw err;
      throw new StaticSiteError(`WEB_DIST_DIR (${root}) cannot be read`);
    }
    if (!assets.has(INDEX)) throw new StaticSiteError(`WEB_DIST_DIR (${root}) has no index.html`);
    return new StaticSite(assets);
  }

  /** For tests: a site made of files given in memory. */
  static fromFiles(files: Record<string, string>): StaticSite {
    const assets = new Map<string, StaticAsset>();
    for (const [urlPath, text] of Object.entries(files)) assets.set(urlPath, toAsset(urlPath, Buffer.from(text)));
    if (!assets.has(INDEX)) throw new StaticSiteError('no index.html');
    return new StaticSite(assets);
  }

  get fileCount(): number {
    return this.#assets.size;
  }

  /**
   * The file to send for a request that matched no API route, or null for "not found".
   * A path that looks like a screen address (no file extension) gets the application page, so that
   * reloading the browser on any screen works.
   */
  resolve(method: string, rawUrl: string): StaticAsset | null {
    if (method !== 'GET' && method !== 'HEAD') return null;
    const query = rawUrl.indexOf('?');
    const pathname = query === -1 ? rawUrl : rawUrl.slice(0, query);
    if (!pathname.startsWith('/') || pathname === '/v1' || pathname.startsWith('/v1/')) return null;
    const exact = this.#assets.get(pathname);
    if (exact !== undefined) return exact;
    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
    if (lastSegment.includes('.') || pathname.includes('%') || pathname.includes('\\')) return null;
    return this.#assets.get(INDEX) ?? null;
  }
}
