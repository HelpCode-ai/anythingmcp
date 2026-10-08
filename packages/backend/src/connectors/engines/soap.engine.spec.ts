import { SoapEngine } from './soap.engine';
import axios from 'axios';
import * as soap from 'soap';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { SsrfBlockedError } from '../../common/ssrf.util';

jest.mock('axios');
jest.mock('soap');

const mockedAxios = axios as jest.Mocked<typeof axios>;

const FIXED_NONCE = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

/** SoapEngine with a fixed clock and nonce, so WS-Security headers are deterministic. */
class FixedClockSoapEngine extends SoapEngine {
  protected currentTime(): Date {
    return new Date('2026-10-08T07:00:00.123Z');
  }
  protected createNonce(): Buffer {
    return Buffer.from(FIXED_NONCE);
  }
}

describe('SoapEngine', () => {
  let engine: SoapEngine;

  const baseConfig = {
    baseUrl: 'http://example.com/service',
    authType: 'NONE',
  };

  const baseMapping = {
    method: 'GetUser',
    path: 'BasicHttpBinding_IService',
    soapAction: 'http://tempuri.org/IService/GetUser',
    endpoint: 'http://example.com/service',
    targetNamespace: 'http://tempuri.org/',
    paramOrder: ['userId'],
  };

  beforeEach(() => {
    engine = new SoapEngine();
    jest.clearAllMocks();
  });

  describe('SOAP envelope generation', () => {
    it('should generate valid SOAP 1.1 XML envelope', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><GetUserResponse><result>ok</result></GetUserResponse></Body></Envelope>',
      });

      await engine.execute(baseConfig, baseMapping, { userId: '42' });

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(envelope).toContain('soapenv:Envelope');
      expect(envelope).toContain('xmlns:tns="http://tempuri.org/"');
      expect(envelope).toContain('<tns:GetUser>');
      expect(envelope).toContain('<tns:userId>42</tns:userId>');
    });

    it('should order parameters by paramOrder', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        baseConfig,
        { ...baseMapping, paramOrder: ['lastName', 'firstName'] },
        { firstName: 'John', lastName: 'Doe' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      const lastNameIdx = envelope.indexOf('lastName');
      const firstNameIdx = envelope.indexOf('firstName');
      expect(lastNameIdx).toBeLessThan(firstNameIdx);
    });

    it('wraps the parameters in the stored input element and namespace', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        baseConfig,
        {
          ...baseMapping,
          inputElement: 'GetUserRequest',
          inputNamespace: 'http://example.com/users/schema',
        },
        { userId: '42' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain('xmlns:tns="http://example.com/users/schema"');
      expect(envelope).toContain('<tns:GetUserRequest>');
      expect(envelope).toContain('<tns:userId>42</tns:userId>');
      expect(envelope).toContain('</tns:GetUserRequest>');
      expect(envelope).not.toContain('<tns:GetUser>');
    });

    it('should escape XML special characters in parameter values', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        baseConfig,
        { ...baseMapping, paramOrder: ['name'] },
        { name: '<script>alert("xss")&more</script>' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain('&lt;script&gt;');
      expect(envelope).toContain('&amp;more');
      expect(envelope).toContain('&quot;xss&quot;');
      expect(envelope).not.toContain('<script>');
    });
  });

  describe('nested parameter values', () => {
    const okResponse = { status: 200, data: '<Envelope><Body><Resp/></Body></Envelope>' };
    const orderMapping = {
      ...baseMapping,
      method: 'CreateOrder',
      paramOrder: ['customer', 'lines', 'tags', 'note'],
    };

    async function envelopeFor(mapping: Record<string, unknown>, params: Record<string, unknown>) {
      mockedAxios.post.mockResolvedValue(okResponse);
      await engine.execute(baseConfig, mapping as any, params);
      return mockedAxios.post.mock.calls[0][1] as string;
    }

    it('writes objects as child elements and arrays as repeated elements', async () => {
      const envelope = await envelopeFor(orderMapping, {
        customer: { name: 'Ada & Co', address: { street: 'Main St 1', city: 'Basel' } },
        lines: [
          { sku: 'A-1', quantity: 2, gift: false },
          { sku: 'B-2', quantity: 1, gift: true },
        ],
        tags: ['urgent', 'b2b'],
        note: 'x',
      });

      expect(envelope).toContain(
        [
          '    <tns:CreateOrder>',
          '      <tns:customer>',
          '        <tns:name>Ada &amp; Co</tns:name>',
          '        <tns:address>',
          '          <tns:street>Main St 1</tns:street>',
          '          <tns:city>Basel</tns:city>',
          '        </tns:address>',
          '      </tns:customer>',
          '      <tns:lines>',
          '        <tns:sku>A-1</tns:sku>',
          '        <tns:quantity>2</tns:quantity>',
          '        <tns:gift>false</tns:gift>',
          '      </tns:lines>',
          '      <tns:lines>',
          '        <tns:sku>B-2</tns:sku>',
          '        <tns:quantity>1</tns:quantity>',
          '        <tns:gift>true</tns:gift>',
          '      </tns:lines>',
          '      <tns:tags>urgent</tns:tags>',
          '      <tns:tags>b2b</tns:tags>',
          '      <tns:note>x</tns:note>',
          '    </tns:CreateOrder>',
        ].join('\n'),
      );
      expect(envelope).not.toContain('[object Object]');
    });

    it('orders child elements by the stored elementOrder, then the remaining keys', async () => {
      const envelope = await envelopeFor(
        {
          ...orderMapping,
          elementOrder: { customer: ['name', 'address'], 'customer/address': ['street', 'city'] },
        },
        {
          // Keys in the "wrong" order, as a JSON client may send them.
          customer: { extra: 1, address: { city: 'Basel', street: 'Main St 1' }, name: 'Ada' },
        },
      );

      expect(envelope).toContain(
        [
          '      <tns:customer>',
          '        <tns:name>Ada</tns:name>',
          '        <tns:address>',
          '          <tns:street>Main St 1</tns:street>',
          '          <tns:city>Basel</tns:city>',
          '        </tns:address>',
          '        <tns:extra>1</tns:extra>',
          '      </tns:customer>',
        ].join('\n'),
      );
    });

    it('leaves out null and undefined values at any level and writes dates as ISO 8601', async () => {
      const envelope = await envelopeFor(orderMapping, {
        customer: {
          name: null,
          since: new Date('2026-10-08T07:00:00.000Z'),
          address: undefined,
          vip: true,
        },
        lines: [null, { sku: 'A-1' }],
        tags: [],
        note: null,
      });

      expect(envelope).toContain(
        [
          '    <tns:CreateOrder>',
          '      <tns:customer>',
          '        <tns:since>2026-10-08T07:00:00.000Z</tns:since>',
          '        <tns:vip>true</tns:vip>',
          '      </tns:customer>',
          '      <tns:lines>',
          '        <tns:sku>A-1</tns:sku>',
          '      </tns:lines>',
          '    </tns:CreateOrder>',
        ].join('\n'),
      );
      expect(envelope).not.toContain('null');
      expect(envelope).not.toContain('tags');
    });

    it('writes an empty object as an empty element', async () => {
      const envelope = await envelopeFor(orderMapping, { customer: {} });
      expect(envelope).toContain('      <tns:customer/>\n    </tns:CreateOrder>');
    });

    it('writes a parameter an older import named "tags[]" as <tns:tags>', async () => {
      const envelope = await envelopeFor(
        { ...baseMapping, paramOrder: ['tags[]'], bodyMapping: { 'tags[]': '$tags[]' } },
        { 'tags[]': ['a', 'b'] },
      );
      expect(envelope).toContain('      <tns:tags>a</tns:tags>\n      <tns:tags>b</tns:tags>');
      expect(envelope).not.toContain('[]');
    });

    it('escapes nested text', async () => {
      const envelope = await envelopeFor(orderMapping, {
        customer: { name: '<b>"x"</b>' },
        tags: ["it's"],
      });
      expect(envelope).toContain('<tns:name>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</tns:name>');
      expect(envelope).toContain('<tns:tags>it&apos;s</tns:tags>');
    });

    it('refuses a nested key that is not an XML name', async () => {
      await expect(
        engine.execute(baseConfig, orderMapping as any, {
          customer: { 'a><evil/><b': 'x' },
        }),
      ).rejects.toThrow('SOAP parameter "a><evil/><b" is not a valid XML element name');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('refuses a value that refers to itself', async () => {
      const customer: Record<string, unknown> = { name: 'Ada' };
      customer.self = customer;
      await expect(
        engine.execute(baseConfig, orderMapping as any, { customer }),
      ).rejects.toThrow('SOAP parameter "customer/self" contains a circular reference');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('refuses values nested more than 20 levels deep', async () => {
      let deep: Record<string, unknown> = { leaf: 'x' };
      for (let i = 0; i < 20; i++) deep = { level: deep };
      await expect(
        engine.execute(baseConfig, orderMapping as any, { customer: deep }),
      ).rejects.toThrow(/is nested more than 20 levels deep/);
      expect(mockedAxios.post).not.toHaveBeenCalled();

      // 20 levels are fine.
      let ok: Record<string, unknown> = { leaf: 'x' };
      for (let i = 0; i < 19; i++) ok = { level: ok };
      await expect(envelopeFor(orderMapping, { customer: ok })).resolves.toContain(
        '<tns:leaf>x</tns:leaf>',
      );
    });
  });

  describe('element qualification', () => {
    const okResponse = { status: 200, data: '<Envelope><Body><Resp/></Body></Envelope>' };
    const params = { userId: '42', filter: { active: true, roles: ['a', 'b'] } };
    const mapping = { ...baseMapping, paramOrder: ['userId', 'filter'] };

    it('qualifies parameter elements when the tool does not say otherwise (stored tools)', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);
      await engine.execute(baseConfig, mapping, params);
      const envelope = mockedAxios.post.mock.calls[0][1] as string;

      expect(envelope).toContain('      <tns:userId>42</tns:userId>');
      expect(envelope).toContain('        <tns:active>true</tns:active>');
    });

    it('writes parameter and nested elements unprefixed when childElementsQualified is false', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);
      await engine.execute(baseConfig, { ...mapping, childElementsQualified: false }, params);
      const envelope = mockedAxios.post.mock.calls[0][1] as string;

      expect(envelope).toContain(
        [
          '    <tns:GetUser>',
          '      <userId>42</userId>',
          '      <filter>',
          '        <active>true</active>',
          '        <roles>a</roles>',
          '        <roles>b</roles>',
          '      </filter>',
          '    </tns:GetUser>',
        ].join('\n'),
      );
      // The wrapper stays qualified, and no default namespace pulls the
      // unprefixed elements into one.
      expect(envelope).toContain('xmlns:tns="http://tempuri.org/"');
      expect(envelope).not.toMatch(/xmlns=/);
    });
  });

  describe('SOAP 1.2', () => {
    const soap12Mapping = { ...baseMapping, soapVersion: '1.2' as const };
    const soap12Response = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
        <env:Body><GetUserResponse><Name>Ada</Name></GetUserResponse></env:Body>
      </env:Envelope>`;

    it('sends a SOAP 1.2 envelope with the action in the Content-Type and no SOAPAction header', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200, data: soap12Response });

      const result = (await engine.execute(baseConfig, soap12Mapping, { userId: '42' })) as any;

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toBe(`<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:GetUser>
      <tns:userId>42</tns:userId>
    </tns:GetUser>
  </soapenv:Body>
</soapenv:Envelope>`);
      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe(
        'application/soap+xml; charset=utf-8; action="http://tempuri.org/IService/GetUser"',
      );
      expect(headers).not.toHaveProperty('SOAPAction');
      // The response is read the same way as a SOAP 1.1 one.
      expect(result).toEqual({ Name: 'Ada' });
    });

    it('leaves the action parameter out when the action is empty', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200, data: soap12Response });
      (soap.createClientAsync as jest.Mock).mockRejectedValueOnce(new Error('offline'));

      await engine.execute(
        { ...baseConfig, specUrl: 'http://example.com/soap12-empty?wsdl' },
        { ...soap12Mapping, soapAction: '' },
        { userId: '42' },
      );

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/soap+xml; charset=utf-8');
      expect(headers).not.toHaveProperty('SOAPAction');
    });

    it('reads a SOAP 1.2 fault returned with an HTTP error status', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
        data: `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>
          <env:Code><env:Value>env:Sender</env:Value></env:Code>
          <env:Reason><env:Text xml:lang="en">User 42 is unknown</env:Text></env:Reason>
        </env:Fault></env:Body></env:Envelope>`,
      });

      await expect(engine.execute(baseConfig, soap12Mapping, { userId: '42' })).rejects.toThrow(
        'SOAP call failed with HTTP 400: User 42 is unknown',
      );
    });

    it('puts the WS-Security header in the SOAP 1.2 envelope', async () => {
      engine = new FixedClockSoapEngine();
      mockedAxios.post.mockResolvedValue({ status: 200, data: soap12Response });

      await engine.execute(
        { ...baseConfig, authType: 'WS_SECURITY', authConfig: { username: 'u', password: 'p' } },
        soap12Mapping,
        { userId: '42' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain(
        'xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope"',
      );
      expect(envelope).toMatch(/<soapenv:Header>\s*<wsse:Security [^>]*soapenv:mustUnderstand="1">/);
    });

    it('sends SOAP 1.1 for a stored tool without soapVersion', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200, data: soap12Response });

      await engine.execute(baseConfig, baseMapping, { userId: '42' });

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain('xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"');
      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers).toEqual({
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'http://tempuri.org/IService/GetUser',
      });
    });
  });

  describe('SOAP response parsing', () => {
    it('should extract body content from SOAP response XML', async () => {
      const xml = `
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
          <soapenv:Body>
            <GetUserResponse>
              <Name>John</Name>
            </GetUserResponse>
          </soapenv:Body>
        </soapenv:Envelope>
      `;
      mockedAxios.post.mockResolvedValue({ status: 200, data: xml });

      const result = (await engine.execute(baseConfig, baseMapping, { userId: '1' })) as any;
      expect(result.Name).toBe('John');
    });

    it('should throw on SOAP fault', async () => {
      const xml = `
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
          <soapenv:Body>
            <soapenv:Fault>
              <faultstring>Server error</faultstring>
            </soapenv:Fault>
          </soapenv:Body>
        </soapenv:Envelope>
      `;
      mockedAxios.post.mockResolvedValue({ status: 200, data: xml });

      await expect(
        engine.execute(baseConfig, baseMapping, { userId: '1' }),
      ).rejects.toThrow('SOAP Fault');
    });

    it.each([
      [
        'a single Text with xml:lang',
        '<env:Reason><env:Text xml:lang="en">Item 7 does not exist</env:Text></env:Reason>',
        'Item 7 does not exist',
      ],
      [
        'one Text per language',
        '<env:Reason><env:Text xml:lang="en">Not found</env:Text><env:Text xml:lang="de">Nicht gefunden</env:Text></env:Reason>',
        'Not found; Nicht gefunden',
      ],
      [
        'a Text without attributes',
        '<env:Reason><env:Text>Plain reason</env:Text></env:Reason>',
        'Plain reason',
      ],
    ])('reads the message of a SOAP 1.2 fault with %s', async (_label, reason, message) => {
      const xml = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
          <env:Body>
            <env:Fault>
              <env:Code><env:Value>env:Sender</env:Value></env:Code>
              ${reason}
            </env:Fault>
          </env:Body>
        </env:Envelope>`;
      mockedAxios.post.mockResolvedValue({ status: 200, data: xml });

      const err: any = await engine
        .execute(baseConfig, baseMapping, { userId: '1' })
        .catch((e) => e);
      expect(err.message).toBe(`SOAP Fault: ${message}`);
      expect(err.message).not.toContain('[object Object]');
    });

    it('reads a SOAP 1.1 faultstring that carries an xml:lang attribute', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring xml:lang="en-US">Invalid itemId</faultstring></s:Fault></s:Body></s:Envelope>',
      });

      await expect(
        engine.execute(baseConfig, baseMapping, { userId: '1' }),
      ).rejects.toThrow(/^SOAP Fault: Invalid itemId$/);
    });

    it('should return non-string data as-is', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { raw: 'object' },
      });

      const result = await engine.execute(baseConfig, baseMapping, { userId: '1' });
      expect(result).toEqual({ raw: 'object' });
    });
  });

  describe('auth injection', () => {
    it('should inject Basic auth header', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        {
          ...baseConfig,
          authType: 'BASIC_AUTH',
          authConfig: { username: 'user', password: 'pass' },
        },
        baseMapping,
        { userId: '1' },
      );

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
      const decoded = Buffer.from(
        headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString();
      expect(decoded).toBe('user:pass');
    });

    it('should inject Bearer token header', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        {
          ...baseConfig,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'my-token' },
        },
        baseMapping,
        { userId: '1' },
      );

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer my-token');
    });

    it('should inject API key header', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        {
          ...baseConfig,
          authType: 'API_KEY',
          authConfig: { headerName: 'X-Key', apiKey: 'sk-123' },
        },
        baseMapping,
        { userId: '1' },
      );

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers['X-Key']).toBe('sk-123');
    });
  });

  describe('WS-Security UsernameToken', () => {
    const PROFILE =
      'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
    const wsConfig = (authConfig: Record<string, unknown>) => ({
      ...baseConfig,
      authType: 'WS_SECURITY',
      authConfig,
    });
    const okResponse = {
      status: 200,
      data: '<Envelope><Body><Resp/></Body></Envelope>',
    };

    beforeEach(() => {
      engine = new FixedClockSoapEngine();
    });

    it('sends a PasswordText UsernameToken in the SOAP header', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);

      await engine.execute(
        wsConfig({ username: 'ws-user', password: 'p&ss<word>' }),
        baseMapping,
        { userId: '1' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain(`  <soapenv:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" soapenv:mustUnderstand="1">
      <wsse:UsernameToken>
        <wsse:Username>ws-user</wsse:Username>
        <wsse:Password Type="${PROFILE}#PasswordText">p&amp;ss&lt;word&gt;</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>`);
      expect(envelope).not.toContain('<wsse:Nonce');
      // No HTTP auth header: the credentials travel in the envelope only.
      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('adds Nonce and Created to PasswordText when includeNonce is set', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);

      await engine.execute(
        wsConfig({ username: 'ws-user', password: 'secret', includeNonce: true }),
        baseMapping,
        { userId: '1' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain(`#PasswordText">secret</wsse:Password>`);
      expect(envelope).toContain(`>${FIXED_NONCE.toString('base64')}</wsse:Nonce>`);
      expect(envelope).toContain('<wsu:Created>2026-10-08T07:00:00Z</wsu:Created>');
    });

    it('sends a PasswordDigest computed from the nonce, the created time and the password', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);
      const password = 'S3cr3t!pass';
      const created = '2026-10-08T07:00:00Z';

      await engine.execute(
        wsConfig({ username: 'ws-user', password, passwordType: 'PasswordDigest' }),
        baseMapping,
        { userId: '1' },
      );

      // Base64(SHA1(nonceBytes + created + password)), computed here on its own
      // and checked against a value computed once outside the code under test.
      const expected = createHash('sha1')
        .update(Buffer.concat([FIXED_NONCE, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
        .digest('base64');
      expect(expected).toBe('euMhlB+cBX2QSvgw9Sfr2BcXv7I=');

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain(`      <wsse:UsernameToken>
        <wsse:Username>ws-user</wsse:Username>
        <wsse:Password Type="${PROFILE}#PasswordDigest">euMhlB+cBX2QSvgw9Sfr2BcXv7I=</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">AAECAwQFBgcICQoLDA0ODw==</wsse:Nonce>
        <wsu:Created>2026-10-08T07:00:00Z</wsu:Created>
      </wsse:UsernameToken>`);
      expect(envelope).not.toContain(password);
    });

    it('adds a five-minute wsu:Timestamp when includeTimestamp is set', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);

      await engine.execute(
        wsConfig({ username: 'u', password: 'p', includeTimestamp: true }),
        baseMapping,
        { userId: '1' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain(`      <wsu:Timestamp>
        <wsu:Created>2026-10-08T07:00:00Z</wsu:Created>
        <wsu:Expires>2026-10-08T07:05:00Z</wsu:Expires>
      </wsu:Timestamp>
      <wsse:UsernameToken>`);
    });

    it('refuses to call without a username and password', async () => {
      await expect(
        engine.execute(wsConfig({ username: 'u' }), baseMapping, { userId: '1' }),
      ).rejects.toThrow('WS-Security needs a username and a password');
      await expect(
        engine.execute(
          wsConfig({ username: 'u', password: 'p', passwordType: 'PasswordHash' }),
          baseMapping,
          { userId: '1' },
        ),
      ).rejects.toThrow('Unsupported WS-Security passwordType "PasswordHash"');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('keeps the empty header for other auth types', async () => {
      mockedAxios.post.mockResolvedValue(okResponse);

      await engine.execute(
        { ...baseConfig, authType: 'BASIC_AUTH', authConfig: { username: 'u', password: 'p' } },
        baseMapping,
        { userId: '1' },
      );

      const envelope = mockedAxios.post.mock.calls[0][1] as string;
      expect(envelope).toContain('  <soapenv:Header/>\n  <soapenv:Body>');
      expect(envelope).not.toContain('wsse');
    });

    describe.each([
      ['PasswordText', {}],
      ['PasswordDigest', { passwordType: 'PasswordDigest' }],
    ])('with %s, the credentials never leave the engine', (_type, extra) => {
      const password = 'Sup3r-S3cret-Value';
      const digest = createHash('sha1')
        .update(
          Buffer.concat([
            FIXED_NONCE,
            Buffer.from('2026-10-08T07:00:00Z', 'utf8'),
            Buffer.from(password, 'utf8'),
          ]),
        )
        .digest('base64');
      const secrets = [password, digest, FIXED_NONCE.toString('base64')];
      let logged: string[];

      beforeEach(() => {
        logged = [];
        for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation((...args: unknown[]) => {
              logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
            });
        }
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      const expectNoSecrets = (text: string) => {
        for (const secret of secrets) expect(text).not.toContain(secret);
      };

      async function failingCall(): Promise<any> {
        const err = await engine
          .execute(
            wsConfig({ username: 'ws-user', password, ...extra }),
            // No soapAction: the engine also goes through the WSDL path and logs.
            { ...baseMapping, soapAction: undefined },
            { userId: '1' },
          )
          .catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        // The real request did carry the token.
        const sent = mockedAxios.post.mock.calls[0][1] as string;
        expect(sent).toContain('<wsse:UsernameToken>');
        return err;
      }

      it('on an HTTP error that echoes the request', async () => {
        mockedAxios.post.mockImplementation(async (_url, body) => ({
          status: 500,
          statusText: 'Internal Server Error',
          // A server that echoes the received message in its fault.
          data: `<s:Envelope><s:Body><s:Fault><faultstring>Bad request</faultstring><detail>${String(body).replace('<soapenv:Header>', '<soapenv:Header >')}</detail></s:Fault></s:Body></s:Envelope>`,
        }));

        const err = await failingCall();
        expect(err.soapDetail.requestBody).toContain(
          '<wsse:Security><!-- redacted --></wsse:Security>',
        );
        expect(err.soapDetail.requestBody).toContain('<tns:userId>1</tns:userId>');
        expectNoSecrets(JSON.stringify(err.soapDetail));
        expectNoSecrets(err.message);
        expectNoSecrets(logged.join('\n'));
      });

      it('on a network error', async () => {
        mockedAxios.post.mockRejectedValue(
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );

        const err = await failingCall();
        expect(err.soapDetail.requestBody).toContain(
          '<wsse:Security><!-- redacted --></wsse:Security>',
        );
        expectNoSecrets(JSON.stringify(err.soapDetail));
        expectNoSecrets(err.message);
        expectNoSecrets(logged.join('\n'));
      });

      it('on a SOAP fault in a 200 response', async () => {
        mockedAxios.post.mockResolvedValue({
          status: 200,
          data: '<Envelope><Body><Fault><faultstring>Denied</faultstring></Fault></Body></Envelope>',
        });

        const err = await failingCall();
        expect(err.message).toContain('Denied');
        expectNoSecrets(JSON.stringify(err.soapDetail));
        expectNoSecrets(logged.join('\n'));
      });
    });
  });

  describe('endpoint host override', () => {
    it('should replace WSDL endpoint host with connector baseUrl host', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(
        { baseUrl: 'http://internal.local:8080/service', authType: 'NONE' },
        {
          ...baseMapping,
          endpoint: 'http://external.public:9090/service',
        },
        { userId: '1' },
      );

      const calledUrl = mockedAxios.post.mock.calls[0][0];
      expect(calledUrl).toContain('internal.local:8080');
      expect(calledUrl).not.toContain('external.public');
    });
  });

  describe('HTTP error handling', () => {
    it('should throw enriched error for HTTP 500 status', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        data: 'Server error body',
      });

      await expect(
        engine.execute(baseConfig, baseMapping, { userId: '1' }),
      ).rejects.toThrow('SOAP call failed with HTTP 500');
    });

    it('names the SOAP fault returned with HTTP 500', async () => {
      const data =
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>a:ActionNotSupported</faultcode><faultstring xml:lang="en-US">The message with Action \'\' cannot be processed</faultstring></s:Fault></s:Body></s:Envelope>';
      mockedAxios.post.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        data,
      });

      const err: any = await engine
        .execute(baseConfig, baseMapping, { userId: '1' })
        .catch((e) => e);
      expect(err.message).toBe(
        "SOAP call failed with HTTP 500: The message with Action '' cannot be processed",
      );
      expect(err.soapDetail).toMatchObject({ status: 500, responseBody: data });
    });
  });

  describe('WSDL metadata cache', () => {
    const mockedCreateClient = soap.createClientAsync as jest.Mock;
    const fakeClient = {
      wsdl: {
        definitions: {
          $targetNamespace: 'http://tempuri.org/',
          services: {
            UserService: {
              ports: {
                BasicHttpBinding_IService: {
                  location: 'http://example.com/service',
                  binding: {
                    methods: {
                      GetUser: {
                        style: 'document',
                        soapAction: '',
                        input: { name: 'element', $name: 'GetUser', targetNamespace: 'http://tempuri.org/' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      describe: () => ({
        UserService: {
          BasicHttpBinding_IService: { GetUser: { input: { userId: 's:string' } } },
        },
      }),
    };
    // A document/literal tool whose soapAction is legitimately empty: it
    // reads the WSDL on every call.
    const mapping = { ...baseMapping, soapAction: undefined };
    const wsdlConfig = {
      ...baseConfig,
      specUrl: 'https://user:pw@example.com/service?wsdl&token=s3cret',
    };

    class ManualClockSoapEngine extends SoapEngine {
      now = Date.parse('2026-10-08T07:00:00Z');
      protected currentTime(): Date {
        return new Date(this.now);
      }
    }
    let clocked: ManualClockSoapEngine;

    beforeEach(() => {
      clocked = new ManualClockSoapEngine();
      mockedCreateClient.mockReset();
      mockedCreateClient.mockResolvedValue(fakeClient);
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });
    });

    it('reads the WSDL once for repeated calls, without the soap library cache', async () => {
      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      await clocked.execute(wsdlConfig, mapping, { userId: '2' });

      expect(mockedCreateClient).toHaveBeenCalledTimes(1);
      expect(mockedCreateClient).toHaveBeenCalledWith(
        wsdlConfig.specUrl,
        expect.objectContaining({ disableCache: true }),
      );
      const envelope = mockedAxios.post.mock.calls[1][1] as string;
      expect(envelope).toContain('<tns:GetUser>');
      expect(envelope).toContain('<tns:userId>2</tns:userId>');
    });

    it('shares one read between concurrent calls', async () => {
      await Promise.all([
        clocked.execute(wsdlConfig, mapping, { userId: '1' }),
        clocked.execute(wsdlConfig, mapping, { userId: '2' }),
      ]);
      expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    });

    it('reads the WSDL again after ten minutes', async () => {
      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      clocked.now += 9 * 60_000;
      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      expect(mockedCreateClient).toHaveBeenCalledTimes(1);

      clocked.now += 60_000;
      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      expect(mockedCreateClient).toHaveBeenCalledTimes(2);
    });

    it('retries a WSDL that could not be read after a minute, not on every call', async () => {
      mockedCreateClient.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));

      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      expect(mockedCreateClient).toHaveBeenCalledTimes(1);

      clocked.now += 60_000;
      await clocked.execute(wsdlConfig, mapping, { userId: '1' });
      expect(mockedCreateClient).toHaveBeenCalledTimes(2);
    });

    it('keeps at most 100 WSDLs, dropping the oldest', async () => {
      for (let i = 0; i <= 100; i++) {
        await clocked.execute({ ...baseConfig, specUrl: `http://example.com/${i}?wsdl` }, mapping, {});
      }
      expect(mockedCreateClient).toHaveBeenCalledTimes(101);

      await clocked.execute({ ...baseConfig, specUrl: 'http://example.com/100?wsdl' }, mapping, {});
      expect(mockedCreateClient).toHaveBeenCalledTimes(101);
      await clocked.execute({ ...baseConfig, specUrl: 'http://example.com/0?wsdl' }, mapping, {});
      expect(mockedCreateClient).toHaveBeenCalledTimes(102);
    });

    it('logs the WSDL URL without credentials or query string', async () => {
      const lines: string[] = [];
      const spies = (['debug', 'warn'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
          lines.push(String(message));
        }),
      );
      mockedCreateClient.mockRejectedValueOnce(new Error('boom'));

      await clocked.execute(wsdlConfig, mapping, { userId: '1' });

      spies.forEach((s) => s.mockRestore());
      const log = lines.join('\n');
      expect(log).toContain('https://example.com/service');
      expect(log).not.toContain('s3cret');
      expect(log).not.toContain('pw@');
    });
  });

  describe('inspectWsdl (connection test)', () => {
    const mockedCreateClient = soap.createClientAsync as jest.Mock;
    const url = 'https://user:pw@example.com/service?wsdl&token=s3cret';

    beforeEach(() => mockedCreateClient.mockReset());

    it('counts operations and ports without calling any operation', async () => {
      mockedCreateClient.mockResolvedValue({
        wsdl: { definitions: { services: {}, bindings: {} } },
        describe: () => ({
          UserService: {
            BasicHttpBinding_IService: { GetUser: {}, SetUser: {} },
            BasicHttpsBinding_IService: { GetUser: {}, SetUser: {} },
          },
        }),
      });

      await expect(engine.inspectWsdl(url)).resolves.toEqual({
        operations: 2,
        ports: 2,
        soap12Ports: 0,
      });
      expect(mockedCreateClient).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ disableCache: true }),
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('reports the HTTP status of a refused WSDL, without the URL or the response body', async () => {
      mockedCreateClient.mockRejectedValue(
        new Error(`Invalid WSDL URL: ${url}\n\n\r Code: 401\n\n\r Response Body: <html>secret page</html>`),
      );

      const err: any = await engine.inspectWsdl(url).catch((e) => e);
      expect(err.name).toBe('WsdlReadError');
      expect(err.status).toBe(401);
      expect(err.message).toBe('The WSDL request returned HTTP 401');
    });

    it('keeps network error codes and strips credentials from other messages', async () => {
      mockedCreateClient.mockRejectedValue(
        Object.assign(new Error(`getaddrinfo ENOTFOUND for ${url}`), { code: 'ENOTFOUND' }),
      );

      const err: any = await engine.inspectWsdl(url).catch((e) => e);
      expect(err.code).toBe('ENOTFOUND');
      expect(err.status).toBeUndefined();
      expect(err.message).toBe('getaddrinfo ENOTFOUND for https://example.com/service');
      expect(err.message).not.toMatch(/s3cret|pw@/);
    });

    it.each([
      ['an HTTP status', new Error('Invalid WSDL URL: x\n\n\r Code: 404\n\n\r Response Body: '), true],
      ['a 200 that is not a WSDL', new Error('Root element of WSDL was <html>. This is likely an authentication issue.'), true],
      ['a redirect loop', Object.assign(new Error('Maximum number of redirects exceeded'), { code: 'ERR_FR_TOO_MANY_REDIRECTS' }), true],
      ['DNS', Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' }), false],
      ['a timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }), false],
      ['TLS', Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), false],
      ['the SSRF guard', new SsrfBlockedError("SSRF guard: hostname 'example.com' is blocked"), false],
    ])('tells whether the server answered: %s', async (_label, error, reached) => {
      mockedCreateClient.mockRejectedValue(error);
      const err: any = await engine.inspectWsdl(url).catch((e) => e);
      expect(err.reachedServer).toBe(reached);
    });

    describe('cache', () => {
      class ClockedEngine extends SoapEngine {
        now = Date.parse('2026-10-08T07:00:00Z');
        protected currentTime(): Date {
          return new Date(this.now);
        }
      }
      const client = {
        wsdl: {
          definitions: {
            $targetNamespace: 'http://tempuri.org/',
            services: { S: { ports: { P: { location: 'http://example.com/service', binding: { methods: {} } } } } },
            bindings: {},
          },
        },
        describe: () => ({ S: { P: { GetUser: { input: { userId: 's:string' } } } } }),
      };

      it('reads a WSDL once for repeated tests within ten minutes, and again after', async () => {
        const clocked = new ClockedEngine();
        mockedCreateClient.mockResolvedValue(client);

        await clocked.inspectWsdl(url);
        await clocked.inspectWsdl(url);
        expect(mockedCreateClient).toHaveBeenCalledTimes(1);

        clocked.now += 10 * 60_000;
        await clocked.inspectWsdl(url);
        expect(mockedCreateClient).toHaveBeenCalledTimes(2);
      });

      it('shares the read with tool calls, both ways', async () => {
        const clocked = new ClockedEngine();
        mockedCreateClient.mockResolvedValue(client);
        mockedAxios.post.mockResolvedValue({ status: 200, data: '<Envelope><Body><R/></Body></Envelope>' });

        await clocked.inspectWsdl(url);
        await clocked.execute(
          { ...baseConfig, specUrl: url },
          { method: 'GetUser', path: 'P', paramOrder: ['userId'] },
          { userId: '1' },
        );
        expect(mockedCreateClient).toHaveBeenCalledTimes(1);

        const other = new ClockedEngine();
        await other.execute(
          { ...baseConfig, specUrl: url },
          { method: 'GetUser', path: 'P', paramOrder: ['userId'] },
          { userId: '1' },
        );
        await other.inspectWsdl(url);
        expect(mockedCreateClient).toHaveBeenCalledTimes(2);
      });

      it('tries a WSDL that could not be read again on the next test', async () => {
        const clocked = new ClockedEngine();
        mockedCreateClient.mockRejectedValueOnce(new Error('Root element of WSDL was <html>.'));
        mockedCreateClient.mockResolvedValueOnce(client);

        await expect(clocked.inspectWsdl(url)).rejects.toThrow('Root element');
        await expect(clocked.inspectWsdl(url)).resolves.toMatchObject({ operations: 1, ports: 1 });
      });
    });

    it('logs a failed metadata read without the query string or the response body', async () => {
      const lines: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
      mockedCreateClient.mockRejectedValue(
        new Error(`Invalid WSDL URL: ${url}\n\n\r Code: 404\n\n\r Response Body: secret-body`),
      );
      mockedAxios.post.mockResolvedValue({ status: 200, data: '<Envelope><Body><R/></Body></Envelope>' });

      await engine.execute({ ...baseConfig, specUrl: url }, { ...baseMapping, soapAction: undefined }, { userId: '1' });

      spy.mockRestore();
      expect(lines.join('\n')).toContain('https://example.com/service: The WSDL request returned HTTP 404');
      expect(lines.join('\n')).not.toMatch(/s3cret|pw@|secret-body/);
    });
  });

  describe('SOAPAction and Content-Type headers', () => {
    it('should set correct headers for SOAP call', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(baseConfig, baseMapping, { userId: '1' });

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('text/xml; charset=utf-8');
      expect(headers.SOAPAction).toBe('http://tempuri.org/IService/GetUser');
    });

    it('sends an empty SOAPAction as "" (SOAP 1.1 requires the header)', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });
      // No soapAction stored and none in the WSDL (it cannot be read here).
      (soap.createClientAsync as jest.Mock).mockRejectedValueOnce(new Error('offline'));

      await engine.execute(
        { ...baseConfig, specUrl: 'http://example.com/empty-action?wsdl' },
        { ...baseMapping, soapAction: '' },
        { userId: '1' },
      );

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers.SOAPAction).toBe('""');
      expect(headers['Content-Type']).toBe('text/xml; charset=utf-8');
    });

    it('keeps a non-empty SOAPAction unquoted', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: '<Envelope><Body><Resp/></Body></Envelope>',
      });

      await engine.execute(baseConfig, { ...baseMapping, soapAction: 'urn:GetUser' }, { userId: '1' });

      const headers = mockedAxios.post.mock.calls[0][2]?.headers as Record<string, string>;
      expect(headers.SOAPAction).toBe('urn:GetUser');
    });
  });
});
