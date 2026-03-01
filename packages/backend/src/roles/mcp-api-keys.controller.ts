import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString } from 'class-validator';
import { McpApiKeysService } from './mcp-api-keys.service';

class CreateKeyDto {
  @IsString()
  name: string;
}

@ApiTags('MCP API Keys')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/mcp-keys')
export class McpApiKeysController {
  constructor(private readonly keysService: McpApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'List my MCP API keys' })
  async listKeys(@Req() req: any) {
    const keys = await this.keysService.listByUser(req.user.sub);
    // Mask keys for display: show only last 8 chars
    return keys.map((k) => ({
      ...k,
      key: `mcp_${'•'.repeat(24)}${k.key.slice(-8)}`,
    }));
  }

  @Post()
  @ApiOperation({ summary: 'Generate a new MCP API key' })
  async generateKey(@Req() req: any, @Body() dto: CreateKeyDto) {
    // Returns the full key — user must save it, it won't be shown again
    return this.keysService.generate(req.user.sub, dto.name);
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke (deactivate) an MCP API key' })
  async revokeKey(@Req() req: any, @Param('id') id: string) {
    await this.keysService.revoke(id, req.user.sub);
    return { message: 'Key revoked' };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an MCP API key' })
  async deleteKey(@Req() req: any, @Param('id') id: string) {
    await this.keysService.deleteKey(id, req.user.sub);
    return { message: 'Key deleted' };
  }
}
