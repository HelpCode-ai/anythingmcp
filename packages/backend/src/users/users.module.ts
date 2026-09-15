import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserLifecycleService } from './user-lifecycle.service';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [OrganizationsModule],
  controllers: [UsersController],
  providers: [UsersService, UserLifecycleService],
  exports: [UsersService, UserLifecycleService],
})
export class UsersModule {}
