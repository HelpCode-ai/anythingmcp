import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_BUILD_DATE,
  APP_COMMIT,
  APP_VERSION,
  formatVersionLogLine,
  readAppBuildDate,
  readAppCommit,
  readAppVersion,
  shortCommit,
} from './app-version';

const FULL_SHA = '3bd9f8b0a1c2d3e4f567890abcdef1234567890a';

describe('app-version', () => {
  it('reads the backend package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(readAppVersion()).toBe(pkg.version);
  });

  it('falls back to 0.0.0 when no package.json is found', () => {
    expect(readAppVersion('/definitely-missing-amcp/a/b')).toBe('0.0.0');
  });

  describe('readAppCommit', () => {
    it('falls back to dev when unset', () => {
      expect(readAppCommit({})).toBe('dev');
    });

    it('prefers APP_COMMIT over SENTRY_RELEASE', () => {
      expect(readAppCommit({ APP_COMMIT: FULL_SHA, SENTRY_RELEASE: 'other' })).toBe(FULL_SHA);
    });

    it('uses SENTRY_RELEASE when APP_COMMIT is unset', () => {
      expect(readAppCommit({ SENTRY_RELEASE: FULL_SHA })).toBe(FULL_SHA);
    });

    it('treats an empty APP_COMMIT as unset', () => {
      expect(readAppCommit({ APP_COMMIT: '', SENTRY_RELEASE: FULL_SHA })).toBe(FULL_SHA);
      expect(readAppCommit({ APP_COMMIT: '' })).toBe('dev');
    });
  });

  describe('readAppBuildDate', () => {
    it('defaults to null', () => {
      expect(readAppBuildDate({})).toBeNull();
    });

    it('reads APP_BUILD_DATE', () => {
      expect(readAppBuildDate({ APP_BUILD_DATE: '2026-10-04' })).toBe('2026-10-04');
    });

    it('treats an empty value as unset', () => {
      expect(readAppBuildDate({ APP_BUILD_DATE: '' })).toBeNull();
    });
  });

  it('exports the values read from the process environment', () => {
    expect(APP_COMMIT).toBe(readAppCommit());
    expect(APP_BUILD_DATE).toBe(readAppBuildDate());
  });

  describe('shortCommit', () => {
    it('shortens a 40-hex SHA to seven characters', () => {
      expect(shortCommit(FULL_SHA)).toBe('3bd9f8b');
    });

    it('leaves dev and an already-short value unchanged', () => {
      expect(shortCommit('dev')).toBe('dev');
      expect(shortCommit('3bd9f8b')).toBe('3bd9f8b');
    });
  });

  describe('formatVersionLogLine', () => {
    it('prints the short SHA and the build date', () => {
      expect(
        formatVersionLogLine({
          version: '0.18.0',
          commit: FULL_SHA,
          buildDate: '2026-10-04',
          deploymentMode: 'self-hosted',
        }),
      ).toBe('AnythingMCP v0.18.0 (commit 3bd9f8b, built 2026-10-04, mode self-hosted)');
    });

    it('prints dev and built unknown when the image has no provenance', () => {
      expect(
        formatVersionLogLine({
          version: '0.24.0',
          commit: 'dev',
          buildDate: null,
          deploymentMode: 'cloud',
        }),
      ).toBe('AnythingMCP v0.24.0 (commit dev, built unknown, mode cloud)');
    });
  });
});
