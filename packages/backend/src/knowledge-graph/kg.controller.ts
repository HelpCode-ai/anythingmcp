import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { KgService } from './kg.service';
import { KgSkillService, SKILL_BODY_MAX } from './kg-skill.service';
import { KnowledgeFoldersService } from '../knowledge-folders/knowledge-folders.service';
import {
  KgLearningService,
  LEARNING_BULK_MAX,
  LEARNING_MODES,
  type LearningMode,
} from './kg-learning.service';

const SKILL_STATUSES = ['pending', 'applied', 'dismissed'];

class CreateSkillDto {
  @ApiProperty({ description: 'Short name of the skill (stored up to 160 characters).' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ description: 'When the model should apply it.' })
  @IsOptional()
  @IsString()
  whenToUse?: string;

  @ApiProperty({ description: 'The rule (stored up to 2000 characters).' })
  @IsString()
  instruction: string;

  @ApiPropertyOptional({
    description: `Optional full procedure in markdown (up to ${SKILL_BODY_MAX} characters). Served by skill_get, never pasted into the instructions.`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SKILL_BODY_MAX)
  body?: string | null;

  @ApiPropertyOptional({ description: 'Scope the skill to one connector of this workspace.' })
  @IsOptional()
  @IsString()
  connectorId?: string | null;

  @ApiPropertyOptional({ description: 'Scope the skill to one MCP server of this workspace (wins over connectorId).' })
  @IsOptional()
  @IsString()
  mcpServerId?: string | null;

  @ApiPropertyOptional({ enum: SKILL_STATUSES, description: 'Defaults to applied.' })
  @IsOptional()
  @IsIn(SKILL_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Knowledge folder id; omit for the top level.' })
  @IsOptional()
  @IsString()
  folderId?: string | null;
}

class UpdateSkillDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  whenToUse?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  instruction?: string;

  @ApiPropertyOptional({ description: 'Full procedure in markdown; empty string or null removes it.' })
  @IsOptional()
  @IsString()
  @MaxLength(SKILL_BODY_MAX)
  body?: string | null;

  @ApiPropertyOptional({ enum: SKILL_STATUSES })
  @IsOptional()
  @IsIn(SKILL_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Knowledge folder id; null moves the skill to the top level.' })
  @IsOptional()
  @IsString()
  folderId?: string | null;
}

class SkillScopeDto {
  @ApiPropertyOptional({ description: 'Work on one MCP server; omit for the connector-scoped skills.' })
  @IsOptional()
  @IsString()
  mcpServerId?: string;
}

class SetMembersLearningDto {
  @ApiProperty({ type: [String], description: `Member user ids of this workspace (max ${LEARNING_BULK_MAX}).` })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(LEARNING_BULK_MAX)
  @IsString({ each: true })
  userIds: string[];

  @ApiProperty({
    enum: LEARNING_MODES,
    description: 'inherit = follow the workspace switch; on / off = override it for these members.',
  })
  @IsIn(LEARNING_MODES as unknown as string[])
  mode: LearningMode;

  @ApiPropertyOptional({
    description: 'Also erase the intents already captured from members whose learning ends up off.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  clearIntents?: boolean;
}

class SetMyLearningDto {
  @ApiProperty({ description: 'true = do not use my requests for skill learning in this workspace.' })
  @IsBoolean()
  optOut: boolean;

  @ApiPropertyOptional({
    description: 'When opting out, also erase the intents already captured from me.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  clearIntents?: boolean;
}

@ApiTags('Knowledge Graph')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('api/knowledge-graph')
export class KgController {
  constructor(
    private readonly kg: KgService,
    private readonly skills: KgSkillService,
    private readonly learning: KgLearningService,
    private readonly folders: KnowledgeFoldersService,
  ) {}

  @Get()
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Get the knowledge graph for the current workspace' })
  async getGraph(@Req() req: any) {
    return this.kg.getGraph(req.user.organizationId, req.user.sub);
  }

  @Get('stats')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Graph counts (nodes, edges, suggested)' })
  async stats(@Req() req: any) {
    return this.kg.stats(req.user.organizationId);
  }

  @Get('settings')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Whether the knowledge graph is enabled for this workspace' })
  async getSettings(@Req() req: any) {
    return this.kg.getSettings(req.user.organizationId);
  }

  @Put('settings')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update knowledge-graph settings for this workspace' })
  async setSettings(
    @Req() req: any,
    @Body()
    body: {
      enabled?: boolean;
      llmEnabled?: boolean;
      captureIntent?: boolean;
      autoExtend?: boolean;
      skillAutoApply?: boolean;
      edgeAutoApply?: boolean;
    },
  ) {
    return this.kg.updateSettings(req.user.organizationId, body);
  }

  @Post('enrich')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Run the optional LLM enrichment pass (suggests links)' })
  async enrich(@Req() req: any) {
    return this.kg.enrich(req.user.organizationId);
  }

  @Get('skills')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'List skill suggestions (filterable + paginated) with per-status counts' })
  async listSkills(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('folderId') folderId?: string,
  ) {
    return this.skills.list(req.user.organizationId, {
      status,
      q,
      take: take ? parseInt(take, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
      folderId,
      folders: await this.folders.accessFor(req.user.organizationId, req.user.sub),
    });
  }

  @Post('skills')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a skill manually (live for MCP by default)' })
  async createSkill(
    @Req() req: any,
    @Body() body: CreateSkillDto,
  ) {
    return this.skills.create(req.user.organizationId, { ...body, source: 'manual' });
  }

  @Post('skills/generate')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Generate skill suggestions from captured intents — per-connector, or server-wide when mcpServerId is given',
  })
  async generateSkills(@Req() req: any, @Body() body: SkillScopeDto) {
    return this.skills.generate(req.user.organizationId, { mcpServerId: body?.mcpServerId });
  }

  @Post('skills/propose-from-errors')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Propose skills from calls that failed and were fixed by changing an argument format (no AI model needed)',
  })
  async proposeFromErrors(@Req() req: any) {
    return this.skills.proposeFromErrors(req.user.organizationId);
  }

  @Post('skills/consolidate')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Merge the active skills in a scope into the fewest non-redundant ones (AI)',
  })
  async consolidateSkills(@Req() req: any, @Body() body: SkillScopeDto) {
    return this.skills.consolidate(req.user.organizationId, { mcpServerId: body?.mcpServerId });
  }

  @Post('skills/:id/apply')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Activate a skill (composed into the MCP server instructions)' })
  async applySkill(@Req() req: any, @Param('id') id: string) {
    return this.skills.apply(req.user.organizationId, id);
  }

  @Post('skills/:id/dismiss')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Dismiss a skill suggestion' })
  async dismissSkill(@Req() req: any, @Param('id') id: string) {
    return this.skills.dismiss(req.user.organizationId, id);
  }

  @Patch('skills/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Edit a skill (title / when / instruction / status)' })
  async updateSkill(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: UpdateSkillDto,
  ) {
    return this.skills.update(req.user.organizationId, id, body, req.user.sub);
  }

  @Get('skills/:id/versions')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Earlier versions of a skill, newest first' })
  async skillVersions(@Req() req: any, @Param('id') id: string) {
    return this.skills.versions(
      req.user.organizationId,
      id,
      await this.folders.accessFor(req.user.organizationId, req.user.sub),
    );
  }

  // ── Who contributes to skill learning ────────────────────────────────────

  @Get('learning/me')
  @ApiOperation({ summary: 'Whether my requests are used for skill learning in this workspace' })
  async getMyLearning(@Req() req: any) {
    return this.learning.getForMember(req.user.organizationId, req.user.sub);
  }

  @Put('learning/me')
  @ApiOperation({
    summary: 'Opt out of (or back into) skill learning in this workspace. Cannot override an admin\'s "off".',
  })
  async setMyLearning(@Req() req: any, @Body() body: SetMyLearningDto) {
    return this.learning.setOptOut(
      req.user.organizationId,
      req.user.sub,
      body.optOut,
      this.actionContext(req),
      { clearIntents: body.clearIntents },
    );
  }

  @Put('learning/members')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Set whether these members\' requests are used for skill learning (ADMIN)' })
  async setMembersLearning(@Req() req: any, @Body() body: SetMembersLearningDto) {
    return this.learning.setMode(
      req.user.organizationId,
      body.userIds,
      body.mode,
      this.actionContext(req),
      { clearIntents: body.clearIntents },
    );
  }

  @Delete('skills/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a skill' })
  async deleteSkill(@Req() req: any, @Param('id') id: string) {
    return this.skills.remove(req.user.organizationId, id);
  }

  @Post('rebuild')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Rebuild the graph (static + observational)' })
  async rebuild(@Req() req: any) {
    return this.kg.rebuild(req.user.organizationId);
  }

  @Post('nodes')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a custom entity attached to a connector' })
  async createNode(
    @Req() req: any,
    @Body() body: { connectorId: string; label: string; entity?: string; description?: string },
  ) {
    return this.kg.createNode(req.user.organizationId, body);
  }

  @Post('edges')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a manual link between two entities' })
  async createEdge(
    @Req() req: any,
    @Body()
    body: { sourceNodeId: string; targetNodeId: string; kind?: string; note?: string },
  ) {
    return this.kg.createManualEdge(req.user.organizationId, body);
  }

  @Patch('edges/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Edit an edge: status, kind, and/or description (note)' })
  async updateEdge(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      status?: 'active' | 'rejected' | 'suggested';
      kind?: string;
      note?: string | null;
      matchKey?: string | null;
    },
  ) {
    return this.kg.updateEdge(req.user.organizationId, id, body);
  }

  @Delete('edges/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete an edge' })
  async deleteEdge(@Req() req: any, @Param('id') id: string) {
    return this.kg.deleteEdge(req.user.organizationId, id);
  }

  @Patch('nodes/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Edit an entity node: label and/or description' })
  async updateNode(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { label?: string; description?: string | null },
  ) {
    return this.kg.updateNode(req.user.organizationId, id, body);
  }

  @Delete('nodes/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete an entity node and its edges' })
  async deleteNode(@Req() req: any, @Param('id') id: string) {
    return this.kg.deleteNode(req.user.organizationId, id);
  }

  private actionContext(req: any) {
    return {
      actorUserId: req.user.sub as string,
      ip: req.ip as string | undefined,
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
  }
}
