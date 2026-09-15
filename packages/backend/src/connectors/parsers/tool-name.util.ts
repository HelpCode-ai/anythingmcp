import { createHash } from 'crypto';

/**
 * The longest tool name an MCP client is guaranteed to accept. The Claude
 * connectors directory refuses anything longer; other clients truncate or
 * fail silently.
 */
export const MAX_TOOL_NAME_LENGTH = 64;

const HASH_LENGTH = 6;

/**
 * Fits a generated tool name into MAX_TOOL_NAME_LENGTH without letting two
 * long names collapse into one.
 *
 * Plain truncation is not enough: an OpenAPI spec such as Microsoft Graph
 * produces hundreds of operationIds that share their first 64 characters
 * (`drives_drive_items_driveitem_workbook_worksheets_…`), and `McpTool` is
 * unique per (connector, name). So the tail is replaced by a short hash of
 * the FULL original name — deterministic, so re-importing the same spec
 * yields the same names and existing role assignments keep matching.
 */
export function capToolName(name: string): string {
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = createHash('sha1')
    .update(name)
    .digest('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, HASH_LENGTH)
    .toLowerCase();
  const keep = MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1;
  // Cut on a word boundary when one is near, so the prefix stays readable.
  let head = name.slice(0, keep);
  const boundary = head.lastIndexOf('_');
  if (boundary >= keep - 12) head = head.slice(0, boundary);
  return `${head}_${hash}`;
}
