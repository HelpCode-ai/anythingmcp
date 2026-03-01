import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';
import { UsersService } from '../users/users.service';

@ApiTags('AI')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly usersService: UsersService,
  ) {}

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
    @Req() req: any,
    @Body()
    dto: {
      toolName: string;
      currentDescription: string;
      apiContext?: string;
    },
  ) {
    const user = await this.usersService.findById(req.user.sub);
    if (!user?.aiProvider || !user?.aiApiKey) {
      throw new BadRequestException(
        'AI provider not configured. Go to Settings to set up your AI provider and API key.',
      );
    }

    return {
      description: await this.aiService.improveToolDescription(
        dto.toolName,
        dto.currentDescription,
        dto.apiContext || '',
        user.aiProvider as 'anthropic' | 'openai',
        user.aiApiKey,
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
