import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SiteSettingsService } from './site-settings.service';

@Injectable()
export class OrgSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteSettings: SiteSettingsService,
  ) {}

  async get(organizationId: string, key: string): Promise<string | null> {
    const row = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });
    return row?.value ?? null;
  }

  async getJson<T = unknown>(organizationId: string, key: string): Promise<T | null> {
    const value = await this.get(organizationId, key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set(organizationId: string, key: string, value: string): Promise<void> {
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value },
      update: { value },
    });
  }

  async setJson(organizationId: string, key: string, value: unknown): Promise<void> {
    await this.set(organizationId, key, JSON.stringify(value));
  }

  /**
   * Get SMTP config for an org, falling back to global SiteSettings if not configured.
   */
  async getSmtpConfig(organizationId: string) {
    const orgSmtp = await this.getJson<any>(organizationId, 'smtp_config');
    if (orgSmtp) return orgSmtp;
    // Fallback to global
    return this.siteSettings.getJson<any>('smtp_config');
  }

  /**
   * Get footer links for an org, falling back to global SiteSettings.
   */
  async getFooterLinks(organizationId: string) {
    const orgLinks = await this.getJson<any[]>(organizationId, 'footer_links');
    if (orgLinks) return orgLinks;
    return this.siteSettings.getJson<any[]>('footer_links');
  }
}
