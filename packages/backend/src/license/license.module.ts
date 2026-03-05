import { Module } from '@nestjs/common';
import { LicenseService } from './license.service';
import { LicenseController } from './license.controller';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [SettingsModule, UsersModule],
  controllers: [LicenseController],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicenseModule {}
