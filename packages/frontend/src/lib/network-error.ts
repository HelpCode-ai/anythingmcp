/**
 * Recognises the errors a browser raises when a request never got an answer:
 * the machine went offline, woke from sleep before the network was back, or
 * a script chunk could not be downloaded. Each engine words it differently.
 */
const NETWORK_ERROR_MESSAGES = [
  /^Load failed$/i, // Safari
  /^Failed to fetch$/i, // Chrome, Edge
  /^NetworkError when attempting to fetch resource\.?$/i, // Firefox
  /^Network request failed$/i,
  /^Importing a module script failed\.?$/i, // Safari, dynamic import
  /^Failed to fetch dynamically imported module/i, // Chrome, dynamic import
  /^Loading (CSS )?chunk [\w-]+ failed/i, // webpack/turbopack chunk loader
];

export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  if (typeof message !== 'string') return false;
  return NETWORK_ERROR_MESSAGES.some((re) => re.test(message.trim()));
}

const RELOAD_KEY = 'amcp_network_reload_at';
/** One automatic reload per this window, so a page that fails for another reason cannot loop. */
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * Reloads the page once the connection is back: at once if the browser says
 * it is online, otherwise on the next `online` event. Returns a cleanup
 * function. Does nothing if it already reloaded in the last 30 seconds.
 */
export function reloadWhenOnline(): () => void {
  if (typeof window === 'undefined') return () => {};
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {}
  if (Date.now() - last < RELOAD_COOLDOWN_MS) return () => {};

  const reload = () => {
    try {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {}
    window.location.reload();
  };

  if (navigator.onLine) {
    // A moment's grace: a wake from sleep often reports online before DNS works.
    const timer = setTimeout(reload, 2_000);
    return () => clearTimeout(timer);
  }
  window.addEventListener('online', reload, { once: true });
  return () => window.removeEventListener('online', reload);
}
