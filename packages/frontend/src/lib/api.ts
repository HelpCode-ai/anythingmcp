// Use relative paths so requests go to the same origin.
// In production (Docker / Railway) Next.js rewrites proxy /api/* to the backend.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  skipAutoLogout?: boolean;
}

// Emitted when any authenticated request gets a 401 — auth-context listens for this.
export const AUTH_EXPIRED_EVENT = 'amcp:auth-expired';

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: response.statusText }));
    // Auto-logout on 401 for authenticated requests, except when explicitly opting out
    // (self-delete intentionally returns 401 for wrong password — let the caller handle it)
    const skipAutoLogout = options.skipAutoLogout;
    if (response.status === 401 && token && !skipAutoLogout) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    const message = errorBody.message || errorBody.error || `API error: ${response.status}`;
    throw new ApiError(message, response.status, errorBody);
  }

  return response.json();
}

// Auth
export const auth = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user: any; needsLicenseSetup?: boolean }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  register: (email: string, password: string, name: string, acceptTerms: boolean) =>
    request<{ accessToken: string; user: any; isFirstUser?: boolean }>('/api/auth/register', {
      method: 'POST',
      body: { email, password, name, acceptTerms },
    }),
  forgotPassword: (email: string) =>
    request<{ message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: { email },
    }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ message: string }>('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword },
    }),
  inviteUser: (data: { email: string; role: string; mcpRoleId?: string }, token: string) =>
    request<{ message: string; inviteUrl: string; emailSent: boolean; emailError?: string }>('/api/auth/invite', {
      method: 'POST',
      body: data,
      token,
    }),
  verifyInvite: (token: string) =>
    request<{ email: string; role: string; valid: boolean }>(`/api/auth/invite/verify?token=${token}`),
  acceptInvite: (data: { token: string; password: string; name: string }) =>
    request<{ accessToken: string; user: any }>('/api/auth/accept-invite', {
      method: 'POST',
      body: data,
    }),
  verifyEmail: (code: string, token: string) =>
    request<{ message: string; emailVerified: boolean }>('/api/auth/verify-email', {
      method: 'POST',
      body: { code },
      token,
    }),
  resendVerification: (token: string) =>
    request<{ message: string }>('/api/auth/resend-verification', {
      method: 'POST',
      token,
    }),
};

// Users
export interface OnboardingState {
  id: string;
  emailVerified: boolean;
  createdAt: string;
  onboardingCompletedAt: string | null;
  onboardingLastReminderAt: string | null;
  onboardingReminderCount: number;
  emailMarketingOptOut: boolean;
}

export const users = {
  me: (token: string) =>
    request<any>('/api/users/me', { token }),
  onboardingState: (token: string) =>
    request<OnboardingState>('/api/users/me/onboarding-state', { token }),
  updateOnboardingState: (
    data: { completed?: boolean; emailMarketingOptOut?: boolean },
    token: string,
  ) =>
    request<OnboardingState>('/api/users/me/onboarding-state', {
      method: 'PATCH',
      body: data,
      token,
    }),
  updateProfile: (data: { name?: string; email?: string }, token: string) =>
    request('/api/users/me', { method: 'PUT', body: data, token }),
  changePassword: (data: { currentPassword: string; newPassword: string }, token: string) =>
    request<{ message?: string; error?: string }>('/api/users/me/password', { method: 'PUT', body: data, token }),
  // Admin
  list: (token: string) =>
    request<any[]>('/api/users', { token }),
  updateRole: (id: string, role: string, token: string) =>
    request(`/api/users/${id}/role`, { method: 'PUT', body: { role }, token }),
  delete: (id: string, token: string) =>
    request(`/api/users/${id}`, { method: 'DELETE', token }),
  deleteSelf: (data: { password: string; confirm: 'DELETE' }, token: string) =>
    request<{ message: string }>('/api/users/me', {
      method: 'DELETE',
      body: data,
      token,
      skipAutoLogout: true,
    }),
  invitations: (token: string) =>
    request<any[]>('/api/users/invitations', { token }),
  deleteInvitation: (id: string, token: string) =>
    request(`/api/users/invitations/${id}`, { method: 'DELETE', token }),
};

