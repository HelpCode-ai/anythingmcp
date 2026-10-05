/**
 * Copy text and report whether it worked.
 *
 * navigator.clipboard is missing on plain-HTTP origins (self-hosted on a LAN
 * address) and rejects with NotAllowedError when the browser denies the
 * permission (Safari after a delay, embedded webviews, some privacy settings).
 * Either way we fall back to a hidden textarea + execCommand('copy'), and the
 * caller only says "Copied" when one of the two actually succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not focused: try the fallback below.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
