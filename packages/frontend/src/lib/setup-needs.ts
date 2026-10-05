/** "Bot token", "Sign in · Keystring and Shared secret", ... (sign-in first: cards truncate the end). */
export function setupNeeds(a: { setupKind?: string; needs?: string[] }): string {
  const needs = a.needs ?? [];
  const list = needs.length <= 1 ? needs.join('') : `${needs.slice(0, -1).join(', ')} and ${needs[needs.length - 1]}`;
  if (a.setupKind === 'none') return 'No account needed';
  if (a.setupKind === 'oauth_browser') return list ? `Sign in · ${list}` : 'Sign in with your account';
  return list || 'API key';
}
