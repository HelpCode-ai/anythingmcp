import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { RestEngine, parseXmlBody, renderXmlBodyTemplate } from './rest.engine';
import { escapeXmlValue } from '../../common/xml-escape.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import tallyprime from '../../adapters/in/tallyprime.json';

describe('parseXmlBody', () => {
  it('leaves JSON responses exactly as axios delivered them', () => {
    const data = { a: 1 };
    expect(
      parseXmlBody({ data, headers: { 'content-type': 'application/json' } }),
    ).toBe(data);
  });

  it('leaves a string body alone unless the response is declared XML', () => {
    expect(
      parseXmlBody({ data: '<a/>', headers: { 'content-type': 'text/plain' } }),
    ).toBe('<a/>');
    expect(parseXmlBody({ data: '<a/>' })).toBe('<a/>');
  });

  it('parses application/xml and text/xml, hoisting attributes without a prefix', () => {
    // Shape of the Deutsche Bahn Timetables API: everything is an attribute.
    const xml =
      '<?xml version="1.0"?><timetable station="Freiburg(Breisgau) Hbf">' +
      '<s id="1"><tl f="F" c="ICE" n="373"/><dp pt="2609151427" pp="1" ppth="Basel SBB|Bern"/></s>' +
      '</timetable>';
    for (const ct of ['application/xml', 'text/xml; charset=utf-8']) {
      const out = parseXmlBody({ data: xml, headers: { 'content-type': ct } }) as any;
      expect(out.timetable.station).toBe('Freiburg(Breisgau) Hbf');
      expect(out.timetable.s.tl.c).toBe('ICE');
      expect(out.timetable.s.dp.ppth).toBe('Basel SBB|Bern');
      // Numeric-looking values stay strings: "2609151427" is a timestamp, not
      // a number, and "0810" would lose its leading zero.
      expect(out.timetable.s.dp.pt).toBe('2609151427');
    }
  });

  it('handles +xml media types and strips namespace prefixes', () => {
    const out = parseXmlBody({
      data: '<x:root xmlns:x="urn:x"><x:item v="1"/></x:root>',
      headers: { 'content-type': 'application/vnd.example+xml' },
    }) as any;
    expect(out.root.item.v).toBe('1');
  });

  it('returns the original text when the declared XML does not parse to anything', () => {
    expect(
      parseXmlBody({ data: 'not xml at all', headers: { 'content-type': 'application/xml' } }),
    ).toBe('not xml at all');
  });
});

describe('escapeXmlValue', () => {
  it('escapes the five XML specials', () => {
    expect(escapeXmlValue(`Sharma & Sons <"O'Neil">`)).toBe(
      'Sharma &amp; Sons &lt;&quot;O&apos;Neil&quot;&gt;',
    );
  });

  it('leaves an existing entity or character reference alone', () => {
    // A model following an older tool description may still escape by hand.
    expect(escapeXmlValue('Sharma &amp; Sons')).toBe('Sharma &amp; Sons');
    expect(escapeXmlValue('A &#38; B &#x26; C &lt;')).toBe('A &#38; B &#x26; C &lt;');
    expect(escapeXmlValue('R&D &ampersand')).toBe('R&amp;D &amp;ampersand');
  });
});

describe('renderXmlBodyTemplate', () => {
  it('escapes every substituted value and empties missing ones', () => {
    expect(
      renderXmlBodyTemplate('<A>${a}</A><B x="${b}"/><C>${missing}</C>', { a: 'Tom & Jerry', b: '"q"' }),
    ).toBe('<A>Tom &amp; Jerry</A><B x="&quot;q&quot;"/><C></C>');
  });
});

describe('RestEngine XML request bodies', () => {
  let server: Server;
  let baseUrl: string;
  let received: { body: string; contentType?: string };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received = { body, contentType: req.headers['content-type'] };
        res.setHeader('Content-Type', 'text/xml');
        res.end('<ENVELOPE><OK>1</OK></ENVELOPE>');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const engine = new RestEngine({} as any, {} as any);
  const raw = '<ENVELOPE><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></ENVELOPE>';

  it('sends __raw verbatim without bodyEncoding, as before', async () => {
    await engine.execute(
      { baseUrl, authType: 'NONE' },
      { method: 'POST', path: '/', bodyMapping: { __raw: raw } },
      { company: 'Sharma & Sons' },
    );
    expect(received.body).toBe('<ENVELOPE><SVCURRENTCOMPANY>Sharma & Sons</SVCURRENTCOMPANY></ENVELOPE>');
  });

  it('escapes ${param} in __raw with bodyEncoding xml and labels the body as XML', async () => {
    const out = await engine.execute(
      { baseUrl, authType: 'NONE' },
      { method: 'POST', path: '/', bodyEncoding: 'xml', bodyMapping: { __raw: raw } },
      { company: 'Sharma & Sons <Pvt>' },
    );
    expect(received.body).toBe(
      '<ENVELOPE><SVCURRENTCOMPANY>Sharma &amp; Sons &lt;Pvt&gt;</SVCURRENTCOMPANY></ENVELOPE>',
    );
    expect(received.contentType).toBe('application/xml; charset=utf-8');
    expect(out).toEqual({ ENVELOPE: { OK: '1' } });
  });

  it("keeps the connector's own Content-Type", async () => {
    await engine.execute(
      { baseUrl, authType: 'NONE', headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
      { method: 'POST', path: '/', bodyEncoding: 'xml', bodyMapping: { __raw: raw } },
      { company: 'A&B' },
    );
    expect(received.contentType).toBe('text/xml; charset=utf-8');
    expect(received.body).toContain('A&amp;B');
  });

  it('sends a whole-value $param body as given', async () => {
    await engine.execute(
      { baseUrl, authType: 'NONE' },
      { method: 'POST', path: '/', bodyEncoding: 'xml', bodyMapping: { __raw: '$xml' } },
      { xml: '<A>x &amp; y</A>' },
    );
    expect(received.body).toBe('<A>x &amp; y</A>');
  });

  it('renders an XML bodyTemplate as markup instead of parsing it as JSON', async () => {
    await engine.execute(
      { baseUrl, authType: 'NONE' },
      { method: 'POST', path: '/', bodyEncoding: 'xml', bodyTemplate: '<Q><NAME>${name}</NAME></Q>' },
      { name: 'Smith & Co' },
    );
    expect(received.body).toBe('<Q><NAME>Smith &amp; Co</NAME></Q>');
  });

  it('escapes connector variables in an XML body too', () => {
    const { endpointMapping } = interpolateConnectorConfig(
      { baseUrl },
      { method: 'POST', path: '/', bodyEncoding: 'xml', bodyMapping: { __raw: '<C>{{COMPANY}}</C><D>${d}</D>' } },
      { COMPANY: 'A & B' },
    );
    expect(endpointMapping.bodyMapping?.__raw).toBe('<C>A &amp; B</C><D>${d}</D>');
  });
});

describe('TallyPrime adapter', () => {
  it('sends every tool body as XML and no longer asks the model to escape names', () => {
    for (const tool of (tallyprime as any).tools) {
      expect(tool.endpointMapping.bodyEncoding).toBe('xml');
      expect(typeof tool.endpointMapping.bodyMapping.__raw).toBe('string');
    }
    expect(JSON.stringify(tallyprime)).not.toContain('&amp;');
  });
});
