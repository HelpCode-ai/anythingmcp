import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RunScriptDto } from './codebound.dto';
import { CodeboundService, ScriptCaller } from './codebound.service';

@ApiTags('Codebound')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/codebound/servers/:serverId')
export class CodeboundController {
  constructor(private readonly codebound: CodeboundService) {}

  @Get('tools')
  @ApiOperation({ summary: 'List REST read tools available to a script run' })
  tools(
    @Req() req: { user: ScriptCaller },
    @Param('serverId') serverId: string,
  ) {
    return this.codebound.listTools(req.user, serverId);
  }

  @Post('run')
  @ApiOperation({
    summary: 'Run an isolated JavaScript body with authorized connector reads',
  })
  run(
    @Req() req: { user: ScriptCaller },
    @Param('serverId') serverId: string,
    @Body() dto: RunScriptDto,
  ) {
    return this.codebound.run(req.user, serverId, dto);
  }
}
