import { Logger } from '@nestjs/common';
import axios from 'axios';
import { LICENSE_API_URL, licenseServiceHeaders } from '../license/license.service';

/** Attempts per report before giving up until a later call (or a restart). */
export const REPORT_ATTEMPTS = 3;
/** Read at call time so a test can shrink the wait; doubles per attempt. */
const retryBaseMs = () => Number(process.env.ADS_ACTIVATION_RETRY_BASE_MS ?? 1000);

/**
 * POST one ad conversion report to the licence site, which queues it for the
 * ad platforms (lib/google-ads-upload.ts, lib/openai-ads-upload.ts there).
 *
 * Returns the site's HTTP status once it answered for good (2xx, or a 4xx it
 * will not change its mind about), or null when every attempt failed: 401,
 * 429, 5xx and network errors are retried with backoff. Logs `what` and
 * `subject` only, never the body (it carries an email and a click id).
 */
export async function postAdReport(
  logger: Logger,
  path: string,
  body: Record<string, unknown>,
  what: string,
  subject: string,
): Promise<number | null> {
  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(`${LICENSE_API_URL}${path}`, body, {
        timeout: 10000,
        headers: licenseServiceHeaders(),
      });
      logger.log(`Reported the ${what} of ${subject} (${res.status}).`);
      return res.status;
    } catch (err: any) {
      const status: number | undefined = err?.response?.status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 429) {
        logger.warn(`Licence site refused the ${what} of ${subject} (${status}).`);
        return status;
      }
      logger.warn(
        `Reporting the ${what} of ${subject} failed ` +
          `(${status ?? err?.code ?? 'no response'}), attempt ${attempt}/${REPORT_ATTEMPTS}.`,
      );
      if (attempt < REPORT_ATTEMPTS) await sleep(retryBaseMs() * 2 ** (attempt - 1));
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
