import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class OpenaiProvider {
  private readonly logger = new Logger(OpenaiProvider.name);

  async complete(apiKey: string, prompt: string): Promise<string> {
    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });

    return response.choices[0]?.message?.content ?? '';
  }
}
