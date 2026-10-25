import {
  URL_PASSWORD_MASK,
  keepMaskedUrlPassword,
  maskUrlPassword,
  moveUrlCredentials,
} from './database-url-credentials.util';
import { toPublicConnector } from './connector-secrets.util';
import { DatabaseEngine } from './engines/database.engine';

const M = URL_PASSWORD_MASK;

describe('moveUrlCredentials', () => {
  it.each([
    ['postgresql://app:s3cret@db.example.com:5432/shop', 'postgresql://db.example.com:5432/shop'],
    ['postgres://app:s3cret@db.example.com/shop?sslmode=require', 'postgres://db.example.com/shop?sslmode=require'],
    ['mysql://app:s3cret@db.example.com:3306/shop', 'mysql://db.example.com:3306/shop'],
    ['mariadb://app:s3cret@db.example.com/shop', 'mariadb://db.example.com/shop'],
    ['mongodb://app:s3cret@mongo.example.com:27017/shop?authSource=admin', 'mongodb://mongo.example.com:27017/shop?authSource=admin'],
    ['mongodb+srv://app:s3cret@cluster0.example.net/shop', 'mongodb+srv://cluster0.example.net/shop'],
    ['mssql://app:s3cret@sql.example.com:1433/shop', 'mssql://sql.example.com:1433/shop'],
    ['oracle://app:s3cret@ora.example.com:1521/ORCL', 'oracle://ora.example.com:1521/ORCL'],
    ['hana://app:s3cret@hana.example.com:30015', 'hana://hana.example.com:30015'],
  ])('moves the credentials out of %s', (input, stripped) => {
    expect(moveUrlCredentials(input, undefined)).toEqual({
      baseUrl: stripped,
      authConfig: { username: 'app', password: 's3cret' },
    });
  });

  it('stores percent-encoded credentials decoded, as the engine expects them', () => {
    const moved = moveUrlCredentials('postgresql://app%2Bro:p%40ss%3Aw0rd@db.example.com/shop', null);
    expect(moved?.authConfig).toEqual({ username: 'app+ro', password: 'p@ss:w0rd' });
  });

  it('keeps an @ in the query string where it is', () => {
    const moved = moveUrlCredentials(
      'postgresql://app:s3cret@db.example.com/shop?application_name=ops@example',
      undefined,
    );
    expect(moved?.baseUrl).toBe('postgresql://db.example.com/shop?application_name=ops@example');
  });

  it('keeps other authConfig keys', () => {
    const moved = moveUrlCredentials('mssql://app:s3cret@sql.example.com/shop', { domain: 'CORP' });
    expect(moved?.authConfig).toEqual({ domain: 'CORP', username: 'app', password: 's3cret' });
  });

  it.each([
    ['a username', { username: 'other' }],
    ['a password', { password: 'other' }],
  ])('leaves the URL alone when authConfig already holds %s', (_label, authConfig) => {
    expect(moveUrlCredentials('postgresql://app:s3cret@db.example.com/shop', authConfig)).toBeNull();
  });

  it.each([
    ['no credentials', 'postgresql://db.example.com/shop'],
    ['a user without a password', 'postgresql://app@db.example.com/shop'],
    ['a password without a user', 'postgresql://:s3cret@db.example.com/shop'],
    ['variable references', 'postgresql://{{DB_USER}}:{{DB_PASSWORD}}@db.example.com/shop'],
    ['the mask from a masked export', `postgresql://app:${M}@db.example.com/shop`],
    ['an ADO.NET string', 'Server=sql.example.com;User Id=app;Password=s3cret;'],
    ['a multi-host MongoDB URL', 'mongodb://app:s3cret@m1.example.com:27017,m2.example.com:27017/shop'],
    ['a SQLite path', 'sqlite:///data/shop.db'],
  ])('returns null for %s', (_label, url) => {
    expect(moveUrlCredentials(url, undefined)).toBeNull();
  });

  it.each([
    'postgresql://app:s3cret@db.example.com:5432/shop',
    'postgres://app%2Bro:p%40ss%3Aw0rd@db.example.com/shop?sslmode=require',
    'mysql://app:s3cret@db.example.com:3306/shop',
    'mongodb://app:s3cret@mongo.example.com:27017/shop?authSource=admin',
  ])('connects with the same URL after the move: %s', (input) => {
    const moved = moveUrlCredentials(input, undefined)!;
    const engine = new DatabaseEngine() as unknown as {
      withUrlCredentials(baseUrl: string, authConfig?: Record<string, unknown>): string;
    };
    expect(engine.withUrlCredentials(moved.baseUrl, moved.authConfig)).toBe(new URL(input).href);
  });
});

describe('maskUrlPassword', () => {
  it.each([
    ['postgresql://app:s3cret@db.example.com:5432/shop', `postgresql://app:${M}@db.example.com:5432/shop`],
    [
      'mongodb://app:s3cret@m1.example.com:27017,m2.example.com:27017/shop',
      `mongodb://app:${M}@m1.example.com:27017,m2.example.com:27017/shop`,
    ],
    ['postgresql://app:p@ss@db.example.com/shop', `postgresql://app:${M}@db.example.com/shop`],
  ])('masks the password in %s', (input, masked) => {
    expect(maskUrlPassword(input)).toBe(masked);
  });

  it.each([
    'postgresql://db.example.com/shop',
    'postgresql://app@db.example.com/shop',
    'postgresql://{{DB_USER}}:{{DB_PASSWORD}}@db.example.com/shop',
    'Server=sql.example.com;User Id=app;Password=s3cret;',
  ])('leaves %s as it is', (input) => {
    expect(maskUrlPassword(input)).toBe(input);
  });
});

describe('keepMaskedUrlPassword', () => {
  const stored = 'postgresql://app:s3cret@db.example.com/shop';

  it('keeps the stored URL when the masked one comes back unchanged', () => {
    expect(keepMaskedUrlPassword(maskUrlPassword(stored), stored)).toBe(stored);
  });

  it('takes an edited URL as sent', () => {
    const edited = `postgresql://app:${M}@db2.example.com/shop`;
    expect(keepMaskedUrlPassword(edited, stored)).toBe(edited);
    expect(keepMaskedUrlPassword('postgresql://app:new@db.example.com/shop', stored)).toBe(
      'postgresql://app:new@db.example.com/shop',
    );
  });
});

describe('toPublicConnector and DATABASE connection strings', () => {
  it('masks a stored password in the base URL', () => {
    const pub = toPublicConnector({
      type: 'DATABASE',
      baseUrl: 'postgresql://app:s3cret@db.example.com/shop',
      headers: null,
      config: null,
      envVars: null,
      authConfig: 'ciphertext',
    });
    expect(pub.baseUrl).toBe(`postgresql://app:${M}@db.example.com/shop`);
    expect(JSON.stringify(pub)).not.toContain('s3cret');
  });
});
