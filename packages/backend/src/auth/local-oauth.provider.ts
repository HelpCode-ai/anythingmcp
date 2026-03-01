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
  profileMapper: (profile: any) => ({
    id: profile.id,
    username: profile.email || profile.username,
    email: profile.email,
    displayName: profile.name || profile.displayName || profile.email,
    avatarUrl: profile.avatarUrl,
  }),
};
