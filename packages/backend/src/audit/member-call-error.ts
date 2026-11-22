/**
 * The error text of a failed call, as a restricted member reads it for a
 * connector they see in the reduced view.
 *
 * In a workspace with restricted member visibility, a member who does not own
 * a connector is not told where it connects (docs/operations/member-visibility.md).
 * The stored error of a call says exactly that: "Host not found:
 * 'erp.corp.example' could not be resolved", a response body quoting the
 * request URL, a database error naming host, database and user. The audit log
 * and the tool performance list handed it back.
 *
 * Picking the address out of the text cannot be done reliably (it may be a
 * variable of the connector, an IP the name resolved to, or the provider's own
 * words), so the text is replaced as a whole, the way the health check does
 * for the same members: the HTTP status the call ended with, when the stored
 * text starts with one, and a fixed sentence. The owner of the connector and
 * the workspace admins keep the full text.
 */
export const MEMBER_CALL_ERROR =
  "The call failed. Its details are kept for the connector's owner and the workspace admins.";

/** `<status> <reason>: ...` as DynamicMcpTools.formatStoredError writes it. */
const LEADING_HTTP_STATUS = /^([1-5]\d\d)(?![\d.])/;

export function memberCallError<T extends string | null | undefined>(error: T): T | string {
  if (!error) return error;
  const status = LEADING_HTTP_STATUS.exec(error)?.[1];
  return status ? `HTTP ${status}. ${MEMBER_CALL_ERROR}` : MEMBER_CALL_ERROR;
}
