import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
];

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

@Injectable()
export class ClaudeProvider {
  private readonly logger = new Logger(ClaudeProvider.name);

  async complete(
    apiKey: string,
    prompt: string,
    model?: string,
  ): Promise<string> {
    const client = new Anthropic({ apiKey });

    const selectedModel = model || DEFAULT_CLAUDE_MODEL;
    this.logger.debug(`Using Claude model: ${selectedModel}`);

    const response = await client.messages.create({
      model: selectedModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((c) => c.type === 'text');
    return textBlock ? textBlock.text : '';
  }
}
