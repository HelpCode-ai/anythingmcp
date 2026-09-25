import { Controller, HttpCode, NotFoundException, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { McpServerService } from './mcp-server.service';

/**
 * `POST /internal/registry/catch-up` — reload, from the database, every
 * connector whose tools this process may hold out of date. See
 * {@link McpServerService.catchUpRegistry} for why that can happen.
 *
 * Callable from inside the container only:
 *
 *   docker exec amcp-cloud-backend \
 *     wget -qO- --post-data= http://127.0.0.1:4000/internal/registry/catch-up
 *
 * deploy/cloud/release.sh does exactly that once the previous backend has
 * stopped. Anyone else gets a 404, decided on the socket's own peer address:
 * `req.ip` would honour X-Forwarded-For (trust proxy is on), and Caddy's
 * connections come from the proxy's container address, never from loopback.
 * Caddy does not route /internal to the backend in the first place; this
 * check is what holds if that ever changes.
 */
@ApiExcludeController()
@Controller('internal/registry')
export class RegistryCatchUpController {
  constructor(private readonly mcpServer: McpServerService) {}

  @Post('catch-up')
  @HttpCode(200)
  async catchUp(@Req() req: Request) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      throw new NotFoundException();
    }
    return this.mcpServer.catchUpRegistry();
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}
