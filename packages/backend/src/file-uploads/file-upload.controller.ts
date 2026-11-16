import { Controller, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { FileUploadService } from './file-upload.service';

/**
 * Agent file uploads. Both routes are public on purpose: the upload token
 * (192 bits, stored hashed, one use, 15 minutes) and the signed download URL
 * (HMAC, one hour) are the credentials. An AI client's code sandbox has no
 * AnythingMCP session to send.
 */
@ApiTags('File uploads')
@Controller('api/uploads')
export class FileUploadController {
  constructor(private readonly uploads: FileUploadService) {}

  @Get('u/:token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'State of a one-time upload link: file name, size limit, waiting or uploaded (public)' })
  status(@Param('token') token: string) {
    return this.uploads.linkStatus(token);
  }

  @Put('u/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Upload a file through a one-time link from file_upload_link (public)' })
  put(@Param('token') token: string, @Req() req: Request) {
    return this.receive(token, req);
  }

  @Post('u/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Same as PUT, for clients that can only POST a raw body (public)' })
  post(@Param('token') token: string, @Req() req: Request) {
    return this.receive(token, req);
  }

  private receive(token: string, req: Request) {
    // A slow or stalled client must not hold an upload slot for long.
    req.setTimeout?.(120_000);
    const raw = req.headers['content-length'];
    const length = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    return this.uploads.receive(token, req, length);
  }

  @Get('f/:signed/:name')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Download an uploaded media file through its signed public URL (public)' })
  async download(@Param('signed') signed: string, @Req() req: Request, @Res() res: Response) {
    const file = await this.uploads.openPublic(signed);
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    // Only images, videos and PDFs whose bytes match get here (publicAllowed),
    // so the real type is sent: providers need it to accept an image.
    res.setHeader('Content-Type', file.mimeType);
    if (file.bytes) res.setHeader('Content-Length', String(file.bytes));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    file.stream.on('error', () => res.destroy());
    res.on('close', () => file.stream.destroy());
    file.stream.pipe(res);
  }
}
