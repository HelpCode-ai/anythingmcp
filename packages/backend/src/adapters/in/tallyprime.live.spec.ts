import axios from 'axios';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { RestEngine } from '../../connectors/engines/rest.engine';
import * as adapter from './tallyprime.json';

// No TallyPrime instance is reachable from CI, so these tests send every tool
// through the real REST engine with axios mocked and check the XML it would
// post: well-formed, an Export request, every argument placed where Tally
// reads it. Nothing here talks to a network.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping: { __raw: string } };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; headers: Record<string, string> };
  probe: { tool: string };
  prerequisites: string;
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const sample: Record<string, string> = {
  company: 'Sharma &amp; Sons Pvt Ltd',
  from_date: '20250401',
  to_date: '20260331',
  ledger: 'Customer ABC',
  group: 'Sundry Debtors',
  voucher_type: 'Sales',
};
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

async function render(t: Tool): Promise<string> {
  mockedAxios.mockResolvedValue({ data: '<ENVELOPE/>', headers: { 'content-type': 'text/xml' } });
  const params = Object.fromEntries(Object.keys(t.parameters.properties).map((p) => [p, sample[p]]));
  await new RestEngine({} as never, {} as never).execute(
    { baseUrl: 'http://192.168.1.20:9000', authType: 'NONE', headers: a.connector.headers },
    t.endpointMapping,
    params,
  );
  const sent = mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as unknown as {
    url: string;
    method: string;
    data: string;
    headers: Record<string, string>;
  };
  expect(sent.url).toBe('http://192.168.1.20:9000/');
  expect(sent.method).toBe('POST');
  expect(sent.headers['Content-Type']).toMatch(/^text\/xml/);
  return sent.data;
}

describe('tallyprime adapter: static spec conformance', () => {
  it('posts XML to the address of the TallyPrime server, without auth', () => {
    expect(a.connector.baseUrl).toBe('{{TALLY_URL}}');
    expect(a.connector.authType).toBe('NONE');
    expect(a.probe.tool).toBe('tallyprime_list_companies');
    expect(tool('tallyprime_list_companies').parameters.required).toBeUndefined();
  });

  it('explains that Cloud cannot reach a LAN address', () => {
    expect(a.prerequisites).toMatch(/Cloud cannot reach a LAN/);
  });

  it('every tool is a read-only Export over POST', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.annotations).toEqual({ readOnlyHint: true });
      expect(t.endpointMapping.bodyMapping.__raw).toContain('<TALLYREQUEST>Export</TALLYREQUEST>');
      expect(t.endpointMapping.bodyMapping.__raw).not.toMatch(/Import|<TALLYMESSAGE/i);
    }
  });

  it('every declared parameter is required and reaches the XML', () => {
    // The engine drops a raw body whose ${placeholder} has no value, so an
    // optional parameter would silently send an empty request.
    for (const t of a.tools) {
      for (const p of Object.keys(t.parameters.properties)) {
        expect(`${t.name}:${p}:${t.endpointMapping.bodyMapping.__raw.includes('${' + p + '}')}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it.each(adapter.tools.map((t) => t.name))('%s renders well-formed XML with the arguments in place', async (name) => {
    const t = tool(name);
    const xml = await render(t);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain('${');
    const doc = parser.parse(xml);
    expect(doc.ENVELOPE.HEADER.TALLYREQUEST).toBe('Export');
    const sv = doc.ENVELOPE.BODY.DESC.STATICVARIABLES;
    expect(sv.SVEXPORTFORMAT).toBe('$$SysName:XML');
    if (t.parameters.properties.company) expect(sv.SVCURRENTCOMPANY).toBe('Sharma & Sons Pvt Ltd');
    if (t.parameters.properties.from_date) {
      expect(sv.SVFROMDATE).toEqual({ '#text': 20250401, TYPE: 'Date' });
      expect(sv.SVTODATE).toEqual({ '#text': 20260331, TYPE: 'Date' });
    }
  });

  it('uses the documented report names and report variables', async () => {
    const id = async (n: string) => parser.parse(await render(tool(n))).ENVELOPE.HEADER.ID;
    expect(await id('tallyprime_get_trial_balance')).toBe('Trial Balance');
    expect(await id('tallyprime_get_day_book')).toBe('Day Book');
    expect(await id('tallyprime_get_bills_receivable')).toBe('Bills Receivable');
    expect(await id('tallyprime_get_bills_payable')).toBe('Bills Payable');
    const lv = parser.parse(await render(tool('tallyprime_get_ledger_vouchers')));
    expect(lv.ENVELOPE.HEADER.ID).toBe('Ledger Vouchers');
    expect(lv.ENVELOPE.BODY.DESC.STATICVARIABLES.LEDGERNAME).toBe('Customer ABC');
    const go = parser.parse(await render(tool('tallyprime_get_group_outstandings')));
    expect(go.ENVELOPE.BODY.DESC.STATICVARIABLES.GROUPNAME).toBe('Sundry Debtors');
    const obj = parser.parse(await render(tool('tallyprime_get_ledger')));
    expect(obj.ENVELOPE.HEADER).toMatchObject({ TYPE: 'Object', SUBTYPE: 'Ledger', ID: { '#text': 'Customer ABC', TYPE: 'Name' } });
  });

  it('filters the Day Book by voucher type with a TDL formula', async () => {
    const xml = await render(tool('tallyprime_get_day_book_by_type'));
    expect(xml).toContain('$VoucherTypeName = "Sales"');
  });

  it('a Tally collection response parses into objects', async () => {
    const body =
      '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>' +
      '<LEDGER NAME="ABC India Pvt. Ltd." RESERVEDNAME=""><OPENINGBALANCE TYPE="Amount">5000.00</OPENINGBALANCE></LEDGER>' +
      '</COLLECTION></DATA></BODY></ENVELOPE>';
    mockedAxios.mockResolvedValue({ data: body, headers: { 'content-type': 'text/xml; charset=utf-8' } });
    const out = (await new RestEngine({} as never, {} as never).execute(
      { baseUrl: 'http://192.168.1.20:9000', authType: 'NONE', headers: a.connector.headers },
      tool('tallyprime_list_ledgers').endpointMapping,
      { company: 'X' },
    )) as any;
    expect(out.ENVELOPE.BODY.DATA.COLLECTION.LEDGER.NAME).toBe('ABC India Pvt. Ltd.');
  });
});
