import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
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
import { KnowledgeFoldersService } from './knowledge-folders.service';

class CreateFolderDto {
  @ApiProperty({ description: 'Folder name (no "/").' })
  @IsString()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ description: 'Parent folder id; omit for a top-level folder.' })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @ApiPropertyOptional({ description: 'What belongs here; shown to AI clients when skills are listed by folder.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

class UpdateFolderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'New parent id; null moves the folder to the top level.' })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

class FolderRolesDto {
  @ApiProperty({ type: [String], description: 'Custom role ids; empty = the whole workspace.' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  roleIds: string[];
}

class MoveItemsDto {
  @ApiProperty({ enum: ['skill', 'memory'] })
  @IsIn(['skill', 'memory'])
  kind: 'skill' | 'memory';

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids: string[];

  @ApiPropertyOptional({ description: 'Target folder id; null = top level.' })
  @IsOptional()
  @IsString()
  folderId?: string | null;
}

@ApiTags('Knowledge folders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('api/knowledge-folders')
export class KnowledgeFoldersController {
  constructor(private readonly folders: KnowledgeFoldersService) {}

  @Get()
  @ApiOperation({ summary: 'The folders I may see, with skill and company-memory counts' })
  async list(@Req() req: any) {
    return this.folders.listForCaller(req.user.organizationId, req.user.sub);
  }

  @Post()
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Create a folder' })
  async create(@Req() req: any, @Body() body: CreateFolderDto) {
    return this.folders.create(req.user.organizationId, body, req.user.sub);
  }

  @Patch(':id')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Rename, describe or move a folder' })
  async update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateFolderDto) {
    return this.folders.update(req.user.organizationId, id, body, req.user.role === 'ADMIN', req.user.sub);
  }

  @Delete(':id')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Delete a folder; its subfolders and items move to its parent' })
  async remove(@Req() req: any, @Param('id') id: string) {
    return this.folders.remove(req.user.organizationId, id, req.user.sub);
  }

  @Put(':id/roles')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Limit a folder and its subtree to roles (ADMIN, Enterprise)' })
  async setRoles(@Req() req: any, @Param('id') id: string, @Body() body: FolderRolesDto) {
    return this.folders.setRoles(req.user.organizationId, id, body.roleIds, {
      actorUserId: req.user.sub,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }

  @Post('move')
  @Roles('ADMIN', 'EDITOR')
  @ApiOperation({ summary: 'Move skills or company memory items into a folder' })
  async move(@Req() req: any, @Body() body: MoveItemsDto) {
    return this.folders.moveItems(
      req.user.organizationId,
      body.kind,
      body.ids,
      body.folderId ?? null,
      req.user.role === 'ADMIN',
      req.user.sub,
    );
  }
}
