import { ConnectorsService } from './connectors.service';
import { WsdlReadError } from './engines/soap.engine';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * Test connection of a SOAP connector reads its WSDL (and nothing else): no
 * operation is called, since any of them may change data.
 */
describe('ConnectorsService.testConnection for SOAP connectors', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const password = 'Sup3r-S3cret-Pass';
  const row = {
    id: 'conn-soap',
    name: 'ERP SOAP',
    type: 'SOAP',
    baseUrl: 'https://erp.example.com/Service.svc',
    specUrl: 'https://erp.example.com/Service.svc?wsdl&token=t0ken',
    authType: 'WS_SECURITY',
    authConfig: encrypt(JSON.stringify({ username: 'ws-user', password }), KEY),
    headers: null,
    envVars: null,
    healthcheckPath: null,
    tools: [],
  };

  let prisma: any;
  let soapEngine: { inspectWsdl: jest.Mock; execute: jest.Mock };
  let service: ConnectorsService;

  beforeEach(() => {
    prisma = { connector: { findUnique: jest.fn().mockResolvedValue(row) } };
    soapEngine = {
      inspectWsdl: jest.fn().mockResolvedValue({ operations: 12, ports: 2, soap12Ports: 1 }),
      execute: jest.fn(),
    };
    service = new ConnectorsService(
      prisma,
      { get: () => KEY } as any,
      {} as any,
      soapEngine as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  const noSecrets = (result: unknown) => {
    const text = JSON.stringify(result);
    expect(text).not.toContain(password);
    expect(text).not.toContain('t0ken');
  };

  it('reads the WSDL, reports what it declares and says the credentials were not checked', async () => {
    const result = await service.testConnection('conn-soap');

    expect(soapEngine.inspectWsdl).toHaveBeenCalledWith(row.specUrl);
    expect(soapEngine.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      kind: 'ok',
      message:
        'WSDL read: 12 operations on 2 ports, 1 of them SOAP 1.2. No operation was called, ' +
        'so the credentials (HTTP Basic, WS-Security, …) were not checked.',
    });
  });

  it('reads the WSDL from the base URL when there is no specUrl', async () => {
    prisma.connector.findUnique.mockResolvedValue({
      ...row,
      specUrl: null,
      baseUrl: 'https://erp.example.com/Service.svc?singleWsdl',
    });
    await service.testConnection('conn-soap');
    expect(soapEngine.inspectWsdl).toHaveBeenCalledWith('https://erp.example.com/Service.svc?singleWsdl');
  });

  it('fails a WSDL without operations', async () => {
    soapEngine.inspectWsdl.mockResolvedValue({ operations: 0, ports: 0, soap12Ports: 0 });
    await expect(service.testConnection('conn-soap')).resolves.toMatchObject({
      ok: false,
      kind: 'error',
    });
  });

  it.each([
    [401, 'auth_failed', /refused with HTTP 401\. AnythingMCP reads the WSDL without the connector's credentials/],
    [403, 'auth_failed', /refused with HTTP 403/],
    [404, 'not_found', /^No WSDL at https:\/\/erp\.example\.com\/Service\.svc \(HTTP 404\)/],
    [500, 'error', /could not be downloaded: HTTP 500/],
  ])('reports HTTP %i from the WSDL server as %s', async (status, kind, message) => {
    soapEngine.inspectWsdl.mockRejectedValue(
      new WsdlReadError(`The WSDL request returned HTTP ${status}`, status),
    );

    const result = await service.testConnection('conn-soap');

    expect(result).toMatchObject({ ok: false, kind, httpStatus: status });
    expect(result.message).toMatch(message);
    noSecrets(result);
  });

  it('reports a network error as unreachable', async () => {
    soapEngine.inspectWsdl.mockRejectedValue(
      new WsdlReadError('getaddrinfo ENOTFOUND erp.example.com', undefined, 'ENOTFOUND'),
    );
    await expect(service.testConnection('conn-soap')).resolves.toMatchObject({
      ok: false,
      kind: 'unreachable',
    });
  });

  it('reports a document that is not a WSDL as an error naming the URL without its query', async () => {
    soapEngine.inspectWsdl.mockRejectedValue(
      new WsdlReadError('Root element of WSDL was <html>. This is likely an authentication issue.'),
    );

    const result = await service.testConnection('conn-soap');

    expect(result).toEqual({
      ok: false,
      kind: 'error',
      message:
        'The WSDL at https://erp.example.com/Service.svc could not be read: ' +
        'Root element of WSDL was <html>. This is likely an authentication issue.',
    });
    noSecrets(result);
  });
});
