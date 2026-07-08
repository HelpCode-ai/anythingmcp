import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsNumber, IsOptional, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SiteSettingsService } from './site-settings.service';
import { OrgSettingsService } from './org-settings.service';
import { EmailService } from './email.service';
import { SsrfPolicyService } from '../common/ssrf-policy.service';

class SmtpConfigDto {
  @ApiProperty({ description: 'SMTP server hostname.', example: 'smtp.sendgrid.net' })
  @IsString()
  host: string;

  @ApiProperty({ description: 'SMTP port.', example: 587 })
  @IsNumber()
  port: number;

  @ApiProperty({ description: 'SMTP username.' })
  @IsString()
  user: string;

  @ApiPropertyOptional({
    description:
      'SMTP password / API key. Omit or leave empty to keep the currently stored password.',
  })
  @IsOptional()
  @IsString()
  pass?: string;

  @ApiPropertyOptional({
    description: '"From" address used by outbound mail. Defaults to the SMTP user.',
    example: 'noreply@example.com',
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Use implicit TLS (port 465). Default false (STARTTLS).',
  })
  @IsOptional()
  @IsBoolean()
  secure?: boolean;
}

class FooterLinkDto {
  @ApiProperty({ description: 'Link label shown in the footer.', example: 'Privacy' })
  @IsString()
  label: string;

  @ApiProperty({ description: 'Target URL.', example: 'https://example.com/privacy' })
  @IsString()
  url: string;
}

class FooterLinksDto {
  @ApiProperty({
    description: 'Footer links. Replaces the existing array.',
    type: [FooterLinkDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FooterLinkDto)
  links: FooterLinkDto[];
}

class SsrfAllowedHostsDto {
  @ApiProperty({
    description:
      'Hostnames (and *.suffix wildcards / plain IPs) that the SSRF guard will let through even when they resolve to a private/loopback address. Replaces the stored list. Hosts merged at request time with whatever is in the SSRF_ALLOWED_HOSTS env var.',
    type: [String],
    example: ['koch-filesystem-bridge', '*.internal.example.com', '172.23.0.0'],
  })
  @IsArray()
  @IsString({ each: true })
  hosts: string[];
}

// ── Public endpoints (no auth) ──────────────────────────────────────────────

@ApiTags('Site Settings')
@Controller('api/site-settings')
export class SiteSettingsPublicController {
  constructor(private readonly siteSettings: SiteSettingsService) {}

  @Get('footer-links')
  @ApiOperation({ summary: 'Get footer links (public)' })
  async getFooterLinks() {
    return this.siteSettings.getFooterLinks();
  }
}

// ── Admin endpoints ─────────────────────────────────────────────────────────

@ApiTags('Site Settings')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('api/admin/settings')
export class SiteSettingsAdminController {
  constructor(
    private readonly siteSettings: SiteSettingsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly emailService: EmailService,
    private readonly ssrfPolicy: SsrfPolicyService,
  ) {}

  @Get('smtp')
  @ApiOperation({ summary: 'Get SMTP configuration for current organization (ADMIN)' })
  async getSmtpConfig(@Req() req: any) {
    // Org-only — never fall back to the global/system config, so operator
    // credentials are never exposed to workspace admins.
    const config = await this.orgSettings.getJson<any>(req.user.organizationId, 'smtp_config');
    if (!config?.host) return { configured: false };
    return {
      configured: true,
      host: config.host,
      port: config.port,
      user: config.user,
      from: config.from,
      secure: config.secure,
    };
  }

  @Put('smtp')
  @ApiOperation({ summary: 'Update SMTP configuration for current organization (ADMIN)' })
  async updateSmtpConfig(@Req() req: any, @Body() dto: SmtpConfigDto) {
    // Empty password = keep the stored one, so admins can edit host/port
    // without re-entering the secret (the GET never returns it).
    let pass = dto.pass;
    if (!pass) {
      const existing = await this.orgSettings.getJson<any>(
        req.user.organizationId,
        'smtp_config',
      );
      pass = existing?.pass;
      if (!pass) {
        throw new BadRequestException('SMTP password is required');
      }
    }
    await this.orgSettings.setJson(req.user.organizationId, 'smtp_config', {
      host: dto.host,
      port: dto.port,
      user: dto.user,
      pass,
      from: dto.from || '',
      secure: dto.secure ?? (dto.port === 465),
    });
    return { message: 'SMTP configuration saved' };
  }

  @Delete('smtp')
  @ApiOperation({
    summary:
      'Remove the SMTP configuration for the current organization (ADMIN) — emails fall back to the platform mail service',
  })
  async deleteSmtpConfig(@Req() req: any) {
    await this.orgSettings.delete(req.user.organizationId, 'smtp_config');
    return { message: 'SMTP configuration removed' };
  }

  @Post('smtp/test')
  @ApiOperation({ summary: 'Test SMTP connection (ADMIN)' })
  async testSmtp(@Req() req: any) {
    return this.emailService.testConnection(req.user.organizationId);
  }

  @Get('footer-links')
  @ApiOperation({ summary: 'Get footer links for current organization (ADMIN)' })
  async getFooterLinks(@Req() req: any) {
    return (
      (await this.orgSettings.getFooterLinks(req.user.organizationId)) || []
    );
  }

  @Put('footer-links')
  @ApiOperation({ summary: 'Update footer links for current organization (ADMIN)' })
  async updateFooterLinks(@Req() req: any, @Body() dto: FooterLinksDto) {
    await this.orgSettings.setJson(req.user.organizationId, 'footer_links', dto.links);
    return { message: 'Footer links saved' };
  }

  @Get('ssrf-allowed-hosts')
  @ApiOperation({
    summary: 'Get the admin-editable SSRF allowlist (ADMIN)',
    description:
      'Returns the DB-backed list of hosts that bypass the SSRF guard. The effective allowlist also includes anything in the SSRF_ALLOWED_HOSTS env var (returned separately so the UI can show them as read-only).',
  })
  async getSsrfAllowedHosts() {
    const dbHosts = await this.ssrfPolicy.getDbAllowedHosts();
    const envHosts = (process.env.SSRF_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return { hosts: dbHosts, envHosts };
  }

  @Put('ssrf-allowed-hosts')
  @ApiOperation({
    summary: 'Replace the admin-editable SSRF allowlist (ADMIN)',
    description:
      'Use with caution: hostnames added here can be reached by every connector in every organization on this deployment.',
  })
  async setSsrfAllowedHosts(@Body() dto: SsrfAllowedHostsDto) {
    const hosts = await this.ssrfPolicy.setDbAllowedHosts(dto.hosts);
    return { hosts };
  }
}
