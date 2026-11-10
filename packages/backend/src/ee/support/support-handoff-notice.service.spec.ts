import { HANDOFF_NOTICES, SupportHandoffNoticeService, triageLanguage } from './support-handoff-notice.service';

class TestService extends SupportHandoffNoticeService {
  constructor(
    private readonly desk: any,
    private readonly assistant: number | null = 5,
  ) {
    super();
  }
  protected client() {
    return this.desk;
  }
  protected assistantUserId() {
    return this.assistant;
  }
}

const handoffNote = (over: Record<string, unknown> = {}) => ({
  uuid: 'm1',
  type: 'outgoing',
  private: true,
  sender_type: 'agent',
  sender_id: 5,
  conversation_uuid: 'c1',
  text_content: 'The customer asked us to install it for them.',
  ...over,
});

function desk(notes: any[] = [], channel = 'livechat') {
  return {
    conversation: jest.fn().mockResolvedValue({ uuid: 'c1', inbox_channel: channel }),
    privateNotes: jest.fn().mockResolvedValue(notes),
    reply: jest.fn().mockResolvedValue({}),
  };
}

describe('triageLanguage', () => {
  it('reads the language from the triage note', () => {
    expect(triageLanguage(['AI triage : connector-setup, priority High, language fr Customer wants'])).toBe('fr');
    expect(triageLanguage(['<p><strong>AI triage</strong>: other, priority Medium, language es</p>'])).toBe('es');
    expect(triageLanguage(['AI triage : other, priority Medium Instance : cloud'])).toBeNull();
    expect(triageLanguage([null, 'unrelated'])).toBeNull();
  });
});

describe('SupportHandoffNoticeService', () => {
  it('tells the customer, in the triage language, that a person replies here', async () => {
    const d = desk([{ private: true, text_content: 'AI triage : other, priority Medium, language es' }]);
    const svc = new TestService(d);
    await expect(svc.handleMessage(handoffNote() as any)).resolves.toBe(true);
    expect(d.reply).toHaveBeenCalledWith('c1', `<p>${HANDOFF_NOTICES.es}</p>`);
  });

  it('falls back to English for an unknown or missing language', async () => {
    const d = desk([{ private: true, text_content: 'AI triage : other, priority Medium, language uz' }]);
    await new TestService(d).handleMessage(handoffNote() as any);
    expect(d.reply).toHaveBeenCalledWith('c1', `<p>${HANDOFF_NOTICES.en}</p>`);
  });

  it('ignores notes of others, public messages, customer messages and non-chat inboxes', async () => {
    const d = desk();
    const svc = new TestService(d);
    await expect(svc.handleMessage(handoffNote({ sender_id: 3 }) as any)).resolves.toBe(false);
    await expect(svc.handleMessage(handoffNote({ private: false }) as any)).resolves.toBe(false);
    await expect(svc.handleMessage(handoffNote({ sender_type: 'contact' }) as any)).resolves.toBe(false);
    expect(d.reply).not.toHaveBeenCalled();

    const email = desk([], 'email');
    await expect(new TestService(email).handleMessage(handoffNote() as any)).resolves.toBe(false);
    expect(email.reply).not.toHaveBeenCalled();
  });

  it('does nothing without a configured AI assistant user', async () => {
    const d = desk();
    await expect(new TestService(d, null).handleMessage(handoffNote() as any)).resolves.toBe(false);
    expect(d.conversation).not.toHaveBeenCalled();
  });

  it('sends one notice per conversation in six hours', async () => {
    const d = desk();
    const svc = new TestService(d);
    const t0 = Date.parse('2026-11-10T10:00:00Z');
    await svc.handleMessage(handoffNote() as any, t0);
    await svc.handleMessage(handoffNote({ uuid: 'm2' }) as any, t0 + 60_000);
    expect(d.reply).toHaveBeenCalledTimes(1);
    await svc.handleMessage(handoffNote({ uuid: 'm3' }) as any, t0 + 7 * 60 * 60_000);
    expect(d.reply).toHaveBeenCalledTimes(2);
  });
});
