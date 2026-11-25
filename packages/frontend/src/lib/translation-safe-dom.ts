/**
 * Keeps React from crashing when a script outside the app has rewritten the
 * DOM under it: the browser's page translator above all, on browsers whose
 * language the dashboard does not offer.
 *
 * 1. Text nodes. Google Translate (and Edge, Safari, the Chrome auto-translate
 *    prompt) replaces text nodes with <font> wrappers. React still holds the
 *    originals, so the next render calls removeChild/insertBefore on a node
 *    whose parent is no longer the one React knows, the DOM throws
 *    NotFoundError, and the error boundary replaces the page: a
 *    Russian-speaking visitor translating /login got "Something went wrong"
 *    (ANYTHINGMCP-CLOUD-FRONTEND-3). The workaround is the one the React team
 *    points to (facebook/react#11538): make the two calls a no-op when the
 *    node has already been moved, instead of throwing. It only changes
 *    behaviour on that exceptional path.
 *
 * 2. <body>. React renders the root layout's children through document.body
 *    and assumes it is always there. When another script takes <body> out of
 *    <html> (removes it, or moves it into a wrapper of its own), document.body
 *    is null and every later navigation throws "Cannot read properties of
 *    null (reading 'removeChild')", after React's own "expected a <body>
 *    element" error (ANYTHINGMCP-CLOUD-FRONTEND-T, -V, -X: Chrome in Russian,
 *    Miui Browser in Chinese). The DOM guard of point 1 cannot help, as React
 *    reads the parent from document.body before calling anything. So the
 *    <body> the page was parsed with is put back into <html> as soon as it
 *    leaves, a bounded number of times so it never fights a script forever.
 *    Nothing happens while a <body> is in place, whichever element it is.
 *
 * A repair is a console warning and a Sentry breadcrumb (instrumentation-
 * client.ts drains DOM_GUARD_GLOBAL), never an error: the page keeps working,
 * and an error that does follow still carries the trail of what the guard
 * did. The node repairs are reported once per kind and page (a translated
 * page has dozens), each <body> repair every time.
 *
 * It must run before React does, so it is inlined into <head> by the root
 * layout. Plain ES5: it runs before any polyfill.
 */
export const DOM_GUARD_GLOBAL = '__AMCP_DOM_GUARD__';

/** What the guard repaired, as recorded in DOM_GUARD_GLOBAL. */
export type DomGuardRepair = 'removeChild' | 'insertBefore' | 'body';

export interface DomGuardState {
  /** Repairs reported before a listener was attached, oldest first (at most 50). */
  queue: DomGuardRepair[];
  /** Called on every reported repair once set. */
  listener: ((repair: DomGuardRepair) => void) | null;
}

export const DOM_GUARD_MESSAGES: Record<DomGuardRepair, string> = {
  removeChild: 'removeChild skipped: another script (often the page translator) had already moved the node',
  insertBefore: 'insertBefore skipped: another script (often the page translator) had already moved the reference node',
  body: '<body> put back into <html>: another script had taken it out',
};

export const TRANSLATION_SAFE_DOM_SCRIPT = `(function(){
  if (typeof Node !== 'function' || !Node.prototype) return;
  var messages = ${JSON.stringify(DOM_GUARD_MESSAGES)};
  var state = window.${DOM_GUARD_GLOBAL} = { queue: [], listener: null };
  var warned = {};
  function repaired(kind) {
    var first = !warned[kind];
    warned[kind] = true;
    if (first) try { console.warn('[AnythingMCP] ' + messages[kind]); } catch (e) {}
    if (!first && kind !== 'body') return;
    try {
      if (state.listener) state.listener(kind);
      else if (state.queue.length < 50) state.queue.push(kind);
    } catch (e) {}
  }
  var remove = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) { repaired('removeChild'); return child; }
    return remove.apply(this, arguments);
  };
  var insert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, ref) {
    if (ref && ref.parentNode !== this) { repaired('insertBefore'); return node; }
    return insert.apply(this, arguments);
  };
  var html = document.documentElement;
  if (!html || typeof MutationObserver !== 'function') return;
  var body = null, restores = 0;
  new MutationObserver(function () {
    if (document.body) { body = document.body; return; }
    if (!body || restores >= 5 || document.documentElement !== html) return;
    restores++;
    html.appendChild(body);
    repaired('body');
  }).observe(html, { childList: true });
})();`;
