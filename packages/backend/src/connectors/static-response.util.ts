/**
 * Static tools answer with text stored on the tool itself, no upstream call:
 * playbooks, example queries, domain guides. Two shapes:
 *
 * - `staticResponse`: one text, returned whatever the arguments.
 * - `staticResponses`: a map of topic → text, picked by the `topic` argument
 *   (or the argument named by `topicParam`). One tool can then carry a whole
 *   guide — `sap_guide(topic: "finance")` — instead of one tool per chapter.
 *   Without a topic, or with an unknown one, the tool answers with
 *   `staticResponse` (if any) followed by the list of topics, so a model that
 *   guessed wrong learns the right names from the reply.
 */
export interface StaticEndpointMapping {
  staticResponse?: string;
  staticResponses?: Record<string, unknown>;
  topicParam?: string;
}

export function renderStaticResponse(
  mapping: StaticEndpointMapping,
  params: Record<string, unknown> = {},
): string {
  const topics = Object.entries(mapping.staticResponses ?? {}).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].trim() !== '',
  );

  if (topics.length > 0) {
    const param = mapping.topicParam || 'topic';
    const wanted = params[param];
    const key = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
    if (key) {
      const hit = topics.find(([name]) => name.toLowerCase() === key);
      if (hit) return hit[1];
    }
    const index = `Topics (pass one as "${param}"): ${topics.map(([n]) => n).join(', ')}`;
    const lead = key ? `There is no topic "${String(wanted)}".\n\n` : '';
    const overview = mapping.staticResponse ? `${mapping.staticResponse}\n\n` : '';
    return `${lead}${overview}${index}`;
  }

  if (!mapping.staticResponse) {
    throw new Error(
      'This tool is configured to return a fixed text response, but that ' +
        "response is empty. Set it under the tool's endpoint mapping, or " +
        'change the method to a real HTTP verb.',
    );
  }
  return mapping.staticResponse;
}
