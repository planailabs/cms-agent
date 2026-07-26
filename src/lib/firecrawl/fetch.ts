import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

export const MAX_FETCH_BYTES = 25 * 1024 * 1024;

/**
 * Non-public address blocks, derived from the IANA special-purpose registries
 * (blocks whose "Globally Reachable" is False, collapsed to their top-level
 * prefixes) plus multicast and deprecated transition ranges:
 *   https://www.iana.org/assignments/iana-ipv4-special-registry/
 *   https://www.iana.org/assignments/iana-ipv6-special-registry/
 * Deliberate deviations, all toward blocking:
 * - 2001::/23 and 192.0.0.0/24 are blocked wholesale although they contain a
 *   handful of globally reachable anycast sub-assignments (PCP/TURN/AMT) — no
 *   fetchable website lives there.
 * - 64:ff9b::/96 (NAT64) is "reachable" per IANA, but a local translator can
 *   map it onto the operator's internal IPv4 space — blocked.
 * - 192.88.99.0/24 and 2002::/16 (6to4) are deprecated and embed IPv4 — blocked.
 * NOTE: ::ffff:0:0/96 (IPv4-mapped) must NOT be added as an ipv6 rule —
 * node's BlockList canonicalizes every IPv4 check as a mapped IPv6 address
 * internally, so that rule blocks ALL IPv4. Mapped literals are still caught:
 * the ipv4 rules match them through the same canonicalization.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['100:0:0:1::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

const isBlockedIp = (address: string): boolean =>
  blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

async function resolvePublicUrl(value: string): Promise<{ url: URL; address: string }> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs without credentials are allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error('Private, local, and special-purpose network addresses are not allowed');
  }
  return { url, address: addresses[0].address };
}

export async function assertPublicUrl(value: string): Promise<URL> {
  return (await resolvePublicUrl(value)).url;
}

export interface FetchResult {
  body: Buffer;
  status: number;
  url: string;
  headers: Record<string, string>;
}

export async function fetchPublic(
  value: string,
  options: {
    headers?: Record<string, string>;
    maxBytes?: number;
    timeoutMs?: number;
    method?: string;
    body?: Buffer;
  } = {},
): Promise<FetchResult> {
  let target = await resolvePublicUrl(value);
  const maxBytes = Math.min(options.maxBytes ?? MAX_FETCH_BYTES, MAX_FETCH_BYTES);
  let method = options.method ?? 'GET';
  let body = options.body;

  for (let redirects = 0; redirects <= 5; redirects++) {
    const fetched = await new Promise<FetchResult>((resolve, reject) => {
      const transport = target.url.protocol === 'https:' ? https : http;
      const headers = { ...options.headers };
      for (const name of ['host', 'connection', 'transfer-encoding', 'content-length']) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === name) delete headers[key];
      }
      headers.Host = target.url.host;
      headers['Accept-Encoding'] = 'identity';
      if (body) headers['Content-Length'] = String(body.length);

      const request = transport.request({
        protocol: target.url.protocol,
        hostname: target.address,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method,
        headers,
        servername: target.url.hostname,
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) request.destroy(new Error(`Response exceeds ${maxBytes} bytes`));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => resolve({
          body: Buffer.concat(chunks),
          status: response.statusCode ?? 0,
          url: target.url.href,
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, val]) => [key, Array.isArray(val) ? val.join(', ') : val ?? '']),
          ),
        }));
      });
      request.setTimeout(options.timeoutMs ?? 30_000, () => request.destroy(new Error('Request timed out')));
      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
    if (fetched.status >= 300 && fetched.status < 400) {
      const location = fetched.headers.location;
      if (!location) throw new Error(`Redirect ${fetched.status} has no Location header`);
      target = await resolvePublicUrl(new URL(location, target.url).href);
      if (fetched.status === 303 || ((fetched.status === 301 || fetched.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return fetched;
  }
  throw new Error('Too many redirects');
}
