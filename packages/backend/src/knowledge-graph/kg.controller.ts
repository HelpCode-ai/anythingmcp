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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { KgService } from './kg.service';
import { KgSkillService } from './kg-skill.service';

@ApiTags('Knowledge Graph')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('api/knowledge-graph')
export class KgController {
  constructor(
    private readonly kg: KgService,
    private readonly skills: KgSkillService,
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
  ) {
    return this.skills.list(req.user.organizationId, {
      status,
      q,
      take: take ? parseInt(take, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
    });
  }

  @Post('skills')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a skill manually (live for MCP by default)' })
  async createSkill(
    @Req() req: any,
    @Body()
    body: {
      title: string;
      whenToUse?: string;
      instruction: string;
      connectorId?: string | null;
      mcpServerId?: string | null;
      status?: string;
    },
  ) {
    return this.skills.create(req.user.organizationId, body);
  }

  @Post('skills/generate')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Generate skill suggestions from captured intents — per-connector, or server-wide when mcpServerId is given',
  })
  async generateSkills(@Req() req: any, @Body() body: { mcpServerId?: string }) {
    return this.skills.generate(req.user.organizationId, { mcpServerId: body?.mcpServerId });
  }

  @Post('skills/consolidate')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Merge the active skills in a scope into the fewest non-redundant ones (AI)',
  })
  async consolidateSkills(@Req() req: any, @Body() body: { mcpServerId?: string }) {
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
    @Body() body: { title?: string; whenToUse?: string; instruction?: string; status?: string },
  ) {
    return this.skills.update(req.user.organizationId, id, body);
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
}
