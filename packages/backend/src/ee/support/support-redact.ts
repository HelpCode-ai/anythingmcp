/**
 * Scrubs credentials out of text that leaves the instance for the support
 * desk or its AI triage: upstream error messages sometimes echo the request
 * (a bearer token, an api_key query parameter, a signed URL).
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=:-]{8,}/gi, '$1 [redacted]'],
  [
    /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token|signature|sig|key)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    '$1$2[redacted]',
  ],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  // Long opaque strings (keys, hashes) that survived the rules above
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]'],
];

export function redactSecrets(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** One line, at most `max` characters, credentials removed. */
export function compactError(text: string | null | undefined, max = 160): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
