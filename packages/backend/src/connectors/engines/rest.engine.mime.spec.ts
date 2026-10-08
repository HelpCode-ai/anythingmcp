import axios from 'axios';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { containsMimeMarker } from './mime-message.util';
import { getAdapter, listAdapters } from '../../adapters/catalog';
import * as gmail from '../../adapters/intl/gmail.json';

// The callable default export is mocked; every real static (AxiosError,
// isAxiosError, create, …) is kept so the engine's helpers behave as in prod.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    ...actual,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
  };
});
// No DNS in unit tests: the catalog-wide check below calls hundreds of hosts.
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as unknown as jest.Mock;

type Mapping = Record<string, any>;
const gmailTool = (name: string): Mapping => {
  const t = (gmail as any).tools.find((x: { name: string }) => x.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t.endpointMapping;
};

function engine(): RestEngine {
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
}

const config = { baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me', authType: 'NONE' };

async function sentRequest(mapping: Mapping, params: Record<string, unknown>) {
  mockedAxios.mockResolvedValue({ data: { id: 'sent' }, headers: {} });
  await engine().execute(config, mapping as any, params);
  expect(mockedAxios).toHaveBeenCalledTimes(1);
  return mockedAxios.mock.calls[0][0];
}

function unfoldHeaders(message: string): Record<string, string> {
  const head = message.slice(0, message.indexOf('\r\n\r\n')).replace(/\r\n(?=[ \t])/g, '');
  return Object.fromEntries(
    head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
  );
}
const decodeWords = (v: string) =>
  v.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_m, b: string) => Buffer.from(b, 'base64').toString('utf8'));
const fromRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

beforeEach(() => mockedAxios.mockReset());

