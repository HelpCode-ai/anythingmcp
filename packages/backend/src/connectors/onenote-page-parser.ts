import { XMLParser } from 'fast-xml-parser';

/** Graph's page coordinates are CSS pixels; its ink coordinates are himetric. */
const HIMETRIC_TO_PX = 96 / 2540;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_POINTS = 100_000;
const MAX_COORDINATE = 100_000;
const INK_NAMESPACE = 'http://www.w3.org/2003/InkML';

export interface InkStroke {
  points: Array<[number, number]>;
  color: string;
  width: number;
  opacity: number;
}

export interface PageImage {
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type XmlNode = Record<string, any>;
const localName = (name: string) => name.slice(name.lastIndexOf(':') + 1);
const tagOf = (node: XmlNode): string => Object.keys(node).find((key) => key !== ':@') ?? '';
const children = (node: XmlNode): XmlNode[] => Array.isArray(node[tagOf(node)]) ? node[tagOf(node)] : [];
const attrs = (node: XmlNode): Record<string, string> => node[':@'] ?? {};
const named = (node: XmlNode, name: string) => children(node).find((child) => localName(tagOf(child)) === name);
const text = (node: XmlNode): string => children(node).filter((child) => '#text' in child).map((child) => child['#text']).join('');

function parseXml(source: string, html = false): XmlNode[] {
  if (Buffer.byteLength(source) > MAX_DOCUMENT_BYTES) throw new Error('OneNote document exceeds 10 MiB');
  // Neither parser may expand a DTD or fetch an external entity. An HTML5
  // doctype carries neither; Graph can include it in the presentation part.
  source = source.replace(/<!DOCTYPE\s+html\s*>/gi, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('OneNote documents must not contain DTDs or entities');
  // Count before allocating the parser's tree. A post-parse walk alone
  // cannot bound the memory used by millions of small, flat elements.
  // Deliberately conservative: markup-like text in comments/CDATA counts too.
  let openings = 0;
  for (let at = source.indexOf('<'); at >= 0; at = source.indexOf('<', at + 1)) {
    if (!['/', '!', '?'].includes(source[at + 1]) && ++openings > MAX_NODES) {
      throw new Error('OneNote document has too many elements');
    }
  }
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false,
    maxNestedTags: 32,
    ...(html ? { unpairedTags: ['img', 'br', 'meta', 'link', 'hr', 'input', 'wbr', 'source'] } : {}),
  }).parse(source, !html);
}

function walk(nodes: XmlNode[], visit: (node: XmlNode, parent?: XmlNode) => void): void {
  const stack = nodes.map((node) => ({ node, parent: undefined as XmlNode | undefined })).reverse();
  let count = 0;
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (++count > MAX_NODES) throw new Error('OneNote document has too many elements');
    visit(node, parent);
    const nested = children(node);
    for (let i = nested.length - 1; i >= 0; i--) stack.push({ node: nested[i], parent: node });
  }
}

