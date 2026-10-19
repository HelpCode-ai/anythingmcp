import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { KnowledgeFoldersService } from '../knowledge-folders/knowledge-folders.service';
import {
  MEMORY_ACCESS_LEVELS,
  MEMORY_CONTENT_MAX,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_TAGS_MAX,
  MEMORY_WRITE_MODES,
  MemoryService,
  type MemoryAccess,
  type MemoryAccessSetting,
  type MemoryWriteMode,
  allows,
} from './memory.service';

const CURATOR_ROLES = ['ADMIN', 'EDITOR'];

class CreateMemoryDto {
  @ApiProperty({ description: `What to remember (up to ${MEMORY_CONTENT_MAX} characters, no secrets).` })
  @IsString()
  @MaxLength(MEMORY_CONTENT_MAX)
  content: string;

  @ApiPropertyOptional({ enum: MEMORY_KINDS, default: 'fact' })
  @IsOptional()
  @IsIn(MEMORY_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional({
    enum: MEMORY_SCOPES,
    default: 'personal',
    description: 'organization: admins and editors only from the dashboard.',
  })
  @IsOptional()
  @IsIn(MEMORY_SCOPES as unknown as string[])
  scope?: string;

  @ApiPropertyOptional({ type: [String], description: `Up to ${MEMORY_TAGS_MAX} tags.` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEMORY_TAGS_MAX)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Knowledge folder id (company memory only).' })
  @IsOptional()
  @IsString()
  folderId?: string | null;
}

class UpdateMemoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MEMORY_CONTENT_MAX)
  content?: string;

  @ApiPropertyOptional({ enum: MEMORY_KINDS })
  @IsOptional()
  @IsIn(MEMORY_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEMORY_TAGS_MAX)
  @IsString({ each: true })
  tags?: string[];
}

class MemorySettingsDto {
  @ApiPropertyOptional({
    enum: MEMORY_ACCESS_LEVELS.filter((l) => l !== 'inherit'),
    description: 'Access of members set to inherit.',
  })
  @IsOptional()
  @IsIn(MEMORY_ACCESS_LEVELS.filter((l) => l !== 'inherit'))
  defaultAccess?: MemoryAccess;

  @ApiPropertyOptional({
    enum: MEMORY_WRITE_MODES,
    description: 'approval: organization items from AI clients wait for an admin or editor; auto: saved right away.',
  })
  @IsOptional()
  @IsIn(MEMORY_WRITE_MODES as unknown as string[])
  writeMode?: MemoryWriteMode;
}

class SetMemoryAccessDto {
  @ApiProperty({ type: [String], description: 'Member user ids of this workspace (max 500).' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  userIds: string[];

  @ApiProperty({ enum: MEMORY_ACCESS_LEVELS })
  @IsIn(MEMORY_ACCESS_LEVELS as unknown as string[])
  access: MemoryAccessSetting;
}

@ApiTags('Memory')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('api/memory')
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly folders: KnowledgeFoldersService,
  ) {}

  private access(req: any) {
    return this.folders.accessFor(req.user.organizationId, req.user.sub);
  }

  @Get('status')
  @ApiOperation({ summary: 'Whether memory is licensed here, my access and the workspace settings' })
  async status(@Req() req: any) {
    const org = req.user.organizationId;
    const licensed = await this.memory.licensed(org);
    return {
      licensed,
      access: licensed ? await this.memory.accessFor(org, req.user.sub) : 'none',
      settings: await this.memory.settings(org),
      isCurator: CURATOR_ROLES.includes(req.user.role),
    };
  }

  @Get('items')
  @ApiOperation({
    summary:
      'List my personal memory (scope=personal) or the company memory (scope=organization; pending/rejected for admins and editors)',
  })
  async list(
    @Req() req: any,
    @Query('scope') scope?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('folderId') folderId?: string,
  ) {
    const org = req.user.organizationId;
    const curator = CURATOR_ROLES.includes(req.user.role);
    const sc = scope === 'organization' ? 'organization' : 'personal';
    if (sc === 'organization') {
      if (status && status !== 'active' && !curator) {
        throw new ForbiddenException('Only admins and editors review company memory.');
      }
      if (!curator && !allows(await this.memory.accessFor(org, req.user.sub), 'read')) {
        throw new ForbiddenException('Your memory access does not include the company memory.');
      }
    }
    return this.memory.list(org, req.user.sub, {
      scope: sc,
      status,
      q,
      take: take ? parseInt(take, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
      folderId,
      folders: sc === 'organization' ? await this.access(req) : null,
    });
  }

  @Post('items')
  @ApiOperation({ summary: 'Add to my personal memory, or (admins and editors) to the company memory' })
  async create(@Req() req: any, @Body() body: CreateMemoryDto) {
    const org = req.user.organizationId;
    const curator = CURATOR_ROLES.includes(req.user.role);
    const organization = body.scope === 'organization';
    if (organization && !curator) {
      throw new ForbiddenException('Only admins and editors add to the company memory here.');
    }
    await this.memory.assertLicensed(org);
    const level = await this.memory.accessFor(org, req.user.sub);
    return this.memory.save(
      // A curator writing company memory needs no member level for it.
      {
        organizationId: org,
        userId: req.user.sub,
        level: organization ? 'contribute' : level,
        folders: organization ? await this.access(req) : null,
      },
      { ...body, folder: body.folderId ?? null },
      { via: 'ui' },
      { asCurator: organization },
    );
  }

  @Patch('items/:id')
  @ApiOperation({ summary: 'Edit one of my personal items, or (admins and editors) a company item' })
  async update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateMemoryDto) {
    return this.memory.update(
      req.user.organizationId,
      req.user.sub,
      CURATOR_ROLES.includes(req.user.role),
      id,
      body,
      await this.access(req),
    );
  }

  @Delete('items/:id')
  @ApiOperation({ summary: 'Delete one of my personal items, or (admins and editors) a company item' })
  async remove(@Req() req: any, @Param('id') id: string) {
    return this.memory.remove(
      req.user.organizationId,
      req.user.sub,
      CURATOR_ROLES.includes(req.user.role),
      id,
      await this.access(req),
    );
  }

  @Post('items/:id/approve')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Approve a pending company memory item' })
  async approve(@Req() req: any, @Param('id') id: string) {
    return this.memory.review(req.user.organizationId, req.user.sub, id, 'approve', await this.access(req));
  }

  @Post('items/:id/reject')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Reject a pending company memory item' })
  async reject(@Req() req: any, @Param('id') id: string) {
    return this.memory.review(req.user.organizationId, req.user.sub, id, 'reject', await this.access(req));
  }

  @Put('settings')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Default member access and how AI clients write company memory (ADMIN)' })
  async updateSettings(@Req() req: any, @Body() body: MemorySettingsDto) {
    return this.memory.updateSettings(req.user.organizationId, body, this.actionContext(req));
  }

  @Put('members/access')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Set the memory access of members (ADMIN)' })
  async setAccess(@Req() req: any, @Body() body: SetMemoryAccessDto) {
    return this.memory.setAccess(req.user.organizationId, body.userIds, body.access, this.actionContext(req));
  }

  @Delete('members/:userId/personal')
  @Roles('ADMIN')
  @ApiOperation({ summary: "Erase a member's personal memory in this workspace without reading it (ADMIN)" })
  async erasePersonal(@Req() req: any, @Param('userId') userId: string) {
    return this.memory.erasePersonal(req.user.organizationId, userId, this.actionContext(req));
  }

  private actionContext(req: any) {
    return {
      actorUserId: req.user.sub as string,
      ip: req.ip as string | undefined,
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
  }
}
