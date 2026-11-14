import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SecurityEvents, SecurityEventService } from '../audit/security-event.service';
import {
  MEMBER_VISIBILITY_MODES,
  MemberVisibilityMode,
  MemberVisibilityService,
} from './member-visibility.service';

export class MemberVisibilityDto {
  @ApiProperty({
    enum: MEMBER_VISIBILITY_MODES,
    description:
      '`open`: every member sees every connector, MCP server and tool call of the workspace. ' +
      '`restricted`: a member who is not an admin sees only their own tool calls, the connectors ' +
      'their roles reach and the MCP servers that hold one of them.',
    example: 'restricted',
  })
  @IsIn(MEMBER_VISIBILITY_MODES as unknown as string[], {
    message: `mode must be one of: ${MEMBER_VISIBILITY_MODES.join(', ')}`,
  })
  mode: MemberVisibilityMode;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: [...MEMBER_VISIBILITY_MODES] },
    restrictedForMe: {
      type: 'boolean',
      description: 'True when the caller is not an admin and the mode is `restricted`.',
    },
  },
};

// The routes live in their own module rather than in SiteSettingsMember/Admin
// controllers: SettingsModule is also loaded by the File Search worker, which
// has neither RolesModule nor AuditModule, so a dependency on RolesService or
// SecurityEventService there would stop the worker at boot.

@ApiTags('Site Settings')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard)
@Controller('api/settings')
export class MemberVisibilityMemberController {
  constructor(private readonly visibility: MemberVisibilityService) {}

  @Get('member-visibility')
  @ApiOperation({
    summary: "Member visibility mode of the caller's workspace, and whether it narrows the caller's view",
    description:
      'Any member may call this. `mode` is `open` (every member sees every connector, MCP server and tool call ' +
      'of the workspace) or `restricted` (a member who is not an admin sees only their own tool calls, the ' +
      'connectors their roles reach and the MCP servers that hold one of them). A workspace that never set ' +
      'it is `open`. `restrictedForMe` is true when the mode is `restricted` and the caller is not an admin of ' +
      'the workspace; admins are never restricted. A change can take up to 30 seconds to reach every server ' +
      'process.\n\n' +
      '```bash\namcp api GET /api/settings/member-visibility\n```',
  })
  @ApiResponse({
    status: 200,
    schema: { ...RESPONSE_SCHEMA, example: { mode: 'restricted', restrictedForMe: true } },
  })
  async getMemberVisibility(@Req() req: any) {
    const mode = await this.visibility.mode(req.user.organizationId);
    return { mode, restrictedForMe: mode === 'restricted' && req.user.role !== 'ADMIN' };
  }
}

@ApiTags('Site Settings')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard, RolesGuard)
@Roles('ADMIN')
@Controller('api/admin/settings')
export class MemberVisibilityAdminController {
  constructor(
    private readonly visibility: MemberVisibilityService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  @Put('member-visibility')
  @ApiOperation({
    summary: 'Set the member visibility mode of the current workspace (ADMIN)',
    description:
      'Switches what members who are not admins see in the dashboard and the REST API. `open` (the default) ' +
      'keeps every connector, MCP server and tool call of the workspace visible to every member. `restricted` ' +
      'shows a member who is not an admin only their own tool calls, the connectors their roles reach (owned by ' +
      'them, or with at least one tool their roles allow) and the MCP servers that hold one of them. In a ' +
      'workspace without any tool whitelist, roles narrow nothing, so members still see every connector; only ' +
      'the tool calls are narrowed. Admins always see everything. The MCP endpoint is not affected: roles ' +
      'already filter what an AI client can call there.\n\n' +
      'Applies to the workspace of the caller. A change writes a `MEMBER_VISIBILITY_CHANGED` security event ' +
      'with the old and new mode, and can take up to 30 seconds to reach every server process. A read-only ' +
      '(`MANAGEMENT_READ`) API key gets 403.\n\n' +
      '```bash\namcp api PUT /api/admin/settings/member-visibility --data \'{"mode":"restricted"}\' --yes\n```',
  })
  @ApiBody({
    type: MemberVisibilityDto,
    examples: {
      restricted: { summary: 'Members see only what their roles reach', value: { mode: 'restricted' } },
      open: { summary: 'Every member sees everything (default)', value: { mode: 'open' } },
    },
  })
  @ApiResponse({
    status: 200,
    schema: { ...RESPONSE_SCHEMA, example: { mode: 'restricted', restrictedForMe: false } },
  })
  async setMemberVisibility(@Req() req: any, @Body() dto: MemberVisibilityDto) {
    const organizationId = req.user.organizationId;
    const { before, after, changed } = await this.visibility.setMode(organizationId, dto.mode);
    if (changed) {
      await this.securityEvents.log({
        event: SecurityEvents.MEMBER_VISIBILITY_CHANGED,
        actorType: 'USER',
        organizationId,
        actorUserId: req.user.sub,
        metadata: { from: before, to: after },
        ip: req.ip,
        userAgent: req.headers?.['user-agent'],
      });
    }
    return { mode: after, restrictedForMe: false };
  }
}
