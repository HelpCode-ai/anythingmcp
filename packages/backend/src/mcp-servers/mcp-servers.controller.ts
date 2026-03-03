import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsBoolean, IsArray } from 'class-validator';
import { McpServersService } from './mcp-servers.service';

class CreateMcpServerDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class UpdateMcpServerDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class AssignConnectorsDto {
  @IsArray()
  @IsString({ each: true })
  connectorIds: string[];
}

@ApiTags('MCP Servers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/mcp-servers')
export class McpServersController {
  constructor(private readonly mcpServersService: McpServersService) {}

  @Get()
  @ApiOperation({ summary: 'List MCP servers for current user' })
  async list(@Req() req: any) {
    return this.mcpServersService.findAllByUser(req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new MCP server' })
  async create(@Req() req: any, @Body() dto: CreateMcpServerDto) {
    return this.mcpServersService.create(req.user.sub, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get MCP server detail' })
  async get(@Req() req: any, @Param('id') id: string) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    if (server.userId !== req.user.sub) throw new ForbiddenException();
    return server;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update MCP server' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateMcpServerDto) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    if (server.userId !== req.user.sub) throw new ForbiddenException();
    return this.mcpServersService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete MCP server' })
  async delete(@Req() req: any, @Param('id') id: string) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    if (server.userId !== req.user.sub) throw new ForbiddenException();
    await this.mcpServersService.delete(id);
    return { message: 'MCP server deleted' };
  }

  @Put(':id/connectors')
  @ApiOperation({ summary: 'Assign connectors to MCP server' })
  async assignConnectors(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AssignConnectorsDto,
  ) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    if (server.userId !== req.user.sub) throw new ForbiddenException();
    await this.mcpServersService.assignConnectors(id, dto.connectorIds);
    return { message: 'Connectors assigned' };
  }
}
