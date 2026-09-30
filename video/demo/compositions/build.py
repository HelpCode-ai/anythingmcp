"""
Builds index.html, the Lumen & Clay demo film, from the cut list below.

The footage is the Recordly exports in assets/footage/ (gitignored). Every
segment is (clip, source in, source out, playback rate, caption); its length
on the timeline is (out - in) / rate. Overlays follow the Claude Design
styleframes in ../styleframes/handoff/.

Cuts are cleaned before placement:
- two segments of the same clip less than a second apart are joined, so a
  change of speed never hides a tiny jump in the picture;
- every real cut (in and out) snaps to the stillest frame within half a
  second, measured in .motion/motion.json (frame-difference per frame).

    python3 build.py && npx hyperframes check
"""
from __future__ import annotations

import html
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).parent

INK = "#0b1220"
CREAM = "#f6f4ef"
BLUE = "#2563eb"
BLUE_LIGHT = "#60a5fa"
MUTED = "#5b6475"
MUTED_DARK = "#94a0b8"

OPEN = 7.6          # cold open length
FINALE_CARD = 3.0   # "Now ask across all of them." interstitial
END_A = 3.8         # proof points
END_B = 5.2         # logo lockup
CARD_HOLD = 3.4     # section card on screen
ENTER = 1.0         # recording flies in from depth
EXIT = 0.6          # recording leaves into depth

# The recording rests slightly smaller and higher than full frame, so the
# captions sit on the stage below it instead of over the UI.
REST_SCALE = 0.9
REST_Y = -44

# Scene -> list of (clip, in, out, rate, caption).
SCENES = [
    ("etsy", [
        ("01-etsy-ui", 2.6, 9.0, 1.0, "Open the Marketplace and search for Etsy"),
        ("01-etsy-ui", 9.0, 15.0, 1.2, "Paste the Etsy app keys and import"),
        ("01-etsy-ui", 15.0, 20.0, 1.0, "Put it on your MCP server"),
        ("01-etsy-ui", 23.4, 27.6, 1.0, "Sign in to Etsy once"),
        ("01-etsy-ui", 27.6, 31.2, 1.0, "9 Etsy tools, ready for Claude"),
    ]),
    ("sap", [
        ("03-sap-ui", 0.3, 2.5, 1.0, "New connector, type OData"),
        ("03-sap-ui", 2.5, 15.6, 1.2, "SAP Gateway URL, client, language and a read-only user"),
        ("03-sap-ui", 15.6, 18.8, 1.0, "Test connection: SAP answers with its service catalog"),
        ("03-sap-ui", 18.8, 22.5, 1.0, "SAP S/4HANA joins the same server"),
    ]),
    ("openapi", [
        ("05-openapi-ui", 1.2, 4.5, 1.0, "New connector, type REST API"),
        ("05-openapi-ui", 4.5, 14.6, 1.2, "Base URL, OpenAPI spec URL and an API key"),
        ("05-openapi-ui", 14.6, 19.2, 1.0, "12 tools generated from the spec"),
    ]),
    ("connect", [
        ("07-connect-claude", 9.6, 24.6, 1.5, "In Claude: add a custom connector with the server URL"),
        ("07-connect-claude", 26.9, 30.4, 1.0, "Approve access in AnythingMCP"),
        ("07-connect-claude", 32.8, 36.8, 1.0, "Claude now sees every tool on the server"),
    ]),
    ("ask-etsy", [
        ("02-etsy-claude", 4.6, 16.5, 2.0, "Ask in plain English"),
        ("02-etsy-claude", 18.1, 51.6, 7.0, "Claude calls the Etsy tools through AnythingMCP"),
        ("02-etsy-claude", 51.6, 57.8, 1.0, "Real numbers from the shop"),
        ("02-etsy-claude", 57.8, 62.5, 1.0, "Units, revenue and what stands out"),
    ]),
    ("ask-sap", [
        ("04-sap-claude", 4.6, 14.5, 2.0, "Same chat, now about stock"),
        ("04-sap-claude", 15.9, 36.6, 7.0, "Claude queries SAP over OData"),
        ("04-sap-claude", 36.6, 42.8, 1.0, "Three products below safety stock in Lisbon"),
        ("04-sap-claude", 44.5, 48.5, 1.0, "With what is already in the kiln"),
    ]),
    ("finale", [
        ("06b-finale-claude", 4.6, 28.2, 3.0, "One question across all three systems"),
        ("06b-finale-claude", 29.7, 50.6, 6.0, "Etsy orders, then shipments, then SAP stock"),
        ("06b-finale-claude", 50.6, 58.5, 1.0, "Three stuck orders, and where to resend from"),
        ("06b-finale-claude", 58.5, 62.4, 1.0, "Ready to act on it"),
    ]),
]

