import { Body, Controller, Delete, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AlertsService } from './alerts.service';

class SaveAlertWebhookDto {
  @ApiProperty({ description: 'Webhook URL to POST the signed alert to.', example: 'https://example.com/hooks/anythingmcp' })
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  url: string;

  @ApiProperty({ description: 'Payload shape: a generic JSON event, or a ready-to-post Slack message.', enum: ['json', 'slack'] })
  @IsIn(['json', 'slack'])
  type: 'json' | 'slack';

  @ApiPropertyOptional({ description: 'Whether the alert is active. Default true.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Consecutive failures within the window before an alert fires. Default 5.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  threshold?: number;

  @ApiPropertyOptional({ description: 'Window, in minutes, that failures are counted over; it starts at the first failure. Default 10.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  windowMinutes?: number;

  @ApiPropertyOptional({ description: 'Minutes to wait after a dispatch before the same connector can alert again. Default 30.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  cooldownMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Generate a new signing secret and return it once. Required to see the secret again after the first save.',
  })
  @IsOptional()
  @IsBoolean()
  rotateSecret?: boolean;
}

@ApiTags('Alerts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('api/admin/settings')
export class AlertsAdminController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('alert-webhook')
  @ApiOperation({ summary: 'Get the connector-failure alert webhook for the current organization (ADMIN)' })
  async getConfig(@Req() req: any) {
    return this.alerts.getConfig(req.user.organizationId);
  }

  @Put('alert-webhook')
  @ApiOperation({ summary: 'Save the connector-failure alert webhook for the current organization (ADMIN)' })
  async saveConfig(@Req() req: any, @Body() dto: SaveAlertWebhookDto) {
    const { secret } = await this.alerts.saveConfig(req.user.organizationId, dto);
    return { message: 'Alert webhook saved', ...(secret ? { secret } : {}) };
  }

  @Delete('alert-webhook')
  @ApiOperation({ summary: 'Remove the connector-failure alert webhook for the current organization (ADMIN)' })
  async deleteConfig(@Req() req: any) {
    await this.alerts.deleteConfig(req.user.organizationId);
    return { message: 'Alert webhook removed' };
  }

  @Post('alert-webhook/test')
  // It reports the status any public URL answers with: keep it a test, not a probe.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a test alert to the configured webhook (ADMIN)' })
  async testWebhook(@Req() req: any) {
    return this.alerts.testWebhook(req.user.organizationId);
  }
}
