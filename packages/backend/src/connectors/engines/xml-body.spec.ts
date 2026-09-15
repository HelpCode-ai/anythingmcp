import { parseXmlBody } from './rest.engine';

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
