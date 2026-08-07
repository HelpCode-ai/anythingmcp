import type { OAuthProviderConfig } from '@rekog/mcp-nest';
import { LocalOAuthStrategy } from './local-oauth.strategy';

export const LocalOAuthProvider: OAuthProviderConfig = {
  name: 'local',
  displayName: 'Local Login',
  strategy: LocalOAuthStrategy,
  strategyOptions: ({
    serverUrl,
    callbackPath,
  }: {
    serverUrl: string;
    clientId: string;
    clientSecret: string;
    callbackPath?: string;
  }) => ({
    serverUrl,
    callbackPath: callbackPath || '/callback',
  }),
  scope: [],
  // SECURITY: `username` becomes `authCode.user_id` and therefore the `sub` of
  // every issued MCP access token. It MUST be the local `users.id` cuid, never
  // an email.
  //
  // Emails are mutable, reassignable and — once an external IdP can populate
  // this profile — attacker-controllable. A `sub` that is an email forced every
  // downstream consumer to resolve the caller with an "id OR email" lookup,
  // which turns an email claim into an authentication assertion: set one user's
  // mail to a victim's address and the token resolves to the victim's row, in
  // the victim's organization. Keying on the cuid removes that whole class.
  //
  // `displayName`/`email` still carry the human-readable values for the UI.
  profileMapper: (profile: any) => ({
    id: profile.id,
    username: profile.id,
    email: profile.email,
    displayName: profile.name || profile.displayName || profile.email,
    avatarUrl: profile.avatarUrl,
  }),
};
