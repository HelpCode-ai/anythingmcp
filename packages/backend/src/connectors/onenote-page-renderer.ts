import { toolMaxResponseBytes } from '../common/response-size-limit';
import { parseOneNoteHtml, parseOneNoteInk, parseOneNoteMultipart, type InkStroke, type PageImage } from './onenote-page-parser';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 8_000_000;
const MAX_TOTAL_IMAGE_PIXELS = 16_000_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TILE_EDGE = 1500;
const MAX_TILES = 8;
const MAX_ACTIVE_RENDERS = 2;
let activeRenders = 0;

export interface OneNotePageResult {
  __amcpOneNotePage: 1;
  title?: string;
  text: string;
  width: number;
  height: number;
  warnings: string[];
  tiles: Array<{ x: number; y: number; width: number; height: number; bytes: number; data: string }>;
}

export type OneNoteFetch = (path: string, remainingMs: number, maxBytes: number) => Promise<{ body: Buffer; contentType: string }>;
type OneNoteDocument = { body: Buffer; contentType: string };

function ownerIdentity(path: string): string {
  const owner = /^\/(me|users|sites|groups)(?:\/([^/?#]+))?$/.exec(path);
  if (!owner || (owner[1] === 'me') !== (owner[2] === undefined)) throw new Error('Invalid OneNote owner path');
  let id: string;
  try { id = owner[2] === undefined ? '' : decodeURIComponent(owner[2]); } catch { throw new Error('Invalid OneNote owner id'); }
  return JSON.stringify([owner[1], id]);
}

/** A resource is reconstructed under the original owner, never fetched by URL. */
export function oneNoteResourcePath(source: string, ownerPath: string): string {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('OneNote image is not a Graph resource URL'); }
  if (url.username || url.password || url.hash) {
    throw new Error('OneNote image must stay on graph.microsoft.com');
  }
  let id: string | undefined;
  if (url.origin === 'https://graph.microsoft.com') {
    const resource = /^\/v1\.0(\/(?:me|(?:users|sites|groups)\/[^/]+))\/onenote\/resources\/([^/]+)\/(?:content|\$value)$/.exec(url.pathname);
    // Equivalent owner ids can have different percent-encoding in the HTML
    // and the request (commas in a site id, or @ in a user principal name).
    if (!resource || ownerIdentity(resource[1]) !== ownerIdentity(ownerPath)) throw new Error('OneNote image belongs to a different notebook owner');
    id = resource[2];
  } else if (url.origin === 'https://www.onenote.com') {
    // Microsoft's output-HTML documentation also shows these legacy URIs.
    // Only their id is used: the credential never goes to this origin.
    const legacy = /^\/api\/v1\.0\/(me\/notes\/)?resources\/([^/]+)\/\$value$/.exec(url.pathname);
    if (!legacy || (legacy[1] && ownerPath !== '/me')) throw new Error('Unsupported legacy OneNote resource URL');
    id = legacy[2];
  } else {
    throw new Error('OneNote image must stay on graph.microsoft.com');
  }
  if (!id || id.includes('/')) throw new Error('Invalid OneNote resource id');
  let decoded: string;
  try { decoded = decodeURIComponent(id); } catch { throw new Error('Invalid OneNote resource id'); }
  if (decoded === '.' || decoded === '..') throw new Error('Invalid OneNote resource id');
  // Query values from the HTML, including access_token, are never forwarded.
  return `${ownerPath}/onenote/resources/${encodeURIComponent(decoded)}/content`;
}

function imageDimensions(data: Buffer): { width: number; height: number; mimeType: string } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), mimeType: 'image/png' };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    // JPEG dimensions live in a SOF marker, before compressed pixel data.
    let at = 2;
    while (at + 4 <= data.length) {
      if (data[at++] !== 0xff) break;
      while (data[at] === 0xff) at++;
      const marker = data[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > data.length) break;
      const length = data.readUInt16BE(at);
      if (length < 2 || at + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: data.readUInt16BE(at + 5), height: data.readUInt16BE(at + 3), mimeType: 'image/jpeg' };
      }
      at += length;
    }
  }
  throw new Error('OneNote page images must be PNG or JPEG');
}

function safeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Invalid OneNote drawing coordinate');
  return String(Math.round(value * 1000) / 1000);
}

