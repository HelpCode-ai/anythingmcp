const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
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
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

// Auth
export const auth = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user: any }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  register: (email: string, password: string, name: string) =>
    request<{ accessToken: string; user: any }>('/api/auth/register', {
      method: 'POST',
      body: { email, password, name },
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
    request<{ message: string; inviteUrl?: string }>('/api/auth/invite', {
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
};

// Users
export const users = {
  me: (token: string) =>
    request<any>('/api/users/me', { token }),
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
};

// Connectors
export const connectors = {
  list: (token: string) =>
    request<any[]>('/api/connectors', { token }),
  create: (data: unknown, token: string) =>
    request<any>('/api/connectors', { method: 'POST', body: data, token }),
  get: (id: string, token: string) =>
    request<any>(`/api/connectors/${id}`, { token }),
  update: (id: string, data: unknown, token: string) =>
    request(`/api/connectors/${id}`, { method: 'PUT', body: data, token }),
  delete: (id: string, token: string) =>
    request(`/api/connectors/${id}`, { method: 'DELETE', token }),
  test: (id: string, token: string) =>
    request<{ ok: boolean; message: string }>(`/api/connectors/${id}/test`, { method: 'POST', token }),
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
  invocations: (token: string, params?: { limit?: number; offset?: number; toolId?: string; status?: string; search?: string; connectorId?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.toolId) query.set('toolId', params.toolId);
    if (params?.status) query.set('status', params.status);
    if (params?.search) query.set('search', params.search);
    if (params?.connectorId) query.set('connectorId', params.connectorId);
    const qs = query.toString();
    return request<any[]>(`/api/audit/invocations${qs ? `?${qs}` : ''}`, { token });
  },
  stats: (token: string) =>
    request<{ invocations24h: number; errors24h: number; invocations7d: number; totalInvocations: number }>('/api/audit/stats', { token }),
  analytics: (token: string) =>
    request<{
      daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }>;
      topTools: Array<{ name: string; count: number; errors: number; avgDuration: number }>;
      totalInvocations: number;
      successRate: number;
      avgDuration: number;
    }>('/api/audit/analytics', { token }),
};

// Server settings (public)
export const server = {
  info: () =>
    request<{
      mcpAuthMode: string;
      serverUrl: string;
      mcpEndpoint: string;
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
  updateSmtp: (data: { host: string; port: number; user: string; pass: string; from?: string; secure?: boolean }, token: string) =>
    request<{ message: string }>('/api/admin/settings/smtp', { method: 'PUT', body: data, token }),
  testSmtp: (token: string) =>
    request<{ ok: boolean; message: string }>('/api/admin/settings/smtp/test', { method: 'POST', token }),
  getFooterLinks: (token: string) =>
    request<Array<{ label: string; url: string }>>('/api/admin/settings/footer-links', { token }),
  updateFooterLinks: (links: Array<{ label: string; url: string }>, token: string) =>
    request<{ message: string }>('/api/admin/settings/footer-links', { method: 'PUT', body: { links }, token }),
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

// MCP Servers
export const mcpServers = {
  list: (token: string) =>
    request<any[]>('/api/mcp-servers', { token }),
  get: (id: string, token: string) =>
    request<any>(`/api/mcp-servers/${id}`, { token }),
  create: (data: { name: string; slug?: string; description?: string }, token: string) =>
    request<any>('/api/mcp-servers', { method: 'POST', body: data, token }),
  update: (id: string, data: { name?: string; slug?: string; description?: string; isActive?: boolean }, token: string) =>
    request<any>(`/api/mcp-servers/${id}`, { method: 'PUT', body: data, token }),
  delete: (id: string, token: string) =>
    request(`/api/mcp-servers/${id}`, { method: 'DELETE', token }),
  assignConnectors: (id: string, connectorIds: string[], token: string) =>
    request(`/api/mcp-servers/${id}/connectors`, { method: 'PUT', body: { connectorIds }, token }),
};
