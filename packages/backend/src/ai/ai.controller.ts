import {
  Controller,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';

@ApiTags('AI')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('generate-tools')
  @ApiOperation({
    summary: 'AI-generate MCP tool definitions from an API spec',
  })
  async generateTools(
    @Body()
    dto: {
      apiSpec: Record<string, unknown>;
      provider: 'anthropic' | 'openai';
      apiKey: string;
    },
  ) {
    return this.aiService.generateToolDefinitions(
      dto.apiSpec,
      dto.provider,
      dto.apiKey,
    );
  }

  @Post('improve-description')
  @ApiOperation({ summary: 'AI-improve a tool description for LLM consumption' })
  async improveDescription(
    @Body()
    dto: {
      toolName: string;
      currentDescription: string;
      apiContext: string;
      provider: 'anthropic' | 'openai';
      apiKey: string;
    },
  ) {
    return {
      description: await this.aiService.improveToolDescription(
        dto.toolName,
        dto.currentDescription,
        dto.apiContext,
        dto.provider,
        dto.apiKey,
      ),
    };
  }

  @Post('configure')
  @ApiOperation({
    summary: 'Configure a connector using natural language with AI assistance',
  })
  async configure(
    @Body()
    dto: {
      message: string;
      existingConnectors: Array<{ name: string; type: string }>;
      provider: 'anthropic' | 'openai';
      apiKey: string;
    },
  ) {
    return this.aiService.configureFromNaturalLanguage(
      dto.message,
      dto.existingConnectors,
      dto.provider,
      dto.apiKey,
    );
  }
}
