# Claude Design brief: AnythingMCP demo video styleframes

Paste everything below the line into a new Claude Design project. Attach:
`packages/frontend/public/logo.svg`, `packages/frontend/public/logos/connectors/etsy.svg`,
and one screenshot of the anythingmcp.com hero (cream background, dark gateway diagram).

When the frames are approved, use **Export → Handoff to Claude Code** and save the
bundle into `video/demo/styleframes/handoff/`.

---

Design five 1920×1080 styleframes for a 90-second product demo video of **AnythingMCP**, a
gateway that turns any API, database or business system into tools Claude can use (MCP).
The video has no voice-over: on-screen type carries the story, over screen recordings of
the product and of Claude. The frames will be rebuilt as HTML animation, so keep every
element a clean vector/text layer, no raster effects that can't be reproduced in CSS.

**Brand (match the anythingmcp.com hero exactly)**
- Background cream `#f6f4ef` (light scenes) and ink `#0b1220` (dark scenes).
- Accent blue `#2563eb`, light accent `#60a5fa`, success green `#16a34a`.
- Headlines: Fraunces (serif, 400/500, italic allowed for one emphasised word).
- UI and labels: Geist; code, tool names and URLs: Geist Mono.
- Logo: the attached three-node hub mark; the wordmark is "Anything" + "MCP" in blue.
- Tone: calm, confident, editorial. Generous whitespace. No gradients-on-everything,
  no glassmorphism, no neon, no stock 3D.

**Story**: a fictional ceramics studio, *Lumen & Clay*, sells on Etsy, runs SAP S/4HANA and
has its own logistics API. AnythingMCP connects all three to Claude, then Claude answers a
question that spans them.

**Frames**
1. **Cold open.** Large serif line "Claude can't see your business." with three system
   chips floating apart (Etsy logo, "SAP S/4HANA", `{ Logistics API }`), and the AnythingMCP
   hub mark waiting at the centre. Second state of the same frame: the chips snapped onto
   the hub with thin connector lines, line reads "Connect anything. In minutes."
2. **Section card.** A compact label used three times: number + title + one-line subtitle,
   e.g. "① From the marketplace" / "Etsy, installed in 30 seconds." Also design the
   variants "② Your SAP, your rules" / "A custom OData connector." and
   "③ Any REST API" / "From its OpenAPI spec." Show how it sits over a screen recording
   (lower-left, over a dimmed recording) and as a full-screen interstitial.
3. **Tool-call callout.** Over a Claude conversation recording: a floating annotation that
   points at a tool call, showing the tool name in mono (`etsy_get_shop_receipts`), the
   system badge (Etsy), and a tiny "via AnythingMCP" tag. Needs to work over both a light
   and a dark recording.
4. **Finale split.** Left: the question "Which Etsy orders are stuck, and can SAP cover a
   resend?" as it is typed. Right: three stacked tool-call chips lighting up in sequence
   (Etsy → Logistics → SAP) and, below, a clean answer table (order, item, issue, stock,
   action). This is the hero moment of the video; make it feel inevitable, not busy.
5. **End card.** Four short proof points in a row: "Cloud or self-hosted", "SSO & SCIM",
   "Roles & audit log", "Open source (AGPL)". Then logo, "anythingmcp.com" and
   "★ Star on GitHub".

Also give me: the frame/safe-area grid, type scale, the corner radius and shadow used for
screen recordings placed on the canvas, and the motion principles you'd apply (easing,
durations, how chips and callouts enter and leave).
