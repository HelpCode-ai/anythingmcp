'use client';

import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { ToastProvider } from '@/components/toast';
import { OnboardingRedirect } from '@/components/onboarding-redirect';
import { SupportChat } from '@/components/support-chat';
import { NavHintProvider } from '@/lib/use-member-access';
import type { NavHint } from '@/lib/member-access';
import { PendingAuthorizationBar } from '@/components/pending-authorization-bar';

export function Providers({ children, navHint = null }: { children: React.ReactNode; navHint?: NavHint }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        {/* What the server knew about this browser's member, for the first paint (lib/member-access.ts). */}
        <NavHintProvider hint={navHint}>
          <ToastProvider>
            {/* No DOM; runs the welcome-wizard gate on every navigation. */}
            <OnboardingRedirect />
            {/* No DOM; loads the support chat where the instance offers it. */}
            <SupportChat />
            {/* Cloud only: the way back to an AI client's unfinished authorization. */}
            <PendingAuthorizationBar />
            {children}
          </ToastProvider>
        </NavHintProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
