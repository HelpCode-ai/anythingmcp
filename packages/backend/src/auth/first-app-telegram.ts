import qrcode from 'qrcode-generator';

/**
 * The one-tap Telegram bot on the page after approving an AI client (see
 * adapters/telegram-managed-bot.ts): its markup, styles and script, kept out
 * of login.controller.ts. Rendered only when this instance has a manager bot
 * and the workspace is offered the feature; without it the page is unchanged.
 *
 * The panel sits inside the app picker and stays hidden until Telegram is
 * picked. Everything in it is optional: "Continue" is never touched here.
 * Once the bot is connected the panel says that one step is left, Continue,
 * and scrolls that button into view; it never follows it for the user.
 *
 * Its links are ordinary `<a target="_blank">`s, each on its own button:
 * - "Create your Telegram bot" opens Telegram on the creation screen. On a
 *   computer that is the Telegram app, if there is one; beside the QR code
 *   for the phone, "open Telegram Web in this browser" does the same in
 *   Telegram's web client, for someone with neither app nor phone at hand;
 * - "Changed the username? Link your bot" opens the manager bot's chat with
 *   the setup's code, for a bot whose username names no setup. It appears
 *   when the server saw such a bot, or when no bot arrived in time.
 */

/**
 * The creation link as a QR code, for a desktop browser: most users have
 * Telegram on their phone. An SVG in a data URI, so it is set as an image
 * source and never parsed as markup.
 */
