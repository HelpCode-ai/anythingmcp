import {
  Controller,
  Post,
  Body,
  Get,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';
import { UsersService } from '../users/users.service';
import { OPENAI_MODELS, DEFAULT_OPENAI_MODEL } from './providers/openai.provider';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from './providers/claude.provider';

@ApiTags('AI')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Resolve AI provider, apiKey and model.
   * Priority: request body → user's saved DB config → .env vars
   */
  private async resolveAiConfig(
    userId: string,
    bodyProvider?: string,
    bodyApiKey?: string,
    bodyModel?: string,
  ): Promise<{ provider: 'anthropic' | 'openai'; apiKey: string; model?: string }> {
    const provider = bodyProvider as 'anthropic' | 'openai' | undefined;
    const apiKey = bodyApiKey;
    const model = bodyModel;

    // 1) If both provider and apiKey are provided in the request body, use them
    if (provider && apiKey) {
      return { provider, apiKey, model };
    }

    // 2) Fall back to user's saved AI config in DB
    const user = await this.usersService.findById(userId);
    if (user?.aiApiKey) {
      return {
        provider: (provider || user.aiProvider || 'openai') as 'anthropic' | 'openai',
        apiKey: apiKey || user.aiApiKey,
        model: model || user.aiModel || undefined,
      };
    }

    // 3) Fall back to server-level .env API keys
    const envAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const envOpenaiKey = process.env.OPENAI_API_KEY;

    const resolvedProvider = provider || (user?.aiProvider as 'anthropic' | 'openai') || undefined;

    // If a specific provider is requested, try that env key
    if (resolvedProvider === 'anthropic' && envAnthropicKey) {
      return { provider: 'anthropic', apiKey: envAnthropicKey, model };
    }
    if (resolvedProvider === 'openai' && envOpenaiKey) {
      return { provider: 'openai', apiKey: envOpenaiKey, model };
    }

    // Otherwise use whichever env key is available
    if (envAnthropicKey) {
      return { provider: 'anthropic', apiKey: envAnthropicKey, model };
    }
    if (envOpenaiKey) {
      return { provider: 'openai', apiKey: envOpenaiKey, model };
    }

    throw new BadRequestException(
      'AI provider not configured. Set your API key in Settings, or add ANTHROPIC_API_KEY / OPENAI_API_KEY to .env',
    );
  }

  @Get('models')
  @ApiOperation({ summary: 'Get available AI models per provider' })
  async getModels() {
    return {
      anthropic: {
        models: CLAUDE_MODELS,
        default: DEFAULT_CLAUDE_MODEL,
      },
      openai: {
        models: OPENAI_MODELS,
        default: DEFAULT_OPENAI_MODEL,
      },
    };
  }

  @Post('generate-tools')
  @ApiOperation({
    summary: 'AI-generate MCP tool definitions from an API spec',
  })
  async generateTools(
    @Req() req: any,
    @Body()
    dto: {
      apiSpec: Record<string, unknown>;
      provider?: string;
      apiKey?: string;
      model?: string;
    },
  ) {
    const config = await this.resolveAiConfig(
      req.user.sub,
      dto.provider,
      dto.apiKey,
      dto.model,
    );
    return this.aiService.generateToolDefinitions(
      dto.apiSpec,
      config.provider,
      config.apiKey,
      config.model,
    );
  }

  @Post('improve-description')
  @ApiOperation({ summary: 'AI-improve a tool description for LLM consumption' })
  async improveDescription(
    @Req() req: any,
    @Body()
    dto: {
      toolName: string;
      currentDescription: string;
      apiContext?: string;
      model?: string;
    },
  ) {
    const config = await this.resolveAiConfig(
      req.user.sub,
      undefined,
      undefined,
      dto.model,
    );

    return {
      description: await this.aiService.improveToolDescription(
        dto.toolName,
        dto.currentDescription,
        dto.apiContext || '',
        config.provider,
        config.apiKey,
        config.model,
      ),
    };
  }

  @Post('configure')
  @ApiOperation({
    summary: 'Configure a connector using natural language with AI assistance',
  })
  async configure(
    @Req() req: any,
    @Body()
    dto: {
      message: string;
      existingConnectors: Array<{ name: string; type: string }>;
      provider?: string;
      apiKey?: string;
      model?: string;
    },
  ) {
    const config = await this.resolveAiConfig(
      req.user.sub,
      dto.provider,
      dto.apiKey,
      dto.model,
    );
    return this.aiService.configureFromNaturalLanguage(
      dto.message,
      dto.existingConnectors,
      config.provider,
      config.apiKey,
      config.model,
    );
  }
}
