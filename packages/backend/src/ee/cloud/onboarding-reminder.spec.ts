// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { getAdapter } from '../../adapters/catalog';
import { QUICK_SETUPS, attributedIntent, claudeChatUrl, reminderArm } from './onboarding-reminder';

describe('onboarding reminder arms', () => {
  it('assigns the same arm to a user on every run', () => {
    // u3 was in arm A until the A/B test ended (2026-11-17).
    expect(reminderArm('u3')).toBe('B');
    expect(reminderArm('u2')).toBe('B');
    expect(reminderArm('u1')).toBe('holdout');
    expect(reminderArm('u3')).toBe(reminderArm('u3'));
  });

  it('holds out about 10% and gives everyone else arm B', () => {
    const counts = { A: 0, B: 0, holdout: 0 };
    for (let i = 0; i < 20_000; i++) counts[reminderArm(`user-${i}`)]++;
    expect(counts.holdout / 20_000).toBeGreaterThan(0.08);
    expect(counts.holdout / 20_000).toBeLessThan(0.12);
    expect(counts.A).toBe(0);
    expect(counts.B + counts.holdout).toBe(20_000);
  });

  it('offers only catalog connectors for the one-click setups', () => {
    for (const q of QUICK_SETUPS) expect(getAdapter(q.adapterSlug)).toBeTruthy();
  });

  it('opens a new Claude chat with the request typed in', () => {
    expect(claudeChatUrl('Connect my Odoo to AnythingMCP')).toBe(
      'https://claude.ai/new?q=Connect%20my%20Odoo%20to%20AnythingMCP',
    );
  });

  it.each([
    ['organic_google', true],
    ['ai_assistant', true],
    ['google_ads', true],
    ['github', true],
    ['direct', false],
    ['', false],
    [undefined, false],
  ])('counts a sign-up first through %p as intent: %p', (channel, expected) => {
    expect(attributedIntent(channel === undefined ? {} : { first_channel: channel })).toBe(expected);
  });

  it('counts a sign-up without attribution as no intent', () => {
    expect(attributedIntent(null)).toBe(false);
  });
});
