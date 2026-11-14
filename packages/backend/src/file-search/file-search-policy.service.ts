import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Workspace policy for File Search and File Share (Enterprise, #1388).
 * Stored as JSON in org_settings under `file_search_policy`. Without
 * Enterprise the defaults apply and the policy cannot be changed.
 */
export interface FileSearchPolicy {
  /** Public share links allowed at all. */
  publicLinks: boolean;
  /** Upper bound for link validity, below the plan's own (null = the plan's). */
  maxTtlHours: number | null;
  /** The setup wizard may send folder names and samples to the configured AI. */
  aiDrafting: boolean;
  /** Plain (unencrypted) FTP may be used. */
  allowPlainFtp: boolean;
}

export const DEFAULT_POLICY: FileSearchPolicy = {
  publicLinks: true,
  maxTtlHours: null,
  aiDrafting: true,
  allowPlainFtp: true,
};

const KEY = 'file_search_policy';

export function parsePolicy(raw: unknown): FileSearchPolicy {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ttl = o.maxTtlHours;
  return {
    publicLinks: typeof o.publicLinks === 'boolean' ? o.publicLinks : DEFAULT_POLICY.publicLinks,
    maxTtlHours: typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 1 ? Math.floor(ttl) : null,
    aiDrafting: typeof o.aiDrafting === 'boolean' ? o.aiDrafting : DEFAULT_POLICY.aiDrafting,
    allowPlainFtp: typeof o.allowPlainFtp === 'boolean' ? o.allowPlainFtp : DEFAULT_POLICY.allowPlainFtp,
  };
}

@Injectable()
export class FileSearchPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string): Promise<FileSearchPolicy> {
    const row = await this.prisma.orgSettings.findUnique({ where: { organizationId_key: { organizationId, key: KEY } } });
    if (!row) return { ...DEFAULT_POLICY };
    try {
      return parsePolicy(JSON.parse(row.value));
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  async set(organizationId: string, patch: Partial<FileSearchPolicy>): Promise<FileSearchPolicy> {
    const next = parsePolicy({ ...(await this.get(organizationId)), ...patch });
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key: KEY } },
      create: { organizationId, key: KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    });
    return next;
  }
}
