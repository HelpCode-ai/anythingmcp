import { Global, Module } from '@nestjs/common';
import { LicenseModule } from '../../license/license.module';
import { LearningAccessService } from './learning-access.service';

/**
 * Learning projects (#1695): learning turned on for one member on one MCP
 * server. PrismaService, DeploymentService and EditionService come from
 * @Global modules. Global so the MCP endpoint can ask whether a caller has an
 * active project without importing this module.
 */
@Global()
@Module({
  imports: [LicenseModule],
  providers: [LearningAccessService],
  exports: [LearningAccessService],
})
export class LearningModule {}
