import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Roles, RolesGuard } from '../../auth/roles.guard';
import { EditionService } from './edition.service';

@ApiTags('License')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/license')
export class EditionController {
  constructor(private readonly edition: EditionService) {}

  @Get('edition')
  @ApiOperation({ summary: 'Edition of this instance, its user limit and Enterprise availability' })
  getEdition() {
    return this.edition.getState();
  }

  @Post('business-trial')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Start the one-time Enterprise trial on a self-hosted instance (ADMIN)' })
  startTrial() {
    return this.edition.startTrial();
  }
}
