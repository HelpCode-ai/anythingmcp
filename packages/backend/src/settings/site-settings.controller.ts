import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsNumber, IsOptional, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SiteSettingsService } from './site-settings.service';
import { EmailService } from './email.service';

class SmtpConfigDto {
  @IsString()
  host: string;

  @IsNumber()
  port: number;

  @IsString()
  user: string;

  @IsString()
  pass: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;
}

class FooterLinkDto {
  @IsString()
  label: string;

  @IsString()
  url: string;
}

class FooterLinksDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FooterLinkDto)
  links: FooterLinkDto[];
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
    private readonly emailService: EmailService,
  ) {}

  @Get('smtp')
  @ApiOperation({ summary: 'Get SMTP configuration (ADMIN)' })
  async getSmtpConfig() {
    const config = await this.siteSettings.getSmtpConfig();
    if (!config) return { configured: false };
    // Mask password
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
  @ApiOperation({ summary: 'Update SMTP configuration (ADMIN)' })
  async updateSmtpConfig(@Body() dto: SmtpConfigDto) {
    await this.siteSettings.setJson('smtp_config', {
      host: dto.host,
      port: dto.port,
      user: dto.user,
      pass: dto.pass,
      from: dto.from || '',
      secure: dto.secure ?? (dto.port === 465),
    });
    return { message: 'SMTP configuration saved' };
  }

  @Post('smtp/test')
  @ApiOperation({ summary: 'Test SMTP connection (ADMIN)' })
  async testSmtp() {
    return this.emailService.testConnection();
  }

  @Get('footer-links')
  @ApiOperation({ summary: 'Get footer links (ADMIN)' })
  async getFooterLinks() {
    return this.siteSettings.getFooterLinks();
  }

  @Put('footer-links')
  @ApiOperation({ summary: 'Update footer links (ADMIN)' })
  async updateFooterLinks(@Body() dto: FooterLinksDto) {
    await this.siteSettings.setJson('footer_links', dto.links);
    return { message: 'Footer links saved' };
  }
}
