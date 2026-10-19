'use client';

import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { ToastProvider } from '@/components/toast';
import { OnboardingRedirect } from '@/components/onboarding-redirect';
import { SupportChat } from '@/components/support-chat';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          {/* No DOM; runs the welcome-wizard gate on every navigation. */}
          <OnboardingRedirect />
          {/* No DOM; loads the support chat where the instance offers it. */}
          <SupportChat />
          {children}
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
