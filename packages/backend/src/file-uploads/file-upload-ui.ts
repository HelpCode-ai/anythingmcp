/**
 * The upload box an AI app shows with a file_upload_link result (MCP Apps,
 * SEP-1865): a `ui://` HTML resource rendered in a sandboxed iframe inside the
 * chat. The user picks the file the AI created (after saving it from the chat)
 * and the box sends it straight to the one-time upload link, then tells the AI
 * in the chat that the file is there.
 *
 * Needed because AI code sandboxes often cannot reach AnythingMCP: on Claude
 * Free, Pro and Max the sandbox reaches package managers only and no domain
 * can be added. The box runs in the user's browser, so no sandbox network is
 * involved. Apps without MCP Apps support ignore it and the model offers
 * browser_upload_url instead.
 *
 * Self-contained on purpose: no external scripts or styles (the default MCP App
 * CSP allows inline code only), and the only network target is our own upload
 * endpoint, declared in `connectDomains`.
 */

export const UPLOAD_UI_URI = 'ui://anythingmcp/file-upload';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

export function uploadUiMeta(serverOrigin: string) {
  return { ui: { csp: { connectDomains: [serverOrigin] }, prefersBorder: true } };
}

export const UPLOAD_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload a file</title>
<style>
  :root { color-scheme: light dark; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --ok:#15803d; --err:#b91c1c; --bg:#ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f3f4f6; --muted:#9ca3af; --line:#374151; --brand:#60a5fa; --ok:#4ade80; --err:#f87171; --bg:transparent; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:14px 16px; font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  .row { display:flex; align-items:center; gap:10px; }
  .name { font-weight:600; word-break:break-all; }
  .muted { color:var(--muted); font-size:12.5px; }
  .drop { margin-top:10px; border:1.5px dashed var(--line); border-radius:10px; padding:14px; text-align:center; }
  .drop.over { border-color:var(--brand); }
  button, label.btn { display:inline-block; border:0; border-radius:8px; padding:8px 14px; font:600 13.5px system-ui,sans-serif; cursor:pointer; background:var(--brand); color:#fff; }
  button.link { background:none; color:var(--brand); padding:0; font-weight:500; text-decoration:underline; }
  input[type=file] { position:absolute; width:1px; height:1px; opacity:0; }
  .ok { color:var(--ok); font-weight:600; }
  .err { color:var(--err); }
  .bar { height:4px; background:var(--line); border-radius:2px; overflow:hidden; margin-top:8px; }
  .bar > i { display:block; height:100%; width:0; background:var(--brand); transition:width .2s; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
  <div id="loading" class="muted">Preparing the upload…</div>
  <div id="main" hidden>
    <div class="row"><span aria-hidden="true">📎</span><div><div class="name" id="fname"></div><div class="muted" id="limit"></div></div></div>
    <div id="pick">
      <div class="drop" id="drop">
        <div class="muted" style="margin-bottom:8px">Save the file from the chat, then choose it here (or drop it on this box).</div>
        <label class="btn" for="file">Choose file</label>
        <input type="file" id="file">
      </div>
      <div class="muted" style="margin-top:8px">Can't choose a file here? <button class="link" id="open">Open the upload page in your browser</button></div>
    </div>
    <div id="progress" hidden><div class="muted" id="ptext">Uploading…</div><div class="bar"><i id="pbar"></i></div></div>
    <div id="done" hidden><span class="ok">✓ Uploaded.</span> <span class="muted" id="dtext"></span></div>
    <div id="error" class="err" hidden style="margin-top:8px"></div>
  </div>
<script>
(function () {
  var nextId = 1, pending = {}, info = null, sent = false;
  function post(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 15000);
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).hidden = !on; }
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }
  function fail(text) { $('error').textContent = text; show('error', true); }
  function resize() { notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }); }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && pending[m.id] && (('result' in m) || ('error' in m))) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || 'error')); else p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') onResult(m.params || {});
    else if (m.method === 'ui/resource-teardown' && m.id != null) post({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.method === 'ping' && m.id != null) post({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  function parseResult(r) {
    if (r.structuredContent && r.structuredContent.upload_url) return r.structuredContent;
    var c = (r.content || []).filter(function (x) { return x && x.type === 'text'; })[0];
    try { return c ? JSON.parse(c.text) : null; } catch (err) { return null; }
  }

  function onResult(r) {
    show('loading', false); show('main', true);
    info = r.isError ? null : parseResult(r);
    if (!info || !info.upload_url) {
      $('fname').textContent = 'No upload link';
      show('pick', false);
      var c = (r.content || [])[0];
      fail(c && c.text ? c.text : 'The upload link could not be created.');
      return;
    }
    $('fname').textContent = info.filename || 'File';
    $('limit').textContent = info.max_bytes ? 'Up to ' + mb(info.max_bytes) + ' · link works for 15 minutes' : '';
    fetch(info.upload_url, { method: 'GET' }).then(function (res) { return res.ok ? res.json() : null; }).then(function (s) {
      if (s && s.state === 'uploaded') finished(s.bytes, false);
      else if (s && s.state === 'expired') { show('pick', false); fail('This upload link has expired or was already used. Ask the AI for a new one.'); }
    }).catch(function () {});
  }

  function finished(bytes, tell) {
    show('pick', false); show('progress', false); show('error', false); show('done', true);
    $('dtext').textContent = bytes ? '(' + mb(bytes) + ')' : '';
    if (tell && !sent && info) {
      sent = true;
      var text = 'I uploaded ' + (info.filename || 'the file') + ' in the upload box (' + info.file_ref + '). Please continue with it.';
      var block = [{ type: 'text', text: text }];
      // Context first (kept for the model's next turn even if the message is
      // refused), then the chat message that makes the AI continue at once.
      request('ui/update-model-context', { content: block }).catch(function () {});
      request('ui/message', { role: 'user', content: block })
        .then(function (r) {
          if (r && r.isError) throw new Error('refused');
          $('dtext').textContent += ' The AI has been told.';
        })
        .catch(function () { $('dtext').textContent += ' Now tell the AI "uploaded" to continue.'; });
    }
  }

  function ext(name) { var i = (name || '').lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : ''; }
  var confirmed = null;
  function upload(file) {
    if (!info || !file) return;
    show('error', false);
    var want = ext(info.filename), got = ext(file.name);
    if (want && got !== want && confirmed !== file) {
      confirmed = file;
      fail('You picked ' + file.name + ', but the AI asked for ' + info.filename + '. Choose that file, or pick ' + file.name + ' again to upload it anyway.');
      $('file').value = '';
      return;
    }
    if (info.max_bytes && file.size > info.max_bytes) { fail('This file is ' + mb(file.size) + '; the limit is ' + mb(info.max_bytes) + '.'); return; }
    show('pick', false); show('progress', true);
    $('ptext').textContent = 'Uploading ' + file.name + '…';
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', info.upload_url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) $('pbar').style.width = Math.round(100 * ev.loaded / ev.total) + '%'; };
    xhr.onload = function () {
      var body = null; try { body = JSON.parse(xhr.responseText); } catch (err) {}
      if (xhr.status >= 200 && xhr.status < 300) { finished(body && body.bytes, true); return; }
      show('progress', false);
      if (xhr.status === 409 || xhr.status === 410) { fail((body && body.message) || 'This upload link was already used or has expired. Ask the AI for a new one.'); return; }
      show('pick', true);
      fail((body && body.message) || ('Upload failed (' + xhr.status + '). Try again.'));
    };
    xhr.onerror = function () { show('progress', false); show('pick', true); fail('The upload did not go through. Check your connection, or open the upload page in your browser.'); };
    xhr.send(file);
  }

  $('file').addEventListener('change', function (e) { upload(e.target.files && e.target.files[0]); });
  var drop = $('drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files && e.dataTransfer.files[0]); });
  $('open').addEventListener('click', function () {
    if (!info || !info.browser_upload_url) return;
    request('ui/open-link', { url: info.browser_upload_url }).catch(function () { window.open(info.browser_upload_url, '_blank', 'noopener'); });
  });

  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'AnythingMCP file upload', version: '1.0.0' },
    appCapabilities: {},
  }).then(function () { notify('ui/notifications/initialized', {}); resize(); })
    .catch(function () { notify('ui/notifications/initialized', {}); });
})();
</script>
</body>
</html>`;
