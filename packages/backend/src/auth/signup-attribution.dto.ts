import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { MAX_TOUCH_FIELD } from '../audit/signup-attribution';

/**
 * One touch: what a landing on the marketing site (or on the cloud app, for
 * visitors who came straight there) said about where the visitor came from.
 * Campaign-level only: no click id, no referrer path, nothing personal. The
 * server sanitizes again before storing (audit/signup-attribution.ts); these
 * rules only bound what the register endpoint accepts.
 *
 * Keep the key set in step with the cloud frontend (lib/attribution.ts): the
 * global ValidationPipe rejects unknown keys, and the frontend drops any key
 * not listed here before sending.
 */
export class SignupTouchDto {
  @ApiPropertyOptional({ maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  utm_source?: string;

  @ApiPropertyOptional({ maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  utm_medium?: string;

  @ApiPropertyOptional({ maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  utm_campaign?: string;

  @ApiPropertyOptional({ maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  utm_term?: string;

  @ApiPropertyOptional({ maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  utm_content?: string;

  @ApiPropertyOptional({ description: 'Google Ads `gad_source`.', maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  gad_source?: string;

  @ApiPropertyOptional({ description: 'Google Ads `gad_campaignid`.', maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  gad_campaignid?: string;

  @ApiPropertyOptional({ description: 'A Google Ads click id was present. The id itself is never sent.' })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @ApiPropertyOptional({ description: 'Host of the referring page, without path or query.', maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  referrer_host?: string;

  @ApiPropertyOptional({ description: 'Landing path, without query string.', maxLength: MAX_TOUCH_FIELD })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TOUCH_FIELD)
  landing_path?: string;

  @ApiPropertyOptional({ description: 'When the touch was recorded, epoch milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  ts?: number;

  @ApiPropertyOptional({ enum: ['site', 'cloud'] })
  @IsOptional()
  @IsIn(['site', 'cloud'])
  captured_on?: 'site' | 'cloud';
}

export class SignupAttributionDto {
  @ApiPropertyOptional({ type: SignupTouchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SignupTouchDto)
  first_touch?: SignupTouchDto;

  @ApiPropertyOptional({ type: SignupTouchDto, description: 'Omitted when it equals the first touch.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => SignupTouchDto)
  last_touch?: SignupTouchDto;
}
