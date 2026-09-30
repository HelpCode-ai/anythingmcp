# AnythingMCP demo video ("Lumen & Clay")

Source of the product demo on anythingmcp.com/video-promo and in the README (2:40, English).
No voice-over: on-screen type, captions, music, and screen recordings of the product and of Claude.

The story: *Lumen & Clay*, a fictional ceramics studio, sells on Etsy, runs SAP S/4HANA and
has its own logistics API. The video connects all three through AnythingMCP (a marketplace
adapter, a custom OData connector, an OpenAPI import) and ends with Claude answering a
question that spans them. **All data is fictional**: nothing here touches a real shop, SAP
system or customer.

```
fixtures/      the one source of the Lumen & Clay data (products, orders, SAP, logistics)
mock-api/      mock backend (Etsy v3, SAP Gateway OData V2, logistics API): Worker-style handler, run on Node
director/      drives the recordings: real-cursor input helper, mock backend, scene scripts
styleframes/   Claude Design brief (the exported styleframes stay local)
compositions/  HyperFrames project: build.py generates index.html from the cut list
export-web.py  web and README files derived from the final render
footage/       raw Recordly exports (git-ignored; compositions/assets/footage/ too)
renders/       final renders and web files (git-ignored)
```

## 1. Mock backend

```bash
cd mock-api
npm install
npm run dev              # local, http://localhost:8787 (wrangler)
npm run build:node       # dist/server.mjs, the same handler on plain Node
```

On AnythingMCP Cloud it runs as an internal container next to the backend, with no
public port. The backend reaches it by a dotted network alias (connector base URLs must
contain a dot), which is on the instance SSRF allowlist:

```bash
scp dist/server.mjs root@<droplet>:/opt/lumen-demo-api/server.mjs
docker run -d --name lumen-demo-api --network amcp-cloud_default \
  --network-alias demo-api.lumenandclay.internal --restart unless-stopped --memory 128m \
  -v /opt/lumen-demo-api/server.mjs:/app/server.mjs:ro -e PORT=8787 node:22-alpine node /app/server.mjs
# site_settings.ssrf_allowed_hosts must contain "demo-api.lumenandclay.internal"
```

Endpoints:

| Path | What |
|---|---|
| `/etsy/v3/application/...` | the nine endpoints of the Etsy adapter |
| `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection` | SAP service catalog (42 services) |
| `/sap/opu/odata/sap/ZLC_STOCK_OVERVIEW_SRV` | stock by plant with safety stock (the one the demo queries) |
| `/sap/opu/odata/sap/API_PRODUCT_SRV`, `API_SALES_ORDER_SRV` | products, sales orders |
| `/logistics/openapi.json` | OpenAPI 3.1 of the logistics API (12 operations) |
| `/logistics/v1/...` | the logistics API |

Dates are relative to the day of the request, so "last 30 days" and "this week" hold
whenever the video is recorded.

## 2. Cloud connectors used by Claude

`mock-api/cloud-setup.cjs` creates, through the backend's own API, one MCP server
**"Lumen & Clay Demo"** with only these connectors (`--reset` replaces a previous run):

| Connector | Type | Base URL | Notes |
|---|---|---|---|
| Etsy | the Etsy marketplace adapter, re-pointed | `<mock>/etsy/v3/application` | auth switched to none |
| SAP S/4HANA | OData, SAP Gateway on, client 100, tool prefix `s4` | `<mock>` | Basic auth, any credentials |
| Lumen Logistics API | REST from OpenAPI | spec `<mock>/logistics/openapi.json` | API key, any value |

The server instructions tell Claude where things are (shop id, the stock service, the
order_ref convention), so answers need fewer calls on camera.

## 3. Recording

The web-app scenes run against the real frontend with a local mock backend (so no real
workspace, connector or email is ever on screen); the Claude scenes run in claude.ai.
Both are driven by `director/`, which moves the **real** macOS cursor with human timing,
so Recordly's auto-zoom and cursor effects work as with a person at the mouse.

One-time setup:

1. System Settings → Privacy & Security → **Accessibility**: enable the app that runs the
   director (Conductor or Terminal). **Screen Recording**: enable Recordly.
2. `cd director && npm install && npm run build:native`
3. Build the frontend for the harness:
   `cd packages/frontend && BACKEND_INTERNAL_URL=http://127.0.0.1:4100 NEXT_PUBLIC_API_URL= npx next build`
4. Log in to claude.ai once in the recording profile (`~/.lumen-demo-chrome`), which the
   director opens as an app window.

Run a take with `cd director && npx tsx run.ts <scene>`; with Recordly recording, press
Ctrl+Option+G in the demo window (or `npx tsx go.ts`). Scenes: `etsy-ui`, `sap-ui`,
`openapi-ui`, `connect-claude`, `etsy-claude`, `sap-claude`, `finale-claude`
(`--dry` checks a web-app scene headless). The director takes care of what bit us:

- the window opens on the Retina display, so a take is 3200×1800 even with a 1x monitor as main display;
- claude.ai is forced to English for the take, chats are incognito (no sidebar, history or memory);
- the notification nudge over the composer is hidden, Chrome autocomplete is off (its dropdown swallows real clicks);
- the consent page shows the demo user's email instead of the real account;
- `connect-claude` disconnects and removes the connector off camera first: removing alone keeps the OAuth grant and skips the consent page. Set `LUMEN_MCP_URL` to the server URL.

Before every take: Do Not Disturb on, nothing over the recording area, Recordly in
**window** mode. Export every clip **untrimmed** (Recordly otherwise cuts idle stretches,
the Claude waits among them) at full resolution. Clip names: `01-etsy-ui`,
`02-etsy-claude`, `03-sap-ui`, `04-sap-claude`, `05-openapi-ui`, `06b-finale-claude`,
`07-connect-claude`, in `compositions/assets/footage/`.

## 4. Edit and render

```bash
cd compositions
# frame-difference per frame, used to snap cuts to still frames
for n in assets/footage/*.mp4; do b=$(basename $n .mp4); ffmpeg -i $n -vf "scale=320:180,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=.motion/$b.txt" -f null -; done
python3 build.py            # cut list, captions, overlays -> index.html (see the script's docstring for .motion/motion.json)
npx hyperframes check
npx hyperframes preview --background
npx hyperframes render --output ../renders/anythingmcp-demo-lumen-clay-en.mp4 --fps 30 --quality delivery
cd .. && python3 export-web.py   # demo.mp4/.webm, 23 s preview loop, poster, README video
```

- **Cut list**: `SCENES` in `build.py`, one line per kept range: clip, source in/out, speed, caption. Claude waits run at 6–8× with a visible speed label; cut after the Send click, before Recordly's zoom-out.
- **Look**: overlays follow the Claude Design styleframes (AnythingMCP Design System: Fraunces, Geist, cream/ink/blue); recordings fly in and out in 3D on a dark stage, captions sit below them.
- **Music**: a HeyGen catalog track (`npx hyperframes media-use resolve --type bgm`, needs `heygen auth login --oauth`), kept out of git in `compositions/.media/`. Its licence for use outside HeyGen is not confirmed.
- **Publishing**: the site streams the files from DigitalOcean Spaces (`koch-katalog` bucket, `anythingmcp/demo/<date>/`, public-read, `Cache-Control: immutable`), so a new cut goes into a new dated folder and `lib/demo-media.ts` in the website repo points at it. The README embeds `demo-github.mp4`, uploaded to GitHub by dropping it into a comment box (without posting) so GitHub plays it inline; a new cut needs a new upload and a new link in the four READMEs.
