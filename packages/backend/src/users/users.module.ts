import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserLifecycleService } from './user-lifecycle.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { LicenseReleaseModule } from '../license/license-release.module';

@Module({
  imports: [OrganizationsModule, LicenseReleaseModule],
  controllers: [UsersController],
  providers: [UsersService, UserLifecycleService],
  exports: [UsersService, UserLifecycleService],
})
export class UsersModule {}