export function telegramQrDataUri(link: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  // Four modules of quiet zone, as the standard asks.
  const svg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** The panel. `withQr`: a desktop browser, which also gets the QR codes. */
export function telegramPanelHtml(opts: { withQr: boolean }): string {
  const qr = opts.withQr
    ? `
        <figure class="tg-qr" id="tg-qr" hidden>
          <img id="tg-qr-img" alt="QR code that opens Telegram to create your bot" width="104" height="104">
          <figcaption>Scan with your phone<a class="tg-web" id="tg-web" href="https://web.telegram.org/a/" target="_blank" rel="noopener noreferrer" hidden>or open Telegram Web in this browser</a></figcaption>
        </figure>`
    : '';
  // Beside the button, not under it: the panel stays short.
  const linkQr = opts.withQr
    ? `
          <figure class="tg-qr" id="tg-link-qr" hidden>
            <img id="tg-link-qr-img" alt="QR code that opens Telegram to link your bot" width="104" height="104">
          </figure>`
    : '';
  const linkHint = opts.withQr
    ? 'Telegram opens our setup bot: press Start there, then come back here. Bot made on your phone? Scan the code.'
    : 'Telegram opens our setup bot: press Start there, then come back here.';
  const linkWeb = opts.withQr
    ? `
            <a class="tg-web" id="tg-link-web" href="https://web.telegram.org/a/" target="_blank" rel="noopener noreferrer" hidden>Or open it in Telegram Web</a>`
    : '';
  return `
      <div class="tg" id="tg-setup" hidden>
        <a class="tg-create" id="tg-create" href="https://t.me/" target="_blank" rel="noopener noreferrer">Create your Telegram bot</a>
        <p class="tg-help" id="tg-help">This creates a new bot that belongs to you: it appears in your own @BotFather list, and you can rename it, add a picture and use it with your customers. Already have a bot? Paste its token below.</p>${qr}
        <p class="tg-status" id="tg-status" role="status" aria-live="polite"></p>
        <p class="tg-next" id="tg-next" role="status" aria-live="polite" hidden></p>
        <div class="tg-link" id="tg-link" hidden>${linkQr}
          <div class="tg-link-main">
            <a class="tg-link-btn" id="tg-link-btn" href="https://t.me/" target="_blank" rel="noopener noreferrer">Changed the username? Link your bot</a>
            <p class="tg-hint" id="tg-hint">${linkHint}</p>${linkWeb}
          </div>
        </div>
        <details class="tg-paste" id="tg-paste">
          <summary>Already have a bot? Paste its token</summary>
          <ol class="tg-steps">
            <li>In Telegram, open @BotFather and send /mybots (or /newbot for a new bot).</li>
            <li>Pick the bot, choose API Token, and paste the token here.</li>
          </ol>
          <form id="tg-token-form" novalidate>
            <label for="tg-token">Bot token</label>
            <div class="tg-token-row">
              <input type="text" id="tg-token" class="other" maxlength="120" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="123456789:AAH...">
              <button type="submit" class="secondary" id="tg-token-save">Save</button>
            </div>
          </form>
          <p class="tg-token-status" id="tg-token-status" role="status" aria-live="polite"></p>
        </details>
      </div>`;
}

/** The line the app picker's script runs after a pick, to hand the link over. */
export const TELEGRAM_PICK_HOOK = `
            if (out.telegram && window.amcpTelegram) window.amcpTelegram(out.telegram);`;

export const TELEGRAM_PANEL_STYLES = `
  .quick[data-telegram] .other-label, .quick[data-telegram] #other-app { display: none; }
  .tg { display: flex; flex-direction: column; border-top: 1px solid var(--border); margin: 4px 0 8px; padding-top: 12px; }
  .tg[hidden], .tg [hidden] { display: none !important; }
  a.tg-create { font: inherit; font-size: 15px; font-weight: 600; line-height: 1.3; min-height: 46px; width: 100%; padding: 8px 14px;
             display: flex; align-items: center; justify-content: center; text-align: center; text-decoration: none;
             border: 1px solid var(--brand); border-radius: 10px; background: var(--brand); color: #fff;
             overflow-wrap: anywhere; text-wrap: balance; transition: background .15s; }
  a.tg-create:hover { background: var(--brand-strong); }
  a.tg-create:focus-visible, a.tg-link-btn:focus-visible, .tg-paste summary:focus-visible, .tg-token-row button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  /* The second way in, for a bot whose username was changed: quieter than the first. */
  .tg-link { display: flex; align-items: flex-start; gap: 12px; margin: 12px 0 0; }
  .tg-link .tg-qr { margin: 0; flex: none; }
  .tg-link-main { flex: 1; min-width: 0; }
  a.tg-link-btn { font: inherit; font-size: 14.5px; font-weight: 600; line-height: 1.3; min-height: 44px; width: 100%; padding: 8px 12px;
             display: flex; align-items: center; justify-content: center; text-align: center; text-decoration: none;
             border: 1.5px solid var(--brand); border-radius: 10px; background: #fff; color: var(--brand-strong);
             text-wrap: balance; transition: background .15s; }
  a.tg-link-btn:hover { background: var(--tint); }
  .tg-help { font-size: 13px; color: var(--text-2); line-height: 1.45; margin: 8px 0 0; }
  .tg-qr { display: flex; align-items: center; gap: 12px; margin: 12px 0 0; }
  .tg-qr img { width: 104px; height: 104px; flex: none; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
  .tg-qr figcaption { font-size: 13px; font-weight: 500; color: var(--text); line-height: 1.45; }
  /* Telegram in the browser: the way in without the app or the phone. */
  a.tg-web { display: block; width: fit-content; margin: 4px 0 0; font-size: 13px; font-weight: 600; color: var(--brand); text-decoration: underline; text-underline-offset: 2px; border-radius: 4px; }
  a.tg-web:hover { color: var(--brand-strong); }
  a.tg-web:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .tg-status { font-size: 13.5px; font-weight: 500; color: var(--text); margin: 12px 0 0; line-height: 1.45; overflow-wrap: anywhere; }
  .tg-status:empty { margin: 0; }
  /* Once connected, the result comes first and what is left to do follows. */
  .tg[data-state] .tg-status { order: -2; margin: 0 0 4px; }
  .tg[data-state] .tg-status::before { content: '\\2713\\00a0'; color: var(--ok); font-weight: 700; }
  .tg-next { order: -1; font-size: 14px; font-weight: 600; color: var(--text); line-height: 1.45; margin: 0 0 8px; text-wrap: balance; }
  .tg[data-state="start"] .tg-next { margin-bottom: 12px; }
  /* Telegram is done: Continue is what is left, so it is the one thing that stands out. */
  .quick[data-telegram="done"] ~ a.button { box-shadow: 0 0 0 4px rgba(37,99,235,.22); }
  @media (prefers-reduced-motion: no-preference) {
    .quick[data-telegram="done"] ~ a.button { animation: tg-continue 1.6s ease-out 2; }
    @keyframes tg-continue { 0% { box-shadow: 0 0 0 0 rgba(37,99,235,.45); } 100% { box-shadow: 0 0 0 4px rgba(37,99,235,.22); } }
  }
  .tg-hint { font-size: 13px; color: var(--text-2); margin: 8px 0 0; line-height: 1.45; }
  .tg-paste { margin: 8px 0 0; font-size: 13px; }
  .tg-paste summary { cursor: pointer; color: var(--brand); font-weight: 500; padding: 6px 0; border-radius: 6px; }
  .tg-steps { color: var(--text-2); line-height: 1.5; margin: 4px 0 12px; padding-left: 18px; }
  .tg-steps li { margin: 0 0 2px; }
  .tg-token-row { display: flex; gap: 8px; }
  .tg-token-row input.other { flex: 1; min-width: 0; margin: 0; }
  .tg-token-row button { width: auto; min-height: 38px; padding: 0 14px; font-size: 14px; flex: none; }
  .tg-token-row button[aria-disabled="true"] { cursor: default; color: var(--text-3); }
  .tg-token-status { font-size: 13px; color: var(--text-2); margin: 8px 0 0; line-height: 1.45; overflow-wrap: anywhere; }
  .tg-token-status:empty { margin: 0; }
  @media (pointer: coarse) {
    .tg-paste summary { padding: 12px 0; }
    .tg-token-row input.other { height: 44px; font-size: 16px; }
    .tg-token-row button { min-height: 44px; }
  }`;

/**
 * The panel's script, appended to the page's one script block. The app
 * picker calls `window.amcpTelegram` with the link once Telegram was added.
 *
 * It asks the status endpoint every two seconds while the page is visible,
 * and at once when the user comes back to it (on a phone they leave for
 * Telegram). It never navigates and adds nothing to the Continue link: a
 * second tab opened from Continue broke the hand-back on phones.
 */
export const TELEGRAM_PANEL_SCRIPT = `
    // The one-tap Telegram bot: a link that creates the bot in Telegram, and
    // a check every two seconds for its token. Continue is not touched.
    (function () {
      var panel = document.getElementById('tg-setup');
      var picker = document.getElementById('quick-apps');
      var request = document.getElementById('example-request');
      var quick = document.getElementById('quick-status');
      var cont = document.getElementById('continue');
      var create = document.getElementById('tg-create');
      var help = document.getElementById('tg-help');
      var status = document.getElementById('tg-status');
      var next = document.getElementById('tg-next');
      var link = document.getElementById('tg-link');
      var linkButton = document.getElementById('tg-link-btn');
      var paste = document.getElementById('tg-paste');
      var form = document.getElementById('tg-token-form');
      var field = document.getElementById('tg-token');
      var save = document.getElementById('tg-token-save');
      var formStatus = document.getElementById('tg-token-status');
      // Desktop only: the server leaves the QR codes out for a phone.
      var qr = document.getElementById('tg-qr');
      var qrImage = document.getElementById('tg-qr-img');
      var linkQr = document.getElementById('tg-link-qr');
      var linkQrImage = document.getElementById('tg-link-qr-img');
      var web = document.getElementById('tg-web');
      var linkWeb = document.getElementById('tg-link-web');
      if (!panel || !picker || !request || !quick || !cont || !create || !help || !status || !next || !link || !linkButton || !paste ||
          !form || !field || !save || !formStatus || !window.fetch || !window.JSON) return;
      var clientName = cont.getAttribute('data-client') || 'the chat';
      var POLL_MS = 2000;
      // "Link your bot" appears when the server saw a bot with another
      // username, or by time: a bot with the suggested username is connected
      // within seconds of its creation, so 20 seconds after the click on the
      // link (a minute when the QR code is used, which no click reports).
      var LINK_AFTER_CLICK_MS = 20000;
      var LINK_AFTER_PICK_MS = 60000;
      var GREET_MS = 120000;
      var GIVE_UP_MS = 30 * 60000;
      var startedAt = 0;
      var linkAt = 0;
      var connectedAt = 0;
      var opened = false;
      var openedVia = 'app';
      var openedSent = false;
      var offered = false;
      var offeredSent = false;
      var claimed = false;
      var touch = false;
      var claimQr = '';
      var connected = false;
      var shownContinue = false;
      var stopped = false;
      var busy = false;
      var saving = false;
      var timer = null;
      var post = function (path, body) {
        body.csrf = picker.getAttribute('data-csrf');
        return fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) {
          return r.json().catch(function () { return {}; });
        });
      };
      var stop = function () {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
      };
      var showConnected = function (out) {
        if (!connected) { connected = true; connectedAt = Date.now(); }
        // 'start': connected, and the user has not pressed Start in the bot's chat yet.
        panel.setAttribute('data-state', out.startUrl ? 'start' : 'connected');
        status.textContent = 'Telegram is connected' + (out.bot ? ': ' + out.bot : '') + '.';
        quick.textContent = '';
        link.hidden = true;
        paste.hidden = true;
        if (qr) qr.hidden = true;
        if (out.request) request.textContent = out.request;
        // The page opened on "your workspace has no apps yet": no longer true.
        var sub = document.getElementById('first-sub');
        var body = document.getElementById('first-body');
        if (sub) sub.textContent = 'Telegram is ready. Continue to ' + clientName + ' and ask, for example:';
        if (body) body.hidden = true;
        // The AI client is not connected yet: only Continue finishes that.
        // Said in so many words, because people stopped here for minutes.
        next.hidden = false;
        if (out.startUrl) {
          // A bot can only write to someone who pressed Start in its chat.
          create.setAttribute('href', out.startUrl);
          create.textContent = 'Open your bot and press Start';
          help.textContent = 'Your bot can write to you once you have pressed Start in its chat.';
          next.textContent = 'Two steps left: press Start in your bot’s chat, then tap Continue to ' + clientName + ' below.';
          if (Date.now() - connectedAt > GREET_MS) stop();
        } else {
          create.hidden = true;
          help.hidden = true;
          next.textContent = 'Last step: tap Continue to ' + clientName + ' below.';
          picker.setAttribute('data-telegram', 'done');
          showContinue();
          stop();
        }
      };
      // Continue is brought into view, once; the tap stays the user's.
      var showContinue = function () {
        if (shownContinue) return;
        shownContinue = true;
        try {
          if (cont.scrollIntoView) cont.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (e) { /* an old browser: the button is a few lines below */ }
      };
      var apply = function (out) {
        // No answer worth reading (offline, too many requests): ask again later.
        if (!out || typeof out.ok !== 'boolean') return;
        if (out.ok !== true || out.state === 'none' || out.state === 'expired') {
          if (!connected) {
            status.textContent = 'This link has expired. Go back to ' + clientName + ' and press Connect again.';
            link.hidden = true;
          }
          return stop();
        }
        if (out.state === 'connected') return showConnected(out);
        if (out.claimed) {
          // Start was pressed in the setup bot's chat before any bot existed:
          // whatever bot this Telegram account creates now is connected.
          claimed = true;
          link.hidden = true;
          status.textContent = 'Your Telegram account is linked. Now create your bot: any username works.';
          return;
        }
        // A bot whose username was changed carries no code: its creator
        // links it by pressing Start in the setup bot's chat.
        if (!claimed && (out.unmatched === true || Date.now() >= linkAt)) showLink();
      };
      var showLink = function () {
        if (offered || connected || !linkButton.getAttribute('data-ready')) return;
        offered = true;
        link.hidden = false;
        if (linkQr && linkQrImage && claimQr && !touch) {
          linkQrImage.setAttribute('src', claimQr);
          linkQr.hidden = false;
        }
      };
      var again = function () {
        if (!stopped && !timer) timer = setTimeout(check, POLL_MS);
      };
      var check = function () {
        timer = null;
        if (stopped || busy) return;
        // Not in the background: coming back to the page checks at once.
        if (document.hidden) return;
        if (Date.now() - startedAt > GIVE_UP_MS) return stop();
        busy = true;
        var body = {};
        if (opened && !openedSent) { body.opened = true; body.via = openedVia; }
        if (offered && !offeredSent) body.offered = true;
        post('/auth/first-app/telegram/status', body).then(function (out) {
          busy = false;
          if (body.opened && out && out.ok === true) openedSent = true;
          if (body.offered && out && out.ok === true) offeredSent = true;
          apply(out);
          again();
        }, function () {
          busy = false;
          again();
        });
      };
      var checkNow = function () {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        check();
      };
      create.addEventListener('click', function () {
        // The link itself opens Telegram (a new tab, or the app on a phone):
        // this only notes the click and counts the wait from now.
        if (connected) return;
        opened = true;
        linkAt = Date.now() + LINK_AFTER_CLICK_MS;
        checkNow();
      });
      linkButton.addEventListener('click', function () {
        // Again the link itself opens Telegram; the answer is asked for at once.
        if (!connected) checkNow();
      });
      // Telegram in the browser (a computer only): the same two links, opened
      // in Telegram's web client. Again only noted; the link does the opening.
      if (web) {
        web.addEventListener('click', function () {
          if (connected) return;
          if (!opened) openedVia = 'web';
          opened = true;
          linkAt = Date.now() + LINK_AFTER_CLICK_MS;
          checkNow();
        });
      }
      if (linkWeb) {
        linkWeb.addEventListener('click', function () {
          if (!connected) checkNow();
        });
      }
      form.addEventListener('submit', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        if (saving || connected) return;
        var token = (field.value || '').replace(/\\s+/g, '');
        if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(token)) {
          formStatus.textContent = 'This does not look like a bot token. Paste the whole value from @BotFather, like 123456789:AAH...';
          return;
        }
        saving = true;
        save.setAttribute('aria-disabled', 'true');
        formStatus.textContent = 'Checking the token with Telegram…';
        var done = function (out) {
          saving = false;
          save.setAttribute('aria-disabled', 'false');
          if (!out || out.ok !== true) {
            formStatus.textContent = (out && out.error) || 'The token could not be saved. Try again.';
            return;
          }
          field.value = '';
          formStatus.textContent = '';
          showConnected(out);
        };
        post('/auth/first-app/telegram/token', { token: token }).then(done, function () { done(null); });
      });
      window.amcpTelegram = function (telegram) {
        if (!telegram || !telegram.link || startedAt) return;
        startedAt = Date.now();
        linkAt = startedAt + LINK_AFTER_PICK_MS;
        create.setAttribute('href', telegram.link);
        if (telegram.claim) {
          linkButton.setAttribute('href', telegram.claim);
          linkButton.setAttribute('data-ready', '1');
          claimQr = telegram.claimQr || '';
        }
        if (linkWeb && telegram.claimWeb) {
          linkWeb.setAttribute('href', telegram.claimWeb);
          linkWeb.hidden = false;
        }
        // No QR code on a touch device, whatever its user agent says (an
        // iPad asking for the desktop site): the button opens the app there.
        try {
          touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        } catch (e) { /* no media queries: treated as a desktop */ }
        if (qr && qrImage && telegram.qr && !touch) {
          qrImage.setAttribute('src', telegram.qr);
          qr.hidden = false;
          if (web && telegram.web) {
            web.setAttribute('href', telegram.web);
            web.hidden = false;
          }
        }
        picker.setAttribute('data-telegram', 'on');
        quick.textContent = 'Telegram added. Create its bot now, or continue and finish it in ' + clientName + '.';
        status.textContent = 'Waiting for your bot…';
        panel.hidden = false;
        if (document.addEventListener) {
          document.addEventListener('visibilitychange', function () { if (!document.hidden) checkNow(); });
        }
        if (window.addEventListener) window.addEventListener('focus', checkNow);
        again();
      };
    })();`;
