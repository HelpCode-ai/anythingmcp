import {
  CredentialRefusalTracker,
  REFUSALS_BEFORE_MARK,
  credentialRefusedMessage,
  marksAt,
} from './credential-refusal-tracker';

describe('CredentialRefusalTracker', () => {
  it('counts the refusals in a row of each connector', () => {
    const t = new CredentialRefusalTracker();
    expect(t.refused('c1')).toBe(1);
    expect(t.refused('c1')).toBe(2);
    expect(t.refused('c2')).toBe(1);
    expect(t.refused('c1')).toBe(3);
  });

  it('starts over after a call that worked', () => {
    const t = new CredentialRefusalTracker();
    t.refused('c1');
    t.refused('c1');
    expect(t.succeeded('c1')).toBe(true);
    expect(t.refused('c1')).toBe(1);
  });

  it('asks to clear once per connector, and again after new refusals', () => {
    const t = new CredentialRefusalTracker();
    expect(t.succeeded('c1')).toBe(true); // a mark from before a restart
    expect(t.succeeded('c1')).toBe(false);
    expect(t.succeeded('c2')).toBe(true);
    t.refused('c1');
    expect(t.succeeded('c1')).toBe(true);
    expect(t.succeeded('c1')).toBe(false);
  });

});

describe('marksAt', () => {
  it('asks for a mark at the threshold, not before, and again every 100 refusals', () => {
    const asked: number[] = [];
    for (let count = 1; count <= 205; count++) if (marksAt(count)) asked.push(count);
    expect(asked).toEqual([REFUSALS_BEFORE_MARK, 100, 200]);
  });

  it('marks after three refusals: people stop trying sooner than five', () => {
    expect(REFUSALS_BEFORE_MARK).toBe(3);
  });
});

describe('credentialRefusedMessage', () => {
  it('says what happened, then the advice', () => {
    expect(credentialRefusedMessage(5, 'Create a new key.', 401)).toBe(
      "The API refused this connector's saved credentials on 5 calls in a row (HTTP 401). Create a new key.",
    );
    // A refusal that is not an HTTP 401 (Telegram's 404, Odoo's Access Denied in a 200) names no status.
    expect(credentialRefusedMessage(3, 'Copy the token again.')).toBe(
      "The API refused this connector's saved credentials on 3 calls in a row. Copy the token again.",
    );
    expect(credentialRefusedMessage(5, undefined)).toMatch(/enter valid ones in the connector's settings/);
    expect(credentialRefusedMessage(5, 'x'.repeat(2000)).length).toBe(1000);
  });
});
