'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';

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
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
  login: () => {},
  logout: () => {},
  isLoading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const savedToken = localStorage.getItem('amcp_token');
    const savedUser = localStorage.getItem('amcp_user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    setIsLoading(false);
  }, []);

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

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('amcp_token');
    localStorage.removeItem('amcp_user');
    // Clear cookie
    document.cookie = 'amcp_token=; path=/; max-age=0';
    router.push('/login');
  };

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
