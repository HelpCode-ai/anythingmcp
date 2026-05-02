import { Logger } from '@nestjs/common';

const logger = new Logger('Secrets');

const MIN_SECRET_LENGTH = 32;

/**
 * Returns a required secret from the environment.
 * Throws on startup if the value is missing or shorter than the minimum length.
 *
 * Never falls back to a hardcoded default: a known default key on a
 * source-available product is equivalent to having no encryption at all.
 */
export function getRequiredSecret(
  name: string,
  value: string | undefined,
  minLength: number = MIN_SECRET_LENGTH,
): string {
  if (!value || value.length === 0) {
    throw new Error(
      `[secrets] ${name} is not set. Generate one with: openssl rand -base64 48`,
    );
  }
  if (value.length < minLength) {
    throw new Error(
      `[secrets] ${name} is too short (${value.length} chars, minimum ${minLength}). Regenerate with: openssl rand -base64 48`,
    );
  }
  if (looksLikeDefaultSecret(value)) {
    throw new Error(
      `[secrets] ${name} appears to be a placeholder/default value. Generate a real secret with: openssl rand -base64 48`,
    );
  }
  return value;
}

/**
 * Validate all required secrets eagerly at boot. Call from main.ts before
 * any code that uses them runs.
 */
export function validateRequiredSecretsAtStartup(env: NodeJS.ProcessEnv): void {
  // These are required for any deployment — no graceful degradation.
  getRequiredSecret('JWT_SECRET', env.JWT_SECRET);
  getRequiredSecret('ENCRYPTION_KEY', env.ENCRYPTION_KEY);
  logger.log('Secrets validated (JWT_SECRET, ENCRYPTION_KEY).');
}

const KNOWN_PLACEHOLDERS = [
  'default-dev-secret-change-me',
  'default-dev-key-change-in-prod!!',
  'dev-secret-change-me-at-least-32chars!!',
  'change-me-in-production-min-32-chars',
  'change-me-in-production-exactly-32',
];

function looksLikeDefaultSecret(value: string): boolean {
  if (KNOWN_PLACEHOLDERS.includes(value)) return true;
  const lower = value.toLowerCase();
  return (
    lower.includes('change-me') ||
    lower.includes('changeme') ||
    lower.includes('default-dev') ||
    lower.includes('placeholder') ||
    lower.includes('your-secret') ||
    lower.includes('your-encryption-key')
  );
}
