import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class SiteSettingsService {
  private readonly logger = new Logger(SiteSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<string | null> {
    const setting = await this.prisma.siteSettings.findUnique({
      where: { key },
    });
    return setting?.value ?? null;
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.siteSettings.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  async getAll(): Promise<Record<string, string>> {
    const settings = await this.prisma.siteSettings.findMany();
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    await this.prisma.siteSettings.deleteMany({ where: { key } });
  }

  // ── Convenience methods ───────────────────────────────────────────────────

  async getSmtpConfig(): Promise<{
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
    secure: boolean;
  } | null> {
    return this.getJson('smtp_config');
  }

  async getFooterLinks(): Promise<Array<{ label: string; url: string }>> {
    return (await this.getJson<Array<{ label: string; url: string }>>('footer_links')) || [];
  }
}
