import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { LEARNING_LIMITS, PUBLISH_MODES } from './learning.service';

export class CreateLearningProjectDto {
  @ApiProperty({ description: 'Name of the project, e.g. "Hardware for old windows".' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'The member whose lessons are kept (a user id of this workspace).' })
  @IsString()
  userId: string;

  @ApiProperty({ description: 'The MCP server the member works on.' })
  @IsString()
  mcpServerId: string;

  @ApiPropertyOptional({ description: 'Folder the learned skills are filed in.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  folderId?: string | null;

  @ApiPropertyOptional({ description: 'Date the project ends on its own (ISO 8601).', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  endsAt?: string | null;

  @ApiPropertyOptional({ description: 'Up to 10 labels put on the learned skills.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEARNING_LIMITS.tags)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    enum: PUBLISH_MODES,
    description: '`manual`: a person publishes each topic. `confirmed`: lessons the member confirms are published.',
  })
  @IsOptional()
  @IsIn([...PUBLISH_MODES])
  publishMode?: string;

  @ApiPropertyOptional({ description: 'Show the member\'s name to everyone, not to admins only.' })
  @IsOptional()
  @IsBoolean()
  showExpertName?: boolean;
}

export class UpdateLearningProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Applies to topics started from now on.', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  folderId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  endsAt?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEARNING_LIMITS.tags)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: PUBLISH_MODES })
  @IsOptional()
  @IsIn([...PUBLISH_MODES])
  publishMode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showExpertName?: boolean;
}

export class UpdateLessonDto {
  @ApiPropertyOptional({ enum: ['draft', 'confirmed', 'rejected'] })
  @IsOptional()
  @IsIn(['draft', 'confirmed', 'rejected'])
  status?: string;

  @ApiPropertyOptional({ description: 'A corrected wording. The earlier lesson is kept as superseded.' })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(LEARNING_LIMITS.text)
  text?: string;
}

export class LearningConsentDto {
  @ApiProperty({ description: 'The notice the member read and accepts, as it was shown.' })
  @IsString()
  @MinLength(20)
  @MaxLength(LEARNING_LIMITS.notice)
  notice: string;
}

export class LearningWithdrawDto {
  @ApiPropertyOptional({ description: 'Also erase everything that was not published.' })
  @IsOptional()
  @IsBoolean()
  erase?: boolean;
}
