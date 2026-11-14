import { describeHtmlAnswer, htmlText, looksLikeHtml } from './html-excerpt';

describe('html-excerpt', () => {
  it.each([
    ['<!DOCTYPE html><html lang="en">', true],
    ['  <html><head>', true],
    ['<head><title>x</title></head>', true],
    ['{"error":"<b>not html</b>"}', false],
    ['invalid token', false],
    ['<header-value>', false],
  ])('looksLikeHtml(%j) is %s', (body, expected) => {
    expect(looksLikeHtml(body)).toBe(expected);
  });

  it('keeps the readable words: no scripts, styles, comments or tags', () => {
    const page =
      '<html><head><title>Access denied</title><script>var a = "<p>x</p>";</script><style>.a{}</style></head>' +
      '<body><!-- note --><h1>Blocked</h1><p>Ray&nbsp;ID: 123</p><td>a</td><td>b</td></body></html>';
    expect(htmlText(page)).toBe('Access denied Blocked Ray ID: 123 a b');
  });

  it('copes with tags left open at the end of the page', () => {
    expect(htmlText('<p>Hello <script>never closed')).toBe('Hello');
    expect(htmlText('<p>Hello <b')).toBe('Hello');
  });

  it('caps the excerpt and quotes it', () => {
    const out = describeHtmlAnswer(`<p>${'word '.repeat(100)}</p>`, 20);
    expect(out).toMatch(/^the server answered with a web page: "word word word word…"$/);
  });

  it('says so when the page has nothing to read', () => {
    expect(describeHtmlAnswer('<html><body><script>window.location = "/x";</script></body></html>')).toBe(
      'the server answered with a web page, not API data',
    );
  });

  it('reads a large page in one pass', () => {
    const page = `<html><body>${'<div><span>x</span></div>'.repeat(50_000)}</body></html>`;
    const started = Date.now();
    expect(htmlText(page).length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
