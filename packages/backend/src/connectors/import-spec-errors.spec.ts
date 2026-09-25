import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { UnprocessableEntityException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { WsdlParser } from './parsers/wsdl.parser';

/**
 * POST /api/connectors/:id/import-spec with a WSDL URL that answers with an
 * HTML page — the case behind ANYTHINGMCP-CLOUD-BACKEND-3. Uses the real WSDL
 * parser (and the real `soap` library) against a local HTTP server, so the
 * error mapped is the one production saw.
 */
describe('import-spec: an unreadable specification is a 422, not a 500', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><form action="/login">Sign in</form></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function controllerFor(connector: Record<string, unknown>) {
    const connectorsService = { findById: jest.fn().mockResolvedValue(connector) };
    return new ConnectorsController(
      connectorsService as any,
      {} as any, // openApiParser
      new WsdlParser(),
      {} as any, // graphqlParser
      {} as any, // postmanParser
      {} as any, // curlParser
      {} as any, // mcpClientEngine
      {} as any, // mcpOAuthService
      {} as any, // catalogResync
      {} as any, // prisma
      {} as any, // mcpServer
      { get: jest.fn().mockReturnValue('a'.repeat(48)) } as any,
      {} as any, // licenseGuard
      {} as any, // mcpServers
      { isCloud: () => true } as any,
    );
  }

  it('answers 422 with a reason the user can act on', async () => {
    const controller = controllerFor({
      id: 'c1',
      type: 'SOAP',
      organizationId: 'org1',
      userId: 'u1',
      specUrl: `${base}/service?wsdl&token=secret`,
      baseUrl: base,
    });
    const req = { user: { sub: 'u1', organizationId: 'org1', role: 'ADMIN' } };

    const run = controller.importSpec(req, 'c1');
    await expect(run).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(run).rejects.toThrow(
      /Could not read the WSDL: the URL returned an HTML page instead of a WSDL document/,
    );
    await expect(run).rejects.not.toThrow(/secret/);
  });
});
