import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { PrismaService } from '../common/prisma.service';

@Controller('auth')
export class LoginController {
  private readonly logger = new Logger(LoginController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Get('login')
  async showLoginPage(
    @Query('session') session: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const serverName =
      this.configService.get<string>('MCP_SERVER_NAME') || 'AnythingToMCP';

    res.setHeader('Content-Type', 'text/html');
    res.send(this.renderLoginPage(session, error, serverName));
  }

  @Post('login')
  async handleLogin(
    @Req() req: Request,
    @Body() body: { email: string; password: string; session: string },
    @Res() res: Response,
  ) {
    const { email, password, session } = body;

    if (!email || !password) {
      return res.redirect(
        `/auth/login?session=${encodeURIComponent(session || '')}&error=${encodeURIComponent('Email and password are required')}`,
      );
    }

    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      this.logger.warn(`Login attempt for non-existent user: ${email}`);
      return res.redirect(
        `/auth/login?session=${encodeURIComponent(session || '')}&error=${encodeURIComponent('Invalid email or password')}`,
      );
    }

    // Verify password
    const passwordValid = await this.authService.comparePassword(
      password,
      user.passwordHash,
    );

    if (!passwordValid) {
      this.logger.warn(`Failed login attempt for user: ${email}`);
      return res.redirect(
        `/auth/login?session=${encodeURIComponent(session || '')}&error=${encodeURIComponent('Invalid email or password')}`,
      );
    }

    this.logger.log(`Successful login for user: ${email}`);

    // Set a short-lived cookie with the user profile for the callback to read
    const profile = {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.email,
    };

    const encoded = Buffer.from(JSON.stringify(profile)).toString('base64url');

    // Detect if behind HTTPS proxy (ngrok, etc.)
    const isSecure =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      this.configService.get<string>('NODE_ENV') === 'production';

    res.cookie('login_user', encoded, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 60 * 1000, // 1 minute — just enough for the redirect
      sameSite: isSecure ? 'none' : 'lax',
    });

    // Derive callback URL from the request origin (works behind proxy/tunnel)
    const baseUrl = this.getBaseUrl(req);
    res.redirect(`${baseUrl}/callback`);
  }

  private getBaseUrl(req: Request): string {
    const proto =
      (req.headers['x-forwarded-proto'] as string) ||
      (req.secure ? 'https' : 'http');
    const host =
      (req.headers['x-forwarded-host'] as string) || req.headers.host;
    if (host) {
      return `${proto}://${host}`;
    }
    return (
      this.configService.get<string>('SERVER_URL') || 'http://localhost:4000'
    );
  }

  private renderLoginPage(
    session: string,
    error: string | undefined,
    serverName: string,
  ): string {
    const errorHtml = error
      ? `<div class="error">${this.escapeHtml(error)}</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — ${this.escapeHtml(serverName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #333;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 8px;
      text-align: center;
    }
    .subtitle {
      color: #666;
      text-align: center;
      margin-bottom: 24px;
      font-size: 0.9rem;
    }
    .error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      font-size: 0.875rem;
    }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 6px;
      color: #555;
    }
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }
    button {
      width: 100%;
      padding: 12px;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #1d4ed8; }
    button:active { background: #1e40af; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign In</h1>
    <p class="subtitle">Authorize access to ${this.escapeHtml(serverName)} MCP Server</p>
    ${errorHtml}
    <form method="POST" action="/auth/login">
      <input type="hidden" name="session" value="${this.escapeHtml(session || '')}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autofocus placeholder="you@example.com">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="Your password">
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
}