// Organizations
export const organizations = {
  getCurrent: (token: string) =>
    request<{ id: string; name: string; createdAt: string }>('/api/organizations/current', { token }),
  updateCurrent: (data: { name?: string }, token: string) =>
    request<{ id: string; name: string }>('/api/organizations/current', { method: 'PUT', body: data, token }),
  listMine: (token: string) =>
    request<Array<{ id: string; name: string; role: string; joinedAt: string }>>('/api/organizations/mine', { token }),
  switchOrg: (organizationId: string, token: string) =>
    request<{ accessToken: string; user: any; organization: any }>('/api/organizations/switch', {
      method: 'POST', body: { organizationId }, token,
    }),
  create: (name: string, token: string) =>
    request<{ id: string; name: string }>('/api/organizations', { method: 'POST', body: { name }, token }),
  deleteCurrent: (data: { confirmName: string }, token: string) =>
    request<{
      message: string;
      accessToken: string;
      user: { id: string; email: string; name: string | null; role: string; organizationId: string };
      organization: { id: string; name: string };
      autoCreated: boolean;
    }>('/api/organizations/current', { method: 'DELETE', body: data, token }),
};

// Connectors
export const connectors = {
  list: (token: string) =>
    request<any[]>('/api/connectors', { token }),
  proxyAvailability: (token: string) =>
    request<{ available: boolean }>('/api/connectors/proxy-availability', { token }),
  create: (data: unknown, token: string) =>
    request<any>('/api/connectors', { method: 'POST', body: data, token }),
  get: (id: string, token: string) =>
    request<any>(`/api/connectors/${id}`, { token }),
  update: (id: string, data: unknown, token: string) =>
    request(`/api/connectors/${id}`, { method: 'PUT', body: data, token }),
  delete: (id: string, token: string) =>
    request(`/api/connectors/${id}`, { method: 'DELETE', token }),
  test: (id: string, token: string) =>
    request<{
      ok: boolean;
      message: string;
      kind?:
        | 'ok'
        | 'auth_failed'
        | 'not_found'
        | 'unreachable'
        | 'unsupported'
        | 'error';
      httpStatus?: number;
      suggestedFix?: { action: string; hostname?: string; url?: string };
    }>(`/api/connectors/${id}/test`, { method: 'POST', token }),
  importSpec: (id: string, token: string) =>
    request<{ message: string; tools: any[] }>(`/api/connectors/${id}/import-spec`, { method: 'POST', token }),
  importTools: (id: string, data: { source: string; content?: string; url?: string }, token: string) =>
    request<{ message: string; tools: any[]; skipped?: string[] }>(`/api/connectors/${id}/import`, { method: 'POST', body: data, token }),
  updateEnvVars: (id: string, envVars: Record<string, string>, token: string) =>
    request(`/api/connectors/${id}/env-vars`, { method: 'PUT', body: { envVars }, token }),
  exportAll: (token: string) =>
    request<{ version: string; exportedAt: string; connectors: any[] }>('/api/connectors/export-all', { token }),
  importAll: (data: { connectors: any[] }, token: string) =>
    request<{ message: string; created: number; skipped: number; tools: number }>('/api/connectors/import-all', { method: 'POST', body: data, token }),
  healthCheck: (token: string) =>
    request<{ total: number; healthy: number; unhealthy: number; connectors: any[] }>('/api/connectors/health-check', { token }),
  oauthAuthorize: (id: string, token: string) =>
    request<{ authorizationUrl?: string; error?: string }>(
      `/api/connectors/${id}/oauth/authorize`,
      { method: 'POST', token },
    ),
  discoverTools: (id: string, token: string) =>
    request<{ message: string; tools: any[]; skipped?: string[]; error?: string }>(
      `/api/connectors/${id}/discover-tools`,
      { method: 'POST', token },
    ),
};

