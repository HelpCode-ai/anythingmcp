import { Global, Module } from '@nestjs/common';
import { LicenseModule } from '../../license/license.module';
import { LearningAccessService } from './learning-access.service';
import { LearningService } from './learning.service';
import { LearningController } from './learning.controller';

/**
 * Learning projects (#1695): learning turned on for one member on one MCP
 * server. PrismaService, DeploymentService, EditionService, KgSkillService,
 * SecurityEventService and the auth guards come from @Global modules. Global
 * so the MCP endpoint can ask whether a caller has an active project without
 * importing this module.
 */
@Global()
@Module({
  imports: [LicenseModule],
  controllers: [LearningController],
  providers: [LearningAccessService, LearningService],
  exports: [LearningAccessService, LearningService],
})
export class LearningModule {}
