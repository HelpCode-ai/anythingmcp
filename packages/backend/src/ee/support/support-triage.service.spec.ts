import {
  SupportTriageService,
  HUMAN_ROUTING_ACKS,
  fallbackTriage,
  humanRoutingAck,
  isPublicAgentReply,
  normaliseAttrs,
  parseTriage,
  segmentTags,
  triageNote,
} from './support-triage.service';
import { compactError, redactSecrets } from './support-redact';
import * as llm from '../../knowledge-graph/llm-client';

function fakeDesk(messages: any[] = [], all: any[] = messages) {
  return {
    incomingMessages: jest.fn().mockResolvedValue(messages),
    messages: jest.fn().mockResolvedValue(all),
    reply: jest.fn().mockResolvedValue(true),
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
    const raw = JSON.parse(
      '{"plan":"trial","__proto__":{"x":1},"constructor":"y","other":"z","connectors":3,"connector_links":"Etsy: u","mcp_server_urls":"Default: m"}',
    );
    const out = normaliseAttrs(raw);
    expect(out).toEqual({ plan: 'trial', connectors: '3', connector_links: 'Etsy: u', mcp_server_urls: 'Default: m' });
    expect(({} as any).x).toBeUndefined();
  });

  it('fallback keeps enterprise conversations at High', () => {
    expect(fallbackTriage({ deployment: 'dedicated' }).priority).toBe('High');
    expect(fallbackTriage({ deployment: 'cloud' }).priority).toBe('Medium');
  });

  it('the note escapes model output', () => {
    const html = triageNote(
      { category: 'bug', priority: 'High', language: 'it', summary: '<script>x</script>', suggestedReply: 'a\nb' },
      {
        plan: 'trial',
        connector_issues: 'Etsy: auth needs_reauth',
        connector_links: 'Etsy: https://cloud.test/connectors/setup/etsy?connector=c1',
        mcp_server_urls: 'Default: https://cloud.test/mcp/s1',
      },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a<br>b');
    expect(html).toContain('Etsy: auth needs_reauth');
    expect(html).toContain('Connector links');
    expect(html).toContain('MCP server URL');
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
    // The catalog connectors the customer names, so the reply never says we lack one.
    expect(userPrompt).toContain('Etsy (/connectors/setup/etsy)');
    expect(chat.mock.calls[0][1]).toMatch(/never used to connect an AI assistant/);
    expect(desk.addTags).toHaveBeenCalledWith('c1', ['connector-error', 'cloud', 'trial', 'ai-triaged']);
    expect(desk.setPriority).toHaveBeenCalledWith('c1', 'Medium');
    expect(desk.assignTeam).toHaveBeenCalledWith('c1', 1);
    expect(desk.addPrivateNote).toHaveBeenCalledTimes(1);
  });

  it('routes dedicated instances to the Enterprise team and mentions it in the note', async () => {
    const desk = fakeDesk([{ private: false, sender_type: 'contact', text_content: 'help' }]);
    jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'bug', priority: 'Low' } });
    await new TestTriage(desk).triage({ uuid: 'c2', contact: { custom_attributes: { deployment: 'dedicated' } } });
    expect(desk.assignTeam).toHaveBeenCalledWith('c2', 2);
    expect(desk.setPriority).toHaveBeenCalledWith('c2', 'High');
    expect(desk.addPrivateNote).toHaveBeenCalledWith('c2', expect.any(String), [{ type: 'team', id: 2 }]);
  });

  it('does not mention a team for non-enterprise conversations', async () => {
    const desk = fakeDesk([{ private: false, sender_type: 'contact', text_content: 'help' }]);
    jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'bug', priority: 'Low' } });
    await new TestTriage(desk).triage({ uuid: 'c7', contact: { custom_attributes: { deployment: 'cloud', plan: 'starter' } } });
    expect(desk.addPrivateNote).toHaveBeenCalledWith('c7', expect.any(String), []);
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

  it('hands safe live chats to the AI assistant after the team, enterprise included, never billing problems', async () => {
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

    chat.mockResolvedValueOnce({ json: { category: 'billing-question', priority: 'Low' } });
    const howTo = fakeDesk(msgs);
    await new TestTriage(howTo, undefined, 5).triage({ uuid: 'a7', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'cloud', plan: 'starter' } } });
    expect(howTo.addTags).toHaveBeenCalledWith('a7', ['billing-question', 'cloud', 'paid', 'ai-triaged', 'ai-assistant']);
    expect(howTo.setPriority).toHaveBeenCalledWith('a7', 'Low');
    expect(howTo.assignUser).toHaveBeenCalledWith('a7', 5);

    chat.mockResolvedValueOnce({ json: { category: 'billing-question', priority: 'Low' } });
    const entHowTo = fakeDesk(msgs);
    await new TestTriage(entHowTo, undefined, 5).triage({ uuid: 'a8', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'dedicated' } } });
    expect(entHowTo.assignUser).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Low' } });
    const ent = fakeDesk(msgs);
    await new TestTriage(ent, undefined, 5).triage({ uuid: 'a3', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'dedicated' } } });
    expect(ent.assignTeam).toHaveBeenCalledWith('a3', 2);
    expect(ent.assignUser).toHaveBeenCalledWith('a3', 5);
    expect(ent.addPrivateNote).toHaveBeenCalledWith('a3', expect.any(String), [{ type: 'team', id: 2 }]);

    chat.mockResolvedValueOnce({ json: { category: 'billing', priority: 'Low' } });
    const entBilling = fakeDesk(msgs);
    await new TestTriage(entBilling, undefined, 5).triage({ uuid: 'a6', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'cloud', plan: 'enterprise' } } });
    expect(entBilling.assignUser).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Low' } });
    const email = fakeDesk(msgs);
    await new TestTriage(email, undefined, 5).triage({ uuid: 'a4', inbox_channel: 'email', contact: { custom_attributes: { deployment: 'cloud' } } });
    expect(email.assignUser).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({ json: { category: 'connector-setup', priority: 'Low' } });
    const off = fakeDesk(msgs);
    await new TestTriage(off).triage({ uuid: 'a5', inbox_channel: 'livechat', contact: { custom_attributes: { deployment: 'cloud' } } });
    expect(off.assignUser).not.toHaveBeenCalled();
  });

  describe('acknowledgement when a live chat goes straight to a person', () => {
    const customer = { type: 'incoming', private: false, sender_type: 'contact', text_content: 'Why was I charged during the trial?' };
    const triageNoteMsg = { type: 'outgoing', private: true, sender_type: 'agent', text_content: 'AI triage: billing' };
    const cloud = { custom_attributes: { deployment: 'cloud', plan: 'trial' } };

    it('posts one public message in the customer language on human-only routing', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'billing', priority: 'High', language: 'de' } });
      const desk = fakeDesk([customer], [triageNoteMsg, customer]);
      await new TestTriage(desk, undefined, 5).triage({ uuid: 'h1', inbox_channel: 'livechat', contact: cloud });
      expect(desk.assignUser).not.toHaveBeenCalled();
      expect(desk.reply).toHaveBeenCalledTimes(1);
      expect(desk.reply).toHaveBeenCalledWith('h1', `<p>${HUMAN_ROUTING_ACKS.de}</p>`);
      // After the team, tags and note, so the person finds the context.
      expect(desk.addPrivateNote.mock.invocationCallOrder[0]).toBeLessThan(desk.reply.mock.invocationCallOrder[0]);
    });

    it('also acknowledges when no AI assistant is configured', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'connector-setup', priority: 'Low', language: 'it' } });
      const desk = fakeDesk([customer]);
      await new TestTriage(desk).triage({ uuid: 'h2', inbox_channel: 'livechat', contact: cloud });
      expect(desk.reply).toHaveBeenCalledWith('h2', `<p>${HUMAN_ROUTING_ACKS.it}</p>`);
    });

    it('falls back to English without an LLM or for a language without a text', async () => {
      const desk = fakeDesk([customer]);
      await new TestTriage(desk, null, 5).triage({ uuid: 'h3', inbox_channel: 'livechat', contact: cloud });
      // The fallback triage is "other", which the assistant handles.
      expect(desk.assignUser).toHaveBeenCalledWith('h3', 5);
      expect(desk.reply).not.toHaveBeenCalled();

      await new TestTriage(desk, null).triage({ uuid: 'h4', inbox_channel: 'livechat', contact: cloud });
      expect(desk.reply).toHaveBeenCalledWith('h4', `<p>${HUMAN_ROUTING_ACKS.en}</p>`);
    });

    it('says nothing when the AI assistant takes the chat', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'connector-error', priority: 'Medium', language: 'fr' } });
      const desk = fakeDesk([customer]);
      await new TestTriage(desk, undefined, 5).triage({ uuid: 'h5', inbox_channel: 'livechat', contact: cloud });
      expect(desk.assignUser).toHaveBeenCalledWith('h5', 5);
      expect(desk.messages).not.toHaveBeenCalled();
      expect(desk.reply).not.toHaveBeenCalled();
    });

    it('says nothing outside the live chat', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'billing', priority: 'High', language: 'en' } });
      const desk = fakeDesk([customer]);
      await new TestTriage(desk, undefined, 5).triage({ uuid: 'h6', inbox_channel: 'email', contact: cloud });
      expect(desk.reply).not.toHaveBeenCalled();
    });

    it('is not posted when a public agent reply is already there', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'bug', priority: 'Medium', language: 'en' } });
      const human = { type: 'outgoing', private: false, sender_type: 'agent', text_content: 'Looking into it' };
      const desk = fakeDesk([customer], [human, triageNoteMsg, customer]);
      await new TestTriage(desk, undefined, 5).triage({ uuid: 'h7', inbox_channel: 'livechat', contact: cloud });
      expect(desk.reply).not.toHaveBeenCalled();
    });

    it('is never duplicated on a repeated delivery or a re-triage after a restart', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'billing', priority: 'High', language: 'en' } });
      const desk = fakeDesk([customer], [triageNoteMsg, customer]);
      const svc = new TestTriage(desk, undefined, 5);
      await svc.triage({ uuid: 'h8', inbox_channel: 'livechat', contact: cloud });
      await svc.triage({ uuid: 'h8', inbox_channel: 'livechat', contact: cloud });
      expect(desk.reply).toHaveBeenCalledTimes(1);

      // A new process whose tag step had failed: the posted message is in the chat.
      const posted = { type: 'outgoing', private: false, sender_type: 'agent', text_content: HUMAN_ROUTING_ACKS.en };
      desk.messages.mockResolvedValue([posted, triageNoteMsg, customer]);
      await new TestTriage(desk, undefined, 5).triage({ uuid: 'h8', inbox_channel: 'livechat', contact: cloud });
      expect(desk.reply).toHaveBeenCalledTimes(1);
    });

    it('is not posted when the messages cannot be read', async () => {
      jest.spyOn(llm, 'chatJson').mockResolvedValue({ json: { category: 'billing', priority: 'High', language: 'en' } });
      const desk = fakeDesk([customer]);
      desk.messages.mockRejectedValue(new Error('Libredesk GET -> 502'));
      await new TestTriage(desk, undefined, 5).triage({ uuid: 'h9', inbox_channel: 'livechat', contact: cloud });
      expect(desk.reply).not.toHaveBeenCalled();
      expect(desk.addPrivateNote).toHaveBeenCalled();
    });

    it('picks the language and tells replies from notes and activity rows', () => {
      expect(humanRoutingAck('pt-BR')).toBe(HUMAN_ROUTING_ACKS.pt);
      expect(humanRoutingAck('ES')).toBe(HUMAN_ROUTING_ACKS.es);
      expect(humanRoutingAck('ja')).toBe(HUMAN_ROUTING_ACKS.en);
      expect(humanRoutingAck('')).toBe(HUMAN_ROUTING_ACKS.en);
      expect(isPublicAgentReply({ type: 'outgoing', private: false, sender_type: 'agent' })).toBe(true);
      expect(isPublicAgentReply({ type: 'outgoing', private: true, sender_type: 'agent' })).toBe(false);
      expect(isPublicAgentReply({ type: 'activity', private: false, sender_type: 'agent' })).toBe(false);
      expect(isPublicAgentReply({ type: 'incoming', private: false, sender_type: 'contact' })).toBe(false);
    });

    it('keeps every text short, plain and free of promises', () => {
      for (const text of Object.values(HUMAN_ROUTING_ACKS)) {
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(text).toMatch(/17/);
        expect(text.length).toBeLessThan(200);
        expect(text).not.toMatch(/refund|€|\$|24 ?h/i);
      }
    });
  });

  it('a failing step does not stop the others', async () => {
    const desk = fakeDesk([]);
    desk.addTags.mockRejectedValue(new Error('tag missing'));
    await new TestTriage(desk, null).triage({ uuid: 'c6' });
    expect(desk.setPriority).toHaveBeenCalled();
    expect(desk.addPrivateNote).toHaveBeenCalled();
  });
});
