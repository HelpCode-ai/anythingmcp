export interface NavItem {
  /** Message key under `nav.items` (messages/*.json). */
  id: string;
  href: string;
  /** English label; the sidebar shows the translated `nav.items.<id>`. */
  label: string;
  keywords?: string[];
}

export interface NavGroup {
  /** Message key under `nav.groups` (messages/*.json). */
  id: string;
  group: string;
  items: NavItem[];
}

export interface SettingsItem {
  /** Message key under `settingsNav.items` (messages/*.json). */
  id: string;
  href: string;
  /** English label; the settings sidebar shows `settingsNav.items.<id>.label`. */
  label: string;
  description: string;
  exact?: boolean;
  adminOnly?: boolean;
  /** Hidden in cloud. The backend answers 404 there regardless. */
  selfHostedOnly?: boolean;
  keywords?: string[];
}

export interface SettingsSection {
  /** Message key under `settingsNav.sections`, when the section has a title. */
  id?: string;
  title?: string;
  adminOnly?: boolean;
  items: SettingsItem[];
}

export const NAV: NavGroup[] = [
  {
    id: 'overview',
    group: 'Overview',
    items: [
      { id: 'dashboard', href: '/', label: 'Dashboard', keywords: ['home', 'overview', 'dashboard', 'main'] },
      { id: 'analytics', href: '/analytics', label: 'Analytics', keywords: ['analytics', 'metrics', 'stats', 'charts'] },
      { id: 'auditLog', href: '/logs', label: 'Audit Log', keywords: ['audit', 'logs', 'audit log', 'history', 'activity'] },
    ],
  },
  {
    id: 'build',
    group: 'Build',
    items: [
      { id: 'connectors', href: '/connectors', label: 'Connectors', keywords: ['connectors', 'apis', 'integrations', 'rest', 'soap'] },
      { id: 'marketplace', href: '/connectors/store', label: 'Marketplace', keywords: ['marketplace', 'store', 'catalog', 'adapters'] },
      { id: 'mcpServers', href: '/mcp-server', label: 'MCP Servers', keywords: ['mcp servers', 'servers', 'mcp', 'tools', 'endpoints'] },
    ],
  },
  {
    id: 'intelligence',
    group: 'Intelligence',
    items: [
      { id: 'knowledgeGraph', href: '/knowledge-graph', label: 'Knowledge Graph', keywords: ['knowledge graph', 'kg', 'graph', 'entities'] },
      { id: 'aiSkills', href: '/knowledge-graph/skills', label: 'AI Skills', keywords: ['ai skills', 'skills', 'prompts'] },
      { id: 'memory', href: '/memory', label: 'Memory', keywords: ['memory', 'remember', 'facts', 'preferences', 'knowledge'] },
    ],
  },
  {
    id: 'getStarted',
    group: 'Get started',
    items: [
      { id: 'setup', href: '/welcome', label: 'Setup & onboarding', keywords: ['setup', 'onboarding', 'welcome', 'getting started', 'guide'] },
    ],
  },
];

export const SIDEBAR_SECTIONS: SettingsSection[] = [
  {
    items: [
      { id: 'profile', href: '/settings', label: 'Profile', description: 'Name, email, password', exact: true, keywords: ['profile', 'account', 'user', 'password', 'name', 'email'] },
      { id: 'connections', href: '/settings/connections', label: 'Connections', description: 'What each AI client can reach', keywords: ['connections', 'clients', 'ai', 'claude', 'chatgpt', 'reach'] },
    ],
  },
  {
    id: 'organization',
    title: 'Organization',
    items: [
      { id: 'organization', href: '/settings/organization', label: 'General', description: 'Workspace and new orgs', keywords: ['organization', 'general', 'workspace', 'org'] },
      { id: 'users', href: '/settings/users', label: 'Users', description: 'Members and invitations', adminOnly: true, keywords: ['users', 'members', 'invitations', 'team', 'invite'] },
      { id: 'roles', href: '/settings/roles', label: 'Roles', description: 'MCP tool access control', adminOnly: true, keywords: ['roles', 'permissions', 'access', 'rbac', 'control'] },
      // Self-hosted only: SSO assumes the workspace owns its own directory,
      // tenant and operator. The backend refuses these routes in cloud, so
      // showing the entry there would lead an admin to a page that 404s.
      { id: 'identityProviders', href: '/settings/identity-providers', label: 'Single sign-on', description: 'Microsoft, Google, Okta', adminOnly: true, selfHostedOnly: true, keywords: ['single sign-on', 'sso', 'saml', 'oidc', 'microsoft', 'google', 'okta', 'identity'] },
      { id: 'license', href: '/settings/license', label: 'License', description: 'Plan, billing, subscription', adminOnly: true, keywords: ['license', 'billing', 'plan', 'subscription'] },
      { id: 'admin', href: '/settings/admin', label: 'Administration', description: 'SMTP, alerts, footer links', adminOnly: true, keywords: ['administration', 'admin', 'smtp', 'alerts', 'footer', 'email', 'system'] },
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