describe('RestEngine __mime marker (Gmail)', () => {
  it('gmail_send_message posts {raw: base64url RFC 5322 message}', async () => {
    const req = await sentRequest(gmailTool('gmail_send_message'), {
      to: ['Jürgen Müller <juergen@example.de>', 'ana@example.com'],
      cc: [],
      subject: 'Grüße 👋',
      body: 'Hallo,\nbis morgen.',
    });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(Object.keys(req.data)).toEqual(['raw']);
    expect(req.data.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const message = fromRaw(req.data.raw);
    const h = unfoldHeaders(message);
    expect(decodeWords(h.To)).toBe('Jürgen Müller <juergen@example.de>, ana@example.com');
    expect(h.Cc).toBeUndefined();
    expect(decodeWords(h.Subject)).toBe('Grüße 👋');
    expect(h['MIME-Version']).toBe('1.0');
    expect(h['Content-Type']).toBe('text/plain; charset=UTF-8');
    const body = message.slice(message.indexOf('\r\n\r\n') + 4);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hallo,\r\nbis morgen.');
  });

  it('gmail_create_draft nests the message and omits an unset threadId', async () => {
    const req = await sentRequest(gmailTool('gmail_create_draft'), { body: 'Entwurf', subject: 'Test' });
    expect(req.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(Object.keys(req.data)).toEqual(['message']);
    expect(Object.keys(req.data.message)).toEqual(['raw']);
    expect(unfoldHeaders(fromRaw(req.data.message.raw)).Subject).toBe('Test');
  });

  it('gmail_reply threads the reply: threadId, In-Reply-To, References, Re: subject, html alternative', async () => {
    const req = await sentRequest(gmailTool('gmail_reply'), {
      thread_id: '18c0',
      in_reply_to: '<CAF123@mail.gmail.com>',
      references: '<root@mail.gmail.com>',
      to: ['ana@example.com'],
      subject: 'Offerta',
      body: 'Grazie!',
      html_body: '<p>Grazie!</p>',
    });
    expect(req.data.threadId).toBe('18c0');
    const h = unfoldHeaders(fromRaw(req.data.raw));
    expect(h.Subject).toBe('Re: Offerta');
    expect(h['In-Reply-To']).toBe('<CAF123@mail.gmail.com>');
    expect(h.References).toBe('<root@mail.gmail.com> <CAF123@mail.gmail.com>');
    expect(h['Content-Type']).toMatch(/^multipart\/alternative; boundary="amcp_[0-9a-f]+"$/);
  });

  it('refuses header injection before anything is sent', async () => {
    await expect(
      engine().execute(config, gmailTool('gmail_send_message') as any, {
        to: ['ana@example.com'],
        subject: 'Hi\r\nBcc: victim@example.com',
        body: 'x',
      }),
    ).rejects.toThrow(/subject must be a single line/);
    await expect(
      engine().execute(config, gmailTool('gmail_send_message') as any, {
        to: ['not an address'],
        subject: 'Hi',
        body: 'x',
      }),
    ).rejects.toThrow(/is not an e-mail address/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('a message text containing $ or ${…} is not read as a placeholder', async () => {
    const req = await sentRequest(
      { method: 'POST', path: '/x', bodyMapping: { raw: { __mime: { subject: '$s', text: '$t' }, __encoding: 'none' } } },
      { s: 'Costs ${price} or $amount', t: '${body} $x' },
    );
    const h = unfoldHeaders(req.data.raw);
    expect(h.Subject).toBe('Costs ${price} or $amount');
  });

  it('does not expand a __mime object that arrives as an argument', async () => {
    const callerObject = { __mime: { to: 'a@example.com' } };
    const req = await sentRequest({ method: 'POST', path: '/x', bodyMapping: { payload: '$p' } }, { p: callerObject });
    expect(req.data).toEqual({ payload: callerObject });
  });
});

describe('RestEngine without __mime: requests are unchanged', () => {
  it('no catalog adapter other than Gmail uses the marker', () => {
    const users = listAdapters()
      .map((m) => getAdapter(m.slug)!)
      .filter((a) => a.tools.some((t) => containsMimeMarker((t.endpointMapping as Mapping).bodyMapping)))
      .map((a) => a.slug);
    expect(users).toEqual(['gmail']);
  });

  it.each([
    [
      'nested JSON with arrays and literals',
      { method: 'POST', path: '/a', bodyMapping: { message: { text: '$t', tags: ['$a', 'fixed'] }, n: 1, flag: true } },
      { t: 'hi', a: 'x' },
      { message: { text: 'hi', tags: ['x', 'fixed'] }, n: 1, flag: true },
    ],
    [
      'embedded ${} and dropped empty values',
      { method: 'PATCH', path: '/a', bodyMapping: { name: 'Hi ${who}', skip: '$missing', empty: '$e' } },
      { who: 'Ana', e: '' },
      { name: 'Hi Ana' },
    ],
    [
      '__merge',
      { method: 'POST', path: '/a', bodyMapping: { model: 'res.partner', __merge: '$kw' } },
      { kw: { domain: [], limit: 5, model: 'ignored' } },
      { domain: [], limit: 5, model: 'res.partner' },
    ],
    [
      'top-level array body',
      { method: 'POST', path: '/a', bodyMapping: [{ sku: '$sku', qty: '$q' }] },
      { sku: 'A1', q: 3 },
      [{ sku: 'A1', qty: 3 }],
    ],
    [
      '__raw XML with escaping',
      { method: 'POST', path: '/a', bodyEncoding: 'xml', bodyMapping: { __raw: '<a>${v}</a>' } },
      { v: '<&>' },
      '<a>&lt;&amp;&gt;</a>',
    ],
    [
      'form-urlencoded with nested values',
      { method: 'POST', path: '/a', bodyEncoding: 'form-urlencoded', bodyMapping: { fields: { TITLE: '$t', TAGS: ['$a'] } } },
      { t: 'Grüße', a: 'x' },
      'fields%5BTITLE%5D=Gr%C3%BC%C3%9Fe&fields%5BTAGS%5D%5B0%5D=x',
    ],
  ])('%s', async (_label, mapping, params, expected) => {
    const req = await sentRequest(mapping, params);
    expect(req.data).toEqual(expected);
  });

  /**
   * Every REST tool in the catalog that builds a body: the engine hands the
   * tool's own bodyMapping object and the call's own params to the resolver,
   * exactly as before the marker existed. Anything else would mean the new
   * branch touched a mapping that did not opt in.
   */
  it('every catalog body mapping without the marker reaches the resolver as the same objects', async () => {
    const e = engine();
    const mapSpy = jest.spyOn(e as any, 'mapParams');
    const resolveSpy = jest.spyOn(e as any, 'resolveValue');
    let checked = 0;
    for (const meta of listAdapters()) {
      const adapter = getAdapter(meta.slug)!;
      if (adapter.connector.type !== 'REST') continue;
      for (const tool of adapter.tools) {
        const original = tool.endpointMapping as Mapping;
        const method = String(original.method).toUpperCase();
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
        if (!original.bodyMapping || original.bodyTemplate) continue;
        if (containsMimeMarker(original.bodyMapping)) continue;
        if (JSON.stringify(original.bodyMapping).includes('__file')) continue;
        // Placeholders for connector variables are resolved by the caller.
        const mapping = JSON.parse(JSON.stringify(original).replace(/\{\{[^}]+\}\}/g, 'x'));
        const params: Record<string, unknown> = {};
        for (const name of Object.keys((tool.parameters as any)?.properties ?? {})) params[name] = 'v';
        mockedAxios.mockReset();
        mockedAxios.mockResolvedValue({ data: {}, headers: {} });
        mapSpy.mockClear();
        resolveSpy.mockClear();
        await e.execute({ baseUrl: 'https://api.example.com', authType: 'NONE' }, mapping, params);
        if ('__raw' in mapping.bodyMapping) {
          const call = resolveSpy.mock.calls.find((c) => c[0] === mapping.bodyMapping.__raw);
          expect(call?.[1]).toBe(params);
        } else {
          const call = mapSpy.mock.calls.find((c) => c[0] === mapping.bodyMapping);
          expect(`${meta.slug}/${tool.name}: ${!!call && call[1] === params}`).toBe(`${meta.slug}/${tool.name}: true`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  }, 60000);
});
