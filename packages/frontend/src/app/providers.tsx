'use client';

import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { ToastProvider } from '@/components/toast';
import { OnboardingRedirect } from '@/components/onboarding-redirect';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          {/* No DOM; runs the welcome-wizard gate on every navigation. */}
          <OnboardingRedirect />
          {children}
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