// Adapters (built-in connector recipes)
export const adapters = {
  list: (token: string) =>
    request<any[]>('/api/adapters', { token }),
  get: (slug: string, token: string) =>
    request<any>(`/api/adapters/${slug}`, { token }),
  import: (slug: string, token: string, credentials?: Record<string, string>) =>
    request<{ message: string; connectorId: string; toolsCreated: number }>(
      `/api/adapters/${slug}/import`,
      { method: 'POST', token, body: credentials ? { credentials } : undefined },
    ),
};

// Tools
export const tools = {
  list: (connectorId: string, token: string) =>
    request<any[]>(`/api/connectors/${connectorId}/tools`, { token }),
  create: (connectorId: string, data: unknown, token: string) =>
    request(`/api/connectors/${connectorId}/tools`, { method: 'POST', body: data, token }),
  bulkCreate: (connectorId: string, toolDefs: unknown[], token: string) =>
    request<{ message: string; tools: any[]; skipped: string[] }>(
      `/api/connectors/${connectorId}/tools/bulk`,
      { method: 'POST', body: { tools: toolDefs }, token },
    ),
  update: (connectorId: string, toolId: string, data: unknown, token: string) =>
    request(`/api/connectors/${connectorId}/tools/${toolId}`, { method: 'PUT', body: data, token }),
  setProxy: (connectorId: string, toolId: string, useProxy: boolean, token: string) =>
    request<any>(`/api/connectors/${connectorId}/tools/${toolId}/proxy`, {
      method: 'PATCH',
      body: { useProxy },
      token,
    }),
  delete: (connectorId: string, toolId: string, token: string) =>
    request(`/api/connectors/${connectorId}/tools/${toolId}`, { method: 'DELETE', token }),
  test: (connectorId: string, toolId: string, params: Record<string, unknown>, token: string) =>
    request<{ ok: boolean; durationMs: number; result?: unknown; error?: string }>(
      `/api/connectors/${connectorId}/tools/${toolId}/test`,
      { method: 'POST', body: { params }, token },
    ),
};

// Audit
export const audit = {
  invocations: (token: string, params?: { limit?: number; offset?: number; toolId?: string; status?: string; search?: string; connectorId?: string; mcpServerId?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.toolId) query.set('toolId', params.toolId);
    if (params?.status) query.set('status', params.status);
    if (params?.search) query.set('search', params.search);
    if (params?.connectorId) query.set('connectorId', params.connectorId);
    if (params?.mcpServerId) query.set('mcpServerId', params.mcpServerId);
    const qs = query.toString();
    return request<any[]>(`/api/audit/invocations${qs ? `?${qs}` : ''}`, { token });
  },
  stats: (token: string) =>
    request<{ invocations24h: number; errors24h: number; invocations7d: number; totalInvocations: number }>('/api/audit/stats', { token }),
  analytics: (token: string, days = 7) =>
    request<{
      daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }>;
      topTools: Array<{ name: string; count: number; errors: number; avgDuration: number }>;
      totalInvocations: number;
      successRate: number;
      avgDuration: number;
    }>(`/api/audit/analytics?days=${days}`, { token }),
  breakdowns: (token: string, days = 30) =>
    request<AuditBreakdowns>(`/api/audit/breakdowns?days=${days}`, { token }),
};

export interface BreakdownRow {
  id: string | null;
  label: string;
  count: number;
  errors: number;
}

export interface AuditBreakdowns {
  days: number;
  total: number;
  errors: number;
  proxyCalls: number;
  estCostMicros: number;
  rates: { callMicros: number; proxyCallMicros: number };
  byConnector: BreakdownRow[];
  byServer: BreakdownRow[];
  byUser: BreakdownRow[];
}

// Knowledge Graph
export interface KgNode {
  id: string;
  entity: string;
  label: string;
  description?: string | null;
  connectorId: string;
  connectorName: string | null;
  fields: Array<{ name: string; type: string }>;
  toolNames: string[];
  source: string;
  confidence: number;
  observations: number;
}

