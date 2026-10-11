import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Profile {
  url: string;
  server: string;
  key: string;
}

type Config = { profiles: Record<string, Profile> };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'amcp', 'config.json');
}

function validProfile(value: unknown): value is Profile {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.url === 'string' && typeof p.server === 'string' && typeof p.key === 'string';
}

export async function readConfig(path = configPath()): Promise<Config> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error('Configuration path is not a regular file');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid CLI configuration');
    const profiles = (parsed as Record<string, unknown>).profiles;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles) ||
        !Object.values(profiles).every(validProfile)) throw new Error('Invalid CLI configuration');
    return { profiles: profiles as Record<string, Profile> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw error;
  }
}

export async function writeConfig(config: Config, path = configPath()): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function profileName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('Profile name must contain only letters, digits, _, - or .');
  }
  return value;
}
