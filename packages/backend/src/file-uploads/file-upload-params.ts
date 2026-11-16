/**
 * Which parameters of a REST tool feed a `{ "__file": "$param" }` marker in its
 * bodyMapping, and the hint that tells the model it may pass an uploaded file's
 * reference there. The tool JSONs stay untouched: editing 58 adapters would
 * re-sync every installed connector at boot.
 */

export const FILE_REF_PREFIX = 'amcp-file:';
export const FILE_REF_RE = /^amcp-file:([a-f0-9]{24})$/;
export const FILE_UPLOAD_LINK_TOOL = 'file_upload_link';
export const FILE_PUBLIC_URL_TOOL = 'file_public_url';

export const FILE_REF_HINT =
  ` Or, for a file you created yourself, the reference "amcp-file:<id>" returned by ${FILE_UPLOAD_LINK_TOOL}.`;

export function isFileRef(value: unknown): value is string {
  return typeof value === 'string' && FILE_REF_RE.test(value.trim());
}

/** Parameter names (without `$`) behind the tool's own top-level __file markers. */
export function fileParamNames(bodyMapping: unknown): string[] {
  if (!bodyMapping || typeof bodyMapping !== 'object' || Array.isArray(bodyMapping)) return [];
  const out: string[] = [];
  for (const v of Object.values(bodyMapping as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !('__file' in v)) continue;
    const ref = (v as { __file: unknown }).__file;
    if (typeof ref === 'string' && ref.startsWith('$') && ref.length > 1) out.push(ref.slice(1));
  }
  return out;
}

/**
 * A copy of the tool's JSON schema whose file parameters mention the upload
 * reference. Returns the schema unchanged when the tool takes no file.
 */
export function withFileRefHints<T>(schema: T, bodyMapping: unknown): T {
  const names = fileParamNames(bodyMapping);
  const props = (schema as { properties?: Record<string, any> } | null)?.properties;
  if (!names.length || !props) return schema;
  const next: Record<string, any> = { ...props };
  let changed = false;
  for (const n of names) {
    const p = next[n];
    if (!p || typeof p !== 'object') continue;
    const desc = typeof p.description === 'string' ? p.description : '';
    if (desc.includes(FILE_REF_PREFIX)) continue;
    next[n] = { ...p, description: `${desc}${FILE_REF_HINT}`.trim() };
    changed = true;
  }
  return changed ? ({ ...(schema as object), properties: next } as T) : schema;
}
