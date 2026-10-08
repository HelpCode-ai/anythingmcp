import { SoapEngine } from './soap.engine';
import axios from 'axios';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';

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
  });
});
