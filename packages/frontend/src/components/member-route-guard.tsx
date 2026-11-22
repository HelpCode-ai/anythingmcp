'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { MEMBER_FALLBACK_PATH, isMemberGuardedPath, type Access } from '@/lib/member-access';
import { useMemberAccess } from '@/lib/use-member-access';
import { useToast } from '@/components/toast';

/**
 * Keeps a restricted member out of the pages that are not theirs.
 *
 * The sidebar and the command palette no longer list those pages, but a URL
 * can still be typed, bookmarked or sent by a colleague. Each of them used to
 * open its own shell and then show a 403 text or an "Access Denied" panel,
 * after asking the API for the admin data. Here every such URL ends in one
 * place: the connectors list, with a short note. The page is not rendered
 * until the answer is known, so nothing of it is drawn and none of its
 * requests is sent.
 *
 * It only ever acts on the paths `isMemberGuardedPath` names and only for a
 * member whose view member visibility narrows (lib/member-access.ts). Admins,
 * members of an Open workspace, signed-out visitors and every other path pass
 * straight through. The API stays the access control; this is where the
 * dashboard stops offering what it would refuse.
 */
export function MemberRouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { token, isLoading } = useAuth();
  const access = useMemberAccess();
  const toast = useToast();
  const t = useTranslations('memberAccess');
  const redirectedFrom = useRef<string | null>(null);

  // Signed out: the page, or the auth context, sends to the sign-in page.
  const signedOut = !isLoading && !token;
  const verdict: Access =
    !isMemberGuardedPath(pathname) || signedOut || !access.restricted
      ? 'allow'
      : access.decided
        ? access.access(pathname)
        : 'pending';

  useEffect(() => {
    if (verdict !== 'deny') return;
    // Once per path: a development build runs effects twice.
    if (redirectedFrom.current === pathname) return;
    redirectedFrom.current = pathname;
    toast.show({ title: t('notAvailableTitle'), description: t('notAvailableBody'), tone: 'info' });
    router.replace(MEMBER_FALLBACK_PATH);
  }, [verdict, pathname, router, toast, t]);

  if (verdict !== 'allow') return null;
  return <>{children}</>;
}
