import { Controller, Delete, ForbiddenException, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { FileShareService } from './file-share.service';
import { FileShareConnectorService } from './file-share-connector.service';
import { FileShareListQueryDto } from './file-search.dto';

/**
 * File Share links (#1387). The `s/:token` routes are public on purpose: the
 * token (192 bits, stored hashed) is the credential for public links, and
 * internal links additionally need a signed-in member (the `-internal` route).
 */
@ApiTags('File Share')
@Controller('api/file-share')
export class FileShareController {
  constructor(
    private readonly shares: FileShareService,
    private readonly connector: FileShareConnectorService,
  ) {}

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @UseGuards(JwtOrManagementKeyGuard)
  @Get()
  @ApiOperation({ summary: 'List File Share links' })
  async list(@Req() req: any, @Query() query: FileShareListQueryDto) {
    const user = req.user;
    // Members see their own links; administrators every link, or only theirs.
    const onlyMine = user.role !== 'ADMIN' || !!query.mine;
    const [page, limits, usage] = await Promise.all([
      this.shares.list(user.organizationId, {
        userId: onlyMine ? user.sub : undefined,
        q: query.q,
        access: query.access,
        page: query.page,
        pageSize: query.pageSize,
      }),
      this.shares.limits(user.organizationId),
      this.shares.usage(user.organizationId),
    ]);
    const connector = await this.connector.find(user.organizationId);
    return { ...page, limits, usage, connector };
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @UseGuards(JwtOrManagementKeyGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a File Share link' })
  revoke(@Req() req: any, @Param('id') id: string) {
    return this.shares.revoke(req.user.organizationId, id, req.user);
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @UseGuards(JwtOrManagementKeyGuard)
  @Post('connector')
  @ApiOperation({ summary: 'Create the File Share connector (admin only)' })
  createConnector(@Req() req: any) {
    if (req.user.role !== 'ADMIN') throw new ForbiddenException('Only workspace administrators can add the File Share connector.');
    return this.connector.ensure(req.user);
  }

  @Get('s/:token')
  @ApiOperation({ summary: 'Describe a public share by its token (public)' })
  describe(@Param('token') token: string) {
    return this.shares.describe(token);
  }

  @Post('s/:token/download')
  @ApiOperation({ summary: 'Issue a download for a public share (public)' })
  download(@Param('token') token: string) {
    return this.shares.issueDownload(token, null);
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @UseGuards(JwtOrManagementKeyGuard)
  @Post('s/:token/download-internal')
  @ApiOperation({ summary: 'Issue a download for an internal share (signed-in member)' })
  downloadInternal(@Req() req: any, @Param('token') token: string) {
    return this.shares.issueDownload(token, req.user);
  }

  @Get('d/:signed')
  @ApiOperation({ summary: 'Stream a signed file download (public)' })
  async stream(@Param('signed') signed: string, @Res() res: Response) {
    const file = await this.shares.openSigned(signed);
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    // Types a browser could run or render as a page are always sent as bytes.
    const active = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript)/i.test(file.mimeType ?? '');
    res.setHeader('Content-Type', active || !file.mimeType ? 'application/octet-stream' : file.mimeType);
    res.setHeader('Content-Length', String(file.bytes));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @UseGuards(JwtOrManagementKeyGuard)
  @Get('limits')
  @ApiOperation({ summary: 'Get File Share limits and usage' })
  async limits(@Req() req: any) {
    return { limits: await this.shares.limits(req.user.organizationId), usage: await this.shares.usage(req.user.organizationId) };
  }
}
