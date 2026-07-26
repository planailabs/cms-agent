import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from '@/lib/firecrawl/fetch';

describe('web fetch network boundary', () => {
  it('allows public addresses (regression: ::ffff:0:0/96 rule blocked ALL IPv4)', async () => {
    // node's BlockList canonicalizes IPv4 checks as mapped IPv6; an
    // ::ffff:0:0/96 ipv6 rule therefore rejected every IPv4 address.
    await expect(assertPublicUrl('http://3.161.119.87/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://93.184.215.14/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://[2600:9000:2611:3e00::1]/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://[2606:4700::6810:1]/')).resolves.toBeInstanceOf(URL);
  });

  it('rejects local, private, credentialed, and non-HTTP targets', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('http://10.0.0.1/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('http://[::ffff:a00:1]/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('https://user:pass@example.com/')).rejects.toThrow(/without credentials/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/HTTP/);
  });

  it('rejects the IANA special-purpose ranges', async () => {
    const blockedHosts = [
      '0.1.2.3',              // "this network"
      '100.64.0.1',           // shared address space (CGN)
      '169.254.1.1',          // link local
      '172.16.0.1',           // private
      '192.0.0.170',          // NAT64/DNS64 discovery
      '192.0.2.1',            // TEST-NET-1
      '192.88.99.1',          // deprecated 6to4 relay
      '192.168.1.1',          // private
      '198.18.0.1',           // benchmarking
      '203.0.113.9',          // TEST-NET-3
      '224.0.0.251',          // multicast
      '255.255.255.255',      // broadcast (240.0.0.0/4)
      '[::]',                 // unspecified
      '[::ffff:7f00:1]',      // IPv4-mapped loopback literal
      '[64:ff9b::a00:1]',     // NAT64
      '[100::1]',             // discard-only
      '[2001:2::1]',          // benchmarking (2001::/23)
      '[2001:db8::1]',        // documentation
      '[2002:a00:1::1]',      // 6to4
      '[3fff::1]',            // documentation (new)
      '[5f00::1]',            // SRv6 SIDs (new)
      '[fc00::1]', '[fd12::1]', // unique local
      '[fe80::1]',            // link local
      '[ff02::1]',            // multicast
    ];
    for (const host of blockedHosts) {
      await expect(assertPublicUrl(`http://${host}/`), host).rejects.toThrow(/not allowed/);
    }
  });
});