function strokeSvg(stroke: InkStroke): string {
  const [first, ...rest] = stroke.points;
  const common = `fill="${stroke.color}" opacity="${safeNumber(stroke.opacity)}"`;
  if (rest.length === 0) return `<circle cx="${safeNumber(first[0])}" cy="${safeNumber(first[1])}" r="${safeNumber(stroke.width / 2)}" ${common}/>`;
  const path = `M${safeNumber(first[0])} ${safeNumber(first[1])}` + rest.map(([x, y]) => `L${safeNumber(x)} ${safeNumber(y)}`).join('');
  return `<path d="${path}" fill="none" stroke="${stroke.color}" stroke-width="${safeNumber(stroke.width)}" stroke-opacity="${safeNumber(stroke.opacity)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function isOneNotePageResult(value: unknown): value is OneNotePageResult {
  return !!value && typeof value === 'object'
    && (value as OneNotePageResult).__amcpOneNotePage === 1
    && typeof (value as OneNotePageResult).text === 'string'
    && Array.isArray((value as OneNotePageResult).tiles);
}

/** Audit rows and structured output carry geometry, not encoded pictures. */
export function oneNotePageSummary(value: OneNotePageResult): Omit<OneNotePageResult, 'tiles' | '__amcpOneNotePage'> & { tiles: Array<Omit<OneNotePageResult['tiles'][number], 'data'>> } {
  const { __amcpOneNotePage: _marker, tiles, ...summary } = value;
  return { ...summary, tiles: tiles.map(({ data: _data, ...tile }) => tile) };
}

/**
 * Render generated SVG only. The source HTML/InkML is never given to resvg,
 * and images are embedded after signature, byte and pixel-budget checks.
 */
export async function renderOneNotePage(
  document: OneNoteDocument | (() => Promise<OneNoteDocument>),
  ownerPath: string,
  fetchResource: OneNoteFetch,
  deadline: number,
  options: { maxTileBytes?: number; signal?: AbortSignal } = {},
): Promise<OneNotePageResult> {
  ownerIdentity(ownerPath);
  if (activeRenders >= MAX_ACTIVE_RENDERS) throw new Error('OneNote renderer is busy; retry the tool call');
  activeRenders++;
  let nativeRender: Promise<unknown> | undefined;
  try {
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error('OneNote page rendering timed out');
      return ms;
    };
    remaining();
    const response = typeof document === 'function' ? await document() : document;
    remaining();
    const parts = parseOneNoteMultipart(response.body, response.contentType);
    const page = parseOneNoteHtml(parts.html);
    const strokes = parts.ink ? parseOneNoteInk(parts.ink) : [];
    remaining();
    const pictures: Array<PageImage & { resourceId: string }> = [];
    const resources = new Map<string, { resourceId: string; href: string; pixels: number }>();
    let totalBytes = 0, totalPixels = 0;
    // Validate all URLs before the first additional authenticated call.
    const paths = page.images.map((image) => oneNoteResourcePath(image.source, ownerPath));
    for (let i = 0; i < page.images.length; i++) {
      const path = paths[i];
      let resource = resources.get(path);
      if (!resource) {
        const downloaded = await fetchResource(path, remaining(), MAX_IMAGE_BYTES);
        remaining();
        if (downloaded.body.length > MAX_IMAGE_BYTES) throw new Error('OneNote image exceeds 4 MiB');
        const dimensions = imageDimensions(downloaded.body);
        const pixels = dimensions.width * dimensions.height;
        if (!dimensions.width || !dimensions.height || pixels > MAX_IMAGE_PIXELS) throw new Error('OneNote image exceeds the pixel budget');
        totalBytes += downloaded.body.length;
        if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('OneNote page images exceed the total budget');
        resource = { resourceId: `resource${resources.size}`, pixels, href: `data:${dimensions.mimeType};base64,${downloaded.body.toString('base64')}` };
        resources.set(path, resource);
      }
      totalPixels += resource.pixels;
      if (totalPixels > MAX_TOTAL_IMAGE_PIXELS) throw new Error('OneNote page images exceed the total pixel budget');
      pictures.push({ ...page.images[i], resourceId: resource.resourceId });
    }

    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    for (const stroke of strokes) {
      for (const [x, y] of stroke.points) {
        minX = Math.min(minX, x - stroke.width / 2);
        minY = Math.min(minY, y - stroke.width / 2);
        maxX = Math.max(maxX, x + stroke.width / 2);
        maxY = Math.max(maxY, y + stroke.width / 2);
      }
    }
    for (const image of pictures) {
      minX = Math.min(minX, image.x); minY = Math.min(minY, image.y);
      maxX = Math.max(maxX, image.x + image.width); maxY = Math.max(maxY, image.y + image.height);
    }
    minX = Math.floor(minX - 4); minY = Math.floor(minY - 4);
    const width = Math.max(1, Math.ceil(maxX - minX + 4));
    const height = Math.max(1, Math.ceil(maxY - minY + 4));
    const result: OneNotePageResult = { __amcpOneNotePage: 1, ...(page.title ? { title: page.title } : {}), text: page.text, width, height, warnings: page.warnings, tiles: [] };
    if (!strokes.length && !pictures.length) {
      result.warnings.push('Graph returned no renderable ink or positioned images.');
      return result;
    }
    const columns = Math.ceil(width / TILE_EDGE), rows = Math.ceil(height / TILE_EDGE);
    if (columns * rows > MAX_TILES) throw new Error('OneNote page exceeds the eight-tile canvas limit');
    const inkSvg = strokes.map(strokeSvg).join('');
    // Encoded image blocks and the text must fit the same response budget.
    const outputLimit = Math.min(MAX_OUTPUT_BYTES, Math.max(0, Math.floor((toolMaxResponseBytes() - 512 * 1024) * 3 / 4)));
    const tileLimit = Math.min(MAX_IMAGE_BYTES, options.maxTileBytes ?? MAX_IMAGE_BYTES);
    const { renderAsync } = await import('@resvg/resvg-js');
    let outputBytes = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = minX + column * TILE_EDGE, y = minY + row * TILE_EDGE;
        const tileWidth = Math.min(TILE_EDGE, width - column * TILE_EDGE);
        const tileHeight = Math.min(TILE_EDGE, height - row * TILE_EDGE);
        const visible = pictures.filter((image) => image.x < x + tileWidth && image.x + image.width > x && image.y < y + tileHeight && image.y + image.height > y);
        const usedResources = new Set(visible.map((image) => image.resourceId));
        const definitions = [...resources.values()].filter((resource) => usedResources.has(resource.resourceId))
          .map((resource) => `<image id="${resource.resourceId}" width="1" height="1" preserveAspectRatio="none" href="${resource.href}"/>`).join('');
        const imageSvg = visible.map((image) => `<use href="#${image.resourceId}" transform="translate(${safeNumber(image.x)} ${safeNumber(image.y)}) scale(${safeNumber(image.width)} ${safeNumber(image.height)})"/>`).join('');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${tileHeight}" viewBox="${x} ${y} ${tileWidth} ${tileHeight}"><defs>${definitions}</defs>${imageSvg}${inkSvg}</svg>`;
        const milliseconds = remaining();
        if (options.signal?.aborted) throw new Error('OneNote page rendering timed out');
        let cancelled = false;
        let cancelTile!: () => void;
        const cancellation = new Promise<never>((_resolve, reject) => {
          cancelTile = () => {
            cancelled = true;
            reject(new Error('OneNote page rendering timed out'));
          };
        });
        const timer = setTimeout(cancelTile, milliseconds);
        options.signal?.addEventListener('abort', cancelTile, { once: true });
        let rendered: Awaited<ReturnType<typeof renderAsync>>;
        try {
          // napi-rs abort rejects the promise without stopping an executing
          // native task. Keep its completion promise separate from the
          // caller's cancellation so the admission slot cannot be reused early.
          const task = renderAsync(svg, { background: 'white', font: { loadSystemFonts: false }, logLevel: 'off' });
          nativeRender = task;
          rendered = await Promise.race([task, cancellation]);
        } catch {
          if (cancelled) throw new Error('OneNote page rendering timed out');
          throw new Error('Could not rasterize the OneNote page preview');
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', cancelTile);
        }
        remaining();
        const png = rendered.asPng();
        outputBytes += png.length;
        if (png.length > tileLimit || outputBytes > outputLimit) throw new Error('OneNote preview exceeds the output byte limit');
        result.tiles.push({ x, y, width: tileWidth, height: tileHeight, bytes: png.length, data: png.toString('base64') });
      }
    }
    return result;
  } finally {
    if (nativeRender) {
      const release = () => { activeRenders--; };
      // A cancelled caller gets its error promptly; unfinished native work
      // continues to hold the slot until it resolves or rejects.
      void nativeRender.then(release, release);
    } else {
      activeRenders--;
    }
  }
}