# Music: HeyGen catalog track (see .media/). Swap by changing MUSIC.
MUSIC = ".media/audio/bgm/bgm_008.wav"
LEVEL = 0.6
XFADE = 2.5


def r(x: float) -> float:
    return round(x, 3)


# ---- clean cuts -----------------------------------------------------------

MOTION = json.loads((HERE / ".motion/motion.json").read_text())


def stillest(clip: str, t: float, lo: float, hi: float) -> float:
    """Frame time in [t-0.5, t+0.5] ∩ [lo, hi] with the least motion around it."""
    series = MOTION[clip]
    times = [p[0] for p in series]
    vals = [p[1] for p in series]
    best, best_score = t, None
    for i, ti in enumerate(times):
        if ti < max(lo, t - 0.5) or ti > min(hi, t + 0.5):
            continue
        window = vals[max(0, i - 2): i + 3]
        score = sum(window) / len(window) + abs(ti - t) * 0.5  # prefer staying close
        if best_score is None or score < best_score:
            best, best_score = ti, score
    return r(best)


def clean(segs):
    out = [list(s) for s in segs]
    for i in range(1, len(out)):
        prev, cur = out[i - 1], out[i]
        gap = cur[1] - prev[2]
        if prev[0] == cur[0] and 0 < gap < 1.0:
            cur[1] = prev[2]                      # join: speed change only
    for i, s in enumerate(out):
        clip, a, b = s[0], s[1], s[2]
        joined_in = i > 0 and out[i - 1][0] == clip and out[i - 1][2] == a
        joined_out = i + 1 < len(out) and out[i + 1][0] == clip and out[i + 1][1] == b
        if not joined_in:
            s[1] = stillest(clip, a, 0, b - 1)
        if not joined_out:
            s[2] = stillest(clip, b, s[1] + 1, 1e9)
    return [tuple(s) for s in out]


# ---- timeline -------------------------------------------------------------

videos: list[str] = []
scene_at: dict[str, tuple[float, float]] = {}
segs_at: dict[str, list[tuple[float, float, float, str]]] = {}
t = OPEN
n = 0
for name, raw in SCENES:
    if name == "finale":
        t += FINALE_CARD
    start = t
    segs_at[name] = []
    for clip, a, b, rate, cap in clean(raw):
        d = r((b - a) / rate)
        n += 1
        videos.append(
            f'<video id="v{n:02d}" class="clip footage" src="assets/footage/{clip}.mp4" '
            f'data-start="{r(t)}" data-duration="{d}" data-media-start="{a}" '
            f'data-playback-rate="{rate}" data-track-index="0" muted playsinline></video>'
        )
        segs_at[name].append((r(t), d, rate, cap))
        t = r(t + d)
    scene_at[name] = (start, r(t - start))

END_AT = t
TOTAL = r(END_AT + END_A + END_B)

# ---- music ----------------------------------------------------------------

MUSIC_LEN = float(subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(HERE / MUSIC)]
).decode().strip())


def lane(points: list[tuple[float, float]]) -> str:
    return json.dumps({"version": 1, "lanes": [{"target": "volume", "points": [{"t": r(p), "v": v} for p, v in points]}]})


music: list[str] = []
at, k = 0.0, 0
while at < TOTAL:
    k += 1
    dur = r(min(MUSIC_LEN, TOTAL - at))
    last = at + MUSIC_LEN >= TOTAL
    pts = [(0, 0), (1.0 if k == 1 else XFADE, LEVEL)]
    pts += [(dur - 3.2, LEVEL), (dur, 0)] if last else [(dur - XFADE, LEVEL), (dur, 0)]
    music.append(
        f"""<audio id="music-{k}" src="{MUSIC}" data-start="{r(at)}" data-duration="{dur}" data-media-start="0" """
        f"""data-track-index="{9 + k}" data-automation='{lane(pts)}'></audio>"""
    )
    at = r(at + MUSIC_LEN - XFADE)

# ---- shared pieces --------------------------------------------------------

MARK = (
    '<svg viewBox="0 0 52 52" width="{s}" height="{s}" fill="none">'
    '<line x1="26" y1="26" x2="26" y2="9" stroke="{c}" stroke-width="{w}" stroke-linecap="round" opacity="{o}"/>'
    '<line x1="26" y1="26" x2="10" y2="40" stroke="{c}" stroke-width="{w}" stroke-linecap="round" opacity="{o}"/>'
    '<line x1="26" y1="26" x2="42" y2="40" stroke="{c}" stroke-width="{w}" stroke-linecap="round" opacity="{o}"/>'
    '<circle cx="26" cy="9" r="5" fill="{c}" opacity="{o2}"/><circle cx="10" cy="40" r="5" fill="{c}" opacity="{o2}"/>'
    '<circle cx="42" cy="40" r="5" fill="{c}" opacity="{o2}"/>'
    '<circle cx="26" cy="26" r="10" fill="#2563eb"/><circle cx="26" cy="26" r="5.5" fill="#ffffff"/></svg>'
)


