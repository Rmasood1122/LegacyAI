// Runs INSIDE the API image (piped to node by scripts/ci-container-checks.sh). It uses the same loader the
// server runs at start-up, alone, so no database is needed: the screens must load, the page and a deep
// link must be served, and nothing under /v1 may be shadowed by a file.
import { StaticSite, WEB_APP_CSP } from '/app/dist/modules/platform/internal/static-site.js';

const site = StaticSite.load(process.env.WEB_DIST_DIR ?? '');
const page = site.resolve('GET', '/');
const deepLink = site.resolve('GET', '/knowledge/anything');
if (page === null || deepLink === null) throw new Error('the page is not served');
if (site.resolve('GET', '/v1/health') !== null || site.resolve('GET', '/v1') !== null) throw new Error('a file shadows /v1');
if (site.resolve('POST', '/') !== null) throw new Error('a file answers a POST');
if (!WEB_APP_CSP.includes("script-src 'self'") || WEB_APP_CSP.includes('unsafe-inline')) throw new Error('unexpected content security policy');
console.log(`ok ${site.fileCount}`);
