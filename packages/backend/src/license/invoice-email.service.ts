import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { LICENSE_API_URL, LicenseService, licenseServiceHeaders } from './license.service';

/**
 * Invoices by email (Cloud): a workspace admin has every paid invoice emailed
 * as a PDF, to the billing contact or to another address. The licence site
 * owns Stripe, stores the setting on the workspace's licence and sends the
 * emails (its lib/invoice-email.ts); this server only relays the admin's
 * choice, with its service token.
 *
 * Tenant isolation on this side: the workspace is the caller's own
 * (`organizationId` from the session, never from the request) and so is the
 * licence key, resolved here exactly as for the billing portal. The site
 * checks again that the key is bound to that workspace and answers 404
 * otherwise.
 */

export interface InvoiceEmailView {
  /** False when the workspace has no subscription to send invoices for. */
  available: boolean;
  enabled: boolean;
  /** The Stripe customer's email: where invoices go unless another address is set. */
  billingContact: string | null;
  recipient: { kind: 'billing' | 'custom'; address: string | null };
  /** The last invoice emailed; `to` is masked by the site. */
  lastSent: { number: string; at: string; to: string } | null;
}

/** A refusal with the HTTP status the controller should answer. */
export class InvoiceEmailError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 502,
    message: string,
  ) {
    super(message);
  }
}

const UNAVAILABLE: InvoiceEmailView = {
  available: false,
  enabled: false,
  billingContact: null,
  recipient: { kind: 'billing', address: null },
  lastSent: null,
};

/** The site's view, checked field by field: nothing else reaches the browser. */
export function parseInvoiceEmailView(data: unknown): InvoiceEmailView | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, any>;
  if (typeof d.available !== 'boolean' || typeof d.enabled !== 'boolean') return null;
  const str = (v: unknown, max = 254) => (typeof v === 'string' && v.length <= max ? v : null);
  const kind = d.recipient?.kind === 'custom' ? 'custom' : 'billing';
  const last = d.lastSent && typeof d.lastSent === 'object' ? d.lastSent : null;
  const lastSent =
    last && str(last.number, 64) && str(last.at, 64) && !Number.isNaN(Date.parse(last.at)) && str(last.to)
      ? { number: last.number as string, at: last.at as string, to: last.to as string }
      : null;
  return {
    available: d.available,
    enabled: d.enabled,
    billingContact: str(d.billingContact),
    recipient: { kind, address: str(d.recipient?.address) },
    lastSent,
  };
}

@Injectable()
export class InvoiceEmailService {
  private readonly logger = new Logger(InvoiceEmailService.name);
  private readonly apiBase = LICENSE_API_URL;

  constructor(
    private readonly licenses: LicenseService,
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {}

  /** The licence that carries the workspace's subscription, as for the billing portal. */
  private async licenseKeyOf(organizationId: string): Promise<string | null> {
    const current = await this.licenses.getCurrentLicense(organizationId);
    const license =
      current && current.plan !== 'trial'
        ? current
        : ((await this.licenses.getPaymentFailedLicense(organizationId)) ?? current);
    return license?.licenseKey ?? null;
  }

  private async call(body: Record<string, unknown>): Promise<InvoiceEmailView> {
    const headers = licenseServiceHeaders();
    if (!this.deployment.isCloud() || !headers['x-amcp-service-token']) {
      throw new InvoiceEmailError(502, 'Invoices by email are unavailable right now.');
    }
    try {
      const { data } = await axios.post(`${this.apiBase}/api/license/invoice-email`, body, { timeout: 15000, headers });
      const view = parseInvoiceEmailView(data);
      if (!view) throw new InvoiceEmailError(502, 'Invoices by email are unavailable right now.');
      return view;
    } catch (err: any) {
      if (err instanceof InvoiceEmailError) throw err;
      const status = err?.response?.status;
      this.logger.warn(`Invoice email settings (${body.action}) for workspace ${body.organizationId}: ${status ?? 'no response'}`);
      // The site's own wording stays on the site, except for a refused address.
      if (status === 400) throw new InvoiceEmailError(400, 'Invalid email address.');
      if (status === 404) throw new InvoiceEmailError(404, 'No subscription found for this workspace.');
      if (status === 409) throw new InvoiceEmailError(409, 'This workspace has no subscription to send invoices for.');
      if (status === 429) throw new InvoiceEmailError(429, 'Too many changes. Try again in a minute.');
      throw new InvoiceEmailError(502, 'Invoices by email are unavailable right now.');
    }
  }

  async get(organizationId: string): Promise<InvoiceEmailView> {
    const licenseKey = await this.licenseKeyOf(organizationId);
    if (!licenseKey) return UNAVAILABLE;
    return this.call({ action: 'get', licenseKey, organizationId });
  }

  /**
   * `to`: undefined keeps the current address, null (or '') goes back to the
   * billing contact, a string sets that address.
   */
  async set(
    organizationId: string,
    userId: string,
    change: { enabled: boolean; to?: string | null },
  ): Promise<InvoiceEmailView> {
    const licenseKey = await this.licenseKeyOf(organizationId);
    if (!licenseKey) throw new InvoiceEmailError(409, 'This workspace has no subscription to send invoices for.');
    const [org, actor] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    return this.call({
      action: 'set',
      licenseKey,
      organizationId,
      enabled: change.enabled,
      ...(change.to !== undefined && { to: change.to === '' ? null : change.to }),
      ...(org?.name && { workspaceName: org.name }),
      ...(actor?.email && { actorEmail: actor.email }),
    });
  }
}
