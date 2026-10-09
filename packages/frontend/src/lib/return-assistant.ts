/**
 * Where the connector setup page sends the user once a connector set up from
 * a chat is ready. The `from` query names the assistant the chat runs in; it
 * comes from the URL, so it is only ever looked up in this fixed list and the
 * links are the ones written here, never a value from the query.
 *
 *   claude     Claude, with a link to a new chat
 *   chatgpt    ChatGPT, with a link to a new chat
 *   muse       Meta's Muse, named only: it runs in apps as well as on the web
 *   assistant  a chat whose assistant is not known (Cursor, an API key, …)
 *
 * Anything else, and no `from` at all (a setup started in the dashboard),
 * shows no way back.
 */
export interface ReturnAssistant {
  id: 'claude' | 'chatgpt' | 'muse' | 'assistant';
  /** Shown in "Back to …" and "return to …". */
  name: string;
  /** Fixed, external: a new chat in that assistant. */
  href?: string;
}

const ASSISTANTS: Record<ReturnAssistant['id'], ReturnAssistant> = {
  claude: { id: 'claude', name: 'Claude', href: 'https://claude.ai/new' },
  chatgpt: { id: 'chatgpt', name: 'ChatGPT', href: 'https://chatgpt.com/' },
  muse: { id: 'muse', name: 'Meta Muse' },
  assistant: { id: 'assistant', name: 'your AI assistant' },
};

export function returnAssistant(from: string | null | undefined): ReturnAssistant | null {
  if (!from || !Object.prototype.hasOwnProperty.call(ASSISTANTS, from)) return null;
  return ASSISTANTS[from as ReturnAssistant['id']];
}
