'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { users, server, AUTH_EXPIRED_EVENT } from './api';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface AuthContextType {
  token: string | null;
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateUser: (updates: Partial<User>) => void;
  isLoading: boolean;
  deploymentMode: string;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
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
  const [deploymentMode, setDeploymentMode] = useState('self-hosted');
  const router = useRouter();
  const pathname = usePathname();

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('amcp_token');
    localStorage.removeItem('amcp_user');
    // Clear cookie
    document.cookie = 'amcp_token=; path=/; max-age=0';
    router.push('/login');
  }, [router]);

  // On mount: restore saved token and validate it against the backend
  useEffect(() => {
    const savedToken = localStorage.getItem('amcp_token');
    const savedUser = localStorage.getItem('amcp_user');

    if (savedToken && savedUser) {
      // Optimistically set state for instant UI
      setToken(savedToken);
      setUser(JSON.parse(savedUser));

      // Validate the token is still accepted by the backend
      users.me(savedToken).then((freshUser) => {
        setUser(freshUser);
        localStorage.setItem('amcp_user', JSON.stringify(freshUser));
        setIsLoading(false);
      }).catch(() => {
        // Token rejected — clear and redirect to login
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
      router.push('/login');
    }
  }, [isLoading, token, pathname, router]);

  const login = (newToken: string, newUser: User) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('amcp_token', newToken);
    localStorage.setItem('amcp_user', JSON.stringify(newUser));
    // Set cookie for middleware auth check
    document.cookie = `amcp_token=${newToken}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
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
    <AuthContext.Provider value={{ token, user, login, logout, updateUser, isLoading, deploymentMode }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
