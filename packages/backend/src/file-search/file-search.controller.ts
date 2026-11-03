import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileSearchService } from './file-search.service';
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
 */
@ApiTags('File Search')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/file-search')
export class FileSearchController {
  constructor(private readonly svc: FileSearchService) {}

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
  getPolicy(@Req() req: any) {
    return this.svc.getPolicy(req.user);
  }

  @Put('policy')
  setPolicy(@Req() req: any, @Body() body: FileSearchPolicyDto) {
    return this.svc.setPolicy(req.user, body as Record<string, unknown>);
  }

  @Get('connectors/:id')
  overview(@Req() req: any, @Param('id') id: string) {
    return this.svc.overview(req.user, id);
  }

  @Put('connectors/:id/source')
  updateSource(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchUpdateSourceDto) {
    return this.svc.updateSource(req.user, id, body);
  }

  @Post('connectors/:id/scans')
  startScan(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchScanDto) {
    return this.svc.startScan(req.user, id, body);
  }

  @Get('connectors/:id/scans/:scanId')
  getScan(@Req() req: any, @Param('id') id: string, @Param('scanId') scanId: string) {
    return this.svc.getScan(req.user, id, scanId);
  }

  @Delete('connectors/:id/scans/:scanId')
  cancelScan(@Req() req: any, @Param('id') id: string, @Param('scanId') scanId: string) {
    return this.svc.cancelScan(req.user, id, scanId);
  }

  @Post('connectors/:id/scans/:scanId/describe')
  redescribe(@Req() req: any, @Param('id') id: string, @Param('scanId') scanId: string, @Body() body: FileSearchScanDto) {
    return this.svc.redescribe(req.user, id, scanId, body);
  }

  @Put('connectors/:id/selection')
  setSelection(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchSelectionDto) {
    return this.svc.setSelection(req.user, id, body);
  }

  @Post('connectors/:id/activate')
  activate(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchActivateDto) {
    return this.svc.activate(req.user, id, body);
  }

  @Get('connectors/:id/tree')
  tree(@Req() req: any, @Param('id') id: string) {
    return this.svc.tree(req.user, id);
  }

  @Get('connectors/:id/problems')
  problems(@Req() req: any, @Param('id') id: string, @Query() query: PageQueryDto) {
    return this.svc.problems(req.user, id, query);
  }

  @Get('connectors/:id/runs')
  runs(@Req() req: any, @Param('id') id: string) {
    return this.svc.runs(req.user, id);
  }

  @Post('connectors/:id/sync')
  syncNow(@Req() req: any, @Param('id') id: string) {
    return this.svc.syncNow(req.user, id);
  }

  @Post('connectors/:id/pause')
  pause(@Req() req: any, @Param('id') id: string) {
    return this.svc.pause(req.user, id);
  }

  @Post('connectors/:id/resume')
  resume(@Req() req: any, @Param('id') id: string) {
    return this.svc.resume(req.user, id);
  }

  @Put('connectors/:id/schedule')
  schedule(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchScheduleDto) {
    return this.svc.setSchedule(req.user, id, body);
  }

  @Put('connectors/:id/description')
  description(@Req() req: any, @Param('id') id: string, @Body() body: FileSearchDescriptionDto) {
    return this.svc.setDescription(req.user, id, body);
  }

  @Get('connectors/:id/access-rules')
  getRules(@Req() req: any, @Param('id') id: string) {
    return this.svc.getAccessRules(req.user, id);
  }

  @Put('connectors/:id/access-rules')
  setRules(@Req() req: any, @Param('id') id: string, @Body() body: FileAccessRulesDto) {
    return this.svc.setAccessRules(req.user, id, body);
  }
}
