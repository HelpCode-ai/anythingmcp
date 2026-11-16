/**
 * Whether the signed-in user may change a connector: its owner (unless a
 * viewer) or a workspace admin, the rule every write route of the API
 * applies. The reduced view a restricted member gets of a connector they do
 * not own (`memberView: true`, see docs/operations/member-visibility.md)
 * carries no owner and is never manageable.
 *
 * The Connectors pages show Edit, Test, Variables, Delete and the other
 * controls that write only when this is true, in every member visibility
 * mode, instead of offering a form whose save answers 403.
 */
export function canManageConnector(
  user: { id?: string; role?: string } | null | undefined,
  connector: { userId?: string; memberView?: boolean } | null | undefined,
): boolean {
  if (!user || !connector || connector.memberView) return false;
  return user.role === 'ADMIN' || (user.role !== 'VIEWER' && !!user.id && user.id === connector.userId);
}
