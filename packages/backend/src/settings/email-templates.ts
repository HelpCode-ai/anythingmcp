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
  const shown = /^\d{6}$/.test(input.code) ? `${input.code.slice(0, 3)} ${input.code.slice(3)}` : input.code;
  return build({
    // Code first: it is what the inbox preview shows, and what iOS reads to
    // offer it above the keyboard (autocomplete one-time-code).
    subject: `${input.code} is your AnythingMCP verification code`,
    preheader: 'Your code is valid for 15 minutes.',
    bodyHtml:
      h1('Confirm your email,', 'and you are in.') +
      p('Enter this code in the AnythingMCP window you just left. It is valid for 15 minutes.') +
      codeBox(shown) +
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
  input: { name: string; dayNumber: 1 | 2; aiClient?: string; cloudUrl: string },
  ctx: MarketingContext,
): RenderedEmail {
  const { cloudUrl } = input;
  const welcomeUrl = `${cloudUrl}/welcome`;
  const storeUrl = `${cloudUrl}/connectors/store`;
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
  },
  ctx: EmailBrandContext,
): RenderedEmail {
  const { stage, recap, cloudUrl } = input;
  const pricingUrl = `${input.marketingUrl}/pricing?return_url=${encodeURIComponent(`${cloudUrl}/settings/license/activate`)}`;
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
 * What a win-back email offers. `trialEndedAt` dates the trial in the copy.
 * The first win-back goes out about a day after the trial ends (up to a week
 * for trials that ended before that timing shipped); the final one a month
 * after.
 */
export type WinbackOffer =
  | {
      kind: 'discount';
      percentOff: number;
      promoCode: string;
      stage: 'first' | 'final';
      trialEndedAt: Date;
      successfulCalls: number;
    }
  | {
      /** A fixed price for the first month of Cloud Starter (first win-back, A/B test arm). */
      kind: 'firstMonth';
      price: string;
      regularPrice: string;
      promoCode: string;
      trialEndedAt: Date;
      successfulCalls: number;
    }
  | { kind: 'help'; trialEndedAt: Date };

/** "7 October": the day a trial ended, as the win-back emails say it. */
const dayAndMonth = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

export function trialWinbackEmail(
  input: { name: string; offer: WinbackOffer; cloudUrl: string; marketingUrl: string },
  ctx: MarketingContext,
): RenderedEmail {
  const { offer, cloudUrl, marketingUrl } = input;
  const returnUrl = encodeURIComponent(`${cloudUrl}/settings/license/activate`);
  const hi = greeting(input.name);
  const endedOn = dayAndMonth(offer.trialEndedAt);
  const replyLine = 'Not the right time, or something was missing? Reply and tell us; we read every answer.';
  const callsHtml = (n: number) =>
    n > 0
      ? ` Your AI made <strong style="font-weight:600;">${n.toLocaleString('en-US')} successful tool ${plural(n, 'call')}</strong> during the trial, and your connectors are still there.`
      : ' Your connectors are still there.';
  const callsText = (n: number) => (n > 0 ? `; your AI made ${n} successful tool ${plural(n, 'call')} during it` : '');

  if (offer.kind === 'firstMonth') {
    const price = esc(offer.price);
    const regular = esc(offer.regularPrice);
    const pricingUrl = `${marketingUrl}/pricing?promo=${encodeURIComponent(offer.promoCode)}&return_url=${returnUrl}`;
    return build({
      subject: `Your first month of AnythingMCP Cloud for ${offer.price}`,
      preheader: `Your workspace is still there. Cloud Starter for ${offer.price} the first month, then ${offer.regularPrice}/month.`,
      bodyHtml:
        h1(`Your first month for ${price}.`, 'Pick up where you left off.') +
        p(`${esc(hi)} your AnythingMCP trial ended on ${endedOn}.${callsHtml(offer.successfulCalls)}`) +
        p(
          `If you'd like to keep going, Cloud Starter is <strong style="font-weight:600;">${price} for the first month</strong>, then ${regular}/month. ` +
            'You can cancel anytime from the billing portal. The code is applied when you use the button, or enter it at checkout:',
        ) +
        codeBox(offer.promoCode, { size: 22, spacing: 3 }) +
        button(pricingUrl, `Continue for ${price}`) +
        small(replyLine),
      bodyText:
        `${hi}\n\nYour AnythingMCP trial ended on ${endedOn}${callsText(offer.successfulCalls)}. Your connectors are still there.\n\n` +
        `If you'd like to keep going, Cloud Starter is ${offer.price} for the first month, then ${offer.regularPrice}/month. ` +
        `You can cancel anytime from the billing portal.\n\n` +
        `Code: ${offer.promoCode}\nContinue for ${offer.price}: ${pricingUrl}\n\n` +
        replyLine,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }

  if (offer.kind === 'discount') {
    const percent = Math.round(offer.percentOff);
    const pricingUrl = `${marketingUrl}/pricing?promo=${encodeURIComponent(offer.promoCode)}&return_url=${returnUrl}`;
    const ended = offer.stage === 'first' ? `ended on ${endedOn}` : 'ended a month ago';
    return build({
      subject:
        offer.stage === 'first'
          ? `${percent}% off your first 3 months of AnythingMCP`
          : `One more try? ${percent}% off AnythingMCP for 3 months`,
      preheader: `Your workspace is still there. ${percent}% off your first 3 months on any Cloud plan.`,
      bodyHtml:
        h1(`${percent}% off for 3 months.`, 'Pick up where you left off.') +
        p(`${esc(hi)} your AnythingMCP trial ${ended}.${callsHtml(offer.successfulCalls)}`) +
        p(`If you'd like to continue, here is <strong style="font-weight:600;">${percent}% off your first 3 months</strong> on any Cloud plan. The code is applied when you use the button, or enter it at checkout:`) +
        codeBox(offer.promoCode, { size: 22, spacing: 3 }) +
        button(pricingUrl, `Reactivate with ${percent}% off`) +
        small(replyLine),
      bodyText:
        `${hi}\n\nYour AnythingMCP trial ${ended}${callsText(offer.successfulCalls)}` +
        `. Your connectors are still there.\n\nHere is ${percent}% off your first 3 months on any Cloud plan.\n\n` +
        `Code: ${offer.promoCode}\nReactivate: ${pricingUrl}\n\n` +
        replyLine,
      ctx,
      unsubscribeUrl: ctx.unsubscribeUrl,
    });
  }

  const pricingUrl = `${marketingUrl}/pricing?return_url=${returnUrl}`;
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
