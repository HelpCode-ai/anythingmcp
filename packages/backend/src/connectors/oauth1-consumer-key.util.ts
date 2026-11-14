import { BadRequestException } from '@nestjs/common';

/**
 * Whether a credential field holds an e-mail address rather than a key.
 * Written without a backtracking regex: the value is user input, and the
 * equivalent `^[^\s@/]+@[^\s@/]+\.[^\s@/]+$` is polynomial on crafted
 * strings (CodeQL js/polynomial-redos).
 */
export function looksLikeEmail(value: string): boolean {
  if (value.length > 320 || /[\s/]/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

/**
 * Refuse an e-mail address as an OAuth 1.0a consumer key. Two
 * ImmobilienScout24 installs had the account's login there, and IS24 answered
 * "Consumer not found" to every call; no provider issues keys of that shape.
 * `source` names where the value came from (an environment variable) when it
 * was not typed into the consumer key field itself.
 */
export function assertConsumerKeyIsNotEmail(value: string, source?: string): void {
  if (!looksLikeEmail(value)) return;
  throw new BadRequestException(
    `The consumer key${source ? ` (${source})` : ''} looks like an e-mail ` +
      'address. It is the key of the application registered with the ' +
      'provider, not your login — copy it from the provider\'s developer or ' +
      'API-key page.',
  );
}
