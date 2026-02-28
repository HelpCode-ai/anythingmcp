import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class ClaudeProvider {
  private readonly logger = new Logger(ClaudeProvider.name);

  async complete(apiKey: string, prompt: string): Promise<string> {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((c) => c.type === 'text');
    return textBlock ? textBlock.text : '';
  }
}
