/**
 * Signs the recording browser in as the Lumen & Clay demo user of the mock
 * backend, and rewrites the dev host into the cloud host wherever it would be
 * visible (the MCP endpoint URL on the server page), so the recording reads
 * as AnythingMCP Cloud.
 */
import type { BrowserContext } from 'playwright-core';

export const APP = 'http://localhost:3100';

const USER = {
  id: 'usr_alex',
  email: 'alex@lumenandclay.example',
  name: 'Alex Rivera',
  role: 'ADMIN',
  organizationId: 'org_lumen',
  emailVerified: true,
};

export async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: 'amcp_token', value: 'demo-token', url: APP }]);
  // A plain string: functions serialised from tsx carry esbuild's __name
  // helper, which does not exist in the page.
  await context.addInitScript(`(() => {
    if (location.origin !== ${JSON.stringify(APP)}) return;
    localStorage.setItem('amcp_token', 'demo-token');
    localStorage.setItem('amcp_user', ${JSON.stringify(JSON.stringify(USER))});
    localStorage.setItem('theme', 'light');
    const re = /https?:\\/\\/localhost:(4000|3100)/g;
    const fix = (s) => s.replace(re, 'https://cloud.anythingmcp.com');
    const walk = (root) => {
      if (!root) return;
      if (root.nodeType === 3) {
        if (re.test(root.nodeValue)) root.nodeValue = fix(root.nodeValue);
        re.lastIndex = 0;
        return;
      }
      const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (n.nodeValue && n.nodeValue.includes('localhost:')) n.nodeValue = fix(n.nodeValue);
      }
      if (root.querySelectorAll) {
        root.querySelectorAll('input, textarea, [contenteditable]').forEach((i) => {
          // No red spell-check squiggles under pasted keys and URLs.
          i.spellcheck = false;
          if (i.value && i.value.includes('localhost:')) i.value = fix(i.value);
        });
      }
    };
    // A short window title instead of the page's long marketing title.
    const retitle = () => { if (document.title !== 'AnythingMCP') document.title = 'AnythingMCP'; };
    new MutationObserver((muts) => {
      retitle();
      for (const m of muts) {
        if (m.type === 'characterData') walk(m.target);
        m.addedNodes.forEach(walk);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    document.addEventListener('DOMContentLoaded', () => walk(document.body));
  })();`);
}

/**
 * The AnythingMCP consent page says "Signed in as <email>" for the real
 * cloud account that owns the demo server; show the demo user instead of
 * any address on that page.
 */
export async function maskCloudIdentity(context: BrowserContext): Promise<void> {
  await context.addInitScript(`(() => {
    if (location.origin !== 'https://cloud.anythingmcp.com') return;
    const swap = () => {
      const it = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (n.nodeValue && n.nodeValue.includes('@') && !n.nodeValue.includes(${JSON.stringify(USER.email)})) {
          n.nodeValue = n.nodeValue.replace(/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g, ${JSON.stringify(USER.email)});
        }
      }
    };
    new MutationObserver(swap).observe(document, { subtree: true, childList: true, characterData: true });
    document.addEventListener('DOMContentLoaded', swap);
  })();`);
}

/**
 * claude.ai shows "Want to be notified when Claude responds?" over the
 * composer while an answer runs, whatever the notification permission.
 */
export async function hideClaudeNudges(context: BrowserContext): Promise<void> {
  await context.addInitScript(`(() => {
    if (location.origin !== 'https://claude.ai') return;
    const hide = () => {
      const it = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (!n.nodeValue || !n.nodeValue.includes('Want to be notified')) continue;
        let el = n.parentElement;
        // Up to the box that holds both the Notify button and its close (×) button.
        while (el && el.parentElement && el.querySelectorAll('button').length < 2) el = el.parentElement;
        if (el) el.style.display = 'none';
      }
    };
    new MutationObserver(hide).observe(document, { subtree: true, childList: true, characterData: true });
  })();`);
}
