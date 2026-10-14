import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

/**
 * The self-hosted compose files list the app's environment one variable at a
 * time, so a variable missing there never reaches the app, whatever .env says.
 * SMTP was missing from docker-compose.yml: setup.sh wrote SMTP_* into .env
 * and no mail ever left a self-hosted install (seen in PR #1083).
 */
const ROOT = join(__dirname, '..', '..', '..', '..');

/** The SMTP_* names the email service reads. */
function smtpVariablesRead(): string[] {
  const source = readFileSync(join(__dirname, 'email.service.ts'), 'utf8');
  return [...new Set([...source.matchAll(/\benv\.(SMTP_[A-Z_]+)/g)].map((m) => m[1]))].sort();
}

/** The environment names a compose service passes to its container. */
function passedVariables(file: string, service: string): Set<string> {
  const doc = load(readFileSync(join(ROOT, file), 'utf8')) as {
    services: Record<string, { environment?: string[] | Record<string, unknown> }>;
  };
  const env = doc.services[service]?.environment ?? [];
  const names = Array.isArray(env) ? env.map((e) => String(e).split('=')[0]) : Object.keys(env);
  return new Set(names);
}

describe('compose files pass the SMTP settings to the app', () => {
  const read = smtpVariablesRead();

  it('reads the variables setup.sh writes', () => {
    expect(read).toEqual(
      expect.arrayContaining(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME']),
    );
  });

  it.each(['docker-compose.yml', 'docker-compose.quickstart.yml'])('%s passes every one of them', (file) => {
    const passed = passedVariables(file, 'app');
    expect(read.filter((name) => !passed.has(name))).toEqual([]);
  });

  it('the cloud backend gets the ones the cloud uses', () => {
    // SMTP_FROM_NAME is not set on the cloud: SMTP_FROM carries the name there.
    const source = readFileSync(join(ROOT, 'docker-compose.cloud.yml'), 'utf8');
    for (const name of read.filter((n) => n !== 'SMTP_FROM_NAME')) {
      expect(source).toContain(`- ${name}=`);
    }
  });
});
