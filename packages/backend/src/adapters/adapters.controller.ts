import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AdaptersService } from './adapters.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';
import { STARTER_PACK_MAX_INSTALL } from './starter-pack';

// Public endpoints (no auth required) — used by the marketing website
@ApiTags('Adapters')
@Controller('api/adapters')
export class AdaptersPublicController {
  constructor(private readonly adaptersService: AdaptersService) {}

  @Get()
  @ApiOperation({
    summary: 'List all available built-in adapters',
    description:
      'Returns metadata for all pre-configured adapters. This endpoint is public so the marketing website can render the marketplace dynamically.',
  })
  list() {
    return this.adaptersService.listAll();
  }
}

// Authenticated endpoints
@ApiTags('Adapters')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/adapters')
export class AdaptersController {
  constructor(
    private readonly adaptersService: AdaptersService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly mcpServers: McpServersService,
    private readonly productEvents: ProductEventService,
  ) {}

  // Declared before `:slug`, which would otherwise take "starter-pack" for
  // an adapter slug.
  @Get('starter-pack')
  @ApiOperation({
    summary: 'Connectors offered to a new workspace',
    description:
      'Keyless connectors that install in one click, with whether this workspace already has each one.',
  })
  starterPack(@Req() req: any) {
    return this.adaptersService.starterPack(req.user.organizationId);
  }

  @Post('starter-pack/install')
  @ApiOperation({
    summary: 'Install connectors from the starter pack',
    description:
      'Installs the chosen starter-pack connectors and puts them on your default MCP server. ' +
      'Each one is reported separately, so one failure does not undo the others.',
  })
  async installStarterPack(@Req() req: any, @Body() body: { slugs?: unknown }) {
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot modify connectors');
    }
    const requested = body?.slugs;
    if (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      requested.length > STARTER_PACK_MAX_INSTALL ||
      requested.some((s) => typeof s !== 'string')
    ) {
      throw new BadRequestException('Pick between 1 and 10 connectors from the starter pack.');
    }
    const orgId = req.user.organizationId;
    const offered = new Map(
      (await this.adaptersService.starterPack(orgId)).map((i) => [i.slug, i]),
    );
    const unknown = (requested as string[]).filter((s) => !offered.has(s));
    if (unknown.length) {
      throw new BadRequestException(`Not in the starter pack: ${unknown.join(', ')}`);
    }

    const results: StarterPackInstallResult[] = [];
    let server: { id: string; name: string } | null = null;
    // One at a time: the trial limit counts connectors, so it has to see the
    // previous install before it judges the next one.
    for (const slug of [...new Set(requested as string[])]) {
      if (offered.get(slug)!.installed) {
        results.push({ slug, status: 'already_installed' });
        continue;
      }
      try {
        await this.licenseGuard.checkCanCreateConnector(req.user.sub, orgId);
        const imported = await this.adaptersService.importAdapter(slug, req.user.sub, orgId);
        const attached = await this.mcpServers.attachToDefaultServer(
          req.user.sub,
          orgId,
          imported.connectorId,
        );
        if (attached) server = { id: attached.id, name: attached.name };
        results.push({
          slug,
          status: 'installed',
          connectorId: imported.connectorId,
          toolsCreated: imported.toolsCreated,
          probeOk: imported.probe ? imported.probe.ok : null,
        });
      } catch (err: any) {
        results.push({ slug, status: 'failed', error: String(err?.message ?? err).slice(0, 300) });
      }
    }

    const installed = results.filter((r) => r.status === 'installed').map((r) => r.slug);
    if (installed.length) {
      void this.productEvents.log({
        event: ProductEvents.STARTER_PACK_INSTALLED,
        userId: req.user.sub,
        organizationId: orgId,
        metadata: { adapterSlug: installed.join(','), serverId: server?.id },
      });
    }
    return { results, server };
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
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot modify connectors');
    }
    await this.licenseGuard.checkCanCreateConnector(req.user.sub, req.user.organizationId);
    const result = await this.adaptersService.importAdapter(
      slug,
      req.user.sub,
      req.user.organizationId,
      body?.credentials,
    );
    // Same as a hand-made connector (connectors.controller): put it on a
    // server straight away. A marketplace install that reaches no server is
    // exactly the connector nobody's client ever sees.
    const attachedTo = await this.mcpServers.attachToDefaultServer(
      req.user.sub,
      req.user.organizationId,
      result.connectorId,
    );
    return {
      message: `Adapter "${slug}" imported successfully with ${result.toolsCreated} tools.`,
      connectorId: result.connectorId,
      toolsCreated: result.toolsCreated,
      attachedToServer: attachedTo ? { id: attachedTo.id, name: attachedTo.name } : null,
      // The store page has always read this to say whether the first test
      // call worked; it was computed and then left out of the response.
      probe: result.probe,
    };
  }
}

export interface StarterPackInstallResult {
  slug: string;
  status: 'installed' | 'already_installed' | 'failed';
  connectorId?: string;
  toolsCreated?: number;
  /** Outcome of the test call made at install; null when none was made. */
  probeOk?: boolean | null;
  error?: string;
}
