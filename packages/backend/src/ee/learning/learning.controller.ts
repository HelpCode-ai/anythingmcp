import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtOrManagementKeyGuard } from '../../auth/jwt-or-management-key.guard';
import { Roles, RolesGuard } from '../../auth/roles.guard';
import { LearningAccessService } from './learning-access.service';
import { LearningActionContext, LearningService } from './learning.service';
import {
  CreateLearningProjectDto,
  LearningConsentDto,
  LearningWithdrawDto,
  UpdateLearningProjectDto,
  UpdateLessonDto,
} from './learning.dto';

/**
 * Learning projects (#1695): learning turned on for one member on one MCP
 * server. Admins manage projects, admins and editors review and publish, and
 * the member accepts, declines or stops their own project.
 */
@ApiTags('Learning projects')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard, RolesGuard)
@Controller('api/learning')
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly access: LearningAccessService,
  ) {}

  private ctx(req: any): LearningActionContext {
    return {
      actorUserId: req.user.sub,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    };
  }

  private viewer(req: any) {
    return { isAdmin: req.user.role === 'ADMIN' };
  }

  @Get('allowance')
  @ApiOperation({ summary: 'How many learning projects this workspace\'s plan includes, and how many are open' })
  allowance(@Req() req: any) {
    return this.access.usage(req.user.organizationId);
  }

  // ── The member's own projects ────────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'My learning projects in this workspace' })
  mine(@Req() req: any) {
    return this.learning.mine(req.user.organizationId, req.user.sub);
  }

  @Post('projects/:id/consent')
  @ApiOperation({ summary: 'Accept a learning project as its member: from now on the lessons are kept' })
  consent(@Req() req: any, @Param('id') id: string, @Body() body: LearningConsentDto) {
    return this.learning.consent(req.user.organizationId, id, req.user.sub, body.notice, this.ctx(req));
  }

  @Post('projects/:id/withdraw')
  @ApiOperation({
    summary: 'Decline or stop a learning project as its member, optionally erasing what was not published',
  })
  withdraw(@Req() req: any, @Param('id') id: string, @Body() body: LearningWithdrawDto) {
    return this.learning.withdraw(req.user.organizationId, id, req.user.sub, { erase: body?.erase }, this.ctx(req));
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  @Get('projects')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'List the learning projects of this workspace' })
  list(@Req() req: any) {
    return this.learning.list(req.user.organizationId, this.viewer(req));
  }

  @Post('projects')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Start a learning project for a member on an MCP server (waits for the member to accept)' })
  create(@Req() req: any, @Body() body: CreateLearningProjectDto) {
    return this.learning.create(req.user.organizationId, body, this.ctx(req));
  }

  @Get('projects/:id')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'One learning project with its topics' })
  get(@Req() req: any, @Param('id') id: string) {
    return this.learning.get(req.user.organizationId, id, this.viewer(req));
  }

  @Patch('projects/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Change a learning project\'s name, folder, end date, labels or publishing' })
  update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateLearningProjectDto) {
    return this.learning.update(req.user.organizationId, id, body);
  }

  @Post('projects/:id/pause')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Pause a learning project: nothing is captured until it is resumed' })
  pause(@Req() req: any, @Param('id') id: string) {
    return this.learning.setStatus(req.user.organizationId, id, 'paused', this.ctx(req));
  }

  @Post('projects/:id/resume')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Resume a paused learning project' })
  resume(@Req() req: any, @Param('id') id: string) {
    return this.learning.setStatus(req.user.organizationId, id, 'active', this.ctx(req));
  }

  @Post('projects/:id/end')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'End a learning project. Lessons and published skills are kept' })
  end(@Req() req: any, @Param('id') id: string) {
    return this.learning.setStatus(req.user.organizationId, id, 'ended', this.ctx(req));
  }

  @Delete('projects/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a learning project and its lessons. Published skills are kept' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.learning.remove(req.user.organizationId, id, this.ctx(req));
  }

  // ── Lessons and topics ───────────────────────────────────────────────────

  @Get('projects/:id/lessons')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'The lessons of a learning project, newest first' })
  lessons(
    @Req() req: any,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('topicId') topicId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.learning.lessons(req.user.organizationId, id, {
      status: ['draft', 'confirmed', 'rejected', 'superseded'].includes(status ?? '') ? status : undefined,
      topicId: topicId || undefined,
      take: take ? parseInt(take, 10) || undefined : undefined,
      skip: skip ? parseInt(skip, 10) || undefined : undefined,
    });
  }

  @Patch('lessons/:id')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Confirm, reject, reopen or reword one lesson' })
  setLesson(@Req() req: any, @Param('id') id: string, @Body() body: UpdateLessonDto) {
    return this.learning.setLesson(req.user.organizationId, id, body, this.ctx(req));
  }

  @Get('topics/:id/preview')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'The skill text publishing a topic would write, from its confirmed lessons' })
  preview(@Req() req: any, @Param('id') id: string) {
    return this.learning.preview(req.user.organizationId, id);
  }

  @Post('topics/:id/publish')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Publish a topic\'s confirmed lessons as a skill for everyone on the MCP server' })
  publish(@Req() req: any, @Param('id') id: string) {
    return this.learning.publish(req.user.organizationId, id, this.ctx(req));
  }
}
