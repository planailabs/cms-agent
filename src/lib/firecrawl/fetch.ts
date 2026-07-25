import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MAX_FETCH_BYTES = 25 * 1024 * 1024;

function isBlockedIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const ip = address.toLowerCase();
  return (
    ip === '::' ||
    ip === '::1' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    /^fe[89ab]/.test(ip) ||
    ip.startsWith('ff') ||
    ip.startsWith('::ffff:127.') ||
    ip.startsWith('::ffff:10.') ||
    ip.startsWith('::ffff:192.168.')
  );
}

export async function assertPublicUrl(value: string): Promise<URL> {
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
  return url;
}

export interface FetchResult {
  body: Buffer;
  status: number;
  url: string;
  headers: Record<string, string>;
}

export async function fetchPublic(
  value: string,
  options: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  let url = await assertPublicUrl(value);
  const maxBytes = Math.min(options.maxBytes ?? MAX_FETCH_BYTES, MAX_FETCH_BYTES);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      headers: options.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect ${response.status} has no Location header`);
      url = await assertPublicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.body) throw new Error('Response has no body');

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
      chunks.push(buffer);
    }
    return {
      body: Buffer.concat(chunks),
      status: response.status,
      url: url.href,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }
  throw new Error('Too many redirects');
}
