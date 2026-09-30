/**
 * Every word of the query must start a word somewhere in the fields.
 *
 * A plain substring match turned "SAP" into WhatsApp, MessageBird ("WhatsApp
 * via Bird") and NewsAPI. Word starts include camelCase and letter/digit
 * humps, so "api" still finds NewsAPI and "hana" finds S/4HANA, while the
 * text as written still matches too ("4hana", "s/4hana").
 */
export function matchesSearch(fields: string[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields
    .flatMap((f) => [
      f.toLowerCase(),
      f
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])|([0-9])([A-Za-z])/g, '$1$3 $2$4')
        .toLowerCase(),
    ])
    .join(' \n ');
  return words.every((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}`).test(haystack);
  });
}
