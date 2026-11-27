/**
 * Cloud: an account just created from an invitation still has to enter the
 * code sent to its address. The accept-invite page hands its session to the
 * sign-in page's code step (`/login?verify=invite`) through sessionStorage,
 * this tab only, and never through the URL. The session is not saved as the
 * signed-in one until the code is entered: an unverified Cloud account cannot
 * load the dashboard.
 */
const KEY = 'amcp_invite_email_code';

export interface InviteEmailCodeSession {
  accessToken: string;
  user: { id: string; email: string; emailVerified?: boolean; [key: string]: unknown };
}

export function saveInviteEmailCodeSession(session: InviteEmailCodeSession): boolean {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/** The handed-over session, once: it is removed as it is read. */
export function takeInviteEmailCodeSession(): InviteEmailCodeSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accessToken !== 'string' || typeof parsed?.user?.email !== 'string') return null;
    return parsed as InviteEmailCodeSession;
  } catch {
    return null;
  }
}
