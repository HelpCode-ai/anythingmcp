import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { PrismaService } from '../common/prisma.service';
import { LicenseReleaseModule } from '../license/license-release.module';

@Module({
  imports: [LicenseReleaseModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, PrismaService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
