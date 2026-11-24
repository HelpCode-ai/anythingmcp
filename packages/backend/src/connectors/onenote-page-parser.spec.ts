import { parseOneNoteHtml, parseOneNoteInk, parseOneNoteMultipart } from './onenote-page-parser';
import { XMLParser } from 'fast-xml-parser';

const INK_NS = 'http://www.w3.org/2003/InkML';
const ink = (traces: string, definitions = '') => `<inkml:ink xmlns:inkml="${INK_NS}"><inkml:definitions>${definitions}</inkml:definitions>${traces}</inkml:ink>`;
const context = (channels = '<channel name="X" units="himetric"/><channel name="Y" units="himetric"/>') =>
  `<context xml:id="coordinates"><inkSource><traceFormat>${channels}</traceFormat></inkSource></context>`;
const trace = (samples: string, attributes = '') => `<trace ${attributes}>${samples}</trace>`;
const multipart = (html: string, drawing?: string, boundary = 'amcp-fixture') => Buffer.from([
  `--${boundary}\r\nContent-Type: text/html\r\n\r\n${html}\r\n`,
  ...(drawing ? [`--${boundary}\r\nContent-Type: application/inkml+xml\r\n\r\n${drawing}\r\n`] : []),
  `--${boundary}--\r\n`,
].join(''));

describe('OneNote multipart parsing', () => {
  it('keeps the HTML and namespaced InkML unchanged', () => {
    const html = '<html><body><p>Pen notes</p></body></html>';
    const drawing = ink(trace('0 0, 2540 1270'));
    expect(parseOneNoteMultipart(multipart(html, drawing), 'multipart/mixed; boundary="amcp-fixture"')).toEqual({ html, ink: drawing });
  });

  it('accepts a text-only page and an HTML-only multipart page', () => {
    expect(parseOneNoteMultipart(Buffer.from('<p>Notes</p>'), 'text/html; charset=utf-8')).toEqual({ html: '<p>Notes</p>' });
    expect(parseOneNoteMultipart(multipart('<p>Notes</p>'), 'multipart/mixed; boundary=amcp-fixture')).toEqual({ html: '<p>Notes</p>' });
  });

  it('does not split on a boundary-like string inside the HTML', () => {
    const html = '<p>--amcp-fixture</p>\r\n--amcp-fixture-not-a-boundary\r\n';
    expect(parseOneNoteMultipart(multipart(html), 'multipart/mixed; boundary=amcp-fixture').html).toBe(html);
  });

  it.each([
    ['no boundary', Buffer.from('body'), 'multipart/mixed'],
    ['missing closing delimiter', multipart('<p>Notes</p>').subarray(0, -22), 'multipart/mixed; boundary=amcp-fixture'],
    ['wrong boundary', multipart('<p>Notes</p>'), 'multipart/mixed; boundary=wrong'],
    ['non-UTF8 document', Buffer.from([0xff]), 'text/html'],
  ])('rejects %s', (_label, body, type) => {
    expect(() => parseOneNoteMultipart(body as Buffer, type as string)).toThrow();
  });

  it('rejects an input over the byte limit before parsing', () => {
    expect(() => parseOneNoteMultipart(Buffer.alloc(10 * 1024 * 1024 + 1), 'text/html')).toThrow('exceeds');
  });
});

