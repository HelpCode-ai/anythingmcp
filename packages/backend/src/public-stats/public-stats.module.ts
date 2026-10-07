import { Global, Module } from '@nestjs/common';
import { PublicStatsController } from './public-stats.controller';
import { TrustStatsService } from './trust-stats.service';

/** Public aggregate numbers, shared by emails, the sign-in pages and GET /api/public/stats. */
@Global()
@Module({
  controllers: [PublicStatsController],
  providers: [TrustStatsService],
  exports: [TrustStatsService],
})
export class PublicStatsModule {}
