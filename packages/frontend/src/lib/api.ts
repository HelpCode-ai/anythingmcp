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
};

// Users
export const users = {
  me: (token: string) =>
    request<any>('/api/users/me', { token }),
  updateProfile: (data: { name?: string; email?: string }, token: string) =>
    request('/api/users/me', { method: 'PUT', body: data, token }),
  updateAiConfig: (data: { provider: string; apiKey: string; model?: string }, token: string) =>
    request('/api/users/me/ai-config', { method: 'PUT', body: data, token }),
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
  invocations: (token: string, params?: { limit?: number; offset?: number; toolId?: string; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.toolId) query.set('toolId', params.toolId);
    if (params?.status) query.set('status', params.status);
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

// AI
export const ai = {
  models: (token: string) =>
    request<{
      anthropic: { models: Array<{ id: string; label: string }>; default: string };
      openai: { models: Array<{ id: string; label: string }>; default: string };
    }>('/api/ai/models', { token }),
  generateTools: (data: unknown, token: string) =>
    request('/api/ai/generate-tools', { method: 'POST', body: data, token }),
  improveDescription: (data: unknown, token: string) =>
    request('/api/ai/improve-description', { method: 'POST', body: data, token }),
  configure: (data: unknown, token: string) =>
    request<any>('/api/ai/configure', { method: 'POST', body: data, token }),
};
