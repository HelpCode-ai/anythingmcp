import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import {
  AD_CONSENT_VALUES,
  CLICK_ID_PATTERN,
  MAX_CLICK_ID,
  MAX_TOUCH_FIELD,
  type AdConsent,
} from '../audit/signup-attribution';

const CLICK_ID_MESSAGE = 'must be a Google Ads click id (letters, digits, "-" and "_")';

/**
 * One touch: what a landing on the marketing site (or on the cloud app, for
 * visitors who came straight there) said about where the visitor came from.
 * Campaign-level, no referrer path, nothing personal; a Google Ads click id
 * only next to `ad_consent: 'granted'`. The server sanitizes again before
 * storing (audit/signup-attribution.ts) and drops a click id sent without
 * that consent; these rules only bound what the register endpoint accepts.
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

  @ApiPropertyOptional({ description: 'A Google Ads click id was present, whether or not the id itself is sent.' })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @ApiPropertyOptional({
    description: "Google Ads click id. Stored only when `ad_consent` is 'granted'.",
    maxLength: MAX_CLICK_ID,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CLICK_ID)
  @Matches(CLICK_ID_PATTERN, { message: `gclid ${CLICK_ID_MESSAGE}` })
  gclid?: string;

  @ApiPropertyOptional({
    description: "Google Ads click id for app-to-web (iOS). Stored only when `ad_consent` is 'granted'.",
    maxLength: MAX_CLICK_ID,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CLICK_ID)
  @Matches(CLICK_ID_PATTERN, { message: `gbraid ${CLICK_ID_MESSAGE}` })
  gbraid?: string;

  @ApiPropertyOptional({
    description: "Google Ads click id for web-to-app (iOS). Stored only when `ad_consent` is 'granted'.",
    maxLength: MAX_CLICK_ID,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CLICK_ID)
  @Matches(CLICK_ID_PATTERN, { message: `wbraid ${CLICK_ID_MESSAGE}` })
  wbraid?: string;

  @ApiPropertyOptional({
    enum: AD_CONSENT_VALUES,
    description: 'The visitor\'s ad (marketing cookie) consent when the touch was recorded.',
  })
  @IsOptional()
  @IsIn(AD_CONSENT_VALUES)
  ad_consent?: AdConsent;

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
