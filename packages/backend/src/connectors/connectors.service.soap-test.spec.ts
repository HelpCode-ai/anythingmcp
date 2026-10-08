import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController } from './connectors.controller';
import { SoapEngine, WsdlReadError } from './engines/soap.engine';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * Test connection of a SOAP connector reads its WSDL (and nothing else): no
 * operation is called, since any of them may change data. It also feeds the
 * health check, which only looks at `ok`, so it is lenient: a service that
 * answers over HTTP below 500 is ok even when no WSDL can be read at the
 * address (many connectors have the service address as base URL and work
 * without a WSDL); only an unreachable service or a server error is not.
 */
describe('ConnectorsService.testConnection for SOAP connectors', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const password = 'Sup3r-S3cret-Pass';
  const row = {
    id: 'conn-soap',
    name: 'ERP SOAP',
    type: 'SOAP',
    baseUrl: 'https://erp.example.com/Service.svc',
    specUrl: null as string | null,
    authType: 'WS_SECURITY',
    authConfig: encrypt(JSON.stringify({ username: 'ws-user', password }), KEY),
    headers: null,
    envVars: null,
    healthcheckPath: null,
    tools: [],
  };
  const notChecked =
    'No operation was called, so the credentials (HTTP Basic, WS-Security, ...) were not checked.';
  const summary = { operations: 12, ports: 2, soap12Ports: 1 };

  /** A 200 that is not a WSDL: what node-soap reports for an HTML page. */
  const notAWsdl = () =>
    new WsdlReadError('Root element of WSDL was <html>. This is likely an authentication issue.', undefined, true);
  const httpError = (status: number) =>
    new WsdlReadError(`The WSDL request returned HTTP ${status}`, status, true);
  const networkError = (code: string, message: string) =>
    new WsdlReadError(message, undefined, false, code);

  let prisma: any;
  let soapEngine: { inspectWsdl: jest.Mock; execute: jest.Mock };
  let service: ConnectorsService;

  beforeEach(() => {
    prisma = { connector: { findUnique: jest.fn().mockResolvedValue(row) } };
    soapEngine = { inspectWsdl: jest.fn().mockResolvedValue(summary), execute: jest.fn() };
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

  const withSpecUrl = (specUrl: string) =>
    prisma.connector.findUnique.mockResolvedValue({ ...row, specUrl });

  const noSecrets = (result: unknown) => {
    const text = JSON.stringify(result);
    expect(text).not.toContain(password);
    expect(text).not.toContain('t0ken');
  };

  describe('the WSDL is read', () => {
    it('from specUrl: reports what it declares and that the credentials were not checked', async () => {
      withSpecUrl('https://erp.example.com/Service.svc?wsdl&token=t0ken');

      const result = await service.testConnection('conn-soap');

      expect(soapEngine.inspectWsdl.mock.calls).toEqual([
        ['https://erp.example.com/Service.svc?wsdl&token=t0ken'],
      ]);
      expect(soapEngine.execute).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        kind: 'ok',
        message: `WSDL read: 12 operations on 2 ports, 1 of them SOAP 1.2. ${notChecked}`,
      });
      noSecrets(result);
    });

    it('from the base URL with ?wsdl when the base URL is the service address', async () => {
      soapEngine.inspectWsdl.mockRejectedValueOnce(notAWsdl()).mockResolvedValueOnce(summary);

      const result = await service.testConnection('conn-soap');

      expect(soapEngine.inspectWsdl.mock.calls).toEqual([
        ['https://erp.example.com/Service.svc'],
        ['https://erp.example.com/Service.svc?wsdl'],
      ]);
      expect(result).toMatchObject({ ok: true, kind: 'ok' });
      expect(result.message).toContain("The WSDL was found at the base URL with ?wsdl: set it as the connector's WSDL URL");
    });

    it('reports a WSDL without operations as reachable', async () => {
      soapEngine.inspectWsdl.mockResolvedValue({ operations: 0, ports: 0, soap12Ports: 0 });
      await expect(service.testConnection('conn-soap')).resolves.toMatchObject({ ok: true, kind: 'ok' });
    });
  });

  it('does not add ?wsdl to a base URL that has a query string, nor to specUrl', async () => {
    prisma.connector.findUnique.mockResolvedValue({
      ...row,
      baseUrl: 'https://erp.example.com/Service.svc?singleWsdl',
    });
    soapEngine.inspectWsdl.mockRejectedValue(httpError(404));
    await service.testConnection('conn-soap');
    expect(soapEngine.inspectWsdl).toHaveBeenCalledTimes(1);

    soapEngine.inspectWsdl.mockClear();
    withSpecUrl('https://erp.example.com/wsdl/service.wsdl');
    await service.testConnection('conn-soap');
    expect(soapEngine.inspectWsdl.mock.calls).toEqual([['https://erp.example.com/wsdl/service.wsdl']]);
  });

  describe('the service answers, but no WSDL can be read: ok (healthy)', () => {
    it.each([404, 405, 400])('HTTP %i', async (status) => {
      soapEngine.inspectWsdl.mockRejectedValue(httpError(status));

      const result = await service.testConnection('conn-soap');

      expect(soapEngine.inspectWsdl).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        ok: true,
        kind: 'ok',
        httpStatus: status,
        message:
          `The service at https://erp.example.com/Service.svc answered with HTTP ${status}, ` +
          "but no WSDL could be read there (also with ?wsdl). Set the connector's WSDL URL to " +
          `import or refresh tools. ${notChecked}`,
      });
    });

    it('a 200 that is not a WSDL', async () => {
      soapEngine.inspectWsdl.mockRejectedValue(notAWsdl());

      const result = await service.testConnection('conn-soap');

      expect(result).toMatchObject({ ok: true, kind: 'ok' });
      expect(result).not.toHaveProperty('httpStatus');
      expect(result.message).toContain('answered with a document that is not a WSDL (Root element of WSDL was <html>');
    });

    it.each([401, 403])('HTTP %i: says the WSDL cannot be downloaded with credentials', async (status) => {
      soapEngine.inspectWsdl.mockRejectedValue(httpError(status));

      const result = await service.testConnection('conn-soap');

      expect(result).toEqual({
        ok: true,
        kind: 'ok',
        httpStatus: status,
        message:
          `The service at https://erp.example.com/Service.svc answered, but refused the WSDL download ` +
          `with HTTP ${status} (also with ?wsdl). AnythingMCP reads the WSDL without the connector's ` +
          `credentials; a WSDL that requires them cannot be downloaded. ${notChecked}`,
      });
      noSecrets(result);
    });

    it('a configured WSDL URL that is not found: asks to check it, without its query string', async () => {
      withSpecUrl('https://erp.example.com/Service.svc?wsdl&token=t0ken');
      soapEngine.inspectWsdl.mockRejectedValue(httpError(404));

      const result = await service.testConnection('conn-soap');

      expect(result).toMatchObject({ ok: true, httpStatus: 404 });
      expect(result.message).toContain("Check the connector's WSDL URL");
      noSecrets(result);
    });

    it('the address answers 500 to a plain GET but 404 with ?wsdl', async () => {
      soapEngine.inspectWsdl.mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(httpError(404));
      await expect(service.testConnection('conn-soap')).resolves.toMatchObject({ ok: true, httpStatus: 404 });
    });
  });

  describe('the service cannot be reached or fails: not ok (unhealthy)', () => {
    it.each([
      ['DNS', 'ENOTFOUND', 'getaddrinfo ENOTFOUND erp.example.com', 'unreachable'],
      ['a refused connection', 'ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:443', 'unreachable'],
      ['a timeout', 'ECONNABORTED', 'timeout of 30000ms exceeded', 'unreachable'],
      ['TLS', 'CERT_HAS_EXPIRED', 'certificate has expired', 'error'],
    ])('%s', async (_label, code, message, kind) => {
      soapEngine.inspectWsdl.mockRejectedValue(networkError(code, message));

      const result = await service.testConnection('conn-soap');

      // ?wsdl is not tried against a host that cannot be reached.
      expect(soapEngine.inspectWsdl).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: false,
        kind,
        message: `The service at https://erp.example.com/Service.svc could not be reached: ${message}`,
      });
    });

    it('a host the SSRF guard blocks', async () => {
      soapEngine.inspectWsdl.mockRejectedValue(
        new WsdlReadError("SSRF guard: hostname 'erp.example.com' resolves to a private address", undefined, false),
      );
      await expect(service.testConnection('conn-soap')).resolves.toMatchObject({
        ok: false,
        kind: 'unreachable',
      });
    });

    it.each([500, 502, 503])('HTTP %i, also with ?wsdl', async (status) => {
      soapEngine.inspectWsdl.mockRejectedValue(httpError(status));

      const result = await service.testConnection('conn-soap');

      expect(soapEngine.inspectWsdl).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        ok: false,
        kind: 'error',
        httpStatus: status,
        message: `The service at https://erp.example.com/Service.svc answered with HTTP ${status}: a server error. No WSDL could be read.`,
      });
    });
  });

  /**
   * End to end, against a real HTTP server: the health check only looks at
   * `ok`, so this is what decides healthy or unhealthy on the dashboard.
   */
  describe('health check', () => {
    const wsdl = fs.readFileSync(
      path.join(__dirname, 'parsers', '__fixtures__', 'wsdl', 'soap12-only.wsdl'),
      'utf8',
    );
    let server: http.Server;
    let base: string;
    let closedPort: string;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/wcf/Service.svc') {
          if (url.search === '?wsdl') {
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(wsdl);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>You have created a service.</body></html>');
          }
        } else if (url.pathname === '/no-wsdl/endpoint') {
          res.writeHead(405);
          res.end('Method Not Allowed: secret-body-text');
        } else if (url.pathname === '/protected/Service.svc') {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic' });
          res.end();
        } else {
          res.writeHead(503);
          res.end('down: secret-body-text');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const spare = http.createServer();
      await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
      closedPort = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
      await new Promise<void>((resolve) => spare.close(() => resolve()));
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('is healthy whenever the service answers below 500, unhealthy otherwise', async () => {
      const connectors = [
        { ...row, id: 'wcf', baseUrl: `${base}/wcf/Service.svc` },
        { ...row, id: 'no-wsdl', baseUrl: `${base}/no-wsdl/endpoint` },
        { ...row, id: 'protected', baseUrl: `${base}/protected/Service.svc` },
        { ...row, id: 'down', baseUrl: `${base}/down` },
        { ...row, id: 'closed', baseUrl: `${closedPort}/Service.svc` },
      ].map((c) => ({ ...c, name: c.id, isActive: true }));
      const prismaRows = {
        connector: {
          findMany: jest.fn().mockResolvedValue(connectors),
          findUnique: jest.fn(({ where }) => Promise.resolve(connectors.find((c) => c.id === where.id))),
        },
      };
      const realService = new ConnectorsService(
        prismaRows as any,
        { get: () => KEY } as any,
        {} as any,
        new SoapEngine(),
        {} as any,
        {} as any,
        {} as any,
      );
      const controller = new ConnectorsController(
        realService,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { get: () => KEY } as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const health = await controller.healthCheck({ user: { organizationId: 'org-1' } });

      const status = Object.fromEntries(
        health.connectors.map((c: any) => [c.id, c.status]),
      );
      expect(status).toEqual({
        wcf: 'healthy',
        'no-wsdl': 'healthy',
        protected: 'healthy',
        down: 'unhealthy',
        closed: 'unhealthy',
      });
      expect(health).toMatchObject({ total: 5, healthy: 3, unhealthy: 2 });
      const byId = Object.fromEntries(health.connectors.map((c: any) => [c.id, c.message]));
      expect(byId.wcf).toMatch(/^WSDL read: 1 operation on 1 port, 1 of them SOAP 1\.2\. The WSDL was found at the base URL with \?wsdl/);
      expect(byId['no-wsdl']).toContain('answered with HTTP 405');
      expect(byId.protected).toContain('refused the WSDL download with HTTP 401');
      expect(JSON.stringify(health)).not.toContain('secret-body-text');
    });
  });
});
