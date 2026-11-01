# file-extractor

A stateless HTTP service that turns one uploaded document into plain text,
page by page. The AnythingMCP backend worker sends it files from customers'
file servers for File Search; the service treats every byte as hostile. It
needs no network access, no database and no secrets except one shared token.

Licensed under the AnythingMCP Commercial License, see
[`deploy/ee/LICENSE`](../LICENSE). It is not covered by the AGPL that governs
the rest of the repository.

## API

### `POST /extract`

Multipart form:

| field      | required | content                                                         |
|------------|----------|-----------------------------------------------------------------|
| `file`     | yes      | the document bytes                                              |
| `filename` | no       | original name; its extension picks the parser (falls back to the file part's own filename) |
| `options`  | no       | JSON string, `{"ocr": false, "maxChars": 2000000}`              |

Header `X-Extractor-Token` must equal the `EXTRACTOR_TOKEN` environment
variable.

| situation                                   | status | body |
|---------------------------------------------|--------|------|
| `EXTRACTOR_TOKEN` empty or unset            | 503    | `{"detail": ...}` (fails closed) |
| token missing or wrong                      | 401    | `{"detail": ...}` |
| not multipart, no `file` part, bad `options`| 400    | `{"detail": ...}` |
| all extraction slots busy for 30 s          | 503    | `{"detail": ...}`, `Retry-After: 10` |
| any document outcome (success or failure)   | 200    | result JSON below |

Result:

```json
{"ok": true,
 "pages": [{"page": 1, "text": "..."}],
 "meta": {"title": null, "author": null, "pageCount": 3, "sheetCount": null, "format": "pdf"},
 "truncated": false,
 "ocrPages": 0,
 "emptyPages": 0,
 "error": null}
```

On failure `ok` is `false`, `pages` is `[]` and
`error` is `{"kind": "...", "message": "plain English"}` with `kind` one of:

| kind          | meaning |
|---------------|---------|
| `unsupported` | extension not in `/formats` (or no extension), or a supported extension holding content that cannot be read: binary data in a text/code extension (e.g. a `.ts` video), binary DXF, an iWork file without PDF preview |
| `encrypted`   | password-protected PDF, OOXML (OLE-wrapped), ODF, XLS or DOC; DRM-protected EPUB |
| `corrupt`     | the parser could not read it, or it looks like a decompression bomb |
| `timeout`     | extraction took longer than the deadline; the child was killed |
| `too_large`   | upload above `MAX_INPUT_BYTES`, or the document needed more memory than allowed |
| `empty`       | empty file, or no text at all (a scanned PDF without OCR reports `meta.pageCount` and `emptyPages`) |

`meta` and the counters are filled as far as known also on failure. Error
messages never contain document content.

`page` semantics:

- PDF, XPS/OXPS and iWork previews: real 1-based page numbers (pages without
  text are omitted, numbers stay real).
- PowerPoint (PPTX, PPTM, PPSX, PPSM, POTX, POTM), ODP, OTP: slide numbers.
- EPUB: the chapter's position in the spine (reading order); spine items
  that are not text (images) keep their number but produce no item.
- MBOX: message numbers, one item per message.
- Spreadsheets (XLSX, XLSM, XLTX, XLTM, XLSB, XLS, ODS, OTS, CSV, TSV): 1-based
  segment numbers across the workbook, at most 200 rows (or 32,000
  characters) per segment; a segment never spans two sheets.
  `meta.sheetCount` is set.
- Everything else (Word and ODT variants, DOC, PPT, RTF, text, code, HTML,
  MSG, EML, SVG, DXF): `page: null` segments of at most 4,000 characters,
  split on paragraph boundaries, then line boundaries, and only as a last
  resort inside a line.

Numbered items have no size limit of their own (an EPUB chapter or a long
mail can be large); the backend splits every item into search chunks.

### `GET /health`

`{"ok": true, "ocr": <bool>, "version": "1"}`. No token needed. `ocr` is
true only in images built with `OCR=1`.

### `GET /formats`

JSON array of supported extensions, with leading dot: the formats below, in
the order `.pdf`, `.xlsx`, `.xlsm`, `.xltx`, `.xltm`, `.xlsb`, `.xls`, `.ods`,
`.ots`, `.csv`, `.tsv`, `.docx`, `.docm`, `.dotx`, `.dotm`, `.odt`, `.ott`,
`.odp`, `.otp`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.potx`, `.potm`, `.doc`,
`.ppt`, `.rtf`, `.txt`, `.md`, `.json`, `.xml`, `.log`, `.html`, `.htm`,
`.msg`, `.eml`, `.mbox`, `.svg`, `.dxf`, `.epub`, `.xps`, `.oxps`, `.pages`,
`.numbers`, `.key`, then the configuration and source-code extensions.
No token needed.

## Formats

| extension | how |
|-----------|-----|
| `.pdf` | `pypdfium2`, text layer page by page; pages with < 50 characters count as `emptyPages` |
| `.xlsx`, `.xlsm`, `.xltx`, `.xltm` | `openpyxl` (read-only, cached values), streamed sparsely row by row |
| `.xlsb` | `pyxlsb` (pure Python), streamed sparsely row by row; cell styles are not read, so dates appear as Excel serial numbers |
| `.xls` | `xlrd`; fallback `xls2csv` (catdoc). An `.xls` that is really HTML or CSV (web exports) is read as such |
| `.ods`, `.ots` | own streaming reader (`defusedxml` iterparse); repeated empty rows/columns are counted, never expanded |
| `.csv`, `.tsv` | stdlib `csv`, delimiter sniffing, encoding detection (`charset-normalizer`); the "sheet" name is the file name |
| `.docx`, `.docm`, `.dotx`, `.dotm` | `python-docx`: paragraphs and tables in document order, table rows as `cell · cell · cell` |
| `.odt`, `.ott`, `.odp`, `.otp` | own streaming reader (`defusedxml` iterparse): paragraphs, tables as `cell · cell`, ODP/OTP one item per slide incl. notes |
| `.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.potx`, `.potm` | `python-pptx`: one item per slide (title first, text frames, group shapes, tables, `Notes: ...`) |
| `.doc` | `antiword`, fallback `catdoc`. A `.doc` that is really RTF or DOCX is read as such |
| `.ppt` | `catppt`; returned as `page: null` segments, because catppt's text blocks are not reliable slides (masters and notes are emitted the same way). Repeated blocks are dropped. catppt misses text in some files saved by newer PowerPoint versions |
| `.rtf` | `striprtf` with the code page from `\ansicpg` |
| `.txt`, `.md`, `.json`, `.xml`, `.log` | decoded with `charset-normalizer`, never parsed |
| configuration and data: `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.properties`, `.sql`, `.tex`, `.bib`, `.srt`, `.vtt`, `.ics`, `.vcf`, `.kml`, `.gpx` | decoded like `.txt`, never parsed or run; a file with binary content (NUL bytes, not UTF-16) is `unsupported` |
| source code: `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.java`, `.kt`, `.kts`, `.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cs`, `.go`, `.rb`, `.php`, `.sh`, `.bash`, `.ps1`, `.bat`, `.cmd`, `.swift`, `.rs`, `.r`, `.scala`, `.vb`, `.vbs`, `.pl`, `.lua`, `.css`, `.scss`, `.less`, `.sass`, `.gradle`, `.groovy`, `.dart`, `.m`, `.asm` | same as configuration files (a `.ts` video is `unsupported`) |
| `.html`, `.htm` | stdlib `html.parser`, script/style dropped, `<title>` into `meta.title` |
| `.msg` | `extract-msg`; header block, body (plain, else HTML), attachments |
| `.eml` | stdlib `email`; same layout as `.msg` |
| `.mbox` | stdlib `email`, streamed: one item per message with the `.msg` header block and the text body (attachments listed, not read); at most 20,000 messages, 16 MB parsed and 100,000 body characters per message |
| `.svg` | `defusedxml` iterparse: only `<text>`/`<tspan>`, `<title>`, `<desc>` (and Inkscape flowed text); the root `<title>` into `meta.title` |
| `.dxf` | own streaming reader for ASCII DXF: `TEXT`, `MTEXT` (formatting codes such as `\P`, `\f...;`, `\H...;` stripped, `\S1/2;` as `1/2`), `ATTRIB`/`ATTDEF` as `TAG: value`, dimension text overrides and multileader text, from model space, paper space and block definitions; `%%d`/`%%p`/`%%c` and `\U+XXXX` decoded, code page from `$DWGCODEPAGE`. Binary DXF is `unsupported`; `.dwg` is not supported (no free reader) and says so |
| `.epub` | spine (reading order) from the OPF via `META-INF/container.xml` (`defusedxml`), each XHTML chapter through the HTML extraction; title and author from the OPF; DRM (chapters listed in `META-INF/encryption.xml`) is `encrypted` |
| `.xps`, `.oxps` | `Glyphs` `UnicodeString` text, one item per `FixedPage` in document order (root relationship → FixedDocumentSequence → FixedDocuments → pages), runs on one baseline joined into a line; `defusedxml`, DTDs refused |
| `.pages`, `.numbers`, `.key` | the embedded PDF preview (`QuickLook/Preview.pdf` or `preview.pdf`) read like a PDF; files saved without a preview (the iWork format itself has no free reader) are `unsupported` |

Spreadsheet rows are rendered with their header, so a search for an article
number returns the whole row:

```
Sheet "Preise" columns: Artikel · Breite · Preis
Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412
```

The first non-empty row of a sheet is the header; empty cells are skipped and
a cell under an empty header cell is labelled with its column letter. Numbers
lose float noise (`412.0000000001` becomes `412`, integers have no `.0`),
dates are ISO (`2026-03-01`, `2026-03-01T14:30:00`), booleans `TRUE`/`FALSE`.

Mail layout (`page: null` segments):

```
From: ...
To: ...
Cc: ...
Date: ...
Subject: ...
Attachments: a.pdf, b.xlsx, c.exe

<body>

--- Attachment: a.pdf ---
<text of the attachment>
```

Attachments go through the same pipeline one level deep (supported types
only, nested `.msg`/`.eml`/`.mbox` skipped), with all attachment text capped at
200,000 characters. Signed, encrypted or broken messages return what could
be read.

OCR: only when the request sends `"ocr": true` and the image was built with
`--build-arg OCR=1`. PDF pages with < 50 characters are rendered at 200 dpi
(at most 40 megapixels) and read with RapidOCR (`rapidocr-onnxruntime`, CPU);
they are counted in `ocrPages`, and `emptyPages` counts the pages still below
50 characters afterwards. Without OCR in the image, `"ocr": true` is
accepted and ignored.

## Limits and environment

| variable | default | meaning |
|----------|---------|---------|
| `EXTRACTOR_TOKEN` | (empty) | shared secret; empty means every `/extract` gets 503 |
| `MAX_INPUT_BYTES` | `209715200` (200 MB) | larger uploads get `too_large`; checked while streaming |
| `TIMEOUT_SECONDS` | `60` | deadline per extraction |
| `LARGE_TIMEOUT_SECONDS` | `300` | deadline for inputs above `LARGE_INPUT_BYTES` |
| `LARGE_INPUT_BYTES` | `52428800` (50 MB) | threshold for the large deadline |
| `EXTRACT_CONCURRENCY` | `2` | parallel extractions (read at startup) |
| `QUEUE_TIMEOUT_SECONDS` | `30` | how long a request waits for a slot before 503 |
| `CHILD_MEMORY_MB` | `1536` | address-space limit of each extraction process (Linux; `0` disables). Not applied to OCR jobs: ONNX Runtime reserves several GB of address space and fails under this limit, so those rely on the container's `mem_limit` |
| `EXTRACTOR_TMPDIR` | `/tmp` | where per-request temp directories are created |
| `PORT` | `8890` | listening port |
| `LOG_LEVEL` | `INFO` | log level |

Output is capped at `maxChars` (default and hard maximum 2,000,000
characters); when the cap stops collection, `truncated` is `true`.

## Security model

- **Process isolation.** Every extraction runs in a fresh child process
  (`multiprocessing` spawn) in its own process group. The parent waits with a
  deadline and kills the whole group (including `antiword`/`catdoc`) when it
  expires; the parent itself never parses a document and stays healthy. The
  child drops the token from its environment, gets an address-space limit
  (`CHILD_MEMORY_MB`, except for OCR jobs), no core dumps, and its `TMPDIR`/`HOME` point to the
  request's private temp directory.
- **Bounded input.** The multipart body is parsed as a stream straight to a
  temp file; the upload is cut off as soon as it exceeds `MAX_INPUT_BYTES`
  (and a declared `Content-Length` above the limit is refused before
  reading). Form fields other than the file are capped at 64 KB.
- **Bounded work.** At most `EXTRACT_CONCURRENCY` extractions run at once;
  more requests wait up to `QUEUE_TIMEOUT_SECONDS`, then get 503.
- **Decompression bombs.** Before a ZIP-based format (every OOXML variant,
  xlsb, every ODF document and template, epub, xps, oxps, pages, numbers,
  key) is opened, its directory is checked: at most 10,000 entries
  (read from the end-of-central-directory record before the directory is
  parsed), at most 500 MB declared uncompressed in total, compression ratio
  at most 200 (for the archive and every entry above 1 MB). Otherwise the
  result is `corrupt`, "looks like a decompression bomb".
- **XML.** `openpyxl` uses `defusedxml` (installed); ODF, EPUB package files
  and XPS pages are parsed with `defusedxml` (no entity expansion, no
  external resources; XPS refuses DTDs); `python-docx` and `python-pptx`
  parse with entity resolution off; `pyxlsb`'s relationship parts go
  through `defusedxml`. SVG is parsed with `defusedxml` refusing external
  entities (never fetched or read) but allowing internal ones, because
  Adobe Illustrator declares its namespaces that way; expat's own
  amplification limit stops "billion laughs". EPUB chapters go through
  `html.parser`, which never resolves entities. `.xml`, `.json`, `.kml`,
  `.gpx` and the other text formats are decoded as text, never parsed.
- **Files.** The upload is stored as `input.<ext>` with the allow-listed
  extension only; names from the request or from attachments never become
  paths. Each request gets its own directory under `/tmp`, deleted when the
  request ends (also on errors and client disconnects).
- **External tools** run without a shell, with a minimal environment, a
  timeout, and output written to a file, never buffered unbounded.
- **Logs** contain only the extension (allow-listed characters), size,
  duration, result kind, page count and the truncation flag; never file
  names or content. Libraries' own logging and warnings are disabled in the
  child.
- **Container.** Runs as uid 10001, works with a read-only root file system,
  a tmpfs on `/tmp`, all capabilities dropped and `no-new-privileges`. It
  needs no network: put it on an internal network that only the backend can
  reach (`test.sh` proves it works with `--network none`).

Known limits: a ZIP entry whose declared size lies is only caught by the
deadline and the memory limit; a hostile file can always use the full
deadline of its slot.

## Compose service (to add in the File Search deployment)

```yaml
  file-extractor:
    build: ./deploy/ee/file-extractor
    profiles: ["files"]
    restart: unless-stopped
    environment:
      EXTRACTOR_TOKEN: ${EXTRACTOR_TOKEN:?set EXTRACTOR_TOKEN}
      # Optional: MAX_INPUT_BYTES, TIMEOUT_SECONDS, EXTRACT_CONCURRENCY
    networks: [extractor]          # internal network shared with the backend only
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=1g
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 2g
    pids_limit: 128
    # No ports: only the backend talks to it, at http://file-extractor:8890

networks:
  extractor:
    internal: true
```

The backend joins the `extractor` network as well and sends the same
`EXTRACTOR_TOKEN`. Size the tmpfs for `EXTRACT_CONCURRENCY` uploads of
`MAX_INPUT_BYTES` plus the text output (about 1 GB for the defaults).

## Tests

```sh
./test.sh                                        # host pytest, in-image pytest, HTTP, no-network check
EXTRACTOR_SAMPLES_DIR=/path/to/samples ./test.sh # also real .msg/.doc/.ppt/.xls samples
OCR=1 ./test.sh                                  # also build and test the OCR variant
```

`test.sh` needs `uv` and Docker. Fixtures are generated in `tests/samples.py`
(PDF incl. an encrypted one, XLSX, XLS, ODS/ODT/ODP and their templates,
DOCX, PPTX and their macro/template/show variants, a hand-built XLSB,
CSV/TSV, HTML, RTF, text and code, EML incl. signed, MBOX, SVG incl. XXE
and entity-bomb attempts, ASCII and binary DXF, EPUB incl. DRM and XXE,
XPS/OXPS, iWork with and without preview, ZIP bombs, OLE-encrypted OOXML). `.msg`,
`.doc` and `.ppt` cannot be generated with free tools; their tests run when
`EXTRACTOR_SAMPLES_DIR` points to a folder with such files and are skipped
otherwise.

## Updating dependencies

`requirements.in` (runtime), `requirements-ocr.in` (OCR) and
`requirements-dev.in` (tests) hold the direct pins. `./compile-requirements.sh`
compiles them into fully pinned, hash-checked lock files with `uv`,
considering only versions published before its `CUTOFF`. The image installs
the lock files with `pip --require-hashes --no-deps`.
`ocr-overrides.txt` swaps RapidOCR's `opencv-python` dependency for
`opencv-python-headless` (no X11/OpenGL libraries).
