import { Global, Module } from '@nestjs/common';
import { FileUploadController } from './file-upload.controller';
import { FileUploadService } from './file-upload.service';

/**
 * Agent file uploads (file_upload_link / amcp-file references). Global so the
 * REST engine and the MCP endpoint can reach the service without importing
 * this module; PrismaService and DeploymentService come from @Global modules.
 */
@Global()
@Module({
  controllers: [FileUploadController],
  providers: [FileUploadService],
  exports: [FileUploadService],
})
export class FileUploadsModule {}