describe('OneNote ink coordinates', () => {
  it('rejects too many elements before the XML parser can allocate a tree', () => {
    const parser = jest.spyOn(XMLParser.prototype, 'parse');
    try {
      expect(() => parseOneNoteInk(ink('<trace/>'.repeat(20_001)))).toThrow('too many elements');
      expect(parser).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });

  it('scales himetric to CSS pixels and honors channel order and group references', () => {
    const definitions = context('<channel name="F"/><channel name="Y" units="himetric"/><channel name="X" units="himetric"/>')
      + '<brush xml:id="blue"><brushProperty name="width" value="254" units="himetric"/><brushProperty name="color" value="#1234ab"/><brushProperty name="transparency" value="128"/></brush>';
    const source = ink(`<traceGroup contextRef="#coordinates" brushRef="#blue">${trace('100 1270 2540, 200 2540 5080')}</traceGroup>`, definitions);
    const [stroke] = parseOneNoteInk(source);
    expect(stroke.points).toEqual([[96, 48], [192, 96]]);
    expect(stroke.width).toBeCloseTo(9.6);
    expect(stroke.color).toBe('#1234ab');
    expect(stroke.opacity).toBe(0.5);
  });

  it('integrates first and second differences independently per channel', () => {
    const source = ink(trace(`10 20, '2 '3, "1 "-1, 0 1, !0 !0`, 'contextRef="#coordinates"'), context('<channel name="X" units="px"/><channel name="Y" units="px"/>'));
    expect(parseOneNoteInk(source)[0].points).toEqual([[10, 20], [12, 23], [15, 25], [18, 28], [0, 0]]);
  });

  it('supports explicit and repeated first-difference wildcard values', () => {
    const source = ink(trace(`10 20, * 30, '2 '3, * *`, 'contextRef="#coordinates"'), context('<channel name="X" units="px"/><channel name="Y" units="px"/>'));
    expect(parseOneNoteInk(source)[0].points).toEqual([[10, 20], [10, 30], [12, 33], [14, 36]]);
  });

  it('repeats acceleration for a second-difference wildcard', () => {
    const source = ink(trace(`0 0, '2 '3, "1 "2, * *`, 'contextRef="#coordinates"'), context('<channel name="X" units="px"/><channel name="Y" units="px"/>'));
    expect(parseOneNoteInk(source)[0].points).toEqual([[0, 0], [2, 3], [5, 8], [9, 15]]);
  });

  it('does not draw pen-up trajectories', () => {
    expect(parseOneNoteInk(ink(trace('0 0, 100 100', 'type="penUp"')))).toEqual([]);
  });

  it.each([
    ['external context', ink(trace('0 0', 'contextRef="https://example.com/ink"'))],
    ['missing reference', ink(trace('0 0', 'brushRef="#absent"'))],
    ['non-numeric coordinate', ink(trace('NaN 0'))],
    ['infinite coordinate', ink(trace('1e999 0'))],
    ['differential first sample', ink(trace("'1 '2"))],
    ['second difference without velocity', ink(trace('0 0, "1 "2'))],
    ['unsupported mapping', ink('<canvasTransform/>')],
    ['continuation trace', ink(trace('0 0', 'continuation="end" priorRef="#previous"'))],
    ['malformed XML', `<ink xmlns="${INK_NS}"><trace>0 0</ink>`],
    ['DTD', `<!DOCTYPE ink [<!ENTITY private SYSTEM "file:///private">]>${ink(trace('0 0'))}`],
    ['deep tree', ink('<traceGroup>'.repeat(40) + trace('0 0') + '</traceGroup>'.repeat(40))],
  ])('rejects %s', (_label, source) => expect(() => parseOneNoteInk(source)).toThrow());
});

describe('OneNote page HTML', () => {
  it('extracts typed text, decodes references once and excludes scripts/styles', () => {
    const source = '<!DOCTYPE html><html><head><title>Hidden</title><style>hidden</style></head><body><p>Plan &amp; notes &#x1f4dd;</p><script>hidden()</script><p>Next &lt;step&gt;</p></body></html>';
    const parsed = parseOneNoteHtml(source);
    expect(parsed.text).toBe('Plan & notes 📝\nNext <step>');
    expect(parsed.images).toEqual([]);
  });

  it('places image rectangles using parent offsets and converts pt to pixels', () => {
    const source = '<html><body><div style="position:absolute;left:72pt;top:100px"><img src="https://graph.microsoft.com/v1.0/me/onenote/resources/a/content?x=1&amp;y=2" width="300" height="200" style="left:10px;top:20px" /></div></body></html>';
    expect(parseOneNoteHtml(source).images).toEqual([{ source: 'https://graph.microsoft.com/v1.0/me/onenote/resources/a/content?x=1&y=2', x: 106, y: 120, width: 300, height: 200 }]);
  });

  it('reports unpositionable images rather than inventing dimensions', () => {
    const parsed = parseOneNoteHtml('<html><body><img src="image"/></body></html>');
    expect(parsed.images).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('reports when typed text exceeds the text budget', () => {
    const parsed = parseOneNoteHtml(`<html><body><p>${'a'.repeat(100_001)}</p></body></html>`);
    expect(parsed.text).toHaveLength(100_000);
    expect(parsed.warnings).toEqual(['Typed text was truncated at 100,000 characters.']);
  });
});
