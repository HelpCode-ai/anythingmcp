import { SupportTriageConfig } from './support-config';

const TIMEOUT_MS = 15_000;

export interface LibredeskMessage {
  type: string;
  private: boolean;
  sender_type: string;
  text_content?: string;
  content?: string;
  created_at?: string;
}

export interface LibredeskMention {
  type: 'agent' | 'team';
  id: number;
}

/** Minimal REST client for the endpoints the triage uses (API-key auth). */
export class LibredeskClient {
  constructor(
    private readonly cfg: SupportTriageConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `token ${this.cfg.apiKey}:${this.cfg.apiSecret}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Libredesk ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = text ? JSON.parse(text) : {};
    return parsed?.data as T;
  }

  async incomingMessages(uuid: string): Promise<LibredeskMessage[]> {
    const page = await this.call<{ results?: LibredeskMessage[] }>(
      'GET',
      `/api/v1/conversations/${encodeURIComponent(uuid)}/messages?page=1&page_size=30&type=incoming`,
    );
    return page?.results ?? [];
  }

  addTags(uuid: string, tags: string[]) {
    return this.call('POST', `/api/v1/conversations/${encodeURIComponent(uuid)}/tags`, {
      tags,
      action: 'add_tags',
    });
  }

  setPriority(uuid: string, priority: string) {
    return this.call('PUT', `/api/v1/conversations/${encodeURIComponent(uuid)}/priority`, { priority });
  }

  assignTeam(uuid: string, teamId: number) {
    return this.call('PUT', `/api/v1/conversations/${encodeURIComponent(uuid)}/assignee/team`, {
      assignee_id: teamId,
    });
  }

  assignUser(uuid: string, userId: number) {
    return this.call('PUT', `/api/v1/conversations/${encodeURIComponent(uuid)}/assignee/user`, {
      assignee_id: userId,
    });
  }

  /** Mentioned agents and team members get an in-app and email notification. */
  addPrivateNote(uuid: string, html: string, mentions: LibredeskMention[] = []) {
    return this.call('POST', `/api/v1/conversations/${encodeURIComponent(uuid)}/messages`, {
      message: html,
      private: true,
      sender_type: 'agent',
      ...(mentions.length ? { mentions } : {}),
    });
  }

  async teams(): Promise<Array<{ id: number; name: string }>> {
    return (await this.call<Array<{ id: number; name: string }>>('GET', '/api/v1/teams/compact')) ?? [];
  }
}