def mark(size: int, color: str = BLUE_LIGHT, width: float = 1.5, op: str = "0.7", op2: str = "0.8") -> str:
    return MARK.format(s=size, c=color, w=width, o=op, o2=op2)


def chip(icon: str, label: str, mono: bool = False) -> str:
    font = "font-family:'Geist Mono',monospace;font-size:24px" if mono else "font-weight:500;font-size:28px"
    return f'<div class="chip">{icon}<span style="{font};white-space:nowrap">{html.escape(label)}</span></div>'


ETSY_ICON = '<div class="chip-icon" style="background:#fdf1ea"><img src="assets/brand/etsy.svg" alt="Etsy"></div>'
SAP_ICON = f'<div class="chip-icon mono" style="background:#eef3fe;color:{BLUE}">S/4</div>'
API_ICON = '<div class="chip-icon mono" style="background:#edf7f0;color:#15803d">API</div>'

# ---- overlays -------------------------------------------------------------

overlays: list[str] = []

overlays.append(f"""
    <div id="open" class="clip overlay stage3d" data-start="0" data-duration="{OPEN}" data-track-index="1" style="background:{CREAM}">
      <div id="open-world">
        <div class="headline" id="open-line-a">Claude can&rsquo;t <em>see</em> your business.</div>
        <div class="headline" id="open-line-b">Connect <em>anything.</em> In minutes.</div>
        <svg id="open-wires" width="1920" height="1080" viewBox="0 0 1920 1080" fill="none">
          <path class="wire" pathLength="1" d="M740 520 C 810 520, 810 640, 876 640"/>
          <path class="wire" pathLength="1" d="M740 640 L 876 640"/>
          <path class="wire" pathLength="1" d="M740 760 C 810 760, 810 640, 876 640"/>
          <path class="wire" pathLength="1" d="M1044 640 L 1180 640"/>
        </svg>
        <div class="chip-slot" id="open-etsy" style="left:400px;top:478px">{chip(ETSY_ICON, "Etsy")}</div>
        <div class="chip-slot" id="open-sap" style="left:400px;top:598px">{chip(SAP_ICON, "SAP S/4HANA")}</div>
        <div class="chip-slot" id="open-api" style="left:400px;top:718px">{chip(API_ICON, "{ Logistics API }", mono=True)}</div>
        <div id="open-hub">
          <div class="hub">{mark(96)}</div>
          <div class="hub-name" id="open-hub-name">Anything<span style="color:{BLUE}">MCP</span></div>
        </div>
        <div class="chip-slot" id="open-claude" style="left:1180px;top:598px">
          <div class="chip" style="width:300px;justify-content:space-between"><span style="font-weight:500;font-size:28px">Claude</span><span style="font-family:'Geist Mono',monospace;font-size:24px;color:{MUTED}">/mcp</span></div>
        </div>
      </div>
    </div>""")


def section_card(sid: str, badge: str, title: str, sub: str) -> str:
    start, _ = scene_at[sid]
    return f"""
    <div id="card-{sid}" class="clip overlay stage3d" data-start="{r(start + 0.5)}" data-duration="{CARD_HOLD}" data-track-index="2">
      <div class="section-card" id="card-{sid}-box">
        <div class="badge">{badge}</div>
        <div class="section-copy">
          <div class="section-title">{title}</div>
          <div class="section-sub">{sub}</div>
        </div>
      </div>
    </div>"""


overlays.append(section_card("etsy", "1", "From the marketplace", "Etsy, installed in 30 seconds."))
overlays.append(section_card("sap", "2", "Your SAP, your rules", "A custom OData connector."))
overlays.append(section_card("openapi", "3", "Any REST API", "From its OpenAPI spec."))
overlays.append(section_card("connect", mark(40, "#ffffff", 2.5, "0.8", "0.9"), "One URL in Claude", "Add it as a custom connector."))


def callout(cid: str, at: float, dur: float, icon: str, system: str, tool: str) -> str:
    return f"""
    <div id="{cid}" class="clip overlay stage3d" data-start="{r(at)}" data-duration="{r(dur)}" data-track-index="3">
      <div class="callout" id="{cid}-box">
        <div class="callout-head">{icon}<span>{system}</span></div>
        <div class="callout-tool">{tool}</div>
        <div class="callout-via"><span>via</span>{mark(22, BLUE, 2.5, "0.55", "0.65")}<b>Anything<span style="color:{BLUE}">MCP</span></b></div>
      </div>
    </div>"""


def speed_tag(tid: str, at: float, dur: float, rate: float) -> str:
    return f"""
    <div id="{tid}" class="clip overlay" data-start="{r(at)}" data-duration="{r(dur)}" data-track-index="4">
      <div class="speed" id="{tid}-pill">{rate:g}&times; speed</div>
    </div>"""


