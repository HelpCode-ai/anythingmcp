import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';

/** The Cloud host. Self-hosted installs keep the whole app out of search. */
const CLOUD_HOST = 'cloud.anythingmcp.com';

/**
 * The sign-in page is the one page of the app worth finding in search
 * ("anythingmcp login"), so on Cloud it is indexable, with its own title
 * and description. /login?mode=register and /login?redirect=<page> are the
 * same page: the canonical folds them into /login.
 *
 * Decided by the request host because the frontend container is not given
 * DEPLOYMENT_MODE (docker-compose.cloud.yml passes it only what the Next.js
 * server reads).
 */
export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get('host')?.split(':')[0];
  if (host !== CLOUD_HOST) return {};
  return {
    title: 'Sign in to AnythingMCP Cloud',
    description:
      'Sign in to AnythingMCP Cloud or start a 7-day free trial. Connect SAP, DATEV, databases and any REST or SOAP API to Claude, ChatGPT and Copilot.',
    alternates: { canonical: `https://${CLOUD_HOST}/login` },
    robots: { index: true, follow: true },
  };
}

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
