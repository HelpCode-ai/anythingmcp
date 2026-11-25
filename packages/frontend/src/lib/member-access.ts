/**
 * What a signed-in member may open in the dashboard.
 *
 * The one place that decides it. The sidebar, the command palette, the
 * settings navigation, the links on the pages a member keeps and the route
 * guard (components/member-route-guard.tsx) all ask `accessTo`, so an entry
 * that is hidden is also a URL that does not open, and the other way round.
 *
 * It narrows anything only for a member whose view member visibility
 * restricts: someone who is not an admin, in a workspace set to Restricted
 * (Settings → Organization; docs/operations/member-visibility.md). Admins and
 * every member of an Open workspace get `allow` for every path, so nothing
 * changes for them.
 *
 * This is navigation, not access control: the API decides what a member reads
 * and changes, whatever the dashboard shows. The rules below follow the API
 * (packages/backend/src/settings/member-visibility.routes.ts): a page is
 * hidden when every request it would make is refused to this member, or when
 * it sets up something they cannot create.
 */

export type Access = 'allow' | 'deny' | 'pending';

export interface MemberAccessFacts {
  /** The member's role in the active workspace. Unknown is treated as VIEWER. */
  role: string | null | undefined;
  /** Member visibility narrows this member's view. False for admins and in Open mode. */
  restricted: boolean;
  /**
   * Whether the member owns an MCP server (a restricted member is shown only
   * their own). null while not known yet.
   */
  ownsMcpServer: boolean | null;
  /**
   * Whether Memory has something for the member: it is licensed here and
   * their memory access, set by an admin, is not "none" (or they curate the
   * company memory as an EDITOR). null while not known yet.
   */
  memoryAccess: boolean | null;
}

/** Where a restricted member lands when they open a page that is not theirs. */
export const MEMBER_FALLBACK_PATH = '/connectors';

/** Settings pages of workspace admins. */
const ADMIN_SETTINGS = [
  '/settings/users',
  '/settings/roles',
  '/settings/identity-providers',
  '/settings/license',
  '/settings/admin',
  // The pages these moved from; they still exist.
  '/admin',
];

/** Creating a connector: the form, the catalog and its guided setup. */
const CONNECTOR_CREATION = ['/connectors/new', '/connectors/store', '/connectors/setup'];

/**
 * Other members' work (the graph of every connector, skills and lessons
 * learned from their requests): the API answers 403 to a restricted member.
 */
const WORKSPACE_KNOWLEDGE = ['/knowledge-graph'];

/** The first-run wizard: it sets a workspace up, which is not a member's job. */
const WORKSPACE_SETUP = ['/welcome'];

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

const anyUnder = (pathname: string, bases: readonly string[]) => bases.some((b) => under(pathname, b));

const known = (fact: boolean | null): Access => (fact === null ? 'pending' : fact ? 'allow' : 'deny');

/**
 * Whether the member may open `pathname` (no query string). `pending` means a
 * fact it depends on is still loading: do not show the entry, do not render
 * the page, do not redirect yet.
 */
export function accessTo(pathname: string, facts: MemberAccessFacts): Access {
  if (!facts.restricted) return 'allow';
  // Only an EDITOR creates connectors and MCP servers. Any other value,
  // including one this code does not know, gets the narrower VIEWER answer.
  const editor = facts.role === 'EDITOR';

  if (anyUnder(pathname, CONNECTOR_CREATION)) return editor ? 'allow' : 'deny';
  if (under(pathname, '/mcp-server')) return editor ? 'allow' : known(facts.ownsMcpServer);
  if (anyUnder(pathname, WORKSPACE_KNOWLEDGE)) return 'deny';
  if (under(pathname, '/memory')) return known(facts.memoryAccess);
  if (anyUnder(pathname, WORKSPACE_SETUP)) return 'deny';
  if (anyUnder(pathname, ADMIN_SETTINGS)) return 'deny';
  return 'allow';
}

/**
 * Whether `pathname` is one a restricted member may be refused, whatever
 * their role and facts. The route guard leaves every other path alone, so the
 * sign-in pages, token links and the pages every member keeps never wait for
 * it.
 */
export function isMemberGuardedPath(pathname: string): boolean {
  return (
    accessTo(pathname, { role: 'VIEWER', restricted: true, ownsMcpServer: false, memoryAccess: false }) !== 'allow'
  );
}

/**
 * Whether the member may create a workspace. Cloud: everyone runs their own.
 * Self-hosted: only an admin, because the creator becomes the ADMIN of the new
 * workspace (POST /api/organizations answers 403 to anyone else there).
 */
export function canCreateWorkspace(role: string | null | undefined, isCloud: boolean): boolean {
  return isCloud || role === 'ADMIN';
}

// ── The navigation hint ────────────────────────────────────────────────────

/**
 * Whether the dashboard last knew this browser's member as restricted, kept in
 * a cookie so the server can render that member's navigation before any
 * script runs.
 *
 * The cookie exists only for a restricted member. Without it (an admin, a
 * member of an Open workspace, or a browser the dashboard has not seen yet)
 * everything renders as it always did: the whole navigation and every page.
 * Almost every workspace is Open with one admin, and they must not wait for
 * anything. A restricted member on their very first load in a browser sees
 * the whole navigation until their answer has loaded, a moment later; from
 * then on the cookie is there and the first HTML is already theirs.
 *
 * A hint only: it decides what is drawn while the answer loads, never what
 * the member may read. The answer itself always comes from the API.
 */
export type NavHint = 'restricted' | null;
export const NAV_HINT_COOKIE = 'amcp_nav';

export function parseNavHint(raw: string | null | undefined): NavHint {
  return raw === 'restricted' ? raw : null;
}

/** Stores the hint for the next page load; `null` removes the cookie. Browser only. */
export function writeNavHint(hint: NavHint): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = hint
      ? `${NAV_HINT_COOKIE}=${hint}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`
      : `${NAV_HINT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    // A browser that refuses cookies only loses the hint.
  }
}
