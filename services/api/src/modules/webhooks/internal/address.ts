// Where a webhook may be sent: an `https` address on the public internet, and nothing else.
//
// The danger is that the API server itself makes the request. An address that names (or resolves to) something
// inside the hosting network - the cloud metadata server, the database, the AI service, localhost - would let a
// company's Owner make the server talk to those (server-side request forgery). So:
//   1. when the endpoint is registered, the address must be `https://<host name>[:port]/<path>`: no IP literal, no
//      user name or password, no fragment, a host name with a dot that is not a known internal suffix;
//   2. at EVERY delivery the host name is looked up again and EVERY address it resolves to must be public; the
//      connection is then made to the address that was checked (a pinned lookup), so the name cannot be re-pointed
//      at an internal address between the check and the connection (DNS rebinding);
//   3. redirects are not followed (transport.ts).
// The rules below are pure; the lookup is passed in.
import { BlockList, isIP } from 'node:net';

export const MAX_URL_LENGTH = 2048;

export type AddressProblem = 'not-https' | 'credentials' | 'fragment' | 'ip-literal' | 'bad-host' | 'internal-host' | 'too-long' | 'unreadable';

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.home.arpa', '.localdomain'];

/** Why this address cannot be registered, or null when it can. Pure. */
export function urlProblem(text: string): AddressProblem | null {
  if (text.length > MAX_URL_LENGTH) return 'too-long';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'unreadable';
  }
  if (url.protocol !== 'https:') return 'not-https';
  if (url.username !== '' || url.password !== '') return 'credentials';
  if (text.includes('#')) return 'fragment';
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || isIP(host) !== 0 || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'ip-literal';
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return 'internal-host';
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return 'bad-host';
  return null;
}

// Every range that is not ordinary public unicast (IANA special-purpose registries, checked 2026-10-06). Two lists:
// node's BlockList treats an IPv4-mapped IPv6 range as covering IPv4 addresses too, so the families are kept apart
// (and a mapped address is checked as the IPv4 address it carries, embeddedV4 below).
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC_V4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC_V6.addSubnet(net, bits, 'ipv6');
// Global unicast IPv6 is 2000::/3; everything outside it is reserved.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

/** An IPv4 address written inside an IPv6 one (::ffff:a.b.c.d), as IPv4; otherwise null. */
function embeddedV4(address: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? (m[1] as string) : null;
}

/** True only for an ordinary public unicast address. Pure. */
export function isPublicAddress(address: string): boolean {
  const v4 = embeddedV4(address);
  if (v4 !== null) return isPublicAddress(v4);
  const family = isIP(address);
  if (family === 4) return !NOT_PUBLIC_V4.check(address, 'ipv4');
  if (family === 6) return GLOBAL_V6.check(address, 'ipv6') && !NOT_PUBLIC_V6.check(address, 'ipv6');
  return false;
}

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/**
 * The address to connect to, or why there is none: every address the name resolves to must be public (one internal
 * address among public ones refuses the whole name - a name that points inside is not trusted for any of its
 * addresses). `isAllowed` exists for the tests of the transport only; production uses isPublicAddress.
 */
export async function checkedAddress(host: string, resolve: Resolver, isAllowed: (a: string) => boolean = isPublicAddress): Promise<ResolvedAddress | 'dns' | 'address_refused'> {
  let found: ResolvedAddress[];
  try {
    found = await resolve(host);
  } catch {
    return 'dns';
  }
  if (found.length === 0) return 'dns';
  if (!found.every((a) => isAllowed(a.address))) return 'address_refused';
  return found[0] as ResolvedAddress;
}
