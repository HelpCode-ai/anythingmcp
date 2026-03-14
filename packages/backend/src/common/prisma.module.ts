import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DeploymentService } from './deployment.service';

@Global()
@Module({
  providers: [PrismaService, DeploymentService],
  exports: [PrismaService, DeploymentService],
})
export class PrismaModule {}
