import { Injectable, Logger } from '@nestjs/common';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenaiProvider } from './providers/openai.provider';

/**
 * AiService — AI-assisted configuration service.
 *
 * Uses Claude or OpenAI to:
 * 1. Generate MCP tool descriptions from API specs
 * 2. Suggest parameter naming and descriptions for LLM consumption
 * 3. Recommend tool groupings (avoid overwhelming LLMs with too many tools)
 * 4. Help users configure connectors via natural language
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly claude: ClaudeProvider,
    private readonly openai: OpenaiProvider,
  ) {}

  /**
   * Generate MCP tool definitions from a parsed API spec.
   */
  async generateToolDefinitions(
    apiSpec: Record<string, unknown>,
    provider: 'anthropic' | 'openai',
    apiKey: string,
  ): Promise<GeneratedToolDef[]> {
    const prompt = this.buildToolGenerationPrompt(apiSpec);

    let response: string;
    if (provider === 'anthropic') {
      response = await this.claude.complete(apiKey, prompt);
    } else {
      response = await this.openai.complete(apiKey, prompt);
    }

    return this.parseToolDefinitions(response);
  }

  /**
   * Improve a single tool's description for better LLM comprehension.
   */
  async improveToolDescription(
    toolName: string,
    currentDescription: string,
    apiContext: string,
    provider: 'anthropic' | 'openai',
    apiKey: string,
  ): Promise<string> {
    const prompt =
      `You are an expert at writing MCP tool descriptions optimized for LLM consumption.\n\n` +
      `Improve this tool description to be clearer and more useful for an AI assistant:\n\n` +
      `Tool name: ${toolName}\n` +
      `Current description: ${currentDescription}\n` +
      `API context: ${apiContext}\n\n` +
      `Write a new description that:\n` +
      `- Clearly explains what the tool does\n` +
      `- Lists the main use cases\n` +
      `- Describes what data is returned\n` +
      `- Includes workflow tips (when to use this vs other tools)\n\n` +
      `Return ONLY the improved description text, no JSON or markdown.`;

    if (provider === 'anthropic') {
      return this.claude.complete(apiKey, prompt);
    }
    return this.openai.complete(apiKey, prompt);
  }

  /**
   * Natural language configuration: user describes what they want,
   * AI returns connector configuration.
   */
  async configureFromNaturalLanguage(
    userMessage: string,
    existingConnectors: Array<{ name: string; type: string }>,
    provider: 'anthropic' | 'openai',
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    const prompt =
      `You are an assistant helping configure API connectors for the AnythingToMCP platform.\n\n` +
      `The user said: "${userMessage}"\n\n` +
      `Existing connectors: ${JSON.stringify(existingConnectors)}\n\n` +
      `Based on this, return a JSON object with the suggested connector configuration:\n` +
      `{\n` +
      `  "action": "create" | "update" | "configure_tools",\n` +
      `  "connector": { "name": "...", "type": "REST|SOAP|GRAPHQL|...", "baseUrl": "...", "authType": "..." },\n` +
      `  "tools": [{ "name": "...", "description": "...", "endpoint": "..." }],\n` +
      `  "explanation": "What I understood and what I'm suggesting"\n` +
      `}\n\n` +
      `Return valid JSON only.`;

    let response: string;
    if (provider === 'anthropic') {
      response = await this.claude.complete(apiKey, prompt);
    } else {
      response = await this.openai.complete(apiKey, prompt);
    }

    return JSON.parse(response);
  }

  private buildToolGenerationPrompt(
    apiSpec: Record<string, unknown>,
  ): string {
    return (
      `You are an expert at creating MCP (Model Context Protocol) tool definitions ` +
      `from API specifications.\n\n` +
      `Given this API spec, generate MCP tool definitions that are optimized for ` +
      `LLM consumption. Group related endpoints into logical tools when appropriate ` +
      `(don't create one tool per endpoint if they're closely related).\n\n` +
      `API Spec:\n${JSON.stringify(apiSpec, null, 2)}\n\n` +
      `For each tool, provide:\n` +
      `- name: concise snake_case name\n` +
      `- description: detailed, LLM-optimized description with use cases and returned data\n` +
      `- parameters: JSON schema with descriptions for each param\n` +
      `- endpointMapping: how this tool maps to the API\n\n` +
      `Return a JSON array of tool definitions.`
    );
  }

  private parseToolDefinitions(response: string): GeneratedToolDef[] {
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return JSON.parse(response);
    } catch {
      this.logger.warn('Failed to parse AI response as JSON');
      return [];
    }
  }
}

export interface GeneratedToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: Record<string, unknown>;
}
