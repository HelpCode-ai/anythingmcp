import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../common/pagination.dto';
import { ScriptCaller } from './codebound.service';
import {
  RunSavedScriptDto,
  SaveScriptDto,
  UpdateScriptDto,
} from './codebound.dto';
import { SavedScriptsService } from './saved-scripts.service';

@ApiTags('Codebound')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/codebound/scripts')
export class SavedScriptsController {
  constructor(private readonly scripts: SavedScriptsService) {}

  @Get()
  @ApiOperation({ summary: 'List saved scripts in the current workspace' })
  list(
    @Req() req: { user: ScriptCaller },
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.scripts.list(req.user, pagination);
  }

  @Post()
  @ApiOperation({ summary: 'Save a reusable script in the current workspace' })
  create(@Req() req: { user: ScriptCaller }, @Body() dto: SaveScriptDto) {
    return this.scripts.create(req.user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Open a saved script' })
  get(@Req() req: { user: ScriptCaller }, @Param('id') id: string) {
    return this.scripts.get(req.user, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a saved script at its reviewed revision' })
  update(
    @Req() req: { user: ScriptCaller },
    @Param('id') id: string,
    @Body() dto: UpdateScriptDto,
  ) {
    return this.scripts.update(req.user, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a saved script' })
  delete(@Req() req: { user: ScriptCaller }, @Param('id') id: string) {
    return this.scripts.delete(req.user, id);
  }

  @Post(':id/run')
  @ApiOperation({
    summary: 'Execute a saved script using current caller permissions',
  })
  run(
    @Req() req: { user: ScriptCaller },
    @Param('id') id: string,
    @Body() dto: RunSavedScriptDto,
  ) {
    return this.scripts.run(req.user, id, dto);
  }
}
