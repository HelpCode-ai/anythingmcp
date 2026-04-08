'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { users, server, organizations, AUTH_EXPIRED_EVENT } from './api';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
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
  login: (token: string, user: User) => void;
  logout: () => void;
  updateUser: (updates: Partial<User>) => void;
  isLoading: boolean;
  deploymentMode: string;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
  orgName: null,
  orgs: null,
  setOrgName: () => {},
  switchOrg: async () => {},
  login: () => {},
  logout: () => {},
  updateUser: () => {},
  isLoading: true,
  deploymentMode: 'self-hosted',
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgInfo[] | null>(null);
  const [deploymentMode, setDeploymentMode] = useState('self-hosted');
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

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setOrgName(null);
    setOrgs(null);
    localStorage.removeItem('amcp_token');
    localStorage.removeItem('amcp_user');
    document.cookie = 'amcp_token=; path=/; max-age=0';
    router.push('/login');
  }, [router]);

  // On mount: restore saved token and validate it against the backend
  useEffect(() => {
    const savedToken = localStorage.getItem('amcp_token');
    const savedUser = localStorage.getItem('amcp_user');

    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));

      users.me(savedToken).then((freshUser) => {
        setUser(freshUser);
        localStorage.setItem('amcp_user', JSON.stringify(freshUser));
        fetchOrgData(savedToken);
        setIsLoading(false);
      }).catch(() => {
        setToken(null);
        setUser(null);
        localStorage.removeItem('amcp_token');
        localStorage.removeItem('amcp_user');
        document.cookie = 'amcp_token=; path=/; max-age=0';
        setIsLoading(false);
      });
    } else {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch deployment mode on mount
  useEffect(() => {
    server.info().then((info) => {
      setDeploymentMode(info.deploymentMode || 'self-hosted');
    }).catch(() => {});
  }, []);

  // Listen for 401 events from api.ts to auto-logout
  useEffect(() => {
    const handleAuthExpired = () => logout();
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [logout]);

  useEffect(() => {
    const publicPaths = ['/login', '/register', '/forgot-password', '/reset-password', '/accept-invite', '/verify-email'];
    if (!isLoading && !token && !publicPaths.includes(pathname)) {
      const currentUrl = typeof window !== 'undefined' ? window.location.pathname + window.location.search : pathname;
      router.push(`/login?redirect=${encodeURIComponent(currentUrl)}`);
    }
  }, [isLoading, token, pathname, router]);

  const login = (newToken: string, newUser: User) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('amcp_token', newToken);
    localStorage.setItem('amcp_user', JSON.stringify(newUser));
    document.cookie = `amcp_token=${newToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
    fetchOrgData(newToken);
  };

  const switchOrg = async (organizationId: string) => {
    if (!token) return;
    try {
      const result = await organizations.switchOrg(organizationId, token);
      // Store new token and user from the switch response
      setToken(result.accessToken);
      setUser(result.user);
      localStorage.setItem('amcp_token', result.accessToken);
      localStorage.setItem('amcp_user', JSON.stringify(result.user));
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

  const updateUser = (updates: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, ...updates };
      localStorage.setItem('amcp_user', JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <AuthContext.Provider value={{ token, user, orgName, orgs, setOrgName, switchOrg, login, logout, updateUser, isLoading, deploymentMode }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
