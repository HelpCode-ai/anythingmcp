import {
  CLAUDE_DIRECTORY_URL,
  EmailBrandContext,
  button,
  code,
  codeBox,
  esc,
  h1,
  link,
  p,
  renderEmail,
  renderEmailText,
  small,
  steps,
  usageBox,
} from './email-layout';
import { withEmailLinkToken } from '../common/email-link-token';
import { type PricingLinkSource, withSourceParam } from '../license/license-checkout';

/**
 * Every email the backend sends, as pure functions of their inputs: no
 * transport, no database. EmailService sends them; the preview script and the
 * tests render them with sample data. Any value a user, an admin or an operator
 * chose is escaped before it reaches the HTML.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Marketing or lifecycle nudge: carries an unsubscribe line and List-Unsubscribe. */
  marketing: boolean;
}

/** For marketing emails: where "Unsubscribe" leads. */
export interface MarketingContext extends EmailBrandContext {
  unsubscribeUrl: string;
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/**
 * A dashboard page an email links to. Someone who signs in with Google,
 * Microsoft or GitHub has no password: a plain link opens the sign-in form
 * wherever the dashboard has no session (a phone's mail app, a new browser),
 * and most stop there. With `signInWith`, the link goes through
 * `/login?continueWith=<provider>`, which goes straight on with a session and
 * otherwise signs in with that provider on its own (the consent page's links
 * do the same, login.controller.ts).
 */
export function cloudPageUrl(cloudUrl: string, path: string, signInWith?: string | null): string {
  if (!signInWith) return `${cloudUrl}${path}`;
  return `${cloudUrl}/login?continueWith=${encodeURIComponent(signInWith)}&redirect=${encodeURIComponent(path)}`;
}

const greeting = (name: string | null | undefined) => (name && name.trim() ? `Hi ${name.trim()},` : 'Hi there,');
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function build(opts: {
  subject: string;
  preheader: string;
  bodyHtml: string;
  bodyText: string;
  ctx: EmailBrandContext;
  unsubscribeUrl?: string;
}): RenderedEmail {
  const marketing = opts.unsubscribeUrl ? { unsubscribeUrl: opts.unsubscribeUrl } : false;
  return {
    subject: opts.subject,
    html: renderEmail({
      preheader: opts.preheader,
      title: opts.subject,
      bodyHtml: opts.bodyHtml,
      marketing,
      ctx: opts.ctx,
    }),
    text: renderEmailText({ bodyText: opts.bodyText, marketing, ctx: opts.ctx }),
    marketing: !!marketing,
  };
}

// ── Transactional ───────────────────────────────────────────────────────────

export function verificationEmail(
  input: { code: string; verifyUrl: string },
  ctx: EmailBrandContext,
): RenderedEmail {
  return build({
    // Code first: it is what the inbox preview shows, and what iOS reads to
    // offer it above the keyboard (autocomplete one-time-code).
    subject: `${input.code} is your AnythingMCP verification code`,
    preheader: 'Your code is valid for 15 minutes.',
    bodyHtml:
      h1('Confirm your email,', 'and you are in.') +
      p('Enter this code in the AnythingMCP window you just left. It is valid for 15 minutes.') +
      // The code exactly as it is typed: no space between the two halves. The
      // box's letter-spacing already spaces the digits out to read, while a
      // real space was copied along with them, so a pasted "504 452" no
      // longer fitted the six-character field (October 2026).
      codeBox(input.code) +
      p('Or confirm with one click:', { size: 15, muted: true, mb: 4 }) +
      button(input.verifyUrl, 'Verify my email') +
      small("Didn't sign up? You can ignore this email; the address stays unverified without the code."),
    bodyText:
      `Confirm your email, and you are in.\n\n` +
      `Your verification code: ${input.code}\n` +
      `It is valid for 15 minutes.\n\n` +
      `Or confirm with one click: ${input.verifyUrl}\n\n` +
      `Didn't sign up? You can ignore this email; the address stays unverified without the code.`,
    ctx,
  });
}

export function passwordResetEmail(input: { resetUrl: string }, ctx: EmailBrandContext): RenderedEmail {
  return build({
    subject: 'Reset your AnythingMCP password',
    preheader: 'The link works for 1 hour.',
    bodyHtml:
      h1('Forgot your password?', 'Set a new one.') +
      p('Someone, most likely you, asked to reset the password of your AnythingMCP account. Use the button below to choose a new one. The link works for 1 hour.') +
      button(input.resetUrl, 'Set a new password') +
      small("Didn't ask for this? You can ignore this email; your password stays as it is."),
    bodyText:
      `Forgot your password? Set a new one.\n\n` +
      `Someone, most likely you, asked to reset the password of your AnythingMCP account. Choose a new one here (the link works for 1 hour):\n${input.resetUrl}\n\n` +
      `Didn't ask for this? You can ignore this email; your password stays as it is.`,
    ctx,
  });
}

export function invitationEmail(
  input: { inviteUrl: string; invitedByName: string; roleName: string },
  ctx: EmailBrandContext,
): RenderedEmail {
  const inviter = input.invitedByName?.trim() || 'A colleague';
  return build({
    subject: "You've been invited to AnythingMCP",
    preheader: `${inviter} invited you to their workspace. The invitation expires in 48 hours.`,
    bodyHtml:
      h1("You're invited.", 'Join your team on AnythingMCP.') +
      p(
        `<strong style="font-weight:600;">${esc(inviter)}</strong> invited you to their AnythingMCP workspace as <strong style="font-weight:600;">${esc(input.roleName)}</strong>. ` +
          'Create your account with the button below; the invitation expires in 48 hours.',
      ) +
      p('AnythingMCP connects AI assistants such as Claude, ChatGPT and Copilot to the software your company runs, with roles and a full audit log.', {
        size: 15,
        muted: true,
      }) +
      button(input.inviteUrl, 'Accept invitation') +
      small("Weren't expecting this? You can ignore this email; nothing happens without you."),
    bodyText:
      `You're invited. Join your team on AnythingMCP.\n\n` +
      `${inviter} invited you to their AnythingMCP workspace as ${input.roleName}.\n\n` +
      `Accept the invitation: ${input.inviteUrl}\n` +
      `It expires in 48 hours.\n\n` +
      `Weren't expecting this? You can ignore this email; nothing happens without you.`,
    ctx,
  });
}

/**
 * A connector stopped working because the provider refused its credential for
 * good (a refresh token refused, a Meta session logged out). Sent once to the
 * workspace owner; calls fail fast until the credential is replaced, so
 * nothing else would tell them. Transactional: no unsubscribe line.
 */
export function connectorAuthEmail(
  input: { name: string | null; connectorName: string; message: string; connectorUrl: string },
  ctx: EmailBrandContext,
): RenderedEmail {
  const hi = greeting(input.name);
  const connector = input.connectorName.trim() || 'A connector';
  return build({
    subject: `${connector} needs a new sign-in`,
    preheader: 'Your AI client cannot use it until you authorize it again.',
    bodyHtml:
      h1('A connector needs a new sign-in.', 'Your AI client cannot use it until then.') +
      p(
        `${esc(hi)} the provider behind <strong style="font-weight:600;">${esc(connector)}</strong> refused its credential, ` +
          'so AnythingMCP stopped retrying and every tool call now answers with what to do instead.',
      ) +
      p(esc(input.message)) +
      button(input.connectorUrl, 'Open the connector') +
      small('This is the only email about it. Once you sign in again, the connector works as before.'),
    bodyText:
      `${hi}\n\nThe provider behind "${connector}" refused its credential, so AnythingMCP stopped retrying and every tool call now answers with what to do instead.\n\n` +
      `${input.message}\n\n` +
      `Open the connector: ${input.connectorUrl}\n\n` +
      'This is the only email about it. Once you sign in again, the connector works as before.',
    ctx,
  });
}

/**
 * The provider approved the app the user created for a connector (Etsy: an
 * app leaves Pending), so the sign-in that was refused works now. Sent once
 * per connector (AppApprovalWatcherService). Transactional: the user asked to
 * connect the app and is waiting for this.
 */
export function appApprovedEmail(
  input: {
    name: string | null;
    /** The provider, e.g. "Etsy". */
    providerName: string;
    connectorUrl: string;
    /** A first request to try once signed in, and its claude.ai link. */
    prompt: string;
    promptUrl: string;
  },
  ctx: EmailBrandContext,
): RenderedEmail {
  const hi = greeting(input.name);
  const provider = input.providerName.trim() || 'The provider';
  return build({
    subject: `${provider} approved your app`,
    preheader: `Finish the ${provider} sign-in to connect it to your AI client.`,
    bodyHtml:
      h1(`${esc(provider)} approved your app.`, 'One step is left: the sign-in.') +
      p(
        `${esc(hi)} ${esc(provider)} now accepts the app keys you entered in AnythingMCP. ` +
          `Sign in to ${esc(provider)} from the connector page and approve the access; it takes a minute.`,
      ) +
      button(input.connectorUrl, `Finish the ${provider} sign-in`) +
      p(`Then ask Claude: ${link(input.promptUrl, `&ldquo;${esc(input.prompt)}&rdquo;`)}`) +
      small(`This is the only email about it. We checked your app keys with ${esc(provider)} until it approved them.`),
    bodyText:
      `${hi}\n\n${provider} now accepts the app keys you entered in AnythingMCP. ` +
      `Sign in to ${provider} from the connector page and approve the access; it takes a minute.\n\n` +
      `Finish the ${provider} sign-in: ${input.connectorUrl}\n\n` +
      `Then ask Claude: "${input.prompt}" ${input.promptUrl}\n\n` +
      `This is the only email about it. We checked your app keys with ${provider} until it approved them.`,
    ctx,
  });
}

export function licenseKeyEmail(
  input: { name: string; licenseKey: string },
  ctx: EmailBrandContext,
): RenderedEmail {
  const guide = 'https://anythingmcp.com/docs/getting-started';
  return build({
    subject: 'Your AnythingMCP license key',
    preheader: 'Keep it safe: you need it to activate your instance.',
    bodyHtml:
      h1('Welcome to AnythingMCP.', 'Here is your license key.') +
      p(`${esc(greeting(input.name))} this is the key for your AnythingMCP instance:`) +
      codeBox(input.licenseKey, { size: 18, spacing: 2 }) +
      p('Keep it safe: you need it to activate your instance under Settings &rarr; License.') +
      button(guide, 'Open the getting-started guide') +
      small('Questions about your license? Just reply to this email.'),
    bodyText:
      `Welcome to AnythingMCP. Here is your license key.\n\n` +
      `${greeting(input.name)}\n\nYour license key: ${input.licenseKey}\n\n` +
      `Keep it safe: you need it to activate your instance under Settings > License.\n\n` +
      `Getting started: ${guide}`,
    ctx,
  });
}

export function existingAccountEmail(
  input: { loginUrl: string; resetUrl: string },
  ctx: EmailBrandContext,
): RenderedEmail {
  return build({
    subject: 'You already have an AnythingMCP account',
    preheader: 'No new account was created. Sign in to the one you have.',
    bodyHtml:
      h1('You already have an account,', 'so nothing new was created.') +
      p('Someone, probably you, just tried to create a new AnythingMCP account with this email address. There already is one, so no new account was created.') +
      button(input.loginUrl, 'Sign in') +
      p(`Forgot your password? ${link(input.resetUrl, 'Reset it here')}.`, { size: 15 }) +
      small("If this wasn't you, you can ignore this email; nothing has changed on your account."),
    bodyText:
      `You already have an account, so nothing new was created.\n\n` +
      `Someone, probably you, just tried to create a new AnythingMCP account with this email address. There already is one, so no new account was created.\n\n` +
      `Sign in: ${input.loginUrl}\nForgot your password? ${input.resetUrl}\n\n` +
      `If this wasn't you, you can ignore this email; nothing has changed on your account.`,
    ctx,
  });
}

// ── Cloud lifecycle ─────────────────────────────────────────────────────────

export function onboardingReminderEmail(
  input: {
    name: string;
    dayNumber: 1 | 2;
    aiClient?: string;
    cloudUrl: string;
    /** The recipient's sign-in provider, if any (see cloudPageUrl). */
    signInWith?: string | null;
    /**
     * Reminder 1 without an AI client only: one-click Claude chats that
     * replace the how-to (the cron's variant B, ee/cloud/onboarding-reminder.ts).
     */
    quickSetups?: ReadonlyArray<{ label: string; url: string }>;
  },
  ctx: MarketingContext,
): RenderedEmail {
  const { cloudUrl } = input;
  const welcomeUrl = cloudPageUrl(cloudUrl, '/welcome', input.signInWith);
  const storeUrl = cloudPageUrl(cloudUrl, '/connectors/store', input.signInWith);
  const mcpUrl = `${cloudUrl}/mcp`;
  const hi = esc(greeting(input.name));
  const examples = '<em>&ldquo;Connect my Shopify store&rdquo;</em> or <em>&ldquo;Add HubSpot&rdquo;</em>';

  if (input.aiClient) {
    const client = esc(input.aiClient);
    return build({
      subject: `${input.aiClient} is connected. Now ask it for your first app`,
      preheader: `Ask ${input.aiClient} in the chat and it sets up the app with you.`,
      bodyHtml:
        h1(`${client} is connected.`, 'Now give it an app to use.') +
        p(`${hi} you connected ${client} to AnythingMCP, but your workspace has no apps yet, so ${client} has nothing to reach.`) +
        p(
          `<strong style="font-weight:600;">Ask ${client} for one, in the chat:</strong> ${examples}. It finds the connector, installs it in your workspace and gives you a one-time link where you sign in to the app. No API keys pasted into the chat.`,
        ) +
        p(`This works when ${client} is connected through ${code(mcpUrl)}, which is what Claude's connector directory uses.`, { size: 14, muted: true }) +
        p('Prefer clicking? Etsy, Odoo, weclapp, Lexware, Shopify and 200+ more are in the dashboard.') +
        button(storeUrl, 'Add your first app') +
        small('Stuck, or the app you need is missing? Reply and tell us which one.'),
      bodyText:
        `${greeting(input.name)}\n\n` +
        `You connected ${input.aiClient} to AnythingMCP, but your workspace has no apps yet. Ask ${input.aiClient} in the chat, e.g. "Connect my Shopify store": it installs the connector and gives you a one-time link to sign in to the app. No API keys pasted into the chat.\n\n` +
        `This works when ${input.aiClient} is connected through ${mcpUrl}.\n\n` +
        `Or add one in the dashboard: ${storeUrl}`,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }

  if (input.dayNumber === 1 && input.quickSetups?.length) {
    const quick = input.quickSetups;
    return build({
      subject: 'Connect your first app in one click: AnythingMCP',
      preheader: 'Pick one: Claude opens with the request typed in.',
      bodyHtml:
        h1('Your workspace is ready.', 'Connect your first app in one click.') +
        p(`${hi} your AnythingMCP workspace has no apps yet. Pick one below: Claude opens a new chat with the request typed in, sets up the connector with you and gives you a one-time link to sign in. No API keys pasted into the chat.`) +
        steps(
          quick.map((q) => ({
            title: link(q.url, `Connect ${esc(q.label)}`),
            detail: 'A token or key you create yourself, no app review: ready in a few minutes.',
          })),
        ) +
        p(
          `AnythingMCP not in Claude yet? Add it from ${link(CLAUDE_DIRECTORY_URL, 'Claude&rsquo;s connector directory')} first, one click.`,
          { size: 14, muted: true },
        ) +
        button(welcomeUrl, 'Or pick an app in the dashboard') +
        small('Stuck, or the app you need is missing? Reply and tell us which one.'),
      bodyText:
        `${greeting(input.name)}\n\n` +
        `Your AnythingMCP workspace is ready but has no apps yet. Pick one: Claude opens a new chat with the request typed in and sets up the connector with you.\n\n` +
        quick.map((q) => `Connect ${q.label}: ${q.url}`).join('\n') +
        `\n\nAnythingMCP not in Claude yet? Add it from Claude's connector directory first: ${CLAUDE_DIRECTORY_URL}\n\n` +
        `Or pick an app in the dashboard: ${welcomeUrl}\n\n` +
        `Stuck, or the app you need is missing? Reply and tell us which one.`,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }

  if (input.dayNumber === 1) {
    return build({
      subject: 'Connect your first app in two minutes: AnythingMCP',
      preheader: 'Your workspace is ready. Add an app from the chat or the dashboard.',
      bodyHtml:
        h1('Your workspace is ready.', 'Let&rsquo;s connect your first app.') +
        p(`${hi} your AnythingMCP workspace has no apps yet. In the next two minutes your AI assistant can read and act on the tools your company already runs: no code, no MCP server to build.`) +
        steps([
          {
            title: 'Add AnythingMCP to your AI',
            detail: `Claude, ChatGPT, Copilot, Cursor or Meta Muse: add ${code(mcpUrl)} and sign in once.`,
          },
          {
            title: 'Ask for an app in plain language',
            detail: `${examples}. The assistant installs the connector and gives you a one-time link to sign in to the app. No API keys pasted into the chat.`,
          },
          {
            title: 'Or pick one in the dashboard',
            detail: '200+ ready-made connectors: Etsy, Odoo, weclapp, Lexware, Sendcloud, GitHub&hellip;',
          },
        ]) +
        button(welcomeUrl, 'Open the welcome wizard') +
        small(
          `Fastest with Claude: AnythingMCP is in ${link(CLAUDE_DIRECTORY_URL, 'Claude&rsquo;s connector directory')}, one click and you&rsquo;re connected. Stuck, or the app you need is missing? Reply and tell us which one.`,
        ),
      bodyText:
        `${greeting(input.name)}\n\n` +
        `Your AnythingMCP workspace is ready but has no apps yet. Two ways to add one:\n\n` +
        `1. From the chat: add AnythingMCP to Claude (connector directory: ${CLAUDE_DIRECTORY_URL}), ChatGPT, Copilot, Cursor or Meta Muse with ${mcpUrl}, then ask "Connect my Shopify store". The assistant installs the connector and gives you a one-time link to sign in to the app.\n` +
        `2. From the dashboard: pick one of 200+ ready-made connectors.\n\n` +
        `Open the welcome wizard: ${welcomeUrl}\n\n` +
        `Stuck, or the app you need is missing? Reply and tell us which one.`,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }

  return build({
    subject: 'Still here? Pick a tool to try — AnythingMCP',
    preheader: 'Your workspace is still waiting for its first connector.',
    bodyHtml:
      h1('Still here?', 'Pick one app to try.') +
      p(`${hi} your AnythingMCP account is still waiting for its first connector. If anything got in your way, hit reply and tell us what; we read every reply.`) +
      p(`The quickest way: ask your AI assistant ${examples} once AnythingMCP is connected through ${code(mcpUrl)}.`, { size: 15 }) +
      button(welcomeUrl, 'Pick a connector') +
      small('Not the right time? You can unsubscribe from these tips below.'),
    bodyText:
      `${greeting(input.name)}\n\n` +
      `Your AnythingMCP account is still waiting for its first connector. If anything got in your way, reply and tell us what; we read every reply.\n\n` +
      `Pick a connector: ${welcomeUrl}`,
    ctx,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });
}

/**
 * Trial lifecycle. Sent whatever the marketing opt-out says (it is about the
 * workspace's access ending), so it has no unsubscribe line.
 */
export function trialLifecycleEmail(
  input: {
    name: string;
    stage: 'warn3' | 'warn1' | 'expired';
    recap: { connectors: number; successfulCalls: number; daysLeft: number };
    cloudUrl: string;
    marketingUrl: string;
    /**
     * The recipient's address token (common/email-link-token.ts), so the
     * pricing page knows who buys and refuses a second subscription.
     */
    emailToken?: string | null;
  },
  ctx: EmailBrandContext,
): RenderedEmail {
  const { stage, recap, cloudUrl } = input;
  // `source` reaches the checkout's Stripe metadata (checkout_source), so a
  // purchase from this email can be told apart from the pricing page's own.
  const pricingUrl = withEmailLinkToken(
    withSourceParam(
      `${input.marketingUrl}/pricing?return_url=${encodeURIComponent(`${cloudUrl}/settings/license/activate`)}`,
      `email_trial_${stage}`,
    ),
    input.emailToken,
  );
  const licenseUrl = `${cloudUrl}/settings/license`;
  const hi = greeting(input.name);
  const days = Math.max(0, Math.round(recap.daysLeft));
  const used = recap.connectors > 0 || recap.successfulCalls > 0;

  const subject =
    stage === 'expired'
      ? 'Your AnythingMCP trial has ended — your work is saved'
      : stage === 'warn1'
        ? 'Last day of your AnythingMCP trial'
        : `Your AnythingMCP trial ends in ${days} ${plural(days, 'day')}`;

  const heading =
    stage === 'expired'
      ? h1('Your trial has ended.', 'Your work is saved.')
      : stage === 'warn1'
        ? h1('Last day of your trial.', 'Keep your AI connected.')
        : h1(`${days} ${plural(days, 'day')} left.`, 'Keep what you built.');

  const usageIntro = used
    ? p(`${esc(hi)} here is what your AI did with AnythingMCP during the trial:`) +
      usageBox([
        { value: recap.connectors.toLocaleString('en-US'), label: `${plural(recap.connectors, 'connector')} set up` },
        { value: recap.successfulCalls.toLocaleString('en-US'), label: `successful tool ${plural(recap.successfulCalls, 'call')}` },
      ])
    : p(`${esc(hi)} your workspace has no connected apps yet. Setting one up takes two minutes, from the chat or the dashboard.`);

  const outcome =
    stage === 'expired'
      ? 'Nothing was deleted: your connectors, MCP servers and configuration are preserved. Choose a plan to pick up exactly where you left off.'
      : stage === 'warn1'
        ? 'Your trial ends tomorrow. When it does, your connectors stop answering, but nothing is deleted. Choose a plan and they keep working without interruption.'
        : 'When the trial ends your connectors stop answering, but nothing is deleted. Choose a plan and they keep working without a minute of downtime.';

  const usageText = used
    ? `So far: ${recap.connectors} ${plural(recap.connectors, 'connector')} set up, ${recap.successfulCalls} successful tool ${plural(recap.successfulCalls, 'call')}.\n\n`
    : '';

  return build({
    subject,
    preheader:
      stage === 'expired'
        ? 'Nothing was deleted: your connectors are ready when you pick a plan.'
        : 'Keep your connectors and everything you built.',
    bodyHtml:
      heading +
      usageIntro +
      p(outcome) +
      button(pricingUrl, 'Choose a plan') +
      small(`Already have a key? Enter it at ${link(licenseUrl, esc(hostOf(licenseUrl)))}.`, 6) +
      small('Questions before you decide? Just reply: a person reads every email.'),
    bodyText:
      `${hi}\n\n` +
      (stage === 'expired'
        ? 'Your 7-day AnythingMCP trial has ended.'
        : stage === 'warn1'
          ? 'Your AnythingMCP trial ends tomorrow.'
          : `Your AnythingMCP trial ends in ${days} ${plural(days, 'day')}.`) +
      `\n\n${usageText}${outcome}\n\n` +
      `Choose a plan: ${pricingUrl}\nAlready have a key? ${licenseUrl}\n\n` +
      `Questions before you decide? Just reply: a person reads every email.`,
    ctx,
  });
}

export function activationReminderEmail(
  input: { name: string; connectorUrl: string; variant: 'connect-client' | 'test-connector' },
  ctx: MarketingContext,
): RenderedEmail {
  const hi = greeting(input.name);
  if (input.variant === 'connect-client') {
    return build({
      subject: 'Your MCP server is ready — one paste connects Claude, Cursor or ChatGPT',
      preheader: 'Copy the endpoint, pick your client under Quick Connect, done.',
      bodyHtml:
        h1('Your MCP server is ready.', 'One paste connects your AI.') +
        p(`${esc(hi)} your connector is set up and sitting on an MCP server, but no client has talked to it yet. The last step is a copy and paste.`) +
        steps([
          { title: 'Open the server page', detail: 'Your endpoint is at the top.' },
          { title: 'Pick your client under Quick Connect', detail: 'Claude, Cursor, ChatGPT, Meta Muse and Claude Code each have a short recipe there.' },
          { title: 'Ask your first question', detail: 'Your AI now uses the connector&rsquo;s tools.' },
        ]) +
        button(input.connectorUrl, 'Connect your client') +
        small('Stuck? Reply to this email; we read every one.'),
      bodyText:
        `${hi}\n\nYour connector is set up on an MCP server, but no client has talked to it yet. Open the server page, copy the endpoint and pick your client under Quick Connect (Claude, Cursor, ChatGPT, Meta Muse, Claude Code).\n\n` +
        `Connect your client: ${input.connectorUrl}\n\nStuck? Reply to this email; we read every one.`,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }
  return build({
    subject: "You're one call away — finish setting up your connector",
    preheader: 'Run one tool and see your connector answer.',
    bodyHtml:
      h1("You're one call away.", 'Run your first tool.') +
      p(`${esc(hi)} you created a connector in AnythingMCP but it hasn't made a successful call yet. That last step, running one tool, is where everything clicks.`) +
      p('Open your connector and hit <strong style="font-weight:600;">Run test</strong> on any tool. If it returns an error, the message tells you exactly what to fix: a missing API key, a wrong URL and so on.') +
      button(input.connectorUrl, 'Test your connector') +
      small('Stuck? Reply to this email; we read every one.'),
    bodyText:
      `${hi}\n\nYou created a connector in AnythingMCP but it hasn't made a successful call yet. Open it and hit "Run test" on any tool; error messages tell you exactly what to fix.\n\n` +
      `Test your connector: ${input.connectorUrl}\n\nStuck? Reply to this email; we read every one.`,
    ctx,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });
}

/**
 * The win-back offers (Cloud), each a single-use code minted per workspace by
 * the licence site (winback-code). They are 12-month prices on Cloud Starter;
 * every email that carries one says the price after the 12 months, in the
 * text, not only on the checkout page.
 *
 * - `locked`: business workspaces. €12/month for the first 12 months, then
 *   €19, or €120 for the first year, then €190. Two codes: Stripe keeps each
 *   on its own billing period.
 * - `personal`: consumer and Telegram workspaces (and the never-used ones
 *   whose AI kept calling). €6/month for the first 12 months, then €19.
 *
 * `codesExpireAt`: when the codes stop working (14 days after minting).
 */
export type RetentionOffer =
  | { kind: 'locked'; monthlyCode: string; yearlyCode: string; codesExpireAt: Date }
  | { kind: 'personal'; code: string; codesExpireAt: Date };

/** The prices the offers' Stripe coupons give, as the emails say them. */
export const RETENTION_PRICES = {
  locked: { monthly: '€12', yearly: '€120' },
  personal: { monthly: '€6' },
  list: { monthly: '€19', yearly: '€190' },
} as const;

/**
 * The checkout link of one code. `buy=starter&hosting=cloud` goes straight to
 * the Cloud Starter checkout, and `period` picks its billing period: the site
 * pre-applies a code only on the period it was minted for, and its pricing
 * page shows the monthly prices unless `period=yearly` comes with `buy`.
 */
function offerCheckoutUrl(
  input: { marketingUrl: string; cloudUrl: string; emailToken?: string | null },
  code: string,
  period: 'monthly' | 'yearly',
  source: PricingLinkSource,
): string {
  const returnUrl = encodeURIComponent(`${input.cloudUrl}/settings/license/activate`);
  return withEmailLinkToken(
    withSourceParam(
      `${input.marketingUrl}/pricing?buy=starter&hosting=cloud&period=${period}&promo=${encodeURIComponent(code)}&return_url=${returnUrl}`,
      source,
    ),
    input.emailToken,
  );
}

/** One offer, as HTML and as text: what it costs now and after 12 months, its codes and links. */
function offerBlock(
  offer: RetentionOffer,
  links: { marketingUrl: string; cloudUrl: string; emailToken?: string | null },
  source: PricingLinkSource,
): { html: string; text: string; subjectPrice: string } {
  const until = dayAndMonth(offer.codesExpireAt);
  const { list } = RETENTION_PRICES;
  if (offer.kind === 'personal') {
    const price = RETENTION_PRICES.personal.monthly;
    const url = offerCheckoutUrl(links, offer.code, 'monthly', source);
    const terms = `Cloud Starter for ${price}/month for your first 12 months, then ${list.monthly}/month. Cancel anytime from the billing portal.`;
    return {
      subjectPrice: `${price}/month`,
      html:
        p(`Here is <strong style="font-weight:600;">${esc(terms)}</strong> The code works once, until ${until}, and is applied when you use the button:`) +
        codeBox(offer.code, { size: 22, spacing: 3 }) +
        button(url, `Continue for ${price}/month`),
      text: `${terms}\nCode (once, until ${until}): ${offer.code}\nContinue for ${price}/month: ${url}`,
    };
  }
  const { monthly, yearly } = RETENTION_PRICES.locked;
  const monthlyUrl = offerCheckoutUrl(links, offer.monthlyCode, 'monthly', source);
  const yearlyUrl = offerCheckoutUrl(links, offer.yearlyCode, 'yearly', source);
  const monthlyTerms = `${monthly}/month for your first 12 months, then ${list.monthly}/month`;
  const yearlyTerms = `${yearly} for the first year, then ${list.yearly}/year`;
  return {
    subjectPrice: `${monthly}/month`,
    html:
      p(
        `Cloud Starter at <strong style="font-weight:600;">${esc(monthlyTerms)}</strong>, or <strong style="font-weight:600;">${esc(yearlyTerms)}</strong>. ` +
          `Each code works once, until ${until}, and is applied when you use its button. Cancel anytime from the billing portal.`,
      ) +
      p(`Monthly, ${esc(monthlyTerms)}:`) +
      codeBox(offer.monthlyCode, { size: 20, spacing: 2 }) +
      button(monthlyUrl, `Continue for ${monthly}/month`) +
      p(`Yearly, ${esc(yearlyTerms)}:`) +
      codeBox(offer.yearlyCode, { size: 20, spacing: 2 }) +
      button(yearlyUrl, `Continue for ${yearly}/year`),
    text:
      `Cloud Starter at ${monthlyTerms}, or ${yearlyTerms}. Each code works once, until ${until}. Cancel anytime from the billing portal.\n\n` +
      `Monthly (${monthlyTerms}): code ${offer.monthlyCode}\n${monthlyUrl}\n\n` +
      `Yearly (${yearlyTerms}): code ${offer.yearlyCode}\n${yearlyUrl}`,
  };
}

/**
 * What a win-back email carries. `trialEndedAt` dates the trial in the copy.
 * The first win-back goes out about a day after the trial ends (up to a week
 * for trials that ended before that timing shipped); the final one a month
 * after. A workspace that never made a call gets the how-to, no offer.
 */
export type WinbackOffer =
  | {
      kind: 'offer';
      offer: RetentionOffer;
      stage: 'first' | 'final';
      trialEndedAt: Date;
      successfulCalls: number;
    }
  | { kind: 'help'; trialEndedAt: Date };

/** "7 October": the day a trial ended, as the win-back emails say it. */
const dayAndMonth = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

export function trialWinbackEmail(
  input: {
    name: string;
    offer: WinbackOffer;
    cloudUrl: string;
    marketingUrl: string;
    /** The recipient's address token for the pricing links (see trialLifecycleEmail). */
    emailToken?: string | null;
  },
  ctx: MarketingContext,
): RenderedEmail {
  const { offer, cloudUrl, marketingUrl } = input;
  const returnUrl = encodeURIComponent(`${cloudUrl}/settings/license/activate`);
  const hi = greeting(input.name);
  const endedOn = dayAndMonth(offer.trialEndedAt);
  const replyLine = 'Not the right time, or something was missing? Reply and tell us; we read every answer.';

  if (offer.kind === 'offer') {
    // Every pricing link carries `source=email_winback` into the checkout's
    // Stripe metadata; the code tells the offers apart.
    const block = offerBlock(offer.offer, input, 'email_winback');
    const n = offer.successfulCalls;
    const callsHtml =
      n > 0
        ? ` Your AI made <strong style="font-weight:600;">${n.toLocaleString('en-US')} successful tool ${plural(n, 'call')}</strong> during the trial, and your connectors are still there.`
        : ' Your connectors are still there.';
    const callsText = n > 0 ? `; your AI made ${n} successful tool ${plural(n, 'call')} during it` : '';
    const ended = offer.stage === 'first' ? `ended on ${endedOn}` : 'ended a month ago';
    const yearly = offer.offer.kind === 'locked';
    const subject =
      offer.stage === 'first'
        ? `Keep AnythingMCP Cloud for ${block.subjectPrice} for your first year`
        : `Your workspace is still here: ${block.subjectPrice} for your first year`;
    return build({
      subject,
      preheader: yearly
        ? `Cloud Starter at ${RETENTION_PRICES.locked.monthly}/month for 12 months, then ${RETENTION_PRICES.list.monthly}/month.`
        : `Cloud Starter at ${RETENTION_PRICES.personal.monthly}/month for 12 months, then ${RETENTION_PRICES.list.monthly}/month.`,
      bodyHtml:
        h1(`${esc(block.subjectPrice)} for your first year.`, 'Pick up where you left off.') +
        p(`${esc(hi)} your AnythingMCP trial ${ended}.${callsHtml}`) +
        block.html +
        small(replyLine),
      bodyText:
        `${hi}\n\nYour AnythingMCP trial ${ended}${callsText}. Your connectors are still there.\n\n` +
        `${block.text}\n\n` +
        replyLine,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }

  const pricingUrl = withEmailLinkToken(
    withSourceParam(`${marketingUrl}/pricing?return_url=${returnUrl}`, 'email_winback'),
    input.emailToken,
  );
  const connectorsUrl = `${cloudUrl}/connectors`;
  const mcpUrl = `${cloudUrl}/mcp`;
  return build({
    subject: 'Connect your first app to Claude in two minutes',
    preheader: 'Set it up from the chat: no API keys pasted, no code.',
    bodyHtml:
      h1('Your workspace is still here.', 'Connect your first app in two minutes.') +
      p(`${esc(hi)} your AnythingMCP trial ended on ${endedOn} before you connected an app, so you never saw the part that matters. It is quicker than it looks.`) +
      p(
        `<strong style="font-weight:600;">You can set it up from the chat.</strong> Add AnythingMCP to Claude (it is in ${link(CLAUDE_DIRECTORY_URL, 'Claude&rsquo;s connector directory')}) or to ChatGPT with ${code(mcpUrl)}, then just ask: <em>&ldquo;Connect my Shopify store&rdquo;</em> or <em>&ldquo;Add HubSpot&rdquo;</em>. The assistant finds the connector, installs it in your workspace and gives you a one-time link where you sign in to the app. No API keys pasted into the chat.`,
      ) +
      p(`You can also pick from 200+ apps in the dashboard: ${link(connectorsUrl, esc(hostOf(connectorsUrl)))}.`) +
      p('Your workspace is still there. To use it again, choose a plan:') +
      button(pricingUrl, 'See plans') +
      small("Not sure it fits what you need? Reply with the app you want to connect and we'll tell you honestly."),
    bodyText:
      `${hi}\n\nYour AnythingMCP trial ended on ${endedOn} before you connected an app.\n\n` +
      `You can set it up from the chat: add AnythingMCP to Claude (connector directory: ${CLAUDE_DIRECTORY_URL}) or ChatGPT with ${mcpUrl} and ask "Connect my Shopify store". ` +
      `The assistant installs the connector and gives you a one-time link to sign in to the app.\n\n` +
      `Or pick from 200+ apps: ${connectorsUrl}\nPlans: ${pricingUrl}\n\n` +
      `Not sure it fits what you need? Reply with the app you want to connect and we'll tell you honestly.`,
    ctx,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });
}

/**
 * "Claude tried to use Etsy 6 times since yesterday": sent once to a Cloud
 * workspace whose AI kept calling its tools after the trial ended (the
 * `trial_expired_call_blocked` events), with the segment's offer. The
 * onboarding cron decides who gets it; marketing, so it carries the
 * unsubscribe line. The client and app names come from an OAuth client's
 * self-chosen name and the catalog, so both are escaped and capped.
 */
export interface TrialBlockedCallsEmailInput {
  name: string;
  /** The AI client's name ("Claude"); null when unknown ("Your AI"). */
  clientName: string | null;
  /** The app the AI tried most ("Etsy"); null when none is known. */
  appName: string | null;
  /** How many blocked calls the email reports (at least 1). */
  attempts: number;
  /**
   * The workspace never made a successful call during its trial: the email
   * speaks to the person who tried ("You tried to use…"), not about the AI's
   * work.
   */
  neverUsed?: boolean;
  offer: RetentionOffer;
  trialEndedAt: Date;
  cloudUrl: string;
  marketingUrl: string;
  /** The recipient's address token for the pricing links (see trialLifecycleEmail). */
  emailToken?: string | null;
}

const capName = (v: string | null | undefined, max = 40) => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function trialBlockedCallsEmail(input: TrialBlockedCallsEmailInput, ctx: MarketingContext): RenderedEmail {
  const client = capName(input.clientName);
  const who = client ?? 'Your AI';
  const whoInline = client ?? 'your AI';
  const app = capName(input.appName) ?? 'your apps';
  const n = Math.max(1, Math.round(input.attempts));
  const times = n === 1 ? 'once' : `${n.toLocaleString('en-US')} times`;
  const endedOn = dayAndMonth(input.trialEndedAt);
  const hi = greeting(input.name);
  const block = offerBlock(input.offer, input, 'email_blocked_calls');
  const headline = input.neverUsed
    ? `You tried to use ${app} ${times} since yesterday`
    : `${who} tried to use ${app} ${times} since yesterday`;
  const situation = input.neverUsed
    ? `your AnythingMCP trial ended on ${endedOn} before your first successful call, so those calls were refused. ` +
      `Your connectors and settings are kept: reactivate and try again from the chat, where you left off.`
    : `your AnythingMCP trial ended on ${endedOn}, so those calls were refused. ` +
      `Your connectors and settings are kept: reactivate and ${whoInline} can use ${app} again right away.`;
  const replyLine = input.neverUsed
    ? 'Did something not work the way you expected? Reply and tell us; a person reads every answer and will help you set it up.'
    : 'Not the right time, or something was missing? Reply and tell us; we read every answer.';
  return build({
    subject: headline,
    preheader: `Your trial ended, so those calls were refused. Your connectors are still there.`,
    bodyHtml:
      h1(`${esc(headline)}.`, 'Your workspace is still there.') +
      p(`${esc(hi)} ${esc(situation)}`) +
      block.html +
      small(replyLine),
    bodyText:
      `${hi}\n\n${headline}. ${situation.charAt(0).toUpperCase()}${situation.slice(1)}\n\n` +
      `${block.text}\n\n` +
      replyLine,
    ctx,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });
}

/**
 * The day a business workspace's trial ends (lifecycle `expired` stage,
 * business segment, outside the holdout): a short plain email from Matteo
 * instead of the designed one. What they built, and two ways on: one more
 * week (the one-click extension) or the locked price. Sent only to admins who
 * did not opt out of marketing (the others get the standard notice), so it
 * carries the unsubscribe line.
 */
export interface TrialEndedBusinessEmailInput {
  name: string;
  recap: {
    connectors: number;
    successfulCalls: number;
    /** The connector that made the most successful calls; null when none did. */
    topConnector: string | null;
  };
  /** The one-click 7-day extension link; null when it cannot be offered. */
  extendUrl: string | null;
  offer: Extract<RetentionOffer, { kind: 'locked' }>;
  cloudUrl: string;
  marketingUrl: string;
  emailToken?: string | null;
}

export function trialEndedBusinessEmail(input: TrialEndedBusinessEmailInput, ctx: MarketingContext): RenderedEmail {
  const hi = greeting(input.name);
  const { connectors, successfulCalls } = input.recap;
  const top = capName(input.recap.topConnector, 60);
  const { list } = RETENTION_PRICES;
  const { monthly, yearly } = RETENTION_PRICES.locked;
  const until = dayAndMonth(input.offer.codesExpireAt);
  const monthlyUrl = offerCheckoutUrl(input, input.offer.monthlyCode, 'monthly', 'email_trial_expired');
  const yearlyUrl = offerCheckoutUrl(input, input.offer.yearlyCode, 'yearly', 'email_trial_expired');

  const built =
    `You set up ${connectors} ${plural(connectors, 'connector')} and your AI made ` +
    `${successfulCalls.toLocaleString('en-US')} successful tool ${plural(successfulCalls, 'call')}` +
    (top ? `, most of them through ${top}.` : '.');
  const paragraphs: Array<{ text: string; html: string }> = [
    { text: hi, html: esc(hi) },
    {
      text: `I'm Matteo, I build AnythingMCP. Your trial ended today. ${built} Nothing is deleted: your connectors and settings are where you left them.`,
      html: `I'm Matteo, I build AnythingMCP. Your trial ended today. ${esc(built)} Nothing is deleted: your connectors and settings are where you left them.`,
    },
  ];
  if (input.extendUrl) {
    paragraphs.push({
      text: `If you need more time to decide, take one more week, free, in one click:\n${input.extendUrl}`,
      html: `If you need more time to decide, take one more week, free, in one click: <a href="${esc(input.extendUrl)}">extend my trial by 7 days</a>.`,
    });
  }
  paragraphs.push(
    {
      text:
        `If it already does its job, keep it at a price for the first year: Cloud Starter at ${monthly}/month for your first 12 months, then ${list.monthly}/month, ` +
        `or ${yearly} for the first year, then ${list.yearly}/year. Each code works once, until ${until}.\n\n` +
        `Monthly, code ${input.offer.monthlyCode}:\n${monthlyUrl}\n\nYearly, code ${input.offer.yearlyCode}:\n${yearlyUrl}`,
      html:
        `If it already does its job, keep it at a price for the first year: Cloud Starter at ${monthly}/month for your first 12 months, then ${list.monthly}/month ` +
        `(<a href="${esc(monthlyUrl)}">monthly, code ${esc(input.offer.monthlyCode)}</a>), or ${yearly} for the first year, then ${list.yearly}/year ` +
        `(<a href="${esc(yearlyUrl)}">yearly, code ${esc(input.offer.yearlyCode)}</a>). Each code works once, until ${until}.`,
    },
    {
      text: 'And if something was missing, just reply to this email. It comes to me.',
      html: 'And if something was missing, just reply to this email. It comes to me.',
    },
    { text: 'Matteo', html: 'Matteo' },
  );
  return plainEmail({
    subject: 'Your AnythingMCP trial ended today',
    preheader: 'What you built, one more week if you need it, and a price for the first year.',
    paragraphs,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });
}

/**
 * A personal email: no layout, no logo, no buttons, the way a person writes.
 * The HTML part is the same paragraphs with their links; the text part is the
 * one most readers see. Marketing: the unsubscribe line closes both.
 */
function plainEmail(opts: {
  subject: string;
  preheader: string;
  paragraphs: Array<{ text: string; html: string }>;
  unsubscribeUrl: string;
}): RenderedEmail {
  const unsubscribe = `Unsubscribe from tips and offers: ${opts.unsubscribeUrl}`;
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(opts.subject)}</title></head>` +
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;background:#ffffff;">' +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(opts.preheader)}</div>` +
    '<div style="max-width:560px;">' +
    opts.paragraphs.map((para) => `<p style="margin:0 0 14px 0;">${para.html}</p>`).join('') +
    `<p style="margin:24px 0 0 0;font-size:12px;color:#6b6b6b;"><a href="${esc(opts.unsubscribeUrl)}" style="color:#6b6b6b;">Unsubscribe from tips and offers</a></p>` +
    '</div></body></html>';
  const text = `${opts.paragraphs.map((para) => para.text).join('\n\n')}\n\n--\n${unsubscribe}\n`;
  return { subject: opts.subject, html, text, marketing: true };
}

/**
 * The card-trial offer after a workspace's first successful tool call
 * (card-trial-offer.service.ts), 30 to 90 minutes after it. Value first:
 * the connection works, here is what to ask next. Then the trial's end date
 * and the way to keep it running. No card, charge or price talk.
 */
export interface CardTrialOfferEmailInput {
  name: string;
  /** The connector's name in the workspace; null when it is gone. */
  connectorName: string | null;
  /** Up to three things to ask next, from the connector's tools. */
  nextSteps: Array<{ name: string; text: string }>;
  trialEndsAt: Date;
  /** Where the button leads: /start-trial (card trial) or the plans. */
  ctaUrl: string;
  /** True when the card trial can still start; false links to the plans. */
  cardTrial: boolean;
}

export function cardTrialOfferEmail(input: CardTrialOfferEmailInput, ctx: MarketingContext): RenderedEmail {
  const hi = greeting(input.name);
  const named = input.connectorName?.trim() || null;
  const app = named ?? 'your app';
  const endsOn = dayAndMonth(input.trialEndsAt);
  const replyLine = 'Something did not work the way you expected? Just reply: a person reads every email.';
  const keep = input.cardTrial
    ? 'To keep it running after that, start your trial on the plan that fits you. It takes a minute, in the app.'
    : 'To keep it running after that, choose the plan that fits you. It takes a minute, in the app.';
  const cta = input.cardTrial ? 'Start your trial' : 'Choose a plan';

  const stepsHtml = input.nextSteps.length
    ? p('A few things to ask your AI next, in the same chat:') +
      steps(input.nextSteps.map((s) => ({ title: esc(s.text), detail: esc(s.name) })))
    : p(`Ask your AI what it can do with ${esc(app)}: it knows every tool the connection offers and picks the right one.`);
  const stepsText = input.nextSteps.length
    ? `A few things to ask your AI next, in the same chat:\n${input.nextSteps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}\n\n`
    : `Ask your AI what it can do with ${app}: it knows every tool the connection offers and picks the right one.\n\n`;

  return build({
    subject: named ? `Your ${named} connection works` : 'Your first connection works',
    preheader: 'Your AI just used it for real. Here is what to try next.',
    bodyHtml:
      h1(`Your ${esc(app)} connection works.`, 'Here is what to try next.') +
      p(
        `${esc(hi)} your AI just made its first successful call to ${esc(app)} through AnythingMCP. ` +
          'The setup is done: from now on you ask in plain language and it does the work.',
      ) +
      stepsHtml +
      p(`Your trial ends on <strong style="font-weight:600;">${esc(endsOn)}</strong>. ${keep}`) +
      button(input.ctaUrl, cta) +
      small(replyLine),
    bodyText:
      `${hi}\n\nYour AI just made its first successful call to ${app} through AnythingMCP. ` +
      'The setup is done: from now on you ask in plain language and it does the work.\n\n' +
      stepsText +
      `Your trial ends on ${endsOn}. ${keep}\n\n${cta}: ${input.ctaUrl}\n\n` +
      replyLine,
    ctx,
    unsubscribeUrl: ctx.unsubscribeUrl,
  });
}
