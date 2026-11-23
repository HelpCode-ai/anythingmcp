'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { users, server, organizations, recentSignIn, AUTH_EXPIRED_EVENT, ApiError } from './api';
import { storage } from './storage';
import { clearCommandPaletteCache } from './command-palette-cache';
import { writeNavHint } from './member-access';

/**
 * An admin is never restricted: a hint a restricted member left in this
 * browser must not narrow the admin's first page. For anyone else the hint
 * stays as it is until their own answer is loaded (use-member-visibility.ts).
 */
function forgetNavHintForAdmin(role: string | null | undefined): void {
  if (role === 'ADMIN') writeNavHint(null);
}

/** Who a saved session belongs to, and in which workspace. null when there is none. */
function sessionIdentity(user: Pick<User, 'id' | 'organizationId'> | null | undefined): string | null {
  return user?.id ? `${user.id}:${user.organizationId ?? ''}` : null;
}

function savedSessionIdentity(): string | null {
  // No token means signed out, whatever user record is still there.
  if (!storage.get('amcp_token')) return null;
  try {
    return sessionIdentity(JSON.parse(storage.get('amcp_user') || 'null'));
  } catch {
    return null;
  }
}

interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  organizationId: string | null;
}

interface OrgInfo {
  id: string;
  name: string;
  role: string;
  joinedAt: string;
}

interface AuthContextType {
  token: string | null;
  user: User | null;
  orgName: string | null;
  orgs: OrgInfo[] | null;
  setOrgName: (name: string) => void;
  switchOrg: (organizationId: string) => Promise<void>;
  replaceSession: (token: string, user: User, orgName?: string | null) => void;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateUser: (updates: Partial<User>) => void;
  isLoading: boolean;
  deploymentMode: string;
  /** False until /health/server-info has answered; `deploymentMode` is a guess before that. */
  deploymentModeLoaded: boolean;
}

/** Pages anyone may open without a session. */
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/accept-invite', '/verify-email'];

/**
 * Pages that decide themselves whether a sign-in is needed, so the guard
 * below leaves them alone without a session:
 * - /f/<token>: File Share links.
 * - /s/<token>: setup links first try the sign-in the browser just made to
 *   connect an AI client, then send to /login themselves.
 * - /setup/file-search: the File Search plugin's hand-off, the same way.
 * - /reactivate/<token>: the no-login page an AI client links to once the
 *   trial ended; the token stands in for a session.
 * - /upload/<token>: one-time upload link from an AI client; the token is the credential.
 */
function decidesOwnSignIn(pathname: string): boolean {
  return (
    pathname.startsWith('/f/') ||
    pathname.startsWith('/s/') ||
    pathname.startsWith('/reactivate/') ||
    pathname.startsWith('/upload/') ||
    pathname === '/setup/file-search'
  );
}

