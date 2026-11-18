import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiSecurity } from '@nestjs/swagger';
import { FileSearchService } from './file-search.service';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import {
  FileAccessRulesDto,
  FileSearchActivateDto,
  FileSearchDescriptionDto,
  FileSearchDraftDto,
  FileSearchPolicyDto,
  FileSearchScanDto,
  FileSearchScheduleDto,
  FileSearchSelectionDto,
  FileSearchTestDto,
  FileSearchUpdateSourceDto,
  PageQueryDto,
} from './file-search.dto';

/**
 * File Search API (#1385): the setup wizard and the connector's Files tab.
 * Every route is scoped to the caller's workspace; setup routes need ADMIN.
 *
 * Member visibility (settings/member-visibility.service.ts): in a workspace
 * set to `restricted`, a member who is not an admin gets 404 (the body an
 * unknown id gets) on every route with a connector id, unless they own that
 * connector, before the route's own checks. A connector shared with them
 * through their roles is reachable through its tools only. Admins and open
 * workspaces: today's path. The route-by-route rules are listed in
 * settings/member-visibility.routes.ts.
 */
@ApiTags('File Search')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard)
@Controller('api/file-search')
export class FileSearchController {
  constructor(
    private readonly svc: FileSearchService,
    private readonly visibility: MemberVisibilityService,
  ) {}

  /** 404 for a connector a restricted member does not own; nothing for admins and open workspaces. */
  private async hideUnlessVisible(req: any, id: string): Promise<void> {
    const scope = await this.visibility.scopeFor(req.user);
    if (!scope.restricted) return;
    await this.svc.assertVisible(req.user, id, scope);
  }

  @Get('capabilities')
  @ApiOperation({ summary: 'Plan, limits, worker health, protocols and AI availability for the wizard' })
  capabilities(@Req() req: any) {
    return this.svc.capabilities(req.user);
  }

  @Post('test')
  @ApiOperation({ summary: 'Test unsaved connection settings through files-worker' })
  test(@Req() req: any, @Body() body: FileSearchTestDto) {
    return this.svc.test(req.user, body);
  }

  @Post('connectors')
  @ApiOperation({ summary: 'Save a tested connector as a draft' })
  createDraft(@Req() req: any, @Body() body: FileSearchDraftDto) {
    return this.svc.createDraft(req.user, body);
  }

  @Get('policy')
  @ApiOperation({ summary: 'Get the workspace File Search policy' })
  getPolicy(@Req() req: any) {
    return this.svc.getPolicy(req.user);
  }

  @Put('policy')
  @ApiOperation({ summary: 'Update the workspace File Search policy' })
  setPolicy(@Req() req: any, @Body() body: FileSearchPolicyDto) {
    return this.svc.setPolicy(req.user, body as Record<string, unknown>);
  }

  @Get('connectors/:id')
  @ApiOperation({
    summary: 'Get a File Search connector overview',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async overview(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.overview(req.user, id);
  }

  @Put('connectors/:id/source')
  @ApiOperation({
    summary: "Update a connector's source and connection settings",
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async updateSource(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchUpdateSourceDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.updateSource(req.user, id, body);
  }

  @Post('connectors/:id/scans')
  @ApiOperation({
    summary: 'Start a scan of a connector',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async startScan(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchScanDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.startScan(req.user, id, body);
  }

  @Get('connectors/:id/scans/:scanId')
  @ApiOperation({
    summary: 'Get the status and results of a scan',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async getScan(@Req() req: any, @Param('id') id: string, @Param('scanId') scanId: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.getScan(req.user, id, scanId);
  }

  @Delete('connectors/:id/scans/:scanId')
  @ApiOperation({
    summary: 'Cancel a running scan',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async cancelScan(@Req() req: any, @Param('id') id: string, @Param('scanId') scanId: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.cancelScan(req.user, id, scanId);
  }

  @Post('connectors/:id/scans/:scanId/describe')
  @ApiOperation({
    summary: 'Regenerate AI descriptions for a scan',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async redescribe(@Req() req: any, @Param('id') id: string, @Param('scanId') scanId: string, @Body() body: FileSearchScanDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.redescribe(req.user, id, scanId, body);
  }

  @Put('connectors/:id/selection')
  @ApiOperation({
    summary: 'Set which folders and files the connector indexes',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async setSelection(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchSelectionDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.setSelection(req.user, id, body);
  }

  @Post('connectors/:id/activate')
  @ApiOperation({
    summary: 'Activate a drafted connector',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async activate(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchActivateDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.activate(req.user, id, body);
  }

  @Get('connectors/:id/tree')
  @ApiOperation({
    summary: 'Get the folder tree of a connector',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async tree(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.tree(req.user, id);
  }

  @Get('connectors/:id/problems')
  @ApiOperation({
    summary: 'List indexing problems for a connector',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async problems(@Req() req: any, @Param('id') id: string, @Query() query: PageQueryDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.problems(req.user, id, query);
  }

  @Get('connectors/:id/runs')
  @ApiOperation({
    summary: 'List sync runs for a connector',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async runs(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.runs(req.user, id);
  }

  @Post('connectors/:id/sync')
  @ApiOperation({
    summary: 'Trigger an immediate sync',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async syncNow(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.syncNow(req.user, id);
  }

  @Post('connectors/:id/pause')
  @ApiOperation({
    summary: 'Pause automatic syncing',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async pause(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.pause(req.user, id);
  }

  @Post('connectors/:id/resume')
  @ApiOperation({
    summary: 'Resume automatic syncing',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async resume(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.resume(req.user, id);
  }

  @Put('connectors/:id/schedule')
  @ApiOperation({
    summary: 'Set the automatic sync schedule',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async schedule(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchScheduleDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.setSchedule(req.user, id, body);
  }

  @Put('connectors/:id/description')
  @ApiOperation({
    summary: 'Set the connector description shown to agents',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async description(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchDescriptionDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.setDescription(req.user, id, body);
  }

  @Get('connectors/:id/access-rules')
  @ApiOperation({
    summary: 'Get per-connector access rules',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async getRules(@Req() req: any, @Param('id') id: string) {
    await this.hideUnlessVisible(req, id);
    return this.svc.getAccessRules(req.user, id);
  }

  @Put('connectors/:id/access-rules')
  @ApiOperation({
    summary: 'Set per-connector access rules',
    description: 'In a workspace with restricted member visibility, a member who is not an admin gets 404 for a connector they do not own.',
  })
  async setRules(@Req() req: any, @Param('id') id: string, @Body() body: FileAccessRulesDto) {
    await this.hideUnlessVisible(req, id);
    return this.svc.setAccessRules(req.user, id, body);
  }
}