export interface KgEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  matchKey: string | null;
  note?: string | null;
  source: string;
  confidence: number;
  observations: number;
  isManual: boolean;
  status: string;
}

export interface KgSettings {
  enabled: boolean;
  llmEnabled: boolean;
  llmAvailable: boolean;
  captureIntent: boolean;
  autoExtend: boolean;
  skillAutoApply: boolean;
  edgeAutoApply: boolean;
}

export interface KgSkillList {
  items: KgSkill[];
  total: number;
  counts: { pending: number; applied: number; dismissed: number };
  take: number;
  skip: number;
}

export const knowledgeGraph = {
  get: (token: string) =>
    request<{ nodes: KgNode[]; edges: KgEdge[]; lastBuiltAt: string | null; enabled: boolean }>(
      '/api/knowledge-graph',
      { token },
    ),
  getSettings: (token: string) =>
    request<KgSettings>('/api/knowledge-graph/settings', { token }),
  updateSettings: (
    token: string,
    body: {
      enabled?: boolean;
      llmEnabled?: boolean;
      captureIntent?: boolean;
      autoExtend?: boolean;
      skillAutoApply?: boolean;
      edgeAutoApply?: boolean;
    },
  ) =>
    request<KgSettings>('/api/knowledge-graph/settings', { token, method: 'PUT', body }),
  enrich: (token: string) =>
    request<{ suggested: number; skipped?: boolean; model?: string }>(
      '/api/knowledge-graph/enrich',
      { token, method: 'POST' },
    ),
  stats: (token: string) =>
    request<{ nodes: number; edges: number; suggested: number }>(
      '/api/knowledge-graph/stats',
      { token },
    ),
  rebuild: (token: string) =>
    request<{ connectors: number; nodes: number; edges: number; invocations: number }>(
      '/api/knowledge-graph/rebuild',
      { token, method: 'POST' },
    ),
  setEdgeStatus: (token: string, id: string, status: 'active' | 'rejected') =>
    request<KgEdge>(`/api/knowledge-graph/edges/${id}`, {
      token,
      method: 'PATCH',
      body: { status },
    }),
  createEdge: (
    token: string,
    body: { sourceNodeId: string; targetNodeId: string; kind?: string; note?: string },
  ) =>
    request<KgEdge>('/api/knowledge-graph/edges', { token, method: 'POST', body }),
  updateEdge: (
    token: string,
    id: string,
    body: {
      status?: 'active' | 'rejected' | 'suggested';
      kind?: string;
      note?: string | null;
      matchKey?: string | null;
    },
  ) => request<KgEdge>(`/api/knowledge-graph/edges/${id}`, { token, method: 'PATCH', body }),
  updateNode: (
    token: string,
    id: string,
    body: { label?: string; description?: string | null },
  ) => request<KgNode>(`/api/knowledge-graph/nodes/${id}`, { token, method: 'PATCH', body }),
  deleteEdge: (token: string, id: string) =>
    request<{ ok: boolean }>(`/api/knowledge-graph/edges/${id}`, {
      token,
      method: 'DELETE',
    }),
  createNode: (
    token: string,
    body: { connectorId: string; label: string; entity?: string; description?: string },
  ) => request<KgNode>('/api/knowledge-graph/nodes', { token, method: 'POST', body }),
  deleteNode: (token: string, id: string) =>
    request<{ ok: boolean }>(`/api/knowledge-graph/nodes/${id}`, { token, method: 'DELETE' }),
  skills: {
    list: (
      token: string,
      params?: { status?: string; q?: string; take?: number; skip?: number },
    ) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.q) qs.set('q', params.q);
      if (params?.take != null) qs.set('take', String(params.take));
      if (params?.skip != null) qs.set('skip', String(params.skip));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<KgSkillList>(`/api/knowledge-graph/skills${suffix}`, { token });
    },
    consolidate: (token: string, mcpServerId?: string) =>
      request<{ before: number; after: number; model?: string }>(
        '/api/knowledge-graph/skills/consolidate',
        { token, method: 'POST', body: mcpServerId ? { mcpServerId } : {} },
      ),
    create: (
      token: string,
      body: {
        title: string;
        whenToUse?: string;
        instruction: string;
        connectorId?: string | null;
        mcpServerId?: string | null;
        status?: string;
      },
    ) => request<KgSkill>('/api/knowledge-graph/skills', { token, method: 'POST', body }),
    generate: (token: string, mcpServerId?: string) =>
      request<{ created: number; model?: string }>('/api/knowledge-graph/skills/generate', {
        token,
        method: 'POST',
        body: mcpServerId ? { mcpServerId } : {},
      }),
    apply: (token: string, id: string) =>
      request<KgSkill>(`/api/knowledge-graph/skills/${id}/apply`, { token, method: 'POST' }),
    dismiss: (token: string, id: string) =>
      request<KgSkill>(`/api/knowledge-graph/skills/${id}/dismiss`, { token, method: 'POST' }),
    update: (
      token: string,
      id: string,
      patch: { title?: string; whenToUse?: string; instruction?: string; status?: string },
    ) => request<KgSkill>(`/api/knowledge-graph/skills/${id}`, { token, method: 'PATCH', body: patch }),
    remove: (token: string, id: string) =>
      request<{ ok: boolean }>(`/api/knowledge-graph/skills/${id}`, { token, method: 'DELETE' }),
  },
};

