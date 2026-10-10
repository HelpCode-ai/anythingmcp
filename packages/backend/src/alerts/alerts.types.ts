export type AlertWebhookType = 'json' | 'slack';

/** Stored at OrgSettings key `alert_webhook`. `secretEnc` is never sent to a client. */
export interface AlertWebhookConfig {
  url: string;
  type: AlertWebhookType;
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  secretEnc: string;
}

/** `GET`/`PUT` response shape: everything except the secret. */
export type AlertWebhookPublicConfig = Omit<AlertWebhookConfig, 'secretEnc'>;

export const DEFAULT_THRESHOLD = 5;
export const DEFAULT_WINDOW_MINUTES = 10;
export const DEFAULT_COOLDOWN_MINUTES = 30;

export const ALERT_WEBHOOK_SETTINGS_KEY = 'alert_webhook';
