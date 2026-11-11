import {
  CredentialRefusalTracker,
  REFUSALS_BEFORE_MARK,
  credentialRefusedMessage,
} from './credential-refusal-tracker';

describe('CredentialRefusalTracker', () => {
  it('asks for a mark at the threshold, not before, and again every 100 refusals', () => {
    const t = new CredentialRefusalTracker();
    const asked: number[] = [];
    for (let i = 1; i <= 205; i++) {
      const n = t.refused('c1');
      if (n !== undefined) asked.push(n);
    }
    expect(asked).toEqual([REFUSALS_BEFORE_MARK, 100, 200]);
  });

  it('starts over after a call that worked', () => {
    const t = new CredentialRefusalTracker();
    for (let i = 1; i < REFUSALS_BEFORE_MARK; i++) expect(t.refused('c1')).toBeUndefined();
    expect(t.succeeded('c1')).toBe(true);
    for (let i = 1; i < REFUSALS_BEFORE_MARK; i++) expect(t.refused('c1')).toBeUndefined();
    expect(t.refused('c1')).toBe(REFUSALS_BEFORE_MARK);
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

  it('keeps connectors apart', () => {
    const t = new CredentialRefusalTracker();
    for (let i = 1; i < REFUSALS_BEFORE_MARK; i++) t.refused('c1');
    expect(t.refused('c2')).toBeUndefined();
    expect(t.refused('c1')).toBe(REFUSALS_BEFORE_MARK);
  });
});

describe('credentialRefusedMessage', () => {
  it('says what happened, then the advice', () => {
    expect(credentialRefusedMessage(5, 'Create a new key.')).toBe(
      "The API refused this connector's saved credentials on 5 calls in a row (HTTP 401). Create a new key.",
    );
    expect(credentialRefusedMessage(5, undefined)).toMatch(/enter valid ones in the connector's settings/);
    expect(credentialRefusedMessage(5, 'x'.repeat(2000)).length).toBe(1000);
  });
});
