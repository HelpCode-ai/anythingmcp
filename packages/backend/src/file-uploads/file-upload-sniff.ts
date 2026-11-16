/**
 * The real type of an uploaded file, from its first bytes. A public URL is only
 * issued when the bytes and the extension agree on one of PUBLIC_TYPES, so a
 * renamed HTML page or script can never be served as "an image".
 */

export type SniffedType = 'jpeg' | 'png' | 'gif' | 'webp' | 'pdf' | 'mp4' | 'mov' | 'zip' | 'unknown';

export const SNIFF_BYTES = 16;

export function sniffType(head: Buffer): SniffedType {
  const b = head;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    return b.subarray(8, 10).toString('latin1') === 'qt' ? 'mov' : 'mp4';
  }
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return 'zip';
  return 'unknown';
}

const MIME: Record<Exclude<SniffedType, 'unknown'>, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  zip: 'application/zip',
};

const EXT: Record<string, Exclude<SniffedType, 'unknown'>> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.gif': 'gif',
  '.webp': 'webp',
  '.pdf': 'pdf',
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.mov': 'mov',
  '.zip': 'zip',
};

/** Types a provider may fetch through a public URL. ZIP never: it is reference-only. */
const PUBLIC_TYPES = new Set<SniffedType>(['jpeg', 'png', 'gif', 'webp', 'pdf', 'mp4', 'mov']);

export function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(i).toLowerCase() : '';
}

/**
 * The content type stored for the file: the sniffed one when known, else the
 * extension's (text, CSV, Office files…), else plain bytes. Never trusts the
 * extension for the types the sniffer knows: a ".png" that is not a PNG is
 * stored as bytes.
 */
export function mimeForUpload(filename: string, sniffed: SniffedType, byExtension: (name: string) => string): string {
  if (sniffed !== 'unknown') return MIME[sniffed];
  if (EXT[extOf(filename)]) return 'application/octet-stream';
  return byExtension(filename);
}

/** Whether a stored file may get a public URL: bytes and extension agree on a public type. */
export function publicAllowed(filename: string, mimeType: string | null | undefined): boolean {
  const t = EXT[extOf(filename)];
  if (!t || !PUBLIC_TYPES.has(t)) return false;
  // mp4 and mov share the ftyp box; accept either for both extensions.
  const video = t === 'mp4' || t === 'mov';
  if (video) return mimeType === MIME.mp4 || mimeType === MIME.mov;
  return mimeType === MIME[t];
}