function number(value: string | undefined, label: string): number {
  if (value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    throw new Error(`Unsupported OneNote ${label}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_COORDINATE / HIMETRIC_TO_PX) throw new Error(`OneNote ${label} is out of range`);
  return n;
}

/** No external references are followed, even if an InkML context names one. */
function reference(value: string | undefined, definitions: Map<string, XmlNode>): XmlNode | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith('#') || !definitions.has(value.slice(1))) throw new Error('Unsupported OneNote ink reference');
  return definitions.get(value.slice(1));
}

/** The OneNote subset: named X/Y channels, absolute or differential samples. */
export function parseOneNoteInk(source: string): InkStroke[] {
  const tree = parseXml(source);
  const root = tree.find((node) => localName(tagOf(node)) === 'ink');
  const rootTag = root && tagOf(root);
  const namespaceKey = rootTag?.includes(':') ? `xmlns:${rootTag.split(':')[0]}` : 'xmlns';
  if (!root || attrs(root)[namespaceKey] !== INK_NAMESPACE) throw new Error('Expected a OneNote InkML document');

  const definitions = new Map<string, XmlNode>();
  const parents = new Map<XmlNode, XmlNode>();
  walk([root], (node, parent) => {
    if (parent) parents.set(node, parent);
    const id = attrs(node)['xml:id'];
    if (id) {
      if (definitions.has(id)) throw new Error('Duplicate OneNote ink id');
      definitions.set(id, node);
    }
    if (['canvasTransform', 'mapping', 'traceView'].includes(localName(tagOf(node)))) {
      throw new Error('This OneNote ink mapping is not supported');
    }
  });

  const inherited = (node: XmlNode, key: string): string | undefined => {
    for (let current: XmlNode | undefined = node; current; current = parents.get(current)) {
      if (attrs(current)[key] !== undefined) return attrs(current)[key];
    }
    return undefined;
  };
  const strokes: InkStroke[] = [];
  let pointCount = 0;
  walk([root], (node) => {
    if (localName(tagOf(node)) !== 'trace' || attrs(node).type === 'penUp') return;
    if (attrs(node).type && attrs(node).type !== 'penDown') throw new Error('Unsupported OneNote pen state');
    if (attrs(node).continuation || attrs(node).priorRef) throw new Error('OneNote continuation traces are not supported');
    if (strokes.length >= 10_000) throw new Error('Too many OneNote ink strokes');
    const context = reference(inherited(node, 'contextRef'), definitions);
    if (context && attrs(context).contextRef) throw new Error('Inherited OneNote ink contexts are not supported');
    const inkSource = context && (named(context, 'inkSource') ?? reference(attrs(context).inkSourceRef, definitions));
    const format = (context && (named(context, 'traceFormat') ?? reference(attrs(context).traceFormatRef, definitions)))
      ?? (inkSource && named(inkSource, 'traceFormat'))
      ?? named(root, 'traceFormat');
    const channels = format
      ? children(format).filter((child) => localName(tagOf(child)) === 'channel').map(attrs)
      : [{ name: 'X', units: 'himetric' }, { name: 'Y', units: 'himetric' }];
    const xIndex = channels.findIndex((channel) => channel.name === 'X');
    const yIndex = channels.findIndex((channel) => channel.name === 'Y');
    if (channels.length > 16 || xIndex < 0 || yIndex < 0 || new Set(channels.map((channel) => channel.name)).size !== channels.length) throw new Error('OneNote ink needs distinct X and Y channels');
    const scale = (index: number) => {
      const unit = channels[index].units ?? 'himetric';
      if (unit === 'himetric') return HIMETRIC_TO_PX;
      if (unit === 'px') return 1;
      throw new Error('Unsupported OneNote ink coordinate units');
    };
    const xScale = scale(xIndex), yScale = scale(yIndex);

    const brush = reference(inherited(node, 'brushRef') ?? (context && attrs(context).brushRef), definitions)
      ?? (context && named(context, 'brush'));
    const properties = new Map<string, Record<string, string>>();
    if (brush) {
      for (const property of children(brush)) {
        if (localName(tagOf(property)) === 'brushProperty') properties.set(attrs(property).name, attrs(property));
      }
    }
    if (properties.get('rasterOp')?.value === 'noOperation') return;
    if (!['copyPen', 'maskPen', undefined].includes(properties.get('rasterOp')?.value)) throw new Error('Unsupported OneNote ink raster operation');
    const color = properties.get('color')?.value ?? '#000000';
    if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Unsupported OneNote ink color');
    const widthProperty = properties.get('width');
    const widthUnit = widthProperty?.units ?? 'himetric';
    if (!['himetric', 'px'].includes(widthUnit)) throw new Error('Unsupported OneNote ink brush units');
    const width = widthProperty ? number(widthProperty.value, 'brush width') * (widthUnit === 'px' ? 1 : HIMETRIC_TO_PX) : 1;
    const transparency = number(properties.get('transparency')?.value ?? '0', 'transparency');
    if (width <= 0 || width > 200 || transparency < 0 || transparency > 256) throw new Error('OneNote ink brush is out of range');

    const previous = Array(channels.length).fill(0) as number[];
    const velocity = Array(channels.length).fill(0) as number[];
    const acceleration = Array(channels.length).fill(0) as number[];
    const modes = Array(channels.length).fill('!') as string[];
    const hasVelocity = Array(channels.length).fill(false) as boolean[];
    const points: InkStroke['points'] = [];
    for (const sample of text(node).split(',')) {
      if (!sample.trim()) continue;
      if (++pointCount > MAX_POINTS) throw new Error('Too many OneNote ink points');
      // Sticky scanning also accepts adjacent signed values, as InkML allows.
      const token = /\s*([!'"]?)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\*)/iy;
      const values: number[] = [];
      let offset = 0;
      for (let i = 0; i < channels.length; i++) {
        token.lastIndex = offset;
        const match = token.exec(sample);
        if (!match) throw new Error('Unsupported OneNote ink sample');
        offset = token.lastIndex;
        const mode = match[1] || modes[i];
        if (match[1] && match[2] === '*') throw new Error('Unsupported OneNote ink wildcard prefix');
        if (!points.length && (mode !== '!' || match[2] === '*')) throw new Error('OneNote ink must start with an absolute sample');
        if (mode === '"' && !hasVelocity[i]) throw new Error('OneNote ink second difference needs a first difference');
        const value = match[2] === '*'
          ? (mode === '!' ? previous[i] : mode === "'" ? velocity[i] : acceleration[i])
          : number(match[2], 'sample');
        // A repeated second difference integrates the previous acceleration.
        if (mode === "'") { velocity[i] = value; hasVelocity[i] = true; }
        if (mode === '"') { acceleration[i] = value; velocity[i] += value; }
        if (mode === '!') hasVelocity[i] = false;
        values[i] = mode === '!' ? value : previous[i] + velocity[i];
        if (!Number.isFinite(values[i])) throw new Error('OneNote ink sample is out of range');
        previous[i] = values[i];
        modes[i] = mode;
      }
      if (sample.slice(offset).trim()) throw new Error('Unsupported extra OneNote ink channels');
      const point: [number, number] = [values[xIndex] * xScale, values[yIndex] * yScale];
      if (point.some((coordinate) => Math.abs(coordinate) > MAX_COORDINATE)) throw new Error('OneNote ink coordinate is out of range');
      points.push(point);
    }
    if (points.length) strokes.push({ points, color, width, opacity: 1 - transparency / 256 });
  });
  return strokes;
}

/** Only HTML character references, never a custom or recursively expanded entity. */
function unescapeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (entity) => {
    const fixed: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (fixed[entity.toLowerCase()] !== undefined) return fixed[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function cssPixels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|pt|in)?$/i.exec(value.trim());
  if (!match) return undefined;
  const result = Number(match[1]) * ({ px: 1, pt: 96 / 72, in: 96 }[match[2]?.toLowerCase() ?? 'px'] ?? 1);
  if (!Number.isFinite(result) || Math.abs(result) > MAX_COORDINATE) throw new Error('OneNote image position is out of range');
  return result;
}

export function parseOneNoteHtml(source: string): { title: string; text: string; images: PageImage[]; warnings: string[] } {
  const tree = parseXml(source, true);
  const positions = new Map<XmlNode, { x: number; y: number; hidden: boolean }>();
  const texts: string[] = [];
  const images: PageImage[] = [];
  const warnings: string[] = [];
  let title = '';
  walk(tree, (node, parent) => {
    const tag = localName(tagOf(node)).toLowerCase();
    const parentPosition = parent && positions.get(parent);
    const style = new Map((attrs(node).style ?? '').split(';').map((declaration) => {
      const colon = declaration.indexOf(':');
      return [declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim()];
    }));
    const hidden = Boolean(parentPosition?.hidden || ['script', 'style', 'head'].includes(tag));
    const x = (parentPosition?.x ?? 0) + (cssPixels(style.get('left')) ?? 0);
    const y = (parentPosition?.y ?? 0) + (cssPixels(style.get('top')) ?? 0);
    positions.set(node, { x, y, hidden });
    if (tag === 'title') title = unescapeHtml(text(node)).slice(0, 1000);
    if (hidden) return;
    if (tag === '#text') texts.push(unescapeHtml(String(node['#text'])));
    if (['p', 'div', 'br', 'li', 'tr'].includes(tag)) texts.push('\n');
    if (tag === 'td' || tag === 'th') texts.push('\t');
    if (tag !== 'img') return;
    if (images.length >= 20) throw new Error('OneNote page has more than 20 images');
    const width = cssPixels(attrs(node).width) ?? cssPixels(style.get('width'));
    const height = cssPixels(attrs(node).height) ?? cssPixels(style.get('height'));
    const src = attrs(node)['data-fullres-src'] ?? attrs(node).src;
    if (!src || width === undefined || height === undefined || width <= 0 || height <= 0) {
      warnings.push('An image without an explicit size could not be positioned.');
      return;
    }
    images.push({ source: unescapeHtml(src), x, y, width, height });
  });
  const typedText = texts.join('').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  if (typedText.length > 100_000) warnings.push('Typed text was truncated at 100,000 characters.');
  return { title, text: typedText.slice(0, 100_000), images, warnings: [...new Set(warnings)] };
}

/** Graph returns HTML and InkML as UTF-8 MIME parts, not a JSON envelope. */
export function parseOneNoteMultipart(body: Buffer, contentType: string): { html: string; ink?: string } {
  if (body.length > MAX_DOCUMENT_BYTES) throw new Error('OneNote page exceeds 10 MiB');
  if (/^text\/html(?:;|$)/i.test(contentType)) return { html: new TextDecoder('utf-8', { fatal: true }).decode(body) };
  const boundaryMatch = /^multipart\/[\w-]+\s*;[\s\S]*?\bboundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary)) throw new Error('OneNote page has no valid multipart boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  let offset = 0, parts = 0;
  let html: string | undefined, ink: string | undefined;
  const nextBoundary = (from: number): number => {
    let at = body.indexOf(delimiter, from);
    while (at >= 0) {
      const end = at + delimiter.length;
      if ((at === 0 || body.subarray(at - 2, at).equals(Buffer.from('\r\n')))
        && ['\r\n', '--'].includes(body.toString('ascii', end, end + 2))) return at;
      at = body.indexOf(delimiter, at + delimiter.length);
    }
    return -1;
  };
  offset = nextBoundary(0);
  if (offset < 0) throw new Error('OneNote multipart boundary was not found');
  while (offset >= 0) {
    const start = offset + delimiter.length;
    if (body.toString('ascii', start, start + 2) === '--') break;
    if (++parts > 16) throw new Error('Too many OneNote multipart parts');
    const headerEnd = body.indexOf('\r\n\r\n', start + 2);
    if (headerEnd < 0 || headerEnd - start > 16_384) throw new Error('Invalid OneNote multipart headers');
    const end = nextBoundary(headerEnd + 4);
    if (end < 0) throw new Error('OneNote multipart response is incomplete');
    const headers = new Map(body.toString('utf8', start + 2, headerEnd).split('\r\n').map((line) => {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error('Invalid OneNote multipart header');
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    }));
    const encoding = headers.get('content-transfer-encoding')?.toLowerCase();
    if (encoding && !['binary', '8bit', '7bit'].includes(encoding)) throw new Error('Unsupported OneNote multipart encoding');
    const type = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === 'application/inkml+xml') {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(headerEnd + 4, end - 2));
      if (type === 'text/html') {
        if (html !== undefined) throw new Error('Duplicate OneNote HTML part');
        html = value;
      } else {
        if (ink !== undefined) throw new Error('Duplicate OneNote InkML part');
        ink = value;
      }
    }
    offset = end;
  }
  if (html === undefined) throw new Error('OneNote multipart response has no HTML part');
  return { html, ink };
}
