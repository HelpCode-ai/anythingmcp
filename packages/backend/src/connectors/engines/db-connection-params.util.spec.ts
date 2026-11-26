import {
  CLOUD_BLOCKED_MONGODB_PARAMS,
  CLOUD_BLOCKED_POSTGRES_PARAMS,
  stripConnectionParams,
} from './db-connection-params.util';

describe('stripConnectionParams', () => {
  const pg = (s: string) => stripConnectionParams(s, CLOUD_BLOCKED_POSTGRES_PARAMS);
  const mongo = (s: string) =>
    stripConnectionParams(s, CLOUD_BLOCKED_MONGODB_PARAMS, { caseInsensitive: true });

  it('removes the file and startup parameters and keeps sslmode and the rest in order', () => {
    expect(
      pg('postgres://u:p@db.example.com:5432/app?sslmode=require&sslrootcert=/etc/x&application_name=amcp&sslcert=/a&sslkey=/b&options=-c%20x%3Dy'),
    ).toEqual({
      connectionString: 'postgres://u:p@db.example.com:5432/app?sslmode=require&application_name=amcp',
      removed: ['sslrootcert', 'sslcert', 'sslkey', 'options'],
    });
  });

  it('drops the question mark when nothing is left', () => {
    expect(pg('postgres://db.example.com/app?sslrootcert=/etc/x').connectionString).toBe(
      'postgres://db.example.com/app',
    );
  });

  it('leaves a string without those parameters untouched, byte for byte', () => {
    for (const s of [
      'postgres://db.example.com/app',
      'postgres://u:p%40ss@db.example.com:5432/app?sslmode=verify-full&connect_timeout=5',
      'postgresql://u@db.example.com/app?ssl=true#frag',
    ]) {
      expect(pg(s)).toEqual({ connectionString: s, removed: [] });
    }
  });

  it('removes every copy of a repeated parameter', () => {
    expect(pg('postgres://h/db?sslkey=/a&sslmode=require&sslkey=/b')).toEqual({
      connectionString: 'postgres://h/db?sslmode=require',
      removed: ['sslkey'],
    });
  });

  it('matches a key written with percent escapes, as the driver decodes it', () => {
    expect(pg('postgres://h/db?ssl%72ootcert=/etc/x&sslmode=require').connectionString).toBe(
      'postgres://h/db?sslmode=require',
    );
    // Same when a space elsewhere makes pg pre-encode the string first.
    expect(pg('postgres://h/my db?ssl%72ootcert=/etc/x').connectionString).toBe('postgres://h/my db');
  });

  it('keeps a pg key that differs in case (pg matches keys as written)', () => {
    expect(pg('postgres://h/db?SSLCERT=/a').removed).toEqual([]);
  });

  it('keeps the fragment and does not read a question mark inside it as a query', () => {
    expect(pg('postgres://h/db?sslcert=/a#x?sslmode=1').connectionString).toBe('postgres://h/db#x?sslmode=1');
    expect(pg('postgres://h/db#?sslcert=/a').removed).toEqual([]);
  });

  it('removes the MongoDB TLS file options in any case, multi-host strings included', () => {
    expect(
      mongo('mongodb://u:p@h1:27017,h2:27017/db?replicaSet=rs0&TLSCAFILE=/a&tls=true&tlsCertificateKeyFile=/b&tlscrlfile=/c'),
    ).toEqual({
      connectionString: 'mongodb://u:p@h1:27017,h2:27017/db?replicaSet=rs0&tls=true',
      removed: ['tlsCAFile', 'tlsCertificateKeyFile', 'tlsCRLFile'],
    });
  });
});
