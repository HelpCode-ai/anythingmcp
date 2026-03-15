import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AdaptersService } from './adapters.service';
import { LicenseGuardService } from '../license/license-guard.service';

@ApiTags('Adapters')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/adapters')
export class AdaptersController {
  constructor(
    private readonly adaptersService: AdaptersService,
    private readonly licenseGuard: LicenseGuardService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List all available built-in adapters',
    description:
      'Returns metadata for all pre-configured adapters that can be imported with a single click.',
  })
  list() {
    return this.adaptersService.listAll();
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Get adapter details including tool definitions',
    description:
      'Returns the full adapter definition with connector config and all tool mappings.',
  })
  getBySlug(@Param('slug') slug: string) {
    return this.adaptersService.getBySlug(slug);
  }

  @Post(':slug/import')
  @ApiOperation({
    summary: 'Import a built-in adapter as a new connector',
    description:
      'Creates a new connector and its tools from a pre-configured adapter recipe. ' +
      'Optionally provide credentials in the request body to make the connector immediately functional.',
  })
  async importAdapter(
    @Req() req: any,
    @Param('slug') slug: string,
    @Body() body: { credentials?: Record<string, string> },
  ) {
    await this.licenseGuard.checkCanCreateConnector(req.user.sub);
    const result = await this.adaptersService.importAdapter(
      slug,
      req.user.sub,
      body?.credentials,
    );
    return {
      message: `Adapter "${slug}" imported successfully with ${result.toolsCreated} tools.`,
      connectorId: result.connectorId,
      toolsCreated: result.toolsCreated,
    };
  }
}
