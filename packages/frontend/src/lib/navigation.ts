export interface NavItem {
  href: string;
  label: string;
  keywords?: string[];
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

export interface SettingsItem {
  href: string;
  label: string;
  description: string;
  exact?: boolean;
  adminOnly?: boolean;
  /** Hidden in cloud. The backend answers 404 there regardless. */
  selfHostedOnly?: boolean;
  keywords?: string[];
}

export interface SettingsSection {
  title?: string;
  adminOnly?: boolean;
  items: SettingsItem[];
}

export const NAV: NavGroup[] = [
  {
    group: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', keywords: ['home', 'overview', 'dashboard', 'main'] },
      { href: '/analytics', label: 'Analytics', keywords: ['analytics', 'metrics', 'stats', 'charts'] },
      { href: '/logs', label: 'Audit Log', keywords: ['audit', 'logs', 'audit log', 'history', 'activity'] },
    ],
  },
  {
    group: 'Build',
    items: [
      { href: '/connectors', label: 'Connectors', keywords: ['connectors', 'apis', 'integrations', 'rest', 'soap'] },
      { href: '/connectors/store', label: 'Marketplace', keywords: ['marketplace', 'store', 'catalog', 'adapters'] },
      { href: '/mcp-server', label: 'MCP Servers', keywords: ['mcp servers', 'servers', 'mcp', 'tools', 'endpoints'] },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { href: '/knowledge-graph', label: 'Knowledge Graph', keywords: ['knowledge graph', 'kg', 'graph', 'entities'] },
      { href: '/knowledge-graph/skills', label: 'AI Skills', keywords: ['ai skills', 'skills', 'prompts'] },
    ],
  },
  {
    group: 'Get started',
    items: [
      { href: '/welcome', label: 'Setup & onboarding', keywords: ['setup', 'onboarding', 'welcome', 'getting started', 'guide'] },
    ],
  },
];

export const SIDEBAR_SECTIONS: SettingsSection[] = [
  {
    items: [
      { href: '/settings', label: 'Profile', description: 'Name, email, password', exact: true, keywords: ['profile', 'account', 'user', 'password', 'name', 'email'] },
      { href: '/settings/connections', label: 'Connections', description: 'What each AI client can reach', keywords: ['connections', 'clients', 'ai', 'claude', 'chatgpt', 'reach'] },
    ],
  },
  {
    title: 'Organization',
    items: [
      { href: '/settings/organization', label: 'General', description: 'Workspace and new orgs', keywords: ['organization', 'general', 'workspace', 'org'] },
      { href: '/settings/users', label: 'Users', description: 'Members and invitations', adminOnly: true, keywords: ['users', 'members', 'invitations', 'team', 'invite'] },
      { href: '/settings/roles', label: 'Roles', description: 'MCP tool access control', adminOnly: true, keywords: ['roles', 'permissions', 'access', 'rbac', 'control'] },
      // Self-hosted only: SSO assumes the workspace owns its own directory,
      // tenant and operator. The backend refuses these routes in cloud, so
      // showing the entry there would lead an admin to a page that 404s.
      { href: '/settings/identity-providers', label: 'Single sign-on', description: 'Microsoft, Google, Okta', adminOnly: true, selfHostedOnly: true, keywords: ['single sign-on', 'sso', 'saml', 'oidc', 'microsoft', 'google', 'okta', 'identity'] },
      { href: '/settings/license', label: 'License', description: 'Plan, billing, subscription', adminOnly: true, keywords: ['license', 'billing', 'plan', 'subscription'] },
      { href: '/settings/admin', label: 'Administration', description: 'SMTP, alerts, footer links', adminOnly: true, keywords: ['administration', 'admin', 'smtp', 'alerts', 'footer', 'email', 'system'] },
    ],
  },
];

export interface NavigationVisibilityContext {
  isAdmin: boolean;
  isCloud: boolean;
}

export function isSettingsItemVisible(
  item: SettingsItem,
  context: NavigationVisibilityContext,
  section?: SettingsSection
): boolean {
  if (section?.adminOnly && !context.isAdmin) return false;
  if (item.adminOnly && !context.isAdmin) return false;
  if (item.selfHostedOnly && context.isCloud) return false;
  return true;
}

export function getVisibleSettingsSections(
  sections: SettingsSection[],
  context: NavigationVisibilityContext
): SettingsSection[] {
  return sections
    .filter((section) => !section.adminOnly || context.isAdmin)
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => isSettingsItemVisible(item, context, section)),
    }))
    .filter((section) => section.items.length > 0);
}
