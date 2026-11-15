import { applyEnvDefaults, applySchemaDefaults } from './schema-defaults.util';

describe('applySchemaDefaults', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', default: '%' },
      limit: { type: 'integer', default: 200 },
      flag: { type: 'boolean', default: false },
      id: { type: 'string' },
    },
  };

  it('fills only the parameters the caller left undefined', () => {
    expect(applySchemaDefaults(schema, { id: 'a', limit: 5 })).toEqual({
      id: 'a',
      limit: 5,
      name: '%',
      flag: false,
    });
  });

  it('leaves an explicit empty string or null alone', () => {
    expect(applySchemaDefaults(schema, { name: '', limit: null })).toMatchObject({
      name: '',
      limit: null,
    });
  });

  it('does not mutate the caller object', () => {
    const params = { id: 'a' };
    applySchemaDefaults(schema, params);
    expect(params).toEqual({ id: 'a' });
  });

  it.each([undefined, null, {}, { properties: null }, 'x'])(
    'returns the params unchanged for schema %p',
    (s) => {
      const params = { id: 'a' };
      expect(applySchemaDefaults(s, params)).toBe(params);
    },
  );
});

describe('applyEnvDefaults', () => {
  const mapping = { method: 'POST', path: '/sendMessage', envDefaults: { chat_id: 'TELEGRAM_DEFAULT_CHAT_ID' } };
  const env = { TELEGRAM_BOT_TOKEN: '1:secret', TELEGRAM_DEFAULT_CHAT_ID: ' 4242 ' };

  it('fills a parameter the caller left out from the variable the tool names', () => {
    expect(applyEnvDefaults(mapping, { text: 'hi' }, env)).toEqual({ text: 'hi', chat_id: '4242' });
  });

  it.each([undefined, null, ''])('treats %p as left out', (given) => {
    expect(applyEnvDefaults(mapping, { text: 'hi', chat_id: given }, env).chat_id).toBe('4242');
  });

  it('never replaces a value the caller gave', () => {
    expect(applyEnvDefaults(mapping, { chat_id: '-100123' }, env).chat_id).toBe('-100123');
    expect(applyEnvDefaults(mapping, { chat_id: 0 }, env).chat_id).toBe(0);
  });

  it('leaves the call alone when the variable is not set or empty', () => {
    const params = { text: 'hi' };
    expect(applyEnvDefaults(mapping, params, {})).toEqual({ text: 'hi' });
    expect(applyEnvDefaults(mapping, params, { TELEGRAM_DEFAULT_CHAT_ID: '  ' })).toEqual({ text: 'hi' });
    expect(applyEnvDefaults(mapping, params, null)).toBe(params);
  });

  it('reads only the named variable: no other one, and nothing inherited', () => {
    const out = applyEnvDefaults({ envDefaults: { chat_id: 'toString', token: 'MISSING' } }, {}, env);
    expect(out).toEqual({});
  });

  it.each([undefined, null, {}, { envDefaults: null }, { envDefaults: ['chat_id'] }, { envDefaults: { chat_id: 7 } }])(
    'does nothing for mapping %p',
    (m) => {
      expect(applyEnvDefaults(m, { text: 'hi' }, env)).toEqual({ text: 'hi' });
    },
  );

  it('does not mutate the caller object', () => {
    const params = { text: 'hi' };
    applyEnvDefaults(mapping, params, env);
    expect(params).toEqual({ text: 'hi' });
  });
});
