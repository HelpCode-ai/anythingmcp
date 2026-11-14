import { Injectable, Logger } from '@nestjs/common';
import { LibredeskClient } from './libredesk.client';
import { supportTriageConfig } from './support-config';
import { compactError } from './support-redact';
import type { DeskMessage } from './support-telegram-setup.service';

/** One notice per conversation in this window, however often it is handed off. */
const NOTICE_WINDOW_MS = 6 * 60 * 60_000;
const SEEN_MAX = 2_000;

/**
 * What the customer reads when the desk's AI assistant hands the chat to a
 * person. Support hours from the enterprise and partner support model:
 * Monday to Friday, 9:00 to 17:00 CET.
 */
export const HANDOFF_NOTICES: Record<string, string> = {
  en: 'I have passed your question to our team. A person will reply here in this chat, usually within one business day (Monday to Friday, 9:00 to 17:00 CET).',
  de: 'Ich habe Ihre Frage an unser Team weitergegeben. Eine Person antwortet Ihnen hier im Chat, in der Regel innerhalb eines Werktags (Montag bis Freitag, 9 bis 17 Uhr MEZ).',
  it: 'Ho passato la tua domanda al nostro team. Una persona ti risponderà qui in chat, di solito entro un giorno lavorativo (dal lunedì al venerdì, dalle 9 alle 17 CET).',
  es: 'He pasado tu pregunta a nuestro equipo. Una persona te responderá aquí en el chat, normalmente en un día laborable (de lunes a viernes, de 9:00 a 17:00 CET).',
  fr: "J'ai transmis votre question à notre équipe. Une personne vous répondra ici dans le chat, en général sous un jour ouvré (du lundi au vendredi, de 9 h à 17 h CET).",
  pt: 'Passei a sua pergunta para a nossa equipe. Uma pessoa vai responder aqui no chat, normalmente em até um dia útil (de segunda a sexta, das 9h às 17h CET).',
  ru: 'Я передал ваш вопрос нашей команде. Сотрудник ответит вам здесь, в чате, обычно в течение одного рабочего дня (с понедельника по пятницу, с 9:00 до 17:00 CET).',
  tr: 'Sorunuzu ekibimize ilettim. Bir kişi size burada, sohbette, genellikle bir iş günü içinde yanıt verecek (pazartesiden cumaya, 9:00-17:00 CET).',
};

/** The language the triage note recorded ("AI triage: …, language fr"). */
export function triageLanguage(notes: Array<string | null | undefined>): string | null {
  for (const n of notes) {
    const m = (n || '').match(/AI triage\W+[^\n]*?language ([a-z]{2})\b/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Libredesk v2.8.0 hands a chat off with only a private note and a new
 * assignee: the model's own text is dropped, so the customer saw nothing
 * until a person answered (2026-11-10: four and a half hours). When the AI
 * assistant posts its handoff note, this tells the customer, in the
 * language the triage found, that a person replies here.
 */
@Injectable()
export class SupportHandoffNoticeService {
  private readonly logger = new Logger(SupportHandoffNoticeService.name);
  private readonly noticed = new Map<string, number>();

  protected client(): LibredeskClient | null {
    const cfg = supportTriageConfig();
    return cfg ? new LibredeskClient(cfg) : null;
  }

  protected assistantUserId(): number | null {
    return supportTriageConfig()?.aiAssistantUserId ?? null;
  }

  async handleMessage(msg: DeskMessage, now = Date.now()): Promise<boolean> {
    const assistant = this.assistantUserId();
    if (!assistant || !msg?.conversation_uuid) return false;
    // The handoff note: private, written by the AI assistant's user.
    if (!msg.private || msg.sender_type !== 'agent' || msg.sender_id !== assistant) return false;
    const uuid = msg.conversation_uuid;
    const last = this.noticed.get(uuid);
    if (last !== undefined && now - last < NOTICE_WINDOW_MS) return false;
    const desk = this.client();
    if (!desk) return false;
    this.remember(uuid, now);
    try {
      const conv = await desk.conversation(uuid);
      if (!conv || conv.inbox_channel !== 'livechat') return false;
      const notes = await desk.privateNotes(uuid).catch(() => []);
      const lang = triageLanguage(notes.map((n) => n.text_content || n.content));
      const text = HANDOFF_NOTICES[lang ?? 'en'] ?? HANDOFF_NOTICES.en;
      await desk.reply(uuid, `<p>${text}</p>`);
      return true;
    } catch (err) {
      this.logger.warn(`Handoff notice for ${uuid} failed: ${compactError((err as Error).message)}`);
      return false;
    }
  }

  private remember(uuid: string, now: number) {
    if (this.noticed.size >= SEEN_MAX) {
      const oldest = this.noticed.keys().next().value;
      if (oldest !== undefined) this.noticed.delete(oldest);
    }
    this.noticed.set(uuid, now);
  }
}
