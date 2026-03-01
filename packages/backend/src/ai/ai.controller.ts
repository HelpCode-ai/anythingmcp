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
   * Resolve AI provider, apiKey and model — prefers request body,
   * falls back to user's saved config in DB.
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

    // If both provider and apiKey are provided in the request body, use them
    if (provider && apiKey) {
      return { provider, apiKey, model };
    }

    // Fall back to user's saved AI config
    const user = await this.usersService.findById(userId);
    if (!user?.aiProvider || !user?.aiApiKey) {
      throw new BadRequestException(
        'AI provider not configured. Go to Settings to set up your AI provider and API key.',
      );
    }

    return {
      provider: (provider || user.aiProvider) as 'anthropic' | 'openai',
      apiKey: apiKey || user.aiApiKey,
      model: model || user.aiModel || undefined,
    };
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
