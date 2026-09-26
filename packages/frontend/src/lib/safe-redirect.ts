/**
 * The post-sign-in target from `?redirect=`, or `fallback` when it would
 * leave this origin.
 *
 * `redirect` arrives in a URL anyone can craft, so `?redirect=https://evil`
 * (or `//evil`, `/\evil`, a tab-smuggled `/\t/evil`) must never be followed:
 * that turns our sign-in page into a phishing launcher. Resolving against a
 * placeholder origin and requiring the origin to survive catches every form
 * the browser itself would treat as off-site.
 */
const PLACEHOLDER = 'https://amcp.invalid';

export function safeRedirect(target: string | null | undefined, fallback = '/'): string {
  if (!target || !target.startsWith('/') || /[\u0000-\u001f\\]/.test(target)) return fallback;
  try {
    const url = new URL(target, PLACEHOLDER);
    if (url.origin !== PLACEHOLDER) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
