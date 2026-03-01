import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

export const OPENAI_MODELS = [
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { id: 'o4-mini', label: 'o4-mini' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
];

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

@Injectable()
export class OpenaiProvider {
  private readonly logger = new Logger(OpenaiProvider.name);

  async complete(
    apiKey: string,
    prompt: string,
    model?: string,
  ): Promise<string> {
    const client = new OpenAI({ apiKey });

    const selectedModel = model || DEFAULT_OPENAI_MODEL;
    this.logger.debug(`Using OpenAI model: ${selectedModel}`);

    const response = await client.chat.completions.create({
      model: selectedModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });

    return response.choices[0]?.message?.content ?? '';
  }
}
