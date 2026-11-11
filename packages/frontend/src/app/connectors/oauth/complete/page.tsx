'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { ApiError, connectors, type MetaInstagramAccount } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Where "Authorize with Provider" lands. The provider sends the browser to the
 * backend callback, which only checks the state and forwards the code here;
 * this page exchanges it in an authenticated request, so the server can check
 * that the person completing the authorization is the one who started it.
 *
 * A TikTok Shop App Store install (`provider=tiktok-shop-install`) arrives
 * with a state only: the code stays on the server. Nobody started it here,
 * so a signed-out visitor is asked to sign in or create an account first,
 * and comes back to this address to add and authorize the connector.
 *
 * A Facebook sign-in of an Instagram connector (`provider=meta`) can reach
 * several Instagram accounts: the token is stored, and the user picks the
 * account here.
 */
function CompleteContent() {
  const params = useSearchParams();
  const router = useRouter();
  const { token, isLoading } = useAuth();
  const [error, setError] = useState<string | null>(params.get('error'));
  const started = useRef(false);

  // Read once: the address is cleared below (the code has no business in the
  // history), and reading it again would show "Nothing to complete here"
  // while the completion is still running.
  const [initial] = useState(() => ({
    state: params.get('state'),
    code: params.get('code'),
    provider: params.get('provider'),
    shopId: params.get('shop_id'),
  }));
  const state = initial.state;
  const code = initial.code;
  // A Shopee shop authorization comes back through its own callback, with the
  // shop id next to the code, and is completed by its own endpoint.
  const shopeeShopId = initial.provider === 'shopee' ? initial.shopId : null;
  // A TikTok Shop authorization too, completed by its own endpoint.
  const isTikTokShop = initial.provider === 'tiktok-shop';
  // A TikTok Shop App Store install: no code in the address, the server keeps it.
  const isTikTokShopInstall = initial.provider === 'tiktok-shop-install';
  // A Meta sign-in of an Instagram connector: every outcome goes back to the
  // connector page, which shows what happened and the next step.
  const isMeta = initial.provider === 'meta';
  // Several Instagram accounts behind one Meta sign-in: the user picks one.
  const [choice, setChoice] = useState<{
    connectorId: string;
    accounts: MetaInstagramAccount[];
    returnTo?: string;
  } | null>(null);
  const [choosing, setChoosing] = useState(false);
  // From the provider redirect, or from the answer when the exchange is refused.
  const [connectorId, setConnectorId] = useState<string | null>(params.get('connectorId'));

  useEffect(() => {
    if (error || !state || started.current || isLoading) return;
    if (isTikTokShopInstall) {
      // Signed out: the page offers sign-in and sign-up (below).
      if (!token) return;
      started.current = true;
      window.history.replaceState({}, '', '/connectors/oauth/complete');
      connectors
        .tiktokShopInstall(state, token)
        .then((out) => router.replace(`/connectors/${out.connectorId}?oauth=success&tools=${out.toolsImported}`))
        .catch((err: Error) => {
          if (err instanceof ApiError && typeof err.body?.connectorId === 'string') {
            setConnectorId(err.body.connectorId);
          }
          setError(err.message || 'The TikTok Shop installation could not be completed.');
        });
      return;
    }
    if (!code) return;
    if (!token) {
      // Sign in first, then come back here with the same code.
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?redirect=${encodeURIComponent(here)}`);
      return;
    }
    started.current = true;
    // The code is single-use and bound to a verifier the server keeps, but it
    // still has no business staying in the address bar or the history.
    window.history.replaceState({}, '', '/connectors/oauth/complete');
    if (isMeta) {
      connectors
        .metaComplete(state, code, token)
        .then((out) => {
          const status = out.account ? 'connected' : out.noAccount ? 'no_account' : 'choose';
          router.replace(`/connectors/${out.connectorId}?meta=${status}`);
        })
        .catch((err: Error) => {
          const id = err instanceof ApiError && typeof err.body?.connectorId === 'string' ? err.body.connectorId : null;
          const message = err.message || 'The authorization could not be completed.';
          if (id) router.replace(`/connectors/${id}?meta=error&message=${encodeURIComponent(message)}`);
          else setError(message);
        });
      return;
    }
    (shopeeShopId !== null
      ? connectors.shopeeComplete(state, code, shopeeShopId, token)
      : isTikTokShop
        ? connectors.tiktokShopComplete(state, code, token)
        : connectors.oauthComplete(state, code, token))
      .then((out: { connectorId: string; toolsImported: number; returnTo?: string; accounts?: MetaInstagramAccount[] }) => {
        if (out.accounts && out.accounts.length > 0) {
          setChoice({ connectorId: out.connectorId, accounts: out.accounts, returnTo: out.returnTo });
          return;
        }
        const fallback = `/connectors/${out.connectorId}?oauth=success&tools=${out.toolsImported}`;
        router.replace(out.returnTo || fallback);
      })
      .catch((err: Error) => {
        if (err instanceof ApiError && typeof err.body?.connectorId === 'string') {
          setConnectorId(err.body.connectorId);
        }
        setError(err.message || 'The authorization could not be completed.');
      });
  }, [error, state, code, shopeeShopId, isTikTokShop, isTikTokShopInstall, isMeta, token, isLoading, router]);

  const choose = (account: MetaInstagramAccount) => {
    if (!choice || !token) return;
    setChoosing(true);
    connectors
      .metaChooseAccount(choice.connectorId, account.id, token)
      .then(() => router.replace(choice.returnTo || `/connectors/${choice.connectorId}?oauth=success&tools=0`))
      .catch((err: Error) => {
        setConnectorId(choice.connectorId);
        setChoice(null);
        setError(err.message || 'The Instagram account could not be saved.');
      })
      .finally(() => setChoosing(false));
  };

  if (!error && choice) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-[var(--text)]">Choose the Instagram account</h1>
        <p className="text-sm text-[var(--text-2)]">
          The sign-in reaches several Instagram accounts. Pick the one this connector should use; you can sign in
          again later to switch.
        </p>
        <ul className="space-y-2">
          {choice.accounts.map((a) => (
            <li key={a.id}>
              <Button
                variant="secondary"
                className="w-full justify-between"
                disabled={choosing}
                onClick={() => choose(a)}
              >
                <span>{a.username ? `@${a.username}` : a.id}</span>
                {a.pageName && <span className="text-xs text-[var(--text-3)]">{a.pageName}</span>}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!error && !state) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-2)]">There is no authorization waiting here.</p>
        <Link
          href={connectorId ? `/connectors/${connectorId}` : '/connectors'}
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
        >
          {connectorId ? 'Back to the connector' : 'Back to connectors'}
        </Link>
      </div>
    );
  }

  // Someone coming from the TikTok Shop App Store may have no account yet:
  // offer both, and come back here with the same state.
  if (!error && isTikTokShopInstall && !isLoading && !token) {
    const back = encodeURIComponent(`/connectors/oauth/complete?${params.toString()}`);
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-[var(--text)]">Connect your TikTok shop</h1>
        <p className="text-sm text-[var(--text-2)]">
          Sign in to AnythingMCP, or create an account, to add the TikTok Shop connector to your workspace. Your shop is
          authorized as soon as you are back here. Finish within 30 minutes, or install the app again from the TikTok
          Shop App Store.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href={`/login?redirect=${back}`} className={cn(buttonVariants({ size: 'sm' }))}>
            Sign in
          </Link>
          <Link href={`/login?mode=register&redirect=${back}`} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
            Create an account
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-[var(--text)]">Authorization not completed</h1>
        <p role="alert" className="text-sm text-[var(--text-2)]">{error}</p>
        <Link
          href={connectorId ? `/connectors/${connectorId}` : '/connectors'}
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
        >
          {connectorId ? 'Back to the connector' : 'Back to connectors'}
        </Link>
      </div>
    );
  }

  return (
    <p className="text-sm text-[var(--text-2)]">
      {isTikTokShopInstall ? 'Adding your TikTok shop…' : 'Completing the authorization…'}
    </p>
  );
}

export default function OAuthCompletePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-6">
      <Card className="w-full max-w-md p-6">
        <Suspense fallback={<p className="text-sm text-[var(--text-2)]">Loading…</p>}>
          <CompleteContent />
        </Suspense>
      </Card>
    </div>
  );
}