callouts: list[tuple[str, float, float]] = []
sap_ok_at = segs_at["sap"][2][0]
overlays.append(callout("call-sap-test", sap_ok_at + 0.6, 2.4, SAP_ICON, "SAP S/4HANA", "Test connection: 42 services"))
callouts.append(("call-sap-test", sap_ok_at + 0.6, 2.4))
for sid, icon, system, tool in [
    ("ask-etsy", ETSY_ICON, "Etsy", "etsy_get_shop_receipts"),
    ("ask-sap", SAP_ICON, "SAP S/4HANA", "s4_query"),
]:
    wait_at, wait_d, rate, _ = segs_at[sid][1]
    overlays.append(callout(f"call-{sid}", wait_at, wait_d + 0.6, icon, system, tool))
    callouts.append((f"call-{sid}", wait_at, wait_d + 0.6))
    overlays.append(speed_tag(f"speed-{sid}", wait_at, wait_d, rate))

finale_at, _ = scene_at["finale"]
overlays.append(f"""
    <div id="finale-card" class="clip overlay stage3d" data-start="{r(finale_at - FINALE_CARD)}" data-duration="{FINALE_CARD}" data-track-index="1">
      <div class="inter" id="finale-inter">
        <div class="inter-kicker" id="finale-kicker">ETSY &middot; LOGISTICS API &middot; SAP S/4HANA</div>
        <div class="inter-title"><span class="w">Now</span> <span class="w">ask</span> <span class="w">across</span> <span class="w"><em>all</em></span> <span class="w">of</span> <span class="w">them.</span></div>
      </div>
    </div>""")

fin_wait_at, fin_wait_d, fin_rate, _ = segs_at["finale"][1]
overlays.append(f"""
    <div id="finale-chips" class="clip overlay stage3d" data-start="{r(fin_wait_at)}" data-duration="{r(fin_wait_d + 0.5)}" data-track-index="3">
      <div class="dim" id="finale-dim"></div>
      <div class="tool-stack" id="tool-stack">
        <div class="kicker">ASKED IN CLAUDE</div>
        <div class="tool-row" id="tr-1"><span class="dot" id="tr-1-dot"></span><span class="sys">Etsy</span><span class="fn">etsy_get_shop_receipts</span></div>
        <div class="tool-row" id="tr-2"><span class="dot" id="tr-2-dot"></span><span class="sys">Logistics</span><span class="fn">logistics_list_shipments</span></div>
        <div class="tool-row" id="tr-3"><span class="dot" id="tr-3-dot"></span><span class="sys">SAP S/4HANA</span><span class="fn">s4_query</span></div>
      </div>
    </div>""")
overlays.append(speed_tag("speed-finale", fin_wait_at, fin_wait_d, fin_rate))

overlays.append(f"""
    <div id="end" class="clip overlay stage3d" data-start="{r(END_AT)}" data-duration="{r(END_A + END_B)}" data-track-index="1" style="background:{CREAM}">
      <div class="proof" id="end-proof">
        <div class="proof-item" id="pf-1"><span class="num">01</span><span class="big">Cloud or self-hosted</span></div>
        <div class="proof-item" id="pf-2"><span class="num">02</span><span class="big">SSO &amp; SCIM</span></div>
        <div class="proof-item" id="pf-3"><span class="num">03</span><span class="big">Roles &amp; audit log</span></div>
        <div class="proof-item" id="pf-4"><span class="num">04</span><span class="big">Open source (AGPL)</span></div>
      </div>
      <div class="lockup" id="end-lockup">
        <div class="lockup-row" id="end-logo">{mark(120, BLUE, 1.5, "0.55", "0.65")}<span class="wordmark">Anything<span style="color:{BLUE}">MCP</span></span></div>
        <div class="lockup-row" id="end-cta"><span class="url">anythingmcp.com</span><span class="star">&#9733; Star on GitHub</span></div>
      </div>
      <div class="footer" id="end-footer"><span>Cloud or self-hosted</span><span>SSO &amp; SCIM</span><span>Roles &amp; audit log</span><span>Open source (AGPL)</span></div>
    </div>""")

# Captions: one line per step, on the stage below the recording. The first
# one of a scene waits for the section card to leave.
captions: list[tuple[str, float, float]] = []
for sid, segs in segs_at.items():
    card_end = scene_at[sid][0] + 0.5 + CARD_HOLD if sid in ("etsy", "sap", "openapi", "connect") else 0
    for i, (at, d, _, cap) in enumerate(segs):
        start = max(at, card_end) if i == 0 else at
        end = at + d
        if end - start < 1.2:
            continue
        cid = f"cap-{sid}-{i}"
        captions.append((cid, r(start), r(end - start)))
        overlays.append(f"""
    <div id="{cid}" class="clip overlay stage3d" data-start="{r(start)}" data-duration="{r(end - start)}" data-track-index="5">
      <div class="caption" id="{cid}-pill">{html.escape(cap)}</div>
    </div>""")

