import {
  SupportTriageService,
  fallbackTriage,
  normaliseAttrs,
  parseTriage,
  segmentTags,
  triageNote,
} from './support-triage.service';
import { compactError, redactSecrets } from './support-redact';
import * as llm from '../../knowledge-graph/llm-client';

function fakeDesk(messages: any[] = []) {
  return {
    incomingMessages: jest.fn().mockResolvedValue(messages),
    addTags: jest.fn().mockResolvedValue(true),
    setPriority: jest.fn().mockResolvedValue(true),
    assignTeam: jest.fn().mockResolvedValue(true),
    assignUser: jest.fn().mockResolvedValue(true),
    addPrivateNote: jest.fn().mockResolvedValue(true),
    teams: jest.fn().mockResolvedValue([
      { id: 1, name: 'Support' },
      { id: 2, name: 'Enterprise' },
    ]),
  };
}

class TestTriage extends SupportTriageService {
  constructor(
    private readonly desk: any,
    private readonly llmCfg: any = { provider: 'anthropic', model: 'm', apiKey: 'k' },
    private readonly assistantId: number | null = null,
  ) {
    super();
  }
  protected client() {
    return this.desk;
  }
  protected aiAssistantUserId() {
    return this.assistantId;
  }
  protected llm() {
    return this.llmCfg;
  }
}

