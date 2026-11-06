import { DIRECTORY_SIGNUP_WINDOW_MS, markDirectorySignup } from './directory-signup';
import { parseDirectoryPlugin } from '../auth/resource-indicator.middleware';

const NOW = Date.parse('2026-11-06T05:46:00Z');

function setup(opts: { createdMinutesAgo?: number; already?: number; signup?: Record<string, unknown> | null } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () =>
        opts.createdMinutesAgo === undefined ? null : { createdAt: new Date(NOW - opts.createdMinutesAgo * 60_000) },
      ),
    },
    productEvent: {
      count: jest.fn(async () => opts.already ?? 0),
      findFirst: jest.fn(async () => (opts.signup === null ? null : { id: 'ev-1', metadata: opts.signup ?? { first_channel: 'direct' } })),
      update: jest.fn(async () => ({})),
    },
  };
  const events = { log: jest.fn(async () => undefined) };
  return { prisma, events };
}

describe('markDirectorySignup', () => {
  it('adds the directory to a recent sign-up and records the event once', async () => {
    const { prisma, events } = setup({ createdMinutesAgo: 29 });
    expect(await markDirectorySignup(prisma as any, events as any, 'u1', 'chatgpt-app', NOW)).toBe(true);
    expect(prisma.productEvent.update).toHaveBeenCalledWith({
      where: { id: 'ev-1' },
      data: { metadata: { first_channel: 'direct', directory: 'chatgpt', directory_plugin: 'chatgpt-app' } },
    });
    expect(events.log).toHaveBeenCalledWith({
      event: 'directory_signup',
      userId: 'u1',
      metadata: { directory: 'chatgpt', plugin: 'chatgpt-app' },
    });
  });

  it('leaves the channel untouched', async () => {
    const { prisma, events } = setup({ createdMinutesAgo: 5, signup: { first_channel: 'direct', last_channel: 'direct' } });
    await markDirectorySignup(prisma as any, events as any, 'u1', 'file-search', NOW);
    const data = (prisma.productEvent.update.mock.calls[0] as any)[0].data.metadata;
    expect(data.first_channel).toBe('direct');
    expect(data.last_channel).toBe('direct');
  });

  it('ignores accounts older than the window, unknown users and repeats', async () => {
    const old = setup({ createdMinutesAgo: DIRECTORY_SIGNUP_WINDOW_MS / 60_000 + 1 });
    expect(await markDirectorySignup(old.prisma as any, old.events as any, 'u1', 'chatgpt-app', NOW)).toBe(false);
    const missing = setup({});
    expect(await markDirectorySignup(missing.prisma as any, missing.events as any, 'u1', 'chatgpt-app', NOW)).toBe(false);
    const again = setup({ createdMinutesAgo: 3, already: 1 });
    expect(await markDirectorySignup(again.prisma as any, again.events as any, 'u1', 'chatgpt-app', NOW)).toBe(false);
    for (const s of [old, missing, again]) {
      expect(s.prisma.productEvent.update).not.toHaveBeenCalled();
      expect(s.events.log).not.toHaveBeenCalled();
    }
  });

  it('still records the event when the sign-up has no attribution row, and never throws', async () => {
    const noRow = setup({ createdMinutesAgo: 3, signup: null });
    expect(await markDirectorySignup(noRow.prisma as any, noRow.events as any, 'u1', 'chatgpt-app', NOW)).toBe(true);
    expect(noRow.events.log).toHaveBeenCalled();
    const broken = setup({ createdMinutesAgo: 3 });
    broken.prisma.productEvent.update.mockRejectedValueOnce(new Error('db down'));
    expect(await markDirectorySignup(broken.prisma as any, broken.events as any, 'u1', 'chatgpt-app', NOW)).toBe(false);
  });
});

describe('parseDirectoryPlugin', () => {
  it.each([
    ['https://cloud.anythingmcp.com/mcp/chatgpt-app', 'chatgpt-app'],
    ['https://cloud.anythingmcp.com/mcp/file-search', 'file-search'],
    ['https://cloud.anythingmcp.com/mcp', null],
    ['https://cloud.anythingmcp.com/mcp/cmw4iwbi01cdg01qufsiqg1t7', null],
    ['https://cloud.anythingmcp.com/mcp/chatgpt-app/extra', null],
    ['not a url', null],
  ])('%s → %s', (resource, expected) => {
    expect(parseDirectoryPlugin(resource)).toBe(expected);
  });
});