export interface KgSkill {
  id: string;
  connectorId: string | null;
  connector?: { name: string } | null;
  mcpServerId: string | null;
  mcpServer?: { name: string } | null;
  title: string;
  whenToUse: string;
  instruction: string;
  confidence: number;
  evidenceCount: number;
  status: string;
}

// Server settings (public)
export const server = {
  info: () =>
    request<{
      mcpAuthMode: string;
      serverUrl: string;
      mcpEndpoint: string;
      deploymentMode: string;
      hasUsers: boolean;
      registrationEnabled: boolean;
      oauthEndpoints: { wellKnown: string; authorize: string; token: string; register: string } | null;
    }>('/health/server-info'),
};

// Site Settings
export const siteSettings = {
  footerLinks: () =>
    request<Array<{ label: string; url: string }>>('/api/site-settings/footer-links'),
};

// Admin Settings
export const adminSettings = {
  getSmtp: (token: string) =>
    request<{ configured: boolean; host?: string; port?: number; user?: string; from?: string; secure?: boolean }>('/api/admin/settings/smtp', { token }),
  updateSmtp: (data: { host: string; port: number; user: string; pass?: string; from?: string; secure?: boolean }, token: string) =>
    request<{ message: string }>('/api/admin/settings/smtp', { method: 'PUT', body: data, token }),
  deleteSmtp: (token: string) =>
    request<{ message: string }>('/api/admin/settings/smtp', { method: 'DELETE', token }),
  testSmtp: (token: string) =>
    request<{ ok: boolean; message: string }>('/api/admin/settings/smtp/test', { method: 'POST', token }),
  getFooterLinks: (token: string) =>
    request<Array<{ label: string; url: string }>>('/api/admin/settings/footer-links', { token }),
  updateFooterLinks: (links: Array<{ label: string; url: string }>, token: string) =>
    request<{ message: string }>('/api/admin/settings/footer-links', { method: 'PUT', body: { links }, token }),
  getSsrfAllowedHosts: (token: string) =>
    request<{ hosts: string[]; envHosts: string[] }>('/api/admin/settings/ssrf-allowed-hosts', { token }),
  setSsrfAllowedHosts: (hosts: string[], token: string) =>
    request<{ hosts: string[] }>('/api/admin/settings/ssrf-allowed-hosts', { method: 'PUT', body: { hosts }, token }),
};

