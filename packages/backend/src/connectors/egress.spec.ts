import { egressIps, ipRefusalHint, listIps, looksLikeIpRefusal } from './egress';

describe('egressIps', () => {
  it('reads EGRESS_IPS, trims, drops what is not an address and repeats', () => {
    expect(egressIps({ EGRESS_IPS: ' 104.248.242.235 , 2001:db8::1,not-an-ip,,104.248.242.235' })).toEqual([
      '104.248.242.235',
      '2001:db8::1',
    ]);
  });

  it('is empty when the operator did not set it', () => {
    expect(egressIps({})).toEqual([]);
    expect(egressIps({ EGRESS_IPS: '' })).toEqual([]);
  });

  it('lists addresses the way a sentence reads', () => {
    expect(listIps(['1.1.1.1'])).toBe('1.1.1.1');
    expect(listIps(['1.1.1.1', '2.2.2.2'])).toBe('1.1.1.1 and 2.2.2.2');
    expect(listIps(['1.1.1.1', '2.2.2.2', '3.3.3.3'])).toBe('1.1.1.1, 2.2.2.2 and 3.3.3.3');
  });
});

describe('looksLikeIpRefusal', () => {
  // 3 Nov 2026: a self-hosted Bitrix24 behind a firewall answered every call
  // with this page after its allowlist changed.
  const accessRestricted =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Access Restricted</title>';

  it('takes a 403 web page for a firewall in front of the API', () => {
    expect(looksLikeIpRefusal({ status: 403, text: accessRestricted })).toBe(true);
  });

  it('recognises the providers that say so in words', () => {
    expect(looksLikeIpRefusal({ status: 403, text: '{"error":"error_auth","message":"source_ip_undeclared"}' })).toBe(true);
    expect(looksLikeIpRefusal({ status: 200, text: '{"isError":true,"messages":["You are not allowed to use this API."]}' })).toBe(true);
    expect(looksLikeIpRefusal({ status: 401, text: 'Your IP address is not whitelisted' })).toBe(true);
    expect(looksLikeIpRefusal({ status: 403, text: 'Request blocked from this IP' })).toBe(true);
  });

  it('leaves bot walls to the proxy: no allowlist on the user side fixes them', () => {
    expect(looksLikeIpRefusal({ status: 403, text: '<!DOCTYPE html><html><head><title>Just a moment...</title>' })).toBe(false);
    expect(
      looksLikeIpRefusal({
        status: 403,
        text: '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.1 https://errors.edgesuite.net/18.1</BODY></HTML>',
      }),
    ).toBe(false);
  });

  it('leaves permission errors and other pages alone', () => {
    expect(looksLikeIpRefusal({ status: 403, text: '{"error":"ACCESS_DENIED","error_description":"Access denied"}' })).toBe(false);
    expect(looksLikeIpRefusal({ status: 404, text: accessRestricted })).toBe(false);
    expect(looksLikeIpRefusal({ status: 500, text: '<html><body>Internal error</body></html>' })).toBe(false);
    expect(looksLikeIpRefusal({ text: 'connect ETIMEDOUT' })).toBe(false);
  });
});

describe('ipRefusalHint', () => {
  it('names the fixed Cloud address', () => {
    const hint = ipRefusalHint({ ips: ['104.248.242.235'], cloud: true });
    expect(hint).toMatch(/AnythingMCP Cloud calls every API from the fixed IP address 104\.248\.242\.235\./);
    expect(hint).toMatch(/allow 104\.248\.242\.235/);
    expect(hint).not.toMatch(/proxy/i);
  });

  it('speaks of the server address when none is configured', () => {
    const hint = ipRefusalHint({ ips: [] });
    expect(hint).toMatch(/public IP address of the server AnythingMCP runs on/);
    expect(hint).toMatch(/allow that address/);
  });

  it('says to switch the proxy off when the call went through it', () => {
    expect(ipRefusalHint({ ips: ['1.2.3.4', '5.6.7.8'], usedProxy: true })).toMatch(
      /fixed IP addresses 1\.2\.3\.4 and 5\.6\.7\.8[\s\S]*switch "Use proxy" off/,
    );
  });
});
