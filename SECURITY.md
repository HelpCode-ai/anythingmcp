# Security Policy

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in AnythingMCP, please report it responsibly:

1. **Email**: Send details to [security@helpcode.ai](mailto:security@helpcode.ai)
2. **Subject**: Include "AnythingMCP Security" in the subject line
3. **Details**: Provide as much information as possible:
   - Type of vulnerability (e.g., SQL injection, XSS, authentication bypass)
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

| Action | Timeline |
|--------|----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix development | Depends on severity |
| Public disclosure | After fix is released |

## Scope

The following are in scope for security reports:

- **Authentication & authorization** — JWT, OAuth2, API key handling, session management
- **Credential storage** — Encryption of stored API keys, database passwords, OAuth tokens
- **Input validation** — SQL injection, XSS, command injection in connector engines
- **MCP protocol** — Tool invocation security, parameter injection
- **Data exposure** — Unintended disclosure of credentials, tokens, or sensitive configuration

## Out of Scope

- Vulnerabilities in third-party dependencies (report to the upstream project)
- Denial of service attacks
- Social engineering
- Issues in environments running outdated or unsupported versions

## Security Best Practices for Deployers

AnythingMCP handles sensitive data (API keys, database credentials, OAuth tokens). We recommend:

- **Always use HTTPS** in production (Caddy with automatic SSL is included)
- **Use strong secrets** — The `setup.sh` script auto-generates cryptographically secure values
- **Restrict network access** — Use `APP_BIND_IP=127.0.0.1` behind a reverse proxy
- **Enable Redis** — Required for rate limiting (`MCP_RATE_LIMIT_PER_MINUTE`)
- **Review audit logs** — All tool invocations are logged with input/output
- **Use OAuth2 mode** — Preferred over legacy bearer tokens for MCP auth
- **Rotate credentials regularly** — API keys, JWT secrets, encryption keys

## Rotating secrets

### `JWT_SECRET` and `COOKIE_SECRET`

Update the value in `.env` and restart: `docker compose up -d`. Existing sessions invalidate immediately — no re-encryption needed.

### `ENCRYPTION_KEY` (AES-256-GCM, stored credentials)

`ENCRYPTION_KEY` encrypts connector credentials (API keys, OAuth tokens, database passwords) at rest. Rotating it requires re-encrypting every stored secret, because the existing ciphertext was sealed with the old key.

Until a built-in rotation command ships (tracked in [ROADMAP.md](ROADMAP.md)), the safe procedure is:

1. **Take a database backup** — `docker compose exec postgres pg_dump -U amcp anythingmcp > backup-pre-rotation.sql`.
2. **Export connector configs** — from the Admin UI, export each connector to JSON (this captures the *decrypted* credentials in transit; keep the export file in a secure location and delete it after step 5).
3. **Generate a new key** — `openssl rand -base64 32 | head -c 32` (must be exactly 32 ASCII chars).
4. **Replace `ENCRYPTION_KEY` in `.env`, wipe the encrypted columns, and restart** — the simplest path is to drop and re-create the database from backup *without* the connector secrets, then restart the app with the new key.
5. **Re-import each connector** from the JSON exports. New ciphertext is sealed with the new key.

If your installation has many connectors, prefer waiting for the upcoming rotation CLI (or write your own script against `packages/backend/src/common/crypto/encryption.util.ts`). Do **not** simply swap the key in `.env` without re-encrypting — existing credentials will become unreadable and every connector will fail with a decryption error.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | Best effort |

## Acknowledgments

We appreciate the security research community. Reporters of valid vulnerabilities will be credited in release notes (unless they prefer to remain anonymous).
