import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { SelfHostedOnlyGuard } from '../../common/self-hosted-only.guard';
import { ScimAuthGuard, ScimProvider } from './scim-auth.guard';
import { SCIM_CONTENT_TYPE, ScimError, ScimExceptionFilter } from './scim.errors';
import { parseFilter, parsePagination } from './scim.parser';
import { resourceTypes, schemas, serviceProviderConfig } from './scim.schemas';
import { ScimCtx, ScimUsersService } from './scim-users.service';

/**
 * SCIM 2.0 endpoint for Microsoft Entra ID outbound provisioning.
 *
 * Mounted under /api so the frontend's existing rewrite and the login
 * redirect middleware both leave it alone — a bare /scim would be 302'd to
 * /login by proxy.ts and Entra would receive an HTML page.
 *
 * NO DTO CLASSES HERE, deliberately. The global ValidationPipe runs with
 * `forbidNonWhitelisted`; bodies are typed `unknown` so the pipe never looks
 * at them, and the parser reads the fields it understands. Adding a DTO to
 * any route re-enables whitelisting and 400s every real Entra payload.
 */
@ApiExcludeController()
@UseGuards(SelfHostedOnlyGuard, ScimAuthGuard)
@UseFilters(ScimExceptionFilter)
// Entra's initial cycle sends hundreds of requests within minutes; the global
// 100/min bucket would 429 it. Overrides `default` only — see app.module.ts.
@Throttle({ default: { limit: 1000, ttl: 60_000 } })
@Controller('api/scim/v2')
export class ScimController {
  constructor(
    private readonly users: ScimUsersService,
    private readonly config: ConfigService,
  ) {}

  // ── Discovery ─────────────────────────────────────────────────────────────

  @Get('ServiceProviderConfig')
  serviceProviderConfig(@Req() req: Request, @Res() res: Response) {
    return this.send(res, serviceProviderConfig(this.baseUrl(req)));
  }

  @Get('ResourceTypes')
  resourceTypes(@Req() req: Request, @Res() res: Response) {
    return this.send(res, this.list(resourceTypes(this.baseUrl(req))));
  }

  @Get('ResourceTypes/:name')
  resourceType(@Req() req: Request, @Res() res: Response, @Param('name') name: string) {
    const rt = resourceTypes(this.baseUrl(req)).find((r) => r.id.toLowerCase() === name.toLowerCase());
    if (!rt) throw new ScimError(404, 'Resource type not found', 'noTarget');
    return this.send(res, rt);
  }

  @Get('Schemas')
  schemas(@Req() req: Request, @Res() res: Response) {
    return this.send(res, this.list(schemas(this.baseUrl(req))));
  }

  @Get('Schemas/:uri')
  schema(@Req() req: Request, @Res() res: Response, @Param('uri') uri: string) {
    const s = schemas(this.baseUrl(req)).find((x) => x.id === uri);
    if (!s) throw new ScimError(404, 'Schema not found', 'noTarget');
    return this.send(res, s);
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  @Get('Users')
  async listUsers(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, string>) {
    const ctx = this.ctx(req);
    return this.send(res, await this.users.list(this.provider(req), parseFilter(q.filter), parsePagination(q), ctx));
  }

  @Get('Users/:id')
  async getUser(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    return this.send(res, await this.users.get(this.provider(req), id, this.ctx(req)));
  }

  @Post('Users')
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return this.send(res, await this.users.create(this.provider(req), body, this.ctx(req)), HttpStatus.CREATED);
  }

  @Put('Users/:id')
  async replaceUser(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Body() body: unknown) {
    return this.send(res, await this.users.replace(this.provider(req), id, body, this.ctx(req)));
  }

  @Patch('Users/:id')
  async patchUser(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Body() body: unknown) {
    return this.send(res, await this.users.patch(this.provider(req), id, body, this.ctx(req)));
  }

  @Delete('Users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    await this.users.remove(this.provider(req), id, this.ctx(req));
    res.status(HttpStatus.NO_CONTENT).end();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private provider(req: Request): ScimProvider {
    return (req as any).scimProvider;
  }

  private ctx(req: Request): ScimCtx {
    return { baseUrl: this.baseUrl(req), ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  /**
   * Where this endpoint is reachable, for `meta.location`. Configured URL
   * first; a header-derived value is acceptable as a fallback here because it
   * only decorates responses — nothing is redirected to it.
   */
  private baseUrl(req: Request): string {
    const configured = this.config.get<string>('FRONTEND_URL') || this.config.get<string>('SERVER_URL');
    if (configured) return `${configured.replace(/\/$/, '')}/api/scim/v2`;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] || req.headers.host;
    return `${proto}://${host}/api/scim/v2`;
  }

  private list(resources: unknown[]) {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  private send(res: Response, body: unknown, status = HttpStatus.OK) {
    // `res.json`, not `send(JSON.stringify(...))`: Express keeps a
    // Content-Type that is already set, so the SCIM media type survives, and
    // the JSON encoder is what makes user-supplied strings safe to echo.
    res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return res.status(status).json(body);
  }
}