/** Where to sign in again, coming back to the page (and its query) afterwards. */
function signInPathFor(pathname: string, search: string): string {
  return `/login?redirect=${encodeURIComponent(pathname + search)}`;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
  orgName: null,
  orgs: null,
  setOrgName: () => {},
  switchOrg: async () => {},
  replaceSession: () => {},
  login: () => {},
  logout: () => {},
  updateUser: () => {},
  isLoading: true,
  deploymentMode: 'self-hosted',
  deploymentModeLoaded: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgInfo[] | null>(null);
  const [deploymentMode, setDeploymentMode] = useState('self-hosted');
  const [deploymentModeLoaded, setDeploymentModeLoaded] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const fetchOrgData = useCallback(async (t: string) => {
    try {
      const [orgInfo, orgList] = await Promise.all([
        organizations.getCurrent(t),
        organizations.listMine(t),
      ]);
      setOrgName(orgInfo.name);
      setOrgs(orgList);
    } catch {}
  }, []);

  /** Forgets the session in this browser, without going anywhere. */
  const endSession = useCallback(() => {
    clearCommandPaletteCache();
    // Signing out also forgets the authorization page's recent sign-in, or
    // the sign-in page would offer "Continue as …" right after.
    void recentSignIn.forget();
    setToken(null);
    setUser(null);
    setOrgName(null);
    setOrgs(null);
    storage.remove('amcp_token');
    storage.remove('amcp_user');
    document.cookie = 'amcp_token=; path=/; max-age=0';
  }, []);

  /** "Sign out" chosen by the user: on to the sign-in page. */
  const logout = useCallback(() => {
    endSession();
    router.push('/login');
  }, [endSession, router]);

  // On mount: restore saved token and validate it against the backend
  useEffect(() => {
    const savedToken = storage.get('amcp_token');
    const savedUser = storage.get('amcp_user');

    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));

      const refresh = () =>
        users.me(savedToken).then((freshUser) => {
          setUser(freshUser);
          storage.set('amcp_user', JSON.stringify(freshUser));
          fetchOrgData(savedToken);
        });

      refresh().catch((err) => {
        if (err instanceof ApiError && err.status < 500) {
          // The backend answered and rejected the session.
          clearCommandPaletteCache();
          setToken(null);
          setUser(null);
          storage.remove('amcp_token');
          storage.remove('amcp_user');
          document.cookie = 'amcp_token=; path=/; max-age=0';
          return;
        }
        // No answer (offline, a laptop waking before its network) or a 5xx
        // during a deploy says nothing about the session. Signing out here
        // sent people to /login, offline, for a token that was still valid
        // (ANYTHINGMCP-CLOUD-FRONTEND-7). Keep the saved session and check
        // it again once the connection is back; a real 401 still signs out
        // through AUTH_EXPIRED_EVENT.
        window.addEventListener('online', () => void refresh().catch(() => {}), { once: true });
      }).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch deployment mode on mount
  useEffect(() => {
    server.info().then((info) => {
      setDeploymentMode(info.deploymentMode || 'self-hosted');
    }).catch(() => {}).finally(() => setDeploymentModeLoaded(true));
  }, []);

  // The session lives in localStorage, which every tab of the browser shares.
  // When another tab signs out, signs in as someone else or switches
  // workspace, this tab kept its own copy in memory: the old name and
  // navigation on screen, the other account's token on the next reload, and
  // in between requests answered for a workspace the page did not show. Load
  // the page again as soon as the saved session is no longer this tab's, so
  // it shows one identity, the current one. A tab that is signed out is left
  // alone (someone may be typing on a sign-in page).
  const identityRef = useRef<string | null>(null);
  useEffect(() => {
    identityRef.current = token ? sessionIdentity(user) : null;
  }, [token, user]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // `key` is null when the whole storage was cleared.
      if (event.key !== null && event.key !== 'amcp_token' && event.key !== 'amcp_user') return;
      const mine = identityRef.current;
      if (!mine || savedSessionIdentity() === mine) return;
      clearCommandPaletteCache();
      window.location.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // A 401 on an authenticated request: the saved session is no longer valid
  // (expired, or its account was deleted). Forget it, but keep the page and
  // its address. Sending everyone to a bare /login dropped `?redirect=` and
  // `?mode=register` from the sign-up an AI client's authorization page opens
  // ("Create an account"), so a browser holding an old session finished that
  // sign-up on the dashboard instead of back in the authorization.
  // - a public page (/login, sign-up, …) stays where it is;
  // - a page that decides its own sign-in goes to /login and comes back;
  // - any other page is sent there by the guard below, which comes back too.
  useEffect(() => {
    const handleAuthExpired = () => {
      endSession();
      const { pathname: path, search } = window.location;
      if (decidesOwnSignIn(path)) router.push(signInPathFor(path, search));
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [endSession, router]);

  useEffect(() => {
    if (!isLoading && !token && !PUBLIC_PATHS.includes(pathname) && !decidesOwnSignIn(pathname)) {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      router.push(signInPathFor(pathname, search));
    }
  }, [isLoading, token, pathname, router]);

  const login = (newToken: string, newUser: User) => {
    // What the command palette remembered belongs to whoever was signed in
    // before: accepting an invitation in an admin's tab showed the admin's
    // connector names to the new member until the list was loaded again.
    clearCommandPaletteCache();
    forgetNavHintForAdmin(newUser.role);
    setToken(newToken);
    setUser(newUser);
    storage.set('amcp_token', newToken);
    storage.set('amcp_user', JSON.stringify(newUser));
    document.cookie = `amcp_token=${newToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
    fetchOrgData(newToken);
  };

  const switchOrg = async (organizationId: string) => {
    if (!token) return;
    try {
      clearCommandPaletteCache();
      const result = await organizations.switchOrg(organizationId, token);
      // Store new token and user from the switch response
      forgetNavHintForAdmin(result.user?.role);
      setToken(result.accessToken);
      setUser(result.user);
      storage.set('amcp_token', result.accessToken);
      storage.set('amcp_user', JSON.stringify(result.user));
      document.cookie = `amcp_token=${result.accessToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
      // Update org data
      setOrgName(result.organization?.name || null);
      await fetchOrgData(result.accessToken);
      // Reload the page to refresh all data
      window.location.href = '/';
    } catch (err) {
      console.error('Failed to switch org:', err);
    }
  };

  const replaceSession = (newToken: string, newUser: User, newOrgName?: string | null) => {
    clearCommandPaletteCache();
    forgetNavHintForAdmin(newUser.role);
    setToken(newToken);
    setUser(newUser);
    storage.set('amcp_token', newToken);
    storage.set('amcp_user', JSON.stringify(newUser));
    document.cookie = `amcp_token=${newToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
    if (newOrgName !== undefined) setOrgName(newOrgName);
  };

  const updateUser = (updates: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, ...updates };
      storage.set('amcp_user', JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <AuthContext.Provider value={{ token, user, orgName, orgs, setOrgName, switchOrg, replaceSession, login, logout, updateUser, isLoading, deploymentMode, deploymentModeLoaded }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
