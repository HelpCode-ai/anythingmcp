/**
 * Escape a value for an XML request body, in element text or in an attribute.
 *
 * A value substituted into an XML template went in raw, so a company called
 * "Sharma & Sons" made the document malformed and TallyPrime refused the
 * whole request; the adapter had to ask the model to write `&amp;` itself.
 *
 * An `&` that already starts a character or entity reference (`&amp;`,
 * `&#38;`, `&#x26;`, `&lt;` ...) is left alone, so a value that a model (or a
 * tool description written before this existed) escaped by hand is not
 * escaped twice into `&amp;amp;`.
 */
export function escapeXmlValue(value: string): string {
  return value
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
