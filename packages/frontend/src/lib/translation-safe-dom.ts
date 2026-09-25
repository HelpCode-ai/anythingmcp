/**
 * Keeps React from crashing when the browser's page translator has rewritten
 * the DOM under it.
 *
 * Google Translate (and Edge, Safari, the Chrome auto-translate prompt)
 * replaces text nodes with <font> wrappers. React still holds the originals,
 * so the next render calls removeChild/insertBefore on a node whose parent is
 * no longer the one React knows, the DOM throws NotFoundError, and the error
 * boundary replaces the page: a Russian-speaking visitor translating /login
 * got "Something went wrong" (ANYTHINGMCP-CLOUD-FRONTEND-3).
 *
 * The workaround is the one the React team points to (facebook/react#11538):
 * make the two calls a no-op when the node has already been moved, instead of
 * throwing. It only changes behaviour on that exceptional path. It must run
 * before React does, so it is inlined into <head> by the root layout.
 */
export const TRANSLATION_SAFE_DOM_SCRIPT = `(function(){
  if (typeof Node !== 'function' || !Node.prototype) return;
  var remove = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) return child;
    return remove.apply(this, arguments);
  };
  var insert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, ref) {
    if (ref && ref.parentNode !== this) return node;
    return insert.apply(this, arguments);
  };
})();`;
