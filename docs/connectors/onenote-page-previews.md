# OneNote handwriting and page previews

`microsoft_onenote_get_page_image` reads a page's ink and positioned pictures
as PNG images that an MCP client can show to its model. Typed text is returned
separately. It does not modify the notebook or run handwriting recognition.
Cloud and self-hosted instances use the same renderer and limits.

Pass a `page_id` from `microsoft_onenote_list_pages` or
`microsoft_onenote_list_section_pages`. The tool uses the connector's existing
delegated Microsoft Graph sign-in; it needs no new OAuth permission.

The result has a text block containing `text`, an optional `title`, page dimensions, `warnings`,
and tile metadata (`x`, `y`, `width`, `height`, `bytes`). PNG image blocks follow
in row order. Coordinates use CSS pixels. Negative tile origins preserve
strokes to the left of or above the page origin.

## What the preview includes

The renderer requests page content with `includeInkML=true`, reads the HTML
and InkML parts, and combines strokes with PNG or JPEG page resources.
Himetric coordinates are converted to CSS pixels at 96 DPI. Channel names,
channel order, trace-group brush references, pen color, width and transparency
are respected. Absolute, first-difference and second-difference samples are
supported. Pen-up traces are omitted.

This is a handwriting preview, not a browser screenshot. Typed text stays in
the text block; its fonts and table layout are not drawn into the PNG. Brush
pressure, rectangular tips and highlighter compositing are approximate. The
renderer handles explicit image dimensions and parent `left`/`top` offsets;
it does not lay out normal HTML flow or apply arbitrary CSS transforms.
An image without dimensions is omitted with a warning.

Graph does not expose every kind of OneNote pen content. If it returns no
renderable ink or pictures, the text remains available and the result says
so. Unsupported InkML mappings or units cause an error instead of producing
a misleading drawing. Microsoft's original [InkML API description](https://devblogs.microsoft.com/microsoft365dev/onenote-ink-beta-apis/)
describes a beta API; use a real page to confirm the content Graph returns
for your account and OneNote client.

## Bounds and resource fetching

- Page HTML plus InkML: at most 10 MiB, or the tool's smaller upstream limit.
- XML nesting: 32 levels; at most 20,000 elements and 100,000 stroke samples.
- Typed text: at most 100,000 characters, with a warning when it is cut.
- Page images: at most 20 placements, 4 MiB per file, 12 MiB of downloaded
  image data, 8 million pixels per image and 16 million across placements.
- Preview: at most eight tiles, each at most 1,500 by 1,500 pixels. Each PNG
  is limited to 4 MiB or the smaller `binary.maxBytes`. The aggregate output
  is bounded by the instance response limit and an 8 MiB decoded ceiling.
- A page's request timeout covers its image fetches and rasterization too.
  At most two previews run concurrently per backend process; additional
  calls receive a retryable busy message rather than waiting without a bound.

Page resources are requested under the same OneNote owner on
`https://graph.microsoft.com/v1.0`. Resource IDs are extracted and encoded
into new Graph paths; query parameters from image URLs are discarded.
The legacy `www.onenote.com/api/v1.0/.../resources/{id}/$value` links shown
in Microsoft's [output-content documentation](https://learn.microsoft.com/en-us/graph/onenote-get-content)
are normalized to Graph paths too; the legacy host is never fetched.
Redirects are refused. Resource calls reuse the connector's credential
handling, including OAuth renewal. A failed resource fetch fails the preview
instead of returning an incomplete picture.

External XML references and DTDs are rejected. The rasterizer receives SVG
generated from validated numbers and embedded PNG/JPEG data. Source HTML,
source SVG, external URLs, filesystem paths and system fonts are not loaded.
Image byte and pixel budgets apply before rasterization.

The call log, structured output and dashboard tool test keep tile metadata
without image bytes. A configured response cache retains the PNGs so repeated
MCP calls can return the same image blocks.

## Custom tools

The renderer is opt-in through the response mapping of a REST tool:

```json
{
  "render": "onenote-page",
  "binary": { "maxBytes": 4194304 }
}
```

The endpoint must be a Graph v1.0 page-content GET. Besides `/me`, custom tools
may use `/users/{id}`, `/sites/{id}` or `/groups/{id}` with the appropriate
delegated access. Download-follow mappings are not combined with rendering.
As with a raw binary response, ordinary response transforms do not reshape
the preview's text or images.

## Optional live check

Choose a page that contains pen input. This check only reads it:

```bash
cd packages/backend
RUN_ONENOTE_INK_LIVE=1 MS_GRAPH_ACCESS_TOKEN='<delegated-token>' \
  ONENOTE_LIVE_PAGE_ID='<page-id>' \
  npx jest --runInBand src/adapters/intl/microsoft-onenote.ink.live.spec.ts
```

Keep the token out of shell history and logs when setting the environment.
The test checks PNG output; visual alignment still needs comparison with the
original page before treating a newly supported InkML format as verified.