# ---- motion ---------------------------------------------------------------

tl: list[str] = []


def add(line: str) -> None:
    tl.append("  " + line)


# Cold open. The world starts tilted in depth, chips float at different
# distances; the camera settles as they snap onto the hub.
add('tl.fromTo("#open-world", {rotationX:14, rotationY:-18, z:-260, scale:0.96}, {rotationX:6, rotationY:-8, z:-80, scale:1, duration:3.0, ease:"none"}, 0);')
add('tl.to("#open-world", {rotationX:0, rotationY:0, z:0, duration:1.4, ease:"settle"}, 3.0);')
add('tl.fromTo("#open-line-a", {opacity:0, y:30, rotationX:-60}, {opacity:1, y:0, rotationX:0, duration:0.9, ease:"settle"}, 0.15);')
for i, (sel, fx, fy, rot, z) in enumerate([
    ("#open-etsy", -180, 82, -5, 240), ("#open-sap", 980, -178, 4, -320), ("#open-api", 840, 102, -3, 120),
]):
    add(f'tl.fromTo("{sel}", {{opacity:0, x:{fx}, y:{fy + 30}, z:{z - 400}, rotation:{rot}, rotationY:{-rot * 6}}}, '
        f'{{opacity:1, y:{fy}, z:{z}, duration:0.9, ease:"settle"}}, {0.45 + i * 0.12});')
add('tl.fromTo("#open-hub", {opacity:0, scale:0.6, z:-300}, {opacity:1, scale:1, z:0, duration:0.9, ease:"settle"}, 0.8);')
add('tl.set("#open-hub-name", {opacity:0}, 0);')
add('tl.to("#open-line-a", {opacity:0, y:-20, rotationX:50, duration:0.4, ease:"leave"}, 2.9);')
for i, sel in enumerate(["#open-etsy", "#open-sap", "#open-api"]):
    add(f'tl.to("{sel}", {{x:0, y:0, z:0, rotation:0, rotationY:0, duration:1.0, ease:"settle"}}, {3.0 + i * 0.08});')
add('tl.fromTo("#open-wires .wire", {strokeDashoffset:1}, {strokeDashoffset:0, duration:0.45, ease:"move", stagger:0.08}, 3.8);')
add('tl.to("#open-hub-name", {opacity:1, duration:0.4}, 4.0);')
add('tl.fromTo("#open-claude", {opacity:0, x:80, z:-300, rotationY:-40}, {opacity:1, x:0, z:0, rotationY:0, duration:0.9, ease:"settle"}, 4.2);')
add('tl.fromTo("#open-line-b", {opacity:0, y:30, rotationX:-60}, {opacity:1, y:0, rotationX:0, duration:0.9, ease:"settle"}, 3.9);')
# Fly through the hub into the stage.
add(f'tl.to("#open-world", {{z:900, duration:0.65, ease:"leave"}}, {OPEN - 0.7});')
add(f'tl.to("#open", {{opacity:0, duration:0.45, ease:"leave"}}, {OPEN - 0.45});')

# Recordings: each scene flies in from depth, drifts, and leaves into space.
for i, (sid, (s, d)) in enumerate(scene_at.items()):
    sign = 1 if i % 2 == 0 else -1
    cam = f"#cam-{sid}"
    add(f'tl.fromTo("{cam}", {{opacity:0, z:-900, rotationX:18, rotationY:{-22 * sign}, y:{REST_Y + 160}, scale:{REST_SCALE}}}, '
        f'{{opacity:1, z:0, rotationX:0, rotationY:0, y:{REST_Y}, scale:{REST_SCALE}, duration:{ENTER}, ease:"settle"}}, {r(s)});')
    add(f'tl.to("{cam}", {{rotationY:{2.2 * sign}, rotationX:-1.2, duration:{r(d - ENTER - EXIT)}, ease:"none"}}, {r(s + ENTER)});')
    add(f'tl.to("{cam}", {{opacity:0, z:-700, rotationX:-14, rotationY:{24 * sign}, y:{REST_Y - 140}, duration:{EXIT}, ease:"leave"}}, {r(s + d - EXIT)});')

# Section cards hinge up from the stage floor.
for sid in ["etsy", "sap", "openapi", "connect"]:
    s = scene_at[sid][0] + 0.5
    add(f'tl.fromTo("#card-{sid}-box", {{opacity:0, rotationX:-75, z:-200, y:40}}, {{opacity:1, rotationX:0, z:0, y:0, duration:0.9, ease:"settle"}}, {r(s)});')
    add(f'tl.to("#card-{sid}-box", {{opacity:0, rotationX:60, z:-160, duration:0.4, ease:"leave"}}, {r(s + CARD_HOLD - 0.45)});')

