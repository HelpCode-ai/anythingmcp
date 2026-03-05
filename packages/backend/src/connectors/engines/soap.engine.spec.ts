import { SoapEngine } from './soap.engine';
import axios from 'axios';

jest.mock('axios');
jest.mock('soap');

const mockedAxios = axios as jest.Mocked<typeof axios>;

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
