import { Module } from '@nestjs/common';

/**
 * CloudModule — loaded only when DEPLOYMENT_MODE=cloud.
 *
 * Groups cloud-specific providers and controllers. Future additions:
 * - Usage metering
 * - Multi-tenant routing
 * - Cloud-specific billing webhooks
 */
@Module({})
export class CloudModule {}
