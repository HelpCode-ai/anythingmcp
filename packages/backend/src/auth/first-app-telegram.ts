import qrcode from 'qrcode-generator';

/**
 * The one-tap Telegram bot on the page after approving an AI client (see
 * adapters/telegram-managed-bot.ts): its markup, styles and script, kept out
 * of login.controller.ts. Rendered only when this instance has a manager bot
 * and the workspace is offered the feature; without it the page is unchanged.
 *
 * The panel sits inside the app picker and stays hidden until Telegram is
 * picked. Everything in it is optional: "Continue" is never touched here.
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

/** The panel. `withQr`: a desktop browser, which also gets the QR code. */
export function telegramPanelHtml(opts: { withQr: boolean }): string {
  const qr = opts.withQr
    ? `
        <figure class="tg-qr" id="tg-qr" hidden>
          <img id="tg-qr-img" alt="QR code that opens Telegram to create your bot" width="104" height="104">
          <figcaption>Scan with your phone</figcaption>
        </figure>`
    : '';
  return `
      <div class="tg" id="tg-setup" hidden>
        <a class="tg-create" id="tg-create" href="https://t.me/" target="_blank" rel="noopener noreferrer">Create your Telegram bot</a>
        <p class="tg-help" id="tg-help">Telegram opens with a name and a username filled in. Confirm, then press Start in the bot’s chat.</p>${qr}
        <p class="tg-status" id="tg-status" role="status" aria-live="polite"></p>
        <p class="tg-hint" id="tg-hint" hidden>Changed the username in Telegram? Then paste the bot’s token below.</p>
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
             overflow-wrap: anywhere; transition: background .15s; }
  a.tg-create:hover { background: var(--brand-strong); }
  a.tg-create:focus-visible, .tg-paste summary:focus-visible, .tg-token-row button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .tg-help { font-size: 13px; color: var(--text-2); line-height: 1.45; margin: 8px 0 0; }
  .tg-qr { display: flex; align-items: center; gap: 12px; margin: 12px 0 0; }
  .tg-qr img { width: 104px; height: 104px; flex: none; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
  .tg-qr figcaption { font-size: 13px; font-weight: 500; color: var(--text); line-height: 1.45; }
  .tg-status { font-size: 13.5px; font-weight: 500; color: var(--text); margin: 12px 0 0; line-height: 1.45; overflow-wrap: anywhere; }
  .tg-status:empty { margin: 0; }
  /* Once connected, the result comes first and what is left to do follows. */
  .tg[data-state] .tg-status { order: -1; margin: 0 0 4px; }
  .tg[data-state="start"] .tg-status { margin-bottom: 12px; }
  .tg[data-state] .tg-status::before { content: '\\2713\\00a0'; color: var(--ok); font-weight: 700; }
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
      var hint = document.getElementById('tg-hint');
      var paste = document.getElementById('tg-paste');
      var form = document.getElementById('tg-token-form');
      var field = document.getElementById('tg-token');
      var save = document.getElementById('tg-token-save');
      var formStatus = document.getElementById('tg-token-status');
      // Desktop only: the server leaves the QR code out for a phone.
      var qr = document.getElementById('tg-qr');
      var qrImage = document.getElementById('tg-qr-img');
      if (!panel || !picker || !request || !quick || !cont || !create || !help || !status || !hint || !paste ||
          !form || !field || !save || !formStatus || !window.fetch || !window.JSON) return;
      var clientName = cont.getAttribute('data-client') || 'the chat';
      var POLL_MS = 2000;
      var HINT_MS = 60000;
      var GREET_MS = 120000;
      var GIVE_UP_MS = 30 * 60000;
      var startedAt = 0;
      var hintAt = 0;
      var connectedAt = 0;
      var opened = false;
      var openedSent = false;
      var connected = false;
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
        hint.hidden = true;
        paste.hidden = true;
        if (qr) qr.hidden = true;
        if (out.request) request.textContent = out.request;
        // The page opened on "your workspace has no apps yet": no longer true.
        var sub = document.getElementById('first-sub');
        var body = document.getElementById('first-body');
        if (sub) sub.textContent = 'Telegram is ready. Continue to ' + clientName + ' and ask, for example:';
        if (body) body.hidden = true;
        if (out.startUrl) {
          // A bot can only write to someone who pressed Start in its chat.
          create.setAttribute('href', out.startUrl);
          create.textContent = 'Open your bot and press Start';
          help.textContent = 'Your bot can write to you once you have pressed Start in its chat.';
          if (Date.now() - connectedAt > GREET_MS) stop();
        } else {
          create.hidden = true;
          help.hidden = true;
          stop();
        }
      };
      var apply = function (out) {
        // No answer worth reading (offline, too many requests): ask again later.
        if (!out || typeof out.ok !== 'boolean') return;
        if (out.ok !== true || out.state === 'none' || out.state === 'expired') {
          if (!connected) status.textContent = 'This link has expired. Continue, and finish Telegram in ' + clientName + '.';
          return stop();
        }
        if (out.state === 'connected') return showConnected(out);
        // A bot whose username was changed in Telegram cannot be matched.
        if (Date.now() >= hintAt) hint.hidden = false;
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
        if (opened && !openedSent) body.opened = true;
        post('/auth/first-app/telegram/status', body).then(function (out) {
          busy = false;
          if (body.opened && out && out.ok === true) openedSent = true;
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
        // this only notes the click and gives the user a minute from now.
        if (connected) return;
        opened = true;
        hintAt = Date.now() + HINT_MS;
        checkNow();
      });
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
        hintAt = startedAt + HINT_MS;
        create.setAttribute('href', telegram.link);
        // No QR code on a touch device, whatever its user agent says (an
        // iPad asking for the desktop site): the button opens the app there.
        var touch = false;
        try {
          touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        } catch (e) { /* no media queries: treated as a desktop */ }
        if (qr && qrImage && telegram.qr && !touch) {
          qrImage.setAttribute('src', telegram.qr);
          qr.hidden = false;
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