// Roles (Admin)
export const roles = {
  list: (token: string) =>
    request<any[]>('/api/roles', { token }),
  get: (id: string, token: string) =>
    request<any>(`/api/roles/${id}`, { token }),
  create: (data: { name: string; description?: string }, token: string) =>
    request<any>('/api/roles', { method: 'POST', body: data, token }),
  update: (id: string, data: { name?: string; description?: string }, token: string) =>
    request<any>(`/api/roles/${id}`, { method: 'PUT', body: data, token }),
  delete: (id: string, token: string) =>
    request(`/api/roles/${id}`, { method: 'DELETE', token }),
  getToolAccess: (id: string, token: string) =>
    request<any[]>(`/api/roles/${id}/tools`, { token }),
  setToolAccess: (id: string, toolIds: string[], token: string) =>
    request(`/api/roles/${id}/tools`, { method: 'PUT', body: { toolIds }, token }),
  assignToUser: (userId: string, roleId: string | null, token: string) =>
    request(`/api/roles/assign/${userId}`, { method: 'PUT', body: { roleId }, token }),
};

// MCP API Keys
export const mcpKeys = {
  list: (token: string) =>
    request<any[]>('/api/mcp-keys', { token }),
  generate: (name: string, token: string, mcpServerId?: string) =>
    request<{ id: string; key: string; name: string; mcpServerId?: string }>('/api/mcp-keys', {
      method: 'POST',
      body: { name, ...(mcpServerId ? { mcpServerId } : {}) },
      token,
    }),
  revoke: (id: string, token: string) =>
    request(`/api/mcp-keys/${id}/revoke`, { method: 'POST', token }),
  delete: (id: string, token: string) =>
    request(`/api/mcp-keys/${id}`, { method: 'DELETE', token }),
};

// License
export const license = {
  getStatus: (token?: string) =>
    request<{ plan: string | null; status: string; features: any; expiresAt: string | null; lastVerifiedAt: string | null; instanceId: string | null; trialDaysLeft?: number }>('/api/license/status', { token }),
  activateTrial: (token: string) =>
    request<{ message: string; trialStarted: boolean; licenseKey: string; plan: string; expiresAt: string; trialDaysLeft: number }>('/api/license/activate-trial', {
      method: 'POST',
      token,
    }),
  setKey: (licenseKey: string, token: string) =>
    request<{ message: string; license: any }>('/api/license/key', {
      method: 'PUT',
      body: { licenseKey },
      token,
    }),
  verify: (token: string) =>
    request<{ valid: boolean; plan?: string; features?: any; expiresAt?: string; error?: string }>('/api/license/verify', {
      method: 'POST',
      token,
    }),
  registerCommunity: (token: string) =>
    request<{ message: string; email: string }>('/api/license/register-community', {
      method: 'POST',
      token,
    }),
  billingPortal: (token: string, returnUrl?: string) =>
    request<{ url: string }>('/api/license/billing-portal', {
      method: 'POST',
      body: { returnUrl },
      token,
    }),
  getInstanceId: () =>
    request<{ instanceId: string }>('/api/license/instance-id'),
  getUsage: (token?: string) =>
    request<{
      plan: string | null;
      connectors: { current: number; max: number | null; isOver: boolean };
      mcpServers: { current: number; max: number | null; isOver: boolean };
      users: { current: number; max: number | null; isOver: boolean };
      isOverAny: boolean;
    }>('/api/license/usage', { token }),
};

// MCP Servers
export const mcpServers = {
  list: (token: string) =>
    request<any[]>('/api/mcp-servers', { token }),
  get: (id: string, token: string) =>
    request<any>(`/api/mcp-servers/${id}`, { token }),
  create: (data: { name: string; slug?: string; description?: string; instructions?: string }, token: string) =>
    request<any>('/api/mcp-servers', { method: 'POST', body: data, token }),
  update: (id: string, data: { name?: string; slug?: string; description?: string; instructions?: string; isActive?: boolean }, token: string) =>
    request<any>(`/api/mcp-servers/${id}`, { method: 'PUT', body: data, token }),
  delete: (id: string, token: string) =>
    request(`/api/mcp-servers/${id}`, { method: 'DELETE', token }),
  assignConnectors: (id: string, connectorIds: string[], token: string) =>
    request(`/api/mcp-servers/${id}/connectors`, { method: 'PUT', body: { connectorIds }, token }),
};