# Callouts swing in like a door on their left edge.
for cid, at, dur in callouts:
    add(f'tl.fromTo("#{cid}-box", {{opacity:0, rotationY:-70, x:-80, z:-200}}, {{opacity:1, rotationY:0, x:0, z:0, duration:0.8, ease:"settle"}}, {r(at + 0.1)});')
    add(f'tl.to("#{cid}-box", {{opacity:0, rotationY:40, z:-150, duration:0.35, ease:"leave"}}, {r(at + dur - 0.4)});')
for sid in ["ask-etsy", "ask-sap", "finale"]:
    at, d, _, _ = segs_at[sid][1]
    add(f'tl.fromTo("#speed-{sid}-pill", {{opacity:0, y:-10}}, {{opacity:1, y:0, duration:0.3}}, {r(at)});')
    add(f'tl.to("#speed-{sid}-pill", {{opacity:0, duration:0.25}}, {r(at + d - 0.3)});')

# Captions rise off the stage floor and fold away.
for cid, at, dur in captions:
    add(f'tl.fromTo("#{cid}-pill", {{opacity:0, y:24, rotationX:-70}}, {{opacity:1, y:0, rotationX:0, duration:0.55, ease:"settle"}}, {r(at + 0.05)});')
    add(f'tl.to("#{cid}-pill", {{opacity:0, y:-10, rotationX:50, duration:0.3, ease:"leave"}}, {r(at + dur - 0.32)});')

# Finale interstitial: words arrive from depth one after another.
fs = r(finale_at - FINALE_CARD)
add(f'tl.fromTo("#finale-kicker", {{opacity:0, y:24}}, {{opacity:1, y:0, duration:0.7, ease:"settle"}}, {r(fs + 0.1)});')
add(f'tl.fromTo("#finale-inter .w", {{opacity:0, z:-600, rotationX:-50, y:40}}, {{opacity:1, z:0, rotationX:0, y:0, duration:0.8, ease:"settle", stagger:0.09}}, {r(fs + 0.2)});')
add(f'tl.to("#finale-inter", {{opacity:0, z:500, duration:0.5, ease:"leave"}}, {r(finale_at - 0.5)});')
add(f'tl.fromTo("#finale-dim", {{opacity:0}}, {{opacity:1, duration:0.5}}, {r(fin_wait_at)});')
step = (fin_wait_d - 0.8) / 3
for i in range(1, 4):
    at = r(fin_wait_at + 0.2 + (i - 1) * step)
    add(f'tl.fromTo("#tr-{i}", {{opacity:0, rotationX:-85, z:-200}}, {{opacity:1, rotationX:0, z:0, duration:0.7, ease:"settle"}}, {at});')
    add(f'tl.fromTo("#tr-{i}", {{borderColor:"#2563eb", boxShadow:"0 0 0 4px rgba(37,99,235,.18)"}}, {{borderColor:"#1f2b42", boxShadow:"0 0 0 0px rgba(37,99,235,0)", duration:0.4}}, {r(at + step)});')
    add(f'tl.fromTo("#tr-{i}-dot", {{backgroundColor:"#60a5fa"}}, {{backgroundColor:"#16a34a", duration:0.3}}, {r(at + step)});')
add(f'tl.to(["#finale-dim", "#tool-stack"], {{opacity:0, duration:0.35, ease:"leave"}}, {r(fin_wait_at + fin_wait_d + 0.1)});')

# End card: proof points flip down on a top hinge, then the lockup rises from depth.
add(f'tl.fromTo(".proof-item", {{opacity:0, rotationX:-95, z:-100}}, {{opacity:1, rotationX:0, z:0, duration:0.8, ease:"settle", stagger:0.13}}, {r(END_AT + 0.15)});')
add(f'tl.to("#end-proof", {{opacity:0, z:-500, duration:0.45, ease:"leave"}}, {r(END_AT + END_A - 0.4)});')
add(f'tl.fromTo("#end-logo", {{opacity:0, z:-700, rotationX:30, y:40}}, {{opacity:1, z:0, rotationX:0, y:0, duration:1.0, ease:"settle"}}, {r(END_AT + END_A + 0.05)});')
add(f'tl.fromTo("#end-cta", {{opacity:0, y:30, rotationX:-60}}, {{opacity:1, y:0, rotationX:0, duration:0.8, ease:"settle"}}, {r(END_AT + END_A + 0.35)});')
add(f'tl.fromTo("#end-footer", {{opacity:0}}, {{opacity:1, duration:0.6}}, {r(END_AT + END_A + 0.6)});')

# ---- document -------------------------------------------------------------

cams: list[str] = []
vid_by_scene: dict[str, list[str]] = {}
k = 0
for name, _ in SCENES:
    count = len(segs_at[name])
    vid_by_scene[name] = videos[k:k + count]
    k += count
