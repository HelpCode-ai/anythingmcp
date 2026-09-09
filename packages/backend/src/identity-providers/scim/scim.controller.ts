import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { SelfHostedOnlyGuard } from '../../common/self-hosted-only.guard';
import { ScimAuthGuard, ScimProvider } from './scim-auth.guard';
import { SCIM_CONTENT_TYPE, ScimError, ScimExceptionFilter } from './scim.errors';
import { parseExcluded, parseFilter, parsePagination } from './scim.parser';
import { resourceTypes, schemas, serviceProviderConfig } from './scim.schemas';
import { ScimCtx, ScimUsersService } from './scim-users.service';
import { ScimGroupsService } from './scim-groups.service';

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
 *
 * No `@Res()` either: handlers return plain objects and Nest serialises them
 * (Express keeps the Content-Type set by `@Header`, so the SCIM media type
 * survives). Writing `res.json(body)` from a helper looked to CodeQL like a
 * reflected-XSS sink it could not tie to a route; a typed return value is
 * not one.
 */
const ScimJson = () => Header('Content-Type', SCIM_CONTENT_TYPE);

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
    private readonly groups: ScimGroupsService,
    private readonly config: ConfigService,
  ) {}

  // ── Discovery ─────────────────────────────────────────────────────────────

  @Get('ServiceProviderConfig')
  @ScimJson()
  serviceProviderConfig(@Req() req: Request) {
    return serviceProviderConfig(this.baseUrl(req));
  }

  @Get('ResourceTypes')
  @ScimJson()
  resourceTypes(@Req() req: Request) {
    return this.list(resourceTypes(this.baseUrl(req)));
  }

  @Get('ResourceTypes/:name')
  @ScimJson()
  resourceType(@Req() req: Request, @Param('name') name: string) {
    const rt = resourceTypes(this.baseUrl(req)).find((r) => r.id.toLowerCase() === name.toLowerCase());
    if (!rt) throw new ScimError(404, 'Resource type not found', 'noTarget');
    return rt;
  }

  @Get('Schemas')
  @ScimJson()
  schemas(@Req() req: Request) {
    return this.list(schemas(this.baseUrl(req)));
  }

  @Get('Schemas/:uri')
  @ScimJson()
  schema(@Req() req: Request, @Param('uri') uri: string) {
    const s = schemas(this.baseUrl(req)).find((x) => x.id === uri);
    if (!s) throw new ScimError(404, 'Schema not found', 'noTarget');
    return s;
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  @Get('Users')
  @ScimJson()
  listUsers(@Req() req: Request, @Query() q: Record<string, string>) {
    return this.users.list(this.provider(req), parseFilter(q.filter), parsePagination(q), this.ctx(req));
  }

  @Get('Users/:id')
  @ScimJson()
  getUser(@Req() req: Request, @Param('id') id: string) {
    return this.users.get(this.provider(req), id, this.ctx(req));
  }

  @Post('Users')
  @HttpCode(HttpStatus.CREATED)
  @ScimJson()
  createUser(@Req() req: Request, @Body() body: unknown) {
    return this.users.create(this.provider(req), body, this.ctx(req));
  }

  @Put('Users/:id')
  @ScimJson()
  replaceUser(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.users.replace(this.provider(req), id, body, this.ctx(req));
  }

  @Patch('Users/:id')
  @ScimJson()
  patchUser(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.users.patch(this.provider(req), id, body, this.ctx(req));
  }

  @Delete('Users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.users.remove(this.provider(req), id, this.ctx(req));
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  @Get('Groups')
  @ScimJson()
  listGroups(@Req() req: Request, @Query() q: Record<string, string>) {
    return this.groups.list(this.provider(req), parseFilter(q.filter), parsePagination(q), parseExcluded(q), this.ctx(req));
  }

  @Get('Groups/:id')
  @ScimJson()
  getGroup(@Req() req: Request, @Param('id') id: string, @Query() q: Record<string, string>) {
    return this.groups.get(this.provider(req), id, parseExcluded(q), this.ctx(req));
  }

  @Post('Groups')
  @HttpCode(HttpStatus.CREATED)
  @ScimJson()
  createGroup(@Req() req: Request, @Body() body: unknown) {
    return this.groups.create(this.provider(req), body, this.ctx(req));
  }

  @Put('Groups/:id')
  @ScimJson()
  replaceGroup(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.groups.replace(this.provider(req), id, body, this.ctx(req));
  }

  @Patch('Groups/:id')
  @ScimJson()
  patchGroup(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.groups.patch(this.provider(req), id, body, this.ctx(req));
  }

  @Delete('Groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.groups.remove(this.provider(req), id, this.ctx(req));
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
}