describe('support triage helpers', () => {
  it('segment tags follow deployment and plan', () => {
    expect(segmentTags({ deployment: 'cloud', plan: 'trial' })).toEqual(['cloud', 'trial']);
    expect(segmentTags({ deployment: 'cloud', plan: 'starter' })).toEqual(['cloud', 'paid']);
    expect(segmentTags({ deployment: 'cloud', plan: 'none' })).toEqual(['cloud']);
    expect(segmentTags({ deployment: 'dedicated', plan: 'enterprise' })).toEqual([
      'self-hosted',
      'enterprise',
      'paid',
    ]);
  });

  it('parseTriage clamps unknown values and raises billing and enterprise to High', () => {
    expect(parseTriage({ category: 'nonsense', priority: 'Urgent' }, {})).toMatchObject({
      category: 'other',
      priority: 'Medium',
    });
    expect(parseTriage({ category: 'billing', priority: 'Low' }, {})?.priority).toBe('High');
    expect(parseTriage({ category: 'bug', priority: 'Low' }, { deployment: 'dedicated' })?.priority).toBe('High');
    expect(parseTriage(null, {})).toBeNull();
  });

  it('reads only the known contact attributes', () => {
    const raw = JSON.parse('{"plan":"trial","__proto__":{"x":1},"constructor":"y","other":"z","connectors":3}');
    const out = normaliseAttrs(raw);
    expect(out).toEqual({ plan: 'trial', connectors: '3' });
    expect(({} as any).x).toBeUndefined();
  });

  it('fallback keeps enterprise conversations at High', () => {
    expect(fallbackTriage({ deployment: 'dedicated' }).priority).toBe('High');
    expect(fallbackTriage({ deployment: 'cloud' }).priority).toBe('Medium');
  });

  it('the note escapes model output', () => {
    const html = triageNote(
      { category: 'bug', priority: 'High', language: 'it', summary: '<script>x</script>', suggestedReply: 'a\nb' },
      { plan: 'trial', connector_issues: 'Etsy: auth needs_reauth' },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a<br>b');
    expect(html).toContain('Etsy: auth needs_reauth');
  });

  it('redacts credentials from error text', () => {
    const out = redactSecrets(
      'GET https://x.test/v1?api_key=abc123secret failed: Authorization: Bearer sk-live-1234567890abcdef',
    );
    expect(out).not.toContain('abc123secret');
    expect(out).not.toContain('sk-live-1234567890abcdef');
    expect(compactError('x'.repeat(10) + ' ' + 'y '.repeat(200), 40).length).toBeLessThanOrEqual(40);
  });
});

describe('SupportTriageService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('classifies, tags, prioritises, assigns and writes a private note', async () => {
    const desk = fakeDesk([
      { private: false, sender_type: 'contact', text_content: 'My Etsy connector says unauthorized' },
      { private: true, sender_type: 'agent', text_content: 'internal' },
    ]);
    const chat = jest.spyOn(llm, 'chatJson').mockResolvedValue({
      json: { category: 'connector-error', priority: 'Medium', language: 'en', summary: 's', suggested_reply: 'r' },
    });
    const svc = new TestTriage(desk);
    const res = await svc.triage({
      uuid: 'c1',
      contact: { custom_attributes: { deployment: 'cloud', plan: 'trial', organization_id: 'org-secret' } },
    });

    expect(res?.category).toBe('connector-error');
    const userPrompt = chat.mock.calls[0][2];
    expect(userPrompt).toContain('My Etsy connector says unauthorized');
    expect(userPrompt).not.toContain('internal');
    expect(userPrompt).not.toContain('org-secret');
    expect(desk.addTags).toHaveBeenCalledWith('c1', ['connector-error', 'cloud', 'trial', 'ai-triaged']);
    expect(desk.setPriority).toHaveBeenCalledWith('c1', 'Medium');
    expect(desk.assignTeam).toHaveBeenCalledWith('c1', 1);
    expect(desk.addPrivateNote).toHaveBeenCalledTimes(1);
  });

  it('routes dedicated instances to the Enterprise team', async () => {
    const desk = fakeDesk([{ private: false, sender_type: 'contact', text_content: 'help' }]);
    jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'bug', priority: 'Low' } });
    await new TestTriage(desk).triage({ uuid: 'c2', contact: { custom_attributes: { deployment: 'dedicated' } } });
    expect(desk.assignTeam).toHaveBeenCalledWith('c2', 2);
    expect(desk.setPriority).toHaveBeenCalledWith('c2', 'High');
  });

  it('still tags and annotates when the LLM is unavailable', async () => {
    const desk = fakeDesk([{ private: false, sender_type: 'contact', text_content: 'help' }]);
    const chat = jest.spyOn(llm, 'chatJson');
    await new TestTriage(desk, null).triage({ uuid: 'c3', contact: { custom_attributes: { deployment: 'cloud' } } });
    expect(chat).not.toHaveBeenCalled();
    expect(desk.addTags).toHaveBeenCalledWith('c3', ['other', 'cloud', 'ai-triaged']);
  });

  it('handles each conversation once and skips already-triaged ones', async () => {
    const desk = fakeDesk([]);
    const svc = new TestTriage(desk, null);
    await svc.triage({ uuid: 'c4' });
    await svc.triage({ uuid: 'c4' });
    await svc.triage({ uuid: 'c5', tags: ['ai-triaged'] });
    expect(desk.addTags).toHaveBeenCalledTimes(1);
  });

  it('hands safe live chats to the AI assistant after the team, never billing or enterprise', async () => {
    const msgs = [{ private: false, sender_type: 'contact', text_content: 'help' }];
    const chat = jest.spyOn(llm, 'chatJson');

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Medium' } });
    const desk = fakeDesk(msgs);
    await new TestTriage(desk, undefined, 5).triage({
      uuid: 'a1',
      inbox_channel: 'livechat',
      contact: { custom_attributes: { deployment: 'cloud', plan: 'trial' } },
    });
    expect(desk.addTags).toHaveBeenCalledWith('a1', ['connector-setup', 'cloud', 'trial', 'ai-triaged', 'ai-assistant']);
    expect(desk.assignUser).toHaveBeenCalledWith('a1', 5);
    expect(desk.assignTeam.mock.invocationCallOrder[0]).toBeLessThan(desk.assignUser.mock.invocationCallOrder[0]);

    chat.mockResolvedValueOnce({ json: { category: 'billing', priority: 'Low' } });
    const billing = fakeDesk(msgs);
    await new TestTriage(billing, undefined, 5).triage({ uuid: 'a2', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'cloud' } } });
    expect(billing.assignUser).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Low' } });
    const ent = fakeDesk(msgs);
    await new TestTriage(ent, undefined, 5).triage({ uuid: 'a3', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'dedicated' } } });
    expect(ent.assignUser).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Low' } });
    const email = fakeDesk(msgs);
    await new TestTriage(email, undefined, 5).triage({ uuid: 'a4', inbox_channel: 'email', contact: { custom_attributes: { deployment: 'cloud' } } });
    expect(email.assignUser).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Low' } });
    const off = fakeDesk(msgs);
    await new TestTriage(off).triage({ uuid: 'a5', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'cloud' } } });
    expect(off.assignUser).not.toHaveBeenCalled();
  });

  it('a failing step does not stop the others', async () => {
    const desk = fakeDesk([]);
    desk.addTags.mockRejectedValue(new Error('tag missing'));
    await new TestTriage(desk, null).triage({ uuid: 'c6' });
    expect(desk.setPriority).toHaveBeenCalled();
    expect(desk.addPrivateNote).toHaveBeenCalled();
  });
});
