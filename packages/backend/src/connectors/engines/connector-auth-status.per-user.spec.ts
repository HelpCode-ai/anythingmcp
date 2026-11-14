import { ConnectorAuthStatusService } from './connector-auth-status.service';
import { userCredentialKey } from '../../common/credential-key.util';

/**
 * The status of a user's own sign-in lives on that user's credential row and
 * concerns that user only: the connector stays untouched, and the email goes
 * to the user whose sign-in needs renewing, not to the workspace owner.
 */
function setup() {
  let row: Record<string, unknown> = {
    authStatus: null,
    authStatusCode: null,
    authStatusRef: null,
    authStatusMessage: null,
    authNotifiedAt: null,
  };
  const userConnectorCredential = {
    findFirst: jest.fn(async ({ select }: any) =>
      select.user
        ? {
            authStatusMessage: row.authStatusMessage,
            organizationId: 'org-1',
            connector: { name: 'MFR' },
            user: { email: 'tech@example.com', name: 'Tech' },
          }
        : row,
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (where.authNotifiedAt === null && row.authNotifiedAt !== null) return { count: 0 };
      row = { ...row, ...data };
      return { count: 1 };
    }),
  };
  const connector = {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const organizationMember = { findFirst: jest.fn() };
  const email = { sendConnectorAuthEmail: jest.fn(async () => undefined) };
  const svc = new ConnectorAuthStatusService(
    { userConnectorCredential, connector, organizationMember } as any,
    email as any,
  );
  return { svc, userConnectorCredential, connector, organizationMember, email, row: () => row };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ConnectorAuthStatusService with a user credential key', () => {
  const key = userCredentialKey('conn-1', 'user-1');
  const issue = { status: 'needs_reauth' as const, code: 'refresh_refused', message: 'Sign in again.', ref: 'r1' };

  it("records on the user's row and leaves the connector alone", async () => {
    const s = setup();
    await s.svc.mark(key, issue);
    expect(s.row().authStatus).toBe('needs_reauth');
    expect(s.userConnectorCredential.updateMany.mock.calls[0][0].where).toEqual({
      connectorId: 'conn-1',
      userId: 'user-1',
    });
    expect(s.connector.update).not.toHaveBeenCalled();
    expect(s.connector.updateMany).not.toHaveBeenCalled();
  });

  it('emails the user once, never the workspace owner', async () => {
    const s = setup();
    await s.svc.mark(key, issue);
    await flush();
    await s.svc.mark(key, issue);
    await flush();
    expect(s.email.sendConnectorAuthEmail).toHaveBeenCalledTimes(1);
    expect((s.email.sendConnectorAuthEmail.mock.calls[0] as unknown[])[0]).toBe('tech@example.com');
    // To the page where that user signs in again, not the dashboard.
    expect((s.email.sendConnectorAuthEmail.mock.calls[0] as unknown[])[1]).toMatchObject({
      connectorPath: expect.stringMatching(/^\/auth\/connect\//),
    });
    expect(s.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it("clears the user's status only", async () => {
    const s = setup();
    await s.svc.mark(key, issue);
    await s.svc.clear(key);
    expect(s.row().authStatus).toBeNull();
    expect(s.connector.updateMany).not.toHaveBeenCalled();
  });

  it("reads the user's status", async () => {
    const s = setup();
    await s.svc.mark(key, issue);
    expect(await s.svc.get(key)).toEqual(
      expect.objectContaining({ status: 'needs_reauth', code: 'refresh_refused' }),
    );
    expect(s.connector.findUnique).not.toHaveBeenCalled();
  });
});
