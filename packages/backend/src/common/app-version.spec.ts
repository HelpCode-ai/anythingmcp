describe('app-version', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('APP_COMMIT falls back to dev when unset', () => {
    delete process.env.APP_COMMIT;
    delete process.env.SENTRY_RELEASE;
    const mod = require('./app-version');
    expect(mod.APP_COMMIT).toBe('dev');
  });

  it('APP_COMMIT prefers APP_COMMIT over SENTRY_RELEASE', () => {
    process.env.APP_COMMIT = 'abc1234';
    process.env.SENTRY_RELEASE = 'def5678';
    const mod = require('./app-version');
    expect(mod.APP_COMMIT).toBe('abc1234');
  });

  it('APP_COMMIT uses SENTRY_RELEASE when APP_COMMIT is unset', () => {
    delete process.env.APP_COMMIT;
    process.env.SENTRY_RELEASE = 'def5678';
    const mod = require('./app-version');
    expect(mod.APP_COMMIT).toBe('def5678');
  });

  it('APP_BUILD_DATE defaults to null', () => {
    delete process.env.APP_BUILD_DATE;
    const mod = require('./app-version');
    expect(mod.APP_BUILD_DATE).toBeNull();
  });

  it('APP_BUILD_DATE reads from env', () => {
    process.env.APP_BUILD_DATE = '2026-10-10T12:00:00Z';
    const mod = require('./app-version');
    expect(mod.APP_BUILD_DATE).toBe('2026-10-10T12:00:00Z');
  });

  it('APP_VERSION is a non-empty string', () => {
    const mod = require('./app-version');
    expect(mod.APP_VERSION).toBeTruthy();
    expect(typeof mod.APP_VERSION).toBe('string');
  });
});