for name, vids in vid_by_scene.items():
    cams.append(f'      <div class="cam" id="cam-{name}">\n        ' + "\n        ".join(vids) + "\n      </div>")

fonts = (HERE / "assets/fonts/fonts.css").read_text()

doc = f"""<!doctype html>
<html lang="en" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>AnythingMCP demo: Lumen &amp; Clay</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/CustomEase.min.js"></script>
    <style>
{fonts}
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; background: {INK}; -webkit-font-smoothing: antialiased; }}
      #root {{ position: relative; width: 100%; height: 100%; overflow: hidden; font-family: 'Geist', sans-serif; color: {INK};
        background: radial-gradient(1200px 700px at 50% 38%, #16233d 0%, {INK} 70%); }}
      #space {{ position: absolute; inset: 0; opacity: .5;
        background-image: radial-gradient(rgba(148,160,184,.22) 1px, transparent 1.4px); background-size: 36px 36px;
        -webkit-mask-image: radial-gradient(900px 560px at 50% 45%, #000 20%, transparent 80%); mask-image: radial-gradient(900px 560px at 50% 45%, #000 20%, transparent 80%); }}
      #stage {{ position: absolute; inset: 0; perspective: 1800px; perspective-origin: 50% 45%; }}
      .cam {{ position: absolute; inset: 0; transform-origin: 50% 50%; will-change: transform; }}
      .clip {{ position: absolute; inset: 0; }}
      .footage {{ width: 100%; height: 100%; object-fit: cover; }}
      .overlay {{ overflow: hidden; }}
      .stage3d {{ perspective: 1400px; }}
      em {{ font-style: italic; color: {BLUE}; }}

      #open-world {{ position: absolute; inset: 0; transform-style: preserve-3d; }}
      .headline {{ position: absolute; left: 0; right: 0; top: 150px; text-align: center; transform-origin: 50% 100%;
        font-family: 'Fraunces', serif; font-weight: 400; font-size: 104px; line-height: 1.05; letter-spacing: -0.02em; }}
      #open-wires {{ position: absolute; left: 0; top: 0; }}
      .wire {{ stroke: {BLUE}; stroke-width: 2; opacity: 0.55; stroke-dasharray: 1; stroke-dashoffset: 1; }}
      .chip-slot {{ position: absolute; }}
      .chip {{ width: 340px; height: 84px; background: #ffffff; border: 1px solid #e3dfd5; border-radius: 16px;
        display: flex; align-items: center; gap: 18px; padding: 0 24px;
        box-shadow: 0 1px 2px rgba(11,18,32,.05), 0 8px 24px -8px rgba(11,18,32,.12); }}
      .chip-icon {{ width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }}
      .chip-icon img {{ width: 26px; height: 26px; }}
      .chip-icon.mono {{ font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 15px; }}
      #open-hub {{ position: absolute; left: 876px; top: 556px; width: 168px; display: flex; flex-direction: column; align-items: center; gap: 20px; }}
      .hub {{ width: 168px; height: 168px; border-radius: 32px; background: {INK}; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 0 0 6px rgba(37,99,235,.12), 0 24px 48px -16px rgba(11,18,32,.45); }}
      .hub-name {{ font-size: 26px; font-weight: 500; white-space: nowrap; }}

      .dim {{ position: absolute; inset: 0; background: rgba(11,18,32,.62); opacity: 0; }}
      .section-card {{ position: absolute; left: 192px; top: 96px; display: flex; align-items: center; gap: 28px; transform-origin: 50% 100%;
        background: {CREAM}; border-radius: 20px; padding: 30px 44px 30px 30px; box-shadow: 0 30px 70px -20px rgba(0,0,0,.6); }}
      .badge {{ width: 64px; height: 64px; border-radius: 32px; background: {BLUE}; color: #ffffff; display: flex; align-items: center;
        justify-content: center; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 28px; flex-shrink: 0; }}
      .section-copy {{ display: flex; flex-direction: column; gap: 6px; }}
      .section-title {{ font-family: 'Fraunces', serif; font-size: 48px; line-height: 1.1; letter-spacing: -0.01em; white-space: nowrap; }}
      .section-sub {{ font-size: 28px; color: {MUTED}; white-space: nowrap; }}

      .callout {{ position: absolute; left: 120px; top: 392px; width: 520px; background: {CREAM}; border-radius: 16px; padding: 24px 28px;
        transform-origin: 0% 50%; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 30px 60px -16px rgba(0,0,0,.6); }}
      .callout-head {{ display: flex; align-items: center; gap: 12px; font-weight: 500; font-size: 24px; }}
      .callout-head .chip-icon {{ width: 36px; height: 36px; border-radius: 8px; }}
      .callout-head .chip-icon img {{ width: 22px; height: 22px; }}
      .callout-tool {{ font-family: 'Geist Mono', monospace; font-size: 28px; letter-spacing: -0.01em; }}
      .callout-via {{ display: flex; align-items: center; gap: 8px; font-size: 24px; color: {MUTED}; }}
      .callout-via b {{ color: {INK}; font-weight: 500; }}
      .speed {{ position: absolute; right: 96px; top: 44px; font-family: 'Geist Mono', monospace; font-size: 24px; color: {CREAM};
        background: rgba(11,18,32,.8); border: 1px solid #2a3753; border-radius: 999px; padding: 10px 20px; }}

      .caption {{ position: absolute; left: 50%; bottom: 20px; transform-origin: 50% 100%; translate: -50% 0; white-space: nowrap;
        font-size: 32px; font-weight: 500; color: {CREAM}; letter-spacing: -0.005em;
        background: rgba(17,26,44,.92); border: 1px solid #2a3753; border-radius: 999px; padding: 12px 30px;
        box-shadow: 0 16px 40px -16px rgba(0,0,0,.7); }}

      .inter {{ position: absolute; left: 192px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 36px;
        color: {CREAM}; transform-style: preserve-3d; }}
      .inter-kicker {{ font-family: 'Geist Mono', monospace; font-size: 24px; letter-spacing: .08em; color: {MUTED_DARK}; }}
      .inter-title {{ font-family: 'Fraunces', serif; font-weight: 400; font-size: 120px; line-height: 1; letter-spacing: -0.025em; transform-style: preserve-3d; }}
      .inter-title .w {{ display: inline-block; }}
      .inter-title em {{ color: {BLUE_LIGHT}; }}
      .tool-stack {{ position: absolute; left: 980px; top: 280px; width: 748px; display: flex; flex-direction: column; gap: 12px; color: {CREAM}; }}
      .kicker {{ font-family: 'Geist Mono', monospace; font-size: 24px; letter-spacing: .08em; color: {MUTED_DARK}; margin-bottom: 12px; }}
      .tool-row {{ height: 72px; background: #111a2c; border: 1px solid #1f2b42; border-radius: 14px; display: flex; align-items: center; gap: 18px;
        padding: 0 24px; transform-origin: 50% 0%; }}
      .tool-row .dot {{ width: 12px; height: 12px; border-radius: 6px; background: {BLUE_LIGHT}; flex-shrink: 0; }}
      .tool-row .sys {{ width: 190px; font-weight: 500; white-space: nowrap; font-size: 24px; }}
      .tool-row .fn {{ flex: 1; font-family: 'Geist Mono', monospace; font-size: 24px; color: #cfd6e4; }}

      .proof {{ position: absolute; left: 192px; right: 192px; top: 0; bottom: 0; display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
        gap: 48px; align-content: center; transform-style: preserve-3d; }}
      .proof-item {{ border-top: 2px solid {INK}; padding-top: 28px; display: flex; flex-direction: column; gap: 20px; transform-origin: 50% 0%; }}
      .proof-item .num {{ font-family: 'Geist Mono', monospace; font-size: 24px; color: {BLUE}; }}
      .proof-item .big {{ font-family: 'Fraunces', serif; font-size: 52px; line-height: 1.08; letter-spacing: -0.015em; }}
      .lockup {{ position: absolute; left: 0; right: 0; top: 0; bottom: 120px; display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 40px; transform-style: preserve-3d; }}
      .lockup-row {{ display: flex; align-items: center; gap: 28px; }}
      .wordmark {{ font-weight: 600; font-size: 104px; letter-spacing: -0.03em; }}
      .url {{ font-family: 'Geist Mono', monospace; font-size: 34px; }}
      .star {{ border: 1.5px solid {INK}; border-radius: 999px; padding: 14px 28px; font-weight: 500; font-size: 28px; }}
      .footer {{ position: absolute; left: 192px; right: 192px; bottom: 108px; display: flex; justify-content: center; gap: 56px;
        font-size: 26px; color: {MUTED}; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
      <div id="space"></div>
      <div id="stage">
{chr(10).join(cams)}
      </div>
      {chr(10).join('      ' + m for m in music).strip()}
{''.join(overlays)}
    </div>
    <script>
      gsap.registerPlugin(CustomEase);
      CustomEase.create("settle", ".16,1,.3,1");
      CustomEase.create("move", ".65,0,.35,1");
      CustomEase.create("leave", ".5,0,.75,0");
      const tl = gsap.timeline({{ paused: true }});
{chr(10).join('    ' + l for l in tl)}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""

(HERE / "index.html").write_text(doc)
print(f"index.html: {TOTAL}s, {len(videos)} footage segments, {len(captions)} captions, music {Path(MUSIC).name}")
for name, (s, d) in scene_at.items():
    print(f"  {name:9s} {s:6.2f} +{d:5.2f}  " + "  ".join(f"[{a:.2f}]" for a, *_ in segs_at[name]))
print(f"  end       {END_AT:6.2f} +{END_A + END_B:5.2f}")
